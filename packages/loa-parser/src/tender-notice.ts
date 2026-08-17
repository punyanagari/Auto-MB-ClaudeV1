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
 */
export function reviewTenderNotice(rawText: string): TenderNoticeReview {
  const lines = normalizeLines(rawText);

  const tenderNumber = firstLabelValue(lines, TENDER_NUMBER_LABELS);
  const authority = firstLabelValue(lines, AUTHORITY_LABELS);
  const title = firstWrappedLabelValue(lines, TITLE_LABELS);
  const bidClosesAtLocal = closingMoment(firstLabelValue(lines, CLOSING_LABELS));
  const estimatedValue = rupeeAmount(firstLabelValue(lines, ESTIMATED_VALUE_LABELS));
  const emdAmount = rupeeAmount(firstLabelValue(lines, EMD_LABELS));
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
