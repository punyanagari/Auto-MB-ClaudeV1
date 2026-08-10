import { Type, type Static } from '@sinclair/typebox';
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

export const ChallanItemInputSchema = Type.Object(
  {
    workItemId: UuidSchema,
    quantity: DecimalStringSchema,
    /** The purchase-order line this delivery receives against (the 0033
     * receipt link). Optional because plenty of material arrives without
     * an order — a free issue from the railway, or stock the contractor
     * already held. When named, it must be a line of an ISSUED purchase
     * order of the SAME Work (404 PO_LINE_NOT_FOUND / 409 PO_NOT_ISSUED).
     * Receiving MORE than the line ordered is a warning, never a refusal
     * — vendors over-ship (see ChallanOverReceiptWarningSchema). */
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

export const CancelChallanRequestSchema = Type.Object(
  { note: Type.String({ minLength: 3, maxLength: 1000 }) },
  { additionalProperties: false },
);
export type CancelChallanRequest = Static<typeof CancelChallanRequestSchema>;

export const ChallanItemSchema = Type.Object(
  {
    id: UuidSchema,
    workItemId: UuidSchema,
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

export const ChallanSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
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

export const ChallanListResponseSchema = Type.Object(
  { challans: Type.Array(ChallanSchema) },
  { additionalProperties: false },
);
export type ChallanListResponse = Static<typeof ChallanListResponseSchema>;

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
    items: Type.Array(WorkBalanceItemSchema),
  },
  { additionalProperties: false },
);
export type WorkBalanceResponse = Static<typeof WorkBalanceResponseSchema>;
