import { useState } from 'react';
import type { SerialSearchResponse } from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Card } from '../ui/card.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { Field, Actions, FormError } from '../ui/form.js';

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
            setResult(null);
            setQuery(null);
            return;
          }
          setPending(true);
          setError(null);
          api
            .searchSerials(organisationId, q)
            .then((found) => {
              setResult(found);
              setQuery(q);
            })
            .catch((cause: unknown) => {
              setResult(null);
              setQuery(null);
              setError(
                cause instanceof RequestFailedError
                  ? cause.message
                  : 'The search failed; try again.',
              );
            })
            .finally(() => {
              setPending(false);
            });
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

      {error !== null && <FormError>{error}</FormError>}

      {result !== null && result.matches.length === 0 && (
        <p className="text-muted-foreground" role="status">
          No serial matches “{query}”.
        </p>
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
                    <Button
                      variant="link"
                      size="inline"
                      className="font-medium"
                      onClick={() => {
                        onOpenWork(match.workId);
                      }}
                    >
                      {match.workCode}
                    </Button>{' '}
                    <span className="text-muted-foreground">{match.workTitle}</span>
                  </td>
                  <td className={wrapCell}>{match.itemDescription}</td>
                  <td>
                    <Button
                      variant="link"
                      size="inline"
                      className="font-medium"
                      onClick={() => {
                        onOpenChallan(match.workId, match.challanId);
                      }}
                    >
                      {match.challanNumber ?? 'Draft'}
                    </Button>{' '}
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
