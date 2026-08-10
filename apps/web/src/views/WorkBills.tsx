import type { Dispatch, SetStateAction } from 'react';
import type { Bill } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formatInr, formatRate } from '../format.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { CardHeader } from '../ui/card.js';
import { DataTable, numericCell } from '../ui/table.js';
import { Actions } from '../ui/form.js';

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
      <CardHeader>
        <h2>Bills</h2>
      </CardHeader>
      {canIssue && (
        <p className="text-muted-foreground">
          Bills are prepared from a finalized stage-wise Measurement Book — use the
          Measurement Books section below.
        </p>
      )}
      {bills.length > 0 ? (
        bills.map((bill) => (
          <div key={bill.id}>
            <h3>
              Bill #{bill.billNumber} <StatusChip status={bill.status} />
            </h3>
            <DataTable>
              <caption className="sr-only">Lines of bill {bill.billNumber}</caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Unit</th>
                  <th scope="col" className={numericCell}>
                    Quantity
                  </th>
                  <th scope="col" className={numericCell}>
                    Rate
                  </th>
                  <th scope="col" className={numericCell}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {billLines(bill.linesSnapshot).map((line) => (
                  <tr key={`${bill.id}-${line.itemNumber}`}>
                    <th scope="row">{line.itemNumber}</th>
                    <td>{line.unitCode}</td>
                    <td className={numericCell}>{line.quantity}</td>
                    <td className={numericCell}>{formatRate(line.rate)}</td>
                    <td className={numericCell}>{formatInr(line.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" colSpan={4}>
                    Total
                  </th>
                  <td className={numericCell}>
                    <strong>{formatInr(bill.totalAmount)}</strong>
                  </td>
                </tr>
              </tbody>
            </DataTable>
            {canIssue && bill.status !== 'paid' && (
              <Actions>
                <Button
                  variant="outline"
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
                </Button>
              </Actions>
            )}
          </div>
        ))
      ) : (
        <p className="text-muted-foreground">No bills prepared yet.</p>
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
