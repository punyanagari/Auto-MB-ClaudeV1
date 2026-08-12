import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  NonNegativeDecimalStringSchema,
  RoundOffStringSchema,
  DecimalStringSchema,
  GstRateSchema,
  GstStateCodeSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';
import { InvoiceNumberPrefixSchema } from './organisations.js';

/**
 * The two GST tax documents (migration 0035): the TAX INVOICE and the
 * E-WAY BILL that moves it.
 *
 * The invoice model, settled with the product owner: a works contract is
 * a supply of services under GST, so the tax invoice is CUMULATIVE — one
 * service line at a SAC (six digits) for a finalized Measurement Book's
 * total. It is never a per-item HSN document. Draft -> submitted
 * (numbered gapless per organisation PER FINANCIAL YEAR, buyer
 * snapshotted, amounts frozen from the MB total in exact SQL numeric
 * arithmetic) -> cancelled. Submitting the invoice is what closes the MB
 * it bills; cancelling it releases the MB for a corrected invoice.
 *
 * The e-way bill shapes below serve LEGACY records. The owner's decision
 * (finding 1, docs/AUDIT-DISPOSITION-2026-08-10.md): these SAC service
 * invoices need no e-way bill, so fresh generation is refused; the live
 * provider surface (Whitebooks) is lookup and cancellation of bills that
 * already exist. The 12-digit EWB number and validity window only ever
 * came BACK from NIC — never made up locally. Draft -> generated ->
 * cancelled.
 */

// --- Shared vocabulary -------------------------------------------------------

export const TAX_INVOICE_STATUSES = ['draft', 'submitted', 'cancelled'] as const;
export const TaxInvoiceStatusSchema = Type.Union(
  TAX_INVOICE_STATUSES.map((status) => Type.Literal(status)),
);
export type TaxInvoiceStatus = Static<typeof TaxInvoiceStatusSchema>;

/** SAC (services) code: exactly six digits — services take no 8-digit
 * deepening, and the cumulative invoice line is always a service. The
 * 9954xx family is works contracts, but the schema does not hard-code
 * that judgement (the 0035 column holds the same six-digit CHECK). */
export const SacCodeSchema = Type.String({
  pattern: '^[0-9]{6}$',
  description: 'SAC (services accounting) code: exactly six digits.',
});
export type SacCode = Static<typeof SacCodeSchema>;

/** The IRN as the IRP mints it: 64 lowercase hex characters. */
export const IrnSchema = Type.String({
  pattern: '^[0-9a-f]{64}$',
  description: 'Invoice Reference Number: 64 hexadecimal characters.',
});
export type Irn = Static<typeof IrnSchema>;

export const IRP_PROVIDER_STATES = [
  'not_requested',
  'registering',
  'registered',
  'registration_failed',
  'registration_unknown',
  'cancelling',
  'cancelled',
  'cancellation_unknown',
] as const;
export const IrpProviderStateSchema = Type.Union(
  IRP_PROVIDER_STATES.map((state) => Type.Literal(state)),
);
export type IrpProviderState = Static<typeof IrpProviderStateSchema>;

// --- Tax invoice requests ----------------------------------------------------

/** POST /api/works/:id/tax-invoices — drafts the invoice against a
 * finalized on-account or final Measurement Book of the Work. The buyer
 * is a contact; its details are snapshotted at SUBMIT (not now), so a
 * master edit before submit is reflected and one after is not. */
export const CreateTaxInvoiceRequestSchema = Type.Object(
  {
    measurementBookId: UuidSchema,
    invoiceDate: DateOnlySchema,
    sacCode: SacCodeSchema,
    serviceDescription: nonBlankString({ minLength: 3, maxLength: 1000 }),
    gstRate: GstRateSchema,
    /** Two-digit state code of the place of supply. Against the
     * organisation's own state it decides CGST+SGST (intra) vs IGST
     * (inter) at submit. */
    placeOfSupply: GstStateCodeSchema,
    /** Explicit GST liability confirmation. Reverse-charge invoices are
     * retained as drafts but issuance is refused until that calculation and
     * statutory flow are implemented. Omitted means not yet confirmed. */
    reverseChargeApplicable: Type.Optional(Type.Boolean()),
    buyerContactId: UuidSchema,
    /** The BUYER's own order reference, printed on the face of the
     * invoice and verbatim: the paying division matches the bill against
     * it. One free-text field on purpose — the observed shape is
     * division / tender number / order number and date, but that grammar
     * is the railway's, it varies by division, and a parser would refuse
     * the first invoice that did not match it. */
    customerPoReference: Type.Optional(
      nonBlankString({ minLength: 3, maxLength: 500 }),
    ),
    /** The unit word beside the quantity ('set'). Per invoice, because
     * work billed per metre or per job says something else. The column
     * measures TRIMMED length 1..20, and a floor of one cannot use
     * nonBlankString — it starts at two — so the pattern demands at
     * least one non-space character itself. */
    unitLabel: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 20,
        pattern: '^[\\s\\S]*[^ ][\\s\\S]*$',
        description: "The unit word beside the quantity, e.g. 'set'.",
      }),
    ),
    /** The Notes block. Falls back to the organisation's standing line
     * when omitted; nothing to do with the cancellation note. */
    notes: Type.Optional(nonBlankString({ minLength: 3, maxLength: 4000 })),
    /** Where the supply is delivered, when that differs from who is
     * billed. Snapshotted at submit like the buyer. Omitted means the
     * ship-to block repeats the buyer, which is the common case. */
    shipToContactId: Type.Optional(UuidSchema),
    /** Overrides the organisation's house prefix for this invoice's
     * number; the serial behind it is shared across every prefix. */
    numberPrefix: Type.Optional(InvoiceNumberPrefixSchema),
  },
  { additionalProperties: false },
);
export type CreateTaxInvoiceRequest = Static<typeof CreateTaxInvoiceRequestSchema>;

/** POST /api/tax-invoices — a DIRECT invoice, raised against a private
 * customer rather than a works contract. It descends from no LOA, so it
 * names no Work and no Measurement Book, and states its own taxable
 * value; everything else — the SAC, the buyer, the GST split, the
 * number, the IRN — behaves exactly as on an MB-backed invoice. */
export const CreateDirectTaxInvoiceRequestSchema = Type.Object(
  {
    invoiceDate: DateOnlySchema,
    sacCode: SacCodeSchema,
    serviceDescription: nonBlankString({ minLength: 3, maxLength: 1000 }),
    gstRate: GstRateSchema,
    placeOfSupply: GstStateCodeSchema,
    /** See the MB-backed request. Omitted means not yet confirmed. */
    reverseChargeApplicable: Type.Optional(Type.Boolean()),
    buyerContactId: UuidSchema,
    /** What the supply is worth before tax. Stated, because there is no
     * Measurement Book to measure it. */
    taxableValue: NonNegativeDecimalStringSchema,
    customerPoReference: Type.Optional(
      nonBlankString({ minLength: 3, maxLength: 500 }),
    ),
    unitLabel: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 20,
        pattern: '^[\\s\\S]*[^ ][\\s\\S]*$',
      }),
    ),
    notes: Type.Optional(nonBlankString({ minLength: 3, maxLength: 4000 })),
    shipToContactId: Type.Optional(UuidSchema),
    numberPrefix: Type.Optional(InvoiceNumberPrefixSchema),
  },
  { additionalProperties: false },
);
export type CreateDirectTaxInvoiceRequest = Static<
  typeof CreateDirectTaxInvoiceRequestSchema
>;

/** PUT /api/tax-invoices/:id — edits the draft's fields. The Measurement
 * Book is the invoice's SUBJECT, not a field: re-pointing an invoice at
 * another MB is delete-and-redraft, so the 0035 finalized-MB insert
 * guard is never sidestepped by an update. */
export const UpdateTaxInvoiceRequestSchema = Type.Object(
  {
    invoiceDate: DateOnlySchema,
    sacCode: SacCodeSchema,
    serviceDescription: nonBlankString({ minLength: 3, maxLength: 1000 }),
    gstRate: GstRateSchema,
    placeOfSupply: GstStateCodeSchema,
    /** See the create request. Omitted means not yet confirmed. */
    reverseChargeApplicable: Type.Optional(Type.Boolean()),
    buyerContactId: UuidSchema,
    /** The BUYER's own order reference, printed on the face of the
     * invoice and verbatim: the paying division matches the bill against
     * it. One free-text field on purpose — the observed shape is
     * division / tender number / order number and date, but that grammar
     * is the railway's, it varies by division, and a parser would refuse
     * the first invoice that did not match it. */
    customerPoReference: Type.Optional(
      nonBlankString({ minLength: 3, maxLength: 500 }),
    ),
    /** The unit word beside the quantity ('set'). Per invoice, because
     * work billed per metre or per job says something else. The column
     * measures TRIMMED length 1..20, and a floor of one cannot use
     * nonBlankString — it starts at two — so the pattern demands at
     * least one non-space character itself. */
    unitLabel: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 20,
        pattern: '^[\\s\\S]*[^ ][\\s\\S]*$',
        description: "The unit word beside the quantity, e.g. 'set'.",
      }),
    ),
    /** The Notes block. Falls back to the organisation's standing line
     * when omitted; nothing to do with the cancellation note. */
    notes: Type.Optional(nonBlankString({ minLength: 3, maxLength: 4000 })),
    /** Where the supply is delivered, when that differs from who is
     * billed. Snapshotted at submit like the buyer. Omitted means the
     * ship-to block repeats the buyer, which is the common case. */
    shipToContactId: Type.Optional(UuidSchema),
    /** Overrides the organisation's house prefix for this invoice's
     * number; the serial behind it is shared across every prefix. */
    numberPrefix: Type.Optional(InvoiceNumberPrefixSchema),
  },
  { additionalProperties: false },
);
export type UpdateTaxInvoiceRequest = Static<typeof UpdateTaxInvoiceRequestSchema>;

const ProviderTimestampTextSchema = Type.String({
  minLength: 19,
  maxLength: 25,
  pattern:
    '^([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}([zZ]|[+-][0-9]{2}:[0-9]{2})?|[0-9]{2}/[0-9]{2}/[0-9]{4}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})$',
});

/** The cancellation note column measures TRIMMED length 3..2000. */
export const CancelTaxInvoiceRequestSchema = Type.Object(
  { note: nonBlankString({ minLength: 3, maxLength: 2000 }) },
  { additionalProperties: false },
);
export type CancelTaxInvoiceRequest = Static<typeof CancelTaxInvoiceRequestSchema>;

/** Provider-side statutory cancellation. NIC/IRP reason codes are kept as
 * strings so no caller can silently coerce or truncate the provider value. */
export const CancelStatutoryDocumentRequestSchema = Type.Object(
  {
    reasonCode: Type.Union([
      Type.Literal('1'),
      Type.Literal('2'),
      Type.Literal('3'),
      Type.Literal('4'),
    ]),
    remark: nonBlankString({ minLength: 3, maxLength: 2000 }),
  },
  { additionalProperties: false },
);
export type CancelStatutoryDocumentRequest = Static<
  typeof CancelStatutoryDocumentRequestSchema
>;

/** Compatibility import for a cancellation already completed outside the
 * app. It never claims provider verification; exact portal text is retained. */
export const RecordManualStatutoryCancellationRequestSchema = Type.Object(
  {
    reasonCode: Type.Union([
      Type.Literal('1'),
      Type.Literal('2'),
      Type.Literal('3'),
      Type.Literal('4'),
    ]),
    remark: nonBlankString({ minLength: 3, maxLength: 2000 }),
    cancelledAt: Type.String({ format: 'date-time' }),
    cancelledAtText: ProviderTimestampTextSchema,
  },
  { additionalProperties: false },
);
export type RecordManualStatutoryCancellationRequest = Static<
  typeof RecordManualStatutoryCancellationRequestSchema
>;

/** POST /api/tax-invoices/:id/irp-response — what the GSP brought back
 * from the IRP. Recorded once, on a submitted invoice, verbatim. */
export const RecordIrpResponseRequestSchema = Type.Object(
  {
    irn: IrnSchema,
    ackNumber: nonBlankString({ minLength: 2, maxLength: 100 }),
    ackDate: Type.String({ format: 'date-time' }),
    /** Portal wall clock exactly as displayed; no browser timezone rewrite. */
    ackDateText: ProviderTimestampTextSchema,
    signedQr: Type.String({ minLength: 1, maxLength: 65536 }),
    signedInvoice: Type.Optional(Type.String({ minLength: 1, maxLength: 1048576 })),
  },
  { additionalProperties: false },
);
export type RecordIrpResponseRequest = Static<typeof RecordIrpResponseRequestSchema>;

// --- Tax invoice read model --------------------------------------------------

export const TaxInvoiceSchema = Type.Object(
  {
    id: UuidSchema,
    /** Null on a DIRECT invoice — one raised against a private customer
     * rather than a works contract. It descends from no LOA, so it has
     * no Work and no Measurement Book; its taxable value is stated on
     * the invoice instead. */
    workId: Type.Union([UuidSchema, Type.Null()]),
    measurementBookId: Type.Union([UuidSchema, Type.Null()]),
    /** A direct invoice's taxable value, stated rather than measured.
     * Exactly one of this and measurementBookId is ever set. */
    statedTaxableValue: Type.Union([DecimalStringSchema, Type.Null()]),
    /** The billed Measurement Book's number — how a listing says which
     * MB an invoice closes (finalized MBs always carry one). */
    mbNumber: Type.Union([Type.String(), Type.Null()]),
    status: TaxInvoiceStatusSchema,
    /** TI/<fy>/NNN once submitted; null while draft. */
    invoiceNumber: Type.Union([Type.String(), Type.Null()]),
    sequenceNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    /** April-to-March financial year label ('2026-27'), derived from the
     * invoice date at submit and stored so the counter scope and the
     * number agree forever. */
    fyLabel: Type.Union([Type.String(), Type.Null()]),
    invoiceDate: DateOnlySchema,
    sacCode: SacCodeSchema,
    serviceDescription: Type.String(),
    gstRate: DecimalStringSchema,
    placeOfSupply: GstStateCodeSchema,
    /** Explicit submit-time GST liability fact; null only on an unconfirmed
     * draft or a historical issued invoice that predates capture. */
    reverseChargeApplicable: Type.Union([Type.Boolean(), Type.Null()]),
    /** The buyer contact the draft names (snapshotted at submit). */
    buyerContactId: UuidSchema,
    /** Submit-written, frozen; all null while draft. */
    taxableValue: Type.Union([DecimalStringSchema, Type.Null()]),
    cgstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    sgstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    igstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    /** What was added to (or taken off) the sum of the taxable value and
     * its taxes to reach a whole-rupee payable total. Prints as the
     * Rounding line, and the document omits that line when it is zero. */
    roundOff: Type.Union([RoundOffStringSchema, Type.Null()]),
    /** The PAYABLE total: whole rupees, after roundOff. The unrounded
     * sum is exactly totalAmount - roundOff. */
    totalAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    customerPoReference: Type.Union([Type.String(), Type.Null()]),
    unitLabel: Type.Union([Type.String(), Type.Null()]),
    notes: Type.Union([Type.String(), Type.Null()]),
    shipToContactId: Type.Union([UuidSchema, Type.Null()]),
    /** Prefix + the financial year's opening year + the serial: the
     * number is composed, so the prefix is kept as a fact of its own. */
    numberPrefix: Type.Union([Type.String(), Type.Null()]),
    /** What the IRP handed back through the GSP; null until recorded. */
    irn: Type.Union([IrnSchema, Type.Null()]),
    irpProvider: Type.Union([
      Type.Literal('manual'),
      Type.Literal('whitebooks'),
      Type.Null(),
    ]),
    irpProviderState: IrpProviderStateSchema,
    ackNumber: Type.Union([Type.String(), Type.Null()]),
    ackDate: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    /** The acknowledgement's wall clock exactly as the portal wrote it
     * ('2026-07-30 12:09:00'). ackDate above is the same moment as an
     * instant, for querying; this is what prints. */
    ackDateText: Type.Union([Type.String(), Type.Null()]),
    signedInvoiceAvailable: Type.Boolean(),
    /** True once the immutable invoice has been converted to a stored PDF. */
    renderedAvailable: Type.Boolean(),
    irpLegacyEvidenceMissing: Type.Boolean(),
    irpCancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    irpCancelledAtText: Type.Union([Type.String(), Type.Null()]),
    irpCancelReasonCode: Type.Union([Type.String(), Type.Null()]),
    irpCancelRemark: Type.Union([Type.String(), Type.Null()]),
    cancellationNote: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    submittedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type TaxInvoice = Static<typeof TaxInvoiceSchema>;

export const TaxInvoiceDetailResponseSchema = Type.Object(
  {
    invoice: TaxInvoiceSchema,
    /** The immutable submit-time buyer snapshot, verbatim; null while
     * draft. */
    buyerSnapshot: Type.Unknown(),
    /** The ship-to as invoiced, when one was named; null otherwise. */
    shipToSnapshot: Type.Unknown(),
    /** The whole document as issued — supplier masthead, both parties,
     * the line, the totals and the words. A re-render reproduces this
     * rather than recomputing from live tables, so correcting the
     * company address never rewrites an invoice already registered. */
    issuedSnapshot: Type.Unknown(),
    /** The IRP's signed QR payload; null until the irp-response lands. */
    signedQr: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type TaxInvoiceDetailResponse = Static<typeof TaxInvoiceDetailResponseSchema>;

export const TaxInvoiceListResponseSchema = Type.Object(
  { invoices: Type.Array(TaxInvoiceSchema) },
  { additionalProperties: false },
);
export type TaxInvoiceListResponse = Static<typeof TaxInvoiceListResponseSchema>;

// --- E-way bill requests -----------------------------------------------------

export const EWAY_BILL_STATUSES = ['draft', 'generated', 'cancelled'] as const;
export const EwayBillStatusSchema = Type.Union(
  EWAY_BILL_STATUSES.map((status) => Type.Literal(status)),
);
export type EwayBillStatus = Static<typeof EwayBillStatusSchema>;

export const EWAY_PROVIDER_STATES = [
  'not_requested',
  'generating',
  'generated',
  'generation_failed',
  'generation_unknown',
  'cancelling',
  'cancelled',
  'cancellation_unknown',
] as const;
export const EwayProviderStateSchema = Type.Union(
  EWAY_PROVIDER_STATES.map((state) => Type.Literal(state)),
);
export type EwayProviderState = Static<typeof EwayProviderStateSchema>;

export const TRANSPORT_MODES = ['road', 'rail', 'air', 'ship'] as const;
export const TransportModeSchema = Type.Union(
  TRANSPORT_MODES.map((mode) => Type.Literal(mode)),
);
export type TransportMode = Static<typeof TransportModeSchema>;

const PincodeSchema = Type.String({
  pattern: '^[0-9]{6}$',
  description: 'Six-digit Indian postal PIN code.',
});

/** POST /api/tax-invoices/:id/eway-bills and PUT /api/eway-bills/:id —
 * the same body serves create and draft edit. A road movement will need
 * a vehicle number and the other modes a transport document by the time
 * NIC answers (the 0035 CHECK), but a draft may still be filling in. */
export const SaveEwayBillRequestSchema = Type.Object(
  {
    transportMode: TransportModeSchema,
    /** The GSTIN-shaped transporter enrolment id; the supplier's own
     * vehicle needs none. */
    transporterId: Type.Optional(
      Type.String({
        pattern: '^[0-9]{2}[0-9A-Z]{13}$',
        description: 'Fifteen-character transporter enrolment id.',
      }),
    ),
    transporterName: Type.Optional(nonBlankString({ minLength: 2, maxLength: 200 })),
    vehicleNumber: Type.Optional(
      Type.String({
        pattern: '^[A-Z0-9]{6,12}$',
        description: 'Vehicle registration, uppercase letters and digits.',
      }),
    ),
    /** The column measures TRIMMED length 1..30; the floor of one cannot
     * use nonBlankString (which starts at two), so the pattern demands at
     * least one non-space character itself. */
    transportDocNumber: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 30,
        pattern: '^[\\s\\S]*[^ ][\\s\\S]*$',
        description: 'Transport document number (RR/airway bill/bill of lading).',
      }),
    ),
    transportDocDate: Type.Optional(DateOnlySchema),
    distanceKm: Type.Integer({ minimum: 0, maximum: 4000 }),
    fromPincode: PincodeSchema,
    toPincode: PincodeSchema,
  },
  { additionalProperties: false },
);
export type SaveEwayBillRequest = Static<typeof SaveEwayBillRequestSchema>;

/** POST /api/eway-bills/:id/nic-response — what NIC handed back through
 * the GSP: the 12-digit EWB number and its validity window. */
export const RecordEwayNicResponseRequestSchema = Type.Object(
  {
    ewbNumber: Type.String({
      pattern: '^[0-9]{12}$',
      description: 'Twelve-digit e-way bill number.',
    }),
    ewbDate: Type.String({ format: 'date-time' }),
    validUntil: Type.String({ format: 'date-time' }),
    ewbDateText: ProviderTimestampTextSchema,
    validUntilText: ProviderTimestampTextSchema,
  },
  { additionalProperties: false },
);
export type RecordEwayNicResponseRequest = Static<
  typeof RecordEwayNicResponseRequestSchema
>;

export const CancelEwayBillRequestSchema = Type.Object(
  { note: nonBlankString({ minLength: 3, maxLength: 2000 }) },
  { additionalProperties: false },
);
export type CancelEwayBillRequest = Static<typeof CancelEwayBillRequestSchema>;

// --- E-way bill read model ---------------------------------------------------

export const EwayBillSchema = Type.Object(
  {
    id: UuidSchema,
    taxInvoiceId: UuidSchema,
    /** The moved invoice's number — an e-way bill only ever exists for a
     * submitted (numbered) invoice. */
    invoiceNumber: Type.Union([Type.String(), Type.Null()]),
    status: EwayBillStatusSchema,
    transportMode: TransportModeSchema,
    transporterId: Type.Union([Type.String(), Type.Null()]),
    transporterName: Type.Union([Type.String(), Type.Null()]),
    vehicleNumber: Type.Union([Type.String(), Type.Null()]),
    transportDocNumber: Type.Union([Type.String(), Type.Null()]),
    transportDocDate: Type.Union([DateOnlySchema, Type.Null()]),
    distanceKm: Type.Integer({ minimum: 0 }),
    fromPincode: PincodeSchema,
    toPincode: PincodeSchema,
    /** From NIC through the GSP; null until generated. */
    ewbNumber: Type.Union([Type.String(), Type.Null()]),
    provider: Type.Union([
      Type.Literal('manual'),
      Type.Literal('whitebooks'),
      Type.Null(),
    ]),
    providerState: EwayProviderStateSchema,
    ewbDate: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    validUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    ewbDateText: Type.Union([Type.String(), Type.Null()]),
    validUntilText: Type.Union([Type.String(), Type.Null()]),
    legacyEvidenceMissing: Type.Boolean(),
    providerCancelledAt: Type.Union([
      Type.String({ format: 'date-time' }),
      Type.Null(),
    ]),
    providerCancelledAtText: Type.Union([Type.String(), Type.Null()]),
    providerCancelReasonCode: Type.Union([Type.String(), Type.Null()]),
    providerCancelRemark: Type.Union([Type.String(), Type.Null()]),
    cancellationNote: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    generatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type EwayBill = Static<typeof EwayBillSchema>;

export const EwayBillDetailResponseSchema = Type.Object(
  { ewayBill: EwayBillSchema },
  { additionalProperties: false },
);
export type EwayBillDetailResponse = Static<typeof EwayBillDetailResponseSchema>;

export const EwayBillListResponseSchema = Type.Object(
  { ewayBills: Type.Array(EwayBillSchema) },
  { additionalProperties: false },
);
export type EwayBillListResponse = Static<typeof EwayBillListResponseSchema>;
