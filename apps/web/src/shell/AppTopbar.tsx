import type { RefObject } from 'react';
import {
  ArrowLeftRight,
  Bell,
  ChevronDown,
  FolderKanban,
  LogOut,
  Menu,
  PanelLeft,
  Plus,
  Search,
  Settings as SettingsIcon,
  Upload,
} from 'lucide-react';
import { Button } from '../ui/button.js';

export interface AppTopbarProps {
  readonly sidebarId: string;
  readonly organisationName: string;
  readonly sectionTitle: string;
  readonly identityInitials: string;
  readonly identityName: string;
  readonly identityRole: string;
  readonly pendingApprovals: number;
  readonly canModify: boolean;
  readonly canSwitchOrganisation: boolean;
  readonly sidebarCollapsed: boolean;
  readonly mobileNavOpen: boolean;
  readonly quickActionsOpen: boolean;
  readonly accountMenuOpen: boolean;
  readonly searchQuery: string;
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  readonly onToggleSidebar: () => void;
  readonly onOpenMobileNav: (trigger: HTMLElement) => void;
  readonly onToggleQuickActions: (trigger: HTMLElement) => void;
  readonly onToggleAccountMenu: (trigger: HTMLElement) => void;
  readonly onSearchQueryChange: (value: string) => void;
  readonly onSearch: () => void;
  readonly onUploadLoa: () => void;
  readonly onOpenWorks: () => void;
  readonly onOpenApprovals: () => void;
  readonly onOpenSettings: () => void;
  readonly onSwitchOrganisation: () => void;
  readonly onSignOut: () => void;
}

const MENU_PANEL =
  'absolute top-[calc(100%+0.5rem)] right-0 z-40 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10';
const MENU_ITEM =
  'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0';

/**
 * The mock's sticky 64px topbar (`components/app-topbar` at `a8e1fde`):
 * the sidebar trigger, the tenant over the open section, and a right cluster
 * carrying the search control, notifications and the account menu.
 *
 * Two deliberate differences from that file, both recorded in `docs/UX.md`:
 * the ⌘K chip is not rendered because the palette is Phase 4 and the rule is
 * that the chip ships only with a working shortcut, and the control is a real
 * search field rather than a button, because `/` already focuses it and the
 * label has to deliver what it promises.
 */
export function AppTopbar({
  sidebarId,
  organisationName,
  sectionTitle,
  identityInitials,
  identityName,
  identityRole,
  pendingApprovals,
  canModify,
  canSwitchOrganisation,
  sidebarCollapsed,
  mobileNavOpen,
  quickActionsOpen,
  accountMenuOpen,
  searchQuery,
  searchInputRef,
  onToggleSidebar,
  onOpenMobileNav,
  onToggleQuickActions,
  onToggleAccountMenu,
  onSearchQueryChange,
  onSearch,
  onUploadLoa,
  onOpenWorks,
  onOpenApprovals,
  onOpenSettings,
  onSwitchOrganisation,
  onSignOut,
}: AppTopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur-xl md:px-6 print:hidden">
      <Button
        variant="ghost"
        size="icon"
        className="-ml-1 size-8 lg:hidden"
        aria-label="Open navigation"
        aria-expanded={mobileNavOpen}
        aria-controls="mobile-navigation-dialog"
        aria-haspopup="dialog"
        onClick={(event) => {
          onOpenMobileNav(event.currentTarget);
        }}
      >
        <Menu aria-hidden="true" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="-ml-1 hidden size-7 rounded-md lg:inline-flex"
        aria-label="Toggle sidebar"
        aria-expanded={!sidebarCollapsed}
        aria-controls={sidebarId}
        onClick={onToggleSidebar}
      >
        <PanelLeft aria-hidden="true" />
      </Button>
      <span
        className="hidden h-5 w-px shrink-0 bg-border lg:block"
        aria-hidden="true"
      />

      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium text-muted-foreground">
          {organisationName}
        </p>
        <p className="truncate text-sm font-semibold">{sectionTitle}</p>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {/* A real search box, not a button that went to the Works register:
            the label promised records and now delivers them. `/` focuses it
            from anywhere in the workspace. */}
        <form
          role="search"
          className="hidden h-9 w-64 items-center gap-1.5 rounded-lg border border-border/80 bg-card px-2.5 text-sm text-muted-foreground shadow-sm transition-colors focus-within:border-ring hover:bg-muted md:flex"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch();
          }}
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            name="header-search"
            aria-label="Search Works and records"
            placeholder="Search anything"
            maxLength={120}
            autoComplete="off"
            className="min-h-0 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-foreground shadow-none outline-none"
            value={searchQuery}
            onChange={(event) => {
              onSearchQueryChange(event.target.value);
            }}
            onKeyDown={(event) => {
              // Escape gives the keyboard back without submitting, the same
              // way Escape closes the mobile navigation.
              if (event.key === 'Escape') event.currentTarget.blur();
            }}
          />
          <kbd
            aria-hidden="true"
            className="ml-auto shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]"
          >
            /
          </kbd>
        </form>

        <div className="relative">
          <Button
            size="sm"
            aria-label={quickActionsOpen ? 'Close quick actions' : 'Open quick actions'}
            aria-expanded={quickActionsOpen}
            aria-controls="header-quick-actions"
            onClick={(event) => {
              onToggleQuickActions(event.currentTarget);
            }}
          >
            <Plus aria-hidden="true" />
            <span className="hidden sm:inline">Quick action</span>
            <ChevronDown className="hidden size-3.5 sm:block" aria-hidden="true" />
          </Button>
          {quickActionsOpen && (
            <div
              id="header-quick-actions"
              className={`${MENU_PANEL} w-64`}
              role="group"
              aria-label="Quick actions"
            >
              {canModify && (
                <button type="button" className={MENU_ITEM} onClick={onUploadLoa}>
                  <Upload className="text-primary" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold">Upload LOA</span>
                    <span className="block text-xs text-muted-foreground">
                      Start a new awarded Work
                    </span>
                  </span>
                </button>
              )}
              <button type="button" className={MENU_ITEM} onClick={onOpenWorks}>
                <FolderKanban className="text-primary" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold">Open Works</span>
                  <span className="block text-xs text-muted-foreground">
                    Find a contract or document
                  </span>
                </span>
              </button>
              <button type="button" className={MENU_ITEM} onClick={onOpenApprovals}>
                <Bell className="text-primary" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold">Approval queue</span>
                  <span className="block text-xs text-muted-foreground">
                    {pendingApprovals > 0
                      ? `${String(pendingApprovals)} decisions waiting`
                      : 'No pending decisions'}
                  </span>
                </span>
              </button>
            </div>
          )}
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="relative size-8"
          aria-label={
            pendingApprovals > 0
              ? `${String(pendingApprovals)} pending approvals`
              : 'No pending approvals'
          }
          onClick={onOpenApprovals}
        >
          <Bell aria-hidden="true" />
          {pendingApprovals > 0 && (
            <span className="absolute top-2 right-2 size-1.5 rounded-full bg-warning" />
          )}
        </Button>

        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 p-0"
            aria-label="Account menu"
            aria-expanded={accountMenuOpen}
            aria-controls="header-account-menu"
            onClick={(event) => {
              onToggleAccountMenu(event.currentTarget);
            }}
          >
            <span className="flex size-8 items-center justify-center rounded-full border border-border bg-accent text-xs font-bold text-accent-foreground">
              {identityInitials}
            </span>
          </Button>
          {accountMenuOpen && (
            <div
              id="header-account-menu"
              className={`${MENU_PANEL} w-60`}
              role="group"
              aria-label="Account"
            >
              <p className="flex flex-col gap-0.5 px-1.5 py-1 text-sm">
                <span className="truncate font-medium">{identityName}</span>
                <span className="truncate text-xs font-normal text-muted-foreground">
                  {identityRole}
                </span>
              </p>
              <div className="-mx-1 my-1 h-px bg-border" />
              <button type="button" className={MENU_ITEM} onClick={onOpenSettings}>
                <SettingsIcon aria-hidden="true" />
                Settings
              </button>
              {canSwitchOrganisation && (
                <button
                  type="button"
                  className={MENU_ITEM}
                  onClick={onSwitchOrganisation}
                >
                  <ArrowLeftRight aria-hidden="true" />
                  Switch organisation
                </button>
              )}
              <div className="-mx-1 my-1 h-px bg-border" />
              <button type="button" className={MENU_ITEM} onClick={onSignOut}>
                <LogOut aria-hidden="true" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
