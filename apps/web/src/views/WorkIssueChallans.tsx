import type { IssueChallan } from '@auto-mb/contracts';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { CardHeader } from '../ui/card.js';
import { DataTable, wrapCell } from '../ui/table.js';

const MOVEMENT_LABELS: Record<IssueChallan['movementType'], string> = {
  issue: 'Issue',
  loan: 'Loan',
  return: 'Return',
};

interface WorkIssueChallansProps {
  readonly workId: string;
  readonly issueChallans: readonly IssueChallan[] | null;
  readonly canCreateDocuments: boolean;
  readonly onNewIssueChallan: (workId: string) => void;
  readonly onOpenIssueChallan: (challanId: string) => void;
}

/** Issue Challans: material issued out to site, job work, loan or return.
 * Split out of WorkDetail, which was rendering eleven areas from one file. */
export function WorkIssueChallans({
  workId,
  issueChallans,
  canCreateDocuments,
  onNewIssueChallan,
  onOpenIssueChallan,
}: WorkIssueChallansProps) {
  return (
    <>
      <CardHeader>
        <h2>Issue Challans</h2>
        {issueChallans !== null &&
          canCreateDocuments &&
          (issueChallans?.some((challan) => challan.status === 'draft') === true ? (
            <Button
              onClick={() => {
                const draft = issueChallans.find(
                  (challan) => challan.status === 'draft',
                );
                if (draft) onOpenIssueChallan(draft.id);
              }}
            >
              Open draft Issue Challan
            </Button>
          ) : (
            <Button
              onClick={() => {
                onNewIssueChallan(workId);
              }}
            >
              New Issue Challan
            </Button>
          ))}
      </CardHeader>
      {issueChallans === null ? (
        <p className="text-muted-foreground" role="status">
          Loading Issue Challans…
        </p>
      ) : issueChallans.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Issue Challans for this Work</caption>
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
            {issueChallans.map((challan) => (
              <tr key={challan.id}>
                <th scope="row">
                  <Button
                    variant="link"
                    size="inline"
                    className="font-medium"
                    onClick={() => {
                      onOpenIssueChallan(challan.id);
                    }}
                  >
                    {challan.challanNumber ?? 'Draft'}
                  </Button>
                </th>
                <td>{MOVEMENT_LABELS[challan.movementType]}</td>
                <td>{challan.challanDate}</td>
                <td className={wrapCell}>{challan.issuedToName}</td>
                <td>
                  <StatusChip status={challan.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">
          No Issue Challans yet. Issue Challans record material sent out to site, job
          work, loans, and returns.
        </p>
      )}
    </>
  );
}
