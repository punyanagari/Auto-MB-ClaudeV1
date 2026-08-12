import {
  ApiErrorSchema,
  CancelPurchaseOrderRequestSchema,
  CreatePurchaseOrderRequestSchema,
  PURCHASE_ORDER_STATUSES,
  PurchaseOrderDetailResponseSchema,
  PurchaseOrderListResponseSchema,
  SavePurchaseOrderLinesRequestSchema,
  type CancelPurchaseOrderRequest,
  type CreatePurchaseOrderRequest,
  type PurchaseOrder,
  type PurchaseOrderDetailResponse,
  type PurchaseOrderLine,
  type PurchaseOrderLineInput,
  type PurchaseOrderNotFullyReceivedDetails,
  type PurchaseOrderStatus,
  type SavePurchaseOrderLinesRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireAuthority, requireWriterRole } from '../authz.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { canonicalRateText } from '../rate-text.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { assertWorkOperable } from '../work-status.js';
import { cancellationNote } from './challans.js';

/**
 * Purchase orders (migration 0033; legacy spec Â§5.8): what the contractor
 * buys IN to supply a Work.
 *
 * Draft (one per Work, no number) -> issued (gapless
 * `<work_code>-PO-NN` under the per-Work counter row lock, vendor
 * snapshotted, total frozen) -> closed once every line has been fully
 * received, or cancelled with a note it keeps forever. The whole posture â€”
 * one transaction per request, the document row locked before any state
 * transition, issue and cancel behind their explicit authorities, every
 * transition audited â€” is the delivery challan's (routes/challans.ts),
 * because a purchase order is the same kind of object: a numbered document
 * that leaves the building.
 *
 * CLOSING IS DERIVED, NEVER ASSERTED. A line is fully received when the
 * quantities on ISSUED delivery challan items pointing at it reach the
 * quantity ordered; an order closes only when no line is still owed
 * anything, and the refusal names every line that still is. The
 * received/pending balance is recomputed from live challan rows on EVERY
 * read â€” never stored â€” so a receipt released later (its challan
 * cancelled) shows up as pending again even on an order already recorded
 * as closed. The status records a transition that was true when it was
 * made; the balance is always the truth of now.
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

/** `status=open` is the challan editor's filter: the orders a delivery
 * challan can still receive against â€” issued, and with at least one line
 * still owed material. An issued order whose lines are all received but
 * which nobody has closed yet is deliberately NOT open: there is nothing
 * left to receive on it. The four real statuses filter literally. */
const ListQuerySchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union([
        Type.Literal('open'),
        ...PURCHASE_ORDER_STATUSES.map((status) => Type.Literal(status)),
      ]),
    ),
  },
  { additionalProperties: false },
);

// --- Row shapes -------------------------------------------------------------

interface PurchaseOrderRow {
  id: string;
  work_id: string;
  vendor_contact_id: string;
  vendor_designation: string;
  status: PurchaseOrderStatus;
  po_number: string | null;
  sequence_number: number | null;
  po_date: string;
  expected_on: string | null;
  terms: string | null;
  total_amount: string | null;
  cancellation_note: string | null;
  created_at: Date;
  issued_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
}

/** `vendorDesignation` is the vendor as the DOCUMENT names it: the
 * issue-time snapshot once issued (rule 7 â€” retiring or renaming the
 * contact never rewrites history), the live contact master while the
 * order is still a draft and has snapshotted nothing. */
const PO_COLUMNS = `
  po.id, po.work_id, po.vendor_contact_id,
  coalesce(po.vendor_snapshot->>'designation', c.designation) as vendor_designation,
  po.status, po.po_number, po.sequence_number, po.po_date::text as po_date,
  po.expected_on::text as expected_on, po.terms,
  po.total_amount::text as total_amount, po.cancellation_note,
  po.created_at, po.issued_at, po.closed_at, po.cancelled_at
`;

const PO_FROM = `
  from purchase_orders po
  join contacts c on c.organisation_id = po.organisation_id
    and c.id = po.vendor_contact_id
`;

function toPurchaseOrder(row: PurchaseOrderRow): PurchaseOrder {
  return {
    id: row.id,
    workId: row.work_id,
    vendorContactId: row.vendor_contact_id,
    vendorDesignation: row.vendor_designation,
    status: row.status,
    poNumber: row.po_number,
    sequenceNumber: row.sequence_number,
    poDate: row.po_date,
    expectedOn: row.expected_on,
    terms: row.terms,
    totalAmount: row.total_amount,
    cancellationNote: row.cancellation_note,
    createdAt: row.created_at.toISOString(),
    issuedAt: row.issued_at?.toISOString() ?? null,
    closedAt: row.closed_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

interface LineRow {
  id: string;
  work_item_id: string | null;
  line_number: number;
  description: string;
  hsn_code: string | null;
  unit_code: string;
  quantity: string;
  rate: string;
  gst_rate: string | null;
  line_amount: string;
  received_quantity: string;
  pending_quantity: string;
}

/**
 * Every line with its receipt balance, computed in exact SQL numeric
 * arithmetic from the live delivery challan items that point at it.
 *
 * Only ISSUED challans count: a draft challan has delivered nothing, and
 * a cancelled one releases what it had claimed â€” exactly the rule the
 * Work balance already applies to awarded quantities. `pending` floors at
 * zero so an over-receipt reads as "nothing still owed" rather than as a
 * negative debt; the ordered and received quantities are both on the row,
 * so an over-receipt is still visible.
 */
async function readLines(tx: TransactionSql, purchaseOrderId: string) {
  return tx<LineRow[]>`
    select pol.id, pol.work_item_id, pol.line_number, pol.description,
           pol.hsn_code, pol.unit_code, pol.quantity::text as quantity,
           pol.rate::text as rate, pol.gst_rate::text as gst_rate,
           pol.line_amount::text as line_amount,
           coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0)
             ::numeric(18,3)::text as received_quantity,
           greatest(
             pol.quantity
               - coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0),
             0
           )::numeric(18,3)::text as pending_quantity
    from purchase_order_lines pol
    left join delivery_challan_items dci
      on dci.purchase_order_line_id = pol.id
    left join delivery_challans dc on dc.id = dci.delivery_challan_id
    where pol.purchase_order_id = ${purchaseOrderId}
    group by pol.id
    order by pol.line_number
  `;
}

function toLine(row: LineRow): PurchaseOrderLine {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    lineNumber: row.line_number,
    description: row.description,
    hsnCode: row.hsn_code,
    unitCode: row.unit_code,
    quantity: row.quantity,
    rate: canonicalRateText(row.rate),
    gstRate: row.gst_rate,
    lineAmount: row.line_amount,
    receivedQuantity: row.received_quantity,
    pendingQuantity: row.pending_quantity,
  };
}

async function readDetail(
  tx: TransactionSql,
  purchaseOrderId: string,
): Promise<PurchaseOrderDetailResponse> {
  const rows = (await tx.unsafe(
    `select ${PO_COLUMNS}, po.vendor_snapshot ${PO_FROM} where po.id = $1`,
    [purchaseOrderId],
  )) as unknown as (PurchaseOrderRow & { vendor_snapshot: unknown })[];
  const row = rows[0];
  if (!row) {
    throw httpError(404, 'PURCHASE_ORDER_NOT_FOUND', 'No such purchase order.');
  }
  const lines = await readLines(tx, purchaseOrderId);
  // Summed SERVER-side as exact decimals so a draft screen can show its
  // value without the client adding money in floating point (rule 5).
  const [total] = await tx<{ amount: string }[]>`
    select coalesce(sum(line_amount), 0)::numeric(18,2)::text as amount
    from purchase_order_lines where purchase_order_id = ${purchaseOrderId}
  `;
  return {
    purchaseOrder: toPurchaseOrder(row),
    lines: lines.map(toLine),
    vendorSnapshot: parseJsonbColumn(row.vendor_snapshot),
    previewTotal: total?.amount ?? '0.00',
  };
}

/** Locks the order row for the rest of the transaction and returns it.
 * Every state transition starts here so concurrent requests serialise
 * (`of po` â€” the joined contacts row is read, never written). */
async function lockPurchaseOrder(
  tx: TransactionSql,
  purchaseOrderId: string,
): Promise<PurchaseOrderRow> {
  const rows = (await tx.unsafe(
    `select ${PO_COLUMNS} ${PO_FROM} where po.id = $1 for update of po`,
    [purchaseOrderId],
  )) as unknown as PurchaseOrderRow[];
  const row = rows[0];
  if (!row) {
    throw httpError(404, 'PURCHASE_ORDER_NOT_FOUND', 'No such purchase order.');
  }
  return row;
}

function requireStatus(row: PurchaseOrderRow, status: PurchaseOrderStatus): void {
  if (row.status !== status) {
    throw httpError(
      409,
      'PO_STATUS_CONFLICT',
      `This operation requires a ${status} purchase order (current status: ${row.status}).`,
    );
  }
}

// --- Field guards -----------------------------------------------------------

/**
 * Text as the DATABASE judges it. Every text CHECK in 0033 measures the
 * value TRIMMED (`length(btrim(x)) BETWEEN n AND m`) while the contract
 * schemas count raw characters, so a description of "  a\n  " passes
 * validation, reaches Postgres, and comes back as a bare 500. The trimmed
 * text is also what gets stored, so what is on the order is what the
 * operator meant.
 */
function trimmedText(
  value: string,
  min: number,
  max: number,
  code: string,
  label: string,
): string {
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw httpError(
      400,
      code,
      `${label} must be between ${min} and ${max} characters that are not blank.`,
    );
  }
  return trimmed;
}

/** Product contract, and the 0033 `purchase_orders_date_guard` trigger in
 * friendly form: an order is never dated in the future and never before
 * the Work's LOA letter date â€” a contractor cannot buy against an award
 * that did not exist yet. "Today" is the organisation's own timezone, not
 * the server clock. */
async function assertPurchaseOrderDate(
  tx: TransactionSql,
  workId: string,
  poDate: string,
): Promise<void> {
  const [bounds] = await tx<{ letter_date: string; today: string }[]>`
    select w.letter_date::text as letter_date,
           (now() at time zone o.timezone)::date::text as today
    from works w
    join organisations o on o.id = w.organisation_id
    where w.id = ${workId}
  `;
  if (!bounds) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  // ISO dates compare correctly as strings.
  if (poDate > bounds.today) {
    throw httpError(
      400,
      'PO_DATE_INVALID',
      `The purchase order date cannot be in the future (today is ${bounds.today}).`,
    );
  }
  if (poDate < bounds.letter_date) {
    throw httpError(
      400,
      'PO_DATE_INVALID',
      `The purchase order date cannot precede the LOA letter date (${bounds.letter_date}).`,
    );
  }
}

interface VendorRow {
  id: string;
  designation: string;
  contact_person: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  pincode: string | null;
  state_code: string | null;
  is_vendor: boolean;
  active: boolean;
}

/**
 * The vendor must be a contact carrying `is_vendor` and still active â€”
 * checked when the draft names it AND again at issue, because the
 * contact can be retired in between and an order that leaves the building
 * today must not name a supplier the organisation has stopped using. A
 * contact of another tenant is invisible under RLS and answers exactly
 * like an unknown id.
 */
async function requireVendor(
  tx: TransactionSql,
  contactId: string,
): Promise<VendorRow> {
  const [row] = await tx<VendorRow[]>`
    select id, designation, contact_person, address, phone, email, gstin,
           pincode, state_code, is_vendor, active
    from contacts where id = ${contactId}
  `;
  if (!row) throw httpError(404, 'VENDOR_NOT_FOUND', 'No such contact.');
  if (!row.is_vendor) {
    throw httpError(
      409,
      'CONTACT_NOT_VENDOR',
      'A purchase order is placed on a vendor contact; this contact does not carry the vendor role.',
    );
  }
  if (!row.active) {
    throw httpError(
      409,
      'CONTACT_RETIRED',
      'This vendor is retired â€” reactivate it or pick another.',
    );
  }
  return row;
}

/** The vendor exactly as the issued order names it. Frozen into
 * `vendor_snapshot` at issue so later master edits never rewrite the
 * document (rule 7); `designation` is the field the read model reads
 * back. */
function vendorSnapshot(vendor: VendorRow): Record<string, unknown> {
  return {
    contactId: vendor.id,
    designation: vendor.designation,
    contactPerson: vendor.contact_person,
    address: vendor.address,
    phone: vendor.phone,
    email: vendor.email,
    gstin: vendor.gstin,
    pincode: vendor.pincode,
    stateCode: vendor.state_code,
  };
}

// --- Line writing -----------------------------------------------------------

function isNumericOverflow(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '22003';
}

/**
 * Replaces the draft's lines from the request; `line_number` follows
 * array order. The line amount is computed HERE, in exact SQL numeric
 * arithmetic from the quantity and rate â€” a client-supplied amount would
 * be a second, disagreeing authority (and, in JavaScript, a
 * floating-point one).
 *
 * A line that names a Work item is inserted FROM that item, which both
 * proves the item belongs to this Work and lets the item's tax facts
 * (HSN/SAC and GST rate, migration 0033) stand in when the request omits
 * them â€” the invoice slice reads those. A consumable the LOA never named
 * carries no item link and stands on its own description.
 */
async function writeLines(
  tx: TransactionSql,
  organisationId: string,
  purchaseOrdeãw¶‰Ëkºwµç`°½É‘•È¹İ½É­}¥°‰½‘ä¹Á½…Ñ”¤ì(€€€€€€€½¹ÍĞÙ•¹‘½È€ô…İ…¥ĞÉ•ÅÕ¥É•Y•¹‘½È¡Ñà°‰½‘ä¹Ù•¹‘½É½¹Ñ…Ñ%¤ì(€€€€€€€½¹ÍĞm•á¥ÍÑ¥¹É…™Ñt€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€Í•±•Ğ¥™É½´ÁÕÉ¡…Í•}½É‘•ÉÌ(€€€€€€€€€İ¡•É”İ½É­}¥€ô€‘í½É‘•È¹İ½É­}¥‘ô(€€€€€€€€€€€…¹Ù•¹‘½É}½¹Ñ…Ñ}¥€ô€‘í‰½‘ä¹Ù•¹‘½É½¹Ñ…Ñ%‘ô(€€€€€€€€€€€…¹ÍÑ…ÑÕÌ€ô€‘É…™Ğœ…¹¥€ğø€‘í¥‘ô(€€€€€€€€ì(€€€€€€€¥˜€¡•á¥ÍÑ¥¹É…™Ğ¤ì(€€€€€€€€€Ñ¡É½Ü‘É…™Ñ½¹™±¥ÑÉÉ½È (€€€€€€€€€€€€A=}IQ}a%MQLœ°(€€€€€€€€€€€€Q¡¥ÌÙ•¹‘½È…±É•…‘ä¡…Ì„‘É…™ĞÁÕÉ¡…Í”½É‘•È½¸Ñ¡¥Ì]½É¬ì¥ÍÍÕ”½È‘•±•Ñ”¥Ğ™¥ÉÍĞ¸œ°(€€€€€€€€€€€•á¥ÍÑ¥¹É…™Ğ¹¥°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€ÕÁ‘…Ñ”ÁÕÉ¡…Í•}½É‘•ÉÌ(€€€€€€€€€Í•ĞÙ•¹‘½É}½¹Ñ…Ñ}¥€ô€‘í‰½‘ä¹Ù•¹‘½É½¹Ñ…Ñ%‘ô°Á½}‘…Ñ”€ô€‘í‰½‘ä¹Á½…Ñ•ô°(€€€€€€€€€€€€€•áÁ•Ñ•‘}½¸€ô€‘í‰½‘ä¹•áÁ•Ñ•‘=¸€üü¹Õ±±ô°Ñ•ÉµÌ€ô€‘íÑ•ÉµÍô(€€€€€€€€€İ¡•É”¥€ô€‘í¥‘ô(€€€€€€€€¹…Ñ  ¡•ÉÉ½ÈèÕ¹­¹½İ¸¤€ôøì(€€€€€€€€€¥˜€¡•ÉÉ½È¥¹ÍÑ…¹•½˜ÉÉ½È€˜˜€½‘”œ¥¸•ÉÉ½È€˜˜•ÉÉ½È¹½‘”€ôôô€œÈÌÔÀÔœ¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ĞÀä°(€€€€€€€€€€€€€€A=}IQ}a%MQLœ°(€€€€€€€€€€€€€€Q¡¥ÌÙ•¹‘½È…±É•…‘ä¡…Ì„‘É…™ĞÁÕÉ¡…Í”½É‘•È½¸Ñ¡¥Ì]½É¬ì¥ÍÍÕ”½È‘•±•Ñ”¥Ğ™¥ÉÍĞ¸œ°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€ô¤ì(€€€€€€€½¹ÍĞ¡…¹•Ì€ô…Õ‘¥Ñ¥™˜ (€€€€€€€€€ì(€€€€€€€€€€€Ù•¹‘½É½¹Ñ…Ñ%è½É‘•È¹Ù•¹‘½É}½¹Ñ…Ñ}¥°(€€€€€€€€€€€Á½…Ñ”è½É‘•È¹Á½}‘…Ñ”°(€€€€€€€€€€€•áÁ•Ñ•‘=¸è½É‘•È¹•áÁ•Ñ•‘}½¸°(€€€€€€€€€€€Ñ•ÉµÌè½É‘•È¹Ñ•ÉµÌ°(€€€€€€€€€ô°(€€€€€€€€€ì(€€€€€€€€€€€Ù•¹‘½É½¹Ñ…Ñ%è‰½‘ä¹Ù•¹‘½É½¹Ñ…Ñ%°(€€€€€€€€€€€Á½…Ñ”è‰½‘ä¹Á½…Ñ”°(€€€€€€€€€€€•áÁ•Ñ•‘=¸è‰½‘ä¹•áÁ•Ñ•‘=¸€üü¹Õ±°°(€€€€€€€€€€€Ñ•ÉµÌ°(€€€€€€€€€ô°(€€€€€€€€¤ì(€€€€€€€…İ…¥Ğ…Õ‘¥ÑAÕÉ¡…Í•=É‘•È (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€ÁÕÉ¡…Í•}½É‘•È¹ÕÁ‘…Ñ•œ°(€€€€€€€€€¥°(€€€€€€€€€ì‰•™½É”è¡…¹•Ì¹‰•™½É”°…™Ñ•Èè¡…¹•Ì¹…™Ñ•È°Ù•¹‘½ÈèÙ•¹‘½È¹‘•Í¥¹…Ñ¥½¸ô°(€€€€€€€€¤ì(€€€€€€€É•ÑÕÉ¸É•…‘•Ñ…¥°¡Ñà°¥¤ì(€€€€€ô¤¹…Ñ ¡…Íå¹Œ€¡•ÉÉ½ÈèÕ¹­¹½İ¸¤€ôøì(€€€€€€€Ñ¡É½Ü…İ…¥Ğ¹…µ•É…™Ñ½¹™±¥Ğ¡•ÉÉ½È°€A=}IQ}a%MQLœ°€ ¤€ôø(€€€€€€€€€İ¥Ñ¡	½Õ¹‘Q•¹…¹Ğ¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€€€½¹ÍĞmÉ½İt€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€€€€€Í•±•Ğ¥™É½´ÁÕÉ¡…Í•}½É‘•ÉÌ(€€€€€€€€€€€€€İ¡•É”İ½É­}¥€ô€ (€€€€€€€€€€€€€€€Í•±•Ğİ½É­}¥™É½´ÁÕÉ¡…Í•}½É‘•ÉÌİ¡•É”¥€ô€‘í¥‘ô(€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€…¹Ù•¹‘½É}½¹Ñ…Ñ}¥€ô€‘í‰½‘ä¹Ù•¹‘½É½¹Ñ…Ñ%‘ô(€€€€€€€€€€€€€€€…¹ÍÑ…ÑÕÌ€ô€‘É…™Ğœ…¹¥€ğø€‘í¥‘ô(€€€€€€€€€€€€ì(€€€€€€€€€€€É•ÑÕÉ¸É½Üü¹¥€üü¹Õ±°ì(€€€€€€€€€ô¤°(€€€€€€€€¤ì(€€€€€ô¤ì(€€€ô°(€€¤ì((€…ÁÀ¹ÁÕĞ (€€€€œ½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼é¥½±¥¹•Ìœ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€‰½‘äèM…Ù•AÕÉ¡…Í•=É‘•É1¥¹•ÍI•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀèAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍĞ¤€ôøì(€€€€€½¹ÍĞÕÍ•È€ô…İ…¥ĞÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍĞ¤ì(€€€€€½¹ÍĞ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍĞ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍĞì¥ô€ôÉ•ÅÕ•ÍĞ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍĞ‰½‘ä€ôÉ•ÅÕ•ÍĞ¹‰½‘ä…ÌM…Ù•AÕÉ¡…Í•=É‘•É1¥¹•ÍI•ÅÕ•ÍĞì(€€€€€É•ÑÕÉ¸İ¥Ñ¡	½Õ¹‘Q•¹…¹Ğ¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€…İ…¥ĞÉ•ÅÕ¥É•]É¥Ñ•ÉI½±”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€½¹ÍĞ½É‘•È€ô…İ…¥Ğ±½­AÕÉ¡…Í•=É‘•È¡Ñà°¥¤ì(€€€€€€€…İ…¥Ğ…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°½É‘•È¹İ½É­}¥¤ì(€€€€€€€É•ÅÕ¥É•MÑ…ÑÕÌ¡½É‘•È°€‘É…™Ğœ¤ì(€€€€€€€½¹ÍĞ±¥¹•Í	•™½É”€ô…İ…¥ĞÉ•…‘1¥¹•%¹ÁÕÑÌ¡Ñà°¥¤ì(€€€€€€€…İ…¥ĞİÉ¥Ñ•1¥¹•Ì¡Ñà°½É…¹¥Í…Ñ¥½¹%°¥°½É‘•È¹İ½É­}¥°‰½‘ä¹±¥¹•Ì¤ì(€€€€€€€½¹ÍĞ¡…¹•Ì€ô…Õ‘¥Ñ¥™˜ (€€€€€€€€€ì±¥¹•Ìè±¥¹•Í	•™½É”ô°(€€€€€€€€€ì±¥¹•Ìè…İ…¥ĞÉ•…‘1¥¹•%¹ÁÕÑÌ¡Ñà°¥¤ô°(€€€€€€€€¤ì(€€€€€€€…İ…¥Ğ…Õ‘¥ÑAÕÉ¡…Í•=É‘•È (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€ÁÕÉ¡…Í•}½É‘•È¹±¥¹•Í}Í…Ù•œ°(€€€€€€€€€¥°(€€€€€€€€€ì(€€€€€€€€€€€‰•™½É”è¡…¹•Ì¹‰•™½É”°(€€€€€€€€€€€…™Ñ•Èè¡…¹•Ì¹…™Ñ•È°(€€€€€€€€€€€±¥¹•½Õ¹Ğè‰½‘ä¹±¥¹•Ì¹±•¹Ñ °(€€€€€€€€€ô°(€€€€€€€€¤ì(€€€€€€€É•ÑÕÉ¸É•…‘•Ñ…¥°¡Ñà°¥¤ì(€€€€€ô¤ì(€€€ô°(€€¤ì((€…ÁÀ¹‘•±•Ñ” (€€€€œ½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼é¥œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀĞèQåÁ”¹9Õ±° ¤°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€€€½¹ÍĞÕÍ•È€ô…İ…¥ĞÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍĞ¤ì(€€€€€½¹ÍĞ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍĞ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍĞì¥ô€ôÉ•ÅÕ•ÍĞ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€…İ…¥Ğİ¥Ñ¡	½Õ¹‘Q•¹…¹Ğ¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€…İ…¥ĞÉ•ÅÕ¥É•]É¥Ñ•ÉI½±”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€½¹ÍĞ½É‘•È€ô…İ…¥Ğ±½­AÕÉ¡…Í•=É‘•È¡Ñà°¥¤ì(€€€€€€€…İ…¥Ğ…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°½É‘•È¹İ½É­}¥¤ì(€€€€€€€€¼¼IÕ±”€àè„‘É…™Ğ¥Ì¹½Ğå•Ğ„‘½Õµ•¹Ğ°Í¼¥Ğ¥Ì‘•±•Ñ•É…Ñ¡•È(€€€€€€€€¼¼Ñ¡…¸…¹•±±•¸¹åÑ¡¥¹œ¥ÍÍÕ•­••ÁÌ¥ÑÌ¹Õµ‰•È™½É•Ù•È¸(€€€€€€€É•ÅÕ¥É•MÑ…ÑÕÌ¡½É‘•È°€‘É…™Ğœ¤ì(€€€€€€€€¼¼Q¡”±¥¹•Ì¼%IMP…¹•áÁ±¥¥Ñ±äèÑ¡”€ÀÀÌÌ±¥¹”Õ…ÉÉ•…‘ÌÑ¡”(€€€€€€€€¼¼Á…É•¹ĞÌÍÑ…ÑÕÌ°…¹„…Í…‘”™É½´Ñ¡”‘•±•Ñ•Á…É•¹Ğİ½Õ±(€€€€€€€€¼¼™¥¹¹¼Á…É•¹ĞÉ½Ü…¹É…¥Í”¸(€€€€€€€…İ…¥ĞÑá‘•±•Ñ”™É½´ÁÕÉ¡…Í•}½É‘•É}±¥¹•Ìİ¡•É”ÁÕÉ¡…Í•}½É‘•É}¥€ô€‘í¥‘õ€ì(€€€€€€€…İ…¥ĞÑá‘•±•Ñ”™É½´ÁÕÉ¡…Í•}½É‘•ÉÌİ¡•É”¥€ô€‘í¥‘õ€ì(€€€€€€€…İ…¥Ğ…Õ‘¥ÑAÕÉ¡…Í•=É‘•È (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€ÁÕÉ¡…Í•}½É‘•È¹‘•±•Ñ•œ°(€€€€€€€€€¥°(€€€€€€€€€ìİ½É­%è½É‘•È¹İ½É­}¥ô°(€€€€€€€€¤ì(€€€€€ô¤ì(€€€€€É•ÑÕÉ¸É•Á±ä¹ÍÑ…ÑÕÌ ÈÀĞ¤¹Í•¹ ¤ì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍĞ (€€€€œ½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼é¥½¥ÍÍÕ”œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÄèAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍĞ°É•Á±ä¤€ôøì(€€€€€½¹ÍĞÕÍ•È€ô…İ…¥ĞÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍĞ¤ì(€€€€€½¹ÍĞ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍĞ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍĞì¥ô€ôÉ•ÅÕ•ÍĞ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍĞ‘•Ñ…¥°€ô…İ…¥Ğİ¥Ñ¡	½Õ¹‘Q•¹…¹Ğ (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…İ…¥ĞÉ•ÅÕ¥É•ÕÑ¡½É¥Ñä¡Ñà°ÕÍ•È¹¥°€¥ÍÍÕ”œ¤ì(€€€€€€€€€½¹ÍĞ½É‘•È€ô…İ…¥Ğ±½­AÕÉ¡…Í•=É‘•È¡Ñà°¥¤ì(€€€€€€€€€…İ…¥Ğ…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°½É‘•È¹İ½É­}¥¤ì(€€€€€€€€€É•ÅÕ¥É•MÑ…ÑÕÌ¡½É‘•È°€‘É…™Ğœ¤ì((€€€€€€€€€€¼¼1½¬½É‘•Èİ½É­Ì€´ø½Õ¹Ñ•Èµ…Ñ¡•Ì•Ù•Éä½Ñ¡•È¹Õµ‰•É¥¹œ(€€€€€€€€€€¼¼İÉ¥Ñ•È°Í¼…¸¥ÍÍÕ”…¹„]½É¬½µÁ±•Ñ¥½¸Í•É¥…±¥Í”¥¹ÍÑ•…½˜(€€€€€€€€€€¼¼‘•…‘±½­¥¹œ¸(€€€€€€€€€½¹ÍĞmİ½É­t€ô…İ…¥ĞÑàñìİ½É­}½‘”èÍÑÉ¥¹œìÍÑ…ÑÕÌèÍÑÉ¥¹œõmtù€(€€€€€€€€€€€Í•±•Ğİ½É­}½‘”°ÍÑ…ÑÕÌ™É½´İ½É­Ì(€€€€€€€€€€€İ¡•É”¥€ô€‘í½É‘•È¹İ½É­}¥‘ô…¹‘•±•Ñ•‘}…Ğ¥Ì¹Õ±°(€€€€€€€€€€€™½ÈÕÁ‘…Ñ”(€€€€€€€€€€ì(€€€€€€€€€¥˜€ …İ½É¬¤Ñ¡É½Ü¡ÑÑÁÉÉ½È ĞÀĞ°€]=I-}9=Q}=U9œ°€9¼ÍÕ ]½É¬¸œ¤ì(€€€€€€€€€€¼¼Hàè„½µÁ±•Ñ•]½É¬…•ÁÑÌ¹¼¹•ÜÁÉ½ÕÉ•µ•¹Ğ¸(€€€€€€€€€…ÍÍ•ÉÑ]½É­=Á•É…‰±”¡İ½É¬¹ÍÑ…ÑÕÌ°€¥ÍÍÕ¥¹œ„ÁÕÉ¡…Í”½É‘•Èœ¤ì((€€€€€€€€€½¹ÍĞm±¥¹•½Õ¹Ñt€ô…İ…¥ĞÑàñìÑ½Ñ…°èÍÑÉ¥¹œõmtù€(€€€€€€€€€€€Í•±•Ğ½Õ¹Ğ ¨¤èéÑ•áĞ…ÌÑ½Ñ…°™É½´ÁÕÉ¡…Í•}½É‘•É}±¥¹•Ì(€€€€€€€€€€€İ¡•É”ÁÕÉ¡…Í•}½É‘•É}¥€ô€‘í¥‘ô(€€€€€€€€€€ì(€€€€€€€€€¥˜€¡±¥¹•½Õ¹Ğü¹Ñ½Ñ…°€ôôô€œÀœ¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ĞÀä°(€€€€€€€€€€€€€€A=}5AQdœ°(€€€€€€€€€€€€€€ÁÕÉ¡…Í”½É‘•È¹••‘Ì…Ğ±•…ÍĞ½¹”±¥¹”‰•™½É”¥Ğ…¸‰”¥ÍÍÕ•¸œ°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô((€€€€€€€€€€¼¼I”µ¡•­•Õ¹‘•ÈÑ¡”±½¬èÑ¡”Ù•¹‘½Èµ…ä¡…Ù”‰••¸É•Ñ¥É•(€€€€€€€€€€¼¼Í¥¹”Ñ¡”‘É…™Ğ¹…µ•¥Ğ°…¹…¸½É‘•È¥ÍÍÕ•Ñ½‘…äµÕÍĞ¹½Ğ(€€€€€€€€€€¼¼¼Ñ¼„ÍÕÁÁ±¥•ÈÑ¡”½É…¹¥Í…Ñ¥½¸¡…ÌÍÑ½ÁÁ•ÕÍ¥¹œ¸(€€€€€€€€€½¹ÍĞÙ•¹‘½È€ô…İ…¥ĞÉ•ÅÕ¥É•Y•¹‘½È¡Ñà°½É‘•È¹Ù•¹‘½É}½¹Ñ…Ñ}¥¤ì((€€€€€€€€€½¹ÍĞmÑ½Ñ…±t€ô…İ…¥ĞÑàñì…µ½Õ¹ĞèÍÑÉ¥¹œõmtù€(€€€€€€€€€€€Í•±•Ğ½…±•Í”¡ÍÕ´¡±¥¹•}…µ½Õ¹Ğ¤°€À¤èé¹Õµ•É¥Œ Äà°È¤èéÑ•áĞ…Ì…µ½Õ¹Ğ(€€€€€€€€€€€™É½´ÁÕÉ¡…Í•}½É‘•É}±¥¹•Ìİ¡•É”ÁÕÉ¡…Í•}½É‘•É}¥€ô€‘í¥‘ô(€€€€€€€€€€ì((€€€€€€€€€€¼¼M•É¥…±¥Í•Á•Èµ]½É¬¹Õµ‰•É¥¹œèÑ¡”½Õ¹Ñ•ÈÉ½Ü±½¬½É‘•ÉÌ(€€€€€€€€€€¼¼½¹ÕÉÉ•¹Ğ¥ÍÍÕ•Ì°…¹„É½±±•µ‰…¬ÑÉ…¹Í…Ñ¥½¸É½±±ÌÑ¡”(€€€€€€€€€€¼¼½Õ¹Ñ•È‰…¬İ¥Ñ ¥Ğ°Í¼¹Õµ‰•ÉÌ…É”…Á±•ÍÌÁ•È]½É¬¸(€€€€€€€€€½¹ÍĞm½Õ¹Ñ•Ét€ô…İ…¥ĞÑàñì¹•áÑ}Ù…±Õ”è¹Õµ‰•Èõmtù€(€€€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼ÁÕÉ¡…Í•}½É‘•É}½Õ¹Ñ•ÉÌ€¡½É…¹¥Í…Ñ¥½¹}¥°İ½É­}¥¤(€€€€€€€€€€€Ù…±Õ•Ì€ ‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘í½É‘•È¹İ½É­}¥‘ô¤(€€€€€€€€€€€½¸½¹™±¥Ğ€¡½É…¹¥Í…Ñ¥½¹}¥°İ½É­}¥¤(€€€€€€€€€€€‘¼ÕÁ‘…Ñ”Í•Ğ¹•áÑ}Ù…±Õ”€ôÁÕÉ¡…Í•}½É‘•É}½Õ¹Ñ•ÉÌ¹¹•áÑ}Ù…±Õ”€¬€Ä(€€€€€€€€€€€É•ÑÕÉ¹¥¹œ¹•áÑ}Ù…±Õ”(€€€€€€€€€€ì(€€€€€€€€€¥˜€ …½Õ¹Ñ•È¤Ñ¡É½Ü¹•ÜÉÉ½È ½Õ¹Ñ•ÈÕÁÍ•ÉĞÉ•ÑÕÉ¹•¹¼É½Üœ¤ì(€€€€€€€€€½¹ÍĞÍ•ÅÕ•¹”€ô½Õ¹Ñ•È¹¹•áÑ}Ù…±Õ”ì(€€€€€€€€€½¹ÍĞÁ½9Õµ‰•È€ô€‘íİ½É¬¹İ½É­}½‘•ôµA<´‘íMÑÉ¥¹œ¡Í•ÅÕ•¹”¤¹Á…‘MÑ…ÉĞ È°€œÀœ¥õ€ì((€€€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€€€ÕÁ‘…Ñ”ÁÕÉ¡…Í•}½É‘•ÉÌ(€€€€€€€€€€€Í•ĞÍÑ…ÑÕÌ€ô€¥ÍÍÕ•œ°Á½}¹Õµ‰•È€ô€‘íÁ½9Õµ‰•Éô°(€€€€€€€€€€€€€€€Í•ÅÕ•¹•}¹Õµ‰•È€ô€‘íÍ•ÅÕ•¹•ô°(€€€€€€€€€€€€€€€Ù•¹‘½É}Í¹…ÁÍ¡½Ğ€ô€‘í©Í½¹ˆ¡Ñà°Ù•¹‘½ÉM¹…ÁÍ¡½Ğ¡Ù•¹‘½È¤¥ô°(€€€€€€€€€€€€€€€Ñ½Ñ…±}…µ½Õ¹Ğ€ô€‘íÑ½Ñ…°ü¹…µ½Õ¹Ğ€üü€œÀ¸ÀÀô°(€€€€€€€€€€€€€€€¥ÍÍÕ•‘}‰å}ÕÍ•É}¥€ô€‘íÕÍ•È¹¥‘ô°¥ÍÍÕ•‘}…Ğ€ô¹½Ü ¤(€€€€€€€€€€€İ¡•É”¥€ô€‘í¥‘ô(€€€€€€€€€€¹…Ñ  ¡•ÉÉ½ÈèÕ¹­¹½İ¸¤€ôøì(€€€€€€€€€€€¥˜€¡•ÉÉ½È¥¹ÍÑ…¹•½˜ÉÉ½È€˜˜€½‘”œ¥¸•ÉÉ½È€˜˜•ÉÉ½È¹½‘”€ôôô€œÈÌÔÀÔœ¤ì(€€€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€€€ĞÀä°(€€€€€€€€€€€€€€€€A=}9U5	I}=91%Pœ°(€€€€€€€€€€€€€€€AÕÉ¡…Í”½É‘•È¹Õµ‰•È€‘íÁ½9Õµ‰•Éô…±É•…‘ä•á¥ÍÑÌ¥¸Ñ¡¥Ì½É…¹¥Í…Ñ¥½¸¹€°(€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€ô(€€€€€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€€€ô¤ì((€€€€€€€€€…İ…¥Ğ…Õ‘¥ÑAÕÉ¡…Í•=É‘•È (€€€€€€€€€€€Ñà°(€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€€€ÁÕÉ¡…Í•}½É‘•È¹¥ÍÍÕ•œ°(€€€€€€€€€€€¥°(€€€€€€€€€€€ì(€€€€€€€€€€€€€Á½9Õµ‰•È°(€€€€€€€€€€€€€Í•ÅÕ•¹”°(€€€€€€€€€€€€€Ñ½Ñ…±µ½Õ¹ĞèÑ½Ñ…°ü¹…µ½Õ¹Ğ€üü€œÀ¸ÀÀœ°(€€€€€€€€€€€€€Ù•¹‘½É½¹Ñ…Ñ%èÙ•¹‘½È¹¥°(€€€€€€€€€€€ô°(€€€€€€€€€€¤ì(€€€€€€€€€É•ÑÕÉ¸É•…‘•Ñ…¥°¡Ñà°¥¤ì(€€€€€€€ô°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸É•Á±ä¹ÍÑ…ÑÕÌ ÈÀÄ¤¹Í•¹¡‘•Ñ…¥°¤ì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍĞ (€€€€œ½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼é¥½…¹•°œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€‰½‘äè…¹•±AÕÉ¡…Í•=É‘•ÉI•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀèAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍĞ¤€ôøì(€€€€€½¹ÍĞÕÍ•È€ô…İ…¥ĞÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍĞ¤ì(€€€€€½¹ÍĞ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍĞ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍĞì¥ô€ôÉ•ÅÕ•ÍĞ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍĞ‰½‘ä€ôÉ•ÅÕ•ÍĞ¹‰½‘ä…Ì…¹•±AÕÉ¡…Í•=É‘•ÉI•ÅÕ•ÍĞì(€€€€€½¹ÍĞ¹½Ñ”€ô…¹•±±…Ñ¥½¹9½Ñ”¡‰½‘ä¹¹½Ñ”¤ì(€€€€€É•ÑÕÉ¸İ¥Ñ¡	½Õ¹‘Q•¹…¹Ğ¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€…İ…¥ĞÉ•ÅÕ¥É•ÕÑ¡½É¥Ñä¡Ñà°ÕÍ•È¹¥°€…¹•°œ¤ì(€€€€€€€½¹ÍĞ½É‘•È€ô…İ…¥Ğ±½­AÕÉ¡…Í•=É‘•È¡Ñà°¥¤ì(€€€€€€€…İ…¥Ğ…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°½É‘•È¹İ½É­}¥¤ì(€€€€€€€€¼¼=¹±ä…¸¥ÍÍÕ•½É‘•È…¹•±Ìè„‘É…™Ğ¥Ì‘•±•Ñ•€¡ÉÕ±”€à¤°…¹„(€€€€€€€€¼¼±½Í•½¹”¥Ì™¥¹¥Í¡•¸I••¥ÁÑÌ…±É•…‘äÉ•½É‘•……¥¹ÍĞÑ¡”(€€€€€€€€¼¼½É‘•ÈÌ±¥¹•Ì…É”9=P‘¥ÍÑÕÉ‰•ƒŠPÑ¡”‘•±¥Ù•É•µ…Ñ•É¥…°¥ÌÑ¡”(€€€€€€€€¼¼¡…±±…¸Ì™…Ğ°¹½ĞÑ¡”½É‘•ÈÌ°…¹Ñ¡”]½É¬ÌÅÕ…¹Ñ¥Ñä±•‘•È(€€€€€€€€¼¼¹•Ù•ÈÉ•…Ñ¡¥Ì½É‘•È¸…¹•±±¥¹œÍ…åÌ½¹±äÑ¡…ĞÑ¡”É•ÍĞ½˜¥Ğ(€€€€€€€€¼¼¥Ì¹•Ù•È½µ¥¹œ¸(€€€€€€€É•ÅÕ¥É•MÑ…ÑÕÌ¡½É‘•È°€¥ÍÍÕ•œ¤ì(€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€ÕÁ‘…Ñ”ÁÕÉ¡…Í•}½É‘•ÉÌ(€€€€€€€€€Í•ĞÍÑ…ÑÕÌ€ô€…¹•±±•œ°…¹•±±•‘}‰å}ÕÍ•É}¥€ô€‘íÕÍ•È¹¥‘ô°(€€€€€€€€€€€€€…¹•±±•‘}…Ğ€ô¹½Ü ¤°…¹•±±…Ñ¥½¹}¹½Ñ”€ô€‘í¹½Ñ•ô(€€€€€€€€€İ¡•É”¥€ô€‘í¥‘ô(€€€€€€€€ì(€€€€€€€…İ…¥Ğ…Õ‘¥ÑAÕÉ¡…Í•=É‘•È (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€ÁÕÉ¡…Í•}½É‘•È¹…¹•±±•œ°(€€€€€€€€€¥°(€€€€€€€€€ìÁ½9Õµ‰•Èè½É‘•È¹Á½}¹Õµ‰•È°¹½Ñ”ô°(€€€€€€€€¤ì(€€€€€€€É•ÑÕÉ¸É•…‘•Ñ…¥°¡Ñà°¥¤ì(€€€€€ô¤ì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍĞ (€€€€œ½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼é¥½±½Í”œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀèAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍĞ¤€ôøì(€€€€€½¹ÍĞÕÍ•È€ô…İ…¥ĞÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍĞ¤ì(€€€€€½¹ÍĞ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍĞ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍĞì¥ô€ôÉ•ÅÕ•ÍĞ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€É•ÑÕÉ¸İ¥Ñ¡	½Õ¹‘Q•¹…¹Ğ¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€¼¼±½Í¥¹œ…ÍÍ•ÉÑÌ¹½Ñ¡¥¹œ…¸½Á•É…Ñ½È½Õ±¥¹Ù•¹Ğè¥ĞÍÕ••‘Ì(€€€€€€€€¼¼½¹±äİ¡•¸Ñ¡”É••¥ÁÑÌ…±É•…‘äÍ…äÑ¡”½É‘•È¥Ì½µÁ±•Ñ”°Í¼¥Ğ(€€€€€€€€¼¼¥Ì„İÉ¥Ñ•È…Ñ¥½¸É…Ñ¡•ÈÑ¡…¸…¸¥ÍÍÕ”½…¹•°…ÕÑ¡½É¥Ñä¸(€€€€€€€…İ…¥ĞÉ•ÅÕ¥É•]É¥Ñ•ÉI½±”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€½¹ÍĞ½É‘•È€ô…İ…¥Ğ±½­AÕÉ¡…Í•=É‘•È¡Ñà°¥¤ì(€€€€€€€…İ…¥Ğ…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°½É‘•È¹İ½É­}¥¤ì(€€€€€€€É•ÅÕ¥É•MÑ…ÑÕÌ¡½É‘•È°€¥ÍÍÕ•œ¤ì((€€€€€€€€¼¼I½Üµ±½¬•Ù•Éä¡…±±…¸Ñ¡…Ğ¡…Ì™•Ñ¡¥Ì½É‘•È°Í¼„É••¥ÁĞ(€€€€€€€€¼¼…¹¹½Ğ‰”É•±•…Í•€¡¥ÑÌ¡…±±…¸…¹•±±•¤¡…±™İ…äÑ¡É½Õ Ñ¡”(€€€€€€€€¼¼‰…±…¹”‰•±½Ü¸1½¬½É‘•È¥ÌÁÕÉ¡…Í•}½É‘•ÉÌ€´ø‘•±¥Ù•Éå}¡…±±…¹Ì(€€€€€€€€¼¼…¹Ñ¡”¡…±±…¸…¹•°Á…Ñ Ñ…­•Ì‘•±¥Ù•Éå}¡…±±…¹Ì€´øİ½É­Ì°Í¼(€€€€€€€€¼¼Ñ¡”Ñİ¼…¹¹½Ğå±”¸]¡…Ğ¹¼±½¬…¸ÁÉ•Ù•¹Ğ¥Ì„¡…±±…¸(€€€€€€€€¼¼…¹•±±•QHÑ¡¥Ì½µµ¥ÑÌìÑ¡”‰…±…¹”¥ÌÑ¡•É•™½É”(€€€€€€€€¼¼É•½µÁÕÑ•±¥Ù”½¸•Ù•ÉäÉ•…°…¹„±½Í•½É‘•Èİ¡½Í”É••¥ÁĞ(€€€€€€€€¼¼İ…Ì±…Ñ•ÈÉ•±•…Í•Í¡½İÌ¥ÑÌ±¥¹•ÌÁ•¹‘¥¹œ……¥¸¸(€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€Í•±•Ğ‘Œ¹¥™É½´‘•±¥Ù•Éå}¡…±±…¹Ì‘Œ(€€€€€€€€€İ¡•É”‘Œ¹¥¥¸€ (€€€€€€€€€€€Í•±•Ğ‘¤¹‘•±¥Ù•Éå}¡…±±…¹}¥(€€€€€€€€€€€™É½´‘•±¥Ù•Éå}¡…±±…¹}¥Ñ•µÌ‘¤(€€€€€€€€€€€©½¥¸ÁÕÉ¡…Í•}½É‘•É}±¥¹•ÌÁ½°½¸Á½°¹¥€ô‘¤¹ÁÕÉ¡…Í•}½É‘•É}±¥¹•}¥(€€€€€€€€€€€İ¡•É”Á½°¹ÁÕÉ¡…Í•}½É‘•É}¥€ô€‘í¥‘ô(€€€€€€€€€€¤(€€€€€€€€€½É‘•È‰ä‘Œ¹¥(€€€€€€€€€™½ÈÕÁ‘…Ñ”(€€€€€€€€ì((€€€€€€€½¹ÍĞ±¥¹•Ì€ô…İ…¥ĞÉ•…‘1¥¹•Ì¡Ñà°¥¤ì(€€€€€€€½¹ÍĞ½ÕÑÍÑ…¹‘¥¹œ€ô±¥¹•Ì¹™¥±Ñ•È ¡±¥¹”¤€ôø±¥¹”¹Á•¹‘¥¹}ÅÕ…¹Ñ¥Ñä€„ôô€œÀ¸ÀÀÀœ¤ì(€€€€€€€¥˜€¡½ÕÑÍÑ…¹‘¥¹œ¹±•¹Ñ €ø€À¤ì(€€€€€€€€€½¹ÍĞ‘•Ñ…¥±ÌèAÕÉ¡…Í•=É‘•É9½ÑÕ±±åI••¥Ù•‘•Ñ…¥±Ì€ôì(€€€€€€€€€€€½ÕÑÍÑ…¹‘¥¹1¥¹•Ìè½ÕÑÍÑ…¹‘¥¹œ¹µ…À ¡±¥¹”¤€ôø€¡ì(€€€€€€€€€€€€€ÁÕÉ¡…Í•=É‘•É1¥¹•%è±¥¹”¹¥°(€€€€€€€€€€€€€±¥¹•9Õµ‰•Èè±¥¹”¹±¥¹•}¹Õµ‰•È°(€€€€€€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸è±¥¹”¹‘•ÍÉ¥ÁÑ¥½¸°(€€€€€€€€€€€€€½É‘•É•‘EÕ…¹Ñ¥Ñäè±¥¹”¹ÅÕ…¹Ñ¥Ñä°(€€€€€€€€€€€€€É••¥Ù•‘EÕ…¹Ñ¥Ñäè±¥¹”¹É••¥Ù•‘}ÅÕ…¹Ñ¥Ñä°(€€€€€€€€€€€€€Á•¹‘¥¹EÕ…¹Ñ¥Ñäè±¥¹”¹Á•¹‘¥¹}ÅÕ…¹Ñ¥Ñä°(€€€€€€€€€€€ô¤¤°(€€€€€€€€€ôì(€€€€€€€€€½¹ÍĞ¹…µ•Ì€ô½ÕÑÍÑ…¹‘¥¹œ(€€€€€€€€€€€€¹µ…À (€€€€€€€€€€€€€€¡±¥¹”¤€ôø(€€€€€€€€€€€€€€€±¥¹”€‘íMÑÉ¥¹œ¡±¥¹”¹±¥¹•}¹Õµ‰•È¥ô€ ‘í±¥¹”¹É••¥Ù•‘}ÅÕ…¹Ñ¥Ñåô½˜€‘í±¥¹”¹ÅÕ…¹Ñ¥Ñåô€‘í±¥¹”¹Õ¹¥Ñ}½‘•ôÉ••¥Ù•¥€°(€€€€€€€€€€€€¤(€€€€€€€€€€€€¹©½¥¸ œì€œ¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ĞÀä°(€€€€€€€€€€€€A=}9=Q}U11e}I%Yœ°(€€€€€€€€€€€ÁÕÉ¡…Í”½É‘•È±½Í•Ì½¹±äİ¡•¸•Ù•Éä±¥¹”¡…Ì‰••¸É••¥Ù•……¥¹ÍĞ…¸¥ÍÍÕ•‘•±¥Ù•Éä¡…±±…¸ƒŠPÍÑ¥±°½Á•¸è€‘í¹…µ•Íô¹€°(€€€€€€€€€€€‘•Ñ…¥±Ì°(€€€€€€€€€€¤ì(€€€€€€€ô((€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€ÕÁ‘…Ñ”ÁÕÉ¡…Í•}½É‘•ÉÌ(€€€€€€€€€Í•ĞÍÑ…ÑÕÌ€ô€±½Í•œ°±½Í•‘}…Ğ€ô¹½Ü ¤(€€€€€€€€€İ¡•É”¥€ô€‘í¥‘ô(€€€€€€€€ì(€€€€€€€…İ…¥Ğ…Õ‘¥ÑAÕÉ¡…Í•=É‘•È (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€ÁÕÉ¡…Í•}½É‘•È¹±½Í•œ°(€€€€€€€€€¥°(€€€€€€€€€ìÁ½9Õµ‰•Èè½É‘•È¹Á½}¹Õµ‰•È°±¥¹•½Õ¹Ğè±¥¹•Ì¹±•¹Ñ ô°(€€€€€€€€¤ì(€€€€€€€É•ÑÕÉ¸É•…‘•Ñ…¥°¡Ñà°¥¤ì(€€€€€ô¤ì(€€€ô°(€€¤ì)ô(