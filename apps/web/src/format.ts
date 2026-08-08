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

/** Whole-percent progress, clamped to 0–100 for display. */
export function progressPercent(part: string, whole: string): number {
  const partValue = Number(part);
  const wholeValue = Number(whole);
  if (!Number.isFinite(partValue) || !Number.isFinite(wholeValue) || wholeValue <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((partValue / wholeValue) * 100)));
}
