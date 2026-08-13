import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/* The modal surface, extracted from the two implementations that already
 * had it right: the shell's mobile navigation drawer and its unsaved-draft
 * departure confirmation (`views/OperationsWorkspace.tsx`). Both now render
 * through this component, and so does every confirmation that used to be a
 * pair of buttons swapped into the page (`ui/confirm.tsx`).
 *
 * What "right" meant in those two, and therefore what this owns:
 *
 *  - `role="dialog"` + `aria-modal="true"` on the surface, with a name from
 *    a heading (`labelledBy`) or a literal string (`label`);
 *  - focus moved into the dialog when it opens, so a keyboard operator is
 *    not left behind on a control that has just been covered;
 *  - Tab and Shift+Tab cycling inside the surface;
 *  - Escape closing it;
 *  - focus restored, on close, to whatever held it when the dialog opened —
 *    only if that element is still in the document, because the action that
 *    closed the dialog may well have unmounted its own trigger;
 *  - a click on the backdrop closing it, with the backdrop `aria-hidden` so
 *    it is not a second unnamed thing in the accessibility tree.
 *
 * What it does NOT own, stated rather than implied: the background is not
 * made `inert`. `inert` can only be set on an ancestor's siblings, and this
 * component knows nothing about where it was rendered. The shell sets it on
 * its own main column for the two dialogs it hosts, and any other caller
 * gets `aria-modal` plus the focus trap — which is what assistive
 * technology reads and what the keyboard obeys, but not a pointer lock.
 *
 * Native `<dialog showModal()>` would give all of this including inertness,
 * and is the right destination. It is not available yet: jsdom 30 — what the
 * component suites run on — does not implement `showModal`, so adopting it
 * today would mean every dialog test asserting against a polyfill instead of
 * the product. */

const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface ModalProps {
  /** Escape, the backdrop, and the close control all route here. */
  readonly onClose: () => void;
  /** The id of the heading that names the dialog. */
  readonly labelledBy?: string;
  /** A literal name, for a dialog with no visible heading of its own. */
  readonly label?: string;
  /** The id of the paragraph that describes what closing decides. */
  readonly describedBy?: string;
  /** Where focus lands on open. Defaults to the first focusable control in
   * the surface — which is why a confirmation puts its safe choice first. */
  readonly initialFocusRef?: { readonly current: HTMLElement | null };
  /** Restore focus here rather than to whatever was focused on open. The
   * shell needs it: a departure requested from inside a transient menu must
   * return the operator to the menu's trigger, not to a control the menu
   * closing has already removed. */
  readonly restoreFocusTo?: HTMLElement | null;
  /** Holds the page still behind a full-height surface. A short confirmation
   * does not need it; a drawer that covers the viewport does. */
  readonly lockScroll?: boolean;
  readonly id?: string;
  /** Classes for the surface — its size, placement and skin. The dialog
   * semantics and the trap do not vary with them. */
  readonly className?: string;
  /** Classes for the fixed layer holding backdrop and surface. */
  readonly overlayClassName?: string;
  readonly backdropClassName?: string;
  readonly children: ReactNode;
}

/** A modal dialog. Rendered only while it is open — mounting opens it and
 * unmounting closes it, so callers keep their own boolean and this component
 * keeps no `open` prop that could disagree with the tree. */
export function Modal({
  onClose,
  labelledBy,
  label,
  describedBy,
  initialFocusRef,
  restoreFocusTo,
  lockScroll = false,
  id,
  className,
  overlayClassName,
  backdropClassName,
  children,
}: ModalProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  /* Both are read inside the effect, and both are held in refs so a caller's
   * re-render cannot re-run it and take focus a second time. `initialFocusRef`
   * in particular MUST NOT be read during render: React attaches refs during
   * commit, so at render time the caller's ref is still null and the dialog
   * would silently fall back to the first focusable control. */
  const initialFocusRefRef = useRef(initialFocusRef);
  initialFocusRefRef.current = initialFocusRef;
  const restoreOverrideRef = useRef<HTMLElement | null>(null);
  restoreOverrideRef.current = restoreFocusTo ?? null;

  useEffect(() => {
    const restoreTarget =
      restoreOverrideRef.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const previousOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = 'hidden';
    const surface = surfaceRef.current;
    const target =
      initialFocusRefRef.current?.current ??
      surface?.querySelector<HTMLElement>(FOCUSABLE) ??
      surface;
    target?.focus();
    return () => {
      if (lockScroll) document.body.style.overflow = previousOverflow;
      if (restoreTarget?.isConnected === true) restoreTarget.focus();
    };
  }, [lockScroll]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      surfaceRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={cn(
        'fixed inset-0 z-[60] grid place-items-center p-4 print:hidden',
        overlayClassName,
      )}
    >
      {/* A real button, because it really is a click target — a div with an
          onClick is a control that only a mouse knows about. It is hidden
          from assistive technology and taken out of the tab order on
          purpose: Escape is the keyboard's way out, and a second unnamed
          "close" stop in front of every dialog would be noise. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className={cn(
          'absolute inset-0 cursor-default bg-foreground/30 backdrop-blur-sm',
          backdropClassName,
        )}
        onClick={onClose}
      />
      <div
        {...(id === undefined ? {} : { id })}
        ref={surfaceRef}
        className={cn(
          'relative w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl',
          className,
        )}
        role="dialog"
        aria-modal="true"
        /* On the surface rather than on the layer around it: focus never
           leaves the surface while the dialog is open (that is what the
           trap below is for), so this is where every key arrives, and the
           layer is a plain box with no business listening for keys. */
        onKeyDown={handleKeyDown}
        {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
        {...(label === undefined ? {} : { 'aria-label': label })}
        {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
        /* A surface with no focusable child of its own would otherwise leave
         * focus on <body>, outside the trap it is meant to be inside. */
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
