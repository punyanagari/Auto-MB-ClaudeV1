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

export const ExtensionRequestSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    status: ExtensionRequestStatusSchema,
    proposedCompletionDate: DateOnlySchema,
    reason: Type.String(),
    addressee: Type.String(),
    letterDate: Type.Union([DateOnlySchema, Type.Null()]),
    sequenceNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    requestNumber: Type.Union([Type.String(), Type.Null()]),
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

export const WorkCompletionResponseSchema = Type.Object(
  {
    completion: WorkCompletionSchema,
    extensionRequests: Type.Array(ExtensionRequestSchema),
  },
  { additionalProperties: false },
);
export type WorkCompletionResponse = Static<typeof WorkCompletionResponseSchema>;
