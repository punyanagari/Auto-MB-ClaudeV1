import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
  UuidSchema,
} from './primitives.js';

// --- OEM production (migration 0084) ---------------------------------------
//
// The half of the business that happens before a Delivery Challan: the
// agency BUILDS what it delivers. An item master of products and the
// parts they are made from, a recursive bill of material, a job card that
// turns a contract line into physical units, the serial genealogy of
// those units, and the despatch that hands them to stock.
//
// One thing this module deliberately does not carry, recorded in
// migration 0084's header and in `docs/UX.md` § 11: no stored readiness.
// `material-short`, `material-ready` and `dispatch-ready` are the mock's
// derived facts stored as a status field, and its own fixture disagrees
// with itself on two of three plans as a result.
//
// Material SHORTAGE was the second such omission until the Inventory
// pack's stock ledger landed (migration 0087). It is here now, and it is
// DERIVED ON READ from that ledger — nothing below is a column anyone can
// type into.

/* --- The item master ---------------------------------------------------- */

/** A user-named attribute and its value, as the mock's Specifications
 * card collects them ("Attribute names are created by users"). */
export const ProductionSpecificationSchema = Type.Object(
  {
    attribute: Type.String({ minLength: 1, maxLength: 100 }),
    value: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export type ProductionSpecification = Static<typeof ProductionSpecificationSchema>;

export const ProductionItemSchema = Type.Object(
  {
    id: UuidSchema,
    /** The part number an operator says out loud, e.g. `PEB-IPDB-6L`.
     * Unique per organisation, case-insensitively, and never reissued —
     * it is printed on physical labels. */
    itemCode: Type.String({ minLength: 2, maxLength: 40 }),
    name: Type.String({ minLength: 2, maxLength: 200 }),
    /** Rendered as a badge, not a foreign key: the distinct values
     * across an organisation's items are its category list. */
    category: Type.String({ minLength: 2, maxLength: 100 }),
    /** The unit this part is counted in EVERYWHERE. The mock puts it on
     * the bill-of-material node, which lets one bolt be Nos in one
     * assembly and Kg in another. */
    unit: Type.String({ minLength: 1, maxLength: 20 }),
    /** Whether a job card may be raised for this item. A manufactured
     * item always carries a serial series and is always serial
     * controlled (migration 0084's shape CHECK). */
    manufactured: Type.Boolean(),
    /** The finished-serial series, e.g. `IPDB6`. Frozen once the first
     * unit is minted. Null for a bought-in part. */
    serialPrefix: Type.Union([
      Type.String({ minLength: 2, maxLength: 16 }),
      Type.Null(),
    ]),
    /** Whether this part's serials are captured when it is consumed as a
     * component. Independent of holding a prefix: a bought-in card
     * carries the supplier's serials, which are scanned, not minted. */
    serialControlled: Type.Boolean(),
    specifications: Type.Array(ProductionSpecificationSchema, { maxItems: 50 }),
    active: Type.Boolean(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type ProductionItem = Static<typeof ProductionItemSchema>;

export const SaveProductionItemRequestSchema = Type.Object(
  {
    itemCode: Type.String({ minLength: 2, maxLength: 40 }),
    name: Type.String({ minLength: 2, maxLength: 200 }),
    category: Type.String({ minLength: 2, maxLength: 100 }),
    unit: Type.String({ minLength: 1, maxLength: 20 }),
    manufactured: Type.Boolean(),
    /** Required when `manufactured`; uppercase letters, digits and
     * hyphens, because it becomes the leading half of a serial number. */
    serialPrefix: Type.Optional(
      Type.String({
        minLength: 2,
        maxLength: 16,
        pattern: '^[A-Z0-9][A-Z0-9-]{1,15}$',
      }),
    ),
    serialControlled: Type.Optional(Type.Boolean()),
    specifications: Type.Optional(
      Type.Array(ProductionSpecificationSchema, { maxItems: 50 }),
    ),
  },
  { additionalProperties: false },
);
export type SaveProductionItemRequest = Static<typeof SaveProductionItemRequestSchema>;

export const ProductionItemListResponseSchema = Type.Object(
  { items: Type.Array(ProductionItemSchema) },
  { additionalProperties: false },
);
export type ProductionItemListResponse = Static<
  typeof ProductionItemListResponseSchema
>;

/* --- The recursive bill of material ------------------------------------- */

/**
 * One node of an exploded bill of material.
 *
 * Recursive in the domain and FLAT on the wire, with `parentLineId`
 * naming the edge above. TypeBox has `Type.Recursive`, and a recursive
 * response schema would have to be validated recursively by the
 * serialiser on every read of a screen that renders the whole tree; the
 * flat list costs one grouping pass in the view and keeps the contract
 * checkable in linear time. It also gives the view stable ids to key its
 * expand/collapse state on, which a nested literal does not.
 */
export const BomNodeSchema = Type.Object(
  {
    /** The bill-of-material line this node came from. */
    lineId: UuidSchema,
    /** The line one level up, or null at the top of this item's bill. */
    parentLineId: Type.Union([UuidSchema, Type.Null()]),
    depth: Type.Integer({ minimum: 0 }),
    itemId: UuidSchema,
    itemCode: Type.String(),
    name: Type.String(),
    unit: Type.String(),
    /** Per one unit of the immediate parent, exactly as stored. */
    quantity: PositiveDecimalStringSchema,
    /** Per one unit of the item at the root of this explosion — the
     * quantity above multiplied down every level. */
    effectiveQuantity: PositiveDecimalStringSchema,
    /** Whether this part's serials are captured on consumption. */
    serialControlled: Type.Boolean(),
    /** The mock's `type`: 'sub-assembly' when the node has a bill of its
     * own, 'raw' when it does not. Derived, never stored. */
    hasChildren: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type BomNode = Static<typeof BomNodeSchema>;

export const BomResponseSchema = Type.Object(
  {
    nodes: Type.Array(BomNodeSchema),
    /** Whether the walk stopped at the depth bound with children unread.
     *
     * The cap is not the defect; a bill drawn half-way and presented as
     * the whole bill is. When this is true the view says so, so nobody
     * plans a build against a list that quietly stops. */
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type BomResponse = Static<typeof BomResponseSchema>;

export const SaveBomLineRequestSchema = Type.Object(
  {
    componentItemId: UuidSchema,
    quantity: PositiveDecimalStringSchema,
  },
  { additionalProperties: false },
);
export type SaveBomLineRequest = Static<typeof SaveBomLineRequestSchema>;

/* --- The job card ------------------------------------------------------- */

/**
 * Where a production order stands. Four states and no others.
 *
 * The mock draws six. Three of its six (`material-short`,
 * `material-ready`, `dispatch-ready`) are computed from stock and serial
 * counts rather than decided by anybody, and are derived on read here.
 */
export const JOB_CARD_STATUSES = [
  'planned',
  'in_production',
  'completed',
  'cancelled',
] as const;

export const JobCardStatusSchema = Type.Union(
  JOB_CARD_STATUSES.map((status) => Type.Literal(status)),
);
export type JobCardStatus = Static<typeof JobCardStatusSchema>;

/** What the bill of material asks of one job card, one part at a time,
 * and how much of it this card can actually have.
 *
 * All three quantities are derived on read. `required` is 0084's
 * explosion; `available` and `shortage` come off the stock ledger of
 * migration 0087 and no column stores either.
 *
 * `available` is THIS CARD'S share of the shelf — what is on hand, less
 * every OTHER open job card's outstanding claim on the same part. The
 * card's own claim is not taken off, because a card must not be told it
 * cannot have what it itself reserved, and the other cards are, because
 * two cards each subtracting nothing would each be promised the same reel
 * of cable.
 *
 * `shortage` is what still has to be BOUGHT, and it is measured on a
 * different basis on purpose: not `required`, but the card's outstanding
 * requirement — the bill times the units not yet serialised, less what
 * has already been issued to the card and not returned. Material issued
 * to the bench has left the shelf, so measuring a gross requirement
 * against the shelf would report a card short of the parts lying in front
 * of the operator. From that it takes off the shelf and the outstanding
 * balance of every open purchase order for the part, both after the other
 * cards' claim.
 *
 * So `required - available` is deliberately not `shortage`: different
 * bases, and one term the pair does not carry. A card that is completed,
 * cancelled or fully serialised is short of nothing whatever the shelf
 * says, because it needs nothing more.
 *
 * Two cards competing for one part with a single purchase order covering
 * one of them BOTH read short. Neither may assume the order is theirs,
 * and the organisation-wide shortage screen stays the authority on how
 * much to buy. */
export const MaterialRequirementSchema = Type.Object(
  {
    itemId: UuidSchema,
    itemCode: Type.String(),
    name: Type.String(),
    unit: Type.String(),
    /** For the whole job card: the exploded per-unit quantity times the
     * planned quantity. */
    required: NonNegativeDecimalStringSchema,
    /** On the shelf and unclaimed by any other open job card. */
    available: NonNegativeDecimalStringSchema,
    /** What still has to be bought, net of the shelf and of what is on
     * order. Zero, never negative: a surplus is not a shortage. */
    shortage: NonNegativeDecimalStringSchema,
    serialControlled: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type MaterialRequirement = Static<typeof MaterialRequirementSchema>;

export const JobCardSummarySchema = Type.Object(
  {
    id: UuidSchema,
    /** `PP-26-081`. Built from the financial year and the sequence for
     * display, never stored a third time. */
    number: Type.String(),
    /** The mock's `sourceType`, derived from whether a Work is named
     * rather than stored beside it. */
    sourceType: Type.Union([Type.Literal('work'), Type.Literal('private')]),
    /** The schedule or purchase-order reference the order came from. */
    sourceReference: Type.String(),
    /** The Work this order serves, or null for a private purchase
     * order. */
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String(), Type.Null()]),
    /** The typed customer on a private purchase order, and NULL for a
     * Work-sourced card.
     *
     * The mock prints a customer on every plan; a Work in this product
     * does not carry one. `works` holds the letter, the title and the
     * money, and the railway's own name is on the consignee snapshot of
     * each challan rather than on the contract row — so a Work-sourced
     * card would have to guess, and the header shows its Work code
     * instead, which is the identifier an operator actually uses. */
    customer: Type.Union([Type.String(), Type.Null()]),
    itemId: UuidSchema,
    itemCode: Type.String(),
    itemName: Type.String(),
    quantity: Type.Integer({ minimum: 1 }),
    /** Units that exist as finished serials. Counted, not stored. */
    manufactured: Type.Integer({ minimum: 0 }),
    /** Units that have left production on a despatch. Counted. */
    dispatched: Type.Integer({ minimum: 0 }),
    /** How many lines the product's bill of material has at its TOP
     * level — not the exploded part count, which is what the Materials
     * tab lists. It is asked one question only: zero means the product
     * has no bill at all, which the register says in those words rather
     * than reporting nothing short. */
    materialLines: Type.Integer({ minimum: 0 }),
    /** How many EXPLODED parts this card is short of: one per row of the
     * Materials tab whose `shortage` is above zero, so the register's
     * Material badge and the tab cannot answer differently. Unrelated to
     * `materialLines`, which counts top-level bill lines — a card can be
     * short of a part nested three sub-assemblies down.
     *
     * A COUNT OF PARTS, not the mock's sum of quantities. The mock badges
     * "2277 units short" by adding cabinets in Nos to cable in Mtr to
     * solder in Kg, which `docs/UX.md` § 13a refuses for the stock
     * register's tiles and refuses here for the same reason: a count of
     * parts is the same question asked in a unit that exists. */
    materialShortParts: Type.Integer({ minimum: 0 }),
    status: JobCardStatusSchema,
    dueDate: DateOnlySchema,
    completedOn: Type.Union([DateOnlySchema, Type.Null()]),
    cancellationReason: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type JobCardSummary = Static<typeof JobCardSummarySchema>;

/** One finished unit, and what is known to be inside it. */
export const FinishedSerialSchema = Type.Object(
  {
    id: UuidSchema,
    serialNumber: Type.String(),
    /** Null while the unit is still in the factory. Once set the unit's
     * component record is closed and the unit cannot be removed. */
    dispatchedOn: Type.Union([DateOnlySchema, Type.Null()]),
    components: Type.Array(
      Type.Object(
        {
          id: UuidSchema,
          componentItemId: UuidSchema,
          componentItemCode: Type.String(),
          componentName: Type.String(),
          serialNumber: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type FinishedSerial = Static<typeof FinishedSerialSchema>;

/** A serial-controlled part one unit is built from, and how many of it
 * the bill of material calls for.
 *
 * There is no `captured` count here: how many have been scanned into a
 * given unit is a fact about that UNIT, and it is already on
 * `FinishedSerial.components`. A second copy on a per-card slot would
 * have to mean "captured into which unit?" and could only ever answer
 * for one of them. */
export const ComponentSlotSchema = Type.Object(
  {
    componentItemId: UuidSchema,
    componentItemCode: Type.String(),
    name: Type.String(),
    required: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type ComponentSlot = Static<typeof ComponentSlotSchema>;

export const DispatchSchema = Type.Object(
  {
    id: UuidSchema,
    /** `PP-26-081/D1`. Per job card, built for display. */
    number: Type.String(),
    dispatchedOn: DateOnlySchema,
    remarks: Type.Union([Type.String(), Type.Null()]),
    serialNumbers: Type.Array(Type.String()),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type Dispatch = Static<typeof DispatchSchema>;

export const JobCardDetailSchema = Type.Composite(
  [
    JobCardSummarySchema,
    Type.Object(
      {
        materials: Type.Array(MaterialRequirementSchema),
        serials: Type.Array(FinishedSerialSchema),
        /** The per-unit slots every unit of this product has to fill
         * before it may be despatched. Constant across the job card, so
         * it is sent once rather than repeated on every serial. */
        componentSlots: Type.Array(ComponentSlotSchema),
        dispatches: Type.Array(DispatchSchema),
        /** Whether every unit is built and every unit's serial-controlled
         * components are captured — the mock's `dispatch-ready`, derived.
         */
        dispatchReady: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  ],
  { additionalProperties: false },
);
export type JobCardDetail = Static<typeof JobCardDetailSchema>;

export const JobCardListResponseSchema = Type.Object(
  {
    jobCards: Type.Array(JobCardSummarySchema),
    nextCursor: Type.Union([UuidSchema, Type.Null()]),
    /** Register-wide counts, so the stat tiles do not have to be derived
     * from one page of a keyset. */
    openCount: Type.Integer({ minimum: 0 }),
    inProductionCount: Type.Integer({ minimum: 0 }),
    dispatchReadyCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type JobCardListResponse = Static<typeof JobCardListResponseSchema>;

export const JobCardListQuerySchema = Type.Object(
  {
    /** The mock's `?work=` deep link, as every other register takes it. */
    workId: Type.Optional(UuidSchema),
    status: Type.Optional(JobCardStatusSchema),
  },
  { additionalProperties: false },
);
export type JobCardListQuery = Static<typeof JobCardListQuerySchema>;

export const CreateJobCardRequestSchema = Type.Object(
  {
    itemId: UuidSchema,
    quantity: Type.Integer({ minimum: 1, maximum: 100000 }),
    /** A Work, or a typed customer for a private purchase order —
     * exactly one of the two. */
    workId: Type.Optional(UuidSchema),
    customerName: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
    sourceReference: Type.String({ minLength: 1, maxLength: 200 }),
    dueDate: DateOnlySchema,
  },
  { additionalProperties: false },
);
export type CreateJobCardRequest = Static<typeof CreateJobCardRequestSchema>;

export const UpdateJobCardRequestSchema = Type.Object(
  {
    quantity: Type.Integer({ minimum: 1, maximum: 100000 }),
    sourceReference: Type.String({ minLength: 1, maxLength: 200 }),
    dueDate: DateOnlySchema,
  },
  { additionalProperties: false },
);
export type UpdateJobCardRequest = Static<typeof UpdateJobCardRequestSchema>;

export const CancelJobCardRequestSchema = Type.Object(
  { reason: Type.String({ minLength: 3, maxLength: 500 }) },
  { additionalProperties: false },
);
export type CancelJobCardRequest = Static<typeof CancelJobCardRequestSchema>;

/* --- Serials and despatch ----------------------------------------------- */

/** Nothing to send: the serial number comes from the item's own series,
 * claimed from its counter. A client-supplied number would let two
 * operators mint the same one. */
export const RecordComponentSerialRequestSchema = Type.Object(
  {
    componentItemId: UuidSchema,
    /** The supplier's number, scanned. Not minted here. */
    serialNumber: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);
export type RecordComponentSerialRequest = Static<
  typeof RecordComponentSerialRequestSchema
>;

export const CreateDispatchRequestSchema = Type.Object(
  {
    /** The finished units leaving. Every one must belong to this job
     * card and none may have left already. */
    serialIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 500 }),
    dispatchedOn: DateOnlySchema,
    remarks: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type CreateDispatchRequest = Static<typeof CreateDispatchRequestSchema>;
