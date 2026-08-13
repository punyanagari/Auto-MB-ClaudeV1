import { cn } from '../lib/cn.js';

/** The shared operations-workspace surface. Legal documents drop all screen
 * chrome when printed; the on-screen shadow stays deliberately soft so dense
 * registers do not turn into a wall of outlined boxes. */
export function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        /* `w-full` is a width guard, not a layout preference.
         *
         * Without a stated width a card sizes itself to its content, and
         * one thing inside it that cannot be narrowed — a `<table>`, a
         * `<select>` with a long option — made the card wider than the
         * screen and the whole shell scrolled sideways with it. An
         * explicit 100% means the card takes the column it is in and
         * anything that will not fit is contained where it belongs (a
         * register in `ui/table.tsx`'s scrollport, a control by its own
         * max-width). Several views had already discovered this and passed
         * `className="w-full"` one at a time; the primitive owns it now.
         * Measured at 320px by `e2e/responsive.spec.ts`. */
        'w-full rounded-2xl border border-border/90 bg-card p-5',
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
