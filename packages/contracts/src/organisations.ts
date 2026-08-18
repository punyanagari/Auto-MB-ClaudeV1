import { Type, type Static } from '@sinclair/typebox';
import {
  BankAccountHolderSchema,
  BankAccountNumberSchema,
  BankBranchSchema,
  BankNameSchema,
  IfscSchema,
} from './masters.js';
import {
  DateOnlySchema,
  GstStateCodeSchema,
  TaxInvoiceLineShapeSchema,
  UuidSchema,
} from './primitives.js';

const MembershipRoleSchema = Type.Union([
  Type.Literal('owner'),
  Type.Literal('office'),
  Type.Literal('site'),
  Type.Literal('viewer'),
]);
export type MembershipRole = Static<typeof MembershipRoleSchema>;

const WorkScopeSchema = Type.Union([Type.Literal('all'), Type.Literal('assigned')]);
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

const MembershipSchema = Type.Object(
  {
    organisationId: UuidSchema,
    userId: Type.String({ minLength: 1 }),
    role: MembershipRoleSchema,
    workScope: WorkScopeSchema,
    canIssueDocuments: Type.Boolean(),
    canCancelDocuments: Type.Boolean(),
    canApproveAmendments: Type.Boolean(),
    /** The compliance authority (migration 0061): may drive IRP and NIC
     * E-way Bill provider operations and record portal evidence. It sits
     * ON TOP of issue/cancel rather than replacing them, and defaults
     * false — it is granted, never inherited. */
    canManageStatutoryReporting: Type.Boolean(),
    /** The payments authority (migration 0080): may approve employee
     * payment requests and record or pay vendor invoices. Separate from
     * issue/cancel because sending the organisation's money out is not
     * the same act as issuing a document it is owed for. */
    canManagePayments: Type.Boolean(),
    canSignDocuments: Type.Boolean(),
    /** The payroll authority (migration 0089): may see the employee
     * register and run payroll. Separate from canManagePayments because
     * reading what every colleague earns is a different secret from
     * approving a vendor payment — a vendor-payment manager must not see
     * salaries, PAN, UAN or bank details by default. Defaults false; the
     * owner of a new organisation holds it implicitly. */
    canManagePayroll: Type.Boolean(),
    /** The notifications authority (migration 0092): may configure the
     * WhatsApp and email channels, maintain message templates, record
     * recipient consent and send a message. Separate from
     * canIssueDocuments because choosing the number the organisation
     * speaks from — and who else may be messaged — is a different
     * decision from committing the words of a document. Defaults false;
     * the owner of a new organisation holds it implicitly. */
    canManageNotifications: Type.Boolean(),
    /** The entitlements authority (migration 0096): may switch the
     * organisation's modules on and off and configure its recurring
     * statutory checks. OWNER-ONLY IN EFFECT — every route carrying it
     * also requires the owner role, so granting it to a non-owner confers
     * nothing until that member is made an owner. */
    canManageEntitlements: Type.Boolean(),
    /** The organisation-export authority (migration 0096): may request
     * and download a copy of the whole organisation record. Separate from
     * the owner role so an owner can delegate the annual package without
     * delegating the organisation; the route additionally requires full
     * work scope, because the package is not work-scoped. */
    canExportOrg: Type.Boolean(),
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
    canManageStatutoryReporting: Type.Optional(Type.Boolean()),
    canManagePayments: Type.Optional(Type.Boolean()),
    canSignDocuments: Type.Optional(Type.Boolean()),
    canManagePayroll: Type.Optional(Type.Boolean()),
    canManageNotifications: Type.Optional(Type.Boolean()),
    canManageEntitlements: Type.Optional(Type.Boolean()),
    canExportOrg: Type.Optional(Type.Boolean()),
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

export const MemberListResponseSchema = Type.Object(
  {
    members: Type.Array(MembershipSchema),
  },
  { additionalProperties: false },
);

/** The Udyam (MSME) registration number, exactly as the column's CHECK
 * holds it: UDYAM-MH-26-0224294 — two state letters, a two-digit
 * district, seven digits. */
const UdyamNumberSchema = Type.String({
  pattern: '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$',
  description: 'Udyam (MSME) registration number.',
});

/** A tax invoice number's prefix: the owner's live series runs P10 / P14,
 * so an initial letter and up to seven more uppercase alphanumerics. The
 * serial behind it is one gapless per-financial-year sequence shared
 * across every prefix. */
export const InvoiceNumberPrefixSchema = Type.String({
  pattern: '^[A-Z][A-Z0-9]{0,7}$',
  description: 'Tax invoice number prefix, e.g. P10.',
});

/** The owner's declaration of whether e-invoicing (IRP reporting)
 * applies to the organisation (migration 0049). The system cannot know
 * the turnover, so the owner asserts the legal fact and the system
 * enforces its consequence: `undeclared` blocks the IRP transport until
 * a declaration exists, `not_applicable` refuses it because voluntary
 * registration below the mandate is not provided for, and `applicable`
 * (with the date it became so) permits it — the mandate is permanent
 * once aggregate annual turnover has ever crossed ₹5 crore. */
const EinvoiceApplicabilitySchema = Type.Union([
  Type.Literal('undeclared'),
  Type.Literal('not_applicable'),
  Type.Literal('applicable'),
]);
export type EinvoiceApplicability = Static<typeof EinvoiceApplicabilitySchema>;

/** Days after its date within which an invoice may still be reported to
 * the IRP — 30 under the rule binding AATO ≥ ₹10 crore since 1 April
 * 2025. Bounded so a typo cannot declare a window the law does not
 * offer. */
const IrpReportingWindowDaysSchema = Type.Integer({
  minimum: 1,
  maximum: 365,
});

/** The six documents whose number format an organisation may define.
 * Every other numbered document keeps its fixed format. The standalone
 * Delivery Challan is its own type because it belongs to no Work: it
 * counts per financial year rather than per Work, so it can neither share
 * the work challan's counter nor its {WORK} token. */
export const NUMBERED_DOCUMENT_TYPES = [
  'delivery_challan',
  'issue_challan',
  'tax_invoice',
  'budgetary_quotation',
  'credit_note',
  'standalone_challan',
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
    /** Which line shape the invoice CREATE FORM starts on (migration
     * 0057). A form default only: the shape is chosen per document, and
     * changing this never touches an invoice that already exists.
     * Optional on the wire like the other later tax facts, so a reader
     * that predates it omits rather than invents it. */
    defaultInvoiceShape: Type.Optional(TaxInvoiceLineShapeSchema),
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

// --- The organisation's own bank accounts (migration 0078) ------------------
//
// A LIST, unlike the single beneficiary a contact carries, because the
// mock's Company settings card is a list with an "Add account" dialog
// above it. The shapes of a holder, a bank name, an account number and an
// IFSC are the Contacts master's shapes, imported rather than restated, so
// the two surfaces cannot drift.
//
// The stored account number is NOT returned. This list is add-and-retire
// with no edit control anywhere in the mock, so nothing needs to
// round-trip the value, and the only rendering the mock draws is its last
// four digits. Handing back the whole number would be exposure with no
// reader. `apps/server/src/routes/organisation.ts` selects the last four
// in SQL and never lifts the full value out of the database.

export const OrganisationBankAccountSchema = Type.Object(
  {
    id: UuidSchema,
    accountHolder: BankAccountHolderSchema,
    bankName: BankNameSchema,
    /** The last four characters only — see the note above. */
    accountNumberLast4: Type.String({ minLength: 4, maxLength: 4 }),
    ifsc: IfscSchema,
    branch: Type.Union([BankBranchSchema, Type.Null()]),
    active: Type.Boolean(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type OrganisationBankAccount = Static<typeof OrganisationBankAccountSchema>;

export const CreateOrganisationBankAccountRequestSchema = Type.Object(
  {
    accountHolder: BankAccountHolderSchema,
    bankName: BankNameSchema,
    accountNumber: BankAccountNumberSchema,
    /** Accepted in any case; stored upper. */
    ifsc: IfscSchema,
    branch: Type.Optional(BankBranchSchema),
  },
  { additionalProperties: false },
);
export type CreateOrganisationBankAccountRequest = Static<
  typeof CreateOrganisationBankAccountRequestSchema
>;

export const OrganisationBankAccountListResponseSchema = Type.Object(
  { accounts: Type.Array(OrganisationBankAccountSchema) },
  { additionalProperties: false },
);

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
    /** The invoice create form's starting shape (migration 0057). Never
     * nullable: every organisation has one, defaulting to the cumulative
     * service invoice the railway trade writes most often. */
    defaultInvoiceShape: Type.Optional(TaxInvoiceLineShapeSchema),
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
    canManageStatutoryReporting: Type.Optional(Type.Boolean()),
    canManagePayments: Type.Optional(Type.Boolean()),
    canSignDocuments: Type.Optional(Type.Boolean()),
    canManagePayroll: Type.Optional(Type.Boolean()),
    canManageNotifications: Type.Optional(Type.Boolean()),
    canManageEntitlements: Type.Optional(Type.Boolean()),
    canExportOrg: Type.Optional(Type.Boolean()),
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

export const MemberAssignmentsResponseSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    workIds: Type.Array(UuidSchema),
  },
  { additionalProperties: false },
);
export type MemberAssignmentsResponse = Static<typeof MemberAssignmentsResponseSchema>;
