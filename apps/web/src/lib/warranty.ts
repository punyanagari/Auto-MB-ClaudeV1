import type { WarrantyStartBasis } from '@auto-mb/contracts';

/**
 * The two pieces of warranty vocabulary both surfaces render, in one
 * place — the Work's Instruments card and the Warranties register show
 * the same periods from different ends, and a countdown that read
 * differently between them would be two answers to one question.
 *
 * Neither of these computes anything. `daysToExpiry` is the SERVER's
 * figure, measured against the organisation's own calendar day; the
 * browser's day is not the one that decides a legal date, which is why
 * nothing here touches `Date`.
 */

/** How the countdown is said. Null on a period that is no longer running,
 * where a countdown means nothing. */
export function warrantyCountdown(daysToExpiry: number | null): string {
  if (daysToExpiry === null) return '—';
  if (daysToExpiry < 0) return `${String(-daysToExpiry)} days over`;
  if (daysToExpiry === 0) return 'last day';
  return `${String(daysToExpiry)} days left`;
}

/** What starts the clock, in the operator's own words. */
export const WARRANTY_BASIS_LABELS: Readonly<Record<WarrantyStartBasis, string>> = {
  installation: 'the installation date',
  pac: 'the PAC certificate date',
};
