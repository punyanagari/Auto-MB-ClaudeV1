import { cn } from '../lib/cn.js';
import { Button } from './button.js';

/*
 * The three states a screen is in when it is not showing records.
 *
 * `docs/UX.md` ("Shared states") has always asked every register and detail
 * page for distinct loading, empty and failure patterns. What shipped was
 * one skeleton in the whole client, a retry beside three of about thirty
 * load failures, and about twenty-seven views whose failure branch printed
 * a sentence and stopped. A sentence is not a state: the operator is told
 * the register could not be read and given nothing to do about it, on a
 * screen whose own reload button is the browser's.
 *
 * So the failure primitive here takes `onRetry` as a REQUIRED prop. There is
 * no variant without it and no default that quietly does nothing — a load
 * that can fail has to say how it is re-run, and the type checker is what
 * asks. That is the whole point of this module; keep it that way.
 */

/** One placeholder bar. Sized by the caller; never announced on its own —
 * the surrounding LoadingState carries the announcement.
 *
 * The pulse is `motion-safe:` as well as being caught by the global
 * reduced-motion rule in `globals.css`, so the intent is legible at the
 * component and not only in a stylesheet three files away. */
export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'motion-safe:animate-pulse rounded-md bg-muted-foreground/15',
        'h-4 w-full',
        className,
      )}
      {...props}
    />
  );
}

interface LoadingStateProps {
  /** What is being read, as an operator would say it: "Delivery Challans",
   * "the approvals queue". Announced; never rendered as visible text, so the
   * placeholder shape stays the only thing on screen. */
  readonly label: string;
  /** Placeholder rows. Roughly what the register usually shows, so the page
   * does not jump when the records arrive. */
  readonly rows?: number;
  /** Placeholder columns per row. One column reads as a paragraph, which is
   * what a detail panel wants; three or more read as a table. */
  readonly columns?: number;
  readonly className?: string;
}

/** The wait, as the shape of what is coming rather than a spinner. Skeletons
 * for lists and tables are the house rule (`docs/UX.md`); a spinner says
 * "something is happening", a skeleton says "records are coming and there
 * will be about this many". */
export function LoadingState({
  label,
  rows = 4,
  columns = 1,
  className,
}: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn('my-3 flex flex-col gap-2', className)}
    >
      <span className="sr-only">Loading {label}…</span>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-3">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton
              key={column}
              className={cn(
                // The first column is the row's name and the widest.
                column === 0 ? 'flex-[2]' : 'flex-1',
                // A single-column block is a paragraph, and a paragraph's
                // last line is short.
                columns === 1 && row === rows - 1 && 'max-w-[60%]',
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

interface EmptyStateProps {
  /** One plain operational sentence. Not a headline, not an apology, and
   * not an explanation of the feature: what is not here yet, and what
   * putting something here would mean. */
  readonly children: React.ReactNode;
  /** The one action that ends the emptiness. Omitted when the operator
   * genuinely cannot act — a read-only register, or a list that fills
   * itself as other work is recorded. */
  readonly action?: {
    readonly label: string;
    readonly onClick: () => void;
  };
  readonly className?: string;
}

/** Nothing here yet, said once, with the action that changes that. */
export function EmptyState({ children, action, className }: EmptyStateProps) {
  return (
    <div className={cn('my-3 flex flex-col items-start gap-3', className)}>
      <p className="m-0 text-sm text-muted-foreground">{children}</p>
      {action !== undefined && (
        <Button variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

interface ErrorStateProps {
  /** What failed and what it means for the work in front of the operator.
   * The server's own message when there is one — it is written for this
   * screen — otherwise a plain sentence naming the register. */
  readonly children: React.ReactNode;
  /**
   * Re-runs the load that failed. REQUIRED: an error state without a way
   * back is a dead end, and this product shipped about twenty-seven of
   * them. Views hold a `loadVersion` counter and bump it here; the mount
   * effect depends on it, so one prop re-runs every load on the screen.
   */
  readonly onRetry: () => void;
  /** Names what is retried when a screen has more than one failure on it
   * ("Retry consignees"). Defaults to the plain verb. */
  readonly retryLabel?: string;
  /** Anything else that resolves this particular failure — a link to the
   * record the refusal named, for instance. Sits beside the retry. */
  readonly action?: React.ReactNode;
  readonly className?: string;
}

/** A failure that persists until it is fixed, with the way to fix it.
 *
 * Announced as an alert, unlike the success notice beside it, which
 * expires: an error is state, a success is news. The lamp is the same
 * destructive ink the rest of the product refuses in. */
export function ErrorState({
  children,
  onRetry,
  retryLabel = 'Try again',
  action,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'my-3 flex flex-col items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/5 p-4',
        className,
      )}
    >
      <p className="m-0 flex items-start gap-2 text-[13px] font-medium text-destructive">
        <span
          aria-hidden="true"
          className="mt-1.5 size-2 shrink-0 rounded-full bg-destructive"
        />
        <span>{children}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
        {action}
      </div>
    </div>
  );
}
