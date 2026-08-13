import { useEffect, useState } from 'react';
import type { SearchResponse, SearchResult, SearchResultKind } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import {
  QUOTATIONS_HASH,
  SERIALS_HASH,
  challanHash,
  issueChallanHash,
  navigateOnClick,
  workHash,
} from '../lib/workspace-routes.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Card } from '../ui/card.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { FormError } from '../ui/form.js';

interface SearchProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The query carried by the route, so a refresh or a Back re-runs the
   * same search rather than landing on an empty box. */
  readonly query: string;
  /** Re-routes to `#/search/<next>` when the operator edits the query
   * here, keeping the address bar and the results in step. */
  readonly onQueryChange: (query: string) => void;
  readonly onOpenWork: (workId: string) => void;
  readonly onOpenChallan: (workId: string, challanId: string) => void;
  readonly onOpenIssueChallan: (workId: string, challanId: string) => void;
  readonly onOpenSerials: () => void;
  readonly onOpenQuotations: () => void;
}

const GROUP_LABELS: Readonly<Record<SearchResultKind, string>> = {
  work: 'Works',
  'delivery-challan': 'Delivery Challans',
  'issue-challan': 'Issue Challans',
  'tax-invoice': 'Tax invoices',
  'credit-note': 'Credit notes',
  'purchase-order': 'Purchase orders',
  quotation: 'Quotations',
};

/**
 * Where a result leads.
 *
 * Delivery and issue challans have their own screens. The remaining
 * document registers live inside a Work's tabs rather than at their own
 * routes, so those results deep-link to the tab that holds them — the
 * operator lands on the register with the document in it, which is the
 * honest destination available. A quotation has no Work, so it goes to
 * the quotation register.
 */
function hrefOf(result: SearchResult): string | null {
  switch (result.kind) {
    case 'work':
      return workHash(result.id);
    case 'delivery-challan':
      return result.workId === null ? null : challanHash(result.workId, result.id);
    case 'issue-challan':
      return result.workId === null ? null : issueChallanHash(result.workId, result.id);
    case 'tax-invoice':
    case 'credit-note':
      return result.workId === null ? null : workHash(result.workId, 'bills');
    case 'purchase-order':
      return result.workId === null ? null : workHash(result.workId, 'procurement');
    case 'quotation':
      return QUOTATIONS_HASH;
  }
}

export function Search({
  api,
  organisationId,
  query,
  onQueryChange,
  onOpenWork,
  onOpenChallan,
  onOpenIssueChallan,
  onOpenSerials,
  onOpenQuotations,
}: SearchProps) {
  const [draft, setDraft] = useState(query);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Bumped by Retry. The route cannot carry it — retrying the SAME query
   * is the whole point, so navigating to an identical hash would change
   * nothing and the retry button would be as dead as the `/` hint was. */
  const [attempt, setAttempt] = useState(0);

  // The route owns the query; the box only edits it. Re-syncing here is
  // what makes Back and Forward walk previous searches.
  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResult(null);
      setError(null);
      setPending(false);
      return;
    }
    let cancelled = false;
    setPending(true);
    setError(null);
    api
      .search(organisationId, trimmed)
      .then((found) => {
        if (cancelled) return;
        setResult(found);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setResult(null);
        // A failed search must never render as "nothing matched"
        // (finding 27): an empty register and an unreachable one are
        // different facts and the operator has to be able to tell.
        setError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The search could not be completed.',
        );
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, query, attempt]);

  function openResult(result: SearchResult): void {
    switch (result.kind) {
      case 'work':
        onOpenWork(result.id);
        return;
      case 'delivery-challan':
        if (result.workId !== null) onOpenChallan(result.workId, result.id);
        return;
      case 'issue-challan':
        if (result.workId !== null) onOpenIssueChallan(result.workId, result.id);
        return;
      case 'tax-invoice':
      case 'credit-note':
      case 'purchase-order':
        if (result.workId !== null) onOpenWork(result.workId);
        return;
      case 'quotation':
        onOpenQuotations();
        return;
    }
  }

  const trimmed = query.trim();
  const hasResults = result !== null && result.groups.length > 0;

  return (
    <Card className="w-full" aria-labelledby="search-title">
      <h1 id="search-title" tabIndex={-1}>
        Search
      </h1>
      <p className="text-muted-foreground">
        Works, Delivery and Issue Challans, tax invoices, credit notes, purchase
        orders and quotations — by number, by Work, or by the party named on the
        document.
      </p>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          onQueryChange(draft.trim());
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-56 flex-1">
          <label htmlFor="record-search-query" className="block text-xs font-medium">
            Search Works and records
          </label>
          <input
            id="record-search-query"
            name="record-search-query"
            type="search"
            className="w-full"
            maxLength={120}
            autoComplete="off"
            placeholder="Work code, challan or invoice number, party name"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </div>
        <Button type="submit" disabled={pending}>
          Search
        </Button>
      </form>

      {trimmed.length > 0 && trimmed.length < 2 && (
        <p className="text-muted-foreground" role="status">
          Enter at least two characters.
        </p>
      )}

      {error !== null && (
        <>
          <FormError>{error}</FormError>
          <Button
            variant="ghost"
            onClick={() => {
              setAttempt((current) => current + 1);
            }}
          >
            Try again
          </Button>
        </>
      )}

      {pending && (
        <p className="text-muted-foreground" role="status">
          Searching…
        </p>
      )}

      {!pending && error === null && result !== null && !hasResults && (
        <p className="text-muted-foreground" role="status">
          Nothing in the registers matches “{result.query}”.
        </p>
      )}

      {!pending && error === null && hasResults && (
        <>
          <p className="text-muted-foreground" role="status">
            {result.returned} {result.returned === 1 ? 'result' : 'results'} for “
            {result.query}”.
          </p>
          {result.groups.map((group) => (
            <section key={group.kind} aria-labelledby={`search-group-${group.kind}`}>
              <h2 id={`search-group-${group.kind}`}>{GROUP_LABELS[group.kind]}</h2>
              {group.truncated && (
                <p className="text-muted-foreground">
                  More {GROUP_LABELS[group.kind].toLowerCase()} match than are shown;
                  refine the search to narrow them down.
                </p>
              )}
              <DataTable>
                <caption className="sr-only">
                  {GROUP_LABELS[group.kind]} matching the search
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">Detail</th>
                    <th scope="col">Work</th>
                    <th scope="col">Date</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {group.results.map((row) => {
                    const href = hrefOf(row);
                    return (
                      <tr key={`${row.kind}-${row.id}`}>
                        <th scope="row">
                          {href === null ? (
                            row.label
                          ) : (
                            /* Real links: a middle click opens the record
                               in its own tab, exactly as the href says. */
                            <a
                              href={href}
                              className="font-medium"
                              onClick={navigateOnClick(() => {
                                openResult(row);
                              })}
                            >
                              {row.label}
                            </a>
                          )}
                        </th>
                        <td className={wrapCell}>{row.detail}</td>
                        <td>
                          {/* A Work result IS its own Work: repeating the
                              code as a second link to the same record
                              would be noise, and two identical links in
                              one row are a screen-reader hazard. */}
                          {row.kind === 'work' ||
                          row.workId === null ||
                          row.workCode === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <a
                              href={workHash(row.workId)}
                              onClick={navigateOnClick(() => {
                                onOpenWork(row.workId ?? '');
                              })}
                            >
                              {row.workCode}
                            </a>
                          )}
                        </td>
                        <td>{row.date ?? '—'}</td>
                        <td>
                          <StatusChip status={row.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            </section>
          ))}
        </>
      )}

      <p className="text-muted-foreground">
        Looking for a serial number? Serials carry their own delivery, receipt and
        installation trail —{' '}
        <a
          href={SERIALS_HASH}
          onClick={navigateOnClick(() => {
            onOpenSerials();
          })}
        >
          open Serial Lookup
        </a>
        .
      </p>
    </Card>
  );
}
