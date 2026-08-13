/** April-to-March financial year label from a date-only string —
 * '2027-03-31' -> '2026-27', '2027-04-01' -> '2027-28'. String parts
 * only; a legal date never round-trips through a timezone (rule 6).
 *
 * Its own module because three unrelated documents now count per
 * financial year — the tax invoice, the credit note, and the standalone
 * Delivery Challan (migration 0056) — and the challan module importing
 * it from the tax-invoice barrel would close an import cycle
 * (tax-invoices/cancel.ts already imports from routes/challans.ts). */
export function financialYearLabel(documentDate: string): string {
  const year = Number(documentDate.slice(0, 4));
  const month = Number(documentDate.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
