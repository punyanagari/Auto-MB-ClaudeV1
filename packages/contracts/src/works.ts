import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  DecimalStringSchema,
  NonNegativeDecimalStringSchema,
  NonNegativeRateStringSchema,
  PositiveDecimalStringSchema,
  RateStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';
import { WorkItemPaymentCategorySchema } from './payment.js';

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

/** The letter's rebate or premium as a percentage of the advertised
 * value: 0 to 100. A rebate cannot exceed the whole advertised value and
 * a negative "below par" is a contradiction in terms, so neither is
 * accepted; above 999.999 the numeric(6,3) column overflowed into an
 * opaque 500 as well. This deliberately does NOT require 'at_par' to
 * carry 0 — the parser models an at-par letter as declaring no
 * percentage at all, and that decision stands. */
export const LetterPercentageSchema = Type.String({
  pattern: '^(?:100(?:\\.0{1,3})?|0(?:\\.\\d{1,3})?|[1-9]\\d?(?:\\.\\d{1,3})?)$',
  description:
    'Percentage between 0 and 100 inclusive, with up to three fraction digits.',
});
export type LetterPercentage = Static<typeof LetterPercentageSchema>;

const WorkCodeSchema = Type.String({ pattern: '^[A-Z0-9][A-Z0-9_/-]{0,19}$' });

/** One corrected item as the reviewer confirms it. `sourceRef` points back
 * into the stored extraction payload (schedule id + printed serial) so the
 * server can attach the parser's verbatim source block as evidence.
 * A row the reviewer ADDED at review time (a letter the parser could not
 * fully serve) carries `manualEntry: true` INSTEAD of a sourceRef; the
 * server records an explicit manual-entry marker as its source evidence.
 * Every item must carry exactly one of the two — the confirm endpoint
 * refuses items with neither (or both). */
export const ConfirmWorkItemSchema = Type.Object(
  {
    itemNumber: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.String({ minLength: 3 }),
    unitCode: Type.String({ minLength: 1, maxLength: 20 }),
    /** Strictly positive (the column's CHECK says so); the rate is only
     * non-negative, because free-issue and nil-rate supply lines are
     * real letters. Both bounds live here so a reviewer who types 0 in
     * one row out of a hundred is told WHICH row, instead of losing the
     * whole confirmation to an unmapped CHECK violation. */
    awardedQuantity: PositiveDecimalStringSchema,
    effectiveRate: NonNegativeRateStringSchema,
    sourceRef: Type.Optional(
      Type.Object(
        {
          scheduleId: Type.String({ minLength: 1, maxLength: 50 }),
          itemSno: Type.String({ minLength: 1, maxLength: 50 }),
        },
        { additionalProperties: false },
      ),
    ),
    manualEntry: Type.Optional(Type.Literal(true)),
    /** Reviewer-set payment category (Milestone 8, spec §8). The parser
     * never proposes it; omitting it leaves the item uncategorised. */
    paymentCategory: Type.Optional(WorkItemPaymentCategorySchema),
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

/** The Performance Bank Guarantee REQUIREMENT the letter demands, as the
 * reviewer confirms it. Distinct from work_instruments kind='pbg' rows
 * (what the contractor actually submitted). The server derives provenance
 * (parser-proposed vs reviewer-corrected) by comparing these values with
 * the stored extraction payload, and retains the printed raw source —
 * clients only ever submit the values themselves. Letters without a
 * performance-guarantee clause simply omit the whole object. */
export const ConfirmPbgRequirementSchema = Type.Object(
  {
    requiredAmount: DecimalStringSchema,
    submissionDays: Type.Integer({ minimum: 1, maximum: 180 }),
    extensionDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 3650 })),
    penalInterestPercent: Type.Optional(DecimalStringSchema),
  },
  { additionalProperties: false },
);
export type ConfirmPbgRequirement = Static<typeof ConfirmPbgRequirementSchema>;

export const ConfirmWorkRequestSchema = Type.Object(
  {
    workCode: WorkCodeSchema,
    letterNumber: Type.String({ minLength: 1, maxLength: 200 }),
    letterDate: DateOnlySchema,
    title: Type.String({ minLength: 3, maxLength: 1000 }),
    advertisedValue: NonNegativeDecimalStringSchema,
    contractValue: NonNegativeDecimalStringSchema,
    pricingShape: PricingShapeSchema,
    letterPercentage: Type.Optional(LetterPercentageSchema),
    letterPercentageDirection: Type.Optional(LetterPercentageDirectionSchema),
    pbgRequirement: Type.Optional(ConfirmPbgRequirementSchema),
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
    /** The letter's PBG requirement (all null when the letter demands
     * none). What the contractor actually submitted lives on the Work's
     * instruments, not here. */
    pbgRequiredAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    pbgSubmissionDays: Type.Union([
      Type.Integer({ minimum: 1, maximum: 180 }),
      Type.Null(),
    ]),
    pbgExtensionDays: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    pbgPenalInterestPercent: Type.Union([DecimalStringSchema, Type.Null()]),
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('completed'),
      Type.Literal('cancelled'),
    ]),
    /** R8 completion state (migration 0031). All null while the Work is
     * active; a reopen clears them again. The full history of every
     * completion and reopen — including the reopen notes, which are not
     * part of the current-state row — is on the Work's timeline. */
    completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    completedByUserId: Type.Union([Type.String(), Type.Null()]),
    completionNote: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    /** Present on the Work detail: PRODUCT.md invariant 5's escape hatch,
     * set by an owner through PATCH /api/works/:id. */
    allowExcessDelivery: Type.Optional(Type.Boolean()),
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
    effectiveRate: RateStringSchema,
    /** Amendment overlays (Milestone 6): null/absent means the original
     * applies. Present on the Work detail response. */
    effectiveQuantity: Type.Optional(Type.Union([DecimalStringSchema, Type.Null()])),
    effectiveUnitRate: Type.Optional(Type.Union([RateStringSchema, Type.Null()])),
    effectiveDescription: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    effectiveUnit: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    amendmentAdded: Type.Optional(Type.Boolean()),
    requiresSerials: Type.Boolean(),
    /** Present on the Work detail response: SUM of non-cancelled
     * quantity-level installation records for the item (Milestone 7) —
     * the authoritative installed quantity Milestone 8 billing reads. */
    installedQuantity: Type.Optional(DecimalStringSchema),
    /** Milestone 8 payment category; null/absent = uncategorised (the
     * item resolves through the Work's UNCATEGORISED matrix row). */
    paymentCategory: Type.Optional(
      Type.Union([WorkItemPaymentCategorySchema, Type.Null()]),
    ),
    /** Present on the Work detail response: SUM of certified quantities
     * over non-cancelled PAC certificates for the item (Milestone 8
     * phase 1) — THE pac_qty the Measurement Book engine consumes. */
    pacCertifiedQuantity: Type.Optional(DecimalStringSchema),
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

/* --- R8 work completion / reopen (Milestone 6/7 retrofit) ------------- */

/** Both lifecycle transitions take a human-entered note (R8, R17); the
 * database CHECK and the 0031 transition trigger hold the same floor —
 * and they measure it TRIMMED, so the note schema does too. A note of
 * three spaces used to satisfy minLength and die at the CHECK, which the
 * operator read as a server error rather than "a note is required". */
export const WorkCompletionNoteSchema = nonBlankString({
  minLength: 3,
  maxLength: 2000,
});

export const CompleteWorkRequestSchema = Type.Object(
  { note: WorkCompletionNoteSchema },
  { additionalProperties: false },
);
export type CompleteWorkRequest = Static<typeof CompleteWorkRequestSchema>;

export const ReopenWorkRequestSchema = Type.Object(
  { note: WorkCompletionNoteSchema },
  { additionalProperties: false },
);
export type ReopenWorkRequest = Static<typeof ReopenWorkRequestSchema>;

export const WorkStatusResponseSchema = Type.Object(
  { work: WorkSchema },
  { additionalProperties: false },
);
export type WorkStatusResponse = Static<typeof WorkStatusResponseSchema>;

/** What the item still owes before the Work is 100% executed. The
 * requirement follows the item's payment category over EFFECTIVE
 * quantities (spec §8 + R8): supply categories owe delivery, pure
 * installation owes installation, supply-and-installation owes both, and
 * an uncategorised item owes installation when its description mentions
 * installation and delivery otherwise. */
export const WorkCompletionRequirementSchema = Type.Union([
  Type.Literal('delivery'),
  Type.Literal('installation'),
  Type.Literal('delivery_and_installation'),
]);
export type WorkCompletionRequirement = Static<typeof WorkCompletionRequirementSchema>;

/** Which way an item misses 100%. The predicate is exact equality, so an
 * over-delivered item (reachable only with the Work's excess-delivery
 * toggle, R4) is as unfinished as a short one — but the remedies are
 * opposite. 'short' amends the sanctioned quantity DOWN; 'excess' amends
 * it UP to match what was delivered, which is exactly what the R7 floor
 * permits and what amending down would be refused for. An item over on
 * either measured dimension is 'excess': while any dimension exceeds the
 * baseline, the floor refuses every reduction, so up is the only move. */
export const WorkCompletionDirectionSchema = Type.Union([
  Type.Literal('short'),
  Type.Literal('excess'),
]);
export type WorkCompletionDirection = Static<typeof WorkCompletionDirectionSchema>;

export const UnfinishedWorkItemSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    /** null = uncategorised: the requirement was derived from the
     * description, which the client shows verbatim. */
    category: Type.Union([WorkItemPaymentCategorySchema, Type.Null()]),
    requirement: WorkCompletionRequirementSchema,
    direction: WorkCompletionDirectionSchema,
    /** coalesce(effective_quantity, awarded_quantity) — the effective
     * baseline the aggregates must equal exactly. */
    requiredQuantity: DecimalStringSchema,
    deliveredQuantity: DecimalStringSchema,
    installedQuantity: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type UnfinishedWorkItem = Static<typeof UnfinishedWorkItemSchema>;

/** `details` of the 409 WORK_NOT_FULLY_EXECUTED — the operator's
 * worklist, each row carrying the direction of its own remedy: short
 * items amend down through the approval path, over-delivered items amend
 * the sanctioned quantity up to match the delivery. */
export const WorkNotFullyExecutedDetailsSchema = Type.Object(
  { unfinishedItems: Type.Array(UnfinishedWorkItemSchema) },
  { additionalProperties: false },
);
export type WorkNotFullyExecutedDetails = Static<
  typeof WorkNotFullyExecutedDetailsSchema
>;

export const WORK_COMPLETION_BLOCKER_KINDS = [
  'draft_delivery_challan',
  'draft_issue_challan',
  'draft_extension_request',
  'draft_measurement_book',
  'pending_approval_request',
] as const;

export const WorkCompletionBlockerSchema = Type.Object(
  {
    kind: Type.Union(WORK_COMPLETION_BLOCKER_KINDS.map((kind) => Type.Literal(kind))),
    recordId: UuidSchema,
    /** Human-readable identity of the blocking record (draft label,
     * proposed item number, …) for the operator's worklist. */
    label: Type.String(),
  },
  { additionalProperties: false },
);
export type WorkCompletionBlocker = Static<typeof WorkCompletionBlockerSchema>;

/** `details` of the 409 WORK_NOT_CLEAN: the adopted clean-state rule —
 * a Work completes only with nothing live still holding a claim. */
export const WorkNotCleanDetailsSchema = Type.Object(
  { blockers: Type.Array(WorkCompletionBlockerSchema) },
  { additionalProperties: false },
);
export type WorkNotCleanDetails = Static<typeof WorkNotCleanDetailsSchema>;

/** What the Work page asks before it offers to complete a Work. The two
 * refusals a completion attempt can raise, answered as a question instead:
 * the operator sees the shortfall before writing a completion note, not
 * after submitting one. Computed by the same functions the POST uses, so
 * the screen and the transition can never disagree. */
export const WorkCompletionReadinessSchema = Type.Object(
  {
    /** True only when both lists are empty and the Work is still active.
     * The caller already holds the status on the Work itself. */
    ready: Type.Boolean(),
    unfinished: Type.Array(UnfinishedWorkItemSchema),
    blockers: Type.Array(WorkCompletionBlockerSchema),
  },
  { additionalProperties: false },
);
export type WorkCompletionReadiness = Static<typeof WorkCompletionReadinessSchema>;
