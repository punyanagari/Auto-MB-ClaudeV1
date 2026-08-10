import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  DecimalStringSchema,
  GstRateSchema,
  GstStateCodeSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';

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
 * The e-way bill is the invoice's movement document. It is drafted here,
 * carried to NIC by the GSP (Taxilla, most likely), and the 12-digit EWB
 * number and validity window come BACK from NIC — never made up locally.
 * Draft -> generated -> cancelled.
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
    buyerContactId: UuidSchema,
  },
  { additionalProperties: false },
);
export type CreateTaxInvoiceRequest = Static<typeof CreateTaxInvoiceRequestSchema>;

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
    buyerContactId: UuidSchema,
  },
  { additionalProperties: false },
);
export type UpdateTaxInvoiceRequest = Static<typeof UpdateTaxInvoiceRequestSchema>;

/** The cancellation note column measures TRIMMED length 3..2000. */
export const CancelTaxInvoiceRequestSchema = Type.Object(
  { note: nonBlankString({ minLength: 3, maxLength: 2000 }) },
  { additionalProperties: false },
);
export type CancelTaxInvoiceRequest = Static<typeof CancelTaxInvoiceRequestSchema>;

/** POST /api/tax-invoices/:id/irp-response — what the GSP brought back
 * from the IRP. Recorded once, on a submitted invoice, verbatim. */
export const RecordIrpResponseRequestSchema = Type.Object(
  {
    irn: IrnSchema,
    ackNumber: nonBlankString({ minLength: 2, maxLength: 100 }),
    ackDate: Type.String({ format: 'date-time' }),
    signedQr: Type.String({ minLength: 1, maxLength: 65536 }),
  },
  { additionalProperties: false },
);
export type RecordIrpResponseRequest = Static<typeof RecordIrpResponseRequestSchema>;

// --- Tax invoice read model --------------------------------------------------

export const TaxInvoiceSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    measurementBookId: UuidSchema,
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
    /** The buyer contact the draft names (snapshotted at submit). */
    buyerContactId: Type.Union([UuidSchema, Type.Null()]),
    /** Submit-written, frozen; all null while draft. */
    taxableValue: Type.Union([DecimalStringSchema, Type.Null()]),
    cgstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    sgstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    igstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    totalAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    /** What the IRP handed back through the GSP; null until recorded. */
    irn: Type.Union([IrnSchema, Type.Null()]),
    ackNumber: Type.Union([Type.String(), Type.Null()]),
    ackDate: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
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
    ewbDate: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    validUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
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
