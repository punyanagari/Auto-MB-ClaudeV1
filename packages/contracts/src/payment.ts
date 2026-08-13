import { Type, type Static } from '@sinclair/typebox';
import { DecimalStringSchema, UuidSchema } from './primitives.js';

/** The item payment categories (spec §8, rule R10) — the four legacy
 * ones plus AMC (migration 0068). An item with no category is
 * "uncategorised" (payment_category NULL) and resolves its stage
 * percentages through the Work's optional UNCATEGORISED matrix row
 * instead.
 *
 * AMC is the annual-maintenance category. Its items are quoted in `Year`
 * (or `Month`) and are never delivered and never installed: a period of
 * maintenance is SERVED and the railway CERTIFIES it, which is why an
 * AMC item is discharged by certified quantity and its matrix row may
 * bill only on the certification and final-bill stages. Before it
 * existed, an AMC schedule resolved to a delivery requirement and made
 * work completion unsatisfiable without a fabricated Delivery Challan —
 * see the migration header. */
export const WORK_ITEM_PAYMENT_CATEGORIES = [
  'SUPPLY',
  'SUPPLY_AND_INSTALLATION',
  'PURE_INSTALLATION',
  'SPARE_SUPPLY',
  'AMC',
] as const;

export const WorkItemPaymentCategorySchema = Type.Union(
  WORK_ITEM_PAYMENT_CATEGORIES.map((category) => Type.Literal(category)),
);
export type WorkItemPaymentCategory = Static<typeof WorkItemPaymentCategorySchema>;

/** Matrix rows are keyed by the item categories plus UNCATEGORISED
 * (the row uncategorised items resolve through). */
export const PAYMENT_MATRIX_CATEGORIES = [
  ...WORK_ITEM_PAYMENT_CATEGORIES,
  'UNCATEGORISED',
] as const;

export const PaymentMatrixCategorySchema = Type.Union(
  PAYMENT_MATRIX_CATEGORIES.map((category) => Type.Literal(category)),
);
export type PaymentMatrixCategory = Static<typeof PaymentMatrixCategorySchema>;

/** One per-Work payment matrix row: the four stage percentages for a
 * category, summing to exactly 100 (R10: percentages live ONLY here —
 * there is deliberately no per-item percentage entry). Percentages are
 * exact decimal strings (numeric(5,2) verbatim); finalised Measurement
 * Books snapshot the percentages they billed with, so editing or
 * deleting a matrix row never alters a finalised record.
 *
 * The AMC row is additionally constrained: `pctSupply` and
 * `pctInstallation` must both be zero, because an AMC item takes no
 * Delivery Challan line and no installation record, so those two stage
 * deltas are permanently zero and value parked on them could never be
 * billed (migration 0068). */
export const PaymentMatrixRowSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    category: PaymentMatrixCategorySchema,
    pctSupply: DecimalStringSchema,
    pctInstallation: DecimalStringSchema,
    pctPac: DecimalStringSchema,
    pctFinalBill: DecimalStringSchema,
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type PaymentMatrixRow = Static<typeof PaymentMatrixRowSchema>;

export const PaymentMatrixResponseSchema = Type.Object(
  { rows: Type.Array(PaymentMatrixRowSchema) },
  { additionalProperties: false },
);
export type PaymentMatrixResponse = Static<typeof PaymentMatrixResponseSchema>;

/** Upsert body for PUT /api/works/:id/payment-matrix/:category. The
 * server validates each percentage 0–100 with at most two decimals and
 * the exact sum of 100 in integer minor units — never floats. */
export const UpsertPaymentMatrixRowRequestSchema = Type.Object(
  {
    pctSupply: DecimalStringSchema,
    pctInstallation: DecimalStringSchema,
    pctPac: DecimalStringSchema,
    pctFinalBill: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type UpsertPaymentMatrixRowRequest = Static<
  typeof UpsertPaymentMatrixRowRequestSchema
>;

/** PATCH /api/work-items/:id/payment-category — the reviewer-editable
 * category assignment. Category is payment configuration, not the
 * contract baseline, so it is owner/office-editable without the
 * amendment approval engine; finalised MB snapshots protect history.
 * null clears the assignment back to uncategorised. */
export const SetWorkItemPaymentCategoryRequestSchema = Type.Object(
  {
    paymentCategory: Type.Union([WorkItemPaymentCategorySchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type SetWorkItemPaymentCategoryRequest = Static<
  typeof SetWorkItemPaymentCategoryRequestSchema
>;

export const WorkItemPaymentCategoryResponseSchema = Type.Object(
  {
    id: UuidSchema,
    itemNumber: Type.String(),
    paymentCategory: Type.Union([WorkItemPaymentCategorySchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkItemPaymentCategoryResponse = Static<
  typeof WorkItemPaymentCategoryResponseSchema
>;
