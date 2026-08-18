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

interface ReviewPayloadView {
  readonly header: {
    readonly letterNumber: FieldView;
    readonly letterDate: FieldView;
    readonly workDescription: FieldView;
    readonly performanceGuarantee?: PerformanceGuaranteeView;
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
