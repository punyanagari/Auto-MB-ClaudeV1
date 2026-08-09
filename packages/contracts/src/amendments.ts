import { Type, type Static } from '@sinclair/typebox';
import { DecimalStringSchema, UuidSchema } from './primitives.js';

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
]);
export type ApprovalEntityType = Static<typeof ApprovalEntityTypeSchema>;

/** Fields a change amendment may touch. quantity '0' omits the item; the
 * floor (already-delivered issued quantity) is enforced at apply time. */
export const AmendmentChangesSchema = Type.Object(
  {
    quantity: Type.Optional(DecimalStringSchema),
    rate: Type.Optional(DecimalStringSchema),
    description: Type.Optional(Type.String({ minLength: 3, maxLength: 4000 })),
    unit: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
  },
  { additionalProperties: false },
);
export type AmendmentChanges = Static<typeof AmendmentChangesSchema>;

export const ProposeAmendmentRequestSchema = Type.Object(
  {
    workItemId: UuidSchema,
    reason: Type.String({ minLength: 3, maxLength: 2000 }),
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
    reason: Type.String({ minLength: 3, maxLength: 2000 }),
    scheduleId: UuidSchema,
    itemNumber: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.String({ minLength: 3, maxLength: 4000 }),
    unitCode: Type.String({ minLength: 1, maxLength: 20 }),
    quantity: DecimalStringSchema,
    rate: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type ProposeAddItemRequest = Static<typeof ProposeAddItemRequestSchema>;

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
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type ApprovalRequest = Static<typeof ApprovalRequestSchema>;

export const ApprovalListResponseSchema = Type.Object(
  { approvals: Type.Array(ApprovalRequestSchema) },
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
  { note: Type.Optional(Type.String({ minLength: 3, maxLength: 1000 })) },
  { additionalProperties: false },
);
export type ApproveAmendmentRequest = Static<typeof ApproveAmendmentRequestSchema>;

export const RejectAmendmentRequestSchema = Type.Object(
  { note: Type.String({ minLength: 3, maxLength: 1000 }) },
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
