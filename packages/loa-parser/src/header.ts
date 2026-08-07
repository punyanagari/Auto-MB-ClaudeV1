/**
 * @auto-mb/loa-parser — LOA header/prose extraction (DC-23; tickets/DC-23.md;
 * research/DC-32-loa-parser-contract.md §3).
 *
 * `extractHeader` is the single entry point: it strips print furniture
 * FIRST (furniture.ts, per the ticket's ordering requirement), then locates
 * every header/prose field research §3 names. A field this module cannot
 * confidently locate is emitted `{ value: null, raw: <candidate text>,
 * needsReview: true }` — never a partial or guessed value (field.ts).
 *
 * Every regex here is anchored against phrasing verified byte-for-byte
 * across all six corpus fixtures (packages/loa/fixtures/*.txt via
 * loadCorpus()) — this module never reads a fixture file directly.
 */
import { parseDdMmYyyy } from './dates.js';
import { found, notFound, optionalAbsent, preview, type FieldResult } from './field.js';
import { stripPrintFurniture } from './furniture.js';
import { extractLetterNumberAndDate } from './letter-number.js';
import { flatten, hyphenJoin, paragraphs } from './text.js';
import { parseRupeesWords } from './words-to-number.js';

const ITEM_TABLE_MARKER = 'Awarded Quantities And Rates';

export interface ContractValueField {
  readonly figures: number | null;
  readonly words: string | null;
  readonly raw: string | null;
  /** true when either half is missing, OR both are present but disagree
   * (research §1/§4; tickets/DC-23.md: "a mismatch raises needsReview
   * rather than the parser picking one"). */
  readonly needsReview: boolean;
}

export interface EmdField {
  readonly amount: number | null;
  /** Verbatim as printed — PL270-CRB carries two comma-separated IREPS
   * reference IDs against a single EMD figure, so this is not assumed to be
   * a single token. */
  readonly irepsReferenceId: string | null;
  readonly raw: string | null;
  readonly needsReview: boolean;
}

export interface SecurityDepositField {
  readonly recoveryPercent: number | null;
  readonly capPercent: number | null;
  /** The clause citation as printed — its shape varies a great deal across
   * the corpus ("clause 16.1 of GCC-2022", "clause 20 of Part II of tender
   * document", "clause 2.7 of Chapter II of Tender Document") so this is
   * carried verbatim rather than decomposed. */
  readonly clauseReference: string | null;
  readonly raw: string | null;
  readonly needsReview: boolean;
}

export interface PerformanceGuaranteeField {
  readonly amountFigures: number | null;
  readonly amountWords: string | null;
  readonly submissionDays: number | null;
  readonly extensionDays: number | null;
  readonly penalInterestPercent: number | null;
  readonly raw: string | null;
  readonly needsReview: boolean;
}

export interface CompletionPeriodField {
  readonly value: number | null;
  readonly unit: string | null;
  readonly raw: string | null;
  readonly needsReview: boolean;
}

export interface LoaHeader {
  readonly zone: FieldResult<string>;
  readonly division: FieldResult<string>;
  readonly officeAddress: FieldResult<string>;
  readonly letterNumber: FieldResult<string>;
  readonly letterDate: FieldResult<string>;
  readonly tenderNumber: FieldResult<string>;
  readonly tenderClosingDate: FieldResult<string>;
  readonly workDescription: FieldResult<string>;
  readonly bidId: FieldResult<string>;
  readonly bidDate: FieldResult<string>;
  readonly contractorName: FieldResult<string>;
  readonly contractorAddress: FieldResult<string>;
  readonly contractValue: ContractValueField;
  readonly emd: EmdField;
  readonly securityDeposit: SecurityDepositField;
  readonly performanceGuarantee: PerformanceGuaranteeField;
  readonly completionPeriod: CompletionPeriodField;
  readonly consignee: FieldResult<string>;
  readonly officerInCharge: FieldResult<string>;
  readonly signatoryName: FieldResult<string>;
  readonly signatoryDesignation: FieldResult<string>;
  readonly gccVersion: FieldResult<string>;
  /** Present only in PL280-ADI (research §3). Absence is normal, not an
   * anomaly: `optionalAbsent()` (needsReview: false), never `notFound()`. */
  readonly fileNo: FieldResult<string>;
}

function headerTextOf(rawText: string): string {
  const stripped = stripPrintFurniture(rawText);
  const markerIdx = stripped.indexOf(ITEM_TABLE_MARKER);
  return markerIdx === -1 ? stripped : stripped.slice(0, markerIdx);
}

// ---------------------------------------------------------------------------
// zone / division / office address
// ---------------------------------------------------------------------------

function extractZoneDivisionAddress(headerText: string): {
  zone: FieldResult<string>;
  division: FieldResult<string>;
  officeAddress: FieldResult<string>;
} {
  const lines = headerText.split('\n');
  const zoneIdx = lines.findIndex((l) => l.trim().length > 0);
  if (zoneIdx === -1) {
    return {
      zone: notFound(null),
      division: notFound(null),
      officeAddress: notFound(null),
    };
  }
  const zoneLine = (lines[zoneIdx] ?? '').trim();
  const zone = found(zoneLine, zoneLine);

  const letterNoIdx = lines.findIndex((l) => /Letter No\s*:/.test(l));
  const blockEnd = letterNoIdx === -1 ? lines.length : letterNoIdx;
  const blockLines = lines
    .slice(zoneIdx + 1, blockEnd)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (blockLines.length === 0) {
    const raw = preview(zoneLine);
    return { zone, division: notFound(raw), officeAddress: notFound(raw) };
  }

  // Every letter's printed division name ends "... DIVISION-S AND T"
  // (research §0's corpus — verified line-by-line on all six fixtures).
  const andTLineIdx = blockLines.findIndex((l) => l.includes('AND T'));
  if (andTLineIdx === -1) {
    const raw = preview(blockLines.join('\n'));
    return { zone, division: notFound(raw), officeAddress: notFound(raw) };
  }

  const divisionLines = blockLines.slice(0, andTLineIdx + 1);
  const addressLines = blockLines.slice(andTLineIdx + 1);
  const divisionValue = hyphenJoin(divisionLines);
  const officeAddressValue = addressLines.join(' ').trim();

  return {
    zone,
    division: found(divisionValue, divisionLines.join('\n')),
    officeAddress:
      officeAddressValue.length > 0
        ? found(officeAddressValue, addressLines.join('\n'))
        : notFound(preview(blockLines.join('\n'))),
  };
}

// ---------------------------------------------------------------------------
// contractor name / address
// ---------------------------------------------------------------------------

function extractContractorNameAddress(headerText: string): {
  contractorName: FieldResult<string>;
  contractorAddress: FieldResult<string>;
} {
  const lines = headerText.split('\n');
  const subIdx = lines.findIndex((l) => /Sub\s*:/.test(l));
  const mSlashIdx = lines.findIndex((l) => /^\s*M\/s\b/.test(l));

  if (mSlashIdx === -1 || subIdx === -1 || mSlashIdx >= subIdx) {
    const raw = preview(headerText.slice(0, 800));
    return { contractorName: notFound(raw), contractorAddress: notFound(raw) };
  }

  const blockLines = lines
    .slice(mSlashIdx, subIdx)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // The address always starts at the "S.No" street-address marker (verified
  // on all six fixtures).
  const addressStartIdx = blockLines.findIndex((l) => /^S\.?\s*No\b/i.test(l));
  const nameLines =
    addressStartIdx === -1 ? blockLines : blockLines.slice(0, addressStartIdx);
  const addressLines = addressStartIdx === -1 ? [] : blockLines.slice(addressStartIdx);

  const nameValue = hyphenJoin(nameLines);
  const addressValue = addressLines.join(' ').trim();

  return {
    contractorName:
      nameValue.length > 0
        ? found(nameValue, nameLines.join('\n'))
        : notFound(preview(blockLines.join('\n'))),
    contractorAddress:
      addressValue.length > 0
        ? found(addressValue, addressLines.join('\n'))
        : notFound(preview(blockLines.join('\n'))),
  };
}

// ---------------------------------------------------------------------------
// tender number / closing date / work description / bid id / bid date
// ---------------------------------------------------------------------------

const TENDER_RE =
  /Tender No\.\s*(.+?)\s+closing date\s+(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{4})/i;
const WORK_DESC_RE =
  /closing date\s+\d{1,2}\s*-\s*\d{1,2}\s*-\s*\d{4}\s+\d{1,2}:\d{2}\s+for\s+(.+?)\s+\d\.\s*Your bid ID/i;
const BID_RE =
  /Your bid ID\s+(\d+)\s+dated\s+(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/i;

function extractTenderAndBid(flat: string): {
  tenderNumber: FieldResult<string>;
  tenderClosingDate: FieldResult<string>;
  workDescription: FieldResult<string>;
  bidId: FieldResult<string>;
  bidDate: FieldResult<string>;
} {
  const tenderMatch = TENDER_RE.exec(flat);
  let tenderNumber: FieldResult<string>;
  let tenderClosingDate: FieldResult<string>;
  if (tenderMatch === null) {
    const raw = preview(flat.slice(0, 400));
    tenderNumber = notFound(raw);
    tenderClosingDate = notFound(raw);
  } else {
    const [full, number, day, month, year] = tenderMatch;
    tenderNumber = found((number ?? '').trim(), full ?? '');
    const iso = parseDdMmYyyy(`${day ?? ''}-${month ?? ''}-${year ?? ''}`);
    tenderClosingDate = iso === null ? notFound(full ?? null) : found(iso, full ?? '');
  }

  const workDescMatch = WORK_DESC_RE.exec(flat);
  const workDescription: FieldResult<string> =
    workDescMatch === null
      ? notFound(preview(flat.slice(0, 400)))
      : found((workDescMatch[1] ?? '').trim(), workDescMatch[0]);

  const bidMatch = BID_RE.exec(flat);
  let bidId: FieldResult<string>;
  let bidDate: FieldResult<string>;
  if (bidMatch === null) {
    const raw = preview(flat.slice(0, 400));
    bidId = notFound(raw);
    bidDate = notFound(raw);
  } else {
    const [full, id, day, month, year] = bidMatch;
    bidId = found((id ?? '').trim(), full ?? '');
    const iso = parseDdMmYyyy(`${day ?? ''}/${month ?? ''}/${year ?? ''}`);
    bidDate = iso === null ? notFound(full ?? null) : found(iso, full ?? '');
  }

  return { tenderNumber, tenderClosingDate, workDescription, bidId, bidDate };
}

// ---------------------------------------------------------------------------
// contract value (figures + words, mismatch -> needsReview)
// ---------------------------------------------------------------------------

const CONTRACT_VALUE_RE = /works out to Rs\.\s*([\d,]+(?:\.\d+)?)\s*\(([^)]+?)\)/i;

function parseFigures(raw: string): number | null {
  const n = Number.parseFloat(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function valuesMatch(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

function extractContractValue(flat: string): ContractValueField {
  const m = CONTRACT_VALUE_RE.exec(flat);
  if (m === null) {
    return {
      figures: null,
      words: null,
      raw: preview(flat.slice(0, 400)),
      needsReview: true,
    };
  }
  const [full, figuresRaw, wordsRaw] = m;
  const figures = parseFigures(figuresRaw ?? '');
  const words = (wordsRaw ?? '').trim();
  const wordsValue = parseRupeesWords(words);
  const needsReview =
    figures === null || wordsValue === null || !valuesMatch(figures, wordsValue);
  return {
    figures,
    words: words.length > 0 ? words : null,
    raw: full ?? null,
    needsReview,
  };
}

// ---------------------------------------------------------------------------
// EMD
// ---------------------------------------------------------------------------

const EMD_RE =
  /A sum of Rs\.\s*([\d,]+(?:\.\d+)?)\s+deposited as Earnest Money vide IREPS reference ID\s+([A-Za-z0-9]+(?:\s*,\s*[A-Za-z0-9]+)*)\s+has been retained/i;

function extractEmd(flat: string): EmdField {
  const m = EMD_RE.exec(flat);
  if (m === null) {
    return {
      amount: null,
      irepsReferenceId: null,
      raw: preview(flat.slice(0, 400)),
      needsReview: true,
    };
  }
  const [full, amountRaw, refId] = m;
  const amount = parseFigures(amountRaw ?? '');
  return {
    amount,
    irepsReferenceId: (refId ?? '').trim(),
    raw: full ?? null,
    needsReview: amount === null,
  };
}

// ---------------------------------------------------------------------------
// security deposit
// ---------------------------------------------------------------------------

// The clause-reference capture must tolerate a "." INSIDE the clause number
// itself (e.g. "clause 16.1", "clause 2.7") without stopping there — only a
// "." that is NOT immediately followed by a digit is the real sentence
// terminator. `(?:[^.]|\.(?=\d))+` expresses exactly that: any non-period
// character, or a period that IS followed by a digit.
const SECURITY_DEPOSIT_RE =
  /recovered from the progressive bills\s*@\s*(\d+(?:\.\d+)?)\s*%\s*of the bill amount till it reaches\s*(\d+(?:\.\d+)?)\s*%\s*of the contract value in terms of\s+(clause\s+(?:[^.]|\.(?=\d))+)\./i;

function extractSecurityDeposit(flat: string): SecurityDepositField {
  const m = SECURITY_DEPOSIT_RE.exec(flat);
  if (m === null) {
    return {
      recoveryPercent: null,
      capPercent: null,
      clauseReference: null,
      raw: preview(flat.slice(0, 400)),
      needsReview: true,
    };
  }
  const [full, recovery, cap, clause] = m;
  const recoveryPercent = parseFigures(recovery ?? '');
  const capPercent = parseFigures(cap ?? '');
  const clauseReference = (clause ?? '').trim();
  return {
    recoveryPercent,
    capPercent,
    clauseReference: clauseReference.length > 0 ? clauseReference : null,
    raw: full ?? null,
    needsReview:
      recoveryPercent === null || capPercent === null || clauseReference.length === 0,
  };
}

// ---------------------------------------------------------------------------
// performance guarantee
// ---------------------------------------------------------------------------

const PG_RE =
  /amounting to Rs\.\s*([\d,]+(?:\.\d+)?)\s*\(([^)]+?)\)\s*within\s+(\d+)\s+days\s+from the date of issue of Letter of Acceptance,\s*valid up to stipulated date of completion plus\s+(\d+)\s+days/i;
const PENAL_INTEREST_RE = /penal\s*interest of\s+(\d+(?:\.\d+)?)\s*%?\s*per annum/i;

function extractPerformanceGuarantee(flat: string): PerformanceGuaranteeField {
  const m = PG_RE.exec(flat);
  const penalMatch = PENAL_INTEREST_RE.exec(flat);
  const penalInterestPercent =
    penalMatch === null ? null : parseFigures(penalMatch[1] ?? '');

  if (m === null) {
    return {
      amountFigures: null,
      amountWords: null,
      submissionDays: null,
      extensionDays: null,
      penalInterestPercent,
      raw: preview(flat.slice(0, 400)),
      needsReview: true,
    };
  }

  const [full, amountRaw, wordsRaw, submissionRaw, extensionRaw] = m;
  const amountFigures = parseFigures(amountRaw ?? '');
  const amountWords = (wordsRaw ?? '').trim();
  const submissionDays = Number.parseInt(submissionRaw ?? '', 10);
  const extensionDays = Number.parseInt(extensionRaw ?? '', 10);
  const wordsValue = parseRupeesWords(amountWords);

  const needsReview =
    amountFigures === null ||
    wordsValue === null ||
    !valuesMatch(amountFigures, wordsValue) ||
    !Number.isInteger(submissionDays) ||
    !Number.isInteger(extensionDays) ||
    penalInterestPercent === null;

  return {
    amountFigures,
    amountWords: amountWords.length > 0 ? amountWords : null,
    submissionDays: Number.isInteger(submissionDays) ? submissionDays : null,
    extensionDays: Number.isInteger(extensionDays) ? extensionDays : null,
    penalInterestPercent,
    raw: full ?? null,
    needsReview,
  };
}

// ---------------------------------------------------------------------------
// completion period
// ---------------------------------------------------------------------------

const COMPLETION_RE =
  /entire work shall be completed within\s+(\d+)\s+(month|months|day|days|year|years)\s+from the date of issue/i;

function extractCompletionPeriod(flat: string): CompletionPeriodField {
  const m = COMPLETION_RE.exec(flat);
  if (m === null) {
    return {
      value: null,
      unit: null,
      raw: preview(flat.slice(0, 400)),
      needsReview: true,
    };
  }
  const [full, valueRaw, unit] = m;
  const value = Number.parseInt(valueRaw ?? '', 10);
  return {
    value: Number.isInteger(value) ? value : null,
    unit: (unit ?? '').trim(),
    raw: full ?? null,
    needsReview: !Number.isInteger(value),
  };
}

// ---------------------------------------------------------------------------
// consignee / officer-in-charge (paragraph-anchored — free-form prose)
// ---------------------------------------------------------------------------

const CONSIGNEE_LABEL_RE = /^Consignee\s*:\s*:?\s*/i;
const CONSIGNEE_ALT_RE = /consignee of the work will be\s+([^.]+)\./i;
const CONSIGNEE_PRESENCE_RE = /^Consignee\s*:|consignee of the work will be/i;

/** True when a candidate value packs MORE THAN ONE "<X> will be <role>"
 * role-mapping into a single string (e.g. PL280-ADI's "a. ... will be
 * SSE/Tele/MSH b. ... will be SSE/Tele/MSH c. ... will be ADSTE/MSH", or
 * PL270-CRB's five-sentence consignee paragraph). research §3 calls the
 * field "consignee(s)" — plural — precisely because a letter can name
 * several role-holders in one block. DC-23 review round 1 [m2]: pinning such
 * a paragraph as a single value with `needsReview: false` overstates
 * confidence that this string IS "the" consignee rather than several
 * candidates a human still needs to disambiguate. POLICY (documented here,
 * the one place both extractConsignee and its test read): a value with 0 or
 * 1 "will be" clause is a single, confidently-extracted fact
 * (`needsReview: false`); a value with 2+ is compound prose — retained in
 * full (nothing discarded) but flagged `needsReview: true` so a reviewer
 * resolves which role-holder(s) are the actual consignee(s) before a
 * downstream consumer trusts a single string. */
function isCompoundRoleProse(value: string): boolean {
  const willBeCount = value.match(/\bwill\s+be\b/gi)?.length ?? 0;
  return willBeCount > 1;
}

function extractConsignee(paras: readonly string[]): FieldResult<string> {
  const para = paras.find((p) => CONSIGNEE_PRESENCE_RE.test(p));
  if (para === undefined) {
    // [m1] Retain a candidate raw block even when no Consignee: paragraph
    // exists: the nearest related prose is wherever officer-in-charge /
    // incharge role assignments are stated (e.g. PL276-GTL's "Incharges:"
    // paragraph, PL276-GTL.txt:76) — a reviewer chasing this field down
    // starts there, not at an empty candidate.
    const nearby = paras.find((p) => OFFICER_PRESENCE_RE.test(p));
    return notFound(nearby ?? null);
  }
  if (CONSIGNEE_LABEL_RE.test(para)) {
    const value = para.replace(CONSIGNEE_LABEL_RE, '').trim();
    return { value, raw: para, needsReview: isCompoundRoleProse(value) };
  }
  const altMatch = CONSIGNEE_ALT_RE.exec(para);
  if (altMatch !== null) {
    const value = (altMatch[1] ?? '').trim();
    return { value, raw: para, needsReview: isCompoundRoleProse(value) };
  }
  return { value: para, raw: para, needsReview: isCompoundRoleProse(para) };
}

// Case-insensitive: the corpus spells this every possible way — "Officer
// incharge" (PL273, lowercase), "Officer In Charge" (PL275), "Officer
// In-charge" (PL276), "Engineer Incharge" (PL281), "Engineer In charge"
// (PL280), "Engineering Incharge" (PL270).
const OFFICER_LABEL =
  '(?:Officer\\s*In-?\\s*charge|Engineer\\s*In-?\\s*charge|Engineering\\s*Incharge)';
const OFFICER_PRESENCE_RE = new RegExp(OFFICER_LABEL, 'i');
// The corpus uses both sentence shapes: LABEL-FIRST ("The Officer In Charge
// of the Work will be ADSTE/HSR.", "Engineer Incharge: ADSTE/..."), and
// VALUE-FIRST ("...DSTE/JHS & ADSTE/GWL will be the Officer incharge of the
// work.", "Sr.DSTE/Co/BB will be Engineering Incharge."). Each candidate is
// tried in order; the first with a non-empty capture wins.
const OFFICER_COLON_RE = new RegExp(`${OFFICER_LABEL}\\s*:\\s*([^.\\n]+)`, 'i');
const OFFICER_LABEL_FIRST_RE = new RegExp(
  `${OFFICER_LABEL}(?:\\s+of\\s+the\\s+work)?\\s+(?:will be|shall be)\\s*([^.]+)`,
  'i',
);
// The VALUE-FIRST target: "<subject> will be [the] <label>" (e.g. "...ADSTE/
// GWL will be the Officer incharge of the work."). Deliberately NOT a single
// regex with a `(?:(?!\bwill\s+be\b)[^.])+?`-style negative-lookahead
// capture group: DC-23 review round 1 [M1] measured that shape finding its
// leftmost SUCCESSFUL match starting mid-word, INSIDE the earlier "will be"
// it was meant to exclude (JS tries start positions left-to-right and a
// negative lookahead only blocks a start position that itself begins "will
// be" — a start one character in, e.g. "ill be...", is not blocked, and
// succeeds first) — on PL273-JHS's "...GWL will be consignee and DSTE/JHS &
// ADSTE/GWL will be the Officer incharge...", it captured "ill be consignee
// and DSTE/JHS & ADSTE/GWL" instead of "DSTE/JHS & ADSTE/GWL". Locating the
// anchor first and then splitting the text before it on the LAST "and" is
// immune to that class of bug by construction (extractValueFirstOfficer,
// below).
const OFFICER_VALUE_FIRST_TARGET_RE = new RegExp(
  `\\bwill\\s+be\\s+(?:the\\s+)?${OFFICER_LABEL}`,
  'i',
);
const OFFICER_LABEL_STRIP_RE = /^(?:Consignee|Incharges?)\s*:\s*:?\s*/i;

/**
 * Extracts the VALUE-FIRST shape's subject: the text immediately before
 * "will be [the] <officer label>", narrowed to the LAST coordinating clause
 * (split on "and") so a preceding, unrelated role-mapping earlier in the
 * same paragraph ("SSE/TELE/GWL will be consignee and DSTE/JHS & ADSTE/GWL
 * will be the Officer incharge...") does not bleed into the captured value.
 * Verified against PL273-JHS (-> "DSTE/JHS & ADSTE/GWL") and PL270-CRB's
 * "Sr.DSTE/Co/BB will be Engineering Incharge." (-> "Sr.DSTE/Co/BB", no
 * "and" present so the whole prefix is kept).
 *
 * [R1, DC-23 review round 2]: the split-on-"and" heuristic is guarded, not
 * unconditional. TRUNCATION DIRECTION this guards against: an unconditional
 * "take the last clause after the last 'and'" would silently DROP the
 * earlier part of a legitimate subject phrase that happens to contain the
 * literal word "and" as ordinary conjunction rather than as a role-mapping
 * separator — reviewer-demonstrated synthetically by mutating PL273-JHS's
 * "&" to "and" ("...DSTE/JHS and ADSTE/GWL will be the Officer
 * incharge..."), which an unguarded split turns into "ADSTE/GWL" alone with
 * `needsReview: false` — a PARTIAL value carried confidently, exactly the
 * "nothing... guessed" failure DC-23 exists to prevent. The corpus never
 * exercises this path (every "and" split point actually taken in a
 * value-first subject prefix is a genuine role-mapping separator on all six
 * letters — verified below and by the snapshot-unchanged check in
 * header-normalise.test.ts), but the guard is cheap and every later parser
 * ticket (DC-24..28) inherits this module. The guard checks only the split
 * point actually being relied on — the clause IMMEDIATELY BEFORE the one
 * being kept (`clauses[clauses.length - 2]`), not every earlier clause: a
 * paragraph legitimately has clauses further back that are not themselves
 * "X will be Y" role-mappings (PL273-JHS's own discarded first clause,
 * "SSE/TELE/ML/JHS", is just a name — requiring EVERY discarded clause to
 * contain "will be" was measured to reject that real, correct split, because
 * PL273-JHS's prefix contains TWO "and"s, not one: "...JHS and
 * SSE/TELE/GWL will be consignee and DSTE/JHS & ADSTE/GWL..."). What must
 * hold is that the clause bordering the LAST "and" — the one whose end we
 * are trusting as a boundary — is itself a complete "X will be Y" mapping;
 * that's the only proof available that this specific "and" coordinates two
 * independent clauses rather than joining two words inside one subject.
 * When the guard fails, the WHOLE prefix is kept (nothing discarded) and
 * `needsReview` is raised instead — partial+confident becomes
 * whole+flagged.
 */
function extractValueFirstOfficer(
  para: string,
): { readonly value: string; readonly needsReview: boolean } | null {
  const target = OFFICER_VALUE_FIRST_TARGET_RE.exec(para);
  if (target === null) {
    return null;
  }
  const prefix = para.slice(0, target.index).trim();
  if (prefix.length === 0) {
    return null;
  }
  const clauses = prefix.split(/\band\b/i);
  if (clauses.length === 1) {
    // No "and" in the prefix at all — nothing to guard against.
    return { value: prefix, needsReview: false };
  }
  const lastClause = (clauses[clauses.length - 1] ?? '').trim();
  const precedingClause = clauses[clauses.length - 2] ?? '';
  const lastAndIsARoleMappingBoundary = /\bwill\s+be\b/i.test(precedingClause);
  if (lastAndIsARoleMappingBoundary && lastClause.length > 0) {
    return { value: lastClause, needsReview: false };
  }
  return { value: prefix, needsReview: true };
}

function extractOfficerInCharge(paras: readonly string[]): FieldResult<string> {
  const para = paras.find((p) => OFFICER_PRESENCE_RE.test(p));
  if (para === undefined) {
    // [m1] Symmetric with extractConsignee's fallback: a Consignee: paragraph
    // is the nearest related prose when no officer-in-charge label exists at
    // all (unexercised on the current six-letter corpus — every letter names
    // an officer-in-charge somewhere — but the contract holds regardless).
    const nearby = paras.find((p) => CONSIGNEE_PRESENCE_RE.test(p));
    return notFound(nearby ?? null);
  }
  for (const re of [OFFICER_COLON_RE, OFFICER_LABEL_FIRST_RE]) {
    const m = re.exec(para);
    const captured = m?.[1]?.trim();
    if (captured !== undefined && captured.length > 0) {
      const value = captured.replace(OFFICER_LABEL_STRIP_RE, '').trim();
      return found(value.length > 0 ? value : captured, para);
    }
  }
  const valueFirst = extractValueFirstOfficer(para);
  if (valueFirst !== null) {
    const value = valueFirst.value.replace(OFFICER_LABEL_STRIP_RE, '').trim();
    return {
      value: value.length > 0 ? value : valueFirst.value,
      raw: para,
      needsReview: valueFirst.needsReview,
    };
  }
  return found(para, para);
}

// ---------------------------------------------------------------------------
// signatory (name + designation, immediately above "Digitally Signed")
// ---------------------------------------------------------------------------

function extractSignatory(headerText: string): {
  signatoryName: FieldResult<string>;
  signatoryDesignation: FieldResult<string>;
} {
  const lines = headerText.split('\n');
  const dsIdx = lines.findIndex((l) => l.trim() === 'Digitally Signed');
  if (dsIdx === -1) {
    const raw = preview(lines.slice(-15).join('\n'));
    return {
      signatoryName: notFound(raw),
      signatoryDesignation: notFound(raw),
    };
  }
  const preceding: string[] = [];
  for (let i = dsIdx - 1; i >= 0 && preceding.length < 2; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line.length > 0) {
      preceding.push(line);
    }
  }
  const [designationLine, nameLine] = preceding;
  if (designationLine === undefined || nameLine === undefined) {
    const raw = preview(lines.slice(Math.max(0, dsIdx - 6), dsIdx + 1).join('\n'));
    return {
      signatoryName: notFound(raw),
      signatoryDesignation: notFound(raw),
    };
  }
  return {
    signatoryName: found(nameLine, nameLine),
    signatoryDesignation: found(designationLine, designationLine),
  };
}

// ---------------------------------------------------------------------------
// GCC version (present in 4/6 letters, in wildly varying phrasing)
// ---------------------------------------------------------------------------

const GCC_VERSION_PATTERNS: readonly RegExp[] = [
  /GCC-\s*20\d{2}/i, // PL273-JHS: "GCC-2022"
  /General Condition of Contract\s+APRIL-?\s*20\d{2}/i, // PL280-ADI
  /IRGCC\s+April\s*20\d{2}/i, // PL276-GTL (first/authoritative mention)
];

// Where a GCC citation lives in this template WHEN a letter carries one at
// all: the security-deposit clause-reference sentence ("...in terms of
// clause 16.1 of GCC-2022."). Used only as the [m1] candidate-raw-block
// source for letters where none of GCC_VERSION_PATTERNS matched — the same
// decimal-tolerant clause capture as SECURITY_DEPOSIT_RE (header.ts, "clause
// 16.1" must not truncate at the "." inside the clause number).
const GCC_CANDIDATE_CONTEXT_RE = /in terms of\s+(?:[^.]|\.(?=\d))+\./i;

function extractGccVersion(flat: string): FieldResult<string> {
  for (const re of GCC_VERSION_PATTERNS) {
    const m = re.exec(flat);
    if (m !== null) {
      const value = m[0].replace(/-\s+/g, '-').trim();
      return found(value, m[0]);
    }
  }
  // Genuinely absent in PL275-BKN/PL270-CRB (no year-qualified GCC edition
  // cited)/PL281-BB — a real gap in the source letter, not a parser miss.
  // [m1] Retain a candidate raw block rather than null: the security-deposit
  // clause-reference sentence is where a GCC citation would appear if the
  // letter carried one, so it's where a reviewer chasing this field down
  // should look first.
  const candidate = GCC_CANDIDATE_CONTEXT_RE.exec(flat);
  return notFound(
    candidate !== null ? preview(candidate[0]) : preview(flat.slice(0, 400)),
  );
}

// ---------------------------------------------------------------------------
// File No (optional — PL280-ADI only)
// ---------------------------------------------------------------------------

function extractFileNo(paras: readonly string[]): FieldResult<string> {
  const para = paras.find((p) => /^File No\s*:/i.test(p));
  if (para === undefined) {
    return optionalAbsent();
  }
  const value = para.replace(/^File No\s*:\s*/i, '').trim();
  return found(value, para);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Extracts the full LOA header/prose block from raw `pdftotext -layout`
 * text (as returned by `loadCorpus()`/`loadLetter()`'s `.text`). Strips
 * print furniture first, then locates every field research §3 names. Never
 * throws on missing structure — every field degrades to `null` + candidate
 * raw text + `needsReview: true` (or, for the genuinely optional File No,
 * `optionalAbsent()`).
 */
export function extractHeader(rawText: string): LoaHeader {
  const headerText = headerTextOf(rawText);
  const flat = flatten(headerText);
  const paras = paragraphs(headerText);

  const { zone, division, officeAddress } = extractZoneDivisionAddress(headerText);
  const { letterNumber, letterDate } = extractLetterNumberAndDate(headerText);
  const { contractorName, contractorAddress } =
    extractContractorNameAddress(headerText);
  const { tenderNumber, tenderClosingDate, workDescription, bidId, bidDate } =
    extractTenderAndBid(flat);
  const contractValue = extractContractValue(flat);
  const emd = extractEmd(flat);
  const securityDeposit = extractSecurityDeposit(flat);
  const performanceGuarantee = extractPerformanceGuarantee(flat);
  const completionPeriod = extractCompletionPeriod(flat);
  const consignee = extractConsignee(paras);
  const officerInCharge = extractOfficerInCharge(paras);
  const { signatoryName, signatoryDesignation } = extractSignatory(headerText);
  const gccVersion = extractGccVersion(flat);
  const fileNo = extractFileNo(paras);

  return {
    zone,
    division,
    officeAddress,
    letterNumber,
    letterDate,
    tenderNumber,
    tenderClosingDate,
    workDescription,
    bidId,
    bidDate,
    contractorName,
    contractorAddress,
    contractValue,
    emd,
    securityDeposit,
    performanceGuarantee,
    completionPeriod,
    consignee,
    officerInCharge,
    signatoryName,
    signatoryDesignation,
    gccVersion,
    fileNo,
  };
}
