import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema } from './primitives.js';

// --- Superseding a confirmed Work (migration 0071) -------------------------
// The exit for a Work confirmed from a letter that was read wrongly. It
// runs through the same approval engine as every other change to an
// authoritative record, and it is available only while nothing downstream
// depends on the Work.

/** One reason a Work cannot be superseded, in the operator's words. */
export const SupersedeBlockerSchema = Type.Object(
  {
    /** The document register that still holds rows, e.g. `delivery_challans`. */
    register: Type.String({ minLength: 1, maxLength: 100 }),
    /** What that register is called on screen, e.g. "delivery challans". */
    label: Type.String({ minLength: 1, maxLength: 100 }),
    count: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type SupersedeBlocker = Static<typeof SupersedeBlockerSchema>;

export const SupersedeEligibilityResponseSchema = Type.Object(
  {
    workId: UuidSchema,
    /** True when the Work carries no downstream document at all. */
    eligible: Type.Boolean(),
    /** Every register that still holds something, newest rule first. */
    blockers: Type.Array(SupersedeBlockerSchema),
    /** The LOA document that would be released back to review; null when
     * the Work was not created from one (a v1 import, for instance), which
     * is itself a reason the remedy is unavailable. */
    loaDocumentId: Type.Union([UuidSchema, Type.Null()]),
    /** A supersede request already awaiting a decision, if any. */
    pendingRequestId: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type SupersedeEligibilityResponse = Static<
  typeof SupersedeEligibilityResponseSchema
>;

export const ProposeWorkSupersedeRequestSchema = Type.Object(
  { reason: Type.String({ minLength: 3, maxLength: 2000 }) },
  { additionalProperties: false },
);
export type ProposeWorkSupersedeRequest = Static<
  typeof ProposeWorkSupersedeRequestSchema
>;

/** The record of a Work withdrawn and, once its letter is confirmed
 * again, of what replaced it. */
export const WorkSupersessionSchema = Type.Object(
  {
    id: UuidSchema,
    supersededWorkId: UuidSchema,
    supersededWorkCode: Type.String(),
    successorWorkId: Type.Union([UuidSchema, Type.Null()]),
    successorWorkCode: Type.Union([Type.String(), Type.Null()]),
    loaDocumentId: UuidSchema,
    approvalRequestId: UuidSchema,
    reason: Type.String(),
    supersededAt: Type.String({ format: 'date-time' }),
    supersededByUserId: Type.String(),
    successorBoundAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkSupersession = Static<typeof WorkSupersessionSchema>;

export const WorkSupersessionListResponseSchema = Type.Object(
  { supersessions: Type.Array(WorkSupersessionSchema) },
  { additionalProperties: false },
);
export type WorkSupersessionListResponse = Static<
  typeof WorkSupersessionListResponseSchema
>;
