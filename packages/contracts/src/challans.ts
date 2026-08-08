import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, DecimalStringSchema, UuidSchema } from './primitives.js';

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
    rate: DecimalStringSchema,
    lineAmount: DecimalStringSchema,
    position: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type ChallanItem = Static<typeof ChallanItemSchema>;

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
    /** Sum of quantities on ISSUED challans; cancelled ones release theirs. */
    deliveredQuantity: DecimalStringSchema,
    remainingQuantity: Type.String({
      description:
        'awarded − delivered as exact decimal text; negative only when excess delivery was allowed.',
    }),
    effectiveRate: DecimalStringSchema,
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
