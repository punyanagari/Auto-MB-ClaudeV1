/**
 * Canonical text form of a RATE read from the database (rate columns are
 * numeric(18,6) since migration 0027, so `::text` renders six fraction
 * digits — '100.000000'). The canonical form trims trailing fractional
 * zeros but keeps at least two fraction digits, so whole and paise-level
 * rates keep their conventional money look ('100.00') while finer rates
 * show exactly their real precision ('0.8517', '2.505', '3.175636').
 *
 * Display/transport only: the numeric column stays authoritative, and a
 * canonicalised string round-trips to the same numeric value.
 */
export function canonicalRateText(raw: string): string {
  const dot = raw.indexOf('.');
  const whole = dot === -1 ? raw : raw.slice(0, dot);
  const frac = dot === -1 ? '' : raw.slice(dot + 1);
  if (!/^-?\d+$/.test(whole) || !/^\d*$/.test(frac)) return raw;
  const trimmed = frac.replace(/0+$/, '');
  const kept = trimmed.length < 2 ? frac.slice(0, 2).padEnd(2, '0') : trimmed;
  return `${whole}.${kept}`;
}
