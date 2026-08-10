import { cn } from '../lib/cn.js';

/** A calm application surface. Legal documents drop all screen chrome when
 * printed; the on-screen shadow is deliberately soft so dense registers do
 * not turn into a wall of outlined boxes. */
export function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'rounded-2xl border border-border/90 bg-card p-5',
        'shadow-[0_1px_2px_rgba(16,24,40,0.03),0_10px_30px_rgba(16,24,40,0.035)]',
        'print:rounded-none print:border-0 print:p-0 print:shadow-none',
        className,
      )}
      {...props}
    />
  );
}

/** A card's title line, with room for actions that belong to that surface. */
export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'mb-3 flex flex-wrap items-start justify-between gap-3 [&>h1]:m-0 [&>h2]:m-0',
        className,
      )}
      {...props}
    />
  );
}
