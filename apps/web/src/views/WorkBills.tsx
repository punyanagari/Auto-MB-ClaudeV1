import type { Dispatch, SetStateAction } from 'react';
import type { Bill } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formatInr, formatRate } from '../format.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { CardHeader } from '../ui/card.js';
import { DataTable, numericCell } from '../ui/table.js';
import { Actions } from '../ui/form.js';

/** The Milestone 5 sweep shape: one row per swept mb_entry. Bills
 * prepared before ADR-0006 still carry it, so it still renders. */
interface LegacyBillLine {
  readonly itemNumber: string;
  readonly unitCode: string;
  readonly quantity: string;
  readonly rate: string;
  readonly amount: string;
}

/** The ADR-0006 shape: the finalized Measurement Book's lines verbatim
 * (stage deltas, effective rate, line total). Only the rendered subset
 * is named here. */
interface MbBillLine {
  readonly itemNumber: string;
  readonly unitCode: string;
  readonly deltaSupplied: string;
  readonly deltaInstalled: string;
  readonly deltaPac: string;
  readonly effectiveRate: string;
  readonly lineTotal: string;
}

type BillLines =
  | { readonly kind: 'legacy'; readonly lines: readonly LegacyBillLine[] }
  | { readonly kind: 'mb'; readonly lines: readonly MbBillLine[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLegacyLine(line: unknown): line is LegacyBillLine {
  return (
    isRecord(line) &&
    typeof line.itemNumber === 'string' &&
    typeof line.quantity === 'string' &&
    typeof line.amount === 'string'
  );
}

function isMbLine(line: unknown): line is MbBillLine {
  return (
    isRecord(line) &&
    typeof line.itemNumber === 'string' &&
    typeof line.lineTotal === 'string' &&
    typeof line.effectiveRate === 'string'
  );
}

/** Both snapshot generations, told apart by their fields. A bill whose
 * snapshot matches neither renders no rows — the total row still stands,
 * because totalAmount is a column of the bill itself. */
function billLines(snapshot: unknown): BillLines {
  if (!Array.isArray(snapshot)) return { kind: 'legacy', lines: [] };
  if (snapshot.every(isMbLine) && snapshot.length > 0) {
    return { kind: 'mb', lines: snapshot };
  }
  return { kind: 'legacy', lines: snapshot.filter(isLegacyLine) };
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
        bills.map((bill) => {
          const snapshot = billLines(bill.linesSnapshot);
          return (
            <div key={bill.id}>
              <h3>
                Bill #{bill.billNumber} <StatusChip status={bill.status} />
              </h3>
              {snapshot.kind === 'mb' ? (
                <DataTable scroll>
                  <caption className="sr-only">Lines of bill {bill.billNumber}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col">Unit</th>
                      <th scope="col" className={numericCell}>
                        Supplied Δ
                      </th>
                      <th scope="col" className={numericCell}>
                        Installed Δ
                      </th>
                      <th scope="col" className={numericCell}>
                        PAC Δ
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
                    {snapshot.lines.map((line) => (
                      <tr key={`${bill.id}-${line.itemNumber}`}>
                        <th scope="row">{line.itemNumber}</th>
                        <td>{line.unitCode}</td>
                        <td className={numericCell}>{line.deltaSupplied}</td>
                        <td className={numericCell}>{line.deltaInstalled}</td>
                        <td className={numericCell}>{line.deltaPac}</td>
                        <td className={numericCell}>
                          {formatRate(line.effectiveRate)}
                        </td>
                        <td className={numericCell}>{formatInr(line.lineTotal)}</td>
                      </tr>
                    ))}
                    <tr>
                      <th scope="row" colSpan={6}>
                        Total
                      </th>
                      <td className={numericCell}>
                        <strong>{formatInr(bill.totalAmount)}</strong>
                      </td>
                    </tr>
                  </tbody>
                </DataTable>
              ) : (
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
                    {snapshot.lines.map((line) => (
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
              )}
              {canIssue && bill.status !== 'paid' && (
                <Actions>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      const next = bill.status === 'prepared' ? 'submitted' : 'paid';
                      void act(async () => {
                        const updated = await api.setBillStatus(
                          organisationId,
                          bill.id,
                          {
                            status: next,
                          },
                        );
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
          );
        })
      ) : (
        <p className="text-muted-foreground">No bills prepared yet.</p>
      )}
    </>
  );
}
