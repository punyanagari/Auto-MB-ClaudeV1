import { Type, type Static } from '@sinclair/typebox';
import { InstallationCountsSchema } from './installations.js';
import {
  DateOnlySchema,
  DecimalStringSchema,
  GstRateSchema,
  HsnCodeSchema,
  NonNegativeDecimalStringSchema,
  NonNegativeRateStringSchema,
  PositiveDecimalStringSchema,
  RateStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';
import {
  PAYMENT_MATRIX_CATEGORIES,
  PaymentMatrixCategorySchema,
  WorkItemPaymentCategorySchema,
} from './payment.js';

const PricingShapeSchema = Type.Union([
  Type.Literal('letter_percentage'),
  Type.Literal('per_schedule'),
]);
export type PricingShape = Static<typeof PricingShapeSchema>;

const LetterPercentageDirectionSchema = Type.Union([
  Type.Literal('below'),
  Type.Literal('at_par'),
  Type.Literal('above'),
]);

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

/**
 * Whether a Work's LOA rates — and therefore its contract value and every
 * amount derived from those rates — are quoted INCLUSIVE or EXCLUSIVE of
 * GST (migration 0062).
 *
 * Owner ruling, 13 August 2026: usually inclusive at 18%, because works
 * contracts sit in the 18% slab, but some LOAs quote exclusive rates.
 * Rare, and real. It is NOT parsed: the letter is silent on GST (the
 * railway's own bill is where 'Rate is inclusive of GST: Yes' appears), so
 * the reviewer states it at LOA review time and the default follows the
 * common case.
 *
 * It is carried on the wire because executed value is meaningless without
 * it: comparing money on one basis against a contract value on the other
 * moves the answer by the whole GST factor, and in the dangerous direction
 * — an exclusive letter read as inclusive OVERSTATES execution, so the
 * Work can be completed with roughly a sixth of the contract unbilled.
 */
export const GstBasisSchema = Type.Union([
  Type.Literal('inclusive'),
  Type.Literal('exclusive'),
]);
export type GstBasis = Static<typeof GstBasisSchema>;

/** One corrected item as the reviewer confirms it. `sourceRef` points back
 * into the stored extraction payload (schedule id + printed serial) so the
 * server can attach the parser's verbatim source block as evidence.
 * A row the reviewer ADDED at review time (a letter the parser could not
 * fully serve) carries `manualEntry: true` INSTEAD of a sourceRef; the
 * server records an explicit manual-entry marker as its source evidence.
 * Every item must carry exactly one of the two — the confirm endpoint
 * refuses items with neither (or both). */
const ConfirmWorkItemSchema = Type.Object(
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

const ConfirmWorkScheduleSchema = Type.Object(
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
const ConfirmPbgRequirementSchema = Type.Object(
  {
    requiredAmount: DecimalStringSchema,
    submissionDays: Type.Integer({ minimum: 1, maximum: 180 }),
    extensionDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 3650 })),
    penalInterestPercent: Type.Optional(DecimalStringSchema),
  },
  { additionalProperties: false },
);
export type ConfirmPbgRequirement = Static<typeof ConfirmPbgRequirementSchema>;

/** Optional initial per-Work payment matrix entered by the reviewer.
 * Tender extraction may prefill the editor, but these values are the human
 * confirmation and remain manually editable later. The server validates
 * uniqueness, 0–100 bounds and the exact sum of 100 for every row. */
const ConfirmPaymentMatrixRowSchema = Type.Object(
  {
    category: PaymentMatrixCategorySchema,
    pctSupply: DecimalStringSchema,
    pctInstallation: DecimalStringSchema,
    pctPac: DecimalStringSchema,
    pctFinalBill: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type ConfirmPaymentMatrixRow = Static<typeof ConfirmPaymentMatrixRowSchema>;

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
    /** The GST basis these rates are quoted on, and the rate it refers
     * to. Optional on the wire and defaulted to inclusive/18.00 by the
     * server: the parser never proposes either (the letter is silent), so
     * this is a HOLE the reviewer fills rather than an extracted truth,
     * and an older client that omits it gets the common case. The rate is
     * validated against the organisation's notified GST rate master as of
     * the letter date. */
    gstBasis: Type.Optional(GstBasisSchema),
    gstRate: Type.Optional(GstRateSchema),
    /** The contractual completion date, which the review screen proposes
     * as the letter date plus the completion period the letter prints
     * (`header.completionPeriod`, packages/loa-parser) and the reviewer
     * may overwrite.
     *
     * Optional, because a letter that states no period leaves the date to
     * be set later through `PUT /api/works/:id/completion-dates` — the
     * one-time set that has always existed. Sending it here writes the
     * same pair of columns that route writes, at creation, which is when
     * the letter is still in the reviewer's hands. It stays a WRITE-ONCE
     * value either way: migration 0011's works guard lets it move
     * afterwards only through a responded extension request. */
    completionDate: Type.Optional(DateOnlySchema),
    pbgRequirement: Type.Optional(ConfirmPbgRequirementSchema),
    /** At most one row per matrix category, which is what the reviewer's
     * editor offers. The bound was a bare `5` and stayed there when
     * migration 0068 added AMC and made it six, so a reviewer who filled
     * every row was refused by the schema with no message naming the
     * cause. Derived from the vocabulary now, so the next category
     * carries its own ceiling with it. */
    paymentMatrix: Type.Optional(
      Type.Array(ConfirmPaymentMatrixRowSchema, {
        minItems: 1,
        maxItems: PAYMENT_MATRIX_CATEGORIES.length,
      }),
    ),
    schedules: Type.Array(ConfirmWorkScheduleSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type ConfirmWorkRequest = Static<typeof ConfirmWorkRequestSchema>;

const WorkSchema = Type.Object(
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
    /** The basis this Work's rates are quoted on, and the rate it refers
     * to. Never null: migration 0062 defaults every Work to inclusive at
     * 18.00. Any comparison of money against `contractValue` must be made
     * on this basis (apps/server/src/executed-value.ts). */
    gstBasis: GstBasisSchema,
    gstRate: GstRateSchema,
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

const WorkItemSchema = Type.Object(
  {
    id: UuidSchema,
    scheduleId: UuidSchema,
    itemNumber: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.String({ minLength: 3 }),
    unitCode: Type.String({ minLength: 1, maxLength: 20 }),
    awardedQuantity: DecimalStringSchema,
    /** The ACCEPTED rate — what the railway pays per unit, and what every
     * money figure on this item is computed at. The server derives it from
     * `advertisedRate` and the schedule's accepted percentage (migration
     * 0063); it is never submitted. */
    effectiveRate: RateStringSchema,
    /** The rate as PRINTED in the LOA item table, which is the ADVERTISED
     * rate. Kept so a screen can show the derivation — "24,90,000 less
     * 14.35% = 21,32,685" — instead of a rate that matches neither the
     * letter a reviewer is holding nor a recomputation they could do.
     * Optional: readers that do not select it omit it rather than sending
     * a false null. Null on Works confirmed before 0063. */
    advertisedRate: Type.Optional(Type.Union([RateStringSchema, Type.Null()])),
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
    /** Present on the Work detail response: the item has more installed
     * than the contract sanctions, so it owes a railway variation order
     * (migration 0077). Installation is measured as it happened; the
     * excess is not billable until a variation raises the sanctioned
     * quantity, and the Work cannot complete while it stands. Derived in
     * the database from `installedQuantity` against
     * `effectiveQuantity ?? awardedQuantity` — never submitted. */
    pendingVariation: Type.Optional(Type.Boolean()),
    /** Milestone 8 payment category; null/absent = uncategorised (the
     * item resolves through the Work's UNCATEGORISED matrix row). */
    paymentCategory: Type.Optional(
      Type.Union([WorkItemPaymentCategorySchema, Type.Null()]),
    ),
    /** Present on the Work detail response: SUM of certified quantities
     * over non-cancelled PAC certificates for the item (Milestone 8
     * phase 1) — THE pac_qty the Measurement Book engine consumes. */
    pacCertifiedQuantity: Type.Optional(DecimalStringSchema),
    /** Tax facts (migration 0033), per item because the rate follows the
     * goods and a Work mixes them: a switchboard and its installation do
     * not share an HSN or a rate. An item with no `hsnCode` cannot be
     * invoiced — the IRP refuses the line — so null is a gap the tax
     * screens chase, not a settled value. `isService` decides the SAC
     * reading of the code and the e-invoice's IsServc flag; the column
     * is NOT NULL, so the value is a boolean whenever it is read at all.
     * Optional like the aggregates above: a reader that does not select
     * the tax columns omits them rather than sending a false null. */
    hsnCode: Type.Optional(Type.Union([HsnCodeSchema, Type.Null()])),
    gstRate: Type.Optional(Type.Union([GstRateSchema, Type.Null()])),
    isService: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type WorkItem = Static<typeof WorkItemSchema>;

const WorkScheduleSchema = Type.Object(
  {
    id: UuidSchema,
    scheduleCode: Type.String({ minLength: 1, maxLength: 50 }),
    title: Type.String({ minLength: 1, maxLength: 1000 }),
    position: Type.Integer({ minimum: 1 }),
    /** The AMC billing cadence, when this schedule states one (migration
     * 0107): M periods and the word the agency calls one of them. Both
     * null on every schedule that is not maintenance, and on a
     * maintenance schedule whose cadence nobody has confirmed yet — the
     * import proposes a default, it is not assumed. */
    amcBillingPeriods: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    amcCycleNoun: Type.Union([Type.String(), Type.Null()]),
    items: Type.Array(WorkItemSchema),
  },
  { additionalProperties: false },
);
export type WorkSchedule = Static<typeof WorkScheduleSchema>;

export const WorkListResponseSchema = Type.Object(
  { works: Type.Array(WorkSchema) },
  { additionalProperties: false },
);

export const WorkDetailResponseSchema = Type.Object(
  {
    work: WorkSchema,
    schedules: Type.Array(WorkScheduleSchema),
    /** The Work's installation-record tally. Carried on the Work read
     * because the Work page needs the count on every open and the records
     * only when their tab is opened; see `InstallationCountsSchema`. */
    installationCounts: InstallationCountsSchema,
    /** How many formal Measurement Books the Work carries, any status.
     * The Measurement tab's badge must count what the tab shows, and the
     * books are read only when the tab is opened — a book with no loose
     * evidence entries left the badge claiming zero measurements. */
    measurementBookCount: Type.Integer({ minimum: 0 }),
    /** How many tax invoices the Work carries, any status — the Bills
     * tab renders them beside the railway bills, so its badge counts
     * both for the same reason. */
    taxInvoiceCount: Type.Integer({ minimum: 0 }),
    /** How many HISTORICAL invoices (migration 0115) are filed against
     * this Work — the Zoho Books billing that predates this product. The
     * Bills tab renders them under the invoices this application raised,
     * so the badge counts them too, for the reason the two counts above
     * exist: a tab whose badge disagrees with what the tab shows teaches
     * an operator not to trust the badge. Discarded rows are excluded,
     * because the tab does not show them either. */
    historicalInvoiceCount: Type.Integer({ minimum: 0 }),
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
const WorkCompletionNoteSchema = nonBlankString({
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
 * installation owes installation, supply-and-installation owes both, AMC
 * owes certified service, and an uncategorised item owes installation
 * when its description mentions installation and delivery otherwise.
 *
 * 'service' is the AMC requirement (migration 0068). An annual
 * maintenance item is never delivered and never installed — the period
 * is served and the railway certifies it — so what it owes is certified
 * quantity, summed over its non-cancelled acceptance certificates. */
const WorkCompletionRequirementSchema = Type.Union([
  Type.Literal('delivery'),
  Type.Literal('installation'),
  Type.Literal('delivery_and_installation'),
  Type.Literal('service'),
]);
export type WorkCompletionRequirement = Static<typeof WorkCompletionRequirementSchema>;

/** Which way an item misses 100%. The predicate is exact equality, so an
 * item measuring ABOVE its baseline is as unfinished as a short one — but
 * the remedies are opposite. 'short' amends the sanctioned quantity DOWN;
 * 'excess' amends it UP to match what was measured, which is exactly what
 * the R7 floor permits and what amending down would be refused for. An
 * item over on either measured dimension is 'excess': while any dimension
 * exceeds the baseline, the floor refuses every reduction, so up is the
 * only move. Over-DELIVERY reaches 'excess' only with the Work's
 * excess-delivery toggle (R4); over-INSTALLATION reaches it whenever site
 * ran ahead of the variation order that sanctions the extra work
 * (migration 0077), which is the ordinary way an item lands here. */
const WorkCompletionDirectionSchema = Type.Union([
  Type.Literal('short'),
  Type.Literal('excess'),
]);

const UnfinishedWorkItemSchema = Type.Object(
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
    /** SUM over the item's non-cancelled acceptance certificates. The
     * measured dimension of the 'service' requirement, and 0 on every
     * other requirement — an AMC item is the only one certification can
     * finish, because it is the only one that takes no movement. */
    certifiedQuantity: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type UnfinishedWorkItem = Static<typeof UnfinishedWorkItemSchema>;

/** `details` of the 409 WORK_NOT_FULLY_EXECUTED — the operator's
 * worklist, each row carrying the direction of its own remedy: short
 * items amend down through the approval path, items measuring above the
 * baseline amend the sanctioned quantity up to match the measurement. */
export const WorkNotFullyExecutedDetailsSchema = Type.Object(
  { unfinishedItems: Type.Array(UnfinishedWorkItemSchema) },
  { additionalProperties: false },
);
export type WorkNotFullyExecutedDetails = Static<
  typeof WorkNotFullyExecutedDetailsSchema
>;

const WORK_COMPLETION_BLOCKER_KINDS = [
  'draft_delivery_challan',
  'draft_issue_challan',
  'draft_extension_request',
  'draft_measurement_book',
  'pending_approval_request',
] as const;

const WorkCompletionBlockerSchema = Type.Object(
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
