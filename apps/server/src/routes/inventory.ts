import {
  CreateShortagePurchaseOrderRequestSchema,
  CreateStockMovementRequestSchema,
  PendingProductionReceiptListResponseSchema,
  PurchaseOrderDetailResponseSchema,
  RecordProductionReceiptRequestSchema,
  SetReorderLevelRequestSchema,
  StockItemResponseSchema,
  StockMovementListQuerySchema,
  StockMovementListResponseSchema,
  StockMovementResponseSchema,
  StockRegisterQuerySchema,
  StockRegisterResponseSchema,
  StockShortageResponseSchema,
  withKeysetQuery,
  type ErrorCode,
  type PendingProductionReceipt,
  type ShortagePurchaseOrder,
  type StockItem,
  type StockMovement,
  type StockMovementSource,
  type StockMovementType,
  type StockShortage,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { draftConflictError } from '../draft-conflict.js';
import { httpError } from '../http.js';
import { cursorRowId, keysetPage, sqlLimit } from '../pagination.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import { assertWorkOperable } from '../work-status.js';
import {
  assertPurchaseOrderDate,
  readDetail as readPurchaseOrderDetail,
  requireVendor,
} from './purchase-orders.js';
import { audit, errorResponses, IdParamsSchema, optionalTrimmed } from './shared.js';

/**
 * The stock ledger (migration 0087).
 *
 * Three screens' worth of reading and five ways to write, all resting on
 * one append-only table. The mock draws the register at
 * `app/inventory/page.tsx` and the shortage screen at
 * `app/inventory/purchase-orders/page.tsx` (fdfe5ef).
 *
 * ## What is authoritative, and what is derived
 *
 * The ledger is the only stored fact. A balance is the last row's
 * `balance_after`, the committed quantity is the open job cards'
 * outstanding bill-of-material explosion, and a shortage is the second
 * minus the first. None of the three is a column anybody can type into,
 * which is the whole point: the mock keeps a mutable `onHand` on the item
 * AND a `balanceAfter` on every movement, and has no writer at all for
 * the `reserved` it subtracts.
 *
 * ## Where the rules live
 *
 * Every refusal below is made twice. The route makes it first, under no
 * lock, so an operator gets a named 409 with a remedy pointing at the
 * movement that fixes it. `app_private.guard_stock_movement()` makes it
 * again inside the insert, under the per-item counter lock — which is the
 * arm that holds when two operators issue the last unit at the same
 * moment, and the arm that holds when a writer reaches the table by
 * another path. The route can name the problem; only the trigger can be
 * right about it.
 *
 * ## Permissions, and why no new authority
 *
 * A stock movement is site and store work — the same class of act as
 * recording a delivery or an installation — so it is `role: 'writer'`
 * throughout. Nothing here issues a numbered document: the one act that
 * creates one, raising a purchase order from a shortage, creates a DRAFT
 * and stops, and the `issue` authority still guards the moment that draft
 * becomes an order (`routes/purchase-orders.ts`).
 *
 * ## Work-scope
 *
 * Stock belongs to the ORGANISATION, not to a Work: one shelf serves every
 * contract, and a part bought for one Work is routinely consumed by
 * another. So the register and the ledger are not work-scoped, and an
 * 'assigned'-scope member sees every part and every movement. What that
 * member does NOT see is which Work a movement served: `sourceLabel`
 * answers null where the Work is out of scope, exactly as it would if the
 * Work had been deleted. The shortage screen's purchase orders ARE
 * work-scoped, because a purchase order is a Work's document and the
 * procurement module already treats it as one.
 */

/**
 * The database's own refusals, mapped to named codes.
 *
 * Migration 0087 raises with SQLSTATEs from the 23F block, one per rule,
 * so a guard that fires because the route's own check lost a race
 * surfaces as the same 409 an operator would have got from the route —
 * not as an unexplained 500.
 */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23F01': [
    'STOCK_INSUFFICIENT',
    'The shelf ran out while this movement was being posted; another issue against the same part committed first.',
  ],
  '23F02': [
    'STOCK_SOURCE_INVALID',
    'The document this movement names stopped admitting it while the movement was being posted.',
  ],
  '23F03': [
    'STOCK_MOVEMENT_INVALID',
    'The stock ledger refused this movement; check the part and the date and try again.',
  ],
  // A second receipt against one despatch loses the race to the unique
  // index rather than to a guard, so it arrives as 23505.
  '23505': [
    'STOCK_DISPATCH_RECEIVED',
    'This despatch was taken into stock while this receipt was being posted.',
  ],
};

function rethrowWriteRefusal(error: unknown): never {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  const refusal = DATABASE_REFUSALS[code];
  if (refusal !== undefined) throw httpError(409, refusal[0], refusal[1]);
  throw error;
}

/** `PP-26-081` — the job card as production names it.
 *
 * Built from the financial year and the sequence, because both halves are
 * columns and 0084 deliberately stores no third copy of the assembled
 * string (`JobCardSummary.number` in `@auto-mb/contracts` says so). The
 * production module will build the same string from the same two columns
 * when its own routes land; the format is the contract's, not this
 * module's, and this is the second reader of it rather than a second
 * definition. */
function jobCardNumber(fyLabel: string, sequenceNumber: number): string {
  return `PP-${fyLabel.slice(2, 4)}-${String(sequenceNumber).padStart(3, '0')}`;
}

/** `SM/EL-SMPS-2410/17` — a movement's identity on screen. The mock
 * renders a `referenceNumber` per movement; here it is the item's code and
 * the movement's ledger position, which together already name the row
 * uniquely, so nothing is stored a third time. */
function movementReference(itemCode: string, sequenceNumber: number): string {
  return `SM/${itemCode}/${String(sequenceNumber)}`;
}

/** Which of the four source shapes a stored row is in. Derived from which
 * key is present, so the wire value and the row cannot disagree. */
function sourceOf(row: {
  readonly production_dispatch_id: string | null;
  readonly purchase_order_line_id: string | null;
  readonly production_job_card_id: string | null;
  readonly work_id: string | null;
}): StockMovementSource {
  if (row.production_dispatch_id !== null) return 'production_dispatch';
  if (row.purchase_order_line_id !== null) return 'purchase_order';
  if (row.production_job_card_id !== null) return 'job_card';
  if (row.work_id !== null) return 'work';
  return 'none';
}

// --- Row shapes -------------------------------------------------------------

interface StockItemRow {
  id: string;
  item_code: string;
  name: string;
  category: string;
  unit: string;
  manufactured: boolean;
  serial_controlled: boolean;
  active: boolean;
  reorder_level: string | null;
  on_hand: string;
  committed: string;
  available: string;
  below_reorder_level: boolean;
}

function toStockItem(row: StockItemRow): StockItem {
  return {
    id: row.id,
    itemCode: row.item_code,
    name: row.name,
    category: row.category,
    unit: row.unit,
    manufactured: row.manufactured,
    serialControlled: row.serial_controlled,
    active: row.active,
    reorderLevel: row.reorder_level,
    onHand: row.on_hand,
    committed: row.committed,
    available: row.available,
    belowReorderLevel: row.below_reorder_level,
  };
}

interface MovementRow {
  id: string;
  sequence_number: number;
  production_item_id: string;
  item_code: string;
  item_name: string;
  unit: string;
  movement_type: StockMovementType;
  quantity: string;
  balance_after: string;
  movement_date: string;
  production_dispatch_id: string | null;
  purchase_order_line_id: string | null;
  production_job_card_id: string | null;
  work_id: string | null;
  source_label: string | null;
  reason: string | null;
  counterparty: string | null;
  created_at: Date;
}

function toMovement(row: MovementRow): StockMovement {
  return {
    id: row.id,
    reference: movementReference(row.item_code, Number(row.sequence_number)),
    itemId: row.production_item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    unit: row.unit,
    movementType: row.movement_type,
    quantity: row.quantity,
    balanceAfter: row.balance_after,
    movementDate: row.movement_date,
    source: sourceOf(row),
    sourceLabel: row.source_label,
    reason: row.reason,
    counterparty: row.counterparty,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The register's rows, and the summary over the same set.
 *
 * `committed` is aggregated from `app_private.stock_outstanding_requirement`
 * — ONE call per statement, grouped, rather than a correlated call per
 * item, because the function explodes every open job card's bill of
 * material and doing that once per row would explode it once per row.
 */
const STOCK_ITEM_SELECT = `
  select i.id, i.item_code, i.name, i.category, i.unit, i.manufactured,
         i.serial_controlled, i.active,
         i.reorder_level::text as reorder_level,
         balance.on_hand::text as on_hand,
         coalesce(committed.required, 0)::text as committed,
         (balance.on_hand - coalesce(committed.required, 0))::text as available,
         (
           i.reorder_level is not null
           and balance.on_hand - coalesce(committed.required, 0) <= i.reorder_level
         ) as below_reorder_level
  from production_items i
  cross join lateral (
    select app_private.stock_on_hand(i.organisation_id, i.id) as on_hand
  ) balance
  left join (
    select r.component_item_id, sum(r.required) as required
    from app_private.stock_outstanding_requirement($1::uuid) r
    group by r.component_item_id
  ) committed on committed.component_item_id = i.id
  where i.organisation_id = $1::uuid
`;

async function readStockItem(
  tx: TransactionSql,
  organisationId: string,
  itemId: string,
): Promise<StockItem> {
  const rows = (await tx.unsafe(`${STOCK_ITEM_SELECT} and i.id = $2::uuid`, [
    organisationId,
    itemId,
  ])) as unknown as StockItemRow[];
  const row = rows[0];
  if (!row) throw httpError(404, 'STOCK_ITEM_NOT_FOUND', 'No such part.');
  return toStockItem(row);
}

/** The part, proven to exist in this tenant before anything is posted
 * against it. RLS has already narrowed the table, so an unknown id and
 * another tenant's id answer identically. */
async function requireItem(
  tx: TransactionSql,
  itemId: string,
): Promise<{ id: string; unit: string; item_code: string; active: boolean }> {
  const [row] = await tx<
    { id: string; unit: string; item_code: string; active: boolean }[]
  >`
    select id, unit, item_code, active from production_items where id = ${itemId}
  `;
  if (!row) throw httpError(404, 'STOCK_ITEM_NOT_FOUND', 'No such part.');
  return row;
}

/**
 * Reads back the movements a write just made, or a page of the register.
 *
 * `sourceLabel` is built in SQL from whichever document the row names.
 * The Work code is the one label gated by work-scope: a member assigned to
 * two Works may see that material left the shelf, and may not learn which
 * third Work it left for.
 */
async function readMovements(
  tx: TransactionSql,
  parameters: {
    readonly userId: string;
    readonly fullScope: boolean;
    readonly itemId: string | null;
    readonly movementId: string | null;
    readonly cursorId: string | null;
    readonly limit: number | null;
  },
): Promise<MovementRow[]> {
  return tx<MovementRow[]>`
    select m.id, m.sequence_number, m.production_item_id,
           i.item_code, i.name as item_name, i.unit,
           m.movement_type, m.quantity::text as quantity,
           m.balance_after::text as balance_after,
           m.movement_date::text as movement_date,
           m.production_dispatch_id, m.purchase_order_line_id,
           m.production_job_card_id, m.work_id,
           case
             when m.production_dispatch_id is not null then
               'PP-' || substr(dispatch_card.fy_label, 3, 2) || '-'
                 || lpad(dispatch_card.sequence_number::text, 3, '0')
                 || '/D' || dispatch.sequence_number::text
             when m.purchase_order_line_id is not null then
               coalesce(purchase_order.po_number, 'Draft purchase order')
             when m.production_job_card_id is not null then
               'PP-' || substr(card.fy_label, 3, 2) || '-'
                 || lpad(card.sequence_number::text, 3, '0')
             when m.work_id is not null then
               case
                 when ${parameters.fullScope} or exists (
                   select 1 from work_assignments wa
                   where wa.work_id = m.work_id and wa.user_id = ${parameters.userId}
                 ) then work.work_code
                 else null
               end
             else null
           end as source_label,
           m.reason, m.counterparty, m.created_at
    from stock_movements m
    join production_items i on i.id = m.production_item_id
    left join production_dispatches dispatch on dispatch.id = m.production_dispatch_id
    left join production_job_cards dispatch_card
      on dispatch_card.id = dispatch.job_card_id
    left join purchase_order_lines line on line.id = m.purchase_order_line_id
    left join purchase_orders purchase_order
      on purchase_order.id = line.purchase_order_id
    left join production_job_cards card on card.id = m.production_job_card_id
    left join works work on work.id = m.work_id
    where (${parameters.itemId}::uuid is null or m.production_item_id = ${parameters.itemId})
      and (${parameters.movementId}::uuid is null or m.id = ${parameters.movementId})
      and (
        ${parameters.cursorId}::uuid is null
        or (m.movement_date, m.created_at, m.id) < (
          select cursor_row.movement_date, cursor_row.created_at, cursor_row.id
          from stock_movements cursor_row
          where cursor_row.id = ${parameters.cursorId}
        )
      )
    order by m.movement_date desc, m.created_at desc, m.id desc
    limit ${parameters.limit}
  `;
}

/** The one movement a write just created, read back through the same
 * projection every list uses so a posted row and a listed row can never
 * render differently. */
async function readMovement(
  tx: TransactionSql,
  userId: string,
  fullScope: boolean,
  movementId: string,
): Promise<StockMovement> {
  const rows = await readMovements(tx, {
    userId,
    fullScope,
    itemId: null,
    movementId,
    cursorId: null,
    limit: 1,
  });
  const row = rows[0];
  if (!row) throw new Error('stock movement insert returned no readable row');
  return toMovement(row);
}

// --- Write-side rules the route states first --------------------------------

/** The sign belongs to the movement type, and the request never carries
 * it: `quantity` on the wire is always the magnitude an operator typed. */
function signedQuantity(type: StockMovementType, magnitude: string): string {
  return type === 'issue' || type === 'adjustment_out' ? `-${magnitude}` : magnitude;
}

/**
 * The source shape, checked before the row is built.
 *
 * `stock_movements_source_shape_check` refuses the same combinations, and
 * would arrive as a bare 23514 — a 500 with no field named. This is the
 * same rule said in a sentence, at the boundary, where the operator can
 * act on it.
 */
function assertSourceShape(body: {
  readonly movementType: StockMovementType;
  readonly purchaseOrderLineId?: string;
  readonly productionJobCardId?: string;
  readonly workId?: string;
  readonly reason?: string;
}): void {
  const refuse = (message: string): never => {
    throw httpError(400, 'STOCK_MOVEMENT_INVALID', message);
  };
  const isAdjustment =
    body.movementType === 'adjustment_in' || body.movementType === 'adjustment_out';
  const isTransfer = body.movementType === 'issue' || body.movementType === 'return';

  if (body.movementType === 'purchase_receipt') {
    if (body.purchaseOrderLineId === undefined) {
      refuse('A purchase receipt names the purchase order line it received against.');
    }
  } else if (body.purchaseOrderLineId !== undefined) {
    refuse('Only a purchase receipt names a purchase order line.');
  }

  if (isTransfer) {
    if ((body.productionJobCardId === undefined) === (body.workId === undefined)) {
      refuse(
        `An ${body.movementType === 'issue' ? 'issue' : 'return'} names exactly one destination: a job card or a Work.`,
      );
    }
  } else if (body.productionJobCardId !== undefined || body.workId !== undefined) {
    refuse('Only an issue or a return names a job card or a Work.');
  }

  if (isAdjustment) {
    if (body.reason === undefined) {
      refuse('An adjustment carries the reason the shelf count was wrong.');
    }
  } else if (body.reason !== undefined) {
    refuse(
      'Only an adjustment carries a reason; every other movement names the document that caused it.',
    );
  }
}

/** The organisation's own today, which is what the ledger bounds a
 * movement date against — a movement posted at 00:30 IST is not in the
 * future because a server in UTC thinks it is still yesterday. */
async function assertNotFutureDated(
  tx: TransactionSql,
  organisationId: string,
  movementDate: string,
): Promise<void> {
  const [row] = await tx<{ today: string }[]>`
    select app_private.organisation_today(${organisationId})::text as today
  `;
  const today = row?.today;
  if (today !== undefined && movementDate > today) {
    throw httpError(
      400,
      'STOCK_MOVEMENT_INVALID',
      `A stock movement cannot be dated in the future (today is ${today}).`,
    );
  }
}

/** A movement naming a job card or a Work reaches a Work, and a Work is
 * work-scoped even though the shelf is not. Returns the Work the movement
 * touches, so the caller can check it is still operable. */
async function assertDestinationReachable(
  tx: TransactionSql,
  userId: string,
  body: { readonly productionJobCardId?: string; readonly workId?: string },
): Promise<void> {
  if (body.workId !== undefined) {
    await assertWorkAccess(tx, userId, body.workId);
    const [work] = await tx<{ status: string }[]>`
      select status from works where id = ${body.workId} and deleted_at is null
    `;
    if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
    assertWorkOperable(work.status, 'posting a stock movement');
    return;
  }
  if (body.productionJobCardId === undefined) return;
  const [card] = await tx<{ status: string; work_id: string | null }[]>`
    select status, work_id from production_job_cards
    where id = ${body.productionJobCardId}
  `;
  if (!card) {
    throw httpError(404, 'PRODUCTION_JOB_CARD_NOT_FOUND', 'No such job card.');
  }
  if (card.work_id !== null) await assertWorkAccess(tx, userId, card.work_id);
  if (card.status !== 'planned' && card.status !== 'in_production') {
    throw httpError(
      409,
      'STOCK_SOURCE_INVALID',
      `This job card is ${card.status} and takes no stock movement.`,
    );
  }
}

// --- Routes -----------------------------------------------------------------

export function registerInventoryRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'GET',
      url: '/api/stock/items',
      schema: {
        querystring: withKeysetQuery(StockRegisterQuerySchema),
        response: { 200: StockRegisterResponseSchema, ...errorResponses },
      },
    },
    async ({ request, organisationId, tenant }) => {
      const { limit, cursor, status } = request.query;
      const activeOnly = status === 'active';
      return tenant(async (tx) => {
        const cursorId = await cursorRowId(tx, 'production_items', cursor);
        // Ordered by the register's own sort — category then name, the
        // mock's `production_items_catalogue_idx` order — with the id
        // breaking ties so the keyset has a total order to seek on.
        const rows = (await tx.unsafe(
          `${STOCK_ITEM_SELECT}
             and ($2::boolean = false or i.active)
             and (
               $3::uuid is null
               or (lower(i.category), lower(i.name), i.id) > (
                 select lower(c.category), lower(c.name), c.id
                 from production_items c where c.id = $3::uuid
               )
             )
           order by lower(i.category), lower(i.name), i.id
           limit $4::int`,
          [organisationId, activeOnly, cursorId, sqlLimit(limit)],
        )) as unknown as StockItemRow[];

        // Register-WIDE, so the stat tiles do not describe one page of a
        // keyset. Counts of parts rather than the mock's sums of
        // quantities: see the contract for why adding Nos to Kg is not a
        // number.
        const [summary] = (await tx.unsafe(
          `select
             count(*) filter (where source.active) as parts_tracked,
             count(*) filter (
               where source.active and source.below_reorder_level
             ) as parts_below_reorder_level,
             count(*) filter (
               where source.available::numeric < 0
             ) as parts_short
           from (${STOCK_ITEM_SELECT}) source`,
          [organisationId],
        )) as unknown as {
          parts_tracked: string;
          parts_below_reorder_level: string;
          parts_short: string;
        }[];

        const page = keysetPage(rows, limit, (row) => row.id);
        return {
          items: page.rows.map(toStockItem),
          nextCursor: page.nextCursor,
          summary: {
            partsTracked: Number(summary?.parts_tracked ?? 0),
            partsBelowReorderLevel: Number(summary?.parts_below_reorder_level ?? 0),
            partsShort: Number(summary?.parts_short ?? 0),
          },
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/stock/items/:id/reorder-level',
      schema: {
        params: IdParamsSchema,
        body: SetReorderLevelRequestSchema,
        response: { 200: StockItemResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { reorderLevel } = request.body;
      return tenant(async (tx) => {
        const item = await requireItem(tx, id);
        const [before] = await tx<{ reorder_level: string | null }[]>`
          select reorder_level::text as reorder_level
          from production_items where id = ${id} for update
        `;
        await tx`
          update production_items set reorder_level = ${reorderLevel} where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'stock.reorder_level_set',
          'production_items',
          id,
          {
            itemCode: item.item_code,
            before: before?.reorder_level ?? null,
            after: reorderLevel,
          },
        );
        return { item: await readStockItem(tx, organisationId, id) };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/stock/movements',
      schema: {
        querystring: withKeysetQuery(StockMovementListQuerySchema),
        response: { 200: StockMovementListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { limit, cursor, itemId } = request.query;
      return tenant(async (tx) => {
        const cursorId = await cursorRowId(tx, 'stock_movements', cursor);
        const rows = await readMovements(tx, {
          userId: user.id,
          fullScope: await hasFullWorkScope(tx, user.id),
          itemId: itemId ?? null,
          movementId: null,
          cursorId,
          limit: sqlLimit(limit),
        });
        const page = keysetPage(rows, limit, (row) => row.id);
        return {
          movements: page.rows.map(toMovement),
          nextCursor: page.nextCursor,
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/stock/movements',
      schema: {
        body: CreateStockMovementRequestSchema,
        response: { 201: StockMovementResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const reason = optionalTrimmed(body.reason) ?? null;
      const counterparty = optionalTrimmed(body.counterparty) ?? null;

      const movement = await tenant(async (tx) => {
        // INSIDE the bound transaction, so the membership wall answers
        // first. Checked out here it ran before `tenant()` had proved
        // anything, and a non-member posting a malformed body learned
        // that the field was malformed — a 400 where every other route
        // in the product answers 403. Shape refusals are for callers who
        // are allowed to be here.
        assertSourceShape(body);
        const item = await requireItem(tx, body.productionItemId);
        await assertNotFutureDated(tx, organisationId, body.movementDate);
        await assertDestinationReachable(tx, user.id, body);

        // A retired part takes nothing more in. Said here so the refusal
        // names the part; the guard says it again for every other writer.
        const inbound =
          body.movementType !== 'issue' && body.movementType !== 'adjustment_out';
        if (!item.active && inbound) {
          throw httpError(
            409,
            'STOCK_MOVEMENT_INVALID',
            `${item.item_code} is retired and takes no further stock in.`,
          );
        }

        if (body.purchaseOrderLineId !== undefined) {
          const [line] = await tx<
            { production_item_id: string | null; status: string; work_id: string }[]
          >`
            select pol.production_item_id, po.status, po.work_id
            from purchase_order_lines pol
            join purchase_orders po on po.id = pol.purchase_order_id
            where pol.id = ${body.purchaseOrderLineId}
          `;
          if (!line) {
            throw httpError(
              404,
              'PURCHASE_ORDER_NOT_FOUND',
              'No such purchase order line.',
            );
          }
          // The order is a Work's document even though the shelf is not.
          await assertWorkAccess(tx, user.id, line.work_id);
          if (line.production_item_id !== body.productionItemId) {
            throw httpError(
              409,
              'STOCK_SOURCE_INVALID',
              `This purchase order line does not buy ${item.item_code}. Only a line raised from a shortage names a part.`,
            );
          }
          if (line.status !== 'issued') {
            throw httpError(
              409,
              'STOCK_SOURCE_INVALID',
              `This purchase order is ${line.status}; material is received against an issued order.`,
            );
          }
        }

        // The on-hand read is advisory ONLY: it makes the refusal say how
        // much is actually there. The binding check is the guard's, under
        // the counter lock, and the column CHECK behind that.
        if (!inbound) {
          const [balance] = await tx<{ on_hand: string }[]>`
            select app_private.stock_on_hand(${organisationId}, ${body.productionItemId})::text as on_hand
          `;
          const onHand = balance?.on_hand ?? '0';
          if (Number(onHand) < Number(body.quantity)) {
            throw httpError(
              409,
              'STOCK_INSUFFICIENT',
              `${item.item_code} holds ${onHand} ${item.unit} and cannot release ${body.quantity}.`,
            );
          }
        }

        const [created] = await tx<{ id: string }[]>`
          insert into stock_movements (
            organisation_id, production_item_id, movement_type,
            quantity, movement_date, purchase_order_line_id,
            production_job_card_id, work_id, reason, counterparty,
            created_by_user_id
          )
          values (
            ${organisationId}, ${body.productionItemId}, ${body.movementType},
            ${signedQuantity(body.movementType, body.quantity)},
            ${body.movementDate}, ${body.purchaseOrderLineId ?? null},
            ${body.productionJobCardId ?? null}, ${body.workId ?? null},
            ${reason}, ${counterparty}, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!created) throw new Error('stock movement insert returned no row');

        await audit(
          tx,
          organisationId,
          user.id,
          'stock.movement_posted',
          'stock_movements',
          created.id,
          {
            itemCode: item.item_code,
            movementType: body.movementType,
            quantity: signedQuantity(body.movementType, body.quantity),
            movementDate: body.movementDate,
            purchaseOrderLineId: body.purchaseOrderLineId ?? null,
            productionJobCardId: body.productionJobCardId ?? null,
            workId: body.workId ?? null,
            reason,
          },
        );
        return readMovement(
          tx,
          user.id,
          await hasFullWorkScope(tx, user.id),
          created.id,
        );
      });
      return reply.status(201).send({ movement });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/stock/production-receipts',
      schema: {
        response: {
          200: PendingProductionReceiptListResponseSchema,
          ...errorResponses,
        },
      },
    },
    async ({ tenant }) => {
      const dispatches = await tenant(async (tx) => {
        // A despatch with no stock receipt behind it. Listed because the
        // alternative is a shelf that is quietly understated: production
        // has said the units left the factory, and until somebody takes
        // them in, the register says they do not exist.
        return tx<
          {
            id: string;
            fy_label: string;
            card_sequence: number;
            dispatch_sequence: number;
            dispatched_on: string;
            item_id: string;
            item_code: string;
            item_name: string;
            unit: string;
            quantity: string;
          }[]
        >`
          select d.id, card.fy_label, card.sequence_number as card_sequence,
                 d.sequence_number as dispatch_sequence,
                 d.dispatched_on::text as dispatched_on,
                 card.item_id, i.item_code, i.name as item_name, i.unit,
                 count(ds.production_serial_id)::text as quantity
          from production_dispatches d
          join production_job_cards card on card.id = d.job_card_id
          join production_items i on i.id = card.item_id
          join production_dispatch_serials ds on ds.production_dispatch_id = d.id
          where not exists (
            select 1 from stock_movements m where m.production_dispatch_id = d.id
          )
          group by d.id, card.fy_label, card.sequence_number, d.sequence_number,
                   d.dispatched_on, card.item_id, i.item_code, i.name, i.unit
          order by d.dispatched_on desc, d.id
        `;
      });
      return {
        dispatches: dispatches.map((row): PendingProductionReceipt => ({
          productionDispatchId: row.id,
          reference: `${jobCardNumber(row.fy_label, Number(row.card_sequence))}/D${String(row.dispatch_sequence)}`,
          dispatchedOn: row.dispatched_on,
          itemId: row.item_id,
          itemCode: row.item_code,
          itemName: row.item_name,
          unit: row.unit,
          quantity: row.quantity,
        })),
      };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/stock/production-receipts',
      schema: {
        body: RecordProductionReceiptRequestSchema,
        response: { 201: StockMovementResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const counterparty = optionalTrimmed(body.counterparty) ?? null;
      const movement = await tenant(async (tx) => {
        // PRODUCTION STATES THE QUANTITY. The units are counted from the
        // despatch's own lines rather than typed, exactly as migration
        // 0084 § 7 asks, and the guard counts them again inside the
        // insert so the two cannot drift apart.
        const [dispatch] = await tx<
          { item_id: string; item_code: string; units: string }[]
        >`
          select card.item_id, i.item_code, count(ds.production_serial_id)::text as units
          from production_dispatches d
          join production_job_cards card on card.id = d.job_card_id
          join production_items i on i.id = card.item_id
          join production_dispatch_serials ds on ds.production_dispatch_id = d.id
          where d.id = ${body.productionDispatchId}
          group by card.item_id, i.item_code
        `;
        if (!dispatch) {
          throw httpError(
            404,
            'PRODUCTION_DISPATCH_NOT_FOUND',
            'No such despatch, or it released no units.',
          );
        }
        await assertNotFutureDated(tx, organisationId, body.movementDate);

        const [existing] = await tx<{ id: string }[]>`
          select id from stock_movements
          where production_dispatch_id = ${body.productionDispatchId}
        `;
        if (existing) {
          throw httpError(
            409,
            'STOCK_DISPATCH_RECEIVED',
            'This despatch is already on the shelf.',
          );
        }

        const [created] = await tx<{ id: string }[]>`
          insert into stock_movements (
            organisation_id, production_item_id, movement_type,
            quantity, movement_date, production_dispatch_id,
            counterparty, created_by_user_id
          )
          values (
            ${organisationId}, ${dispatch.item_id}, 'production_receipt',
            ${dispatch.units}, ${body.movementDate},
            ${body.productionDispatchId}, ${counterparty}, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!created) throw new Error('stock movement insert returned no row');

        await audit(
          tx,
          organisationId,
          user.id,
          'stock.production_received',
          'stock_movements',
          created.id,
          {
            itemCode: dispatch.item_code,
            productionDispatchId: body.productionDispatchId,
            quantity: dispatch.units,
            movementDate: body.movementDate,
          },
        );
        return readMovement(
          tx,
          user.id,
          await hasFullWorkScope(tx, user.id),
          created.id,
        );
      });
      return reply.status(201).send({ movement });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/stock/shortages',
      schema: {
        response: { 200: StockShortageResponseSchema, ...errorResponses },
      },
    },
    async ({ user, organisationId, tenant }) => {
      return tenant(async (tx) => {
        const fullScope = await hasFullWorkScope(tx, user.id);
        // One row per PART, with its contributing job cards nested — see
        // the contract for why the mock's row-per-(plan, part) with a
        // checkbox on each is an order placed twice.
        const rows = await tx<
          {
            item_id: string;
            item_code: string;
            name: string;
            unit: string;
            required: string;
            on_hand: string;
            shortage: string;
            job_cards: {
              id: string;
              number: string;
              workId: string | null;
              workCode: string | null;
              required: string;
            }[];
          }[]
        >`
          with requirement as (
            select r.job_card_id, r.component_item_id, r.required
            from app_private.stock_outstanding_requirement(${organisationId}) r
          ),
          per_item as (
            select requirement.component_item_id,
                   sum(requirement.required) as required,
                   app_private.stock_on_hand(
                     ${organisationId}, requirement.component_item_id
                   ) as on_hand
            from requirement
            group by requirement.component_item_id
          )
          select per_item.component_item_id as item_id, i.item_code, i.name, i.unit,
                 per_item.required::text as required,
                 per_item.on_hand::text as on_hand,
                 (per_item.required - per_item.on_hand)::text as shortage,
                 (
                   select coalesce(
                     json_agg(
                       json_build_object(
                         'id', card.id,
                         'number', 'PP-' || substr(card.fy_label, 3, 2) || '-'
                           || lpad(card.sequence_number::text, 3, '0'),
                         'workId', case
                           when card.work_id is null then null
                           when ${fullScope} or exists (
                             select 1 from work_assignments wa
                             where wa.work_id = card.work_id and wa.user_id = ${user.id}
                           ) then card.work_id::text
                           else null
                         end,
                         'workCode', case
                           when card.work_id is null then null
                           when ${fullScope} or exists (
                             select 1 from work_assignments wa
                             where wa.work_id = card.work_id and wa.user_id = ${user.id}
                           ) then w.work_code
                           else null
                         end,
                         'required', contribution.required::text
                       )
                       order by card.due_date, card.id
                     ),
                     '[]'::json
                   )
                   from requirement contribution
                   join production_job_cards card on card.id = contribution.job_card_id
                   left join works w on w.id = card.work_id
                   where contribution.component_item_id = per_item.component_item_id
                 ) as job_cards
          from per_item
          join production_items i on i.id = per_item.component_item_id
          where per_item.required > per_item.on_hand
          order by i.item_code
        `;

        // The screen's right-hand column. Work-scoped, because a purchase
        // order is a Work's document even though the shortage that caused
        // it is the organisation's.
        const orders = await tx<
          {
            id: string;
            work_id: string;
            po_number: string | null;
            status: string;
            vendor_designation: string;
            po_date: string;
            expected_on: string | null;
            job_card_numbers: string[];
            lines: {
              productionItemId: string;
              itemCode: string;
              name: string;
              unit: string;
              ordered: string;
              received: string;
            }[];
          }[]
        >`
          select po.id, po.work_id, po.po_number, po.status,
                 coalesce(po.vendor_snapshot->>'designation', c.designation)
                   as vendor_designation,
                 po.po_date::text as po_date,
                 po.expected_on::text as expected_on,
                 (
                   select coalesce(array_agg(distinct
                     'PP-' || substr(card.fy_label, 3, 2) || '-'
                       || lpad(card.sequence_number::text, 3, '0')
                   ), '{}')
                   from purchase_order_lines pol
                   join production_job_cards card
                     on card.id = pol.production_job_card_id
                   where pol.purchase_order_id = po.id
                 ) as job_card_numbers,
                 (
                   select coalesce(
                     json_agg(
                       json_build_object(
                         'productionItemId', pol.production_item_id,
                         'itemCode', i.item_code,
                         'name', i.name,
                         'unit', i.unit,
                         'ordered', pol.quantity::text,
                         'received', coalesce((
                           select sum(m.quantity)
                           from stock_movements m
                           where m.purchase_order_line_id = pol.id
                         ), 0)::text
                       )
                       order by pol.line_number
                     ),
                     '[]'::json
                   )
                   from purchase_order_lines pol
                   join production_items i on i.id = pol.production_item_id
                   where pol.purchase_order_id = po.id
                     and pol.production_item_id is not null
                 ) as lines
          from purchase_orders po
          join contacts c on c.id = po.vendor_contact_id
          where po.status in ('draft', 'issued')
            and exists (
              select 1 from purchase_order_lines pol
              where pol.purchase_order_id = po.id
                and pol.production_job_card_id is not null
            )
            and (${fullScope} or exists (
              select 1 from work_assignments wa
              where wa.work_id = po.work_id and wa.user_id = ${user.id}
            ))
          order by po.po_date desc, po.id
          limit 50
        `;

        return {
          shortages: rows.map((row): StockShortage => ({
            itemId: row.item_id,
            itemCode: row.item_code,
            name: row.name,
            unit: row.unit,
            required: row.required,
            onHand: row.on_hand,
            shortage: row.shortage,
            jobCards: row.job_cards,
          })),
          purchaseOrders: orders.map((row): ShortagePurchaseOrder => ({
            id: row.id,
            workId: row.work_id,
            poNumber: row.po_number,
            status: row.status,
            vendorDesignation: row.vendor_designation,
            poDate: row.po_date,
            expectedOn: row.expected_on,
            jobCardNumbers: row.job_card_numbers,
            lines: row.lines,
          })),
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/stock/shortages/purchase-order',
      schema: {
        body: CreateShortagePurchaseOrderRequestSchema,
        response: { 201: PurchaseOrderDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const detail = await tenant(async (tx) => {
        const [card] = await tx<
          {
            id: string;
            status: string;
            work_id: string | null;
            fy_label: string;
            sequence_number: number;
          }[]
        >`
          select id, status, work_id, fy_label, sequence_number
          from production_job_cards where id = ${body.jobCardId}
        `;
        if (!card) {
          throw httpError(404, 'PRODUCTION_JOB_CARD_NOT_FOUND', 'No such job card.');
        }
        // A purchase order belongs to a Work, and 0033 says so with a NOT
        // NULL column, a per-Work counter and a per-Work authorization
        // check. A job card serving a private purchase order has no Work
        // to raise one against; migration 0087's header records why
        // relaxing that is its own pack.
        if (card.work_id === null) {
          throw httpError(
            409,
            'STOCK_JOB_CARD_HAS_NO_WORK',
            `Job card ${jobCardNumber(card.fy_label, Number(card.sequence_number))} serves a private purchase order, and a purchase order is raised against a Work.`,
          );
        }
        const workId = card.work_id;
        await assertWorkAccess(tx, user.id, workId);
        if (card.status !== 'planned' && card.status !== 'in_production') {
          throw httpError(
            409,
            'STOCK_SOURCE_INVALID',
            `This job card is ${card.status}; material is ordered for a card that is still being built.`,
          );
        }

        // The Work's own lock, taken in the same order and for the same
        // reason `POST /api/works/:id/purchase-orders` takes it: a draft
        // created here can never appear behind a completed Work's
        // refusals.
        const [work] = await tx<{ status: string }[]>`
          select status from works where id = ${workId} and deleted_at is null
          for update
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'drafting a purchase order');
        await assertPurchaseOrderDate(tx, workId, body.poDate);
        await requireVendor(tx, body.vendorContactId);

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

        // THE QUANTITY IS THE SERVER'S. The request names parts, never
        // amounts: the shortage is recomputed here, inside the same
        // transaction that writes the lines, so what is ordered is what
        // was short at the moment of ordering rather than what a screen
        // was showing some seconds ago.
        const shortages = await tx<
          {
            item_id: string;
            item_code: string;
            unit: string;
            name: string;
            shortage: string;
          }[]
        >`
          with requirement as (
            select r.component_item_id, sum(r.required) as required
            from app_private.stock_outstanding_requirement(${organisationId}) r
            group by r.component_item_id
          )
          select i.id as item_id, i.item_code, i.unit, i.name,
                 (requirement.required
                   - app_private.stock_on_hand(${organisationId}, i.id))::text as shortage
          from requirement
          join production_items i on i.id = requirement.component_item_id
          where i.id = any(${body.productionItemIds}::uuid[])
            and requirement.required
                > app_private.stock_on_hand(${organisationId}, i.id)
          order by i.item_code
        `;
        const found = new Set(shortages.map((row) => row.item_id));
        const missing = body.productionItemIds.filter((id) => !found.has(id));
        if (missing.length > 0) {
          throw httpError(
            409,
            'STOCK_NOT_SHORT',
            `${String(missing.length)} of the selected parts ${missing.length === 1 ? 'is' : 'are'} no longer short — reload the shortage list and choose again.`,
          );
        }

        const [order] = await tx<{ id: string }[]>`
          insert into purchase_orders (
            organisation_id, work_id, vendor_contact_id, po_date, expected_on,
            created_by_user_id
          )
          values (
            ${organisationId}, ${workId}, ${body.vendorContactId}, ${body.poDate},
            ${body.expectedOn ?? null}, ${user.id}
          )
          returning id
        `;
        if (!order) throw new Error('purchase order insert returned no row');

        // NIL RATES, deliberately. The shortage screen knows what to buy
        // and not what it costs — the mock's screen has no price field
        // either — so the draft carries the quantities and the existing
        // purchase-order editor is where rates, terms and the vendor are
        // settled before it is issued. `line_amount` is the product of
        // the two, computed in SQL like every other line amount.
        await tx`
          insert into purchase_order_lines (
            organisation_id, purchase_order_id, production_item_id,
            production_job_card_id, line_number, description, unit_code,
            quantity, rate, line_amount
          )
          select ${organisationId}, ${order.id}, l.item_id, ${body.jobCardId},
                 l.line_number, l.description, l.unit_code, l.quantity, 0,
                 0::numeric(18,2)
          from unnest(
            ${shortages.map((row) => row.item_id)}::uuid[],
            ${shortages.map((_, index) => index + 1)}::int[],
            ${shortages.map((row) => `${row.item_code} — ${row.name}`)}::text[],
            ${shortages.map((row) => row.unit)}::text[],
            ${shortages.map((row) => row.shortage)}::numeric(18,3)[]
          ) as l(item_id, line_number, description, unit_code, quantity)
        `;

        await audit(
          tx,
          organisationId,
          user.id,
          'purchase_order.created',
          'purchase_orders',
          order.id,
          {
            workId,
            vendorContactId: body.vendorContactId,
            poDate: body.poDate,
            raisedFromShortage: true,
            jobCardId: body.jobCardId,
            lines: shortages.map((row) => ({
              productionItemId: row.item_id,
              itemCode: row.item_code,
              quantity: row.shortage,
            })),
          },
        );
        return readPurchaseOrderDetail(tx, order.id);
      });
      return reply.status(201).send(detail);
    },
  );
}
