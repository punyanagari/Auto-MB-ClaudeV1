import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
import {
  DateOnlySchema,
  NonNegativeMoneyStringSchema,
  PositiveMoneyStringSchema,
  SignedMoneyStringSchema,
  UuidSchema,
} from './primitives.js';
import { TallyVoucherRefusalSchema } from './tally-invoices.js';

// --- Railway receipts as imported payments (migration 0120) -------------
//
// Wave T3 of the Tally migration train. A railway does not pay a bill: it
// pays the bill MINUS what it deducts against it, and says so on one
// voucher — the gross booked to the customer, the net to a bank, and
// every deduction to its own head. 755 real receipts carry exactly that
// shape.
//
// FOUR THINGS THE WIRE MODEL SAYS OUT LOUD, because a reader would
// otherwise assume the opposite:
//
//   * GROSS, NET AND THE HEADS ALL TRAVEL, and `gross = net + Σ heads` is
//     exact on every imported receipt. Money the railway kept is settled
//     money; a register carrying only the bank credit would report every
//     bill as short by its own statutory deductions forever.
//   * A HEAD WITH NO FIGURE IS NOT A ZERO SOMEBODY TYPED. Owner ruling
//     10: the voucher named the head with no AMOUNT element at all, and
//     `amountMissing` is the flag that keeps the two apart.
//   * ROUND-OFF IS NOT A HEAD (ruling 16). It folds into the net and
//     `roundOff` says by how much, signed.
//   * A RECEIPT WITH NO WORK IS NOT A FAILURE (ruling 17). It imports
//     unlinked, into the queue this register's `linked=unlinked` filter
//     reads.

/* --- Vocabulary ------------------------------------------------------------ */

/**
 * Migration 0114's five closed heads, plus ruling 15's single bucket.
 *
 * The five are closed by design — a free-text head makes the receivables
 * arithmetic a sum over whatever anybody typed. About a third of real
 * deduction lines match none of them (bill copy, labour cess,
 * conservation, postage, legal), and ruling 15 books every one of those
 * into `other` WITH ITS TALLY LEDGER NAME, so the arithmetic stays exact
 * and any bucket can be promoted to a first-class head later without a
 * re-import.
 *
 * `retention` is here and is never written (ruling 13): no ledger in the
 * export contains the word. `liquidated_damages` receives the
 * `Contracual Deduction` ledger by the owner's ruling of 23 Aug 2026,
 * which closed question 14 and unblocked this wave.
 */
export const ImportedDeductionHeadSchema = Type.Union([
  Type.Literal('security_deposit'),
  Type.Literal('retention'),
  Type.Literal('liquidated_damages'),
  Type.Literal('income_tax_tds'),
  Type.Literal('gst_tds'),
  Type.Literal('other'),
]);
export type ImportedDeductionHead = Static<typeof ImportedDeductionHeadSchema>;

/** Which of ruling 17's three routes proposed the Work, or a person's own
 * choice. `manual` is written by nothing in this wave; it is named so that
 * when a route to link one by hand lands, the row cannot claim an
 * automatic proposal that never happened. */
export const ImportedPaymentWorkLinkMethodSchema = Type.Union([
  Type.Literal('sd_ledger'),
  Type.Literal('bill_reference'),
  Type.Literal('narration'),
  Type.Literal('manual'),
]);
export type ImportedPaymentWorkLinkMethod = Static<
  typeof ImportedPaymentWorkLinkMethodSchema
>;

/* --- What a receipt is ----------------------------------------------------- */

export const ImportedPaymentDeductionSchema = Type.Object(
  {
    id: UuidSchema,
    head: ImportedDeductionHeadSchema,
    /** The ledger the deduction was booked to in Tally, verbatim. On an
     * `other` line it is the only thing that says what the deduction WAS,
     * which is what makes the bucket honest. */
    tallyLedgerName: Type.String({ minLength: 1, maxLength: 300 }),
    amount: NonNegativeMoneyStringSchema,
    /** Ruling 10: the export named this head and stated no figure. */
    amountMissing: Type.Boolean(),
    /** The v1 work code the ledger name carries, where it carries exactly
     * one. The security-deposit heads are already keyed to it, which is
     * the first route to a Work. */
    plCode: Type.Union([Type.String({ maxLength: 8 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type ImportedPaymentDeduction = Static<typeof ImportedPaymentDeductionSchema>;

/** Which invoice on the historical register this receipt settled, where
 * the voucher's bill allocation named one. */
export const ImportedPaymentInvoiceLinkSchema = Type.Object(
  {
    id: UuidSchema,
    importedInvoiceId: UuidSchema,
    invoiceNumber: Type.String({ maxLength: 60 }),
    tallyBillReference: Type.String({ minLength: 1, maxLength: 200 }),
    /** Null where the allocation stated no figure, which is not zero. */
    amount: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),
    matchMethod: Type.Union([Type.Literal('exact_number'), Type.Literal('manual')]),
  },
  { additionalProperties: false },
);
export type ImportedPaymentInvoiceLink = Static<
  typeof ImportedPaymentInvoiceLinkSchema
>;

export const ImportedPaymentSchema = Type.Object(
  {
    id: UuidSchema,
    tallyGuid: Type.String({ minLength: 1, maxLength: 80 }),
    voucherNumber: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
    voucherDate: DateOnlySchema,
    narration: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
    /** Who paid — the ledger the voucher CREDITED. */
    counterpartyLedger: Type.String({ minLength: 1, maxLength: 300 }),
    contactId: Type.Union([UuidSchema, Type.Null()]),
    contactName: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
    /** The Work this receipt names was WITHDRAWN after it was filed
     * (0071). The row still names it — nothing edits an imported payment
     * — so the register renders the code without a link and counts the
     * receipt as unlinked, which is what ruling 17's queue means. */
    workWithdrawn: Type.Boolean(),
    workLinkMethod: Type.Union([ImportedPaymentWorkLinkMethodSchema, Type.Null()]),
    /** What the railway settled, what reached the bank, and what the
     * difference was. `gross = net + deductionTotal`, always. */
    gross: PositiveMoneyStringSchema,
    net: NonNegativeMoneyStringSchema,
    deductionTotal: NonNegativeMoneyStringSchema,
    /** Ruling 16, signed: folded into the net rather than booked as a
     * head. */
    roundOff: SignedMoneyStringSchema,
    deductions: Type.Array(ImportedPaymentDeductionSchema),
    invoiceLinks: Type.Array(ImportedPaymentInvoiceLinkSchema),
    importedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type ImportedPayment = Static<typeof ImportedPaymentSchema>;

/* --- Reading the register --------------------------------------------------- */

export const ImportedPaymentListQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    work: Type.Optional(UuidSchema),
    /** `unlinked` is ruling 17's manual-link queue: the receipts no route
     * to a Work could be found for. */
    linked: Type.Optional(
      Type.Union([Type.Literal('linked'), Type.Literal('unlinked')]),
    ),
  },
  { additionalProperties: false },
);
export type ImportedPaymentListQuery = Static<typeof ImportedPaymentListQuerySchema>;

export const ImportedPaymentListSchema = Type.Object(
  {
    payments: Type.Array(ImportedPaymentSchema),
    nextCursor: NextCursorSchema,
    /** Counted over the WHOLE filtered register rather than the page, and
     * sent with the FIRST page only — `imported-invoices.ts`'s rule, for
     * its reason: a request carrying a cursor is continuing a walk whose
     * totals the screen already has. */
    totals: Type.Union([
      Type.Object(
        {
          count: Type.Integer({ minimum: 0 }),
          gross: NonNegativeMoneyStringSchema,
          net: NonNegativeMoneyStringSchema,
          deductionTotal: NonNegativeMoneyStringSchema,
          /** The queue's own size (ruling 17). */
          unlinkedCount: Type.Integer({ minimum: 0 }),
          /** What has been deducted under each head, over the whole
           * filtered register. The point of the wave. */
          heads: Type.Array(
            Type.Object(
              {
                head: ImportedDeductionHeadSchema,
                amount: NonNegativeMoneyStringSchema,
                lineCount: Type.Integer({ minimum: 0 }),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type ImportedPaymentList = Static<typeof ImportedPaymentListSchema>;

/* --- Importing -------------------------------------------------------------- */

/** `preview` reads, maps and answers; it writes nothing. `commit` does the
 * identical reading and then inserts. Two calls against the same bytes,
 * for the reason the invoice importers state: an import is a conversation
 * about what could not be tied together, and a pipeline that writes as it
 * reads cannot have it. */
export const TallyReceiptImportModeSchema = Type.Union([
  Type.Literal('preview'),
  Type.Literal('commit'),
]);
export type TallyReceiptImportMode = Static<typeof TallyReceiptImportModeSchema>;

export const TallyReceiptUploadQuerySchema = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    mode: TallyReceiptImportModeSchema,
  },
  { additionalProperties: false },
);
export type TallyReceiptUploadQuery = Static<typeof TallyReceiptUploadQuerySchema>;

/** One receipt the export carried, as the preview describes it. */
export const TallyReceiptProposalSchema = Type.Object(
  {
    tallyGuid: Type.String({ minLength: 1, maxLength: 80 }),
    voucherNumber: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
    voucherDate: DateOnlySchema,
    counterpartyLedger: Type.String({ maxLength: 300 }),
    gross: SignedMoneyStringSchema,
    net: SignedMoneyStringSchema,
    deductionTotal: SignedMoneyStringSchema,
    /**
     * What this receipt would do.
     *
     *   `imported`     it becomes a payment with its heads;
     *   `already_read` a previous import of this export brought it in;
     *   `skipped`      a bank-party receipt or one with no deduction at
     *                  all — wave T4's, counted here rather than silently
     *                  dropped;
     *   `refused`      a shape this wave will not guess at (rulings 19
     *                  and 20, or one that does not reconcile). Named,
     *                  with a reason, so a person can split or correct it
     *                  in TallyPrime.
     */
    outcome: Type.Union([
      Type.Literal('imported'),
      Type.Literal('already_read'),
      Type.Literal('skipped'),
      Type.Literal('refused'),
    ]),
    reason: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
    workCode: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
    workLinkMethod: Type.Union([ImportedPaymentWorkLinkMethodSchema, Type.Null()]),
    invoiceLinkCount: Type.Integer({ minimum: 0 }),
    /** Ruling 10 — head lines this voucher stated no figure for. */
    missingAmountCount: Type.Integer({ minimum: 0 }),
    heads: Type.Array(
      Type.Object(
        {
          head: ImportedDeductionHeadSchema,
          tallyLedgerName: Type.String({ minLength: 1, maxLength: 300 }),
          amount: NonNegativeMoneyStringSchema,
          amountMissing: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type TallyReceiptProposal = Static<typeof TallyReceiptProposalSchema>;

export const TallyReceiptImportResultSchema = Type.Object(
  {
    mode: TallyReceiptImportModeSchema,
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    /** Every `<VOUCHER>` the file declared, of every type — so an operator
     * sees whether they exported the whole Day Book or the narrowed
     * register the runbook asks for. */
    voucherCount: Type.Integer({ minimum: 0 }),
    receiptCount: Type.Integer({ minimum: 0 }),
    /** Ruling 22: cancelled and optional vouchers are skipped and counted. */
    cancelledCount: Type.Integer({ minimum: 0 }),
    optionalCount: Type.Integer({ minimum: 0 }),
    /** Wave T4's two populations, counted here because they are the bulk
     * of the file and their silence would read as data loss: receipts
     * whose party is a bank (loan drawdowns, EMD and deposit refunds, FDR
     * maturities) and receipts with no deduction at all. */
    bankPartyCount: Type.Integer({ minimum: 0 }),
    noDeductionCount: Type.Integer({ minimum: 0 }),
    /** What this file would bring in, and what it already has. */
    importableCount: Type.Integer({ minimum: 0 }),
    alreadyReadCount: Type.Integer({ minimum: 0 }),
    /** Rulings 19 and 20, and anything that does not reconcile. */
    refusedCount: Type.Integer({ minimum: 0 }),
    /** Of the importable receipts: how many carry a proposed Work, by
     * which route, and how many carry none at all (ruling 17's queue). */
    workLinkedCount: Type.Integer({ minimum: 0 }),
    unlinkedCount: Type.Integer({ minimum: 0 }),
    matchedContactCount: Type.Integer({ minimum: 0 }),
    /** Bill allocations that reached an invoice on the register, and ones
     * that named a bill this register does not hold. */
    invoiceLinkCount: Type.Integer({ minimum: 0 }),
    unmatchedBillReferenceCount: Type.Integer({ minimum: 0 }),
    /** Ruling 10's reconciliation-report population. */
    missingAmountLineCount: Type.Integer({ minimum: 0 }),
    /** Ruling 16: round-off lines folded into the net, and the signed
     * total folded. */
    roundOffLineCount: Type.Integer({ minimum: 0 }),
    roundOffTotal: SignedMoneyStringSchema,
    /** Receipts refused because a leg named a ledger the CURRENT census
     * (0118, latest import) does not hold. Such a leg answers none of the
     * three questions this import asks — bank, customer or head — and a
     * second bank account missing from the census would otherwise book as
     * a deduction on a receipt that still balanced. The remedy is one
     * fresh masters export, so the count is worth its own line. */
    uncensusedLedgerRefusalCount: Type.Integer({ minimum: 0 }),
    /** Bill allocations whose reference matched MORE THAN ONE live
     * invoice on the register. Ambiguity links nothing — the rule every
     * proposal in this product keeps — and the count says how often. */
    ambiguousBillReferenceCount: Type.Integer({ minimum: 0 }),
    /** What the file totals, whether or not it is committed. */
    grossTotal: NonNegativeMoneyStringSchema,
    netTotal: NonNegativeMoneyStringSchema,
    deductionTotal: NonNegativeMoneyStringSchema,
    heads: Type.Array(
      Type.Object(
        {
          head: ImportedDeductionHeadSchema,
          amount: NonNegativeMoneyStringSchema,
          lineCount: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    /** Zero on a preview. On a commit, the rows actually written. */
    importedPaymentCount: Type.Integer({ minimum: 0 }),
    importedDeductionCount: Type.Integer({ minimum: 0 }),
    importedInvoiceLinkCount: Type.Integer({ minimum: 0 }),
    receipts: Type.Array(TallyReceiptProposalSchema),
    refusals: Type.Array(TallyVoucherRefusalSchema),
  },
  { additionalProperties: false },
);
export type TallyReceiptImportResult = Static<typeof TallyReceiptImportResultSchema>;
