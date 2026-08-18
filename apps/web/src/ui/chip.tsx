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
  // A letter this organisation dispatched, and one that a later letter
  // answers (0086). `docs/DESIGN.md` § Status badge semantics puts both
  // in the primary family: an outward legal act, and a thread that has
  // been closed by one.
  sent: 'info',
  replied: 'info',

  // A tender that was won (0083). The LOA follows, and the Work follows
  // that.
  awarded: 'success',
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
  // An inward letter on file (0086). Receiving the paper is what closes
  // the step; whether it has been answered is `replied`.
  received: 'success',

  // A tender whose technical bid has been opened: the result is with
  // the railway and nobody here can do anything about it (0083).
  opened: 'warning',

  // A job card the factory has started (0084): work in hand, which is
  // the warning family's own meaning. Its sibling `planned` is
  // deliberately NOT mapped — see the note below `CHIP_TONES`.
  'in-production': 'warning',

  // A part whose available quantity has fallen to its reorder level, or
  // below what the open job cards have already spoken for (0087). The
  // mock badges this `destructive`; here it is a caution, because the
  // destructive family is cancelled/rejected/declined and a part that
  // needs reordering is a thing to do rather than a thing that failed.
  // Its two siblings, `available` and `retired`, are deliberately
  // UNMAPPED so they read neutral — being in stock is not an
  // achievement, and a retired part is finished rather than bad.
  'low-stock': 'warning',

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

  // Neutral by DECISION, not by falling off the end of the map.
  // `docs/DESIGN.md` § Status badge semantics puts `draft` in the inert
  // family and records why: a record being assembled is not in progress
  // and not good news, and an amber lamp on every draft is a lamp that is
  // always lit. It was previously unmapped, which rendered the same
  // neutral by accident — and an accident is exactly what somebody
  // "fixes" later.
  draft: 'neutral',

  // A finalised payroll run (0090) is an issued document — numbered,
  // immutable, the record of what was paid. `docs/DESIGN.md` § Status
  // badge semantics gives a completed, correct, proceed-state record the
  // success family, and the v0 mock tints its finalised run the same way;
  // unmapped it rendered neutral, identical to a draft, which is the one
  // reading it must not have.
  finalized: 'success',

  // A tender that was not won, or was not pursued (0083). Not a system
  // failure, but the end of that pipeline either way.
  lost: 'destructive',
  failed: 'destructive',
  cancelled: 'destructive',
  expired: 'destructive',
  rejected: 'destructive',
  omitted: 'destructive',
} as const;

/**
 * `planned` is deliberately absent, and it is recorded here so it is not
 * "fixed" later.
 *
 * A production job card that has been raised and not started is inert —
 * the same reading `draft` has, and the state most job cards are in for
 * most of their lives. Mapping it to warning would put an amber lamp on
 * every card the moment it is created, and a chip that is always lit
 * says nothing. Unmapped renders neutral, which is the answer.
 */
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
  tone,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, 'variant'> & {
  readonly status: string;
  /** Overrides the shared map for a status whose meaning is local.
   *
   * The map above is a PRODUCT vocabulary: `cancelled` means the same
   * destructive thing on every screen that renders it. A word that does
   * not — `closed` is a finished, successful inspection call here and
   * would be something else entirely on a register of closed accounts —
   * must not be added to it, because the map has no idea which screen is
   * asking. Such a screen names its own tone here instead. */
  readonly tone?: React.ComponentProps<typeof Badge>['variant'];
}) {
  return (
    <Badge
      variant={tone ?? toneOf(status)}
      className={cn(STATUS_SHAPE, className)}
      {...props}
    >
      <span
        aria-hidden="true"
        className="mr-1.5 size-1.5 shrink-0 rounded-full bg-current opacity-70"
      />
      {children ?? status}
    </Badge>
  );
}
