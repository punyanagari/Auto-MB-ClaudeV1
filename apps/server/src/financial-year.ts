/**
 * The Indian April-to-March financial year, as a label.
 *
 * This lives at the server root rather than inside the tax-invoice routes
 * because two layers need the same answer and must not disagree: the routes
 * freeze it on a document as `fy_label` and number series inside it, and the
 * statutory-provider adapter needs the identical string to derive an IRN
 * locally (`gsp/irn.ts`) — the NIC IRN is a hash OVER this label, so a second
 * implementation drifting by one character would make every derivation
 * mismatch and refuse legitimate evidence. One function, one answer.
 */

/** April-to-March financial year label from a date-only string —
 * '2027-03-31' -> '2026-27', '2027-04-01' -> '2027-28'. String parts
 * only; a legal date never round-trips through a timezone (rule 6). */
export function financialYearLabel(invoiceDate: string): string {
  const year = Number(invoiceDate.slice(0, 4));
  const month = Number(invoiceDate.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
