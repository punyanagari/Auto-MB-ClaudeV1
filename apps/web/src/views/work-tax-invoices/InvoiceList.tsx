import type { TaxInvoice } from '@auto-mb/contracts';
import { formatDate, formatInr } from '../../format.js';
import { Button } from '../../ui/button.js';
import { StatusChip } from '../../ui/chip.js';
import { DataTable, numericCell } from '../../ui/table.js';

interface InvoiceListProps {
  readonly invoices: readonly TaxInvoice[];
  readonly pending: boolean;
  readonly onOpen: (invoiceId: string, label: string) => void;
}

/** The Work's tax-invoice register: number, MB, date, status signals
 * (including the frozen IRP reporting window) and frozen total. */
export function InvoiceList({ invoices, pending, onOpen }: InvoiceListProps) {
  if (invoices.length === 0) {
    return (
      <p className="text-muted-foreground">
        No tax invoice has been raised for this Work yet.
      </p>
    );
  }
  return (
    <DataTable>
      <caption className="sr-only">Tax invoices raised for this Work</caption>
      <thead>
        <tr>
          <th scope="col">Number</th>
          <th scope="col">Measurement Book</th>
          <th scope="col">Date</th>
          <th scope="col">Status</th>
          <th scope="col" className={numericCell}>
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((row) => (
          <tr key={row.id}>
            <th scope="row">
              <Button
                variant="link"
                size="inline"
                className="font-medium"
                onClick={() => {
                  onOpen(row.id, row.invoiceNumber ?? 'draft');
                }}
                disabled={pending}
              >
                {row.invoiceNumber ?? 'Draft'}
              </Button>
            </th>
            <td>{row.mbNumber ?? '—'}</td>
            <td>{formatDate(row.invoiceDate)}</td>
            <td>
              <StatusChip status={row.status}>{row.status}</StatusChip>
              {row.irn !== null && (
                <StatusChip status="issued">
                  {row.irpProvider === 'whitebooks'
                    ? 'IRP registered'
                    : 'manual IRP evidence · unverified'}
                </StatusChip>
              )}
              {/* The frozen reporting window (migration 0049): amber
                  while it is open, red once it has lawfully closed.
                  A signal only — local validity never changes. */}
              {row.status === 'submitted' &&
                (row.irpReportingOverdue ? (
                  <StatusChip status="expired">IRP overdue</StatusChip>
                ) : (
                  row.irpReportingDeadline !== null &&
                  row.irpProviderState !== 'registered' && (
                    <StatusChip status="review">
                      IRP due {formatDate(row.irpReportingDeadline)}
                    </StatusChip>
                  )
                ))}
            </td>
            <td className={numericCell}>
              {row.totalAmount === null ? '—' : formatInr(row.totalAmount)}
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}
