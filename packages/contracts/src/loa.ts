import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema } from './primitives.js';

export const ExtractionStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('processing'),
  Type.Literal('review'),
  Type.Literal('confirmed'),
  Type.Literal('failed'),
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
export const LoaDocumentDetailSchema = Type.Composite(
  [
    LoaDocumentSchema,
    Type.Object({ extractionPayload: Type.Unknown() }, { additionalProperties: false }),
  ],
  { additionalProperties: false },
);
export type LoaDocumentDetail = Static<typeof LoaDocumentDetailSchema>;

export const LoaDocumentListResponseSchema = Type.Object(
  { documents: Type.Array(LoaDocumentSchema) },
  { additionalProperties: false },
);
export type LoaDocumentListResponse = Static<typeof LoaDocumentListResponseSchema>;

export const UploadLoaQuerySchema = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 300 }),
  },
  { additionalProperties: false },
);
export type UploadLoaQuery = Static<typeof UploadLoaQuerySchema>;
