import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  DecimalStringSchema,
  RateStringSchema,
  UuidSchema,
} from './primitives.js';
import { WorkItemPaymentCategorySchema } from './payment.js';

/**
 * Milestone 8 phase 2: the stage-wise Measurement Book lifecycle
 * (ADR-0006; legacy spec §5.9, rule R19). An MB is drafted against a
 * Work, claims its open sources (issued delivery challans, recorded
 * installations, recorded PAC certificates), previews its computed
 * lines from live state, and finalises into an immutable snapshot with
 * a gap-free <work_code>-MB-NN number. Bills are prepared FROM a
 * finalized MB (bills.mb_id, amount = the MB total).
 *
 * Migration 0034 splits the MB into three kinds. RECORD: one
 * consignee's parallel measurement sheet — several consignees fill
 * record MBs simultaneously, each named by consigneeContactId, and a
 * main consignee MERGES them into an on-account MB. ON_ACCOUNT: the
 * billable MB (started directly where one measurement suffices).
 * FINAL: the Work's last MB — after it, no further MB may be raised.
 * Record MBs never finalize and never take a number; they end merged
 * (status 'merged', mergedIntoId set) or deleted while still drafts.
 */

export const MEASUREMENT_BOOK_STATUSES = [
  'draft',
  'finalized',
  'cancelled',
  'merged',
] as const;
export const MeasurementBookStatusSchema = Type.Union(
  MEASUREMENT_BOOK_STATUSES.map((status) => Type.Literal(status)),
);
export type MeasurementBookStatus = Static<typeof MeasurementBookStatusSchema>;

export const MEASUREMENT_BOOK_KINDS = ['record', 'on_account', 'final'] as const;
export const MeasurementBookKindSchema = Type.Union(
  MEASUREMENT_BOOK_KINDS.map((kind) => Type.Literal(kind)),
);
export type MeasurementBookKind = Static<typeof MeasurementBookKindSchema>;

/** The three billable source record types (spec §5.9 "Sources"). */
export const MB_SOURCE_TYPES = [
  'delivery_challan',
  'installation',
  'pac_certificate',
] as const;
export const MbSourceTypeSchema = Type.Union(
  MB_SOURCE_TYPES.map((sourceType) => Type.Literal(sourceType)),
);
export type MbSourceType = Static<typeof MbSourceTypeSchema>;

export const CreateMeasurementBookRequestSchema = Type.Object(
  {
    mbDate: DateOnlySchema,
    /** The Measurement Book kind; defaults to 'on_account'. A 'record'
     * MB additionally REQUIRES consigneeContactId. */
    kind: Type.Optional(MeasurementBookKindSchema),
    /** Record MBs only: the active consignee contact filling this
     * parallel sheet. One record draft per consignee per Work. */
    consigneeContactId: Type.Optional(UuidSchema),
    /** Compatibility alias for `kind` (pre-0034 clients): true means
     * 'final', false/absent means 'on_account'. A body naming BOTH
     * fields inconsistently is refused (MB_KIND_CONFLICT). */
    isFinal: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type CreateMeasurementBookRequest = Static<
  typeof CreateMeasurementBookRequestSchema
>;

/** POST /api/works/:id/measurement-books/merge — merges record drafts
 * into a NEW on-account draft: the draft claims the union of the
 * records' sources, and each record MB is marked merged pointing at it.
 * The one-billing-draft rule still applies to the created draft. */
export const MergeMeasurementBooksRequestSchema = Type.Object(
  {
    recordMbIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 100 }),
    mbDate: DateOnlySchema,
  },
  { additionalProperties: false },
);
export type MergeMeasurementBooksRequest = Static<
  typeof MergeMeasurementBooksRequestSchema
>;

export const MbSourceRefSchema = Type.Object(
  {
    sourceType: MbSourceTypeSchema,
    sourceId: UuidSchema,
  },
  { additionalProperties: false },
);
export type MbSourceRef = Static<typeof MbSourceRefSchema>;

/** PUT .../sources — REPLACES the draft's source selection wholesale. */
export const SetMbSourcesRequestSchema = Type.Object(
  {
    sources: Type.Array(MbSourceRefSchema, { maxItems: 500 }),
  },
  { additionalProperties: false },
);
export type SetMbSourcesRequest = Static<typeof SetMbSourcesRequestSchema>;

export const CancelMeasurementBookRequestSchema = Type.Object(
  {
    note: Type.String({ minLength: 3, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
export type CancelMeasurementBookRequest = Static<
  typeof CancelMeasurementBookRequestSchema
>;

export const MeasurementBookSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    status: MeasurementBookStatusSchema,
    kind: MeasurementBookKindSchema,
    /** Generated from kind (kind === 'final'); kept for compatibility. */
    isFinal: Type.Boolean(),
    /** Record MBs only: the consignee filling this sheet. */
    consigneeContactId: Type.Union([UuidSchema, Type.Null()]),
    /** Merged record MBs only: the on-account draft that absorbed this
     * record's sources. */
    mergedIntoId: Type.Union([UuidSchema, Type.Null()]),
    mbDate: DateOnlySchema,
    mbNumber: Type.Union([Type.String(), Type.Null()]),
    sequenceNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    /** Finalize-written; null while draft. */
    totalAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    remarkTemplateVersion: Type.Union([Type.String(), Type.Null()]),
    /** The document template the persisted PDF was rendered under
     * (mb-v1); null until the finalized MB is first rendered. */
    templateVersion: Type.Union([Type.String(), Type.Null()]),
    /** True once a persisted PDF render exists (finalized MBs only;
     * a cancelled-after-finalized MB keeps its render). */
    renderedAvailable: Type.Boolean(),
    cancellationNote: Type.Union([Type.String(), Type.Null()]),
    /** Set when a bill has been prepared from this MB (1:1). */
    billId: Type.Union([UuidSchema, Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    finalizedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    /**
     * When the railway's own On-Account Bill settling this measurement was
     * accepted (migration 0066).
     *
     * Deliberately NOT the same "closed" migration 0035 speaks of — that
     * one means a live tax invoice bills this book, and is an invoice
     * fact. This is a railway fact, and the two are independent: the
     * settlement corpus carries an invoice dated two days BEFORE the bill
     * that settles it.
     */
    closedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    /** The received railway bill that closed this measurement. */
    closedByReceivedBillId: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type MeasurementBook = Static<typeof MeasurementBookSchema>;

/** One claimed source with a human-readable label (challan number, PAC
 * reference, or installation summary). */
export const MeasurementBookSourceSchema = Type.Object(
  {
    id: UuidSchema,
    sourceType: MbSourceTypeSchema,
    sourceId: UuidSchema,
    label: Type.String(),
    releasedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type MeasurementBookSource = Static<typeof MeasurementBookSourceSchema>;

/** One MB line: the full per-item stage breakdown. On drafts this is
 * the live-state preview; on finalized/cancelled MBs it is the
 * immutable snapshot read back verbatim. */
export const MeasurementBookLineSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    description: Type.String(),
    unitCode: Type.String(),
    paymentCategory: Type.Union([WorkItemPaymentCategorySchema, Type.Null()]),
    /** The matrix row resolved through ('UNCATEGORISED' when the item
     * has no category). */
    resolvedCategory: Type.String(),
    pctSupply: DecimalStringSchema,
    pctInstallation: DecimalStringSchema,
    pctPac: DecimalStringSchema,
    pctFinalBill: DecimalStringSchema,
    effectiveRate: RateStringSchema,
    deltaSupplied: DecimalStringSchema,
    deltaInstalled: DecimalStringSchema,
    deltaPac: DecimalStringSchema,
    /** Final MB only: final-bill base minus prior; '0' elsewhere. */
    deltaFinalBill: DecimalStringSchema,
    priorSupplied: DecimalStringSchema,
    priorInstalled: DecimalStringSchema,
    priorPac: DecimalStringSchema,
    priorFinalBill: DecimalStringSchema,
    amountSupply: DecimalStringSchema,
    amountInstallation: DecimalStringSchema,
    amountPac: DecimalStringSchema,
    amountFinalBill: DecimalStringSchema,
    lineTotal: DecimalStringSchema,
    remark: Type.String(),
  },
  { additionalProperties: false },
);
export type MeasurementBookLine = Static<typeof MeasurementBookLineSchema>;

/** A draft-preview warning: an item that would appear on the MB but
 * whose category has no payment-matrix row to resolve through. */
export const MeasurementBookWarningSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    missingCategory: Type.String(),
  },
  { additionalProperties: false },
);
export type MeasurementBookWarning = Static<typeof MeasurementBookWarningSchema>;

export const MeasurementBookDetailResponseSchema = Type.Object(
  {
    book: MeasurementBookSchema,
    sources: Type.Array(MeasurementBookSourceSchema),
    lines: Type.Array(MeasurementBookLineSchema),
    /** Missing-matrix-row warnings; always empty once finalized. */
    warnings: Type.Array(MeasurementBookWarningSchema),
    /** Draft preview of the would-be total (line-rounded then summed);
     * equals book.totalAmount once finalized. */
    previewTotal: Type.Union([DecimalStringSchema, Type.Null()]),
    /** The Work's UNBILLABLE VARIATION EXPOSURE: money value of what is
     * installed above the sanctioned quantity and therefore excluded
     * from every Measurement Book until a variation order raises the
     * sanction (migration 0077). '0.00' when nothing is over-installed.
     *
     * A current fact about the Work, not a snapshot of this book — it
     * reads the same on a draft and on a finalized book, and it falls to
     * zero when the variation lands. The lines above are already
     * clamped; this is what the clamp left out, stated in rupees. */
    unbillableVariationExposure: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type MeasurementBookDetailResponse = Static<
  typeof MeasurementBookDetailResponseSchema
>;

export const MeasurementBookListResponseSchema = Type.Object(
  {
    books: Type.Array(MeasurementBookSchema),
  },
  { additionalProperties: false },
);
export type MeasurementBookListResponse = Static<
  typeof MeasurementBookListResponseSchema
>;

/** 409 details when a source is already claimed by another live MB
 * (MB_SOURCE_ALREADY_BILLED): names the source and the holding MB. */
export const MbSourceConflictDetailsSchema = Type.Object(
  {
    sourceType: MbSourceTypeSchema,
    sourceId: UuidSchema,
    holdingMeasurementBookId: UuidSchema,
    holdingMbNumber: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type MbSourceConflictDetails = Static<typeof MbSourceConflictDetailsSchema>;

/** 409 details when finalize cannot resolve stage percentages
 * (MB_PERCENTAGES_UNRESOLVED): every affected item, in one error. */
export const MbPercentagesUnresolvedDetailsSchema = Type.Object(
  {
    items: Type.Array(MeasurementBookWarningSchema),
  },
  { additionalProperties: false },
);
export type MbPercentagesUnresolvedDetails = Static<
  typeof MbPercentagesUnresolvedDetailsSchema
>;

/** 409 details when a final MB misses open sources (MB_FINAL_SWEEP_INCOMPLETE). */
export const MbFinalSweepDetailsSchema = Type.Object(
  {
    missedSources: Type.Array(
      Type.Object(
        {
          sourceType: MbSourceTypeSchema,
          sourceId: UuidSchema,
          label: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type MbFinalSweepDetails = Static<typeof MbFinalSweepDetailsSchema>;

/** 409 details when cancelling a non-newest live MB (MB_NOT_NEWEST). */
export const MbNotNewestDetailsSchema = Type.Object(
  {
    newerMeasurementBookId: UuidSchema,
    newerMbNumber: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type MbNotNewestDetails = Static<typeof MbNotNewestDetailsSchema>;

/** 409 details when deleting an on-account draft that absorbed record
 * MBs (MB_HAS_MERGED_RECORDS): the un-merge endpoint is the remedy. */
export const MbHasMergedRecordsDetailsSchema = Type.Object(
  {
    recordMbIds: Type.Array(UuidSchema),
  },
  { additionalProperties: false },
);
export type MbHasMergedRecordsDetails = Static<typeof MbHasMergedRecordsDetailsSchema>;
