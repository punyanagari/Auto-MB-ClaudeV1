import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
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
export type ChallanStatus = Static<typeof ChallanStatusSchema>;

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
export const ChallanItemInputSchema = Type.Object(
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
export const SaveStandaloneChallanRequestSchema = Type.Object(
  {
    challanDate: DateOnlySchema,
    prefix: PrefixSchema,
    consigneeContactId: UuidSchema,
    items: Type.Array(ChallanItemInputSchema, { minItems: 1 }),
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

export const ChallanItemSchema = Type.Object(
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
export const ChallanOverReceiptWarningSchema = Type.Object(
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
export const ChallanKindSchema = Type.Union([
  Type.Literal('work'),
  Type.Literal('standalone'),
]);
export type ChallanKind = Static<typeof ChallanKindSchema>;

export const ChallanSchema = Type.Object(
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
export type ChallanListResponse = Static<typeof ChallanListResponseSchema>;

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
export const DeliveryChallanMovementSchema = Type.Union([
  Type.Literal('loa_supply'),
  Type.Literal('work_material'),
  Type.Literal('standalone'),
]);
export type DeliveryChallanMovement = Static<typeof DeliveryChallanMovementSchema>;

export const DeliveryChallanRegisterEntrySchema = Type.Object(
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

/** The organisation-wide movement register, newest challan date first.
 *
 * `nextCursor` is the keyset contract from `pagination.ts`: the id to send
 * as the next `cursor`, or null when there is no further page — which is
 * also what an unpaginated request (no `limit`) always answers, because it
 * received the whole register. */
export const DeliveryChallanRegisterResponseSchema = Type.Object(
  {
    challans: Type.Array(DeliveryChallanRegisterEntrySchema),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type DeliveryChallanRegisterResponse = Static<
  typeof DeliveryChallanRegisterResponseSchema
>;

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

export const WorkBalanceItemSchema = Type.Object(
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

export const WorkBalanceResponseSchema = Type.Object(
  {
    allowExcessDelivery: Type.Boolean(),
    /** Current legal date in the Organisation timezone. Editors use this
     * instead of a browser or UTC clock when defaulting a document date. */
    today: DateOnlySchema,
    items: Type.Array(WorkBalanceItemSchema),
  },
  { additionalProperties: false },
);
export type WorkBalanceResponse = Static<typeof WorkBalanceResponseSchema>;
