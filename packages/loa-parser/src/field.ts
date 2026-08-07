/**
 * @auto-mb/loa-parser — the field-result contract every header/normalisation
 * extractor in this package returns (DC-23; legacy ticket DC-23 criterion
 * "Nothing is discarded and nothing is guessed"; PRODUCT-SPEC §5.1 step 3;
 * docs/reference/loa-parser-contract.md §3).
 *
 * A field the parser cannot confidently locate is NEVER partially guessed —
 * it is emitted as `value: null` with its candidate raw text retained (so a
 * human reviewer can find the answer without re-opening the source PDF) and
 * `needsReview: true`. A field that IS located still carries its matched
 * raw text, for the same audit-trail reason.
 */
export interface FieldResult<T> {
  readonly value: T | null;
  readonly raw: string | null;
  readonly needsReview: boolean;
}

/** A field was located and parsed. `raw` is the exact source substring the
 * value was derived from. */
export function found<T>(value: T, raw: string): FieldResult<T> {
  return { value, raw, needsReview: false };
}

/** A field could not be located (or parsed unambiguously). `raw`, when
 * available, is a candidate text block near where the field was expected —
 * never null-with-no-context when better context exists. */
export function notFound<T>(raw: string | null): FieldResult<T> {
  return { value: null, raw, needsReview: true };
}

/** A field that is legitimately OPTIONAL in the source template (e.g. the
 * LOA `File No`, research §3: "present only in PL280") — absence here is
 * normal, not an anomaly, so it must NOT raise `needsReview` the way a
 * missing REQUIRED field does (legacy ticket DC-23: "an absent field is null,
 * not an error"). */
export function optionalAbsent<T>(): FieldResult<T> {
  return { value: null, raw: null, needsReview: false };
}

/** Bounded preview of a text region, trimmed, for use as the `raw` context
 * of a field that could not be located at all (no better anchor available). */
export function preview(text: string, maxLen = 400): string {
  const trimmed = text.trim();
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen)}…`;
}
