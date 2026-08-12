import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap border',
  {
    variants: {
      /* Badge text is 12px, so every tint/ink pairing must hold 4.5:1 in
       * both themes (WCAG 1.4.3): the blue chip uses the accent ink rather
       * than raw primary, and the neutral chip uses the secondary ink
       * rather than muted-foreground, whose ratio on the muted tint is
       * borderline. Verified by the live axe/contrast gate. */
      variant: {
        default: 'border-transparent bg-accent text-accent-foreground',
        neutral: 'border-border bg-muted text-secondary-foreground',
        success: 'border-transparent bg-success/12 text-success',
        warning: 'border-transparent bg-warning/15 text-warning-foreground',
        destructive: 'border-transparent bg-destructive/10 text-destructive',
        info: 'border-transparent bg-info/12 text-info',
        outline: 'border-border bg-transparent text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
