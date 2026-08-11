/** Indian-format rupee display: exact decimal strings from the API are
 * rendered with lakh/crore digit grouping. Display only — arithmetic
 * stays server-side in exact SQL numerics. */
const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatInr(decimal: string): string {
  const value = Number(decimal);
  if (!Number.isFinite(value)) return decimal;
  return rupees.format(value);
}

const compact = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/** Compact crore/lakh label for dense tables, e.g. "84610891.00" →
 * "₹8.46 Cr". Small amounts fall back to the exact rupee format. */
export function formatCompactInr(decimal: string): string {
  const value = Number(decimal);
  if (!Number.isFinite(value)) return decimal;
  if (Math.abs(value) >= 1_00_00_000) {
    return `₹${compact.format(value / 1_00_00_000)} Cr`;
  }
  if (Math.abs(value) >= 1_00_000) {
    return `₹${compact.format(value / 1_00_000)} L`;
  }
  return rupees.format(value);
}

function decimalThousandths(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const magnitude =
    BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3) || '0');
  return negative ? -magnitude : magnitude;
}

/** Exact ordering for API decimal strings. Sorting must not use Number or
 * lexical comparison because authoritative values may exceed safe integer
 * precision and strings such as "9.00" sort after "100.00". */
export function compareDecimalStrings(left: string, right: string): number {
  const leftValue = decimalThousandths(left);
  const rightValue = decimalThousandths(right);
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : 1;
}

/** "2026-08-08" → "08 Aug 2026"; anything unparseable passes through. */
export function formatDate(isoDate: string): string {
  const parsed = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** First letters of the first two words — the avatar monogram. */
export function initials(nameOrEmail: string): string {
  return nameOrEmail
    .split(/[\s@._-]+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => (part[0] ?? '').toUpperCase())
    .join('');
}

/** Rupee display for RATES, which carry up to six fraction digits
 * (numeric(18,6)): at least the conventional two decimals, trailing
 * zeros beyond them trimmed — ₹100.00, ₹0.8517, ₹3.175636. */
const rupeeRates = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function formatRate(decimal: string): string {
  const value = Number(decimal);
  if (!Number.isFinite(value)) return decimal;
  return rupeeRates.format(value);
}

/** Whole-percent progress, clamped to 0–100 for display. */
export function progressPercent(part: string, whole: string): number {
  const partValue = Number(part);
  const wholeValue = Number(whole);
  if (!Number.isFinite(partValue) || !Number.isFinite(wholeValue) || wholeValue <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((partValue / wholeValue) * 100)));
}
