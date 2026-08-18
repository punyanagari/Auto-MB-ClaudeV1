import { cn } from '../lib/cn.js';

/* The mock's stock badge (`components/ui/badge` at a8e1fde): a 20px
 * pill, 12px medium text, transparent border, `gap-1` between an icon and
 * its label. `ui/chip.tsx` reshapes it into the status badge — 24px,
 * `rounded-md`, 11px semibold, dot-first — exactly as the mock's
 * `components/shared` reshapes its own.
 *
 * The tints below are the mock's four status families plus its primary
 * one, read off `components/shared`. A tint is `bg-<tone>/10` with the tone
 * itself as ink and a `/20` edge; warning is the exception the mock also
 * makes, because `--warning` is a fill colour and `--warning-foreground`
 * is the ink that goes on it.
 *
 * DIVERGENCE (`neutral`). The mock pairs `bg-muted` with
 * `text-muted-foreground`, which measures 3.74:1 in light — under WCAG AA
 * 1.4.3 for text of this size. The ink here is `--secondary-foreground`,
 * the next tone up the same neutral ramp (9.2:1 light, 8.1:1 dark), so
 * the chip keeps the mock's surface and loses only the failing ink. The
 * defect is the mock's and should be fixed there; see the pull request. */
const BADGE_BASE =
  'inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap';

const BADGE_VARIANTS = {
  default: 'border-primary/20 bg-primary/10 text-primary',
  neutral: 'bg-muted text-secondary-foreground',
  success: 'border-success/20 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/15 text-warning-foreground',
  destructive: 'border-destructive/20 bg-destructive/10 text-destructive',
  /* The mock carries no informational tone, so `--info` holds the mock's
   * primary values and this family renders as the mock's "outward legal
   * act" primary tint. */
  info: 'border-info/20 bg-info/10 text-info',
  outline: 'border-border bg-transparent text-foreground',
} as const;

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & {
  readonly variant?: keyof typeof BADGE_VARIANTS | null | undefined;
}) {
  return (
    <span
      className={cn(BADGE_BASE, BADGE_VARIANTS[variant ?? 'default'], className)}
      {...props}
    />
  );
}
