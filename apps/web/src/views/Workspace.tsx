import { useEffect, useRef, useState } from 'react';
import type { Organisation } from '@auto-mb/contracts';
import type { ApiClient, MeResponse } from '../api.js';
import { ChallanDetail } from './ChallanDetail.js';
import { ChallanEditor } from './ChallanEditor.js';
import { Dashboard } from './Dashboard.js';
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
  const containerRef = useRef<HTMLDivElement>(null);

  const membership = me.memberships.find(
    (candidate) =>
      candidate.organisationId === organisation.id && candidate.status === 'active',
  );
  // Owner/office members may upload, confirm, and draft; site/viewer read.
  const canModify = membership?.role === 'owner' || membership?.role === 'office';
  // Issue and cancel are explicit per-member authorities, not roles.
  const canIssue = membership?.canIssueDocuments ?? false;
  const canCancel = membership?.canCancelDocuments ?? false;

  // Same convention as the app shell: view changes land keyboard and
  // screen-reader users on the new heading.
  useEffect(() => {
    containerRef.current?.querySelector('h1')?.focus();
  }, [view]);

  const activeModule =
    view.name === 'dashboard' || view.name === 'members' || view.name === 'settings'
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
                      : key === 'members'
                        ? { name: 'members' }
                        : { name: 'settings' },
                );
              }}
            >
              {module.icon}
              {module.label}
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
          {view.name === 'work' && (
            <WorkDetail
              api={api}
              organisationId={organisation.id}
              workId={view.workId}
              canModify={canModify}
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
