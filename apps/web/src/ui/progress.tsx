import { cn } from '../lib/cn.js';

export function ProgressBar({
  value,
  label,
  className,
  indicatorClassName,
}: {
  value: number;
  label?: string;
  className?: string;
  indicatorClassName?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(label !== undefined ? { 'aria-label': label } : {})}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div
        className={cn(
          'h-full rounded-full bg-primary transition-[width] duration-500',
          indicatorClassName,
        )}
        style={{ width: `${String(clamped)}%` }}
      />
    </div>
  );
}
