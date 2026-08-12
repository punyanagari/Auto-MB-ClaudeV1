import { useEffect, useMemo, useState } from 'react';
import { Search, Plus } from 'lucide-react';
import type { LoaDocument, Work } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatCompactInr, formatDate, formatTimestampDate } from '../format.js';
import { cn } from '../lib/cn.js';
import { navigateOnClick, workHash, workspaceHashOf } from '../lib/workspace-routes.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';

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

const DOCUMENT_BADGE: Record<
  LoaDocument['extractionStatus'],
  'neutral' | 'warning' | 'success' | 'destructive'
> = {
  pending: 'neutral',
  processing: 'warning',
  review: 'warning',
  confirmed: 'success',
  failed: 'destructive',
};

const WORK_STATUS: Record<
  Work['status'],
  { label: string; variant: 'info' | 'success' | 'destructive' }
> = {
  active: { label: 'Active', variant: 'info' },
  completed: { label: 'Completed', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'destructive' },
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
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mb-1 text-[11px] font-semibold tracking-widest text-primary uppercase">
            Works registry
          </p>
          <h1
            id="works-title"
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight text-balance"
          >
            Works
          </h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Every awarded contract, from LOA to delivery evidence.
          </p>
        </div>
        {canModify && (
          <div className="flex shrink-0 items-center gap-2">
            <Button onClick={onUpload}>
              <Plus className="size-4" aria-hidden="true" />
              Upload LOA
            </Button>
          </div>
        )}
      </header>

      <section aria-labelledby="works-title" className="flex flex-col gap-4">
        {loadError !== null && (
          <p className="text-sm font-medium text-destructive" role="alert">
            {loadError}
          </p>
        )}

        {loadError === null && (works === null || documents === null) && (
          <p className="text-sm text-muted-foreground" role="status">
            Loading Works…
          </p>
        )}

        {works !== null && works.length > 0 && (
          <>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1">
                {FILTERS.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    aria-pressed={filter === candidate.id}
                    onClick={() => {
                      setFilter(candidate.id);
                    }}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      filter === candidate.id
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {candidate.label}
                    <span
                      className={cn(
                        'rounded px-1.5 text-[11px] tnum',
                        filter === candidate.id
                          ? 'bg-primary-foreground/20'
                          : 'bg-muted-foreground/15',
                      )}
                    >
                      {counts[candidate.id]}
                    </span>
                  </button>
                ))}
              </div>

              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  aria-label="Search Works"
                  placeholder="Search code, work, letter…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  className="h-9 w-full rounded-md border border-input bg-card pr-3 pl-9 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 lg:w-80"
                />
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-sm">
                  <caption className="sr-only">
                    Works with letter reference, contract value, and status
                  </caption>
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                      <th className="px-4 py-3">Work</th>
                      <th className="px-4 py-3">Letter</th>
                      <th className="px-4 py-3 text-right">Contract value</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((work) => (
                      <tr
                        key={work.id}
                        className="group transition-colors hover:bg-muted/40"
                      >
                        <th scope="row" className="px-4 py-3 text-left font-normal">
                          {/* A real link: middle-click opens the Work in
                              its own tab, a left click stays in-app. */}
                          <a
                            href={workHash(work.id)}
                            onClick={navigateOnClick(() => {
                              onOpenWork(work.id);
                            })}
                            className="inline-block rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-primary no-underline"
                          >
                            {work.workCode}
                          </a>
                          <p className="mt-1 line-clamp-2 max-w-md text-[13px] leading-snug font-medium text-foreground group-hover:text-primary">
                            {work.title}
                          </p>
                        </th>
                        <td className="px-4 py-3">
                          <p className="text-[13px]">{work.letterNumber}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground tnum">
                            {formatDate(work.letterDate)}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="font-mono text-[13px] font-semibold tnum">
                            {formatCompactInr(work.contractValue)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={WORK_STATUS[work.status].variant}>
                            {WORK_STATUS[work.status].label}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-4 py-16 text-center text-sm text-muted-foreground"
                        >
                          No Works match your search.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Showing {rows.length} of {works.length} Works
            </p>
          </>
        )}

        {works !== null && works.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No Works yet. Upload a Letter of Acceptance to create the first one.
          </p>
        )}
      </section>

      {documents !== null && documents.length > 0 && (
        <section aria-labelledby="loa-documents-title" className="flex flex-col gap-3">
          <h2 id="loa-documents-title" className="text-sm font-semibold">
            LOA documents
          </h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <caption className="sr-only">
                  Uploaded Letter of Acceptance documents and their extraction status
                </caption>
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    <th className="px-4 py-3">File</th>
                    <th className="px-4 py-3">Uploaded</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {documents.map((document) => (
                    <tr
                      key={document.id}
                      className="transition-colors hover:bg-muted/40"
                    >
                      <th
                        scope="row"
                        className="px-4 py-3 text-left text-[13px] font-medium"
                      >
                        {document.originalFilename}
                      </th>
                      <td className="px-4 py-3 text-[13px] tnum">
                        {formatTimestampDate(document.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={DOCUMENT_BADGE[document.extractionStatus]}>
                          {STATUS_LABELS[document.extractionStatus]}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {document.extractionStatus === 'review' && (
                          <a
                            href={workspaceHashOf({
                              view: { name: 'review', documentId: document.id },
                            })}
                            onClick={navigateOnClick(() => {
                              onReview(document.id);
                            })}
                          >
                            Review
                          </a>
                        )}
                        {document.extractionStatus === 'confirmed' &&
                          document.confirmedWorkId !== null && (
                            <a
                              href={workHash(document.confirmedWorkId)}
                              onClick={navigateOnClick(() => {
                                if (document.confirmedWorkId !== null) {
                                  onOpenWork(document.confirmedWorkId);
                                }
                              })}
                            >
                              Open Work
                            </a>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
