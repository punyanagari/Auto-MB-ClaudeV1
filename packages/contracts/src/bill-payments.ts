import { Type, type Static } from '@sinclair/typebox';
import { BillStatusSchema } from './retention.js';
import { BILL_DEDUCTION_HEADS } from './statutory.js';
import {
  DateOnlySchema,
  DecimalStringSchema,
  NonNegativeMoneyStringSchema,
  PositiveMoneyStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';

/**
 * Money received from the railway, and what the railway kept out of it.
 *
 * The shape to notice is that a payment reports THREE figures and never
 * one. `receivedAmount` is what reached the bank; `deductionTotal` is what
 * was withheld; `grossAmount` is their sum, which is the part of the bill
 * this receipt settles. A screen that shows only the first understates the
 * settlement by the deductions, and that is precisely the mistake the
 * spreadsheet this replaces was making.
 */

/**
 * The heads a railway payment is reduced by.
 *
 * Most have a statutory or contractual identity and are reclaimed,
 * reconciled or released through a named form: GST TDS surfaces in
 * GSTR-7A, income-tax TDS on Form 26AS, a security deposit is released at
 * PAC or at the end of maintenance, BOCW cess is reconciled against a
 * cess return, and liquidated damages are argued under a named contract
 * clause. `OTHER` is the head that always turns up, and it is the only
 * one that cannot be recorded without saying what it is.
 *
 * The list itself lives in `packages/contracts/src/statutory.ts` with each head's provision
 * and rate beside it, because the same facts are needed by the web half
 * to label a field and by the server half to compute. This alias is kept
 * so the many existing importers of `BILL_DEDUCTION_CATEGORIES` do not
 * all have to move at once.
 */
export const BILL_DEDUCTION_CATEGORIES = BILL_DEDUCTION_HEADS;
export const BillDeductionCategorySchema = Type.Union(
  BILL_DEDUCTION_CATEGORIES.map((category) => Type.Literal(category)),
);
export type BillDeductionCategory = Static<typeof BillDeductionCategorySchema>;

export const BillPaymentDeductionSchema = Type.Object(
  {
    id: UuidSchema,
    category: BillDeductionCategorySchema,
    amount: PositiveMoneyStringSchema,
    /** Required on `OTHER` and optional elsewhere: a named head explains
     * itself, an unnamed one has to be explained. */
    description: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type BillPaymentDeduction = Static<typeof BillPaymentDeductionSchema>;

export const BillPaymentSchema = Type.Object(
  {
    id: UuidSchema,
    billId: UuidSchema,
    receivedOn: DateOnlySchema,
    /** What reached the bank. Zero is legitimate — a bill entirely
     * consumed by a recovery is a real event and has to be recordable. */
    receivedAmount: NonNegativeMoneyStringSchema,
    reference: Type.Union([Type.String(), Type.Null()]),
    remarks: Type.Union([Type.String(), Type.Null()]),
    deductions: Type.Array(BillPaymentDeductionSchema),
    /** Summed in SQL, never in the browser. */
    deductionTotal: NonNegativeMoneyStringSchema,
    /** `receivedAmount + deductionTotal`: the part of the bill this
     * receipt settles, which is what the outstanding position moves by. */
    grossAmount: NonNegativeMoneyStringSchema,
    voidedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    voidReason: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type BillPayment = Static<typeof BillPaymentSchema>;

/**
 * Recording a receipt and its breakup in one act.
 *
 * The deductions arrive with the payment rather than through their own
 * endpoint because that is how the paper arrives: a payment advice states
 * the gross, the heads and the net together, and a half-entered advice is
 * a wrong settlement position rather than an incomplete one.
 */
export const RecordBillPaymentRequestSchema = Type.Object(
  {
    receivedOn: DateOnlySchema,
    receivedAmount: NonNegativeMoneyStringSchema,
    reference: Type.Optional(nonBlankString({ minLength: 3, maxLength: 100 })),
    remarks: Type.Optional(nonBlankString({ minLength: 3, maxLength: 500 })),
    deductions: Type.Array(
      Type.Object(
        {
          category: BillDeductionCategorySchema,
          amount: PositiveMoneyStringSchema,
          description: Type.Optional(nonBlankString({ minLength: 3, maxLength: 200 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);
export type RecordBillPaymentRequest = Static<typeof RecordBillPaymentRequestSchema>;

/** Retracting a receipt. The reason is required, unlike a discarded
 * document's: withdrawing a recorded receipt of money is never
 * self-evident from the record itself. */
export const VoidBillPaymentRequestSchema = Type.Object(
  { reason: nonBlankString({ minLength: 3, maxLength: 500 }) },
  { additionalProperties: false },
);
export type VoidBillPaymentRequest = Static<typeof VoidBillPaymentRequestSchema>;

/**
 * Outstanding with the railway, for one prepared bill.
 *
 * `railwayBillAmount` is the reference the position is measured against —
 * the railway's own On-Account Bill figure, extracted from its PDF and
 * GST-inclusive — and not `preparedAmount`, which is what the agency
 * prepared on the Work's recorded GST basis. Both are reported so a
 * difference between them is visible; only the first is subtracted from.
 * `docs/PRODUCT.md` §5.7 states why.
 *
 * `outstandingAmount` is null exactly when `railwayBillAmount` is: until
 * the measurement is closed by a verified railway bill there is no agreed
 * figure to be outstanding against, and reporting the prepared amount as
 * outstanding would state a debt the railway has not acknowledged.
 */
export const BillSettlementPositionSchema = Type.Object(
  {
    billId: UuidSchema,
    workId: UuidSchema,
    billNumber: Type.Integer({ minimum: 1 }),
    status: BillStatusSchema,
    preparedAmount: DecimalStringSchema,
    measurementBookId: Type.Union([UuidSchema, Type.Null()]),
    measurementBookNumber: Type.Union([Type.String(), Type.Null()]),
    measurementClosedAt: Type.Union([
      Type.String({ format: 'date-time' }),
      Type.Null(),
    ]),
    receivedRailwayBillId: Type.Union([UuidSchema, Type.Null()]),
    railwayBillNumber: Type.Union([Type.String(), Type.Null()]),
    railwayBillDate: Type.Union([DateOnlySchema, Type.Null()]),
    railwayBillAmount: Type.Union([PositiveMoneyStringSchema, Type.Null()]),
    receivedTotal: NonNegativeMoneyStringSchema,
    /** Money the railway KEPT. Settled, not outstanding — the whole
     * reason the position takes three figures. */
    deductionTotal: NonNegativeMoneyStringSchema,
    outstandingAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    payments: Type.Array(BillPaymentSchema),
  },
  { additionalProperties: false },
);
export type BillSettlementPosition = Static<typeof BillSettlementPositionSchema>;

export const BillSettlementResponseSchema = Type.Object(
  { positions: Type.Array(BillSettlementPositionSchema) },
  { additionalProperties: false },
);
export type BillSettlementResponse = Static<typeof BillSettlementResponseSchema>;
