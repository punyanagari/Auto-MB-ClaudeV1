import type { Dispatch, SetStateAction } from 'react';
import type { Bill } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formatInr, formatRate } from '../format.js';

interface BillLine {
  readonly itemNumber: string;
  readonly unitCode: string;
  readonly quantity: string;
  readonly rate: string;
  readonly amount: string;
}

interface WorkBillsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly bills: readonly Bill[];
  readonly setBills: Dispatch<SetStateAction<readonly Bill[]>>;
  readonly canIssue: boolean;
  readonly pending: boolean;
  readonly act: (run: () => Promise<void>, message: string) => Promise<void>;
}

/** The Work's bills: what each one draws on, and how it moves from prepared to paid.
 * Split out of WorkDetail, which was rendering eleven areas from one file. */
export function WorkBills({
  api,
  organisationId,
  bills,
  setBills,
  canIssue,
  pending,
  act,
}: WorkBillsProps) {
  return (
    <>
      <div className="card__header">
        <h2>Bills</h2>
      </div>
      {canIssue && (
        <p className="muted">
          Bills are prepared from a finalized stage-wise Measurement Book — use the
          Measurement Books section below.
        </p>
      )}
      {bills.length > 0 ? (
        bills.map((bill) => (
          <div key={bill.id}>
            <h3>
              Bill #{bill.billNumber}{' '}
              <span className={`chip chip--${bill.status}`}>{bill.status}</span>
            </h3>
            <table className="data-table">
              <caption className="visually-hidden">
                Lines of bill {bill.billNumber}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Unit</th>
                  <th scope="col" className="cell--numeric">
                    Quantity
                  </th>
                  <th scope="col" className="cell--numeric">
                    Rate
                  </th>
                  <th scope="col" className="cell--numeric">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {billLines(bill.linesSnapshot).map((line) => (
                  <tr key={`${bill.id}-${line.itemNumber}`}>
                    <th scope="row">{line.itemNumber}</th>
                    <td>{line.unitCode}</td>
                    <td className="cell--numeric">{line.quantity}</td>
                    <td className="cell--numeric">{formatRate(line.rate)}</td>
                    <td className="cell--numeric">{formatInr(line.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" colSpan={4}>
                    Total
                  </th>
                  <td className="cell--numeric">
                    <strong>{formatInr(bill.totalAmount)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
            {canIssue && bill.status !== 'paid' && (
              <div className="actions">
                <button
                  type="button"
                  className="button--ghost"
                  disabled={pending}
                  onClick={() => {
                    const next = bill.status === 'prepared' ? 'submitted' : 'paid';
                    void act(async () => {
                      const updated = await api.setBillStatus(organisationId, bill.id, {
                        status: next,
                      });
                      setBills((current) =>
                        current.map((candidate) =>
                          candidate.id === updated.id ? updated : candidate,
                        ),
                      );
                    }, `Bill #${bill.billNumber} marked ${next}.`);
                  }}
                >
                  {bill.status === 'prepared' ? 'Mark submitted' : 'Mark paid'}
                </button>
              </div>
            )}
          </div>
        ))
      ) : (
        <p className="muted">No bills prepared yet.</p>
      )}
    </>
  );
}

function billLines(snapshot: unknown): readonly BillLine[] {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.filter(
    (line): line is BillLine =>
      typeof line === 'object' &&
      line !== null &&
      typeof (line as BillLine).itemNumber === 'string' &&
      typeof (line as BillLine).quantity === 'string' &&
      typeof (line as BillLine).amount === 'string',
  );
}
