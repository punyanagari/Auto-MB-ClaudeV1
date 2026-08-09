import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, UuidSchema } from './primitives.js';

// --- Work completion dates --------------------------------------------------

/** One-time set of the Work's completion date: original and current start
 * equal; afterwards the current date moves only through a responded
 * extension request. */
export const SetCompletionDateRequestSchema = Type.Object(
  { completionDate: DateOnlySchema },
  { additionalProperties: false },
);
export type SetCompletionDateRequest = Static<typeof SetCompletionDateRequestSchema>;

export const WorkCompletionSchema = Type.Object(
  {
    originalCompletionDate: Type.Union([DateOnlySchema, Type.Null()]),
    currentCompletionDate: Type.Union([DateOnlySchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkCompletion = Static<typeof WorkCompletionSchema>;

// --- Extension requests -----------------------------------------------------

export const ExtensionRequestStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('finalised'),
  Type.Literal('responded'),
]);
export type ExtensionRequestStatus = Static<typeof ExtensionRequestStatusSchema>;

export const ExtensionResponseOutcomeSchema = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('modified'),
  Type.Literal('rejected'),
]);
export type ExtensionResponseOutcome = Static<typeof ExtensionResponseOutcomeSchema>;

export const SaveExtensionRequestSchema = Type.Object(
  {
    proposedCompletionDate: DateOnlySchema,
    reason: Type.String({ minLength: 3, maxLength: 5000 }),
    addressee: Type.String({ minLength: 2, maxLength: 200 }),
    letterDate: Type.Optional(DateOnlySchema),
  },
  { additionalProperties: false },
);
export type SaveExtensionRequest = Static<typeof SaveExtensionRequestSchema>;

/** accepted grants the proposed date (no override allowed); modified
 * requires the railway's granted date; rejected grants nothing. */
export const RespondExtensionRequestSchema = Type.Object(
  {
    outcome: ExtensionResponseOutcomeSchema,
    grantedCompletionDate: Type.Optional(DateOnlySchema),
  },
  { additionalProperties: false },
);
export type RespondExtensionRequest = Static<typeof RespondExtensionRequestSchema>;

/** 'software' letters are drafted and finalised in the product; 'manual'
 * records back-fill paper letters issued before adoption (§5.5) — they
 * are finalised on arrival, occupy the next sequence slot, and carry the
 * paper letter's own reference. */
export const ExtensionSourceSchema = Type.Union([
  Type.Literal('software'),
  Type.Literal('manual'),
]);
export type ExtensionSource = Static<typeof ExtensionSourceSchema>;

export const ExtensionRequestSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    status: ExtensionRequestStatusSchema,
    source: ExtensionSourceSchema,
    proposedCompletionDate: DateOnlySchema,
    reason: Type.String(),
    addressee: Type.String(),
    letterDate: Type.Union([DateOnlySchema, Type.Null()]),
    sequenceNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    requestNumber: Type.Union([Type.String(), Type.Null()]),
    /** The paper letter's own reference; null for software letters. */
    manualReference: Type.Union([Type.String(), Type.Null()]),
    templateVersion: Type.Union([Type.String(), Type.Null()]),
    renderedAvailable: Type.Boolean(),
    responseDocumentAvailable: Type.Boolean(),
    responseOutcome: Type.Union([ExtensionResponseOutcomeSchema, Type.Null()]),
    grantedCompletionDate: Type.Union([DateOnlySchema, Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    finalisedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    respondedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type ExtensionRequest = Static<typeof ExtensionRequestSchema>;

/** Manual back-fill of a paper letter (§5.5): the paper reference and
 * letter date plus the transcribed content the register needs. The record
 * is finalised on arrival and consumes the next sequence slot. */
export const BackfillExtensionRequestSchema = Type.Object(
  {
    /** The paper letter's own reference, preserved verbatim. */
    reference: Type.String({ minLength: 1, maxLength: 100 }),
    /** The paper letter's date — never in the future. */
    letterDate: DateOnlySchema,
    proposedCompletionDate: DateOnlySchema,
    reason: Type.String({ minLength: 3, maxLength: 5000 }),
    addressee: Type.String({ minLength: 2, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export type BackfillExtensionRequest = Static<typeof BackfillExtensionRequestSchema>;

export const ExtensionRequestListResponseSchema = Type.Object(
  { extensionRequests: Type.Array(ExtensionRequestSchema) },
  { additionalProperties: false },
);
export type ExtensionRequestListResponse = Static<
  typeof ExtensionRequestListResponseSchema
>;

export const ExtensionRequestDetailResponseSchema = Type.Object(
  {
    extensionRequest: ExtensionRequestSchema,
    /** Immutable letter snapshot captured at finalise; null while draft. */
    finalisedSnapshot: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type ExtensionRequestDetailResponse = Static<
  typeof ExtensionRequestDetailResponseSchema
>;

/** The back-fill answer: the created record plus non-blocking warnings —
 * §5.5 warns (without blocking) when a manual record is dated after the
 * first software-generated letter. */
export const BackfillExtensionResponseSchema = Type.Object(
  {
    extensionRequest: ExtensionRequestSchema,
    finalisedSnapshot: Type.Unknown(),
    warnings: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type BackfillExtensionResponse = Static<typeof BackfillExtensionResponseSchema>;

export const WorkCompletionResponseSchema = Type.Object(
  {
    completion: WorkCompletionSchema,
    extensionRequests: Type.Array(ExtensionRequestSchema),
  },
  { additionalProperties: false },
);
export type WorkCompletionResponse = Static<typeof WorkCompletionResponseSchema>;
