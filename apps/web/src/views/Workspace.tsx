import { useCallback, useEffect, useRef, useState } from 'react';
import type { Organisation } from '@auto-mb/contracts';
import type { ApiClient, MeResponse } from '../api.js';
import { Approvals } from './Approvals.js';
import { ChallanDetail } from './ChallanDetail.js';
import { ChallanEditor } from './ChallanEditor.js';
import { IssueChallanDetail } from './IssueChallanDetail.js';
import { IssueChallanEditor } from './IssueChallanEditor.js';
import { Dashboard } from './Dashboard.js';
import { Masters } from './Masters.js';
import { Members } from './Members.js';
import { Settings } from './Settings.js';
import { ReviewLoa } from './ReviewLoa.js';
import { UploadLoa } from './UploadLoa.js';
import { WorkDetail } from './WorkDetail.js';
import { Works } from './Works.js';

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

export function Workspace({
  api,
  me,
  organisation,
  onSwitchOrganisation,
  onSignOut,
}: WorkspaceProps) {
  const [view, setView] = useState<WorkspaceView>({ name: 'dashboard' });
  const [pendingApprovals, setPendingApprovals] = useState(0);
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

  // Same convention as the app shell: view changes land keyboard and
  // screen-reader users on the new heading.
  useEffect(() => {
    containerRef.current?.querySelector('h1')?.focus();
  }, [view]);

  const activeModule =
    view.name === 'dashboard' ||
    view.name === 'masters' ||
    view.name === 'approvals' ||
    view.name === 'members' ||
    view.name === 'settings'
      ? view.name
      : 'works';

  return (
    <div className="app-frame">
      <nav className="sidebar" aria-label="Modules">
        <span className="sidebar__brand">
          <span className="sidebar__brand-mark" aria-hidden="true">
            MB
          </span>
          Auto-MB
        </span>
        <div className="sidebar__nav">
          {MODULES.map((module) => (
            <button
              key={module.key}
              type="button"
              className="sidebar__item"
              aria-current={activeModule === module.key ? 'page' : undefined}
              onClick={() => {
                const key = module.key;
                setView(
                  key === 'dashboard'
                    ? { name: 'dashboard' }
                    : key === 'works'
                      ? { name: 'works' }
                      : key === 'masters'
                        ? { name: 'masters' }
                      : key === 'approvals'
                        ? { name: 'approvals' }
                        : key === 'members'
                          ? { name: 'members' }
                          : { name: 'settings' },
                );
              }}
            >
              {module.icon}
              {module.label}
              {module.key === 'approvals' && pendingApprovals > 0 && (
                <span
                  className="chip chip--draft"
                  aria-label={`${String(pendingApprovals)} pending approvals`}
                >
                  {pendingApprovals}
                </span>
              )}
            </button>
          ))}
        </div>
        <span className="sidebar__foot">{organisation.name}</span>
      </nav>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar__session">
            <span className="topbar__org">{organisation.name}</span>
            <button
              type="button"
              className="button--ghost"
              onClick={onSwitchOrganisation}
            >
              Switch organisation
            </button>
          </div>
          <div className="topbar__session">
            <span className="muted">{me.user.email}</span>
            <button type="button" className="button--ghost" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </header>

        <main className="content" ref={containerRef}>
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
            <Masters api={api} organisationId={organisation.id} canModify={canModify} />
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
