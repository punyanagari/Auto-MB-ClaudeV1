import { useCallback, useEffect, useState } from 'react';
import {
  ClipboardList,
  PackageCheck,
  RotateCcw,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type {
  MaintenanceRequestSummary,
  MaintenanceStageCounts,
  MaintenanceStatus,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate, formatTimestampDate } from '../format.js';
import { maintenanceRequestHash, navigateOnClick } from '../lib/workspace-routes.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { PageHeader } from '../ui/page-header.js';
import { Stat } from '../ui/stat.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable } from '../ui/table.js';

/**
 * The maintenance register.
 *
 * Replicates `app/maintenance/page.tsx` and
 * `components/maintenance-dashboard.tsx` of the frozen mock at
 * `fdfd610`: the eyebrowed page header with one primary action, a
 * four-across stage strip counting the requests in each stage, and the
 * list of job cards underneath.
 *
 * Two things the mock draws that this screen does not, both recorded in
 * `docs/UX.md` § 14:
 *
 *   * **The rows are a dense table, not bordered link cards.** The mock's
 *     row is a 44px numbered tile beside a fault summary and a progress
 *     bar, which is a card list at table density. Every other register in
 *     this product is a sticky-header table and an operator scanning
 *     twenty requests reads columns, not cards.
 *   * **No per-row progress bar.** The mock's `Progress` value is a
 *     literal per status — 15, 38, 66, 100 — and not a measurement of
 *     anything. The stage chip already says which of the four stages a
 *     request is in, and a bar that only ever shows four positions is the
 *     same fact drawn twice.
 */

/** The mock's four stage cards, in its order and with its icons. */
const STAGES: readonly {
  readonly key: keyof MaintenanceStageCounts;
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [
  { key: 'awaitingApproval', label: 'Awaiting approval', icon: ClipboardList },
  { key: 'approved', label: 'Awaiting dispatch', icon: PackageCheck },
  { key: 'partiallyDispatched', label: 'Active / returns due', icon: RotateCcw },
  { key: 'closed', label: 'Closed', icon: Wrench },
];

/** The stored state, as the chip vocabulary spells it. `docs/DESIGN.md`
 * § Status badge semantics carries all four. */
export function maintenanceChipKey(status: MaintenanceStatus): string {
  return status.replaceAll('_', '-');
}

const STATUS_LABELS: Readonly<Record<MaintenanceStatus, string>> = {
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
  partially_dispatched: 'Dispatching',
  closed: 'Closed',
};

/** The mock's own next-action line, kept: it is the one thing the row
 * says that the stage chip does not. */
const NEXT_ACTION: Readonly<Record<MaintenanceStatus, string>> = {
  awaiting_approval: 'Admin review required',
  approved: 'Reserve and dispatch stock',
  partially_dispatched: 'Complete dispatch / receive defects',
  closed: 'Maintenance history complete',
};

const PAGE_SIZE = 50;

interface MaintenanceProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Raising a request is site and store work, exactly as the server
   * gates it. A viewer reads the register. */
  readonly canModify: boolean;
  readonly onNewRequest: () => void;
  readonly onOpenRequest: (requestId: string) => void;
}

export function Maintenance({
  api,
  organisationId,
  canModify,
  onNewRequest,
  onOpenRequest,
}: MaintenanceProps) {
  const [requests, setRequests] = useState<readonly MaintenanceRequestSummary[] | null>(
    null,
  );
  const [counts, setCounts] = useState<MaintenanceStageCounts | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);

  const reload = useCallback(() => {
    setLoadVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRequests(null);
    setLoadError(null);
    api
      .listMaintenanceRequests(organisationId, { limit: PAGE_SIZE })
      .then((loaded) => {
        if (cancelled) return;
        setRequests(loaded.requests);
        setCounts(loaded.counts);
        setNextCursor(loaded.nextCursor);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The maintenance register could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    setLoadError(null);
    api
      .listMaintenanceRequests(organisationId, { limit: PAGE_SIZE, cursor: nextCursor })
      .then((page) => {
        // Deliberately does NOT touch `counts`: the strip describes the
        // whole register and the server sends null on a cursor page.
        setRequests((current) => [...(current ?? []), ...page.requests]);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The next page could not be loaded.',
        );
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [api, organisationId, nextCursor]);

  const header = (
    <PageHeader
      eyebrow="Operations control"
      title="Maintenance"
      titleId="maintenance-title"
      description="Track site material requests from approval and stock reservation through dispatch, defective return, and repair intake."
      action={
        canModify ? (
          <Button onClick={onNewRequest}>
            <ClipboardList data-icon="inline-start" aria-hidden="true" />
            New material request
          </Button>
        ) : undefined
      }
    />
  );

  if (loadError !== null && requests === null) {
    return (
      <>
        {header}
        <ErrorState onRetry={reload} retryLabel="Retry maintenance">
          {loadError}
        </ErrorState>
      </>
    );
  }

  return (
    <>
      {header}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {STAGES.map((stage) => (
          <Card key={stage.key}>
            <div className="flex items-start justify-between gap-3">
              <Stat
                label={stage.label}
                value={counts === null ? '—' : String(counts[stage.key])}
              />
              <stage.icon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Maintenance job cards</h2>
          <p className="m-0 text-sm text-muted-foreground">
            Open jobs remain visible until all material and defective-return obligations
            are resolved.
          </p>
        </CardHeader>

        {requests === null ? (
          <LoadingState label="the maintenance register" rows={5} columns={5} />
        ) : requests.length === 0 ? (
          <EmptyState
            {...(canModify
              ? { action: { label: 'New material request', onClick: onNewRequest } }
              : {})}
          >
            No maintenance request has been raised yet. Create the first site material
            request to begin.
          </EmptyState>
        ) : (
          <DataTable>
            <caption className="sr-only">Maintenance job cards</caption>
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Fault</th>
                <th className="hidden md:table-cell" scope="col">
                  Work / station
                </th>
                <th className="hidden lg:table-cell" scope="col">
                  Required by
                </th>
                <th className="hidden sm:table-cell" scope="col">
                  Priority
                </th>
                <th scope="col">Stage</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <div className="flex flex-col gap-0.5">
                      {/* A real href so a row can be middle-clicked into
                          its own tab; a plain left click stays in-app
                          through the shell's navigation. */}
                      <a
                        href={maintenanceRequestHash(entry.id)}
                        className="font-mono text-sm tabular-nums text-primary underline-offset-4 hover:underline"
                        onClick={navigateOnClick(() => {
                          onOpenRequest(entry.id);
                        })}
                      >
                        {entry.requestNumber}
                      </a>
                      <span className="text-xs text-muted-foreground">
                        {/* A timestamp, so it goes through the helper
                            that renders it in the reader's own day.
                            Slicing the ISO string takes the UTC day and
                            shows yesterday's date all evening in IST. */}
                        {formatTimestampDate(entry.createdAt)}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-col gap-0.5">
                      <span className="max-w-96 truncate text-sm">
                        {entry.faultSummary}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {NEXT_ACTION[entry.status]}
                      </span>
                    </div>
                  </td>
                  <td className="hidden md:table-cell">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono text-xs tabular-nums">
                        {entry.workCode}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {entry.station} · {entry.requesterName}
                      </span>
                    </div>
                  </td>
                  <td className="hidden font-mono text-sm tabular-nums lg:table-cell">
                    {entry.requiredBy === null ? '—' : formatDate(entry.requiredBy)}
                  </td>
                  <td className="hidden sm:table-cell">
                    {/* Priority is not a lifecycle state, so it is not a
                        status chip: the mock draws it as a plain badge
                        beside one, and `docs/DESIGN.md` reserves the
                        dot-plus-label vocabulary for record state. */}
                    <span className="text-sm capitalize">{entry.priority}</span>
                  </td>
                  <td>
                    <StatusChip status={maintenanceChipKey(entry.status)}>
                      {STATUS_LABELS[entry.status]}
                    </StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}

        {loadError !== null && requests !== null && (
          <p className="alert error" role="alert">
            {loadError}
          </p>
        )}

        {nextCursor !== null && requests !== null && (
          <div className="mt-3">
            <Button variant="outline" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? 'Loading…' : 'Load more requests'}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
