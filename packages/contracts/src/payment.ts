import { Type, type Static } from '@sinclair/typebox';
import { DecimalStringSchema, UuidSchema } from './primitives.js';

/** The item payment categories (spec §8, rule R10) — the four legacy
 * ones plus AMC (migration 0068) and the residual UNCATEGORISED
 * (migration 0105). An item with NO category (payment_category NULL) is
 * NOT SELECTED YET: it resolves through no row at all, and a
 * Measurement Book naming it refuses to finalize until somebody
 * decides. Choosing UNCATEGORISED IS a decision — the item bills
 * through the Work's residual row.
 *
 * AMC is the annual-maintenance category. Its items are quoted in `Year`
 * (or `Month`) and are never delivered and never installed: a period of
 * maintenance is SERVED and the railway CERTIFIES it, which is why an
 * AMC item is discharged by certified quantity and its matrix row may
 * bill only on the certification and final-bill stages. Before it
 * existed, an AMC schedule resolved to a delivery requirement and made
 * work completion unsatisfiable without a fabricated Delivery Challan —
 * see the migration header. */
export const PAYMENT_MATRIX_CATEGORIES = [
  'SUPPLY',
  'SUPPLY_AND_INSTALLATION',
  'PURE_INSTALLATION',
  'SPARE_SUPPLY',
  'AMC',
  // The residual category (migration 0105). It was a matrix-row key
  // only, which left NULL carrying two meanings the product could not
  // tell apart: "nobody has decided yet" and "decided — bill this
  // through the residual row". An item may now say the second out loud,
  // and NULL means the first and only the first.
  'UNCATEGORISED',
] as const;

/** ONE list, two names for what it describes.
 *
 * There used to be a second constant, `WORK_ITEM_PAYMENT_CATEGORIES`,
 * differing by UNCATEGORISED — a matrix-row key an item could not carry.
 * Migration 0105 let an item carry it, which made the two lists
 * identical, and two exported names for one array is a pair that drifts.
 * The item schema and the matrix schema are both built from this list;
 * the day a matrix row exists that no item may claim, the second list
 * comes back here with a reason attached.
 */
export const WorkItemPaymentCategorySchema = Type.Union(
  PAYMENT_MATRIX_CATEGORIES.map((category) => Type.Literal(category)),
);
export type WorkItemPaymentCategory = Static<typeof WorkItemPaymentCategorySchema>;

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
    /** The residual row's per-Work display name (migration 0105), or
     * null for the product's own wording. Display only — nothing
     * resolves through it, and it is null on every other row. */
    categoryLabel: Type.Union([Type.String(), Type.Null()]),
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
    /** Only the residual row accepts one (migration 0105); the server
     * refuses it on any other category, as the CHECK does. Omitted
     * leaves whatever is stored; explicit null clears it back to the
     * product's own wording. */
    categoryLabel: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 60 }), Type.Null()]),
    ),
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

/** One row of the matrix as the payment-setup dialog submits it: the
 * category it configures plus its four stage percentages. Same values as
 * the per-row upsert body, with the category inside the object because
 * the whole matrix travels in one request. */
const PaymentSetupMatrixRowSchema = Type.Object(
  {
    category: PaymentMatrixCategorySchema,
    pctSupply: DecimalStringSchema,
    pctInstallation: DecimalStringSchema,
    pctPac: DecimalStringSchema,
    pctFinalBill: DecimalStringSchema,
  },
  { additionalProperties: false },
);

const PaymentSetupItemCategorySchema = Type.Object(
  {
    workItemId: UuidSchema,
    paymentCategory: Type.Union([WorkItemPaymentCategorySchema, Type.Null()]),
    /**
     * Whether this value is the keyword proposal the dialog offered,
     * accepted without being touched.
     *
     * Provenance, recorded on the audit event rather than on the row: an
     * accepted proposal and a typed choice produce the identical
     * `payment_category`, and only the trail can say afterwards which act
     * set a category that turns out to be wrong. Without it a review of
     * a mis-categorised item cannot tell "the operator decided this" from
     * "a keyword decided this and nobody looked", which are different
     * findings with different fixes.
     *
     * Optional on the wire and false when absent: it is a statement ABOUT
     * a value, not part of it, and a client that has no proposer to speak
     * for simply does not make the claim. It grants nothing — the value
     * is written and guarded identically either way.
     */
    proposed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type PaymentSetupItemCategory = Static<typeof PaymentSetupItemCategorySchema>;

/**
 * POST /api/works/:id/payment-setup — the whole payment configuration of
 * a Work in ONE request, which is what the post-creation setup dialog
 * asks the operator for and therefore what its Save must do.
 *
 * It exists because the alternative is a burst of up to six matrix
 * upserts and one PATCH per item from the browser: a failure part-way
 * through leaves the Work half-configured with no statement of what
 * landed, and the operator cannot tell which half to redo. One request
 * is one transaction — every row and every item, or none of them.
 *
 * It adds NO authority. Each row goes through the same percentage, sum
 * and AMC rules as the per-row upsert, and each item through the same
 * work-scope, Work-operable, billed and AMC guards as the per-item
 * PATCH — the same functions, not copies of them.
 */
export const SavePaymentSetupRequestSchema = Type.Object(
  {
    matrixRows: Type.Array(PaymentSetupMatrixRowSchema, {
      maxItems: PAYMENT_MATRIX_CATEGORIES.length,
    }),
    /**
     * 500 is the house ceiling for a per-item bulk body — the bound the
     * PAC certificate, purchase order, installation-serial and
     * Measurement Book source arrays all take. The largest Work in the
     * LOA regression corpus carries 129 items, so it is roughly four
     * times the biggest thing the product has seen, and a request naming
     * more than 500 items of one Work is a mistake rather than a save.
     */
    itemCategories: Type.Array(PaymentSetupItemCategorySchema, { maxItems: 500 }),
  },
  { additionalProperties: false },
);
export type SavePaymentSetupRequest = Static<typeof SavePaymentSetupRequestSchema>;

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

/**
 * What the payment-setup save wrote: each item whose category it set.
 *
 * The matrix rows are deliberately NOT returned. Nothing consumed them —
 * the dialog closes on success and the Work page re-reads the matrix,
 * because a save that was partly refused, or a row another operator
 * configured meanwhile, are both things an echo of the request could not
 * have told it. The items are here because the Work page folds them into
 * its own copy of the schedules rather than refetching the whole Work.
 */
export const PaymentSetupResponseSchema = Type.Object(
  { items: Type.Array(WorkItemPaymentCategoryResponseSchema) },
  { additionalProperties: false },
);
export type PaymentSetupResponse = Static<typeof PaymentSetupResponseSchema>;
