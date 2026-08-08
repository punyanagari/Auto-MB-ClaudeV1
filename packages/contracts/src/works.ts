import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, DecimalStringSchema, UuidSchema } from './primitives.js';

export const PricingShapeSchema = Type.Union([
  Type.Literal('letter_percentage'),
  Type.Literal('per_schedule'),
]);
export type PricingShape = Static<typeof PricingShapeSchema>;

export const LetterPercentageDirectionSchema = Type.Union([
  Type.Literal('below'),
  Type.Literal('at_par'),
  Type.Literal('above'),
]);
export type LetterPercentageDirection = Static<typeof LetterPercentageDirectionSchema>;

const WorkCodeSchema = Type.String({ pattern: '^[A-Z0-9][A-Z0-9_/-]{0,19}$' });

/** One corrected item as the reviewer confirms it. `sourceRef` points back
 * into the stored extraction payload (schedule id + printed serial) so the
 * server can attach the parser's verbatim source block as evidence. */
export const ConfirmWorkItemSchema = Type.Object(
  {
    itemNumber: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.String({ minLength: 3 }),
    unitCode: Type.String({ minLength: 1, maxLength: 20 }),
    awardedQuantity: DecimalStringSchema,
    effectiveRate: DecimalStringSchema,
    sourceRef: Type.Optional(
      Type.Object(
        {
          scheduleId: Type.String({ minLength: 1, maxLength: 50 }),
          itemSno: Type.String({ minLength: 1, maxLength: 50 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ConfirmWorkItem = Static<typeof ConfirmWorkItemSchema>;

export const ConfirmWorkScheduleSchema = Type.Object(
  {
    scheduleCode: Type.String({ minLength: 1, maxLength: 50 }),
    title: Type.String({ minLength: 1, maxLength: 1000 }),
    items: Type.Array(ConfirmWorkItemSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type ConfirmWorkSchedule = Static<typeof ConfirmWorkScheduleSchema>;

export const ConfirmWorkRequestSchema = Type.Object(
  {
    workCode: WorkCodeSchema,
    letterNumber: Type.String({ minLength: 1, maxLength: 200 }),
    letterDate: DateOnlySchema,
    title: Type.String({ minLength: 3, maxLength: 1000 }),
    advertisedValue: DecimalStringSchema,
    contractValue: DecimalStringSchema,
    pricingShape: PricingShapeSchema,
    letterPercentage: Type.Optional(DecimalStringSchema),
    letterPercentageDirection: Type.Optional(LetterPercentageDirectionSchema),
    schedules: Type.Array(ConfirmWorkScheduleSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type ConfirmWorkRequest = Static<typeof ConfirmWorkRequestSchema>;

export const WorkSchema = Type.Object(
  {
    id: UuidSchema,
    workCode: WorkCodeSchema,
    letterNumber: Type.String({ minLength: 1, maxLength: 200 }),
    letterDate: DateOnlySchema,
    title: Type.String({ minLength: 3, maxLength: 1000 }),
    advertisedValue: DecimalStringSchema,
    contractValue: DecimalStringSchema,
    pricingShape: PricingShapeSchema,
    letterPercentage: Type.Union([DecimalStringSchema, Type.Null()]),
    letterPercentageDirection: Type.Union([
      LetterPercentageDirectionSchema,
      Type.Null(),
    ]),
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('completed'),
      Type.Literal('cancelled'),
    ]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type Work = Static<typeof WorkSchema>;

export const WorkItemSchema = Type.Object(
  {
    id: UuidSchema,
    scheduleId: UuidSchema,
    itemNumber: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.String({ minLength: 3 }),
    unitCode: Type.String({ minLength: 1, maxLength: 20 }),
    awardedQuantity: DecimalStringSchema,
    effectiveRate: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type WorkItem = Static<typeof WorkItemSchema>;

export const WorkScheduleSchema = Type.Object(
  {
    id: UuidSchema,
    scheduleCode: Type.String({ minLength: 1, maxLength: 50 }),
    title: Type.String({ minLength: 1, maxLength: 1000 }),
    position: Type.Integer({ minimum: 1 }),
    items: Type.Array(WorkItemSchema),
  },
  { additionalProperties: false },
);
export type WorkSchedule = Static<typeof WorkScheduleSchema>;

export const WorkListResponseSchema = Type.Object(
  { works: Type.Array(WorkSchema) },
  { additionalProperties: false },
);
export type WorkListResponse = Static<typeof WorkListResponseSchema>;

export const WorkDetailResponseSchema = Type.Object(
  {
    work: WorkSchema,
    schedules: Type.Array(WorkScheduleSchema),
  },
  { additionalProperties: false },
);
export type WorkDetailResponse = Static<typeof WorkDetailResponseSchema>;
