/**
 * Structural view of the LOA extraction payload. The parser package is
 * authoritative for the full shape (packages/loa-parser); the payload
 * travels untyped over the API (contracts: `extractionPayload: unknown`),
 * so the web narrows to exactly the fields the review screen reads.
 * Everything here is display/prefill data — the reviewer's corrections,
 * not this payload, become the confirmed Work.
 */

interface FieldView {
  readonly value: string | null;
  readonly raw: string | null;
  readonly needsReview: boolean;
}

export interface ParsedItemView {
  readonly schedule: { readonly id: string } | null;
  readonly itemSno: string;
  readonly itemCode: string;
  readonly description: string;
  /** Whether the description is the exact row-owned reading from the PDF's
   * own reading order, or the conservative layout fallback that
   * deliberately claims a neighbour's prose too. Only the exact reading is
   * an extracted truth. Optional: older stored payloads predate it. */
  readonly descriptionSource?: 'raw-exact' | 'layout-overinclusive';
  readonly qty: string;
  readonly qtyUnit: string | null;
  readonly unitRate: string;
  readonly bidAmount: string;
  /** `qty × unitRate` against the printed bid amount. A row that does not
   * reconcile is the letter contradicting itself, and neither figure is a
   * truth. Optional for the same reason as `descriptionSource`. */
  readonly reconciliation?: { readonly ok?: boolean };
  readonly needsReview: boolean;
  readonly raw: { readonly anchorLine: string };
}

export interface ReviewFlagView {
  readonly code: string;
  readonly scope: string;
  /** `<scheduleId>#<itemSno>` for an item flag; the letter number for a
   * letter-scoped one. */
  readonly targetId?: string;
  readonly message: string;
  readonly rawBlock: string;
}

/** The parser's performance-guarantee header field (what the LETTER
 * demands — distinct from any PBG instrument the contractor later
 * records). Declared optional because older stored payloads travel
 * untyped; the review screen degrades to a blank requirement block. */
interface PerformanceGuaranteeView {
  readonly amountFigures: number | null;
  readonly amountWords: string | null;
  readonly submissionDays: number | null;
  readonly extensionDays: number | null;
  readonly penalInterestPercent: number | null;
  readonly raw: string | null;
  readonly needsReview: boolean;
}

/** The parser's completion-period header field: "24 months", "18 (Eighteen)
 * Months". `unit` is normalised to `'month'` by the parser; anything else is
 * a unit this screen will not do arithmetic on. Optional for the same reason
 * as `performanceGuarantee` — older stored payloads travel untyped. */
interface CompletionPeriodView {
  readonly value: number | null;
  readonly unit: string | null;
  readonly raw: string | null;
  readonly needsReview: boolean;
}

interface ReviewPayloadView {
  readonly header: {
    readonly letterNumber: FieldView;
    readonly letterDate: FieldView;
    readonly workDescription: FieldView;
    readonly performanceGuarantee?: PerformanceGuaranteeView;
    readonly completionPeriod?: CompletionPeriodView;
  };
  readonly pricingShape: {
    readonly advertised_value: number | null;
    readonly contract_value: number | null;
    readonly pricing_shape: 'letter_percentage' | 'per_schedule' | null;
    readonly letter_percentage: number | null;
    readonly letter_percentage_direction: 'below' | 'at_par' | 'above' | null;
    readonly needsReview: boolean;
  };
  readonly items: readonly ParsedItemView[];
  readonly flags: readonly ReviewFlagView[];
  readonly needsReview: { readonly total: number; readonly anyLetterLevel: boolean };
}

export interface ExtractionPayloadView {
  readonly sourceText: string;
  readonly review: ReviewPayloadView;
}

/**
 * The completion date a letter implies: its own date plus the completion
 * period it prints.
 *
 * The period is a count of MONTHS, so this is calendar arithmetic, not a
 * day count: "12 months from 15/03/2026" is 15/03/2027, whatever the
 * intervening months are worth. A day-based approximation would land a
 * day or two out on most letters and be wrong in a way nobody would
 * notice until a liquidated-damages calculation ran off it.
 *
 * Month-end is CLAMPED to the last day of the target month — 31/01 plus
 * one month is 28/02, not 03/03. Rolling forward would put the deadline
 * in the month after the one the letter names.
 *
 * Null unless the parser read a positive whole number of months: a
 * period in weeks or days, a fraction, or a field it could not read is
 * left for the reviewer to type. This is a PREFILL, never an authority —
 * the operator can overwrite whatever it proposes.
 */
export function completionDateFrom(
  letterDate: string,
  period: { readonly value: number | null; readonly unit: string | null } | undefined,
): string | null {
  if (period === undefined || period.unit !== 'month') return null;
  const months = period.value;
  if (months === null || !Number.isInteger(months) || months <= 0) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(letterDate);
  if (match === null) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const zeroBased = month - 1 + months;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = (zeroBased % 12) + 1;
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return [
    String(targetYear).padStart(4, '0'),
    String(targetMonth).padStart(2, '0'),
    String(targetDay).padStart(2, '0'),
  ].join('-');
}

/** Narrows the transported payload; null for failed/absent extractions. */
export function asExtractionPayload(value: unknown): ExtractionPayloadView | null {
  if (
    value !== null &&
    typeof value === 'object' &&
    'review' in value &&
    value.review !== null &&
    typeof value.review === 'object' &&
    'items' in value.review &&
    Array.isArray(value.review.items)
  ) {
    return value as unknown as ExtractionPayloadView;
  }
  return null;
}

/** Reduces a printed decimal to the contracts' DecimalString shape for
 * input prefill: thousands separators dropped, bounded fraction, no
 * leading zeros. Unparseable printed figures prefill as empty so the
 * reviewer must supply the value rather than inherit a guess. */
export function normaliseDecimal(raw: string, maxDp: number): string {
  const cleaned = raw.replaceAll(',', '').trim();
  const dotParts = cleaned.split('.');
  const [intRaw, fracRaw] = dotParts;
  const digits = /^\d+$/;
  if (
    dotParts.length > 2 ||
    intRaw === undefined ||
    intRaw.length === 0 ||
    !digits.test(intRaw) ||
    (fracRaw !== undefined && !digits.test(fracRaw))
  ) {
    return '';
  }
  const intPart = String(BigInt(intRaw));
  const frac = (fracRaw ?? '').slice(0, maxDp).replace(/0+$/, '');
  return frac.length > 0 ? `${intPart}.${frac}` : intPart;
}

/** Parses a plain non-negative decimal with at most `scale` fractional
 * digits into exact integer minor units (BigInt), or null when the text
 * is not such a decimal. Mirrors the parser package's exact-decimal
 * discipline for the review screen's DISPLAY-ONLY reconciliation total —
 * no float ever touches a rupee figure, even a cosmetic one. */
export function parseDecimalMinorUnits(raw: string, scale: number): bigint | null {
  const cleaned = raw.replaceAll(',', '').trim();
  const parts = cleaned.split('.');
  const [wholeRaw, fracRaw] = parts;
  const digits = /^\d+$/;
  if (
    parts.length > 2 ||
    wholeRaw === undefined ||
    !digits.test(wholeRaw) ||
    (fracRaw !== undefined && (!digits.test(fracRaw) || fracRaw.length > scale))
  ) {
    return null;
  }
  const whole = BigInt(wholeRaw);
  const frac = (fracRaw ?? '').padEnd(scale, '0');
  return whole * 10n ** BigInt(scale) + (frac.length > 0 ? BigInt(frac) : 0n);
}

/** Formats integer minor units back to plain decimal text, trimming
 * trailing fractional zeros but keeping at least two decimal places for
 * rupee display. */
export function formatMinorUnits(minor: bigint, scale: number): string {
  const divisor = 10n ** BigInt(scale);
  const whole = minor / divisor;
  const frac = (minor % divisor).toString().padStart(scale, '0');
  const trimmed = frac.replace(/0+$/, '');
  const kept = trimmed.length < 2 ? frac.slice(0, 2) : trimmed;
  return kept.length > 0 ? `${whole.toString()}.${kept}` : whole.toString();
}

interface RowTotalInput {
  readonly awardedQuantity: string;
  readonly effectiveRate: string;
}

/**
 * Exact reconciliation total over the review screen's current rows:
 * Σ quantity (≤3 dp) × rate (≤6 dp), computed entirely in BigInt minor
 * units at scale 9. Null when any row's quantity or rate is not yet a
 * plain decimal — the total is then simply not shown rather than guessed.
 */
export function exactRowsTotal(rows: readonly RowTotalInput[]): string | null {
  let total = 0n;
  for (const row of rows) {
    const qty = parseDecimalMinorUnits(row.awardedQuantity, 3);
    const rate = parseDecimalMinorUnits(row.effectiveRate, 6);
    if (qty === null || rate === null) return null;
    total += qty * rate;
  }
  return formatMinorUnits(total, 9);
}
