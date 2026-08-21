import { useId } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './button.js';

/**
 * A choice whose DATA condition is not met.
 *
 * The rule this exists to enforce: a choice the product could offer, but
 * cannot offer YET, stays on the screen — disabled, and saying what would
 * have to be true. Hiding it teaches the operator that the feature does
 * not exist, which is the one thing that is definitely false; they then
 * go looking for it in the wrong module, or ask whether it was ever
 * built. The condition is nearly always something they can fix in a
 * minute somewhere else, and naming it is the whole difference between a
 * dead end and a next step.
 *
 * The reason is a VISIBLE line under the control, not only a `title`.
 * A tooltip is a pointer affordance: a touch screen has no hover, a
 * disabled button is not in the tab order so keyboard focus never reaches
 * it, and a name that exists only in a tooltip is a name the axe gate
 * counts as absent. The `title` rides along for a mouse user who is
 * already hovering, and `aria-describedby` binds the line to the control
 * so the two are one announcement rather than two neighbours.
 *
 * PERMISSION is deliberately NOT a reason to use this. A choice withheld
 * because the caller's membership does not carry the right stays hidden:
 * a disabled control naming the permission it wants publishes the
 * permission matrix to everyone who cannot use it, which is a different
 * and worse failure than a missing button. This helper is for conditions
 * about DATA — no consignee yet, no client contact yet, no priced line
 * yet — which every member of the organisation may know about.
 */
/**
 * The same rule for a control that is not a button — a `select` whose
 * options cannot be offered yet, most of them.
 *
 * Returns the props to spread on the control and the id to put on the
 * `Hint` beneath it. The two are handed out together on purpose: a
 * disabled control and a nearby sentence are two things a screen reader
 * announces separately, and `aria-describedby` is what makes them one.
 * The `Hint` primitive takes an `id` but does not mint one, so this does.
 *
 * `reason` is null when the condition is met and the control is live, in
 * which case nothing is disabled and nothing is described — the caller
 * still renders its ordinary hint under the returned id, which is
 * harmless and keeps the markup the same shape in both states.
 */
export function useUnavailableControl(reason: string | null): {
  readonly control: {
    readonly disabled: boolean;
    readonly 'aria-describedby'?: string;
  };
  readonly hintId: string;
} {
  const hintId = useId();
  return {
    control:
      reason === null
        ? { disabled: false }
        : { disabled: true, 'aria-describedby': hintId },
    hintId,
  };
}

export function UnavailableAction({
  reason,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'disabled' | 'onClick'> & {
  readonly reason: string;
}) {
  const reasonId = useId();
  return (
    <span className={cn('inline-flex flex-col items-start gap-1', className)}>
      <Button {...props} disabled aria-disabled="true" aria-describedby={reasonId}>
        {children}
      </Button>
      <span id={reasonId} className="text-xs text-muted-foreground" title={reason}>
        {reason}
      </span>
    </span>
  );
}
