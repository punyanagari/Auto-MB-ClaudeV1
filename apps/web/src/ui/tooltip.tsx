import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn.js';

/* The mock's `components/ui/tooltip` at a8e1fde — the same dark bubble, the
 * same 12px ink on `--foreground`, the same little rotated-square arrow —
 * without base-ui's positioner underneath it.
 *
 * Two things that runtime did for free have to be done by hand here, and
 * both are the reason this is a portal rather than an absolutely positioned
 * sibling:
 *
 *  - the collapsed rail is `overflow-hidden` (`shell/AppSidebar.tsx`), so a
 *    bubble anchored inside it is clipped at the rail's edge — which is
 *    precisely where a collapsed-rail tooltip has to appear;
 *  - the topbar is `backdrop-blur-xl`, and a backdrop filter makes its
 *    element a containing block for `position: fixed` descendants, so a
 *    fixed bubble inside the header would measure from the header instead
 *    of the viewport.
 *
 * Portalling to `document.body` escapes both. The trade is that the
 * position is measured once when the bubble opens rather than tracked, so
 * a scroll or a resize closes it instead of letting it drift off its
 * trigger.
 *
 * NAMING RULE: the bubble is `aria-hidden`. It says again, in view, what
 * the trigger already says to a screen reader — every consumer here is an
 * icon-only control that carries an `aria-label` or an `sr-only` label — so
 * exposing it would announce the same word twice. A trigger that is not
 * already named needs a name, not a tooltip. */

type Side = 'top' | 'right' | 'bottom' | 'left';

/** Where the bubble sits relative to the trigger, and which way the arrow
 * points out of it. Kept together so the two cannot disagree. */
function placement(side: Side, rect: DOMRect, sideOffset: number) {
  switch (side) {
    case 'right':
      return {
        style: { left: rect.right + sideOffset, top: rect.top + rect.height / 2 },
        bubble: '-translate-y-1/2',
        arrow: 'top-1/2 -left-1 -translate-y-1/2',
      };
    case 'left':
      return {
        style: { left: rect.left - sideOffset, top: rect.top + rect.height / 2 },
        bubble: '-translate-x-full -translate-y-1/2',
        arrow: 'top-1/2 -right-1 -translate-y-1/2',
      };
    case 'bottom':
      return {
        style: { left: rect.left + rect.width / 2, top: rect.bottom + sideOffset },
        bubble: '-translate-x-1/2',
        arrow: 'top-1 left-1/2 -translate-x-1/2',
      };
    case 'top':
    default:
      return {
        style: { left: rect.left + rect.width / 2, top: rect.top - sideOffset },
        bubble: '-translate-x-1/2 -translate-y-full',
        arrow: '-bottom-1 left-1/2 -translate-x-1/2',
      };
  }
}

export function Tooltip({
  content,
  side = 'top',
  sideOffset = 4,
  className,
  children,
}: {
  /** The words in the bubble. Repeats the trigger's own name. */
  readonly content: ReactNode;
  readonly side?: Side;
  readonly sideOffset?: number;
  /** Classes for the wrapper around the trigger, not for the bubble. The
   * wrapper is a real box in the layout — a rail item is `w-full` and
   * would collapse to its icon without this. */
  readonly className?: string;
  /** The control the bubble describes. It must already carry its own
   * accessible name — see the naming rule above. */
  readonly children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  /* Listeners are attached to the node rather than written as JSX props
   * because the wrapper is a plain span: `jsx-a11y/no-static-element-
   * interactions` rightly refuses a non-interactive element that handles
   * pointer and focus events, and the alternative — a fourth scoped
   * exemption in `eslint.config.js` — would be buying silence for a rule
   * that has a point. The trigger inside stays the only interactive thing
   * here, which is the arrangement the rule is asking for. `focusin` and
   * `focusout` bubble out of it; `mouseenter` and `mouseleave` fire on the
   * wrapper that encloses it. */
  useEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return undefined;
    const show = (): void => {
      setRect(anchor.getBoundingClientRect());
    };
    const hide = (): void => {
      setRect(null);
    };
    anchor.addEventListener('mouseenter', show);
    anchor.addEventListener('mouseleave', hide);
    /* Focus, not just hover: the rail is walked with Tab as often as it is
     * pointed at, and a keyboard operator gets the same label. */
    anchor.addEventListener('focusin', show);
    anchor.addEventListener('focusout', hide);
    return () => {
      anchor.removeEventListener('mouseenter', show);
      anchor.removeEventListener('mouseleave', hide);
      anchor.removeEventListener('focusin', show);
      anchor.removeEventListener('focusout', hide);
    };
  }, []);

  useEffect(() => {
    if (rect === null) return undefined;
    /* Measured once, so anything that moves the trigger under the bubble
     * dismisses it rather than leaving it stranded mid-air. Escape closes
     * it for the same reason a dialog closes on Escape: the keyboard needs
     * a way to dismiss something it did not ask to see. */
    function dismiss(): void {
      setRect(null);
    }
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') setRect(null);
    }
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [rect]);

  const seat = rect === null ? null : placement(side, rect, sideOffset);

  return (
    <span ref={anchorRef} className={cn('inline-flex', className)}>
      {children}
      {seat !== null &&
        createPortal(
          <span
            role="tooltip"
            aria-hidden="true"
            style={{ position: 'fixed', ...seat.style }}
            className={cn(
              'pointer-events-none z-50 inline-flex w-fit max-w-xs items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background',
              seat.bubble,
            )}
          >
            {content}
            <span
              className={cn(
                'absolute size-2.5 rotate-45 rounded-[2px] bg-foreground',
                seat.arrow,
              )}
            />
          </span>,
          document.body,
        )}
    </span>
  );
}
