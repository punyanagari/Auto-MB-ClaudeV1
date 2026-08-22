import { useEffect, useState } from 'react';
import type { ImportedPayment, ImportedPaymentList } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formatDate, formatInr } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { workspaceHashOf } from '../lib/workspace-routes.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * What this Work has actually been PAID, on the tab that lists what it has
 * been billed (migration 0120).
 *
 * The panel above it answers "what was billed before this system"; this
 * answers the question that follows immediately — what came back, and what
 * the railway kept. Three figures rather than one, because money the
 * railway withheld is settled money: a panel showing only bank credits
 * would read as a Work paid short by its own statutory deductions.
 *
 * Deliberately SHORT, on `WorkHistoricalInvoices`'s terms exactly: the
 * whole register is one click away in the footer, and what belongs on the
 * Work is "is there any, how much, and what was withheld". The per-head
 * breakdown lives on the register, because five heads per receipt across
 * ten receipts is a screen of its own.
 *
 * Nothing here is recorded, edited or settled: a receipt is a record of a
 * voucher another system wrote.
 */

/** How many rows the panel draws. */
const PANEL_ROWS = 10;

interface WorkRailwayReceiptsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
}

export function WorkRailwayReceipts({
  api,
  organisationId,
  workId,
}: WorkRailwayReceiptsProps) {
  const [payments, setPayments] = useState<readonly ImportedPayment[] | null>(null);
  const [totals, setTotals] = useState<ImportedPaymentList['totals']>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setPayments(null);
    setTotals(null);
    setLoadError(null);
    api
      .listImportedPayments(organisationId, { work: workId, limit: PANEL_ROWS })
      .then((page) => {
        if (cancelled) return;
        setPayments(page.payments);
        // The totals ride the first page only, and this panel never asks
        // for a second one.
        setTotals(page.totals);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          errorMessage(
            cause,
            'The railway receipts for this Work could not be loaded.',
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  const registerHash = workspaceHashOf({
    view: { name: 'historical-receipts', workId },
  });

  return (
    <section
      aria-labelledby="work-railway-receipts-title"
      className="flex flex-col gap-3"
    >
      <h2 id="work-railway-receipts-title" className="text-sm font-semibold">
        Railway receipts
      </h2>
      <p className="text-[13px] text-muted-foreground">
        What the railway paid against this Work before this system, and what it
        withheld. Read-only — nothing measures, bills or settles against them.
      </p>

      {loadError !== null && (
        <ErrorState onRetry={retry} retryLabel="Retry railway receipts">
          {loadError}
        </ErrorState>
      )}
      {loadError === null && payments === null && (
        <LoadingState label="the railway receipts" rows={3} columns={4} />
      )}

      {payments !== null &&
        (payments.length > 0 ? (
          <>
            <DataTable>
              <caption className="sr-only">
                Railway receipts filed against this Work, with what was settled, what
                was received and what was deducted
              </caption>
              <thead>
                <tr>
                  <th scope="col">Receipt</th>
                  <th scope="col">Date</th>
                  <th scope="col">Paid by</th>
                  <th scope="col" className={numericCell}>
                    Settled
                  </th>
                  <th scope="col" className={numericCell}>
                    Received
                  </th>
                  <th scope="col" className={numericCell}>
                    Deducted
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className="font-mono">
                      {row.voucherNumber ?? '—'}
                    </th>
                    <td>{formatDate(row.voucherDate)}</td>
                    <td className={wrapCell}>{row.counterpartyLedger}</td>
                    <td className={numericCell}>{formatInr(row.gross)}</td>
                    <td className={numericCell}>{formatInr(row.net)}</td>
                    <td className={numericCell}>{formatInr(row.deductionTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            <p className="text-[13px] text-muted-foreground">
              <span className="font-mono tabular-nums">
                {String(totals?.count ?? 0)}
              </span>{' '}
              receipt(s) on this Work:{' '}
              <span className="font-mono tabular-nums">
                {formatInr(totals?.gross ?? '0.00')}
              </span>{' '}
              settled, of which{' '}
              <span className="font-mono tabular-nums">
                {formatInr(totals?.deductionTotal ?? '0.00')}
              </span>{' '}
              was withheld.{' '}
              {/* A plain anchor, and no click handler: the destination is a
                  hash, so the shell's own hashchange listener does the
                  navigation and a middle-click opens the same address. */}
              <a href={registerHash}>Open the receipts register</a>.
            </p>
          </>
        ) : (
          <EmptyState>
            No railway receipt is filed against this Work. Imported receipts reach a
            Work through the work code on their security-deposit head, the bill they
            name or their narration, and one that reaches none is held in the
            register&rsquo;s own queue.
          </EmptyState>
        ))}
    </section>
  );
}
