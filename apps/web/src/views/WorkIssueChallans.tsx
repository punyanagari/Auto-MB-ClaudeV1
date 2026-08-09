import type { IssueChallan } from '@auto-mb/contracts';

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
      <div className="card__header">
        <h2>Issue Challans</h2>
        {canCreateDocuments &&
          (issueChallans?.some((challan) => challan.status === 'draft') === true ? (
            <button
              type="button"
              onClick={() => {
                const draft = issueChallans.find(
                  (challan) => challan.status === 'draft',
                );
                if (draft) onOpenIssueChallan(draft.id);
              }}
            >
              Open draft Issue Challan
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                onNewIssueChallan(workId);
              }}
            >
              New Issue Challan
            </button>
          ))}
      </div>
      {issueChallans !== null && issueChallans.length > 0 ? (
        <table className="data-table">
          <caption className="visually-hidden">Issue Challans for this Work</caption>
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
                  <button
                    type="button"
                    className="button--link"
                    onClick={() => {
                      onOpenIssueChallan(challan.id);
                    }}
                  >
                    {challan.challanNumber ?? 'Draft'}
                  </button>
                </th>
                <td>{MOVEMENT_LABELS[challan.movementType]}</td>
                <td>{challan.challanDate}</td>
                <td className="cell--wrap">{challan.issuedToName}</td>
                <td>
                  <span className={`chip chip--${challan.status}`}>
                    {challan.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">
          No Issue Challans yet. Issue Challans record material sent out to site, job
          work, loans, and returns.
        </p>
      )}
    </>
  );
}
