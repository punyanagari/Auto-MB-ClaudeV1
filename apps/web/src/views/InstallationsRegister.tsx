import { useEffect, useState } from 'react';
import type { InstallationRegisterEntry } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { navigateOnClick, workHash } from '../lib/workspace-routes.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

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
 */

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
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped by the failure state's retry, to re-run the load below. */
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setInstallations(null);
    setLoadError(null);
    api
      .listInstallations(organisationId)
      .then((loaded) => {
        if (!cancelled) setInstallations(loaded);
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
  }, [api, organisationId, loadVersion]);

  function retry(): void {
    setLoadVersion((current) => current + 1);
  }

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
                      {/* A real link, so a Work can be middle-clicked into
                          its own tab; a left click stays in-app. */}
                      <a
                        href={workHash(row.workId, 'installations')}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                        onClick={navigateOnClick(() => {
                          onOpenWork(row.workId);
                        })}
                      >
                        {row.workCode}
                      </a>
                      <span className="block text-xs text-muted-foreground">
                        {row.workTitle}
                      </span>
                    </th>
                    <td>{row.itemNumber}</td>
                    <td className={numericCell}>{row.quantity}</td>
                    <td className={numericCell}>{formatDate(row.installedOn)}</td>
                    <td className={wrapCell}>{row.locationName}</td>
                    <td className={numericCell}>
                      {row.serialCount > 0 ? row.serialCount : '—'}
                    </td>
                    <td>
                      {row.status === 'cancelled' ? (
                        <StatusChip status="cancelled" />
                      ) : (
                        <StatusChip status="installed">recorded</StatusChip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
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
