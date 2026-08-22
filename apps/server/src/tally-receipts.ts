/**
 * Reading TallyPrime's railway receipts into payments with per-head
 * deduction attribution (migration 0120) — wave T3.
 *
 * ## The shape this exists for
 *
 * A railway does not pay a bill. It pays the bill MINUS what it deducts
 * against it, and one voucher says all of it:
 *
 *     <Division>                 credit  1,000,000.00   gross
 *     <Bank A/c>                  debit    880,000.00   net received
 *     SD <Division> PL-<code>     debit     50,000.00   security deposit
 *     TDS on Railway Bills AY …   debit     20,000.00   income-tax TDS
 *     CGST TDS 1%                 debit     10,000.00
 *     …
 *
 * `gross = net + Σ heads` on every one of them, and the whole wave rests
 * on it: money the railway kept is settled money, and a register carrying
 * only the bank credit would report every bill as short by its own
 * statutory deductions forever.
 *
 * ## The scanner is not here
 *
 * `tally-vouchers.ts` reads the envelope — UTF-16LE, one tag per line,
 * illegal character references, both accounting-leg tags, bill
 * allocations a level deeper, the five refusals about a voucher with no
 * GUID or no date. It takes the kept types as a parameter, so this module
 * asks it for `Receipt` and holds only what a receipt MEANS.
 *
 * ## Which leg is which, and why the answer comes from the ledger census
 *
 * A voucher line names a ledger and states a figure. Nothing on the line
 * says whether that ledger is a bank, a customer or a TDS head — that
 * fact lives in the GROUP the ledger sits under, which is
 * `tally_ledgers` (migration 0118, wave T1). So this wave READS THE
 * CENSUS rather than pattern-matching ledger names, and an import run
 * before the masters import is refused with that as the remedy.
 *
 * A LEDGER THE CENSUS DOES NOT HOLD REFUSES ITS VOUCHER, rather than
 * defaulting to the `other` bucket. The case that settles it is a SECOND
 * BANK ACCOUNT missing from the census: it is not a bank to this reader,
 * so the money that reached it would book as a deduction, the receipt
 * would still balance — `gross = net + Σ heads` holds either way — and
 * the register would say the railway withheld money it had actually
 * paid. Nothing downstream could notice. The census and the vouchers are
 * one day's two exports (ruling 3), so the remedy is a fresh masters
 * export and the refusal names the ledger.
 *
 * The alternative was matching names: `/tds/i` catches CGST TDS and
 * income-tax TDS alike and would have merged two statutory heads that are
 * reclaimed from two different authorities. Ancestry cannot make that
 * mistake — `classify` in `tally-masters.ts` argues the same point about
 * customers and vendors.
 *
 * ## The one head decided by NAME, and why that is not a contradiction
 *
 * `Contracual Deduction` (sic) sits in the `Contractual Deductions`
 * group beside bill copy, cess and conservation, so its group says only
 * that it is a contractual deduction of some kind. The owner read the
 * underlying vouchers and ruled on 23 Aug 2026 that this LEDGER is
 * liquidated damages — question 14, the one the whole wave was blocked
 * on. A ruling about one ledger is applied to that ledger, by name.
 *
 * ## Pure
 *
 * No database handle, no request, no clock. Everything is a function from
 * the reader's output and rows the route read under RLS to plain values,
 * which is what makes it testable against synthetic fixtures — and that
 * matters more than usual here, because the only file that exercises
 * every branch is a real company's ledger and no row of it may enter this
 * repository.
 */

import type { ImportedDeductionHead } from '@auto-mb/contracts';
import { paiseText, toPaise } from './money.js';
import { readPlCode } from './tally-masters.js';
import {
  type TallyVoucherRecord,
  type TallyVoucherRefusal,
  readTallyVoucherRecords,
} from './tally-vouchers.js';
import { squeeze } from './zoho-invoices.js';

/* --- what the census tells this wave --------------------------------------- */

/** One row of the ledger census (0118), as this wave reads it. */
export interface TallyLedgerFacts {
  readonly name: string;
  /** The group ancestry, immediate parent first — 0118's `group_path`. */
  readonly groupPath: readonly string[];
  /** The census's own class. Only `customer` is load-bearing here: it is
   * what makes a credited line the counterparty and a debited one a
   * refusal (ruling 19). */
  readonly classification: string;
  readonly plCode: string | null;
  readonly proposedContactId: string | null;
  readonly proposedContactMethod: 'gstin' | 'name' | null;
}

/**
 * Tally's own reserved bank groups.
 *
 * Reserved, so they are present in every company file and cannot be
 * renamed away — the same property `classify` relies on for `Sundry
 * Debtors`. Read against the real export these select exactly the 845
 * bank-party receipts the census counted, which is the check that this
 * list is the right one.
 */
const BANK_GROUPS = new Set([
  'bank accounts',
  'bank od a/c',
  'bank occ a/c',
  'cash-in-hand',
]);

/** The groups behind each of 0114's directly-mapped heads (census § 4.4).
 * `TDS & SAT AY <year>` is fifteen groups that differ only by assessment
 * year, so it is matched by prefix rather than listed. */
const GST_TDS_GROUP = 'gst- tds';
const INCOME_TAX_GROUP = 'tds on railway bills';
const INCOME_TAX_GROUP_PREFIX = 'tds & sat ay';
const SECURITY_DEPOSIT_GROUP = 'railway security deposits';

/** The one ledger decided by name — the owner's ruling of 23 Aug 2026 on
 * question 14. Squeezed, so the spellings `Contracual Deduction`,
 * `CONTRACTUAL DEDUCTION` and `Contracual-Deduction` are one ledger. Both
 * the export's misspelling and the correct spelling are admitted: the
 * ruling is about the deduction, not about the typo, and an operator
 * fixing the spelling in TallyPrime must not silently move ₹80 lakh into
 * the `other` bucket. */
const LIQUIDATED_DAMAGES_LEDGERS = new Set([
  'CONTRACUALDEDUCTION',
  'CONTRACTUALDEDUCTION',
]);

/**
 * Round-off is not a head (ruling 16); it folds into the net.
 *
 * BY NAME, and by CONTAINMENT rather than equality, because the group
 * cannot answer it: the real ledger sits under `Indirect Expenses` beside
 * every other expense head in the company, so ancestry would either match
 * nothing or match hundreds. Containment covers `Round Off`, `Rounding
 * Off` and `Round Off A/c` — one real ledger, 129 lines, ₹107 in total
 * across six years — and a ledger with "round off" in its name that is
 * NOT a rounding adjustment is not a shape this business has. The cost of
 * being wrong is bounded and visible: such a line would land in the net
 * instead of a head, and `round_off_amount` on the row says by how much.
 */
const ROUND_OFF_NAMES = ['ROUNDOFF', 'ROUNDINGOFF'];

const inGroup = (facts: TallyLedgerFacts | undefined, group: string): boolean =>
  facts?.groupPath.some((name) => name.toLowerCase() === group) ?? false;

export const isBankLedger = (facts: TallyLedgerFacts | undefined): boolean =>
  facts?.groupPath.some((name) => BANK_GROUPS.has(name.toLowerCase())) ?? false;

export const isCustomerLedger = (facts: TallyLedgerFacts | undefined): boolean =>
  facts?.classification === 'customer';

export const isRoundOffLedger = (ledger: string): boolean => {
  const name = squeeze(ledger);
  return ROUND_OFF_NAMES.some((known) => name.includes(known));
};

/**
 * Which of 0114's heads a deduction ledger books to.
 *
 * Only ever asked about a ledger the census HOLDS: a leg naming one it
 * does not refuses its whole voucher before this is reached, because a
 * ledger with no group answers none of the three questions this reader
 * asks of a leg. The `facts` parameter is still optional so the rule
 * stays total, and an absent one falls to the bucket.
 */
export function deductionHead(
  ledger: string,
  facts: TallyLedgerFacts | undefined,
): ImportedDeductionHead {
  if (LIQUIDATED_DAMAGES_LEDGERS.has(squeeze(ledger))) return 'liquidated_damages';
  if (inGroup(facts, GST_TDS_GROUP)) return 'gst_tds';
  if (
    inGroup(facts, INCOME_TAX_GROUP) ||
    (facts?.groupPath.some((name) =>
      name.toLowerCase().startsWith(INCOME_TAX_GROUP_PREFIX),
    ) ??
      false)
  ) {
    return 'income_tax_tds';
  }
  if (inGroup(facts, SECURITY_DEPOSIT_GROUP)) return 'security_deposit';
  // RULING 15. Bill copy, labour cess, conservation, postage, legal — a
  // third of real lines, every one a genuine railway deduction with no
  // 0114 head. One bucket, with the ledger name on the line, so
  // `gross = net + Σ heads` still holds and a promotion to a first-class
  // head later needs no re-import.
  return 'other';
}

/* --- what a read produces -------------------------------------------------- */

export interface ImportedDeductionLine {
  readonly head: ImportedDeductionHead;
  readonly tallyLedgerName: string;
  /** Exact rupees, never negative. `0.00` where the export stated no
   * figure — see `amountMissing`. */
  readonly amount: string;
  /** Ruling 10: the voucher named this head with no `AMOUNT` element at
   * all. 74 real lines. */
  readonly amountMissing: boolean;
  readonly plCode: string | null;
}

/** A receipt this wave will import, with everything it needs decided. */
export interface TallyReceipt {
  readonly voucher: TallyVoucherRecord;
  /** The ledger the voucher CREDITED — who paid. */
  readonly counterpartyLedger: string;
  readonly contactId: string | null;
  readonly contactMatchMethod: 'gstin' | 'name' | null;
  readonly gross: string;
  readonly net: string;
  readonly deductionTotal: string;
  /** Signed, folded into `net` already (ruling 16). */
  readonly roundOff: string;
  /** How many lines were folded. Reported rather than derived from the
   * figure above, which is zero on a receipt whose two round-offs
   * cancelled. */
  readonly roundOffLineCount: number;
  readonly deductions: readonly ImportedDeductionLine[];
  /** The bill allocations the voucher carried, verbatim. Tied to register
   * rows by the route, which is what holds the invoices. */
  readonly billReferences: readonly string[];
  /** The work code the security-deposit head names, where it names
   * exactly one. Ruling 17's first route. */
  readonly securityDepositPlCode: string | null;
}

/** Why a receipt is not this wave's to import. Not a refusal: a bank-party
 * receipt is a loan drawdown or a deposit refund, and a receipt with no
 * deduction is a plain collection — both are wave T4's, and counting
 * 1,263 of them as problems would bury the seven that are. */
export type TallyReceiptSkipReason = 'bank_party' | 'no_deduction';

export interface TallyReceiptSkip {
  readonly voucher: TallyVoucherRecord;
  readonly reason: TallyReceiptSkipReason;
}

/**
 * Why one receipt was refused, as a value rather than as a sentence.
 *
 * The sentence is what an operator reads and the kind is what the import
 * report counts, and they are separate for the reason every census in
 * this repository is: a count derived by matching a sentence breaks the
 * day somebody improves the wording.
 */
export type TallyReceiptRefusalKind =
  | 'no_customer_credit'
  | 'two_party'
  | 'credited_head'
  | 'customer_as_head'
  | 'no_bank_line'
  | 'uncensused_ledger'
  | 'duplicate_head_ledger'
  | 'zero_gross'
  | 'unbalanced';

/** A receipt refused BY NAME, with the line its voucher opened on, in both
 * the preview and the commit. */
export interface TallyReceiptRefusal {
  readonly voucher: TallyVoucherRecord;
  readonly kind: TallyReceiptRefusalKind;
  readonly reason: string;
}

export interface TallyReceiptRead {
  readonly receipts: readonly TallyReceipt[];
  readonly skipped: readonly TallyReceiptSkip[];
  readonly refused: readonly TallyReceiptRefusal[];
  /** Cancelled and optional vouchers (ruling 22), skipped and counted. */
  readonly cancelled: readonly TallyVoucherRecord[];
  readonly optional: readonly TallyVoucherRecord[];
  /** Every `<VOUCHER>` the file declared, of every type. */
  readonly voucherCount: number;
  readonly receiptCount: number;
  /** The reader's own refusals — a voucher with no GUID, no date, a name
   * longer than the schema stores. */
  readonly refusals: readonly TallyVoucherRefusal[];
}

/* --- reading ---------------------------------------------------------------- */

const RECEIPT_OPTIONS = {
  types: new Set(['Receipt']),
  noun: 'receipt vouchers',
};

/** Tally's sign convention: negative is a debit. A leg with no figure is
 * neither, and ruling 10 decides what happens to it. */
const isDebit = (amount: string | null): boolean =>
  amount !== null && amount.startsWith('-');
const magnitude = (amount: string): string =>
  amount.startsWith('-') ? amount.slice(1) : amount;

/**
 * Reads a filtered TallyPrime receipt export into one record per railway
 * receipt, deciding each voucher's fate exactly once.
 *
 * PREVIEW AND COMMIT CALL THIS, and that is what makes them agree: every
 * per-voucher decision — skipped, refused, importable — is taken here,
 * from the bytes and the census, with no clock and no database. The route
 * adds only the two facts it alone holds: which vouchers a previous
 * import already read, and which Works and invoices this member may see.
 */
export function readTallyReceipts(
  bytes: Buffer,
  ledgers: ReadonlyMap<string, TallyLedgerFacts>,
): TallyReceiptRead {
  const read = readTallyVoucherRecords(bytes, RECEIPT_OPTIONS);
  const receipts: TallyReceipt[] = [];
  const skipped: TallyReceiptSkip[] = [];
  const refused: TallyReceiptRefusal[] = [];
  const cancelled: TallyVoucherRecord[] = [];
  const optional: TallyVoucherRecord[] = [];

  for (const voucher of read.vouchers) {
    // RULING 22. TallyPrime strips a cancelled voucher of its party and
    // its legs, so there is nothing to reconcile and nothing to import;
    // it is counted rather than passed over in silence.
    if (voucher.cancelled) {
      cancelled.push(voucher);
      continue;
    }
    if (voucher.optional) {
      optional.push(voucher);
      continue;
    }

    // WAVE T4'S, NOT THIS WAVE'S. 845 real receipts name a bank as the
    // party and credit no customer at all: loan drawdowns, EMD and
    // deposit refunds, FDR maturities. 401 of them are the RELEASE side
    // of the instruments wave T5 reconciles, which is why they are a
    // class rather than leftovers.
    if (isBankLedger(ledgers.get(voucher.partyLedger))) {
      skipped.push({ voucher, reason: 'bank_party' });
      continue;
    }

    const credits = voucher.entries.filter(
      (entry) => entry.amount !== null && !isDebit(entry.amount),
    );
    const debits = voucher.entries.filter((entry) => isDebit(entry.amount));
    const missing = voucher.entries.filter((entry) => entry.amount === null);

    const bankLines = debits.filter((entry) => isBankLedger(ledgers.get(entry.ledger)));
    const roundOffLines = [...debits, ...credits].filter((entry) =>
      isRoundOffLedger(entry.ledger),
    );
    const headLines = [...debits, ...missing].filter(
      (entry) =>
        !isBankLedger(ledgers.get(entry.ledger)) && !isRoundOffLedger(entry.ledger),
    );

    // A plain collection, an advance, a refund. Wave T4's.
    if (headLines.length === 0) {
      skipped.push({ voucher, reason: 'no_deduction' });
      continue;
    }

    // A DEBIT LEG NAMING A LEDGER THE CENSUS DOES NOT HOLD REFUSES THE
    // VOUCHER, and this is the arm the coordinator's finding 4 is about.
    //
    // Every question this reader asks of a leg — is it a bank, is it a
    // customer, which head is it — is answered by the ledger's GROUP, and
    // a ledger the census does not carry answers none of them. The old
    // reading defaulted such a leg to the `other` bucket, which is
    // exactly wrong on the case that matters: a SECOND BANK ACCOUNT
    // missing from the census is not a bank to this reader, so the money
    // that reached it was booked as a deduction. The receipt still
    // balanced — `gross = net + Σ heads` holds either way — so nothing
    // downstream could notice, and the register would have said the
    // railway withheld money it had actually paid.
    //
    // The remedy is a fresh masters export, which is the same day's file
    // (ruling 3), so the refusal names the ledger and says so.
    const uncensused = [...debits, ...missing].find(
      (entry) => !ledgers.has(entry.ledger),
    );
    if (uncensused !== undefined) {
      refused.push({
        voucher,
        kind: 'uncensused_ledger',
        reason: `This receipt names the ledger ${uncensused.ledger}, which the current Tally census does not hold — so nothing here can say whether it is a bank, a customer or a deduction head. Import the All Masters export taken with these vouchers, then read this file again.`,
      });
      continue;
    }

    // ONE LEDGER, ONE LINE. The line key is (voucher, ledger name) — the
    // census's own § 5 key and migration 0120's unique index — so two
    // legs naming one ledger are ONE row: the second collides on
    // `on conflict do nothing`, the heads sum short of the stated total,
    // and the deferred constraint refuses the whole transaction at COMMIT
    // with nothing naming the voucher. Refused here instead, by name.
    const seenLedgers = new Set<string>();
    const duplicate = headLines.find((entry) => {
      if (seenLedgers.has(entry.ledger)) return true;
      seenLedgers.add(entry.ledger);
      return false;
    });
    if (duplicate !== undefined) {
      refused.push({
        voucher,
        kind: 'duplicate_head_ledger',
        reason: `This receipt books two deduction lines to ${duplicate.ledger}, and a receipt holds one line per ledger. Combine them in TallyPrime, or book the second to its own head, and export again.`,
      });
      continue;
    }

    const customerCredits = credits.filter((entry) =>
      isCustomerLedger(ledgers.get(entry.ledger)),
    );
    const strayCredits = credits.filter(
      (entry) =>
        !isCustomerLedger(ledgers.get(entry.ledger)) && !isRoundOffLedger(entry.ledger),
    );
    if (customerCredits.length === 0) {
      refused.push({
        voucher,
        kind: 'no_customer_credit',
        reason:
          'This receipt carries deductions but credits no customer ledger, so there is nobody it can be filed as a payment from.',
      });
      continue;
    }
    // RULING 20. A person splits such a receipt into two clean ones; a
    // rule that split it here would have to decide how much of each
    // deduction belongs to which customer, which the voucher does not
    // say.
    if (customerCredits.length > 1) {
      refused.push({
        voucher,
        kind: 'two_party',
        reason:
          'This receipt credits more than one customer ledger with its deductions pooled across them. Split it into one receipt per customer in TallyPrime and export again.',
      });
      continue;
    }
    // A DEDUCTION HEAD ON THE CREDIT SIDE is a reversal — a deposit
    // released back and netted against the bill. It is real, and it is
    // not a payment with deductions; guessing at it would put a negative
    // deduction into a head this schema keeps non-negative.
    if (strayCredits.length > 0) {
      refused.push({
        voucher,
        kind: 'credited_head',
        reason: `This receipt credits ${strayCredits[0]?.ledger ?? 'a ledger'}, which is not a customer — a release netted against a collection is not a payment with deductions, and this wave does not model it.`,
      });
      continue;
    }
    // RULING 19. Five real deduction lines debit a railway CUSTOMER
    // ledger as if it were a head. Held with a named refusal and listed
    // for the owner, because whether it is a correction entry or a
    // genuine inter-division adjustment is not something a reader can
    // decide.
    const customerHeads = headLines.filter((entry) =>
      isCustomerLedger(ledgers.get(entry.ledger)),
    );
    if (customerHeads.length > 0) {
      refused.push({
        voucher,
        kind: 'customer_as_head',
        reason: `This receipt debits the customer ledger ${customerHeads[0]?.ledger ?? ''} as if it were a deduction head. Whether that is a correction or an inter-division adjustment is the owner's to say.`,
      });
      continue;
    }
    if (bankLines.length === 0) {
      refused.push({
        voucher,
        kind: 'no_bank_line',
        reason:
          'This receipt names no bank ledger, so there is no figure for what actually reached the bank.',
      });
      continue;
    }

    /* --- the arithmetic, in minor units ---------------------------------
       AGENTS.md rule 5, and this is the path it exists for: every figure
       below is added in BigInt paise and turned back into an exact
       decimal once. A sum of money strings through `Number` would put a
       rounding error inside the comparison that decides whether a receipt
       reconciles at all. */
    const grossPaise = toPaise(customerCredits[0]?.amount ?? '0');
    // A RECEIPT OF NOTHING IS NOT A RECEIPT. `gross_amount > 0` is a
    // CHECK on the header, and a degenerate correction voucher — every
    // leg zero — reconciles perfectly on the way to meeting it
    // mid-commit, where it would name a constraint rather than a
    // voucher.
    if (grossPaise <= 0n) {
      refused.push({
        voucher,
        kind: 'zero_gross',
        reason: `This receipt credits ${paiseText(grossPaise)} to ${customerCredits[0]?.ledger ?? 'its customer'}, so it records no money arriving. A correction voucher is not a payment.`,
      });
      continue;
    }
    // RULING 16. Signed: a debited round-off raises the net, a credited
    // one lowers it, and either way `gross = net + Σ heads` stays exact.
    // Without the fold, 125 real receipts miss by a paisa and every one
    // of them would be refused for it.
    let roundOffPaise = 0n;
    for (const entry of roundOffLines) roundOffPaise -= toPaise(entry.amount ?? '0');
    let netPaise = roundOffPaise;
    for (const entry of bankLines) netPaise -= toPaise(entry.amount ?? '0');

    const deductions: ImportedDeductionLine[] = [];
    let deductionPaise = 0n;
    let securityDepositPlCode: string | null = null;
    let securityDepositCodeAmbiguous = false;
    for (const entry of headLines) {
      // Present, always: a leg naming a ledger the census does not hold
      // refused the whole voucher above.
      const facts = ledgers.get(entry.ledger);
      const head = deductionHead(entry.ledger, facts);
      const amount = entry.amount === null ? '0.00' : magnitude(entry.amount);
      deductionPaise += toPaise(amount);
      // The census's own code reader (0118), not `proposeWorkLink`'s: a
      // ledger NAME spells the code five ways and `tally-masters.ts`
      // argues at length why the two patterns are deliberately different.
      const plCode = facts?.plCode ?? readPlCode(entry.ledger).code;
      deductions.push({
        head,
        tallyLedgerName: entry.ledger,
        amount,
        amountMissing: entry.amount === null,
        plCode,
      });
      if (head === 'security_deposit' && plCode !== null) {
        // No real receipt splits security deposit across two works. If
        // one ever does, it proposes NOTHING rather than the first code
        // it saw — ruling 6's discipline, one level down.
        if (securityDepositPlCode !== null && securityDepositPlCode !== plCode) {
          securityDepositCodeAmbiguous = true;
        }
        securityDepositPlCode ??= plCode;
      }
    }

    if (grossPaise !== netPaise + deductionPaise) {
      refused.push({
        voucher,
        kind: 'unbalanced',
        reason: `This receipt does not reconcile: ${paiseText(grossPaise)} credited against ${paiseText(netPaise)} to the bank and ${paiseText(deductionPaise)} of deductions. Nothing is imported from a voucher whose own arithmetic this reader cannot reproduce.`,
      });
      continue;
    }

    const counterpartyLedger = customerCredits[0]?.ledger ?? '';
    const facts = ledgers.get(counterpartyLedger);
    receipts.push({
      voucher,
      counterpartyLedger,
      // THE CENSUS'S OWN PROPOSAL, not a second matcher. 0118 already ran
      // GSTIN-then-name against this organisation's contacts, ambiguity
      // proposing nothing (ruling 8), and re-deciding it here would be a
      // second implementation of one rule that drifts from the first.
      contactId: facts?.proposedContactId ?? null,
      contactMatchMethod: facts?.proposedContactMethod ?? null,
      gross: paiseText(grossPaise),
      net: paiseText(netPaise),
      deductionTotal: paiseText(deductionPaise),
      roundOff: paiseText(roundOffPaise),
      roundOffLineCount: roundOffLines.length,
      deductions,
      billReferences: voucher.billReferences,
      securityDepositPlCode: securityDepositCodeAmbiguous
        ? null
        : securityDepositPlCode,
    });
  }

  return {
    receipts,
    skipped,
    refused,
    cancelled,
    optional,
    voucherCount: read.voucherCount,
    receiptCount: read.vouchers.length,
    refusals: read.refusals,
  };
}
