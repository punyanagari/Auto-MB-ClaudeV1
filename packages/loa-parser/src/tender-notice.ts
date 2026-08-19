/**
 * @auto-mb/loa-parser — the Notice Inviting Tender field reader.
 *
 * A sibling of `tender-document.ts` and deliberately much smaller. That
 * module reads a tender document that arrives BESIDE a Letter of
 * Acceptance, so its job is clause work: payment matrices, warranty
 * periods, release clauses, item specifications. This one reads the
 * notice that arrives BEFORE anything — months before there is an LOA to
 * hang it off — and the only questions anyone asks of an NIT at that
 * stage are the six on its first page: whose tender is it, what is it
 * for, when does it close, what is it worth, what earnest money does it
 * demand, and who may bid.
 *
 * TWO PRINTED SHAPES are read. The general one is a list of labelled
 * lines, which is what a division's own notice looks like. The other is
 * the IREPS "TENDER DOCUMENT" page every e-tender on ireps.gov.in is
 * published as, which states the same facts in COLUMNS — see the block
 * above `IREPS_MARKER` for what that costs a line-oriented reader and how
 * the columnar reader answers it.
 *
 * Everything here is a PROPOSAL (`AGENTS.md` rule 10). Each field carries
 * its own matched source text and its own `needsReview`, and a field that
 * cannot be located confidently is `null` with `needsReview: true` rather
 * than a guess — the `field.ts` contract the rest of this package has
 * followed since DC-23. Nothing in this module writes anything.
 *
 * Reused rather than re-derived: `normalizeLines`, `firstLabelValue` and
 * `firstWrappedLabelValue` from `tender-document.ts` (the same label-then-
 * continuation shapes appear on an NIT), `parseDdMmYyyy` and
 * `isRealCalendarDate` from `dates.ts`, and `parseDecimalToMinorUnits` /
 * `formatMinorUnits` from `decimal.ts` so a rupee figure never touches a
 * binary float.
 */

import { isRealCalendarDate, parseDdMmYyyy } from './dates.js';
import { formatMinorUnits, parseDecimalToMinorUnits } from './decimal.js';
import {
  firstLabelValue,
  firstWrappedLabelValue,
  normalizeLines,
  type TenderField,
} from './tender-document.js';

export interface TenderNoticeReview {
  readonly tenderNumber: TenderField;
  /** The inviting body — a zone, a division, an RDSO directorate, a PSU. */
  readonly authority: TenderField;
  readonly title: TenderField;
  /**
   * The closing moment as the notice prints it, normalised to
   * `YYYY-MM-DDTHH:MM` in the tender's own local time. Deliberately NOT
   * an instant: the notice states a wall-clock time and the server binds
   * it to the organisation's timezone when the proposal is confirmed, so
   * nothing here has to know what that timezone is.
   *
   * A notice that states a date and no time yields the date at `00:00`
   * and `needsReview: true` — midnight is never a real closing time, and
   * saying so is the point of the flag.
   */
  readonly bidClosesAtLocal: TenderField;
  /** Plain decimal rupees, at most two fraction digits, as the
   * `money_amount` column stores them. */
  readonly estimatedValue: TenderField;
  readonly emdAmount: TenderField;
  readonly eligibility: TenderField;
  readonly needsReview: {
    readonly total: number;
    /** The three fields a tender record cannot be created without. */
    readonly identityUnresolved: boolean;
  };
}

const TENDER_NUMBER_LABELS: readonly RegExp[] = [
  /^(?:e-?)?(?:tender|nit|notice\s+inviting\s+tender)\s*(?:no\.?|number|id|ref(?:erence)?)?\s*[:-]\s*(?<value>.+)$/i,
  /^tender\s+reference\s*[:-]\s*(?<value>.+)$/i,
];

const AUTHORITY_LABELS: readonly RegExp[] = [
  /^(?:tender\s+)?inviting\s+authority\s*[:-]\s*(?<value>.+)$/i,
  /^(?:name\s+of\s+)?(?:the\s+)?railway\s*[:-]\s*(?<value>.+)$/i,
  /^(?:zone|division|department|organisation|organization)\s*[:-]\s*(?<value>.+)$/i,
];

const TITLE_LABELS: readonly RegExp[] = [
  /^(?:name\s+of\s+(?:the\s+)?work|work\s+description|description\s+of\s+work|name\s+of\s+(?:the\s+)?tender)\s*[:-]\s*(?<value>.*)$/i,
  /^(?:subject|sub\.)\s*[:-]\s*(?<value>.*)$/i,
];

const CLOSING_LABELS: readonly RegExp[] = [
  /^(?:date\s*(?:&|and)\s*time\s+of\s+)?closing\s+(?:of\s+tender|date(?:\s*(?:&|and)\s*time)?)\s*[:-]\s*(?<value>.+)$/i,
  /^(?:bid|tender)\s+(?:closing|submission)\s+(?:date|end\s+date)(?:\s*(?:&|and)\s*time)?\s*[:-]\s*(?<value>.+)$/i,
  /^last\s+date\s*(?:(?:&|and)\s*time\s*)?(?:of|for)\s+(?:submission|bid\s+submission)\s*[:-]\s*(?<value>.+)$/i,
  /^due\s+date(?:\s*(?:&|and)\s*time)?\s*[:-]\s*(?<value>.+)$/i,
];

const ESTIMATED_VALUE_LABELS: readonly RegExp[] = [
  /^(?:estimated|advertised|approximate|approx\.?)\s+(?:cost|value)(?:\s+of\s+(?:the\s+)?(?:work|tender))?\s*[:-]\s*(?<value>.+)$/i,
  /^tender\s+value\s*[:-]\s*(?<value>.+)$/i,
];

const EMD_LABELS: readonly RegExp[] = [
  /^(?:emd|earnest\s+money(?:\s+deposit)?)\s*(?:amount)?\s*[:-]\s*(?<value>.+)$/i,
];

const ELIGIBILITY_LABELS: readonly RegExp[] = [
  /^eligibility(?:\s+(?:criteria|criterion|requirement|conditions?))?\s*[:-]\s*(?<value>.*)$/i,
  /^(?:minimum\s+)?qualification(?:\s+criteria)?\s*[:-]\s*(?<value>.*)$/i,
];

// ---------------------------------------------------------------------
// The IREPS "TENDER DOCUMENT" layout.
//
// Every notice published through ireps.gov.in prints the same first page,
// and it is not a list of labelled lines: it is a set of TABLES, laid out
// in columns that `pdftotext -layout` preserves as runs of spaces. The
// label readers above cannot see any of it, because `normalizeLines`
// collapses every run of whitespace to one space BEFORE they run — which
// is right for prose and destroys a column boundary.
//
// The damage that does is not merely a field going unread. On the header
// line
//
//   Tender No: BPLNWKS2026-27TELEAMC02        Closing Date/Time: 15/06/2026 15:00
//
// the collapsed line is one line to `firstLabelValue`, so `(?<value>.+)$`
// swallows the whole of it and the tender number comes back as
// "BPLNWKS2026-27TELEAMC02 Closing Date/Time: 15/06/2026 15:00" — a
// CONFIDENT reading of a number that does not exist. A field that reads
// null is a field a reviewer fills in; a field that reads wrong and
// unflagged is one they confirm.
//
// So this reader works on the RAW lines, where the columns are still
// there, and everything below rests on one observation: on an IREPS page
// two or more spaces is a column gap and one space is a word gap. Split a
// line on that and each cell is a field, read whole and never bled into
// its neighbour.
//
// It is gated on the marker line the layout always carries, so no other
// notice shape in the corpus can reach any of it.
// ---------------------------------------------------------------------

/** The centred banner under the masthead on every page of an IREPS
 * tender document, and the one thing that identifies the layout. */
const IREPS_MARKER = 'TENDER DOCUMENT';

/** One printed line split into its column cells. */
function gapCells(rawLine: string): readonly string[] {
  return rawLine
    .trim()
    .split(/\s{2,}/)
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

/** True where a line begins in the label column — column zero. Every
 * label in the NIT HEADER table starts there, and every continuation of a
 * wrapped cell is indented past it, which is the only signal separating
 * the two. */
function startsAtLabelColumn(line: string): boolean {
  return line.length > 0 && !/^\s/.test(line);
}

/** How far a line is indented, which on a `-layout` page IS the column its
 * text sits in. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * A labelled row of the four-column NIT HEADER table, read as the FIRST
 * value column only.
 *
 * The table prints two label/value pairs per row:
 *
 *   Advertised Value       11503728.60      Tendering Section   SNT TELE
 *   Earnest Money (Rs.)    230100.00        Validity of Offer ( Days)  60
 *
 * so cell 1 is this label's value and cells 2 and 3 belong to an entirely
 * different field. Taking anything but cell 1 would read a tendering
 * section as an advertised value, or 60 days of bid validity as an
 * earnest money deposit.
 */
function irepsRowValue(lines: readonly string[], label: RegExp): TenderField | null {
  for (const line of lines) {
    if (!startsAtLabelColumn(line)) continue;
    const cells = gapCells(line);
    const first = cells[0];
    if (first === undefined || !label.test(first)) continue;
    const value = cells[1];
    return value === undefined
      ? { value: null, raw: line.trim(), needsReview: true }
      : { value, raw: line.trim(), needsReview: false };
  }
  return null;
}

/**
 * A NIT HEADER cell whose text wraps over several printed lines.
 *
 * The Name of Work is the one field on the page long enough to do this,
 * and the wrapping has a shape worth stating: the label is VERTICALLY
 * CENTRED in its cell, so the printed text runs both above and below the
 * label's own line.
 *
 *                          Comprehensive Annual Maintenance Contract of ...
 *                          Controller unit, Coach Guidance System, ...
 *   Name of Work
 *                          Glace Display Board, Single Line Display ...
 *                          MABA, ASKN, RTA and SHRN for a period of 5 years.
 *
 * Reading downward alone would lose the first half of the work's name,
 * which is the half naming what the contract is for.
 *
 * A CONTINUATION IS PINNED TO ITS CELL'S OWN COLUMN, not merely indented.
 * "Indented" alone is not enough to say a line belongs to this cell: the
 * table has a SECOND label/value pair to the right of every row, and when
 * one of those wraps its continuation is also indented — just at a
 * different column. Accepting it would prepend somebody else's label to
 * the name of the work and report the result confidently. So the column
 * is taken from the nearest continuation (below first, which is the
 * canonical direction), and every other line has to start at exactly that
 * column to join. Both runs still stop at a blank line or the label
 * column, which is where the cell ends in both directions.
 */
function irepsWrappedCell(lines: readonly string[], label: RegExp): TenderField | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!startsAtLabelColumn(line)) continue;
    const cells = gapCells(line);
    const first = cells[0];
    if (first === undefined || !label.test(first)) continue;

    /** A line that could continue this cell: present, non-blank, and not
     * starting a new row in the label column. */
    const continues = (cursor: number): string | null => {
      const candidate = lines[cursor];
      if (candidate === undefined) return null;
      if (candidate.trim().length === 0 || startsAtLabelColumn(candidate)) return null;
      return candidate;
    };

    // The cell's column. An inline value on the label's own line settles
    // it outright; otherwise the nearest continuation does, looking down
    // before up because a cell's text runs downward from its top edge.
    const inlineValue = cells[1];
    const valueColumn =
      inlineValue !== undefined
        ? line.indexOf(inlineValue, first.length)
        : indentOf(continues(index + 1) ?? continues(index - 1) ?? '');

    const above: string[] = [];
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = continues(cursor);
      if (candidate === null || indentOf(candidate) !== valueColumn) break;
      above.unshift(candidate.trim());
    }
    const below: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = continues(cursor);
      if (candidate === null || indentOf(candidate) !== valueColumn) break;
      below.push(candidate.trim());
    }

    const value = [...above, ...cells.slice(1), ...below].join(' ').trim();
    return value.length > 0
      ? {
          value,
          raw: [...above, line.trim(), ...below].join('\n'),
          needsReview: false,
        }
      : { value: null, raw: line.trim(), needsReview: true };
  }
  return null;
}

/** The four fields the columnar header and the NIT HEADER table state,
 * plus the masthead. A field is null where the page does not carry it —
 * but see `matched`: on an IREPS page a null field is a FLAG, never an
 * invitation to go and ask the label readers. */
interface IrepsNoticeFields {
  /** Whether the page is an IREPS tender document at all. False hands
   * every field back to the label readers; true means this reader owns
   * the six, resolved or not. */
  readonly matched: boolean;
  readonly tenderNumber: TenderField | null;
  readonly authority: TenderField | null;
  readonly title: TenderField | null;
  readonly closing: TenderField | null;
  readonly estimatedValue: TenderField | null;
  readonly emdAmount: TenderField | null;
}

const NO_IREPS_FIELDS: IrepsNoticeFields = {
  matched: false,
  tenderNumber: null,
  authority: null,
  title: null,
  closing: null,
  estimatedValue: null,
  emdAmount: null,
};

const IREPS_TENDER_NUMBER_CELL = /^tender\s+no\.?\s*[:-]\s*(?<value>\S.*)$/i;
const IREPS_CLOSING_CELL = /^closing\s+date\s*\/\s*time\s*[:-]\s*(?<value>\S.*)$/i;

/**
 * What an IREPS tender number is allowed to look like: letters, digits,
 * and the separators a railway reference uses. No spaces.
 *
 * This is a TRIPWIRE, not a parser. A number that fails it is still
 * returned — a reviewer confirming a real oddity is cheap — but it is
 * returned flagged, because every way this capture can go wrong produces
 * a value with something else in it: a bled neighbouring column, a
 * swallowed label, a date. The value being plausible is the whole danger.
 */
const IREPS_TENDER_NUMBER_SHAPE = /^[A-Za-z0-9./_-]+$/;

/** The tokens an IREPS masthead uses to name the office inviting the
 * tender. Matching one is what turns a POSITIONAL read — "the line above
 * the banner" — into an anchored one. */
const IREPS_MASTHEAD_SHAPE =
  /\b(?:RLY|RAILWAY|RAILWAYS|DIVISION|DIVN|RDSO|METRO|KONKAN|WORKSHOP|DEPOT)\b/i;
const IREPS_ADVERTISED_VALUE_ROW = /^advertised\s+value$/i;
const IREPS_EARNEST_MONEY_ROW = /^earnest\s+money(?:\s*\(\s*rs\.?\s*\))?$/i;
const IREPS_NAME_OF_WORK_ROW = /^name\s+of\s+work$/i;

function readIrepsNotice(rawText: string): IrepsNoticeFields {
  // Not `normalizeLines`: this whole reader exists because the column
  // gaps it collapses are the data.
  const lines = rawText.replace(/\r\n?/g, '\n').split('\n');
  const markerAt = lines.findIndex((line) => line.trim() === IREPS_MARKER);
  if (markerAt === -1) return NO_IREPS_FIELDS;

  // The masthead: the printed line above the banner, which is where every
  // IREPS page names the division and the zone inviting the tender —
  // "BHOPAL DIVISION-S AND T/WEST CENTRAL RLY". There is no labelled
  // inviting-authority field anywhere on the document.
  //
  // POSITION IS NOT AN ANCHOR. "The line above the banner" is true of
  // every page this reader has been shown and of nothing it has been
  // promised: a print header, a page rule, a continuation marker or a
  // letterhead address can all sit there, and each would be reported as
  // the inviting authority with full confidence. So the position finds
  // the candidate and the WORDING decides whether it is believed — a line
  // naming a railway, a division or a workshop is anchored; anything else
  // is the right guess to show a reviewer, flagged.
  let authority: TenderField | null = null;
  for (let cursor = markerAt - 1; cursor >= 0; cursor -= 1) {
    const text = (lines[cursor] ?? '').trim();
    if (text.length === 0) continue;
    authority = {
      value: text,
      raw: text,
      needsReview: !IREPS_MASTHEAD_SHAPE.test(text),
    };
    break;
  }

  let tenderNumber: TenderField | null = null;
  let closing: TenderField | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const cells = gapCells(line);
    for (const cell of cells) {
      const number = IREPS_TENDER_NUMBER_CELL.exec(cell);
      if (number !== null && tenderNumber === null) {
        const value = (number.groups?.value ?? '').trim();
        // A number printed as the last cell of its line may have WRAPPED,
        // in which case what was captured is its first half and reads as
        // a perfectly ordinary reference. There is no way to tell a
        // wrapped number from a complete one, so the possibility itself
        // is the flag.
        const couldHaveWrapped =
          cell === cells[cells.length - 1] &&
          (lines[index + 1] ?? '').trim().length > 0 &&
          !startsAtLabelColumn(lines[index + 1] ?? '');
        tenderNumber = {
          value,
          raw: cell,
          needsReview: !IREPS_TENDER_NUMBER_SHAPE.test(value) || couldHaveWrapped,
        };
      }
      const closes = IREPS_CLOSING_CELL.exec(cell);
      if (closes !== null && closing === null) {
        closing = {
          value: (closes.groups?.value ?? '').trim(),
          raw: cell,
          needsReview: false,
        };
      }
    }
    if (tenderNumber !== null && closing !== null) break;
  }

  return {
    matched: true,
    tenderNumber,
    authority,
    title: irepsWrappedCell(lines, IREPS_NAME_OF_WORK_ROW),
    closing,
    estimatedValue: irepsRowValue(lines, IREPS_ADVERTISED_VALUE_ROW),
    emdAmount: irepsRowValue(lines, IREPS_EARNEST_MONEY_ROW),
  };
}

/** `10:00`, `15.30`, `1500 hrs`, `3:00 PM`. Returns `HH:MM` on a 24-hour
 * clock, or null when the fragment states no time at all. */
function timeOfDay(raw: string): string | null {
  const meridiem = /\b(\d{1,2})\s*[:.]\s*(\d{2})\s*(a\.?m\.?|p\.?m\.?)/i.exec(raw);
  if (meridiem !== null) {
    const hour = Number(meridiem[1]);
    const minute = Number(meridiem[2]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const pm = /^p/i.test(meridiem[3] ?? '');
    const normalised = pm ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
    return `${String(normalised).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const separated = /\b(\d{1,2})\s*[:.]\s*(\d{2})\b/.exec(raw);
  if (separated !== null) {
    const hour = Number(separated[1]);
    const minute = Number(separated[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  // `1500 hrs` / `1500 hours` — four digits ONLY when the notice says
  // they are a time. A bare four-digit run is far more likely a year.
  const military = /\b(\d{2})(\d{2})\s*(?:hrs?|hours)\b/i.exec(raw);
  if (military !== null) {
    const hour = Number(military[1]);
    const minute = Number(military[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return null;
}

function closingMoment(field: TenderField): TenderField {
  if (field.value === null) return field;
  const date = parseDdMmYyyy(field.value);
  const iso = date ?? /\b(\d{4}-\d{2}-\d{2})\b/.exec(field.value)?.[1] ?? null;
  if (iso === null || !isRealCalendarDate(iso)) {
    return { value: null, raw: field.raw, needsReview: true };
  }
  const time = timeOfDay(field.value);
  return {
    value: `${iso}T${time ?? '00:00'}`,
    raw: field.raw,
    // A date with no stated time is half an answer. Midnight is never a
    // closing time, so the reviewer is told to supply the real one.
    needsReview: time === null,
  };
}

/** `Cr`/`Crore` and `Lakh`/`Lac`/`L` as printed beside a figure. The
 * Indian grouping, matching `words-to-number.ts`. */
const SCALE_WORDS: readonly (readonly [RegExp, bigint])[] = [
  [/\b(?:cr\.?|crores?)\b/i, 10_000_000n],
  [/\b(?:lakhs?|lacs?)\b/i, 100_000n],
];

/**
 * Reads a printed rupee figure — `Rs. 8,40,00,000/-`, `₹ 8.40 Cr`,
 * `INR 16.80 Lakh`, `84000000` — into a plain decimal string at two
 * fraction digits.
 *
 * Exact throughout: the mantissa is parsed to integer paise and the
 * scale word multiplies that integer, so `8.40 Cr` is `840n * 10^5`
 * paise and never `8.4 * 1e7` in a double.
 *
 * WHERE A SCALE WORD MAY BE. Only between the figure and any opening
 * parenthesis. An Indian tender states its money twice — the figure and
 * then the amount in words — and the second is nearly always
 * parenthesised: `Rs. 8,40,00,000/- (Rupees Eight Crore Forty Lakh
 * only)`. Searching the whole string for "Crore" finds the word half of
 * that restatement and multiplies the already-complete figure by ten
 * million, turning eight crore into eight lakh crore. That is the worst
 * class of bug this module can have: it is silent, it is a hundredfold,
 * and it lands on the EMD an agency has to deposit.
 *
 * So the scale word has to QUALIFY the figure — sit after it and before
 * the parenthetical — and a scale word inside the parenthetical means
 * something different: two statements of the same amount that this
 * function reads only one of. It returns the figure and flags it, rather
 * than either trusting itself or discarding a value the reviewer can
 * confirm at a glance. Comparing the two properly is what
 * `words-to-number.ts` does for the LOA, and an NIT is not worth that
 * machinery yet.
 */
function rupeeAmount(field: TenderField): TenderField {
  if (field.value === null) return field;
  const text = field.value;
  const flagged = (): TenderField => ({
    value: null,
    raw: field.raw,
    needsReview: true,
  });

  // The first number-shaped run, commas and all. Indian grouping puts
  // them in unusual places (`8,40,00,000`), which is exactly why they are
  // stripped rather than validated.
  const match = /(\d[\d,]*(?:\.\d+)?)/.exec(text);
  const figure = match?.[1];
  if (match === undefined || match === null || figure === undefined) return flagged();

  const after = text.slice(match.index + figure.length);
  const parenthesisAt = after.indexOf('(');
  const qualifier = parenthesisAt === -1 ? after : after.slice(0, parenthesisAt);
  const parenthetical = parenthesisAt === -1 ? '' : after.slice(parenthesisAt);

  const scale = SCALE_WORDS.find(([pattern]) => pattern.test(qualifier));
  const restatedInWords = SCALE_WORDS.some(([pattern]) => pattern.test(parenthetical));

  const paise = parseDecimalToMinorUnits(figure, 2);
  if (paise === null) return flagged();
  const scaled = scale === undefined ? paise : paise * scale[1];
  // Fifteen integer digits is what `money_amount` (numeric(18,2)) holds
  // and what the contract's money pattern admits. A figure past it is a
  // misread, not a tender.
  if (scaled >= 10n ** 17n) return flagged();

  return {
    value: formatMinorUnits(scaled, 2),
    raw: field.raw,
    needsReview: restatedInWords,
  };
}

/**
 * Reads the six fields a bid workspace is opened with off an NIT's text.
 *
 * Every field is independent: a notice that names its EMD and not its
 * estimated cost yields one resolved field and one flagged one, and the
 * reviewer fills the hole. Nothing is inferred from anything else.
 *
 * TWO READERS, AND THE SECOND IS NOT A SAFETY NET. The IREPS columnar
 * reader runs first, because it is the SPECIFIC shape: it knows the page
 * it is reading and which column each figure sits in. The label readers
 * are the general reader for every other notice.
 *
 * ONCE THE IREPS MARKER IS PRESENT THE COLUMNAR READER OWNS ALL SIX
 * FIELDS, resolved or not. Falling back per-field would undo the entire
 * point of this module: on an IREPS page the label readers do not fail
 * quietly, they MATCH THE COLLAPSED LINE AND SUCCEED WRONGLY — that is
 * the defect this pack exists to close, and a `??` would have reopened it
 * for every page whose spacing differs by one character from the fixture.
 * A field the columnar reader could not read is therefore null and
 * flagged, which sends it to a human, rather than filled in confidently
 * by a reader that cannot see columns.
 *
 * On any notice WITHOUT the marker line the columnar reader reports
 * nothing at all, and the labelled behaviour is exactly what it was.
 */
export function reviewTenderNotice(rawText: string): TenderNoticeReview {
  const lines = normalizeLines(rawText);
  const ireps = readIrepsNotice(rawText);
  /** What the columnar reader returns for a field of an IREPS page it
   * could not read: an answer for a human, never a guess. */
  const unread: TenderField = { value: null, raw: null, needsReview: true };
  const columnar = (field: TenderField | null, labelled: () => TenderField) =>
    ireps.matched ? (field ?? unread) : labelled();

  const tenderNumber = columnar(ireps.tenderNumber, () =>
    firstLabelValue(lines, TENDER_NUMBER_LABELS),
  );
  const authority = columnar(ireps.authority, () =>
    firstLabelValue(lines, AUTHORITY_LABELS),
  );
  const title = columnar(ireps.title, () =>
    firstWrappedLabelValue(lines, TITLE_LABELS),
  );
  const bidClosesAtLocal = closingMoment(
    columnar(ireps.closing, () => firstLabelValue(lines, CLOSING_LABELS)),
  );
  const estimatedValue = rupeeAmount(
    columnar(ireps.estimatedValue, () =>
      firstLabelValue(lines, ESTIMATED_VALUE_LABELS),
    ),
  );
  const emdAmount = rupeeAmount(
    columnar(ireps.emdAmount, () => firstLabelValue(lines, EMD_LABELS)),
  );
  const eligibility = firstWrappedLabelValue(lines, ELIGIBILITY_LABELS);

  const fields = [
    tenderNumber,
    authority,
    title,
    bidClosesAtLocal,
    estimatedValue,
    emdAmount,
    eligibility,
  ];

  return {
    tenderNumber,
    authority,
    title,
    bidClosesAtLocal,
    estimatedValue,
    emdAmount,
    eligibility,
    needsReview: {
      total: fields.filter((field) => field.needsReview).length,
      // The four the `tenders` row is NOT NULL on. A notice missing any
      // of them still opens the review screen; it just cannot be
      // confirmed until a human supplies them.
      identityUnresolved:
        tenderNumber.value === null ||
        authority.value === null ||
        title.value === null ||
        bidClosesAtLocal.value === null,
    },
  };
}
