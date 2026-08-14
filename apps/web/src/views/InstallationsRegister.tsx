import { useCallback, useEffect, useState } from 'react';
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
 * The list is paged and the window is a date range, for the same reason:
 * "this week" is the question, and a division that has been running for
 * two years has more installation records than any screen should ask for
 * in one request. The two date inputs are the only filter — a Work's own
 * records are read on the Work, and a status filter would offer to hide
 * exactly what the register exists to keep visible.
 */

/** One request's worth of rows. Large enough that the common answer — a
 * week, a division — arrives whole, small enough to be a bounded read. */
const PAGE_SIZE = 100;

interface InstallationsRegisterProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Opens a Work at its Installations tab; the workspace shell owns the
   * actual navigation so the dirty-editor guard still applies. */
  readonly onOpenWork: (workId: string) => void;
  readonly onOpenWorks: () => void;
}

export function InstallationsRegister({
  api,
  organisationId,
  onOpenWork,
  onOpenWorks,
}: InstallationsRegisterProps) {
  const [installations, setInstallations] = useState<
    readonly InstallationRegisterEntry[] | null
  >(null);
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
    setNextCursor(null);
    setLoadError(null);
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
  }, [fetchPage, loadVersion]);

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

  const filtered = dateWindow.from !== '' || dateWindow.to !== '';

  return (
    <>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-semibold tracking-widest text-primary uppercase">
            Site
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
