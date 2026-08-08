import { useEffect, useRef, useState } from 'react';
import type { Organisation } from '@auto-mb/contracts';
import type { ApiClient, MeResponse } from '../api.js';
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
  | { name: 'members' };

export function Workspace({ api, me, organisation }: WorkspaceProps) {
  const [view, setView] = useState<WorkspaceView>({ name: 'works' });
  const containerRef = useRef<HTMLDivElement>(null);

  // Owner/office members may upload and confirm; site/viewer read.
  const canModify = me.memberships.some(
    (membership) =>
      membership.organisationId === organisation.id &&
      membership.status === 'active' &&
      (membership.role === 'owner' || membership.role === 'office'),
  );

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
          onBack={() => {
            setView({ name: 'works' });
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
