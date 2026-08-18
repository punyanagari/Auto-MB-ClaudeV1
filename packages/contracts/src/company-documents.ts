import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, UuidSchema } from './primitives.js';

// --- The company document library (migration 0079) -------------------------
//
// Reusable organisation-level credentials — GST registration, PAN, an ISO
// certificate, a bank solvency letter, a completion certificate — uploaded
// once, kept versioned, carrying the validity window printed on the paper.
// Not a Work document: the library exists precisely because the same PAN
// copy serves every Work, so nothing here is work-scoped.
//
// A credential is the NAME (title plus category); a version is one file
// with one validity window. Versions are append-only, so a renewal is a
// new version and never an edit.

export const COMPANY_DOCUMENT_CATEGORIES = [
  'statutory',
  'financial',
  'eligibility',
  'certification',
  'company',
] as const;

const CompanyDocumentCategorySchema = Type.Union(
  COMPANY_DOCUMENT_CATEGORIES.map((category) => Type.Literal(category)),
);
export type CompanyDocumentCategory = Static<typeof CompanyDocumentCategorySchema>;

/** How the latest version's validity reads TODAY. Derived on every read
 * from `expiresOn` against the server's current date and never stored: a
 * stored status is wrong the morning after it is written, and the whole
 * point of recording an expiry date is that somebody is told before it
 * passes.
 *
 * `none` is not a synonym for `valid`. A PAN card does not expire; a GST
 * registration certificate whose expiry is three years away does. The
 * register says which of the two it is looking at rather than colouring
 * them the same green. */
export const CompanyDocumentExpiryStatusSchema = Type.Union([
  Type.Literal('none'),
  Type.Literal('valid'),
  Type.Literal('expiring'),
  Type.Literal('expired'),
]);
export type CompanyDocumentExpiryStatus = Static<
  typeof CompanyDocumentExpiryStatusSchema
>;

const CompanyDocumentVersionSchema = Type.Object(
  {
    id: UuidSchema,
    versionNumber: Type.Integer({ minimum: 1 }),
    originalFilename: Type.String(),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    sizeBytes: Type.Integer({ minimum: 1 }),
    validFrom: Type.Union([DateOnlySchema, Type.Null()]),
    expiresOn: Type.Union([DateOnlySchema, Type.Null()]),
    uploadedByUserId: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type CompanyDocumentVersion = Static<typeof CompanyDocumentVersionSchema>;

export const CompanyDocumentSchema = Type.Object(
  {
    id: UuidSchema,
    title: Type.String(),
    category: CompanyDocumentCategorySchema,
    /** Every version, newest first. The library is tens of rows per
     * organisation, so the history rides with the register rather than
     * costing a second request per credential the moment anyone expands
     * one. */
    versions: Type.Array(CompanyDocumentVersionSchema),
    /** The validity reading of the NEWEST version — the one a bid would
     * attach. An older version being expired is not news. */
    expiryStatus: CompanyDocumentExpiryStatusSchema,
    /** Whole days from today until the newest version's expiry; negative
     * once it has passed, null when there is no expiry. The register
     * prints it so "expiring" carries a number rather than a mood. */
    expiresInDays: Type.Union([Type.Integer(), Type.Null()]),
    archivedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type CompanyDocument = Static<typeof CompanyDocumentSchema>;

export const CompanyDocumentListResponseSchema = Type.Object(
  {
    documents: Type.Array(CompanyDocumentSchema),
    /** The window `expiring` means, in days, so the screen can say "within
     * 60 days" without hard-coding the number the server used. */
    expiryWarningDays: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type CompanyDocumentListResponse = Static<
  typeof CompanyDocumentListResponseSchema
>;

/** The metadata of an upload, carried in the querystring because the body
 * is the PDF itself — the same shape `POST /api/loa-documents?filename=`
 * and the contract-source upload already use. */
export const CompanyDocumentVersionUploadQuerySchema = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    validFrom: Type.Optional(DateOnlySchema),
    expiresOn: Type.Optional(DateOnlySchema),
  },
  { additionalProperties: false },
);

/** Creating the credential and its first version is one act, because a
 * named credential with no file behind it is a row nobody can use. */
export const CompanyDocumentUploadQuerySchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    category: CompanyDocumentCategorySchema,
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    validFrom: Type.Optional(DateOnlySchema),
    expiresOn: Type.Optional(DateOnlySchema),
  },
  { additionalProperties: false },
);
