import { useCallback, useEffect, useState } from 'react';
import type { TimelineEvent, TimelineResponse } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';

/** Where the event stream comes from: a whole Work's trail (work detail
 * screen) or one record's history (challan detail reuses this). */
export type TimelineScope =
  | { readonly kind: 'work'; readonly workId: string }
  | { readonly kind: 'entity'; readonly entityType: string; readonly entityId: string };

interface TimelineProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly scope: TimelineScope;
}

const ACTION_LABELS: Record<string, string> = {
  'work.created': 'Work created',
  'challan.created': 'Challan drafted',
  'challan.updated': 'Challan draft updated',
  'challan.deleted': 'Challan draft deleted',
  'challan.issued': 'Challan issued',
  'challan.cancelled': 'Challan cancelled',
  'challan.rendered': 'Challan PDF generated',
  'challan.signed_copy_uploaded': 'Signed copy uploaded',
  'challan.received': 'Delivery receipt recorded',
  'serials.recorded': 'Serial numbers recorded',
  'serial.installed': 'Installation recorded',
  'instrument.created': 'Instrument recorded',
  'instrument.updated': 'Instrument updated',
  'mb.recorded': 'Measurement recorded',
  'bill.prepared': 'Bill prepared',
  'bill.submitted': 'Bill submitted',
  'bill.paid': 'Bill paid',
};

const FIELD_LABELS: Record<string, string> = {
  challanDate: 'Challan date',
  prefix: 'Number prefix',
  consignee: 'Consignee',
  items: 'Line items',
  challanNumber: 'Challan number',
  totalAmount: 'Total amount',
  itemCount: 'Line count',
  sequence: 'Sequence',
  note: 'Note',
  status: 'Status',
  expiresOn: 'Expires on',
  notes: 'Notes',
  installedOn: 'Installed on',
  installationRemarks: 'Installation remarks',
  receivedOn: 'Received on',
  measuredQuantity: 'Measured quantity',
  billNumber: 'Bill number',
  entryCount: 'Measurements',
  kind: 'Kind',
  reference: 'Reference',
  count: 'Count',
  role: 'Role',
  workScope: 'Work scope',
  canIssueDocuments: 'Issue authority',
  canCancelDocuments: 'Cancel authority',
  workIds: 'Assigned Works',
  name: 'Name',
  address: 'Address',
  gstin: 'GSTIN',
  contactPhone: 'Contact phone',
  contactEmail: 'Contact email',
};

const ENTITY_FILTERS = [
  { value: '', label: 'All activity' },
  { value: 'works', label: 'Work' },
  { value: 'delivery_challans', label: 'Challans' },
  { value: 'challan_receipts', label: 'Receipts' },
  { value: 'challan_item_serials', label: 'Serials' },
  { value: 'work_instruments', label: 'Instruments' },
  { value: 'mb_entries', label: 'Measurements' },
  { value: 'bills', label: 'Bills' },
  { value: 'installations', label: 'Installations' },
] as const;

function humaniseAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replaceAll('.', ' ').replaceAll('_', ' ');
}

function humaniseField(field: string): string {
  return (
    FIELD_LABELS[field] ??
    field
      .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
      .replaceAll('_', ' ')
      .toLowerCase()
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Compact human text for a diff side: scalars verbatim, objects as
 * "key: value" pairs, arrays summarised per element — never raw JSON. */
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length > 0 ? value : '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    return value.map(displayValue).join('; ');
  }
  if (isPlainObject(value)) {
    return Object.entries(value)
      .map(([key, entry]) => `${humaniseField(key)}: ${displayValue(entry)}`)
      .join(', ');
  }
  return '—';
}

interface DiffRow {
  readonly field: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

/** Update events carry { before: {field: old}, after: {field: new} } for
 * the changed fields only; anything else renders no diff. */
function diffRows(details: unknown): readonly DiffRow[] {
  if (!isPlainObject(details)) return [];
  const { before, after } = details;
  if (!isPlainObject(before) || !isPlainObject(after)) return [];
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return fields.map((field) => ({
    field,
    label: humaniseField(field),
    before: displayValue(before[field]),
    after: displayValue(after[field]),
  }));
}

/** Scalar context facts (challan number, note, quantity…) shown under the
 * action label; structured diffs and identifiers are handled elsewhere. */
function contextFacts(details: unknown): readonly string[] {
  if (!isPlainObject(details)) return [];
  return Object.entries(details)
    .filter(
      ([key, value]) =>
        key !== 'before' &&
        key !== 'after' &&
        !key.endsWith('Id') &&
        (typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean') &&
        !(typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) &&
        !(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)),
    )
    .map(([key, value]) => `${humaniseField(key)}: ${String(value)}`);
}

function occurredOn(iso: string): string {
  return iso.slice(0, 10);
}

export function Timeline({ api, organisationId, scope }: TimelineProps) {
  const [events, setEvents] = useState<readonly TimelineEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [entityFilter, setEntityFilter] = useState('');

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
        setError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The timeline could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  async function loadMore() {
    if (nextCursor === null) return;
    setPending(true);
    setError(null);
    try {
      const page = await fetchPage(nextCursor);
      setEvents((current) => [...(current ?? []), ...page.events]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The timeline could not be loaded.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="timeline-section">
      <div className="card__header">
        <h2>Timeline</h2>
        {scope.kind === 'work' && (
          <span className="actions">
            <label className="visually-hidden" htmlFor="timeline-filter">
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
      </div>
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {events === null && error === null && (
        <p className="muted" role="status">
          Loading timeline…
        </p>
      )}
      {events !== null && events.length === 0 && (
        <p className="muted">No activity recorded yet.</p>
      )}
      {events !== null && events.length > 0 && (
        <ol className="timeline">
          {events.map((event) => {
            const rows = diffRows(event.details);
            const facts = contextFacts(event.details);
            return (
              <li key={event.id} className="timeline__event">
                <p className="timeline__headline">
                  <span className="timeline__action">
                    {humaniseAction(event.action)}
                  </span>
                  <span className="muted">
                    {' '}
                    · {occurredOn(event.occurredAt)}
                    {event.actorName !== null ? ` · ${event.actorName}` : ''}
                  </span>
                </p>
                {facts.length > 0 && (
                  <p className="muted timeline__facts">{facts.join(' · ')}</p>
                )}
                {rows.length > 0 && (
                  <dl className="timeline__diff">
                    {rows.map((row) => (
                      <div key={row.field} className="timeline__diff-row">
                        <dt>{row.label}</dt>
                        <dd>
                          <span className="timeline__before">{row.before}</span>
                          <span aria-hidden="true" className="timeline__arrow">
                            {' '}
                            →{' '}
                          </span>
                          <span className="visually-hidden"> changed to </span>
                          <span className="timeline__after">{row.after}</span>
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
        <div className="actions">
          <button
            type="button"
            className="button--ghost"
            disabled={pending}
            onClick={() => void loadMore()}
          >
            Show earlier events
          </button>
        </div>
      )}
    </div>
  );
}
