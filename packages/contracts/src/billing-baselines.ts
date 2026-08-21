import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  NonNegativeDecimalStringSchema,
  NonNegativeMoneyStringSchema,
  PositiveMoneyStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';

/**
 * The opening billing position of a Work whose history predates this
 * product (migration 0114; owner ruling, live-testing corrections item
 * 23).
 *
 * Works imported at the v1 cutover carry their challans, installations
 * and serials and no Measurement Books at all, so their billing history
 * is unrecordable: migration 0066 needs a bill to name a book and 0111
 * needs that book to carry a matched measurement. A baseline is the way
 * in — the last railway bill, the last measurement sheet it was raised
 * from, and a per-item statement of what had been billed by then.
 *
 * NOTHING HERE IS ASSERTED OVER THE WIRE ON THE WAY IN except what a
 * person is deliberately stating. The uploads carry a file and a
 * filename; the bill's number, date, amount and measurement sequence are
 * read on the server, and the query overrides below exist only for the
 * document whose text this product cannot read at all. The per-item
 * figures ARE typed — that is the point of them — and each one carries
 * the name of the member who confirmed it.
 */

/** The five heads an opening deduction can be under. Closed, because a
 * free-text head makes the receivables arithmetic a sum over whatever
 * anybody typed and two spellings of "retention" are each half the
 * money. */
const DEDUCTION_HEADS = [
  'security_deposit',
  'retention',
  'liquidated_damages',
  'income_tax_tds',
  'gst_tds',
] as const;
export const DeductionHeadSchema = Type.Union(
  DEDUCTION_HEADS.map((head) => Type.Literal(head)),
);
export type DeductionHead = Static<typeof DeductionHeadSchema>;

/** How the bill's own figures came to be known: read from the PDF's text,
 * or typed by a named member from a document this product cannot read.
 * Migration 0111's readable/unreadable split, one document further
 * back. */
const BillingBaselineBillSourceSchema = Type.Union([
  Type.Literal('extracted'),
  Type.Literal('recorded'),
]);
export type BillingBaselineBillSource = Static<typeof BillingBaselineBillSourceSchema>;

/**
 * POST /api/works/:id/billing-baseline — the raw PDF is the body.
 *
 * The four optional figures are the `recorded` path and nothing else. A
 * bill this product can read supplies them itself and REFUSES a request
 * that also states them, because a figure typed beside a figure extracted
 * is two claims about one document and there is no honest way to pick.
 * A bill it cannot read requires all four together.
 */
export const BillingBaselineUploadQuerySchema = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 300 }),
    // NOT `nonBlankString`: its pattern is built as `{minLength - 2,}`
    // and a one-character minimum makes that an invalid quantifier, which
    // Fastify reports at boot. Migration 0111's own contract carries the
    // same note beside the same workaround.
    billNumber: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        pattern: '^\\S(?:[\\s\\S]*\\S)?$',
        description: 'A railway bill number, with no surrounding spaces.',
      }),
    ),
    billDate: Type.Optional(DateOnlySchema),
    billAmount: Type.Optional(PositiveMoneyStringSchema),
    lastMbSequenceNumber: Type.Optional(Type.Integer({ minimum: 1, maximum: 9999 })),
  },
  { additionalProperties: false },
);

/** POST /api/billing-baselines/:id/measurement — the raw PDF is the body.
 * The sheet the proposal is derived from; optional, because an agency
 * that has lost it still gets a baseline, line by line. */
export const BillingBaselineMeasurementQuerySchema = Type.Object(
  { filename: Type.String({ minLength: 1, maxLength: 300 }) },
  { additionalProperties: false },
);

export const WorkBillingBaselineSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    billNumber: Type.String(),
    billDate: DateOnlySchema,
    /** The bill's own total, GST-inclusive as IWRCMS prints it. Shown
     * beside the proposed per-item sum as the operator's cross-check; it
     * is deliberately NOT compared for equality on the server, because
     * the two are on different tax bases and `executed-value.ts` owns
     * that conversion. */
    billAmount: PositiveMoneyStringSchema,
    billSource: BillingBaselineBillSourceSchema,
    billFilename: Type.String(),
    billSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    /** The measurement sequence the recorded bill settles. The Work's
     * Measurement Book counter resumes at this plus one when the baseline
     * locks. */
    lastMbSequenceNumber: Type.Integer({ minimum: 1 }),
    /** The uploaded measurement sheet, or null where none was given. */
    measurementFilename: Type.Union([Type.String(), Type.Null()]),
    lockedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    lockedByUserId: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type WorkBillingBaseline = Static<typeof WorkBillingBaselineSchema>;

export const WorkBillingBaselineLineSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    description: Type.String(),
    unitCode: Type.String(),
    /** What this item had been billed for by the recorded bill, per stage
     * and PHYSICAL — the same reading `measurement_book_lines.prior_*`
     * carries, which is what these are added to once the baseline
     * locks. */
    priorSupplied: NonNegativeDecimalStringSchema,
    priorInstalled: NonNegativeDecimalStringSchema,
    priorPac: NonNegativeDecimalStringSchema,
    priorFinalBill: NonNegativeDecimalStringSchema,
    /** Cumulative rupees billed on this item by then. */
    amount: NonNegativeMoneyStringSchema,
    /** The proposal exactly as it was made, kept beside the confirmed
     * figures rather than overwritten by them: what a parser read and
     * what a person accepted are two statements, and only keeping the
     * second could never answer "did anybody change this?". Null on a
     * line nothing was proposed for. */
    proposedSupplied: Type.Union([NonNegativeDecimalStringSchema, Type.Null()]),
    proposedInstalled: Type.Union([NonNegativeDecimalStringSchema, Type.Null()]),
    proposedPac: Type.Union([NonNegativeDecimalStringSchema, Type.Null()]),
    proposedFinalBill: Type.Union([NonNegativeDecimalStringSchema, Type.Null()]),
    proposedAmount: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),
    /** The railway's own remark the proposal was read out of, verbatim,
     * so the figures can be argued with rather than only accepted. */
    proposedFromRemark: Type.Union([Type.String(), Type.Null()]),
    confirmedByUserId: Type.Union([Type.String(), Type.Null()]),
    confirmedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkBillingBaselineLine = Static<typeof WorkBillingBaselineLineSchema>;

export const WorkDeductionEntrySchema = Type.Object(
  {
    head: DeductionHeadSchema,
    amount: NonNegativeMoneyStringSchema,
    note: Type.Union([Type.String(), Type.Null()]),
    recordedByUserId: Type.String(),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type WorkDeductionEntry = Static<typeof WorkDeductionEntrySchema>;

export const WorkBillingBaselineResponseSchema = Type.Object(
  {
    /** Null on a Work that has no baseline — which is every Work born in
     * this product. */
    baseline: Type.Union([WorkBillingBaselineSchema, Type.Null()]),
    /** Whether this Work could still be given an opening position: true
     * only while it has never numbered a Measurement Book here. Derived
     * on the server rather than inferred from the empty book register,
     * so the screen and migration 0114's guard cannot disagree about a
     * Work whose only book was cancelled. */
    openable: Type.Boolean(),
    lines: Type.Array(WorkBillingBaselineLineSchema),
    /** Every head with a figure recorded against it, in head order.
     * Present even on a Work with no baseline: the deductions are
     * editable until one is locked, so they can be recorded first. */
    deductions: Type.Array(WorkDeductionEntrySchema),
    /** THE RECEIVABLES POSITION, gross to net, derived on the server so
     * the screen cannot compute a different one: the sum of the line
     * amounts, the sum of the deduction heads, and gross minus net —
     * floored at zero, because deductions exceeding the gross is a data
     * error to be looked at rather than a negative receivable to be
     * reported. */
    grossBilledToDate: NonNegativeMoneyStringSchema,
    deductionsTotal: NonNegativeMoneyStringSchema,
    netReceivable: NonNegativeMoneyStringSchema,
  },
  { additionalProperties: false },
);
export type WorkBillingBaselineResponse = Static<
  typeof WorkBillingBaselineResponseSchema
>;

/** One line's figures as an operator states them. Every field is
 * required: a partial statement of an opening position is what leaves a
 * stage silently at zero. */
const SetBillingBaselineLineSchema = Type.Object(
  {
    workItemId: UuidSchema,
    priorSupplied: NonNegativeDecimalStringSchema,
    priorInstalled: NonNegativeDecimalStringSchema,
    priorPac: NonNegativeDecimalStringSchema,
    priorFinalBill: NonNegativeDecimalStringSchema,
    amount: NonNegativeMoneyStringSchema,
  },
  { additionalProperties: false },
);

/**
 * PUT /api/billing-baselines/:id/lines — states the figures for the named
 * items and leaves every other line exactly as it was.
 *
 * NOT a wholesale replacement, unlike the Measurement Book's sources and
 * measured quantities. Those are instructions to a computation that is
 * re-run in full; these are a hundred-odd hand-checked lines confirmed
 * one at a time over what may be several sittings, and a request that
 * replaced the set would reset the ones nobody sent.
 *
 * A line whose figures MOVE loses its confirmation, because the
 * confirmation was about the figures that were there.
 */
export const SetBillingBaselineLinesRequestSchema = Type.Object(
  { lines: Type.Array(SetBillingBaselineLineSchema, { minItems: 1, maxItems: 500 }) },
  { additionalProperties: false },
);
export type SetBillingBaselineLinesRequest = Static<
  typeof SetBillingBaselineLinesRequestSchema
>;

/** POST /api/billing-baselines/:id/lines/confirm — one line, by the item
 * number the operator can see on both documents. Deliberately singular,
 * for migration 0111's reason: the confirmation is an act per line, and a
 * request taking a list would be the single click the model refuses. */
export const ConfirmBillingBaselineLineRequestSchema = Type.Object(
  {
    itemNumber: Type.String({
      minLength: 1,
      maxLength: 100,
      pattern: '^\\S(?:[\\s\\S]*\\S)?$',
      description: 'A Work item number, with no surrounding spaces.',
    }),
  },
  { additionalProperties: false },
);
export type ConfirmBillingBaselineLineRequest = Static<
  typeof ConfirmBillingBaselineLineRequestSchema
>;

/** PUT /api/works/:id/deductions — replaces the whole set. Unlike the
 * baseline lines this IS wholesale: there are five heads, they are read
 * together as one position, and a head left out means nothing was
 * withheld under it. */
export const SetWorkDeductionsRequestSchema = Type.Object(
  {
    deductions: Type.Array(
      Type.Object(
        {
          head: DeductionHeadSchema,
          amount: NonNegativeMoneyStringSchema,
          note: Type.Optional(nonBlankString({ minLength: 3, maxLength: 500 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 5 },
    ),
  },
  { additionalProperties: false },
);
export type SetWorkDeductionsRequest = Static<typeof SetWorkDeductionsRequestSchema>;
