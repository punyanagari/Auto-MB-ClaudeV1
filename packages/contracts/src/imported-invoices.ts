import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
import {
  DateOnlySchema,
  RateStringSchema,
  SignedMoneyStringSchema,
  StorableDecimalStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';

// --- The historical Zoho Books invoice register (migration 0115) --------
//
// 638 invoices raised between January 2023 and today, in a system this
// application is replacing. They are read-only history: nothing bills,
// measures or settles against them, and the register exists so "what have
// we billed this customer" and "what has been billed on this Work" stop
// being questions answered from a CSV on somebody's laptop.
//
// THREE THINGS THE WIRE MODEL SAYS OUT LOUD, because the export does not:
//
//   * `issued` is derived from IRN presence, not from the export's own
//     status column, which reads `Draft` on 372 of the 638. The raw status
//     travels beside it as `zohoStatus` so an operator can see the
//     disagreement rather than being asked to trust its resolution.
//   * `balance` is EVIDENCE, never a receivable. The receipts against
//     these invoices are in Tally, which this register does not read.
//   * money and quantities are decimal STRINGS, exactly as everywhere else
//     in this API: these figures were computed by another system and are
//     stored, never recomputed, so a float would be a silent rewrite.
//
// THE MOCK DRAWS NO HISTORICAL-INVOICES SCREEN. Application-first under
// AGENTS.md § Design contract 2 and 4, built in the mock's existing
// grammar — its page header, its data table, its status chip, its confirm
// dialog. `docs/UX.md` § 34 records the stance and the reasoning rather
// than inventing a mock citation for a screen that does not exist.

/* --- Vocabulary ------------------------------------------------------------ */

/** How an invoice's Work link was arrived at. `pl_code` and `loa_match`
 * name what the importer PROPOSED and a person accepted; `manual` is a
 * person's own choice with no proposal behind it. All three are decisions
 * — the difference is what was on screen when the decision was made. */
export const ImportedInvoiceLinkMethodSchema = Type.Union([
  Type.Literal('pl_code'),
  Type.Literal('loa_match'),
  Type.Literal('manual'),
]);
export type ImportedInvoiceLinkMethod = Static<typeof ImportedInvoiceLinkMethodSchema>;

/** How the customer was matched to the contacts master: by GSTIN, which is
 * the identifier the tax system itself uses, or by an exact name. */
export const ImportedInvoiceContactMatchSchema = Type.Union([
  Type.Literal('gstin'),
  Type.Literal('name'),
]);

/** What the upload is being asked to do. `preview` parses, proposes and
 * answers; it writes nothing. `commit` does the same reading and then
 * inserts. The two are separate calls against the same bytes because an
 * import is a conversation about which invoices could not be linked, and
 * a pipeline that writes as it reads cannot have it. */
export const ImportedInvoiceImportModeSchema = Type.Union([
  Type.Literal('preview'),
  Type.Literal('commit'),
]);
export type ImportedInvoiceImportMode = Static<typeof ImportedInvoiceImportModeSchema>;

/* --- The register row ------------------------------------------------------ */

export const ImportedInvoiceLineSchema = Type.Object(
  {
    id: UuidSchema,
    position: Type.Integer({ minimum: 1 }),
    itemName: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
    itemDescription: Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
    /** Null where the line carried no quantity — a lump-sum charge, which
     * the export produces legitimately. */
    quantity: Type.Union([StorableDecimalStringSchema, Type.Null()]),
    usageUnit: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
    /** A unit RATE, not a money amount: the real export carries three
     * fraction digits here, so it travels at rate scale (six) and is
     * stored as numeric(18,6). `itemTotal` beside it IS money. */
    itemPrice: Type.Union([RateStringSchema, Type.Null()]),
    itemTotal: Type.Union([SignedMoneyStringSchema, Type.Null()]),
    /** Mixes a service code and goods HSNs, because the organisation bills
     * both. Text: nothing infers a supply kind from it. */
    hsnSac: Type.Union([Type.String({ maxLength: 20 }), Type.Null()]),
    supplyType: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
    cgstRate: Type.Union([Type.String({ maxLength: 8 }), Type.Null()]),
    sgstRate: Type.Union([Type.String({ maxLength: 8 }), Type.Null()]),
    igstRate: Type.Union([Type.String({ maxLength: 8 }), Type.Null()]),
    cgstAmount: Type.Union([SignedMoneyStringSchema, Type.Null()]),
    sgstAmount: Type.Union([SignedMoneyStringSchema, Type.Null()]),
    igstAmount: Type.Union([SignedMoneyStringSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ImportedInvoiceLine = Static<typeof ImportedInvoiceLineSchema>;

export const ImportedInvoiceSchema = Type.Object(
  {
    id: UuidSchema,
    /** Zoho's own identifier, and the register's idempotency key. */
    zohoInvoiceId: Type.String({ minLength: 1, maxLength: 60 }),
    invoiceNumber: Type.String({ minLength: 1, maxLength: 60 }),
    invoiceDate: DateOnlySchema,
    customerName: Type.String({ minLength: 1, maxLength: 300 }),
    customerGstin: Type.Union([Type.String({ maxLength: 20 }), Type.Null()]),
    placeOfSupply: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
    /** The contacts master row this customer was matched to, or null when
     * no unambiguous match existed. The invoice is complete either way —
     * the customer's name and GSTIN are on the row itself. */
    contactId: Type.Union([UuidSchema, Type.Null()]),
    contactName: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    contactMatchMethod: Type.Union([ImportedInvoiceContactMatchSchema, Type.Null()]),
    /** The export's own status column, verbatim. NOT the issued signal. */
    zohoStatus: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
    /** Derived from IRN presence. See the module header. */
    issued: Type.Boolean(),
    irn: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]),
    ackNumber: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
    ackDate: Type.Union([DateOnlySchema, Type.Null()]),
    /** The `PurchaseOrder` column: free text carrying the LOA or PO
     * reference the Work proposal reads. */
    referenceText: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
    subTotal: SignedMoneyStringSchema,
    total: SignedMoneyStringSchema,
    /** EVIDENCE ONLY — what Zoho believed was outstanding, from a system
     * that never saw the payments. */
    balance: Type.Union([SignedMoneyStringSchema, Type.Null()]),
    roundOff: Type.Union([SignedMoneyStringSchema, Type.Null()]),
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String({ maxLength: 20 }), Type.Null()]),
    linkMethod: Type.Union([ImportedInvoiceLinkMethodSchema, Type.Null()]),
    lineCount: Type.Integer({ minimum: 0 }),
    discardedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    discardReason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    importedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type ImportedInvoice = Static<typeof ImportedInvoiceSchema>;

/* --- Reading the register --------------------------------------------------- */

/** `work` is the deep link the Work detail screen uses; `linked` filters
 * the two halves of the propose-and-prove outcome; `customer` matches the
 * name on the invoice rather than the contact, because 83 distinct
 * customers appear in the real export and not all are in the master. */
export const ImportedInvoiceQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    cursor: Type.Optional(UuidSchema),
    work: Type.Optional(UuidSchema),
    customer: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    linked: Type.Optional(
      Type.Union([Type.Literal('linked'), Type.Literal('unlinked')]),
    ),
    /** An Indian financial year by its opening calendar year: `2023` is
     * 1 April 2023 to 31 March 2024. */
    financialYear: Type.Optional(Type.Integer({ minimum: 2000, maximum: 2100 })),
    includeDiscarded: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ImportedInvoiceQuery = Static<typeof ImportedInvoiceQuerySchema>;

export const ImportedInvoiceListSchema = Type.Object(
  {
    invoices: Type.Array(ImportedInvoiceSchema),
    nextCursor: NextCursorSchema,
    /** Counted over the WHOLE filtered register rather than the page, so
     * the screen's header does not change as an operator scrolls. */
    totals: Type.Object(
      {
        invoiceCount: Type.Integer({ minimum: 0 }),
        linkedCount: Type.Integer({ minimum: 0 }),
        totalValue: SignedMoneyStringSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ImportedInvoiceList = Static<typeof ImportedInvoiceListSchema>;

export const ImportedInvoiceDetailSchema = Type.Object(
  {
    invoice: ImportedInvoiceSchema,
    lines: Type.Array(ImportedInvoiceLineSchema),
  },
  { additionalProperties: false },
);
export type ImportedInvoiceDetail = Static<typeof ImportedInvoiceDetailSchema>;

/* --- Importing -------------------------------------------------------------- */

/** The upload's metadata rides the querystring: the body is the CSV bytes,
 * exactly as every other upload route in this application takes them. */
export const ImportedInvoiceUploadQuerySchema = Type.Object(
  {
    /** Plain `Type.String`, not `nonBlankString`, for `imports.ts`'s
     * reason: a one-character filename is admissible and the route's
     * `requireTrimmed` is the blank guard. */
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    mode: ImportedInvoiceImportModeSchema,
  },
  { additionalProperties: false },
);
export type ImportedInvoiceUploadQuery = Static<
  typeof ImportedInvoiceUploadQuerySchema
>;

/** One invoice in the file, as the preview describes it. The same shape is
 * returned by a commit, with `imported` saying what became of it — so an
 * operator reads the outcome against the list they approved rather than
 * against a total. */
export const ImportedInvoiceProposalSchema = Type.Object(
  {
    zohoInvoiceId: Type.String({ minLength: 1, maxLength: 60 }),
    invoiceNumber: Type.String({ minLength: 1, maxLength: 60 }),
    invoiceDate: DateOnlySchema,
    customerName: Type.String({ minLength: 1, maxLength: 300 }),
    total: SignedMoneyStringSchema,
    /** True when this invoice is already in the register: a re-upload
     * skips it rather than rewriting it, which is what makes the same file
     * safe to upload twice. */
    alreadyImported: Type.Boolean(),
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String({ maxLength: 20 }), Type.Null()]),
    linkMethod: Type.Union([ImportedInvoiceLinkMethodSchema, Type.Null()]),
    /** The text that produced the proposal, so an operator sees WHY a Work
     * is being proposed rather than only that it is. */
    linkEvidence: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
    contactId: Type.Union([UuidSchema, Type.Null()]),
    contactName: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type ImportedInvoiceProposal = Static<typeof ImportedInvoiceProposalSchema>;

export const ImportedInvoiceImportResultSchema = Type.Object(
  {
    mode: ImportedInvoiceImportModeSchema,
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    /** Invoices in the file, and CSV rows behind them. The two differ
     * because one row is one LINE. */
    invoiceCount: Type.Integer({ minimum: 0 }),
    lineCount: Type.Integer({ minimum: 0 }),
    /** Already in the register, and therefore skipped. */
    alreadyImportedCount: Type.Integer({ minimum: 0 }),
    /** Of the invoices that are NOT already imported: how many carry a
     * proposed Work, and how many carry a matched contact. */
    proposedLinkCount: Type.Integer({ minimum: 0 }),
    unlinkedCount: Type.Integer({ minimum: 0 }),
    matchedContactCount: Type.Integer({ minimum: 0 }),
    /** Zero on a preview. On a commit, the rows actually written. */
    importedCount: Type.Integer({ minimum: 0 }),
    /** Every invoice in the file, named — the proposals AND the ones with
     * no proposal, because "which of these did you fail to link" is the
     * question the confirmation step exists to answer. Bounded by the
     * file, which is bounded by the upload cap. */
    invoices: Type.Array(ImportedInvoiceProposalSchema),
    /** Customer names the contacts master had no unambiguous row for.
     * Distinct, so a customer on forty invoices is named once. */
    unmatchedCustomers: Type.Array(Type.String({ maxLength: 300 })),
  },
  { additionalProperties: false },
);
export type ImportedInvoiceImportResult = Static<
  typeof ImportedInvoiceImportResultSchema
>;

/* --- The two annotations ---------------------------------------------------- */

/** Re-pointing an imported invoice's Work or contact link. Both properties
 * are optional and `null` is meaningful: omitting one leaves it alone,
 * sending null clears it. A link set here is always `manual` — the machine
 * proposal happens once, at import. */
export const RelinkImportedInvoiceSchema = Type.Object(
  {
    workId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    contactId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  },
  { additionalProperties: false },
);
export type RelinkImportedInvoice = Static<typeof RelinkImportedInvoiceSchema>;

/** The exit, because there is no DELETE: an invoice imported from the
 * wrong file stays on the record with the reason it was withdrawn. */
export const DiscardImportedInvoiceSchema = Type.Object(
  { reason: nonBlankString({ minLength: 3, maxLength: 500 }) },
  { additionalProperties: false },
);
export type DiscardImportedInvoice = Static<typeof DiscardImportedInvoiceSchema>;
