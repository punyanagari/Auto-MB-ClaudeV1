import { cn } from '../lib/cn.js';

/** A panel of the page. Anything that reaches paper drops the chrome:
 * documents here are legal artifacts, not screenshots. */
export function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-card p-5 shadow-sm',
        'print:border-0 print:p-0 print:shadow-none',
        className,
      )}
      {...props}
    />
  );
}

/** A card's title line, with room for the actions that belong to it. */
export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'mb-2 flex flex-wrap items-center justify-between gap-3 [&>h1]:m-0 [&>h2]:m-0',
        className,
      )}
      {...props}
    />
  );
}
