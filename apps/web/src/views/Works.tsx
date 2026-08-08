import { useEffect, useState } from 'react';
import type { LoaDocument, Work } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatInr } from '../format.js';

interface WorksProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly canModify: boolean;
  readonly onUpload: () => void;
  readonly onReview: (documentId: string) => void;
  readonly onOpenWork: (workId: string) => void;
}

const STATUS_LABELS: Record<LoaDocument['extractionStatus'], string> = {
  pending: 'Pending',
  processing: 'Processing',
  review: 'Needs review',
  confirmed: 'Confirmed',
  failed: 'Failed',
};

const WORK_STATUS: Record<Work['status'], { label: string; chip: string }> = {
  active: { label: 'Active', chip: 'chip--active' },
  completed: { label: 'Completed', chip: 'chip--completed' },
  cancelled: { label: 'Cancelled', chip: 'chip--failed' },
};

export function Works({
  api,
  organisationId,
  canModify,
  onUpload,
  onReview,
  onOpenWork,
}: WorksProps) {
  const [works, setWorks] = useState<readonly Work[] | null>(null);
  const [documents, setDocuments] = useState<readonly LoaDocument[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setWorks(null);
    setDocuments(null);
    setLoadError(null);
    Promise.all([api.listWorks(organisationId), api.listLoaDocuments(organisationId)])
      .then(([loadedWorks, loadedDocuments]) => {
        if (cancelled) return;
        setWorks(loadedWorks);
        setDocuments(loadedDocuments);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The Works list could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  return (
    <>
      <section className="card" aria-labelledby="works-title">
        <div className="card__header">
          <h1 id="works-title" tabIndex={-1}>
            Works
          </h1>
          {canModify && (
            <button type="button" onClick={onUpload}>
              Upload LOA
            </button>
          )}
        </div>

        {loadError !== null && (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        )}

        {loadError === null && (works === null || documents === null) && (
          <p className="muted" role="status">
            Loading Works…
          </p>
        )}

        {works !== null && works.length > 0 && (
          <table className="data-table">
            <caption className="visually-hidden">
              Works with letter reference, contract value, and status
            </caption>
            <thead>
              <tr>
                <th scope="col">Work code</th>
                <th scope="col">Title</th>
                <th scope="col">Letter</th>
                <th scope="col" className="cell--numeric">
                  Contract value
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {works.map((work) => (
                <tr key={work.id}>
                  <th scope="row">
                    <button
                      type="button"
                      className="button--link"
                      onClick={() => {
                        onOpenWork(work.id);
                      }}
                    >
                      {work.workCode}
                    </button>
                  </th>
                  <td className="cell--wrap">{work.title}</td>
                  <td>
                    {work.letterNumber}
                    <span className="muted"> · {work.letterDate}</span>
                  </td>
                  <td className="cell--numeric">{formatInr(work.contractValue)}</td>
                  <td>
                    <span className={`chip ${WORK_STATUS[work.status].chip}`}>
                      {WORK_STATUS[work.status].label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {works !== null && works.length === 0 && (
          <p className="muted">
            No Works yet. Upload a Letter of Acceptance to create the first one.
          </p>
        )}
      </section>

      {documents !== null && documents.length > 0 && (
        <section className="card" aria-labelledby="loa-documents-title">
          <h2 id="loa-documents-title">LOA documents</h2>
          <table className="data-table">
            <caption className="visually-hidden">
              Uploaded Letter of Acceptance documents and their extraction status
            </caption>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Uploaded</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => (
                <tr key={document.id}>
                  <th scope="row">{document.originalFilename}</th>
                  <td>{document.createdAt.slice(0, 10)}</td>
                  <td>
                    <span className={`chip chip--${document.extractionStatus}`}>
                      {STATUS_LABELS[document.extractionStatus]}
                    </span>
                  </td>
                  <td>
                    {document.extractionStatus === 'review' && (
                      <button
                        type="button"
                        className="button--ghost"
                        onClick={() => {
                          onReview(document.id);
                        }}
                      >
                        Review
                      </button>
                    )}
                    {document.extractionStatus === 'confirmed' &&
                      document.confirmedWorkId !== null && (
                        <button
                          type="button"
                          className="button--ghost"
                          onClick={() => {
                            if (document.confirmedWorkId !== null) {
                              onOpenWork(document.confirmedWorkId);
                            }
                          }}
                        >
                          Open Work
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
