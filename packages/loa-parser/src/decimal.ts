/**
 * @auto-mb/loa-parser — exact-decimal (paisa-precise) arithmetic (DC-25;
 * tickets/DC-25.md criterion "qty × unit_rate ≈ bid_amount is validated per
 * item with an explicit tolerance ... Use exact-decimal string arithmetic
 * (DC-23's dates/words modules are the precedent — no float where paisa
 * matter)").
 *
 * Every money figure the IREPS item table prints is a plain decimal string
 * with AT MOST two fractional digits (paisa) and no exponent notation —
 * verified across all 281 item rows in the six-letter corpus. Parsing
 * straight to `bigint` PAISA (rather than `Number`) means `qty × unit_rate`
 * is computed with ZERO binary-float rounding error: IEEE-754 doubles
 * cannot represent most two-decimal rupee amounts exactly (17530.73 has no
 * exact binary fraction), so a naive `Math.abs(a * b - c) < epsilon` check
 * either needs a fudged epsilon that grows with the operands' magnitude, or
 * risks a false pass/fail right at the boundary it's supposed to police.
 * bigint arithmetic on exact integers has neither problem — multiplying two
 * exact paisa counts is exact, so any remaining difference from the printed
 * bid amount is a genuine data discrepancy, never floating-point noise.
 * This is the same "pure string/integer arithmetic, no `Date`/`Number`
 * rounding surface" discipline dates.ts and words-to-number.ts already
 * apply to dates and Indian-numbering currency words.
 */

/**
 * Parses a plain decimal string (`"17530.73"`, `"8"`, `"1,200.00"`) into an
 * integer count of its minor unit (paisa when `scale=2`) — i.e. the value
 * multiplied by `10**scale`, exactly. Commas are accepted as thousands
 * separators and stripped (matching every numeric column in the corpus).
 * Returns null — never a partial/guessed value — for anything that isn't a
 * non-negative decimal with at most `scale` fractional digits.
 */
export function parseDecimalToMinorUnits(raw: string, scale: number): bigint | null {
  const cleaned = raw.replace(/,/g, '').trim();
  // scale=0 (a plain integer column, e.g. qty) never carries a fractional
  // part at all — `{1,0}` is not a legal regex quantifier, so that case is
  // built as a separate, simpler pattern rather than degenerating the
  // general one.
  const re =
    scale === 0 ? /^(\d+)$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${String(scale)}}))?$`);
  const m = re.exec(cleaned);
  if (m === null) {
    return null;
  }
  const whole = BigInt(m[1] ?? '0');
  const frac = (m[2] ?? '').padEnd(scale, '0');
  const fracValue = frac.length > 0 ? BigInt(frac) : 0n;
  return whole * 10n ** BigInt(scale) + fracValue;
}

/**
 * Formats an integer count of minor units back to a plain (possibly
 * negative) decimal string — `formatMinorUnits(1754073n, 2) === "17540.73"`.
 * Used only to embed a human-readable figure in a reconciliation diagnostic;
 * every actual COMPARISON stays in integer minor units throughout this
 * module, never round-tripping through this formatter first.
 */
export function formatMinorUnits(minor: bigint, scale: number): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const divisor = 10n ** BigInt(scale);
  const whole = abs / divisor;
  const sign = negative ? '-' : '';
  if (scale === 0) {
    return `${sign}${whole.toString()}`;
  }
  const frac = (abs % divisor).toString().padStart(scale, '0');
  return `${sign}${whole.toString()}.${frac}`;
}
