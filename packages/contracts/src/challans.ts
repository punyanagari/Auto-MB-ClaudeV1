import { Type, type Static } from '@sinclair/typebox';
import { GstinSchema } from './masters.js';
import {
  NextCursorSchema,
  SortedNextCursorSchema,
  withSortedKeysetQuery,
} from './pagination.js';
import {
  DateOnlySchema,
  DecimalStringSchema,
  RateStringSchema,
  UuidSchema,
} from './primitives.js';

export const ChallanStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('issued'),
  Type.Literal('cancelled'),
]);

/** Consignee details are snapshotted per challan — railway consignees vary
 * per delivery, so they are challan data, not Work data. */
export const ConsigneeSchema = Type.Object(
  {
    name: Type.String({ minLength: 2, maxLength: 200 }),
    address: Type.String({ minLength: 3, maxLength: 1000 }),
    phone: Type.Optional(Type.String({ minLength: 3, maxLength: 30 })),
  },
  { additionalProperties: false },
);
export type Consignee = Static<typeof ConsigneeSchema>;

/** Six digits for a SAC, six to eight for a goods HSN; which of the two
 * it is comes from `isService` beside it, never from the length. The
 * database pairs the two (migration 0075, restating 0057's rule). */
const HsnSacCodeSchema = Type.String({
  pattern: '^[0-9]{6,8}$',
  description: 'HSN (goods, six to eight digits) or SAC (services, six).',
});

/** Why the goods move, in NIC's e-way bill vocabulary. */
const MOVEMENT_REASONS = ['supply', 'job_work', 'for_own_use', 'others'] as const;
const MovementReasonSchema = Type.Union(
  MOVEMENT_REASONS.map((reason) => Type.Literal(reason)),
);
export type MovementReason = Static<typeof MovementReasonSchema>;

/** A challan line, in one of two shapes.
 *
 * A WORK ITEM line names `workItemId` and takes its description, unit and
 * rate from the live schedule item; it is the only shape that reaches the
 * quantity ledger.
 *
 * A MANUAL line names none of that and carries `description`, `unit` and
 * `rate` itself. It is the non-LOA installation material — poles, bolts,
 * consumables — that moves on the same document as the sanctioned supply
 * but belongs to no schedule item, and it is the ONLY shape a standalone
 * challan may carry.
 *
 * Both shapes live in one object rather than a union so the server can
 * answer a mixed line with a NAMED refusal (MANUAL_LINE_INCOMPLETE,
 * PO_LINE_REQUIRES_WORK_ITEM_LINE, LINE_SHAPE_INVALID) instead of a
 * schema message that says only "does not match any of the allowed
 * shapes". Existing bodies that carry workItemId alone stay valid. */
const ChallanItemInputSchema = Type.Object(
  {
    /** The LOA schedule item this line delivers. Absent on a manual line. */
    workItemId: Type.Optional(UuidSchema),
    quantity: DecimalStringSchema,
    /** Manual lines only: what is printed on the document. Required
     * together, and refused alongside workItemId — a work item line takes
     * these from the schedule so the ledger and the paper agree. */
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    unit: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
    rate: Type.Optional(RateStringSchema),
    /** The purchase-order line this delivery receives against (the 0033
     * receipt link). Optional because plenty of material arrives without
     * an order — a free issue from the railway, or stock the contractor
     * already held. When named, it must be a line of an ISSUED purchase
     * order of the SAME Work (404 PO_LINE_NOT_FOUND / 409 PO_NOT_ISSUED),
     * so it is legal only on a work item line (400
     * PO_LINE_REQUIRES_WORK_ITEM_LINE otherwise). Receiving MORE than the
     * line ordered is a warning, never a refusal — vendors over-ship (see
     * ChallanOverReceiptWarningSchema). */
    purchaseOrderLineId: Type.Optional(UuidSchema),
    /** The statutory classification of what this line moves (ADR-0013),
     * in the shape an itemised tax invoice already uses. Sent together or
     * not at all: a code with no kind cannot be read, because the kind is
     * what decides whether the line is GOODS. Optional everywhere, and
     * required only on a challan an e-way bill is raised from — at least
     * one goods line is what makes the challan an e-way bill source. */
    hsnSacCode: Type.Optional(HsnSacCodeSchema),
    isService: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ChallanItemInput = Static<typeof ChallanItemInputSchema>;

const PrefixSchema = Type.String({ pattern: '^[A-Z0-9][A-Z0-9_/-]{0,24}$' });

export const SaveChallanRequestSchema = Type.Object(
  {
    challanDate: DateOnlySchema,
    prefix: PrefixSchema,
    consignee: ConsigneeSchema,
    items: Type.Array(ChallanItemInputSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type SaveChallanRequest = Static<typeof SaveChallanRequestSchema>;

/** A standalone Delivery Challan: goods leaving the factory for a private
 * customer, a vendor, or a job worker, with no Work anywhere in the
 * picture. The consignee comes from the contacts master rather than free
 * text — a standalone challan has no Work to hang the party off, and the
 * one-open-draft rule counts per consignee. Its lines are always manual. */
/** The statutory movement facts a Delivery Challan may carry (ADR-0013,
 * migration 0075).
 *
 * The transport shapes are the ones `eway_bills` already proved, said
 * again here because the challan is the paper that travels WITH the goods
 * and states its own carriage particulars. Every field is optional: a
 * challan is a valid movement document without any of them, and they are
 * required only on the path that raises an e-way bill.
 *
 * Sending an empty string clears a fact; the server trims and reads a
 * blank as "not recorded", which is how a form that shows every field can
 * leave most of them alone. */
const challanStatutoryFields = {
  movementReason: Type.Optional(MovementReasonSchema),
  /** The consignee's GSTIN, frozen onto the document. Absent when the
   * party is unregistered — which is lawful, and not an error. A fifteen-
   * character GSTIN sets it; an EMPTY STRING clears it (the field-wide
   * convention above), which the length-only `GstinSchema` would otherwise
   * reject, so the empty string is admitted explicitly. Omitting the field
   * entirely defaults it from the contacts master at draft time. */
  consigneeGstin: Type.Optional(Type.Union([GstinSchema, Type.Literal('')])),
  transporterId: Type.Optional(
    Type.String({
      pattern: '^[0-9]{2}[0-9A-Z]{13}$',
      description: 'Fifteen-character transporter enrolment id.',
    }),
  ),
  transporterName: Type.Optional(Type.String({ maxLength: 200 })),
  vehicleNumber: Type.Optional(
    Type.String({
      pattern: '^[A-Z0-9]{6,12}$',
      description: 'Vehicle registration, uppercase letters and digits.',
    }),
  ),
  transportDocNumber: Type.Optional(Type.String({ maxLength: 30 })),
  transportDocDate: Type.Optional(DateOnlySchema),
  transportDistanceKm: Type.Optional(Type.Integer({ minimum: 0, maximum: 4000 })),
} as const;

export const SaveStandaloneChallanRequestSchema = Type.Object(
  {
    challanDate: DateOnlySchema,
    prefix: PrefixSchema,
    consigneeContactId: UuidSchema,
    items: Type.Array(ChallanItemInputSchema, { minItems: 1 }),
    ...challanStatutoryFields,
  },
  { additionalProperties: false },
);
export type SaveStandaloneChallanRequest = Static<
  typeof SaveStandaloneChallanRequestSchema
>;

export const CancelChallanRequestSchema = Type.Object(
  { note: Type.String({ minLength: 3, maxLength: 1000 }) },
  { additionalProperties: false },
);
export type CancelChallanRequest = Static<typeof CancelChallanRequestSchema>;

const ChallanItemSchema = Type.Object(
  {
    id: UuidSchema,
    /** The LOA schedule item, or null on a manual (non-LOA) line. Only
     * non-null lines move the quantity ledger. */
    workItemId: Type.Union([UuidSchema, Type.Null()]),
    description: Type.String(),
    unit: Type.String(),
    quantity: DecimalStringSchema,
    rate: RateStringSchema,
    lineAmount: DecimalStringSchema,
    position: Type.Integer({ minimum: 1 }),
    /** The purchase-order line this delivery receives against; null when
     * the material arrived without an order. Optional in the schema so
     * responses built before the receipt link existed stay valid — the
     * server always serves it. */
    purchaseOrderLineId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    /** The line's statutory classification (ADR-0013); both null when the
     * line carries none. Optional in the schema so responses built before
     * the facts existed stay valid — the server always serves them. */
    hsnSacCode: Type.Optional(Type.Union([HsnSacCodeSchema, Type.Null()])),
    isService: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type ChallanItem = Static<typeof ChallanItemSchema>;

/** A non-blocking over-receipt notice: this challan takes (or, once
 * issued, has taken) a purchase-order line past its ordered quantity.
 * Vendors over-ship, so this is advice for the operator, never a refusal
 * — the ordered and received figures are both here so the screen can say
 * by how much. `receivedQuantity` counts issued receipts elsewhere PLUS
 * this challan's own lines (projected while the challan is a draft,
 * actual once issued); one warning per purchase-order line. */
const ChallanOverReceiptWarningSchema = Type.Object(
  {
    purchaseOrderLineId: UuidSchema,
    poNumber: Type.String(),
    poLineNumber: Type.Integer({ minimum: 1 }),
    description: Type.String(),
    orderedQuantity: DecimalStringSchema,
    receivedQuantity: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type ChallanOverReceiptWarning = Static<typeof ChallanOverReceiptWarningSchema>;

/** What the challan is a movement of. `work` covers both LOA supply and
 * the non-LOA installation material that travels with it; `standalone`
 * is the factory-to-customer movement with no Work at all. */
const ChallanKindSchema = Type.Union([
  Type.Literal('work'),
  Type.Literal('standalone'),
]);
export type ChallanKind = Static<typeof ChallanKindSchema>;

const ChallanSchema = Type.Object(
  {
    id: UuidSchema,
    /** Null on a standalone challan. */
    workId: Type.Union([UuidSchema, Type.Null()]),
    kind: ChallanKindSchema,
    /** The contacts-master consignee of a standalone challan; null on a
     * work challan, which keeps its free-text consignee snapshot. */
    consigneeContactId: Type.Union([UuidSchema, Type.Null()]),
    /** The financial year a standalone number counts in, frozen at issue;
     * null while draft and on every work challan. */
    fyLabel: Type.Union([Type.String({ pattern: '^[0-9]{4}-[0-9]{2}$' }), Type.Null()]),
    status: ChallanStatusSchema,
    challanDate: DateOnlySchema,
    challanNumber: Type.Union([Type.String(), Type.Null()]),
    sequenceNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    prefix: PrefixSchema,
    consignee: ConsigneeSchema,
    templateVersion: Type.Union([Type.String(), Type.Null()]),
    /** Warranty/guarantee certificate facts, set at issue time only when
     * the organisation had template text; null otherwise (the certificate
     * page is optional — legacy §11). */
    warrantyTemplateVersion: Type.Union([Type.String(), Type.Null()]),
    warrantyTextSha256: Type.Union([
      Type.String({ pattern: '^[0-9a-f]{64}$' }),
      Type.Null(),
    ]),
    renderedAvailable: Type.Boolean(),
    signedCopyAvailable: Type.Boolean(),
    cancellationNote: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    issuedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    /** The statutory movement facts (ADR-0013), null where not recorded.
     * Optional in the schema so responses built before they existed stay
     * valid — the server always serves them. */
    movementReason: Type.Optional(Type.Union([MovementReasonSchema, Type.Null()])),
    consigneeGstin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    transporterId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    transporterName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    vehicleNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    transportDocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    transportDocDate: Type.Optional(Type.Union([DateOnlySchema, Type.Null()])),
    transportDistanceKm: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    ),
    /** Whether this challan may raise an e-way bill: the server's own
     * applicability answer, so the screen offers the action exactly when
     * the route would accept it (ADR-0013). Standalone, issued, carrying
     * at least one goods line. */
    ewayBillEligible: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type Challan = Static<typeof ChallanSchema>;

/** The Work's delivery challans, newest first.
 *
 * `nextCursor` is the keyset contract from `pagination.ts`: the id to send
 * as the next `cursor`, or null when there is no further page — which is
 * also what an unpaginated request (no `limit`) always answers, because it
 * received the whole register. */
export const ChallanListResponseSchema = Type.Object(
  { challans: Type.Array(ChallanSchema), nextCursor: NextCursorSchema },
  { additionalProperties: false },
);

/** How the register presents a challan. Three cases, decided from the
 * record rather than guessed on screen:
 *
 *   `loa_supply`      a work challan whose lines are all schedule items;
 *   `work_material`   a work challan carrying at least one manual line —
 *                     installation material that is not on the LOA;
 *   `standalone`      no Work at all.
 *
 * Only `loa_supply` and the schedule-item half of `work_material` reach
 * the quantity ledger. */
const DeliveryChallanMovementSchema = Type.Union([
  Type.Literal('loa_supply'),
  Type.Literal('work_material'),
  Type.Literal('standalone'),
]);
export type DeliveryChallanMovement = Static<typeof DeliveryChallanMovementSchema>;

const DeliveryChallanRegisterEntrySchema = Type.Object(
  {
    id: UuidSchema,
    kind: ChallanKindSchema,
    movement: DeliveryChallanMovementSchema,
    status: ChallanStatusSchema,
    challanDate: DateOnlySchema,
    challanNumber: Type.Union([Type.String(), Type.Null()]),
    prefix: PrefixSchema,
    /** The Work this challan moves against; null when standalone. */
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String(), Type.Null()]),
    /** Who the goods went to, as the document itself records it: the
     * snapshot name on a work challan, the contact designation on a
     * standalone one. */
    consigneeName: Type.String(),
    lineCount: Type.Integer({ minimum: 0 }),
    manualLineCount: Type.Integer({ minimum: 0 }),
    totalAmount: DecimalStringSchema,
    createdAt: Type.String({ format: 'date-time' }),
    issuedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type DeliveryChallanRegisterEntry = Static<
  typeof DeliveryChallanRegisterEntrySchema
>;

/** The register's query: one optional Work, plus the two keyset
 * parameters.
 *
 * `work` is the module's `?work=` deep link pushed into the request. It
 * was applied client-side over the loaded page at first, which was only
 * ever right for a Work whose movements fit in one page; narrowing in SQL
 * makes the page a page OF that Work. A Work the caller may not see
 * matches nothing — the work-scope predicate below is unchanged and still
 * decides what exists, so a guessed id answers an empty register rather
 * than a refusal that would confirm it.
 *
 * Pattern rather than `format: 'uuid'`, for the reason `pagination.ts`
 * states about cursors: the check must not depend on which formats the
 * serving ajv instance happens to have registered. */
export const DeliveryChallanRegisterQuerySchema = withSortedKeysetQuery(
  Type.Object(
    {
      work: Type.Optional(
        Type.String({
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        }),
      ),
    },
    { additionalProperties: false },
  ),
);

/** The organisation-wide movement register, newest challan date first.
 *
 * `nextCursor` is the keyset contract from `pagination.ts`: the id to send
 * as the next `cursor`, or null when there is no further page — which is
 * also what an unpaginated request (no `limit`) always answers, because it
 * received the whole register. */
export const DeliveryChallanRegisterResponseSchema = Type.Object(
  {
    challans: Type.Array(DeliveryChallanRegisterEntrySchema),
    /* Sort-tagged: this register sorts, so its cursor carries the order
     * it was minted under and cannot be replayed under the other one. */
    nextCursor: SortedNextCursorSchema,
  },
  { additionalProperties: false },
);

export const ChallanDetailResponseSchema = Type.Object(
  {
    challan: ChallanSchema,
    items: Type.Array(ChallanItemSchema),
    /** The immutable issue-time snapshot, verbatim; null while draft. */
    issuedSnapshot: Type.Unknown(),
    /** Over-receipt notices for lines linked to purchase-order lines,
     * recomputed live on every read (a receipt issued elsewhere can push
     * a draft into over-receipt after it was saved); empty when nothing
     * is linked or nothing exceeds, always empty once cancelled. Optional
     * in the schema so responses built before the receipt link existed
     * stay valid — the server always serves it. */
    warnings: Type.Optional(Type.Array(ChallanOverReceiptWarningSchema)),
  },
  { additionalProperties: false },
);
export type ChallanDetailResponse = Static<typeof ChallanDetailResponseSchema>;

const WorkBalanceItemSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    description: Type.String(),
    unitCode: Type.String(),
    awardedQuantity: DecimalStringSchema,
    /** Amended ceiling when an approved amendment changed the quantity;
     * null means the awarded quantity applies. */
    effectiveQuantity: Type.Optional(Type.Union([DecimalStringSchema, Type.Null()])),
    /** Sum of quantities on ISSUED challans; cancelled ones release theirs. */
    deliveredQuantity: DecimalStringSchema,
    remainingQuantity: Type.String({
      description:
        'COALESCE(effective, awarded) − delivered as exact decimal text; negative only when excess delivery was allowed.',
    }),
    effectiveRate: RateStringSchema,
  },
  { additionalProperties: false },
);
export type WorkBalanceItem = Static<typeof WorkBalanceItemSchema>;

/** The standing choices a NEW Delivery Challan draft for this Work opens
 * on, taken from the Work's most recent ISSUED challan.
 *
 * A Work delivers to the same consignee under the same number prefix
 * challan after challan, so retyping both on every draft is pure
 * transcription — and transcription is where the consignee snapshot
 * drifts. The source is chosen server-side by sequence number, which is
 * the Work's true series order: it is assigned at issue, so a challan
 * back-entered with an older date cannot displace a later one, and drafts
 * and cancelled challans carry no sequence authority at all. Cancelled
 * documents are excluded because whatever was wrong with one may be
 * exactly these fields.
 *
 * Every value is an editable default. The consignee remains a per-challan
 * snapshot: it is copied, never referenced. */
const ChallanCarryForwardSchema = Type.Object(
  {
    prefix: Type.String(),
    consigneeName: Type.String(),
    consigneeAddress: Type.String(),
    consigneePhone: Type.Union([Type.String(), Type.Null()]),
    /** The challan number the values came from, so the editor can say so. */
    sourceChallanNumber: Type.String(),
  },
  { additionalProperties: false },
);
export type ChallanCarryForward = Static<typeof ChallanCarryForwardSchema>;

/** The Issue Challan equivalent, from the Work's most recent ISSUED Issue
 * Challan, chosen the same way.
 *
 * Movement type is deliberately absent. It is the one field that changes
 * what the document DOES — a 'return' inverts the stock direction — so
 * carrying it would make one return silently turn every later Issue
 * Challan into a return. The Movement select always opens on 'issue'. */
const IssueChallanCarryForwardSchema = Type.Object(
  {
    issuedToName: Type.String(),
    issuedToRole: Type.Union([Type.String(), Type.Null()]),
    location: Type.Union([Type.String(), Type.Null()]),
    sourceChallanNumber: Type.String(),
  },
  { additionalProperties: false },
);
export type IssueChallanCarryForward = Static<typeof IssueChallanCarryForwardSchema>;

export const WorkBalanceResponseSchema = Type.Object(
  {
    allowExcessDelivery: Type.Boolean(),
    /** Current legal date in the Organisation timezone. Editors use this
     * instead of a browser or UTC clock when defaulting a document date. */
    today: DateOnlySchema,
    items: Type.Array(WorkBalanceItemSchema),
    /** What a new Delivery Challan draft opens on; null when the Work has
     * no issued Delivery Challan, so its first challan opens on the plain
     * defaults exactly as it always did.
     *
     * Both editors read this one endpoint, which is why the Issue Challan
     * answer sits beside this one rather than nested under a shared key:
     * an object property here would read to the route-inventory census as
     * "this response names an entity", and quietly drop the route out of
     * the pagination census that covers its `items` list.
     *
     * Optional in the schema so responses built before carry-forward
     * existed stay valid; the server always serves it. */
    deliveryCarryForward: Type.Optional(
      Type.Union([ChallanCarryForwardSchema, Type.Null()]),
    ),
    /** The same answer for a new Issue Challan draft. */
    issueCarryForward: Type.Optional(
      Type.Union([IssueChallanCarryForwardSchema, Type.Null()]),
    ),
  },
  { additionalProperties: false },
);
export type WorkBalanceResponse = Static<typeof WorkBalanceResponseSchema>;
