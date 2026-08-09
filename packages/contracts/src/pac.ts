import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, DecimalStringSchema, UuidSchema } from './primitives.js';

// --- PAC certificates (Milestone 8 phase 1, legacy §5.5 and rule R18) -------
//
// A PAC certificate records the railway's provisional acceptance of
// installed quantities, in parts: reference, issue date, the issuing
// consignee (designation snapshotted from the picked consignee master at
// record time), optional scanned document, and per-item certified
// quantities. Per item, the certified total across non-cancelled
// certificates never exceeds the installed total (R18). Certificates
// cancel with a note — cancelling releases the certified quantities.
//
// Distinct from work_instruments kind 'pac' (Milestone 5), which stays a
// reference-level banking record; this is the quantity-bearing
// certificate the stage-wise Measurement Book bills from.

export const PacCertificateStatusSchema = Type.Union([
  Type.Literal('recorded'),
  Type.Literal('cancelled'),
]);
export type PacCertificateStatus = Static<typeof PacCertificateStatusSchema>;

export const RecordPacCertificateItemSchema = Type.Object(
  {
    workItemId: UuidSchema,
    certifiedQuantity: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type RecordPacCertificateItem = Static<typeof RecordPacCertificateItemSchema>;

export const RecordPacCertificateRequestSchema = Type.Object(
  {
    reference: Type.String({ minLength: 1, maxLength: 100 }),
    issueDate: DateOnlySchema,
    /** The issuing consignee, picked from the consignee masters; the
     * designation is snapshotted onto the certificate at record time. */
    consigneeMasterId: UuidSchema,
    items: Type.Array(RecordPacCertificateItemSchema, {
      minItems: 1,
      maxItems: 500,
    }),
  },
  { additionalProperties: false },
);
export type RecordPacCertificateRequest = Static<
  typeof RecordPacCertificateRequestSchema
>;

export const CancelPacCertificateRequestSchema = Type.Object(
  { note: Type.String({ minLength: 3, maxLength: 1000 }) },
  { additionalProperties: false },
);
export type CancelPacCertificateRequest = Static<
  typeof CancelPacCertificateRequestSchema
>;

export const PacCertificateItemSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    certifiedQuantity: DecimalStringSchema,
    /** DISPLAY-ONLY released value for this line (certified quantity x
     * effective rate x PAC stage percent / 100, rounded to 2 decimals per
     * R13), computed at read time from the ACTIVE payment matrix. Null
     * whenever the matrix or the item's category cannot resolve — never
     * stored on the certificate. */
    releasedValue: Type.Union([DecimalStringSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type PacCertificateItem = Static<typeof PacCertificateItemSchema>;

export const PacCertificateSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    reference: Type.String(),
    issueDate: DateOnlySchema,
    /** Provenance only — the designation below is the record. */
    consigneeMasterId: UuidSchema,
    /** Snapshot of the master's designation at record time; later master
     * edits never rewrite it. */
    consigneeDesignation: Type.String(),
    status: PacCertificateStatusSchema,
    cancellationNote: Type.Union([Type.String(), Type.Null()]),
    documentAvailable: Type.Boolean(),
    items: Type.Array(PacCertificateItemSchema),
    /** Sum of the per-line released values (round2 per line, then sum —
     * R13); null while any line's value is unresolvable. Display-only. */
    releasedValue: Type.Union([DecimalStringSchema, Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type PacCertificate = Static<typeof PacCertificateSchema>;

/** Per-item aggregate of non-cancelled certified quantities alongside the
 * installed total. pacCertifiedQuantity is THE pac_qty the Measurement
 * Book engine consumes (legacy §8); availableQuantity = installed minus
 * certified is what the next certificate may still cover (R18). */
export const PacItemSummarySchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    installedQuantity: DecimalStringSchema,
    pacCertifiedQuantity: DecimalStringSchema,
    availableQuantity: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type PacItemSummary = Static<typeof PacItemSummarySchema>;

export const PacCertificateListResponseSchema = Type.Object(
  {
    certificates: Type.Array(PacCertificateSchema),
    itemSummaries: Type.Array(PacItemSummarySchema),
  },
  { additionalProperties: false },
);
export type PacCertificateListResponse = Static<
  typeof PacCertificateListResponseSchema
>;

/** The structured `details` payload of a PAC_EXCEEDS_INSTALLED 409 (R18:
 * "the error states installed / covered / available"), one entry per
 * offending item. */
export const PacCapExceededItemSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    installed: DecimalStringSchema,
    covered: DecimalStringSchema,
    available: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type PacCapExceededItem = Static<typeof PacCapExceededItemSchema>;

export const PacCapExceededDetailsSchema = Type.Object(
  { items: Type.Array(PacCapExceededItemSchema) },
  { additionalProperties: false },
);
export type PacCapExceededDetails = Static<typeof PacCapExceededDetailsSchema>;
