import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
  RoundOffStringSchema,
  DecimalStringSchema,
  GstRateSchema,
  GstStateCodeSchema,
  HsnCodeSchema,
  TaxInvoiceLineShapeSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';
import { InvoiceNumberPrefixSchema } from './organisations.js';
import { NextCursorSchema, withKeysetQuery, withRegisterSort } from './pagination.js';

/**
 * The two GST tax documents (migration 0035): the TAX INVOICE and the
 * E-WAY BILL that moves it.
 *
 * The invoice's LINE SHAPE is a PER-DOCUMENT choice (migration 0057),
 * with an organisation default that only seeds the create form:
 *
 * - `service_cumulative` — the original 0035 model, and still the common
 *   railway works-contract bill: ONE service line at a SAC (six digits)
 *   for a finalized Measurement Book's total, carried by the header
 *   `sacCode` / `serviceDescription` / `gstRate` fields;
 * - `itemised` — those three header fields are absent and the document is
 *   its `lines`, each with its own HSN (goods) or SAC (services) code,
 *   quantity, unit rate and GST rate.
 *
 * The choice is NEVER derived from the buyer or the Work: the owner's
 * account is that practice varies by company — some vendors put HSN goods
 * items on Railway invoices too, and private customers commonly take HSN
 * goods supply — so a Railway invoice may be itemised and a private one
 * cumulative.
 *
 * Either shape: draft -> submitted (numbered gapless per organisation PER
 * FINANCIAL YEAR, buyer snapshotted, amounts frozen in exact SQL numeric
 * arithmetic — from the MB total for a cumulative invoice, from the sum of
 * the lines for an itemised one) -> cancelled. Submitting the invoice is
 * what closes the MB it bills; cancelling it releases the MB for a
 * corrected invoice.
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

/** superseded (migration 0051): an issued credit note replaced the
 * invoice in full. Terminal like cancelled — it releases the invoice's
 * Measurement Book — except that cancelling the credit note reverts the
 * invoice to submitted while its MB has not been re-invoiced. */
const TAX_INVOICE_STATUSES = ['draft', 'submitted', 'cancelled', 'superseded'] as const;
const TaxInvoiceStatusSchema = Type.Union(
  TAX_INVOICE_STATUSES.map((status) => Type.Literal(status)),
);
export type TaxInvoiceStatus = Static<typeof TaxInvoiceStatusSchema>;

/** SAC (services) code: exactly six digits — services take no 8-digit
 * deepening, and the cumulative invoice line is always a service. The
 * 9954xx family is works contracts, but the schema does not hard-code
 * that judgement (the 0035 column holds the same six-digit CHECK). */
const SacCodeSchema = Type.String({
  pattern: '^[0-9]{6}$',
  description: 'SAC (services accounting) code: exactly six digits.',
});

/** The IRN as the IRP mints it: 64 lowercase hex characters. */
export const IrnSchema = Type.String({
  pattern: '^[0-9a-f]{64}$',
  description: 'Invoice Reference Number: 64 hexadecimal characters.',
});
export type Irn = Static<typeof IrnSchema>;

const IRP_PROVIDER_STATES = [
  'not_requested',
  'registering',
  'registered',
  /** A registration recorded through the manual compatibility door
   * (migration 0053): the operator typed what the portal showed, no
   * provider verified it. Behaves as `registered` for local rules — the
   * cancel interlock, the reporting window — but renders distinctly and
   * is excluded from every provider-verified claim. Only
   * `irp_provider = 'manual'` rows may hold it. */
  'registered_unverified',
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

/** A line's unit rate. Non-negative — free-issue and nil-rated lines are
 * real — and bounded to the TWO fraction digits its numeric(18,2) column
 * holds, so a third digit is a named 400 rather than a silent rounding. */
const LineUnitRateSchema = Type.String({
  pattern: '^(?:0|[1-9]\\d{0,14})(?:\\.\\d{1,2})?$',
  description:
    'Non-negative unit rate transported as a string; up to two fraction digits.',
});

// --- Tax invoice lines (migration 0057) --------------------------------------

/** One line of an ITEMISED invoice, as the client states it. The money
 * is NOT stated: taxable value and the tax heads are computed in SQL
 * numeric at submit from quantity x rate at this line's own GST rate. */
const TaxInvoiceLineInputSchema = Type.Object(
  {
    /** Whether this line supplies a SERVICE or GOODS. Stated, never
     * inferred from the code: it becomes IsServc on the IRP wire and, in
     * a later stage, decides whether the document moves goods at all. */
    isService: Type.Boolean(),
    /** Six digits for a SAC (a service code takes no deepening), six to
     * eight for a goods HSN. The pairing with `isService` is enforced by
     * the server and by the 0057 CHECK. */
    hsnSacCode: HsnCodeSchema,
    description: nonBlankString({ minLength: 3, maxLength: 1000 }),
    quantity: PositiveDecimalStringSchema,
    /** The unit word beside the quantity ('m', 'set', 'no'). The column
     * measures TRIMMED length 1..20, and a floor of one cannot use
     * nonBlankString — it starts at two — so the pattern demands at least
     * one non-space character itself. */
    unitLabel: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 20,
        pattern: '^[\\s\\S]*[^ ][\\s\\S]*$',
      }),
    ),
    unitRate: LineUnitRateSchema,
    gstRate: GstRateSchema,
  },
  { additionalProperties: false },
);
export type TaxInvoiceLineInput = Static<typeof TaxInvoiceLineInputSchema>;

/** One line as stored. The four money fields are null while the invoice
 * is a draft and frozen together at submit (migration 0057). */
const TaxInvoiceLineSchema = Type.Object(
  {
    id: UuidSchema,
    position: Type.Integer({ minimum: 1 }),
    isService: Type.Boolean(),
    hsnSacCode: HsnCodeSchema,
    description: Type.String(),
    quantity: DecimalStringSchema,
    unitLabel: Type.Union([Type.String(), Type.Null()]),
    unitRate: DecimalStringSchema,
    gstRate: DecimalStringSchema,
    taxableValue: Type.Union([DecimalStringSchema, Type.Null()]),
    cgstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    sgstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    igstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type TaxInvoiceLine = Static<typeof TaxInvoiceLineSchema>;

/** At most 200 lines on one invoice — far past any real bill, and a
 * bound so a single request cannot mint unbounded rows. */
const TaxInvoiceLinesSchema = Type.Array(TaxInvoiceLineInputSchema, {
  minItems: 1,
  maxItems: 200,
});

// --- Tax invoice requests ----------------------------------------------------

/** The fields every tax-invoice draft carries whatever its line shape.
 * Spread into each variant rather than composed, so `additionalProperties:
 * false` stays exact on the object ajv actually validates. */
const invoiceCommonFields = {
  invoiceDate: DateOnlySchema,
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
  customerPoReference: Type.Optional(nonBlankString({ minLength: 3, maxLength: 500 })),
  /** The unit word beside the quantity ('set') on a CUMULATIVE invoice's
   * single line; an itemised invoice's units are per line. The column
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
};

/** The CUMULATIVE shape's own fields: the single service line, carried in
 * the header. `lineShape` is optional here and defaults to
 * 'service_cumulative' on the wire, so every client written before
 * migration 0057 keeps working unchanged; the ORGANISATION default seeds
 * the create FORM, never the API. */
const cumulativeLineFields = {
  lineShape: Type.Optional(Type.Literal('service_cumulative')),
  sacCode: SacCodeSchema,
  serviceDescription: nonBlankString({ minLength: 3, maxLength: 1000 }),
  gstRate: GstRateSchema,
};

/** The ITEMISED shape's own fields: no header line at all, and at least
 * one line of its own. */
const itemisedLineFields = {
  lineShape: Type.Literal('itemised'),
  lines: TaxInvoiceLinesSchema,
};

/** POST /api/works/:id/tax-invoices — drafts the invoice against a
 * finalized on-account or final Measurement Book of the Work. The buyer
 * is a contact; its details are snapshotted at SUBMIT (not now), so a
 * master edit before submit is reflected and one after is not.
 *
 * An MB-backed ITEMISED invoice still bills the Measurement Book: its
 * lines must sum to the MB total, which the submit route proves before it
 * freezes any money. */
export const CreateTaxInvoiceRequestSchema = Type.Union([
  Type.Object(
    {
      measurementBookId: UuidSchema,
      ...invoiceCommonFields,
      ...cumulativeLineFields,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      measurementBookId: UuidSchema,
      ...invoiceCommonFields,
      ...itemisedLineFields,
    },
    { additionalProperties: false },
  ),
]);
export type CreateTaxInvoiceRequest = Static<typeof CreateTaxInvoiceRequestSchema>;

/** POST /api/tax-invoices — a DIRECT invoice, raised against a private
 * customer rather than a works contract. It descends from no LOA, so it
 * names no Work and no Measurement Book, and states its own taxable
 * value; everything else — the SAC, the buyer, the GST split, the
 * number, the IRN — behaves exactly as on an MB-backed invoice.
 *
 * The ITEMISED variant states NO taxable value: the lines already say
 * what the supply is worth, and asking for the same figure twice would
 * invite the two to disagree. The server derives it from them. */
export const CreateDirectTaxInvoiceRequestSchema = Type.Union([
  Type.Object(
    {
      ...invoiceCommonFields,
      ...cumulativeLineFields,
      /** What the supply is worth before tax. Stated, because there is no
       * Measurement Book to measure it. */
      taxableValue: NonNegativeDecimalStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...invoiceCommonFields,
      ...itemisedLineFields,
    },
    { additionalProperties: false },
  ),
]);
export type CreateDirectTaxInvoiceRequest = Static<
  typeof CreateDirectTaxInvoiceRequestSchema
>;

/** PUT /api/tax-invoices/:id — edits the draft's fields. The Measurement
 * Book is the invoice's SUBJECT, not a field: re-pointing an invoice at
 * another MB is delete-and-redraft, so the 0035 finalized-MB insert
 * guard is never sidestepped by an update.
 *
 * The line shape IS editable while the invoice is a draft — switching it
 * replaces the header line with lines or the reverse, and nothing legal
 * has been minted yet. Once submitted it is frozen with every other
 * business fact (the 0057 issued-update guard). */
export const UpdateTaxInvoiceRequestSchema = Type.Union([
  Type.Object(
    { ...invoiceCommonFields, ...cumulativeLineFields },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...invoiceCommonFields, ...itemisedLineFields },
    { additionalProperties: false },
  ),
]);
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

const TaxInvoiceSchema = Type.Object(
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
    /** Which shape this document is (migration 0057). A per-document
     * fact, frozen with every other business fact once submitted. */
    lineShape: TaxInvoiceLineShapeSchema,
    /** The cumulative service line, carried in the header. All three are
     * null on an ITEMISED invoice, whose document is its `lines`. */
    sacCode: Type.Union([SacCodeSchema, Type.Null()]),
    serviceDescription: Type.Union([Type.String(), Type.Null()]),
    gstRate: Type.Union([DecimalStringSchema, Type.Null()]),
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
    /** The last date this invoice could lawfully be reported to the IRP,
     * frozen at submit from the organisation's e-invoicing declaration
     * then in force (migration 0049). NULL when no window applied — the
     * organisation had no declared window, or the invoice predates its
     * applicable-from date or this column. */
    irpReportingDeadline: Type.Union([DateOnlySchema, Type.Null()]),
    /** Derived, never stored: the frozen deadline has passed (in the
     * organisation's own timezone) and the invoice is still not
     * registered at the IRP. Local validity is untouched — this is a
     * signal, not a state. */
    irpReportingOverdue: Type.Boolean(),
    /** When NIC's 24-hour IRN cancellation window closes: ack_date + 24
     * hours, derived in SQL. Null until the invoice is registered, and
     * null for legacy manual evidence whose ack instant is unprovable —
     * such rows are treated as window-CLOSED, never unknown-open. */
    irpCancelWindowClosesAt: Type.Union([
      Type.String({ format: 'date-time' }),
      Type.Null(),
    ]),
    /** Derived, never stored: the IRN is provider-registered, its ack
     * instant is provable, and the 24-hour window has not yet closed.
     * Past it the lawful remedy is a credit note. */
    irpCancelWindowOpen: Type.Boolean(),
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
    /** The lines of an ITEMISED invoice, in position order. Always empty
     * for a cumulative one, whose single line lives in the header. */
    lines: Type.Array(TaxInvoiceLineSchema),
  },
  { additionalProperties: false },
);
export type TaxInvoiceDetailResponse = Static<typeof TaxInvoiceDetailResponseSchema>;

export const TaxInvoiceListResponseSchema = Type.Object(
  { invoices: Type.Array(TaxInvoiceSchema) },
  { additionalProperties: false },
);
export type TaxInvoiceListResponse = Static<typeof TaxInvoiceListResponseSchema>;

/** One row of the organisation-wide tax-invoice register.
 *
 * Deliberately NOT the full `TaxInvoice`: the register answers "what have
 * we billed, to whom, and where does it stand" — so it carries the buyer's
 * name, the money as three figures, the local status and the statutory one,
 * and where the invoice came from. Everything else about a document is read
 * on the document.
 *
 * `workId`, `workCode` and `workTitle` are all null together on a DIRECT
 * invoice — one raised against a private customer, which descends from no
 * LOA and so belongs to no Work. That triple is what a row renders as its
 * source: a link to the Work, or the word Direct.
 *
 * `gstAmount` is the sum of the three tax heads, added in SQL numeric and
 * returned as a decimal string like every other amount (engineering rule 5).
 * It is null while the invoice is a draft, exactly as the frozen taxable
 * value and total are: no money exists on an invoice until submit writes
 * it. */
const TaxInvoiceRegisterEntrySchema = Type.Object(
  {
    id: UuidSchema,
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String(), Type.Null()]),
    workTitle: Type.Union([Type.String(), Type.Null()]),
    /** TI/<fy>/NNN once submitted; null while draft. */
    invoiceNumber: Type.Union([Type.String(), Type.Null()]),
    invoiceDate: DateOnlySchema,
    status: TaxInvoiceStatusSchema,
    /** The buyer as the DOCUMENT states it: the invoice's frozen submit-time
     * snapshot designation, so a register line matches the printed and filed
     * invoice even after the contact master is edited. A draft has no
     * snapshot yet and falls back to the live contact's designation. */
    buyerName: Type.String(),
    taxableValue: Type.Union([DecimalStringSchema, Type.Null()]),
    /** CGST + SGST + IGST. Which heads carry it is a property of the
     * document, not of a register column. */
    gstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    irn: Type.Union([IrnSchema, Type.Null()]),
    irpProvider: Type.Union([
      Type.Literal('manual'),
      Type.Literal('whitebooks'),
      Type.Null(),
    ]),
    irpProviderState: IrpProviderStateSchema,
    irpReportingDeadline: Type.Union([DateOnlySchema, Type.Null()]),
    irpReportingOverdue: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type TaxInvoiceRegisterEntry = Static<typeof TaxInvoiceRegisterEntrySchema>;

/** The register's query: a date window over `invoiceDate`, plus the two
 * keyset parameters.
 *
 * The window is the only filter, for the reason the installation register
 * gives: a global register carries the filter its question needs and no
 * more. "What did we bill this quarter" is a date range. A Work filter
 * would duplicate the Work's own Bills tab, and a status filter would offer
 * to hide the drafts and the cancellations the register exists to keep
 * visible. Both bounds are inclusive; either may be sent alone. */
export const TaxInvoiceRegisterQuerySchema = withRegisterSort(
  withKeysetQuery(
    Type.Object(
      {
        invoicedFrom: Type.Optional(DateOnlySchema),
        invoicedTo: Type.Optional(DateOnlySchema),
      },
      { additionalProperties: false },
    ),
  ),
);

/** Every tax invoice in the organisation the caller may see, newest first
 * — work-backed and direct alike. Cancelled and superseded invoices stay
 * listed with their status: a numbered document that was cancelled is a
 * fact the register must keep reporting. `nextCursor` pages the list; see
 * `pagination.ts`. */
export const TaxInvoiceRegisterResponseSchema = Type.Object(
  {
    invoices: Type.Array(TaxInvoiceRegisterEntrySchema),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type TaxInvoiceRegisterResponse = Static<
  typeof TaxInvoiceRegisterResponseSchema
>;

// --- E-way bill requests -----------------------------------------------------

const EWAY_BILL_STATUSES = ['draft', 'generated', 'cancelled'] as const;
const EwayBillStatusSchema = Type.Union(
  EWAY_BILL_STATUSES.map((status) => Type.Literal(status)),
);
export type EwayBillStatus = Static<typeof EwayBillStatusSchema>;

const EWAY_PROVIDER_STATES = [
  'not_requested',
  'generating',
  'generated',
  'generation_failed',
  'generation_unknown',
  'cancelling',
  'cancelled',
  'cancellation_unknown',
] as const;
const EwayProviderStateSchema = Type.Union(
  EWAY_PROVIDER_STATES.map((state) => Type.Literal(state)),
);
export type EwayProviderState = Static<typeof EwayProviderStateSchema>;

const TRANSPORT_MODES = ['road', 'rail', 'air', 'ship'] as const;
const TransportModeSchema = Type.Union(
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

/** Which document the consignment travels under. Exactly one of the two
 * source ids is set on every bill (ADR-0013, migration 0076). */
const EwayBillSourceSchema = Type.Union([
  Type.Literal('tax_invoice'),
  Type.Literal('delivery_challan'),
]);

const EwayBillSchema = Type.Object(
  {
    id: UuidSchema,
    /** Null when the source is a delivery challan. */
    taxInvoiceId: Type.Union([UuidSchema, Type.Null()]),
    /** Null when the source is a tax invoice. */
    deliveryChallanId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    /** Which of the two the bill names. Optional in the schema so
     * responses built before the second source existed stay valid — the
     * server always serves it. */
    source: Type.Optional(EwayBillSourceSchema),
    /** The moved invoice's number — an e-way bill only ever exists for a
     * submitted (numbered) invoice. Null on the challan path. */
    invoiceNumber: Type.Union([Type.String(), Type.Null()]),
    /** The moved challan's number, on the challan path. */
    challanNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
    /** Whether a printable summary has been rendered, and which version
     * the bill currently points at. The PDF is a convenience print — the
     * NIC portal document remains the statutory original — and it exists
     * only once NIC has answered. Optional in the schema so responses
     * built before the render existed stay valid. */
    renderedAvailable: Type.Optional(Type.Boolean()),
    renderedVersion: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    ),
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
