import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema } from './primitives.js';

// --- Superseding a confirmed Work (migration 0071) -------------------------
// The exit for a Work confirmed from a letter that was read wrongly. It
// runs through the same approval engine as every other change to an
// authoritative record, and it is available only while nothing downstream
// depends on the Work.

/**
 * One reason a Work cannot be superseded, in the operator's words.
 *
 * Presence, not a count: the rule turns on whether a register holds
 * anything at all, and asking for a number would make the census scan
 * every matching row of seventeen registers on a screen that only needs
 * to know which ones are non-empty. The server reads each with an
 * `EXISTS`, which stops at the first row.
 */
export const SupersedeBlockerSchema = Type.Object(
  {
    /** The document register that still holds rows, e.g. `delivery_challans`. */
    register: Type.String({ minLength: 1, maxLength: 100 }),
    /** What that register is called on screen, e.g. "delivery challans". */
    label: Type.String({ minLength: 1, maxLength: 100 }),
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
    /** What the withdrawn Work's letter said, so the successor's page can
     * show the identity it inherited rather than only an id. */
    supersededLetterNumber: Type.String(),
    successorWorkId: Type.Union([UuidSchema, Type.Null()]),
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

/** The provenance of ONE Work: the supersession it is the successor of,
 * or null for a Work that replaced nothing — which is almost all of
 * them. The withdrawn Work itself is not readable through the Works
 * routes (every one filters `deleted_at is null`), so this record is
 * where its identity, its reason and its date survive. */
export const WorkSupersessionResponseSchema = Type.Object(
  { supersession: Type.Union([WorkSupersessionSchema, Type.Null()]) },
  { additionalProperties: false },
);
export type WorkSupersessionResponse = Static<typeof WorkSupersessionResponseSchema>;
