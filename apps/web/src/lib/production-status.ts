import type { JobCardStatus } from '@auto-mb/contracts';

/** The chip's key.
 *
 * `in_production` is hyphenated for the chip's vocabulary, which is a
 * word-per-state map rather than a column-name map: `docs/DESIGN.md`
 * § Status badge semantics spells multi-word statuses with a hyphen and
 * gives them a display label. */
export function statusKeyOf(card: { readonly status: JobCardStatus }): string {
  return card.status === 'in_production' ? 'in-production' : card.status;
}

export function statusLabelOf(card: { readonly status: JobCardStatus }): string {
  switch (card.status) {
    case 'in_production':
      return 'In production';
    case 'planned':
      return 'Planned';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
  }
}
