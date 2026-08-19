import { useEffect, useState } from 'react';
import type { SerialSearchResponse } from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { errorMessage } from '../lib/load-failure.js';
import { challanHash, navigateOnClick, workHash } from '../lib/workspace-routes.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

interface SerialTraceProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The Global Search query, already trimmed by the caller. The chain
   * reads it rather than owning a box of its own: the entry point moved
   * into Search, so there is one query on the screen and this is a view
   * of it. */
  readonly query: string;
  readonly onOpenWork: (workId: string) => void;
  readonly onOpenChallan: (workId: string, challanId: string) => void;
}

/**
 * The traceability chain a serial number opens: which Work and item it
 * belongs to, the Delivery Challan it shipped under and that challan's
 * state, whether receipt was recorded at the far end, and whether the
 * unit is installed — with the date and the station it went in at.
 *
 * The chain is unchanged by the merge of `#/serials` into Global Search
 * (`docs/UX.md` § `#/serials` merges into Global Search): "merging the
 * entry point does not merge the answer". What moved is where the query
 * is typed. Everything an operator could read from the standalone Serial
 * Lookup is read here, from the same `searchSerials` call, with the same
 * work-scope filter applied by the server — assigned-scope members see
 * serials of their own Works only.
 *
 * Rendered by `views/Search.tsx` under the "Installations & serials"
 * scope, and by "Everything".
 */
/** The delivery half's challan cell. Extracted so the narrowing that
 * proves a Work and a challan are both present happens in one place
 * rather than at each of the four fields that need it. */
function ChallanCell({
  workId,
  challanId,
  challanNumber,
  challanDate,
  challanStatus,
  onOpenChallan,
}: {
  readonly workId: string;
  readonly challanId: string;
  readonly challanNumber: string | null;
  readonly challanDate: string | null;
  readonly challanStatus: string | null;
  readonly onOpenChallan: (workId: string, challanId: string) => void;
}) {
  return (
    <>
      <a
        href={challanHash(workId, challanId)}
        className="font-medium"
        onClick={navigateOnClick(() => {
          onOpenChallan(workId, challanId);
        })}
      >
        {challanNumber ?? 'Draft'}
      </a>{' '}
      <span className="text-muted-foreground">· {challanDate}</span>{' '}
      {challanStatus !== null && <StatusChip status={challanStatus} />}
    </>
  );
}

export function SerialTrace({
  api,
  organisationId,
  query,
  onOpenWork,
  onOpenChallan,
}: SerialTraceProps) {
  const [result, setResult] = useState<SerialSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Bumped by Retry. Re-running the SAME query is the point, so the
   * attempt cannot be carried by the route — navigating to an identical
   * hash would change nothing and the button would be dead. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (query.length < 2) {
      setResult(null);
      setError(null);
      setPending(false);
      return;
    }
    let cancelled = false;
    setPending(true);
    setError(null);
    api
      .searchSerials(organisationId, query)
      .then((found) => {
        if (!cancelled) setResult(found);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setResult(null);
        // A failed lookup must never render as "no such serial": an empty
        // pool and an unreachable one are different facts about a unit
        // someone is standing next to.
        setError(errorMessage(cause, 'The serial search could not be completed.'));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, query, attempt]);

  if (query.length < 2) return null;

  return (
    <>
      {error !== null && (
        <ErrorState
          retryLabel="Retry serial search"
          onRetry={() => {
            setAttempt((current) => current + 1);
          }}
        >
          {error}
        </ErrorState>
      )}

      {pending && (
        <LoadingState label="the serial search results" rows={3} columns={4} />
      )}

      {!pending && error === null && result !== null && result.matches.length === 0 && (
        <EmptyState>No serial matches “{query}”.</EmptyState>
      )}

      {!pending && error === null && result !== null && result.matches.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground" role="status">
            {result.truncated
              ? `Showing the first ${String(result.matches.length)} matches for “${query}”; refine the search to narrow them down.`
              : `${String(result.matches.length)} ${result.matches.length === 1 ? 'match' : 'matches'} for “${query}”.`}
          </p>
          <DataTable>
            <caption className="sr-only">
              Serial numbers matching the search, with their origin, Work, Delivery
              Challan, receipt and installation state
            </caption>
            <thead>
              <tr>
                <th scope="col">Serial</th>
                <th scope="col">Origin</th>
                <th scope="col">Work</th>
                <th scope="col">Item</th>
                <th scope="col">Challan</th>
                <th scope="col">Receipt</th>
                <th scope="col">Installation</th>
              </tr>
            </thead>
            <tbody>
              {result.matches.map((match) => {
                /* Narrowed once, so the Work cell's link does not have to
                   re-prove it inside a closure. */
                const workCode =
                  match.workId === null
                    ? null
                    : { workId: match.workId, code: match.workCode };
                return (
                  <tr key={match.id}>
                    <th scope="row" className="font-mono">
                      {match.serialNumber}
                    </th>
                    <td>
                      {/* A unit the factory built and has not despatched
                        matched nothing here before migration 0084's
                        union — which reads exactly like "no such
                        serial", the worst answer a trace can give.

                        Migration 0108 adds the third answer, and it is
                        the one this column exists for: a number the
                        Delivery Challan missed and the site recorded is
                        traceable, but its paperwork does not start where
                        a delivered unit's does, and a trace that called
                        it "Delivered" would state the one thing about it
                        that is untrue. */}
                      {match.source === 'production' ? (
                        <StatusChip status="in-production" tone="warning">
                          Production
                        </StatusChip>
                      ) : match.source === 'installation' ? (
                        <StatusChip status="added-at-installation" tone="warning">
                          Added at installation
                        </StatusChip>
                      ) : (
                        <StatusChip status="issued">Delivered</StatusChip>
                      )}
                    </td>
                    <td className={wrapCell}>
                      {/* Real links so a hit can be middle-clicked into
                        its own tab; a left click stays in-app. A
                        production unit may have no Work at all — a job
                        card against a private purchase order — so the
                        cell says so rather than linking nowhere. */}
                      {workCode === null ? (
                        <span className="text-muted-foreground">
                          {match.source === 'production' ? 'Private order' : '—'}
                        </span>
                      ) : (
                        <>
                          <a
                            href={workHash(workCode.workId)}
                            className="font-medium"
                            onClick={navigateOnClick(() => {
                              onOpenWork(workCode.workId);
                            })}
                          >
                            {workCode.code}
                          </a>{' '}
                          <span className="text-muted-foreground">
                            {match.workTitle}
                          </span>
                        </>
                      )}
                    </td>
                    <td className={wrapCell}>{match.itemDescription}</td>
                    <td>
                      {match.challanId === null || match.workId === null ? (
                        <span className="text-muted-foreground">
                          {match.source === 'production'
                            ? match.releasedOn == null
                              ? 'in the factory'
                              : `released ${match.releasedOn}`
                            : match.source === 'installation'
                              ? 'no challan — recorded at site'
                              : '—'}
                        </span>
                      ) : (
                        <ChallanCell
                          workId={match.workId}
                          challanId={match.challanId}
                          challanNumber={match.challanNumber}
                          challanDate={match.challanDate}
                          challanStatus={match.challanStatus}
                          onOpenChallan={onOpenChallan}
                        />
                      )}
                    </td>
                    <td>
                      {match.source === 'production' ? (
                        match.genealogyComplete === true ? (
                          <StatusChip status="confirmed">
                            {match.componentsCaptured ?? 0} components
                          </StatusChip>
                        ) : (
                          <StatusChip status="pending">genealogy short</StatusChip>
                        )
                      ) : match.receiptRecorded ? (
                        <StatusChip status="confirmed">received</StatusChip>
                      ) : (
                        <span className="text-muted-foreground">no receipt</span>
                      )}
                    </td>
                    <td>
                      {match.installedOn !== null ? (
                        <StatusChip status="installed">
                          installed {match.installedOn}
                          {typeof match.installationLocation === 'string'
                            ? ` at ${match.installationLocation}`
                            : ''}
                        </StatusChip>
                      ) : (
                        <span className="text-muted-foreground">not installed</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </>
      )}
    </>
  );
}
