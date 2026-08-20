import { useCallback, useEffect, useState } from 'react';
import type { TimelineEvent, TimelineResponse } from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { formatTimestampDate } from '../format.js';
import { contextFacts, diffRows, humaniseAction } from '../lib/audit-text.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { CardHeader } from '../ui/card.js';
import { Actions } from '../ui/form.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/** Where the event stream comes from: a whole Work's trail (work detail
 * screen) or one record's history (challan detail reuses this). */
type TimelineScope =
  | { readonly kind: 'work'; readonly workId: string }
  | { readonly kind: 'entity'; readonly entityType: string; readonly entityId: string };

interface TimelineProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly scope: TimelineScope;
}

const ENTITY_FILTERS = [
  { value: '', label: 'All activity' },
  { value: 'works', label: 'Work' },
  { value: 'delivery_challans', label: 'Challans' },
  { value: 'challan_receipts', label: 'Receipts' },
  { value: 'challan_item_serials', label: 'Serials' },
  { value: 'work_instruments', label: 'Instruments' },
  { value: 'extension_requests', label: 'Extensions' },
  { value: 'mb_entries', label: 'Measurements' },
  { value: 'bills', label: 'Bills' },
  { value: 'bill_payments', label: 'Payments received' },
  { value: 'installations', label: 'Installations' },
  { value: 'issue_challans', label: 'Issue challans' },
  { value: 'approval_requests', label: 'Approvals' },
  { value: 'correction_notices', label: 'Correction notices' },
  { value: 'measurement_books', label: 'Measurement books' },
  { value: 'received_railway_bills', label: 'Railway bills' },
  { value: 'railway_measurements', label: 'Railway measurements' },
  { value: 'inspection_calls', label: 'Inspection calls' },
  { value: 'correspondence_letters', label: 'Correspondence' },
  { value: 'production_job_cards', label: 'Job cards' },
  { value: 'work_items', label: 'Items' },
  { value: 'payment_matrices', label: 'Payment matrix' },
  { value: 'pac_certificates', label: 'PAC certificates' },
] as const;

export function Timeline({ api, organisationId, scope }: TimelineProps) {
  const [events, setEvents] = useState<readonly TimelineEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [entityFilter, setEntityFilter] = useState('');
  const [loadVersion, retry] = useReload();

  const scopeKey =
    scope.kind === 'work'
      ? `work:${scope.workId}`
      : `entity:${scope.entityType}:${scope.entityId}`;

  const fetchPage = useCallback(
    (cursor?: string): Promise<TimelineResponse> => {
      if (scope.kind === 'work') {
        return api.workTimeline(organisationId, scope.workId, {
          ...(cursor !== undefined ? { cursor } : {}),
          ...(entityFilter !== '' ? { entityTypes: [entityFilter] } : {}),
        });
      }
      return api.entityTimeline(organisationId, scope.entityType, scope.entityId, {
        ...(cursor !== undefined ? { cursor } : {}),
      });
    },
    // scopeKey stands in for the scope object so a re-created but
    // identical scope literal does not refetch.
    [api, organisationId, scopeKey, entityFilter],
  );

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setNextCursor(null);
    setError(null);
    fetchPage()
      .then((page) => {
        if (cancelled) return;
        setEvents(page.events);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorMessage(cause, 'The timeline could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, loadVersion]);

  async function loadMore() {
    if (nextCursor === null) return;
    setPending(true);
    setError(null);
    try {
      const page = await fetchPage(nextCursor);
      setEvents((current) => [...(current ?? []), ...page.events]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(errorMessage(cause, 'The timeline could not be loaded.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-6">
      <CardHeader>
        <h2>Timeline</h2>
        {scope.kind === 'work' && (
          <span className="mt-4 flex flex-wrap items-center gap-2 print:hidden">
            <label className="sr-only" htmlFor="timeline-filter">
              Filter timeline by record type
            </label>
            <select
              id="timeline-filter"
              value={entityFilter}
              onChange={(event) => {
                setEntityFilter(event.target.value);
              }}
            >
              {ENTITY_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
          </span>
        )}
      </CardHeader>
      {error !== null && (
        <ErrorState onRetry={retry} retryLabel="Retry timeline">
          {error}
        </ErrorState>
      )}
      {events === null && error === null && (
        <LoadingState label="the timeline" rows={3} />
      )}
      {events !== null && events.length === 0 && (
        <EmptyState>
          No activity recorded yet. Every issued document, receipt and correction
          appears here as it is recorded.
        </EmptyState>
      )}
      {/* The rail below is `--border` like every other rule in the product.
          It used to be a hard-coded `#cbc9c0`, a warm grey left over from
          the retired quiet-light palette, which does not flip with the
          theme: in dark it drew a pale warm line across a cool dark ground. */}
      {events !== null && events.length > 0 && (
        <ol className="m-0 list-none border-l-2 border-border p-0">
          {events.map((event) => {
            const rows = diffRows(event.details);
            const facts = contextFacts(event.details);
            return (
              <li
                key={event.id}
                className="relative pb-4 pl-4 before:absolute before:top-[0.4rem] before:-left-[calc(0.25rem+3px)] before:size-[0.55rem] before:rounded-full before:bg-primary before:content-['']"
              >
                <p className="m-0">
                  <span className="font-semibold">{humaniseAction(event.action)}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {formatTimestampDate(event.occurredAt)}
                    {event.actorName !== null ? ` · ${event.actorName}` : ''}
                  </span>
                </p>
                {facts.length > 0 && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {facts.join(' · ')}
                  </p>
                )}
                {rows.length > 0 && (
                  <dl className="mt-2 rounded-[var(--radius)] bg-primary/8 px-3 py-2 text-sm">
                    {rows.map((row) => (
                      <div
                        key={row.field}
                        className="flex flex-wrap gap-2 [&_dt]:min-w-32 [&_dt]:font-semibold [&_dd]:m-0"
                      >
                        <dt>{row.label}</dt>
                        <dd>
                          <span className="text-muted-foreground line-through">
                            {row.before}
                          </span>
                          <span aria-hidden="true" className="text-muted-foreground">
                            {' '}
                            →{' '}
                          </span>
                          <span className="sr-only"> changed to </span>
                          <span className="font-semibold text-foreground">
                            {row.after}
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {nextCursor !== null && (
        <Actions>
          <Button variant="outline" disabled={pending} onClick={() => void loadMore()}>
            Show earlier events
          </Button>
        </Actions>
      )}
    </div>
  );
}
