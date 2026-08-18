import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  NonNegativeMoneyStringSchema,
  PositiveMoneyStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';
import { TdsPayeeClassSchema, TdsSectionSchema } from './statutory.js';

/**
 * The payments workspace: money going OUT.
 *
 * Two registers that share a screen and almost nothing else. Employee
 * payment requests are an approval flow over a person's claim; vendor
 * invoices and payments are a liability ledger with tax deducted at
 * source. They are presented together because an operator's question is
 * "what leaves the bank this week", and that question spans both.
 *
 * Every amount here is an exact decimal string, and every total that
 * matters is summed by PostgreSQL. The browser formats money; it never
 * computes it.
 */

// ── Employee payment requests ────────────────────────────────────────

/**
 * `salary` joins the two of migration 0080 with 0090's payroll.
 *
 * A salary is neither an advance nor a reimbursement, and filing it as
 * one would misstate a register somebody reconciles against a bank
 * statement. It behaves like a reimbursement in the one place the
 * lifecycle branches — paying it settles it, because there are no later
 * bills to record — and the one-open-advance gate does not touch it.
 */
export const PAYMENT_REQUEST_KINDS = ['advance', 'reimbursement', 'salary'] as const;
export const PaymentRequestKindSchema = Type.Union(
  PAYMENT_REQUEST_KINDS.map((kind) => Type.Literal(kind)),
);
export type PaymentRequestKind = Static<typeof PaymentRequestKindSchema>;

/**
 * The kinds a person may raise by hand.
 *
 * `salary` is deliberately absent. A salary request exists only because
 * a payroll run was finalised, and it carries that run's figures; one
 * typed straight into this form would be money leaving the bank with no
 * payslip behind it and nothing to reconcile against the PF and TDS
 * actually remitted. Keeping the create schema narrower than the read
 * schema is what makes that a compile-time fact rather than a rule in a
 * route comment.
 */
export const CREATABLE_PAYMENT_REQUEST_KINDS = ['advance', 'reimbursement'] as const;
export const CreatablePaymentRequestKindSchema = Type.Union(
  CREATABLE_PAYMENT_REQUEST_KINDS.map((kind) => Type.Literal(kind)),
);
export type CreatablePaymentRequestKind = Static<
  typeof CreatablePaymentRequestKindSchema
>;

/**
 * Submitted is waiting on a decision;
 * approved is authorised but unpaid; paid means the money left.
 *
 * `settled` is the one that is not obvious. A reimbursement arrives with
 * its bills, so paying it settles it in the same act. An advance is paid
 * against an estimate, and is only settled when the final bills are
 * recorded afterwards — which is the state the "record final bills
 * before new advances" gate reads.
 */
export const PAYMENT_REQUEST_STATUSES = [
  'submitted',
  'approved',
  'rejected',
  'paid',
  'settled',
] as const;
export const PaymentRequestStatusSchema = Type.Union(
  PAYMENT_REQUEST_STATUSES.map((status) => Type.Literal(status)),
);
export type PaymentRequestStatus = Static<typeof PaymentRequestStatusSchema>;

/** `payroll` is 0090's, and is not `labour`: labour means a labour
 * contractor's bill, which is a vendor liability and not a salary. */
export const PAYMENT_REQUEST_CATEGORIES = [
  'travel',
  'materials',
  'labour',
  'site_expenses',
  'general',
  'payroll',
] as const;
export const PaymentRequestCategorySchema = Type.Union(
  PAYMENT_REQUEST_CATEGORIES.map((category) => Type.Literal(category)),
);
export type PaymentRequestCategory = Static<typeof PaymentRequestCategorySchema>;

/** As with the kinds above: `payroll` is reachable only through a
 * finalised run, so the create form cannot offer it. */
export const CREATABLE_PAYMENT_REQUEST_CATEGORIES = [
  'travel',
  'materials',
  'labour',
  'site_expenses',
  'general',
] as const;
export const CreatablePaymentRequestCategorySchema = Type.Union(
  CREATABLE_PAYMENT_REQUEST_CATEGORIES.map((category) => Type.Literal(category)),
);
export type CreatablePaymentRequestCategory = Static<
  typeof CreatablePaymentRequestCategorySchema
>;

export const PaymentRequestSchema = Type.Object(
  {
    id: UuidSchema,
    requestNumber: Type.String(),
    kind: PaymentRequestKindSchema,
    status: PaymentRequestStatusSchema,
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String(), Type.Null()]),
    beneficiaryContactId: UuidSchema,
    beneficiaryName: Type.String(),
    purpose: Type.String(),
    category: PaymentRequestCategorySchema,
    amount: PositiveMoneyStringSchema,
    proofFilename: Type.Union([Type.String(), Type.Null()]),
    /** True for a PAID ADVANCE whose final bills are still outstanding.
     * The one flag the "new requests are blocked" banner reads. */
    billsDue: Type.Boolean(),
    billsRecordedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    requestedByUserId: Type.String(),
    decidedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    decisionNote: Type.Union([Type.String(), Type.Null()]),
    paidAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    paidReference: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type PaymentRequest = Static<typeof PaymentRequestSchema>;

export const CreatePaymentRequestSchema = Type.Object(
  {
    kind: CreatablePaymentRequestKindSchema,
    beneficiaryContactId: UuidSchema,
    workId: Type.Optional(UuidSchema),
    purpose: nonBlankString({ minLength: 3, maxLength: 500 }),
    category: CreatablePaymentRequestCategorySchema,
    amount: PositiveMoneyStringSchema,
    /**
     * What the claim rests on — the estimate, quotation or bill, named.
     * Required, because the mock has no way to submit without proof
     * ("Every expense requires proof before it can be submitted").
     *
     * ponytail: a typed REFERENCE, not an upload. The column is named
     * for what it holds rather than pretending to be an object key: a
     * stored key with no upload behind it and no route to fetch it is a
     * proof that cannot be produced, which is worse than an honest
     * reference. Route it through `consumeUpload` and add a serve route
     * when the proof has to survive an audit rather than jog a memory.
     */
    proofReference: nonBlankString({ minLength: 2, maxLength: 400 }),
    proofFilename: nonBlankString({ minLength: 2, maxLength: 255 }),
  },
  { additionalProperties: false },
);
export type CreatePaymentRequest = Static<typeof CreatePaymentRequestSchema>;

export const DecidePaymentRequestSchema = Type.Object(
  {
    decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
    /** Required on a rejection and ignored on an approval — a refusal
     * has to say what must be corrected. */
    note: Type.Optional(nonBlankString({ minLength: 3, maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export type DecidePaymentRequest = Static<typeof DecidePaymentRequestSchema>;

export const PayPaymentRequestSchema = Type.Object(
  {
    reference: nonBlankString({ minLength: 2, maxLength: 100 }),
    paidOn: DateOnlySchema,
  },
  { additionalProperties: false },
);
export type PayPaymentRequest = Static<typeof PayPaymentRequestSchema>;

export const RecordAdvanceBillsSchema = Type.Object(
  { note: Type.Optional(nonBlankString({ minLength: 3, maxLength: 500 })) },
  { additionalProperties: false },
);
export type RecordAdvanceBills = Static<typeof RecordAdvanceBillsSchema>;

export const PaymentRequestListResponseSchema = Type.Object(
  {
    /* No separate blocked-beneficiary list: every request carries
       `billsDue`, so the set of beneficiaries who cannot draw another
       advance is `requests.filter(r => r.billsDue)` and a second field
       is a second thing that can disagree with the first. */
    requests: Type.Array(PaymentRequestSchema),
  },
  { additionalProperties: false },
);
export type PaymentRequestListResponse = Static<
  typeof PaymentRequestListResponseSchema
>;

// ── Vendor liabilities and payments ──────────────────────────────────

export const VendorPaymentSchema = Type.Object(
  {
    id: UuidSchema,
    paidOn: DateOnlySchema,
    /** What the payment discharges of the invoice: `tds + net`. */
    grossAmount: PositiveMoneyStringSchema,
    tdsAmount: NonNegativeMoneyStringSchema,
    /** What reached the vendor's bank. */
    netAmount: NonNegativeMoneyStringSchema,
    tdsSection: Type.Union([TdsSectionSchema, Type.Null()]),
    tdsRate: Type.Union([Type.String(), Type.Null()]),
    panAbsent: Type.Boolean(),
    vendorPan: Type.Union([Type.String(), Type.Null()]),
    /** What the rate was applied to, and why. Null when nothing was
     * withheld. Snapshotted so a 26Q line whose tax exceeds its own
     * rate x gross explains itself. */
    tdsTaxableAmount: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),
    tdsTaxableBasis: Type.Union([
      Type.Literal('payment'),
      Type.Literal('aggregate_catch_up'),
      Type.Null(),
    ]),
    reference: Type.Union([Type.String(), Type.Null()]),
    remarks: Type.Union([Type.String(), Type.Null()]),
    voidedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    voidReason: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type VendorPayment = Static<typeof VendorPaymentSchema>;

export const VendorInvoiceSchema = Type.Object(
  {
    id: UuidSchema,
    vendorContactId: UuidSchema,
    vendorName: Type.String(),
    invoiceNumber: Type.String(),
    invoiceDate: DateOnlySchema,
    creditDays: Type.Integer({ minimum: 0, maximum: 365 }),
    /** `invoiceDate + creditDays`, computed in SQL so the register and
     * the server never disagree about what is overdue. */
    dueOn: DateOnlySchema,
    amount: PositiveMoneyStringSchema,
    workId: Type.Union([UuidSchema, Type.Null()]),
    tdsSection: Type.Union([TdsSectionSchema, Type.Null()]),
    tdsPayeeClass: Type.Union([TdsPayeeClassSchema, Type.Null()]),
    /** Summed in SQL over live payments, by GROSS. */
    paidTotal: NonNegativeMoneyStringSchema,
    outstandingAmount: NonNegativeMoneyStringSchema,
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelReason: Type.Union([Type.String(), Type.Null()]),
    payments: Type.Array(VendorPaymentSchema),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type VendorInvoice = Static<typeof VendorInvoiceSchema>;

export const RecordVendorInvoiceSchema = Type.Object(
  {
    vendorContactId: UuidSchema,
    invoiceNumber: nonBlankString({ minLength: 2, maxLength: 60 }),
    invoiceDate: DateOnlySchema,
    creditDays: Type.Integer({ minimum: 0, maximum: 365 }),
    amount: PositiveMoneyStringSchema,
    workId: Type.Optional(UuidSchema),
    /** Both or neither: a section without a payee class cannot produce
     * a rate. */
    tdsSection: Type.Optional(TdsSectionSchema),
    tdsPayeeClass: Type.Optional(TdsPayeeClassSchema),
  },
  { additionalProperties: false },
);
export type RecordVendorInvoice = Static<typeof RecordVendorInvoiceSchema>;

/**
 * Paying a vendor.
 *
 * The caller sends the GROSS and the server computes the TDS from the
 * statutory table and the invoice's section — the client never sends a
 * tax amount. That is deliberate: a browser-computed deduction is a
 * float-rounded deduction, and it would also let a caller choose its own
 * rate.
 *
 * There is deliberately no override. A lower-deduction certificate under
 * section 197 is the real case for one, and it needs more than a free
 * amount — the certificate number, its validity period and the rate it
 * certifies all have to be recorded for the deduction to be defensible.
 * A bare "trust this number" field would look like support for that and
 * would not be it. Add it when a certificate has somewhere to live.
 */
export const RecordVendorPaymentSchema = Type.Object(
  {
    paidOn: DateOnlySchema,
    grossAmount: PositiveMoneyStringSchema,
    reference: Type.Optional(nonBlankString({ minLength: 2, maxLength: 100 })),
    remarks: Type.Optional(nonBlankString({ minLength: 2, maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type RecordVendorPayment = Static<typeof RecordVendorPaymentSchema>;

export const VoidVendorPaymentSchema = Type.Object(
  { reason: nonBlankString({ minLength: 3, maxLength: 500 }) },
  { additionalProperties: false },
);
export type VoidVendorPayment = Static<typeof VoidVendorPaymentSchema>;

export const CancelVendorInvoiceSchema = Type.Object(
  { reason: nonBlankString({ minLength: 3, maxLength: 500 }) },
  { additionalProperties: false },
);
export type CancelVendorInvoice = Static<typeof CancelVendorInvoiceSchema>;

export const VendorLedgerResponseSchema = Type.Object(
  {
    invoices: Type.Array(VendorInvoiceSchema),
    /** Every total on the register header, summed in SQL. */
    totalOutstanding: NonNegativeMoneyStringSchema,
    overdueCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type VendorLedgerResponse = Static<typeof VendorLedgerResponseSchema>;

// ── TDS preview and quarterly return ─────────────────────────────────

/**
 * What the server would deduct on a proposed payment, so the operator
 * sees the rate and the reason before committing.
 *
 * It exists because a TDS deduction has three surprising behaviours an
 * operator should not meet for the first time in the ledger: the
 * threshold that has not been crossed yet, the financial-year aggregate
 * that crosses it mid-payment, and the section 206AA uplift for a
 * missing PAN.
 */
/** Asking what would be deducted. A POST body rather than a query
 * string: the amount is a rupee figure about a named vendor, and a URL
 * is the one place request logs, proxies and browser history all keep
 * (AGENTS.md rule 11). */
export const PreviewVendorTdsSchema = Type.Object(
  {
    grossAmount: PositiveMoneyStringSchema,
    paidOn: DateOnlySchema,
  },
  { additionalProperties: false },
);
export type PreviewVendorTds = Static<typeof PreviewVendorTdsSchema>;

export const TdsPreviewResponseSchema = Type.Object(
  {
    section: Type.Union([TdsSectionSchema, Type.Null()]),
    rate: Type.String(),
    ordinaryRate: Type.String(),
    tdsAmount: NonNegativeMoneyStringSchema,
    netAmount: NonNegativeMoneyStringSchema,
    deductible: Type.Boolean(),
    panAbsentUplift: Type.Boolean(),
    /** What the rate is applied to. Equal to the gross except on the
     * payment that carries the year over its annual threshold, which
     * owes tax on every earlier untaxed payment as well. */
    taxableAmount: NonNegativeMoneyStringSchema,
    taxableBasis: Type.Union([
      Type.Literal('payment'),
      Type.Literal('aggregate_catch_up'),
      Type.Literal('none'),
    ]),
    thresholdBasis: Type.Union([
      Type.Literal('single_payment'),
      Type.Literal('annual_aggregate'),
      Type.Literal('none'),
    ]),
    /** Paid to this vendor earlier in the same financial year, which is
     * what the aggregate threshold is measured against. */
    financialYearPaidBefore: NonNegativeMoneyStringSchema,
    /** The provision the rate comes from, so the screen can cite it. */
    provisionCitation: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type TdsPreviewResponse = Static<typeof TdsPreviewResponseSchema>;

/**
 * The quarterly TDS export.
 *
 * Quarters are the income-tax financial year's, not the calendar's: Q1
 * is April–June. The export is a flat CSV because that is what a tax
 * practitioner's return-preparation utility ingests, and because the
 * product has no spreadsheet writer and does not need one to emit rows
 * of numbers.
 */
export const TDS_QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;
export const TdsQuarterSchema = Type.Union(
  TDS_QUARTERS.map((quarter) => Type.Literal(quarter)),
);
export type TdsQuarter = Static<typeof TdsQuarterSchema>;

export const TdsReturnQuerySchema = Type.Object(
  {
    financialYear: Type.String({ pattern: '^[0-9]{4}-[0-9]{2}$' }),
    quarter: TdsQuarterSchema,
  },
  { additionalProperties: false },
);
export type TdsReturnQuery = Static<typeof TdsReturnQuerySchema>;
