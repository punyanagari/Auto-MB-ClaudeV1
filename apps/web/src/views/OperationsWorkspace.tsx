import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
    setQuickActionsOpen(false);
  }, [view]);

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
          setView({ name: 'works' });
        },
        current: view.name === 'works',
      },
      ...(canModify
        ? [
            {
              label: 'Upload LOA',
              open: () => {
                setView({ name: 'upload' });
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
        setView({ name: 'masters' });
      },
      current: view.name === 'masters' && mastersTab === category.key,
    })),
  };

  function openModule(key: ModuleKey): void {
    setView(defaultViewOf(key));
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
                const Icon = item.icon;
                const current = activeModule === item.key;
                const children = subItems[item.key] ?? [];
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
                      <ul className="my-1 ml-6 flex list-none flex-col gap-0.5 border-l border-border pl-3">
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
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-border bg-card lg:flex print:hidden">
        <div className="flex h-[4.5rem] items-center gap-3 border-b border-border px-5">
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Building2 className="size-5" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <strong className="block text-base tracking-tight">Auto-MB</strong>
            <span className="block truncate text-[11px] text-muted-foreground">
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
            <p className="text-[10px] font-semibold tracking-[0.14em] text-primary uppercase">
              Quick actions
            </p>
            <div className="mt-2 flex flex-col gap-1">
              {canModify && (
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-foreground hover:bg-card"
                  onClick={() => {
                    setView({ name: 'upload' });
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
                  setView({ name: 'works' });
                }}
              >
                <Search className="size-3.5 text-primary" aria-hidden="true" />
                Find a Work
              </button>
              <button
                type="button"
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-foreground hover:bg-card"
                onClick={() => {
                  setView({ name: 'approvals' });
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
              onClick={onSwitchOrganisation}
            >
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 font-semibold text-primary">
                {organisation.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-xs">{organisation.name}</strong>
                <span className="block truncate text-[11px] text-muted-foreground">
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
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 font-semibold text-primary">
                {organisation.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-xs">{organisation.name}</strong>
                <span className="block truncate text-[11px] text-muted-foreground">
                  Current organisation
                </span>
              </span>
            </div>
          )}
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-[4.5rem] items-center gap-3 border-b border-border bg-card/95 px-4 backdrop-blur lg:px-7 print:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Open navigation"
            aria-expanded={mobileMenuOpen}
            onClick={() => {
              setMobileMenuOpen(true);
            }}
          >
            <Menu aria-hidden="true" />
          </Button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] text-muted-foreground">
              {organisation.name}
            </p>
            <p className="truncate text-sm font-semibold">{pageTitleOf(view)}</p>
          </div>

          <button
            type="button"
            className="hidden min-w-56 max-w-md flex-1 items-center gap-2 rounded-xl border border-input bg-background px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary/35 hover:bg-card md:flex"
            onClick={() => {
              setView({ name: 'works' });
            }}
          >
            <Search className="size-4" aria-hidden="true" />
            Search Works and records
            <kbd className="ml-auto rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]">
              /
            </kbd>
          </button>

          <div className="relative">
            <Button
              size="sm"
              aria-expanded={quickActionsOpen}
              onClick={() => {
                setQuickActionsOpen((current) => !current);
              }}
            >
              <Plus aria-hidden="true" />
              <span className="hidden sm:inline">Quick action</span>
              <ChevronDown className="hidden size-3.5 sm:block" aria-hidden="true" />
            </Button>
            {quickActionsOpen && (
              <div className="absolute top-[calc(100%+0.5rem)] right-0 z-40 w-64 rounded-2xl border border-border bg-card p-2 shadow-xl">
                {canModify && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setView({ name: 'upload' });
                    }}
                  >
                    <Upload className="size-4 text-primary" aria-hidden="true" />
                    <span>
                      <strong className="block text-xs">Upload LOA</strong>
                      <span className="text-[11px] text-muted-foreground">
                        Start a new awarded Work
                      </span>
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setView({ name: 'works' });
                  }}
                >
                  <BriefcaseBusiness
                    className="size-4 text-primary"
                    aria-hidden="true"
                  />
                  <span>
                    <strong className="block text-xs">Open Works</strong>
                    <span className="text-[11px] text-muted-foreground">
                      Find a contract or document
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setView({ name: 'approvals' });
                  }}
                >
                  <CheckCircle className="size-4 text-primary" aria-hidden="true" />
                  <span>
                    <strong className="block text-xs">Approval queue</strong>
                    <span className="text-[11px] text-muted-foreground">
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
              setView({ name: 'approvals' });
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
            <span className="inline-flex size-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {me.user.email.slice(0, 1).toUpperCase()}
            </span>
            <span className="max-w-48 truncate text-xs text-muted-foreground">
              {me.user.email}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              onClick={onSignOut}
            >
              <LogOut aria-hidden="true" />
            </Button>
          </div>
        </header>

        <main
          ref={containerRef}
          className="mx-auto flex w-full max-w-[100rem] flex-col gap-5 px-4 py-5 pb-24 sm:px-6 lg:px-8 lg:py-7 lg:pb-10"
        >
          {view.name === 'dashboard' && (
            <OperationsDashboard
              api={api}
              organisationId={organisation.id}
              canModify={canModify}
              onOpenWork={(workId) => {
                setView({ name: 'work', workId });
              }}
              onOpenWorks={() => {
                setView({ name: 'works' });
              }}
              onUploadLoa={() => {
                setView({ name: 'upload' });
              }}
              onOpenApprovals={() => {
                setView({ name: 'approvals' });
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
                setView({ name: 'upload' });
              }}
              onReview={(documentId) => {
                setView({ name: 'review', documentId });
              }}
              onOpenWork={(workId) => {
                setView({ name: 'work', workId });
              }}
            />
          )}

          {view.name === 'upload' && (
            <UploadLoa
              api={api}
              organisationId={organisation.id}
              onUploaded={(document) => {
                setView(
                  document.extractionStatus === 'review'
                    ? { name: 'review', documentId: document.id }
                    : { name: 'works' },
                );
              }}
              onCancel={() => {
                setView({ name: 'works' });
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
                setView({ name: 'work', workId: created.work.id });
              }}
              onBack={() => {
                setView({ name: 'works' });
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
              isOwner={isOwner}
              onNewChallan={(workId, workCode) => {
                setView({ name: 'challan-new', workId, workCode });
              }}
              onOpenChallan={(challanId) => {
                setView({
                  name: 'challan',
                  workId: view.workId,
                  workCode: '',
                  challanId,
                });
              }}
              onNewIssueChallan={(workId) => {
                setView({ name: 'issue-challan-new', workId });
              }}
              onOpenIssueChallan={(challanId) => {
                setView({ name: 'issue-challan', workId: view.workId, challanId });
              }}
              onBack={() => {
                setView({ name: 'works' });
              }}
              tab={view.workId === tabbedWorkId ? workTab : 'overview'}
              onTabChange={(next) => {
                setTabbedWorkId(view.workId);
                setWorkTab(next);
              }}
            />
          )}

          {(view.name === 'challan-new' || view.name === 'challan-edit') && (
            <div className="flex flex-col gap-4">
              <div className="rounded-2xl border border-primary/15 bg-primary/[0.035] p-4">
                <p className="text-xs font-semibold text-primary">
                  Delivery Challan workflow
                </p>
                <ol className="mt-3 grid list-none gap-2 p-0 text-xs sm:grid-cols-3">
                  <li className="rounded-xl bg-card px-3 py-2 font-medium shadow-sm">
                    1. Work &amp; consignee
                  </li>
                  <li className="rounded-xl bg-card px-3 py-2 font-medium shadow-sm">
                    2. Items &amp; PO links
                  </li>
                  <li className="rounded-xl bg-card px-3 py-2 font-medium shadow-sm">
                    3. Review &amp; save draft
                  </li>
                </ol>
              </div>
              <ChallanEditor
                api={api}
                organisationId={organisation.id}
                workId={view.workId}
                workCode={view.workCode}
                challanId={view.name === 'challan-edit' ? view.challanId : null}
                onSaved={(challanId) => {
                  setView({
                    name: 'challan',
                    workId: view.workId,
                    workCode: view.workCode,
                    challanId,
                  });
                }}
                onCancel={() => {
                  setView({ name: 'work', workId: view.workId });
                }}
              />
            </div>
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
                setView({
                  name: 'challan-edit',
                  workId: view.workId,
                  workCode: view.workCode,
                  challanId,
                });
              }}
              onDeleted={() => {
                setView({ name: 'work', workId: view.workId });
              }}
              onBack={() => {
                setView({ name: 'work', workId: view.workId });
              }}
            />
          )}

          {view.name === 'masters' && (
            <Masters
              api={api}
              organisationId={organisation.id}
              canModify={canModify}
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
                setView({ name: 'issue-challan', workId: view.workId, challanId });
              }}
              onCancel={() => {
                setView({ name: 'work', workId: view.workId });
              }}
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
                setView({
                  name: 'issue-challan-edit',
                  workId: view.workId,
                  challanId,
                });
              }}
              onDeleted={() => {
                setView({ name: 'work', workId: view.workId });
              }}
              onBack={() => {
                setView({ name: 'work', workId: view.workId });
              }}
            />
          )}

          {view.name === 'serials' && (
            <SerialLookup
              api={api}
              organisationId={organisation.id}
              onOpenWork={(workId) => {
                setView({ name: 'work', workId });
              }}
              onOpenChallan={(workId, challanId) => {
                setView({ name: 'challan', workId, workCode: '', challanId });
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
        </main>
      </div>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden print:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-foreground/25 backdrop-blur-sm"
            aria-label="Close navigation"
            onClick={() => {
              setMobileMenuOpen(false);
            }}
          />
          <div
            className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] flex-col border-r border-border bg-card shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Application navigation"
          >
            <div className="flex h-[4.5rem] items-center gap-3 border-b border-border px-4">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Building2 className="size-5" aria-hidden="true" />
              </span>
              <strong className="flex-1">Auto-MB</strong>
              <Button
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
              {renderNavigation(true)}
            </nav>
            <div className="border-t border-border p-3">
              {canSwitchOrganisation && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={onSwitchOrganisation}
                >
                  <ArrowLeftRight aria-hidden="true" />
                  Switch organisation
                </Button>
              )}
              <Button variant="ghost" className="mt-1 w-full" onClick={onSignOut}>
                <LogOut aria-hidden="true" />
                Sign out
              </Button>
            </div>
          </div>
        </div>
      )}

      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-border bg-card/95 px-2 py-1.5 backdrop-blur lg:hidden print:hidden"
        aria-label="Mobile navigation"
      >
        <button
          type="button"
          className={`flex flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-[10px] font-medium ${
            activeModule === 'dashboard' ? 'text-primary' : 'text-muted-foreground'
          }`}
          onClick={() => {
            setView({ name: 'dashboard' });
          }}
        >
          <LayoutDashboard className="size-5" aria-hidden="true" />
          Home
        </button>
        <button
          type="button"
          className={`flex flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-[10px] font-medium ${
            activeModule === 'works' ? 'text-primary' : 'text-muted-foreground'
          }`}
          onClick={() => {
            setView({ name: 'works' });
          }}
        >
          <BriefcaseBusiness className="size-5" aria-hidden="true" />
          Works
        </button>
        <button
          type="button"
          className="flex flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-[10px] font-medium text-primary"
          aria-expanded={quickActionsOpen}
          onClick={() => {
            setQuickActionsOpen((current) => !current);
          }}
        >
          <span className="-mt-5 inline-flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg ring-4 ring-background">
            <Plus className="size-5" aria-hidden="true" />
          </span>
          Record
        </button>
        <button
          type="button"
          className="flex flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-[10px] font-medium text-muted-foreground"
          aria-expanded={mobileMoreOpen}
          onClick={() => {
            setMobileMoreOpen((current) => !current);
          }}
        >
          <MoreHorizontal className="size-5" aria-hidden="true" />
          More
        </button>
      </nav>

      {mobileMoreOpen && (
        <div className="fixed inset-x-3 bottom-20 z-50 rounded-2xl border border-border bg-card p-2 shadow-2xl lg:hidden print:hidden">
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
            onClick={onSignOut}
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
