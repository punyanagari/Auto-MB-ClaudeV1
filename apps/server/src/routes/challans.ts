import { createHash } from 'node:crypto';
import {
  CancelChallanRequestSchema,
  ChallanDetailResponseSchema,
  ChallanListResponseSchema,
  SaveChallanRequestSchema,
  WorkBalanceResponseSchema,
  type Challan,
  type ChallanDetailResponse,
  type ChallanItem,
  type ChallanOverReceiptWarning,
  type Consignee,
  type SaveChallanRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireWriterRole } from '../authz.js';
import {
  CHALLAN_TEMPLATE_VERSION,
  WARRANTY_TEMPLATE_VERSION,
  renderChallanHtml,
  type ChallanSnapshot,
} from '../challan-html.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
import { httpError } from '../http.js';
import {
  NumberTemplateError,
  loadNumberTemplate,
  renderNumberTemplate,
} from '../number-series.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import type { MalwareScanner } from '../malware-scan.js';
import { canonicalRateText } from '../rate-text.js';
import { assertSourceNotBilled } from './measurement-books.js';
import { assertNotMalware } from '../upload-guards.js';
import type { ObjectStorage } from '../storage.js';
import { assertWorkOperable } from '../work-status.js';
import {
  audit,
  IdParamsSchema,
  upstreamErrorResponses as errorResponses,
} from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import { renderPdfViaGotenberg } from '../pdf-render.js';

const PdfQuerySchema = Type.Object(
  {
    kind: Type.Optional(Type.Union([Type.Literal('rendered'), Type.Literal('signed')])),
  },
  { additionalProperties: false },
);

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_PDF_BYTES = 25 * 1024 * 1024;

interface ChallanRow {
  id: string;
  work_id: string;
  status: Challan['status'];
  challan_date: string;
  challan_number: string | null;
  sequence_number: number | null;
  prefix: string;
  consignee_snapshot: unknown;
  template_version: string | null;
  warranty_template_version: string | null;
  warranty_text_sha256: string | null;
  rendered_object_key: string | null;
  signed_copy_object_key: string | null;
  cancellation_note: string | null;
  created_at: Date;
  issued_at: Date | null;
  cancelled_at: Date | null;
}

const CHALLAN_COLUMNS = `
  id, work_id, status, challan_date::text as challan_date, challan_number,
  sequence_number, prefix, consignee_snapshot, template_version,
  warranty_template_version, warranty_text_sha256,
  rendered_object_key, signed_copy_object_key, cancellation_note,
  created_at, issued_at, cancelled_at
`;

function toChallan(row: ChallanRow): Challan {
  return {
    id: row.id,
    workId: row.work_id,
    status: row.status,
    challanDate: row.challan_date,
    challanNumber: row.challan_number,
    sequenceNumber: row.sequence_number,
    prefix: row.prefix,
    consignee: parseJsonbColumn(row.consignee_snapshot) as Consignee,
    templateVersion: row.template_version,
    warrantyTemplateVersion: row.warranty_template_version,
    warrantyTextSha256: row.warranty_text_sha256,
    renderedAvailable: row.rendered_object_key !== null,
    signedCopyAvailable: row.signed_copy_object_key !== null,
    cancellationNote: row.cancellation_note,
    createdAt: row.created_at.toISOString(),
    issuedAt: row.issued_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

interface ChallanItemRow {
  id: string;
  work_item_id: string;
  description_snapshot: string;
  unit_snapshot: string;
  quantity: string;
  rate_snapshot: string;
  line_amount: string;
  position: number;
  purchase_order_line_id: string | null;
}

function toChallanItem(row: ChallanItemRow): ChallanItem {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    description: row.description_snapshot,
    unit: row.unit_snapshot,
    quantity: row.quantity,
    rate: canonicalRateText(row.rate_snapshot),
    lineAmount: row.line_amount,
    position: row.position,
    purchaseOrderLineId: row.purchase_order_line_id,
  };
}

async function readItems(
  tx: TransactionSql,
  challanId: string,
): Promise<ChallanItem[]> {
  const rows = await tx<ChallanItemRow[]>`
    select id, work_item_id, description_snapshot, unit_snapshot,
           quantity::text as quantity, rate_snapshot::text as rate_snapshot,
           line_amount::text as line_amount, position, purchase_order_line_id
    from delivery_challan_items
    where delivery_challan_id = ${challanId}
    order by position
  `;
  return rows.map(toChallanItem);
}

/**
 * The over-receipt notices for this challan's purchase-order-linked
 * lines, one per purchase-order line, in exact SQL numeric arithmetic
 * (rule 5). `received` counts issued receipts on OTHER challans plus this
 * challan's own lines — the projection while this challan is a draft and
 * the actual total once it is issued (its own lines are then part of the
 * issued sum, so the two readings agree). Over-receipt is deliberately a
 * WARNING, never a refusal: vendors over-ship, and the delivery document
 * must record what actually arrived (the purchase-order balance already
 * floors its pending figure at zero, purchase-orders.ts readLines).
 */
async function readOverReceiptWarnings(
  tx: TransactionSql,
  challanId: string,
): Promise<ChallanOverReceiptWarning[]> {
  const rows = await tx<
    {
      purchase_order_line_id: string;
      po_number: string;
      line_number: number;
      description: string;
      ordered_quantity: string;
      received_quantity: string;
    }[]
  >`
    select pol.id as purchase_order_line_id, po.po_number, pol.line_number,
           pol.description, pol.quantity::text as ordered_quantity,
           (coalesce(elsewhere.received, 0) + own.quantity)
             ::numeric(18,3)::text as received_quantity
    from (
      select dci.purchase_order_line_id as pol_id, sum(dci.quantity) as quantity
      from delivery_challan_items dci
      where dci.delivery_challan_id = ${challanId}
        and dci.purchase_order_line_id is not null
      group by dci.purchase_order_line_id
    ) own
    join purchase_order_lines pol on pol.id = own.pol_id
    join purchase_orders po on po.id = pol.purchase_order_id
    left join lateral (
      select sum(q.quantity) as received
      from delivery_challan_items q
      join delivery_challans dc on dc.id = q.delivery_challan_id
      where q.purchase_order_line_id = pol.id
        and dc.status = 'issued'
        and q.delivery_challan_id <> ${challanId}
    ) elsewhere on true
    where coalesce(elsewhere.received, 0) + own.quantity > pol.quantity
    order by pol.line_number
  `;
  return rows.map((row) => ({
    purchaseOrderLineId: row.purchase_order_line_id,
    poNumber: row.po_number,
    poLineNumber: row.line_number,
    description: row.description,
    orderedQuantity: row.ordered_quantity,
    receivedQuantity: row.received_quantity,
  }));
}

async function readDetail(
  tx: TransactionSql,
  challanId: string,
): Promise<ChallanDetailResponse> {
  const [row] = await tx<(ChallanRow & { issued_snapshot: unknown })[]>`
    select ${tx.unsafe(CHALLAN_COLUMNS)}, issued_snapshot
    from delivery_challans where id = ${challanId}
  `;
  if (!row) throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
  return {
    challan: toChallan(row),
    items: await readItems(tx, challanId),
    issuedSnapshot: parseJsonbColumn(row.issued_snapshot),
    // A cancelled challan released its receipts, so it can no longer
    // over-receive anything; otherwise the notices are recomputed live so
    // a receipt issued elsewhere shows up on the next read of this one.
    warnings:
      row.status === 'cancelled' ? [] : await readOverReceiptWarnings(tx, challanId),
  };
}

/** Product contract: a document date is never in the future and never
 * before the Work's LOA letter date. "Today" is the organisation's own
 * timezone (default Asia/Kolkata), not the server clock — an evening
 * entry in India must not be rejected as tomorrow's date. (Exported for
 * the correction flow, which validates replacement drafts.) */
export async function assertChallanDate(
  tx: TransactionSql,
  workId: string,
  challanDate: string,
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
  if (challanDate > bounds.today) {
    throw httpError(
      400,
      'CHALLAN_DATE_INVALID',
      `The challan date cannot be in the future (today is ${bounds.today}).`,
    );
  }
  if (challanDate < bounds.letter_date) {
    throw httpError(
      400,
      'CHALLAN_DATE_INVALID',
      `The challan date cannot precede the LOA letter date (${bounds.letter_date}).`,
    );
  }
}

/** True when a DecimalString denotes a value greater than zero, decided
 * on the digits themselves — never binary floating-point arithmetic
 * (engineering rule 5). The schema pattern guarantees the shape, so a
 * leading '-' is the only sign and any non-zero digit means positive.
 *
 * Exported because every writer that refuses a non-positive quantity owes
 * the same answer. The alternative the other routes used, `Number(value)
 * === 0`, is correct only while DecimalStringSchema caps fraction digits
 * at three: widen that cap (RateStringSchema already allows six) and
 * '0.0001' rounds to a positive Number, passes, and lands on the
 * `CHECK (quantity > 0)` in the database as a statusless 23514 the
 * operator reads as 'The request could not be completed.' Digit
 * inspection does not depend on the cap. */
export function isPositiveDecimal(value: string): boolean {
  return !value.startsWith('-') && /[1-9]/.test(value);
}

/** Digits before the decimal point. `delivery_challan_items.quantity` is
 * numeric(18,3), so sixteen of them is a numeric field overflow (22003)
 * in Postgres — the same statusless error a failed CHECK raises. */
function integerDigitCount(value: string): number {
  const [whole = ''] = value.replace('-', '').split('.');
  return whole.length;
}

/** The consignee block exactly as it will be printed. `ConsigneeSchema`
 * counts RAW characters, so `{name: '  ', address: '   '}` satisfies its
 * minimums, is frozen into the issued snapshot, and reaches the railway
 * as a delivery document with a blank consignee — and `consignee_snapshot`
 * is bare jsonb, so nothing below catches it either. Trim first, then
 * prove the printed parts survived. A phone of only spaces is dropped
 * rather than stored blank. (The web editor already trims; this closes
 * the same hole for direct API callers.) */
export function normaliseConsignee(consignee: Consignee): Consignee {
  const name = consignee.name.trim();
  const address = consignee.address.trim();
  const phone = consignee.phone?.trim() ?? '';
  if (name.length < 2 || address.length < 3) {
    throw httpError(
      400,
      'CONSIGNEE_INVALID',
      'The consignee needs a name and an address that are not blank — this challan is printed and handed to the consignee.',
    );
  }
  return { name, address, ...(phone.length > 0 ? { phone } : {}) };
}

/** A cancellation note as the DATABASE judges it. Every cancellation
 * CHECK in the schema reads `length(btrim(note)) >= 3` while the contract
 * counts raw characters, so a note of three spaces passed validation,
 * reached Postgres, and came back as a bare 500 'The request could not be
 * completed.' The trimmed text is what gets stored, so the note on the
 * record is the note the operator meant. (Exported: the correction-notice
 * and PAC cancels answer to the same CHECK.) */
export function cancellationNote(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length < 3) {
    throw httpError(
      400,
      'CANCELLATION_NOTE_REQUIRED',
      'The cancellation note must say why the record is being cancelled — at least three characters that are not spaces.',
    );
  }
  return trimmed;
}

/** Locks the challan row for the rest of the transaction and returns it.
 * Every state transition starts here so concurrent requests serialise. */
async function lockChallan(tx: TransactionSql, challanId: string): Promise<ChallanRow> {
  const [row] = await tx<ChallanRow[]>`
    select ${tx.unsafe(CHALLAN_COLUMNS)}
    from delivery_challans where id = ${challanId}
    for update
  `;
  if (!row) throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
  return row;
}

export interface LinkedPurchaseOrderLock {
  readonly id: string;
  readonly status: string;
  readonly po_number: string | null;
}

/** Locks every PO linked by this challan's lines in stable id order. Call
 * before locking the challan itself: PO close uses purchase_orders ->
 * delivery_challans, so this shared order prevents a close/cancel cycle. */
export async function lockLinkedPurchaseOrdersForChallan(
  tx: TransactionSql,
  challanId: string,
): Promise<LinkedPurchaseOrderLock[]> {
  return tx<LinkedPurchaseOrderLock[]>`
    select po.id, po.status, po.po_number
    from purchase_orders po
    where po.id in (
      select pol.purchase_order_id
      from delivery_challan_items dci
      join purchase_order_lines pol on pol.id = dci.purchase_order_line_id
      where dci.delivery_challan_id = ${challanId}
    )
    order by po.id
    for update
  `;
}

/** Revalidates the immutable issued-line link set after the challan lock. */
export async function assertLinkedPurchaseOrderLocksCurrent(
  tx: TransactionSql,
  challanId: string,
  lockedOrders: readonly LinkedPurchaseOrderLock[],
): Promise<void> {
  const current = await tx<{ id: string }[]>`
    select po.id
    from purchase_orders po
    where po.id in (
      select pol.purchase_order_id
      from delivery_challan_items dci
      join purchase_order_lines pol on pol.id = dci.purchase_order_line_id
      where dci.delivery_challan_id = ${challanId}
    )
    order by po.id
  `;
  if (
    current.length !== lockedOrders.length ||
    current.some((row, index) => row.id !== lockedOrders[index]?.id)
  ) {
    throw httpError(
      409,
      'CHALLAN_PO_LINK_CHANGED',
      'The challan receipt links changed concurrently; retry the operation.',
    );
  }
}

/** A receipt release makes a formerly complete PO incomplete. Reopen every
 * linked closed order atomically and leave a durable audit explanation. */
export async function reopenClosedPurchaseOrders(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  challan: { id: string; challan_number: string | null },
  note: string,
  linkedOrders: readonly LinkedPurchaseOrderLock[],
): Promise<void> {
  for (const order of linkedOrders) {
    if (order.status !== 'closed') continue;
    await tx`
      update purchase_orders
      set status = 'issued', closed_at = null, updated_at = now()
      where id = ${order.id} and status = 'closed'
    `;
    await tx`
      insert into audit_events (
        organisation_id, actor_user_id, action, entity_type, entity_id, details
      ) values (
        ${organisationId}, ${userId},
        'purchase_order.reopened_after_challan_cancellation',
        'purchase_orders', ${order.id},
        ${jsonb(tx, {
          poNumber: order.po_number,
          challanId: challan.id,
          challanNumber: challan.challan_number,
          cancellationNote: note,
        })}
      )
    `;
  }
}

/** The receipt link (0033): a challan line may name the purchase-order
 * line it fulfils. The named line must belong to an ISSUED order of THIS
 * Work — a draft order has not been placed yet, a closed or cancelled one
 * takes no further receipts, and another Work's procurement answers
 * exactly like an unknown id (the same posture RLS gives another
 * tenant's). What is deliberately NOT checked here is the quantity:
 * over-receipt against the ordered amount is a warning on the read model
 * (readOverReceiptWarnings), never a refusal — vendors over-ship, and the
 * challan must record what actually arrived. The composite FK on
 * (organisation_id, purchase_order_line_id) backstops the existence check
 * in the database.
 *
 * `label` names the offending line the way the caller counts lines, e.g.
 * 'Line 2'. Exported so the correction propose path validates the link at
 * the person who can fix it, rather than discovering it at apply time
 * where the failure rolls the approver's decision back and strands the
 * request as pending.
 *
 * `reopenableOrderIds` is that propose path's one concession: a
 * cancel-and-replace releases the original challan's receipts, so its
 * apply reopens every CLOSED order those receipts closed
 * (reopenClosedPurchaseOrders) before writing the replacement lines. A
 * replacement that keeps a link into one of those orders is therefore
 * lawful even though the order reads 'closed' right now. Any other closed
 * order is refused, because nothing will reopen it. Writers of actual
 * lines pass nothing and hold the strict rule. */
export async function assertPurchaseOrderLineReceivable(
  tx: TransactionSql,
  workId: string,
  purchaseOrderLineId: string,
  label: string,
  reopenableOrderIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  const [poLine] = await tx<{ id: string; status: string; work_id: string }[]>`
    select po.id, po.status, po.work_id
    from purchase_order_lines pol
    join purchase_orders po on po.id = pol.purchase_order_id
    where pol.id = ${purchaseOrderLineId}
  `;
  if (!poLine || poLine.work_id !== workId) {
    throw httpError(
      404,
      'PO_LINE_NOT_FOUND',
      `${label}: the named purchase-order line does not belong to this Work.`,
    );
  }
  const reopenable = poLine.status === 'closed' && reopenableOrderIds.has(poLine.id);
  if (poLine.status !== 'issued' && !reopenable) {
    throw httpError(
      409,
      'PO_NOT_ISSUED',
      `${label}: deliveries are received against an ISSUED purchase order (current status: ${poLine.status}).`,
    );
  }
}

function requireStatus(row: ChallanRow, status: Challan['status']): void {
  if (row.status !== status) {
    throw httpError(
      409,
      'CHALLAN_STATUS_CONFLICT',
      `This operation requires a ${status} challan (current status: ${row.status}).`,
    );
  }
}

/** Replaces the challan's lines from the request, snapshotting
 * description/unit/rate from the live work items and computing the line
 * amount in exact SQL numeric arithmetic. (Exported for the correction
 * flow, which writes replacement drafts through the same path.) */
export async function writeLines(
  tx: TransactionSql,
  organisationId: string,
  challanId: string,
  workId: string,
  body: SaveChallanRequest,
): Promise<void> {
  // Draft-time serials hang off the line rows being replaced (serial
  // lineage FK); they are draft-stage records — deletable by rule — and
  // cannot outlive their lines, so a line rewrite clears them and they
  // are re-recorded against the new lines before issue.
  await tx`
    delete from challan_item_serials where delivery_challan_id = ${challanId}
  `;
  await tx`
    delete from delivery_challan_items where delivery_challan_id = ${challanId}
  `;
  for (const [index, item] of body.items.entries()) {
    // The column reads `numeric(18,3) NOT NULL CHECK (quantity > 0)`,
    // while the shared DecimalString shape admits '0', '-5' and a
    // sixteen-digit typo. Each of those reaches Postgres as a 23514 or a
    // 22003, neither of which carries an HTTP status, so the operator
    // reads 'The request could not be completed.' and the logs record a
    // false 5xx. Refused here instead, naming the line — the same answer
    // the correction path already gives (corrections.ts QUANTITY_INVALID).
    const lineNumber = String(index + 1);
    if (!isPositiveDecimal(item.quantity)) {
      throw httpError(
        400,
        'QUANTITY_INVALID',
        `Line ${lineNumber}: the delivered quantity must be greater than zero (received ${item.quantity}).`,
      );
    }
    if (integerDigitCount(item.quantity) > 15) {
      throw httpError(
        400,
        'QUANTITY_INVALID',
        `Line ${lineNumber}: the delivered quantity ${item.quantity} is too large to record — check for a mistyped digit.`,
      );
    }
    if (item.purchaseOrderLineId !== undefined) {
      await assertPurchaseOrderLineReceivable(
        tx,
        workId,
        item.purchaseOrderLineId,
        `Line ${lineNumber}`,
      );
    }
    const [inserted] = await tx<{ id: string }[]>`
      insert into delivery_challan_items (
        organisation_id, delivery_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, rate_snapshot,
        line_amount, position, purchase_order_line_id
      )
      select ${organisationId}, ${challanId}, ${workId}, wi.id,
             coalesce(wi.effective_description, wi.description),
             coalesce(wi.effective_unit, wi.unit_code), ${item.quantity},
             coalesce(wi.effective_unit_rate, wi.effective_rate),
             (${item.quantity}::numeric(18,3)
               * coalesce(wi.effective_unit_rate, wi.effective_rate))::numeric(18,2),
             ${index + 1}, ${item.purchaseOrderLineId ?? null}
      from work_items wi
      where wi.id = ${item.workItemId} and wi.work_id = ${workId}
        and wi.deleted_at is null
      returning id
    `.catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === '23505') {
        throw httpError(
          409,
          'DUPLICATE_ITEM',
          'The same Work item appears more than once on this challan.',
        );
      }
      throw error;
    });
    if (!inserted) {
      throw httpError(
        404,
        'WORK_ITEM_NOT_FOUND',
        'A selected item does not belong to this Work.',
      );
    }
  }
}

/** The challan's lines in request-input shape ({workItemId, quantity,
 * purchaseOrderLineId}) for audit diffing; quantity text comes normalised
 * from the numeric column so before/after compare like for like. */
async function readLineInputs(
  tx: TransactionSql,
  challanId: string,
): Promise<
  { workItemId: string; quantity: string; purchaseOrderLineId: string | null }[]
> {
  const rows = await tx<
    { work_item_id: string; quantity: string; purchase_order_line_id: string | null }[]
  >`
    select work_item_id, quantity::text as quantity, purchase_order_line_id
    from delivery_challan_items
    where delivery_challan_id = ${challanId}
    order by position
  `;
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    quantity: row.quantity,
    purchaseOrderLineId: row.purchase_order_line_id,
  }));
}

export function registerChallanRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
  scanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/balance',
      schema: {
        params: IdParamsSchema,
        response: { 200: WorkBalanceResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ allow_excess_delivery: boolean; today: string }[]>`
          select w.allow_excess_delivery,
                 (now() at time zone o.timezone)::date::text as today
          from works w
          join organisations o on o.id = w.organisation_id
          where w.id = ${workId} and w.deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        // The delivery ceiling is COALESCE(effective_quantity,
        // awarded_quantity): approved amendments (Milestone 6) raise or
        // lower it, and the rate/description an amendment changed is what
        // new challan lines will snapshot.
        const rows = await tx<
          {
            work_item_id: string;
            item_number: string;
            description: string;
            unit_code: string;
            awarded: string;
            effective: string | null;
            delivered: string;
            remaining: string;
            rate: string;
          }[]
        >`
          select wi.id as work_item_id, wi.item_number,
                 coalesce(wi.effective_description, wi.description) as description,
                 coalesce(wi.effective_unit, wi.unit_code) as unit_code,
                 wi.awarded_quantity::text as awarded,
                 wi.effective_quantity::text as effective,
                 coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0)::text as delivered,
                 (coalesce(wi.effective_quantity, wi.awarded_quantity)
                   - coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0))::text as remaining,
                 coalesce(wi.effective_unit_rate, wi.effective_rate)::text as rate
          from work_items wi
          left join delivery_challan_items dci on dci.work_item_id = wi.id
          left join delivery_challans dc on dc.id = dci.delivery_challan_id
          where wi.work_id = ${workId} and wi.deleted_at is null
          group by wi.id
          order by wi.item_number
        `;
        return {
          allowExcessDelivery: work.allow_excess_delivery,
          today: work.today,
          items: rows.map((row) => ({
            workItemId: row.work_item_id,
            itemNumber: row.item_number,
            description: row.description,
            unitCode: row.unit_code,
            awardedQuantity: row.awarded,
            effectiveQuantity: row.effective,
            deliveredQuantity: row.delivered,
            remainingQuantity: row.remaining,
            effectiveRate: canonicalRateText(row.rate),
          })),
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/challans',
      schema: {
        params: IdParamsSchema,
        response: { 200: ChallanListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const rows = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        return tx<ChallanRow[]>`
            select ${tx.unsafe(CHALLAN_COLUMNS)}
            from delivery_challans
            where work_id = ${workId}
            order by created_at desc, id
          `;
      });
      return { challans: rows.map(toChallan) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/challans',
      schema: {
        params: IdParamsSchema,
        body: SaveChallanRequestSchema,
        response: { 201: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const consignee = normaliseConsignee(body.consignee);

      const detail = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertWorkAccess(tx, user.id, workId);
        // The works row lock pairs with the one POST
        // /api/works/:id/complete holds: a draft created here and a
        // completion on the same Work serialise, so a draft can never
        // appear behind a completed Work's refusals (the 0031 insert
        // guard backstops it in the database).
        const [work] = await tx<{ status: string }[]>`
            select status from works where id = ${workId} and deleted_at is null
            for update
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'drafting a delivery challan');
        await assertChallanDate(tx, workId, body.challanDate);

        // One open draft per Work (the partial unique index is the
        // arbiter): the 409 names the existing draft so the client can
        // open it instead of parsing the message.
        const [existingDraft] = await tx<{ id: string }[]>`
            select id from delivery_challans
            where work_id = ${workId} and status = 'draft'
          `;
        if (existingDraft) {
          throw draftConflictError(
            'DRAFT_EXISTS',
            'This Work already has a draft challan; issue or delete it first.',
            existingDraft.id,
          );
        }

        const [created] = await tx<{ id: string }[]>`
            insert into delivery_challans (
              organisation_id, work_id, challan_date, prefix,
              consignee_snapshot, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.challanDate}, ${body.prefix},
              ${jsonb(tx, consignee)}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            // A concurrent create won between the pre-check and this
            // insert; the transaction is aborted, so the route-level
            // catch names the winner from a fresh read.
            throw httpError(
              409,
              'DRAFT_EXISTS',
              'This Work already has a draft challan; issue or delete it first.',
            );
          }
          throw error;
        });
        if (!created) throw new Error('challan insert returned no row');

        await writeLines(tx, organisationId, created.id, workId, body);
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.created',
          'delivery_challans',
          created.id,
          {
            workId,
            itemCount: body.items.length,
          },
        );
        return readDetail(tx, created.id);
      }).catch(async (error: unknown) => {
        // The unique-index race path could not name the winning draft
        // inside its aborted transaction; do it from a fresh read.
        throw await nameDraftConflict(error, 'DRAFT_EXISTS', () =>
          tenant(async (tx) => {
            const [row] = await tx<{ id: string }[]>`
              select id from delivery_challans
              where work_id = ${workId} and status = 'draft'
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
      url: '/api/challans/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [ref] = await tx<{ work_id: string }[]>`
          select work_id from delivery_challans where id = ${id}
        `;
        if (!ref) {
          throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
        }
        await assertWorkAccess(tx, user.id, ref.work_id);
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/challans/:id',
      schema: {
        params: IdParamsSchema,
        body: SaveChallanRequestSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const consignee = normaliseConsignee(body.consignee);
      return tenant(async (tx) => {
        const challan = await lockChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'draft');
        await assertChallanDate(tx, challan.work_id, body.challanDate);
        const linesBefore = await readLineInputs(tx, id);
        await tx`
          update delivery_challans
          set challan_date = ${body.challanDate}, prefix = ${body.prefix},
              consignee_snapshot = ${jsonb(tx, consignee)}
          where id = ${id}
        `;
        await writeLines(tx, organisationId, id, challan.work_id, body);
        // Milestone 6: the trail records what each changed field was and
        // became. Lines round-trip through the database on both sides so
        // quantities compare in the same normalised numeric text.
        const changes = auditDiff(
          {
            challanDate: challan.challan_date,
            prefix: challan.prefix,
            consignee: parseJsonbColumn(challan.consignee_snapshot),
            items: linesBefore,
          },
          {
            challanDate: body.challanDate,
            prefix: body.prefix,
            consignee,
            items: await readLineInputs(tx, id),
          },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.updated',
          'delivery_challans',
          id,
          {
            before: changes.before,
            after: changes.after,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/challans/:id',
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        const challan = await lockChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'draft');
        // A deleted draft takes its draft-stage serials with it (they
        // reference the lines and would otherwise orphan the delete).
        await tx`delete from challan_item_serials where delivery_challan_id = ${id}`;
        await tx`delete from delivery_challan_items where delivery_challan_id = ${id}`;
        await tx`delete from delivery_challans where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.deleted',
          'delivery_challans',
          id,
          {
            workId: challan.work_id,
          },
        );
      });
      return reply.status(204).send(null);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/challans/:id/issue',
      schema: {
        params: IdParamsSchema,
        response: { 201: ChallanDetailResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const detail = await tenant(async (tx) => {
        // Closing a PO locks purchase_orders -> linked delivery_challans.
        // Take the identical order here before locking this challan, so
        // the status re-check below cannot deadlock against a close.
        const linkedOrders = await lockLinkedPurchaseOrdersForChallan(tx, id);
        const challan = await lockChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'draft');
        await assertLinkedPurchaseOrderLocksCurrent(tx, id, linkedOrders);
        // writeLines validates the receipt link when the draft is saved,
        // but the order may have been closed or cancelled in between: a
        // closed or cancelled order takes no further receipts, and only
        // a cancellation reopens one. Re-check under the locks above so
        // the issue is refused rather than silently over-receipting.
        const unavailableOrder = linkedOrders.find(
          (order) => order.status !== 'issued',
        );
        if (unavailableOrder) {
          throw httpError(
            409,
            'PO_NOT_ISSUED',
            `Purchase order ${unavailableOrder.po_number ?? unavailableOrder.id} is no longer issued (current status: ${unavailableOrder.status}); deliveries are received against an ISSUED purchase order.`,
          );
        }

        // The works row lock pairs with the one the MB finalize
        // transaction holds: an issue and a final-MB finalize on the
        // same Work serialise here, so whichever commits second sees
        // the other — a challan issued first is caught by the final
        // sweep, and a final MB finalized first makes this issue fail
        // the FINAL_MB_EXISTS check below (the 0027 challan-update
        // guard backstops it in the database). Lock order works ->
        // work_items matches every other writer taking both.
        const [work] = await tx<
          {
            allow_excess_delivery: boolean;
            work_code: string;
            title: string;
            letter_number: string;
            letter_date: string;
            status: string;
          }[]
        >`
            select allow_excess_delivery, work_code, title, letter_number,
                   letter_date::text as letter_date, status
            from works where id = ${challan.work_id}
            for update
          `;
        if (!work) throw new Error('challan without a Work');

        // R8: a completed Work accepts no new operational documents.
        // The works lock above serialises this against completion, and
        // the 0031 challan-update guard backstops it in the database.
        assertWorkOperable(work.status, 'issuing a delivery challan');

        // A live final Measurement Book closes the Work's payment
        // cycle (spec §5.9): a challan issued after it could never be
        // billed, so the issue is refused outright.
        const [finalBook] = await tx<{ id: string; mb_number: string | null }[]>`
            select id, mb_number from measurement_books
            where work_id = ${challan.work_id} and is_final
              and status <> 'cancelled'
          `;
        if (finalBook) {
          throw httpError(
            409,
            'FINAL_MB_EXISTS',
            `The final Measurement Book ${finalBook.mb_number ?? finalBook.id} closes this Work's payment cycle; a challan issued now could never be billed.`,
          );
        }

        // Concurrency-safe quantity validation: this challan's lines plus
        // everything already ISSUED must stay within the delivery ceiling
        // COALESCE(effective_quantity, awarded_quantity) — exact numeric
        // arithmetic in SQL. The challan row lock above serialises
        // competing issues of this work's single draft, and the item row
        // locks below serialise against amendment apply (Milestone 6),
        // which takes the same locks before lowering a ceiling.
        await tx`
            select wi.id from work_items wi
            where wi.id in (
              select dci.work_item_id from delivery_challan_items dci
              where dci.delivery_challan_id = ${id}
            )
            for update
          `;
        if (!work.allow_excess_delivery) {
          const exceeded = await tx<{ item_number: string }[]>`
              select wi.item_number
              from delivery_challan_items dci
              join work_items wi on wi.id = dci.work_item_id
              where dci.delivery_challan_id = ${id}
                and dci.quantity + coalesce((
                  select sum(q.quantity)
                  from delivery_challan_items q
                  join delivery_challans dc on dc.id = q.delivery_challan_id
                  where q.work_item_id = dci.work_item_id
                    and dc.status = 'issued'
                ), 0) > coalesce(wi.effective_quantity, wi.awarded_quantity)
              order by wi.item_number
            `;
          if (exceeded.length > 0) {
            throw httpError(
              409,
              'QUANTITY_EXCEEDED',
              `Issuing would exceed the permitted quantity for: ${exceeded
                .map((row) => row.item_number)
                .join(', ')}.`,
            );
          }
        }

        // requires_serials enforcement. The challan's work_items rows
        // are locked FOR UPDATE (no flag predicate) so a concurrent
        // flag toggle serialises with this check in both orders: a
        // toggle that committed first is visible in the locked read;
        // a toggle waiting on these locks re-validates against the
        // now-issued lines after we commit. Serial recording/deletion
        // already serialises against issue through the challan row
        // lock taken above.
        const challanWorkItems = await tx<
          { id: string; item_number: string; requires_serials: boolean }[]
        >`
            select wi.id, wi.item_number, wi.requires_serials
            from work_items wi
            where wi.id in (
              select work_item_id from delivery_challan_items
              where delivery_challan_id = ${id}
            )
            order by wi.id
            for update of wi
          `;

        // R7 / rule 7: issue freezes the line snapshots written at
        // DRAFT-SAVE time (description, unit, rate) into the immutable
        // snapshot and the PDF handed to the consignee. An amendment
        // approved since then moved work_items.effective_* and never
        // touched the open draft, so issuing now would carry the
        // superseded reading forever — the quantity ledger and the
        // bill maths stay right (both read the live item), the printed
        // document does not. Silently re-snapshotting here would change
        // amounts the operator reviewed on screen a moment ago, so the
        // draft is sent back to be re-saved instead. This runs under
        // the work_items row locks taken just above, which are the same
        // locks amendment apply takes before writing effective_*, so an
        // amendment either committed before this read or waits behind
        // the issue.
        const stale = await tx<{ item_number: string; fields: string[] }[]>`
            select wi.item_number,
                   array_remove(array[
                     case when dci.description_snapshot
                       is distinct from coalesce(wi.effective_description, wi.description)
                       then 'description'::text end,
                     case when dci.unit_snapshot
                       is distinct from coalesce(wi.effective_unit, wi.unit_code)
                       then 'unit'::text end,
                     case when dci.rate_snapshot
                       is distinct from coalesce(wi.effective_unit_rate, wi.effective_rate)
                       then 'rate'::text end
                   ], null) as fields
            from delivery_challan_items dci
            join work_items wi on wi.id = dci.work_item_id
            where dci.delivery_challan_id = ${id}
              and (
                dci.description_snapshot
                  is distinct from coalesce(wi.effective_description, wi.description)
                or dci.unit_snapshot
                  is distinct from coalesce(wi.effective_unit, wi.unit_code)
                or dci.rate_snapshot
                  is distinct from coalesce(wi.effective_unit_rate, wi.effective_rate)
              )
            order by wi.item_number
          `;
        if (stale.length > 0) {
          const changed = stale
            .map((line) => `${line.item_number} (${line.fields.join(', ')})`)
            .join('; ');
          throw httpError(
            409,
            'DRAFT_STALE',
            `These items were amended after this draft was saved: ${changed}. Reopen the draft and save it to pick up the new values, then issue.`,
          );
        }

        const flaggedItemIds = challanWorkItems
          .filter((item) => item.requires_serials)
          .map((item) => item.id);
        if (flaggedItemIds.length > 0) {
          // Exact count check in SQL: recorded serials must equal the
          // line quantity (numeric comparison, no floats).
          const incomplete = await tx<
            { item_number: string; quantity: string; recorded: string }[]
          >`
              select wi.item_number, dci.quantity::text as quantity,
                     (
                       select count(*) from challan_item_serials s
                       where s.delivery_challan_item_id = dci.id
                     )::text as recorded
              from delivery_challan_items dci
              join work_items wi on wi.id = dci.work_item_id
              where dci.delivery_challan_id = ${id}
                and dci.work_item_id = any(${flaggedItemIds}::uuid[])
                and (
                  select count(*) from challan_item_serials s
                  where s.delivery_challan_item_id = dci.id
                ) <> dci.quantity
              order by wi.item_number
            `;
          if (incomplete.length > 0) {
            const detail = incomplete
              .map(
                (line) =>
                  `${line.item_number} (${line.recorded} of ${line.quantity} serials recorded)`,
              )
              .join('; ');
            throw httpError(
              409,
              'SERIALS_INCOMPLETE',
              `These items require one serial per unit before issue: ${detail}.`,
            );
          }
        }

        // Serialised per-Work numbering: the counter row lock orders
        // concurrent issues; a rolled-back transaction rolls the counter
        // back with it, so numbers are gapless per Work.
        const [counter] = await tx<{ next_value: number }[]>`
            insert into delivery_challan_counters (organisation_id, work_id)
            values (${organisationId}, ${challan.work_id})
            on conflict (organisation_id, work_id)
            do update set next_value = delivery_challan_counters.next_value + 1,
                          updated_at = now()
            returning next_value
          `;
        if (!counter) throw new Error('counter upsert returned no row');
        const sequence = counter.next_value;
        // The organisation's own format; the default is the
        // prefix/serial this route used to build by hand.
        // The Work code is a template token, so it is read here rather
        // than assumed: an organisation whose series is {WORK}-DC-{SEQ}
        // needs it, and the default never asks for it.
        const [numberWork] = await tx<{ work_code: string }[]>`
            select work_code from works where id = ${challan.work_id}
          `;
        const template = await loadNumberTemplate(tx, 'delivery_challan');
        let challanNumber: string;
        try {
          challanNumber = renderNumberTemplate(template, {
            prefix: challan.prefix,
            work: numberWork?.work_code ?? null,
            documentDate: challan.challan_date,
            sequence,
          });
        } catch (cause) {
          if (cause instanceof NumberTemplateError) {
            throw httpError(400, 'CHALLAN_NUMBER_UNFILLABLE', cause.message);
          }
          throw cause;
        }

        const [organisation] = await tx<
          { name: string; warranty_template_text: string | null }[]
        >`
            select name, warranty_template_text from organisations
            where id = app_private.current_organisation_id()
          `;
        const lines = await tx<(ChallanItemRow & { item_number: string })[]>`
            select dci.id, dci.work_item_id, dci.description_snapshot,
                   dci.unit_snapshot, dci.quantity::text as quantity,
                   dci.rate_snapshot::text as rate_snapshot,
                   dci.line_amount::text as line_amount, dci.position,
                   wi.item_number
            from delivery_challan_items dci
            join work_items wi on wi.id = dci.work_item_id
            where dci.delivery_challan_id = ${id}
            order by dci.position
          `;
        const [total] = await tx<{ amount: string }[]>`
            select coalesce(sum(line_amount), 0)::numeric(18,2)::text as amount
            from delivery_challan_items where delivery_challan_id = ${id}
          `;

        // Legacy §11: the warranty/guarantee certificate page is
        // optional — it exists exactly when the organisation has
        // template text at issue time. The FULL text is frozen into
        // the immutable snapshot (with the certificate template
        // version and the SHA-256 of the exact text), so later
        // profile edits never change an issued certificate.
        const warrantyText = organisation?.warranty_template_text ?? null;
        const warranty =
          warrantyText !== null
            ? {
                templateVersion: WARRANTY_TEMPLATE_VERSION,
                textSha256: createHash('sha256')
                  .update(warrantyText, 'utf8')
                  .digest('hex'),
                text: warrantyText,
              }
            : undefined;

        const issuedAt = new Date().toISOString();
        const snapshot: ChallanSnapshot = {
          templateVersion: CHALLAN_TEMPLATE_VERSION,
          organisationName: organisation?.name ?? '',
          challanNumber,
          challanDate: challan.challan_date,
          issuedAt,
          work: {
            workCode: work.work_code,
            title: work.title,
            letterNumber: work.letter_number,
            letterDate: work.letter_date,
          },
          consignee: parseJsonbColumn(challan.consignee_snapshot) as Consignee,
          items: lines.map((line) => ({
            position: line.position,
            itemNumber: line.item_number,
            description: line.description_snapshot,
            unit: line.unit_snapshot,
            quantity: line.quantity,
            rate: canonicalRateText(line.rate_snapshot),
            lineAmount: line.line_amount,
          })),
          totalAmount: total?.amount ?? '0.00',
          ...(warranty !== undefined ? { warranty } : {}),
        };

        await tx`
            update delivery_challans
            set status = 'issued', challan_number = ${challanNumber},
                sequence_number = ${sequence},
                issued_snapshot = ${jsonb(tx, snapshot)},
                issued_by_user_id = ${user.id}, issued_at = ${issuedAt},
                template_version = ${CHALLAN_TEMPLATE_VERSION},
                warranty_template_version = ${warranty?.templateVersion ?? null},
                warranty_text_sha256 = ${warranty?.textSha256 ?? null}
            where id = ${id}
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'NUMBER_CONFLICT',
              `Challan number ${challanNumber} already exists in this organisation; use a distinct prefix for this Work.`,
            );
          }
          throw error;
        });

        await audit(
          tx,
          organisationId,
          user.id,
          'challan.issued',
          'delivery_challans',
          id,
          {
            challanNumber,
            sequence,
            totalAmount: snapshot.totalAmount,
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
      url: '/api/challans/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelChallanRequestSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const note = cancellationNote(body.note);
      return tenant(async (tx) => {
        const [challanRef] = await tx<{ work_id: string }[]>`
          select work_id from delivery_challans where id = ${id}
        `;
        if (!challanRef) {
          throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
        }
        await assertWorkAccess(tx, user.id, challanRef.work_id);
        // Closing a PO locks purchase_orders -> linked delivery_challans.
        // Take the identical order here before locking this challan, so a
        // receipt release can reopen every affected PO without a deadlock.
        // Issued challan lines are immutable; the second read below detects
        // an exceptional concurrent raw-SQL link change and fails to retry.
        const linkedOrders = await lockLinkedPurchaseOrdersForChallan(tx, id);
        const challan = await lockChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'issued');
        await assertLinkedPurchaseOrderLocksCurrent(tx, id, linkedOrders);
        // R8: cancelling this challan would drop the delivered quantity
        // the completion predicate was measured against, leaving a Work
        // that says 'completed' below 100% executed. Lock order is the
        // creation paths' — document row first, then works — so cancel
        // and completion serialise instead of deadlocking, and the 0032
        // challan-update guard backstops the refusal in the database.
        const [work] = await tx<{ status: string }[]>`
          select status from works
          where id = ${challan.work_id} and deleted_at is null
          for update
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'cancelling a delivery challan');
        // Received goods cannot be un-delivered: once a receipt, serial,
        // or Measurement Book entry references this challan, cancellation
        // is forbidden (policy 2026-08-08; the DB trigger backs this up).
        const [evidence] = await tx<
          { receipts: string; serials: string; measurements: string }[]
        >`
          select
            (select count(*) from challan_receipts
              where delivery_challan_id = ${id})::text as receipts,
            (select count(*) from challan_item_serials
              where delivery_challan_id = ${id})::text as serials,
            (select count(*) from mb_entries
              where delivery_challan_id = ${id})::text as measurements
        `;
        if (
          evidence &&
          (evidence.receipts !== '0' ||
            evidence.serials !== '0' ||
            evidence.measurements !== '0')
        ) {
          throw httpError(
            409,
            'CHALLAN_HAS_EVIDENCE',
            'This challan has a recorded receipt, serials, or measurements and can no longer be cancelled.',
          );
        }
        // R19: a challan billed in a live Measurement Book cannot be
        // cancelled — the MB must be cancelled first (the 0024 database
        // guard backstops this against every writer).
        await assertSourceNotBilled(tx, 'delivery_challan', id);
        await tx`
          update delivery_challans
          set status = 'cancelled', cancelled_by_user_id = ${user.id},
              cancelled_at = now(), cancellation_note = ${note}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.cancelled',
          'delivery_challans',
          id,
          {
            challanNumber: challan.challan_number,
            note,
          },
        );
        // A closed PO whose receipt was just released must become receivable
        // again. Otherwise its live balance shows pending material while the
        // challan editor refuses the replacement receipt as PO_NOT_ISSUED.
        await reopenClosedPurchaseOrders(
          tx,
          organisationId,
          user.id,
          { id, challan_number: challan.challan_number },
          note,
          linkedOrders,
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/challans/:id/render',
      schema: {
        params: IdParamsSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;

      // Snapshot read and PDF write live in separate transactions so the
      // slow external call holds no database locks; the legal content is
      // the immutable issued snapshot, so re-rendering reproduces the
      // record. Branding (logo, company details) is presentation and
      // comes from the organisation's current profile.
      const { snapshot, branding } = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        const challan = await lockChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'issued');
        const [row] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from delivery_challans where id = ${id}
          `;
        const [organisation] = await tx<
          {
            address: string | null;
            gstin: string | null;
            contact_phone: string | null;
            contact_email: string | null;
            logo_object_key: string | null;
            logo_media_type: string | null;
          }[]
        >`
            select address, gstin, contact_phone, contact_email,
                   logo_object_key, logo_media_type
            from organisations
            where id = app_private.current_organisation_id()
          `;
        return {
          snapshot: parseJsonbColumn(row?.issued_snapshot) as ChallanSnapshot,
          branding: organisation ?? null,
        };
      });

      let logoDataUri: string | undefined;
      if (branding?.logo_object_key && branding.logo_media_type) {
        try {
          const logo = await storage.get(branding.logo_object_key);
          logoDataUri = `data:${branding.logo_media_type};base64,${logo.toString('base64')}`;
        } catch (error) {
          // A missing logo object must not block an issued document.
          request.log.warn({ err: error }, 'challan render: logo unavailable');
        }
      }
      const html = renderChallanHtml(snapshot, {
        ...(logoDataUri !== undefined ? { logoDataUri } : {}),
        address: branding?.address ?? null,
        gstin: branding?.gstin ?? null,
        contactPhone: branding?.contact_phone ?? null,
        contactEmail: branding?.contact_email ?? null,
      });
      const pdf = await renderPdfViaGotenberg(gotenbergUrl, html, {
        failureMessage:
          'The PDF service is unavailable; the issued challan is unaffected — retry later.',
        logError: (error) => {
          request.log.error({ err: error }, 'challan render failed');
        },
      });
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/dc/${id}.pdf`;
      await storage.put(objectKey, pdf);

      return tenant(async (tx) => {
        const updated = await tx`
          update delivery_challans
          set rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256}
          where id = ${id} and status = 'issued'
        `;
        if (updated.count === 0) {
          // The challan stopped being issued while Gotenberg rendered; the
          // stored PDF is an orphan, not evidence — no audit entry.
          throw httpError(
            409,
            'CHALLAN_STATUS_CONFLICT',
            'The challan is no longer issued; the render was discarded.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.rendered',
          'delivery_challans',
          id,
          {
            sha256,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/challans/:id/signed-copy',
      bodyLimit: MAX_PDF_BYTES,
      schema: {
        params: IdParamsSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw httpError(
          400,
          'PDF_REQUIRED',
          'Send the signed copy as an application/pdf request body.',
        );
      }
      if (!body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
        throw httpError(400, 'NOT_A_PDF', 'The uploaded file is not a PDF.');
      }
      // Authorisation before the expensive scan (ops batch): an
      // unauthorised caller must not spend scanner capacity.
      await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
      });
      await assertNotMalware(scanner, body);
      // Content-addressed key: a replacement upload gets a new object and
      // never overwrites earlier evidence; the hash is recorded like the
      // rendered PDF's.
      const signedSha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/signed/${id}-${signedSha256.slice(0, 16)}.pdf`;
      return tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        const challan = await lockChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'issued');
        await storage.put(objectKey, body);
        await tx`
          update delivery_challans
          set signed_copy_object_key = ${objectKey},
              signed_copy_sha256 = ${signedSha256}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.signed_copy_uploaded',
          'delivery_challans',
          id,
          { sizeBytes: body.length, sha256: signedSha256 },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/challans/:id/pdf',
      schema: { params: IdParamsSchema, querystring: PdfQuerySchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const { kind = 'rendered' } = request.query;
      const key = await tenant(async (tx) => {
        const [row] = await tx<
          {
            work_id: string;
            rendered_object_key: string | null;
            signed_copy_object_key: string | null;
          }[]
        >`
            select work_id, rendered_object_key, signed_copy_object_key
            from delivery_challans where id = ${id}
          `;
        if (!row) {
          throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        const found =
          kind === 'rendered' ? row.rendered_object_key : row.signed_copy_object_key;
        if (found === null) {
          throw httpError(
            404,
            'PDF_NOT_AVAILABLE',
            kind === 'rendered'
              ? 'This challan has not been rendered yet.'
              : 'No signed copy has been uploaded for this challan.',
          );
        }
        return found;
      });
      const bytes = await storage.get(key);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="challan-${id}-${kind}.pdf"`,
      );
      return reply.send(bytes);
    },
  );
}
