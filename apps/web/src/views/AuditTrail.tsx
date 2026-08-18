import { useCallback, useEffect, useState } from 'react';
import type {
  AuditEvent,
  AuditFacetsResponse,
  AuditRegisterQuery,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatDate, formatTimestamp } from '../format.js';
import {
  contextFacts,
  diffRows,
  humaniseAction,
  humaniseEntityType,
} from '../lib/audit-text.js';
import { describeLoadFailure, describeRefusal } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { DateField } from '../ui/date-field.js';
import { DownloadButton } from '../ui/download-button.js';
import { FormError } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { Sheet } from '../ui/sheet.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, wrapCell } from '../ui/table.js';

/**
 * The organisation-wide audit register (migration 0095).
 *
 * NOT the per-Work timeline, which stays where it is on the Work
 * workspace: that one answers "what happened to this Work" for everyone
 * assigned to it. This one answers "what did this person do", across every
 * Work and every module, and it is gated on the audit authority AND full
 * work scope. A refusal is rendered as the server's own sentence rather
 * than as an `ErrorState` with a retry button, because neither wall opens
 * on a second attempt.
 *
 * ## The grammar
 *
 * `views/InvoicesRegister.tsx`'s: a `PageHeader`, a `Card` holding the
 * filter row and the dense table, keyset paging through a "Load more"
 * button, and a right-hand `Sheet` for the detail. The Sheet rather than an
 * addressable detail pane, because an audit row has no address of its own
 * worth serialising — it is a fact about a record, and the record already
 * has a screen.
 *
 * The filter pickers are populated from `auditFacets`, which reads the
 * organisation's own trail. A hand-written action list on this side would
 * be wrong within one wave, and it could offer a filter that returns
 * nothing.
 *
 * Everything the rows print — the action sentence, the field names, the
 * before/after — comes from `lib/audit-text.ts`, shared verbatim with the
 * Timeline so the same event never reads two ways.
 */

interface AuditTrailProps {
  readonly api: ApiClient;
  readonly organisationId: string;
}

const PAGE_SIZE = 100;

/** The filters as the screen holds them: every value a string, empty
 * meaning "not filtering", so one shape drives the controls, the request
 * and the workbook. */
interface Filters {
  readonly actorUserId: string;
  readonly entityType: string;
  readonly action: string;
  readonly from: string;
  readonly to: string;
}

const NO_FILTERS: Filters = {
  actorUserId: '',
  entityType: '',
  action: '',
  from: '',
  to: '',
};

function asQuery(filters: Filters): AuditRegisterQuery {
  return {
    ...(filters.actorUserId !== '' ? { actorUserId: filters.actorUserId } : {}),
    ...(filters.entityType !== '' ? { entityType: filters.entityType } : {}),
    ...(filters.action !== '' ? { action: filters.action } : {}),
    ...(filters.from !== '' ? { from: filters.from } : {}),
    ...(filters.to !== '' ? { to: filters.to } : {}),
  };
}

function isFiltered(filters: Filters): boolean {
  return Object.values(filters).some((value) => value !== '');
}

export function AuditTrail({ api, organisationId }: AuditTrailProps) {
  const [events, setEvents] = useState<readonly AuditEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [windowFrom, setWindowFrom] = useState<string | null>(null);
  const [retentionMonths, setRetentionMonths] = useState<number | null>(null);
  const [facets, setFacets] = useState<AuditFacetsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();

  const fetchPage = useCallback(
    (cursor?: string) =>
      api.auditRegister(organisationId, {
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
        ...asQuery(filters),
      }),
    [api, organisationId, filters],
  );

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setLoadError(null);
    fetchPage()
      .then((page) => {
        if (cancelled) return;
        setEvents(page.events);
        setNextCursor(page.nextCursor);
        setWindowFrom(page.windowFrom);
        setRetentionMonths(page.retentionMonths);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const failure = describeRefusal(cause, 'The audit register');
        setLoadError(failure.message);
        setRetryable(failure.retryable);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, loadVersion]);

  // The pickers are loaded once per organisation, not per filter change:
  // the vocabulary of a trail does not move while an operator reads it.
  useEffect(() => {
    let cancelled = false;
    api
      .auditFacets(organisationId)
      .then((loaded) => {
        if (!cancelled) setFacets(loaded);
      })
      .catch(() => {
        // A register that still lists its events is more useful than one
        // that refuses to render because its pickers are empty, and the
        // page read below reports the same refusal properly.
        if (!cancelled) setFacets({ actions: [], entityTypes: [], actors: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    try {
      const page = await fetchPage(nextCursor);
      setEvents((current) => [...(current ?? []), ...page.events]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      const failure = describeLoadFailure(cause, 'The next page of audit events');
      setLoadError(failure.message);
      setRetryable(failure.retryable);
    }
  }

  const header = (
    <PageHeader
      className="mb-0"
      eyebrow="Administration"
      title="Audit trail"
      titleId="audit-title"
      description="Every recorded action across the organisation, with the before and after of each change."
      action={
        /* The SAME control every other register's export uses, and the
           only one whose filters travel: the workbook is the register as
           filtered, clamped to the same retention window. `docs/UX.md`
           § 19 records why this export is the exception. */
        <DownloadButton
          label="Export .xlsx"
          filename={`audit-trail-${windowFrom ?? 'all'}-to-${filters.to === '' ? 'now' : filters.to}.xlsx`}
          fetchBlob={() => api.downloadAuditWorkbook(organisationId, asQuery(filters))}
        />
      }
    />
  );

  if (loadError !== null && events === null) {
    return (
      <section aria-labelledby="audit-title" className="flex flex-col gap-5">
        {header}
        {retryable ? (
          <ErrorState onRetry={retry} retryLabel="Retry the audit register">
            {loadError}
          </ErrorState>
        ) : (
          // An authority or scope refusal does not succeed on a second
          // attempt, so it is stated rather than offered a retry button.
          <p role="alert" className="m-0 text-sm font-medium text-destructive">
            {loadError}
          </p>
        )}
      </section>
    );
  }

  if (events === null) {
    return (
      <section aria-labelledby="audit-title" className="flex flex-col gap-5">
        {header}
        <LoadingState label="the audit register" rows={8} columns={5} />
      </section>
    );
  }

  const openEvent = events.find((event) => event.id === openEventId) ?? null;

  return (
    <section aria-labelledby="audit-title" className="flex flex-col gap-5">
      {header}

      <Card className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setFilters({
              actorUserId: formValue(data, 'audit-actor'),
              entityType: formValue(data, 'audit-entity-type'),
              action: formValue(data, 'audit-action'),
              from: formValue(data, 'audit-from'),
              to: formValue(data, 'audit-to'),
            });
            setOpenEventId(null);
          }}
        >
          <Picker
            id="audit-actor"
            label="Member"
            allLabel="Every member"
            options={(facets?.actors ?? []).map((actor) => ({
              value: actor.userId,
              label: actor.name ?? actor.userId,
            }))}
          />
          <Picker
            id="audit-entity-type"
            label="Record type"
            allLabel="Every record type"
            options={(facets?.entityTypes ?? []).map((entityType) => ({
              value: entityType,
              label: humaniseEntityType(entityType),
            }))}
          />
          <Picker
            id="audit-action"
            label="Action"
            allLabel="Every action"
            options={(facets?.actions ?? []).map((action) => ({
              value: action,
              label: humaniseAction(action),
            }))}
          />
          {/* Uncontrolled and applied on submit, so a half-typed year
              never fires a request — the InvoicesRegister rule. */}
          <DateField
            id="audit-from"
            name="audit-from"
            label="On or after"
            fieldClassName="my-0"
          />
          <DateField
            id="audit-to"
            name="audit-to"
            label="On or before"
            fieldClassName="my-0"
          />
          <Button type="submit" variant="outline">
            Apply filters
          </Button>
          {isFiltered(filters) && (
            <Button
              type="reset"
              variant="ghost"
              onClick={() => {
                setFilters(NO_FILTERS);
                setOpenEventId(null);
              }}
            >
              Clear
            </Button>
          )}
        </form>

        {/* The retention window, said out loud. The register genuinely
            cannot look further back than this, and a screen that silently
            showed less than the dates asked for would read as a quiet
            organisation rather than as a policy. */}
        {windowFrom !== null && retentionMonths !== null && (
          <p className="m-0 text-sm text-muted-foreground">
            This register looks back to {formatDate(windowFrom)} — the organisation
            keeps {retentionMonths} months of trail on screen. Nothing older is deleted;
            an owner widens the window in Settings.
          </p>
        )}

        {loadError !== null && <FormError>{loadError}</FormError>}

        {events.length === 0 ? (
          isFiltered(filters) ? (
            <EmptyState>
              No recorded action matches these filters. Widen the dates, or clear the
              filters to read the whole register.
            </EmptyState>
          ) : (
            <EmptyState>
              Nothing has been recorded yet. Every issued document, permission change
              and correction appears here as it happens.
            </EmptyState>
          )
        ) : (
          <DataTable>
            <caption className="sr-only">
              Recorded actions with time, member, action, record type and record
              identifier
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Member</th>
                <th scope="col">Action</th>
                <th scope="col">Record type</th>
                <th scope="col">Record</th>
                <th scope="col">
                  <span className="sr-only">Detail</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <th scope="row" className="font-mono text-[13px] tabular-nums">
                    {formatTimestamp(event.occurredAt)}
                  </th>
                  <td className={wrapCell}>{event.actorName ?? '—'}</td>
                  <td className={wrapCell}>{humaniseAction(event.action)}</td>
                  <td>{humaniseEntityType(event.entityType)}</td>
                  <td className="font-mono text-[13px]">
                    {event.entityId === null ? '—' : event.entityId.slice(0, 8)}
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setOpenEventId(event.id);
                      }}
                    >
                      Detail
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}

        {nextCursor !== null && (
          <div>
            <Button variant="outline" onClick={() => void loadMore()}>
              Load earlier events
            </Button>
          </div>
        )}
      </Card>

      {openEvent !== null && (
        <EventSheet
          event={openEvent}
          onClose={() => {
            setOpenEventId(null);
          }}
        />
      )}
    </section>
  );
}

/** One filter select, with its "everything" option first. The local
 * helper `views/Receivables.tsx` uses, kept local for the same reason: it
 * is three lines of markup and a shared component would be a shared
 * component with one consumer. */
function Picker({
  id,
  label,
  allLabel,
  options,
}: {
  readonly id: string;
  readonly label: string;
  readonly allLabel: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <select id={id} name={id} defaultValue="">
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The detail pane: what changed, and the context facts the mutation
 * recorded beside it. The same before/after treatment the Timeline
 * prints, from the same helpers. */
function EventSheet({
  event,
  onClose,
}: {
  readonly event: AuditEvent;
  readonly onClose: () => void;
}) {
  const rows = diffRows(event.details);
  const facts = contextFacts(event.details);
  return (
    <Sheet
      side="right"
      title={humaniseAction(event.action)}
      description={`${formatTimestamp(event.occurredAt)} · ${event.actorName ?? 'System'}`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <CardHeader>
          <h3 className="text-sm font-medium">
            {humaniseEntityType(event.entityType)}
          </h3>
          {event.entityId !== null && (
            <p className="m-0 font-mono text-[13px] break-all text-muted-foreground">
              {event.entityId}
            </p>
          )}
        </CardHeader>

        {facts.length > 0 && (
          <p className="m-0 text-sm text-muted-foreground">{facts.join(' · ')}</p>
        )}

        {rows.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">
            This action recorded no field changes.
          </p>
        ) : (
          <dl className="m-0 flex flex-col gap-2 text-sm">
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
                  <span className="font-semibold text-foreground">{row.after}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Sheet>
  );
}
