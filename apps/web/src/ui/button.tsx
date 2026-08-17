import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

/* The mock's button recipes (`components/ui/button` at fdfe5ef) on a
 * plain <button>, with no base-ui runtime: same variants, same size
 * ladder, same focus ring, same svg sizing, same 1px press.
 *
 * The one recipe left out is `in-data-[slot=button-group]:rounded-lg`,
 * which every small size carries in the mock. It squares the corners a
 * size has just tightened whenever the button sits inside a segmented
 * group — and this build has no button-group primitive for it to react
 * to, so the variant would be a selector nothing can ever satisfy. It
 * comes back with the group, not before it.
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
      /* The mock's full ladder. Four text heights (24/28/32/36px) each
       * paired with a square icon-only twin, so a control strip can put an
       * icon button beside a labelled one and have the two agree on height
       * without either being nudged by a caller.
       *
       * The two smallest steps round tighter than `rounded-lg`, and they
       * say so as `min(var(--radius-md), Npx)` rather than a flat value:
       * that is the mock's own expression, and it keeps the corner from
       * outgrowing the box if `--radius` is ever raised.
       *
       * `has-data-[icon=…]` is the mock's asymmetric padding. An icon is
       * visually lighter than a word, so a button that opens with one
       * ("＋ Quick action") looks over-padded on the icon side at the
       * symmetric inset. Marking the icon `data-icon="inline-start"` pulls
       * that edge in by 2px and the button reads as evenly inset. It is
       * opt-in per icon, so nothing that does not carry the attribute
       * moves. Logical names, not left/right: this product renders
       * Devanagari and will render RTL. */
      size: {
        default:
          'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        icon: 'size-8',
        'icon-xs':
          "size-6 rounded-[min(var(--radius-md),10px)] [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-7 rounded-[min(var(--radius-md),12px)]',
        'icon-lg': 'size-9',
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
