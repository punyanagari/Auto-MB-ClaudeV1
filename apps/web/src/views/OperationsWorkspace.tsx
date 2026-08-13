import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { Organisation, Work } from '@auto-mb/contracts';
import {
  ArrowLeftRight,
  Bell,
  BriefcaseBusiness,
  Building2,
  CheckCircle,
  ChevronDown,
  Database,
  FileText,
  Truck,
  LayoutDashboard,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  ScanBarcode,
  Search,
  Settings as SettingsIcon,
  Upload,
  Users,
  X,
} from 'lucide-react';
import type { ApiClient, MeResponse } from '../api.js';
import { useDocumentTitle } from '../lib/document-title.js';
import {
  parseWorkspaceHash,
  workspaceHashOf,
  type WorkspaceRoute,
  type WorkspaceView,
} from '../lib/workspace-routes.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { Modal } from '../ui/dialog.js';
import type { MastersTab } from './Masters.js';
import type { WorkTab } from './WorkDetail.js';

/* The views are code-split at this switch.
 *
 * Statically imported, all twenty of them plus everything they pull in
 * landed in one 899 KiB entry chunk, so signing in downloaded and parsed
 * the LOA review screen, the quotation editor and the Masters registers
 * before the Dashboard could paint. Each view is now its own chunk,
 * fetched the first time it is opened and cached thereafter; the entry
 * chunk carries the shell, the sign-in path and the shared primitives.
 *
 * `lazy` wants a module whose default export is the component, and these
 * are all named exports, so each import is mapped rather than re-exported
 * — a default export would be a second name for the same component and
 * the views are imported by name in the tests. */
const Approvals = lazy(() =>
  import('./Approvals.js').then((module) => ({ default: module.Approvals })),
);
const ChallanDetail = lazy(() =>
  import('./ChallanDetail.js').then((module) => ({ default: module.ChallanDetail })),
);
const ChallanEditor = lazy(() =>
  import('./ChallanEditor.js').then((module) => ({ default: module.ChallanEditor })),
);
const DeliveryChallans = lazy(() =>
  import('./DeliveryChallans.js').then((module) => ({
    default: module.DeliveryChallans,
  })),
);
const IssueChallanDetail = lazy(() =>
  import('./IssueChallanDetail.js').then((module) => ({
    default: module.IssueChallanDetail,
  })),
);
const IssueChallanEditor = lazy(() =>
  import('./IssueChallanEditor.js').then((module) => ({
    default: module.IssueChallanEditor,
  })),
);
const Masters = lazy(() =>
  import('./Masters.js').then((module) => ({ default: module.Masters })),
);
const Members = lazy(() =>
  import('./Members.js').then((module) => ({ default: module.Members })),
);
const OperationsDashboard = lazy(() =>
  import('./OperationsDashboard.js').then((module) => ({
    default: module.OperationsDashboard,
  })),
);
const Quotations = lazy(() =>
  import('./Quotations.js').then((module) => ({ default: module.Quotations })),
);
const ReviewLoa = lazy(() =>
  import('./ReviewLoa.js').then((module) => ({ default: module.ReviewLoa })),
);
const SearchView = lazy(() =>
  import('./Search.js').then((module) => ({ default: module.Search })),
);
const SerialLookup = lazy(() =>
  import('./SerialLookup.js').then((module) => ({ default: module.SerialLookup })),
);
const AccountSecurity = lazy(() =>
  import('./AccountSecurity.js').then((module) => ({
    default: module.AccountSecurity,
  })),
);
const AppearanceSettings = lazy(() =>
  import('./AppearanceSettings.js').then((module) => ({
    default: module.AppearanceSettings,
  })),
);
const Settings = lazy(() =>
  import('./Settings.js').then((module) => ({ default: module.Settings })),
);
const OrganisationAccessSettings = lazy(() =>
  import('./OrganisationAccessSettings.js').then((module) => ({
    default: module.OrganisationAccessSettings,
  })),
);
const UploadLoa = lazy(() =>
  import('./UploadLoa.js').then((module) => ({ default: module.UploadLoa })),
);
const WorkDetail = lazy(() =>
  import('./WorkDetail.js').then((module) => ({ default: module.WorkDetail })),
);
const Works = lazy(() =>
  import('./Works.js').then((module) => ({ default: module.Works })),
);

/**
 * Moves focus onto the heading of whichever view has just opened.
 *
 * It renders nothing and exists only for its effect's timing: the
 * workspace's own `[view]` effect fires as soon as the switch changes,
 * which — with the views code-split — can be while the fallback is on
 * screen and the heading does not exist yet. Rendered inside the
 * Suspense boundary, this one fires when the view itself commits.
 */
function ViewFocus({
  routeKey,
  containerRef,
}: {
  readonly routeKey: WorkspaceView;
  readonly containerRef: RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    containerRef.current?.querySelector('h1')?.focus();
  }, [routeKey, containerRef]);
  return null;
}

/** What the main column shows while a view's chunk is in flight: the
 * shape of a screen, in the same muted-panel idiom the Dashboard already
 * uses for its own loading state. `animate-pulse` is disabled wholesale
 * under `prefers-reduced-motion: reduce` by globals.css, so this needs no
 * media query of its own. */
function ViewSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Opening the screen">
      <div className="h-8 w-64 animate-pulse rounded-lg bg-card" />
      <div className="h-28 animate-pulse rounded-2xl border border-border bg-card" />
      <div className="h-64 animate-pulse rounded-2xl border border-border bg-card" />
    </div>
  );
}

interface OperationsWorkspaceProps {
  readonly api: ApiClient;
  readonly me: MeResponse;
  readonly organisation: Organisation;
  readonly organisations: readonly Organisation[];
  readonly onSwitchOrganisation: () => void;
  readonly onOrganisationCreated: (organisation: Organisation) => void;
  readonly onSignOut: () => void;
}

interface PendingDeparture {
  readonly action: () => void;
}

type ModuleKey =
  | 'dashboard'
  | 'works'
  | 'delivery-challans'
  | 'quotations'
  | 'approvals'
  | 'search'
  | 'serials'
  | 'masters'
  | 'members'
  | 'settings';

const NAVIGATION = [
  {
    label: 'Workspace',
    items: [
      { key: 'dashboard' as const, label: 'Dashboard', icon: LayoutDashboard },
      { key: 'works' as const, label: 'Works', icon: BriefcaseBusiness },
    ],
  },
  {
    label: 'Documents',
    items: [
      {
        key: 'delivery-challans' as const,
        label: 'Delivery Challans',
        icon: Truck,
      },
      { key: 'quotations' as const, label: 'Quotations', icon: FileText },
      { key: 'approvals' as const, label: 'Approvals', icon: CheckCircle },
    ],
  },
  {
    label: 'Operations',
    items: [
      { key: 'search' as const, label: 'Search', icon: Search },
      { key: 'serials' as const, label: 'Serial Lookup', icon: ScanBarcode },
      { key: 'masters' as const, label: 'Masters', icon: Database },
    ],
  },
  {
    label: 'Administration',
    items: [
      { key: 'members' as const, label: 'Members', icon: Users },
      { key: 'settings' as const, label: 'Settings', icon: SettingsIcon },
    ],
  },
] as const;

const MOBILE_MORE_ITEMS = [
  { key: 'delivery-challans', label: 'Delivery Challans', icon: Truck },
  { key: 'quotations', label: 'Quotations', icon: FileText },
  { key: 'approvals', label: 'Approvals', icon: CheckCircle },
  // The header's search box is desktop-only, so the mobile shell reaches
  // the same view from here.
  { key: 'search', label: 'Search', icon: Search },
  { key: 'serials', label: 'Serial Lookup', icon: ScanBarcode },
  { key: 'masters', label: 'Masters', icon: Database },
  { key: 'members', label: 'Members', icon: Users },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
] as const;

const MASTERS_CATEGORIES: readonly { key: MastersTab; label: string }[] = [
  { key: 'contacts', label: 'Contacts' },
  { key: 'locations', label: 'Locations' },
  { key: 'units', label: 'Units' },
  { key: 'signatories', label: 'Signatories' },
  { key: 'gst-rates', label: 'GST rates' },
];

function defaultViewOf(key: ModuleKey): WorkspaceView {
  switch (key) {
    case 'dashboard':
      return { name: 'dashboard' };
    case 'works':
      return { name: 'works' };
    case 'delivery-challans':
      return { name: 'delivery-challans' };
    case 'quotations':
      return { name: 'quotations' };
    case 'approvals':
      return { name: 'approvals' };
    case 'search':
      return { name: 'search', query: '' };
    case 'serials':
      return { name: 'serials' };
    case 'masters':
      return { name: 'masters' };
    case 'members':
      return { name: 'members' };
    case 'settings':
      return { name: 'settings' };
  }
}

function activeModuleOf(view: WorkspaceView): ModuleKey {
  switch (view.name) {
    // Both of the module's views light the same nav lamp: the register
    // and an opened record are one place.
    case 'delivery-challan':
      return 'delivery-challans';
    case 'dashboard':
    case 'delivery-challans':
    case 'quotations':
    case 'approvals':
    case 'search':
    case 'serials':
    case 'masters':
    case 'members':
    case 'settings':
      return view.name;
    default:
      return 'works';
  }
}

function pageTitleOf(view: WorkspaceView): string {
  switch (view.name) {
    case 'dashboard':
      return 'Dashboard';
    case 'works':
      return 'Works';
    case 'upload':
      return 'Upload LOA';
    case 'review':
      return 'Review LOA';
    case 'work':
      return 'Work workspace';
    case 'challan-new':
      return 'New Delivery Challan';
    case 'challan-edit':
      return 'Edit Delivery Challan';
    case 'challan':
      return 'Delivery Challan';
    case 'issue-challan-new':
      return 'New Issue Challan';
    case 'issue-challan-edit':
      return 'Edit Issue Challan';
    case 'issue-challan':
      return 'Issue Challan';
    case 'delivery-challans':
      return 'Delivery Challans';
    case 'delivery-challan':
      return 'Delivery Challan';
    case 'quotations':
      return 'Quotations';
    case 'approvals':
      return 'Approvals';
    case 'search':
      return 'Search';
    case 'serials':
      return 'Serial Lookup';
    case 'masters':
      return 'Masters';
    case 'members':
      return 'Members';
    case 'settings':
      return 'Settings';
  }
}

export function OperationsWorkspace({
  api,
  me,
  organisation,
  organisations,
  onSwitchOrganisation,
  onOrganisationCreated,
  onSignOut,
}: OperationsWorkspaceProps) {
  /** Finding 28: the view state is serialized into location.hash, so a
   * refresh restores the exact screen, the browser's back/forward walk
   * the view history, and every register row can carry a real link. The
   * hash is read once here; afterwards React state stays authoritative
   * and the two are kept in step below. */
  const initialRouteRef = useRef<WorkspaceRoute | null>(null);
  if (initialRouteRef.current === null) {
    initialRouteRef.current = parseWorkspaceHash(window.location.hash) ?? {
      view: { name: 'dashboard' },
    };
  }
  const initialRoute = initialRouteRef.current;
  const [view, setView] = useState<WorkspaceView>(initialRoute.view);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [workTab, setWorkTab] = useState<WorkTab>(initialRoute.workTab ?? 'overview');
  const [tabbedWorkId, setTabbedWorkId] = useState<string | null>(
    initialRoute.view.name === 'work' && initialRoute.workTab !== undefined
      ? initialRoute.view.workId
      : null,
  );
  const [mastersTab, setMastersTab] = useState<MastersTab>(
    initialRoute.mastersTab ?? 'contacts',
  );
  const [challanWork, setChallanWork] = useState<{
    readonly workId: string;
    readonly status: Work['status'];
    readonly workCode: string;
  } | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [headerQuickActionsOpen, setHeaderQuickActionsOpen] = useState(false);
  const [mobileRecordOpen, setMobileRecordOpen] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [pendingDeparture, setPendingDeparture] = useState<PendingDeparture | null>(
    null,
  );
  const [headerSearchQuery, setHeaderSearchQuery] = useState(
    initialRoute.view.name === 'search' ? initialRoute.view.query : '',
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const headerSearchRef = useRef<HTMLInputElement>(null);
  const mobileMenuCloseRef = useRef<HTMLButtonElement>(null);
  const departureRestoreFocusRef = useRef<HTMLElement | null>(null);
  const transientMenuTriggerRef = useRef<HTMLElement | null>(null);

  const membership = me.memberships.find(
    (candidate) =>
      candidate.organisationId === organisation.id && candidate.status === 'active',
  );
  const canModify = membership?.role === 'owner' || membership?.role === 'office';
  const canRecordEvidence = canModify || membership?.role === 'site';
  const canIssue = membership?.canIssueDocuments ?? false;
  const canCancel = membership?.canCancelDocuments ?? false;
  const canApprove = membership?.canApproveAmendments ?? false;
  // The compliance authority (migration 0061). It gates the IRP and NIC
  // portal surfaces ON TOP of issue/cancel — a member who may issue an
  // invoice does not thereby register it at the IRP. The server refuses
  // either way; hiding the controls only spares the useless attempt.
  const canManageStatutory = membership?.canManageStatutoryReporting ?? false;
  const isOwner = membership?.role === 'owner';
  const canSwitchOrganisation = organisations.length > 1;
  const activeModule = activeModuleOf(view);
  /* The screen names the tab, and the tenant names it after that: an
     operator working two organisations keeps a tab open for each, and
     "Auto-MB" on both told them nothing. */
  useDocumentTitle([pageTitleOf(view), organisation.name]);
  const recordWorkId =
    view.name === 'work' || view.name === 'challan' || view.name === 'issue-challan'
      ? view.workId
      : null;

  const refreshPendingApprovals = useCallback(() => {
    api
      .listApprovals(organisation.id, 'pending')
      .then((approvals) => {
        setPendingApprovals(approvals.length);
      })
      .catch(() => {
        // The queue itself owns the visible error state. The badge is only a convenience.
      });
  }, [api, organisation.id]);

  useEffect(() => {
    refreshPendingApprovals();
  }, [refreshPendingApprovals, view.name]);

  // The Work behind any challan screen: its status closes create/record
  // surfaces, and its code fills the editor's prefix when the view was
  // restored from a hash (which carries no work code).
  const openedChallanWorkId =
    view.name === 'challan' ||
    view.name === 'issue-challan' ||
    view.name === 'challan-new' ||
    view.name === 'challan-edit'
      ? view.workId
      : null;
  useEffect(() => {
    if (openedChallanWorkId === null) return;
    let cancelled = false;
    api
      .getWork(organisation.id, openedChallanWorkId)
      .then((loaded) => {
        if (!cancelled) {
          setChallanWork({
            workId: openedChallanWorkId,
            status: loaded.work.status,
            workCode: loaded.work.workCode,
          });
        }
      })
      .catch(() => {
        // The detail screen reports its own failure and the server still enforces status.
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisation.id, openedChallanWorkId]);

  const challanWorkActive =
    challanWork === null ||
    challanWork.workId !== openedChallanWorkId ||
    challanWork.status === 'active';
  const challanWorkCode =
    challanWork !== null && challanWork.workId === openedChallanWorkId
      ? challanWork.workCode
      : '';

  // Closing the transient menus belongs here, where it can happen the
  // instant the view changes. Moving focus onto the new view's heading
  // does not: with the views code-split the heading may not exist yet,
  // so that lives in ViewFocus, inside the Suspense boundary.
  useEffect(() => {
    setMobileMenuOpen(false);
    setMobileMoreOpen(false);
    setHeaderQuickActionsOpen(false);
    setMobileRecordOpen(false);
  }, [view]);

  /**
   * The global `/` shortcut.
   *
   * The header has advertised this key since the shell was written and
   * nothing ever listened for it, so the hint was a promise the product
   * did not keep. It focuses the header search box — a shortcut that
   * jumped straight to a results screen would be worse, because the
   * operator has not typed a query yet.
   *
   * It must never steal a keystroke from someone who is typing. The guard
   * is by element rather than by view: any input, textarea, select or
   * contenteditable region owns `/` while it has focus, which covers the
   * editors, every form field, and any rich-text surface added later
   * without this handler having to learn about it. Modifier chords are
   * left alone as well — those belong to the browser.
   *
   * The box is desktop-only (`hidden md:flex`), so on a narrow viewport
   * the ref is null and the key does nothing, which is correct: there is
   * no keyboard shortcut to honour without a keyboard.
   */
  useEffect(() => {
    function focusSearchOnSlash(event: globalThis.KeyboardEvent): void {
      if (event.key !== '/') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented) return;
      // A modal owns the keyboard while it is open.
      if (mobileMenuOpen || pendingDeparture !== null) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        // `isContentEditable` is the direct question, but it is false for
        // a plain element nested INSIDE an editable region — where the
        // caret usually is — so the attribute lookup walks up to the
        // region itself.
        if (target.isContentEditable) return;
        if (target.closest('[contenteditable]:not([contenteditable="false"])')) return;
      }
      const input = headerSearchRef.current;
      if (input === null) return;
      // Only now: otherwise a suppressed shortcut would still swallow the
      // character the operator meant to type.
      event.preventDefault();
      input.focus();
      input.select();
    }
    window.addEventListener('keydown', focusSearchOnSlash);
    return () => {
      window.removeEventListener('keydown', focusSearchOnSlash);
    };
  }, [mobileMenuOpen, pendingDeparture]);

  useEffect(() => {
    if (!editorDirty) return;
    function warnBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload);
    };
  }, [editorDirty]);

  function requestDeparture(action: () => void): void {
    if (!editorDirty) {
      action();
      return;
    }
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    departureRestoreFocusRef.current =
      mobileMenuOpen || headerQuickActionsOpen || mobileRecordOpen || mobileMoreOpen
        ? (transientMenuTriggerRef.current ?? activeElement)
        : activeElement;
    setHeaderQuickActionsOpen(false);
    setMobileRecordOpen(false);
    setMobileMoreOpen(false);
    setMobileMenuOpen(false);
    setPendingDeparture({ action });
  }

  interface NavigateOptions {
    /** The screen being left has already asked its own question — an
     * editor whose Cancel confirmed the discard, a letter that was just
     * confirmed into a Work, a letter that was withdrawn. Asking again
     * would be a second confirmation for one decision, so the flag is
     * cleared and the move goes through. */
    readonly confirmed?: boolean;
    /** The Work tab to open with, for the views that address one. */
    readonly workTab?: WorkTab;
    readonly mastersTab?: MastersTab;
  }

  /**
   * The only way the workspace changes screen.
   *
   * `setView` is deliberately unreachable from anywhere else — every call
   * site outside this function used to skip the departure confirmation
   * entirely, which is how `ReviewLoa` could be left mid-correction with
   * no warning while the two short editors were protected.
   * `scripts/check-architecture.mjs` now fails the build on a `setView(`
   * outside `navigate`/`requestDeparture`, so this stays true.
   */
  function navigate(next: WorkspaceView, options: NavigateOptions = {}): void {
    const apply = (): void => {
      setView(next);
      if (next.name === 'work' && options.workTab !== undefined) {
        setTabbedWorkId(next.workId);
        setWorkTab(options.workTab);
      }
      if (next.name === 'masters' && options.mastersTab !== undefined) {
        setMastersTab(options.mastersTab);
      }
    };
    if (options.confirmed === true) {
      setEditorDirty(false);
      apply();
      return;
    }
    requestDeparture(apply);
  }

  /** The current navigation state as its canonical fragment. */
  const currentHash = workspaceHashOf({
    view,
    workTab:
      view.name === 'work' && view.workId === tabbedWorkId ? workTab : 'overview',
    ...(view.name === 'masters' ? { mastersTab } : {}),
  });

  // State → address bar. In-app navigation pushes so Back retraces the
  // operator's steps; the very first sync only normalises the fragment
  // it restored from, so it replaces instead of stacking an entry.
  const hashSyncedRef = useRef(false);
  useEffect(() => {
    if (window.location.hash === currentHash) {
      hashSyncedRef.current = true;
      return;
    }
    if (hashSyncedRef.current) {
      window.history.pushState(null, '', currentHash);
    } else {
      window.history.replaceState(null, '', currentHash);
    }
    hashSyncedRef.current = true;
  }, [currentHash]);

  // Address bar → state: browser Back/Forward, a middle-clicked register
  // link, or a hand-edited fragment. The listener is mounted once and
  // reads the live values through refs. A dirty editor gets the same
  // departure confirmation an in-app navigation would show — the hash is
  // put back first, so declining leaves both the screen and the address
  // untouched.
  const currentHashRef = useRef(currentHash);
  currentHashRef.current = currentHash;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const applyRoute = useCallback((route: WorkspaceRoute) => {
    navigateRef.current(route.view, {
      ...(route.view.name === 'work' ? { workTab: route.workTab ?? 'overview' } : {}),
      ...(route.mastersTab !== undefined ? { mastersTab: route.mastersTab } : {}),
    });
  }, []);
  const editorDirtyRef = useRef(editorDirty);
  editorDirtyRef.current = editorDirty;
  useEffect(() => {
    function onHashChange(): void {
      const fragment = window.location.hash;
      if (fragment === currentHashRef.current) return;
      const parsed = parseWorkspaceHash(fragment);
      const route: WorkspaceRoute = parsed ?? { view: { name: 'dashboard' } };
      if (editorDirtyRef.current) {
        // The address bar must keep describing the editor while the
        // confirmation is open; declining then changes nothing at all.
        window.history.replaceState(null, '', currentHashRef.current);
        applyRoute(route);
        return;
      }
      if (parsed === null) {
        // Unknown or stale fragment: land on the Dashboard and
        // normalise the address instead of showing a dead screen.
        window.history.replaceState(null, '', workspaceHashOf(route));
      }
      applyRoute(route);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [applyRoute]);

  function keepEditing(): void {
    setPendingDeparture(null);
  }

  function discardAndLeave(): void {
    const departure = pendingDeparture;
    if (departure === null) return;
    setEditorDirty(false);
    setPendingDeparture(null);
    departure.action();
  }

  function openRecordTab(workId: string, tab: 'deliveries' | 'measurement'): void {
    navigate({ name: 'work', workId }, { workTab: tab });
  }

  const subItems: Partial<
    Record<
      ModuleKey,
      readonly {
        readonly label: string;
        readonly open: () => void;
        readonly current: boolean;
      }[]
    >
  > = {
    works: [
      {
        label: 'All Works',
        open: () => {
          navigate({ name: 'works' });
        },
        current: view.name === 'works',
      },
      ...(canModify
        ? [
            {
              label: 'Upload LOA',
              open: () => {
                navigate({ name: 'upload' });
              },
              current: view.name === 'upload',
            },
          ]
        : []),
    ],
    masters: MASTERS_CATEGORIES.map((category) => ({
      label: category.label,
      open: () => {
        navigate({ name: 'masters' }, { mastersTab: category.key });
      },
      current: view.name === 'masters' && mastersTab === category.key,
    })),
  };

  function openModule(key: ModuleKey): void {
    navigate(defaultViewOf(key));
  }

  /* `scope` prefixes the submenu ids. The rail and the drawer render the
     same navigation at the same time — the desktop aside is hidden by CSS,
     not unmounted — so one id per module would be two elements with the
     same id whenever the drawer is open. */
  function renderNavigation(closeAfterSelection = false, scope = 'rail') {
    return (
      <>
        {NAVIGATION.map((group) => (
          <div key={group.label} className="mb-5 last:mb-0">
            <p className="mb-2 px-3 text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
              {group.label}
            </p>
            <div className="flex flex-col gap-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                const current = activeModule === item.key;
                const children = subItems[item.key] ?? [];
                const submenuId = `${scope}-submenu-${item.key}`;
                return (
                  <div key={item.key}>
                    <button
                      type="button"
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                        current
                          ? 'bg-primary/10 text-primary'
                          : 'text-foreground/75 hover:bg-muted hover:text-foreground'
                      }`}
                      aria-current={current ? 'page' : undefined}
                      aria-expanded={children.length > 0 ? current : undefined}
                      /* Names the list the state refers to. Present only
                         alongside aria-expanded, so it never points at an
                         id that no module will ever render. */
                      aria-controls={children.length > 0 ? submenuId : undefined}
                      onClick={() => {
                        openModule(item.key);
                        if (closeAfterSelection) setMobileMenuOpen(false);
                      }}
                    >
                      <Icon className="size-[18px] shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1">{item.label}</span>
                      {item.key === 'approvals' && pendingApprovals > 0 && (
                        <Badge
                          variant="destructive"
                          aria-label={`${String(pendingApprovals)} pending approvals`}
                        >
                          {pendingApprovals}
                        </Badge>
                      )}
                    </button>
                    {current && children.length > 0 && (
                      <ul
                        id={submenuId}
                        className="my-1 ml-6 flex list-none flex-col gap-0.5 border-l border-border pl-3"
                      >
                        {children.map((child) => (
                          <li key={child.label}>
                            <button
                              type="button"
                              className={`w-full rounded-lg px-3 py-1.5 text-left text-xs transition-colors ${
                                child.current
                                  ? 'bg-primary/5 font-semibold text-primary'
                                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                              }`}
                              aria-current={child.current ? 'page' : undefined}
                              onClick={() => {
                                child.open();
                                if (closeAfterSelection) setMobileMenuOpen(false);
                              }}
                            >
                              {child.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
      {/* The first thing the keyboard reaches, so the twenty-odd rail and
          header controls are one keystroke rather than twenty.
          `preventDefault` is not decoration: the workspace's address IS the
          fragment, so letting the browser follow `#main-content` would
          replace the route with a fragment nothing parses and drop the
          operator on the Dashboard. The anchor keeps its href so it is
          announced as a link and points at a real element; the focus move
          is done here instead. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70] focus:rounded-md focus:border focus:border-border focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
        onClick={(event) => {
          event.preventDefault();
          containerRef.current?.focus();
        }}
      >
        Skip to main content
      </a>
      <aside
        className="sticky top-0 hidden h-screen flex-col border-r border-border bg-card lg:flex print:hidden"
        inert={mobileMenuOpen || pendingDeparture !== null}
      >
        <div className="flex h-[4.5rem] items-center gap-3 border-b border-border px-5">
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Building2 className="size-5" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <strong className="block text-base tracking-tight">Auto-MB</strong>
            <span className="block truncate text-xs text-muted-foreground">
              Contract operations
            </span>
          </span>
        </div>

        <nav
          className="scrollbar-thin flex-1 overflow-y-auto px-3 py-5"
          aria-label="Modules"
        >
          {renderNavigation()}
        </nav>

        <div className="border-t border-border p-3">
          <div className="mb-3 rounded-xl border border-primary/10 bg-primary/[0.035] p-3">
            <p className="text-xs font-semibold tracking-[0.14em] text-primary uppercase">
              Quick actions
            </p>
            <div className="mt-2 flex flex-col gap-1">
              {canModify && (
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-foreground hover:bg-card"
                  onClick={() => {
                    navigate({ name: 'upload' });
                  }}
                >
                  <Upload className="size-3.5 text-primary" aria-hidden="true" />
                  Upload a new LOA
                </button>
              )}
              <button
                type="button"
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-foreground hover:bg-card"
                onClick={() => {
                  navigate({ name: 'works' });
                }}
              >
                <Search className="size-3.5 text-primary" aria-hidden="true" />
                Find a Work
              </button>
              <button
                type="button"
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-foreground hover:bg-card"
                onClick={() => {
                  navigate({ name: 'approvals' });
                }}
              >
                <CheckCircle className="size-3.5 text-primary" aria-hidden="true" />
                Open approval queue
              </button>
            </div>
          </div>

          {canSwitchOrganisation ? (
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-xl border border-border bg-background/70 p-3 text-left transition-colors hover:bg-muted"
              onClick={() => {
                requestDeparture(onSwitchOrganisation);
              }}
            >
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent font-semibold text-accent-foreground">
                {organisation.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-xs">{organisation.name}</strong>
                <span className="block truncate text-xs text-muted-foreground">
                  Switch organisation
                </span>
              </span>
              <ArrowLeftRight
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </button>
          ) : (
            <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-background/70 p-3">
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent font-semibold text-accent-foreground">
                {organisation.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-xs">{organisation.name}</strong>
                <span className="block truncate text-xs text-muted-foreground">
                  Current organisation
                </span>
              </span>
            </div>
          )}
        </div>
      </aside>

      <div className="min-w-0" inert={mobileMenuOpen || pendingDeparture !== null}>
        <header className="sticky top-0 z-30 flex h-[4.5rem] items-center gap-3 border-b border-border bg-card/95 px-4 backdrop-blur lg:px-7 print:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Open navigation"
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-navigation-dialog"
            aria-haspopup="dialog"
            onClick={(event) => {
              transientMenuTriggerRef.current = event.currentTarget;
              setHeaderQuickActionsOpen(false);
              setMobileRecordOpen(false);
              setMobileMoreOpen(false);
              setMobileMenuOpen(true);
            }}
          >
            <Menu aria-hidden="true" />
          </Button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-muted-foreground">
              {organisation.name}
            </p>
            <p className="truncate text-sm font-semibold">{pageTitleOf(view)}</p>
          </div>

          {/* A real search box, not a button that went to the Works
              register: the label promised records and now delivers them.
              `/` focuses it from anywhere in the workspace. */}
          <form
            role="search"
            className="hidden min-w-56 max-w-md flex-1 items-center gap-2 rounded-xl border border-input bg-background px-3 py-2 text-xs text-muted-foreground transition-colors focus-within:border-primary/60 hover:border-primary/35 md:flex"
            onSubmit={(event) => {
              event.preventDefault();
              const query = headerSearchQuery.trim();
              if (query.length < 2) return;
              navigate({ name: 'search', query });
            }}
          >
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <input
              ref={headerSearchRef}
              type="search"
              name="header-search"
              aria-label="Search Works and records"
              placeholder="Search Works and records"
              maxLength={120}
              autoComplete="off"
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs outline-none"
              value={headerSearchQuery}
              onChange={(event) => {
                setHeaderSearchQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                // Escape gives the keyboard back without submitting, the
                // same way Escape closes the mobile navigation.
                if (event.key === 'Escape') event.currentTarget.blur();
              }}
            />
            <kbd
              aria-hidden="true"
              className="ml-auto shrink-0 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-xs"
            >
              /
            </kbd>
          </form>

          <div className="relative">
            <Button
              size="sm"
              aria-label={
                headerQuickActionsOpen ? 'Close quick actions' : 'Open quick actions'
              }
              aria-expanded={headerQuickActionsOpen}
              aria-controls="header-quick-actions"
              onClick={(event) => {
                transientMenuTriggerRef.current = event.currentTarget;
                setMobileRecordOpen(false);
                setMobileMoreOpen(false);
                setHeaderQuickActionsOpen((current) => !current);
              }}
            >
              <Plus aria-hidden="true" />
              <span className="hidden sm:inline">Quick action</span>
              <ChevronDown className="hidden size-3.5 sm:block" aria-hidden="true" />
            </Button>
            {headerQuickActionsOpen && (
              <div
                id="header-quick-actions"
                className="absolute top-[calc(100%+0.5rem)] right-0 z-40 w-64 rounded-2xl border border-border bg-card p-2 shadow-xl"
                role="group"
                aria-label="Quick actions"
              >
                {canModify && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      navigate({ name: 'upload' });
                    }}
                  >
                    <Upload className="size-4 text-primary" aria-hidden="true" />
                    <span>
                      <strong className="block text-xs">Upload LOA</strong>
                      <span className="text-xs text-muted-foreground">
                        Start a new awarded Work
                      </span>
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    navigate({ name: 'works' });
                  }}
                >
                  <BriefcaseBusiness
                    className="size-4 text-primary"
                    aria-hidden="true"
                  />
                  <span>
                    <strong className="block text-xs">Open Works</strong>
                    <span className="text-xs text-muted-foreground">
                      Find a contract or document
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    navigate({ name: 'approvals' });
                  }}
                >
                  <CheckCircle className="size-4 text-primary" aria-hidden="true" />
                  <span>
                    <strong className="block text-xs">Approval queue</strong>
                    <span className="text-xs text-muted-foreground">
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
            aria-label={
              pendingApprovals > 0
                ? `${String(pendingApprovals)} pending approvals`
                : 'No pending approvals'
            }
            onClick={() => {
              navigate({ name: 'approvals' });
            }}
          >
            <span className="relative">
              <Bell aria-hidden="true" />
              {pendingApprovals > 0 && (
                <span className="absolute -top-1 -right-1 size-2 rounded-full bg-destructive ring-2 ring-card" />
              )}
            </span>
          </Button>

          <div className="hidden items-center gap-2 border-l border-border pl-3 xl:flex">
            <span className="inline-flex size-8 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
              {me.user.email.slice(0, 1).toUpperCase()}
            </span>
            <span className="max-w-48 truncate text-xs text-muted-foreground">
              {me.user.email}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              onClick={() => {
                requestDeparture(onSignOut);
              }}
            >
              <LogOut aria-hidden="true" />
            </Button>
          </div>
        </header>

        <main
          id="main-content"
          ref={containerRef}
          /* The skip link's destination has to be able to hold focus, and a
             landmark is not focusable on its own. -1 keeps it out of the tab
             order it is there to shorten. */
          tabIndex={-1}
          /* `[&>*]:min-w-0` caps the page at the screen.
           *
           * A flex item's automatic minimum size is its content, so one
           * unshrinkable string anywhere in a view — a long `<select>`
           * option, a nowrap button — made this column wider than the
           * phone, and the whole shell scrolled sideways with it. Zero lets
           * each view shrink to the column; anything inside a view that
           * still cannot fit is that view's own scroll container to
           * provide, which is what `ui/table.tsx` does for every register.
           * Measured at 320px by `e2e/responsive.spec.ts`. */
          className="mx-auto flex w-full max-w-[100rem] flex-col gap-5 px-4 py-5 pb-24 outline-none sm:px-6 lg:px-8 lg:py-7 lg:pb-10 [&>*]:min-w-0"
        >
          <Suspense fallback={<ViewSkeleton />}>
            {/* Restores the heading focus the outer effect cannot take
                while a chunk is still loading: it runs inside the
                boundary, so its effect fires when the real view commits
                rather than when the fallback does. */}
            <ViewFocus routeKey={view} containerRef={containerRef} />
            {view.name === 'dashboard' && (
              <OperationsDashboard
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
                onOpenWork={(workId) => {
                  navigate({ name: 'work', workId });
                }}
                onOpenWorks={() => {
                  navigate({ name: 'works' });
                }}
                onUploadLoa={() => {
                  navigate({ name: 'upload' });
                }}
                onOpenApprovals={() => {
                  navigate({ name: 'approvals' });
                }}
              />
            )}

            {view.name === 'settings' && (
              <>
                <Settings
                  api={api}
                  organisationId={organisation.id}
                  isOwner={membership?.role === 'owner'}
                />
                <AppearanceSettings />
                <AccountSecurity api={api} />
                <OrganisationAccessSettings
                  api={api}
                  currentOrganisation={organisation}
                  organisations={organisations}
                  canCreate={isOwner}
                  onCreated={onOrganisationCreated}
                />
              </>
            )}

            {view.name === 'works' && (
              <Works
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
                onUpload={() => {
                  navigate({ name: 'upload' });
                }}
                onReview={(documentId) => {
                  navigate({ name: 'review', documentId });
                }}
                onOpenWork={(workId) => {
                  navigate({ name: 'work', workId });
                }}
              />
            )}

            {view.name === 'upload' && (
              <UploadLoa
                api={api}
                organisationId={organisation.id}
                onUploaded={(document) => {
                  navigate(
                    document.extractionStatus === 'review'
                      ? { name: 'review', documentId: document.id }
                      : { name: 'works' },
                  );
                }}
                onOpenDocument={(documentId) => {
                  navigate({ name: 'review', documentId });
                }}
                onOpenWork={(workId) => {
                  navigate({ name: 'work', workId });
                }}
                onCancel={() => {
                  navigate({ name: 'works' });
                }}
              />
            )}

            {view.name === 'review' && (
              <ReviewLoa
                api={api}
                organisationId={organisation.id}
                documentId={view.documentId}
                canModify={canModify}
                onConfirmed={(created) => {
                  // The letter is now a Work; the corrections are saved, so
                  // there is nothing left to confirm.
                  navigate(
                    { name: 'work', workId: created.work.id },
                    { confirmed: true },
                  );
                }}
                onBack={() => {
                  navigate({ name: 'works' });
                }}
                onDiscarded={() => {
                  navigate({ name: 'works' }, { confirmed: true });
                }}
                onDirtyChange={setEditorDirty}
              />
            )}

            {(view.name === 'delivery-challans' ||
              view.name === 'delivery-challan') && (
              <DeliveryChallans
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
                canIssue={canIssue}
                canCancel={canCancel}
                openChallanId={view.name === 'delivery-challan' ? view.challanId : null}
                onOpenChallan={(challanId) => {
                  navigate(
                    challanId === null
                      ? { name: 'delivery-challans' }
                      : { name: 'delivery-challan', challanId },
                  );
                }}
                onOpenWorkChallan={(workId, challanId) => {
                  navigate({ name: 'challan', workId, workCode: '', challanId });
                }}
              />
            )}

            {view.name === 'quotations' && (
              <Quotations
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
                canIssue={canIssue}
                canCancel={canCancel}
              />
            )}

            {view.name === 'approvals' && (
              <Approvals
                api={api}
                organisationId={organisation.id}
                currentUserId={me.user.id}
                canApprove={canApprove}
                onChanged={refreshPendingApprovals}
              />
            )}

            {view.name === 'work' && (
              <WorkDetail
                api={api}
                organisationId={organisation.id}
                workId={view.workId}
                canModify={canModify}
                canRecordEvidence={canRecordEvidence}
                canIssue={canIssue}
                canCancel={canCancel}
                canApprove={canApprove}
                canManageStatutory={canManageStatutory}
                isOwner={isOwner}
                onNewChallan={(workId, workCode) => {
                  navigate({ name: 'challan-new', workId, workCode });
                }}
                onOpenChallan={(challanId) => {
                  navigate({
                    name: 'challan',
                    workId: view.workId,
                    workCode: '',
                    challanId,
                  });
                }}
                onNewIssueChallan={(workId) => {
                  navigate({ name: 'issue-challan-new', workId });
                }}
                onOpenIssueChallan={(challanId) => {
                  navigate({ name: 'issue-challan', workId: view.workId, challanId });
                }}
                onBack={() => {
                  navigate({ name: 'works' });
                }}
                tab={view.workId === tabbedWorkId ? workTab : 'overview'}
                onTabChange={(next) => {
                  setTabbedWorkId(view.workId);
                  setWorkTab(next);
                }}
              />
            )}

            {/* The decorative 1-2-3 stepper that used to sit here never
              advanced; the editor's own sections carry the order. */}
            {(view.name === 'challan-new' || view.name === 'challan-edit') && (
              <ChallanEditor
                api={api}
                organisationId={organisation.id}
                workId={view.workId}
                workCode={view.workCode === '' ? challanWorkCode : view.workCode}
                challanId={view.name === 'challan-edit' ? view.challanId : null}
                onSaved={(challanId) => {
                  // Saved, or cancelled after the editor's own discard
                  // confirmation: either way the decision has been taken
                  // once already and must not be asked again here.
                  navigate(
                    {
                      name: 'challan',
                      workId: view.workId,
                      workCode: view.workCode,
                      challanId,
                    },
                    { confirmed: true },
                  );
                }}
                onCancel={() => {
                  navigate({ name: 'work', workId: view.workId }, { confirmed: true });
                }}
                onDirtyChange={setEditorDirty}
              />
            )}

            {view.name === 'challan' && (
              <ChallanDetail
                api={api}
                organisationId={organisation.id}
                challanId={view.challanId}
                canModify={canModify}
                canIssue={canIssue}
                canCancel={canCancel}
                canRecordEvidence={canRecordEvidence}
                workActive={challanWorkActive}
                onEdit={(challanId) => {
                  navigate({
                    name: 'challan-edit',
                    workId: view.workId,
                    workCode: view.workCode,
                    challanId,
                  });
                }}
                onDeleted={() => {
                  navigate({ name: 'work', workId: view.workId });
                }}
                onBack={() => {
                  navigate({ name: 'work', workId: view.workId });
                }}
              />
            )}

            {view.name === 'masters' && (
              <Masters
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
                isOwner={isOwner}
                tab={mastersTab}
                onTabChange={setMastersTab}
              />
            )}

            {(view.name === 'issue-challan-new' ||
              view.name === 'issue-challan-edit') && (
              <IssueChallanEditor
                api={api}
                organisationId={organisation.id}
                workId={view.workId}
                challanId={view.name === 'issue-challan-edit' ? view.challanId : null}
                onSaved={(challanId) => {
                  navigate(
                    { name: 'issue-challan', workId: view.workId, challanId },
                    { confirmed: true },
                  );
                }}
                onCancel={() => {
                  navigate({ name: 'work', workId: view.workId }, { confirmed: true });
                }}
                onDirtyChange={setEditorDirty}
              />
            )}

            {view.name === 'issue-challan' && (
              <IssueChallanDetail
                api={api}
                organisationId={organisation.id}
                challanId={view.challanId}
                canModify={canModify}
                canIssue={canIssue}
                canCancel={canCancel}
                workActive={challanWorkActive}
                onEdit={(challanId) => {
                  navigate({
                    name: 'issue-challan-edit',
                    workId: view.workId,
                    challanId,
                  });
                }}
                onDeleted={() => {
                  navigate({ name: 'work', workId: view.workId });
                }}
                onBack={() => {
                  navigate({ name: 'work', workId: view.workId });
                }}
              />
            )}

            {view.name === 'serials' && (
              <SerialLookup
                api={api}
                organisationId={organisation.id}
                onOpenWork={(workId) => {
                  navigate({ name: 'work', workId });
                }}
                onOpenChallan={(workId, challanId) => {
                  navigate({ name: 'challan', workId, workCode: '', challanId });
                }}
              />
            )}

            {view.name === 'search' && (
              <SearchView
                api={api}
                organisationId={organisation.id}
                query={view.query}
                onQueryChange={(next) => {
                  navigate({ name: 'search', query: next });
                }}
                onOpenWork={(workId) => {
                  navigate({ name: 'work', workId });
                }}
                onOpenChallan={(workId, challanId) => {
                  navigate({ name: 'challan', workId, workCode: '', challanId });
                }}
                onOpenIssueChallan={(workId, challanId) => {
                  navigate({ name: 'issue-challan', workId, challanId });
                }}
                onOpenSerials={() => {
                  navigate({ name: 'serials' });
                }}
                onOpenQuotations={() => {
                  navigate({ name: 'quotations' });
                }}
              />
            )}

            {view.name === 'members' && (
              <Members
                api={api}
                organisationId={organisation.id}
                currentUserId={me.user.id}
              />
            )}
          </Suspense>
        </main>
      </div>

      {mobileMenuOpen && (
        <Modal
          id="mobile-navigation-dialog"
          label="Application navigation"
          lockScroll
          initialFocusRef={mobileMenuCloseRef}
          onClose={() => {
            setMobileMenuOpen(false);
          }}
          overlayClassName="z-50 p-0 lg:hidden"
          backdropClassName="bg-foreground/25"
          className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] max-w-none flex-col rounded-none border-0 border-r border-border p-0 shadow-2xl"
        >
          <div className="flex h-[4.5rem] items-center gap-3 border-b border-border px-4">
            <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Building2 className="size-5" aria-hidden="true" />
            </span>
            <strong className="flex-1">Auto-MB</strong>
            <Button
              ref={mobileMenuCloseRef}
              variant="ghost"
              size="icon"
              aria-label="Close menu"
              onClick={() => {
                setMobileMenuOpen(false);
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-5">
            {renderNavigation(true, 'drawer')}
          </nav>
          <div className="border-t border-border p-3">
            {canSwitchOrganisation && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  requestDeparture(onSwitchOrganisation);
                }}
              >
                <ArrowLeftRight aria-hidden="true" />
                Switch organisation
              </Button>
            )}
            <Button
              variant="ghost"
              className="mt-1 w-full"
              onClick={() => {
                requestDeparture(onSignOut);
              }}
            >
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </Modal>
      )}

      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-border bg-card/95 px-2 py-1.5 backdrop-blur lg:hidden print:hidden"
        aria-label="Mobile navigation"
        inert={mobileMenuOpen || pendingDeparture !== null}
      >
        <button
          type="button"
          className={`flex flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-xs font-medium ${
            activeModule === 'dashboard' ? 'text-primary' : 'text-muted-foreground'
          }`}
          onClick={() => {
            navigate({ name: 'dashboard' });
          }}
        >
          <LayoutDashboard className="size-5" aria-hidden="true" />
          Home
        </button>
        <button
          type="button"
          className={`flex flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-xs font-medium ${
            activeModule === 'works' ? 'text-primary' : 'text-muted-foreground'
          }`}
          onClick={() => {
            navigate({ name: 'works' });
          }}
        >
          <BriefcaseBusiness className="size-5" aria-hidden="true" />
          Works
        </button>
        <button
          type="button"
          className="flex flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-xs font-medium text-primary"
          aria-label={mobileRecordOpen ? 'Close record actions' : 'Open record actions'}
          aria-expanded={mobileRecordOpen}
          aria-controls="mobile-record-actions"
          onClick={(event) => {
            transientMenuTriggerRef.current = event.currentTarget;
            setHeaderQuickActionsOpen(false);
            setMobileMoreOpen(false);
            setMobileRecordOpen((current) => !current);
          }}
        >
          <span className="-mt-5 inline-flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg ring-4 ring-background">
            <Plus className="size-5" aria-hidden="true" />
          </span>
          Record
        </button>
        <button
          type="button"
          className="flex flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-xs font-medium text-muted-foreground"
          aria-expanded={mobileMoreOpen}
          aria-controls="mobile-more-destinations"
          onClick={(event) => {
            transientMenuTriggerRef.current = event.currentTarget;
            setHeaderQuickActionsOpen(false);
            setMobileRecordOpen(false);
            setMobileMoreOpen((current) => !current);
          }}
        >
          <MoreHorizontal className="size-5" aria-hidden="true" />
          More
        </button>
      </nav>

      {mobileRecordOpen && (
        <div
          id="mobile-record-actions"
          className="fixed inset-x-3 bottom-20 z-50 rounded-2xl border border-border bg-card p-3 shadow-2xl lg:hidden print:hidden"
          role="group"
          aria-label="Record actions"
        >
          {recordWorkId !== null && canRecordEvidence ? (
            <>
              <p className="px-2 pb-2 text-xs text-muted-foreground">
                Record site evidence against the open Work.
              </p>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  openRecordTab(recordWorkId, 'deliveries');
                }}
              >
                <BriefcaseBusiness className="size-4 text-primary" aria-hidden="true" />
                Delivery evidence
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  openRecordTab(recordWorkId, 'measurement');
                }}
              >
                <FileText className="size-4 text-primary" aria-hidden="true" />
                Measurements
              </button>
            </>
          ) : (
            <p className="px-2 pb-2 text-xs text-muted-foreground">
              {canRecordEvidence
                ? 'Choose a Work before recording site evidence.'
                : 'Your access is read-only; choose a Work to view its records.'}
            </p>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted"
            onClick={() => {
              navigate({ name: 'works' });
            }}
          >
            <Search className="size-4 text-primary" aria-hidden="true" />
            Open Works
          </button>
        </div>
      )}

      {mobileMoreOpen && (
        /* Its two sibling sheets carry an id, a role and a name; this one
           carried none, so the trigger's aria-expanded described nothing a
           screen reader could go to. */
        <div
          id="mobile-more-destinations"
          className="fixed inset-x-3 bottom-20 z-50 rounded-2xl border border-border bg-card p-2 shadow-2xl lg:hidden print:hidden"
          role="group"
          aria-label="More destinations"
        >
          {MOBILE_MORE_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  openModule(item.key);
                }}
              >
                <Icon className="size-4 text-primary" aria-hidden="true" />
                {item.label}
                {item.key === 'approvals' && pendingApprovals > 0 && (
                  <Badge className="ml-auto" variant="destructive">
                    {pendingApprovals}
                  </Badge>
                )}
              </button>
            );
          })}
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-destructive hover:bg-destructive/5"
            onClick={() => {
              requestDeparture(onSignOut);
            }}
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}

      {pendingDeparture !== null && (
        <ConfirmDialog
          title="Unsaved draft changes"
          description="Leaving this editor will discard the changes you have not saved."
          cancelLabel="Keep editing"
          confirmLabel="Discard and leave"
          onCancel={keepEditing}
          onConfirm={discardAndLeave}
          /* A departure asked for from inside a transient menu must return
             the operator to the menu's trigger: the menu itself closed when
             the confirmation opened, so whatever held focus is gone. */
          restoreFocusTo={departureRestoreFocusRef.current}
        />
      )}
    </div>
  );
}
