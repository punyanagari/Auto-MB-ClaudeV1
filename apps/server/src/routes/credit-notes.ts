import {
  CancelCreditNoteRequestSchema,
  CancelStatutoryDocumentRequestSchema,
  CreateCreditNoteRequestSchema,
  CreditNoteDetailResponseSchema,
  CreditNoteListResponseSchema,
  UpdateRecipientItcRequestSchema,
  type CreditNote,
  type CreditNoteDetailResponse,
  type CreditNoteStatus,
  type IrpProviderState,
  type RecipientItcStatus,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope, requireAuthorities } from '../authz.js';
import {
  buildFrozenCrnPayload,
  CREDIT_NOTE_TEMPLATE_VERSION,
  parseCreditNoteIssuedSnapshot,
} from '../credit-note-snapshot.js';
import {
  CREDIT_NOTE_PDF_TEMPLATE_VERSION,
  renderCreditNoteHtml,
} from '../credit-note-html.js';
import { draftConflictError } from '../draft-conflict.js';
import { stringifyStatutoryJson } from '../gsp/statutory-json.js';
import {
  finishStatutoryOperation,
  providerFailure,
  recoverStaleStatutoryOperation,
  sha256Hex,
  startStatutoryOperation,
} from '../gsp/provider-operations.js';
import type {
  IrpDocumentIdentity,
  IrpRegistrationEvidence,
  StatutoryProvider,
} from '../gsp/statutory-provider.js';
import { httpError } from '../http.js';
import {
  NumberTemplateError,
  loadNumberTemplate,
  renderNumberTemplate,
} from '../number-series.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import type { ObjectStorage } from '@auto-mb/documents';
import type { TaxInvoiceIrpRenderEvidence } from '../tax-invoice-html.js';
import {
  EInvoiceB2cUnsupportedError,
  parseTaxInvoiceIssuedSnapshot,
  TaxInvoiceSnapshotError,
} from '../tax-invoice-snapshot.js';
import { cancellationNote } from './challans.js';
import { financialYearLabel, requireEinvoiceDeclared } from './tax-invoices/index.js';
import {
  audit,
  IdParamsSchema,
  upstreamErrorResponses as errorResponses,
} from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import { renderPdfViaGotenberg } from '../pdf-render.js';

/**
 * The CGST Section 34 credit note (migration 0051): finding 5's residue.
 *
 * An invoice whose IRN is more than 24 hours old cannot be cancelled at
 * the IRP, so a wrong one would otherwise be a dead end on a legal
 * register. The credit note is the lawful instrument after the window:
 * FULL VALUE against exactly one submitted invoice (money columns are
 * database-proven copies of the invoice's frozen ones), and ISSUING it
 * supersedes the invoice in the same transaction — a terminal state that
 * releases the invoice's Measurement Book while every issued fact and
 * every byte of IRN evidence stays frozen.
 *
 * The note is an IRN document of its own: DocTyp CRN on the same INV-01
 * schema, POSITIVE values by NIC convention (the document type, not a
 * sign, marks the credit), numbered gapless per organisation per
 * financial year under its own counter (rule 46A wants the consecutive
 * serial), carrying finding 20's frozen reporting deadline (0049) and
 * its own 24-hour cancellation window.
 *
 * Local cancel of an issued note is the mirror image of issue: allowed
 * only while its IRP state is not_requested/cancelled AND the invoice's
 * Measurement Book has not been re-invoiced; it reverts the invoice
 * superseded -> submitted in the same transaction through the guarded
 * trigger arm. Direct (MB-less) invoices supersede and revert with no
 * MB logic at all.
 */

// --- Row shape ---------------------------------------------------------------

interface CreditNoteRow {
  id: string;
  tax_invoice_id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  work_id: string | null;
  status: CreditNoteStatus;
  note_number: string | null;
  sequence_number: number | null;
  fy_label: string | null;
  note_date: string;
  reason: string;
  number_prefix: string | null;
  taxable_value: string | null;
  cgst_amount: string | null;
  sgst_amount: string | null;
  igst_amount: string | null;
  round_off: string | null;
  total_amount: string | null;
  recipient_itc_status: RecipientItcStatus;
  irn: string | null;
  irp_provider: 'manual' | 'whitebooks' | null;
  irp_provider_state: IrpProviderState;
  ack_number: string | null;
  ack_date: Date | null;
  ack_date_text: string | null;
  signed_invoice_available: boolean;
  rendered_object_key: string | null;
  irp_legacy_evidence_missing: boolean;
  irp_cancelled_at: Date | null;
  irp_cancelled_at_text: string | null;
  irp_cancel_reason_code: string | null;
  irp_cancel_remark: string | null;
  irp_reporting_deadline: string | null;
  irp_reporting_overdue: boolean;
  irp_cancel_window_closes_at: Date | null;
  irp_cancel_window_open: boolean;
  cancellation_note: string | null;
  created_at: Date;
  issued_at: Date | null;
  cancelled_at: Date | null;
}

const CN_COLUMNS = `
  cn.id, cn.tax_invoice_id, ti.invoice_number,
  ti.invoice_date::text as invoice_date,
  cn.work_id, cn.status, cn.note_number, cn.sequence_number, cn.fy_label,
  cn.note_date::text as note_date, cn.reason, cn.number_prefix,
  cn.taxable_value::text as taxable_value, cn.cgst_amount::text as cgst_amount,
  cn.sgst_amount::text as sgst_amount, cn.igst_amount::text as igst_amount,
  cn.round_off::text as round_off, cn.total_amount::text as total_amount,
  cn.recipient_itc_status,
  cn.irn, cn.irp_provider, cn.irp_provider_state,
  cn.ack_number, cn.ack_date, cn.ack_date_text,
  (cn.signed_invoice is not null) as signed_invoice_available,
  cn.rendered_object_key,
  cn.irp_legacy_evidence_missing, cn.irp_cancelled_at,
  cn.irp_cancelled_at_text, cn.irp_cancel_reason_code, cn.irp_cancel_remark,
  cn.irp_reporting_deadline::text as irp_reporting_deadline,
  (cn.irp_reporting_deadline is not null
     and cn.irp_provider_state <> 'registered'
     and cn.status <> 'cancelled'
     and cn.irp_reporting_deadline <
       (select (now() at time zone o.timezone)::date from organisations o
        where o.id = cn.organisation_id))
    as irp_reporting_overdue,
  case when cn.ack_date is null or cn.irp_legacy_evidence_missing
    then null else cn.ack_date + interval '24 hours' end
    as irp_cancel_window_closes_at,
  (cn.irp_provider_state = 'registered'
     and not cn.irp_legacy_evidence_missing
     and cn.ack_date is not null
     and now() < cn.ack_date + interval '24 hours')
    as irp_cancel_window_open,
  cn.cancellation_note, cn.created_at, cn.issued_at, cn.cancelled_at
`;

const CN_FROM = `
  from credit_notes cn
  join tax_invoices ti on ti.id = cn.tax_invoice_id
`;

function toCreditNote(row: CreditNoteRow): CreditNote {
  return {
    id: row.id,
    taxInvoiceId: row.tax_invoice_id,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    workId: row.work_id,
    status: row.status,
    noteNumber: row.note_number,
    sequenceNumber: row.sequence_number,
    fyLabel: row.fy_label,
    noteDate: row.note_date,
    reason: row.reason,
    numberPrefix: row.number_prefix,
    taxableValue: row.taxable_value,
    cgstAmount: row.cgst_amount,
    sgstAmount: row.sgst_amount,
    igstAmount: row.igst_amount,
    roundOff: row.round_off,
    totalAmount: row.total_amount,
    recipientItcStatus: row.recipient_itc_status,
    irn: row.irn,
    irpProvider: row.irp_provider,
    irpProviderState: row.irp_provider_state,
    ackNumber: row.ack_number,
    ackDate: row.ack_date?.toISOString() ?? null,
    ackDateText: row.ack_date_text,
    signedInvoiceAvailable: row.signed_invoice_available,
    renderedAvailable: row.rendered_object_key !== null,
    irpLegacyEvidenceMissing: row.irp_legacy_evidence_missing,
    irpCancelledAt: row.irp_cancelled_at?.toISOString() ?? null,
    irpCancelledAtText: row.irp_cancelled_at_text,
    irpCancelReasonCode: row.irp_cancel_reason_code,
    irpCancelRemark: row.irp_cancel_remark,
    irpReportingDeadline: row.irp_reporting_deadline,
    irpReportingOverdue: row.irp_reporting_overdue,
    irpCancelWindowClosesAt: row.irp_cancel_window_closes_at?.toISOString() ?? null,
    irpCancelWindowOpen: row.irp_cancel_window_open,
    cancellationNote: row.cancellation_note,
    createdAt: row.created_at.toISOString(),
    issuedAt: row.issued_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

async function readDetail(
  tx: TransactionSql,
  creditNoteId: string,
): Promise<CreditNoteDetailResponse> {
  const rows = (await tx.unsafe(
    `select ${CN_COLUMNS}, cn.issued_snapshot, cn.signed_qr ${CN_FROM}
     where cn.id = $1`,
    [creditNoteId],
  )) as unknown as (CreditNoteRow & {
    issued_snapshot: unknown;
    signed_qr: string | null;
  })[];
  const row = rows[0];
  if (!row) throw httpError(404, 'CREDIT_NOTE_NOT_FOUND', 'No such credit note.');
  return {
    creditNote: toCreditNote(row),
    issuedSnapshot: parseJsonbColumn(row.issued_snapshot),
    signedQr: row.signed_qr,
  };
}

/** Locks the credit-note row for the rest of the transaction (`of cn` —
 * the joined invoice row is read here, locked separately when a
 * transition needs it). */
async function lockCreditNote(
  tx: TransactionSql,
  creditNoteId: string,
): Promise<CreditNoteRow> {
  const rows = (await tx.unsafe(
    `select ${CN_COLUMNS} ${CN_FROM} where cn.id = $1 for update of cn`,
    [creditNoteId],
  )) as unknown as CreditNoteRow[];
  const row = rows[0];
  if (!row) throw httpError(404, 'CREDIT_NOTE_NOT_FOUND', 'No such credit note.');
  return row;
}

function requireStatus(row: CreditNoteRow, status: CreditNoteStatus): void {
  if (row.status !== status) {
    throw httpError(
      409,
      'CREDIT_NOTE_STATUS_CONFLICT',
      `This operation requires a ${status} credit note (current status: ${row.status}).`,
    );
  }
}

/**
 * The reach a credit note against a DIRECT invoice needs: organisation-wide.
 *
 * A direct invoice belongs to no Work, so no Work assignment could ever
 * reach a note raised against it — the same standalone shape as
 * `assertDirectInvoiceAccess` and `assertStandaloneChallanAccess`. The
 * credit-note register now hides these rows from an 'assigned'-scoped
 * member, so the per-document guard has to agree, or the list would deny
 * what the id still handed over.
 *
 * 404 and the credit-note module's own not-found sentence: whether a note
 * against a direct invoice exists is not a fact worth disclosing to
 * someone who may not reach it.
 */
async function assertDirectNoteAccess(
  tx: TransactionSql,
  userId: string,
): Promise<void> {
  if (await hasFullWorkScope(tx, userId)) return;
  throw httpError(404, 'CREDIT_NOTE_NOT_FOUND', 'No such credit note.');
}

/**
 * The per-document work-scope boundary, dispatched by the note's (or its
 * invoice's) work_id exactly as `assertChallanAccess` and
 * `assertInvoiceWorkAccess` dispatch theirs. A null work_id is NOT a free
 * pass: it means the note rides a direct invoice, and that is checked
 * against `assertDirectNoteAccess` — the organisation-wide reach the
 * register demands to list it. Returning on null (as this once did) left
 * every per-document credit-note route open to any 'assigned'-scoped
 * member of the tenant, and the register's direct-invoice ids were the
 * enumeration oracle that made the invoice module's own gap reachable.
 */
async function assertNoteWorkAccess(
  tx: TransactionSql,
  userId: string,
  workId: string | null,
): Promise<void> {
  if (workId === null) {
    await assertDirectNoteAccess(tx, userId);
    return;
  }
  await assertWorkAccess(tx, userId, workId);
}

interface InvoiceForNote {
  id: string;
  status: string;
  work_id: string | null;
  measurement_book_id: string | null;
  invoice_number: string | null;
  invoice_date: string;
  number_prefix: string | null;
  buyer_contact_id: string;
  irp_provider_state: IrpProviderState;
  taxable_value: string | null;
  cgst_amount: string | null;
  sgst_amount: string | null;
  igst_amount: string | null;
  round_off: string | null;
  total_amount: string | null;
}

/** Row-locks the invoice a transition is about to read from or write to,
 * serialising against its own cancel/supersede. */
async function lockInvoiceForNote(
  tx: TransactionSql,
  taxInvoiceId: string,
): Promise<InvoiceForNote> {
  const [row] = await tx<InvoiceForNote[]>`
    select id, status, work_id, measurement_book_id, invoice_number,
           invoice_date::text as invoice_date, number_prefix,
           buyer_contact_id, irp_provider_state,
           taxable_value::text as taxable_value,
           cgst_amount::text as cgst_amount, sgst_amount::text as sgst_amount,
           igst_amount::text as igst_amount, round_off::text as round_off,
           total_amount::text as total_amount
    from tax_invoices where id = ${taxInvoiceId}
    for update
  `;
  if (!row) throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
  return row;
}

async function assertNoteDateValid(
  tx: TransactionSql,
  noteDate: string,
  invoiceDate: string,
): Promise<void> {
  // A credit note documents a correction of the invoice, so it cannot
  // predate it; and like every legal date here it cannot be a future
  // fact (the 0041/0051 trigger backstops this in the database).
  if (noteDate < invoiceDate) {
    throw httpError(
      400,
      'CREDIT_NOTE_DATE_BEFORE_INVOICE',
      `The credit note date cannot precede the invoice date (${invoiceDate}).`,
    );
  }
  const [row] = await tx<{ today: string }[]>`
    select (now() at time zone timezone)::date::text as today
    from organisations
    where id = app_private.current_organisation_id()
  `;
  if (!row) throw new Error('bound organisation disappeared');
  if (noteDate > row.today) {
    throw httpError(
      400,
      'CREDIT_NOTE_DATE_IN_FUTURE',
      `The credit note date cannot be after today (${row.today}) in the organisation timezone.`,
    );
  }
}

/** The frozen reporting window (finding 20, inherited from 0049): a
 * FRESH registration of the note after its stamped deadline is refused;
 * reconcile-by-lookup of an unknown earlier attempt is not gated. */
function assertNoteReportingWindowOpen(note: CreditNoteRow, today: string): void {
  if (note.irp_reporting_deadline !== null && today > note.irp_reporting_deadline) {
    throw httpError(
      409,
      'IRP_REPORTING_WINDOW_CLOSED',
      `The IRP reporting window for this credit note closed on ${note.irp_reporting_deadline}; the IRP no longer accepts a fresh report of it. The credit note remains valid locally.`,
    );
  }
}

/** The note's own 24-hour IRN cancellation window (same honesty as the
 * invoice's, stage 1): checked before any provider operation opens. */
function assertNoteIrpCancelWindowOpen(note: CreditNoteRow): void {
  if (note.irp_cancel_window_open) return;
  const closesAt = note.irp_cancel_window_closes_at;
  throw httpError(
    409,
    'IRP_CANCEL_WINDOW_CLOSED',
    closesAt === null
      ? "The acknowledgement instant of this credit note's IRN cannot be proven from the retained evidence, so NIC's 24-hour cancellation window is treated as closed. The credit note remains registered at the IRP."
      : `NIC's 24-hour IRN cancellation window for this credit note closed at ${closesAt.toISOString()}. The credit note remains registered at the IRP.`,
  );
}

function noteRenderSourceHash(
  snapshot: ReturnType<typeof parseCreditNoteIssuedSnapshot>,
  evidence: TaxInvoiceIrpRenderEvidence,
): string {
  return sha256Hex(stringifyStatutoryJson({ snapshot, evidence }));
}

// --- Routes -----------------------------------------------------------------

export function registerCreditNoteRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
  provider?: StatutoryProvider,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  // The organisation-wide credit-note register. A work-scoped member sees
  // notes of their assigned Works and NOTHING against a direct invoice —
  // the same settled posture the tax-invoice register takes on a document
  // that belongs to no Work (register.ts), and now the same one
  // `assertNoteWorkAccess`/`assertDirectNoteAccess` enforce on the write
  // path. A direct invoice's notes were the enumeration oracle that made
  // the invoice module's per-document gap reachable; hiding them here
  // closes that half. Work-scope binds through a Work; a document with
  // none is organisation-level reach or nothing.
  tenantRoute(
    {
      method: 'GET',
      url: '/api/credit-notes',
      schema: { response: { 200: CreditNoteListResponseSchema, ...errorResponses } },
    },
    async ({ user, tenant }) => {
      const rows = await tenant(async (tx) => {
        const fullScope = await hasFullWorkScope(tx, user.id);
        if (fullScope) {
          return (await tx.unsafe(
            `select ${CN_COLUMNS} ${CN_FROM}
               order by cn.created_at desc, cn.id`,
          )) as unknown as CreditNoteRow[];
        }
        return (await tx.unsafe(
          `select ${CN_COLUMNS} ${CN_FROM}
             where cn.work_id in (
                  select work_id from work_assignments where user_id = $1
                )
             order by cn.created_at desc, cn.id`,
          [user.id],
        )) as unknown as CreditNoteRow[];
      });
      return { creditNotes: rows.map(toCreditNote) };
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/tax-invoices/:id/credit-notes',
      schema: {
        params: IdParamsSchema,
        response: { 200: CreditNoteListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: invoiceId } = request.params;
      const rows = await tenant(async (tx) => {
        const [invoice] = await tx<{ work_id: string | null }[]>`
            select work_id from tax_invoices where id = ${invoiceId}
          `;
        if (!invoice) {
          throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
        }
        await assertNoteWorkAccess(tx, user.id, invoice.work_id);
        return (await tx.unsafe(
          `select ${CN_COLUMNS} ${CN_FROM}
             where cn.tax_invoice_id = $1
             order by cn.created_at desc, cn.id`,
          [invoiceId],
        )) as unknown as CreditNoteRow[];
      });
      return { creditNotes: rows.map(toCreditNote) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tax-invoices/:id/credit-notes',
      schema: {
        params: IdParamsSchema,
        body: CreateCreditNoteRequestSchema,
        response: { 201: CreditNoteDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: invoiceId } = request.params;
      const body = request.body;
      const reason = body.reason.trim();

      const detail = await tenant(async (tx) => {
        const invoice = await lockInvoiceForNote(tx, invoiceId);
        await assertNoteWorkAccess(tx, user.id, invoice.work_id);
        // Only a SUBMITTED invoice takes a credit note: a draft is
        // deleted, a cancelled one already left the register, and a
        // superseded one already has its note.
        if (invoice.status !== 'submitted') {
          throw httpError(
            409,
            'TAX_INVOICE_STATUS_CONFLICT',
            `A credit note supersedes a submitted tax invoice (current status: ${invoice.status}).`,
          );
        }
        await assertNoteDateValid(tx, body.noteDate, invoice.invoice_date);
        const [live] = await tx<{ id: string; note_number: string | null }[]>`
            select id, note_number from credit_notes
            where tax_invoice_id = ${invoiceId} and status <> 'cancelled'
          `;
        if (live) {
          throw draftConflictError(
            'CREDIT_NOTE_EXISTS',
            `This invoice already has a live credit note${live.note_number === null ? '' : ` (${live.note_number})`}; cancel or delete it before raising another.`,
            live.id,
          );
        }
        const [created] = await tx<{ id: string }[]>`
            insert into credit_notes (
              organisation_id, tax_invoice_id, work_id, note_date, reason,
              number_prefix, created_by_user_id
            )
            values (
              ${organisationId}, ${invoiceId}, ${invoice.work_id},
              ${body.noteDate}, ${reason}, ${body.numberPrefix ?? null},
              ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'CREDIT_NOTE_EXISTS',
              'This invoice already has a live credit note; cancel or delete it before raising another.',
            );
          }
          throw error;
        });
        if (!created) throw new Error('credit note insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'credit_note.created',
          'credit_notes',
          created.id,
          {
            taxInvoiceId: invoiceId,
            invoiceNumber: invoice.invoice_number,
            noteDate: body.noteDate,
          },
        );
        return readDetail(tx, created.id);
      });
      return reply.status(201).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/credit-notes/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: CreditNoteDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [ref] = await tx<{ work_id: string | null }[]>`
          select work_id from credit_notes where id = ${id}
        `;
        if (!ref) throw httpError(404, 'CREDIT_NOTE_NOT_FOUND', 'No such credit note.');
        await assertNoteWorkAccess(tx, user.id, ref.work_id);
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/credit-notes/:id',
      schema: {
        params: IdParamsSchema,
        body: CreateCreditNoteRequestSchema,
        response: { 200: CreditNoteDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const reason = body.reason.trim();
      return tenant(async (tx) => {
        const note = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        requireStatus(note, 'draft');
        if (note.invoice_date !== null) {
          await assertNoteDateValid(tx, body.noteDate, note.invoice_date);
        }
        await tx`
          update credit_notes
          set note_date = ${body.noteDate}, reason = ${reason},
              number_prefix = ${body.numberPrefix ?? null}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'credit_note.updated',
          'credit_notes',
          id,
          {
            before: { noteDate: note.note_date, reason: note.reason },
            after: { noteDate: body.noteDate, reason },
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/credit-notes/:id',
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        const note = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        // Rule 8: a draft is not yet a document, so it deletes.
        requireStatus(note, 'draft');
        await tx`delete from credit_notes where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'credit_note.deleted',
          'credit_notes',
          id,
          {
            taxInvoiceId: note.tax_invoice_id,
          },
        );
      });
      return reply.status(204).send(null);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/credit-notes/:id/issue',
      schema: {
        params: IdParamsSchema,
        response: { 201: CreditNoteDetailResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const detail = await tenant(async (tx) => {
        // Issuing assigns a legal number, copies frozen money and
        // supersedes the invoice: issue authority, like invoice submit.
        const note = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        requireStatus(note, 'draft');
        // The invoice row lock is what the whole transition happens
        // under: issue and supersede are one atomic act.
        const invoice = await lockInvoiceForNote(tx, note.tax_invoice_id);
        if (invoice.status !== 'submitted') {
          throw httpError(
            409,
            'TAX_INVOICE_STATUS_CONFLICT',
            `A credit note supersedes a submitted tax invoice (current status: ${invoice.status}).`,
          );
        }
        if (
          invoice.irp_provider_state === 'registering' ||
          invoice.irp_provider_state === 'cancelling'
        ) {
          throw httpError(
            409,
            'STATUTORY_OPERATION_IN_PROGRESS',
            'Resolve the in-flight provider operation on the invoice before superseding it.',
          );
        }
        await assertNoteDateValid(tx, note.note_date, invoice.invoice_date);
        if (
          invoice.taxable_value === null ||
          invoice.cgst_amount === null ||
          invoice.sgst_amount === null ||
          invoice.igst_amount === null ||
          invoice.round_off === null ||
          invoice.total_amount === null
        ) {
          throw new Error(`submitted tax invoice ${invoice.id} is missing money`);
        }
        const [snapshotRow] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from tax_invoices where id = ${invoice.id}
          `;
        if (!snapshotRow) throw new Error('invoice snapshot disappeared');
        const rawInvoiceSnapshot = parseJsonbColumn(snapshotRow.issued_snapshot);
        try {
          // Parse-validate now, so an unrenderable historic snapshot
          // is a named refusal at issue rather than a broken document.
          parseTaxInvoiceIssuedSnapshot(rawInvoiceSnapshot);
        } catch (error) {
          if (error instanceof TaxInvoiceSnapshotError) {
            throw httpError(
              409,
              error.code,
              'The superseded invoice’s frozen snapshot is incomplete; the credit note cannot be built from it.',
            );
          }
          throw error;
        }

        const [organisation] = await tx<
          {
            invoice_number_prefix: string | null;
            einvoice_applicability: 'undeclared' | 'not_applicable' | 'applicable';
            einvoice_applicable_from: string | null;
            irp_reporting_window_days: number | null;
          }[]
        >`
            select invoice_number_prefix, einvoice_applicability,
                   einvoice_applicable_from::text as einvoice_applicable_from,
                   irp_reporting_window_days
            from organisations
            where id = app_private.current_organisation_id()
          `;
        if (!organisation) throw new Error('bound organisation disappeared');

        const [buyer] = await tx<{ division_code: string | null }[]>`
            select division_code from contacts
            where id = ${invoice.buyer_contact_id}
          `;

        // Gapless per (organisation, financial year) under the counter
        // row lock, exactly like the invoice's.
        const fyLabel = financialYearLabel(note.note_date);
        const prefix =
          note.number_prefix ??
          invoice.number_prefix ??
          organisation.invoice_number_prefix;
        const template = await loadNumberTemplate(tx, 'credit_note');
        const [counter] = await tx<{ next_value: number }[]>`
            insert into credit_note_counters (organisation_id, fy_label)
            values (${organisationId}, ${fyLabel})
            on conflict (organisation_id, fy_label)
            do update set next_value = credit_note_counters.next_value + 1
            returning next_value
          `;
        if (!counter) throw new Error('credit note counter upsert returned no row');
        const sequence = counter.next_value;
        let noteNumber: string;
        try {
          noteNumber = renderNumberTemplate(template, {
            prefix,
            divisionCode: buyer?.division_code ?? null,
            financialYear: fyLabel,
            documentDate: note.note_date,
            sequence,
          });
        } catch (cause) {
          if (cause instanceof NumberTemplateError) {
            throw httpError(400, 'CREDIT_NOTE_NUMBER_UNFILLABLE', cause.message);
          }
          throw cause;
        }

        // THE DOCUMENT, frozen: the note's identity and reason, and the
        // superseded invoice's issued snapshot VERBATIM — parties,
        // line and money are the invoice's, in full.
        const issuedSnapshot = {
          templateVersion: CREDIT_NOTE_TEMPLATE_VERSION,
          noteNumber,
          noteDate: note.note_date,
          fyLabel,
          reason: note.reason,
          invoice: rawInvoiceSnapshot,
        };

        // Finding 20's machinery, inherited (0049): the reporting
        // deadline is frozen at issue from the declaration then in
        // force. The 30-day rule covers credit notes too.
        const reportingWindowApplies =
          organisation.einvoice_applicability === 'applicable' &&
          organisation.einvoice_applicable_from !== null &&
          note.note_date >= organisation.einvoice_applicable_from &&
          organisation.irp_reporting_window_days !== null;

        const [stamped] = await tx<{ irp_reporting_deadline: string | null }[]>`
            update credit_notes
            set status = 'issued', note_number = ${noteNumber},
                number_prefix = ${prefix},
                sequence_number = ${sequence}, fy_label = ${fyLabel},
                taxable_value = ${invoice.taxable_value},
                cgst_amount = ${invoice.cgst_amount},
                sgst_amount = ${invoice.sgst_amount},
                igst_amount = ${invoice.igst_amount},
                round_off = ${invoice.round_off},
                total_amount = ${invoice.total_amount},
                issued_snapshot = ${tx.json(issuedSnapshot as never)},
                irp_reporting_deadline = case when ${reportingWindowApplies}
                  then ${note.note_date}::date
                    + ${organisation.irp_reporting_window_days ?? 0}::int
                  else null end,
                issued_by_user_id = ${user.id}, issued_at = now()
            where id = ${id}
            returning irp_reporting_deadline::text as irp_reporting_deadline
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'NUMBER_CONFLICT',
              `Credit note number ${noteNumber} already exists in this organisation.`,
            );
          }
          throw error;
        });

        // The supersession, in the SAME transaction under the invoice
        // row lock: the 0051 trigger arm proves an issued credit note
        // exists, the one-live-per-MB index stops seeing the invoice,
        // and every issued fact and IRN byte stays frozen.
        await tx`
            update tax_invoices set status = 'superseded'
            where id = ${invoice.id}
          `;

        await audit(
          tx,
          organisationId,
          user.id,
          'credit_note.issued',
          'credit_notes',
          id,
          {
            noteNumber,
            fyLabel,
            sequence,
            taxInvoiceId: invoice.id,
            invoiceNumber: invoice.invoice_number,
            totalAmount: invoice.total_amount,
            irpReportingDeadline: stamped?.irp_reporting_deadline ?? null,
          },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'tax_invoice.superseded',
          'tax_invoices',
          invoice.id,
          {
            invoiceNumber: invoice.invoice_number,
            creditNoteId: id,
            creditNoteNumber: noteNumber,
            measurementBookId: invoice.measurement_book_id,
          },
        );
        return readDetail(tx, id);
      });
      return reply.status(201).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/credit-notes/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelCreditNoteRequestSchema,
        response: { 200: CreditNoteDetailResponseSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const note = cancellationNote(body.note);
      return tenant(async (tx) => {
        const creditNote = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, creditNote.work_id);
        if (creditNote.status === 'draft') {
          throw httpError(
            409,
            'CREDIT_NOTE_STATUS_CONFLICT',
            'Draft credit notes are deleted, not cancelled.',
          );
        }
        requireStatus(creditNote, 'issued');
        if (
          creditNote.irp_provider_state !== 'not_requested' &&
          creditNote.irp_provider_state !== 'cancelled'
        ) {
          throw httpError(
            409,
            'IRP_CANCELLATION_REQUIRED',
            creditNote.irp_provider_state === 'registered' &&
              !creditNote.irp_cancel_window_open
              ? "This credit note is registered at the IRP and NIC's 24-hour cancellation window has closed, so its IRN can no longer be cancelled; the credit note stands."
              : 'Resolve any pending/unknown registration and cancel confirmed IRP evidence before cancelling the local credit note.',
          );
        }
        const invoice = await lockInvoiceForNote(tx, creditNote.tax_invoice_id);
        // Local cancel reverts the invoice superseded -> submitted — but
        // only while the invoice's Measurement Book has NOT been
        // re-invoiced. The friendly check names the successor; the
        // one-live-per-MB unique index decides races.
        if (invoice.measurement_book_id !== null) {
          const [successor] = await tx<{ id: string; invoice_number: string | null }[]>`
            select id, invoice_number from tax_invoices
            where measurement_book_id = ${invoice.measurement_book_id}
              and id <> ${invoice.id}
              and status not in ('cancelled', 'superseded')
          `;
          if (successor) {
            throw httpError(
              409,
              'MEASUREMENT_BOOK_REINVOICED',
              `The Measurement Book has been re-invoiced${successor.invoice_number === null ? '' : ` (${successor.invoice_number})`}; the superseded invoice cannot be revived, so this credit note cannot be cancelled.`,
            );
          }
        }
        await tx`
          update credit_notes
          set status = 'cancelled', cancelled_by_user_id = ${user.id},
              cancelled_at = now(), cancellation_note = ${note}
          where id = ${id}
        `;
        if (invoice.status === 'superseded') {
          // The guarded revert: the trigger permits superseded ->
          // submitted only now that no issued credit note remains, and
          // the partial unique index refuses it if the MB was
          // re-invoiced in a race.
          await tx`
            update tax_invoices set status = 'submitted'
            where id = ${invoice.id}
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'MEASUREMENT_BOOK_REINVOICED',
                'The Measurement Book has been re-invoiced; the superseded invoice cannot be revived, so this credit note cannot be cancelled.',
              );
            }
            throw error;
          });
          await audit(
            tx,
            organisationId,
            user.id,
            'tax_invoice.supersession_reverted',
            'tax_invoices',
            invoice.id,
            {
              invoiceNumber: invoice.invoice_number,
              creditNoteId: id,
              creditNoteNumber: creditNote.note_number,
            },
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'credit_note.cancelled',
          'credit_notes',
          id,
          {
            noteNumber: creditNote.note_number,
            taxInvoiceId: creditNote.tax_invoice_id,
            note,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/credit-notes/:id/recipient-itc',
      schema: {
        params: IdParamsSchema,
        body: UpdateRecipientItcRequestSchema,
        response: { 200: CreditNoteDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const note = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        requireStatus(note, 'issued');
        await tx`
          update credit_notes
          set recipient_itc_status = ${body.recipientItcStatus}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'credit_note.recipient_itc_recorded',
          'credit_notes',
          id,
          {
            before: note.recipient_itc_status,
            after: body.recipientItcStatus,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/credit-notes/:id/recover-provider-operation',
      schema: {
        params: IdParamsSchema,
        response: { 202: CreditNoteDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const detail = await tenant(async (tx) => {
        const note = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        // Branched per state, so this route declares nothing and checks
        // inline. Recovery closes out a statutory operation and moves
        // the note's provider state, so it needs the compliance
        // authority alongside the document one.
        if (note.irp_provider_state === 'registering') {
          await requireAuthorities(tx, user.id, ['issue', 'statutory']);
        } else if (note.irp_provider_state === 'cancelling') {
          await requireAuthorities(tx, user.id, ['cancel', 'statutory']);
        } else {
          throw httpError(
            409,
            'IRP_STATE_CONFLICT',
            'Only an in-progress IRP provider operation can be checked for stale recovery.',
          );
        }
        const recovered = await recoverStaleStatutoryOperation(tx, {
          creditNoteId: id,
        });
        if (recovered.length === 0) {
          throw httpError(
            409,
            'STATUTORY_OPERATION_IN_PROGRESS',
            'The provider operation is still within its two-minute lease.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'credit_note.provider_operation_recovered',
          'credit_notes',
          id,
          { operations: recovered },
        );
        return readDetail(tx, id);
      });
      return reply.status(202).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/credit-notes/:id/register-irp',
      schema: {
        params: IdParamsSchema,
        response: {
          200: CreditNoteDetailResponseSchema,
          202: CreditNoteDetailResponseSchema,
          ...errorResponses,
        },
      },
      // Both branches — fresh CRN registration and reconcile-by-lookup —
      // open a ledger operation and write the portal's answer onto a
      // legal document, so both carry the compliance authority.
      authority: ['issue', 'statutory'],
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;

      const prepared = await tenant(async (tx) => {
        await recoverStaleStatutoryOperation(tx, { creditNoteId: id });
        const note = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        if (provider === undefined) {
          throw httpError(
            409,
            'STATUTORY_PROVIDER_NOT_CONFIGURED',
            'Whitebooks transport is not configured.',
          );
        }
        requireStatus(note, 'issued');
        if (note.irp_provider_state === 'registered' || note.irn !== null) {
          throw httpError(
            409,
            'IRP_ALREADY_RECORDED',
            `This credit note already carries IRN ${note.irn ?? '(registered)'}; registration is not repeated.`,
          );
        }
        if (
          note.irp_provider_state === 'registering' ||
          note.irp_provider_state === 'cancelling'
        ) {
          throw httpError(
            409,
            'STATUTORY_OPERATION_IN_PROGRESS',
            'A statutory-provider operation is already in progress for this credit note.',
          );
        }
        if (
          note.irp_provider_state === 'cancelled' ||
          note.irp_provider_state === 'cancellation_unknown'
        ) {
          throw httpError(
            409,
            'IRP_STATE_CONFLICT',
            `IRP registration cannot start from ${note.irp_provider_state}.`,
          );
        }
        const [snapshotRow] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from credit_notes where id = ${id}
          `;
        if (!snapshotRow) throw new Error(`credit note ${id} disappeared while locked`);
        let snapshot: ReturnType<typeof parseCreditNoteIssuedSnapshot>;
        let payloadJson: string;
        try {
          const issued = parseJsonbColumn(snapshotRow.issued_snapshot);
          snapshot = parseCreditNoteIssuedSnapshot(issued);
          payloadJson = stringifyStatutoryJson(buildFrozenCrnPayload(issued));
        } catch (error) {
          if (error instanceof EInvoiceB2cUnsupportedError) {
            throw httpError(409, error.code, error.message);
          }
          if (error instanceof TaxInvoiceSnapshotError) {
            throw httpError(
              409,
              error.code,
              'The frozen issued credit note is incomplete for IRP submission; live master data was not substituted.',
            );
          }
          throw error;
        }
        const identity: IrpDocumentIdentity = {
          gstin: snapshot.invoice.supplier.gstin,
          documentNumber: snapshot.noteNumber,
          documentDate: snapshot.noteDate,
          documentType: 'CRN',
        };
        const reconcileOnly = note.irp_provider_state === 'registration_unknown';
        // The 0049 gates apply to the credit note identically: the
        // declaration must exist and permit the transport, and a fresh
        // registration past the note's own frozen deadline is refused
        // — reconcile-by-lookup is not a new report.
        const today = await requireEinvoiceDeclared(tx);
        if (!reconcileOnly) assertNoteReportingWindowOpen(note, today);
        const requestBody = reconcileOnly
          ? stringifyStatutoryJson(identity)
          : payloadJson;
        const operationId = await startStatutoryOperation(tx, {
          organisationId,
          userId: user.id,
          provider,
          operation: reconcileOnly ? 'reconcile_crn' : 'register_crn',
          requestSha256: sha256Hex(requestBody),
          requestBody,
          creditNoteId: id,
        });
        await tx`
            update credit_notes
            set irp_provider = 'whitebooks', irp_provider_state = 'registering'
            where id = ${id}
          `;
        return { operationId, identity, payloadJson, reconcileOnly, provider };
      });

      let evidence: IrpRegistrationEvidence | null = null;
      let failure: ReturnType<typeof providerFailure> | null = null;
      if (prepared.reconcileOnly) {
        try {
          evidence = await prepared.provider.findInvoiceByDocument(prepared.identity);
          if (evidence === null) {
            failure = {
              status: 'unknown',
              providerCode: null,
              httpStatus: null,
              publicCode: 'WHITEBOOKS_IRP_NOT_FOUND',
              rawResponse: null,
            };
          }
        } catch (error) {
          const foundFailure = providerFailure(error);
          failure = { ...foundFailure, status: 'unknown' };
        }
      } else {
        try {
          evidence = await prepared.provider.registerInvoice(
            prepared.identity,
            prepared.payloadJson,
          );
        } catch (error) {
          const registrationFailure = providerFailure(error);
          if (registrationFailure.status === 'unknown') {
            try {
              evidence = await prepared.provider.findInvoiceByDocument(
                prepared.identity,
              );
              if (evidence === null) failure = registrationFailure;
            } catch (lookupError) {
              const lookupFailure = providerFailure(lookupError);
              failure = {
                ...lookupFailure,
                status: 'unknown',
                publicCode: registrationFailure.publicCode,
              };
            }
          } else {
            failure = registrationFailure;
          }
        }
      }

      const detail = await tenant(async (tx) => {
        const note = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        if (note.irp_provider_state !== 'registering') {
          throw new Error(`credit note ${id} left the registering state`);
        }
        if (evidence !== null) {
          await tx`
              update credit_notes
              set irn = ${evidence.irn}, ack_number = ${evidence.ackNumber},
                  ack_date = ${evidence.ackDate},
                  ack_date_text = ${evidence.ackDateText},
                  signed_qr = ${evidence.signedQr},
                  signed_invoice = ${evidence.signedInvoice},
                  irp_provider = 'whitebooks', irp_provider_state = 'registered'
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: 'succeeded',
            responseBody: evidence.rawResponse,
          });
          await audit(
            tx,
            organisationId,
            user.id,
            'credit_note.irp_registered',
            'credit_notes',
            id,
            {
              noteNumber: note.note_number,
              irn: evidence.irn,
              ackNumber: evidence.ackNumber,
              provider: prepared.provider.name,
              operationId: prepared.operationId,
            },
          );
        } else {
          const result = failure ?? {
            status: 'unknown' as const,
            providerCode: null,
            httpStatus: null,
            publicCode: 'STATUTORY_PROVIDER_UNKNOWN',
            rawResponse: null,
          };
          await tx`
              update credit_notes
              set irp_provider = 'whitebooks',
                  irp_provider_state = ${
                    result.status === 'failed'
                      ? 'registration_failed'
                      : 'registration_unknown'
                  }
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: result.status,
            providerCode: result.providerCode,
            httpStatus: result.httpStatus,
            responseBody: result.rawResponse,
          });
          await audit(
            tx,
            organisationId,
            user.id,
            'credit_note.irp_registration_unresolved',
            'credit_notes',
            id,
            {
              noteNumber: note.note_number,
              outcome: result.status,
              providerCode: result.providerCode,
              provider: prepared.provider.name,
              operationId: prepared.operationId,
            },
          );
        }
        return readDetail(tx, id);
      });

      if (evidence !== null) return reply.status(200).send(detail);
      const result = failure ?? {
        status: 'unknown' as const,
        publicCode: 'STATUTORY_PROVIDER_UNKNOWN',
      };
      if (result.status === 'failed') {
        throw httpError(
          502,
          result.publicCode,
          'Whitebooks rejected the CRN registration. The credit note remains issued locally and unregistered at the IRP.',
        );
      }
      return reply.status(202).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/credit-notes/:id/cancel-irp',
      schema: {
        params: IdParamsSchema,
        body: CancelStatutoryDocumentRequestSchema,
        response: {
          200: CreditNoteDetailResponseSchema,
          202: CreditNoteDetailResponseSchema,
          ...errorResponses,
        },
      },
      authority: ['cancel', 'statutory'],
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const remark = body.remark.trim();
      const prepared = await tenant(async (tx) => {
        const recoveredOperations = await recoverStaleStatutoryOperation(tx, {
          creditNoteId: id,
        });
        const note = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        requireStatus(note, 'issued');
        if (
          note.irp_provider_state === 'cancellation_unknown' &&
          recoveredOperations.includes('cancel_crn')
        ) {
          return {
            recovered: true as const,
            detail: await readDetail(tx, id),
          };
        }
        if (provider === undefined) {
          throw httpError(
            409,
            'STATUTORY_PROVIDER_NOT_CONFIGURED',
            'Whitebooks transport is not configured.',
          );
        }
        if (
          note.irn === null ||
          note.irp_provider !== 'whitebooks' ||
          note.irp_provider_state !== 'registered'
        ) {
          throw httpError(
            409,
            'IRP_STATE_CONFLICT',
            note.irp_provider_state === 'cancellation_unknown'
              ? 'The earlier cancellation result is unknown. It cannot be sent again blindly; reconcile it with Whitebooks/NIC support.'
              : 'Only a Whitebooks-registered IRN can be cancelled through this action.',
          );
        }
        // The credit note's OWN 24-hour window, before a provider
        // operation is opened.
        assertNoteIrpCancelWindowOpen(note);
        const [snapshotRow] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from credit_notes where id = ${id}
          `;
        if (!snapshotRow) throw new Error(`credit note ${id} disappeared`);
        const gstin = parseCreditNoteIssuedSnapshot(
          parseJsonbColumn(snapshotRow.issued_snapshot),
        ).invoice.supplier.gstin;
        const requestJson = stringifyStatutoryJson({
          Irn: note.irn,
          CnlRsn: body.reasonCode,
          CnlRem: remark,
        });
        const operationId = await startStatutoryOperation(tx, {
          organisationId,
          userId: user.id,
          provider,
          operation: 'cancel_crn',
          requestSha256: sha256Hex(requestJson),
          requestBody: requestJson,
          creditNoteId: id,
        });
        await tx`
            update credit_notes set irp_provider_state = 'cancelling'
            where id = ${id}
          `;
        return {
          recovered: false as const,
          operationId,
          irn: note.irn,
          gstin,
          provider,
        };
      });

      if (prepared.recovered) {
        return reply.status(202).send(prepared.detail);
      }

      let cancelled: {
        readonly cancelledAtText: string;
        readonly cancelledAt: string;
        readonly rawResponse: string;
      } | null = null;
      let failure: ReturnType<typeof providerFailure> | null = null;
      try {
        cancelled = await prepared.provider.cancelInvoice({
          gstin: prepared.gstin,
          irn: prepared.irn,
          reasonCode: body.reasonCode,
          remark,
        });
      } catch (error) {
        failure = providerFailure(error);
      }

      const outcome = await tenant(async (tx) => {
        const note = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        if (note.irp_provider_state !== 'cancelling') {
          throw new Error(`credit note ${id} left the cancelling state`);
        }
        const windowClosed =
          note.irp_cancel_window_closes_at === null ||
          note.irp_cancel_window_closes_at.getTime() <= Date.now();
        if (cancelled !== null) {
          await tx`
              update credit_notes
              set irp_provider_state = 'cancelled',
                  irp_cancelled_at = ${cancelled.cancelledAt},
                  irp_cancelled_at_text = ${cancelled.cancelledAtText},
                  irp_cancel_reason_code = ${body.reasonCode},
                  irp_cancel_remark = ${remark}
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: 'succeeded',
            responseBody: cancelled.rawResponse,
          });
        } else {
          const result = failure ?? {
            status: 'unknown' as const,
            providerCode: null,
            httpStatus: null,
            rawResponse: null,
          };
          await tx`
              update credit_notes
              set irp_provider_state = ${
                result.status === 'failed' ? 'registered' : 'cancellation_unknown'
              }
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: result.status,
            providerCode: result.providerCode,
            httpStatus: result.httpStatus,
            responseBody: result.rawResponse,
          });
        }
        await audit(
          tx,
          organisationId,
          user.id,
          cancelled === null
            ? 'credit_note.irp_cancellation_unresolved'
            : 'credit_note.irp_cancelled',
          'credit_notes',
          id,
          {
            irn: prepared.irn,
            outcome: cancelled === null ? (failure?.status ?? 'unknown') : 'succeeded',
            provider: prepared.provider.name,
            operationId: prepared.operationId,
          },
        );
        return { detail: await readDetail(tx, id), windowClosed };
      });
      if (cancelled !== null) return reply.status(200).send(outcome.detail);
      if (failure?.status === 'failed') {
        if (outcome.windowClosed) {
          throw httpError(
            409,
            'IRP_CANCEL_WINDOW_CLOSED',
            "Whitebooks/NIC refused the IRN cancellation and the credit note's 24-hour window has closed. The credit note remains registered at the IRP.",
          );
        }
        throw httpError(
          502,
          failure.publicCode,
          'Whitebooks rejected the IRP cancellation. The IRN remains registered.',
        );
      }
      return reply.status(202).send(outcome.detail);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/credit-notes/:id/irp-payload',
      schema: { params: IdParamsSchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const payload = await tenant(async (tx) => {
        const [note] = await tx<
          {
            work_id: string | null;
            status: CreditNoteStatus;
            issued_snapshot: unknown;
          }[]
        >`
            select work_id, status, issued_snapshot
            from credit_notes where id = ${id}
          `;
        if (!note) {
          throw httpError(404, 'CREDIT_NOTE_NOT_FOUND', 'No such credit note.');
        }
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        if (note.status !== 'issued') {
          throw httpError(
            409,
            'CREDIT_NOTE_STATUS_CONFLICT',
            `The CRN payload exists for an issued credit note (current status: ${note.status}).`,
          );
        }
        try {
          return buildFrozenCrnPayload(parseJsonbColumn(note.issued_snapshot));
        } catch (error) {
          if (error instanceof EInvoiceB2cUnsupportedError) {
            throw httpError(409, error.code, error.message);
          }
          if (error instanceof TaxInvoiceSnapshotError) {
            throw httpError(
              409,
              error.code,
              'The frozen issued credit note is incomplete for IRP submission; it was not replaced with live master data.',
            );
          }
          throw error;
        }
      });
      void reply.type('application/json; charset=utf-8');
      return reply.send(stringifyStatutoryJson(payload));
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/credit-notes/:id/render',
      schema: {
        params: IdParamsSchema,
        response: { 200: CreditNoteDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;

      // Immutable render inputs in one short transaction; Gotenberg and
      // object storage run without a database lock; a second transaction
      // verifies the append-only IRP evidence did not change meanwhile.
      const prepared = await tenant(async (tx) => {
        const note = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        requireStatus(note, 'issued');
        const [source] = await tx<
          { issued_snapshot: unknown; signed_qr: string | null }[]
        >`
            select issued_snapshot, signed_qr from credit_notes where id = ${id}
          `;
        if (!source) throw new Error('credit note render source disappeared');
        const snapshot = parseCreditNoteIssuedSnapshot(
          parseJsonbColumn(source.issued_snapshot),
        );
        const evidence: TaxInvoiceIrpRenderEvidence = {
          provider: note.irp_provider,
          irn: note.irn,
          ackNumber: note.ack_number,
          ackDateText: note.ack_date_text,
          signedQr: source.signed_qr,
          legacyEvidenceMissing: note.irp_legacy_evidence_missing,
        };
        return { snapshot, evidence };
      });

      const renderSourceHash = noteRenderSourceHash(
        prepared.snapshot,
        prepared.evidence,
      );
      let html: string;
      try {
        html = await renderCreditNoteHtml(prepared.snapshot, prepared.evidence);
      } catch (error) {
        request.log.error({ err: error }, 'credit note render input failed');
        throw httpError(
          409,
          'RENDER_INPUT_INVALID',
          'The frozen credit note or signed QR evidence cannot be rendered safely.',
        );
      }

      const pdf = await renderPdfViaGotenberg(gotenbergUrl, html, {
        failureMessage:
          'The PDF service is unavailable; the issued credit note is unaffected — retry later.',
        logError: (error) => {
          request.log.error({ err: error }, 'credit note render failed');
        },
      });

      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/cn/${id}-${sha256.slice(0, 16)}.pdf`;
      try {
        await storage.put(objectKey, pdf);
      } catch (error) {
        request.log.error({ err: error }, 'credit note render storage failed');
        throw httpError(
          502,
          'RENDER_STORAGE_FAILED',
          'The rendered PDF could not be stored. The issued credit note and previous PDF remain unaffected.',
        );
      }

      return tenant(async (tx) => {
        const note = await lockCreditNote(tx, id);
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        requireStatus(note, 'issued');
        const [source] = await tx<
          { issued_snapshot: unknown; signed_qr: string | null }[]
        >`
          select issued_snapshot, signed_qr from credit_notes where id = ${id}
        `;
        if (!source) throw new Error('credit note render source disappeared');
        const currentSnapshot = parseCreditNoteIssuedSnapshot(
          parseJsonbColumn(source.issued_snapshot),
        );
        const currentEvidence: TaxInvoiceIrpRenderEvidence = {
          provider: note.irp_provider,
          irn: note.irn,
          ackNumber: note.ack_number,
          ackDateText: note.ack_date_text,
          signedQr: source.signed_qr,
          legacyEvidenceMissing: note.irp_legacy_evidence_missing,
        };
        if (
          noteRenderSourceHash(currentSnapshot, currentEvidence) !== renderSourceHash
        ) {
          throw httpError(
            409,
            'RENDER_SOURCE_CHANGED',
            'IRP evidence changed while the credit note was rendering; the previous PDF remains current — render again.',
          );
        }
        await tx`
          update credit_notes
          set template_version = ${CREDIT_NOTE_PDF_TEMPLATE_VERSION},
              rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'credit_note.rendered',
          'credit_notes',
          id,
          {
            sha256,
            sourceSha256: renderSourceHash,
            templateVersion: CREDIT_NOTE_PDF_TEMPLATE_VERSION,
            irpEvidenceIncluded: currentEvidence.irn !== null,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/credit-notes/:id/pdf',
      schema: { params: IdParamsSchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const rendered = await tenant(async (tx) => {
        const [note] = await tx<
          {
            work_id: string | null;
            rendered_object_key: string | null;
            rendered_sha256: string | null;
          }[]
        >`
            select work_id, rendered_object_key, rendered_sha256
            from credit_notes where id = ${id}
          `;
        if (!note) {
          throw httpError(404, 'CREDIT_NOTE_NOT_FOUND', 'No such credit note.');
        }
        await assertNoteWorkAccess(tx, user.id, note.work_id);
        if (note.rendered_object_key === null || note.rendered_sha256 === null) {
          throw httpError(
            404,
            'PDF_NOT_AVAILABLE',
            'This credit note has not been rendered yet.',
          );
        }
        return { key: note.rendered_object_key, sha256: note.rendered_sha256 };
      });
      const bytes = await storage.get(rendered.key);
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      if (actualSha256 !== rendered.sha256) {
        throw httpError(
          409,
          'RENDERED_PDF_INTEGRITY_FAILED',
          'The retained credit-note PDF no longer matches its recorded digest.',
        );
      }
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="credit-note-${id}.pdf"`,
      );
      return reply.send(bytes);
    },
  );
}
