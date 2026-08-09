import { Type, type Static } from '@sinclair/typebox';

export const ApiErrorSchema = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
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
