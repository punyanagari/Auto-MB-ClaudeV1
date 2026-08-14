import { Badge } from './badge.js';

/** Every lifecycle status the product renders as a chip, mapped to the badge
 * tone that carries it. The legacy stylesheet spread these across five
 * `.chip--*` rule groups, so a status added in one view could quietly render
 * unstyled in another; the map is the single answer now.
 *
 * `pending` reads as a notice rather than a caution deliberately — an
 * amendment awaiting a decision is not a problem, it is a queue. */
const CHIP_TONES = {
  active: 'info',
  issued: 'info',
  submitted: 'info',
  pending: 'info',

  confirmed: 'success',
  completed: 'success',
  paid: 'success',
  installed: 'success',
  // An installation record that still stands. Named separately from
  // `installed` — which is a serial's own state — so the installation
  // surfaces can render `status` straight from the record instead of
  // translating one word into another at each call site.
  recorded: 'success',
  approved: 'success',

  review: 'warning',
  prepared: 'warning',
  processing: 'warning',
  // A manually-recorded IRP registration: real evidence, no provider
  // verification — caution, not success (migration 0053).
  registered_unverified: 'warning',
  // An invoice replaced in full by an issued credit note (0051): not a
  // failure, but no longer the live document either.
  superseded: 'warning',

  failed: 'destructive',
  cancelled: 'destructive',
  expired: 'destructive',
  rejected: 'destructive',
  omitted: 'destructive',
} as const;

type ChipStatus = keyof typeof CHIP_TONES;

function toneOf(status: string) {
  return status in CHIP_TONES ? CHIP_TONES[status as ChipStatus] : 'neutral';
}

/** A lifecycle status, rendered in the tone its stage earns. Statuses arrive
 * from the contracts as open strings, so an unmapped one reads neutral
 * instead of losing its chip. */
export function StatusChip({
  status,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, 'variant'> & { readonly status: string }) {
  return (
    <Badge variant={toneOf(status)} {...props}>
      {children ?? status}
    </Badge>
  );
}
