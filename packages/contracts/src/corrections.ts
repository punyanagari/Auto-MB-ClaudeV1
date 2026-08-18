import { Type, type Static } from '@sinclair/typebox';
import { SaveChallanRequestSchema } from './challans.js';
import { SaveIssueChallanRequestSchema } from './issue-challans.js';
import { UuidSchema } from './primitives.js';

// --- Correction flow for ISSUED documents (Milestone 7) --------------------
// Two lawful paths, both through the Milestone 6 approval engine:
// cancel-and-replace for an evidence-free issued challan, and a numbered
// correction notice when downstream evidence lawfully blocks cancellation.
// The issued snapshot is never edited.

/** Which correction path the challan's live evidence state permits. */
const CorrectionPathSchema = Type.Union([
  Type.Literal('cancel_replace'),
  Type.Literal('correction_notice'),
]);

export const CorrectionEligibilityResponseSchema = Type.Object(
  {
    challanId: UuidSchema,
    status: Type.Union([
      Type.Literal('draft'),
      Type.Literal('issued'),
      Type.Literal('cancelled'),
    ]),
    evidence: Type.Object(
      {
        receipts: Type.Integer({ minimum: 0 }),
        serials: Type.Integer({ minimum: 0 }),
        measurements: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    /** The lawful path for this challan; null when it is not issued. */
    path: Type.Union([CorrectionPathSchema, Type.Null()]),
    /** A correction request already awaiting a decision, if any. */
    pendingRequestId: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type CorrectionEligibilityResponse = Static<
  typeof CorrectionEligibilityResponseSchema
>;

/** Path A for Delivery Challans: the proposed payload is the full
 * corrected challan content, reusing the draft-challan shape. On
 * approval the original cancels and this becomes a replacement draft. */
export const ProposeChallanCancelReplaceRequestSchema = Type.Object(
  {
    reason: Type.String({ minLength: 3, maxLength: 2000 }),
    replacement: SaveChallanRequestSchema,
  },
  { additionalProperties: false },
);
export type ProposeChallanCancelReplaceRequest = Static<
  typeof ProposeChallanCancelReplaceRequestSchema
>;

/** Path A for Issue Challans (looser content rules by design). */
export const ProposeIssueChallanCancelReplaceRequestSchema = Type.Object(
  {
    reason: Type.String({ minLength: 3, maxLength: 2000 }),
    replacement: SaveIssueChallanRequestSchema,
  },
  { additionalProperties: false },
);
export type ProposeIssueChallanCancelReplaceRequest = Static<
  typeof ProposeIssueChallanCancelReplaceRequestSchema
>;

/** One structured field correction on a notice. */
const CorrectionNoticeEntrySchema = Type.Object(
  {
    field: Type.String({ minLength: 1, maxLength: 100 }),
    corrected: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
export type CorrectionNoticeEntry = Static<typeof CorrectionNoticeEntrySchema>;

/** Path B: a numbered correction notice against an issued challan whose
 * cancellation is blocked by downstream evidence. At least one field
 * correction or a correction statement is required (validated
 * server-side); the reason is always mandatory. */
export const ProposeCorrectionNoticeRequestSchema = Type.Object(
  {
    reason: Type.String({ minLength: 3, maxLength: 2000 }),
    corrections: Type.Optional(
      Type.Array(CorrectionNoticeEntrySchema, { maxItems: 50 }),
    ),
    statement: Type.Optional(Type.String({ minLength: 3, maxLength: 4000 })),
  },
  { additionalProperties: false },
);
export type ProposeCorrectionNoticeRequest = Static<
  typeof ProposeCorrectionNoticeRequestSchema
>;

const CorrectionNoticeStatusSchema = Type.Union([
  Type.Literal('issued'),
  Type.Literal('cancelled'),
]);

const CorrectionNoticeSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    deliveryChallanId: UuidSchema,
    approvalRequestId: UuidSchema,
    noticeNumber: Type.String(),
    sequenceNumber: Type.Integer({ minimum: 1 }),
    status: CorrectionNoticeStatusSchema,
    templateVersion: Type.String(),
    renderedAvailable: Type.Boolean(),
    cancellationNote: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type CorrectionNotice = Static<typeof CorrectionNoticeSchema>;

export const CorrectionNoticeListResponseSchema = Type.Object(
  { notices: Type.Array(CorrectionNoticeSchema) },
  { additionalProperties: false },
);
export type CorrectionNoticeListResponse = Static<
  typeof CorrectionNoticeListResponseSchema
>;

export const CorrectionNoticeDetailResponseSchema = Type.Object(
  {
    notice: CorrectionNoticeSchema,
    /** The immutable issue-time snapshot, verbatim. */
    snapshot: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type CorrectionNoticeDetailResponse = Static<
  typeof CorrectionNoticeDetailResponseSchema
>;

export const CancelCorrectionNoticeRequestSchema = Type.Object(
  { note: Type.String({ minLength: 3, maxLength: 1000 }) },
  { additionalProperties: false },
);
