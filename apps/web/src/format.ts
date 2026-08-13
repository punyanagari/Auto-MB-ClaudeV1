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

/** Date-time instant → the VIEWER'S calendar day, in formatDate's style:
 * "2026-08-11T20:30:00Z" seen from IST is "12 Aug 2026". formatDate
 * stays pinned to UTC because its input is a date-only string with no
 * instant to shift; slicing a timestamp to its UTC day instead printed
 * yesterday's date to anyone east of UTC until their offset had passed
 * midnight. Anything unparseable passes through. */
export function formatTimestampDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Instant with wall-clock time in the viewer's zone — used where a
 * deadline is a moment, not a day (NIC's 24-hour IRN cancellation
 * window). Anything unparseable passes through. */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

/** The viewer's local calendar date as a date-input value (YYYY-MM-DD).
 * A form-prefill convenience only — document editors that have a server
 * read available prefer its organisation-timezone `today`, and the
 * server revalidates every legal date it is sent. en-CA formats as
 * YYYY-MM-DD without any UTC round-trip of the local day. */
export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA').format(new Date());
}

/**
 * Renders a percentage the SERVER computed — `executedPercent` on the
 * dashboard — for display, without recomputing it.
 *
 * Executed value is compared against a contract value whose GST basis
 * varies per Work (migration 0062), so the arithmetic belongs on the
 * server where the basis is known; the browser's job is to print it. The
 * string arrives with four fraction digits because a mixed-basis error is
 * recognisable in them (29.4874 against 24.9893); one is enough on screen.
 * `null` means the contract value is zero, which is not 0% — it is no
 * answer, and the caller shows a dash.
 */
export function formatServerPercent(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return `${parsed.toFixed(1)}%`;
}

/** Whole-percent progress, clamped to 0–100 for display. Only for ratios
 * of two figures already known to be on the SAME GST basis — the
 * dashboard's delivered-against-contract bars, where both sides come from
 * the same Work's own rates. Anything compared across works, or against a
 * figure from a tax document, must be computed on the server instead. */
export function progressPercent(part: string, whole: string): number {
  const partValue = Number(part);
  const wholeValue = Number(whole);
  if (!Number.isFinite(partValue) || !Number.isFinite(wholeValue) || wholeValue <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((partValue / wholeValue) * 100)));
}
