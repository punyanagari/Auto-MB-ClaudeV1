import { useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard,
  LayoutList,
  Users,
  Settings as SettingsIcon,
  LogOut,
  ArrowLeftRight,
} from 'lucide-react';
import type { Organisation } from '@auto-mb/contracts';
import type { ApiClient, MeResponse } from '../api.js';
import { initials } from '../format.js';
import { cn } from '../lib/cn.js';
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
  { key: 'dashboard' as const, label: 'Dashboard', icon: LayoutDashboard },
  { key: 'works' as const, label: 'Works', icon: LayoutList },
  { key: 'members' as const, label: 'Members', icon: Users },
  { key: 'settings' as const, label: 'Settings', icon: SettingsIcon },
];

/** The study's rail monogram: two rails, sleepers, a signal dot. */
function BrandMark() {
  return (
    <span
      className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-5">
        <path
          d="M7 21 10 5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M17 21 14 5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M6.4 17.5H17.6M7 13H17M7.6 8.5H16.4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          opacity="0.85"
        />
        <circle cx="12" cy="4" r="1.9" fill="currentColor" />
      </svg>
    </span>
  );
}

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
  // Site engineers record delivery evidence (receipts, serials,
  // installations, measurements) but cannot draft or issue.
  const canRecordEvidence = canModify || membership?.role === 'site';
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

  const membershipRole = membership?.role ?? 'member';

  return (
    <div className="flex min-h-dvh">
      <nav
        className="sticky top-0 flex h-dvh w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground"
        aria-label="Modules"
      >
        <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-4">
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <div className="leading-tight">
              <div className="font-semibold tracking-tight text-sidebar-accent-foreground">
                Auto<span className="text-[oklch(0.72_0.13_258)]">-MB</span>
              </div>
              <div className="max-w-40 truncate text-[10px] font-medium tracking-widest text-sidebar-faint uppercase">
                {organisation.name}
              </div>
            </div>
          </div>
        </div>

        <div className="scrollbar-thin flex-1 overflow-y-auto px-3 py-4">
          <p
            className="px-2 pb-2 text-[10px] font-semibold tracking-widest text-sidebar-faint uppercase"
            aria-hidden="true"
          >
            Navigation
          </p>
          <ul className="flex flex-col gap-0.5">
            {MODULES.map((module) => {
              const active = activeModule === module.key;
              const Icon = module.icon;
              return (
                <li key={module.key}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
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
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium transition-colors',
                      active
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="flex-1">{module.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
              aria-hidden="true"
            >
              {initials(me.user.email)}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium text-sidebar-accent-foreground">
                {me.user.email}
              </div>
              <div className="truncate text-xs text-sidebar-faint">
                {membershipRole}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onSwitchOrganisation}
            className="mt-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <ArrowLeftRight className="size-4" aria-hidden="true" />
            Switch organisation
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <main
          className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-6 py-6 lg:px-8"
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
          {view.name === 'work' && (
            <WorkDetail
              api={api}
              organisationId={organisation.id}
              workId={view.workId}
              canModify={canModify}
              canRecordEvidence={canRecordEvidence}
              canIssue={canIssue}
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
