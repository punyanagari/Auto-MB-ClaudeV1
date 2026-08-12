import {
  ApiErrorSchema,
  CancelStatutoryDocumentRequestSchema,
  CancelTaxInvoiceRequestSchema,
  CreateDirectTaxInvoiceRequestSchema,
  CreateTaxInvoiceRequestSchema,
  RecordIrpResponseRequestSchema,
  RecordManualStatutoryCancellationRequestSchema,
  TaxInvoiceDetailResponseSchema,
  TaxInvoiceListResponseSchema,
  UpdateTaxInvoiceRequestSchema,
  type CancelTaxInvoiceRequest,
  type CancelStatutoryDocumentRequest,
  type CreateDirectTaxInvoiceRequest,
  type CreateTaxInvoiceRequest,
  type RecordIrpResponseRequest,
  type RecordManualStatutoryCancellationRequest,
  type IrpProviderState,
  type TaxInvoice,
  type TaxInvoiceDetailResponse,
  type TaxInvoiceStatus,
  type UpdateTaxInvoiceRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import { amountInWords } from '../amount-in-words.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireAuthority, requireWriterRole } from '../authz.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
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
import { assertGstRateNotified } from '../gst-rates.js';
import { httpError } from '../http.js';
import {
  NumberTemplateError,
  loadNumberTemplate,
  renderNumberTemplate,
} from '../number-series.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
import {
  renderTaxInvoiceHtml,
  TAX_INVOICE_PDF_TEMPLATE_VERSION,
  type TaxInvoiceIrpRenderEvidence,
} from '../tax-invoice-html.js';
import {
  buildFrozenIrpPayload,
  EInvoiceB2cUnsupportedError,
  parseTaxInvoiceIssuedSnapshot,
  TaxInvoiceSnapshotError,
} from '../tax-invoice-snapshot.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { cancellationNote } from './challans.js';

/**
 * The GST tax invoice (migration 0035): CUMULATIVE, one service line at
 * a SAC for a finalized Measurement Book's total — a works contract is a
 * supply of services, so there are no per-item HSN lines, ever.
 *
 * Draft (unnumbered, amounts open) -> submitted (the money moment: a
 * gapless per-organisation PER-FINANCIAL-YEAR number under the counter
 * row lock, the buyer snapshotted from its contact, the taxable value
 * taken VERBATIM from the MB total and the CGST+SGST/IGST split computed
 * in exact SQL numeric arithmetic) -> cancelled with a note it keeps
 * forever. Submitting is what closes the MB it bills — the 0035 trigger
 * refuses cancelling an MB with a live invoice — and cancelling the
 * invoice releases the MB for a corrected one. The whole posture — one
 * transaction per request, the row locked before every transition, issue
 * and cancel behind their explicit authorities, every change audited,
 * database refusals surfaced as named 400/409s — is the delivery
 * challan's (routes/challans.ts).
 *
 * TWO DELIBERATE DEPARTURES from the site documents:
 *
 * - No completed-Work refusal. R8 freezes OPERATIONS (challans,
 *   installations, MBs); the invoice bills measurement that is already
 *   frozen, and billing legitimately outlives completion — the bill
 *   preparation route (measurement-books.ts) takes the same view.
 * - Invoice dates are organisation-local calendar facts. A delayed entry may
 *   record a past date across a financial-year boundary, but never a future
 *   date; an MB-backed invoice also cannot predate the Measurement Book.
 *
 * 0041 stores the draft buyer in the constrained buyer_contact_id business
 * column. Submit resolves and freezes the buyer snapshot; audit events prove
 * the change but are never operational state.
 */

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  502: ApiErrorSchema,
} as const;

const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_RENDERED_PDF_BYTES = 20 * 1024 * 1024;
const TAX_INVOICE_RENDER_TIMEOUT_MS = 45_000;

async function readBoundedPdfResponse(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (
    (Number.isFinite(declaredLength) && declaredLength > MAX_RENDERED_PDF_BYTES) ||
    declaredLength < 0
  ) {
    throw new Error('Gotenberg response exceeds the PDF size limit');
  }
  if (response.body === null) throw new Error('Gotenberg response has no body');

  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_RENDERED_PDF_BYTES) {
      await reader.cancel('PDF size limit exceeded');
      throw new Error('Gotenberg response exceeds the PDF size limit');
    }
    chunks.push(Buffer.from(value));
  }
  const pdf = Buffer.concat(chunks, total);
  if (
    pdf.length < PDF_MAGIC.length ||
    !pdf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)
  ) {
    throw new Error('Gotenberg response is not an accepted PDF');
  }
  return pdf;
}

// --- Row shapes -------------------------------------------------------------

interface InvoiceRow {
  id: string;
  work_id: string | null;
  measurement_book_id: string | null;
  mb_number: string | null;
  status: TaxInvoiceStatus;
  invoice_number: string | null;
  sequence_number: number | null;
  fy_label: string | null;
  invoice_date: string;
  sac_code: string;
  service_description: string;
  gst_rate: string;
  place_of_supply: string;
  reverse_charge_applicable: boolean | null;
  buyer_contact_id: string;
  taxable_value: string | null;
  cgst_amount: string | null;
  sgst_amount: string | null;
  igst_amount: string | null;
  total_amount: string | null;
  irn: string | null;
  ack_number: string | null;
  ack_date: Date | null;
  cancellation_note: string | null;
  created_at: Date;
  submitted_at: Date | null;
  cancelled_at: Date | null;
  round_off: string | null;
  customer_po_reference: string | null;
  unit_label: string | null;
  notes: string | null;
  ship_to_contact_id: string | null;
  number_prefix: string | null;
  ack_date_text: string | null;
  irp_provider: 'manual' | 'whitebooks' | null;
  irp_provider_state: IrpProviderState;
  signed_invoice_available: boolean;
  rendered_object_key: string | null;
  irp_legacy_evidence_missing: boolean;
  irp_cancelled_at: Date | null;
  irp_cancelled_at_text: string | null;
  irp_cancel_reason_code: string | null;
  irp_cancel_remark: string | null;
  /** A DIRECT invoice's taxable value — the one raised against a private
   * customer, which has no Measurement Book to take a total from.
   * Exactly one of this and measurement_book_id is ever set (0039). */
  stated_taxable_value: string | null;
  /** The line's own value: the UNROUNDED sum of the taxable value and
   * its taxes, summed in SQL numeric. Derived, never stored — the
   * e-invoice payload needs it and deriving it by subtracting the
   * rounding delta in binary floating point would be a money error. */
  line_value: string | null;
}

/** `buyer_contact_id` is a real column on the invoice row (migration
 * 0041), read directly in both draft and submitted states. It was once
 * resolved from the newest audit event while draft; that made the audit
 * trail operational state and is no longer how this works. */
const TI_COLUMNS = `
  ti.id, ti.work_id, ti.measurement_book_id, mb.mb_number,
  ti.status, ti.invoice_number, ti.sequence_number, ti.fy_label,
  ti.invoice_date::text as invoice_date, ti.sac_code, ti.service_description,
  ti.gst_rate::text as gst_rate, ti.place_of_supply,
  ti.reverse_charge_applicable,
  ti.buyer_contact_id,
  ti.taxable_value::text as taxable_value, ti.cgst_amount::text as cgst_amount,
  ti.sgst_amount::text as sgst_amount, ti.igst_amount::text as igst_amount,
  ti.round_off::text as round_off, ti.total_amount::text as total_amount,
  (ti.taxable_value + ti.cgst_amount + ti.sgst_amount + ti.igst_amount)
    ::numeric(18,2)::text as line_value,
  ti.customer_po_reference, ti.unit_label, ti.notes, ti.ship_to_contact_id,
  ti.number_prefix, ti.ack_date_text,
  ti.irp_provider, ti.irp_provider_state,
  (ti.signed_invoice is not null) as signed_invoice_available,
  ti.rendered_object_key,
  ti.irp_legacy_evidence_missing, ti.irp_cancelled_at,
  ti.irp_cancelled_at_text, ti.irp_cancel_reason_code, ti.irp_cancel_remark,
  ti.stated_taxable_value::text as stated_taxable_value,
  ti.irn, ti.ack_number, ti.ack_date, ti.cancellation_note,
  ti.created_at, ti.submitted_at, ti.cancelled_at
`;

// LEFT join, not inner: a DIRECT invoice names no Measurement Book, and
// an inner join would make it invisible to every read in this module.
const TI_FROM = `
  from tax_invoices ti
  left join measurement_books mb on mb.id = ti.measurement_book_id
`;

function toInvoice(row: InvoiceRow): TaxInvoice {
  return {
    id: row.id,
    workId: row.work_id,
    measurementBookId: row.measurement_book_id,
    statedTaxableValue: row.stated_taxable_value,
    mbNumber: row.mb_number,
    status: row.status,
    invoiceNumber: row.invoice_number,
    sequenceNumber: row.sequence_number,
    fyLabel: row.fy_label,
    invoiceDate: row.invoice_date,
    sacCode: row.sac_code,
    serviceDescription: row.service_description,
    gstRate: row.gst_rate,
    placeOfSupply: row.place_of_supply,
    reverseChargeApplicable: row.reverse_charge_applicable,
    buyerContactId: row.buyer_contact_id,
    taxableValue: row.taxable_value,
    cgstAmount: row.cgst_amount,
    sgstAmount: row.sgst_amount,
    igstAmount: row.igst_amount,
    roundOff: row.round_off,
    totalAmount: row.total_amount,
    customerPoReference: row.customer_po_reference,
    unitLabel: row.unit_label,
    notes: row.notes,
    shipToContactId: row.ship_to_contact_id,
    numberPrefix: row.number_prefix,
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
    cancellationNote: row.cancellation_note,
    createdAt: row.created_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

async function readDetail(
  tx: TransactionSql,
  invoiceId: string,
): Promise<TaxInvoiceDetailResponse> {
  const rows = (await tx.unsafe(
    `select ${TI_COLUMNS}, ti.buyer_snapshot, ti.ship_to_snapshot,
            ti.issued_snapshot, ti.signed_qr ${TI_FROM}
     where ti.id = $1`,
    [invoiceId],
  )) as unknown as (InvoiceRow & {
    buyer_snapshot: unknown;
    ship_to_snapshot: unknown;
    issued_snapshot: unknown;
    signed_qr: string | null;
  })[];
  const row = rows[0];
  if (!row) throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
  return {
    invoice: toInvoice(row),
    buyerSnapshot: parseJsonbColumn(row.buyer_snapshot),
    shipToSnapshot: parseJsonbColumn(row.ship_to_snapshot),
    issuedSnapshot: parseJsonbColumn(row.issued_snapshot),
    signedQr: row.signed_qr,
  };
}

/** Locks the invoice row for the rest of the transaction and returns it.
 * Every state transition starts here so concurrent requests serialise
 * (`of ti` — the joined MB row is read, never written here). */
async function lockInvoice(tx: TransactionSql, invoiceId: string): Promise<InvoiceRow> {
  const rows = (await tx.unsafe(
    `select ${TI_COLUMNS} ${TI_FROM} where ti.id = $1 for update of ti`,
    [invoiceId],
  )) as unknown as InvoiceRow[];
  const row = rows[0];
  if (!row) throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
  return row;
}

function requireStatus(row: InvoiceRow, status: TaxInvoiceStatus): void {
  if (row.status !== status) {
    throw httpError(
      409,
      'TAX_INVOICE_STATUS_CONFLICT',
      `This operation requires a ${status} tax invoice (current status: ${row.status}).`,
    );
  }
}

// --- Field guards -----------------------------------------------------------

/** The description column measures TRIMMED length 3..1000; the trimmed
 * text is also what gets stored, so the invoice says what the operator
 * meant. */
function trimmedDescription(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 1000) {
    throw httpError(
      400,
      'SERVICE_DESCRIPTION_INVALID',
      'The service description must be between 3 and 1000 characters that are not blank.',
    );
  }
  return trimmed;
}

/** April-to-March financial year label from a date-only string —
 * '2027-03-31' -> '2026-27', '2027-04-01' -> '2027-28'. String parts
 * only; a legal date never round-trips through a timezone (rule 6). */
export function financialYearLabel(invoiceDate: string): string {
  const year = Number(invoiceDate.slice(0, 4));
  const month = Number(invoiceDate.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

interface BuyerRow {
  id: string;
  designation: string;
  contact_person: string | null;
  address: string | null;
  gstin: string | null;
  pincode: string | null;
  state_code: string | null;
  locality: string | null;
  division_code: string | null;
  active: boolean;
}

/** The buyer is any ACTIVE contact — the railway consignee or a private
 * client; restricting to a role flag would add friction with no
 * correctness gain, since the snapshot below records exactly who was
 * billed. A contact of another tenant is invisible under RLS and answers
 * exactly like an unknown id. */
async function requireBuyer(tx: TransactionSql, contactId: string): Promise<BuyerRow> {
  const [row] = await tx<BuyerRow[]>`
    select id, designation, contact_person, address, gstin, pincode,
           state_code, locality, division_code, active
    from contacts where id = ${contactId}
  `;
  if (!row) throw httpError(404, 'CONTACT_NOT_FOUND', 'No such contact.');
  if (!row.active) {
    throw httpError(
      409,
      'CONTACT_RETIRED',
      'This buyer contact is retired — reactivate it or pick another.',
    );
  }
  return row;
}

/** The ship-to contact, resolved the same way and refused for the same
 * reasons — a retired consignee is as wrong to deliver to as it is to
 * bill. Named separately so its refusals say which of the two parties is
 * at fault. */
/** A direct invoice belongs to no Work, so there is no Work-scope check
 * to make — RLS and the organisation header already bound it. An
 * MB-backed one is checked exactly as before. */
async function assertInvoiceWorkAccess(
  tx: TransactionSql,
  userId: string,
  workId: string | null,
): Promise<void> {
  if (workId === null) return;
  await assertWorkAccess(tx, userId, workId);
}

async function requireShipTo(tx: TransactionSql, contactId: string): Promise<BuyerRow> {
  const [row] = await tx<BuyerRow[]>`
    select id, designation, contact_person, address, gstin, pincode,
           state_code, locality, division_code, active
    from contacts where id = ${contactId}
  `;
  if (!row) {
    throw httpError(404, 'SHIP_TO_NOT_FOUND', 'No such ship-to contact.');
  }
  if (!row.active) {
    throw httpError(
      409,
      'SHIP_TO_RETIRED',
      'This ship-to contact is retired — reactivate it or pick another.',
    );
  }
  return row;
}

interface InvoiceableBook {
  id: string;
  work_id: string;
  status: string;
  kind: string;
  mb_date: string;
  mb_number: string | null;
  total_amount: string | null;
}

/** Row-locks the Measurement Book (serialising against its cancel) and
 * holds it to the rule the 0035 insert trigger backstops: a finalized,
 * non-record MB of THIS Work. Another Work's or tenant's MB answers
 * exactly like an unknown id. */
async function lockInvoiceableBook(
  tx: TransactionSql,
  workId: string,
  measurementBookId: string,
): Promise<InvoiceableBook> {
  const [book] = await tx<InvoiceableBook[]>`
    select id, work_id, status, kind, mb_date::text as mb_date, mb_number,
           total_amount::text as total_amount
    from measurement_books
    where id = ${measurementBookId}
    for update
  `;
  if (!book || book.work_id !== workId) {
    throw httpError(
      404,
      'MEASUREMENT_BOOK_NOT_FOUND',
      'No such Measurement Book in this Work.',
    );
  }
  if (book.kind === 'record') {
    throw httpError(
      409,
      'MB_RECORD_NOT_BILLABLE',
      'Record Measurement Books are never invoiced — merge them into an on-account Measurement Book, finalize it, and invoice that.',
    );
  }
  if (book.status !== 'finalized') {
    throw httpError(
      409,
      'MB_NOT_FINALIZED',
      `Only a finalized Measurement Book can be invoiced (current status: ${book.status}).`,
    );
  }
  return book;
}

/** The template this route freezes into issued_snapshot. Bumping it is
 * how a document change becomes visible: an invoice re-renders from the
 * snapshot it was issued under, never from today's template. */
export const TAX_INVOICE_TEMPLATE_VERSION = 'ti-v1';

/** The unit word when the invoice does not name one. A works-contract
 * invoice bills one whole thing, and 'set' is what the trade writes. */
const DEFAULT_UNIT_LABEL = 'set';

/** The optional document fields a draft may carry, trimmed to what the
 * columns hold. An omitted field stores NULL — these are the invoice's
 * own text, not a PATCH surface, because create and update share one
 * whole-object shape. */
function documentFields(body: CreateTaxInvoiceRequest | UpdateTaxInvoiceRequest): {
  customerPoReference: string | null;
  unitLabel: string | null;
  notes: string | null;
  shipToContactId: string | null;
  numberPrefix: string | null;
} {
  return {
    customerPoReference: body.customerPoReference?.trim() ?? null,
    unitLabel: body.unitLabel?.trim() ?? null,
    notes: body.notes?.trim() ?? null,
    shipToContactId: body.shipToContactId ?? null,
    numberPrefix: body.numberPrefix ?? null,
  };
}

/** Billing cannot precede measurement: the invoice date floors at the
 * billed MB's date. The upper bound is enforced separately by
 * `assertInvoiceDateNotFuture` below, against today in the
 * organisation's own timezone. */
function assertInvoiceDate(invoiceDate: string, book: InvoiceableBook): void {
  // ISO dates compare correctly as strings.
  if (invoiceDate < book.mb_date) {
    throw httpError(
      400,
      'TAX_INVOICE_DATE_BEFORE_MB',
      `The invoice date cannot precede Measurement Book ${book.mb_number ?? book.id}, dated ${book.mb_date}.`,
    );
  }
}

async function assertInvoiceDateNotFuture(
  tx: TransactionSql,
  invoiceDate: string,
): Promise<void> {
  const [row] = await tx<{ today: string }[]>`
    select (now() at time zone timezone)::date::text as today
    from organisations
  `;
  if (!row) throw new Error('bound organisation disappeared');
  if (invoiceDate > row.today) {
    throw httpError(
      400,
      'TAX_INVOICE_DATE_IN_FUTURE',
      `The invoice date cannot be after today (${row.today}) in the organisation timezone.`,
    );
  }
}

/** The friendly half of the 0035 one-live-invoice-per-MB rule: names the
 * live invoice so the client can open it (the partial unique index
 * decides races). */
async function assertBookUninvoiced(
  tx: TransactionSql,
  measurementBookId: string,
): Promise<void> {
  const [live] = await tx<{ id: string; invoice_number: string | null }[]>`
    select id, invoice_number from tax_invoices
    where measurement_book_id = ${measurementBookId} and status <> 'cancelled'
  `;
  if (live) {
    throw draftConflictError(
      'TAX_INVOICE_EXISTS',
      `This Measurement Book already has a live tax invoice${live.invoice_number === null ? '' : ` (${live.invoice_number})`}; cancel or delete it before raising another.`,
      live.id,
    );
  }
}

async function auditInvoice(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  invoiceId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, 'tax_invoices', ${invoiceId},
      ${jsonb(tx, details)}
    )
  `;
}

function invoiceRenderSourceHash(
  snapshot: ReturnType<typeof parseTaxInvoiceIssuedSnapshot>,
  evidence: TaxInvoiceIrpRenderEvidence,
  branding: {
    readonly logoSha256: string | null;
    readonly logoMediaType: string | null;
  },
): string {
  return sha256Hex(stringifyStatutoryJson({ snapshot, evidence, branding }));
}

// --- Routes -----------------------------------------------------------------

export function registerTaxInvoiceRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
  provider?: StatutoryProvider,
): void {
  app.get(
    '/api/works/:id/tax-invoices',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: TaxInvoiceListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await assertWorkAccess(tx, user.id, workId);
          const [work] = await tx<{ id: string }[]>`
            select id from works where id = ${workId} and deleted_at is null
          `;
          if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
          return (await tx.unsafe(
            `select ${TI_COLUMNS} ${TI_FROM}
             where ti.work_id = $1
             order by ti.created_at desc, ti.id`,
            [workId],
          )) as unknown as InvoiceRow[];
        },
      );
      return { invoices: rows.map(toInvoice) };
    },
  );

  app.post(
    '/api/works/:id/tax-invoices',
    {
      schema: {
        params: IdParamsSchema,
        body: CreateTaxInvoiceRequestSchema,
        response: { 201: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const body = request.body as CreateTaxInvoiceRequest;
      const serviceDescription = trimmedDescription(body.serviceDescription);
      const document = documentFields(body);

      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          await assertInvoiceDateNotFuture(tx, body.invoiceDate);
          // The rate must be one the Government had notified on the
          // invoice date (gst_rates master, finding 19) — checked here so
          // a 1.8-instead-of-18 typo is a named 400, and re-checked at
          // submit because the date can change until then.
          await assertGstRateNotified(tx, body.gstRate, body.invoiceDate);
          await assertWorkAccess(tx, user.id, workId);
          const book = await lockInvoiceableBook(tx, workId, body.measurementBookId);
          assertInvoiceDate(body.invoiceDate, book);
          await requireBuyer(tx, body.buyerContactId);
          await assertBookUninvoiced(tx, book.id);

          const [created] = await tx<{ id: string }[]>`
            insert into tax_invoices (
              organisation_id, work_id, measurement_book_id, invoice_date,
              sac_code, service_description, gst_rate, place_of_supply,
              reverse_charge_applicable, buyer_contact_id,
              customer_po_reference, unit_label, notes, ship_to_contact_id,
              number_prefix, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.measurementBookId},
              ${body.invoiceDate}, ${body.sacCode}, ${serviceDescription},
              ${body.gstRate}, ${body.placeOfSupply},
              ${body.reverseChargeApplicable ?? null}, ${body.buyerContactId},
              ${document.customerPoReference}, ${document.unitLabel},
              ${document.notes}, ${document.shipToContactId},
              ${document.numberPrefix}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              // A concurrent create won the one-live-per-MB index race;
              // the transaction is aborted, so the route-level catch
              // names the winner from a fresh read.
              throw httpError(
                409,
                'TAX_INVOICE_EXISTS',
                'This Measurement Book already has a live tax invoice; cancel or delete it before raising another.',
              );
            }
            throw error;
          });
          if (!created) throw new Error('tax invoice insert returned no row');

          // `buyerContactId` in the details is the draft's buyer store —
          // see the module note. Always written, never diffed away.
          await auditInvoice(
            tx,
            organisationId,
            user.id,
            'tax_invoice.created',
            created.id,
            {
              workId,
              measurementBookId: body.measurementBookId,
              mbNumber: book?.mb_number ?? null,
              buyerContactId: body.buyerContactId,
              invoiceDate: body.invoiceDate,
              sacCode: body.sacCode,
              gstRate: body.gstRate,
              placeOfSupply: body.placeOfSupply,
              reverseChargeApplicable: body.reverseChargeApplicable ?? null,
            },
          );
          return readDetail(tx, created.id);
        },
      ).catch(async (error: unknown) => {
        throw await nameDraftConflict(error, 'TAX_INVOICE_EXISTS', () =>
          withBoundTenant(database, organisationId, user.id, async (tx) => {
            const [row] = await tx<{ id: string }[]>`
              select id from tax_invoices
              where measurement_book_id = ${body.measurementBookId}
                and status <> 'cancelled'
            `;
            return row?.id ?? null;
          }),
        );
      });
      return reply.status(201).send(detail);
    },
  );

  // A DIRECT invoice: no Work, no Measurement Book, a stated taxable
  // value. Everything downstream — submit, the number, the GST split,
  // the IRP payload, the e-way bill — is the same code path, because the
  // only thing that differs is where the taxable value came from.
  app.post(
    '/api/tax-invoices',
    {
      schema: {
        body: CreateDirectTaxInvoiceRequestSchema,
        response: { 201: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const body = request.body as CreateDirectTaxInvoiceRequest;
      const serviceDescription = trimmedDescription(body.serviceDescription);
      const document = documentFields(body);

      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          await assertInvoiceDateNotFuture(tx, body.invoiceDate);
          await assertGstRateNotified(tx, body.gstRate, body.invoiceDate);
          await requireBuyer(tx, body.buyerContactId);
          const [created] = await tx<{ id: string }[]>`
            insert into tax_invoices (
              organisation_id, invoice_date, sac_code, service_description,
              gst_rate, place_of_supply, stated_taxable_value,
              reverse_charge_applicable, buyer_contact_id,
              customer_po_reference, unit_label, notes, ship_to_contact_id,
              number_prefix, created_by_user_id
            )
            values (
              ${organisationId}, ${body.invoiceDate}, ${body.sacCode},
              ${serviceDescription}, ${body.gstRate}, ${body.placeOfSupply},
              ${body.taxableValue}, ${body.reverseChargeApplicable ?? null},
              ${body.buyerContactId},
              ${document.customerPoReference}, ${document.unitLabel},
              ${document.notes}, ${document.shipToContactId},
              ${document.numberPrefix}, ${user.id}
            )
            returning id
          `;
          if (!created) throw new Error('direct tax invoice insert returned no row');
          await auditInvoice(
            tx,
            organisationId,
            user.id,
            'tax_invoice.created',
            created.id,
            {
              direct: true,
              taxableValue: body.taxableValue,
              reverseChargeApplicable: body.reverseChargeApplicable ?? null,
              buyerContactId: body.buyerContactId,
            },
          );
          return readDetail(tx, created.id);
        },
      );
      return reply.code(201).send(detail);
    },
  );

  app.get(
    '/api/tax-invoices/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const [ref] = await tx<{ work_id: string | null }[]>`
          select work_id from tax_invoices where id = ${id}
        `;
        if (!ref) throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
        await assertInvoiceWorkAccess(tx, user.id, ref.work_id);
        return readDetail(tx, id);
      });
    },
  );

  app.post(
    '/api/tax-invoices/:id/render',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };

      // Read immutable render inputs in one short transaction. Gotenberg and
      // object storage run without a database lock; a second transaction
      // verifies that the append-only IRP evidence did not change meanwhile.
      const prepared = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          const invoice = await lockInvoice(tx, id);
          await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
          requireStatus(invoice, 'submitted');
          const [source] = await tx<
            {
              issued_snapshot: unknown;
              signed_qr: string | null;
            }[]
          >`
            select issued_snapshot, signed_qr
            from tax_invoices where id = ${id}
          `;
          const [organisation] = await tx<
            { logo_object_key: string | null; logo_media_type: string | null }[]
          >`
            select logo_object_key, logo_media_type from organisations
          `;
          if (!source) throw new Error('tax invoice render source disappeared');
          const snapshot = parseTaxInvoiceIssuedSnapshot(
            parseJsonbColumn(source.issued_snapshot),
          );
          const evidence: TaxInvoiceIrpRenderEvidence = {
            provider: invoice.irp_provider,
            irn: invoice.irn,
            ackNumber: invoice.ack_number,
            ackDateText: invoice.ack_date_text,
            signedQr: source.signed_qr,
            legacyEvidenceMissing: invoice.irp_legacy_evidence_missing,
          };
          return {
            snapshot,
            evidence,
            logoObjectKey: organisation?.logo_object_key ?? null,
            logoMediaType: organisation?.logo_media_type ?? null,
          };
        },
      );

      let logoDataUri: string | undefined;
      let logoBytes: Buffer | null = null;
      let logoSha256: string | null = null;
      let frozenLogoObjectKey: string | null = null;
      if (prepared.logoObjectKey !== null && prepared.logoMediaType !== null) {
        try {
          logoBytes = await storage.get(prepared.logoObjectKey);
          logoSha256 = createHash('sha256').update(logoBytes).digest('hex');
          const extension = prepared.logoMediaType === 'image/png' ? 'png' : 'jpg';
          frozenLogoObjectKey = `${organisationId}/ti/${id}-logo-${logoSha256.slice(0, 16)}.${extension}`;
          logoDataUri = `data:${prepared.logoMediaType};base64,${logoBytes.toString('base64')}`;
        } catch (error) {
          request.log.error({ err: error }, 'tax invoice render: logo unavailable');
          throw httpError(
            502,
            'RENDER_BRANDING_UNAVAILABLE',
            'The configured logo could not be frozen for this invoice render. The submitted invoice is unaffected.',
          );
        }
      }
      const renderSourceHash = invoiceRenderSourceHash(
        prepared.snapshot,
        prepared.evidence,
        {
          logoSha256,
          logoMediaType: logoSha256 === null ? null : prepared.logoMediaType,
        },
      );

      let html: string;
      try {
        html = await renderTaxInvoiceHtml(
          prepared.snapshot,
          prepared.evidence,
          logoDataUri === undefined ? {} : { logoDataUri },
        );
      } catch (error) {
        request.log.error({ err: error }, 'tax invoice render input failed');
        throw httpError(
          409,
          'TAX_INVOICE_RENDER_INPUT_INVALID',
          'The frozen invoice or signed QR evidence cannot be rendered safely.',
        );
      }

      const form = new FormData();
      form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
      let pdf: Buffer;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), TAX_INVOICE_RENDER_TIMEOUT_MS);
      try {
        const response = await fetch(`${gotenbergUrl}/forms/chromium/convert/html`, {
          method: 'POST',
          body: form,
          signal: abort.signal,
        });
        if (!response.ok) {
          throw new Error(`Gotenberg answered ${String(response.status)}`);
        }
        pdf = await readBoundedPdfResponse(response);
      } catch (error) {
        request.log.error({ err: error }, 'tax invoice render failed');
        throw httpError(
          502,
          'RENDER_FAILED',
          'The PDF service is unavailable; the submitted invoice is unaffected — retry later.',
        );
      } finally {
        clearTimeout(timeout);
      }

      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/ti/${id}-${sha256.slice(0, 16)}.pdf`;
      try {
        if (frozenLogoObjectKey !== null && logoBytes !== null) {
          await storage.put(frozenLogoObjectKey, logoBytes);
        }
        await storage.put(objectKey, pdf);
      } catch (error) {
        request.log.error({ err: error }, 'tax invoice render storage failed');
        throw httpError(
          502,
          'RENDER_STORAGE_FAILED',
          'The rendered PDF could not be stored. The submitted invoice and previous PDF remain unaffected.',
        );
      }

      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        requireStatus(invoice, 'submitted');
        const [source] = await tx<
          { issued_snapshot: unknown; signed_qr: string | null }[]
        >`
          select issued_snapshot, signed_qr from tax_invoices where id = ${id}
        `;
        if (!source) throw new Error('tax invoice render source disappeared');
        const currentSnapshot = parseTaxInvoiceIssuedSnapshot(
          parseJsonbColumn(source.issued_snapshot),
        );
        const currentEvidence: TaxInvoiceIrpRenderEvidence = {
          provider: invoice.irp_provider,
          irn: invoice.irn,
          ackNumber: invoice.ack_number,
          ackDateText: invoice.ack_date_text,
          signedQr: source.signed_qr,
          legacyEvidenceMissing: invoice.irp_legacy_evidence_missing,
        };
        if (
          invoiceRenderSourceHash(currentSnapshot, currentEvidence, {
            logoSha256,
            logoMediaType: logoSha256 === null ? null : prepared.logoMediaType,
          }) !== renderSourceHash
        ) {
          throw httpError(
            409,
            'TAX_INVOICE_RENDER_SOURCE_CHANGED',
            'IRP evidence changed while the invoice was rendering; the previous PDF remains current — render again.',
          );
        }
        const [nextRender] = await tx<{ version: number }[]>`
          select coalesce(max(version), 0)::int + 1 as version
          from tax_invoice_renders where tax_invoice_id = ${id}
        `;
        if (!nextRender) throw new Error('tax invoice render version query failed');
        await tx`
          insert into tax_invoice_renders (
            organisation_id, tax_invoice_id, version, template_version,
            template_contract_legacy, source_sha256,
            object_key_scope_missing, logo_evidence_missing,
            logo_object_key, logo_sha256, logo_media_type,
            object_key, pdf_sha256, created_by_user_id
          )
          values (
            ${organisationId}, ${id}, ${nextRender.version},
            ${TAX_INVOICE_PDF_TEMPLATE_VERSION}, false, ${renderSourceHash},
            false, false,
            ${frozenLogoObjectKey}, ${logoSha256},
            ${logoSha256 === null ? null : prepared.logoMediaType},
            ${objectKey}, ${sha256}, ${user.id}
          )
        `;
        await tx`
          update tax_invoices
          set template_version = ${TAX_INVOICE_PDF_TEMPLATE_VERSION},
              rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256}
          where id = ${id}
        `;
        await auditInvoice(tx, organisationId, user.id, 'tax_invoice.rendered', id, {
          sha256,
          renderVersion: nextRender.version,
          sourceSha256: renderSourceHash,
          logoSha256,
          templateVersion: TAX_INVOICE_PDF_TEMPLATE_VERSION,
          irpEvidenceIncluded: currentEvidence.irn !== null,
        });
        return readDetail(tx, id);
      });
    },
  );

  app.get(
    '/api/tax-invoices/:id/pdf',
    { schema: { params: IdParamsSchema } },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const rendered = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [invoice] = await tx<
            {
              work_id: string | null;
              rendered_object_key: string | null;
              rendered_sha256: string | null;
              object_key_scope_missing: boolean | null;
            }[]
          >`
          select invoice.work_id, invoice.rendered_object_key,
                 invoice.rendered_sha256, latest.object_key_scope_missing
          from tax_invoices invoice
          left join lateral (
            select render.object_key_scope_missing
            from tax_invoice_renders render
            where render.tax_invoice_id = invoice.id
            order by render.version desc
            limit 1
          ) latest on true
          where invoice.id = ${id}
      `;
          if (!invoice) {
            throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
          }
          await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
          if (
            invoice.rendered_object_key === null ||
            invoice.rendered_sha256 === null
          ) {
            throw httpError(
              404,
              'PDF_NOT_AVAILABLE',
              'This tax invoice has not been rendered yet.',
            );
          }
          if (invoice.object_key_scope_missing !== false) {
            throw httpError(
              409,
              'RENDERED_PDF_SCOPE_UNVERIFIED',
              'This compatibility render has no verified tenant-scoped object key.',
            );
          }
          return { key: invoice.rendered_object_key, sha256: invoice.rendered_sha256 };
        },
      );
      const bytes = await storage.get(rendered.key);
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      if (actualSha256 !== rendered.sha256) {
        throw httpError(
          409,
          'RENDERED_PDF_INTEGRITY_FAILED',
          'The retained tax-invoice PDF no longer matches its recorded digest.',
        );
      }
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="tax-invoice-${id}.pdf"`,
      );
      return reply.send(bytes);
    },
  );

  app.put(
    '/api/tax-invoices/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: UpdateTaxInvoiceRequestSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as UpdateTaxInvoiceRequest;
      const serviceDescription = trimmedDescription(body.serviceDescription);
      const document = documentFields(body);
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertInvoiceDateNotFuture(tx, body.invoiceDate);
        await assertGstRateNotified(tx, body.gstRate, body.invoiceDate);
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        requireStatus(invoice, 'draft');
        // Billing cannot precede measurement — but only where there IS
        // measurement. A direct invoice has no Measurement Book to floor
        // its date against.
        if (invoice.work_id !== null && invoice.measurement_book_id !== null) {
          const book = await lockInvoiceableBook(
            tx,
            invoice.work_id,
            invoice.measurement_book_id,
          );
          assertInvoiceDate(body.invoiceDate, book);
        }
        await requireBuyer(tx, body.buyerContactId);
        await tx`
          update tax_invoices
          set invoice_date = ${body.invoiceDate}, sac_code = ${body.sacCode},
              service_description = ${serviceDescription},
              gst_rate = ${body.gstRate}, place_of_supply = ${body.placeOfSupply},
              reverse_charge_applicable = ${body.reverseChargeApplicable ?? null},
              buyer_contact_id = ${body.buyerContactId},
              customer_po_reference = ${document.customerPoReference},
              unit_label = ${document.unitLabel}, notes = ${document.notes},
              ship_to_contact_id = ${document.shipToContactId},
              number_prefix = ${document.numberPrefix}
          where id = ${id}
        `;
        // The after-side re-reads the stored row so numbers compare in
        // their normalised numeric text ('18' arrives, '18.00' is what
        // the row — and therefore the trail — says).
        const [stored] = await tx<
          {
            invoice_date: string;
            sac_code: string;
            service_description: string;
            gst_rate: string;
            place_of_supply: string;
          }[]
        >`
          select invoice_date::text as invoice_date, sac_code,
                 service_description, gst_rate::text as gst_rate,
                 place_of_supply
          from tax_invoices where id = ${id}
        `;
        if (!stored) throw new Error('tax invoice vanished mid-update');
        const changes = auditDiff(
          {
            invoiceDate: invoice.invoice_date,
            sacCode: invoice.sac_code,
            serviceDescription: invoice.service_description,
            gstRate: invoice.gst_rate,
            placeOfSupply: invoice.place_of_supply,
            buyerContactId: invoice.buyer_contact_id,
          },
          {
            invoiceDate: stored.invoice_date,
            sacCode: stored.sac_code,
            serviceDescription: stored.service_description,
            gstRate: stored.gst_rate,
            placeOfSupply: stored.place_of_supply,
            buyerContactId: body.buyerContactId,
          },
        );
        // buyerContactId rides top-level on EVERY update event — it is
        // the draft's buyer store, not a diff (see the module note).
        await auditInvoice(tx, organisationId, user.id, 'tax_invoice.updated', id, {
          before: changes.before,
          after: changes.after,
          buyerContactId: body.buyerContactId,
        });
        return readDetail(tx, id);
      });
    },
  );

  app.delete(
    '/api/tax-invoices/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      await withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        // Rule 8: a draft is not yet a document, so it deletes — which
        // also releases the MB it would have billed (the one-live index
        // and the 0035 MB-cancel guard both stop seeing it).
        requireStatus(invoice, 'draft');
        await tx`delete from tax_invoices where id = ${id}`;
        await auditInvoice(tx, organisationId, user.id, 'tax_invoice.deleted', id, {
          workId: invoice.work_id,
          measurementBookId: invoice.measurement_book_id,
        });
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/tax-invoices/:id/submit',
    {
      schema: {
        params: IdParamsSchema,
        response: { 201: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          // Submitting assigns a legal number and freezes money: issue
          // authority, like challan issue and MB finalize.
          await requireAuthority(tx, user.id, 'issue');
          const invoice = await lockInvoice(tx, id);
          await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
          requireStatus(invoice, 'draft');
          await assertInvoiceDateNotFuture(tx, invoice.invoice_date);
          // Re-checked at the money moment: the rate and the date were
          // both checked when the draft was written, but either may have
          // been edited since, and the rate master itself may have been
          // end-dated between drafting and submit. Nothing is computed
          // from a rate the Government had not notified on this date.
          await assertGstRateNotified(tx, invoice.gst_rate, invoice.invoice_date);

          if (invoice.reverse_charge_applicable === null) {
            throw httpError(
              400,
              'REVERSE_CHARGE_CONFIRMATION_REQUIRED',
              'Confirm whether tax is payable under reverse charge before submitting this invoice.',
            );
          }
          if (invoice.reverse_charge_applicable) {
            throw httpError(
              409,
              'REVERSE_CHARGE_UNSUPPORTED',
              'Reverse-charge tax invoices are not implemented. Keep this invoice as a draft and issue it outside Auto-MB.',
            );
          }

          // The split is decided by the organisation's state against the
          // place of supply; without a state it is undecidable, and the
          // IRP payload cannot name a seller without a GSTIN. Refused
          // here, not at draft time — the profile may well be completed
          // between drafting and the money moment.
          const [organisation] = await tx<
            {
              name: string;
              state_code: string | null;
              gstin: string | null;
              address: string | null;
              pincode: string | null;
              locality: string | null;
              trade_name: string | null;
              msme_number: string | null;
              contact_phone: string | null;
              invoice_number_prefix: string | null;
              invoice_notes: string | null;
            }[]
          >`
            select name, state_code, gstin, address, pincode, locality, trade_name,
                   msme_number, contact_phone, invoice_number_prefix,
                   invoice_notes
            from organisations
          `;
          if (!organisation?.state_code) {
            throw httpError(
              400,
              'ORG_STATE_REQUIRED',
              'The organisation profile has no GST state code, so the CGST+SGST/IGST split is undecidable — set it and retry.',
            );
          }
          if (!organisation.gstin) {
            throw httpError(
              400,
              'ORG_GSTIN_REQUIRED',
              'The organisation profile has no GSTIN — the e-invoice names the seller by it. Set it and retry.',
            );
          }

          if (!organisation.address) {
            throw httpError(
              400,
              'ORG_ADDRESS_REQUIRED',
              'The organisation profile has no address; the immutable invoice and IRP payload need it. Set it and retry.',
            );
          }
          if (!organisation.pincode) {
            throw httpError(
              400,
              'ORG_PINCODE_REQUIRED',
              'The organisation profile has no PIN code; the immutable invoice and IRP payload need it. Set it and retry.',
            );
          }
          if (!organisation.locality) {
            throw httpError(
              400,
              'ORG_LOCALITY_REQUIRED',
              'The organisation profile has no explicit locality for the NIC seller block. Set it before issuing this IRP-ready invoice.',
            );
          }

          // The draft's buyer is ordinary relational state since 0041;
          // the audit trail is evidence, never the operational store.
          const buyer = await requireBuyer(tx, invoice.buyer_contact_id);
          const missing = [
            ...(buyer.address === null ? ['address'] : []),
            ...(buyer.state_code === null ? ['stateCode'] : []),
            ...(buyer.pincode === null ? ['pincode'] : []),
            ...(buyer.gstin !== null && buyer.locality === null ? ['locality'] : []),
          ];
          if (missing.length > 0) {
            throw httpError(
              400,
              'BUYER_PROFILE_INCOMPLETE',
              `The buyer contact is missing ${missing.join(', ')} — the invoice snapshot and the e-invoice payload need them. Complete the contact and retry.`,
            );
          }

          // A DIRECT invoice — one raised against a private customer —
          // names no Measurement Book, so there is nothing to lock and
          // the taxable value is the one stated on the draft. An
          // MB-backed invoice locks its book (serialising against a
          // cancel the trigger would refuse anyway) and takes the MB
          // total VERBATIM. The 0039 CHECK guarantees exactly one of the
          // two is present, so this is a real either/or, not a fallback.
          const book =
            invoice.measurement_book_id === null || invoice.work_id === null
              ? null
              : await lockInvoiceableBook(
                  tx,
                  invoice.work_id,
                  invoice.measurement_book_id,
                );
          if (book !== null && book.total_amount === null) {
            throw new Error(`finalized Measurement Book ${book.id} has no total`);
          }
          const taxableValue = book?.total_amount ?? invoice.stated_taxable_value;
          if (taxableValue === null) {
            throw new Error(
              `tax invoice ${id} has neither an MB total nor a stated value`,
            );
          }

          // Gapless per (organisation, financial year) under the counter
          // row lock: concurrent submits serialise here, and a rolled-
          // back transaction rolls the number back with it.
          const fyLabel = financialYearLabel(invoice.invoice_date);
          // The number is COMPOSED, not templated: the owner's series is
          // a prefix, the financial year's opening year, and one gapless
          // serial per year SHARED across every prefix — P10 26 044 and
          // P14 26 048 are the 44th and 48th invoices of 2026-27 under
          // two prefixes. The invoice's own prefix wins over the house
          // default; neither present is a refusal rather than a guess,
          // because inventing a series would put a number on a legal
          // document that the owner's books do not recognise.
          const prefix = invoice.number_prefix ?? organisation.invoice_number_prefix;
          const template = await loadNumberTemplate(tx, 'tax_invoice');
          const [counter] = await tx<{ next_value: number }[]>`
            insert into tax_invoice_counters (organisation_id, fy_label)
            values (${organisationId}, ${fyLabel})
            on conflict (organisation_id, fy_label)
            do update set next_value = tax_invoice_counters.next_value + 1
            returning next_value
          `;
          if (!counter) throw new Error('tax invoice counter upsert returned no row');
          const sequence = counter.next_value;
          // The organisation's own format. The default is TI/<FY>/NNN;
          // an organisation whose series names a division ({DIV}) draws
          // it from the BUYER, which is why a buyer with no division
          // code is a named refusal rather than a number with a hole.
          let invoiceNumber: string;
          try {
            invoiceNumber = renderNumberTemplate(template, {
              prefix,
              divisionCode: buyer.division_code,
              financialYear: fyLabel,
              documentDate: invoice.invoice_date,
              sequence,
            });
          } catch (cause) {
            if (cause instanceof NumberTemplateError) {
              throw httpError(400, 'INVOICE_NUMBER_UNFILLABLE', cause.message);
            }
            throw cause;
          }

          // THE MONEY, entirely in SQL numeric arithmetic: taxable is the
          // MB total verbatim; intra-state (organisation state = place of
          // supply) splits into equal CGST and SGST halves of
          // round(taxable*rate/200, 2); inter-state carries
          // round(taxable*rate/100, 2) as IGST. The total re-adds the
          // rounded parts, so what is charged is exactly what the parts
          // say.
          const intraState = organisation.state_code === invoice.place_of_supply;
          const [money] = await tx<
            {
              taxable: string;
              cgst: string;
              sgst: string;
              igst: string;
              total: string;
              round_off: string;
              line_value: string;
            }[]
          >`
            with base as (
              select ${taxableValue}::numeric(18,2) as taxable,
                     case when ${intraState}
                       then round(${taxableValue}::numeric(18,2)
                              * ${invoice.gst_rate}::numeric / 200, 2)
                       else 0 end::numeric(18,2) as half,
                     case when ${intraState}
                       then 0
                       else round(${taxableValue}::numeric(18,2)
                              * ${invoice.gst_rate}::numeric / 100, 2)
                       end::numeric(18,2) as igst
            )
            select taxable::text as taxable, half::text as cgst, half::text as sgst,
                   igst::text as igst,
                   -- The invoice is payable in whole rupees, so the total
                   -- is rounded and the delta is kept and printed. Both
                   -- in SQL numeric: 4226994.01 + 380429.46 + 380429.46 =
                   -- 4987852.93 becomes 4987853 with a round_off of 0.07,
                   -- which is exactly what the customer's own invoice
                   -- says.
                   round(taxable + half + half + igst, 0)::numeric(18,2)::text
                     as total,
                   (round(taxable + half + half + igst, 0)
                     - (taxable + half + half + igst))::numeric(18,2)::text
                     as round_off,
                   (taxable + half + half + igst)::numeric(18,2)::text
                     as line_value
            from base
          `;
          if (!money) throw new Error('tax computation returned no row');

          // The buyer exactly as invoiced, frozen so master edits never
          // rewrite the document (rule 7). contactId makes the read
          // model's provenance resolution total.
          const buyerSnapshot = {
            contactId: buyer.id,
            designation: buyer.designation,
            contactPerson: buyer.contact_person,
            gstin: buyer.gstin,
            address: buyer.address,
            stateCode: buyer.state_code,
            pincode: buyer.pincode,
            locality: buyer.locality,
          };

          // The ship-to, when one was named. Same freeze as the buyer,
          // and deliberately NOT a copy of it. NIC requires the frozen
          // ship-to GSTIN and explicit locality when this block is present.
          const shipTo =
            invoice.ship_to_contact_id === null
              ? null
              : await requireShipTo(tx, invoice.ship_to_contact_id);
          if (shipTo !== null) {
            const missingShipTo = [
              ...(shipTo.address === null ? ['address'] : []),
              ...(shipTo.state_code === null ? ['stateCode'] : []),
              ...(shipTo.pincode === null ? ['pincode'] : []),
              ...(shipTo.gstin === null ? ['gstin'] : []),
              ...(shipTo.locality === null ? ['locality'] : []),
            ];
            if (missingShipTo.length > 0) {
              throw httpError(
                400,
                'SHIP_TO_PROFILE_INCOMPLETE',
                `The ship-to contact is missing ${missingShipTo.join(', ')} — complete it before the invoice is frozen.`,
              );
            }
          }
          const shipToSnapshot =
            shipTo === null
              ? null
              : {
                  contactId: shipTo.id,
                  designation: shipTo.designation,
                  contactPerson: shipTo.contact_person,
                  gstin: shipTo.gstin,
                  address: shipTo.address,
                  stateCode: shipTo.state_code,
                  pincode: shipTo.pincode,
                  locality: shipTo.locality,
                };

          // THE DOCUMENT, frozen. Everything the printed invoice says
          // about parties and money, captured at the one moment it
          // becomes legal — so correcting the company address in
          // Settings tomorrow cannot rewrite the masthead of an invoice
          // the Government has already registered. A re-render
          // REPRODUCES this; it never recomputes from live tables.
          const issuedSnapshot = {
            templateVersion: TAX_INVOICE_TEMPLATE_VERSION,
            invoiceNumber,
            invoiceDate: invoice.invoice_date,
            fyLabel,
            supplier: {
              name: organisation.name,
              tradeName: organisation.trade_name,
              address: organisation.address,
              pincode: organisation.pincode,
              locality: organisation.locality,
              stateCode: organisation.state_code,
              gstin: organisation.gstin,
              phone: organisation.contact_phone,
              msmeNumber: organisation.msme_number,
            },
            buyer: buyerSnapshot,
            shipTo: shipToSnapshot,
            placeOfSupply: invoice.place_of_supply,
            reverseChargeApplicable: invoice.reverse_charge_applicable,
            customerPoReference: invoice.customer_po_reference,
            line: {
              sacCode: invoice.sac_code,
              description: invoice.service_description,
              quantity: '1.00',
              unitLabel: invoice.unit_label ?? DEFAULT_UNIT_LABEL,
              rate: money.taxable,
              gstRate: invoice.gst_rate,
              amount: money.taxable,
              lineValue: money.line_value,
            },
            totals: {
              taxableValue: money.taxable,
              cgstAmount: money.cgst,
              sgstAmount: money.sgst,
              igstAmount: money.igst,
              roundOff: money.round_off,
              totalAmount: money.total,
            },
            // The organisation's standing line unless this invoice set
            // its own; one sample carries it and the other does not.
            notes: invoice.notes ?? organisation.invoice_notes,
            amountInWords: amountInWords(money.total),
          };

          await tx`
            update tax_invoices
            set status = 'submitted', invoice_number = ${invoiceNumber},
                number_prefix = ${prefix},
                sequence_number = ${sequence}, fy_label = ${fyLabel},
                buyer_snapshot = ${jsonb(tx, buyerSnapshot)},
                ship_to_snapshot = ${shipToSnapshot === null ? null : jsonb(tx, shipToSnapshot)},
                issued_snapshot = ${jsonb(tx, issuedSnapshot)},
                taxable_value = ${money.taxable}, cgst_amount = ${money.cgst},
                sgst_amount = ${money.sgst}, igst_amount = ${money.igst},
                round_off = ${money.round_off}, total_amount = ${money.total},
                submitted_by_user_id = ${user.id}, submitted_at = now()
            where id = ${id}
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'TAX_INVOICE_NUMBER_CONFLICT',
                `Tax invoice number ${invoiceNumber} already exists in this organisation.`,
              );
            }
            throw error;
          });

          await auditInvoice(tx, organisationId, user.id, 'tax_invoice.submitted', id, {
            invoiceNumber,
            fyLabel,
            sequence,
            measurementBookId: invoice.measurement_book_id,
            mbNumber: book?.mb_number ?? null,
            buyerContactId: buyer.id,
            taxableValue: money.taxable,
            cgstAmount: money.cgst,
            sgstAmount: money.sgst,
            igstAmount: money.igst,
            totalAmount: money.total,
            placeOfSupply: invoice.place_of_supply,
            reverseChargeApplicable: invoice.reverse_charge_applicable,
            intraState,
          });
          return readDetail(tx, id);
        },
      );
      return reply.status(201).send(detail);
    },
  );

  app.post(
    '/api/tax-invoices/:id/cancel',
    {
      schema: {
        params: IdParamsSchema,
        body: CancelTaxInvoiceRequestSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as CancelTaxInvoiceRequest;
      const note = cancellationNote(body.note);
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireAuthority(tx, user.id, 'cancel');
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (invoice.status === 'draft') {
          throw httpError(
            409,
            'TAX_INVOICE_STATUS_CONFLICT',
            'Draft tax invoices are deleted, not cancelled.',
          );
        }
        requireStatus(invoice, 'submitted');
        if (
          invoice.irp_provider_state !== 'not_requested' &&
          invoice.irp_provider_state !== 'cancelled'
        ) {
          throw httpError(
            409,
            'IRP_CANCELLATION_REQUIRED',
            'Resolve any pending/unknown registration and cancel confirmed IRP evidence before cancelling the local invoice.',
          );
        }
        // An e-way bill moves THIS invoice; cancelling the invoice under
        // a live movement document would leave the e-way bill moving a
        // cancelled supply. The e-way bill goes first.
        const [liveEwb] = await tx<{ id: string; ewb_number: string | null }[]>`
          select id, ewb_number from eway_bills
          where tax_invoice_id = ${id} and status <> 'cancelled'
        `;
        if (liveEwb) {
          throw httpError(
            409,
            'EWAY_BILL_LIVE',
            `E-way bill ${liveEwb.ewb_number ?? liveEwb.id} still moves this invoice; cancel it first.`,
          );
        }
        await tx`
          update tax_invoices
          set status = 'cancelled', cancelled_by_user_id = ${user.id},
              cancelled_at = now(), cancellation_note = ${note}
          where id = ${id}
        `;
        // Cancelling releases the MB: the one-live index and the 0035
        // MB-cancel guard both ignore cancelled invoices, so a corrected
        // invoice can be raised and the MB can again be cancelled.
        await auditInvoice(tx, organisationId, user.id, 'tax_invoice.cancelled', id, {
          invoiceNumber: invoice.invoice_number,
          measurementBookId: invoice.measurement_book_id,
          note,
        });
        return readDetail(tx, id);
      });
    },
  );

  app.post(
    '/api/tax-invoices/:id/recover-provider-operation',
    {
      schema: {
        params: IdParamsSchema,
        response: { 202: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const invoice = await lockInvoice(tx, id);
          await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
          if (invoice.irp_provider_state === 'registering') {
            await requireAuthority(tx, user.id, 'issue');
          } else if (invoice.irp_provider_state === 'cancelling') {
            await requireAuthority(tx, user.id, 'cancel');
          } else {
            throw httpError(
              409,
              'IRP_STATE_CONFLICT',
              'Only an in-progress IRP provider operation can be checked for stale recovery.',
            );
          }
          const recovered = await recoverStaleStatutoryOperation(tx, {
            taxInvoiceId: id,
          });
          if (recovered.length === 0) {
            throw httpError(
              409,
              'STATUTORY_OPERATION_IN_PROGRESS',
              'The provider operation is still within its two-minute lease.',
            );
          }
          await auditInvoice(
            tx,
            organisationId,
            user.id,
            'tax_invoice.provider_operation_recovered',
            id,
            { operations: recovered },
          );
          return readDetail(tx, id);
        },
      );
      return reply.status(202).send(detail);
    },
  );

  app.post(
    '/api/tax-invoices/:id/register-irp',
    {
      schema: {
        params: IdParamsSchema,
        response: {
          200: TaxInvoiceDetailResponseSchema,
          202: TaxInvoiceDetailResponseSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };

      const prepared = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireAuthority(tx, user.id, 'issue');
          await recoverStaleStatutoryOperation(tx, { taxInvoiceId: id });
          const invoice = await lockInvoice(tx, id);
          await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
          if (provider === undefined) {
            throw httpError(
              409,
              'STATUTORY_PROVIDER_NOT_CONFIGURED',
              'Whitebooks transport is not configured. Use the explicitly unverified manual compatibility flow or configure deployment secrets.',
            );
          }
          requireStatus(invoice, 'submitted');
          if (invoice.irp_provider_state === 'registered' || invoice.irn !== null) {
            throw httpError(
              409,
              'IRP_ALREADY_RECORDED',
              `This invoice already carries IRN ${invoice.irn ?? '(registered)'}; registration is not repeated.`,
            );
          }
          if (
            invoice.irp_provider_state === 'registering' ||
            invoice.irp_provider_state === 'cancelling'
          ) {
            throw httpError(
              409,
              'STATUTORY_OPERATION_IN_PROGRESS',
              'A statutory-provider operation is already in progress for this invoice.',
            );
          }
          if (
            invoice.irp_provider_state === 'cancelled' ||
            invoice.irp_provider_state === 'cancellation_unknown'
          ) {
            throw httpError(
              409,
              'IRP_STATE_CONFLICT',
              `IRP registration cannot start from ${invoice.irp_provider_state}.`,
            );
          }
          const [snapshotRow] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from tax_invoices where id = ${id}
          `;
          if (!snapshotRow)
            throw new Error(`tax invoice ${id} disappeared while locked`);
          let snapshot: ReturnType<typeof parseTaxInvoiceIssuedSnapshot>;
          let payloadJson: string;
          try {
            const issued = parseJsonbColumn(snapshotRow.issued_snapshot);
            snapshot = parseTaxInvoiceIssuedSnapshot(issued);
            payloadJson = stringifyStatutoryJson(buildFrozenIrpPayload(issued));
          } catch (error) {
            if (error instanceof EInvoiceB2cUnsupportedError) {
              throw httpError(409, error.code, error.message);
            }
            if (error instanceof TaxInvoiceSnapshotError) {
              throw httpError(
                409,
                error.code,
                'The frozen issued invoice is incomplete for IRP submission; live master data was not substituted.',
              );
            }
            throw error;
          }
          if (snapshot.buyer.gstin === null) {
            throw httpError(
              409,
              'E_INVOICE_B2C_UNSUPPORTED',
              'This adapter registers only B2B invoices with a frozen buyer GSTIN.',
            );
          }
          const identity: IrpDocumentIdentity = {
            gstin: snapshot.supplier.gstin,
            documentNumber: snapshot.invoiceNumber,
            documentDate: snapshot.invoiceDate,
          };
          const reconcileOnly = invoice.irp_provider_state === 'registration_unknown';
          const requestSha256 = sha256Hex(
            reconcileOnly ? stringifyStatutoryJson(identity) : payloadJson,
          );
          const operationId = await startStatutoryOperation(tx, {
            organisationId,
            userId: user.id,
            provider,
            operation: reconcileOnly ? 'reconcile_irp' : 'register_irp',
            requestSha256,
            taxInvoiceId: id,
          });
          await tx`
            update tax_invoices
            set irp_provider = 'whitebooks', irp_provider_state = 'registering'
            where id = ${id}
          `;
          return { operationId, identity, payloadJson, reconcileOnly, provider };
        },
      );

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

      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireAuthority(tx, user.id, 'issue');
          const invoice = await lockInvoice(tx, id);
          await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
          if (invoice.irp_provider_state !== 'registering') {
            throw new Error(`tax invoice ${id} left the registering state`);
          }
          if (evidence !== null) {
            await tx`
              update tax_invoices
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
            });
            await auditInvoice(
              tx,
              organisationId,
              user.id,
              'tax_invoice.irp_registered',
              id,
              {
                invoiceNumber: invoice.invoice_number,
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
            };
            await tx`
              update tax_invoices
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
            });
            await auditInvoice(
              tx,
              organisationId,
              user.id,
              'tax_invoice.irp_registration_unresolved',
              id,
              {
                invoiceNumber: invoice.invoice_number,
                outcome: result.status,
                providerCode: result.providerCode,
                provider: prepared.provider.name,
                operationId: prepared.operationId,
              },
            );
          }
          return readDetail(tx, id);
        },
      );

      if (evidence !== null) return reply.status(200).send(detail);
      const result = failure ?? {
        status: 'unknown' as const,
        publicCode: 'STATUTORY_PROVIDER_UNKNOWN',
      };
      if (result.status === 'failed') {
        throw httpError(
          502,
          result.publicCode,
          'Whitebooks rejected the IRP registration. The invoice remains issued locally and unregistered at the IRP.',
        );
      }
      return reply.status(202).send(detail);
    },
  );

  app.post(
    '/api/tax-invoices/:id/cancel-irp',
    {
      schema: {
        params: IdParamsSchema,
        body: CancelStatutoryDocumentRequestSchema,
        response: {
          200: TaxInvoiceDetailResponseSchema,
          202: TaxInvoiceDetailResponseSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as CancelStatutoryDocumentRequest;
      const remark = body.remark.trim();
      const prepared = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireAuthority(tx, user.id, 'cancel');
          const recoveredOperations = await recoverStaleStatutoryOperation(tx, {
            taxInvoiceId: id,
          });
          const invoice = await lockInvoice(tx, id);
          await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
          requireStatus(invoice, 'submitted');
          if (
            invoice.irp_provider_state === 'cancellation_unknown' &&
            recoveredOperations.includes('cancel_irp')
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
            invoice.irn === null ||
            invoice.irp_provider !== 'whitebooks' ||
            invoice.irp_provider_state !== 'registered'
          ) {
            throw httpError(
              409,
              'IRP_STATE_CONFLICT',
              invoice.irp_provider_state === 'cancellation_unknown'
                ? 'The earlier cancellation result is unknown. It cannot be sent again blindly; reconcile it with Whitebooks/NIC support.'
                : 'Only a Whitebooks-registered IRN can be cancelled through this action.',
            );
          }
          const [liveEwayBill] = await tx<{ id: string; ewb_number: string | null }[]>`
            select id, ewb_number from eway_bills
            where tax_invoice_id = ${id} and status <> 'cancelled'
            limit 1
          `;
          if (liveEwayBill) {
            throw httpError(
              409,
              'EWAY_BILL_LIVE',
              `Cancel e-way bill ${liveEwayBill.ewb_number ?? liveEwayBill.id} before cancelling its IRN.`,
            );
          }
          const [snapshotRow] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from tax_invoices where id = ${id}
          `;
          if (!snapshotRow) throw new Error(`tax invoice ${id} disappeared`);
          const gstin = parseTaxInvoiceIssuedSnapshot(
            parseJsonbColumn(snapshotRow.issued_snapshot),
          ).supplier.gstin;
          const requestJson = stringifyStatutoryJson({
            Irn: invoice.irn,
            CnlRsn: body.reasonCode,
            CnlRem: remark,
          });
          const operationId = await startStatutoryOperation(tx, {
            organisationId,
            userId: user.id,
            provider,
            operation: 'cancel_irp',
            requestSha256: sha256Hex(requestJson),
            taxInvoiceId: id,
          });
          await tx`
            update tax_invoices set irp_provider_state = 'cancelling'
            where id = ${id}
          `;
          return {
            recovered: false as const,
            operationId,
            irn: invoice.irn,
            gstin,
            provider,
          };
        },
      );

      if (prepared.recovered) {
        return reply.status(202).send(prepared.detail);
      }

      let cancelled: {
        readonly cancelledAtText: string;
        readonly cancelledAt: string;
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

      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireAuthority(tx, user.id, 'cancel');
          const invoice = await lockInvoice(tx, id);
          await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
          if (invoice.irp_provider_state !== 'cancelling') {
            throw new Error(`tax invoice ${id} left the cancelling state`);
          }
          if (cancelled !== null) {
            await tx`
              update tax_invoices
              set irp_provider_state = 'cancelled',
                  irp_cancelled_at = ${cancelled.cancelledAt},
                  irp_cancelled_at_text = ${cancelled.cancelledAtText},
                  irp_cancel_reason_code = ${body.reasonCode},
                  irp_cancel_remark = ${remark}
              where id = ${id}
            `;
            await finishStatutoryOperation(tx, prepared.operationId, {
              status: 'succeeded',
            });
          } else {
            const result = failure ?? {
              status: 'unknown' as const,
              providerCode: null,
              httpStatus: null,
            };
            await tx`
              update tax_invoices
              set irp_provider_state = ${
                result.status === 'failed' ? 'registered' : 'cancellation_unknown'
              }
              where id = ${id}
            `;
            await finishStatutoryOperation(tx, prepared.operationId, {
              status: result.status,
              providerCode: result.providerCode,
              httpStatus: result.httpStatus,
            });
          }
          await auditInvoice(
            tx,
            organisationId,
            user.id,
            cancelled === null
              ? 'tax_invoice.irp_cancellation_unresolved'
              : 'tax_invoice.irp_cancelled',
            id,
            {
              irn: prepared.irn,
              outcome:
                cancelled === null ? (failure?.status ?? 'unknown') : 'succeeded',
              provider: prepared.provider.name,
              operationId: prepared.operationId,
            },
          );
          return readDetail(tx, id);
        },
      );
      if (cancelled !== null) return reply.status(200).send(detail);
      if (failure?.status === 'failed') {
        throw httpError(
          502,
          failure.publicCode,
          'Whitebooks rejected the IRP cancellation. The IRN remains registered.',
        );
      }
      return reply.status(202).send(detail);
    },
  );

  app.post(
    '/api/tax-invoices/:id/irp-response',
    {
      schema: {
        params: IdParamsSchema,
        body: RecordIrpResponseRequestSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as RecordIrpResponseRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        // Compatibility import only. Manually typed evidence is labelled
        // unverified and requires the same authority as provider registration.
        await requireAuthority(tx, user.id, 'issue');
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (provider !== undefined) {
          throw httpError(
            409,
            'MANUAL_PROVIDER_EVIDENCE_DISABLED',
            'Manual IRP evidence entry is disabled while Whitebooks transport is configured.',
          );
        }
        requireStatus(invoice, 'submitted');
        // The IRP answers once per document: a second recording would
        // overwrite the registered IRN with something else.
        if (invoice.irn !== null) {
          throw httpError(
            409,
            'IRP_ALREADY_RECORDED',
            `This invoice already carries IRN ${invoice.irn}; the IRP response is recorded once.`,
          );
        }
        if (
          invoice.irp_provider !== null ||
          invoice.irp_provider_state !== 'not_requested'
        ) {
          throw httpError(
            409,
            'MANUAL_PROVIDER_EVIDENCE_CONFLICT',
            'Manual IRP evidence cannot replace or complete an existing provider attempt.',
          );
        }
        await tx`
          update tax_invoices
          set irn = ${body.irn}, ack_number = ${body.ackNumber.trim()},
              ack_date = ${body.ackDate}, ack_date_text = ${body.ackDateText.trim()},
              signed_qr = ${body.signedQr},
              signed_invoice = ${body.signedInvoice ?? null},
              irp_provider = 'manual', irp_provider_state = 'registered'
          where id = ${id}
        `;
        await auditInvoice(
          tx,
          organisationId,
          user.id,
          'tax_invoice.irp_recorded',
          id,
          {
            invoiceNumber: invoice.invoice_number,
            irn: body.irn,
            ackNumber: body.ackNumber.trim(),
            ackDate: body.ackDate,
            evidence: 'manual_unverified',
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  app.post(
    '/api/tax-invoices/:id/irp-cancel-response',
    {
      schema: {
        params: IdParamsSchema,
        body: RecordManualStatutoryCancellationRequestSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as RecordManualStatutoryCancellationRequest;
      const remark = body.remark.trim();
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireAuthority(tx, user.id, 'cancel');
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (invoice.status !== 'submitted' && invoice.status !== 'cancelled') {
          throw httpError(
            409,
            'TAX_INVOICE_STATUS_CONFLICT',
            'Only an issued tax invoice can receive external IRP cancellation evidence.',
          );
        }
        const manualActive =
          invoice.irp_provider === 'manual' &&
          (invoice.irp_provider_state === 'registered' ||
            invoice.irp_provider_state === 'cancellation_unknown');
        const whitebooksUnknown =
          invoice.irp_provider === 'whitebooks' &&
          invoice.irp_provider_state === 'cancellation_unknown';
        if (invoice.irn === null || (!manualActive && !whitebooksUnknown)) {
          throw httpError(
            409,
            'IRP_STATE_CONFLICT',
            'External cancellation evidence is accepted only for manual IRP records or an unresolved Whitebooks cancellation.',
          );
        }
        const [liveEwayBill] = await tx<{ id: string; ewb_number: string | null }[]>`
          select id, ewb_number from eway_bills
          where tax_invoice_id = ${id} and status <> 'cancelled'
          limit 1
        `;
        if (liveEwayBill) {
          throw httpError(
            409,
            'EWAY_BILL_LIVE',
            `Cancel e-way bill ${liveEwayBill.ewb_number ?? liveEwayBill.id} before recording IRP cancellation.`,
          );
        }
        await tx`
          update tax_invoices
          set irp_provider_state = 'cancelled',
              irp_cancelled_at = ${body.cancelledAt},
              irp_cancelled_at_text = ${body.cancelledAtText.trim()},
              irp_cancel_reason_code = ${body.reasonCode},
              irp_cancel_remark = ${remark}
          where id = ${id}
        `;
        await auditInvoice(
          tx,
          organisationId,
          user.id,
          'tax_invoice.irp_cancellation_recorded',
          id,
          {
            irn: invoice.irn,
            cancelledAt: body.cancelledAt,
            evidence: 'manual_unverified',
            reconciledProviderUnknown: whitebooksUnknown,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  app.get(
    '/api/tax-invoices/:id/irp-payload',
    { schema: { params: IdParamsSchema } },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const payload = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [invoice] = await tx<
            {
              work_id: string | null;
              status: TaxInvoiceStatus;
              issued_snapshot: unknown;
            }[]
          >`
          select work_id, status, issued_snapshot
          from tax_invoices where id = ${id}
        `;
          if (!invoice) {
            throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
          }
          await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
          if (invoice.status !== 'submitted') {
            throw httpError(
              409,
              'TAX_INVOICE_STATUS_CONFLICT',
              `The IRP payload exists for a submitted invoice (current status: ${invoice.status}) — a draft has no number and a cancelled invoice registers nothing.`,
            );
          }
          try {
            return buildFrozenIrpPayload(parseJsonbColumn(invoice.issued_snapshot));
          } catch (error) {
            if (error instanceof EInvoiceB2cUnsupportedError) {
              throw httpError(409, error.code, error.message);
            }
            if (error instanceof TaxInvoiceSnapshotError) {
              throw httpError(
                409,
                error.code,
                'The frozen issued invoice is incomplete for IRP submission; it was not replaced with live master data.',
              );
            }
            throw error;
          }
        },
      );
      void reply.type('application/json; charset=utf-8');
      return reply.send(stringifyStatutoryJson(payload));
    },
  );
}
