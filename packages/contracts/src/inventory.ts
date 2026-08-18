import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
import {
  DateOnlySchema,
  DecimalStringSchema,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';

// --- The stock ledger (migration 0087) --------------------------------------
//
// What is on the shelf, how it got there, and what the open job cards
// are short of. The mock draws two screens: `app/inventory/page.tsx`
// (the register and its movements) and
// `app/inventory/purchase-orders/page.tsx` ("Shortage procurement"), at
// fdfe5ef.
//
// THE ITEM IS `production_items`. There is no stock item master of its
// own: the mock's `BomNode.itemId` already points at its `stockItems`
// list, so the bill of material and the shelf name the same thing, and
// migration 0084 collapsed both into one table. Migration 0087's header
// carries the full reasoning.
//
// THREE FIELDS THE MOCK STORES AND THIS DOES NOT:
//
//   * `onHand` — derived from the ledger, never a column. The mock keeps
//     a mutable copy on the item AND a balance on each movement, which
//     is two writers for one number.
//   * `reserved` — derived as `committed` below, from the open job
//     cards' outstanding bill-of-material requirement. The mock stores
//     it and never writes it; its fixture values do not agree with its
//     own explosion.
//   * `warehouse` / `batchControlled` — absent. Neither participates in
//     any arithmetic the mock does, and its own data layer reads a
//     `location` field its `StockItem` type does not have.

/* --- The register -------------------------------------------------------- */

/**
 * One part, as the stock register shows it.
 *
 * `onHand`, `committed` and `available` are all DERIVED and all
 * unit-consistent with each other: available is on-hand minus committed
 * and may go NEGATIVE, which is precisely the shortage the procurement
 * screen orders against. It is a signed decimal for that reason, while
 * `onHand` cannot be negative because the ledger refuses it.
 */
export const StockItemSchema = Type.Object(
  {
    id: UuidSchema,
    itemCode: Type.String(),
    name: Type.String(),
    category: Type.String(),
    unit: Type.String(),
    /** Whether a job card may be raised for this part. Manufactured
     * parts reach stock through a production despatch; bought-in parts
     * reach it through a purchase order. */
    manufactured: Type.Boolean(),
    serialControlled: Type.Boolean(),
    active: Type.Boolean(),
    /** The available quantity at or below which the register badges this
     * part low. Null means no level is set — a different statement from
     * zero, and the reason the badge is absent rather than lit. */
    reorderLevel: Type.Union([NonNegativeDecimalStringSchema, Type.Null()]),
    /** The last ledger row's balance. Zero for a part that has never
     * moved. */
    onHand: NonNegativeDecimalStringSchema,
    /** What every open job card still needs of this part: the recursive
     * bill-of-material explosion times the units not yet serialised.
     * The mock's stored `reserved`, derived. */
    committed: NonNegativeDecimalStringSchema,
    /** `onHand - committed`. Negative when the open job cards want more
     * than the shelf holds. */
    available: DecimalStringSchema,
    /** Whether `available` has fallen to or below `reorderLevel`. False
     * when no level is set. */
    belowReorderLevel: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type StockItem = Static<typeof StockItemSchema>;

/**
 * The register's stat strip.
 *
 * The mock's three tiles are "On hand", "Reserved" and "At reorder
 * level", and the first two SUM a quantity across every item — adding
 * cabinets in Nos to cable in Mtr to solder in Kg and printing the
 * result as one number. These are counts of PARTS instead, which is the
 * same question asked in a unit that exists. `docs/UX.md` records the
 * divergence.
 */
export const StockSummarySchema = Type.Object(
  {
    /** Active parts in the register. */
    partsTracked: Type.Integer({ minimum: 0 }),
    /** Parts whose available quantity has fallen to their reorder
     * level. */
    partsBelowReorderLevel: Type.Integer({ minimum: 0 }),
    /** Parts the open job cards want more of than the shelf holds — the
     * rows the shortage screen will offer to buy. */
    partsShort: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type StockSummary = Static<typeof StockSummarySchema>;

export const StockRegisterResponseSchema = Type.Object(
  {
    items: Type.Array(StockItemSchema),
    nextCursor: NextCursorSchema,
    summary: StockSummarySchema,
  },
  { additionalProperties: false },
);
export type StockRegisterResponse = Static<typeof StockRegisterResponseSchema>;

export const StockItemResponseSchema = Type.Object(
  { item: StockItemSchema },
  { additionalProperties: false },
);
export type StockItemResponse = Static<typeof StockItemResponseSchema>;

export const StockRegisterQuerySchema = Type.Object(
  {
    /** The mock's status filter: every part, or only the live ones. A
     * retired part with stock still on its shelf stays listed under
     * `all`, because the stock is still there. */
    status: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('active')])),
  },
  { additionalProperties: false },
);
export type StockRegisterQuery = Static<typeof StockRegisterQuerySchema>;

/* --- The ledger ---------------------------------------------------------- */

/**
 * The six movements, in three pairs. Migration 0087 § 3 explains why the
 * mock's single `receipt` is two here (the two rest on different source
 * documents, and each is bound to its own) and why `return` exists at
 * all (material coming back from a job card is not an adjustment with an
 * excuse).
 */
export const STOCK_MOVEMENT_TYPES = [
  'production_receipt',
  'purchase_receipt',
  'issue',
  'return',
  'adjustment_in',
  'adjustment_out',
] as const;

export const StockMovementTypeSchema = Type.Union(
  STOCK_MOVEMENT_TYPES.map((type) => Type.Literal(type)),
);
export type StockMovementType = Static<typeof StockMovementTypeSchema>;

/** What caused a movement. `none` is an adjustment, which carries a
 * typed reason instead of a document. */
export const STOCK_MOVEMENT_SOURCES = [
  'production_dispatch',
  'purchase_order',
  'job_card',
  'work',
  'none',
] as const;

export const StockMovementSourceSchema = Type.Union(
  STOCK_MOVEMENT_SOURCES.map((source) => Type.Literal(source)),
);
export type StockMovementSource = Static<typeof StockMovementSourceSchema>;

export const StockMovementSchema = Type.Object(
  {
    id: UuidSchema,
    /** `SM/<item code>/<position>`. Built from the item's code and this
     * movement's ledger position for display, never stored a third
     * time. */
    reference: Type.String(),
    itemId: UuidSchema,
    itemCode: Type.String(),
    itemName: Type.String(),
    unit: Type.String(),
    movementType: StockMovementTypeSchema,
    /** SIGNED, exactly as stored: positive into stock, negative out. A
     * register that wants "12 Nos out" takes the absolute value; the
     * sign is on the wire so a client can never disagree with the
     * ledger about which way the material went. */
    quantity: DecimalStringSchema,
    /** The balance after this movement, as the ledger computed it. */
    balanceAfter: NonNegativeDecimalStringSchema,
    movementDate: DateOnlySchema,
    source: StockMovementSourceSchema,
    /** The source document as an operator names it — a despatch
     * reference, a purchase order number, a job card number, a Work
     * code. Null for an adjustment, and null for a document the caller's
     * work-scope does not reach. */
    sourceLabel: Type.Union([Type.String(), Type.Null()]),
    /** Present on an adjustment and absent on everything else: a
     * movement that names a document has already said why it
     * happened. */
    reason: Type.Union([Type.String(), Type.Null()]),
    counterparty: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type StockMovement = Static<typeof StockMovementSchema>;

export const StockMovementListResponseSchema = Type.Object(
  {
    movements: Type.Array(StockMovementSchema),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type StockMovementListResponse = Static<typeof StockMovementListResponseSchema>;

export const StockMovementListQuerySchema = Type.Object(
  { itemId: Type.Optional(UuidSchema) },
  { additionalProperties: false },
);
export type StockMovementListQuery = Static<typeof StockMovementListQuerySchema>;

/**
 * Posting a movement.
 *
 * `quantity` is the MAGNITUDE the operator types, always positive: the
 * sign belongs to the movement type and is applied by the server, so a
 * request cannot say "issue +12" and mean anything.
 *
 * A `production_receipt` sends no quantity at all — see
 * `RecordProductionReceiptRequestSchema`. Its quantity is the number of
 * units the despatch released, which production already stated, and a
 * second copy is a second thing that can disagree (migration 0084 § 7).
 */
export const CreateStockMovementRequestSchema = Type.Object(
  {
    productionItemId: UuidSchema,
    movementType: Type.Union([
      Type.Literal('purchase_receipt'),
      Type.Literal('issue'),
      Type.Literal('return'),
      Type.Literal('adjustment_in'),
      Type.Literal('adjustment_out'),
    ]),
    quantity: PositiveDecimalStringSchema,
    movementDate: DateOnlySchema,
    /** Required for a `purchase_receipt`, refused on everything else. */
    purchaseOrderLineId: Type.Optional(UuidSchema),
    /** An `issue` or a `return` names exactly one of these two. */
    productionJobCardId: Type.Optional(UuidSchema),
    workId: Type.Optional(UuidSchema),
    /** Required for an adjustment, refused on everything else. */
    reason: Type.Optional(nonBlankString({ minLength: 3, maxLength: 500 })),
    counterparty: Type.Optional(nonBlankString({ minLength: 2, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type CreateStockMovementRequest = Static<
  typeof CreateStockMovementRequestSchema
>;

/** Taking a production despatch into stock. No quantity and no item: both
 * come from the despatch's own units, so the receipt cannot claim
 * something the factory did not release. */
export const RecordProductionReceiptRequestSchema = Type.Object(
  {
    productionDispatchId: UuidSchema,
    movementDate: DateOnlySchema,
    counterparty: Type.Optional(nonBlankString({ minLength: 2, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type RecordProductionReceiptRequest = Static<
  typeof RecordProductionReceiptRequestSchema
>;

export const StockMovementResponseSchema = Type.Object(
  { movement: StockMovementSchema },
  { additionalProperties: false },
);
export type StockMovementResponse = Static<typeof StockMovementResponseSchema>;

/** A production despatch that has not been taken into stock yet. The
 * register lists these so a release cannot sit unreceived and silently
 * leave the shelf understated. */
export const PendingProductionReceiptSchema = Type.Object(
  {
    productionDispatchId: UuidSchema,
    /** `PP-26-081/D1`, as production names it. */
    reference: Type.String(),
    dispatchedOn: DateOnlySchema,
    itemId: UuidSchema,
    itemCode: Type.String(),
    itemName: Type.String(),
    unit: Type.String(),
    /** The units the despatch released, counted. This is exactly what
     * the receipt will add. */
    quantity: PositiveDecimalStringSchema,
  },
  { additionalProperties: false },
);
export type PendingProductionReceipt = Static<typeof PendingProductionReceiptSchema>;

export const PendingProductionReceiptListResponseSchema = Type.Object(
  { dispatches: Type.Array(PendingProductionReceiptSchema) },
  { additionalProperties: false },
);
export type PendingProductionReceiptListResponse = Static<
  typeof PendingProductionReceiptListResponseSchema
>;

/** The one editable stock fact on the item master. Everything else about
 * a part belongs to the Production item screens. */
export const SetReorderLevelRequestSchema = Type.Object(
  {
    /** Null clears the level, which is not the same as setting zero. */
    reorderLevel: Type.Union([NonNegativeDecimalStringSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type SetReorderLevelRequest = Static<typeof SetReorderLevelRequestSchema>;

/* --- Shortage procurement ------------------------------------------------ */

/**
 * One part the open job cards want more of than the shelf holds.
 *
 * ONE ROW PER PART, NOT PER (PLAN, PART). The mock lists a row for every
 * plan-and-part pair and puts a checkbox on each, so ticking the two
 * rows for one part from two plans orders it twice. The requirement is
 * summed here and the contributing job cards are named instead, which
 * answers the same question — who wants this — without offering the
 * double order. `docs/UX.md` records the divergence.
 */
export const StockShortageSchema = Type.Object(
  {
    itemId: UuidSchema,
    itemCode: Type.String(),
    name: Type.String(),
    unit: Type.String(),
    /** What every open job card still needs, summed. */
    required: PositiveDecimalStringSchema,
    onHand: NonNegativeDecimalStringSchema,
    /** `required - onHand`, always positive: a part that is not short
     * does not appear. */
    shortage: PositiveDecimalStringSchema,
    /** The open job cards asking for it, and how much each wants. */
    jobCards: Type.Array(
      Type.Object(
        {
          id: UuidSchema,
          /** `PP-26-081`. */
          number: Type.String(),
          /** Null for a job card serving a private purchase order —
           * which is also why no purchase order can be raised from it. */
          workId: Type.Union([UuidSchema, Type.Null()]),
          workCode: Type.Union([Type.String(), Type.Null()]),
          required: PositiveDecimalStringSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type StockShortage = Static<typeof StockShortageSchema>;

/** A purchase order raised from a shortage, as the screen's right-hand
 * column lists it. A thin read: the order itself, its status and its
 * lifecycle live in the procurement module, which owns them. */
export const ShortagePurchaseOrderSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    /** Null while the order is still a draft and has claimed no
     * number. */
    poNumber: Type.Union([Type.String(), Type.Null()]),
    status: Type.String(),
    vendorDesignation: Type.String(),
    poDate: DateOnlySchema,
    expectedOn: Type.Union([DateOnlySchema, Type.Null()]),
    /** The job cards its lines were raised for — the mock's
     * `planIds`. */
    jobCardNumbers: Type.Array(Type.String()),
    lines: Type.Array(
      Type.Object(
        {
          productionItemId: UuidSchema,
          itemCode: Type.String(),
          name: Type.String(),
          unit: Type.String(),
          ordered: PositiveDecimalStringSchema,
          /** What has reached the shelf against this line so far. */
          received: NonNegativeDecimalStringSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ShortagePurchaseOrder = Static<typeof ShortagePurchaseOrderSchema>;

export const StockShortageResponseSchema = Type.Object(
  {
    shortages: Type.Array(StockShortageSchema),
    purchaseOrders: Type.Array(ShortagePurchaseOrderSchema),
  },
  { additionalProperties: false },
);
export type StockShortageResponse = Static<typeof StockShortageResponseSchema>;

/**
 * Turning selected shortages into a DRAFT purchase order.
 *
 * No quantities and no rates on the request, deliberately.
 *
 *   * The quantity is the shortage the server just computed. A
 *     client-supplied one would be a second authority on a number the
 *     screen only ever displayed.
 *   * The rate is not known at this point — the mock's screen has no
 *     price field either. The draft carries nil rates and the existing
 *     purchase-order editor is where they are filled in before it is
 *     issued, which is also where the vendor, terms and dates can still
 *     be changed. This creates a draft and stops.
 *
 * `jobCardId` is the card the order is raised FOR: it decides the Work
 * the order belongs to, and it is what each line records as its reason.
 * A card serving a private purchase order has no Work and is refused.
 */
export const CreateShortagePurchaseOrderRequestSchema = Type.Object(
  {
    jobCardId: UuidSchema,
    vendorContactId: UuidSchema,
    poDate: DateOnlySchema,
    expectedOn: Type.Optional(DateOnlySchema),
    /** The parts to buy, from the shortage list. At least one. */
    productionItemIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 200 }),
  },
  { additionalProperties: false },
);
export type CreateShortagePurchaseOrderRequest = Static<
  typeof CreateShortagePurchaseOrderRequestSchema
>;
