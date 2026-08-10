import { useCallback, useEffect, useRef, useState } from 'react';
import type { Organisation, Work } from '@auto-mb/contracts';
import type { ApiClient, MeResponse } from '../api.js';
import { Approvals } from './Approvals.js';
import { ChallanDetail } from './ChallanDetail.js';
import { ChallanEditor } from './ChallanEditor.js';
import { IssueChallanDetail } from './IssueChallanDetail.js';
import { IssueChallanEditor } from './IssueChallanEditor.js';
import { Dashboard } from './Dashboard.js';
import { Masters, type MastersTab } from './Masters.js';
import { Members } from './Members.js';
import { Settings } from './Settings.js';
import { ReviewLoa } from './ReviewLoa.js';
import { SerialLookup } from './SerialLookup.js';
import { UploadLoa } from './UploadLoa.js';
import { WorkDetail, type WorkTab } from './WorkDetail.js';
import { Works } from './Works.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';

interface WorkspaceProps {
  readonly api: ApiClient;
  readonly me: MeResponse;
  readonly organisation: Organisation;
  readonly onSwitchOrganisation: () => void;
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
  | { name: 'approvals' }
  | { name: 'serials' }
  | { name: 'members' }
  | { name: 'settings' };

const MODULES = [
  {
    key: 'dashboard' as const,
    label: 'Dashboard',
    icon: (
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M2 9.5 8 3l6 6.5" />
        <path d="M4 8v6h8V8" />
      </svg>
    ),
  },
  {
    key: 'works' as const,
    label: 'Works',
    icon: (
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <rect x="2" y="2" width="5" height="5" rx="1" />
        <rect x="9" y="2" width="5" height="5" rx="1" />
        <rect x="2" y="9" width="5" height="5" rx="1" />
        <rect x="9" y="9" width="5" height="5" rx="1" />
      </svg>
    ),
  },
  {
    key: 'approvals' as const,
    label: 'Approvals',
    icon: (
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M2.5 8.5 6 12l7.5-8" />
      </svg>
    ),
  },
  {
    key: 'serials' as const,
    label: 'Serial Lookup',
    icon: (
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <circle cx="7" cy="7" r="4.2" />
        <path d="m10.2 10.2 3.6 3.6" />
      </svg>
    ),
  },
  {
    key: 'masters' as const,
    label: 'Masters',
    icon: (
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M2.5 4.5 8 2l5.5 2.5L8 7 2.5 4.5Z" />
        <path d="M2.5 8 8 10.5 13.5 8" />
        <path d="M2.5 11.5 8 14l5.5-2.5" />
      </svg>
    ),
  },
  {
    key: 'members' as const,
    label: 'Members',
    icon: (
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <circle cx="5.5" cy="5" r="2.5" />
        <path d="M1.5 14c0-2.2 1.8-4 4-4s4 1.8 4 4" />
        <circle cx="11.5" cy="5.5" r="2" />
        <path d="M11 10.2c2 .2 3.5 1.8 3.5 3.8" />
      </svg>
    ),
  },
  {
    key: 'settings' as const,
    label: 'Settings',
    icon: (
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <circle cx="8" cy="8" r="2.4" />
        <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" />
      </svg>
    ),
  },
];

const MASTERS_CATEGORIES: readonly { key: MastersTab; label: string }[] = [
  { key: 'contacts', label: 'Contacts' },
  { key: 'locations', label: 'Locations' },
  { key: 'units', label: 'Units' },
  { key: 'signatories', label: 'Signatories' },
];

const ITEM =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium text-[oklch(0.82_0.02_260_/_80%)] transition-colors [&_svg]:shrink-0 hover:bg-[oklch(0.31_0.04_265_/_60%)] hover:text-white aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-white';

const SUB_ITEM =
  'flex w-full cursor-pointer items-center rounded-md px-2.5 py-1.5 text-left text-[13px] text-[oklch(0.82_0.02_260_/_65%)] transition-colors hover:text-white aria-[current=page]:font-semibold aria-[current=page]:text-sidebar-primary';

/** Where a module lands when its own row is clicked. */
function defaultViewOf(key: (typeof MODULES)[number]['key']): WorkspaceView {
  switch (key) {
    case 'dashboard':
      return { name: 'dashboard' };
    case 'works':
      return { name: 'works' };
    case 'masters':
      return { name: 'masters' };
    case 'approvals':
      return { name: 'approvals' };
    case 'serials':
      return { name: 'serials' };
    case 'members':
      return { name: 'members' };
    default:
      return { name: 'settings' };
  }
}

export function Workspace({
  api,
  me,
  organisation,
  onSwitchOrganisation,
  onSignOut,
}: WorkspaceProps) {
  const [view, setView] = useState<WorkspaceView>({ name: 'dashboard' });
  const [pendingApprovals, setPendingApprovals] = useState(0);
  // Held here, not in WorkDetail: opening a challan unmounts the Work page,
  // and an operator who came from Deliveries should land back on Deliveries.
  const [workTab, setWorkTab] = useState<WorkTab>('overview');
  const [tabbedWorkId, setTabbedWorkId] = useState<string | null>(null);
  // Lifted for the same reason the Work tab is: the sidebar opens a Masters
  // category directly, so the category cannot live inside the page.
  const [mastersTab, setMastersTab] = useState<MastersTab>('contacts');
  // R8: the challan detail views close their cancel and correction forms
  // on a completed Work, the way every create surface on the Work page
  // does. Neither view loads the Work — they are reachable from the Work
  // page and from Serial Lookup — so the workspace resolves the status
  // once per opened document and hands it down.
  const [challanWork, setChallanWork] = useState<{
    readonly workId: string;
    readonly status: Work['status'];
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const membership = me.memberships.find(
    (candidate) =>
      candidate.organisationId === organisation.id && candidate.status === 'active',
  );
  // Owner/office members may upload, confirm, and draft; site/viewer read.
  const canModify = membership?.role === 'owner' || membership?.role === 'office';
  // Site engineers record delivery evidence (receipts, serials,
  // installations, measurements) but cannot draft or issue.
  const canRecordEvidence = canModify || membership?.role === 'site';
  // Issue, cancel, and amendment approval are explicit per-member
  // authorities, not roles.
  const canIssue = membership?.canIssueDocuments ?? false;
  const canCancel = membership?.canCancelDocuments ?? false;
  const canApprove = membership?.canApproveAmendments ?? false;
  const isOwner = membership?.role === 'owner';

  // The nav badge: how many amendment requests await a decision. Refreshed
  // on navigation and whenever an approval decision lands.
  const refreshPendingApprovals = useCallback(() => {
    api
      .listApprovals(organisation.id, 'pending')
      .then((approvals) => {
        setPendingApprovals(approvals.length);
      })
      .catch(() => {
        // A failed count never blocks the workspace; the queue page
        // reports its own errors.
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
        if (cancelled) return;
        setChallanWork({ workId: openedChallanWorkId, status: loaded.work.status });
      })
      .catch(() => {
        // A failed status read never blocks the document: the detail view
        // reports its own load errors, and the server refuses a cancel or
        // a correction on a completed Work regardless.
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisation.id, openedChallanWorkId]);

  // Unknown — still loading, or a failed read — stays permissive: a form
  // must not vanish because a side request was slow.
  const challanWorkActive =
    challanWork === null ||
    challanWork.workId !== openedChallanWorkId ||
    challanWork.status === 'active';

  // Same convention as the app shell: view changes land keyboard and
  // screen-reader users on the new heading.
  useEffect(() => {
    containerRef.current?.querySelector('h1')?.focus();
  }, [view]);

  /** The parts of a module worth naming in the rail. Only two modules have
   * any: Masters is four separate registers behind one word, and Works hides
   * the LOA upload that starts everything. The other five are one screen
   * each, and inventing children for them would make the rail longer without
   * making it clearer. */
  const SUB_ITEMS: Partial<
    Record<
      (typeof MODULES)[number]['key'],
      readonly {
        readonly label: string;
        readonly open: () => void;
        readonly isCurrent: (current: WorkspaceView) => boolean;
      }[]
    >
  > = {
    works: [
      {
        label: 'All Works',
        open: () => {
          setView({ name: 'works' });
        },
        isCurrent: (current) => current.name === 'works',
      },
      ...(canModify
        ? [
            {
              label: 'Upload LOA',
              open: () => {
                setView({ name: 'upload' });
              },
              isCurrent: (current: WorkspaceView) => current.name === 'upload',
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
      isCurrent: (current: WorkspaceView) =>
        current.name === 'masters' && mastersTab === category.key,
    })),
  };

  const activeModule =
    view.name === 'dashboard' ||
    view.name === 'masters' ||
    view.name === 'approvals' ||
    view.name === 'serials' ||
    view.name === 'members' ||
    view.name === 'settings'
      ? view.name
      : 'works';

  return (
    <div className="flex min-h-screen max-[800px]:flex-col">
      <nav
        className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground max-[800px]:static max-[800px]:h-auto max-[800px]:w-full print:hidden"
        aria-label="Modules"
      >
        <span className="flex h-16 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4 text-base">
          {/* The rail is graphite and so is --primary, which left this mark
              painting itself the same colour as the wall behind it. Amber is
              what the rail uses to mark a destination, and the sidebar token
              pair already carries it: lamp fill, graphite ink. */}
          <span
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground"
            aria-hidden="true"
          >
            MB
          </span>
          Auto-MB
        </span>
        <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-4 [scrollbar-color:var(--sidebar-border)_transparent] [scrollbar-width:thin] max-[800px]:flex-row max-[800px]:flex-wrap max-[800px]:items-center">
          {MODULES.map((module) => {
            const children = SUB_ITEMS[module.key] ?? [];
            const current = activeModule === module.key;
            return (
              <div key={module.key} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  className={ITEM}
                  aria-current={current ? 'page' : undefined}
                  aria-expanded={children.length > 0 ? current : undefined}
                  onClick={() => {
                    setView(defaultViewOf(module.key));
                  }}
                >
                  {module.icon}
                  {module.label}
                  {module.key === 'approvals' && pendingApprovals > 0 && (
                    <Badge
                      variant="neutral"
                      aria-label={`${String(pendingApprovals)} pending approvals`}
                    >
                      {pendingApprovals}
                    </Badge>
                  )}
                </button>
                {/* Only where a module genuinely has parts. A twisty on every
                    row, five of them empty, would say the sidebar is deeper
                    than it is. Open only while the module is the one on
                    screen, so the rail never shows two module's insides at
                    once. */}
                {current && children.length > 0 && (
                  <ul className="m-0 flex list-none flex-col gap-0.5 border-l border-sidebar-border py-0.5 pr-0 pl-3 ml-4">
                    {children.map((child) => (
                      <li key={child.label}>
                        <button
                          type="button"
                          className={SUB_ITEM}
                          aria-current={child.isCurrent(view) ? 'page' : undefined}
                          onClick={() => {
                            child.open();
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
        <span className="flex flex-col gap-0.5 border-t border-sidebar-border p-3">
          {organisation.name}
        </span>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-3 print:hidden">
          <div className="flex min-w-0 items-center gap-3">
            <span className="font-semibold">{organisation.name}</span>
            <Button variant="outline" onClick={onSwitchOrganisation}>
              Switch organisation
            </Button>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <span className="text-muted-foreground">{me.user.email}</span>
            <Button variant="outline" onClick={onSignOut}>
              Sign out
            </Button>
          </div>
        </header>

        <main
          className="mx-auto flex w-full max-w-[100rem] flex-col gap-4 px-8 py-6 [scroll-padding-top:3rem] max-[800px]:p-4"
          ref={containerRef}
        >
          {view.name === 'dashboard' && (
            <Dashboard
              api={api}
              organisationId={organisation.id}
              onOpenWork={(workId) => {
                setView({ name: 'work', workId });
              }}
            />
          )}
          {view.name === 'settings' && (
            <Settings
              api={api}
              organisationId={organisation.id}
              isOwner={membership?.role === 'owner'}
            />
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
                // A different Work starts on its own Overview rather than
                // inheriting wherever the last one was left.
                setTabbedWorkId(view.workId);
                setWorkTab(next);
              }}
            />
          )}
          {(view.name === 'challan-new' || view.name === 'challan-edit') && (
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
    </div>
  );
}
