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
 * It reads ONE Work, unlike its sibling. An issue challan is only ever
 * listed per Work — `GET /api/works/:id/issue-challans` is the only list
 * the server offers — so without the module's `?work=` deep link there
 * is nothing honest to show, and the tab says where the Work is chosen
 * instead of inventing a cross-Work list the server cannot answer.
 *
 * ponytail: the mock's issue tab reads across Works. Closing that gap is
 * an org-wide `GET /api/issue-challans` register endpoint with its own
 * work-scope predicate and keyset — server work this pack does not own.
 */

const MOVEMENT_LABELS: Record<IssueChallan['movementType'], string> = {
  issue: 'Issue',
  loan: 'Loan',
  return: 'Return',
};

interface IssueChallansProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The Work the module's `?work=` deep link names, or null. */
  readonly workId: string | null;
  readonly onOpenIssueChallan: (workId: string, challanId: string) => void;
  /** Sends the operator to the Works register to pick one. */
  readonly onChooseWork: () => void;
}

export function IssueChallans({
  api,
  organisationId,
  workId,
  onOpenIssueChallan,
  onChooseWork,
}: IssueChallansProps) {
  const [challans, setChallans] = useState<readonly IssueChallan[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped by the failure state's retry, to re-run the load below. */
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    if (workId === null) {
      setChallans([]);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setChallans(null);
    setLoadError(null);
    api
      .listIssueChallans(organisationId, workId)
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
        (workId === null ? (
          <EmptyState action={{ label: 'Choose a Work', onClick: onChooseWork }}>
            Issue challans are numbered inside the Work that issues them, so this
            register reads one Work at a time.
          </EmptyState>
        ) : challans.length === 0 ? (
          <EmptyState>
            No issue challans for this Work yet. An issue challan records material sent
            out to site, job work, a loan, or a return.
          </EmptyState>
        ) : (
          <DataTable>
            <caption className="sr-only">
              Issue challans for this Work with movement, date, recipient, and status
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
                      href={issueChallanHash(workId, challan.id)}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                      onClick={navigateOnClick(() => {
                        onOpenIssueChallan(workId, challan.id);
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
                  <td className={wrapCell}>{challan.issuedToName}</td>
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
