import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  DecimalStringSchema,
  NonNegativeMoneyStringSchema,
  PositiveMoneyStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';

/**
 * Retention money, and liquidated damages.
 *
 * The two halves of what a railway keeps out of a bill for reasons that
 * are not tax. Retention is WITHHELD and comes back; liquidated damages
 * are KEPT and do not. Migration 0067 already records both as deduction
 * heads on a payment advice — this module is what a deduction cannot say
 * on its own: what is still held, and whether the damages were the right
 * number.
 *
 * NOTHING HERE IS ADDED UP IN THE BROWSER. Every money figure is a
 * decimal string the server computed in exact PostgreSQL numeric, and the
 * liquidated-damages arithmetic in particular is a set of GENERATED
 * COLUMNS (migration 0098 § 3), so there is one computation of it in the
 * whole product and neither this package nor `apps/web` performs it.
 */

// ── The contract's terms ─────────────────────────────────────────────

/**
 * A percentage of something, at the scale `numeric(6,3)` stores.
 *
 * Deliberately its own schema rather than `DecimalStringSchema`, which
 * admits fifteen integer digits: a retention rate of `1000` is not a
 * typo the database will catch, it is a CHECK violation surfacing as a
 * bare 500. Bounded at the boundary, where the validator can name the
 * field.
 */
const PercentTermSchema = Type.String({
  pattern: '^(?:100(?:\\.0{1,3})?|\\d{1,2}(?:\\.\\d{1,3})?)$',
  description:
    'A contractual percentage, 0 to 100 inclusive, with up to three fraction digits — the scale of the numeric(6,3) column that stores it.',
});

/**
 * The chargeable liquidated-damages period, in DAYS.
 *
 * Days rather than a calendar unit, and the reasoning is in migration
 * 0098 § 1 at length: a railway clause reads "0.5% per week" or "2% per
 * month", a calendar month is not a fixed quantity, and a product that
 * silently picks one reading of "month" over a delay measured in days is
 * asserting a contract term nobody told it. 7 is a week, 30 is the usual
 * reading of a month, and anything else the contract states is typed in.
 */
const LdPeriodDaysSchema = Type.Integer({ minimum: 1, maximum: 366 });

export const WorkRetentionTermsSchema = Type.Object(
  {
    /** Withheld from each on-account bill, as a percentage of the bill. */
    retentionPercent: Type.Union([PercentTermSchema, Type.Null()]),
    /** The ceiling on the CUMULATIVE hold, as a percentage of contract
     * value. A separate number from the one above, because the usual
     * contract withholds 10% of each bill up to 5% of the contract. */
    retentionLimitPercent: Type.Union([PercentTermSchema, Type.Null()]),
    defectLiabilityMonths: Type.Union([
      Type.Integer({ minimum: 0, maximum: 120 }),
      Type.Null(),
    ]),
    /** The LD triple travels together or not at all: an assessment needs
     * a rate, a period and a cap, and two of the three is a computation
     * that cannot be made. */
    ldRatePercent: Type.Union([PercentTermSchema, Type.Null()]),
    ldPeriodDays: Type.Union([LdPeriodDaysSchema, Type.Null()]),
    ldCapPercent: Type.Union([PercentTermSchema, Type.Null()]),
    sourceClause: Type.Union([Type.String(), Type.Null()]),
    notes: Type.Union([Type.String(), Type.Null()]),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type WorkRetentionTerms = Static<typeof WorkRetentionTermsSchema>;

/**
 * Saving the terms.
 *
 * A whole-record PUT rather than a patch, because the coherence rules are
 * about the record and not about a field: the LD triple must arrive
 * complete or empty, and at least one term must be present for the row to
 * exist at all. A patch would let a caller clear one third of the triple
 * and leave the database to refuse a shape the route could have named.
 */
export const SaveWorkRetentionTermsRequestSchema = Type.Object(
  {
    retentionPercent: Type.Optional(PercentTermSchema),
    retentionLimitPercent: Type.Optional(PercentTermSchema),
    defectLiabilityMonths: Type.Optional(Type.Integer({ minimum: 0, maximum: 120 })),
    ldRatePercent: Type.Optional(PercentTermSchema),
    ldPeriodDays: Type.Optional(LdPeriodDaysSchema),
    ldCapPercent: Type.Optional(PercentTermSchema),
    sourceClause: Type.Optional(nonBlankString({ minLength: 2, maxLength: 200 })),
    notes: Type.Optional(nonBlankString({ minLength: 2, maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export type SaveWorkRetentionTermsRequest = Static<
  typeof SaveWorkRetentionTermsRequestSchema
>;

// ── The releases ─────────────────────────────────────────────────────

/**
 * Why retention came back. Four typed values rather than free text, for
 * the reason 0067's deduction heads are typed: each is a different
 * conversation with the railway backed by a different document.
 */
export const RETENTION_RELEASE_BASES = [
  'pac',
  'defect_liability_end',
  'bank_guarantee_substitution',
  'other',
] as const;
const RetentionReleaseBasisSchema = Type.Union(
  RETENTION_RELEASE_BASES.map((basis) => Type.Literal(basis)),
);
export type RetentionReleaseBasis = Static<typeof RetentionReleaseBasisSchema>;

export const RetentionReleaseSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    releasedOn: DateOnlySchema,
    amount: PositiveMoneyStringSchema,
    basis: RetentionReleaseBasisSchema,
    workInstrumentId: Type.Union([UuidSchema, Type.Null()]),
    /** The guarantee's own reference, so a substitution release reads as
     * a sentence rather than as a uuid. Null when none is named. */
    workInstrumentReference: Type.Union([Type.String(), Type.Null()]),
    reference: Type.Union([Type.String(), Type.Null()]),
    description: Type.Union([Type.String(), Type.Null()]),
    remarks: Type.Union([Type.String(), Type.Null()]),
    voidedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    voidReason: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type RetentionRelease = Static<typeof RetentionReleaseSchema>;

export const RecordRetentionReleaseRequestSchema = Type.Object(
  {
    releasedOn: DateOnlySchema,
    amount: PositiveMoneyStringSchema,
    basis: RetentionReleaseBasisSchema,
    /** Required when the basis is `bank_guarantee_substitution`; the
     * route refuses the combination by name so an operator is not left
     * reading a CHECK violation. */
    workInstrumentId: Type.Optional(UuidSchema),
    reference: Type.Optional(nonBlankString({ minLength: 2, maxLength: 100 })),
    /** Required when the basis is `other`, for the same reason an `OTHER`
     * deduction requires one: an unnamed head cannot be reconciled. */
    description: Type.Optional(nonBlankString({ minLength: 3, maxLength: 200 })),
    remarks: Type.Optional(nonBlankString({ minLength: 2, maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type RecordRetentionReleaseRequest = Static<
  typeof RecordRetentionReleaseRequestSchema
>;

/** Withdrawing a release. The reason is required: retracting a record
 * that money came back is never self-evident from the record. */
export const VoidRetentionReleaseRequestSchema = Type.Object(
  { reason: nonBlankString({ minLength: 3, maxLength: 500 }) },
  { additionalProperties: false },
);

// ── Liquidated damages ───────────────────────────────────────────────

export const LD_ASSESSMENT_STATUSES = [
  'draft',
  'levied',
  'waived',
  'cancelled',
] as const;
const LdAssessmentStatusSchema = Type.Union(
  LD_ASSESSMENT_STATUSES.map((status) => Type.Literal(status)),
);
export type LdAssessmentStatus = Static<typeof LdAssessmentStatusSchema>;

/**
 * One assessment, with the snapshot it was computed from beside the
 * figures the database derived.
 *
 * Both halves travel because the assessment is an ARGUMENT: an agency
 * that cannot show the railway which completion date, which rate and
 * which cap produced ₹7,50,000 has a number and no case. The inputs are
 * frozen on the row at assessment, so a later extension or amendment
 * never rewrites a figure already put in front of the railway.
 */
export const LdAssessmentSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    assessedOn: DateOnlySchema,
    status: LdAssessmentStatusSchema,

    basisAmount: PositiveMoneyStringSchema,
    basisLabel: Type.String(),
    scheduledCompletionDate: DateOnlySchema,
    assessedToDate: DateOnlySchema,
    ldRatePercent: DecimalStringSchema,
    ldPeriodDays: LdPeriodDaysSchema,
    ldCapPercent: DecimalStringSchema,

    /** Derived by the database, never here. */
    delayDays: Type.Integer({ minimum: 0 }),
    chargeablePeriods: Type.Integer({ minimum: 0 }),
    /** What the rate alone would charge, before the cap — shown beside
     * the assessment so an operator can see that the cap bit. */
    uncappedAmount: NonNegativeMoneyStringSchema,
    capAmount: NonNegativeMoneyStringSchema,
    assessedAmount: NonNegativeMoneyStringSchema,

    leviedAmount: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),
    levyReference: Type.Union([Type.String(), Type.Null()]),
    outcomeReason: Type.Union([Type.String(), Type.Null()]),
    notes: Type.Union([Type.String(), Type.Null()]),
    decidedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type LdAssessment = Static<typeof LdAssessmentSchema>;

/**
 * Making an assessment.
 *
 * The request carries the WINDOW and the BASIS and nothing else: the rate,
 * the period and the cap are read from the Work's recorded terms by the
 * route and snapshotted, so an assessment cannot quietly be computed at a
 * rate the contract never stated. `basisAmount` is optional and defaults
 * to the Work's contract value; it is settable because LD is sometimes
 * charged only on the late PORTION of a contract, and `basisLabel` is
 * then what says so.
 */
export const AssessLdRequestSchema = Type.Object(
  {
    assessedOn: DateOnlySchema,
    assessedToDate: DateOnlySchema,
    basisAmount: Type.Optional(PositiveMoneyStringSchema),
    basisLabel: Type.Optional(nonBlankString({ minLength: 3, maxLength: 200 })),
    notes: Type.Optional(nonBlankString({ minLength: 2, maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export type AssessLdRequest = Static<typeof AssessLdRequestSchema>;

/**
 * Deciding one.
 *
 * `levy` carries what the railway actually took, which is ordinarily
 * negotiated below the assessment and may never exceed it. `waive` and
 * `cancel` each carry a reason, and they are two decisions rather than
 * one because "the railway forgave the delay" and "we computed this
 * wrongly" are different facts about the same Work.
 */
export const DecideLdAssessmentRequestSchema = Type.Union([
  Type.Object(
    {
      decision: Type.Literal('levy'),
      leviedAmount: NonNegativeMoneyStringSchema,
      levyReference: Type.Optional(nonBlankString({ minLength: 2, maxLength: 100 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      decision: Type.Union([Type.Literal('waive'), Type.Literal('cancel')]),
      reason: nonBlankString({ minLength: 3, maxLength: 500 }),
    },
    { additionalProperties: false },
  ),
]);
export type DecideLdAssessmentRequest = Static<typeof DecideLdAssessmentRequestSchema>;

// ── The position ─────────────────────────────────────────────────────

/**
 * One Work's retention and liquidated-damages position.
 *
 * `retentionHeldTotal` is DERIVED from the SECURITY_DEPOSIT deductions of
 * migration 0067 — money the railway actually withheld — rather than
 * stored, so it cannot disagree with the payment register.
 *
 * `ldLeviedTotal` and `ldDeductedTotal` are reported side by side and are
 * NEVER subtracted from one another. One is the agency's own assessment
 * record and the other is what the railway took under that head on a
 * payment advice; their difference is a conversation to have, not a
 * balance to display. Migration 0098's header argues it in full.
 */
export const WorkRetentionPositionSchema = Type.Object(
  {
    workId: UuidSchema,
    contractValue: DecimalStringSchema,
    /** The contractual ceiling in rupees, or null when the terms were
     * never recorded — a ceiling nobody stated is not a ceiling of zero. */
    retentionCeilingAmount: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),
    retentionHeldTotal: NonNegativeMoneyStringSchema,
    retentionReleasedTotal: NonNegativeMoneyStringSchema,
    retentionBalance: NonNegativeMoneyStringSchema,
    ldLeviedTotal: NonNegativeMoneyStringSchema,
    ldDeductedTotal: NonNegativeMoneyStringSchema,
    ldOpenAssessments: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type WorkRetentionPosition = Static<typeof WorkRetentionPositionSchema>;

/** Everything one screen needs, in one read. The Work's retention story
 * is small and is always read whole; paging four rows would cost a
 * round-trip to save nothing. */
export const WorkRetentionResponseSchema = Type.Object(
  {
    position: WorkRetentionPositionSchema,
    terms: Type.Union([WorkRetentionTermsSchema, Type.Null()]),
    releases: Type.Array(RetentionReleaseSchema),
    assessments: Type.Array(LdAssessmentSchema),
    /** The Work's contractual completion date as it currently stands,
     * including granted extensions — the date an assessment measures the
     * delay FROM. Null on a Work whose letter stated none, which is the
     * case an assessment cannot be made in. */
    currentCompletionDate: Type.Union([DateOnlySchema, Type.Null()]),
    /** The Work's guarantees, so a substitution release can name one
     * without a second round-trip. Active instruments only: a lapsed
     * guarantee substitutes for nothing. */
    instruments: Type.Array(
      Type.Object(
        {
          id: UuidSchema,
          kind: Type.String(),
          reference: Type.String(),
          amount: Type.Union([DecimalStringSchema, Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type WorkRetentionResponse = Static<typeof WorkRetentionResponseSchema>;
