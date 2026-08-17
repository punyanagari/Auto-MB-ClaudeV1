import { cn } from '../lib/cn.js';

/* The mock's `components/ui/dropdown-menu` at a8e1fde: the popup surface,
 * the item, the group label and the divider, with the mock's classes intact
 * and base-ui's `Menu` runtime replaced by ordinary elements.
 *
 * WHAT THIS DELIBERATELY IS NOT: a `role="menu"` widget. The mock's is one,
 * because Base UI gives it the whole contract for free — focus moves into
 * the popup on open, arrows rove between items, Tab leaves. This build's
 * shell already keeps a different, complete contract for the two menus it
 * hangs here: the trigger keeps focus, the items follow it in tab order,
 * and `views/OperationsWorkspace.tsx` closes on Escape and hands focus
 * back to the trigger. Announcing `menu` while behaving like a group of
 * buttons would promise arrow keys that do not arrive — worse than either
 * pattern on its own. So the surface takes whatever role the caller gives
 * it (a labelled `group`, in the shell) and the items stay real buttons.
 *
 * Adopting the full menu widget is a real improvement and a separate
 * change: it moves four existing assertions off `group`/`button`
 * (`e2e/accessibility.spec.ts`, `test/views/workspace-shell.test.tsx`,
 * `test/App.test.tsx`) and needs the roving-focus contract written to go
 * with them. It is flagged, not smuggled into a primitives port. */

/** The popup surface. Positioned by the caller, which is the only one that
 * knows what it is hanging from — the shell anchors both of its menus with
 * a `relative` wrapper and this fills in the rest. */
export function DropdownMenuContent({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'absolute top-[calc(100%+0.5rem)] right-0 z-40 min-w-32 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10',
        className,
      )}
      {...props}
    />
  );
}

/** One action in the surface. A real button, so it is reachable, pressable
 * and announced without any of it being re-implemented. */
export function DropdownMenuItem({
  className,
  variant = 'default',
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & {
  /** `destructive` tints the row and its icon red. Reserved for an action
   * that removes something — the mock uses the same word. */
  readonly variant?: 'default' | 'destructive';
}) {
  return (
    <button
      type={type}
      data-variant={variant}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        variant === 'destructive' &&
          'text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive [&_svg]:text-destructive',
        className,
      )}
      {...props}
    />
  );
}

/** The heading of a group of items — in the shell, the signed-in identity
 * above the actions that act on it. Not an item: nothing happens when it
 * is pressed, so it is not a button. */
export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      className={cn('px-1.5 py-1 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  );
}

/** The divider between two runs of items. Decorative: the groups it splits
 * are already told apart by their labels and their order, so a reader
 * gains nothing from being told a line is there. */
export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}
