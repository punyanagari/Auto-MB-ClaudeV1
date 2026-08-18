import { useEffect, useState } from 'react';
import type {
  SearchResponse,
  SearchResult,
  SearchResultKind,
} from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { errorMessage } from '../lib/load-failure.js';
import {
  QUOTATIONS_HASH,
  challanHash,
  issueChallanHash,
  navigateOnClick,
  workHash,
} from '../lib/workspace-routes.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Card } from '../ui/card.js';
import { PageHeader } from '../ui/page-header.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { SerialTrace } from './SerialTrace.js';

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
 * What the search reads across, in the frozen mock's own vocabulary
 * (`lib/search` and `app/search/page` at fdfe5ef).
 *
 * The mock offers nine scopes; this build offers the seven whose hits
 * have somewhere to land. Contacts is omitted for the reason
 * `shell/navigation.ts` applies to the modules the mock draws and this
 * build has no route for: a control that would return nothing.
 *
 * Correspondence is omitted for a different reason now that migration
 * 0086 has built the register. Every scope here answers with a row that
 * OPENS something, and a letter has no record page to open: the design
 * contract draws the register and its two composers and no detail screen,
 * so a correspondence hit could only land on the unfiltered register —
 * which is what the rail already does, in one click, without a search.
 * The convergence path is upstream: when the mock grows a letter detail
 * screen, the scope earns its place. Recorded in `docs/UX.md`.
 *
 * `kinds` is the set of server result groups the scope keeps. `serials`
 * holds none of them: serial numbers are deliberately outside the record
 * search (`packages/contracts/src/search.ts`) because their answer is a
 * lineage rather than a row, so that scope runs the serial lookup
 * instead — see `SERIAL_SCOPES` below.
 */
type SearchScope =
  | 'all'
  | 'works'
  | 'challans'
  | 'invoices'
  | 'purchase-orders'
  | 'quotations'
  | 'serials';

interface ScopeOption {
  readonly value: SearchScope;
  readonly label: string;
  /** The server result groups this scope keeps, or `null` for all of
   * them. An empty list keeps none — see `serials` below. */
  readonly kinds: readonly SearchResultKind[] | null;
}

const EVERYTHING: ScopeOption = { value: 'all', label: 'Everything', kinds: null };

const SCOPES: readonly ScopeOption[] = [
  EVERYTHING,
  { value: 'works', label: 'Works', kinds: ['work'] },
  {
    value: 'challans',
    label: 'Challans',
    kinds: ['delivery-challan', 'issue-challan'],
  },
  { value: 'invoices', label: 'Invoices', kinds: ['tax-invoice', 'credit-note'] },
  { value: 'purchase-orders', label: 'Purchase orders', kinds: ['purchase-order'] },
  { value: 'quotations', label: 'Quotations', kinds: ['quotation'] },
  { value: 'serials', label: 'Installations & serials', kinds: [] },
];

/** The scopes that render the serial traceability chain. Everything shows
 * it beside the document groups; the serials scope shows it alone. */
const SERIAL_SCOPES: readonly SearchScope[] = ['all', 'serials'];

function scopeOf(value: SearchScope): ScopeOption {
  return SCOPES.find((scope) => scope.value === value) ?? EVERYTHING;
}

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
  onOpenQuotations,
}: SearchProps) {
  const [draft, setDraft] = useState(query);
  /** Scope is a reading preference over one query, not a destination:
   * it stays out of the route so Back walks the searches an operator
   * made rather than the lenses they tried on one of them. */
  const [scope, setScope] = useState<SearchScope>('all');
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

  const trimmed = query.trim();
  const active = scopeOf(scope);
  /** The serials scope asks nothing of the record search: its whole
   * answer comes from the serial lookup below, and firing a search whose
   * every group would then be filtered away would be a request made to
   * be discarded. */
  const documentsWanted = active.kinds === null || active.kinds.length > 0;

  useEffect(() => {
    if (trimmed.length < 2 || !documentsWanted) {
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
        setError(errorMessage(cause, 'The search could not be completed.'));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, trimmed, documentsWanted, attempt]);

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

  /* The scope is applied to the one response rather than to the request:
     the server searches every register in a single pass, so narrowing
     the reading is a filter, not a second round trip. */
  const kinds = active.kinds;
  const groups =
    result === null
      ? []
      : kinds === null
        ? result.groups
        : result.groups.filter((group) => kinds.includes(group.kind));
  const hasResults = groups.length > 0;
  const showSerials = SERIAL_SCOPES.includes(scope);

  return (
    <>
      <PageHeader
        eyebrow="Find anything"
        titleId="search-title"
        title="Global search"
        description="Every Work, schedule item, serial number, reference and document from one place — by number, by Work, or by the party named on the document."
      />
      {/* The mock's search card: one bordered surface holding the box and
          the scope, with the results as plain sections beneath it rather
          than nested inside it (`app/search/page`). */}
      <Card className="w-full border-primary/20">
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
              placeholder="Work code, challan or invoice number, serial, party name"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
          </div>
          <div className="min-w-44">
            <label htmlFor="search-scope" className="block text-xs font-medium">
              Search inside
            </label>
            <select
              id="search-scope"
              name="search-scope"
              className="w-full"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as SearchScope);
              }}
            >
              {SCOPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={pending}>
            Search
          </Button>
        </form>
      </Card>

      {trimmed.length > 0 && trimmed.length < 2 && (
        <p className="text-muted-foreground" role="status">
          Enter at least two characters.
        </p>
      )}

      {error !== null && (
        <ErrorState
          onRetry={() => {
            setAttempt((current) => current + 1);
          }}
        >
          {error}
        </ErrorState>
      )}

      {pending && <LoadingState label="the search results" rows={3} columns={3} />}

      {!pending && error === null && result !== null && !hasResults && (
        <EmptyState>
          Nothing in{' '}
          {active.kinds === null ? 'the registers' : active.label.toLowerCase()} matches
          “{result.query}”.
        </EmptyState>
      )}

      {!pending && error === null && hasResults && (
        <>
          <p className="text-muted-foreground" role="status">
            {groups.reduce((total, group) => total + group.results.length, 0)} matching
            documents for “{result?.query ?? trimmed}”.
          </p>
          {groups.map((group) => (
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

      {/* Serials are one scope of this screen rather than a destination of
          their own (`docs/UX.md` § `#/serials` merges into Global Search).
          The chain a hit opens is unchanged: Work, item, Delivery Challan
          and its state, receipt, and where and when the unit went in. */}
      {showSerials && trimmed.length >= 2 && (
        <section aria-labelledby="search-group-serials">
          <h2 id="search-group-serials">Installations &amp; serials</h2>
          <SerialTrace
            api={api}
            organisationId={organisationId}
            query={trimmed}
            onOpenWork={onOpenWork}
            onOpenChallan={onOpenChallan}
          />
        </section>
      )}
    </>
  );
}
