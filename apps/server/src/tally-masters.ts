/**
 * Reading TallyPrime's `All Masters` export into the ledger census
 * (migration 0118).
 *
 * ## Why this is a line scanner and not an XML parser
 *
 * The real export is 133 MB of UTF-16LE with a byte-order mark, no XML
 * declaration, and character references like `&#4;` in operator-typed
 * fields. `&#4;` is illegal in XML 1.0, so expat — and therefore every
 * DOM and SAX parser in the ecosystem — refuses the whole file on the
 * first one. The document is also 95 % Tally engine flags: a ledger
 * master carries about 150 boolean tags, one per line, of which this
 * census reads nine.
 *
 * So the file is read the way `docs/reference/TALLY-MAPPING-CENSUS.md`
 * surveyed it: one tag per line, a line at a time, straight off the
 * bytes. Nothing here builds a tree, and the peak memory is the upload
 * buffer plus the ledgers found so far — not a DOM of a 133 MB document.
 *
 * ## Bounded, because the input is a file
 *
 * A reader whose loop is driven by the shape of untrusted bytes needs a
 * ceiling on every axis the bytes control: the length of one line, the
 * number of ledgers, the number of refusals collected, and the size of
 * the per-ledger field bag. Each is stated below with the real figure it
 * is sized against, and each refuses rather than growing.
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
  type ContactCandidate,
  type ContactMatch,
  matchContact,
} from './zoho-invoices.js';

/* --- ceilings -------------------------------------------------------------- */

/**
 * The longest single line this reader will assemble, in UTF-16 code
 * units. Tally writes one tag per line and the longest real line in the
 * 133 MB export is a few hundred characters; 64 Ki is four orders of
 * magnitude of headroom and still refuses a file with no newlines in it
 * at all, which is the shape that would otherwise be concatenated into
 * one string the size of the upload.
 */
const MAX_LINE_LENGTH = 64 * 1024;

/**
 * The most ledgers one export may declare. The real file holds 4,327;
 * ten times that is a company an order of magnitude larger than this one
 * and still a bounded array.
 */
const MAX_LEDGERS = 50_000;

/** The most groups. 159 real, same reasoning. */
const MAX_GROUPS = 20_000;

/**
 * How many named refusals travel back. A file that produces more than
 * this is not a file with some bad rows in it; the preview says so and
 * names the first two hundred, which is more than an operator reads.
 */
const MAX_REFUSALS = 200;

/**
 * The most non-boolean fields kept per ledger in `sourceFields`. A real
 * ledger yields about a dozen.
 */
const MAX_SOURCE_FIELDS = 60;

/* --- refusals -------------------------------------------------------------- */

/** A refusal about the whole file: it is not a Tally masters export, or
 * it exceeds a ceiling. Nothing is imported. */
export class TallyMasterImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TallyMasterImportError';
  }
}

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
   * post-training top-up re-read uses (owner ruling 2). */
  readonly alterId: number;
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

/* --- decoding -------------------------------------------------------------- */

/**
 * The five named entities XML defines, and numeric references.
 *
 * A reference to a CONTROL CHARACTER is dropped rather than decoded, and
 * that is the whole reason this function is written out. The export
 * carries `&#4;` in operator-typed fields — illegal in XML 1.0, which is
 * why no parser will open the file — and decoding it would put a U+0004
 * into a text column every `!~ '[[:cntrl:]]'` CHECK in this schema
 * refuses. Dropping it reproduces what the operator meant and what Tally
 * itself displays.
 */
function decodeEntities(value: string): string {
  return value.replaceAll(
    /&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#[xX]([\dA-Fa-f]{1,6}));/g,
    (
      whole,
      named: string | undefined,
      decimal: string | undefined,
      hex: string | undefined,
    ) => {
      if (named !== undefined) {
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named] ?? whole;
      }
      const code =
        decimal === undefined ? Number.parseInt(hex ?? '0', 16) : Number(decimal);
      // Unpaired surrogates and out-of-range code points would produce a
      // lone U+FFFD or throw; both are dropped for the same reason as the
      // control characters.
      if (!Number.isInteger(code) || code <= 0 || code > 0x10_ff_ff) return '';
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return '';
      if (code >= 0xd8_00 && code <= 0xdf_ff) return '';
      return String.fromCodePoint(code);
    },
  );
}

/** Entity-decoded, control characters removed, ends trimmed. Every value
 * this reader keeps goes through it, so no column can receive a control
 * character the database would refuse as a 500. */
function clean(value: string): string {
  return decodeEntities(value)
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
}

/* --- the line scanner ------------------------------------------------------ */

/**
 * Yields the file's lines without ever materialising it as one string.
 *
 * The export is UTF-16LE with a BOM. Lines are found by searching for the
 * newline's OWN BYTES and each line is decoded on its own, so the peak
 * cost is one line rather than 133 MB of text — which is the difference
 * between this reader and `bytes.toString()` followed by `split`.
 *
 * A match is only accepted at an EVEN offset. `0A 00` can occur straddling
 * two characters — a U+0A?? followed by a U+??00 — and reading that as a
 * line break would split a line in the middle of a character. It does not
 * happen in this export; it costs one modulo to make impossible.
 */
function* readLines(bytes: Buffer): Generator<string> {
  const utf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  const encoding: BufferEncoding = utf16 ? 'utf16le' : 'utf8';
  const newline = Buffer.from('\n', encoding);
  const step = utf16 ? 2 : 1;
  let start = utf16 ? 2 : 0;
  while (start < bytes.length) {
    let index = bytes.indexOf(newline, start);
    while (utf16 && index !== -1 && (index - 2) % 2 !== 0) {
      index = bytes.indexOf(newline, index + 1);
    }
    const end = index === -1 ? bytes.length : index;
    if (end - start > MAX_LINE_LENGTH * step) {
      throw new TallyMasterImportError(
        'That file has a line longer than this reader will assemble, so it is not the one-tag-per-line export Tally writes. Export All Masters from TallyPrime again without reformatting the file.',
      );
    }
    yield bytes.toString(encoding, start, end);
    if (index === -1) return;
    start = index + newline.length;
  }
}

/* --- one line, structurally ------------------------------------------------ */

/** `<TAG …>value</TAG>` closed on its own line. Tally writes every value
 * this way. The tag name is bounded so a hostile line cannot make the
 * expression walk far, and the value is captured lazily to the LAST
 * closing tag on the line rather than the first, which is what a value
 * containing an escaped `<` needs. */
// Linear on every input, and the two bounds are why: the tag name is
// capped at 64 characters, and `[^>]*` cannot cross the `>` that must
// follow it — so the attribute run has exactly ONE possible extent rather
// than a range the engine can explore. Only `[\s\S]*` backtracks, once,
// looking for the closing tag. `zoho-invoices.ts` waives the same rule for
// the same reason.
// eslint-disable-next-line security/detect-unsafe-regex
const COMPLETE_TAG = /^<([A-Z0-9._:]{1,64})(?:\s[^>]*)?>([\s\S]*)<\/\1>$/i;
/** `<TAG …>` with nothing after it: an element that opens here. */
// eslint-disable-next-line security/detect-unsafe-regex
const OPEN_TAG = /^<([A-Z0-9._:]{1,64})(?:\s[^>]*)?>$/i;
/** `</TAG>` */
const CLOSE_TAG = /^<\/([A-Z0-9._:]{1,64})>$/i;
/** The `NAME` attribute, which is where Tally puts a master's own name. */
const NAME_ATTRIBUTE = /\sNAME="([^"]*)"/i;

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
 */
const LEDGER_PL_CODE = /(?<![A-Za-z0-9])PL[-. ]?(\d{1,4})(?!\d)/gi;

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
    // Leading zeros stripped so `PL-07` and `PL-7` are one code. The
    // canonical spelling is what a later wave joins on `works.work_code`;
    // the name itself keeps whatever the operator typed.
    found.add(`PL-${(match[1] ?? '').replace(/^0+(?=\d)/, '')}`);
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

/** An exact rupee figure, or null. A balance is EVIDENCE in this census
 * and nothing computes with it, so a malformed one nulls the column
 * rather than refusing a ledger that is otherwise perfectly readable. */
function balance(value: string): string | null {
  const text = value.replace(/\s+/g, '');
  if (text.length === 0) return null;
  // Every quantifier is bounded and no two of them can consume the same
  // character, so this is linear — `money.ts` waives the rule for the same
  // lexeme.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(-?)(\d{1,15})(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) return null;
  return `${match[1] ?? ''}${match[2] ?? ''}.${(match[3] ?? '').padEnd(2, '0')}`;
}

/**
 * Which direct fields are worth keeping verbatim.
 *
 * `Yes`/`No` are dropped, and that single rule removes about 150 of the
 * ~165 tags on a real ledger master: they are Tally engine flags —
 * `ISBNFCODESUPPORTED`, `INTERESTINCLDAYOFADDITION` — that say nothing
 * about the party. What is left is the dozen fields that carry meaning.
 *
 * This is 0115's `raw_row` discipline, trimmed to the shape of a
 * different file. 0115 keeps every cell because a Zoho export's 193
 * columns are all somebody's data; keeping every tag here would store 13
 * MB of the word "No" to preserve nothing.
 */
function keepSourceField(tag: string, value: string): boolean {
  if (value.length === 0 || value.length > 2000) return false;
  if (value === 'Yes' || value === 'No') return false;
  return !tag.endsWith('.LIST');
}

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
    if (name.length > 300) {
      refuse(
        'This ledger master’s name is longer than this census stores (300 characters).',
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
      throw new TallyMasterImportError(
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
    const lowered = name.toLowerCase();
    if (seenNames.has(lowered)) duplicateNames.add(lowered);
    seenNames.add(lowered);
    ledgers.push({
      guid,
      // A missing or unreadable ALTERID is 0 rather than a refusal: it is
      // an edit cursor for a later re-read, and a census row without one
      // is still a census row.
      alterId: /^\d{1,15}$/.test(alterId) ? Number(alterId) : 0,
      name,
      parentGroup: parent,
      // Resolved once the whole tree is read; the placeholder is replaced
      // below rather than resolved here, because a group may be declared
      // after the ledgers that sit under it.
      groupPath: [],
      classification: 'other',
      gstin,
      openingBalance: balance(opening),
      plCode: code,
      isDeleted: deleted,
      sourceFields,
      // Resolved below, once every name in the export is known.
      nameAmbiguous: false,
      lineNumber: elementLine,
    });
  };

  let lineNumber = 0;
  for (const rawLine of readLines(bytes)) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (!sawEnvelope) {
      if (line.startsWith('<ENVELOPE')) sawEnvelope = true;
      else if (lineNumber > 20) {
        throw new TallyMasterImportError(
          'That file does not begin with a Tally <ENVELOPE>. Export All Masters from TallyPrime and upload the XML it writes, unchanged.',
        );
      }
    }

    if (element === null) {
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
    if (OPEN_TAG.test(line) && !line.endsWith('/>')) depth += 1;
    else if (CLOSE_TAG.test(line) && depth > 0) depth -= 1;
  }

  if (!sawEnvelope) {
    throw new TallyMasterImportError(
      'That file does not begin with a Tally <ENVELOPE>. Export All Masters from TallyPrime and upload the XML it writes, unchanged.',
    );
  }

  // The ancestry, now that every group is known. Root first, ending at the
  // immediate parent, and cycle-guarded: a group tree from a file is a
  // tree because Tally says so, not because anything here checked.
  const resolved = ledgers.map((ledger) => {
    const path: string[] = [];
    const seen = new Set<string>();
    let current = ledger.parentGroup;
    while (current.length > 0 && !seen.has(current.toLowerCase())) {
      seen.add(current.toLowerCase());
      path.unshift(current);
      current = groupParents.get(current.toLowerCase()) ?? '';
    }
    return {
      ...ledger,
      groupPath: path,
      classification: classify(path, ledger.plCode),
      nameAmbiguous: duplicateNames.has(ledger.name.toLowerCase()),
    };
  });

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
  candidates: readonly ContactCandidate[],
): ContactMatch | null {
  if (ledger.classification !== 'customer' && ledger.classification !== 'vendor') {
    return null;
  }
  const match = matchContact(
    { customerGstin: ledger.gstin, customerName: ledger.name },
    candidates,
  );
  // A name shared with another master is not evidence about either of
  // them. The GSTIN arm is unaffected — that is a different identifier
  // and it is the one the ruling prefers anyway.
  if (match?.method === 'name' && ledger.nameAmbiguous) return null;
  return match;
}
