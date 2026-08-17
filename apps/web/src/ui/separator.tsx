import { cn } from '../lib/cn.js';

/** A rule between two things.
 *
 * The mock's `components/ui/separator` at a8e1fde, on a plain div with no
 * base-ui runtime. Base UI marks orientation with `data-horizontal` /
 * `data-vertical` attributes and styles off those, so this emits the same
 * two attributes and carries the mock's class string unchanged.
 *
 * A vertical rule has no height of its own — `self-stretch` takes it from
 * the row it sits in, and a caller that is not in a stretch context says
 * how tall it is (`className="h-5"`, which is what the topbar does).
 */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = false,
  ...props
}: Omit<React.ComponentProps<'div'>, 'role' | 'aria-orientation'> & {
  readonly orientation?: 'horizontal' | 'vertical';
  /** A rule that only groups things visually, with no structural meaning
   * worth announcing. Hidden from assistive technology rather than read
   * out as one more separator between two things a reader can already
   * tell apart. */
  readonly decorative?: boolean;
}) {
  return (
    <div
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'separator', 'aria-orientation': orientation })}
      {...(orientation === 'horizontal'
        ? { 'data-horizontal': '' }
        : { 'data-vertical': '' })}
      className={cn(
        'shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch',
        className,
      )}
      {...props}
    />
  );
}
