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

/**
 * Exact ordering for API decimal strings, re-exported from the one
 * implementation.
 *
 * There were two. This module's own compared through
 * `decimalThousandths`, which truncates at three places, so it called
 * `0.0001` and `0` equal; the contracts one compares digit by digit at
 * full precision. Two comparators that disagree about anything are one
 * comparator and a bug, and the exact one wins — nothing sorting money
 * or quantities wants a silent truncation. The re-export keeps every
 * existing `from '../format.js'` import working.
 */
export { compareDecimalStrings } from '@auto-mb/contracts';

/**
 * `left − right` for two API decimal strings, exactly, as a decimal
 * string with three places.
 *
 * Presentation arithmetic. It started as a balance shown beside a field so
 * the operator could see what was left before they typed, and the
 * Installations table now also uses it to decide which items lead the
 * recording table and which fold away under "Installed to sanction" — a
 * question about what to SHOW, still not about what is true. Authoritative
 * quantities remain the server's: the record route revalidates every one of
 * them and refuses what does not add up, and nothing computed here is ever
 * submitted.
 *
 * Exact all the same, through the same thousandths BigInt the ordering
 * above uses. `Number("10.001") - Number("3.000")` is a float, and a
 * balance that renders as 6.999999999999999 beside a field is worse than
 * no balance at all.
 */
export function subtractDecimalStrings(left: string, right: string): string {
  const difference = decimalThousandths(left) - decimalThousandths(right);
  const negative = difference < 0n;
  const magnitude = negative ? -difference : difference;
  const whole = magnitude / 1000n;
  const fraction = (magnitude % 1000n).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/* Date formatters, constructed once.
 *
 * `toLocaleDateString(locale, options)` and `toLocaleString` build a fresh
 * Intl formatter on every call, and constructing one costs roughly two
 * orders of magnitude more than formatting with an existing one. A dense
 * ledger calls these once per cell, so a 129-item table built 129
 * throwaway formatters per render. These are the same objects the
 * toLocale* calls would have made — `Intl.DateTimeFormat.prototype.format`
 * is exactly what those methods delegate to — so every output is
 * unchanged. */
const dateOnlyFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const viewerDayFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const isoDayFormat = new Intl.DateTimeFormat('en-CA');

/** "2026-08-08" → "08 Aug 2026"; anything unparseable passes through. */
export function formatDate(isoDate: string): string {
  const parsed = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return dateOnlyFormat.format(parsed);
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
  return viewerDayFormat.format(parsed);
}

/* Re-exported rather than defined here: the offline banner needs this
 * one helper from the application shell, and the shell importing this
 * module costs 36 kB gzip on the initial payload.
 * `src/format-instant.ts` carries the reasoning. Callers keep importing
 * `formatTimestamp` from `format.ts` as they always have. */
export { formatTimestamp } from './format-instant.js';

/** An organisation-local wall clock ("2026-09-18T15:00") → "18 Sep 2026,
 * 15:00".
 *
 * Deliberately pure string work, with no `Date` in the path at all. The
 * server already resolved this moment against `organisations.timezone`,
 * so it is the time the tender document PRINTS. Parsing it back into a
 * Date would re-interpret it in the viewer's zone and shift a 15:00
 * deadline for anyone whose laptop disagrees with the organisation —
 * which is the exact class of defect engineering rule 6 exists to stop,
 * applied to a moment instead of a date. */
export function formatLocalDateTime(local: string): string {
  const day = local.slice(0, 10);
  const time = local.slice(11, 16);
  if (time.length !== 5) return formatDate(day);
  return `${formatDate(day)}, ${time}`;
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

/**
 * Today, as the `YYYY-MM-DD` an `<input type="date">` wants.
 *
 * The viewer's LOCAL calendar date, not `toISOString()`'s. An operator in
 * India filling a form at 9pm is already on tomorrow's date in UTC, so a
 * UTC default silently pre-fills the wrong day — and for a payment date
 * that is the difference between two financial years at the end of March.
 * en-CA formats as YYYY-MM-DD without any UTC round-trip of the local day.
 *
 * A form-prefill convenience only — document editors that have a server
 * read available prefer its organisation-timezone `today`, and the server
 * revalidates every legal date it is sent. This only has to stop the FORM
 * from starting out wrong.
 */
export function todayIso(): string {
  return isoDayFormat.format(new Date());
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

/* `progressPercent` stood here: a browser-side division of two decimal
 * strings, clamped for a progress bar. Its only caller was the dashboard's
 * delivered-against-contract column, and the redesigned screen
 * (`docs/UX.md` § 38) takes both of its percentages from the server, which
 * is where a ratio against a contract value belongs — each Work's GST
 * basis decides what its contract value is comparable with (migration
 * 0062) and the browser does not know it. Removed rather than left for the
 * next screen to reach for. */
