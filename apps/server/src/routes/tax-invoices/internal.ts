import {
  type CreateDirectTaxInvoiceRequest,
  type CreateTaxInvoiceRequest,
  type IrpProviderState,
  type TaxInvoice,
  type TaxInvoiceDetailResponse,
  type TaxInvoiceLine,
  type TaxInvoiceLineInput,
  type TaxInvoiceLineShape,
  type TaxInvoiceStatus,
  type UpdateTaxInvoiceRequest,
} from '@auto-mb/contracts';
import type { TransactionSql } from '@auto-mb/db';
import { assertWorkAccess } from '../../authz.js';
import { assertGstRateNotified } from '../../gst-rates.js';
import { draftConflictError } from '../../draft-conflict.js';
import { stringifyStatutoryJson } from '../../gsp/statutory-json.js';
import { sha256Hex } from '../../gsp/provider-operations.js';
import { httpError } from '../../http.js';
import { parseJsonbColumn } from '../../jsonb-column.js';
import type { TaxInvoiceIrpRenderEvidence } from '../../tax-invoice-html.js';
import type { parseTaxInvoiceIssuedSnapshot } from '../../tax-invoice-snapshot.js';

/**
 * The GST tax invoice (migrations 0035 and 0057). Its LINE SHAPE is a
 * per-document choice:
 *
 * - `service_cumulative` — the 0035 model and still the common railway
 *   works-contract bill: one service line at a SAC for a finalized
 *   Measurement Book's total, carried by the header columns;
 * - `itemised` — those header columns are NULL and the document is its
 *   `tax_invoice_lines` rows, each with its own HSN (goods) or SAC
 *   (services) code, quantity, unit rate and GST rate.
 *
 * The choice is NEVER derived from the buyer or the Work. The owner's
 * account is that practice varies by company: some vendors put HSN goods
 * items on Railway invoices too, and private customers commonly take HSN
 * goods supply. The organisation's `default_invoice_shape` seeds the
 * create FORM and nothing else.
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

// --- Row shapes -------------------------------------------------------------

export interface InvoiceRow {
  id: string;
  work_id: string | null;
  measurement_book_id: string | null;
  mb_number: string | null;
  status: TaxInvoiceStatus;
  invoice_number: string | null;
  sequence_number: number | null;
  fy_label: string | null;
  invoice_date: string;
  /** The per-document goods-vs-service shape (0057). */
  line_shape: TaxInvoiceLineShape;
  /** The cumulative service line, in the header. All three are NULL on
   * an ITEMISED invoice, whose document is its lines. */
  sac_code: string | null;
  service_description: string | null;
  gst_rate: string | null;
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
  /** Frozen at submit from the organisation's e-invoicing declaration
   * then in force (migration 0049); NULL when no window applied. */
  irp_reporting_deadline: string | null;
  /** Derived in SQL, never stored: the frozen deadline has passed in
   * the organisation's own timezone and the invoice is still not
   * registered at the IRP. */
  irp_reporting_overdue: boolean;
  /** ack_date + 24 hours (NIC's IRN cancellation window), derived in
   * SQL. NULL until registered; rows with irp_legacy_evidence_missing
   * have no provable ack instant and are treated as window-CLOSED. */
  irp_cancel_window_closes_at: Date | null;
  /** Derived: registered, ack instant provable, and now() is still
   * inside the 24-hour window. */
  irp_cancel_window_open: boolean;
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
export const TI_COLUMNS = `
  ti.id, ti.work_id, ti.measurement_book_id, mb.mb_number,
  ti.status, ti.invoice_number, ti.sequence_number, ti.fy_label,
  ti.invoice_date::text as invoice_date, ti.line_shape,
  ti.sac_code, ti.service_description,
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
  ti.irp_reporting_deadline::text as irp_reporting_deadline,
  (ti.irp_reporting_deadline is not null
     and ti.irp_provider_state not in ('registered', 'registered_unverified')
     and ti.irp_reporting_deadline <
       (select (now() at time zone o.timezone)::date from organisations o
        where o.id = ti.organisation_id))
    as irp_reporting_overdue,
  case when ti.ack_date is null or ti.irp_legacy_evidence_missing
    then null else ti.ack_date + interval '24 hours' end
    as irp_cancel_window_closes_at,
  (ti.irp_provider_state = 'registered'
     and not ti.irp_legacy_evidence_missing
     and ti.ack_date is not null
     and now() < ti.ack_date + interval '24 hours')
    as irp_cancel_window_open,
  ti.stated_taxable_value::text as stated_taxable_value,
  ti.irn, ti.ack_number, ti.ack_date, ti.cancellation_note,
  ti.created_at, ti.submitted_at, ti.cancelled_at
`;

// LEFT join, not inner: a DIRECT invoice names no Measurement Book, and
// an inner join would make it invisible to every read in this module.
export const TI_FROM = `
  from tax_invoices ti
  left join measurement_books mb on mb.id = ti.measurement_book_id
`;

export function toInvoice(row: InvoiceRow): TaxInvoice {
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
    lineShape: row.line_shape,
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
    irpReportingDeadline: row.irp_reporting_deadline,
    irpReportingOverdue: row.irp_reporting_overdue,
    irpCancelWindowClosesAt: row.irp_cancel_window_closes_at?.toISOString() ?? null,
    irpCancelWindowOpen: row.irp_cancel_window_open,
    cancellationNote: row.cancellation_note,
    createdAt: row.created_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

export async function readDetail(
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
    // A cumulative invoice has none; the read is one indexed lookup and
    // keeps the detail response one shape for both.
    lines: (await readInvoiceLines(tx, invoiceId)).map(toInvoiceLine),
  };
}

// --- The lines of an ITEMISED invoice (migration 0057) ----------------------

export interface InvoiceLineRow {
  id: string;
  position: number;
  is_service: boolean;
  hsn_sac_code: string;
  description: string;
  quantity: string;
  unit_label: string | null;
  unit_rate: string;
  gst_rate: string;
  taxable_value: string | null;
  cgst_amount: string | null;
  sgst_amount: string | null;
  igst_amount: string | null;
  /** The line's own UNROUNDED taxable + tax sum, summed in SQL numeric.
   * Derived, never stored — the e-invoice payload needs it as TotItemVal
   * and adding four money strings in binary floating point would be a
   * money error (rule 5). NULL while the parent invoice is a draft. */
  line_value: string | null;
}

export function toInvoiceLine(row: InvoiceLineRow): TaxInvoiceLine {
  return {
    id: row.id,
    position: row.position,
    isService: row.is_service,
    hsnSacCode: row.hsn_sac_code,
    description: row.description,
    quantity: row.quantity,
    unitLabel: row.unit_label,
    unitRate: row.unit_rate,
    gstRate: row.gst_rate,
    taxableValue: row.taxable_value,
    cgstAmount: row.cgst_amount,
    sgstAmount: row.sgst_amount,
    igstAmount: row.igst_amount,
  };
}

/** Every stored line of one invoice, in the order it prints. */
export async function readInvoiceLines(
  tx: TransactionSql,
  invoiceId: string,
): Promise<InvoiceLineRow[]> {
  return tx<InvoiceLineRow[]>`
    select id, position, is_service, hsn_sac_code, description,
           quantity::text as quantity, unit_label,
           unit_rate::text as unit_rate, gst_rate::text as gst_rate,
           taxable_value::text as taxable_value,
           cgst_amount::text as cgst_amount,
           sgst_amount::text as sgst_amount,
           igst_amount::text as igst_amount,
           (taxable_value + cgst_amount + sgst_amount + igst_amount)
             ::numeric(18,2)::text as line_value
    from tax_invoice_lines
    where tax_invoice_id = ${invoiceId}
    order by position
  `;
}

/** A SAC is exactly six digits — services take no eight-digit deepening —
 * while a goods HSN may be deepened to eight. The 0057 CHECK binds the
 * same pairing; this makes the refusal a named 400 that says WHICH line. */
export function assertLineCodeShape(line: TaxInvoiceLineInput, position: number): void {
  if (line.isService && !/^[0-9]{6}$/.test(line.hsnSacCode)) {
    throw httpError(
      400,
      'TAX_INVOICE_LINE_CODE_INVALID',
      `Line ${String(position)}: a service line carries a SAC of exactly six digits (received ${line.hsnSacCode}). Uncheck 'service' if this is a goods HSN.`,
    );
  }
}

/** The line's own text, trimmed to what the column holds — the same rule
 * `trimmedDescription` applies to the cumulative header line. */
function trimmedLineDescription(value: string, position: number): string {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 1000) {
    throw httpError(
      400,
      'TAX_INVOICE_LINE_DESCRIPTION_INVALID',
      `Line ${String(position)}: the description must be between 3 and 1000 characters that are not blank.`,
    );
  }
  return trimmed;
}

/**
 * Replaces an invoice's lines wholesale: create and edit share one
 * whole-object shape, exactly as the header fields do, so there is no
 * per-line PATCH surface to keep coherent. Positions are assigned from
 * the array order, so what the operator sees is what prints.
 *
 * Every line's (rate, date) pair is checked against the organisation's own
 * `gst_rates` master before it is written — the same rule the cumulative
 * header rate has obeyed since 0048, one level down, and re-checked at
 * submit because the date can still move.
 *
 * The 0057 mutation guard refuses all of this once the invoice leaves
 * draft; the route checks the status first so the refusal is a named 409.
 */
export async function replaceInvoiceLines(
  tx: TransactionSql,
  organisationId: string,
  invoiceId: string,
  invoiceDate: string,
  lines: readonly TaxInvoiceLineInput[],
): Promise<void> {
  await tx`delete from tax_invoice_lines where tax_invoice_id = ${invoiceId}`;
  let position = 0;
  for (const line of lines) {
    position += 1;
    assertLineCodeShape(line, position);
    await assertGstRateNotified(
      tx,
      line.gstRate,
      invoiceDate,
      `Line ${String(position)}`,
    );
    await tx`
      insert into tax_invoice_lines (
        organisation_id, tax_invoice_id, position, is_service, hsn_sac_code,
        description, quantity, unit_label, unit_rate, gst_rate
      )
      values (
        ${organisationId}, ${invoiceId}, ${position}, ${line.isService},
        ${line.hsnSacCode},
        ${trimmedLineDescription(line.description, position)},
        ${line.quantity}, ${line.unitLabel?.trim() ?? null},
        ${line.unitRate}, ${line.gstRate}
      )
    `;
  }
}

/**
 * A DIRECT invoice must state its taxable value (the 0039 CHECK), and an
 * itemised one already says it line by line — so the figure is SUMMED
 * from the lines rather than asked for twice and left to disagree.
 *
 * Summed in SQL numeric with the same `round(quantity * unit_rate, 2)`
 * the 0057 line CHECK and the submit arithmetic use, so the stated value
 * and the frozen one cannot drift; never in JavaScript (rule 5).
 */
export async function statedTaxableValueOfLines(
  tx: TransactionSql,
  lines: readonly TaxInvoiceLineInput[],
): Promise<string> {
  const quantities = lines.map((line) => line.quantity);
  const rates = lines.map((line) => line.unitRate);
  const [row] = await tx<{ total: string }[]>`
    select coalesce(sum(round(t.quantity * t.rate, 2)), 0)
             ::numeric(18,2)::text as total
    from unnest(
      ${quantities}::numeric[], ${rates}::numeric[]
    ) as t(quantity, rate)
  `;
  if (!row) throw new Error('line taxable-value sum returned no row');
  return row.total;
}

/**
 * The header's line fields, decided by the request's SHAPE. A cumulative
 * invoice carries its single service line here; an itemised one carries
 * NULL in all three and its lines in `tax_invoice_lines`, which is exactly
 * what the 0057 header-shape CHECK demands.
 *
 * `lineShape` is optional on the cumulative wire variant, so a client
 * written before 0057 keeps working unchanged.
 */
export function headerLineFields(
  body:
    CreateTaxInvoiceRequest | CreateDirectTaxInvoiceRequest | UpdateTaxInvoiceRequest,
): {
  lineShape: TaxInvoiceLineShape;
  sacCode: string | null;
  serviceDescription: string | null;
  gstRate: string | null;
} {
  if (body.lineShape === 'itemised') {
    return {
      lineShape: 'itemised',
      sacCode: null,
      serviceDescription: null,
      gstRate: null,
    };
  }
  return {
    lineShape: 'service_cumulative',
    sacCode: body.sacCode,
    serviceDescription: trimmedDescription(body.serviceDescription),
    gstRate: body.gstRate,
  };
}

/** What the audit trail records about a set of lines: enough to prove
 * what changed without copying the whole document into the event. */
export function auditLineSummary(
  lines: readonly TaxInvoiceLineInput[],
): { position: number; hsnSacCode: string; isService: boolean; gstRate: string }[] {
  return lines.map((line, index) => ({
    position: index + 1,
    hsnSacCode: line.hsnSacCode,
    isService: line.isService,
    gstRate: line.gstRate,
  }));
}

/** Locks the invoice row for the rest of the transaction and returns it.
 * Every state transition starts here so concurrent requests serialise
 * (`of ti` — the joined MB row is read, never written here). */
export async function lockInvoice(
  tx: TransactionSql,
  invoiceId: string,
): Promise<InvoiceRow> {
  const rows = (await tx.unsafe(
    `select ${TI_COLUMNS} ${TI_FROM} where ti.id = $1 for update of ti`,
    [invoiceId],
  )) as unknown as InvoiceRow[];
  const row = rows[0];
  if (!row) throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
  return row;
}

export function requireStatus(row: InvoiceRow, status: TaxInvoiceStatus): void {
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
export function trimmedDescription(value: string): string {
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

/** Re-exported from its own module (apps/server/src/financial-year.ts)
 * since migration 0056 gave the standalone Delivery Challan a
 * per-financial-year counter too; every existing importer is unchanged. */
export { financialYearLabel } from '../../financial-year.js';

export interface BuyerRow {
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
export async function requireBuyer(
  tx: TransactionSql,
  contactId: string,
): Promise<BuyerRow> {
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
export async function assertInvoiceWorkAccess(
  tx: TransactionSql,
  userId: string,
  workId: string | null,
): Promise<void> {
  if (workId === null) return;
  await assertWorkAccess(tx, userId, workId);
}

export async function requireShipTo(
  tx: TransactionSql,
  contactId: string,
): Promise<BuyerRow> {
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

export interface InvoiceableBook {
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
export async function lockInvoiceableBook(
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

/** The ITEMISED document's snapshot version (migration 0057). It differs
 * from ti-v1 in exactly one place — `lines` instead of `line` — and does
 * NOT supersede it: a cumulative invoice still freezes ti-v1, so no
 * stored document's shape moves and the v1 parser stays the truth for
 * every invoice issued before this existed. */
export const TAX_INVOICE_ITEMISED_TEMPLATE_VERSION = 'ti-v2';

/** The unit word when the invoice does not name one. A works-contract
 * invoice bills one whole thing, and 'set' is what the trade writes. */
export const DEFAULT_UNIT_LABEL = 'set';

/** The optional document fields a draft may carry, trimmed to what the
 * columns hold. An omitted field stores NULL — these are the invoice's
 * own text, not a PATCH surface, because create and update share one
 * whole-object shape. */
export function documentFields(
  body:
    CreateTaxInvoiceRequest | CreateDirectTaxInvoiceRequest | UpdateTaxInvoiceRequest,
): {
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
export function assertInvoiceDate(invoiceDate: string, book: InvoiceableBook): void {
  // ISO dates compare correctly as strings.
  if (invoiceDate < book.mb_date) {
    throw httpError(
      400,
      'TAX_INVOICE_DATE_BEFORE_MB',
      `The invoice date cannot precede Measurement Book ${book.mb_number ?? book.id}, dated ${book.mb_date}.`,
    );
  }
}

export async function assertInvoiceDateNotFuture(
  tx: TransactionSql,
  invoiceDate: string,
): Promise<void> {
  const [row] = await tx<{ today: string }[]>`
    select (now() at time zone timezone)::date::text as today
    from organisations
    where id = app_private.current_organisation_id()
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
export async function assertBookUninvoiced(
  tx: TransactionSql,
  measurementBookId: string,
): Promise<void> {
  // superseded behaves like cancelled here (0051): an issued credit note
  // released the MB for a corrected invoice.
  const [live] = await tx<{ id: string; invoice_number: string | null }[]>`
    select id, invoice_number from tax_invoices
    where measurement_book_id = ${measurementBookId}
      and status not in ('cancelled', 'superseded')
  `;
  if (live) {
    throw draftConflictError(
      'TAX_INVOICE_EXISTS',
      `This Measurement Book already has a live tax invoice${live.invoice_number === null ? '' : ` (${live.invoice_number})`}; cancel or delete it before raising another.`,
      live.id,
    );
  }
}

/**
 * The e-invoicing applicability gate (finding 20, migration 0049): the
 * IRP transport — provider registration and manual evidence alike — is
 * refused until the owner has declared whether e-invoicing applies, and
 * refused outright where it does not, because voluntary registration
 * below the mandate is not provided for. The declaration is the owner's
 * assertion of the legal facts; this gate enforces its consequence and
 * never auto-sends anything.
 *
 * Returns today in the organisation's own timezone, for the window gate
 * below — one read serves both.
 */
export async function requireEinvoiceDeclared(tx: TransactionSql): Promise<string> {
  const [row] = await tx<
    {
      einvoice_applicability: 'undeclared' | 'not_applicable' | 'applicable';
      today: string;
    }[]
  >`
    select einvoice_applicability,
           (now() at time zone timezone)::date::text as today
    from organisations
    where id = app_private.current_organisation_id()
  `;
  if (!row) throw new Error('bound organisation disappeared');
  if (row.einvoice_applicability === 'undeclared') {
    throw httpError(
      409,
      'E_INVOICE_APPLICABILITY_UNDECLARED',
      'Declare e-invoicing applicability on the organisation profile before using the IRP transport.',
    );
  }
  if (row.einvoice_applicability === 'not_applicable') {
    throw httpError(
      409,
      'E_INVOICE_NOT_APPLICABLE',
      'E-invoicing is declared not applicable to this organisation, and voluntary registration below the mandate is not provided for. If aggregate turnover has crossed ₹5 crore, update the declaration on the organisation profile first.',
    );
  }
  return row.today;
}

/**
 * The frozen reporting window (finding 20): a FRESH registration after
 * the stamped deadline is refused, because the IRP no longer lawfully
 * accepts the document. Reconciling an earlier attempt whose outcome is
 * unknown is NOT gated — fetching the truth about something already
 * sent is not a new report. A NULL deadline means no window applied
 * when the invoice was submitted, and nothing is gated.
 */
export function assertReportingWindowOpen(invoice: InvoiceRow, today: string): void {
  if (
    invoice.irp_reporting_deadline !== null &&
    today > invoice.irp_reporting_deadline
  ) {
    throw httpError(
      409,
      'IRP_REPORTING_WINDOW_CLOSED',
      `The IRP reporting window for this invoice closed on ${invoice.irp_reporting_deadline}; the IRP no longer accepts a fresh report of it. The invoice remains valid locally. The lawful remedy is to cancel it locally with a note and raise a corrected invoice dated within its reporting window.`,
    );
  }
}

/** The lawful instrument once NIC's window has closed — named in every
 * window refusal so the operator is told the way out, not just the wall. */
export const IRP_CANCEL_WINDOW_REMEDY =
  'Issue a credit note against this invoice instead; it supersedes the invoice and releases its Measurement Book.';

/**
 * NIC's own contract: "You can cancel only past 24 hours of invoices"
 * from IRN generation. Checked BEFORE any provider operation is opened,
 * so a cancellation that cannot succeed never consumes the single-flight
 * ledger. Rows with irp_legacy_evidence_missing have no provable
 * acknowledgement instant and are treated as window-CLOSED, never
 * unknown-open (stage 1 of finding 5's residue).
 */
export function assertIrpCancelWindowOpen(invoice: InvoiceRow): void {
  if (invoice.irp_cancel_window_open) return;
  const closesAt = invoice.irp_cancel_window_closes_at;
  throw httpError(
    409,
    'IRP_CANCEL_WINDOW_CLOSED',
    closesAt === null
      ? `The acknowledgement instant of this IRN cannot be proven from the retained evidence, so NIC's 24-hour cancellation window is treated as closed. ${IRP_CANCEL_WINDOW_REMEDY}`
      : `NIC's 24-hour IRN cancellation window for this invoice closed at ${closesAt.toISOString()}. ${IRP_CANCEL_WINDOW_REMEDY}`,
  );
}

export function invoiceRenderSourceHash(
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
