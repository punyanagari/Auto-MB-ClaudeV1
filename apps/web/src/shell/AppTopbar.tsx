import type { RefObject } from 'react';
import {
  ArrowLeftRight,
  Bell,
  LogOut,
  Menu,
  PanelLeft,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react';
import { Button } from '../ui/button.js';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu.js';
import { Separator } from '../ui/separator.js';
import { Tooltip } from '../ui/tooltip.js';

interface AppTopbarProps {
  readonly sidebarId: string;
  readonly organisationName: string;
  readonly sectionTitle: string;
  readonly identityInitials: string;
  readonly identityName: string;
  readonly identityRole: string;
  readonly pendingApprovals: number;
  readonly canSwitchOrganisation: boolean;
  readonly sidebarCollapsed: boolean;
  readonly mobileNavOpen: boolean;
  readonly accountMenuOpen: boolean;
  readonly searchQuery: string;
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  readonly onToggleSidebar: () => void;
  readonly onOpenMobileNav: (trigger: HTMLElement) => void;
  readonly onToggleAccountMenu: (trigger: HTMLElement) => void;
  readonly onSearchQueryChange: (value: string) => void;
  readonly onSearch: () => void;
  readonly onOpenApprovals: () => void;
  readonly onOpenSettings: () => void;
  readonly onSwitchOrganisation: () => void;
  readonly onSignOut: () => void;
}

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
  canSwitchOrganisation,
  sidebarCollapsed,
  mobileNavOpen,
  accountMenuOpen,
  searchQuery,
  searchInputRef,
  onToggleSidebar,
  onOpenMobileNav,
  onToggleAccountMenu,
  onSearchQueryChange,
  onSearch,
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
        className="-ml-1 lg:hidden"
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
        size="icon-sm"
        className="-ml-1 hidden lg:inline-flex"
        aria-label="Toggle sidebar"
        aria-expanded={!sidebarCollapsed}
        aria-controls={sidebarId}
        onClick={onToggleSidebar}
      >
        <PanelLeft aria-hidden="true" />
      </Button>
      <Separator orientation="vertical" decorative className="hidden h-5 lg:block" />

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

        {/* The mock puts a tooltip on this control and nothing else in the
            topbar. The count is already the button's accessible name, so
            the bubble only shows a pointer what the label already says. */}
        <Tooltip
          content={
            pendingApprovals > 0
              ? `${String(pendingApprovals)} pending approvals`
              : 'No pending approvals'
          }
          side="bottom"
        >
          <Button
            variant="ghost"
            size="icon"
            className="relative"
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
        </Tooltip>

        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
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
            <DropdownMenuContent
              id="header-account-menu"
              className="w-60"
              role="group"
              aria-label="Account"
            >
              <DropdownMenuLabel className="flex flex-col gap-0.5 text-sm text-popover-foreground">
                <span className="truncate font-medium">{identityName}</span>
                <span className="truncate text-xs font-normal text-muted-foreground">
                  {identityRole}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onOpenSettings}>
                <SettingsIcon aria-hidden="true" />
                Settings
              </DropdownMenuItem>
              {canSwitchOrganisation && (
                <DropdownMenuItem onClick={onSwitchOrganisation}>
                  <ArrowLeftRight aria-hidden="true" />
                  Switch organisation
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onSignOut}>
                <LogOut aria-hidden="true" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          )}
        </div>
      </div>
    </header>
  );
}
