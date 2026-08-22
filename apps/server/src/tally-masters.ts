/**
 * Reading TallyPrime's `All Masters` export into the ledger census
 * (migration 0118).
 *
 * ## Why this is a line scanner and not an XML parser
 *
 * Because no XML parser will open the file. `tally-scan.ts` carries that
 * argument, the byte-order mark, the illegal character references, the
 * line-shape expressions and the format's own ceilings — everything this
 * reader shares with the voucher reader (0119) beside it. What is left
 * here is what a LEDGER MASTER means.
 *
 * ## Bounded, because the input is a file
 *
 * A reader whose loop is driven by the shape of untrusted bytes needs a
 * ceiling on every axis the bytes control. The format's own — line
 * length, refusal count — are in `tally-scan.ts`; the ones belonging to
 * this document are below, each stated with the real figure it is sized
 * against, and each refuses rather than growing.
 *
 * ## Two passes over one read
 *
 * Groups and ledgers are interleaved in the export and a ledger's root
 * group is only knowable once the whole group tree is in hand, so the
 * scan collects both and the ancestry is resolved at the end. That is
 * one pass over the BYTES — the expensive axis — and a second pass over
 * 4,327 collected records, which is nothing.
 *
 * ## What it deliberately does not do
 *
 * It does not create contacts, works, or instrument records, and it does
 * not link anything. Owner rulings 4, 5 and 6: a Tally code never creates
 * a Work, parsing a ledger name yields PROPOSALS a person confirms, and
 * ambiguity proposes nothing. The one thing this file decides on its own
 * is the CLASSIFICATION, and it decides it from Tally's own reserved
 * group names rather than from this organisation's group spellings —
 * see `classify`.
 */

import {
  CLOSE_TAG,
  COMPLETE_TAG,
  MAX_REFUSALS,
  NAME_ATTRIBUTE,
  OPEN_TAG,
  TallyImportError,
  VALUE_OPENS_HERE,
  clean,
  exactRupees,
  keepSourceField,
  readLines,
} from './tally-scan.js';
import {
  type ContactCandidate,
  type ContactIndex,
  type ContactMatch,
  matchContact,
  matchIndexedContact,
  normaliseContactName,
} from './zoho-invoices.js';

/* --- ceilings -------------------------------------------------------------- */

/**
 * The most ledgers one export may declare. The real file holds 4,327;
 * ten times that is a company an order of magnitude larger than this one
 * and still a bounded array.
 */
const MAX_LEDGERS = 50_000;

/** The most groups. 159 real, same reasoning. */
const MAX_GROUPS = 20_000;

/** The deepest group ancestry a census row stores, matching 0118's own
 * array bound. The deepest real path in the export is three. */
const MAX_GROUP_DEPTH = 20;

/**
 * The most non-boolean fields kept per ledger in `sourceFields`. A real
 * ledger yields about a dozen.
 */
const MAX_SOURCE_FIELDS = 60;

/* --- refusals -------------------------------------------------------------- */

/**
 * A refusal about the whole file, under the name this reader's callers
 * have always used for it.
 *
 * The class itself is `tally-scan.ts`'s, because the voucher reader
 * throws the same refusal about the same format and two classes would
 * mean two `instanceof` arms in every route that reads a Tally file. The
 * alias is kept so a masters caller still names the masters error.
 */
export { TallyImportError as TallyMasterImportError } from './tally-scan.js';

/**
 * A refusal about ONE ledger, carrying the line it opened on so an
 * operator can find it in the export. The file still imports; the named
 * ledger does not. Same discipline as `spreadsheet_import_rows.errors`
 * (0094) and the Zoho reader's row-numbered refusals.
 */
export interface TallyLedgerRefusal {
  /** The line the `<LEDGER>` element opened on, where 1 is the first line
   * of the file. */
  readonly lineNumber: number;
  /** The ledger's own name where it had a readable one, so the refusal
   * names something the operator can search Tally for. */
  readonly ledgerName: string | null;
  readonly reason: string;
}

/* --- what a read produces -------------------------------------------------- */

export type TallyLedgerClass = 'customer' | 'vendor' | 'instrument' | 'other';

export interface TallyLedger {
  /** Tally's own stable identifier, and therefore the idempotency key. */
  readonly guid: string;
  /** Increments whenever Tally alters the master. The cursor the one
   * post-training top-up re-read uses (owner ruling 2). NULL when the
   * master carries none — unknown, which is not the same as zero, and
   * which the regression guard skips rather than compares. */
  readonly alterId: number | null;
  /** The ledger name, which is unique in Tally and is the join key used
   * inside the export itself. */
  readonly name: string;
  /** The immediate group, verbatim. */
  readonly parentGroup: string;
  /** The group ancestry, ROOT FIRST, ending at the immediate parent.
   * Empty when the ledger's parent group is not in the export. */
  readonly groupPath: readonly string[];
  readonly classification: TallyLedgerClass;
  /** The party GSTIN, where the master carries one in a shape the
   * contacts master would also accept. */
  readonly gstin: string | null;
  readonly openingBalance: string | null;
  /** The v1 work code carried in the ledger's own NAME, canonicalised to
   * `PL-<n>`. Text, never a link: owner ruling 4. Null when the name
   * carries none, or carries two different ones. */
  readonly plCode: string | null;
  readonly isDeleted: boolean;
  /** Every non-boolean, non-empty direct field of the master, keyed by
   * Tally's own tag. See `keepSourceField`. */
  readonly sourceFields: Readonly<Record<string, string>>;
  /**
   * Another master in this export cleans to the same name.
   *
   * Tally holds ledger names unique and the real export honours it — but
   * uniquely only up to the ILLEGAL CHARACTER REFERENCES it contains. Two
   * names that differ solely by a `&#4;` are two names in Tally and one
   * name to everything downstream of `clean`, and two of the 4,327 real
   * masters are such a pair. Both are imported, because both are real
   * masters with their own GUIDs; what they lose is the right to be
   * matched to a contact BY NAME, which is owner ruling 8's "ambiguity
   * refuses and a person decides" applied to the subject rather than to
   * the candidate.
   */
  readonly nameAmbiguous: boolean;
  readonly lineNumber: number;
}

export interface TallyMasterRead {
  readonly ledgers: readonly TallyLedger[];
  /** How many `<GROUP>` masters the export declared. Reported so an
   * operator can see the tree was read, since every classification
   * depends on it. */
  readonly groupCount: number;
  readonly refusals: readonly TallyLedgerRefusal[];
  /** Ledger names carrying two different work codes, which propose
   * nothing (owner ruling 6). Counted rather than refused: the ledger is
   * real and belongs in the census, only its code is unusable. */
  readonly ambiguousCodeCount: number;
  /** Masters whose GSTIN was not in a shape the contacts master accepts.
   * The ledger imports with a null GSTIN and matches by name instead. */
  readonly malformedGstinCount: number;
  /** Masters sharing a cleaned name with another master. See
   * `TallyLedger.nameAmbiguous`. */
  readonly duplicateNameCount: number;
}

/* --- classification -------------------------------------------------------- */

/**
 * `Sundry Debtors` and `Sundry Creditors` are TALLY'S OWN reserved
 * groups, present in every company file ever created, and every customer
 * and vendor sits somewhere beneath one of them however the organisation
 * has subdivided it.
 *
 * That is why the classification reads the ANCESTRY rather than the
 * immediate group. This organisation files its customers under `Railway
 * Authority`, `Private Parties`, `Amc` and `Sundry Debtors` itself, and
 * its vendors under `Sundry Creditors`, eleven `Creditors for A–K`
 * categories and `Sub Contract Advance` — a list that is this company's
 * accounting taxonomy (owner ruling 7: dropped) and that would be stale
 * the first time somebody adds a twelfth. Ancestry gives the same answer
 * without knowing any of them: reading the real export, `Sundry Debtors`
 * ancestry selects exactly the 178 ledgers the census counted as
 * customer-ish, and no ledger descends from both.
 */
const CUSTOMER_ROOT = 'sundry debtors';
const VENDOR_ROOT = 'sundry creditors';

/**
 * The v1 work code as ledger names actually spell it: `PL-282`, `PL 282`
 * and `PL.282` all appear, the last inside instrument names like
 * `…P.B.G. Pl.282`.
 *
 * This is deliberately NOT `proposeWorkLink`'s pattern, which takes no
 * dot and demands two digits. That one reads free text — an invoice
 * reference beside item descriptions — where a dot separator would match
 * a sentence boundary and a single digit would match a quantity. This one
 * reads a ledger NAME, a short operator-typed label whose whole purpose
 * is to key the instrument to a work, and the census found real codes
 * from 1 to 282. Widening the shared matcher to cover both would have
 * loosened the invoice register's matching to suit a different haystack.
 *
 * THE BOUNDARIES ARE WRITTEN OUT RATHER THAN LEFT AS `\b`, and a real
 * naming shape is why: `<fd-account>_BG_<Division>_PL282` is one of the
 * five conventions the census catalogued, and `\bPL` never matches in it
 * because an underscore is a word character, so there is no boundary
 * between `_` and `P`. The lookbehind admits the underscore and still
 * refuses a letter or digit, so `SUPPL 22` and `APL-9` are not work
 * codes. The lookahead refuses only a further DIGIT: truncating `PL-2821`
 * to `PL-282` would key an instrument to the wrong contract.
 *
 * A SPACE MAY NOT INTRODUCE FOUR DIGITS, and that is the difference
 * between reading a work code and reading a financial year. `SD Division
 * PL 2024` is a ledger named for a YEAR, and under a rule that took four
 * digits after a space it became work `PL-2024` — an instrument
 * confidently keyed to a contract nobody has. Scanned against the real
 * export the restriction costs nothing, and the scan is what settled the
 * shape rather than a guess about it:
 *
 *   separator  digits  matches
 *   -          3       234        `.`  2   6
 *   -          2       106        ` `  3   1
 *   (none)     2         8        ` `  2   1
 *   (none)     3         1
 *
 * Every real code is THREE DIGITS OR FEWER — the range is 1..282 — and
 * there is not one four-digit match in the file. So four digits are
 * admitted only behind a HYPHEN, which is the canonical spelling
 * `works.work_code` itself uses, leaving a future `PL-1000` readable
 * while `PL 2024` and `PL.2024` are not codes at all.
 *
 * The optional space after `-` or `.` admits `Pl. 282`, which the census
 * lists among the spellings. It appears zero times in this export; it is
 * one character of pattern against an operator-typed field that will be
 * re-exported on import day, and it cannot introduce a year because a
 * dot is not a hyphen.
 */
const LEDGER_PL_CODE = /(?<![A-Za-z0-9])PL([-.] ?| ?)(\d{1,4})(?!\d)/gi;

/**
 * The work code this ledger name carries, canonical, or null.
 *
 * TWO DIFFERENT CODES IN ONE NAME PROPOSE NOTHING — owner ruling 6, and
 * the same rule `proposeWorkLink` keeps: a coin flip between two
 * contracts is worse than an operator's five seconds. The same code
 * written twice is one code, not an ambiguity.
 */
export function readPlCode(name: string): { code: string | null; ambiguous: boolean } {
  const found = new Set<string>();
  for (const match of name.matchAll(LEDGER_PL_CODE)) {
    const separator = match[1] ?? '';
    const digits = match[2] ?? '';
    // FOUR DIGITS NEED A HYPHEN. See the pattern's own note: everything
    // else that reaches four digits in a ledger name is a year.
    if (digits.length === 4 && !separator.startsWith('-')) continue;
    // Leading zeros stripped so `PL-07` and `PL-7` are one code. The
    // canonical spelling is what a later wave joins on `works.work_code`;
    // the name itself keeps whatever the operator typed.
    found.add(`PL-${digits.replace(/^0+(?=\d)/, '')}`);
  }
  if (found.size === 1) return { code: [...found][0] as string, ambiguous: false };
  return { code: null, ambiguous: found.size > 1 };
}

function classify(
  groupPath: readonly string[],
  plCode: string | null,
): TallyLedgerClass {
  const lowered = groupPath.map((group) => group.toLowerCase());
  if (lowered.includes(CUSTOMER_ROOT)) return 'customer';
  if (lowered.includes(VENDOR_ROOT)) return 'vendor';
  // Everything the SD / FDR / PBG / EMD instruments have in common, and
  // the census's single most valuable finding: they are already keyed to
  // the v1 work code. A ledger outside the party tree whose name carries
  // one is an instrument for waves T4 and T5 to reconcile — not a
  // contact, and not something this wave turns into a record (ruling 18).
  if (plCode !== null) return 'instrument';
  return 'other';
}

/* --- values ---------------------------------------------------------------- */

/** 0028's contacts GSTIN shape, both arms, so a ledger GSTIN and a master
 * one are the same kind of value — and so migration 0118's CHECK can
 * never be reached with something it would refuse as a 500. */
const GSTIN = /^(?:\d{2}[A-Z]{5}\d{4}[A-Z][\dA-Z]Z[\dA-Z]|\d{2}[\dA-Z]{12}D)$/;

/* --- the read -------------------------------------------------------------- */

/**
 * Reads a TallyPrime `All Masters` export into one record per ledger.
 *
 * Depth is tracked by counting the export's own tags rather than by
 * reading its indentation. The census took the indentation as stable and
 * for this file it is, but it is a formatting property of one export
 * setting — counting elements is the same number of lines of code and
 * cannot be changed by a checkbox in TallyPrime.
 */
export function readTallyMasters(bytes: Buffer): TallyMasterRead {
  const groupParents = new Map<string, string>();
  const ledgers: TallyLedger[] = [];
  const refusals: TallyLedgerRefusal[] = [];
  const seenGuids = new Set<string>();
  const seenNames = new Set<string>();
  const duplicateNames = new Set<string>();
  let ambiguousCodeCount = 0;
  let malformedGstinCount = 0;
  let sawEnvelope = false;

  /** The master being read, or null between masters. */
  let element: 'LEDGER' | 'GROUP' | null = null;
  let elementLine = 0;
  let depth = 0;
  let name: string | null = null;
  let parent = '';
  let guid = '';
  let alterId = '';
  let gstinDirect = '';
  let gstinNested = '';
  let opening = '';
  let deleted = false;
  let sourceFields: Record<string, string> = {};

  const refuse = (reason: string): void => {
    if (refusals.length < MAX_REFUSALS) {
      refusals.push({ lineNumber: elementLine, ledgerName: name, reason });
    }
  };

  const finishLedger = (): void => {
    if (name === null || name.length === 0) {
      refuse(
        'This ledger master carries no name, so there is nothing to file it under.',
      );
      return;
    }
    if (guid.length === 0) {
      refuse(
        'This ledger master carries no GUID. The GUID is what makes re-importing the export safe, so a master without one is not imported.',
      );
      return;
    }
    // THE COLUMN BOUNDS, PROVEN HERE RATHER THAN BY THE DATABASE. Each of
    // the three below has a CHECK behind it in migration 0118, and a
    // CHECK is the wrong place to meet one: it arrives mid-commit as a
    // 23514 naming a constraint, after 4,326 other rows have been built,
    // with nothing saying WHICH master or WHERE. Refused here, in the
    // preview, each carries the ledger and the line. The CHECKs stay as
    // the backstop they are.
    if (guid.length > 80) {
      refuse(
        'This ledger master’s GUID is longer than this census stores (80 characters), so it is not a Tally GUID.',
      );
      return;
    }
    if (name.length > 300) {
      refuse(
        'This ledger master’s name is longer than this census stores (300 characters).',
      );
      return;
    }
    if (parent.length > 300) {
      refuse(
        'This ledger master’s group name is longer than this census stores (300 characters).',
      );
      return;
    }
    if (seenGuids.has(guid)) {
      refuse(
        'Two ledger masters in this export carry the same GUID; only the first is imported.',
      );
      return;
    }
    if (ledgers.length >= MAX_LEDGERS) {
      throw new TallyImportError(
        `That export declares more than ${String(MAX_LEDGERS)} ledgers, which is not a masters export this census will read.`,
      );
    }
    const { code, ambiguous } = readPlCode(name);
    if (ambiguous) ambiguousCodeCount += 1;

    let gstin: string | null = null;
    const rawGstin = (gstinDirect.length > 0 ? gstinDirect : gstinNested).toUpperCase();
    if (rawGstin.length > 0) {
      if (GSTIN.test(rawGstin)) gstin = rawGstin;
      else malformedGstinCount += 1;
    }

    seenGuids.add(guid);
    // Keyed on the SAME normalisation the contact match compares under,
    // imported rather than restated — `normaliseContactName`'s own note
    // says what keying on a bare `toLowerCase()` let through.
    const lowered = normaliseContactName(name);
    if (seenNames.has(lowered)) duplicateNames.add(lowered);
    seenNames.add(lowered);
    ledgers.push({
      guid,
      // NULL, NEVER ZERO, when the master carries no readable ALTERID.
      // Zero is a real Tally counter value — a master altered zero times
      // — and conflating "no cursor" with "the lowest cursor" made the
      // regression guard in 0118 fire on every re-import of such a
      // master: the census would hold 0, the fresh export would offer 0,
      // and any real counter that appeared later looked like progress
      // while the reverse looked like an older file. Unknown is unknown,
      // and the comparison is skipped for it.
      alterId: /^\d{1,15}$/.test(alterId) ? Number(alterId) : null,
      name,
      parentGroup: parent,
      // Resolved once the whole tree is read; the placeholder is replaced
      // below rather than resolved here, because a group may be declared
      // after the ledgers that sit under it.
      groupPath: [],
      classification: 'other',
      gstin,
      openingBalance: exactRupees(opening),
      plCode: code,
      isDeleted: deleted,
      sourceFields,
      // Resolved below, once every name in the export is known.
      nameAmbiguous: false,
      lineNumber: elementLine,
    });
  };

  let lineNumber = 0;
  let lastOffset = 0;
  let sawEnvelopeEnd = false;
  /** The tag of a value that opened with text on its line and has not
   * closed yet. See the skip below. */
  let openValueTag: string | null = null;
  for (const { text: rawLine, offset } of readLines(bytes)) {
    lineNumber += 1;
    lastOffset = offset;
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // A VALUE THAT SPANS LINES SWALLOWS ITS OWN CONTENT, and until it is
    // skipped the scanner reads that content as structure. Tally writes
    // one tag per line, but a NARRATION an operator typed a newline into
    // is written across several — and any line of it that happens to look
    // like `<SOMETHING>` was counted as an element opening, leaving the
    // depth one too deep for the rest of the master. Every direct field
    // after it then read as nested and was dropped, so a ledger could
    // lose its GUID to somebody's typing. Skipping to the close is what
    // keeps a value a value.
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
          'That file does not begin with a Tally <ENVELOPE>. Export All Masters from TallyPrime and upload the XML it writes, unchanged.',
        );
      }
    }

    if (element === null) {
      if (line.startsWith('</ENVELOPE')) sawEnvelopeEnd = true;
      const open = /^<(LEDGER|GROUP)(?:\s|>)/i.exec(line);
      if (open === null) continue;
      element = (open[1] as string).toUpperCase() as 'LEDGER' | 'GROUP';
      elementLine = lineNumber;
      depth = 0;
      const attribute = NAME_ATTRIBUTE.exec(line);
      name = attribute === null ? null : clean(attribute[1] as string);
      parent = '';
      guid = '';
      alterId = '';
      gstinDirect = '';
      gstinNested = '';
      opening = '';
      deleted = false;
      sourceFields = {};
      // A master written as `<LEDGER …/>` — Tally does not, but a
      // self-closing element must not leave the scanner inside a master
      // for the rest of the file.
      if (line.endsWith('/>')) element = null;
      continue;
    }

    if (CLOSE_TAG.exec(line)?.[1]?.toUpperCase() === element && depth === 0) {
      if (element === 'LEDGER') finishLedger();
      else if (name !== null && name.length > 0 && groupParents.size < MAX_GROUPS) {
        groupParents.set(name.toLowerCase(), parent);
      }
      element = null;
      continue;
    }

    const complete = COMPLETE_TAG.exec(line);
    if (complete !== null) {
      const tag = (complete[1] as string).toUpperCase();
      const value = clean(complete[2] as string);
      if (depth === 0) {
        if (tag === 'PARENT') parent = value;
        else if (tag === 'GUID') guid = value;
        else if (tag === 'ALTERID') alterId = value;
        else if (tag === 'PARTYGSTIN') gstinDirect = value;
        else if (tag === 'OPENINGBALANCE') opening = value;
        else if (tag === 'ISDELETED') deleted = value === 'Yes';
        if (
          element === 'LEDGER' &&
          Object.keys(sourceFields).length < MAX_SOURCE_FIELDS &&
          keepSourceField(tag, value)
        ) {
          sourceFields[tag] = value;
        }
      } else if (tag === 'GSTIN' && gstinNested.length === 0) {
        // Inside `LEDGSTREGDETAILS.LIST`, where a ledger's registration
        // details live. 1,373 real ledgers carry one here against 1,047
        // in the direct `PARTYGSTIN`, so reading only the direct tag
        // would have left a quarter of the identifiable parties matching
        // on name alone.
        gstinNested = value;
      }
      continue;
    }

    // `endsWith('/>')` is the guard, not decoration: `<LANGUAGENAME.LIST
    // TYPE="String"/>` satisfies the open-tag shape — the attribute run
    // swallows the slash — and counting it would leave the scanner one
    // level too deep for the rest of the master, hiding every direct
    // field after it.
    if (OPEN_TAG.test(line) && !line.endsWith('/>')) {
      depth += 1;
      continue;
    }
    if (CLOSE_TAG.test(line) && depth > 0) {
      depth -= 1;
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
      'That file does not begin with a Tally <ENVELOPE>. Export All Masters from TallyPrime and upload the XML it writes, unchanged.',
    );
  }

  // A MASTER STILL OPEN AT EOF IS A REFUSAL, NOT A DROP. A file that
  // stops mid-master is a half-written export — a copy taken while
  // TallyPrime was still writing it, or a transfer that failed — and the
  // ledgers before the cut are a real, complete-looking prefix. Importing
  // them silently would leave the census describing a fraction of the
  // chart of accounts, and every count on the report would agree with
  // itself and be wrong. The whole file is refused instead, with where it
  // stops.
  if (element !== null) {
    throw new TallyImportError(
      `That export stops in the middle of a ledger master, ${String(lastOffset)} bytes in. It was not finished being written — export All Masters from TallyPrime again and upload the complete file.`,
      'TALLY_EXPORT_TRUNCATED',
    );
  }
  if (!sawEnvelopeEnd) {
    throw new TallyImportError(
      `That export has no closing </ENVELOPE>, so it stops before Tally finished writing it (${String(lastOffset)} bytes read). Export All Masters from TallyPrime again and upload the complete file.`,
      'TALLY_EXPORT_TRUNCATED',
    );
  }

  // The ancestry, now that every group is known. Root first, ending at the
  // immediate parent, and cycle-guarded: a group tree from a file is a
  // tree because Tally says so, not because anything here checked.
  const resolved: TallyLedger[] = [];
  for (const ledger of ledgers) {
    const path: string[] = [];
    const seen = new Set<string>();
    let current = ledger.parentGroup;
    while (current.length > 0 && !seen.has(current.toLowerCase())) {
      seen.add(current.toLowerCase());
      path.unshift(current);
      current = groupParents.get(current.toLowerCase()) ?? '';
    }
    // 0118 stores the ancestry as a bounded array, and a chart of
    // accounts nested twenty deep is not one Tally produced. Refused with
    // the ledger named rather than met as a 23514 in the middle of the
    // commit; the deepest real path in the export is three.
    if (path.length > MAX_GROUP_DEPTH) {
      if (refusals.length < MAX_REFUSALS) {
        refusals.push({
          lineNumber: ledger.lineNumber,
          ledgerName: ledger.name,
          reason: `This ledger sits ${String(path.length)} groups deep, and this census stores at most ${String(MAX_GROUP_DEPTH)}.`,
        });
      }
      continue;
    }
    resolved.push({
      ...ledger,
      groupPath: path,
      classification: classify(path, ledger.plCode),
      nameAmbiguous: duplicateNames.has(normaliseContactName(ledger.name)),
    });
  }

  return {
    ledgers: resolved,
    groupCount: groupParents.size,
    refusals,
    ambiguousCodeCount,
    malformedGstinCount,
    duplicateNameCount: resolved.filter((ledger) => ledger.nameAmbiguous).length,
  };
}

/* --- proposing a contact --------------------------------------------------- */

/**
 * The contact this ledger names, by GSTIN and then by exact name — owner
 * ruling 8, and `matchContact`'s existing behaviour exactly.
 *
 * The shared matcher is called rather than copied, because "GSTIN first,
 * then exact name, ambiguity matches nothing" is one rule this product
 * applies in two places and a second implementation of it would drift.
 *
 * ONLY PARTY LEDGERS ARE PROPOSED. A security deposit or an FDR is not a
 * contact however closely its name resembles one, and proposing a
 * railway division's SD ledger as the division itself is precisely the
 * kind of confident wrong answer ruling 6 refuses.
 */
export function proposeContact(
  ledger: TallyLedger,
  candidates: readonly ContactCandidate[] | ContactIndex,
): ContactMatch | null {
  if (ledger.classification !== 'customer' && ledger.classification !== 'vendor') {
    return null;
  }
  const subject = { customerGstin: ledger.gstin, customerName: ledger.name };
  // An INDEX or a plain list, because the two callers want different
  // things: a test proposes for one ledger and should not have to build
  // an index, and the route proposes for 4,327 and should not rebuild one
  // per ledger. Same rule either way — `matchContact` is the indexed one
  // with the index built on the spot.
  const match = Array.isArray(candidates)
    ? matchContact(subject, candidates)
    : matchIndexedContact(subject, candidates as ContactIndex);
  // A name shared with another master is not evidence about either of
  // them. The GSTIN arm is unaffected — that is a different identifier
  // and it is the one the ruling prefers anyway.
  if (match?.method === 'name' && ledger.nameAmbiguous) return null;
  return match;
}
