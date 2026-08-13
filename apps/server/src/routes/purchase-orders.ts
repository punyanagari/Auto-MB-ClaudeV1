import {
  CancelPurchaseOrderRequestSchema,
  CreatePurchaseOrderRequestSchema,
  PURCHASE_ORDER_STATUSES,
  PurchaseOrderDetailResponseSchema,
  PurchaseOrderListResponseSchema,
  SavePurchaseOrderLinesRequestSchema,
  type PurchaseOrder,
  type PurchaseOrderDetailResponse,
  type PurchaseOrderLine,
  type PurchaseOrderLineInput,
  type PurchaseOrderNotFullyReceivedDetails,
  type PurchaseOrderStatus,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireWriterRole } from '../authz.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
import { assertGstRateNotified } from '../gst-rates.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { canonicalRateText } from '../rate-text.js';
import { assertWorkOperable } from '../work-status.js';
import { cancellationNote } from './challans.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * Purchase orders (migration 0033; legacy spec §5.8): what the contractor
 * buys IN to supply a Work.
 *
 * Draft (one per Work, no number) -> issued (gapless
 * `<work_code>-PO-NN` under the per-Work counter row lock, vendor
 * snapshotted, total frozen) -> closed once every line has been fully
 * received, or cancelled with a note it keeps forever. The whole posture —
 * one transaction per request, the document row locked before any state
 * transition, issue and cancel behind their explicit authorities, every
 * transition audited — is the delivery challan's (routes/challans.ts),
 * because a purchase order is the same kind of object: a numbered document
 * that leaves the building.
 *
 * CLOSING IS DERIVED, NEVER ASSERTED. A line is fully received when the
 * quantities on ISSUED delivery challan items pointing at it reach the
 * quantity ordered; an order closes only when no line is still owed
 * anything, and the refusal names every line that still is. The
 * received/pending balance is recomputed from live challan rows on EVERY
 * read — never stored — so a receipt released later (its challan
 * cancelled) shows up as pending again even on an order already recorded
 * as closed. The status records a transition that was true when it was
 * made; the balance is always the truth of now.
 */

/** `status=open` is the challan editor's filter: the orders a delivery
 * challan can still receive against — issued, and with at least one line
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
 * issue-time snapshot once issued (rule 7 — retiring or renaming the
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
 * a cancelled one releases what it had claimed — exactly the rule the
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
 * (`of po` — the joined contacts row is read, never written). */
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
 * the Work's LOA letter date — a contractor cannot buy against an award
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
 * The vendor must be a contact carrying `is_vendor` and still active —
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
      'This vendor is retired — reactivate it or pick another.',
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
 * arithmetic from the quantity and rate — a client-supplied amount would
 * be a second, disagreeing authority (and, in JavaScript, a
 * floating-point one).
 *
 * A line that names a Work item is inserted FROM that item, which both
 * proves the item belongs to this Work and lets the item's tax facts
 * (HSN/SAC and GST rate, migration 0033) stand in when the request omits
 * them — the invoice slice reads those. A consumable the LOA never named
 * carries no item link and stands on its own description.
 *
 * A line's GST rate, when STATED on the request, must be one the
 * Government had notified on the order date (gst_rates master, finding
 * 19). Nullable-tolerant: an omitted rate passes — it either stays NULL
 * or is inherited from the Work item, whose tax facts are contract data
 * rather than a fresh keystroke.
 */
/** `value` as an integer scaled by 10^scale, without floating point:
 * the digits are read off the decimal string. */
function scaledInteger(value: string, scale: number): bigint {
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  return BigInt(
    (whole === '' ? '0' : whole) + (fraction + '0'.repeat(scale)).slice(0, scale),
  );
}

/** Whether quantity x rate lands outside `numeric(18,2)` — used ONLY to
 * name the offending line when PostgreSQL refuses the batch with a
 * 22003. The stored amount is always PostgreSQL's own exact product;
 * this comparison is exact decimal arithmetic too (BigInt on the digit
 * strings), never a float. */
function overflowsAmountColumn(line: {
  readonly quantity: string;
  readonly rate: string;
}): boolean {
  // numeric(18,2) holds at most 16 integer digits; the product carries
  // 3 + 6 decimal places before rounding.
  return (
    scaledInteger(line.quantity, 3) * scaledInteger(line.rate, 6) >=
    10n ** 16n * 10n ** 9n
  );
}

async function writeLines(
  tx: TransactionSql,
  organisationId: string,
  purchaseOrderId: string,
  workId: string,
  poDate: string,
  lines: readonly PurchaseOrderLineInput[],
): Promise<void> {
  await tx`
    delete from purchase_order_lines where purchase_order_id = ${purchaseOrderId}
  `;
  // Text rules, then the notified-rate check, then the writes. Every
  // refusal is raised in line order exactly as the per-line loop raised
  // it; the difference is that the rows now land in one statement per
  // shape, and each DISTINCT stated rate is checked once rather than
  // once per line that carries it (the first line carrying a rate is
  // the one the refusal named before, and still is).
  interface PreparedLine {
    readonly lineNumber: number;
    readonly label: string;
    readonly workItemId: string | undefined;
    readonly description: string;
    readonly unitCode: string;
    readonly hsnCode: string | null;
    readonly gstRate: string | null;
    readonly quantity: string;
    readonly rate: string;
  }
  const prepared: PreparedLine[] = lines.map((line, index) => {
    const lineNumber = index + 1;
    const label = `Line ${String(lineNumber)}`;
    return {
      lineNumber,
      label,
      workItemId: line.workItemId,
      description: trimmedText(
        line.description,
        3,
        1000,
        'PO_LINE_INVALID',
        `${label}: the description`,
      ),
      unitCode: trimmedText(
        line.unitCode,
        1,
        20,
        'PO_LINE_INVALID',
        `${label}: the unit`,
      ),
      hsnCode: line.hsnCode ?? null,
      gstRate: line.gstRate ?? null,
      quantity: line.quantity,
      rate: line.rate,
    };
  });
  const checkedRates = new Set<string>();
  for (const line of prepared) {
    if (line.gstRate !== null && !checkedRates.has(line.gstRate)) {
      checkedRates.add(line.gstRate);
      await assertGstRateNotified(tx, line.gstRate, poDate, line.label);
    }
  }

  // quantity x rate wider than the numeric(18,2) amount column: a 22003
  // carries no HTTP status, so it would reach the operator as 'The
  // request could not be completed.' Name the offending line instead —
  // found by re-multiplying the batch's lines, since one statement
  // cannot say which row overflowed.
  const nameOverflow = (error: unknown, batch: readonly PreparedLine[]): never => {
    if (isNumericOverflow(error)) {
      const culprit = batch.find((line) => overflowsAmountColumn(line)) ?? batch[0];
      throw httpError(
        400,
        'PO_LINE_INVALID',
        `${culprit?.label ?? 'A line'}: the quantity and rate multiply out to an amount too large to record — check for a mistyped digit.`,
      );
    }
    throw error;
  };

  const manualLines = prepared.filter((line) => line.workItemId === undefined);
  if (manualLines.length > 0) {
    await tx`
      insert into purchase_order_lines (
        organisation_id, purchase_order_id, work_item_id, line_number,
        description, hsn_code, unit_code, quantity, rate, gst_rate,
        line_amount
      )
      select ${organisationId}, ${purchaseOrderId}, null, l.line_number,
             l.description, l.hsn_code, l.unit_code, l.quantity, l.rate,
             l.gst_rate, (l.quantity * l.rate)::numeric(18,2)
      from unnest(
        ${manualLines.map((line) => line.lineNumber)}::int[],
        ${manualLines.map((line) => line.description)}::text[],
        ${manualLines.map((line) => line.hsnCode)}::text[],
        ${manualLines.map((line) => line.unitCode)}::text[],
        ${manualLines.map((line) => line.quantity)}::numeric(18,3)[],
        ${manualLines.map((line) => line.rate)}::numeric(18,6)[],
        ${manualLines.map((line) => line.gstRate)}::numeric(5,2)[]
      ) as l(
        line_number, description, hsn_code, unit_code, quantity, rate, gst_rate
      )
    `.catch((error: unknown) => nameOverflow(error, manualLines));
  }

  const itemLines = prepared.filter((line) => line.workItemId !== undefined);
  if (itemLines.length > 0) {
    const inserted = await tx<{ work_item_id: string }[]>`
      insert into purchase_order_lines (
        organisation_id, purchase_order_id, work_item_id, line_number,
        description, hsn_code, unit_code, quantity, rate, gst_rate,
        line_amount
      )
      select ${organisationId}, ${purchaseOrderId}, wi.id, l.line_number,
             l.description, coalesce(l.hsn_code, wi.hsn_code),
             l.unit_code, l.quantity, l.rate,
             coalesce(l.gst_rate, wi.gst_rate),
             (l.quantity * l.rate)::numeric(18,2)
      from unnest(
        ${itemLines.map((line) => line.workItemId ?? null)}::uuid[],
        ${itemLines.map((line) => line.lineNumber)}::int[],
        ${itemLines.map((line) => line.description)}::text[],
        ${itemLines.map((line) => line.hsnCode)}::text[],
        ${itemLines.map((line) => line.unitCode)}::text[],
        ${itemLines.map((line) => line.quantity)}::numeric(18,3)[],
        ${itemLines.map((line) => line.rate)}::numeric(18,6)[],
        ${itemLines.map((line) => line.gstRate)}::numeric(5,2)[]
      ) as l(
        work_item_id, line_number, description, hsn_code, unit_code, quantity,
        rate, gst_rate
      )
      join work_items wi on wi.id = l.work_item_id
        and wi.work_id = ${workId} and wi.deleted_at is null
      returning work_item_id
    `.catch((error: unknown) => nameOverflow(error, itemLines));
    if (inserted.length !== itemLines.length) {
      const missing = itemLines.find(
        (line) => !inserted.some((row) => row.work_item_id === line.workItemId),
      );
      throw httpError(
        404,
        'WORK_ITEM_NOT_FOUND',
        `${missing?.label ?? 'A line'}: the selected item does not belong to this Work.`,
      );
    }
  }
}

/** The lines in request-input shape for audit diffing; the numbers come
 * back normalised from their columns so before/after compare like for
 * like. */
async function readLineInputs(
  tx: TransactionSql,
  purchaseOrderId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await tx<
    {
      work_item_id: string | null;
      description: string;
      hsn_code: string | null;
      unit_code: string;
      quantity: string;
      rate: string;
      gst_rate: string | null;
    }[]
  >`
    select work_item_id, description, hsn_code, unit_code,
           quantity::text as quantity, rate::text as rate,
           gst_rate::text as gst_rate
    from purchase_order_lines
    where purchase_order_id = ${purchaseOrderId}
    order by line_number
  `;
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    description: row.description,
    hsnCode: row.hsn_code,
    unitCode: row.unit_code,
    quantity: row.quantity,
    rate: row.rate,
    gstRate: row.gst_rate,
  }));
}

// --- Routes -----------------------------------------------------------------

export function registerPurchaseOrderRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/purchase-orders',
      schema: {
        params: IdParamsSchema,
        querystring: ListQuerySchema,
        response: { 200: PurchaseOrderListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const { status } = request.query;
      // 'open' is issued PLUS the derived "still owed something" test; a
      // literal status filters literally; no filter lists everything.
      const statusFilter = status === 'open' ? 'issued' : (status ?? null);
      const openOnly = status === 'open';
      const rows = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        return (await tx.unsafe(
          `select ${PO_COLUMNS} ${PO_FROM}
             where po.work_id = $1
               and ($2::text is null or po.status = $2)
               and (
                 not $3::boolean
                 or exists (
                   select 1 from purchase_order_lines pol
                   where pol.purchase_order_id = po.id
                     and pol.quantity > coalesce((
                       select sum(dci.quantity)
                       from delivery_challan_items dci
                       join delivery_challans dc
                         on dc.id = dci.delivery_challan_id
                       where dci.purchase_order_line_id = pol.id
                         and dc.status = 'issued'
                     ), 0)
                 )
               )
             order by po.po_date desc, po.created_at desc, po.id`,
          [workId, statusFilter, openOnly],
        )) as unknown as PurchaseOrderRow[];
      });
      return { purchaseOrders: rows.map(toPurchaseOrder) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/purchase-orders',
      schema: {
        params: IdParamsSchema,
        body: CreatePurchaseOrderRequestSchema,
        response: { 201: PurchaseOrderDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const terms =
        body.terms === undefined
          ? null
          : trimmedText(body.terms, 3, 4000, 'PO_TERMS_INVALID', 'The terms');

      const detail = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertWorkAccess(tx, user.id, workId);
        // The works row lock pairs with the one POST
        // /api/works/:id/complete holds, so a draft created here can
        // never appear behind a completed Work's refusals; the 0033
        // insert guard backstops it in the database.
        const [work] = await tx<{ status: string }[]>`
            select status from works where id = ${workId} and deleted_at is null
            for update
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'drafting a purchase order');
        await assertPurchaseOrderDate(tx, workId, body.poDate);
        await requireVendor(tx, body.vendorContactId);

        // One open draft per Work and vendor (0045 partial unique index):
        // independent vendors may be drafted in parallel, while the 409
        // names a duplicate for the same vendor.
        const [existingDraft] = await tx<{ id: string }[]>`
            select id from purchase_orders
            where work_id = ${workId} and vendor_contact_id = ${body.vendorContactId}
              and status = 'draft'
          `;
        if (existingDraft) {
          throw draftConflictError(
            'PO_DRAFT_EXISTS',
            'This vendor already has a draft purchase order on this Work; issue or delete it first.',
            existingDraft.id,
          );
        }

        const [created] = await tx<{ id: string }[]>`
            insert into purchase_orders (
              organisation_id, work_id, vendor_contact_id, po_date, expected_on,
              terms, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.vendorContactId},
              ${body.poDate}, ${body.expectedOn ?? null}, ${terms}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            // A concurrent create won between the pre-check and this
            // insert; the transaction is aborted, so the route-level
            // catch names the winner from a fresh read.
            throw httpError(
              409,
              'PO_DRAFT_EXISTS',
              'This vendor already has a draft purchase order on this Work; issue or delete it first.',
            );
          }
          throw error;
        });
        if (!created) throw new Error('purchase order insert returned no row');

        await audit(
          tx,
          organisationId,
          user.id,
          'purchase_order.created',
          'purchase_orders',
          created.id,
          {
            workId,
            vendorContactId: body.vendorContactId,
            poDate: body.poDate,
          },
        );
        return readDetail(tx, created.id);
      }).catch(async (error: unknown) => {
        throw await nameDraftConflict(error, 'PO_DRAFT_EXISTS', () =>
          tenant(async (tx) => {
            const [row] = await tx<{ id: string }[]>`
              select id from purchase_orders
              where work_id = ${workId}
                and vendor_contact_id = ${body.vendorContactId}
                and status = 'draft'
            `;
            return row?.id ?? null;
          }),
        );
      });
      return reply.status(201).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/purchase-orders/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: PurchaseOrderDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [ref] = await tx<{ work_id: string }[]>`
          select work_id from purchase_orders where id = ${id}
        `;
        if (!ref) {
          throw httpError(404, 'PURCHASE_ORDER_NOT_FOUND', 'No such purchase order.');
        }
        await assertWorkAccess(tx, user.id, ref.work_id);
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/purchase-orders/:id',
      schema: {
        params: IdParamsSchema,
        body: CreatePurchaseOrderRequestSchema,
        response: { 200: PurchaseOrderDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const terms =
        body.terms === undefined
          ? null
          : trimmedText(body.terms, 3, 4000, 'PO_TERMS_INVALID', 'The terms');
      return tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        const order = await lockPurchaseOrder(tx, id);
        await assertWorkAccess(tx, user.id, order.work_id);
        // An issued order is a document that left the building: no edits,
        // ever (rule 7). The 0033 line trigger backstops the same rule for
        // the lines against every writer.
        requireStatus(order, 'draft');
        await assertPurchaseOrderDate(tx, order.work_id, body.poDate);
        const vendor = await requireVendor(tx, body.vendorContactId);
        const [existingDraft] = await tx<{ id: string }[]>`
          select id from purchase_orders
          where work_id = ${order.work_id}
            and vendor_contact_id = ${body.vendorContactId}
            and status = 'draft' and id <> ${id}
        `;
        if (existingDraft) {
          throw draftConflictError(
            'PO_DRAFT_EXISTS',
            'This vendor already has a draft purchase order on this Work; issue or delete it first.',
            existingDraft.id,
          );
        }
        await tx`
          update purchase_orders
          set vendor_contact_id = ${body.vendorContactId}, po_date = ${body.poDate},
              expected_on = ${body.expectedOn ?? null}, terms = ${terms}
          where id = ${id}
        `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'PO_DRAFT_EXISTS',
              'This vendor already has a draft purchase order on this Work; issue or delete it first.',
            );
          }
          throw error;
        });
        const changes = auditDiff(
          {
            vendorContactId: order.vendor_contact_id,
            poDate: order.po_date,
            expectedOn: order.expected_on,
            terms: order.terms,
          },
          {
            vendorContactId: body.vendorContactId,
            poDate: body.poDate,
            expectedOn: body.expectedOn ?? null,
            terms,
          },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'purchase_order.updated',
          'purchase_orders',
          id,
          { before: changes.before, after: changes.after, vendor: vendor.designation },
        );
        return readDetail(tx, id);
      }).catch(async (error: unknown) => {
        throw await nameDraftConflict(error, 'PO_DRAFT_EXISTS', () =>
          tenant(async (tx) => {
            const [row] = await tx<{ id: string }[]>`
              select id from purchase_orders
              where work_id = (
                select work_id from purchase_orders where id = ${id}
              )
                and vendor_contact_id = ${body.vendorContactId}
                and status = 'draft' and id <> ${id}
            `;
            return row?.id ?? null;
          }),
        );
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/purchase-orders/:id/lines',
      schema: {
        params: IdParamsSchema,
        body: SavePurchaseOrderLinesRequestSchema,
        response: { 200: PurchaseOrderDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const order = await lockPurchaseOrder(tx, id);
        await assertWorkAccess(tx, user.id, order.work_id);
        requireStatus(order, 'draft');
        const linesBefore = await readLineInputs(tx, id);
        await writeLines(
          tx,
          organisationId,
          id,
          order.work_id,
          order.po_date,
          body.lines,
        );
        const changes = auditDiff(
          { lines: linesBefore },
          { lines: await readLineInputs(tx, id) },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'purchase_order.lines_saved',
          'purchase_orders',
          id,
          {
            before: changes.before,
            after: changes.after,
            lineCount: body.lines.length,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/purchase-orders/:id',
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        const order = await lockPurchaseOrder(tx, id);
        await assertWorkAccess(tx, user.id, order.work_id);
        // Rule 8: a draft is not yet a document, so it is deleted rather
        // than cancelled. Anything issued keeps its number forever.
        requireStatus(order, 'draft');
        // The lines go FIRST and explicitly: the 0033 line guard reads the
        // parent's status, and a cascade from the deleted parent would
        // find no parent row and raise.
        await tx`delete from purchase_order_lines where purchase_order_id = ${id}`;
        await tx`delete from purchase_orders where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'purchase_order.deleted',
          'purchase_orders',
          id,
          { workId: order.work_id },
        );
      });
      return reply.status(204).send(null);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/purchase-orders/:id/issue',
      schema: {
        params: IdParamsSchema,
        response: { 201: PurchaseOrderDetailResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const detail = await tenant(async (tx) => {
        const order = await lockPurchaseOrder(tx, id);
        await assertWorkAccess(tx, user.id, order.work_id);
        requireStatus(order, 'draft');

        // Lock order works -> counter matches every other numbering
        // writer, so an issue and a Work completion serialise instead of
        // deadlocking.
        const [work] = await tx<{ work_code: string; status: string }[]>`
            select work_code, status from works
            where id = ${order.work_id} and deleted_at is null
            for update
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        // R8: a completed Work accepts no new procurement.
        assertWorkOperable(work.status, 'issuing a purchase order');

        const [lineCount] = await tx<{ total: string }[]>`
            select count(*)::text as total from purchase_order_lines
            where purchase_order_id = ${id}
          `;
        if (lineCount?.total === '0') {
          throw httpError(
            409,
            'PO_EMPTY',
            'A purchase order needs at least one line before it can be issued.',
          );
        }

        // Re-checked under the lock: the vendor may have been retired
        // since the draft named it, and an order issued today must not
        // go to a supplier the organisation has stopped using.
        const vendor = await requireVendor(tx, order.vendor_contact_id);

        const [total] = await tx<{ amount: string }[]>`
            select coalesce(sum(line_amount), 0)::numeric(18,2)::text as amount
            from purchase_order_lines where purchase_order_id = ${id}
          `;

        // Serialised per-Work numbering: the counter row lock orders
        // concurrent issues, and a rolled-back transaction rolls the
        // counter back with it, so numbers are gapless per Work.
        const [counter] = await tx<{ next_value: number }[]>`
            insert into purchase_order_counters (organisation_id, work_id)
            values (${organisationId}, ${order.work_id})
            on conflict (organisation_id, work_id)
            do update set next_value = purchase_order_counters.next_value + 1
            returning next_value
          `;
        if (!counter) throw new Error('counter upsert returned no row');
        const sequence = counter.next_value;
        const poNumber = `${work.work_code}-PO-${String(sequence).padStart(2, '0')}`;

        await tx`
            update purchase_orders
            set status = 'issued', po_number = ${poNumber},
                sequence_number = ${sequence},
                vendor_snapshot = ${jsonb(tx, vendorSnapshot(vendor))},
                total_amount = ${total?.amount ?? '0.00'},
                issued_by_user_id = ${user.id}, issued_at = now()
            where id = ${id}
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'PO_NUMBER_CONFLICT',
              `Purchase order number ${poNumber} already exists in this organisation.`,
            );
          }
          throw error;
        });

        await audit(
          tx,
          organisationId,
          user.id,
          'purchase_order.issued',
          'purchase_orders',
          id,
          {
            poNumber,
            sequence,
            totalAmount: total?.amount ?? '0.00',
            vendorContactId: vendor.id,
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
      url: '/api/purchase-orders/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelPurchaseOrderRequestSchema,
        response: { 200: PurchaseOrderDetailResponseSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const note = cancellationNote(body.note);
      return tenant(async (tx) => {
        const order = await lockPurchaseOrder(tx, id);
        await assertWorkAccess(tx, user.id, order.work_id);
        // Only an issued order cancels: a draft is deleted (rule 8), and a
        // closed one is finished. Receipts already recorded against the
        // order's lines are NOT disturbed — the delivered material is the
        // challan's fact, not the order's, and the Work's quantity ledger
        // never read this order. Cancelling says only that the rest of it
        // is never coming.
        requireStatus(order, 'issued');
        await tx`
          update purchase_orders
          set status = 'cancelled', cancelled_by_user_id = ${user.id},
              cancelled_at = now(), cancellation_note = ${note}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'purchase_order.cancelled',
          'purchase_orders',
          id,
          { poNumber: order.po_number, note },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/purchase-orders/:id/close',
      schema: {
        params: IdParamsSchema,
        response: { 200: PurchaseOrderDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        // Closing asserts nothing an operator could invent: it succeeds
        // only when the receipts already say the order is complete, so it
        // is a writer action rather than an issue/cancel authority.
        const order = await lockPurchaseOrder(tx, id);
        await assertWorkAccess(tx, user.id, order.work_id);
        requireStatus(order, 'issued');

        // Row-lock every challan that has fed this order, so a receipt
        // cannot be released (its challan cancelled) halfway through the
        // balance below. Lock order is purchase_orders -> delivery_challans
        // and the challan cancel path takes delivery_challans -> works, so
        // the two cannot cycle. What no lock can prevent is a challan
        // cancelled AFTER this commits; the balance is therefore
        // recomputed live on every read, and a closed order whose receipt
        // was later released shows its lines pending again.
        await tx`
          select dc.id from delivery_challans dc
          where dc.id in (
            select dci.delivery_challan_id
            from delivery_challan_items dci
            join purchase_order_lines pol on pol.id = dci.purchase_order_line_id
            where pol.purchase_order_id = ${id}
          )
          order by dc.id
          for update
        `;

        const lines = await readLines(tx, id);
        const outstanding = lines.filter((line) => line.pending_quantity !== '0.000');
        if (outstanding.length > 0) {
          const details: PurchaseOrderNotFullyReceivedDetails = {
            outstandingLines: outstanding.map((line) => ({
              purchaseOrderLineId: line.id,
              lineNumber: line.line_number,
              description: line.description,
              orderedQuantity: line.quantity,
              receivedQuantity: line.received_quantity,
              pendingQuantity: line.pending_quantity,
            })),
          };
          const names = outstanding
            .map(
              (line) =>
                `line ${String(line.line_number)} (${line.received_quantity} of ${line.quantity} ${line.unit_code} received)`,
            )
            .join('; ');
          throw httpError(
            409,
            'PO_NOT_FULLY_RECEIVED',
            `A purchase order closes only when every line has been received against an issued delivery challan — still open: ${names}.`,
            details,
          );
        }

        await tx`
          update purchase_orders
          set status = 'closed', closed_at = now()
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'purchase_order.closed',
          'purchase_orders',
          id,
          { poNumber: order.po_number, lineCount: lines.length },
        );
        return readDetail(tx, id);
      });
    },
  );
}
