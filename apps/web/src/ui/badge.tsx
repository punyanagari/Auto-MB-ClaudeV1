import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap border',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/10 text-primary',
        neutral: 'border-border bg-muted text-muted-foreground',
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
