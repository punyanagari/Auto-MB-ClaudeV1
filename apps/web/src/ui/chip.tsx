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
  // A document the organisation's own certificate is now on (0091), and
  // whose signature this server's verifier read as signed_and_intact
  // before it would store the bytes. The one terminal success of the
  // signing queue.
  signed: 'success',

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

  // A signing request the kiosk has taken and is working on (0091):
  // work in hand, the same reading `in-production` carries. Its sibling
  // `pending` is already mapped above and stays there — a request
  // waiting for a kiosk is a queue, not a caution.
  claimed: 'warning',
  // A message the provider has accepted but nothing has acknowledged
  // yet, and one written before the provider was even called (0092).
  // Both are queues rather than cautions, which is the reading `pending`
  // already carries; `sent` is mapped info above for the same reason.
  queued: 'info',
  // The two acknowledgements a WhatsApp receipt brings back (0092). A
  // message that reached the handset, and one the recipient opened: both
  // are the proceed state of a delivery, which is what `docs/DESIGN.md`
  // § Status badge semantics gives the success family. Unmapped they
  // rendered neutral — identical to a queued message, which is the one
  // reading they must not have.
  delivered: 'success',
  read: 'success',
  // A template Meta approved and then throttled for poor quality (0092).
  // Work to do — the organisation has to fix the template or its
  // engagement — which is the warning family, not the destructive one:
  // nothing was refused and nothing failed. Its sibling `disabled` stays
  // unmapped and reads neutral, because a withdrawn template is finished
  // rather than bad.
  paused: 'warning',
  // An import batch whose every row has been judged and which is waiting
  // for somebody to decide (0094). Warning is the family for "awaiting
  // someone", and that is exactly what a validated batch is: the machine
  // has finished and nothing will happen until a person acts. Its
  // siblings are already mapped — `pending` above reads as a queue,
  // `completed` as the closed step, `cancelled` as withdrawn.
  validated: 'warning',
  // A staged row the register refused (0094), and the one word this
  // product uses for a thing that is simply wrong rather than cancelled
  // or rejected by somebody. `docs/DESIGN.md` § Status badge semantics
  // gives the destructive family cancelled/rejected/declined; a row that
  // cannot be written belongs with them, because unlike `low-stock` it
  // is not a thing to do — it is a thing that failed. Collision-checked
  // against every status already in this map: the word is new.
  error: 'destructive',
  // A maintenance request nobody has decided yet, and one part-way
  // through its dispatches (0088). `docs/DESIGN.md` § Status badge
  // semantics puts both in the warning family — the first is waiting on
  // somebody, the second is work in hand, which is what `pending` and
  // `partial` already read as. Their siblings `approved` and `closed`
  // are above and below: `approved` is already mapped success, and
  // `closed` is neutral for the reason `completed` is — a finished job
  // is not currently good news.
  'awaiting-approval': 'warning',
  'partially-dispatched': 'warning',
  closed: 'neutral',

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

  // Liquidated damages the railway actually imposed (0098). An act that
  // happened and is on the record, which is the primary family's own
  // reading — the same one `issued`, `submitted` and `sent` carry. NOT
  // destructive: that family is cancelled/rejected/declined, and a levy
  // the contract provides for is a fact rather than a failure. Its
  // sibling `draft` is already mapped neutral above.
  levied: 'info',
  // Damages the railway did not take, or gave back (0098). Money the
  // agency keeps: the success family, beside `paid` and `approved`.
  waived: 'success',

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
