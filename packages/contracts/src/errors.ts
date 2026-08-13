import { Type, type Static } from '@sinclair/typebox';

/**
 * The one shape every refusal answers in.
 *
 * `message` states the fact — what was refused and why. `remedy` states the
 * action that clears it, in the operator's own vocabulary ("Cancel the
 * issued challan, then amend the item"). The panel measurement that put
 * this field here: about three-quarters of the server's refusals stated a
 * fact and stopped, leaving the clerk holding a true sentence and no next
 * step.
 *
 * The two are deliberately separate rather than one longer message. A
 * message is written by the route that refused and belongs to that
 * refusal; a remedy belongs to the error CODE and is the same wherever
 * that code is thrown, which is what lets `apps/server/src/remedies.ts`
 * hold one reviewed sentence per code instead of the same advice drifting
 * across forty call sites.
 *
 * `remedy` is OPTIONAL and stays optional. Adding it is backward
 * compatible in both directions: a client built before it exists ignores
 * an unknown property, and a code with no reviewed remedy yet simply
 * omits the field rather than shipping filler. Only the vocabulary of
 * `code` is planned to tighten later (pack P12).
 */
export const ApiErrorSchema = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    remedy: Type.Optional(Type.String()),
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type ApiError = Static<typeof ApiErrorSchema>;

/**
 * The `details` payload every one-open-draft 409 carries (DRAFT_EXISTS,
 * EXTENSION_DRAFT_EXISTS): `existingRecordId` names the draft that already
 * occupies the slot, so clients can open it directly instead of parsing
 * the message. Any future one-draft rule (e.g. the Measurement Book
 * draft) MUST answer its conflict with this same shape.
 */
export const DraftConflictDetailsSchema = Type.Object(
  {
    existingRecordId: Type.String(),
  },
  { additionalProperties: false },
);

export type DraftConflictDetails = Static<typeof DraftConflictDetailsSchema>;
