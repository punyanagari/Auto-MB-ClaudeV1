import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
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
  LayoutDashboard,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings as SettingsIcon,
  Upload,
  Users,
  X,
} from 'lucide-react';
import type { ApiClient, MeResponse } from '../api.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Approvals } from './Approvals.js';
import { ChallanDetail } from './ChallanDetail.js';
import { ChallanEditor } from './ChallanEditor.js';
import { IssueChallanDetail } from './IssueChallanDetail.js';
import { IssueChallanEditor } from './IssueChallanEditor.js';
import { Masters, type MastersTab } from './Masters.js';
import { Members } from './Members.js';
import { OperationsDashboard } from './OperationsDashboard.js';
import { Quotations } from './Quotations.js';
import { ReviewLoa } from './ReviewLoa.js';
import { SerialLookup } from './SerialLookup.js';
import { Settings } from './Settings.js';
import { OrganisationAccessSettings } from './OrganisationAccessSettings.js';
import { UploadLoa } from './UploadLoa.js';
import { WorkDetail, type WorkTab } from './WorkDetail.js';
import { Works } from './Works.js';

interface OperationsWorkspaceProps {
  readonly api: ApiClient;
  readonly me: MeResponse;
  readonly organisation: Organisation;
  readonly organisations: readonly Organisation[];
  readonly onSwitchOrganisation: () => void;
  readonly onOrganisationCreated: (organisation: Organisation) => void;
  readonly onSignOut: () => void;
}

type WorkspaceView =
  | { name: 'dashboard' }
  | { name: 'works' }
  | { name: 'upload' }
  | { name: 'review'; documentId: string }
  | { name: 'work'; workId: string }
  | { name: 'challan-new'; workId: string; workCode: string }
  | { name: 'challan-edit'; workId: string; workCode: string; challanId: string }
  | { name: 'challan'; workId: string; workCode: string; challanId: string }
  | { name: 'masters' }
  | { name: 'issue-challan-new'; workId: string }
  | { name: 'issue-challan-edit'; workId: string; challanId: string }
  | { name: 'issue-challan'; workId: string; challanId: string }
  | { name: 'quotations' }
  | { name: 'approvals' }
  | { name: 'serials' }
  | { name: 'members' }
  | { name: 'settings' };

interface PendingDeparture {
  readonly action: () => void;
}

type ModuleKey =
  | 'dashboard'
  | 'works'
  | 'quotations'
  | 'approvals'
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
      { key: 'quotations' as const, label: 'Quotations', icon: FileText },
      { key: 'approvals' as const, label: 'Approvals', icon: CheckCircle },
    ],
  },
  {
    label: 'Operations',
    items: [
      { key: 'serials' as const, label: 'Serial Lookup', icon: Search },
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
  { key: 'quotations', label: 'Quotations', icon: FileText },
  { key: 'approvals', label: 'Approvals', icon: CheckCircle },
  { key: 'serials', label: 'Serial Lookup', icon: Search },
  { key: 'masters', label: 'Masters', icon: Database },
  { key: 'members', label: 'Members', icon: Users },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
] as const;

const MASTERS_CATEGORIES: readonly { key: MastersTab; label: string }[] = [
  { key: 'contacts', label: 'Contacts' },
  { key: 'locations', label: 'Locations' },
  { key: 'units', label: 'Units' },
  { key: 'signatories', label: 'Signatories' },
];

function defaultViewOf(key: ModuleKey): WorkspaceView {
  switch (key) {
    case 'dashboard':
      return { name: 'dashboard' };
    case 'works':
      return { name: 'works' };
    case 'quotations':
      return { name: 'quotations' };
    case 'approvals':
      return { name: 'approvals' };
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
    case 'dashboard':
    case 'quotations':
    case 'approvals':
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
    case 'quotations':
      return 'Quotations';
    case 'approvals':
      return 'Approvals';
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
  const [view, setView] = useState<WorkspaceView>({ name: 'dashboard' });
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [workTab, setWorkTab] = useState<WorkTab>('overview');
  const [tabbedWorkId, setTabbedWorkId] = useState<string | null>(null);
  const [mastersTab, setMastersTab] = useState<MastersTab>('contacts');
  const [challanWork, setChallanWork] = useState<{
    readonly workId: string;
    readonly status: Work['status'];
  } | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [headerQuickActionsOpen, setHeaderQuickActionsOpen] = useState(false);
  const [mobileRecordOpen, setMobileRecordOpen] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [pendingDeparture, setPendingDeparture] = useState<PendingDeparture | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const mobileMenuDialogRef = useRef<HTMLDivElement>(null);
  const mobileMenuCloseRef = useRef<HTMLButtonElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const discardAndLeaveRef = useRef<HTMLButtonElement>(null);
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
  const isOwner = membership?.role === 'owner';
  const canSwitchOrganisation = organisations.length > 1;
  const activeModule = activeModuleOf(view);
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

  const openedChallanWorkId =
    view.name === 'challan' || view.name === 'issue-challan' ? view.workId : null;
  useEffect(() => {
    if (openedChallanWorkId === null) return;
    let cancelled = false;
    api
      .getWork(organisation.id, openedChallanWorkId)
      .then((loaded) => {
        if (!cancelled) {
          setChallanWork({ workId: openedChallanWorkId, status: loaded.work.status });
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

  useEffect(() => {
    containerRef.current?.querySelector('h1')?.focus();
    setMobileMenuOpen(false);
    setMobileMoreOpen(false);
    setHeaderQuickActionsOpen(false);
    setMobileRecordOpen(false);
  }, [view]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const restoreTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    mobileMenuCloseRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (restoreTarget?.isConnected === true) restoreTarget.focus();
    };
  }, [mobileMenuOpen]);

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

  useEffect(() => {
    if (pendingDeparture === null) return;
    const restoreTarget = departureRestoreFocusRef.current;
    keepEditingRef.current?.focus();
    return () => {
      if (restoreTarget?.isConnected === true) restoreTarget.focus();
    };
  }, [pendingDeparture]);

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

  function navigate(next: WorkspaceView): void {
    requestDeparture(() => {
      setView(next);
    });
  }

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

  function handleDepartureKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      keepEditing();
      return;
    }
    if (event.key !== 'Tab') return;
    const keep = keepEditingRef.current;
    const discard = discardAndLeaveRef.current;
    if (keep === null || discard === null) return;
    if (event.shiftKey && document.activeElement === keep) {
      event.preventDefault();
      discard.focus();
    } else if (!event.shiftKey && document.activeElement === discard) {
      event.preventDefault();
      keep.focus();
    }
  }

  function handleMobileMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setMobileMenuOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      mobileMenuDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), ' +
          'select:not([disabled]), textarea:not([disabled]), ' +
          '[tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openRecordTab(workId: string, tab: 'deliveries' | 'measurement'): void {
    requestDeparture(() => {
      setTabbedWorkId(workId);
      setWorkTab(tab);
      setMobileRecordOpen(false);
      setView({ name: 'work', workId });
    });
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
        setMastersTab(category.key);
        navigate({ name: 'masters' });
      },
      current: view.name === 'masters' && mastersTab === category.key,
    })),
  };

  function openModule(key: ModuleKey): void {
    navigate(defaultViewOf(key));
  }

  function renderNavigation(closeAfterSelection = false) {
    return (
      <>
        {NAVIGATION.map((group) => (
          <div key={group.label} className="mb-5 last:mb-0">
            <p className="mb-2 px-3 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
              {group.label}
            </p>
            <div className="flex flex-col gap-1">
              {group.items.map((item) => {
         ënº¶‰Ëkºwµç]”õì¡¹•áĞ¤€ôøì(€€€€€€€€€€€€€€€Í•ÑQ…‰‰•‘]½É­%¡Ù¥•Ü¹İ½É­%¤ì(€€€€€€€€€€€€€€€Í•Ñ]½É­Q…ˆ¡¹•áĞ¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€¼ø(€€€€€€€€€€¥ô((€€€€€€€€€ì¡Ù¥•Ü¹¹…µ”€ôôô€¡…±±…¸µ¹•ÜœñğÙ¥•Ü¹¹…µ”€ôôô€¡…±±…¸µ•‘¥Ğœ¤€˜˜€ (€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à™±•àµ½°…À´Ğˆø(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰É½Õ¹‘•´Éá°‰½É‘•È‰½É‘•ÈµÁÉ¥µ…Éä¼ÄÔ‰œµÁÉ¥µ…Éä½lÀ¸ÀÌÕtÀ´Ğˆø(€€€€€€€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áĞµáÌ™½¹ĞµÍ•µ¥‰½±Ñ•áĞµÁÉ¥µ…Éäˆø(€€€€€€€€€€€€€€€€€•±¥Ù•Éä¡…±±…¸İ½É­™±½Ü(€€€€€€€€€€€€€€€€ğ½Àø(€€€€€€€€€€€€€€€€ñ½°±…ÍÍ9…µ”ô‰µĞ´ÌÉ¥±¥ÍĞµ¹½¹”…À´ÈÀ´ÀÑ•áĞµáÌÍ´éÉ¥µ½±Ì´Ìˆø(€€€€€€€€€€€€€€€€€€ñ±¤±…ÍÍ9…µ”ô‰É½Õ¹‘•µá°‰œµ…ÉÁà´ÌÁä´È™½¹Ğµµ•‘¥Õ´Í¡…‘½ÜµÍ´ˆø(€€€€€€€€€€€€€€€€€€€€Ä¸]½É¬€™…µÀì½¹Í¥¹•”(€€€€€€€€€€€€€€€€€€ğ½±¤ø(€€€€€€€€€€€€€€€€€€ñ±¤±…ÍÍ9…µ”ô‰É½Õ¹‘•µá°‰œµ…ÉÁà´ÌÁä´È™½¹Ğµµ•‘¥Õ´Í¡…‘½ÜµÍ´ˆø(€€€€€€€€€€€€€€€€€€€€È¸%Ñ•µÌ€™…µÀìA<±¥¹­Ì(€€€€€€€€€€€€€€€€€€ğ½±¤ø(€€€€€€€€€€€€€€€€€€ñ±¤±…ÍÍ9…µ”ô‰É½Õ¹‘•µá°‰œµ…ÉÁà´ÌÁä´È™½¹Ğµµ•‘¥Õ´Í¡…‘½ÜµÍ´ˆø(€€€€€€€€€€€€€€€€€€€€Ì¸I•Ù¥•Ü€™…µÀìÍ…Ù”‘É…™Ğ(€€€€€€€€€€€€€€€€€€ğ½±¤ø(€€€€€€€€€€€€€€€€ğ½½°ø(€€€€€€€€€€€€€€ğ½‘¥Øø(€€€€€€€€€€€€€€ñ¡…±±…¹‘¥Ñ½È(€€€€€€€€€€€€€€€…Á¤õí…Á¥ô(€€€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%õí½É…¹¥Í…Ñ¥½¸¹¥‘ô(€€€€€€€€€€€€€€€İ½É­%õíÙ¥•Ü¹İ½É­%‘ô(€€€€€€€€€€€€€€€İ½É­½‘”õíÙ¥•Ü¹İ½É­½‘•ô(€€€€€€€€€€€€€€€¡…±±…¹%õíÙ¥•Ü¹¹…µ”€ôôô€¡…±±…¸µ•‘¥Ğœ€üÙ¥•Ü¹¡…±±…¹%€è¹Õ±±ô(€€€€€€€€€€€€€€€½¹M…Ù•õì¡¡…±±…¹%¤€ôøì(€€€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì(€€€€€€€€€€€€€€€€€€€¹…µ”è€¡…±±…¸œ°(€€€€€€€€€€€€€€€€€€€İ½É­%èÙ¥•Ü¹İ½É­%°(€€€€€€€€€€€€€€€€€€€İ½É­½‘”èÙ¥•Ü¹İ½É­½‘”°(€€€€€€€€€€€€€€€€€€€¡…±±…¹%°(€€€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€½¹…¹•°õì ¤€ôøì(€€€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì¹…µ”è€İ½É¬œ°İ½É­%èÙ¥•Ü¹İ½É­%ô¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€½¹¥ÉÑå¡…¹”õíÍ•Ñ‘¥Ñ½É¥ÉÑåô(€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€ğ½‘¥Øø(€€€€€€€€€€¥ô((€€€€€€€€€íÙ¥•Ü¹¹…µ”€ôôô€¡…±±…¸œ€˜˜€ (€€€€€€€€€€€€ñ¡…±±…¹•Ñ…¥°(€€€€€€€€€€€€€…Á¤õí…Á¥ô(€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%õí½É…¹¥Í…Ñ¥½¸¹¥‘ô(€€€€€€€€€€€€€¡…±±…¹%õíÙ¥•Ü¹¡…±±…¹%‘ô(€€€€€€€€€€€€€…¹5½‘¥™äõí…¹5½‘¥™åô(€€€€€€€€€€€€€…¹%ÍÍÕ”õí…¹%ÍÍÕ•ô(€€€€€€€€€€€€€…¹…¹•°õí…¹…¹•±ô(€€€€€€€€€€€€€…¹I•½É‘Ù¥‘•¹”õí…¹I•½É‘Ù¥‘•¹•ô(€€€€€€€€€€€€€İ½É­Ñ¥Ù”õí¡…±±…¹]½É­Ñ¥Ù•ô(€€€€€€€€€€€€€½¹‘¥Ğõì¡¡…±±…¹%¤€ôøì(€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì(€€€€€€€€€€€€€€€€€¹…µ”è€¡…±±…¸µ•‘¥Ğœ°(€€€€€€€€€€€€€€€€€İ½É­%èÙ¥•Ü¹İ½É­%°(€€€€€€€€€€€€€€€€€İ½É­½‘”èÙ¥•Ü¹İ½É­½‘”°(€€€€€€€€€€€€€€€€€¡…±±…¹%°(€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€½¹•±•Ñ•õì ¤€ôøì(€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì¹…µ”è€İ½É¬œ°İ½É­%èÙ¥•Ü¹İ½É­%ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€½¹	…¬õì ¤€ôøì(€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì¹…µ”è€İ½É¬œ°İ½É­%èÙ¥•Ü¹İ½É­%ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€¼ø(€€€€€€€€€€¥ô((€€€€€€€€€íÙ¥•Ü¹¹…µ”€ôôô€µ…ÍÑ•ÉÌœ€˜˜€ (€€€€€€€€€€€€ñ5…ÍÑ•ÉÌ(€€€€€€€€€€€€€…Á¤õí…Á¥ô(€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%õí½É…¹¥Í…Ñ¥½¸¹¥‘ô(€€€€€€€€€€€€€…¹5½‘¥™äõí…¹5½‘¥™åô(€€€€€€€€€€€€€Ñ…ˆõíµ…ÍÑ•ÉÍQ…‰ô(€€€€€€€€€€€€€½¹Q…‰¡…¹”õíÍ•Ñ5…ÍÑ•ÉÍQ…‰ô(€€€€€€€€€€€€¼ø(€€€€€€€€€€¥ô((€€€€€€€€€ì¡Ù¥•Ü¹¹…µ”€ôôô€¥ÍÍÕ”µ¡…±±…¸µ¹•Üœñğ(€€€€€€€€€€€Ù¥•Ü¹¹…µ”€ôôô€¥ÍÍÕ”µ¡…±±…¸µ•‘¥Ğœ¤€˜˜€ (€€€€€€€€€€€€ñ%ÍÍÕ•¡…±±…¹‘¥Ñ½È(€€€€€€€€€€€€€…Á¤õí…Á¥ô(€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%õí½É…¹¥Í…Ñ¥½¸¹¥‘ô(€€€€€€€€€€€€€İ½É­%õíÙ¥•Ü¹İ½É­%‘ô(€€€€€€€€€€€€€¡…±±…¹%õíÙ¥•Ü¹¹…µ”€ôôô€¥ÍÍÕ”µ¡…±±…¸µ•‘¥Ğœ€üÙ¥•Ü¹¡…±±…¹%€è¹Õ±±ô(€€€€€€€€€€€€€½¹M…Ù•õì¡¡…±±…¹%¤€ôøì(€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì¹…µ”è€¥ÍÍÕ”µ¡…±±…¸œ°İ½É­%èÙ¥•Ü¹İ½É­%°¡…±±…¹%ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€½¹…¹•°õì ¤€ôøì(€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì¹…µ”è€İ½É¬œ°İ½É­%èÙ¥•Ü¹İ½É­%ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€½¹¥ÉÑå¡…¹”õíÍ•Ñ‘¥Ñ½É¥ÉÑåô(€€€€€€€€€€€€¼ø(€€€€€€€€€€¥ô((€€€€€€€€€íÙ¥•Ü¹¹…µ”€ôôô€¥ÍÍÕ”µ¡…±±…¸œ€˜˜€ (€€€€€€€€€€€€ñ%ÍÍÕ•¡…±±…¹•Ñ…¥°(€€€€€€€€€€€€€…Á¤õí…Á¥ô(€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%õí½É…¹¥Í…Ñ¥½¸¹¥‘ô(€€€€€€€€€€€€€¡…±±…¹%õíÙ¥•Ü¹¡…±±…¹%‘ô(€€€€€€€€€€€€€…¹5½‘¥™äõí…¹5½‘¥™åô(€€€€€€€€€€€€€…¹%ÍÍÕ”õí…¹%ÍÍÕ•ô(€€€€€€€€€€€€€…¹…¹•°õí…¹…¹•±ô(€€€€€€€€€€€€€İ½É­Ñ¥Ù”õí¡…±±…¹]½É­Ñ¥Ù•ô(€€€€€€€€€€€€€½¹‘¥Ğõì¡¡…±±…¹%¤€ôøì(€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì(€€€€€€€€€€€€€€€€€¹…µ”è€¥ÍÍÕ”µ¡…±±…¸µ•‘¥Ğœ°(€€€€€€€€€€€€€€€€€İ½É­%èÙ¥•Ü¹İ½É­%°(€€€€€€€€€€€€€€€€€¡…±±…¹%°(€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€½¹•±•Ñ•õì ¤€ôøì(€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì¹…µ”è€İ½É¬œ°İ½É­%èÙ¥•Ü¹İ½É­%ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€½¹	…¬õì ¤€ôøì(€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì¹…µ”è€İ½É¬œ°İ½É­%èÙ¥•Ü¹İ½É­%ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€¼ø(€€€€€€€€€€¥ô((€€€€€€€€€íÙ¥•Ü¹¹…µ”€ôôô€Í•É¥…±Ìœ€˜˜€ (€€€€€€€€€€€€ñM•É¥…±1½½­ÕÀ(€€€€€€€€€€€€€…Á¤õí…Á¥ô(€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%õí½É…¹¥Í…Ñ¥½¸¹¥‘ô(€€€€€€€€€€€€€½¹=Á•¹]½É¬õì¡İ½É­%¤€ôøì(€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì¹…µ”è€İ½É¬œ°İ½É­%ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€½¹=Á•¹¡…±±…¸õì¡İ½É­%°¡…±±…¹%¤€ôøì(€€€€€€€€€€€€€€€Í•ÑY¥•Ü¡ì¹…µ”è€¡…±±…¸œ°İ½É­%°İ½É­½‘”è€œœ°¡…±±…¹%ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€¼ø(€€€€€€€€€€¥ô((€€€€€€€€€íÙ¥•Ü¹¹…µ”€ôôô€µ•µ‰•ÉÌœ€˜˜€ (€€€€€€€€€€€€ñ5•µ‰•ÉÌ(€€€€€€€€€€€€€…Á¤õí…Á¥ô(€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%õí½É…¹¥Í…Ñ¥½¸¹¥‘ô(€€€€€€€€€€€€€ÕÉÉ•¹ÑUÍ•É%õíµ”¹ÕÍ•È¹¥‘ô(€€€€€€€€€€€€¼ø(€€€€€€€€€€¥ô(€€€€€€€€ğ½µ…¥¸ø(€€€€€€ğ½‘¥Øø((€€€€€íµ½‰¥±•5•¹Õ=Á•¸€˜˜€ (€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™¥á•¥¹Í•Ğ´Àè´ÔÀ±œé¡¥‘‘•¸ÁÉ¥¹Ğé¡¥‘‘•¸ˆø(€€€€€€€€€€ñ‘¥Ø(€€€€€€€€€€€±…ÍÍ9…µ”ô‰…‰Í½±ÕÑ”¥¹Í•Ğ´À‰œµ™½É•É½Õ¹¼ÈÔ‰…­‘É½Àµ‰±ÕÈµÍ´ˆ(€€€€€€€€€€€…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ(€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€Í•Ñ5½‰¥±•5•¹Õ=Á•¸¡™…±Í”¤ì(€€€€€€€€€€€õô(€€€€€€€€€€¼ø(€€€€€€€€€€ñ‘¥Ø(€€€€€€€€€€€¥ô‰µ½‰¥±”µ¹…Ù¥…Ñ¥½¸µ‘¥…±½œˆ(€€€€€€€€€€€É•˜õíµ½‰¥±•5•¹Õ¥…±½I•™ô(€€€€€€€€€€€±…ÍÍ9…µ”ô‰…‰Í½±ÕÑ”¥¹Í•Ğµä´À±•™Ğ´À™±•àÜµmµ¥¸ ÈÁÉ•´°àáÙÜ¥t™±•àµ½°‰½É‘•ÈµÈ‰½É‘•Èµ‰½É‘•È‰œµ…ÉÍ¡…‘½Ü´Éá°ˆ(€€€€€€€€€€€É½±”ô‰‘¥…±½œˆ(€€€€€€€€€€€…É¥„µµ½‘…°ô‰ÑÉÕ”ˆ(€€€€€€€€€€€…É¥„µ±…‰•°ô‰ÁÁ±¥…Ñ¥½¸¹…Ù¥…Ñ¥½¸ˆ(€€€€€€€€€€€½¹-•å½İ¸õí¡…¹‘±•5½‰¥±•5•¹Õ-•å½İ¹ô(€€€€€€€€€€ø(€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à µlĞ¸ÕÉ•µt¥Ñ•µÌµ•¹Ñ•È…À´Ì‰½É‘•Èµˆ‰½É‘•Èµ‰½É‘•ÈÁà´Ğˆø(€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰¥¹±¥¹”µ™±•àÍ¥é”´ÄÀ¥Ñ•µÌµ•¹Ñ•È©ÕÍÑ¥™äµ•¹Ñ•ÈÉ½Õ¹‘•µá°‰œµÁÉ¥µ…ÉäÑ•áĞµÁÉ¥µ…Éäµ™½É•É½Õ¹ˆø(€€€€€€€€€€€€€€€€ñ	Õ¥±‘¥¹œÈ±…ÍÍ9…µ”ô‰Í¥é”´Ôˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€€€€€€ğ½ÍÁ…¸ø(€€€€€€€€€€€€€€ñÍÑÉ½¹œ±…ÍÍ9…µ”ô‰™±•à´ÄˆùÕÑ¼µ5ğ½ÍÑÉ½¹œø(€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€É•˜õíµ½‰¥±•5•¹Õ±½Í•I•™ô(€€€€€€€€€€€€€€€Ù…É¥…¹Ğô‰¡½ÍĞˆ(€€€€€€€€€€€€€€€Í¥é”ô‰¥½¸ˆ(€€€€€€€€€€€€€€€…É¥„µ±…‰•°ô‰±½Í”µ•¹Ôˆ(€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€Í•Ñ5½‰¥±•5•¹Õ=Á•¸¡™…±Í”¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€ñ`…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€€€€€€ğ½	ÕÑÑ½¸ø(€€€€€€€€€€€€ğ½‘¥Øø(€€€€€€€€€€€€ñ¹…Ø±…ÍÍ9…µ”ô‰ÍÉ½±±‰…ÈµÑ¡¥¸™±•à´Ä½Ù•É™±½Üµäµ…ÕÑ¼Áà´ÌÁä´Ôˆø(€€€€€€€€€€€€€íÉ•¹‘•É9…Ù¥…Ñ¥½¸¡ÑÉÕ”¥ô(€€€€€€€€€€€€ğ½¹…Øø(€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰‰½É‘•ÈµĞ‰½É‘•Èµ‰½É‘•ÈÀ´Ìˆø(€€€€€€€€€€€€€í…¹Mİ¥Ñ¡=É…¹¥Í…Ñ¥½¸€˜˜€ (€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€Ù…É¥…¹Ğô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€±…ÍÍ9…µ”ô‰Üµ™Õ±°ˆ(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€É•ÅÕ•ÍÑ•Á…ÉÑÕÉ”¡½¹Mİ¥Ñ¡=É…¹¥Í…Ñ¥½¸¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€ñÉÉ½İ1•™ÑI¥¡Ğ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€€€€€€€€€Mİ¥Ñ ½É…¹¥Í…Ñ¥½¸(€€€€€€€€€€€€€€€€ğ½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€Ù…É¥…¹Ğô‰¡½ÍĞˆ(€€€€€€€€€€€€€€€±…ÍÍ9…µ”ô‰µĞ´ÄÜµ™Õ±°ˆ(€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€É•ÅÕ•ÍÑ•Á…ÉÑÕÉ”¡½¹M¥¹=ÕĞ¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€ñ1½=ÕĞ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€€€€€€€M¥¸½ÕĞ(€€€€€€€€€€€€€€ğ½	ÕÑÑ½¸ø(€€€€€€€€€€€€ğ½‘¥Øø(€€€€€€€€€€ğ½‘¥Øø(€€€€€€€€ğ½‘¥Øø(€€€€€€¥ô((€€€€€€ñ¹…Ø(€€€€€€€±…ÍÍ9…µ”ô‰™¥á•¥¹Í•Ğµà´À‰½ÑÑ½´´Àè´ĞÀÉ¥É¥µ½±Ì´Ğ‰½É‘•ÈµĞ‰½É‘•Èµ‰½É‘•È‰œµ…É¼äÔÁà´ÈÁä´Ä¸Ô‰…­‘É½Àµ‰±ÕÈ±œé¡¥‘‘•¸ÁÉ¥¹Ğé¡¥‘‘•¸ˆ(€€€€€€€…É¥„µ±…‰•°ô‰5½‰¥±”¹…Ù¥…Ñ¥½¸ˆ(€€€€€€€¥¹•ÉĞõíµ½‰¥±•5•¹Õ=Á•¸ñğÁ•¹‘¥¹•Á…ÉÑÕÉ”€„ôô¹Õ±±ô(€€€€€€ø(€€€€€€€€ñ‰ÕÑÑ½¸(€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ(€€€€€€€€€±…ÍÍ9…µ”õí™±•à™±•àµ½°¥Ñ•µÌµ•¹Ñ•È…À´ÄÉ½Õ¹‘•µá°Áà´ÈÁä´Ä¸ÔÑ•áĞµlÄÁÁát™½¹Ğµµ•‘¥Õ´€‘ì(€€€€€€€€€€€…Ñ¥Ù•5½‘Õ±”€ôôô€‘…Í¡‰½…Éœ€ü€Ñ•áĞµÁÉ¥µ…Éäœ€è€Ñ•áĞµµÕÑ•µ™½É•É½Õ¹œ(€€€€€€€€€õô(€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€¹…Ù¥…Ñ”¡ì¹…µ”è€‘…Í¡‰½…Éœô¤ì(€€€€€€€€€õô(€€€€€€€€ø(€€€€€€€€€€ñ1…å½ÕÑ…Í¡‰½…É±…ÍÍ9…µ”ô‰Í¥é”´Ôˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€!½µ”(€€€€€€€€ğ½‰ÕÑÑ½¸ø(€€€€€€€€ñ‰ÕÑÑ½¸(€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ(€€€€€€€€€±…ÍÍ9…µ”õí™±•à™±•àµ½°¥Ñ•µÌµ•¹Ñ•È…À´ÄÉ½Õ¹‘•µá°Áà´ÈÁä´Ä¸ÔÑ•áĞµlÄÁÁát™½¹Ğµµ•‘¥Õ´€‘ì(€€€€€€€€€€€…Ñ¥Ù•5½‘Õ±”€ôôô€İ½É­Ìœ€ü€Ñ•áĞµÁÉ¥µ…Éäœ€è€Ñ•áĞµµÕÑ•µ™½É•É½Õ¹œ(€€€€€€€€€õô(€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€¹…Ù¥…Ñ”¡ì¹…µ”è€İ½É­Ìœô¤ì(€€€€€€€€€õô(€€€€€€€€ø(€€€€€€€€€€ñ	É¥•™…Í•	ÕÍ¥¹•ÍÌ±…ÍÍ9…µ”ô‰Í¥é”´Ôˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€]½É­Ì(€€€€€€€€ğ½‰ÕÑÑ½¸ø(€€€€€€€€ñ‰ÕÑÑ½¸(€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ(€€€€€€€€€±…ÍÍ9…µ”ô‰™±•à™±•àµ½°¥Ñ•µÌµ•¹Ñ•È…À´ÄÉ½Õ¹‘•µá°Áà´ÈÁä´Ä¸ÔÑ•áĞµlÄÁÁát™½¹Ğµµ•‘¥Õ´Ñ•áĞµÁÉ¥µ…Éäˆ(€€€€€€€€€…É¥„µ±…‰•°õíµ½‰¥±•I•½É‘=Á•¸€ü€±½Í”É•½É…Ñ¥½¹Ìœ€è€=Á•¸É•½É…Ñ¥½¹Ìô(€€€€€€€€€…É¥„µ•áÁ…¹‘•õíµ½‰¥±•I•½É‘=Á•¹ô(€€€€€€€€€…É¥„µ½¹ÑÉ½±Ìô‰µ½‰¥±”µÉ•½Éµ…Ñ¥½¹Ìˆ(€€€€€€€€€½¹±¥¬õì¡•Ù•¹Ğ¤€ôøì(€€€€€€€€€€€ÑÉ…¹Í¥•¹Ñ5•¹ÕQÉ¥•ÉI•˜¹ÕÉÉ•¹Ğ€ô•Ù•¹Ğ¹ÕÉÉ•¹ÑQ…É•Ğì(€€€€€€€€€€€Í•Ñ!•…‘•ÉEÕ¥­Ñ¥½¹Í=Á•¸¡™…±Í”¤ì(€€€€€€€€€€€Í•Ñ5½‰¥±•5½É•=Á•¸¡™…±Í”¤ì(€€€€€€€€€€€Í•Ñ5½‰¥±•I•½É‘=Á•¸ ¡ÕÉÉ•¹Ğ¤€ôø€…ÕÉÉ•¹Ğ¤ì(€€€€€€€€€õô(€€€€€€€€ø(€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ôˆµµĞ´Ô¥¹±¥¹”µ™±•àÍ¥é”´ÄÄ¥Ñ•µÌµ•¹Ñ•È©ÕÍÑ¥™äµ•¹Ñ•ÈÉ½Õ¹‘•´Éá°‰œµÁÉ¥µ…ÉäÑ•áĞµÁÉ¥µ…Éäµ™½É•É½Õ¹Í¡…‘½Üµ±œÉ¥¹œ´ĞÉ¥¹œµ‰…­É½Õ¹ˆø(€€€€€€€€€€€€ñA±ÕÌ±…ÍÍ9…µ”ô‰Í¥é”´Ôˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€€ğ½ÍÁ…¸ø(€€€€€€€€€I•½É(€€€€€€€€ğ½‰ÕÑÑ½¸ø(€€€€€€€€ñ‰ÕÑÑ½¸(€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ(€€€€€€€€€±…ÍÍ9…µ”ô‰™±•à™±•àµ½°¥Ñ•µÌµ•¹Ñ•È…À´ÄÉ½Õ¹‘•µá°Áà´ÈÁä´Ä¸ÔÑ•áĞµlÄÁÁát™½¹Ğµµ•‘¥Õ´Ñ•áĞµµÕÑ•µ™½É•É½Õ¹ˆ(€€€€€€€€€…É¥„µ•áÁ…¹‘•õíµ½‰¥±•5½É•=Á•¹ô(€€€€€€€€€½¹±¥¬õì¡•Ù•¹Ğ¤€ôøì(€€€€€€€€€€€ÑÉ…¹Í¥•¹Ñ5•¹ÕQÉ¥•ÉI•˜¹ÕÉÉ•¹Ğ€ô•Ù•¹Ğ¹ÕÉÉ•¹ÑQ…É•Ğì(€€€€€€€€€€€Í•Ñ!•…‘•ÉEÕ¥­Ñ¥½¹Í=Á•¸¡™…±Í”¤ì(€€€€€€€€€€€Í•Ñ5½‰¥±•I•½É‘=Á•¸¡™…±Í”¤ì(€€€€€€€€€€€Í•Ñ5½‰¥±•5½É•=Á•¸ ¡ÕÉÉ•¹Ğ¤€ôø€…ÕÉÉ•¹Ğ¤ì(€€€€€€€€€õô(€€€€€€€€ø(€€€€€€€€€€ñ5½É•!½É¥é½¹Ñ…°±…ÍÍ9…µ”ô‰Í¥é”´Ôˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€5½É”(€€€€€€€€ğ½‰ÕÑÑ½¸ø(€€€€€€ğ½¹…Øø((€€€€€íµ½‰¥±•I•½É‘=Á•¸€˜˜€ (€€€€€€€€ñ‘¥Ø(€€€€€€€€€¥ô‰µ½‰¥±”µÉ•½Éµ…Ñ¥½¹Ìˆ(€€€€€€€€€±…ÍÍ9…µ”ô‰™¥á•¥¹Í•Ğµà´Ì‰½ÑÑ½´´ÈÀè´ÔÀÉ½Õ¹‘•´Éá°‰½É‘•È‰½É‘•Èµ‰½É‘•È‰œµ…ÉÀ´ÌÍ¡…‘½Ü´Éá°±œé¡¥‘‘•¸ÁÉ¥¹Ğé¡¥‘‘•¸ˆ(€€€€€€€€€É½±”ô‰É½ÕÀˆ(€€€€€€€€€…É¥„µ±…‰•°ô‰I•½É…Ñ¥½¹Ìˆ(€€€€€€€€ø(€€€€€€€€€íÉ•½É‘]½É­%€„ôô¹Õ±°€˜˜…¹I•½É‘Ù¥‘•¹”€ü€ (€€€€€€€€€€€€ğø(€€€€€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Áà´ÈÁˆ´ÈÑ•áĞµáÌÑ•áĞµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€€€€€€€€€I•½ÉÍ¥Ñ”•Ù¥‘•¹”……¥¹ÍĞÑ¡”½Á•¸]½É¬¸(€€€€€€€€€€€€€€ğ½Àø(€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸(€€€€€€€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ(€€€€€€€€€€€€€€€±…ÍÍ9…µ”ô‰™±•àÜµ™Õ±°¥Ñ•µÌµ•¹Ñ•È…À´ÌÉ½Õ¹‘•µá°Áà´ÌÁä´È¸ÔÑ•áĞµ±•™ĞÑ•áĞµÍ´¡½Ù•Èé‰œµµÕÑ•ˆ(€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€½Á•¹I•½É‘Q…ˆ¡É•½É‘]½É­%°€‘•±¥Ù•É¥•Ìœ¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€ñ	É¥•™…Í•	ÕÍ¥¹•ÍÌ±…ÍÍ9…µ”ô‰Í¥é”´ĞÑ•áĞµÁÉ¥µ…Éäˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€€€€€€€•±¥Ù•Éä•Ù¥‘•¹”(€€€€€€€€€€€€€€ğ½‰ÕÑÑ½¸ø(€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸(€€€€€€€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ(€€€€€€€€€€€€€€€±…ÍÍ9…µ”ô‰™±•àÜµ™Õ±°¥Ñ•µÌµ•¹Ñ•È…À´ÌÉ½Õ¹‘•µá°Áà´ÌÁä´È¸ÔÑ•áĞµ±•™ĞÑ•áĞµÍ´¡½Ù•Èé‰œµµÕÑ•ˆ(€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€½Á•¹I•½É‘Q…ˆ¡É•½É‘]½É­%°€µ•…ÍÕÉ•µ•¹Ğœ¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€ñ¥±•Q•áĞ±…ÍÍ9…µ”ô‰Í¥é”´ĞÑ•áĞµÁÉ¥µ…Éäˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€€€€€€€5•…ÍÕÉ•µ•¹ÑÌ(€€€€€€€€€€€€€€ğ½‰ÕÑÑ½¸ø(€€€€€€€€€€€€ğ¼ø(€€€€€€€€€€¤€è€ (€€€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Áà´ÈÁˆ´ÈÑ•áĞµáÌÑ•áĞµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€€€€€€€í…¹I•½É‘Ù¥‘•¹”(€€€€€€€€€€€€€€€€ü€¡½½Í”„]½É¬‰•™½É”É•½É‘¥¹œÍ¥Ñ”•Ù¥‘•¹”¸œ(€€€€€€€€€€€€€€€€è€e½ÕÈ…•ÍÌ¥ÌÉ•…µ½¹±äì¡½½Í”„]½É¬Ñ¼Ù¥•Ü¥ÑÌÉ•½É‘Ì¸ô(€€€€€€€€€€€€ğ½Àø(€€€€€€€€€€¥ô(€€€€€€€€€€ñ‰ÕÑÑ½¸(€€€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ(€€€€€€€€€€€±…ÍÍ9…µ”ô‰™±•àÜµ™Õ±°¥Ñ•µÌµ•¹Ñ•È…À´ÌÉ½Õ¹‘•µá°Áà´ÌÁä´È¸ÔÑ•áĞµ±•™ĞÑ•áĞµÍ´¡½Ù•Èé‰œµµÕÑ•ˆ(€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€¹…Ù¥…Ñ”¡ì¹…µ”è€İ½É­Ìœô¤ì(€€€€€€€€€€€õô(€€€€€€€€€€ø(€€€€€€€€€€€€ñM•…É ±…ÍÍ9…µ”ô‰Í¥é”´ĞÑ•áĞµÁÉ¥µ…Éäˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€€€=Á•¸]½É­Ì(€€€€€€€€€€ğ½‰ÕÑÑ½¸ø(€€€€€€€€ğ½‘¥Øø(€€€€€€¥ô((€€€€€íµ½‰¥±•5½É•=Á•¸€˜˜€ (€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™¥á•¥¹Í•Ğµà´Ì‰½ÑÑ½´´ÈÀè´ÔÀÉ½Õ¹‘•´Éá°‰½É‘•È‰½É‘•Èµ‰½É‘•È‰œµ…ÉÀ´ÈÍ¡…‘½Ü´Éá°±œé¡¥‘‘•¸ÁÉ¥¹Ğé¡¥‘‘•¸ˆø(€€€€€€€€€í5=	%1}5=I}%Q5L¹µ…À ¡¥Ñ•´¤€ôøì(€€€€€€€€€€€½¹ÍĞ%½¸€ô¥Ñ•´¹¥½¸ì(€€€€€€€€€€€É•ÑÕÉ¸€ (€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸(€€€€€€€€€€€€€€€­•äõí¥Ñ•´¹­•åô(€€€€€€€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ(€€€€€€€€€€€€€€€±…ÍÍ9…µ”ô‰™±•àÜµ™Õ±°¥Ñ•µÌµ•¹Ñ•È…À´ÌÉ½Õ¹‘•µá°Áà´ÌÁä´È¸ÔÑ•áĞµ±•™ĞÑ•áĞµÍ´¡½Ù•Èé‰œµµÕÑ•ˆ(€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€½Á•¹5½‘Õ±”¡¥Ñ•´¹­•ä¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€ñ%½¸±…ÍÍ9…µ”ô‰Í¥é”´ĞÑ•áĞµÁÉ¥µ…Éäˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€€€€€€€í¥Ñ•´¹±…‰•±ô(€€€€€€€€€€€€€€€í¥Ñ•´¹­•ä€ôôô€…ÁÁÉ½Ù…±Ìœ€˜˜Á•¹‘¥¹ÁÁÉ½Ù…±Ì€ø€À€˜˜€ (€€€€€€€€€€€€€€€€€€ñ	…‘”±…ÍÍ9…µ”ô‰µ°µ…ÕÑ¼ˆÙ…É¥…¹Ğô‰‘•ÍÑÉÕÑ¥Ù”ˆø(€€€€€€€€€€€€€€€€€€€íÁ•¹‘¥¹ÁÁÉ½Ù…±Íô(€€€€€€€€€€€€€€€€€€ğ½	…‘”ø(€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€ğ½‰ÕÑÑ½¸ø(€€€€€€€€€€€€¤ì(€€€€€€€€€ô¥ô(€€€€€€€€€€ñ‰ÕÑÑ½¸(€€€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ(€€€€€€€€€€€±…ÍÍ9…µ”ô‰™±•àÜµ™Õ±°¥Ñ•µÌµ•¹Ñ•È…À´ÌÉ½Õ¹‘•µá°Áà´ÌÁä´È¸ÔÑ•áĞµ±•™ĞÑ•áĞµÍ´Ñ•áĞµ‘•ÍÑÉÕÑ¥Ù”¡½Ù•Èé‰œµ‘•ÍÑÉÕÑ¥Ù”¼Ôˆ(€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€É•ÅÕ•ÍÑ•Á…ÉÑÕÉ”¡½¹M¥¹=ÕĞ¤ì(€€€€€€€€€€€õô(€€€€€€€€€€ø(€€€€€€€€€€€€ñ1½=ÕĞ±…ÍÍ9…µ”ô‰Í¥é”´Ğˆ…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€€€€€€€€M¥¸½ÕĞ(€€€€€€€€€€ğ½‰ÕÑÑ½¸ø(€€€€€€€€ğ½‘¥Øø(€€€€€€¥ô((€€€€€íÁ•¹‘¥¹•Á…ÉÑÕÉ”€„ôô¹Õ±°€˜˜€ (€€€€€€€€ñ‘¥Ø(€€€€€€€€€±…ÍÍ9…µ”ô‰™¥á•¥¹Í•Ğ´ÀèµlØÁtÉ¥Á±…”µ¥Ñ•µÌµ•¹Ñ•ÈÀ´ĞÁÉ¥¹Ğé¡¥‘‘•¸ˆ(€€€€€€€€€½¹-•å½İ¸õí¡…¹‘±••Á…ÉÑÕÉ•-•å½İ¹ô(€€€€€€€€ø(€€€€€€€€€€ñ‘¥Ø(€€€€€€€€€€€±…ÍÍ9…µ”ô‰…‰Í½±ÕÑ”¥¹Í•Ğ´À‰œµ™½É•É½Õ¹¼ÌÀ‰…­‘É½Àµ‰±ÕÈµÍ´ˆ(€€€€€€€€€€€…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ(€€€€€€€€€€€½¹±¥¬õí­••Á‘¥Ñ¥¹ô(€€€€€€€€€€¼ø(€€€€€€€€€€ñÍ•Ñ¥½¸(€€€€€€€€€€€±…ÍÍ9…µ”ô‰É•±…Ñ¥Ù”Üµ™Õ±°µ…àµÜµµÉ½Õ¹‘•´Éá°‰½É‘•È‰½É‘•Èµ‰½É‘•È‰œµ…ÉÀ´ØÍ¡…‘½Ü´Éá°ˆ(€€€€€€€€€€€É½±”ô‰‘¥…±½œˆ(€€€€€€€€€€€…É¥„µµ½‘…°ô‰ÑÉÕ”ˆ(€€€€€€€€€€€…É¥„µ±…‰•±±•‘‰äô‰Õ¹Í…Ù•µ‘É…™ĞµÑ¥Ñ±”ˆ(€€€€€€€€€€€…É¥„µ‘•ÍÉ¥‰•‘‰äô‰Õ¹Í…Ù•µ‘É…™Ğµ‘•ÍÉ¥ÁÑ¥½¸ˆ(€€€€€€€€€€ø(€€€€€€€€€€€€ñ È¥ô‰Õ¹Í…Ù•µ‘É…™ĞµÑ¥Ñ±”ˆ±…ÍÍ9…µ”ô‰µĞ´Àˆø(€€€€€€€€€€€€€U¹Í…Ù•‘É…™Ğ¡…¹•Ì(€€€€€€€€€€€€ğ½ Èø(€€€€€€€€€€€€ñÀ¥ô‰Õ¹Í…Ù•µ‘É…™Ğµ‘•ÍÉ¥ÁÑ¥½¸ˆ±…ÍÍ9…µ”ô‰Ñ•áĞµÍ´Ñ•áĞµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€€€€€€€1•…Ù¥¹œÑ¡¥Ì•‘¥Ñ½Èİ¥±°‘¥Í…ÉÑ¡”¡…¹•Ìå½Ô¡…Ù”¹½ĞÍ…Ù•¸(€€€€€€€€€€€€ğ½Àø(€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰µĞ´Ô™±•à™±•àµİÉ…À©ÕÍÑ¥™äµ•¹…À´Èˆø(€€€€€€€€€€€€€€ñ	ÕÑÑ½¸É•˜õí­••Á‘¥Ñ¥¹I•™ôÙ…É¥…¹Ğô‰½ÕÑ±¥¹”ˆ½¹±¥¬õí­••Á‘¥Ñ¥¹ôø(€€€€€€€€€€€€€€€-••À•‘¥Ñ¥¹œ(€€€€€€€€€€€€€€ğ½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€É•˜õí‘¥Í…É‘¹‘1•…Ù•I•™ô(€€€€€€€€€€€€€€€Ù…É¥…¹Ğô‰‘•ÍÑÉÕÑ¥Ù”ˆ(€€€€€€€€€€€€€€€½¹±¥¬õí‘¥Í…É‘¹‘1•…Ù•ô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€¥Í…É…¹±•…Ù”(€€€€€€€€€€€€€€ğ½	ÕÑÑ½¸ø(€€€€€€€€€€€€ğ½‘¥Øø(€€€€€€€€€€ğ½Í•Ñ¥½¸ø(€€€€€€€€ğ½‘¥Øø(€€€€€€¥ô(€€€€ğ½‘¥Øø(€€¤ì)ô