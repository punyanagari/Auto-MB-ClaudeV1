/**
 * @auto-mb/loa-parser — date normalisation (DC-23; legacy ticket DC-23 criterion
 * "Dates are parsed DD/MM/YYYY -> YYYY-MM-DD date-only strings, with no
 * timezone-aware datetime anywhere on the path").
 *
 * Deliberately pure string arithmetic: no `new Date(...)`, no `Date.parse`,
 * no `Intl`. A DD/MM/YYYY or DD-MM-YYYY triple is zero-padded and
 * concatenated into an ISO date-only string; there is no wall-clock, no
 * offset, and therefore nothing for a process timezone to perturb. This is
 * the property test/header-normalise.test.ts's TZ-invariance
 * case exercises (running the same input under TZ=UTC and
 * TZ=Asia/Kolkata and asserting byte-identical output).
 */

/** Zero-pads a 1-2 digit day/month string to 2 digits. Throws on malformed
 * input rather than silently truncating or wrapping — a caller passing a
 * non-numeric or out-of-range fragment has a parsing bug upstream, not a
 * value this module should guess at. */
function pad2(part: string): string {
  const n = Number.parseInt(part, 10);
  if (!Number.isInteger(n) || n < 1 || n > 31 || String(n).length === 0) {
    throw new Error(`@auto-mb/loa-parser: invalid date part "${part}"`);
  }
  return String(n).padStart(2, '0');
}

/** Builds a `YYYY-MM-DD` string from separately-captured day/month/year
 * fragments (each already isolated by the caller's regex — this function
 * does no matching of its own, only pure string arithmetic). */
export function toIsoDate(day: string, month: string, year: string): string {
  if (!/^\d{4}$/.test(year)) {
    throw new Error(`@auto-mb/loa-parser: invalid 4-digit year "${year}"`);
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Parses a `DD/MM/YYYY` or `DD-MM-YYYY` string (the two separators observed
 * in the corpus — research §3) into `YYYY-MM-DD`. Tolerant of stray
 * whitespace around the separators, which the print-furniture-stripped text
 * can carry when a date was itself wrapped across a print-layout line break
 * (research §3's "Dated:" wrap trap has a sibling: PL280-ADI's tender
 * closing date wraps mid-date, "23-03-" / "2026"). Returns null — never a
 * partial/guessed date — when the string doesn't match either shape.
 */
export function parseDdMmYyyy(raw: string): string | null {
  const m = /(\d{1,2})\s*[/-]\s*(\d{1,2})\s*[/-]\s*(\d{4})/.exec(raw);
  if (m === null) {
    return null;
  }
  const [, day, month, year] = m;
  let iso: string;
  try {
    iso = toIsoDate(day ?? '', month ?? '', year ?? '');
  } catch {
    return null;
  }
  return isRealCalendarDate(iso) ? iso : null;
}

/**
 * Whether `YYYY-MM-DD` names a day the calendar actually has.
 *
 * `new Date('2026-02-31')` does not fail; it rolls forward to 3 March and
 * hands back a date nobody printed. So the round trip is compared: a value
 * that survives being formatted back is a real date, and 31/02 is not.
 *
 * Shared rather than re-derived. Three call sites read DD/MM/YYYY off a
 * railway document — the letter (`parseDdMmYyyy` itself), the variation
 * order (`apps/server/src/variation-order-verify.ts`) and the received
 * On-Account Bill (`apps/server/src/railway-bill-parse.ts`) — and two of
 * them had grown their own copy of this check while the third had none.
 */
export function isRealCalendarDate(iso: string): boolean {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(iso);
}
