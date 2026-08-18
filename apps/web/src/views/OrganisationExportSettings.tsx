import { useCallback, useEffect, useState } from 'react';
import type { OrganisationExport } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formatTimestamp } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useAction, useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * The organisation's own copy of itself (migration 0096).
 *
 * `GET /api/export` has always produced the whole record, and it has
 * always done it synchronously into an owner's browser: minutes of
 * streaming that a proxy timeout, a laptop lid or a bad connection ends
 * with a truncated file and nothing to resume. This panel asks for the
 * same package to be BUILT, then hands it over as a file that survives a
 * closed tab — and expires, because a complete copy of the business is
 * not a thing to leave lying in storage.
 *
 * No mock screen; see `docs/UX.md` § 20. Card, dense data table, status
 * chip and button, exactly as the registers use them.
 *
 * The digest is printed in full and monospaced, not truncated. It is the
 * only way a recipient can check that the file they were handed is the
 * file this organisation built, and half a digest checks nothing —
 * `views/SigningQueue.tsx` prints its SHA-256 the same way and for the
 * same reason.
 */

interface OrganisationExportSettingsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The `can_export_org` authority. The server refuses regardless; this
   * is the door, not the lock. */
  readonly canExportOrg: boolean;
}

const STATE_CHIP: Record<OrganisationExport['state'], string> = {
  queued: 'pending',
  running: 'recording',
  ready: 'active',
  failed: 'rejected',
  expired: 'expired',
};

function describeState(record: OrganisationExport): string {
  switch (record.state) {
    case 'queued':
      return 'Waiting to start.';
    case 'running':
      return 'Being built. This takes a few minutes for a large organisation.';
    case 'ready':
      return record.expiresAt === null
        ? ''
        : `Available until ${formatTimestamp(record.expiresAt)}.`;
    case 'failed':
      return record.failureReason ?? 'The build did not finish.';
    case 'expired':
      return 'The file has been deleted. Request a new export.';
  }
}

export function OrganisationExportSettings({
  api,
  organisationId,
  canExportOrg,
}: OrganisationExportSettingsProps) {
  const [records, setRecords] = useState<readonly OrganisationExport[] | null>(null);
  const [retentionHours, setRetentionHours] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, reload] = useReload();
  const { pending, notice, actionError, act } = useAction();

  useEffect(() => {
    if (!canExportOrg) return;
    let cancelled = false;
    setRecords(null);
    setLoadError(null);
    api
      .listOrganisationExports(organisationId)
      .then((loaded) => {
        if (cancelled) return;
        setRecords(loaded.exports);
        setRetentionHours(loaded.retentionHours);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The export history could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, canExportOrg, loadVersion]);

  const requestExport = useCallback(
    () =>
      act(async () => {
        await api.requestOrganisationExport(organisationId);
        reload();
      }, 'The export is being built. Reload this panel in a few minutes.'),
    [act, api, organisationId, reload],
  );

  const download = useCallback(
    (record: OrganisationExport) =>
      act(async () => {
        // Fetched rather than linked: the tenant header travels on every
        // scoped request and an <a href> cannot carry one. The object URL
        // is revoked immediately — the click has already been handed to
        // the browser by then, and a whole-organisation blob is not
        // something to leave alive in the tab.
        const blob = await api.downloadOrganisationExport(organisationId, record.id);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `auto-mb-export-${record.id}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        reload();
      }, 'The export was downloaded.'),
    [act, api, organisationId, reload],
  );

  if (!canExportOrg) return null;

  const building = (records ?? []).some(
    (record) => record.state === 'queued' || record.state === 'running',
  );

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Organisation export</h2>
      </CardHeader>
      <p className="mt-1 text-xs text-muted-foreground">
        A complete copy of this organisation&rsquo;s record — every Work, challan,
        invoice, bill, payslip and audit event — as one JSON file. It is built in the
        background and stays downloadable for{' '}
        {retentionHours === 0 ? 'a limited period' : `${retentionHours / 24} days`},
        after which the file is deleted.
      </p>

      {loadError !== null && records === null ? (
        <ErrorState onRetry={reload} retryLabel="Retry the export history">
          {loadError}
        </ErrorState>
      ) : records === null ? (
        <LoadingState label="the export history" rows={2} columns={4} />
      ) : records.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            action={{
              label: 'Request an export',
              onClick: () => {
                void requestExport();
              },
            }}
          >
            No export has been taken of this organisation.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="mt-3">
            <DataTable>
              <caption className="sr-only">Exports taken of this organisation</caption>
              <thead>
                <tr>
                  <th scope="col">Requested</th>
                  <th scope="col">By</th>
                  <th scope="col">State</th>
                  <th scope="col" className={numericCell}>
                    Size
                  </th>
                  <th scope="col">Digest</th>
                  <th scope="col">Detail</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td className={numericCell}>
                      {formatTimestamp(record.requestedAt)}
                    </td>
                    <td>{record.requestedBy}</td>
                    <td>
                      <StatusChip status={STATE_CHIP[record.state]} />
                    </td>
                    <td className={numericCell}>
                      {record.byteSize === null
                        ? '—'
                        : `${Math.round(Number(record.byteSize) / 1024)} KB`}
                    </td>
                    <td className="font-mono text-[11px] break-all">
                      {record.sha256 ?? '—'}
                    </td>
                    <td className={wrapCell}>{describeState(record)}</td>
                    <td>
                      {record.state === 'ready' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => {
                            void download(record);
                          }}
                        >
                          Download
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button
              disabled={pending || building}
              onClick={() => {
                void requestExport();
              }}
            >
              Request an export
            </Button>
            {building && (
              <span className="text-xs text-muted-foreground">
                One export is already being built.
              </span>
            )}
            <Button variant="outline" size="sm" onClick={reload}>
              Refresh
            </Button>
          </div>
        </>
      )}

      {notice !== null && (
        <p className="alert success" role="status">
          {notice}
        </p>
      )}
      {actionError !== null && (
        <p className="alert error" role="alert">
          {actionError}
        </p>
      )}
    </Card>
  );
}
