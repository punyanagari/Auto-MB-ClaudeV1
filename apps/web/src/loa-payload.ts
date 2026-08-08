/**
 * Structural view of the LOA extraction payload. The parser package is
 * authoritative for the full shape (packages/loa-parser); the payload
 * travels untyped over the API (contracts: `extractionPayload: unknown`),
 * so the web narrows to exactly the fields the review screen reads.
 * Everything here is display/prefill data — the reviewer's corrections,
 * not this payload, become the confirmed Work.
 */

export interface FieldView {
  readonly value: string | null;
  readonly raw: string | null;
  readonly needsReview: boolean;
}

export interface ParsedItemView {
  readonly schedule: { readonly id: string } | null;
  readonly itemSno: string;
  readonly itemCode: string;
  readonly description: string;
  readonly qty: string;
  readonly qtyUnit: string | null;
  readonly unitRate: string;
  readonly bidAmount: string;
  readonly needsReview: boolean;
  readonly raw: { readonly anchorLine: string };
}

export interface ReviewFlagView {
  readonly code: string;
  readonly scope: string;
  readonly message: string;
  readonly rawBlock: string;
}

export interface ReviewPayloadView {
  readonly header: {
    readonly letterNumber: FieldView;
    readonly letterDate: FieldView;
    readonly workDescription: FieldView;
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
