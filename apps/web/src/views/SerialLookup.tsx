import { useState } from 'react';
import type { SerialSearchResponse } from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import { challanHash, navigateOnClick, workHash } from '../lib/workspace-routes.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Card } from '../ui/card.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { Field, Actions, FormError } from '../ui/form.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

interface SerialLookupProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly onOpenWork: (workId: string) => void;
  readonly onOpenChallan: (workId: string, challanId: string) => void;
}

/** Organisation-wide serial number lookup: paste (part of) a serial from
 * a field report and land on the Work and challan it shipped under.
 * Assigned-scope members only see serials of their own Works — the
 * server applies the same filter as the Works list. */
export function SerialLookup({
  api,
  organisationId,
  onOpenWork,
  onOpenChallan,
}: SerialLookupProps) {
  const [result, setResult] = useState<SerialSearchResponse | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** The serial the failed search asked for. Retrying the SAME search is
   * the point, and the box may have been edited since, so the attempt is
   * remembered rather than re-read from the form. */
  const [failedQuery, setFailedQuery] = useState<string | null>(null);

  function runSearch(q: string): void {
    setPending(true);
    setError(null);
    setFailedQuery(null);
    api
      .searchSerials(organisationId, q)
      .then((found) => {
        setResult(found);
        setQuery(q);
      })
      .catch((cause: unknown) => {
        setResult(null);
        setQuery(null);
        setFailedQuery(q);
        setError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The serial search could not be completed.',
        );
      })
      .finally(() => {
        setPending(false);
      });
  }

  return (
    <Card className="w-full" aria-labelledby="serial-lookup-title">
      <h1 id="serial-lookup-title" tabIndex={-1}>
        Serial Lookup
      </h1>
      <p className="text-muted-foreground">
        Find where a serial number was delivered: its Work, challan, receipt, and
        installation state.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const q = formValue(data, 'serial-query').trim();
          if (q.length < 2) {
            setError('Enter at least 2 characters of the serial number.');
            setFailedQuery(null);
            setResult(null);
            setQuery(null);
            return;
          }
          runSearch(q);
        }}
      >
        <Field>
          <label htmlFor="serial-query">Serial number</label>
          <input
            id="serial-query"
            name="serial-query"
            maxLength={100}
            placeholder="e.g. SB-2026-014"
            autoComplete="off"
          />
        </Field>
        <Actions>
          <Button type="submit" disabled={pending}>
            Search
          </Button>
        </Actions>
      </form>

      {error !== null &&
        (failedQuery === null ? (
          // A too-short query is the operator's own input, corrected in
          // the box above; there is nothing to re-run.
          <FormError>{error}</FormError>
        ) : (
          <ErrorState
            retryLabel="Retry search"
            onRetry={() => {
              runSearch(failedQuery);
            }}
          >
            {error}
          </ErrorState>
        ))}

      {pending && (
        <LoadingState label="the serial search results" rows={3} columns={4} />
      )}

      {!pending && result !== null && result.matches.length === 0 && (
        <EmptyState>No serial matches “{query}”.</EmptyState>
      )}

      {result !== null && result.matches.length > 0 && (
        <>
          <p className="text-muted-foreground" role="status">
            {result.truncated
              ? `Showing the first ${String(result.matches.length)} matches for “${query ?? ''}”; refine the search to narrow them down.`
              : `${String(result.matches.length)} ${result.matches.length === 1 ? 'match' : 'matches'} for “${query ?? ''}”.`}
          </p>
          <DataTable>
            <caption className="sr-only">Serial numbers matching the search</caption>
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
                  <th scope="row">{match.serialNumber}</th>
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
    </Card>
  );
}
