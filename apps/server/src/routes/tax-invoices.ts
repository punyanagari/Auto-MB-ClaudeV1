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
 * a SAC for a finalized Measurement Book's total â€” a works contract is a
 * supply of services, so there are no per-item HSN lines, ever.
 *
 * Draft (unnumbered, amounts open) -> submitted (the money moment: a
 * gapless per-organisation PER-FINANCIAL-YEAR number under the counter
 * row lock, the buyer snapshotted from its contact, the taxable value
 * taken VERBATIM from the MB total and the CGST+SGST/IGST split computed
 * in exact SQL numeric arithmetic) -> cancelled with a note it keeps
 * forever. Submitting is what closes the MB it bills â€” the 0035 trigger
 * refuses cancelling an MB with a live invoice â€” and cancelling the
 * invoice releases the MB for a corrected one. The whole posture â€” one
 * transaction per request, the row locked before every transition, issue
 * and cancel behind their explicit authorities, every change audited,
 * database refusals surfaced as named 400/409s â€” is the delivery
 * challan's (routes/challans.ts).
 *
 * TWO DELIBERATE DEPARTURES from the site documents:
 *
 * - No completed-Work refusal. R8 freezes OPERATIONS (challans,
 *   installations, MBs); the invoice bills measurement that is already
 *   frozen, and billing legitimately outlives completion â€” the bill
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

  const reader = response.body.getReader();
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
  /** A DIRECT invoice's taxable value â€” the one raised against a private
   * customer, which has no Measurement Book to take a total from.
   * Exactly one of this and measurement_book_id is ever set (0039). */
  stated_taxable_value: string | null;
  /** The line's own value: the UNROUNDED sum of the taxable value and
   * its taxes, summed in SQL numeric. Derived, never stored â€” the
   * e-invoice payload needs it and deriving it by subtracting the
   * rounding delta in binary floating point would be a money error. */
  line_value: string | null;
}

/** `buyer_contact_id` is the submit-time snapshot's contactId once
 * submitted, and the newest audit event's buyerContactId while draft â€”
 * see the module note on where the draft's buyer lives. */
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
 * (`of ti` â€” the joined MB row is read, never written here). */
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

/** April-to-March financial year label from a date-only string â€”
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

/** The buyer is any ACTIVE contact â€” the railway consignee or a private
 * client; restricting to a role flag would add friction with no
 * correctness gain, since the snapshot below records exactly who was
 * billed. A contact of another tenant is invisible under RLS and answers
 * exactly like an unknown id. */
async function requireBuyer(tx: TransactionSql, contactId: string): Promise<BuyerRow> {
  const [row] = await tx<BuyerRow[]>`
    select id, designation, contact_person, address, gstin, pincode,
           state_code, locality, division_code, active
    from contacts where id = ${cÛ^5ÚÚ$z{-®éÜj×¢ç÷7B€¢rö’÷F‚Ö–çfö–6W2ó¦–Bö6æ6VÂÖ—'rÀ¢°¢66†VÖ¢°¢&×3¢–E&×566†VÖÀ¢&öG“¢6æ6VÅ7FGWF÷'”Fö7VÖVçE&WVW7E66†VÖÀ¢&W7öç6S¢°¢#¢F„–çfö–6TFWF–Å&W7öç6U66†VÖÀ¢##¢F„–çfö–6TFWF–Å&W7öç6U66†VÖÀ¢ââæW'&÷%&W7öç6W2À¢ÒÀ¢ÒÀ¢ÒÀ¢7–æ2‡&WVW7BÂ&WÇ’’Óâ°¢6öç7BW6W"Òv—B&WV—&UW6W"†WF‚Â&WVW7B“°¢6öç7B÷&væ—6F–öä–BÒ&WV—&T÷&væ—6F–öä†VFW"€¢&WVW7Bæ†VFW'5²w‚Ö÷&væ—6F–öâÖ–BuÒÀ¢“°¢6öç7B²–BÒÒ&WVW7Bç&×22²–C¢7G&–ærÓ°¢6öç7B&öG’Ò&WVW7Bæ&öG’26æ6VÅ7FGWF÷'”Fö7VÖVçE&WVW7C°¢6öç7B&VÖ&²Ò&öG’ç&VÖ&²çG&–Ò‚“°¢6öç7B&W&VBÒv—Bv—F„&÷VæEFVæçB€¢FF&6RÀ¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢7–æ2‡G‚’Óâ°¢v—B&WV—&TWF†÷&—G’‡G‚ÂW6W"æ–BÂv6æ6VÂr“°¢6öç7B&V6÷fW&VD÷W&F–öç2Òv—B&V6÷fW%7FÆU7FGWF÷'”÷W&F–öâ‡G‚Â°¢F„–çfö–6T–C¢–BÀ¢Ò“°¢6öç7B–çfö–6RÒv—BÆö6´–çfö–6R‡G‚Â–B“°¢v—B76W'D–çfö–6Uv÷&´66W72‡G‚ÂW6W"æ–BÂ–çfö–6Rçv÷&µö–B“°¢&WV—&U7FGW2†–çfö–6RÂw7V&Ö—GFVBr“°¢–b€¢–çfö–6Ræ—'÷&÷f–FW%÷7FFRÓÓÒv6æ6VÆÆF–öå÷Væ¶æ÷vârb`¢&V6÷fW&VD÷W&F–öç2æ–æ6ÇVFW2‚v6æ6VÅö—'r¢’°¢&WGW&â°¢&V6÷fW&VC¢G'VR26öç7BÀ¢FWF–Ã¢v—B&VDFWF–Â‡G‚Â–B’À¢Ó°¢Ğ¢–b‡&÷f–FW"ÓÓÒVæFVf–æVB’°¢F‡&÷r‡GGW'&÷"€¢C’À¢u5DEUDõ%•õ$õd”DU%ôäõEô4ôäd”uU$TBrÀ¢uv†—FV&öö·2G&ç7÷'B—2æ÷B6öæf–wW&VBârÀ¢“°¢Ğ¢–b€¢–çfö–6Ræ—&âÓÓÒçVÆÂÇÀ¢–çfö–6Ræ—'÷&÷f–FW"ÓÒwv†—FV&öö·2rÇÀ¢–çfö–6Ræ—'÷&÷f–FW%÷7FFRÓÒw&Vv—7FW&VBp¢’°¢F‡&÷r‡GGW'&÷"€¢C’À¢t•%õ5DDUô4ôädÄ”5BrÀ¢–çfö–6Ræ—'÷&÷f–FW%÷7FFRÓÓÒv6æ6VÆÆF–öå÷Væ¶æ÷vâp¢òuF†RV&Æ–W"6æ6VÆÆF–öâ&W7VÇB—2Væ¶æ÷vââ—B6ææ÷B&R6VçBv–â&Æ–æFÇ“²&V6öæ6–ÆR—Bv—F‚v†—FV&öö·2ôä”27W÷'Bâp¢¢töæÇ’v†—FV&öö·2×&Vv—7FW&VB•$â6â&R6æ6VÆÆVBF‡&÷Vv‚F†—27F–öâârÀ¢“°¢Ğ¢6öç7B¶Æ—fTWv”&–ÆÅÒÒv—BGƒÇ²–C¢7G&–æs²Wv%öçVÖ&W#¢7G&–ærÂçVÆÂÕµÓæ ¢6VÆV7B–BÂWv%öçVÖ&W"g&öÒWv•ö&–ÆÇ0¢v†W&RF…ö–çfö–6Uö–BÒG¶–GÒæB7FGW2Ãâv6æ6VÆÆVBp¢Æ–Ö—B¢°¢–b†Æ—fTWv”&–ÆÂ’°¢F‡&÷r‡GGW'&÷"€¢C’À¢tUt•ô$”ÄÅôÄ•dRrÀ¢6æ6VÂR×v’&–ÆÂG¶Æ—fTWv”&–ÆÂæWv%öçVÖ&W"óòÆ—fTWv”&–ÆÂæ–GÒ&Vf÷&R6æ6VÆÆ–ær—G2•$âæÀ¢“°¢Ğ¢6öç7B·6æ6†÷E&÷uÒÒv—BGƒÇ²—77VVE÷6æ6†÷C¢Væ¶æ÷vâÕµÓæ ¢6VÆV7B—77VVE÷6æ6†÷Bg&öÒF…ö–çfö–6W2v†W&R–BÒG¶–GĞ¢°¢–b‚6æ6†÷E&÷r’F‡&÷ræWrW'&÷"†F‚–çfö–6RG¶–GÒF—6V&VF“°¢6öç7Bw7F–âÒ'6UF„–çfö–6T—77VVE6æ6†÷B€¢'6T§6öæ$6öÇVÖâ‡6æ6†÷E&÷ræ—77VVE÷6æ6†÷B’À¢’ç7WÆ–W"æw7F–ã°¢6öç7B&WVW7D§6öâÒ7G&–æv–g•7FGWF÷'”§6öâ‡°¢—&ã¢–çfö–6Ræ—&âÀ¢6æÅ'6ã¢&öG’ç&V6öä6öFRÀ¢6æÅ&VÓ¢&VÖ&²À¢Ò“°¢6öç7B÷W&F–öä–BÒv—B7F'E7FGWF÷'”÷W&F–öâ‡G‚Â°¢÷&væ—6F–öä–BÀ¢W6W$–C¢W6W"æ–BÀ¢&÷f–FW"À¢÷W&F–öã¢v6æ6VÅö—'rÀ¢&WVW7E6†#Sc¢6†#Sd†W‚‡&WVW7D§6öâ’À¢F„–çfö–6T–C¢–BÀ¢Ò“°¢v—BG† ¢WFFRF…ö–çfö–6W26WB—'÷&÷f–FW%÷7FFRÒv6æ6VÆÆ–ærp¢v†W&R–BÒG¶–GĞ¢°¢&WGW&â°¢&V6÷fW&VC¢fÇ6R26öç7BÀ¢÷W&F–öä–BÀ¢—&ã¢–çfö–6Ræ—&âÀ¢w7F–âÀ¢&÷f–FW"À¢Ó°¢ÒÀ¢“° ¢–b‡&W&VBç&V6÷fW&VB’°¢&WGW&â&WÇ’ç7FGW2ƒ#"’ç6VæB‡&W&VBæFWF–Â“°¢Ğ ¢ÆWB6æ6VÆÆVC¢°¢&VFöæÇ’6æ6VÆÆVDEFW‡C¢7G&–æs°¢&VFöæÇ’6æ6VÆÆVDC¢7G&–æs°¢ÒÂçVÆÂÒçVÆÃ°¢ÆWBf–ÇW&S¢&WGW&åG—SÇG—Vöb&÷f–FW$f–ÇW&SâÂçVÆÂÒçVÆÃ°¢G'’°¢6æ6VÆÆVBÒv—B&W&VBç&÷f–FW"æ6æ6VÄ–çfö–6R‡°¢w7F–ã¢&W&VBæw7F–âÀ¢—&ã¢&W&VBæ—&âÀ¢&V6öä6öFS¢&öG’ç&V6öä6öFRÀ¢&VÖ&²À¢Ò“°¢Ò6F6‚†W'&÷"’°¢f–ÇW&RÒ&÷f–FW$f–ÇW&R†W'&÷"“°¢Ğ ¢6öç7BFWF–ÂÒv—Bv—F„&÷VæEFVæçB€¢FF&6RÀ¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢7–æ2‡G‚’Óâ°¢v—B&WV—&TWF†÷&—G’‡G‚ÂW6W"æ–BÂv6æ6VÂr“°¢6öç7B–çfö–6RÒv—BÆö6´–çfö–6R‡G‚Â–B“°¢v—B76W'D–çfö–6Uv÷&´66W72‡G‚ÂW6W"æ–BÂ–çfö–6Rçv÷&µö–B“°¢–b†–çfö–6Ræ—'÷&÷f–FW%÷7FFRÓÒv6æ6VÆÆ–ærr’°¢F‡&÷ræWrW'&÷"†F‚–çfö–6RG¶–GÒÆVgBF†R6æ6VÆÆ–ær7FFV“°¢Ğ¢–b†6æ6VÆÆVBÓÒçVÆÂ’°¢v—BG† ¢WFFRF…ö–çfö–6W0¢6WB—'÷&÷f–FW%÷7FFRÒv6æ6VÆÆVBrÀ¢—'ö6æ6VÆÆVEöBÒG¶6æ6VÆÆVBæ6æ6VÆÆVDGÒÀ¢—'ö6æ6VÆÆVEöE÷FW‡BÒG¶6æ6VÆÆVBæ6æ6VÆÆVDEFW‡GÒÀ¢—'ö6æ6VÅ÷&V6öåö6öFRÒG¶&öG’ç&V6öä6öFWÒÀ¢—'ö6æ6VÅ÷&VÖ&²ÒG·&VÖ&·Ğ¢v†W&R–BÒG¶–GĞ¢°¢v—Bf–æ—6…7FGWF÷'”÷W&F–öâ‡G‚Â&W&VBæ÷W&F–öä–BÂ°¢7FGW3¢w7V66VVFVBrÀ¢Ò“°¢ÒVÇ6R°¢6öç7B&W7VÇBÒf–ÇW&Róò°¢7FGW3¢wVæ¶æ÷vâr26öç7BÀ¢&÷f–FW$6öFS¢çVÆÂÀ¢‡GG7FGW3¢çVÆÂÀ¢Ó°¢v—BG† ¢WFFRF…ö–çfö–6W0¢6WB—'÷&÷f–FW%÷7FFRÒG°¢&W7VÇBç7FGW2ÓÓÒvf–ÆVBròw&Vv—7FW&VBr¢v6æ6VÆÆF–öå÷Væ¶æ÷vâp¢Ğ¢v†W&R–BÒG¶–GĞ¢°¢v—Bf–æ—6…7FGWF÷'”÷W&F–öâ‡G‚Â&W&VBæ÷W&F–öä–BÂ°¢7FGW3¢&W7VÇBç7FGW2À¢&÷f–FW$6öFS¢&W7VÇBç&÷f–FW$6öFRÀ¢‡GG7FGW3¢&W7VÇBæ‡GG7FGW2À¢Ò“°¢Ğ¢v—BVF—D–çfö–6R€¢G‚À¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢6æ6VÆÆVBÓÓÒçVÆÀ¢òwF…ö–çfö–6Ræ—'ö6æ6VÆÆF–öå÷Vç&W6öÇfVBp¢¢wF…ö–çfö–6Ræ—'ö6æ6VÆÆVBrÀ¢–BÀ¢°¢—&ã¢&W&VBæ—&âÀ¢÷WF6öÖS ¢6æ6VÆÆVBÓÓÒçVÆÂò†f–ÇW&Sòç7FGW2óòwVæ¶æ÷vâr’¢w7V66VVFVBrÀ¢&÷f–FW#¢&W&VBç&÷f–FW"ææÖRÀ¢÷W&F–öä–C¢&W&VBæ÷W&F–öä–BÀ¢ÒÀ¢“°¢&WGW&â&VDFWF–Â‡G‚Â–B“°¢ÒÀ¢“°¢–b†6æ6VÆÆVBÓÒçVÆÂ’&WGW&â&WÇ’ç7FGW2ƒ#’ç6VæB†FWF–Â“°¢–b†f–ÇW&Sòç7FGW2ÓÓÒvf–ÆVBr’°¢F‡&÷r‡GGW'&÷"€¢S"À¢f–ÇW&RçV&Æ–46öFRÀ¢uv†—FV&öö·2&V¦V7FVBF†R•%6æ6VÆÆF–öââF†R•$â&VÖ–ç2&Vv—7FW&VBârÀ¢“°¢Ğ¢&WGW&â&WÇ’ç7FGW2ƒ#"’ç6VæB†FWF–Â“°¢ÒÀ¢“° ¢ç÷7B€¢rö’÷F‚Ö–çfö–6W2ó¦–Bö—'×&W7öç6RrÀ¢°¢66†VÖ¢°¢&×3¢–E&×566†VÖÀ¢&öG“¢&V6÷&D—'&W7öç6U&WVW7E66†VÖÀ¢&W7öç6S¢²#¢F„–çfö–6TFWF–Å&W7öç6U66†VÖÂââæW'&÷%&W7öç6W2ÒÀ¢ÒÀ¢ÒÀ¢7–æ2‡&WVW7B’Óâ°¢6öç7BW6W"Òv—B&WV—&UW6W"†WF‚Â&WVW7B“°¢6öç7B÷&væ—6F–öä–BÒ&WV—&T÷&væ—6F–öä†VFW"€¢&WVW7Bæ†VFW'5²w‚Ö÷&væ—6F–öâÖ–BuÒÀ¢“°¢6öç7B²–BÒÒ&WVW7Bç&×22²–C¢7G&–ærÓ°¢6öç7B&öG’Ò&WVW7Bæ&öG’2&V6÷&D—'&W7öç6U&WVW7C°¢&WGW&âv—F„&÷VæEFVæçB†FF&6RÂ÷&væ—6F–öä–BÂW6W"æ–BÂ7–æ2‡G‚’Óâ°¢òò6ö×F–&–Æ—G’–×÷'BöæÇ’âÖçVÆÇ’G—VBWf–FVæ6R—2Æ&VÆÆV@¢òòVçfW&–f–VBæB&WV—&W2F†R6ÖRWF†÷&—G’2&÷f–FW"&Vv—7G&F–öâà¢v—B&WV—&TWF†÷&—G’‡G‚ÂW6W"æ–BÂv—77VRr“°¢6öç7B–çfö–6RÒv—BÆö6´–çfö–6R‡G‚Â–B“°¢v—B76W'D–çfö–6Uv÷&´66W72‡G‚ÂW6W"æ–BÂ–çfö–6Rçv÷&µö–B“°¢–b‡&÷f–FW"ÓÒVæFVf–æVB’°¢F‡&÷r‡GGW'&÷"€¢C’À¢tÔåTÅõ$õd”DU%ôUd”DTä4UôD•4$ÄTBrÀ¢tÖçVÂ•%Wf–FVæ6RVçG'’—2F—6&ÆVBv†–ÆRv†—FV&öö·2G&ç7÷'B—26öæf–wW&VBârÀ¢“°¢Ğ¢&WV—&U7FGW2†–çfö–6RÂw7V&Ö—GFVBr“°¢òòF†R•%ç7vW'2öæ6RW"Fö7VÖVçC¢6V6öæB&V6÷&F–ærv÷VÆ@¢òò÷fW'w&—FRF†R&Vv—7FW&VB•$âv—F‚6öÖWF†–ærVÇ6Rà¢–b†–çfö–6Ræ—&âÓÒçVÆÂ’°¢F‡&÷r‡GGW'&÷"€¢C’À¢t•%ôÅ$TE•õ$T4õ$DTBrÀ¢F†—2–çfö–6RÇ&VG’6'&–W2•$âG¶–çfö–6Ræ—&çÓ²F†R•%&W7öç6R—2&V6÷&FVBöæ6RæÀ¢“°¢Ğ¢–b€¢–çfö–6Ræ—'÷&÷f–FW"ÓÒçVÆÂÇÀ¢–çfö–6Ræ—'÷&÷f–FW%÷7FFRÓÒvæ÷E÷&WVW7FVBp¢’°¢F‡&÷r‡GGW'&÷"€¢C’À¢tÔåTÅõ$õd”DU%ôUd”DTä4Uô4ôädÄ”5BrÀ¢tÖçVÂ•%Wf–FVæ6R6ææ÷B&WÆ6R÷"6ö×ÆWFRâW†—7F–ær&÷f–FW"GFV×BârÀ¢“°¢Ğ¢v—BG† ¢WFFRF…ö–çfö–6W0¢6WB—&âÒG¶&öG’æ—&çÒÂ6µöçVÖ&W"ÒG¶&öG’æ6´çVÖ&W"çG&–Ò‚—ÒÀ¢6µöFFRÒG¶&öG’æ6´FFWÒÂ6µöFFU÷FW‡BÒG¶&öG’æ6´FFUFW‡BçG&–Ò‚—ÒÀ¢6–væVE÷"ÒG¶&öG’ç6–væVE'ÒÀ¢6–væVEö–çfö–6RÒG¶&öG’ç6–væVD–çfö–6RóòçVÆÇÒÀ¢—'÷&÷f–FW"ÒvÖçVÂrÂ—'÷&÷f–FW%÷7FFRÒw&Vv—7FW&VBp¢v†W&R–BÒG¶–GĞ¢°¢v—BVF—D–çfö–6R€¢G‚À¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢wF…ö–çfö–6Ræ—'÷&V6÷&FVBrÀ¢–BÀ¢°¢–çfö–6TçVÖ&W#¢–çfö–6Ræ–çfö–6UöçVÖ&W"À¢—&ã¢&öG’æ—&âÀ¢6´çVÖ&W#¢&öG’æ6´çVÖ&W"çG&–Ò‚’À¢6´FFS¢&öG’æ6´FFRÀ¢Wf–FVæ6S¢vÖçVÅ÷VçfW&–f–VBrÀ¢ÒÀ¢“°¢&WGW&â&VDFWF–Â‡G‚Â–B“°¢Ò“°¢ÒÀ¢“° ¢ç÷7B€¢rö’÷F‚Ö–çfö–6W2ó¦–Bö—'Ö6æ6VÂ×&W7öç6RrÀ¢°¢66†VÖ¢°¢&×3¢–E&×566†VÖÀ¢&öG“¢&V6÷&DÖçVÅ7FGWF÷'”6æ6VÆÆF–öå&WVW7E66†VÖÀ¢&W7öç6S¢²#¢F„–çfö–6TFWF–Å&W7öç6U66†VÖÂââæW'&÷%&W7öç6W2ÒÀ¢ÒÀ¢ÒÀ¢7–æ2‡&WVW7B’Óâ°¢6öç7BW6W"Òv—B&WV—&UW6W"†WF‚Â&WVW7B“°¢6öç7B÷&væ—6F–öä–BÒ&WV—&T÷&væ—6F–öä†VFW"€¢&WVW7Bæ†VFW'5²w‚Ö÷&væ—6F–öâÖ–BuÒÀ¢“°¢6öç7B²–BÒÒ&WVW7Bç&×22²–C¢7G&–ærÓ°¢6öç7B&öG’Ò&WVW7Bæ&öG’2&V6÷&DÖçVÅ7FGWF÷'”6æ6VÆÆF–öå&WVW7C°¢6öç7B&VÖ&²Ò&öG’ç&VÖ&²çG&–Ò‚“°¢&WGW&âv—F„&÷VæEFVæçB†FF&6RÂ÷&væ—6F–öä–BÂW6W"æ–BÂ7–æ2‡G‚’Óâ°¢v—B&WV—&TWF†÷&—G’‡G‚ÂW6W"æ–BÂv6æ6VÂr“°¢6öç7B–çfö–6RÒv—BÆö6´–çfö–6R‡G‚Â–B“°¢v—B76W'D–çfö–6Uv÷&´66W72‡G‚ÂW6W"æ–BÂ–çfö–6Rçv÷&µö–B“°¢–b†–çfö–6Rç7FGW2ÓÒw7V&Ö—GFVBrbb–çfö–6Rç7FGW2ÓÒv6æ6VÆÆVBr’°¢F‡&÷r‡GGW'&÷"€¢C’À¢uD…ô”ådô”4Uõ5DEU5ô4ôädÄ”5BrÀ¢töæÇ’â—77VVBF‚–çfö–6R6â&V6V—fRW‡FW&æÂ•%6æ6VÆÆF–öâWf–FVæ6RârÀ¢“°¢Ğ¢6öç7BÖçVÄ7F—fRĞ¢–çfö–6Ræ—'÷&÷f–FW"ÓÓÒvÖçVÂrb`¢†–çfö–6Ræ—'÷&÷f–FW%÷7FFRÓÓÒw&Vv—7FW&VBrÇÀ¢–çfö–6Ræ—'÷&÷f–FW%÷7FFRÓÓÒv6æ6VÆÆF–öå÷Væ¶æ÷vâr“°¢6öç7Bv†—FV&öö·5Væ¶æ÷vâĞ¢–çfö–6Ræ—'÷&÷f–FW"ÓÓÒwv†—FV&öö·2rb`¢–çfö–6Ræ—'÷&÷f–FW%÷7FFRÓÓÒv6æ6VÆÆF–öå÷Væ¶æ÷vâs°¢–b†–çfö–6Ræ—&âÓÓÒçVÆÂÇÂ‚ÖçVÄ7F—fRbbv†—FV&öö·5Væ¶æ÷vâ’’°¢F‡&÷r‡GGW'&÷"€¢C’À¢t•%õ5DDUô4ôädÄ”5BrÀ¢tW‡FW&æÂ6æ6VÆÆF–öâWf–FVæ6R—266WFVBöæÇ’f÷"ÖçVÂ•%&V6÷&G2÷"âVç&W6öÇfVBv†—FV&öö·26æ6VÆÆF–öâârÀ¢“°¢Ğ¢6öç7B¶Æ—fTWv”&–ÆÅÒÒv—BGƒÇ²–C¢7G&–æs²Wv%öçVÖ&W#¢7G&–ærÂçVÆÂÕµÓæ ¢6VÆV7B–BÂWv%öçVÖ&W"g&öÒWv•ö&–ÆÇ0¢v†W&RF…ö–çfö–6Uö–BÒG¶–GÒæB7FGW2Ãâv6æ6VÆÆVBp¢Æ–Ö—B¢°¢–b†Æ—fTWv”&–ÆÂ’°¢F‡&÷r‡GGW'&÷"€¢C’À¢tUt•ô$”ÄÅôÄ•dRrÀ¢6æ6VÂR×v’&–ÆÂG¶Æ—fTWv”&–ÆÂæWv%öçVÖ&W"óòÆ—fTWv”&–ÆÂæ–GÒ&Vf÷&R&V6÷&F–ær•%6æ6VÆÆF–öâæÀ¢“°¢Ğ¢v—BG† ¢WFFRF…ö–çfö–6W0¢6WB—'÷&÷f–FW%÷7FFRÒv6æ6VÆÆVBrÀ¢—'ö6æ6VÆÆVEöBÒG¶&öG’æ6æ6VÆÆVDGÒÀ¢—'ö6æ6VÆÆVEöE÷FW‡BÒG¶&öG’æ6æ6VÆÆVDEFW‡BçG&–Ò‚—ÒÀ¢—'ö6æ6VÅ÷&V6öåö6öFRÒG¶&öG’ç&V6öä6öFWÒÀ¢—'ö6æ6VÅ÷&VÖ&²ÒG·&VÖ&·Ğ¢v†W&R–BÒG¶–GĞ¢°¢v—BVF—D–çfö–6R€¢G‚À¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢wF…ö–çfö–6Ræ—'ö6æ6VÆÆF–öå÷&V6÷&FVBrÀ¢–BÀ¢°¢—&ã¢–çfö–6Ræ—&âÀ¢6æ6VÆÆVDC¢&öG’æ6æ6VÆÆVDBÀ¢Wf–FVæ6S¢vÖçVÅ÷VçfW&–f–VBrÀ¢&V6öæ6–ÆVE&÷f–FW%Væ¶æ÷vã¢v†—FV&öö·5Væ¶æ÷vâÀ¢ÒÀ¢“°¢&WGW&â&VDFWF–Â‡G‚Â–B“°¢Ò“°¢ÒÀ¢“° ¢ævWB€¢rö’÷F‚Ö–çfö–6W2ó¦–Bö—'×–ÆöBrÀ¢²66†VÖ¢²&×3¢–E&×566†VÖÒÒÀ¢7–æ2‡&WVW7BÂ&WÇ’’Óâ°¢6öç7BW6W"Òv—B&WV—&UW6W"†WF‚Â&WVW7B“°¢6öç7B÷&væ—6F–öä–BÒ&WV—&T÷&væ—6F–öä†VFW"€¢&WVW7Bæ†VFW'5²w‚Ö÷&væ—6F–öâÖ–BuÒÀ¢“°¢6öç7B²–BÒÒ&WVW7Bç&×22²–C¢7G&–ærÓ°¢6öç7B–ÆöBÒv—Bv—F„&÷VæEFVæçB€¢FF&6RÀ¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢7–æ2‡G‚’Óâ°¢6öç7B¶–çfö–6UÒÒv—BGƒÀ¢°¢v÷&µö–C¢7G&–ærÂçVÆÃ°¢7FGW3¢F„–çfö–6U7FGW3°¢—77VVE÷6æ6†÷C¢Væ¶æ÷vã°¢ÕµĞ¢æ ¢6VÆV7Bv÷&µö–BÂ7FGW2Â—77VVE÷6æ6†÷@¢g&öÒF…ö–çfö–6W2v†W&R–BÒG¶–GĞ¢°¢–b‚–çfö–6R’°¢F‡&÷r‡GGW'&÷"ƒCBÂuD…ô”ådô”4UôäõEôdõTäBrÂtæò7V6‚F‚–çfö–6Râr“°¢Ğ¢v—B76W'D–çfö–6Uv÷&´66W72‡G‚ÂW6W"æ–BÂ–çfö–6Rçv÷&µö–B“°¢–b†–çfö–6Rç7FGW2ÓÒw7V&Ö—GFVBr’°¢F‡&÷r‡GGW'&÷"€¢C’À¢uD…ô”ådô”4Uõ5DEU5ô4ôädÄ”5BrÀ¢F†R•%–ÆöBW†—7G2f÷"7V&Ö—GFVB–çfö–6R†7W'&VçB7FGW3¢G¶–çfö–6Rç7FGW7Ò’(	BG&gB†2æòçVÖ&W"æB6æ6VÆÆVB–çfö–6R&Vv—7FW'2æ÷F†–æræÀ¢“°¢Ğ¢G'’°¢&WGW&â'V–ÆDg&÷¦Vä—'–ÆöB‡'6T§6öæ$6öÇVÖâ†–çfö–6Ræ—77VVE÷6æ6†÷B’“°¢Ò6F6‚†W'&÷"’°¢–b†W'&÷"–ç7Fæ6VöbT–çfö–6T#&5Vç7W÷'FVDW'&÷"’°¢F‡&÷r‡GGW'&÷"ƒC’ÂW'&÷"æ6öFRÂW'&÷"æÖW76vR“°¢Ğ¢–b†W'&÷"–ç7Fæ6VöbF„–çfö–6U6æ6†÷DW'&÷"’°¢F‡&÷r‡GGW'&÷"€¢C’À¢W'&÷"æ6öFRÀ¢uF†Rg&÷¦Vâ—77VVB–çfö–6R—2–æ6ö×ÆWFRf÷"•%7V&Ö—76–öã²—Bv2æ÷B&WÆ6VBv—F‚Æ—fRÖ7FW"FFârÀ¢“°¢Ğ¢F‡&÷rW'&÷#°¢Ğ¢ÒÀ¢“°¢fö–B&WÇ’çG—R‚vÆ–6F–öâö§6öã²6†'6WC×WFbÓ‚r“°¢&WGW&â&WÇ’ç6VæB‡7G&–æv–g•7FGWF÷'”§6öâ‡–ÆöB’“°¢ÒÀ¢“°§Ğ 