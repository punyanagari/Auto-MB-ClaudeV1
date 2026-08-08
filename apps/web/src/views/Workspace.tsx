import { useEffect, useRef, useState } from 'react';
import type { Organisation } from '@auto-mb/contracts';
import type { ApiClient, MeResponse } from '../api.js';
import { ChallanDetail } from './ChallanDetail.js';
import { ChallanEditor } from './ChallanEditor.js';
import { Members } from './Members.js';
import { ReviewLoa } from './ReviewLoa.js';
import { UploadLoa } from './UploadLoa.js';
import { WorkDetail } from './WorkDetail.js';
import { Works } from './Works.js';

interface WorkspaceProps {
  readonly api: ApiClient;
  readonly me: MeResponse;
  readonly organisation: Organisation;
}

type WorkspaceView =
  | { name: 'works' }
  | { name: 'upload' }
  | { name: 'review'; documentId: string }
  | { name: 'work'; workId: string }
  | { name: 'challan-new'; workId: string; workCode: string }
  | { name: 'challan-edit'; workId: string; workCode: string; challanId: string }
  | { name: 'challan'; workId: string; workCode: string; challanId: string }
  | { name: 'members' };

export function Workspace({ api, me, organisation }: WorkspaceProps) {
  const [view, setView] = useState<WorkspaceView>({ name: 'works' });
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

  const tab = view.name === 'members' ? 'members' : 'works';

  return (
    <div ref={containerRef}>
      <nav className="tabs" aria-label="Workspace sections">
        <button
          type="button"
          className="tab"
          aria-current={tab === 'works' ? 'page' : undefined}
          onClick={() => {
            setView({ name: 'works' });
          }}
        >
          Works
        </button>
        <button
          type="button"
          className="tab"
          aria-current={tab === 'members' ? 'page' : undefined}
          onClick={() => {
            setView({ name: 'members' });
          }}
        >
          Members
        </button>
      </nav>

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
    </div>
  );
}
