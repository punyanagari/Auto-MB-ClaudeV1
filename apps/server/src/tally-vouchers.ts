/**
 * Reading TallyPrime's sales-side vouchers, and tying them to the
 * historical invoice register (migration 0119) — wave T2.
 *
 * ## The file this reads, and the one it refuses
 *
 * `Transactions.xml` — every voucher TallyPrime holds — is 3.18 GB, and
 * no upload route in this application accepts it: the cap is 192 MB and
 * the malware scanner's is 256 MB. That is not a limitation to work
 * around. Read against the real file, 96 % of the corpus is Payment,
 * Journal, Purchase and Contra vouchers this product does not model
 * (`docs/reference/TALLY-MAPPING-CENSUS.md` § 5 says so and proposes
 * importing none of them), and the three types that matter — Sales,
 * Credit Note, Debit Note — are 1,185 vouchers and 61 MB.
 *
 * So the intake is a FILTERED EXPORT: the owner exports the sales-side
 * vouchers from TallyPrime and uploads that, well inside the cap, through
 * the same signature check and the same malware scan every other upload
 * here goes through. `docs/OPERATIONS.md` carries the export steps. This
 * reader filters again on the way in, because a Day Book export the
 * operator forgot to narrow is a real Tuesday and reading past the other
 * types costs a string comparison.
 *
 * ## What a voucher is, structurally
 *
 * The envelope is `tally-scan.ts`'s: UTF-16LE, one tag per line, illegal
 * character references, engine flags everywhere. Inside a `<VOUCHER>`:
 *
 *   * direct fields — `DATE`, `GUID`, `ALTERID`, `VOUCHERTYPENAME`,
 *     `VOUCHERNUMBER`, `REFERENCE`, `PARTYLEDGERNAME`, `PARTYGSTIN`,
 *     `NARRATION`, `ISCANCELLED`, `ISOPTIONAL`;
 *   * accounting legs, in `ALLLEDGERENTRIES.LIST` — or, on the two thirds
 *     of sales vouchers that are in INVENTORY mode, in
 *     `LEDGERENTRIES.LIST`, because Tally moves the income legs inside
 *     the stock allocations and leaves the party leg behind under a
 *     different tag. Reading only `ALLLEDGERENTRIES.LIST` finds no legs
 *     at all on those vouchers, and a voucher with no legs has no value —
 *     which made every inventory-mode invoice look like a ₹0 disagreement
 *     with Zoho. Both tags are read.
 *   * bill allocations, one level deeper, whose `NAME` is a document
 *     number. 419 real sales vouchers carry one and it is sometimes the
 *     only place the invoice number appears.
 *
 * ## What the value of a voucher is
 *
 * The census defines it and this reproduces the definition rather than
 * inventing one: the PARTY LINE's own figure, which carries the document
 * total even in inventory mode, falling back to `max(Σ debits, Σ credits)`
 * where no leg names the party ledger. The sign convention is Tally's —
 * negative is a debit — so the party leg on a sale is negative and the
 * value is its magnitude. Nothing here adds two money strings: the
 * arithmetic is done in `money.ts`'s minor units, in BigInt.
 *
 * ## Matching, and the one guard that is not optional
 *
 * A Tally voucher is tied to a Zoho invoice by DOCUMENT NUMBER, compared
 * with case and punctuation removed (`squeeze`, shared with the Zoho
 * reader). The voucher offers up to three: its number, its reference and
 * each bill allocation, because `Sales` is the one voucher type this
 * company numbers manually and 341 real sales vouchers carry no
 * `VOUCHERNUMBER` at all.
 *
 * Where no number matches, a SERIAL-TOLERANT arm tries the trailing
 * five-digit serial — the census found five documents that Tally and Zoho
 * agree on the serial for and disagree on the two-digit customer-code
 * segment in the middle of. That arm CANNOT stand on the serial alone,
 * and this is the census's § 4.3 finding rather than a precaution: one
 * real pair shares a serial across two unrelated customers, different
 * amounts, five months apart. So a serial-tolerant match must ALSO agree
 * on the amount, the GSTIN or the party name, and `serialCollisions`
 * counts the ones the guard turned away.
 *
 * ## Disagreements are reconciled over a COMPONENT, never over a pair
 *
 * The correspondence is many-to-many: 97 real vouchers name more than one
 * invoice and 47 real invoices name more than one voucher. "Does Tally
 * agree with Zoho" is therefore a question about a connected component of
 * the link graph, and a per-pair comparison would report hundreds of
 * disagreements that are nothing but one entry covering three bills. Read
 * against the real files, 526 components resolve and 5 of them disagree
 * by more than a rupee — which is ruling 21's disputed population.
 *
 * ## Pure
 *
 * No database handle, no request, no clock. Everything below is a
 * function from bytes (and, for the match, from rows the route read under
 * RLS) to plain values — which is what makes it testable against
 * synthetic fixtures, and that matters here more than usual because the
 * only file that exercises every branch is a real company's ledger and no
 * row of it may enter this repository.
 */

import { paiseText, toPaise } from './money.js';
import {
  CLOSE_TAG,
  COMPLETE_TAG,
  MAX_REFUSALS,
  OPEN_TAG,
  TallyImportError,
  VALUE_OPENS_HERE,
  clean,
  exactRupees,
  keepSourceField,
  readLines,
} from './tally-scan.js';
import { squeeze } from './zoho-invoices.js';

/* --- ceilings -------------------------------------------------------------- */

/**
 * The most vouchers one filtered export may declare, counting only the
 * three types this reads. The real file holds 1,185 across six financial
 * years; fifty thousand is a company two orders of magnitude busier and
 * still a bounded array. A Day Book export nobody narrowed carries 83,061
 * vouchers of every type and is admitted, because the filter runs before
 * this count does — it is the KEPT vouchers that are bounded.
 */
const MAX_VOUCHERS = 50_000;

/** The most accounting legs kept per voucher. Six is the real maximum on
 * a sales-side voucher (party, income, two tax heads, round-off, and one
 * spare); a hundred is a voucher nobody typed by hand. */
const MAX_ENTRIES = 100;

/** The most document numbers one voucher offers the matcher. A real one
 * offers at most three — its number, its reference and one bill
 * allocation — and a voucher settling twenty bills is still a bounded
 * fan-out. */
const MAX_MATCH_KEYS = 40;

/** The most non-boolean direct fields kept per voucher in `sourceFields`.
 * A real sales voucher yields about thirty. */
const MAX_SOURCE_FIELDS = 80;

/**
 * The voucher types this wave reads. Everything else in the export is
 * skipped without being counted as a refusal: it is not malformed, it is
 * a different wave's problem (census § 5).
 */
const SALES_SIDE_TYPES = new Set(['Sales', 'Credit Note', 'Debit Note']);

export type TallyVoucherType = 'Sales' | 'Credit Note' | 'Debit Note';

/**
 * What a reader wants out of one voucher export.
 *
 * THE SCANNER IS SHARED AND THE MEANING IS NOT — the same argument
 * `tally-scan.ts` makes about the FORMAT, one level up. Wave T3 reads
 * `Receipt` vouchers out of the same file, through the same envelope, the
 * same two accounting-leg tags, the same bill allocations and the same
 * five refusals about a voucher that has no GUID, no date or a name
 * longer than the schema stores. What differs is which types are kept and
 * what the vouchers MEAN, so the types are a parameter and the meaning
 * lives in `tally-receipts.ts`.
 */
export interface TallyVoucherReadOptions {
  /** The types kept. Everything else is counted and skipped — a Payment
   * voucher is not malformed, it is another wave's problem. */
  readonly types: ReadonlySet<string>;
  /** What to call them in a file-level refusal, so the remedy names the
   * export the operator should re-run: `sales vouchers`, `receipt
   * vouchers`. */
  readonly noun: string;
}

const SALES_SIDE_OPTIONS: TallyVoucherReadOptions = {
  types: SALES_SIDE_TYPES,
  noun: 'sales vouchers',
};

/* --- refusals -------------------------------------------------------------- */

/**
 * A refusal about ONE voucher, carrying the line it opened on so an
 * operator can find it in the export. The file still imports; the named
 * voucher does not. Same discipline as the masters reader's
 * `TallyLedgerRefusal` and `spreadsheet_import_rows.errors` (0094).
 */
export interface TallyVoucherRefusal {
  /** The line the `<VOUCHER>` element opened on, where 1 is the first
   * line of the file. */
  readonly lineNumber: number;
  /** The voucher's own number or reference where it had a readable one,
   * so the refusal names something the operator can search Tally for. */
  readonly voucherNumber: string | null;
  readonly reason: string;
}

/* --- what a read produces -------------------------------------------------- */

/** One accounting leg. `amount` is the exact decimal Tally wrote, sign
 * included — negative is a debit — or null where the leg carried no
 * `AMOUNT` element at all, which 77 real receipts do and which a reader
 * that assumed the tag would crash on. */
export interface TallyVoucherEntry {
  readonly ledger: string;
  readonly amount: string | null;
}

/**
 * One voucher of whatever type the caller asked for.
 *
 * `TallyVoucher` beneath is this record with its type narrowed to the
 * three sales-side ones, which is what wave T2 writes into a column whose
 * CHECK names exactly those three. Wave T3 reads `Receipt` vouchers out
 * of the same file and takes this shape as it stands.
 */
export interface TallyVoucherRecord {
  /** Tally's own stable identifier, and therefore the idempotency key. */
  readonly guid: string;
  /** Tally's edit counter (owner ruling 2). NULL when the voucher carries
   * none — unknown, which is not the same as zero. */
  readonly alterId: number | null;
  /** Tally's own name for the type, kept verbatim. Narrowed to the three
   * sales-side ones on `TallyVoucher`. */
  readonly voucherType: string;
  /** A date-only `YYYY-MM-DD`, converted from Tally's `YYYYMMDD` by
   * string edit and never through a `Date` — AGENTS.md rule 6. */
  readonly date: string;
  /** Null on the 341 real sales vouchers Tally numbers manually and
   * nobody numbered. */
  readonly voucherNumber: string | null;
  readonly reference: string | null;
  /** EMPTY on a cancelled or optional voucher, which TallyPrime strips of
   * its party and its legs. Never empty on one that becomes a link or a
   * register row — `finishVoucher` refuses those. */
  readonly partyLedger: string;
  readonly partyGstin: string | null;
  readonly narration: string | null;
  /** Ruling 22: skipped, and counted by voucher number in the report. */
  readonly cancelled: boolean;
  readonly optional: boolean;
  readonly entries: readonly TallyVoucherEntry[];
  /** The `NAME` of every bill allocation on the voucher, verbatim. A
   * document number lives here on 419 real sales vouchers. */
  readonly billReferences: readonly string[];
  /** The voucher's value, as the census defines it. See the header. */
  readonly amount: string;
  /** Every non-boolean, non-empty direct field, keyed by Tally's own tag —
   * the `raw_row` discipline of 0115, trimmed to this file's noise floor. */
  readonly sourceFields: Readonly<Record<string, string>>;
  readonly lineNumber: number;
}

/** A sales-side voucher: the record above with its type narrowed to the
 * three the `tally_invoice_links` CHECK admits. */
export interface TallyVoucher extends TallyVoucherRecord {
  readonly voucherType: TallyVoucherType;
}

export interface TallyVoucherRecordRead {
  readonly vouchers: readonly TallyVoucherRecord[];
  /** How many `<VOUCHER>` elements the export declared in total, of every
   * type. Reported so an operator can see whether they exported the whole
   * Day Book or the narrowed register the runbook asks for. */
  readonly voucherCount: number;
  readonly refusals: readonly TallyVoucherRefusal[];
}

export interface TallyVoucherRead extends TallyVoucherRecordRead {
  readonly vouchers: readonly TallyVoucher[];
}

/* --- reading one voucher --------------------------------------------------- */

/** Tally writes a date as `YYYYMMDD` with no separators. Converted by
 * string edit, then proven to be a day that exists — `2023-02-30`
 * satisfies every pattern and is not a date, and PostgreSQL would refuse
 * it as a 22008 mid-commit with nothing naming the voucher. */
function tallyDate(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1] ?? ''}-${match[2] ?? ''}-${match[3] ?? ''}`;
}

/** 0028's contacts GSTIN shape, both arms, so a voucher GSTIN and a
 * contacts-master one are the same kind of value and the serial-tolerant
 * match compares like with like. */
const GSTIN = /^(?:\d{2}[A-Z]{5}\d{4}[A-Z][\dA-Z]Z[\dA-Z]|\d{2}[\dA-Z]{12}D)$/;

/** A value cut to a column's width and trimmed AFTER the cut, or null
 * where nothing is left. See the call sites: `clean` trims, and slicing
 * is what can put a space back on the end. */
function trimmedOrNull(value: string, limit: number): string | null {
  const text = value.slice(0, limit).trim();
  return text.length === 0 ? null : text;
}

/**
 * The voucher's value: the party line's own figure, else the larger side
 * of the double entry.
 *
 * THE ARITHMETIC IS IN MINOR UNITS. `money.ts` counts in BigInt for the
 * reason every money path here does, and a fallback that summed two legs
 * as JavaScript numbers would be AGENTS.md rule 5 broken in the one place
 * nobody would look — the branch that only runs on a voucher whose party
 * leg is missing.
 */
function voucherValue(
  partyLedger: string,
  entries: readonly TallyVoucherEntry[],
): string {
  for (const entry of entries) {
    if (entry.ledger !== partyLedger || entry.amount === null) continue;
    return entry.amount.startsWith('-') ? entry.amount.slice(1) : entry.amount;
  }
  let debits = 0n;
  let credits = 0n;
  for (const entry of entries) {
    if (entry.amount === null) continue;
    const paise = toPaise(entry.amount);
    if (paise < 0n) debits += -paise;
    else credits += paise;
  }
  return paiseText(debits > credits ? debits : credits);
}

/**
 * Reads a filtered TallyPrime voucher export into one record per voucher
 * of the types the caller asked for.
 *
 * Depth is tracked by counting the export's own tags rather than by
 * reading its indentation, for the reason `tally-masters.ts` gives:
 * indentation is a formatting property of one export setting and counting
 * elements cannot be changed by a checkbox in TallyPrime.
 */
export function readTallyVoucherRecords(
  bytes: Buffer,
  options: TallyVoucherReadOptions,
): TallyVoucherRecordRead {
  const vouchers: TallyVoucherRecord[] = [];
  const refusals: TallyVoucherRefusal[] = [];
  const seenGuids = new Set<string>();
  let voucherCount = 0;
  let sawEnvelope = false;
  let sawEnvelopeEnd = false;

  /** True while inside a `<VOUCHER>`. */
  let inVoucher = false;
  let elementLine = 0;
  let depth = 0;
  let guid = '';
  let alterId = '';
  let date = '';
  let voucherType = '';
  let voucherNumber = '';
  let reference = '';
  let partyLedger = '';
  let partyGstin = '';
  let narration = '';
  let cancelled = false;
  let optional = false;
  let entries: TallyVoucherEntry[] = [];
  let billReferences: string[] = [];
  let sourceFields: Record<string, string> = {};
  /** The leg being read, or null when the scanner is not inside one. */
  let entryLedger = '';
  let entryAmount: string | null = null;
  let inEntry = false;
  /**
   * The depth at which a `BILLALLOCATIONS.LIST` opened, or null when the
   * scanner is not inside one.
   *
   * A bill allocation's `NAME` is a DOCUMENT NUMBER and one of the three
   * things the matcher reads. `NAME` two levels deep is not: a
   * `CATEGORYALLOCATIONS.LIST` names a cost category and a
   * `COSTCENTREALLOCATIONS.LIST` names a cost centre, and both sit at
   * exactly the same depth. Collecting those fed the matcher strings that
   * are not document numbers at all — harmless on this company's file,
   * which has no cost centres, and a false link waiting on any file that
   * does.
   */
  let billAllocationDepth: number | null = null;
  /** The voucher declared more accounting legs than this reader keeps. Its
   * VALUE would then be read off a truncated set — see `closeEntry`. */
  let tooManyEntries = false;

  const refuse = (reason: string): void => {
    if (refusals.length < MAX_REFUSALS) {
      const named = voucherNumber.length > 0 ? voucherNumber : reference;
      refusals.push({
        lineNumber: elementLine,
        voucherNumber: named.length > 0 ? named.slice(0, 60) : null,
        reason,
      });
    }
  };

  const closeEntry = (): void => {
    if (!inEntry) return;
    inEntry = false;
    if (entryLedger.length === 0) return;
    // A CEILING ON A MONEY PATH REFUSES; IT DOES NOT TRUNCATE. The
    // voucher's value is read off these legs, so silently keeping the
    // first hundred of a longer voucher would produce a figure that is
    // not the document's — quietly, and only for the vouchers nobody
    // looked at. The flag is raised here and `finishVoucher` names the
    // voucher; the real maximum on a sales-side voucher is six.
    if (entries.length >= MAX_ENTRIES) {
      tooManyEntries = true;
      return;
    }
    entries.push({ ledger: entryLedger, amount: entryAmount });
  };

  const finishVoucher = (): void => {
    closeEntry();
    voucherCount += 1;
    // NOT A REFUSAL. A Payment or a Journal is not malformed; it is a
    // voucher this wave does not model, and counting 79,847 of them as
    // problems would bury the ones that are.
    if (!options.types.has(voucherType)) return;
    if (guid.length === 0) {
      refuse(
        'This voucher carries no GUID. The GUID is what makes re-importing the export safe, so a voucher without one is not imported.',
      );
      return;
    }
    // THE COLUMN BOUNDS, PROVEN HERE RATHER THAN BY THE DATABASE. Each has
    // a CHECK behind it in migration 0119, and a CHECK is the wrong place
    // to meet one: it arrives mid-commit as a 23514 naming a constraint,
    // after a thousand other rows have been built, with nothing saying
    // WHICH voucher or WHERE.
    if (guid.length > 80) {
      refuse(
        'This voucher’s GUID is longer than this register stores (80 characters), so it is not a Tally GUID.',
      );
      return;
    }
    if (tooManyEntries) {
      refuse(
        `This voucher carries more than ${String(MAX_ENTRIES)} accounting lines, which is more than this reader keeps — so its value cannot be read from them.`,
      );
      return;
    }
    const legalDate = tallyDate(date);
    if (legalDate === null) {
      refuse(
        'This voucher carries no readable date, and a billing record with no date is not a record of anything.',
      );
      return;
    }
    // A CANCELLED OR OPTIONAL VOUCHER IS STRIPPED, AND RULING 22 STILL
    // WANTS IT NAMED.
    //
    // TallyPrime empties a cancelled voucher: all ten real cancelled
    // sales-side vouchers carry no `PARTYLEDGERNAME`, no
    // `VOUCHERNUMBER` and no accounting legs at all — only the date, the
    // GUID, the type and sometimes a reference survive. Requiring a party
    // ledger of them turned "ten cancelled vouchers, here are their
    // references" into "ten vouchers could not be read", which is exactly
    // the confusion ruling 22 exists to prevent: an operator cannot tell
    // a document TallyPrime cancelled from one this reader choked on.
    //
    // Neither ever becomes a link or a register row — the route filters
    // both before it matches anything — so the fields a ROW needs are not
    // required of them. What is required is what makes them findable
    // again: the date, the GUID and whatever reference is left.
    const stripped = cancelled || optional;
    if (partyLedger.length === 0 && !stripped) {
      refuse(
        'This voucher names no party ledger, so there is no customer to file it under.',
      );
      return;
    }
    // A LIVE SALES VOUCHER WITH NO DOCUMENT NUMBER ANYWHERE IS REFUSED
    // HERE, which is what makes the preview and the commit agree.
    //
    // Such a voucher matches nothing — the matcher reads exactly these
    // three fields — so it would become a register row, and
    // `invoice_number` on that register is NOT NULL because a billing
    // record with no number is not a record of anything. The route used
    // to discover this at COMMIT and answer a file-level 400, so a
    // preview an operator had read and approved could be followed by a
    // refusal that wrote nothing and named no voucher. A row-level
    // condition gets a row-level refusal, in both modes, with the line.
    //
    // Cancelled and optional vouchers keep their exemption: TallyPrime
    // strips their numbers too, and they become nothing.
    if (
      !stripped &&
      voucherType === 'Sales' &&
      voucherNumber.length === 0 &&
      reference.length === 0 &&
      billReferences.length === 0
    ) {
      refuse(
        'This sales voucher carries no voucher number, no reference and no bill allocation, so there is no invoice number to file it under.',
      );
      return;
    }
    if (partyLedger.length > 300) {
      refuse(
        'This voucher’s party ledger name is longer than this register stores (300 characters).',
      );
      return;
    }
    if (seenGuids.has(guid)) {
      refuse(
        'Two vouchers in this export carry the same GUID; only the first is read.',
      );
      return;
    }
    if (vouchers.length >= MAX_VOUCHERS) {
      throw new TallyImportError(
        `That export declares more than ${String(MAX_VOUCHERS)} ${options.noun}, which is not a voucher export this reader will take.`,
      );
    }
    seenGuids.add(guid);
    const gstin = partyGstin.toUpperCase();
    vouchers.push({
      guid,
      // NULL, NEVER ZERO, when the voucher carries no readable ALTERID —
      // 0118's column comment argues it in full: zero is a real Tally
      // counter value and conflating it with "unknown" makes every
      // re-import of such a record look like progress or regression.
      alterId: /^\d{1,15}$/.test(alterId) ? Number(alterId) : null,
      voucherType,
      date: legalDate,
      // TRIMMED AFTER SLICING, every one of them, and that order is the
      // whole point. `clean` already trimmed the value, so slicing is what
      // can reintroduce a trailing space — cutting `ABC DEF` at four
      // characters leaves `ABC `, and every text CHECK behind these
      // columns is `btrim(x) = x`. The truncation would have been met as a
      // 23514 naming a constraint, mid-commit, on whichever voucher
      // happened to be long.
      voucherNumber: trimmedOrNull(voucherNumber, 60),
      reference: trimmedOrNull(reference, 200),
      partyLedger,
      partyGstin: GSTIN.test(gstin) ? gstin : null,
      // Bounded for the same reason: `reference_text` on the register is
      // 2,000 characters, and a narration is the one operator-typed field
      // here with no natural ceiling.
      narration: trimmedOrNull(narration, 2000),
      cancelled,
      optional,
      entries,
      billReferences,
      amount: voucherValue(partyLedger, entries),
      sourceFields,
      lineNumber: elementLine,
    });
  };

  let lineNumber = 0;
  let lastOffset = 0;
  /** The tag of a value that opened with text on its line and has not
   * closed yet — a NARRATION somebody typed a newline into. Until it is
   * skipped the scanner reads its content as structure, which leaves the
   * depth wrong for the rest of the voucher. `tally-masters.ts` found
   * this the hard way; the rule is the same here. */
  let openValueTag: string | null = null;

  for (const { text: rawLine, offset } of readLines(bytes)) {
    lineNumber += 1;
    lastOffset = offset;
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (openValueTag !== null) {
      // Plain string search rather than a regex built from parsed input:
      // a tag name like `BILLALLOCATIONS.LIST` carries a `.`, which as a
      // pattern would match anything.
      if (line.toUpperCase().includes(`</${openValueTag}>`)) openValueTag = null;
      continue;
    }

    if (!sawEnvelope) {
      if (line.startsWith('<ENVELOPE')) sawEnvelope = true;
      else if (lineNumber > 20) {
        throw new TallyImportError(
          `That file does not begin with a Tally <ENVELOPE>. Export the ${options.noun} from TallyPrime and upload the XML it writes, unchanged.`,
        );
      }
    }

    if (!inVoucher) {
      if (line.startsWith('</ENVELOPE')) sawEnvelopeEnd = true;
      if (!/^<VOUCHER(?:\s|>)/i.test(line)) continue;
      inVoucher = true;
      elementLine = lineNumber;
      depth = 0;
      guid = '';
      alterId = '';
      date = '';
      voucherType = '';
      voucherNumber = '';
      reference = '';
      partyLedger = '';
      partyGstin = '';
      narration = '';
      cancelled = false;
      optional = false;
      entries = [];
      billReferences = [];
      sourceFields = {};
      inEntry = false;
      billAllocationDepth = null;
      tooManyEntries = false;
      entryLedger = '';
      entryAmount = null;
      // A voucher written as `<VOUCHER …/>` — Tally does not, but a
      // self-closing element must not leave the scanner inside a voucher
      // for the rest of the file.
      if (line.endsWith('/>')) inVoucher = false;
      continue;
    }

    const closing = CLOSE_TAG.exec(line)?.[1]?.toUpperCase();
    if (closing === 'VOUCHER' && depth === 0) {
      finishVoucher();
      inVoucher = false;
      continue;
    }
    // A leg ends where its list does, which is depth 1 on the way out.
    if (
      inEntry &&
      depth === 1 &&
      (closing === 'ALLLEDGERENTRIES.LIST' || closing === 'LEDGERENTRIES.LIST')
    ) {
      closeEntry();
      depth -= 1;
      continue;
    }

    const complete = COMPLETE_TAG.exec(line);
    if (complete !== null) {
      const tag = (complete[1] as string).toUpperCase();
      const value = clean(complete[2] as string);
      if (depth === 0) {
        if (tag === 'GUID') guid = value;
        else if (tag === 'ALTERID') alterId = value;
        else if (tag === 'DATE') date = value;
        else if (tag === 'VOUCHERTYPENAME') voucherType = value;
        else if (tag === 'VOUCHERNUMBER') voucherNumber = value;
        else if (tag === 'REFERENCE') reference = value;
        else if (tag === 'PARTYLEDGERNAME') partyLedger = value;
        else if (tag === 'PARTYGSTIN') partyGstin = value;
        else if (tag === 'NARRATION') narration = value;
        else if (tag === 'ISCANCELLED') cancelled = value === 'Yes';
        else if (tag === 'ISOPTIONAL') optional = value === 'Yes';
        if (
          Object.keys(sourceFields).length < MAX_SOURCE_FIELDS &&
          keepSourceField(tag, value)
        ) {
          sourceFields[tag] = value;
        }
      } else if (inEntry && depth === 1) {
        if (tag === 'LEDGERNAME') entryLedger = value;
        // THE FIRST AMOUNT ONLY. A leg's own figure is its first
        // `AMOUNT`; the ones after it belong to the sub-allocations
        // nested beneath, and taking the last would read a bill
        // allocation's share as the whole leg.
        else if (tag === 'AMOUNT' && entryAmount === null) {
          entryAmount = exactRupees(value);
        }
      } else if (billAllocationDepth !== null && tag === 'NAME' && value.length > 0) {
        // INSIDE A BILL ALLOCATION ONLY. See `billAllocationDepth`.
        if (billReferences.length < MAX_MATCH_KEYS) billReferences.push(value);
      }
      continue;
    }

    // `endsWith('/>')` is the guard, not decoration: `<LANGUAGENAME.LIST
    // TYPE="String"/>` satisfies the open-tag shape — the attribute run
    // swallows the slash — and counting it would leave the scanner one
    // level too deep for the rest of the voucher, hiding every direct
    // field after it.
    const opening = OPEN_TAG.exec(line);
    if (opening !== null && !line.endsWith('/>')) {
      const tag = (opening[1] as string).toUpperCase();
      // BOTH TAGS, and the header says why: an inventory-mode sales
      // voucher keeps its party leg under `LEDGERENTRIES.LIST` and has no
      // `ALLLEDGERENTRIES.LIST` at all.
      if (
        depth === 0 &&
        (tag === 'ALLLEDGERENTRIES.LIST' || tag === 'LEDGERENTRIES.LIST')
      ) {
        closeEntry();
        inEntry = true;
        entryLedger = '';
        entryAmount = null;
      }
      // The bill-allocation context the NAME arm reads. Recorded as the
      // depth it opened at so the close below can end it exactly, rather
      // than as a boolean a nested list would clear early.
      if (billAllocationDepth === null && tag === 'BILLALLOCATIONS.LIST') {
        billAllocationDepth = depth;
      }
      depth += 1;
      continue;
    }
    if (CLOSE_TAG.test(line) && depth > 0) {
      depth -= 1;
      if (billAllocationDepth !== null && depth <= billAllocationDepth) {
        billAllocationDepth = null;
      }
      continue;
    }
    // Everything left that OPENS a tag and carries text after it is a
    // value running past the end of its line. Its content is skipped, not
    // parsed — see the note at the top of the loop.
    const spanning = VALUE_OPENS_HERE.exec(line);
    if (spanning !== null) openValueTag = (spanning[1] as string).toUpperCase();
  }

  // NOT AN ENVELOPE AT ALL IS ANSWERED FIRST, before either truncation
  // check. A file that never had an opening `<ENVELOPE>` is the wrong
  // file — a spreadsheet, a PDF, somebody's HTML — and telling its sender
  // that their Tally export "stops partway through" would send them to
  // re-run an export they never ran.
  if (!sawEnvelope) {
    throw new TallyImportError(
      `That file does not begin with a Tally <ENVELOPE>. Export the ${options.noun} from TallyPrime and upload the XML it writes, unchanged.`,
    );
  }
  // A VOUCHER STILL OPEN AT EOF IS A REFUSAL, NOT A DROP. A file that
  // stops mid-voucher is a half-written export, and the vouchers before
  // the cut are a real, complete-looking prefix. Importing them silently
  // would leave the register describing a fraction of the billing history
  // with every count agreeing with itself and being wrong.
  if (inVoucher) {
    throw new TallyImportError(
      `That export stops in the middle of a voucher, ${String(lastOffset)} bytes in. It was not finished being written — export the ${options.noun} from TallyPrime again and upload the complete file.`,
      'TALLY_EXPORT_TRUNCATED',
    );
  }
  if (!sawEnvelopeEnd) {
    throw new TallyImportError(
      `That export has no closing </ENVELOPE>, so it stops before Tally finished writing it (${String(lastOffset)} bytes read). Export the ${options.noun} from TallyPrime again and upload the complete file.`,
      'TALLY_EXPORT_TRUNCATED',
    );
  }

  return { vouchers, voucherCount, refusals };
}

/**
 * The sales-side read: wave T2's own three types, narrowed.
 *
 * The cast is the one place the narrowing is asserted, and `options.types`
 * is what makes it true — a voucher of any other type never reaches the
 * array.
 */
export function readTallyVouchers(bytes: Buffer): TallyVoucherRead {
  return readTallyVoucherRecords(bytes, SALES_SIDE_OPTIONS) as TallyVoucherRead;
}

/* --- matching the historical register -------------------------------------- */

/** The register rows a match may name: what the Zoho import already
 * stored. Read by the route under RLS, live rows only. */
export interface RegisterInvoice {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly customerName: string;
  readonly customerGstin: string | null;
  readonly total: string;
}

/**
 * A correspondence the register ALREADY holds, from an earlier import.
 *
 * It joins the reconciliation and becomes no new link. Without it a
 * second file CONTRADICTS the first instead of completing it: a
 * period-narrowed Sales export carrying one of the three vouchers that
 * cover an invoice would sum that voucher alone against the invoice's
 * whole total and report a disagreement of the missing two thirds — a
 * false dispute, on a real invoice, produced by the operator following
 * `docs/OPERATIONS.md`'s own instruction to upload more than one file.
 *
 * Feeding the existing links back in makes the component the union of
 * what every import has seen, so the second file completes the picture.
 */
export interface ExistingTallyLink {
  readonly tallyGuid: string;
  readonly invoiceId: string;
  /** The voucher's value as the earlier import recorded it. */
  readonly amount: string;
}

export type TallyMatchMethod = 'exact_number' | 'serial_tolerant';

export interface TallyInvoiceLink {
  readonly voucher: TallyVoucher;
  readonly invoiceId: string;
  readonly method: TallyMatchMethod;
  /** The normalised document number that produced the match, so a person
   * reads WHY two documents were tied together. */
  readonly evidence: string;
  /** Ruling 21, decided over the whole connected component. */
  readonly disputed: boolean;
  readonly componentTallyTotal: string;
  readonly componentInvoiceTotal: string;
}

export interface TallyMatchResult {
  readonly links: readonly TallyInvoiceLink[];
  /** Live sales vouchers no register row corresponds to — the pre-Zoho
   * half of ruling 23, which become register rows of their own. */
  readonly unmatched: readonly TallyVoucher[];
  /** Serial-tolerant candidates the amount/GSTIN/name confirmation turned
   * away. The census found one and named it: same five digits, different
   * customer, different amount, five months apart. Reported so the guard
   * is visible rather than silent. */
  readonly serialCollisions: number;
  /** How many connected components the links resolved into, and how many
   * of them disagree in value. */
  readonly componentCount: number;
  readonly disputedComponentCount: number;
}

/**
 * The document numbers one voucher offers, normalised and deduplicated.
 *
 * Three sources because `Sales` is the one voucher type this company
 * numbers manually: 706 real sales vouchers carry a `VOUCHERNUMBER`, 640
 * a `REFERENCE` and 419 a bill allocation, and no single one of them
 * covers the history. Keys shorter than three characters are dropped —
 * a one-character "number" matches half a register.
 */
function matchKeys(voucher: TallyVoucher): readonly string[] {
  const keys = new Set<string>();
  for (const raw of [
    voucher.voucherNumber ?? '',
    voucher.reference ?? '',
    ...voucher.billReferences,
  ]) {
    if (keys.size >= MAX_MATCH_KEYS) break;
    const key = squeeze(raw);
    if (key.length >= 3) keys.add(key);
  }
  return [...keys];
}

/**
 * The trailing five-digit serial of a document number, with the prefix
 * that precedes it.
 *
 * Five because that is the shape this company's numbers actually take —
 * `P<aa>NNNNN` — and the renumbering the census found moved the two
 * digits in the middle while leaving the serial alone. A number with NO
 * prefix is not offered: a bare five-digit string is not distinctive
 * enough to be evidence of anything, and matching on it would tie two
 * documents together because both happened to end in the same year.
 */
function serialOf(key: string): { prefix: string; serial: string } | null {
  const match = /^(.+)(\d{5})$/.exec(key);
  if (match === null) return null;
  return { prefix: match[1] as string, serial: match[2] as string };
}

/** Within a rupee. The census reconciles at this tolerance because Zoho
 * rounds a document total and Tally rounds the legs it is built from, and
 * the two land a few paise apart on invoices that agree perfectly. */
function agreesWithinARupee(left: string, right: string): boolean {
  const gap = toPaise(left) - toPaise(right);
  return (gap < 0n ? -gap : gap) <= 100n;
}

/**
 * Ties Tally's sales vouchers to the historical register.
 *
 * CANCELLED AND OPTIONAL VOUCHERS ARE NOT OFFERED HERE (ruling 22): the
 * caller filters them and counts them by number in the import report, so
 * this function only ever sees documents that exist.
 *
 * Only `Sales` vouchers match. A credit note reverses an invoice rather
 * than being one, and tying it to the invoice it credits by NUMBER would
 * claim the two are the same document — migration 0119 § E states the
 * boundary and names the wave that models reversals.
 */
export function matchTallyVouchers(
  vouchers: readonly TallyVoucher[],
  invoices: readonly RegisterInvoice[],
  existing: readonly ExistingTallyLink[] = [],
): TallyMatchResult {
  const byNumber = new Map<string, RegisterInvoice[]>();
  const bySerial = new Map<string, { invoice: RegisterInvoice; prefix: string }[]>();
  for (const invoice of invoices) {
    const key = squeeze(invoice.invoiceNumber);
    if (key.length >= 3) {
      const bucket = byNumber.get(key);
      if (bucket === undefined) byNumber.set(key, [invoice]);
      else bucket.push(invoice);
    }
    const serial = serialOf(key);
    if (serial === null) continue;
    const bucket = bySerial.get(serial.serial);
    const entry = { invoice, prefix: serial.prefix };
    if (bucket === undefined) bySerial.set(serial.serial, [entry]);
    else bucket.push(entry);
  }

  interface Pair {
    readonly voucher: TallyVoucher;
    readonly invoice: RegisterInvoice;
    readonly method: TallyMatchMethod;
    readonly evidence: string;
  }
  const pairs: Pair[] = [];
  const unmatched: TallyVoucher[] = [];
  let serialCollisions = 0;

  for (const voucher of vouchers) {
    if (voucher.voucherType !== 'Sales') continue;
    const keys = matchKeys(voucher);
    const hits = new Map<string, Pair>();
    for (const key of keys) {
      for (const invoice of byNumber.get(key) ?? []) {
        hits.set(invoice.id, {
          voucher,
          invoice,
          method: 'exact_number',
          evidence: key,
        });
      }
    }
    // THE SERIAL ARM ONLY RUNS WHERE THE NUMBER ARM FOUND NOTHING. A
    // voucher whose number matched an invoice outright has its answer,
    // and looking for near-misses beside it would add a second, weaker
    // claim about the same document.
    if (hits.size === 0) {
      for (const key of keys) {
        const serial = serialOf(key);
        if (serial === null) continue;
        for (const candidate of bySerial.get(serial.serial) ?? []) {
          // The exact arm would already have caught an identical prefix.
          if (candidate.prefix === serial.prefix) continue;
          // THE CONFIRMATION IS NOT OPTIONAL. Census § 4.3: one real pair
          // shares a serial across two unrelated customers, different
          // amounts, five months apart, and a serial-only match would
          // have tied them together for good.
          const confirmed =
            agreesWithinARupee(voucher.amount, candidate.invoice.total) ||
            (voucher.partyGstin !== null &&
              voucher.partyGstin === candidate.invoice.customerGstin) ||
            squeeze(voucher.partyLedger) === squeeze(candidate.invoice.customerName);
          if (!confirmed) {
            serialCollisions += 1;
            continue;
          }
          hits.set(candidate.invoice.id, {
            voucher,
            invoice: candidate.invoice,
            method: 'serial_tolerant',
            evidence: key,
          });
        }
      }
    }
    if (hits.size === 0) unmatched.push(voucher);
    else pairs.push(...hits.values());
  }

  /* --- reconciliation, by connected component -----------------------------
     The correspondence is many-to-many, so "does Tally agree with Zoho"
     is a question about a component of the bipartite link graph and not
     about a pair. Union-find over the pairs, then one sum per side; a
     component whose two sums differ by more than a rupee marks EVERY link
     in it disputed, because the disagreement belongs to the group rather
     than to whichever pair happens to be biggest. */
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let current = node;
    for (;;) {
      const next = parent.get(current);
      if (next === undefined || next === current) return current;
      // Path halving, so a long chain does not make this quadratic.
      parent.set(current, parent.get(next) ?? next);
      current = next;
    }
  };
  const link = (left: string, right: string): void => {
    if (!parent.has(left)) parent.set(left, left);
    if (!parent.has(right)) parent.set(right, right);
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft !== rootRight) parent.set(rootLeft, rootRight);
  };
  for (const pair of pairs) {
    link(`v:${pair.voucher.guid}`, `i:${pair.invoice.id}`);
  }
  // THE CORRESPONDENCES THE REGISTER ALREADY HOLDS join the graph before
  // any sum is taken. See `ExistingTallyLink`: without them a second,
  // narrower file reports the invoices it half-covers as disagreeing by
  // whatever the first file already accounted for.
  //
  // A link whose voucher is IN THIS FILE is dropped rather than added
  // twice — the file's own reading of that voucher is the current one,
  // and adding both would double its value inside the component.
  const inThisFile = new Set(vouchers.map((voucher) => voucher.guid));
  const carried = existing.filter((entry) => !inThisFile.has(entry.tallyGuid));
  for (const entry of carried) {
    link(`v:${entry.tallyGuid}`, `i:${entry.invoiceId}`);
  }

  interface Component {
    readonly vouchers: Map<string, string>;
    readonly invoices: Map<string, string>;
  }
  const components = new Map<string, Component>();
  for (const pair of pairs) {
    const root = find(`v:${pair.voucher.guid}`);
    let component = components.get(root);
    if (component === undefined) {
      component = { vouchers: new Map(), invoices: new Map() };
      components.set(root, component);
    }
    component.vouchers.set(pair.voucher.guid, pair.voucher.amount);
    component.invoices.set(pair.invoice.id, pair.invoice.total);
  }
  // The carried links contribute their voucher's value and their
  // invoice's total to whichever component they landed in. An invoice
  // reached ONLY by a carried link forms a component of its own, which is
  // right: the two systems' figures for it are still being compared, and
  // a file that says nothing about it changes nothing about it.
  const invoiceTotals = new Map(invoices.map((invoice) => [invoice.id, invoice.total]));
  for (const entry of carried) {
    const root = find(`v:${entry.tallyGuid}`);
    let component = components.get(root);
    if (component === undefined) {
      component = { vouchers: new Map(), invoices: new Map() };
      components.set(root, component);
    }
    component.vouchers.set(entry.tallyGuid, entry.amount);
    const total = invoiceTotals.get(entry.invoiceId);
    if (total !== undefined) component.invoices.set(entry.invoiceId, total);
  }

  const verdicts = new Map<
    string,
    { disputed: boolean; tallyTotal: string; invoiceTotal: string }
  >();
  let disputedComponentCount = 0;
  for (const [root, component] of components) {
    // BigInt minor units throughout — AGENTS.md rule 5. A component can
    // hold a dozen documents and summing them as JavaScript numbers would
    // put the rounding error inside the comparison that decides whether
    // there is a disagreement at all.
    let tallyPaise = 0n;
    for (const amount of component.vouchers.values()) tallyPaise += toPaise(amount);
    let invoicePaise = 0n;
    for (const total of component.invoices.values()) invoicePaise += toPaise(total);
    const tallyTotal = paiseText(tallyPaise);
    const invoiceTotal = paiseText(invoicePaise);
    const disputed = !agreesWithinARupee(tallyTotal, invoiceTotal);
    if (disputed) disputedComponentCount += 1;
    verdicts.set(root, { disputed, tallyTotal, invoiceTotal });
  }

  const links = pairs.map((pair): TallyInvoiceLink => {
    const verdict = verdicts.get(find(`v:${pair.voucher.guid}`));
    return {
      voucher: pair.voucher,
      invoiceId: pair.invoice.id,
      method: pair.method,
      evidence: pair.evidence.slice(0, 300),
      disputed: verdict?.disputed ?? false,
      componentTallyTotal: verdict?.tallyTotal ?? pair.voucher.amount,
      componentInvoiceTotal: verdict?.invoiceTotal ?? pair.invoice.total,
    };
  });

  return {
    links,
    unmatched,
    serialCollisions,
    componentCount: components.size,
    disputedComponentCount,
  };
}
