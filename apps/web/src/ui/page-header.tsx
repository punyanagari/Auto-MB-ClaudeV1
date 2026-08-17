import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/** The block that opens a screen: what section this is, what the screen is
 * called, what it is for, and the one action it exists to offer.
 *
 * The mock's `PageHeader` from `components/shared` at a8e1fde, verbatim in
 * shape and spacing — `mb-7`, a `gap-4` row that wraps with the action
 * aligned to the baseline of the title, and a `gap-1.5` stack inside it.
 * The eyebrow is the shared `.section-label`, not a copy of its utilities.
 *
 * One addition the mock has no need for: `titleId`. Navigation in this
 * build moves focus to the heading of the view it just opened, so the
 * heading has to be addressable and focusable — `id` plus `tabIndex={-1}`
 * is the convention every hand-written view heading already follows
 * (`views/Approvals.tsx`, `views/ChallanDetail.tsx`). A screen adopting
 * this component keeps its anchor instead of losing it.
 */
export function PageHeader({
  title,
  titleId,
  description,
  eyebrow,
  action,
  className,
}: {
  readonly title: ReactNode;
  readonly titleId?: string;
  readonly description?: ReactNode;
  /** The section this screen belongs to, above its name. */
  readonly eyebrow?: string;
  /** The screen's primary action. A header carries one; a second control
   * belongs in the surface it acts on. */
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn('mb-7 flex flex-wrap items-end justify-between gap-4', className)}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow !== undefined && <span className="section-label">{eyebrow}</span>}
        <h1
          {...(titleId === undefined ? {} : { id: titleId })}
          tabIndex={-1}
          className="text-2xl font-semibold tracking-[-0.025em] text-balance md:text-3xl"
        >
          {title}
        </h1>
        {description !== undefined && (
          <p className="max-w-2xl text-sm leading-6 text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action !== undefined && (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      )}
    </div>
  );
}
