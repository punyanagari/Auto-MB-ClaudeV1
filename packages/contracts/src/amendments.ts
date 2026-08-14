import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
import {
  DateOnlySchema,
  DecimalStringSchema,
  RateStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';

/** Every reason and decision note here is stored in a column whose CHECK
 * measures it TRIMMED, so the schema measures it the same way: a reason
 * of three spaces is refused at the boundary with the field named,
 * instead of reaching Postgres and returning as a bare 500. */
const AmendmentReasonSchema = nonBlankString({ minLength: 3, maxLength: 2000 });
const DecisionNoteSchema = nonBlankString({ minLength: 3, maxLength: 1000 });

// --- Approval engine (first consumer: work-item amendments) ----------------

export const ApprovalStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('approved'),
  Type.Literal('rejected'),
  Type.Literal('withdrawn'),
]);
export type ApprovalStatus = Static<typeof ApprovalStatusSchema>;

/** Everything the engine can decide: work-item amendments (Milestone 6)
 * plus the Milestone 7 correction paths for issued documents. */
export const ApprovalEntityTypeSchema = Type.Union([
  Type.Literal('work_item_amendment'),
  Type.Literal('challan_cancel_replace'),
  Type.Literal('issue_challan_cancel_replace'),
  Type.Literal('challan_correction_notice'),
  /** Withdrawing a confirmed Work that has no downstream document, so its
   * letter can be read again (migration 0071). The entity is the Work. */
  Type.Literal('work_supersede'),
]);
export type ApprovalEntityType = Static<typeof ApprovalEntityTypeSchema>;

/** Fields a change amendment may touch. quantity '0' omits the item; the
 * floor (already-delivered issued quantity) is enforced at apply time. */
export const AmendmentChangesSchema = Type.Object(
  {
    quantity: Type.Optional(DecimalStringSchema),
    rate: Type.Optional(RateStringSchema),
    description: Type.Optional(Type.String({ minLength: 3, maxLength: 4000 })),
    unit: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
  },
  { additionalProperties: false },
);
export type AmendmentChanges = Static<typeof AmendmentChangesSchema>;

export const ProposeAmendmentRequestSchema = Type.Object(
  {
    workItemId: UuidSchema,
    reason: AmendmentReasonSchema,
    changes: AmendmentChangesSchema,
  },
  { additionalProperties: false },
);
export type ProposeAmendmentRequest = Static<typeof ProposeAmendmentRequestSchema>;

/** Adds a brand-new item to an existing schedule by amendment. The
 * approved values become the item's baseline; it is marked
 * amendment-added and carries the approval that created it. */
export const ProposeAddItemRequestSchema = Type.Object(
  {
    reason: AmendmentReasonSchema,
    scheduleId: UuidSchema,
    itemNumber: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.String({ minLength: 3, maxLength: 4000 }),
    unitCode: Type.String({ minLength: 1, maxLength: 20 }),
    quantity: DecimalStringSchema,
    rate: RateStringSchema,
  },
  { additionalProperties: false },
);
export type ProposeAddItemRequest = Static<typeof ProposeAddItemRequestSchema>;

/** Omits (retires) an existing item by amendment. R7 permits it only
 * while the item carries no delivery, installation, PAC, or billing
 * evidence; the removal is a soft-delete, so the item number stays
 * reserved for the life of the Work and is never handed out again. */
export const ProposeRemoveItemRequestSchema = Type.Object(
  {
    workItemId: UuidSchema,
    reason: AmendmentReasonSchema,
  },
  { additionalProperties: false },
);
export type ProposeRemoveItemRequest = Static<typeof ProposeRemoveItemRequestSchema>;

// --- The variation order that authorises an omission -----------------------

/** Every claim the server can make about an uploaded variation order.
 * Mirrors VARIATION_ORDER_CLAIM_CODES in
 * apps/server/src/variation-order-verify.ts, which is the authority. */
export const VariationOrderClaimCodeSchema = Type.Union([
  Type.Literal('text_layer'),
  Type.Literal('variation_statement'),
  Type.Literal('loa_number'),
  Type.Literal('loa_date'),
  Type.Literal('variation_number'),
  Type.Literal('item_listed'),
  Type.Literal('item_omitted'),
  Type.Literal('item_unit'),
  Type.Literal('item_original_quantity'),
  Type.Literal('loa_amount'),
]);
export type VariationOrderClaimCode = Static<typeof VariationOrderClaimCodeSchema>;

export const VariationOrderClaimSchema = Type.Object(
  {
    code: VariationOrderClaimCodeSchema,
    verified: Type.Boolean(),
    /** False for the single advisory claim; a failed REQUIRED claim
     * refuses the approval. */
    required: Type.Boolean(),
    detail: Type.String(),
    /** What the order itself says, when it said anything. */
    found: Type.Union([Type.String(), Type.Null()]),
    /** What the Work or the amendment asserted, where a comparison
     * applies. */
    expected: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type VariationOrderClaim = Static<typeof VariationOrderClaimSchema>;

export const VariationOrderVerdictSchema = Type.Object(
  {
    verified: Type.Boolean(),
    claims: Type.Array(VariationOrderClaimSchema),
    failedClaims: Type.Array(VariationOrderClaimCodeSchema),
  },
  { additionalProperties: false },
);
export type VariationOrderVerdict = Static<typeof VariationOrderVerdictSchema>;

/**
 * The stored order beside an omission amendment. Every identifying value
 * was EXTRACTED from the uploaded PDF and matched against the Work — none
 * of it is operator input, which is the whole point of the ruling. An
 * IREPS Variation Statement carries no letter number of its own: its
 * identity is the agreement number plus the variation number, and its link
 * to this Work is the LOA number it prints.
 */
export const VariationOrderSchema = Type.Object(
  {
    id: UuidSchema,
    approvalRequestId: UuidSchema,
    loaNumber: Type.String(),
    loaDate: DateOnlySchema,
    agreementNumber: Type.String(),
    variationNumber: Type.String(),
    originalFilename: Type.String(),
    sha256: Type.String(),
    sizeBytes: Type.Integer(),
    verdict: VariationOrderVerdictSchema,
    uploadedByUserId: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type VariationOrder = Static<typeof VariationOrderSchema>;

export const AttachVariationOrderQuerySchema = Type.Object(
  { filename: Type.String({ minLength: 1, maxLength: 255 }) },
  { additionalProperties: false },
);
export type AttachVariationOrderQuery = Static<typeof AttachVariationOrderQuerySchema>;

export const AmendmentDiffEntrySchema = Type.Object(
  {
    field: Type.String(),
    before: Type.Union([Type.String(), Type.Null()]),
    after: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type AmendmentDiffEntry = Static<typeof AmendmentDiffEntrySchema>;

export const ApprovalRequestSchema = Type.Object(
  {
    id: UuidSchema,
    entityType: ApprovalEntityTypeSchema,
    /** The target record (work item or challan); null while an add-item
     * proposal is undecided. */
    entityId: Type.Union([UuidSchema, Type.Null()]),
    workId: UuidSchema,
    workCode: Type.String(),
    itemNumber: Type.Union([Type.String(), Type.Null()]),
    /** The targeted document's number for correction requests (challan
     * number); null for work-item amendments. */
    documentNumber: Type.Union([Type.String(), Type.Null()]),
    /** The immutable proposal snapshot, verbatim. */
    proposed: Type.Unknown(),
    diff: Type.Array(AmendmentDiffEntrySchema),
    reason: Type.String(),
    status: ApprovalStatusSchema,
    requestedByUserId: Type.String(),
    decidedByUserId: Type.Union([Type.String(), Type.Null()]),
    decidedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    decisionNote: Type.Union([Type.String(), Type.Null()]),
    /** The railway variation order cited for an omission, once one has
     * been uploaded and verified. Null on every other request kind, and on
     * an omission still waiting for its order — which is a lawful state to
     * file in, but never one to approve from. */
    variationOrder: Type.Union([VariationOrderSchema, Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type ApprovalRequest = Static<typeof ApprovalRequestSchema>;

export const AttachVariationOrderResponseSchema = Type.Object(
  {
    approval: ApprovalRequestSchema,
    verdict: VariationOrderVerdictSchema,
  },
  { additionalProperties: false },
);
export type AttachVariationOrderResponse = Static<
  typeof AttachVariationOrderResponseSchema
>;

/** Approval requests, newest first.
 *
 * `nextCursor` is the keyset contract from `pagination.ts`: the id to send
 * as the next `cursor`, or null when there is no further page — which is
 * also what an unpaginated request (no `limit`) always answers, because it
 * received the whole register. */
export const ApprovalListResponseSchema = Type.Object(
  { approvals: Type.Array(ApprovalRequestSchema), nextCursor: NextCursorSchema },
  { additionalProperties: false },
);
export type ApprovalListResponse = Static<typeof ApprovalListResponseSchema>;

export const ApprovalListQuerySchema = Type.Object(
  { status: Type.Optional(ApprovalStatusSchema) },
  { additionalProperties: false },
);
export type ApprovalListQuery = Static<typeof ApprovalListQuerySchema>;

/** Approving may carry an optional note; rejecting must say why. */
export const ApproveAmendmentRequestSchema = Type.Object(
  { note: Type.Optional(DecisionNoteSchema) },
  { additionalProperties: false },
);
export type ApproveAmendmentRequest = Static<typeof ApproveAmendmentRequestSchema>;

export const RejectAmendmentRequestSchema = Type.Object(
  { note: DecisionNoteSchema },
  { additionalProperties: false },
);
export type RejectAmendmentRequest = Static<typeof RejectAmendmentRequestSchema>;

// --- Work settings (owner-only) --------------------------------------------

/** PRODUCT.md invariant 5's escape hatch: excess delivery must be
 * explicitly enabled on the Work, by an owner, audited. */
export const UpdateWorkSettingsRequestSchema = Type.Object(
  { allowExcessDelivery: Type.Boolean() },
  { additionalProperties: false },
);
export type UpdateWorkSettingsRequest = Static<typeof UpdateWorkSettingsRequestSchema>;

export const WorkSettingsResponseSchema = Type.Object(
  {
    id: UuidSchema,
    allowExcessDelivery: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type WorkSettingsResponse = Static<typeof WorkSettingsResponseSchema>;
