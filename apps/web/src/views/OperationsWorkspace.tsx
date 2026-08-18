import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import type { Organisation, Work } from '@auto-mb/contracts';
import {
  ArrowLeftRight,
  FileText,
  FolderKanban,
  Home,
  LogOut,
  MoreHorizontal,
  Plus,
  Search,
  Truck,
  Wrench,
  X,
} from 'lucide-react';
import type { ApiClient, MeResponse } from '../api.js';
import { useDocumentTitle } from '../lib/document-title.js';
import {
  mastersHash,
  navigateOnClick,
  parseWorkspaceHash,
  workspaceHashOf,
  type WorkspaceRoute,
  type WorkspaceView,
} from '../lib/workspace-routes.js';
import { AppSidebar } from '../shell/AppSidebar.js';
import { AppTopbar } from '../shell/AppTopbar.js';
import { SidebarNav, type NavSubItem } from '../shell/SidebarNav.js';
import {
  activeModuleOf,
  defaultViewOf,
  MOBILE_MORE_ITEMS,
  pageTitleOf,
  type ModuleKey,
} from '../shell/navigation.js';
import { Badge } from '../ui/badge.js';
import { Card } from '../ui/card.js';
import { PageHeader } from '../ui/page-header.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { Modal } from '../ui/dialog.js';
import { Sheet } from '../ui/sheet.js';
import type { MastersTab } from './Masters.js';
import type { WorkTab } from './WorkDetail.js';

/** The rail-hiding sets, module-level so they are stable references and a
 * memoised sidebar is not re-rendered by a fresh Set each pass. Employees
 * (migration 0089) is the only door hidden by authority; every other
 * module gates at the screen. */
const NO_HIDDEN_MODULES: ReadonlySet<ModuleKey> = new Set();
const EMPLOYEES_HIDDEN: ReadonlySet<ModuleKey> = new Set(['employees']);

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
const Payments = lazy(() =>
  import('./Payments.js').then((module) => ({ default: module.Payments })),
);
const ChallanDetail = lazy(() =>
  import('./ChallanDetail.js').then((module) => ({ default: module.ChallanDetail })),
);
const ChallanEditor = lazy(() =>
  import('./ChallanEditor.js').then((module) => ({ default: module.ChallanEditor })),
);
const Challans = lazy(() =>
  import('./Challans.js').then((module) => ({ default: module.Challans })),
);
const InstallationsRegister = lazy(() =>
  import('./InstallationsRegister.js').then((module) => ({
    default: module.InstallationsRegister,
  })),
);
const InvoicesRegister = lazy(() =>
  import('./InvoicesRegister.js').then((module) => ({
    default: module.InvoicesRegister,
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
const AuditTrail = lazy(() =>
  import('./AuditTrail.js').then((module) => ({ default: module.AuditTrail })),
);
const Mis = lazy(() => import('./Mis.js').then((module) => ({ default: module.Mis })));
const OperationsDashboard = lazy(() =>
  import('./OperationsDashboard.js').then((module) => ({
    default: module.OperationsDashboard,
  })),
);
const Quotations = lazy(() =>
  import('./Quotations.js').then((module) => ({ default: module.Quotations })),
);
const Correspondence = lazy(() =>
  import('./Correspondence.js').then((module) => ({
    default: module.Correspondence,
  })),
);
const WriteOutwardLetter = lazy(() =>
  import('./CorrespondenceComposer.js').then((module) => ({
    default: module.WriteOutwardLetter,
  })),
);
const UploadInwardLetter = lazy(() =>
  import('./CorrespondenceComposer.js').then((module) => ({
    default: module.UploadInwardLetter,
  })),
);
const CompanyDocuments = lazy(() =>
  import('./CompanyDocuments.js').then((module) => ({
    default: module.CompanyDocuments,
  })),
);
const Inspection = lazy(() =>
  import('./Inspection.js').then((module) => ({ default: module.Inspection })),
);
const Tenders = lazy(() =>
  import('./Tenders.js').then((module) => ({ default: module.Tenders })),
);
const Receivables = lazy(() =>
  import('./Receivables.js').then((module) => ({ default: module.Receivables })),
);
const Production = lazy(() =>
  import('./Production.js').then((module) => ({ default: module.Production })),
);
const ProductionItems = lazy(() =>
  import('./ProductionItems.js').then((module) => ({
    default: module.ProductionItems,
  })),
);
const ProductionJobCard = lazy(() =>
  import('./ProductionJobCard.js').then((module) => ({
    default: module.ProductionJobCard,
  })),
);
const OrganisationExportSettings = lazy(() =>
  import('./OrganisationExportSettings.js').then((module) => ({
    default: module.OrganisationExportSettings,
  })),
);
const PlatformSettings = lazy(() =>
  import('./PlatformSettings.js').then((module) => ({
    default: module.PlatformSettings,
  })),
);
const SigningKioskSettings = lazy(() =>
  import('./SigningKioskSettings.js').then((module) => ({
    default: module.SigningKioskSettings,
  })),
);
const SigningQueue = lazy(() =>
  import('./SigningQueue.js').then((module) => ({ default: module.SigningQueue })),
);
const Notifications = lazy(() =>
  import('./Notifications.js').then((module) => ({ default: module.Notifications })),
);
const Imports = lazy(() =>
  import('./Imports.js').then((module) => ({ default: module.Imports })),
);
const Warranties = lazy(() =>
  import('./Warranties.js').then((module) => ({ default: module.Warranties })),
);
const StockRegister = lazy(() =>
  import('./StockRegister.js').then((module) => ({ default: module.StockRegister })),
);
const StockShortages = lazy(() =>
  import('./StockShortages.js').then((module) => ({
    default: module.StockShortages,
  })),
);
const Employees = lazy(() =>
  import('./Employees.js').then((module) => ({ default: module.Employees })),
);
const PayrollRun = lazy(() =>
  import('./PayrollRun.js').then((module) => ({ default: module.PayrollRun })),
);
const Maintenance = lazy(() =>
  import('./Maintenance.js').then((module) => ({ default: module.Maintenance })),
);
const MaintenanceJobCard = lazy(() =>
  import('./MaintenanceJobCard.js').then((module) => ({
    default: module.MaintenanceJobCard,
  })),
);
const MaintenanceRequestForm = lazy(() =>
  import('./MaintenanceRequestForm.js').then((module) => ({
    default: module.MaintenanceRequestForm,
  })),
);
const NitIntake = lazy(() =>
  import('./NitIntake.js').then((module) => ({ default: module.NitIntake })),
);
const TenderWorkspace = lazy(() =>
  import('./TenderWorkspace.js').then((module) => ({
    default: module.TenderWorkspace,
  })),
);
const ReviewLoa = lazy(() =>
  import('./ReviewLoa.js').then((module) => ({ default: module.ReviewLoa })),
);
const SearchView = lazy(() =>
  import('./Search.js').then((module) => ({ default: module.Search })),
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

/** Whether the rail is the mock's icon-only rail rather than its full
 * 16rem width. The mock keeps this in a cookie; the application has no
 * cookie of its own to reuse, so the choice rides in localStorage — it is a
 * display preference, carries no authority, and a browser that refuses
 * storage simply opens expanded every time. */
const SIDEBAR_COLLAPSED_KEY = 'auto-mb.sidebar-collapsed';

/** The rail's element id, so the topbar's toggle can name what it expands. */
const SIDEBAR_ID = 'app-sidebar';

/** How the identity block and the account menu describe the membership.
 * The application has a per-feature permission matrix rather than the
 * mock's "Administrator" job title, so the honest label is the membership
 * role behind that matrix. */
const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  office: 'Office',
  site: 'Site',
  viewer: 'Viewer',
};

/** One cell of the mock's bottom bar (`components/mobile-navigation` at
 * fdfe5ef): a 56px touch target, its icon over an 11px label, sharing the
 * bar's width equally with its siblings. */
const MOBILE_BAR_CELL =
  'flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium';

/** One row of either bottom sheet. The mock's own list item: an outline
 * button at 48px, label-first, with the icon inset by the button ladder's
 * `data-icon` rule. */
const MOBILE_SHEET_ROW = 'h-12 justify-start';

function storedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function rememberSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    // A preference the browser will not store is still honoured for this
    // session; nothing here is security-sensitive.
  }
}

/** The initials the topbar avatar and the rail identity block show. The
 * account has no display name yet, so the address is the only name there
 * is. */
function initialsOf(email: string): string {
  const [local] = email.split('@');
  const letters = (local ?? email).replace(/[^a-zA-Z]/g, '');
  return (letters.slice(0, 2) || email.slice(0, 2)).toUpperCase();
}

const MASTERS_CATEGORIES: readonly { key: MastersTab; label: string }[] = [
  { key: 'items', label: 'Items' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'locations', label: 'Locations' },
  { key: 'units', label: 'Units' },
  { key: 'signatories', label: 'Signatories' },
  { key: 'gst-rates', label: 'GST rates' },
];

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
  // Items, matching the rail's first category and the bare `#/masters`
  // address (`lib/workspace-routes.ts`). The Masters view keeps the same
  // default for its own uncontrolled use; here the workspace owns the
  // state because the module rail opens a category directly.
  const [mastersTab, setMastersTab] = useState<MastersTab>(
    initialRoute.mastersTab ?? 'items',
  );
  /**
   * Whether the payment setup has been offered on the current screen and
   * not yet answered.
   *
   * Set by exactly one navigation — the one that follows a letter being
   * confirmed into a Work — and cleared as soon as the dialog is saved or
   * dismissed, or as soon as the operator goes anywhere else. A plain
   * boolean is enough because it is set and cleared in the same act that
   * sets `view`: holding the Work's id here as well and comparing the two
   * would be two names for one fact, and the comparison could only ever
   * be true.
   *
   * It is deliberately NOT in the route: a payment setup prompt is a
   * consequence of an act just performed, not a property of the address,
   * so a refresh, a bookmark or a shared link opens the Work page
   * plainly. The Work page keeps its own, data-derived prompt for a
   * configuration that is still incomplete, which is what makes this
   * one-shot honest rather than forgetful.
   */
  const [paymentSetupOffered, setPaymentSetupOffered] = useState(false);
  const [challanWork, setChallanWork] = useState<{
    readonly workId: string;
    readonly status: Work['status'];
    readonly workCode: string;
  } | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [mobileRecordOpen, setMobileRecordOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storedSidebarCollapsed);
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
  // The signing authority (0091). Separate from canIssue on purpose:
  // issuing a document and putting the organisation's registered
  // certificate on it are two acts, and the second is what a signer at a
  // kiosk trusts the queue about.
  const canSign = membership?.canSignDocuments ?? false;
  const canApprove = membership?.canApproveAmendments ?? false;
  // The compliance authority (migration 0061). It gates the IRP and NIC
  // portal surfaces ON TOP of issue/cancel — a member who may issue an
  // invoice does not thereby register it at the IRP. The server refuses
  // either way; hiding the controls only spares the useless attempt.
  const canManageStatutory = membership?.canManageStatutoryReporting ?? false;
  const canManagePayments = membership?.canManagePayments ?? false;
  // The payroll authority (migration 0089), distinct from payments: it
  // gates the employee register and the payroll run — a vendor-payment
  // manager must not see salaries, PAN, UAN or bank details by default.
  const canManagePayroll = membership?.canManagePayroll ?? false;
  const canManageNotifications = membership?.canManageNotifications ?? false;
  // The import authority (migration 0094). The screen stays on the rail
  // for every writer, because reading which imports an organisation ran
  // — and why eleven rows were refused — is ordinary register history.
  // What the authority gates is the half that WRITES: the upload panel
  // and the button that commits. The server refuses either way.
  const canImport = membership?.canImportData ?? false;
  // The platform controls (migration 0096). `canManageEntitlements` is
  // owner-only in effect — every route needs the owner role beside it —
  // so the panel takes both and renders for neither alone.
  const canManageEntitlements = membership?.canManageEntitlements ?? false;
  const canExportOrg = membership?.canExportOrg ?? false;
  // Without it the rail carries no door to Employees at all — a register
  // of salaries is not something to advertise a way into. The server
  // refuses the route regardless; this only spares the useless attempt.
  const hiddenModules = canManagePayroll ? NO_HIDDEN_MODULES : EMPLOYEES_HIDDEN;
  const isOwner = membership?.role === 'owner';
  const canSwitchOrganisation = organisations.length > 1;
  const identityRole =
    membership === undefined
      ? 'No active membership'
      : (ROLE_LABELS[membership.role] ?? membership.role);
  const activeModule = activeModuleOf(view);
  /* The screen names the tab, and the tenant names it after that: an
     operator working two organisations keeps a tab open for each, and
     "Auto-MB" on both told them nothing. */
  useDocumentTitle([pageTitleOf(view), organisation.name]);
  const recordWorkId =
    view.name === 'work' || view.name === 'challan' || view.name === 'issue-challan'
      ? view.workId
      : null;
  /* The Record sheet's subtitle. It was two paragraphs inside the panel;
     as a sheet it is the description the dialog is `aria-describedby`, so
     the reason there are no record buttons is announced with the sheet
     rather than found by reading it. */
  const recordSheetDescription =
    recordWorkId !== null && canRecordEvidence
      ? 'Record site evidence against the open Work.'
      : canRecordEvidence
        ? 'Choose a Work before recording site evidence.'
        : 'Your access is read-only; choose a Work to view its records.';

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
  // restored from a hash (which carries no work code). The Challans
  // register joins the list for the second reason only — its `?work=`
  // chip names the Work by its code, and the hash carries the id.
  const openedChallanWorkId =
    view.name === 'challan' ||
    view.name === 'issue-challan' ||
    view.name === 'challan-new' ||
    view.name === 'challan-edit'
      ? view.workId
      : view.name === 'challans'
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
    setAccountMenuOpen(false);
    setMobileRecordOpen(false);
  }, [view]);

  /* Escape closes the account menu — the last transient menu in the
     topbar — and hands the keyboard back to the control that opened it,
     the same contract the dialogs and the mobile drawer already keep.

     The two mobile sheets are not among them: they are `Sheet`s, and
     `ui/dialog.tsx` already closes on Escape and restores focus to their
     trigger. Listening for the same key twice could only ever be one of
     the two handlers doing nothing. */
  useEffect(() => {
    if (!accountMenuOpen) return;
    function closeOnEscape(event: globalThis.KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setAccountMenuOpen(false);
      transientMenuTriggerRef.current?.focus();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [accountMenuOpen]);

  /* The mock's sidebar shortcut (`components/ui/sidebar`,
     `SIDEBAR_KEYBOARD_SHORTCUT`). It only ever changes how much of the rail
     is drawn, so unlike `/` it needs no typing guard: the chord is not a
     character anyone is trying to enter into a field. */
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => {
      rememberSidebarCollapsed(!collapsed);
      return !collapsed;
    });
  }, []);

  useEffect(() => {
    function toggleOnChord(event: globalThis.KeyboardEvent): void {
      if (event.key.toLowerCase() !== 'b') return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.altKey || event.defaultPrevented) return;
      event.preventDefault();
      toggleSidebar();
    }
    window.addEventListener('keydown', toggleOnChord);
    return () => {
      window.removeEventListener('keydown', toggleOnChord);
    };
  }, [toggleSidebar]);

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
      mobileMenuOpen || accountMenuOpen || mobileRecordOpen || mobileMoreOpen
        ? (transientMenuTriggerRef.current ?? activeElement)
        : activeElement;
    setAccountMenuOpen(false);
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
    /** Open the Work page with its payment setup dialog, once. Only the
     * confirmation of a letter passes it. */
    readonly promptPaymentSetup?: boolean;
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
      // The prompt belongs to one Work and one arrival at it. Any other
      // move retires it, so an unanswered dialog cannot follow the
      // operator around or reappear when they come back later.
      setPaymentSetupOffered(
        next.name === 'work' && options.promptPaymentSetup === true,
      );
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

  function openRecordTab(
    workId: string,
    tab: 'deliveries' | 'installations' | 'measurement',
  ): void {
    navigate({ name: 'work', workId }, { workTab: tab });
  }

  const subItems: Partial<Record<ModuleKey, readonly NavSubItem[]>> = {
    works: [
      {
        label: 'All Works',
        href: workspaceHashOf({ view: { name: 'works' } }),
        open: () => {
          navigate({ name: 'works' });
        },
        current: view.name === 'works',
      },
      ...(canModify
        ? [
            {
              label: 'Upload LOA',
              href: workspaceHashOf({ view: { name: 'upload', tenderId: null } }),
              open: () => {
                navigate({ name: 'upload', tenderId: null });
              },
              current: view.name === 'upload',
            },
          ]
        : []),
    ],
    masters: MASTERS_CATEGORIES.map((category) => ({
      label: category.label,
      href: mastersHash(category.key),
      open: () => {
        navigate({ name: 'masters' }, { mastersTab: category.key });
      },
      current: view.name === 'masters' && mastersTab === category.key,
    })),
  };

  function openModule(key: ModuleKey): void {
    navigate(defaultViewOf(key));
  }

  return (
    /* The mock's shell: a 16rem rail that narrows to a 3rem icon rail, and
       a content column beside it (`components/app-shell`,
       `components/ui/sidebar` — `SIDEBAR_WIDTH`, `SIDEBAR_WIDTH_ICON`).
       The width rides on a custom property so the transition is the grid's
       and the rail itself stays a plain sticky column. */
    <div
      className="min-h-screen bg-background lg:grid lg:grid-cols-[var(--rail-w)_minmax(0,1fr)] lg:transition-[grid-template-columns] lg:duration-200 lg:ease-linear"
      style={{ '--rail-w': sidebarCollapsed ? '3rem' : '16rem' } as CSSProperties}
    >
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
      <AppSidebar
        id={SIDEBAR_ID}
        organisationName={organisation.name}
        identityInitials={initialsOf(me.user.email)}
        identityName={me.user.email}
        identityRole={identityRole}
        activeModule={activeModule}
        pendingApprovals={pendingApprovals}
        subItems={subItems}
        hiddenModules={hiddenModules}
        collapsed={sidebarCollapsed}
        canModify={canModify}
        canSwitchOrganisation={canSwitchOrganisation}
        inert={mobileMenuOpen || pendingDeparture !== null}
        onOpenModule={openModule}
        onUploadLoa={() => {
          navigate({ name: 'upload', tenderId: null });
        }}
        onSwitchOrganisation={() => {
          requestDeparture(onSwitchOrganisation);
        }}
      />

      <div className="min-w-0" inert={mobileMenuOpen || pendingDeparture !== null}>
        <AppTopbar
          sidebarId={SIDEBAR_ID}
          organisationName={organisation.name}
          sectionTitle={pageTitleOf(view)}
          identityInitials={initialsOf(me.user.email)}
          identityName={me.user.email}
          identityRole={identityRole}
          pendingApprovals={pendingApprovals}
          canSwitchOrganisation={canSwitchOrganisation}
          sidebarCollapsed={sidebarCollapsed}
          mobileNavOpen={mobileMenuOpen}
          accountMenuOpen={accountMenuOpen}
          searchQuery={headerSearchQuery}
          searchInputRef={headerSearchRef}
          onToggleSidebar={toggleSidebar}
          onOpenMobileNav={(trigger) => {
            transientMenuTriggerRef.current = trigger;
            setAccountMenuOpen(false);
            setMobileRecordOpen(false);
            setMobileMoreOpen(false);
            setMobileMenuOpen(true);
          }}
          onToggleAccountMenu={(trigger) => {
            transientMenuTriggerRef.current = trigger;
            setMobileRecordOpen(false);
            setMobileMoreOpen(false);
            setAccountMenuOpen((current) => !current);
          }}
          onSearchQueryChange={setHeaderSearchQuery}
          onSearch={() => {
            const query = headerSearchQuery.trim();
            if (query.length < 2) return;
            navigate({ name: 'search', query });
          }}
          onOpenApprovals={() => {
            navigate({ name: 'approvals' });
          }}
          onOpenSettings={() => {
            navigate({ name: 'settings' });
          }}
          onSwitchOrganisation={() => {
            requestDeparture(onSwitchOrganisation);
          }}
          onSignOut={() => {
            requestDeparture(onSignOut);
          }}
        />

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
          /* The mock's content column: centred at 1440px with its four-step
             inset (`components/app-shell`). `gap-5` is the application's
             own — several screens mount two or three independent sections
             into this column and rely on it to space them. */
          className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-4 py-6 pb-24 outline-none sm:px-6 md:px-8 md:py-8 lg:px-10 lg:pb-8 [&>*]:min-w-0"
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
                  navigate({ name: 'upload', tenderId: null });
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
                <SigningKioskSettings
                  api={api}
                  organisationId={organisation.id}
                  isOwner={membership?.role === 'owner'}
                />
                <PlatformSettings
                  api={api}
                  organisationId={organisation.id}
                  isOwner={membership?.role === 'owner'}
                  canManageEntitlements={canManageEntitlements}
                  currentUserId={me.user.id}
                />
                <OrganisationExportSettings
                  api={api}
                  organisationId={organisation.id}
                  canExportOrg={canExportOrg}
                  currentUserId={me.user.id}
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
                  navigate({ name: 'upload', tenderId: null });
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
                tenderId={view.tenderId}
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
                  // there is nothing left to confirm. The Work opens with
                  // its payment setup offered once — the only place in the
                  // product that raises it.
                  navigate(
                    { name: 'work', workId: created.work.id },
                    { confirmed: true, promptPaymentSetup: true },
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

            {(view.name === 'challans' || view.name === 'delivery-challan') && (
              <Challans
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
                canIssue={canIssue}
                canCancel={canCancel}
                canManageStatutory={canManageStatutory}
                tab={view.name === 'challans' ? view.tab : 'delivery'}
                workId={view.name === 'challans' ? view.workId : null}
                workCode={challanWorkCode}
                openChallanId={view.name === 'delivery-challan' ? view.challanId : null}
                onOpenRegister={(tab, workId) => {
                  navigate({ name: 'challans', tab, workId });
                }}
                onOpenChallan={(challanId) => {
                  navigate(
                    challanId === null
                      ? { name: 'challans', tab: 'delivery', workId: null }
                      : { name: 'delivery-challan', challanId },
                  );
                }}
                onOpenWorkChallan={(workId, challanId) => {
                  navigate({ name: 'challan', workId, workCode: '', challanId });
                }}
                onOpenIssueChallan={(workId, challanId) => {
                  navigate({ name: 'issue-challan', workId, challanId });
                }}
                onNewWorkChallan={(workId, workCode) => {
                  navigate({ name: 'challan-new', workId, workCode });
                }}
                onNewIssueChallan={(workId) => {
                  navigate({ name: 'issue-challan-new', workId });
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

            {view.name === 'correspondence' && (
              <Correspondence
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
                canCancel={canCancel}
                onWriteLetter={() => {
                  navigate({ name: 'correspondence-new' });
                }}
                onUploadInward={() => {
                  navigate({ name: 'correspondence-inward' });
                }}
              />
            )}

            {view.name === 'correspondence-new' && (
              <WriteOutwardLetter
                api={api}
                organisationId={organisation.id}
                onDone={() => {
                  navigate({ name: 'correspondence' });
                }}
                onCancel={() => {
                  navigate({ name: 'correspondence' });
                }}
              />
            )}

            {view.name === 'correspondence-inward' && (
              <UploadInwardLetter
                api={api}
                organisationId={organisation.id}
                onDone={() => {
                  navigate({ name: 'correspondence' });
                }}
                onCancel={() => {
                  navigate({ name: 'correspondence' });
                }}
              />
            )}

            {view.name === 'company-documents' && (
              <CompanyDocuments
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
              />
            )}

            {view.name === 'inspection' && (
              <Inspection
                api={api}
                organisationId={organisation.id}
                canRecord={canRecordEvidence}
                canModify={canModify}
                canCancel={canCancel}
              />
            )}

            {view.name === 'production' && (
              <Production
                api={api}
                organisationId={organisation.id}
                workId={view.workId}
                canRecord={canRecordEvidence}
                onOpenJobCard={(jobCardId) => {
                  navigate({ name: 'production-job-card', jobCardId });
                }}
                onOpenItemMaster={() => {
                  navigate({ name: 'production-items' });
                }}
              />
            )}

            {view.name === 'production-items' && (
              <ProductionItems
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
              />
            )}

            {view.name === 'production-job-card' && (
              <ProductionJobCard
                api={api}
                organisationId={organisation.id}
                jobCardId={view.jobCardId}
                canRecord={canRecordEvidence}
                canCancel={canCancel}
                onBack={() => {
                  navigate({ name: 'production', workId: null });
                }}
              />
            )}

            {view.name === 'signing' && (
              <SigningQueue
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
              />
            )}
            {view.name === 'imports' && (
              <Imports
                api={api}
                organisationId={organisation.id}
                canImport={canImport}
              />
            )}

            {/* Gated at the SCREEN rather than at a control, because
                every read this view makes needs the authority: the
                consent register is a list of counterparties' personal
                telephone numbers, and the delivery log says who was
                messaged and when. The rail door stays visible — unlike
                Employees, whose door leaks that a salary register
                exists, this one leaks nothing an ordinary member should
                not know the product has. The server refuses the reads
                the same way, so this is the door and not the lock. */}
            {view.name === 'notifications' &&
              (canManageNotifications ? (
                <Notifications
                  api={api}
                  organisationId={organisation.id}
                  isOwner={isOwner}
                />
              ) : (
                <NotificationsAuthorityRequired />
              ))}

            {view.name === 'warranties' && (
              <Warranties
                api={api}
                organisationId={organisation.id}
                workId={view.workId}
                onOpenWork={(openWorkId) => {
                  navigate(
                    { name: 'work', workId: openWorkId },
                    {
                      workTab: 'instruments',
                    },
                  );
                }}
                onOpenWorks={() => {
                  navigate({ name: 'works' });
                }}
                onClearWorkFilter={() => {
                  navigate({ name: 'warranties', workId: null });
                }}
              />
            )}

            {view.name === 'stock' && (
              <StockRegister
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
                onOpenShortages={() => {
                  navigate({ name: 'stock-shortages' });
                }}
              />
            )}

            {view.name === 'stock-shortages' && (
              <StockShortages
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
                onOpenRegister={() => {
                  navigate({ name: 'stock' });
                }}
              />
            )}

            {/* Both screens are gated on `can_manage_payroll`, reads
                included: an employee register is a register of salaries,
                PAN, UAN and bank details, and a member who may approve a
                vendor payment has no business reading any of that by
                default (owner ruling, migration 0089). The server refuses
                them the same way, so this is the door and not the lock. */}
            {view.name === 'employees' &&
              (canManagePayroll ? (
                <Employees
                  api={api}
                  organisationId={organisation.id}
                  canManagePayroll={canManagePayroll}
                  canModify={canModify}
                  onOpenPayroll={() => {
                    navigate({ name: 'payroll' });
                  }}
                />
              ) : (
                <PayrollAuthorityRequired title="Employees" />
              ))}

            {view.name === 'payroll' &&
              (canManagePayroll ? (
                <PayrollRun
                  api={api}
                  organisationId={organisation.id}
                  canModify={canModify}
                  onOpenEmployees={() => {
                    navigate({ name: 'employees' });
                  }}
                />
              ) : (
                <PayrollAuthorityRequired title="Monthly payroll" />
              ))}
            {view.name === 'maintenance' && (
              <Maintenance
                api={api}
                organisationId={organisation.id}
                canModify={canRecordEvidence}
                onNewRequest={() => {
                  navigate({ name: 'maintenance-new' });
                }}
                onOpenRequest={(requestId) => {
                  navigate({ name: 'maintenance-request', requestId });
                }}
              />
            )}

            {view.name === 'maintenance-new' && (
              <MaintenanceRequestForm
                api={api}
                organisationId={organisation.id}
                onDone={(requestId) => {
                  navigate({ name: 'maintenance-request', requestId });
                }}
                onCancel={() => {
                  navigate({ name: 'maintenance' });
                }}
              />
            )}

            {view.name === 'maintenance-request' && (
              <MaintenanceJobCard
                api={api}
                organisationId={organisation.id}
                requestId={view.requestId}
                canModify={canRecordEvidence}
                /* The mock's whole-request admin approval: owner only,
                   exactly as `routes/maintenance.ts` gates it. */
                canApprove={membership?.role === 'owner'}
                canIssue={canIssue}
                onBack={() => {
                  navigate({ name: 'maintenance' });
                }}
              />
            )}

            {view.name === 'tenders' && (
              <Tenders
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
                onOpenTender={(tenderId) => {
                  navigate({ name: 'tender', tenderId });
                }}
                onUploadNotice={() => {
                  navigate({ name: 'tender-new' });
                }}
              />
            )}

            {view.name === 'receivables' && (
              <Receivables
                api={api}
                organisationId={organisation.id}
                onOpenWork={(workId) => {
                  navigate({ name: 'work', workId }, { workTab: 'bills' });
                }}
              />
            )}

            {view.name === 'tender-new' && (
              <NitIntake
                api={api}
                organisationId={organisation.id}
                onConfirmed={(tender) => {
                  navigate(
                    { name: 'tender', tenderId: tender.id },
                    { confirmed: true },
                  );
                }}
                onCancel={() => {
                  navigate({ name: 'tenders' });
                }}
              />
            )}

            {view.name === 'tender' && (
              <TenderWorkspace
                api={api}
                organisationId={organisation.id}
                tenderId={view.tenderId}
                canModify={canModify}
                onOpenWork={(workId) => {
                  navigate({ name: 'work', workId });
                }}
                onUploadAwardLetter={(tenderId) => {
                  navigate({ name: 'upload', tenderId });
                }}
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

            {view.name === 'payments' && (
              <Payments
                api={api}
                organisationId={organisation.id}
                currentUserId={me.user.id}
                canManagePayments={canManagePayments}
                canCancel={canCancel}
                tab={view.tab}
                onOpenRegister={(tab) => {
                  navigate({ name: 'payments', tab });
                }}
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
                canSign={canSign}
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
                promptPaymentSetup={paymentSetupOffered}
                onPaymentSetupClosed={() => {
                  setPaymentSetupOffered(false);
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
                canSign={canSign}
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

            {view.name === 'installations' && (
              <InstallationsRegister
                api={api}
                organisationId={organisation.id}
                workId={view.workId}
                onOpenWork={(workId) => {
                  navigate({ name: 'work', workId }, { workTab: 'installations' });
                }}
                onOpenWorks={() => {
                  navigate({ name: 'works' });
                }}
                onClearWorkFilter={() => {
                  navigate({ name: 'installations', workId: null });
                }}
              />
            )}

            {(view.name === 'invoices' || view.name === 'invoice') && (
              <InvoicesRegister
                api={api}
                organisationId={organisation.id}
                canModify={canModify}
                canIssue={canIssue}
                canSign={canSign}
                canCancel={canCancel}
                canManageStatutory={canManageStatutory}
                hasFullWorkScope={membership?.workScope === 'all'}
                openInvoiceId={view.name === 'invoice' ? view.invoiceId : null}
                onOpenInvoice={(invoiceId) => {
                  navigate(
                    invoiceId === null
                      ? { name: 'invoices' }
                      : { name: 'invoice', invoiceId },
                  );
                }}
                onOpenWork={(workId) => {
                  navigate({ name: 'work', workId }, { workTab: 'bills' });
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

            {/* Both screens keep their rail door and refuse at the screen,
                which is the majority precedent here — Employees is the one
                module whose door is hidden, because a register of salaries
                is not something to advertise a way into. That an audit
                trail EXISTS is not a secret; every operator should know
                their actions are recorded. So the door stays and the
                server's own refusal is what the screen renders, naming
                which of its two walls stopped the read. */}
            {view.name === 'audit' && (
              <AuditTrail api={api} organisationId={organisation.id} />
            )}

            {view.name === 'mis' && (
              <Mis api={api} organisationId={organisation.id} isOwner={isOwner} />
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
          className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] max-w-none flex-col rounded-none border-0 bg-sidebar p-0 text-sidebar-foreground shadow-2xl"
        >
          <div className="flex items-center gap-3 p-3">
            <span className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-xl border border-border bg-card px-2.5 shadow-sm">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary font-mono text-xs font-bold text-primary-foreground">
                MB
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold tracking-tight">
                  Auto-MB
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {organisation.name}
                </span>
              </span>
            </span>
            <Button
              ref={mobileMenuCloseRef}
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Close menu"
              onClick={() => {
                setMobileMenuOpen(false);
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          <nav className="scrollbar-thin flex-1 overflow-y-auto px-1">
            <SidebarNav
              activeModule={activeModule}
              pendingApprovals={pendingApprovals}
              subItems={subItems}
              hiddenModules={hiddenModules}
              onOpenModule={openModule}
              onSelected={() => {
                setMobileMenuOpen(false);
              }}
              scope="drawer"
            />
          </nav>
          <div className="border-t border-sidebar-border p-3">
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
        /* The mock's bar (`components/mobile-navigation` at fdfe5ef): four
           equal cells on a translucent, blurred background that clears the
           home indicator. The raised Record button this build carried is
           gone — the mock draws Record as a cell like any other, and the
           ring-and-shadow it needed to float above the bar is exactly the
           bespoke shadow the mock does not use.

           The More cell keeps `MoreHorizontal` where the mock uses `Menu`:
           this shell has a navigation drawer the mock has no equivalent
           for, and its topbar trigger is already the hamburger. Two
           identical icons opening two different surfaces on one screen is
           a worse reading of the mock than one substituted glyph. */
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden print:hidden"
        aria-label="Mobile navigation"
        inert={mobileMenuOpen || pendingDeparture !== null}
      >
        {/* The bar's two destinations are the mock's own `Link`s, so they
            are real anchors here: a long-press offers "open in new tab"
            and the address can be copied, which a button never allows.
            A plain tap still navigates in-app through `navigate`, keeping
            the dirty-editor guard on the path. */}
        <a
          href={workspaceHashOf({ view: { name: 'dashboard' } })}
          className={`${MOBILE_BAR_CELL} ${
            activeModule === 'dashboard' ? 'text-primary' : 'text-muted-foreground'
          }`}
          aria-current={activeModule === 'dashboard' ? 'page' : undefined}
          onClick={navigateOnClick(() => {
            navigate({ name: 'dashboard' });
          })}
        >
          <Home className="size-5" aria-hidden="true" />
          Home
        </a>
        <a
          href={workspaceHashOf({ view: { name: 'works' } })}
          className={`${MOBILE_BAR_CELL} ${
            activeModule === 'works' ? 'text-primary' : 'text-muted-foreground'
          }`}
          aria-current={activeModule === 'works' ? 'page' : undefined}
          onClick={navigateOnClick(() => {
            navigate({ name: 'works' });
          })}
        >
          <FolderKanban className="size-5" aria-hidden="true" />
          Works
        </a>
        {/* Both sheet triggers drop `aria-expanded`/`aria-controls`: what
            they open is now a modal dialog that names itself, traps focus
            and restores it, not a disclosure sitting in the page. */}
        <button
          type="button"
          className={`${MOBILE_BAR_CELL} text-muted-foreground`}
          aria-haspopup="dialog"
          onClick={(event) => {
            transientMenuTriggerRef.current = event.currentTarget;
            setMobileMoreOpen(false);
            setMobileRecordOpen(true);
          }}
        >
          <Plus className="size-5" aria-hidden="true" />
          Record
        </button>
        <button
          type="button"
          className={`${MOBILE_BAR_CELL} text-muted-foreground`}
          aria-haspopup="dialog"
          onClick={(event) => {
            transientMenuTriggerRef.current = event.currentTarget;
            setMobileRecordOpen(false);
            setMobileMoreOpen(true);
          }}
        >
          <MoreHorizontal className="size-5" aria-hidden="true" />
          More
        </button>
      </nav>

      {/* Both bottom sheets are the mock's own (`components/mobile-navigation`
          at fdfe5ef): its `Sheet` on `side="bottom"`, so they rise from the
          bottom edge with a `rounded-t-2xl` top and the home-indicator inset
          the primitive already carries, instead of floating as a card above
          the bar. Their rows are the mock's outline buttons. */}
      {mobileRecordOpen && (
        <Sheet
          side="bottom"
          title="Record field activity"
          description={recordSheetDescription}
          onClose={() => {
            setMobileRecordOpen(false);
          }}
        >
          <div className="grid gap-2 pb-4">
            {recordWorkId !== null && canRecordEvidence && (
              <>
                {/* Two buttons, not one "Delivery evidence": the two records
                    now live on different tabs, and a site user tapping Record
                    on a phone means one of them specifically.

                    Drafting a challan is a Work modification, which a site
                    membership does not carry — so the button is not offered
                    to one, the way Upload LOA is not. Offering it would open
                    a tab whose only action is absent, which is the dead end
                    this sheet exists to avoid; the two records it CAN make
                    are still one tap each. */}
                {canModify && (
                  <Button
                    variant="outline"
                    className={MOBILE_SHEET_ROW}
                    onClick={() => {
                      openRecordTab(recordWorkId, 'deliveries');
                    }}
                  >
                    <Truck data-icon="inline-start" aria-hidden="true" />
                    Delivery challan
                  </Button>
                )}
                <Button
                  variant="outline"
                  className={MOBILE_SHEET_ROW}
                  onClick={() => {
                    openRecordTab(recordWorkId, 'installations');
                  }}
                >
                  <Wrench data-icon="inline-start" aria-hidden="true" />
                  Installation
                </Button>
                <Button
                  variant="outline"
                  className={MOBILE_SHEET_ROW}
                  onClick={() => {
                    openRecordTab(recordWorkId, 'measurement');
                  }}
                >
                  <FileText data-icon="inline-start" aria-hidden="true" />
                  Measurements
                </Button>
              </>
            )}
            <Button
              variant="outline"
              className={MOBILE_SHEET_ROW}
              onClick={() => {
                navigate({ name: 'works' });
              }}
            >
              <Search data-icon="inline-start" aria-hidden="true" />
              Open Works
            </Button>
          </div>
        </Sheet>
      )}

      {mobileMoreOpen && (
        <Sheet
          side="bottom"
          title="More modules"
          description="Open another Auto-MB module."
          onClose={() => {
            setMobileMoreOpen(false);
          }}
        >
          <div className="grid gap-2 pb-4">
            {MOBILE_MORE_ITEMS.filter((item) => !hiddenModules.has(item.key)).map(
              (item) => {
                const Icon = item.icon;
                return (
                  <Button
                    key={item.key}
                    variant="outline"
                    className={MOBILE_SHEET_ROW}
                    onClick={() => {
                      openModule(item.key);
                    }}
                  >
                    <Icon data-icon="inline-start" aria-hidden="true" />
                    {item.label}
                    {item.key === 'approvals' && pendingApprovals > 0 && (
                      <Badge className="ml-auto" variant="destructive">
                        {pendingApprovals}
                      </Badge>
                    )}
                  </Button>
                );
              },
            )}
            <Button
              variant="destructive"
              className={MOBILE_SHEET_ROW}
              onClick={() => {
                requestDeparture(onSignOut);
              }}
            >
              <LogOut data-icon="inline-start" aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </Sheet>
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

/**
 * What a member without `can_manage_payroll` sees where the payroll
 * screens would be — for a member who never reaches this, because the
 * rail hides the door; it is the backstop for a pasted or bookmarked
 * fragment.
 *
 * Deliberately NOT an `ErrorState`. `docs/UX.md` § Shared states settles
 * it: a 403 does not become a success on the second attempt, so offering
 * a Retry would offer a control that refuses identically. It reads as an
 * inline refusal naming the authority and where it is granted, which is
 * the same shape `remedies.ts` gives `AUTHORITY_REQUIRED`.
 *
 * The title tracks which of the two screens was addressed, so the h1
 * matches the topbar's section title rather than always reading
 * "Employees" over a payroll fragment.
 */
function NotificationsAuthorityRequired() {
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Notifications"
        titleId="notifications-authority-title"
        description="Messaging channels, templates, consent and delivery."
      />
      <Card>
        <p className="m-0 text-sm">
          Notifications are behind the notifications authority, and this account does
          not hold it. The consent register carries counterparties&rsquo; personal
          telephone numbers and the delivery log says who was messaged, so it is granted
          per member rather than by role.
        </p>
        <p className="m-0 mt-2 text-sm text-muted-foreground">
          Ask an owner to grant it on the Members screen.
        </p>
      </Card>
    </>
  );
}

function PayrollAuthorityRequired({ title }: { readonly title: string }) {
  return (
    <>
      <PageHeader
        eyebrow="People and payroll"
        title={title}
        titleId="payroll-authority-title"
        description="Employee records and payroll."
      />
      <Card>
        <p className="m-0 text-sm">
          Payroll is behind the payroll authority, and this account does not hold it.
          The register carries every colleague&rsquo;s salary, PAN and bank details, so
          it is granted per member rather than by role.
        </p>
        <p className="m-0 mt-2 text-sm text-muted-foreground">
          Ask an owner to grant it on the Members screen, or ask a member who already
          holds it to run the month.
        </p>
      </Card>
    </>
  );
}
