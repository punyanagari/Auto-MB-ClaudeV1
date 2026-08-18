import type { ReactElement } from 'react';
import { cn } from '../lib/cn.js';
import { navigateOnClick } from '../lib/workspace-routes.js';
import { Tooltip } from '../ui/tooltip.js';
import { moduleHash, NAVIGATION, type ModuleKey } from './navigation.js';

/** A collapsed destination is an icon with an `sr-only` label: named for a
 * screen reader, unlabelled for an eye. The mock's bubble puts the word
 * back on hover and on focus. Expanded, the label is already on screen and
 * a bubble repeating it would be noise. */
function withRailLabel(
  collapsed: boolean,
  label: string,
  destination: ReactElement,
): ReactElement {
  return collapsed ? (
    <Tooltip content={label} side="right" className="w-full">
      {destination}
    </Tooltip>
  ) : (
    destination
  );
}

/** A destination inside an open module. The mock's rail is flat, but its own
 * component library draws this shape (`components/ui/sidebar` →
 * `SidebarMenuSub`), so the two the application carries — the Works module's
 * parts and the Masters categories — render in the mock's grammar rather
 * than in one invented here. */
export interface NavSubItem {
  readonly label: string;
  /** The fragment this destination lives at, so the row is a real link.
   * `open` still runs the in-app move on a plain click. */
  readonly href: string;
  readonly open: () => void;
  readonly current: boolean;
}

interface SidebarNavProps {
  readonly activeModule: ModuleKey;
  readonly pendingApprovals: number;
  readonly subItems: Partial<Record<ModuleKey, readonly NavSubItem[]>>;
  readonly onOpenModule: (key: ModuleKey) => void;
  /** The mobile drawer closes behind a selection; the desk rail does not. */
  readonly onSelected?: () => void;
  /** Modules the current member may not see at all, so the rail carries
   * no door to them. Employees/payroll (migration 0089) is hidden from a
   * member without the payroll authority — a register of salaries is not
   * something to advertise a way into. Empty for everything else, which
   * gates at the screen rather than in the rail. */
  readonly hiddenModules?: ReadonlySet<ModuleKey> | undefined;
  /** The mock's `collapsible="icon"` state: labels go, icons stay. */
  readonly collapsed?: boolean;
  /** Prefixes the submenu ids. The rail and the drawer render the same
   * navigation at the same time — the desk aside is hidden by CSS, not
   * unmounted — so one id per module would be two elements with one id
   * whenever the drawer is open. */
  readonly scope: string;
}

const EMPTY_HIDDEN: ReadonlySet<ModuleKey> = new Set();

export function SidebarNav({
  activeModule,
  pendingApprovals,
  subItems,
  onOpenModule,
  onSelected,
  hiddenModules = EMPTY_HIDDEN,
  collapsed = false,
  scope,
}: SidebarNavProps) {
  return (
    <>
      {NAVIGATION.map((group) => {
        const items = group.items.filter((item) => !hiddenModules.has(item.key));
        // A group whose every entry is hidden takes its heading with it,
        // so the rail never shows an empty "Administration" label.
        if (items.length === 0) return null;
        return (
          <div
            key={group.label ?? 'primary'}
            className={cn(
              'relative flex w-full min-w-0 flex-col',
              group.label === null ? 'py-1' : 'py-2',
            )}
          >
            {group.label !== null && (
              <p
                className={cn(
                  collapsed
                    ? 'sr-only'
                    : 'flex h-8 shrink-0 items-center px-2 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase',
                )}
              >
                {group.label}
              </p>
            )}
            <ul className="flex w-full min-w-0 list-none flex-col gap-0">
              {items.map((item) => {
                const Icon = item.icon;
                const current = activeModule === item.key;
                const children = subItems[item.key] ?? [];
                const submenuId = `${scope}-submenu-${item.key}`;
                const showBadge = item.key === 'approvals' && pendingApprovals > 0;
                return (
                  <li key={item.key} className="relative">
                    {withRailLabel(
                      collapsed,
                      item.label,
                      <a
                        href={moduleHash(item.key)}
                        className={cn(
                          'flex w-full items-center gap-2 overflow-hidden rounded-lg text-left text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring [&>span:last-child]:truncate',
                          collapsed ? 'size-8 justify-center p-2' : 'h-9 p-2',
                          current
                            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                            : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                        )}
                        aria-current={current ? 'page' : undefined}
                        aria-expanded={children.length > 0 ? current : undefined}
                        /* Names the list the state refers to. Present only
                       alongside aria-expanded, so it never points at an id
                       that no module will ever render. */
                        aria-controls={children.length > 0 ? submenuId : undefined}
                        onClick={navigateOnClick(() => {
                          onOpenModule(item.key);
                          onSelected?.();
                        })}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1'}>
                          {item.label}
                        </span>
                      </a>,
                    )}
                    {showBadge && !collapsed && (
                      <span className="pointer-events-none absolute top-1.5 right-1 flex h-5 min-w-5 items-center justify-center rounded-md bg-warning/15 px-1 font-mono text-xs font-medium text-warning-foreground tabular-nums">
                        {pendingApprovals}
                        <span className="sr-only"> pending approvals</span>
                      </span>
                    )}
                    {current && children.length > 0 && !collapsed && (
                      <ul
                        id={submenuId}
                        className="mx-3.5 flex min-w-0 translate-x-px list-none flex-col gap-0.5 border-l border-sidebar-border px-2.5 py-0.5"
                      >
                        {children.map((child) => (
                          <li key={child.label}>
                            <a
                              href={child.href}
                              className={cn(
                                'flex h-7 w-full min-w-0 -translate-x-px items-center overflow-hidden rounded-md px-2 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                                child.current
                                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                              )}
                              aria-current={child.current ? 'page' : undefined}
                              onClick={navigateOnClick(() => {
                                child.open();
                                onSelected?.();
                              })}
                            >
                              <span className="truncate">{child.label}</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}
