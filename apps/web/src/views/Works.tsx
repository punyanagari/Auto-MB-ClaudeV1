import { useEffect, useMemo, useState } from 'react';
import type { LoaDocument, Work } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatCompactInr, formatDate } from '../format.js';

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

type Filter = 'all' | Work['status'];

const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: 'all', label: 'All Works' },
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' },
];

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
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

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

  const counts = useMemo(
    () => ({
      all: works?.length ?? 0,
      active: works?.filter((work) => work.status === 'active').length ?? 0,
      completed: works?.filter((work) => work.status === 'completed').length ?? 0,
      cancelled: works?.filter((work) => work.status === 'cancelled').length ?? 0,
    }),
    [works],
  );

  const rows = useMemo(() => {
    let list = works ?? [];
    if (filter !== 'all') list = list.filter((work) => work.status === filter);
    const needle = query.trim().toLowerCase();
    if (needle.length > 0) {
      list = list.filter(
        (work) =>
          work.workCode.toLowerCase().includes(needle) ||
          work.title.toLowerCase().includes(needle) ||
          work.letterNumber.toLowerCase().includes(needle),
      );
    }
    return list;
  }, [works, filter, query]);

  return (
    <>
      <header className="page-header">
        <div>
          <p className="page-header__eyebrow">Works registry</p>
          <h1 id="works-title" tabIndex={-1}>
            Works
          </h1>
          <p className="page-header__desc">
            Every awarded contract, from LOA to delivery evidence.
          </p>
        </div>
        {canModify && (
          <div className="page-header__actions">
            <button type="button" onClick={onUpload}>
              Upload LOA
            </button>
          </div>
        )}
      </header>

      <section className="card" aria-labelledby="works-title">
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
          <>
            <div className="toolbar">
              <div className="filter-pills">
                {FILTERS.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className="filter-pill"
                    aria-pressed={filter === candidate.id}
                    onClick={() => {
                      setFilter(candidate.id);
                    }}
                  >
                    {candidate.label}
                    <span className="filter-pill__count">{counts[candidate.id]}</span>
                  </button>
                ))}
              </div>
              <input
                type="search"
                className="search-input"
                aria-label="Search Works"
                placeholder="Search code, work, letter…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </div>

            <table className="data-table">
              <caption className="visually-hidden">
                Works with letter reference, contract value, and status
              </caption>
              <thead>
                <tr>
                  <th scope="col">Work</th>
                  <th scope="col">Letter</th>
                  <th scope="col" className="cell--numeric">
                    Contract value
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((work) => (
                  <tr key={work.id}>
                    <th scope="row">
                      <button
                        type="button"
                        className="button--link"
                        onClick={() => {
                          onOpenWork(work.id);
                        }}
                      >
                        <span className="id-chip">{work.workCode}</span>
                      </button>
                      <div className="cell--wrap" style={{ marginTop: '0.2rem' }}>
                        {work.title}
                      </div>
                    </th>
                    <td>
                      {work.letterNumber}
                      <div className="muted">{formatDate(work.letterDate)}</div>
                    </td>
                    <td className="cell--numeric">
                      {formatCompactInr(work.contractValue)}
                    </td>
                    <td>
                      <span className={`chip ${WORK_STATUS[work.status].chip}`}>
                        {WORK_STATUS[work.status].label}
                      </span>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted centered">
                      No Works match your search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="hint">
              Showing {rows.length} of {works.length} Works
            </p>
          </>
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
                  <td>{formatDate(document.createdAt)}</td>
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
