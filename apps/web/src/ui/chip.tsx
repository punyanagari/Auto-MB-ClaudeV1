import { cn } from '../lib/cn.js';
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
  // A company document whose newest version is inside its validity
  // window with room to spare (migration 0079).
  valid: 'success',

  review: 'warning',
  prepared: 'warning',
  // A company document whose newest version lapses inside the warning
  // window (migration 0079). `docs/DESIGN.md` § Status badge semantics
  // puts `expiring` in the warning family; `expired` below is already
  // destructive, and a document with no expiry at all sends `none`,
  // which stays unmapped and reads neutral — "outside the question" is
  // not "currently good".
  expiring: 'warning',
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

/** The mock's status badge, verbatim from `components/shared` at
 * a8e1fde: a 24px `rounded-md` chip — not the stock pill — carrying 11px
 * semibold capitalised text behind a 6px dot that inherits the ink at 70%
 * opacity.
 *
 * The dot NEVER carries the meaning on its own. It is decoration in front
 * of a word, which is what keeps record state off the colour-only path
 * (WCAG 1.4.1) and what the axe gate checks. Do not "tidy" a status
 * surface down to the dot. */
const STATUS_SHAPE = 'h-6 rounded-md px-2 text-[11px] font-semibold capitalize';

/** A lifecycle status, rendered in the tone its stage earns. Statuses arrive
 * from the contracts as open strings, so an unmapped one reads neutral
 * instead of losing its chip. */
export function StatusChip({
  status,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, 'variant'> & { readonly status: string }) {
  return (
    <Badge variant={toneOf(status)} className={cn(STATUS_SHAPE, className)} {...props}>
      <span
        aria-hidden="true"
        className="mr-1.5 size-1.5 shrink-0 rounded-full bg-current opacity-70"
      />
      {children ?? status}
    </Badge>
  );
}
