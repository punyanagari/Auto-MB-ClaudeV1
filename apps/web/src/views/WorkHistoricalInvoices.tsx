import { useEffect, useState } from 'react';
import type { ImportedInvoice } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formatDate, formatInr } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { workspaceHashOf } from '../lib/workspace-routes.js';
import { StatusChip } from '../ui/chip.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * What this Work was billed BEFORE this system, on the tab that lists what
 * it has been billed since (migration 0115).
 *
 * The Bills tab answers "what has this contract billed" and, until the
 * Zoho history was imported, answered it only from the cutover forwards —
 * so a Work carried three years of invoices nobody could see from the
 * Work. This panel closes that, and closes it as a READING rather than as
 * a second register: nothing here is drafted, issued, cancelled or
 * settled, because a historical invoice is a record of a document another
 * system issued.
 *
 * It is deliberately SHORT. A Work's whole historical billing is read in
 * the register, deep-linked from the footer below; what belongs on the
 * Work is the answer to "is there any, and roughly what" — the same
 * posture the Work's own registers take towards their cross-Work
 * siblings.
 */

/** How many rows the panel draws. Enough to see the shape of what was
 * billed; the register is one click away for the rest. */
const PANEL_ROWS = 10;

interface WorkHistoricalInvoicesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
}

export function WorkHistoricalInvoices({
  api,
  organisationId,
  workId,
}: WorkHistoricalInvoicesProps) {
  const [invoices, setInvoices] = useState<readonly ImportedInvoice[] | null>(null);
  const [total, setTotal] = useState<{
    readonly invoiceCount: number;
    readonly totalValue: string;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setInvoices(null);
    setTotal(null);
    setLoadError(null);
    api
      .listImportedInvoices(organisationId, { work: workId, limit: PANEL_ROWS })
      .then((page) => {
        if (cancelled) return;
        setInvoices(page.invoices);
        setTotal({
          invoiceCount: page.totals.invoiceCount,
          totalValue: page.totals.totalValue,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          errorMessage(
            cause,
            'The historical invoices for this Work could not be loaded.',
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  const registerHash = workspaceHashOf({
    view: { name: 'historical-invoices', workId },
  });

  return (
    <section
      aria-labelledby="work-historical-invoices-title"
      className="flex flex-col gap-3"
    >
      <h2 id="work-historical-invoices-title" className="text-sm font-semibold">
        Historical invoices
      </h2>
      <p className="text-[13px] text-muted-foreground">
        Billed against this Work in Zoho Books before this system. Read-only — nothing
        measures, bills or settles against them.
      </p>

      {loadError !== null && (
        <ErrorState onRetry={retry} retryLabel="Retry historical invoices">
          {loadError}
        </ErrorState>
      )}
      {loadError === null && invoices === null && (
        <LoadingState label="the historical invoices" rows={3} columns={4} />
      )}

      {invoices !== null &&
        (invoices.length > 0 ? (
          <>
            <DataTable>
              <caption className="sr-only">
                Historical invoices filed against this Work, with their number, date,
                customer, value and whether they reached the e-invoice portal
              </caption>
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Date</th>
                  <th scope="col">Customer</th>
                  <th scope="col" className={numericCell}>
                    Value
                  </th>
                  <th scope="col">e-Invoice</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className="font-mono">
                      {row.invoiceNumber}
                    </th>
                    <td>{formatDate(row.invoiceDate)}</td>
                    <td className={wrapCell}>{row.customerName}</td>
                    <td className={numericCell}>{formatInr(row.total)}</td>
                    <td>
                      <StatusChip status={row.issued ? 'issued' : 'draft'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            <p className="text-[13px] text-muted-foreground">
              <span className="font-mono tabular-nums">
                {String(total?.invoiceCount ?? 0)}
              </span>{' '}
              historical invoice(s) on this Work, billing{' '}
              <span className="font-mono tabular-nums">
                {formatInr(total?.totalValue ?? '0.00')}
              </span>
              .{' '}
              {/* A plain anchor, and no click handler: the destination is
                  a hash, so the shell's own hashchange listener does the
                  navigation and a middle-click opens the same address a
                  plain click produces. */}
              <a href={registerHash}>Open the historical register</a>.
            </p>
          </>
        ) : (
          <EmptyState>
            No invoice raised before this system is filed against this Work. Imported
            invoices are filed against a Work from the historical register.
          </EmptyState>
        ))}
    </section>
  );
}
