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
const BILL_DEDUCTION_CATEGORIES = BILL_DEDUCTION_HEADS;
const BillDeductionCategorySchema = Type.Union(
  BILL_DEDUCTION_CATEGORIES.map((category) => Type.Literal(category)),
);
export type BillDeductionCategory = Static<typeof BillDeductionCategorySchema>;

const BillPaymentDeductionSchema = Type.Object(
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
const BillSettlementPositionSchema = Type.Object(
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

/**
 * One head's share of everything the railway kept against one bill.
 *
 * Aggregated in SQL across the bill's live receipts, because the register
 * draws a waterfall from the passed amount down to what is outstanding and
 * a waterfall is a sequence of TOTALS. The per-receipt breakup already
 * travels on `BillPayment.deductions`; summing those by head in the browser
 * to draw this would be exactly the money arithmetic engineering rule 5
 * forbids, and it would be wrong the first time a bill is settled by two
 * receipts that both withheld security deposit.
 */
const BillDeductionHeadTotalSchema = Type.Object(
  {
    category: BillDeductionCategorySchema,
    amount: NonNegativeMoneyStringSchema,
  },
  { additionalProperties: false },
);
export type BillDeductionHeadTotal = Static<typeof BillDeductionHeadTotalSchema>;

/**
 * A settlement position as the organisation-wide receivables register
 * reads it.
 *
 * The per-Work position plus the four things a register needs that a
 * Work's own screen already knows from context: whose Work the row is,
 * when the bill went in, which financial year it lands in, and the two
 * derived money figures the waterfall draws. Composed over
 * `BillSettlementPositionSchema` rather than restated beside it, so the
 * two surfaces cannot drift into reporting one bill differently.
 */
const ReceivablesRegisterEntrySchema = Type.Composite(
  [
    BillSettlementPositionSchema,
    Type.Object({
      workCode: Type.String(),
      workTitle: Type.String(),
      /** When the agency's own bill was submitted. The first step of the
       * register's lifecycle strip; null while the bill is only prepared. */
      submittedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
      /**
       * The financial year this receivable belongs to, `2026-27`.
       *
       * Derived from the RAILWAY bill's date, not the agency's — the year a
       * receivable falls in is the year the railway acknowledged it — and
       * therefore null for exactly as long as `railwayBillAmount` is null.
       * A bill the railway has not yet passed is not yet a receivable in
       * any year, and stamping it with the year it was prepared in would
       * put it in the wrong one every March.
       */
      financialYear: Type.Union([
        Type.String({ pattern: '^[0-9]{4}-[0-9]{2}$' }),
        Type.Null(),
      ]),
      /** `railwayBillAmount - deductionTotal`: what the railway owed after
       * what it kept, which is the figure the credits are measured against.
       * Null with `railwayBillAmount`, and computed in SQL for the same
       * reason every other figure here is. */
      netPayableAmount: Type.Union([DecimalStringSchema, Type.Null()]),
      deductionsByHead: Type.Array(BillDeductionHeadTotalSchema),
    }),
  ],
  { additionalProperties: false },
);
export type ReceivablesRegisterEntry = Static<typeof ReceivablesRegisterEntrySchema>;

/**
 * The register's four figures, over every row the caller may see.
 *
 * Over the whole scoped register and never over a page of it: totals on
 * screen have to be the organisation's totals, or the tiles quietly answer
 * a different question than the table below them.
 */
const ReceivablesRegisterSummarySchema = Type.Object(
  {
    /** What the agency prepared, summed over `preparedAmount`. */
    claimedTotal: DecimalStringSchema,
    /** What the railway acknowledged, summed over `railwayBillAmount`.
     * Bills it has not passed contribute nothing rather than their
     * prepared figure. */
    passedTotal: DecimalStringSchema,
    receivedTotal: DecimalStringSchema,
    outstandingTotal: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type ReceivablesRegisterSummary = Static<
  typeof ReceivablesRegisterSummarySchema
>;

export const ReceivablesRegisterResponseSchema = Type.Object(
  {
    entries: Type.Array(ReceivablesRegisterEntrySchema),
    summary: ReceivablesRegisterSummarySchema,
  },
  { additionalProperties: false },
);
export type ReceivablesRegisterResponse = Static<
  typeof ReceivablesRegisterResponseSchema
>;
