import { cn } from '../lib/cn.js';

/** One figure with its name above it and its qualifier below.
 *
 * The mock's `Stat` from `components/shared` at a8e1fde. Label is the
 * shared `.section-label`, the figure is `.metric-value` — mono, tabular,
 * so a row of tiles keeps its digits in columns and a number that changes
 * does not shift the ones beside it.
 *
 * `tone` is emphasis, never the message. A figure that is bad news says so
 * in its `hint`; the colour only makes the reader look sooner, which is
 * why there is no red tone here for an operator to mistake for a status
 * lamp (`docs/UX.md` § status is never colour-alone).
 */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly tone?: 'default' | 'success' | 'warning';
  readonly className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="section-label">{label}</span>
      <span
        className={cn(
          'metric-value',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning-foreground',
        )}
      >
        {value}
      </span>
      {hint !== undefined && (
        <span className="truncate text-xs text-muted-foreground">{hint}</span>
      )}
    </div>
  );
}
