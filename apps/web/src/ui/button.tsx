import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

/* The mock's button recipes (`components/ui/button` at a8e1fde) on a
 * plain <button>, with no base-ui runtime: same variants, same size
 * ladder, same focus ring, same svg sizing, same 1px press.
 *
 * A button is 32px tall here, not 36. That is the mock's density and the
 * density is the point — a control strip above a 129-row ledger is part
 * of the instrument, not a landing page. The press translate skips
 * anything that opens a menu (`aria-haspopup`), because a trigger that
 * drops 1px while its popup is anchored to it makes the popup jump. */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/80',
        outline:
          'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-muted hover:text-foreground',
        destructive: 'bg-destructive/10 text-destructive hover:bg-destructive/20',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 gap-1.5 px-2.5',
        sm: "h-7 gap-1 px-2.5 text-[0.8rem] [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 gap-1.5 px-2.5',
        icon: 'size-8',
        /** A button that reads as a link inside running text or a table
         * cell: no box of its own, and free to wrap with the line. */
        inline: 'h-auto p-0 whitespace-normal',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export function Button({
  className,
  variant = 'default',
  size = 'default',
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
