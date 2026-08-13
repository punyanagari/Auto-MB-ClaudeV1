import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema, nonBlankString } from './primitives.js';

export const ExtractionStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('processing'),
  Type.Literal('review'),
  Type.Literal('confirmed'),
  Type.Literal('failed'),
  /** Terminal (migration 0055): the uploader withdrew an intake package
   * that never became a Work. The row and its stored object survive for
   * retention; the document leaves the working list. */
  Type.Literal('discarded'),
]);
export type ExtractionStatus = Static<typeof ExtractionStatusSchema>;

export const LoaDocumentSchema = Type.Object(
  {
    id: UuidSchema,
    originalFilename: Type.String({ minLength: 1, maxLength: 300 }),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    sizeBytes: Type.Integer({ minimum: 1 }),
    extractionStatus: ExtractionStatusSchema,
    confirmedWorkId: Type.Union([UuidSchema, Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type LoaDocument = Static<typeof LoaDocumentSchema>;

/**
 * The extraction payload is the parser's LoaReviewPayload (plus the raw
 * extracted text), serialised verbatim: every located field carries the
 * exact source substring it was derived from, every unlocated field
 * carries its candidate raw block, and item rows retain their full source
 * lines. It is transported untyped here because the parser package — not
 * this contract — is authoritative for its shape; re-declaring ~30 nested
 * types in TypeBox would create a second source of truth to drift.
 */
/**
 * An earlier intake of the SAME letter number, found when this document
 * was read. Bytes differ — a byte-identical re-upload is refused outright
 * — so this is not a refusal but a warning: revised letters, corrigenda
 * and re-issues legitimately repeat a letter number, and the reviewer is
 * the only one who can say whether this file supersedes the earlier one
 * or duplicates it by mistake.
 */
export const LoaLetterNumberMatchSchema = Type.Object(
  {
    /** 'work' once the earlier intake was confirmed; 'document' while it
     * is still an unconfirmed upload. */
    kind: Type.Union([Type.Literal('document'), Type.Literal('work')]),
    id: UuidSchema,
    letterNumber: Type.String(),
    /** The earlier document's filename, or the Work's code. */
    label: Type.String(),
    /** Extraction status for a document; Work status for a Work. */
    status: Type.String(),
    /** The Work the earlier intake became, when it became one. */
    confirmedWorkId: Type.Union([UuidSchema, Type.Null()]),
    /** Upload time for a document; creation time for a Work. */
    at: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type LoaLetterNumberMatch = Static<typeof LoaLetterNumberMatchSchema>;

export const LoaDocumentDetailSchema = Type.Composite(
  [
    LoaDocumentSchema,
    Type.Object(
      {
        extractionPayload: Type.Unknown(),
        letterNumberMatches: Type.Array(LoaLetterNumberMatchSchema),
      },
      { additionalProperties: false },
    ),
  ],
  { additionalProperties: false },
);
export type LoaDocumentDetail = Static<typeof LoaDocumentDetailSchema>;

/**
 * What a byte-identical duplicate upload is refused with: the existing
 * document named, so the caller can open it instead of guessing which of
 * their files the server already holds.
 */
export const DuplicateLoaDocumentDetailsSchema = Type.Object(
  {
    existingRecordId: Type.String(),
    originalFilename: Type.String(),
    uploadedAt: Type.String({ format: 'date-time' }),
    extractionStatus: ExtractionStatusSchema,
    confirmedWorkId: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type DuplicateLoaDocumentDetails = Static<
  typeof DuplicateLoaDocumentDetailsSchema
>;

export const LoaDocumentListResponseSchema = Type.Object(
  { documents: Type.Array(LoaDocumentSchema) },
  { additionalProperties: false },
);
export type LoaDocumentListResponse = Static<typeof LoaDocumentListResponseSchema>;

/** Discarded documents leave the working list; `includeDiscarded` brings
 * them back for the writers who run the intake workflow. */
export const ListLoaDocumentsQuerySchema = Type.Object(
  { includeDiscarded: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);
export type ListLoaDocumentsQuery = Static<typeof ListLoaDocumentsQuerySchema>;

/** Discarding an unconfirmed upload is a draft deletion, not the
 * cancellation of an issued document, so the reason is optional. */
export const DiscardLoaDocumentRequestSchema = Type.Object(
  { reason: Type.Optional(nonBlankString({ minLength: 3, maxLength: 500 })) },
  { additionalProperties: false },
);
export type DiscardLoaDocumentRequest = Static<typeof DiscardLoaDocumentRequestSchema>;

/** Discarding a letter discards the intake package: the supporting
 * contract documents attached to it go with it, and are named so the
 * caller can say how many went. */
export const DiscardLoaDocumentResponseSchema = Type.Object(
  {
    document: LoaDocumentSchema,
    discardedSupportingDocumentIds: Type.Array(UuidSchema),
  },
  { additionalProperties: false },
);
export type DiscardLoaDocumentResponse = Static<
  typeof DiscardLoaDocumentResponseSchema
>;

export const UploadLoaQuerySchema = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 300 }),
  },
  { additionalProperties: false },
);
export type UploadLoaQuery = Static<typeof UploadLoaQuerySchema>;
