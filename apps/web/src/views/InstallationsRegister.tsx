import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { InstallationRegisterEntry } from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DateField } from '../ui/date-field.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { WorkLink } from '../ui/work-link.js';

/**
 * The installation register — every recorded installation, across Works.
 *
 * Installations have always been reachable one Work at a time, which
 * answers "how far is this contract" and cannot answer the question site
 * supervision actually asks: what went in this week, and where. A gang
 * works several Works in a day; a division reads its own progress by
 * date and location, not by contract.
 *
 * Reading only. Recording stays on the Work, because an installation is
 * capped by that Work's sanctioned quantity and drawn from that Work's
 * delivered serials — a record with no Work in front of it would be a
 * form that has to ask which Work first, which is the Work page. Every
 * row therefore links to its Work's Installations tab, where the record
 * can be read in full and cancelled.
 *
 * Cancelled records are listed with their status rather than hidden: the
 * register reports what was recorded, not only what still stands.
 *
 * Two readings, one screen (the mock's `?work=` deep link,
 * `components/document-register.tsx` at fdfe5ef):
 *
 * - **Across Works** — the register endpoint, paged, narrowed by a date
 *   window. "This week, this division" is a date range and nothing else,
 *   which is why the window is the only filter the register query carries.
 * - **One Work** — the Work's own installation read, the same one its
 *   Installations tab makes, named by a dismissible chip whose clear
 *   control returns to the register. The date window is not offered here:
 *   it exists to bound a cross-Work list, and a single Work's records are
 *   already bounded by the Work.
 *
 * The narrowed reading deliberately does NOT filter the register's pages
 * in the browser. A Work whose last installation predates the current page
 * would render as "no records" under a chip naming it, which is a quieter
 * kind of wrong than a second read.
 */

/** One request's worth of rows. Large enough that the common answer — a
 * week, a division — arrives whole, small enough to be a bounded read. */
const PAGE_SIZE = 100;

interface InstallationsRegisterProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The `?work=` deep link. Null reads across every Work in reach. */
  readonly workId: string | null;
  /** Opens a Work at its Installations tab; the workspace shell owns the
   * actual navigation so the dirty-editor guard still applies. */
  readonly onOpenWork: (workId: string) => void;
  readonly onOpenWorks: () => void;
  /** The filter chip's clear control: back to the unfiltered register. */
  readonly onClearWorkFilter: () => void;
}

/** What the narrowed reading is a reading OF. Held beside the rows so the
 * chip can name the Work on a cold load — a bookmarked or refreshed deep
 * link has nothing else to read the code off. */
interface WorkFilter {
  readonly workCode: string;
  readonly workTitle: string;
}

export function InstallationsRegister({
  api,
  organisationId,
  workId,
  onOpenWork,
  onOpenWorks,
  onClearWorkFilter,
}: InstallationsRegisterProps) {
  const [installations, setInstallations] = useState<
    readonly InstallationRegisterEntry[] | null
  >(null);
  const [workFilter, setWorkFilter] = useState<WorkFilter | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** The window the operator has actually asked for, as opposed to what
   * they are still typing: the inputs are uncontrolled and only applied
   * on submit, so a half-typed year never fires a request. */
  const [dateWindow, setDateWindow] = useState<{
    readonly from: string;
    readonly to: string;
  }>({ from: '', to: '' });
  /** Bumped by the failure state's retry, to re-run the load below. */
  const [loadVersion, setLoadVersion] = useState(0);

  const fetchPage = useCallback(
    (cursor?: string) =>
      api.listInstallations(organisationId, {
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(dateWindow.from !== '' ? { installedFrom: dateWindow.from } : {}),
        ...(dateWindow.to !== '' ? { installedTo: dateWindow.to } : {}),
      }),
    [api, organisationId, dateWindow],
  );

  useEffect(() => {
    let cancelled = false;
    setInstallations(null);
    setWorkFilter(null);
    setNextCursor(null);
    setLoadError(null);

    if (workId === null) {
      fetchPage()
        .then((page) => {
          if (cancelled) return;
          setInstallations(page.installations);
          setNextCursor(page.nextCursor);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setLoadError(
            cause instanceof RequestFailedError
              ? cause.message
              : 'The installation records could not be loaded.',
          );
        });
      return () => {
        cancelled = true;
      };
    }

    /* One failure state, because these are not independent reads: a chip
       with no Work to name and rows with no chip over them are each half
       of the narrowed reading, and neither is worth rendering alone. */
    Promise.all([
      api.getWork(organisationId, workId),
      api.listWorkInstallations(organisationId, workId),
    ])
      .then(([detail, records]) => {
        if (cancelled) return;
        setWorkFilter({ workCode: detail.work.workCode, workTitle: detail.work.title });
        setInstallations(
          records.installations.map((record) => ({
            id: record.id,
            workId: detail.work.id,
            workCode: detail.work.workCode,
            workTitle: detail.work.title,
            workItemId: record.workItemId,
            itemNumber: record.itemNumber,
            quantity: record.quantity,
            installedOn: record.installedOn,
            locationName: record.locationName,
            serialCount: record.serials.length,
            status: record.status,
          })),
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'This Work’s installation records could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, fetchPage, loadVersion]);

  function retry(): void {
    setLoadVersion((current) => current + 1);
  }

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    setPending(true);
    setLoadError(null);
    try {
      const page = await fetchPage(nextCursor);
      setInstallations((current) => [...(current ?? []), ...page.installations]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setLoadError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The next page of installation records could not be loaded.',
      );
    } finally {
      setPending(false);
    }
  }

  const narrowed = workId !== null;
  const filtered = dateWindow.from !== '' || dateWindow.to !== '';

  return (
    <>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-semibold tracking-widest text-primary uppercase">
            Operations
          </p>
          <h1 id="installations-title" tabIndex={-1}>
            Installations
          </h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Every quantity recorded as installed at site, newest first, across the Works
            you can reach. Recording happens on the Work, which is what caps the
            quantity and holds the delivered serials.
          </p>
        </div>
      </header>

      <section aria-labelledby="installations-title" className="flex flex-col gap-4">
        {/* The mock's `?work=` chip: it names the Work the register has
            been narrowed to, and its clear control is the way back to the
            whole register. Rendered from the Work's own record rather than
            from the rows, so a cold deep link still names it. */}
        {narrowed && workFilter !== null && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Filtered to</span>
            <span className="inline-flex items-center gap-2 rounded-md border border-primary/20 bg-primary/10 py-0.5 pr-1 pl-2 text-[13px] text-primary">
              <span className="font-mono font-semibold">{workFilter.workCode}</span>
              <span className="max-w-64 truncate text-primary/80">
                {workFilter.workTitle}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClearWorkFilter}
                aria-label={`Clear the ${workFilter.workCode} filter and read the whole register`}
              >
                <X aria-hidden="true" />
              </Button>
            </span>
          </div>
        )}

        {/* The window bounds a cross-Work list. A single Work's records are
            bounded by the Work, so the form is not offered there. */}
        {!narrowed && (
          <form
            className="flex flex-wrap items-end gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setDateWindow({
                from: formValue(data, 'installed-from'),
                to: formValue(data, 'installed-to'),
              });
            }}
          >
            <DateField
              id="installed-from"
              name="installed-from"
              label="Installed on or after"
              fieldClassName="my-0"
            />
            <DateField
              id="installed-to"
              name="installed-to"
              label="Installed on or before"
              fieldClassName="my-0"
            />
            <Button type="submit" variant="outline">
              Apply dates
            </Button>
          </form>
        )}

        {loadError !== null && (
          <ErrorState onRetry={retry} retryLabel="Retry installations">
            {loadError}
          </ErrorState>
        )}
        {loadError === null && installations === null && (
          <LoadingState label="the installation records" rows={5} columns={4} />
        )}

        {installations !== null &&
          (installations.length > 0 ? (
            <>
              <DataTable>
                <caption className="sr-only">
                  Installation records with Work, item, quantity, date, location, serial
                  count and status
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Work</th>
                    <th scope="col">Item</th>
                    <th scope="col" className={numericCell}>
                      Quantity
                    </th>
                    <th scope="col">Installed on</th>
                    <th scope="col">Location</th>
                    <th scope="col" className={numericCell}>
                      Serials
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {installations.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        <WorkLink
                          workId={row.workId}
                          workCode={row.workCode}
                          workTitle={row.workTitle}
                          tab="installations"
                          onOpenWork={onOpenWork}
                        />
                      </th>
                      <td>{row.itemNumber}</td>
                      <td className={numericCell}>{row.quantity}</td>
                      {/* Left-aligned, as the Delivery Challan register's date
                          column is: the two registers sit one nav item apart
                          and a date that changes side between them reads as a
                          different kind of column. */}
                      <td>{formatDate(row.installedOn)}</td>
                      <td className={wrapCell}>{row.locationName}</td>
                      <td className={numericCell}>
                        {row.serialCount > 0 ? row.serialCount : '—'}
                      </td>
                      <td>
                        <StatusChip status={row.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
              {nextCursor !== null && (
                <div>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => void loadMore()}
                  >
                    Load more installations
                  </Button>
                </div>
              )}
            </>
          ) : narrowed ? (
            <EmptyState
              action={{
                label: 'Read the whole register',
                onClick: onClearWorkFilter,
              }}
            >
              No installations have been recorded against this Work. Recording happens
              on the Work&rsquo;s own Installations tab.
            </EmptyState>
          ) : filtered ? (
            <EmptyState>
              No installations were recorded in these dates. Widen the window, or clear
              both dates to read the whole register.
            </EmptyState>
          ) : (
            <EmptyState action={{ label: 'Open Works', onClick: onOpenWorks }}>
              No installations recorded yet. An installation is recorded against its
              Work, on that Work&rsquo;s Installations tab.
            </EmptyState>
          ))}
      </section>
    </>
  );
}
