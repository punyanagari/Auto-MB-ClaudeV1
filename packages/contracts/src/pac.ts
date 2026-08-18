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

const PacCertificateStatusSchema = Type.Union([
  Type.Literal('recorded'),
  Type.Literal('cancelled'),
]);

const RecordPacCertificateItemSchema = Type.Object(
  {
    workItemId: UuidSchema,
    certifiedQuantity: DecimalStringSchema,
  },
  { additionalProperties: false },
);

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

const PacCertificateItemSchema = Type.Object(
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

/** Which quantity a certificate is capped against (R18, widened by
 * migration 0068).
 *
 * 'installed' is the original rule and still the rule for every item
 * that is installed: a certificate accepts installed work, so it can
 * never certify more than exists. 'sanctioned' is the AMC rule. An
 * annual-maintenance item is never installed — 0068 makes an
 * installation record naming it structurally impossible — so capping it
 * at the installed total would cap it at zero and make it uncertifiable
 * and therefore uncompletable. Its ceiling is the sanctioned quantity
 * instead, the same ceiling R5 puts on installation. */
const PacCertificationBasisSchema = Type.Union([
  Type.Literal('installed'),
  Type.Literal('sanctioned'),
]);
export type PacCertificationBasis = Static<typeof PacCertificationBasisSchema>;

/** Per-item aggregate of non-cancelled certified quantities alongside the
 * quantity that supports them. pacCertifiedQuantity is THE pac_qty the
 * Measurement Book engine consumes (legacy §8); availableQuantity =
 * supporting minus certified is what the next certificate may still
 * cover (R18).
 *
 * `installedQuantity` remains the installed total as such — it is 0 for
 * an AMC item and stays reported as 0 rather than being overwritten with
 * the sanctioned figure, because "nothing is installed" is true and the
 * screen says it. `supportingQuantity` is what the cap is actually
 * measured against, and `certificationBasis` names which of the two
 * rules produced it. */
const PacItemSummarySchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    installedQuantity: DecimalStringSchema,
    certificationBasis: PacCertificationBasisSchema,
    supportingQuantity: DecimalStringSchema,
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

/** The structured `details` payload of a PAC_EXCEEDS_INSTALLED or
 * PAC_EXCEEDS_SANCTIONED 409 (R18: "the error states installed /
 * covered / available"), one entry per offending item. `basis` names
 * which ceiling `supporting` is, so a client never has to guess whether
 * it is reading an installed total or a sanctioned one. */
const PacCapExceededItemSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    basis: PacCertificationBasisSchema,
    supporting: DecimalStringSchema,
    covered: DecimalStringSchema,
    available: DecimalStringSchema,
  },
  { additionalProperties: false },
);

export const PacCapExceededDetailsSchema = Type.Object(
  { items: Type.Array(PacCapExceededItemSchema) },
  { additionalProperties: false },
);
export type PacCapExceededDetails = Static<typeof PacCapExceededDetailsSchema>;
