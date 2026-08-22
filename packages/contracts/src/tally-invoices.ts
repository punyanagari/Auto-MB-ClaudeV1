import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, SignedMoneyStringSchema } from './primitives.js';

// --- The Tally ↔ Zoho invoice cross-reference (migration 0119) ----------
//
// Wave T2 of the Tally migration train. TallyPrime has been this
// organisation's books since April 2020 and Zoho Books held the billing
// from January 2023, so the two overlap for three years and Tally alone
// covers the three before that. This import reads the sales-side vouchers
// and does two things with them, which the owner's rulings keep apart:
//
//   * where Zoho already holds the invoice, it records the correspondence
//     and imports NO register row — Zoho is authoritative and the Tally
//     voucher is provenance (ruling 23);
//   * where Zoho holds nothing, the voucher becomes a historical register
//     row of its own, behind the `tally` source discriminator.
//
// THREE THINGS THE WIRE MODEL SAYS OUT LOUD, because a reader would
// otherwise assume the opposite:
//
//   * A DISPUTED figure is not a failed import. Ruling 21: where the two
//     systems state different values, BOTH are imported and flagged, and
//     the disputed figure joins no sum until the owner rules on the row.
//   * A CANCELLED voucher is skipped and NAMED. Ruling 22: skipped
//     silently would leave an operator unable to tell a cancelled
//     document from one the reader could not read.
//   * CREDIT AND DEBIT NOTES ARE READ AND NOT IMPORTED. They reverse an
//     invoice rather than raising one, and adding them to a register of
//     invoices raised would overstate what was billed. The count is
//     reported so the silence is not mistaken for absence.

/* --- Vocabulary ------------------------------------------------------------ */

/** How a correspondence was found. `origin` means the register row exists
 * BECAUSE the voucher does — the pre-Zoho half — so nothing was matched.
 * `manual` is a person's own choice, which no route in this wave writes;
 * it is named here so that when one does, the row cannot claim an
 * automatic match that never happened. */
export const TallyInvoiceMatchMethodSchema = Type.Union([
  Type.Literal('origin'),
  Type.Literal('exact_number'),
  Type.Literal('serial_tolerant'),
  Type.Literal('manual'),
]);
export type TallyInvoiceMatchMethod = Static<typeof TallyInvoiceMatchMethodSchema>;

/** What the upload is being asked to do. `preview` reads, matches and
 * answers; it writes nothing. `commit` does the identical reading and
 * then inserts. Two calls against the same bytes, for the reason the Zoho
 * importer states: an import is a conversation about what could not be
 * tied together, and a pipeline that writes as it reads cannot have it. */
export const TallyInvoiceImportModeSchema = Type.Union([
  Type.Literal('preview'),
  Type.Literal('commit'),
]);
export type TallyInvoiceImportMode = Static<typeof TallyInvoiceImportModeSchema>;

/* --- Importing -------------------------------------------------------------- */

/** The upload's metadata rides the querystring: the body is the XML
 * bytes, exactly as the masters import next door takes them. */
export const TallyInvoiceUploadQuerySchema = Type.Object(
  {
    /** Plain `Type.String`, not `nonBlankString`, for `imports.ts`'s
     * reason: a one-character filename is admissible and the route's
     * `requireTrimmed` is the blank guard. */
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    mode: TallyInvoiceImportModeSchema,
  },
  { additionalProperties: false },
);
export type TallyInvoiceUploadQuery = Static<typeof TallyInvoiceUploadQuerySchema>;

/** One voucher the export carried, as the preview describes it. */
export const TallyVoucherProposalSchema = Type.Object(
  {
    tallyGuid: Type.String({ minLength: 1, maxLength: 80 }),
    voucherType: Type.Union([
      Type.Literal('Sales'),
      Type.Literal('Credit Note'),
      Type.Literal('Debit Note'),
    ]),
    voucherDate: DateOnlySchema,
    /** Null on the sales vouchers TallyPrime numbers manually and nobody
     * numbered — a third of the real history. */
    voucherNumber: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
    reference: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    /** EMPTY on a cancelled or optional voucher: TallyPrime strips such a
     * voucher of its party and its legs, leaving only the date, the GUID
     * and sometimes a reference. It is reported anyway, because ruling 22
     * says a skipped voucher is named rather than silently absent. */
    partyLedger: Type.String({ maxLength: 300 }),
    amount: SignedMoneyStringSchema,
    /** What this voucher would do. `linked` records a correspondence with
     * an invoice already on the register; `imported` becomes a register
     * row of its own; `already_read` is one a previous import of this
     * export already dealt with; `skipped` is cancelled or optional
     * (ruling 22), or a credit or debit note this wave does not import. */
    outcome: Type.Union([
      Type.Literal('linked'),
      Type.Literal('imported'),
      Type.Literal('already_read'),
      Type.Literal('skipped'),
    ]),
    /** Why it was skipped, where it was. */
    skipReason: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    matchMethod: Type.Union([TallyInvoiceMatchMethodSchema, Type.Null()]),
    /** The normalised document number that tied the two together, so an
     * operator reads WHY rather than only that. */
    matchEvidence: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
    /** The invoice number this voucher corresponds to, where it does. */
    invoiceNumber: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
    /** Ruling 21, decided over the whole connected component: the two
     * systems' figures for the group of documents this voucher belongs
     * to. Null where nothing is disputed. */
    componentTallyTotal: Type.Union([SignedMoneyStringSchema, Type.Null()]),
    componentInvoiceTotal: Type.Union([SignedMoneyStringSchema, Type.Null()]),
    disputed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type TallyVoucherProposal = Static<typeof TallyVoucherProposalSchema>;

/** A voucher the reader could not use, by the line it opened on. */
export const TallyVoucherRefusalSchema = Type.Object(
  {
    lineNumber: Type.Integer({ minimum: 1 }),
    voucherNumber: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type TallyVoucherRefusal = Static<typeof TallyVoucherRefusalSchema>;

export const TallyInvoiceImportResultSchema = Type.Object(
  {
    mode: TallyInvoiceImportModeSchema,
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    /** Every `<VOUCHER>` the file declared, of every type. Reported so an
     * operator can see whether they exported the whole Day Book or the
     * narrowed register the runbook asks for — the difference is 83,061
     * vouchers against 1,185. */
    voucherCount: Type.Integer({ minimum: 0 }),
    /** Of those, the sales-side ones this wave reads. */
    salesCount: Type.Integer({ minimum: 0 }),
    creditNoteCount: Type.Integer({ minimum: 0 }),
    debitNoteCount: Type.Integer({ minimum: 0 }),
    /** RULING 22. Skipped, and named below rather than only counted. */
    cancelledCount: Type.Integer({ minimum: 0 }),
    optionalCount: Type.Integer({ minimum: 0 }),
    /** The voucher numbers of every cancelled or optional voucher, so an
     * operator can tell a document TallyPrime cancelled from one this
     * reader could not read. Bounded by the file. */
    skippedVoucherNumbers: Type.Array(Type.String({ maxLength: 60 })),
    /** Correspondences with invoices already on the register, by how they
     * were found. */
    exactMatchCount: Type.Integer({ minimum: 0 }),
    serialMatchCount: Type.Integer({ minimum: 0 }),
    /** Serial-tolerant candidates the amount/GSTIN/name confirmation
     * turned away. Reported even when zero: a guard that never says it
     * fired reads as a guard nobody wrote. */
    serialCollisionCount: Type.Integer({ minimum: 0 }),
    /** RULING 21: groups of documents whose Tally and Zoho totals differ
     * by more than a rupee, and the links inside them. */
    disputedComponentCount: Type.Integer({ minimum: 0 }),
    disputedLinkCount: Type.Integer({ minimum: 0 }),
    /** Sales vouchers no invoice on the register corresponds to — the
     * pre-Zoho history, which becomes register rows (ruling 23). */
    unmatchedCount: Type.Integer({ minimum: 0 }),
    /** Of those, how many carry a proposed Work through 0115's own
     * propose-and-prove matcher, and how many carry a matched customer. */
    proposedLinkCount: Type.Integer({ minimum: 0 }),
    matchedContactCount: Type.Integer({ minimum: 0 }),
    /** Invoices on the register that no voucher in this file corresponds
     * to. Reported because it is the other half of the reconciliation and
     * ruling 11 says the import proceeds and marks them unmatched. */
    invoicesWithNoVoucherCount: Type.Integer({ minimum: 0 }),
    /** Vouchers a previous import of this export already read: their
     * correspondence, or their register row, is already there. */
    alreadyReadCount: Type.Integer({ minimum: 0 }),
    /** Zero on a preview. On a commit, the rows actually written. */
    importedInvoiceCount: Type.Integer({ minimum: 0 }),
    importedLinkCount: Type.Integer({ minimum: 0 }),
    /** Every sales-side voucher in the file, named. Bounded by the file,
     * which is bounded by the upload cap and by the reader's own ceiling
     * of 50,000 sales-side vouchers. */
    vouchers: Type.Array(TallyVoucherProposalSchema),
    refusals: Type.Array(TallyVoucherRefusalSchema),
  },
  { additionalProperties: false },
);
export type TallyInvoiceImportResult = Static<typeof TallyInvoiceImportResultSchema>;
