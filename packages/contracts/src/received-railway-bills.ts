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

/**
 * Why a received bill's signatures do not permit settlement.
 *
 * Distinct values rather than one boolean, because they say different
 * things to an operator: a missing verdict is re-uploadable, an untrusted
 * chain is a trust-anchor question for whoever runs the server, and a
 * document modified after signing is a conversation with the railway.
 */
const RAILWAY_BILL_VERDICT_REFUSALS = [
  'not_verified',
  'document_status',
  'signature_count',
  'signature_integrity',
  'signature_chain',
  'signature_signers',
  'signature_coverage',
] as const;
const RailwayBillVerdictRefusalSchema = Type.Union(
  RAILWAY_BILL_VERDICT_REFUSALS.map((refusal) => Type.Literal(refusal)),
);

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

/* --- The railway's measurement (migration 0111) ---------------------------- */

/**
 * The document BEFORE the bill.
 *
 * IWRCMS raises an On-Account Bill from a measurement its own system
 * holds, and the agency's finalized Measurement Book is only a claim
 * until that measurement is on record and agrees with it. This is that
 * record — uploaded, read, and compared line by line — and no bill may be
 * recorded against a Measurement Book without it.
 *
 * Nothing is asserted over the wire here either. The upload carries a
 * file and a filename; the quantities, the remarks and the verdict are
 * all read on the server.
 */
export const RailwayMeasurementUploadQuerySchema = Type.Object(
  { filename: Type.String({ minLength: 1, maxLength: 300 }) },
  { additionalProperties: false },
);

/**
 * How the reading went.
 *
 *   matched     every line agrees, and neither document carries a line
 *               the other does not.
 *   mismatched  the document was read and disagrees. Named per line.
 *   unreadable  no line table could be extracted; the recorded
 *               line-by-line confirmation is this state's only exit.
 */
const RAILWAY_MEASUREMENT_MATCH_STATUSES = [
  'matched',
  'mismatched',
  'unreadable',
] as const;
const RailwayMeasurementMatchStatusSchema = Type.Union(
  RAILWAY_MEASUREMENT_MATCH_STATUSES.map((status) => Type.Literal(status)),
);
export type RailwayMeasurementMatchStatus = Static<
  typeof RailwayMeasurementMatchStatusSchema
>;

/** Why one line does not match. Distinct values in the same spirit as the
 * bill's settlement refusals: they say different things to an operator,
 * and a single boolean would flatten a disagreement about quantities into
 * a missing row. */
const RAILWAY_MEASUREMENT_LINE_REFUSALS = [
  'quantity',
  'remark',
  'missing_from_measurement',
  'absent_from_measurement_book',
] as const;
const RailwayMeasurementLineRefusalSchema = Type.Union(
  RAILWAY_MEASUREMENT_LINE_REFUSALS.map((refusal) => Type.Literal(refusal)),
);

const RailwayMeasurementLineSchema = Type.Object(
  {
    itemNumber: Type.String(),
    matched: Type.Boolean(),
    refusal: Type.Union([RailwayMeasurementLineRefusalSchema, Type.Null()]),
    /** One sentence naming what differs on this line. Never a remedy —
     * the remedy catalog owns those. */
    detail: Type.Union([Type.String(), Type.Null()]),
    /** Who confirmed this line by hand, and when, on an unreadable
     * document. Null on every line of a document the parser read: a
     * matched line needs no confirmation and a mismatched one may not
     * have any. */
    confirmedByUserId: Type.Union([Type.String(), Type.Null()]),
    confirmedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type RailwayMeasurementLine = Static<typeof RailwayMeasurementLineSchema>;

export const RailwayMeasurementSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    measurementBookId: UuidSchema,
    originalFilename: Type.String(),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    sizeBytes: Type.Integer({ minimum: 1 }),
    matchStatus: RailwayMeasurementMatchStatusSchema,
    /** One entry per line, in the Measurement Book's own order, with the
     * railway's extra items appended. On an unreadable document this is
     * the BOOK's lines with no verdict, so the screen has something to
     * ask an operator to confirm. */
    lines: Type.Array(RailwayMeasurementLineSchema),
    /** Whether a received railway bill may now be recorded against this
     * measurement: matched by the reading, or confirmed line by line.
     * Derived on the server so the screen and the gate cannot disagree. */
    settles: Type.Boolean(),
    discardedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type RailwayMeasurement = Static<typeof RailwayMeasurementSchema>;

export const RailwayMeasurementResponseSchema = Type.Object(
  {
    measurement: Type.Union([RailwayMeasurementSchema, Type.Null()]),
    /** Every measurement previously discarded against this book, newest
     * first.
     *
     * Carried because discarding a MISMATCHED measurement and uploading
     * one this parser cannot read re-enters the gate through the manual
     * confirmation path. Every step of that is audited, but an audit
     * trail is not where the next decision gets made — this panel is. A
     * discarded mismatch listed beside the live measurement puts the mark
     * in front of the person about to close the book on it. */
    discarded: Type.Array(RailwayMeasurementSchema),
  },
  { additionalProperties: false },
);
export type RailwayMeasurementResponse = Static<
  typeof RailwayMeasurementResponseSchema
>;

/** One line, confirmed by one member. Deliberately singular: the fallback
 * is an act per line, and a request that took a list would be the single
 * click migration 0111 refuses to model. */
export const ConfirmRailwayMeasurementLineSchema = Type.Object(
  {
    // NOT `nonBlankString`: its pattern is built as `{minLength - 2,}`
    // and a one-character minimum makes that an invalid quantifier, which
    // Fastify reports at boot. A schedule item number really can be one
    // character, so the untrimmed-text rule is written directly. It is
    // the same rule migration 0111's `btrim(item_number) = item_number`
    // holds on the column.
    itemNumber: Type.String({
      minLength: 1,
      maxLength: 100,
      pattern: '^\\S(?:[\\s\\S]*\\S)?$',
      description: 'A Measurement Book item number, with no surrounding spaces.',
    }),
  },
  { additionalProperties: false },
);

export const DiscardRailwayMeasurementRequestSchema = Type.Object(
  { reason: Type.Optional(nonBlankString({ minLength: 3, maxLength: 500 })) },
  { additionalProperties: false },
);
