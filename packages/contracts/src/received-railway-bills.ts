import { Type, type Static } from '@sinclair/typebox';
import {
  PdfSignatureReportSchema,
  StoredPdfSignatureStatusSchema,
} from './pdf-signature.js';
import {
  DateOnlySchema,
  PositiveDecimalStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';

/**
 * The railway's own On-Account Bill, as this product records it.
 *
 * Note what is NOT in the upload request: the bill number, its date, its
 * amount, and the measurement it settles. All four are read out of the
 * uploaded PDF (`apps/server/src/railway-bill-parse.ts`) and none of them
 * can be asserted over the wire. The only thing the caller supplies is
 * the file and its name.
 */
export const ReceivedRailwayBillUploadQuerySchema = Type.Object(
  { filename: Type.String({ minLength: 1, maxLength: 300 }) },
  { additionalProperties: false },
);
export type ReceivedRailwayBillUploadQuery = Static<
  typeof ReceivedRailwayBillUploadQuerySchema
>;

/**
 * Why a received bill's signatures do not permit settlement.
 *
 * Distinct values rather than one boolean, because the six say different
 * things to an operator: a missing verdict is re-uploadable, an untrusted
 * chain is a trust-anchor question for whoever runs the server, and a
 * document modified after signing is a conversation with the railway.
 */
export const RAILWAY_BILL_VERDICT_REFUSALS = [
  'not_verified',
  'document_status',
  'signature_count',
  'signature_integrity',
  'signature_chain',
  'signature_coverage',
] as const;
export const RailwayBillVerdictRefusalSchema = Type.Union(
  RAILWAY_BILL_VERDICT_REFUSALS.map((refusal) => Type.Literal(refusal)),
);
export type RailwayBillVerdictRefusalCode = Static<
  typeof RailwayBillVerdictRefusalSchema
>;

export const ReceivedRailwayBillSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    measurementBookId: UuidSchema,
    /** The Measurement Book's own number, for a screen that should not
     * have to fetch the book to name it. */
    measurementBookNumber: Type.Union([Type.String(), Type.Null()]),
    billNumber: Type.String(),
    billDate: DateOnlySchema,
    /** GST-INCLUSIVE, as the bill prints it. Equal to the tax invoice's
     * grand total, never to its taxable value (`docs/PRODUCT.md` §5.2). */
    billAmount: PositiveDecimalStringSchema,
    /** The bill's "Rate is inclusive of GST" declaration — the evidence
     * behind the Work's recorded GST basis (migration 0062). */
    rateInclusiveOfGst: Type.Boolean(),
    /** As printed on the bill, ledger token and all: `.../OAM/FL2/01`. */
    measurementNumber: Type.String(),
    /** The sequence the link was made on. The book spells the same
     * measurement `.../OAM/L2/01`; the sequence is what they share. */
    measurementSequence: Type.Integer({ minimum: 1 }),
    agreementNumber: Type.Union([Type.String(), Type.Null()]),
    letterNumber: Type.String(),
    originalFilename: Type.String(),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    sizeBytes: Type.Integer({ minimum: 1 }),
    signatureStatus: StoredPdfSignatureStatusSchema,
    signatureVerdict: Type.Union([PdfSignatureReportSchema, Type.Null()]),
    /** Whether this bill's signatures permit settlement. Derived from the
     * stored verdict by one server-side rule
     * (`apps/server/src/railway-bill-verdict.ts`) so the screen and the
     * gate can never disagree about it. */
    settleable: Type.Boolean(),
    settlementRefusal: Type.Union([RailwayBillVerdictRefusalSchema, Type.Null()]),
    settlementRefusalDetail: Type.Union([Type.String(), Type.Null()]),
    discardedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type ReceivedRailwayBill = Static<typeof ReceivedRailwayBillSchema>;

export const ReceivedRailwayBillListResponseSchema = Type.Object(
  { bills: Type.Array(ReceivedRailwayBillSchema) },
  { additionalProperties: false },
);
export type ReceivedRailwayBillListResponse = Static<
  typeof ReceivedRailwayBillListResponseSchema
>;

export const DiscardReceivedRailwayBillRequestSchema = Type.Object(
  { reason: Type.Optional(nonBlankString({ minLength: 3, maxLength: 500 })) },
  { additionalProperties: false },
);
export type DiscardReceivedRailwayBillRequest = Static<
  typeof DiscardReceivedRailwayBillRequestSchema
>;

/**
 * What the upload refused to read, when it refused.
 *
 * `field` names the thing that could not be read off the page, so the
 * screen can say "the bill's measurement number does not read as one"
 * rather than "extraction failed". Attached to the error envelope's
 * `details`.
 */
export const RailwayBillParseFailureDetailsSchema = Type.Object(
  { field: Type.String() },
  { additionalProperties: false },
);
export type RailwayBillParseFailureDetails = Static<
  typeof RailwayBillParseFailureDetailsSchema
>;

/**
 * What the closure refusal knows about the measurement it refused to
 * close: which bill it looked at, and why that bill was not enough.
 */
export const MeasurementBookClosureRefusalDetailsSchema = Type.Object(
  {
    measurementBookId: UuidSchema,
    receivedRailwayBillId: Type.Union([UuidSchema, Type.Null()]),
    refusal: Type.Union([RailwayBillVerdictRefusalSchema, Type.Null()]),
    detail: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type MeasurementBookClosureRefusalDetails = Static<
  typeof MeasurementBookClosureRefusalDetailsSchema
>;
