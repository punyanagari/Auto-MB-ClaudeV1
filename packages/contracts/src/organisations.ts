import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, GstStateCodeSchema, UuidSchema } from './primitives.js';

export const MembershipRoleSchema = Type.Union([
  Type.Literal('owner'),
  Type.Literal('office'),
  Type.Literal('site'),
  Type.Literal('viewer'),
]);
export type MembershipRole = Static<typeof MembershipRoleSchema>;

export const WorkScopeSchema = Type.Union([
  Type.Literal('all'),
  Type.Literal('assigned'),
]);
export type WorkScope = Static<typeof WorkScopeSchema>;

export const OrganisationSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String({ minLength: 2, maxLength: 200 }),
    slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,62}$' }),
  },
  { additionalProperties: false },
);
export type Organisation = Static<typeof OrganisationSchema>;

export const MembershipSchema = Type.Object(
  {
    organisationId: UuidSchema,
    userId: Type.String({ minLength: 1 }),
    role: MembershipRoleSchema,
    workScope: WorkScopeSchema,
    canIssueDocuments: Type.Boolean(),
    canCancelDocuments: Type.Boolean(),
    canApproveAmendments: Type.Boolean(),
    /** Whether the member's ACCOUNT has completed TOTP enrolment. Owners
     * see it in the member list so authority is granted to enrolled
     * accounts, not enrolment chased afterwards (finding 36). */
    twoFactorEnabled: Type.Boolean(),
    status: Type.Union([
      Type.Literal('invited'),
      Type.Literal('active'),
      Type.Literal('disabled'),
    ]),
  },
  { additionalProperties: false },
);
export type Membership = Static<typeof MembershipSchema>;

export const CreateOrganisationRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 2, maxLength: 200 }),
    slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,62}$' }),
  },
  { additionalProperties: false },
);
export type CreateOrganisationRequest = Static<typeof CreateOrganisationRequestSchema>;

export const AddMemberRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 320 }),
    role: MembershipRoleSchema,
    workScope: Type.Optional(WorkScopeSchema),
    canIssueDocuments: Type.Optional(Type.Boolean()),
    canCancelDocuments: Type.Optional(Type.Boolean()),
    canApproveAmendments: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type AddMemberRequest = Static<typeof AddMemberRequestSchema>;

export const OrganisationListResponseSchema = Type.Object(
  {
    organisations: Type.Array(OrganisationSchema),
  },
  { additionalProperties: false },
);
export type OrganisationListResponse = Static<typeof OrganisationListResponseSchema>;

export const MemberListResponseSchema = Type.Object(
  {
    members: Type.Array(MembershipSchema),
  },
  { additionalProperties: false },
);
export type MemberListResponse = Static<typeof MemberListResponseSchema>;

/** The Udyam (MSME) registration number, exactly as the column's CHECK
 * holds it: UDYAM-MH-26-0224294 — two state letters, a two-digit
 * district, seven digits. */
export const UdyamNumberSchema = Type.String({
  pattern: '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$',
  description: 'Udyam (MSME) registration number.',
});
export type UdyamNumber = Static<typeof UdyamNumberSchema>;

/** A tax invoice number's prefix: the owner's live series runs P10 / P14,
 * so an initial letter and up to seven more uppercase alphanumerics. The
 * serial behind it is one gapless per-financial-year sequence shared
 * across every prefix. */
export const InvoiceNumberPrefixSchema = Type.String({
  pattern: '^[A-Z][A-Z0-9]{0,7}$',
  description: 'Tax invoice number prefix, e.g. P10.',
});
export type InvoiceNumberPrefix = Static<typeof InvoiceNumberPrefixSchema>;

/** The owner's declaration of whether e-invoicing (IRP reporting)
 * applies to the organisation (migration 0049). The system cannot know
 * the turnover, so the owner asserts the legal fact and the system
 * enforces its consequence: `undeclared` blocks the IRP transport until
 * a declaration exists, `not_applicable` refuses it because voluntary
 * registration below the mandate is not provided for, and `applicable`
 * (with the date it became so) permits it — the mandate is permanent
 * once aggregate annual turnover has ever crossed ₹5 crore. */
export const EinvoiceApplicabilitySchema = Type.Union([
  Type.Literal('undeclared'),
  Type.Literal('not_applicable'),
  Type.Literal('applicable'),
]);
export type EinvoiceApplicability = Static<typeof EinvoiceApplicabilitySchema>;

/** Days after its date within which an invoice may still be reported to
 * the IRP — 30 under the rule binding AATO ≥ ₹10 crore since 1 April
 * 2025. Bounded so a typo cannot declare a window the law does not
 * offer. */
export const IrpReportingWindowDaysSchema = Type.Integer({
  minimum: 1,
  maximum: 365,
});
export type IrpReportingWindowDays = Static<typeof IrpReportingWindowDaysSchema>;

/** The four documents whose number format an organisation may define.
 * Every other numbered document keeps its fixed format. */
export const NUMBERED_DOCUMENT_TYPES = [
  'delivery_challan',
  'issue_challan',
  'tax_invoice',
  'budgetary_quotation',
] as const;
export const NumberedDocumentTypeSchema = Type.Union(
  NUMBERED_DOCUMENT_TYPES.map((value) => Type.Literal(value)),
);
export type NumberedDocumentType = Static<typeof NumberedDocumentTypeSchema>;

/** One document type's number format.
 *
 * Tokens: {WORK} the Work code, {PREFIX} the document's own prefix, {DIV}
 * the buyer's railway division code less one trailing zero, {FY}
 * '2026-27', {FY2} '26', {YYYY}/{YY} the document date's year, and {SEQ}
 * or {SEQ:n} the zero-padded counter. Everything outside a brace is a
 * literal. A template must use {SEQ}, or every document would take the
 * same number. */
export const NumberSeriesSchema = Type.Object(
  {
    documentType: NumberedDocumentTypeSchema,
    template: Type.String({ minLength: 1, maxLength: 120 }),
    /** True while the organisation has configured nothing and the
     * product default is in force — so the screen can say so rather
     * than presenting a default as a choice already made. */
    isDefault: Type.Boolean(),
    /** The tokens THIS document can fill in; the rest would be blank
     * every time and are refused when the template is saved. */
    availableTokens: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type NumberSeries = Static<typeof NumberSeriesSchema>;

export const NumberSeriesListResponseSchema = Type.Object(
  { series: Type.Array(NumberSeriesSchema) },
  { additionalProperties: false },
);
export type NumberSeriesListResponse = Static<typeof NumberSeriesListResponseSchema>;

/** PUT sets a template; DELETE restores the product default. */
export const SaveNumberSeriesRequestSchema = Type.Object(
  { template: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);
export type SaveNumberSeriesRequest = Static<typeof SaveNumberSeriesRequestSchema>;

/** The organisation's document-branding profile: company details and the
 * logo that appear on generated PDFs. Presentation-level — issued
 * snapshots keep the legal record. */
export const OrganisationProfileSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String({ minLength: 2, maxLength: 200 }),
    slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,62}$' }),
    address: Type.Union([Type.String({ minLength: 1, maxLength: 600 }), Type.Null()]),
    gstin: Type.Union([Type.String({ pattern: '^[0-9A-Z]{15}$' }), Type.Null()]),
    contactPhone: Type.Union([
      Type.String({ minLength: 3, maxLength: 30 }),
      Type.Null(),
    ]),
    contactEmail: Type.Union([
      Type.String({ minLength: 3, maxLength: 200 }),
      Type.Null(),
    ]),
    hasLogo: Type.Boolean(),
    /** The place of business's two-digit GST state code (migration
     * 0033). Not derived from the GSTIN above, though it is its first
     * two characters: an unregistered organisation still has a place of
     * business, and the invoice still has to name a state — it is what
     * decides CGST+SGST against IGST for a given place of supply.
     * Optional on the wire so a reader that predates the tax columns
     * omits it rather than reporting a state it never selected. */
    stateCode: Type.Optional(Type.Union([GstStateCodeSchema, Type.Null()])),
    /** The tax invoice's masthead facts (migration 0037). The PIN is
     * load-bearing rather than decorative: the e-invoice payload needs
     * the seller's PIN as a figure in its own right, and an address line
     * is not required to contain one. Optional on the wire for the same
     * reason stateCode is — a reader that predates them omits them. */
    pincode: Type.Optional(
      Type.Union([Type.String({ pattern: '^[0-9]{6}$' }), Type.Null()]),
    ),
    /** Explicit NIC SellerDtls.Loc value; never inferred from address text. */
    locality: Type.Optional(
      Type.Union([Type.String({ minLength: 2, maxLength: 100 }), Type.Null()]),
    ),
    /** The name traded under, when it differs from the legal name. */
    tradeName: Type.Optional(
      Type.Union([Type.String({ minLength: 2, maxLength: 200 }), Type.Null()]),
    ),
    /** Udyam registration, printed as 'Our MSME No.:-'. */
    msmeNumber: Type.Optional(Type.Union([UdyamNumberSchema, Type.Null()])),
    /** House defaults for tax invoices (migration 0038): the number
     * prefix most invoices take, and the standing Notes line. An invoice
     * that sets its own overrides either. */
    invoiceNumberPrefix: Type.Optional(
      Type.Union([InvoiceNumberPrefixSchema, Type.Null()]),
    ),
    invoiceNotes: Type.Optional(
      Type.Union([Type.String({ minLength: 3, maxLength: 4000 }), Type.Null()]),
    ),
    /** Warranty agreement template for a later document generator;
     * stored verbatim, never rendered here (Milestone 7: CRUD only). */
    warrantyTemplateText: Type.Union([
      Type.String({ minLength: 1, maxLength: 20000 }),
      Type.Null(),
    ]),
    /** The e-invoicing declaration (migration 0049). Optional on the
     * wire like the other later tax facts, so a reader that predates
     * them omits rather than invents them. The three travel together:
     * `applicable` carries the from-date, and a reporting window exists
     * only while applicable. */
    einvoiceApplicability: Type.Optional(EinvoiceApplicabilitySchema),
    einvoiceApplicableFrom: Type.Optional(Type.Union([DateOnlySchema, Type.Null()])),
    irpReportingWindowDays: Type.Optional(
      Type.Union([IrpReportingWindowDaysSchema, Type.Null()]),
    ),
  },
  { additionalProperties: false },
);
export type OrganisationProfile = Static<typeof OrganisationProfileSchema>;

export const UpdateOrganisationProfileRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
    address: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 600 }), Type.Null()]),
    ),
    gstin: Type.Optional(
      Type.Union([Type.String({ pattern: '^[0-9A-Z]{15}$' }), Type.Null()]),
    ),
    contactPhone: Type.Optional(
      Type.Union([Type.String({ minLength: 3, maxLength: 30 }), Type.Null()]),
    ),
    contactEmail: Type.Optional(
      Type.Union([Type.String({ minLength: 3, maxLength: 200 }), Type.Null()]),
    ),
    /** Two digits, exactly as the column's CHECK holds; null clears it. */
    stateCode: Type.Optional(Type.Union([GstStateCodeSchema, Type.Null()])),
    pincode: Type.Optional(
      Type.Union([Type.String({ pattern: '^[0-9]{6}$' }), Type.Null()]),
    ),
    locality: Type.Optional(
      Type.Union([Type.String({ minLength: 2, maxLength: 100 }), Type.Null()]),
    ),
    tradeName: Type.Optional(
      Type.Union([Type.String({ minLength: 2, maxLength: 200 }), Type.Null()]),
    ),
    msmeNumber: Type.Optional(Type.Union([UdyamNumberSchema, Type.Null()])),
    /** House defaults an invoice inherits unless it sets its own. */
    invoiceNumberPrefix: Type.Optional(
      Type.Union([InvoiceNumberPrefixSchema, Type.Null()]),
    ),
    invoiceNotes: Type.Optional(
      Type.Union([Type.String({ minLength: 3, maxLength: 4000 }), Type.Null()]),
    ),
    warrantyTemplateText: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 20000 }), Type.Null()]),
    ),
    /** The e-invoicing declaration. The server holds the three to the
     * same coherence the 0049 CHECK binds: `applicable` requires the
     * from-date, anything else forbids it, and a window may exist only
     * while applicable. */
    einvoiceApplicability: Type.Optional(EinvoiceApplicabilitySchema),
    einvoiceApplicableFrom: Type.Optional(Type.Union([DateOnlySchema, Type.Null()])),
    irpReportingWindowDays: Type.Optional(
      Type.Union([IrpReportingWindowDaysSchema, Type.Null()]),
    ),
  },
  { additionalProperties: false },
);
export type UpdateOrganisationProfileRequest = Static<
  typeof UpdateOrganisationProfileRequestSchema
>;

/** Owner-only membership update: any subset of role, scope, authorities,
 * and status. The last active owner can be neither demoted nor disabled. */
export const UpdateMemberRequestSchema = Type.Object(
  {
    role: Type.Optional(MembershipRoleSchema),
    workScope: Type.Optional(WorkScopeSchema),
    canIssueDocuments: Type.Optional(Type.Boolean()),
    canCancelDocuments: Type.Optional(Type.Boolean()),
    canApproveAmendments: Type.Optional(Type.Boolean()),
    status: Type.Optional(
      Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
    ),
  },
  { additionalProperties: false },
);
export type UpdateMemberRequest = Static<typeof UpdateMemberRequestSchema>;

/** Replaces the member's Work assignments with exactly this set. */
export const SetAssignmentsRequestSchema = Type.Object(
  {
    workIds: Type.Array(UuidSchema, { maxItems: 500 }),
  },
  { additionalProperties: false },
);
export type SetAssignmentsRequest = Static<typeof SetAssignmentsRequestSchema>;

export const MemberAssignmentsResponseSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    workIds: Type.Array(UuidSchema),
  },
  { additionalProperties: false },
);
export type MemberAssignmentsResponse = Static<typeof MemberAssignmentsResponseSchema>;
