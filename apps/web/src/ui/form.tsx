import { useEffect, useState } from 'react';
import { cn } from '../lib/cn.js';

/** A labelled control. The label rule rides the wrapper because every field
 * has exactly one, which is what let the legacy `.field label` selector work
 * — the difference is that this one cannot leak past the component. */
export function Field({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-field=""
      /* The mock's `Field` + `FieldLabel` (`components/ui/field` at
       * a8e1fde): a vertical `gap-2` group whose label is 14px medium on
       * a snug leading. */
      className={cn(
        'my-3 flex max-w-[34rem] flex-col gap-2 [&>label]:text-sm [&>label]:leading-snug [&>label]:font-medium',
        className,
      )}
      {...props}
    />
  );
}

/** Fields sharing a line. Each child field takes an equal share and stops
 * shrinking at 10rem, so the row wraps rather than crushing its controls.
 *
 * The share is claimed by fields only, not by every child: a row that also
 * holds a button would otherwise give the button an equal column and squeeze
 * the input it belongs to. That is what `.field-row .field` said, and the
 * data attribute is how a utility says it. */
export function FieldRow({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-wrap gap-3 [&>[data-field]]:min-w-40 [&>[data-field]]:flex-1',
        className,
      )}
      {...props}
    />
  );
}

/** The trailing controls of a form or panel. */
export function Actions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('mt-4 flex flex-wrap items-center gap-2 print:hidden', className)}
      {...props}
    />
  );
}

/** An editor's primary controls, kept visible while the form scrolls. The
 * negative margins bleed it to the card's edges so it picks up the card's
 * bottom corners, so they track `ui/card.tsx`'s padding — the mock's
 * `--card-spacing` of 4 — and the radius tracks its `rounded-xl`.
 *
 * The fill stays `--card` rather than the mock's `bg-muted/50` footer
 * tint, and that is deliberate: this bar is STICKY over its own scrolling
 * form, so a translucent one would let half-typed fields read through the
 * buttons. A dialog footer, which sits over nothing, does use the tint. */
export function ActionBar({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'sticky bottom-0 -mx-4 -mb-4 mt-4 flex items-center gap-2 rounded-b-xl border-t border-border bg-card px-4 py-3 print:hidden',
        className,
      )}
      {...props}
    />
  );
}

/* The mock's `FieldError`: 14px destructive ink. The weight stays medium
 * — these two are the form's alerts, not its descriptions. */
const ERROR_TEXT = 'my-2 text-sm font-medium text-destructive';

/** Why an action failed. Always announced. */
export function FormError({ className, ...props }: React.ComponentProps<'p'>) {
  return <p role="alert" className={cn(ERROR_TEXT, className)} {...props} />;
}

/** Why one field is invalid — the target of its `aria-describedby`, and
 * deliberately silent. A form that fails validation announces once through
 * its summary; giving each field its own live region would announce the same
 * submission five times over. Same ink as FormError, no role. */
export function FieldError({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn(ERROR_TEXT, className)} {...props} />;
}

/** How long a success stays on screen. Long enough to read twice;
 * short enough that stale confirmations never pile up across
 * workflows. */
const NOTICE_LIFETIME_MS = 6000;

/** What an action changed. Announced once, then quietly retired: a
 * success is news, not state, so it expires on its own. Errors
 * (FormError) stay put until the operator fixes them — that asymmetry
 * is deliberate and repo-wide. */
export function FormNotice({
  className,
  children,
  ...props
}: React.ComponentProps<'p'>) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    const timer = window.setTimeout(() => {
      setExpired(true);
    }, NOTICE_LIFETIME_MS);
    return () => {
      window.clearTimeout(timer);
    };
    // A NEW message restarts the clock; the same message re-rendered
    // does not.
  }, [children]);
  if (expired) return null;
  return (
    <p
      role="status"
      className={cn('my-2 text-sm font-medium text-success', className)}
      {...props}
    >
      {children}
    </p>
  );
}

/** Guidance under a control — quieter and smaller than its label. */
export function Hint({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p className={cn('mt-1 text-xs text-muted-foreground', className)} {...props} />
  );
}
