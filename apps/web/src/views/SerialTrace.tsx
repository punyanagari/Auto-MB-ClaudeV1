import { useEffect, useState } from 'react';
import type { SerialSearchResponse } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
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
        setError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The serial search could not be completed.',
        );
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

      {pending && <LoadingState label="the serial search results" rows={3} columns={4} />}

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
              Serial numbers matching the search, with their Work, Delivery Challan,
              receipt and installation state
            </caption>
            <thead>
              <tr>
                <th scope="col">Serial</th>
                <th scope="col">Work</th>
                <th scope="col">Item</th>
                <th scope="col">Challan</th>
                <th scope="col">Receipt</th>
                <th scope="col">Installation</th>
              </tr>
            </thead>
            <tbody>
              {result.matches.map((match) => (
                <tr key={match.id}>
                  <th scope="row" className="font-mono">
                    {match.serialNumber}
                  </th>
                  <td className={wrapCell}>
                    {/* Real links so a hit can be middle-clicked into
                        its own tab; a left click stays in-app. */}
                    <a
                      href={workHash(match.workId)}
                      className="font-medium"
                      onClick={navigateOnClick(() => {
                        onOpenWork(match.workId);
                      })}
                    >
                      {match.workCode}
                    </a>{' '}
                    <span className="text-muted-foreground">{match.workTitle}</span>
                  </td>
                  <td className={wrapCell}>{match.itemDescription}</td>
                  <td>
                    <a
                      href={challanHash(match.workId, match.challanId)}
                      className="font-medium"
                      onClick={navigateOnClick(() => {
                        onOpenChallan(match.workId, match.challanId);
                      })}
                    >
                      {match.challanNumber ?? 'Draft'}
                    </a>{' '}
                    <span className="text-muted-foreground">· {match.challanDate}</span>{' '}
                    <StatusChip status={match.challanStatus} />
                  </td>
                  <td>
                    {match.receiptRecorded ? (
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
              ))}
            </tbody>
          </DataTable>
        </>
      )}
    </>
  );
}
