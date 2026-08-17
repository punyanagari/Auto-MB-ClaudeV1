import { useEffect, useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { IssueChallan } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { issueChallanHash, navigateOnClick } from '../lib/workspace-routes.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/**
 * The issue tab of the Challans module — material leaving the store for
 * a site, a team, a job worker, or coming back.
 *
 * Ports the issue half of `components/document-register` at
 * `a8e1fde` (the mock's `?type=installation` tab): the same register
 * card, number-with-padlock cell and dot-and-label status the delivery
 * tab uses, so the two tabs read as one register with two contents.
 *
 * Two reads, one table. Without the module's `?work=` deep link it reads
 * `GET /api/issue-challans`, the organisation-wide register, and names
 * the Work each row belongs to the way the mock's document register does
 * — the code stacked above the recipient in one cell. Narrowed to a
 * Work, it reads that Work's own list (`GET /api/works/:id/issue-challans`),
 * which is the list the Work's screen shows and the one the numbering
 * series belongs to; the Work is named by the module's chip, so the row
 * does not repeat it.
 */

const MOVEMENT_LABELS: Record<IssueChallan['movementType'], string> = {
  issue: 'Issue',
  loan: 'Loan',
  return: 'Return',
};

/** A row of either read. `workCode` is null in the narrowed mode, where
 * the module's chip already names the Work. */
type Row = IssueChallan & { readonly workCode: string | null };

interface IssueChallansProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The Work the module's `?work=` deep link names, or null. */
  readonly workId: string | null;
  readonly onOpenIssueChallan: (workId: string, challanId: string) => void;
}

export function IssueChallans({
  api,
  organisationId,
  workId,
  onOpenIssueChallan,
}: IssueChallansProps) {
  const [challans, setChallans] = useState<readonly Row[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped by the failure state's retry, to re-run the load below. */
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setChallans(null);
    setLoadError(null);
    (workId === null
      ? api.listIssueChallanRegister(organisationId)
      : api
          .listIssueChallans(organisationId, workId)
          .then((list): readonly Row[] =>
            list.map((challan) => ({ ...challan, workCode: null })),
          )
    )
      .then((list) => {
        if (!cancelled) setChallans(list);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(
          error instanceof RequestFailedError
            ? error.message
            : 'The issue challans could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  return (
    <section aria-label="Issue challans" className="flex flex-col gap-4">
      {loadError !== null && (
        <ErrorState
          onRetry={() => {
            setLoadVersion((current) => current + 1);
          }}
          retryLabel="Retry issue challans"
        >
          {loadError}
        </ErrorState>
      )}
      {loadError === null && challans === null && (
        <LoadingState label="the issue challans" rows={5} columns={4} />
      )}

      {loadError === null &&
        challans !== null &&
        (challans.length === 0 ? (
          <EmptyState>
            {workId === null
              ? 'No issue challans yet. An issue challan records material sent out to site, job work, a loan, or a return.'
              : 'No issue challans for this Work yet. An issue challan records material sent out to site, job work, a loan, or a return.'}
          </EmptyState>
        ) : (
          <DataTable>
            <caption className="sr-only">
              {workId === null
                ? 'Issue challans across every Work, with movement, date, recipient, and status'
                : 'Issue challans for this Work with movement, date, recipient, and status'}
            </caption>
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Movement</th>
                <th scope="col">Date</th>
                <th scope="col">Issued to</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {challans.map((challan) => (
                <tr key={challan.id}>
                  <th scope="row">
                    {/* A real link, so an issue challan can be
                        middle-clicked into its own tab; a left click
                        stays in-app. */}
                    <a
                      href={issueChallanHash(challan.workId, challan.id)}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                      onClick={navigateOnClick(() => {
                        onOpenIssueChallan(challan.workId, challan.id);
                      })}
                    >
                      {challan.challanNumber ?? 'Number assigned on issue'}
                    </a>
                    {challan.status === 'issued' && (
                      <LockKeyhole
                        className="ml-2 inline size-3.5 text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                  </th>
                  <td>{MOVEMENT_LABELS[challan.movementType]}</td>
                  <td>{formatDate(challan.challanDate)}</td>
                  {/* The mock's "Work / consignee" cell: the Work code
                      above the recipient, mono, in the one column. Only
                      across Works — narrowed to one, the module's chip
                      names it and repeating it in every row is noise. */}
                  <td className={wrapCell}>
                    {challan.workCode !== null && (
                      <span className="block font-mono text-xs text-muted-foreground">
                        {challan.workCode}
                      </span>
                    )}
                    {challan.issuedToName}
                  </td>
                  <td>
                    <StatusChip status={challan.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ))}
    </section>
  );
}
