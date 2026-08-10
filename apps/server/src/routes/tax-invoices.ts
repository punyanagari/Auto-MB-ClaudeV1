import {
  ApiErrorSchema,
  CancelTaxInvoiceRequestSchema,
  CreateDirectTaxInvoiceRequestSchema,
  CreateTaxInvoiceRequestSchema,
  RecordIrpResponseRequestSchema,
  TaxInvoiceDetailResponseSchema,
  TaxInvoiceListResponseSchema,
  UpdateTaxInvoiceRequestSchema,
  type CancelTaxInvoiceRequest,
  type CreateDirectTaxInvoiceRequest,
  type CreateTaxInvoiceRequest,
  type RecordIrpResponseRequest,
  type TaxInvoice,
  type TaxInvoiceDetailResponse,
  type TaxInvoiceStatus,
  type UpdateTaxInvoiceRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireAuthority, requireWriterRole } from '../authz.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
import {
  buildIrpPayload,
  extractLocation,
  extractPincode,
} from '../gsp/irp-payload.js';
import { httpError } from '../http.js';
import {
  NumberTemplateError,
  loadNumberTemplate,
  renderNumberTemplate,
} from '../number-series.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { requireUser } from '../session.js';
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
 * - No not-in-the-future date guard. The invoice date is a filing fact
 *   at the operator's discretion: a 31 March invoice is routinely
 *   recorded in April, and the financial-year counter must accept
 *   either side of the boundary. What IS refused is an invoice dated
 *   before the Measurement Book it bills — billing cannot precede
 *   measurement (and the MB date already floors at the LOA letter
 *   date).
 *
 * THE DRAFT'S BUYER LIVES IN THE AUDIT TRAIL. 0035 gives the invoice row
 * no buyer_contact_id column, and the draft-shape CHECK keeps
 * buyer_snapshot NULL until submit — so the buyer chosen while drafting
 * is carried by the created/updated audit events' `buyerContactId`
 * detail, exactly the way the MB merge carries its un-merge provenance.
 * The read model resolves it from the snapshot once submitted and from
 * the newest audit event while draft; both writers of a draft ALWAYS
 * record the field, so a hole is corruption, not user error.
 */

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
} as const;

const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

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
  buyer_contact_id: string | null;
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

/** `buyer_contact_id` is the submit-time snapshot's contactId once
 * submitted, and the newest audit event's buyerContactId while draft —
 * see the module note on where the draft's buyer lives. */
const TI_COLUMNS = `
  ti.id, ti.work_id, ti.measurement_book_id, mb.mb_number,
  ti.status, ti.invoice_number, ti.sequence_number, ti.fy_label,
  ti.invoice_date::text as invoice_date, ti.sac_code, ti.service_description,
  ti.gst_rate::text as gst_rate, ti.place_of_supply,
  coalesce(
    ti.buyer_snapshot->>'contactId',
    (select ae.details->>'buyerContactId' from audit_events ae
      where ae.entity_type = 'tax_invoices' and ae.entity_id = ti.id
        and ae.details ? 'buyerContactId'
      order by ae.occurred_at desc, ae.id desc
      limit 1)
  ) as buyer_contact_id,
  ti.taxable_value::text as taxable_value, ti.cgst_amount::text as cgst_amount,
  ti.sgst_amount::text as sgst_amount, ti.igst_amount::text as igst_amount,
  ti.round_off::text as round_off, ti.total_amount::text as total_amount,
  (ti.taxable_value + ti.cgst_amount + ti.sgst_amount + ti.igst_amount)
    ::numeric(18,2)::text as line_value,
  ti.customer_po_reference, ti.unit_label, ti.notes, ti.ship_to_contact_id,
  ti.number_prefix, ti.ack_date_text,
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
    ackNumber: row.ack_number,
    ackDate: row.ack_date?.toISOString() ?? null,
    ackDateText: row.ack_date_text,
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
           state_code, division_code, active
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
           state_code, division_code, active
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
 * billed MB's date. (There is deliberately no not-in-the-future bound —
 * see the module note.) */
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

// --- Routes -----------------------------------------------------------------

export function registerTaxInvoiceRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
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
          await assertWorkAccess(tx, user.id, workId);
          const book = await lockInvoiceableBook(tx, workId, body.measurementBookId);
          assertInvoiceDate(body.invoiceDate, book);
          await requireBuyer(tx, body.buyerContactId);
          await assertBookUninvoiced(tx, book.id);

          const [created] = await tx<{ id: string }[]>`
            insert into tax_invoices (
              organisation_id, work_id, measurement_book_id, invoice_date,
              sac_code, service_description, gst_rate, place_of_supply,
              customer_po_reference, unit_label, notes, ship_to_contact_id,
              number_prefix, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.measurementBookId},
              ${body.invoiceDate}, ${body.sacCode}, ${serviceDescription},
              ${body.gstRate}, ${body.placeOfSupply},
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
          await requireBuyer(tx, body.buyerContactId);
          const [created] = await tx<{ id: string }[]>`
            insert into tax_invoices (
              organisation_id, invoice_date, sac_code, service_description,
              gst_rate, place_of_supply, stated_taxable_value,
              customer_po_reference, unit_label, notes, ship_to_contact_id,
              number_prefix, created_by_user_id
            )
            values (
              ${organisationId}, ${body.invoiceDate}, ${body.sacCode},
              ${serviceDescription}, ${body.gstRate}, ${body.placeOfSupply},
              ${body.taxableValue},
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
        const [ref] = await tx<{ work_id: string }[]>`
          select work_id from tax_invoices where id = ${id}
        `;
        if (!ref) throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
        await assertWorkAccess(tx, user.id, ref.work_id);
        return readDetail(tx, id);
      });
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
              trade_name: string | null;
              msme_number: string | null;
              contact_phone: string | null;
              invoice_number_prefix: string | null;
              invoice_notes: string | null;
            }[]
          >`
            select name, state_code, gstin, address, pincode, trade_name,
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

          // The draft's buyer, resolved from the audit-trail store. The
          // create/update writers always record it, so a hole here is
          // corruption, not user error.
          if (invoice.buyer_contact_id === null) {
            throw new Error(
              `tax invoice ${id} has no buyerContactId in its audit trail`,
            );
          }
          const buyer = await requireBuyer(tx, invoice.buyer_contact_id);
          const missing = [
            ...(buyer.address === null ? ['address'] : []),
            ...(buyer.state_code === null ? ['stateCode'] : []),
            ...(buyer.pincode === null ? ['pincode'] : []),
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
                     as round_off
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
          };

          // The ship-to, when one was named. Same freeze as the buyer,
          // and deliberately NOT a copy of it: the delivered-to block on
          // a real invoice drops the GSTIN the billed-to block carries,
          // so repeating the buyer would print a GSTIN the document
          // means to leave off.
          const shipTo =
            invoice.ship_to_contact_id === null
              ? null
              : await requireShipTo(tx, invoice.ship_to_contact_id);
          const shipToSnapshot =
            shipTo === null
              ? null
              : {
                  contactId: shipTo.id,
                  designation: shipTo.designation,
                  contactPerson: shipTo.contact_person,
                  address: shipTo.address,
                  stateCode: shipTo.state_code,
                  pincode: shipTo.pincode,
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
              stateCode: organisation.state_code,
              gstin: organisation.gstin,
              phone: organisation.contact_phone,
              msmeNumber: organisation.msme_number,
            },
            buyer: buyerSnapshot,
            shipTo: shipToSnapshot,
            placeOfSupply: invoice.place_of_supply,
            customerPoReference: invoice.customer_po_reference,
            line: {
              sacCode: invoice.sac_code,
              description: invoice.service_description,
              quantity: '1.00',
              unitLabel: invoice.unit_label ?? DEFAULT_UNIT_LABEL,
              rate: money.taxable,
              gstRate: invoice.gst_rate,
              amount: money.taxable,
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
        // Recording what the IRP already decided is clerical — writer
        // role, not issue authority; the legal act was the submit.
        await requireWriterRole(tx, user.id);
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
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
        await tx`
          update tax_invoices
          set irn = ${body.irn}, ack_number = ${body.ackNumber.trim()},
              ack_date = ${body.ackDate}, signed_qr = ${body.signedQr}
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
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  app.get(
    '/api/tax-invoices/:id/irp-payload',
    { schema: { params: IdParamsSchema } },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const rows = (await tx.unsafe(
          `select ${TI_COLUMNS}, ti.buyer_snapshot ${TI_FROM} where ti.id = $1`,
          [id],
        )) as unknown as (InvoiceRow & { buyer_snapshot: unknown })[];
        const invoice = rows[0];
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
        const [organisation] = await tx<
          {
            name: string;
            address: string | null;
            gstin: string | null;
            state_code: string | null;
            pincode: string | null;
          }[]
        >`
          select name, address, gstin, state_code, pincode from organisations
        `;
        // The submit proved GSTIN and state; re-proved here because the
        // profile can be cleared afterwards and the payload must never
        // invent a seller.
        if (!organisation?.gstin) {
          throw httpError(
            400,
            'ORG_GSTIN_REQUIRED',
            'The organisation profile has no GSTIN; the IRP payload cannot name the seller.',
          );
        }
        if (!organisation.state_code) {
          throw httpError(
            400,
            'ORG_STATE_REQUIRED',
            'The organisation profile has no GST state code; the IRP payload cannot name the seller state.',
          );
        }
        if (organisation.address === null) {
          throw httpError(
            400,
            'ORG_ADDRESS_REQUIRED',
            'The organisation profile has no address; the IRP payload needs the seller address.',
          );
        }
        // The PIN is a column of its own since 0037. The address scrape
        // survives ONLY as a fallback for a profile that predates it —
        // an address line is not required to contain a PIN, and real
        // ones frequently do not.
        const sellerPincode =
          organisation.pincode ?? extractPincode(organisation.address);
        if (sellerPincode === null) {
          throw httpError(
            400,
            'ORG_PINCODE_REQUIRED',
            'The organisation profile has no PIN code, and its address names no six-digit one; the IRP payload needs the seller PIN. Set it in Settings.',
          );
        }
        const snapshot = parseJsonbColumn(invoice.buyer_snapshot) as {
          designation?: string;
          gstin?: string | null;
          address?: string;
          stateCode?: string;
          pincode?: string;
        } | null;
        if (
          !snapshot ||
          snapshot.designation === undefined ||
          snapshot.address === undefined ||
          snapshot.stateCode === undefined ||
          snapshot.pincode === undefined ||
          snapshot.address === null ||
          snapshot.stateCode === null ||
          snapshot.pincode === null
        ) {
          // Submit requires all of these before freezing the snapshot.
          throw new Error(`tax invoice ${id} has an incomplete buyer snapshot`);
        }
        if (
          invoice.taxable_value === null ||
          invoice.cgst_amount === null ||
          invoice.sgst_amount === null ||
          invoice.igst_amount === null ||
          invoice.total_amount === null ||
          invoice.round_off === null ||
          invoice.line_value === null ||
          invoice.invoice_number === null
        ) {
          throw new Error(`submitted tax invoice ${id} is missing frozen amounts`);
        }
        return buildIrpPayload({
          invoiceNumber: invoice.invoice_number,
          invoiceDate: invoice.invoice_date,
          sacCode: invoice.sac_code,
          serviceDescription: invoice.service_description,
          placeOfSupply: invoice.place_of_supply,
          gstRate: invoice.gst_rate,
          taxableValue: invoice.taxable_value,
          cgstAmount: invoice.cgst_amount,
          sgstAmount: invoice.sgst_amount,
          igstAmount: invoice.igst_amount,
          totalAmount: invoice.total_amount,
          roundOff: invoice.round_off,
          lineValue: invoice.line_value,
          seller: {
            gstin: organisation.gstin,
            legalName: organisation.name,
            address: organisation.address,
            location: extractLocation(organisation.address, sellerPincode),
            pincode: sellerPincode,
            stateCode: organisation.state_code,
          },
          buyer: {
            gstin: snapshot.gstin ?? null,
            legalName: snapshot.designation,
            address: snapshot.address,
            location: extractLocation(snapshot.address, snapshot.pincode),
            pincode: snapshot.pincode,
            stateCode: snapshot.stateCode,
          },
        });
      });
    },
  );
}
