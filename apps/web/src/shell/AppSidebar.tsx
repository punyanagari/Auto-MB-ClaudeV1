import { ChevronsUpDown, Upload } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { Button } from '../ui/button.js';
import { Tooltip } from '../ui/tooltip.js';
import { SidebarNav, type NavSubItem } from './SidebarNav.js';
import type { ModuleKey } from './navigation.js';

export interface AppSidebarProps {
  readonly id: string;
  readonly organisationName: string;
  readonly identityInitials: string;
  readonly identityName: string;
  readonly identityRole: string;
  readonly activeModule: ModuleKey;
  readonly pendingApprovals: number;
  readonly subItems: Partial<Record<ModuleKey, readonly NavSubItem[]>>;
  readonly collapsed: boolean;
  readonly canModify: boolean;
  readonly canSwitchOrganisation: boolean;
  readonly inert: boolean;
  readonly onOpenModule: (key: ModuleKey) => void;
  readonly onUploadLoa: () => void;
  readonly onSwitchOrganisation: () => void;
}

/** The mock's brand block: a 44px card carrying the product mark, the
 * product name and the tenant beneath it (`components/app-sidebar`).
 * The mock links it to the Dashboard; here the tenant line is the live one,
 * so the block is the organisation chooser when there is a choice to make
 * and plain identity when there is not. */
function BrandBlock({
  organisationName,
  collapsed,
  canSwitchOrganisation,
  onSwitchOrganisation,
}: {
  readonly organisationName: string;
  readonly collapsed: boolean;
  readonly canSwitchOrganisation: boolean;
  readonly onSwitchOrganisation: () => void;
}) {
  const mark = (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary font-mono text-xs font-bold text-primary-foreground">
      MB
    </span>
  );
  const names = (
    <span className="flex min-w-0 flex-1 flex-col text-left">
      <span className="truncate text-sm font-semibold tracking-tight">Auto-MB</span>
      <span className="truncate text-[11px] text-muted-foreground">
        {organisationName}
      </span>
    </span>
  );
  const shell = cn(
    'flex h-11 items-center rounded-xl border border-border bg-card shadow-sm',
    collapsed ? 'justify-center px-0' : 'gap-3 px-2.5',
  );

  if (!canSwitchOrganisation) {
    return (
      <div className={shell}>
        {mark}
        {!collapsed && names}
      </div>
    );
  }

  const chooser = (
    <button
      type="button"
      className={cn(
        shell,
        'w-full transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring',
      )}
      onClick={onSwitchOrganisation}
    >
      {mark}
      {!collapsed && names}
      {!collapsed && (
        <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="sr-only">Switch organisation</span>
    </button>
  );

  /* Collapsed, the words are gone from the block and only the mark is
     left, so the label has to come back on hover — as the mock's own
     bubble rather than the browser's `title`, which appears after a
     second-long delay, in the operating system's font, outside the
     theme. Expanded, the block already reads as itself. */
  return collapsed ? (
    <Tooltip content="Switch organisation" side="right" className="w-full">
      {chooser}
    </Tooltip>
  ) : (
    chooser
  );
}

/** The rail's footer action. Collapsed it is the button ladder's `icon`
 * step — a real size, not a `size-8` patch over the default one — and it
 * borrows the same hover bubble the destinations above it use. */
function UploadAction({
  collapsed,
  onUploadLoa,
}: {
  readonly collapsed: boolean;
  readonly onUploadLoa: () => void;
}) {
  const action = (
    <Button
      size={collapsed ? 'icon' : 'default'}
      className={cn('shadow-sm', !collapsed && 'w-full')}
      onClick={onUploadLoa}
    >
      <Upload aria-hidden="true" />
      <span className={collapsed ? 'sr-only' : undefined}>Upload LOA</span>
    </Button>
  );

  return collapsed ? (
    <Tooltip content="Upload LOA" side="right">
      {action}
    </Tooltip>
  ) : (
    action
  );
}

export function AppSidebar({
  id,
  organisationName,
  identityInitials,
  identityName,
  identityRole,
  activeModule,
  pendingApprovals,
  subItems,
  collapsed,
  canModify,
  canSwitchOrganisation,
  inert,
  onOpenModule,
  onUploadLoa,
  onSwitchOrganisation,
}: AppSidebarProps) {
  return (
    <aside
      id={id}
      className="sticky top-0 hidden h-screen flex-col overflow-hidden bg-sidebar text-sidebar-foreground lg:flex print:hidden"
      inert={inert}
    >
      <div className="p-3">
        <BrandBlock
          organisationName={organisationName}
          collapsed={collapsed}
          canSwitchOrganisation={canSwitchOrganisation}
          onSwitchOrganisation={onSwitchOrganisation}
        />
      </div>

      <nav
        className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-1"
        aria-label="Modules"
      >
        <SidebarNav
          activeModule={activeModule}
          pendingApprovals={pendingApprovals}
          subItems={subItems}
          onOpenModule={onOpenModule}
          collapsed={collapsed}
          scope="rail"
        />
      </nav>

      <div className="flex flex-col gap-3 p-3">
        {canModify && <UploadAction collapsed={collapsed} onUploadLoa={onUploadLoa} />}
        <div className="h-px w-full shrink-0 bg-sidebar-border" />
        <div
          className={cn(
            'flex items-center gap-2.5',
            collapsed ? 'justify-center' : 'px-1',
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
            {identityInitials}
          </span>
          {!collapsed && (
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-semibold">{identityName}</span>
              <span className="truncate text-[11px] text-muted-foreground">
                {identityRole}
              </span>
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}
