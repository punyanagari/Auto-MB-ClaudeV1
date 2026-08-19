import type { BillListResponse, MbEntry } from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { DataTable, numericCell } from '../ui/table.js';
import { FormError } from '../ui/form.js';
import { MeasurementBooks } from './MeasurementBooks.js';

interface WorkMeasurementProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly mbEntries: readonly MbEntry[];
  readonly mbEntriesState: 'loading' | 'unavailable' | 'ready';
  readonly challanNumberById: ReadonlyMap<string, string | null>;
  readonly challansState: 'loading' | 'unavailable' | 'ready';
  /** Applies a re-read of the Work's bills — the list AND the summary
   * above it, which is why this takes the whole response rather than a
   * bills array. Preparing a bill from a Measurement Book moves both. */
  readonly setBills: (bills: BillListResponse) => void;
  readonly billsState: 'loading' | 'unavailable' | 'ready';
  readonly canCreateDocuments: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  /** The page's shared action runner: reports, refreshes, and clears. */
  readonly act: (run: () => Promise<void>, message: string) => Promise<void>;
  /** Forwarded to MeasurementBooks so the tab badge tracks the books
   * this tab loads itself. */
  readonly onBooksKnown: (count: number) => void;
}

/** What has been measured against this Work — the loose entries and the
 * stage-wise Measurement Books they are finalized into. Split out of
 * WorkDetail, which was rendering eleven areas from one file. */
export function WorkMeasurement({
  api,
  organisationId,
  workId,
  mbEntries,
  mbEntriesState,
  challanNumberById,
  challansState,
  setBills,
  billsState,
  canCreateDocuments,
  canIssue,
  canCancel,
  act,
  onBooksKnown,
}: WorkMeasurementProps) {
  return (
    <>
      {/* Finding 30: this register is SITE MEASUREMENT EVIDENCE — the
          loose mb_entries the formal, numbered Measurement Books below
          draw on. It must not present itself as the Measurement Book,
          and the retired billed/unbilled reading (billing runs through
          Measurement Books since ADR-0006) is gone with it. */}
      {mbEntriesState === 'unavailable' ? (
        <>
          <h2>Measurement evidence</h2>
          <FormError>
            Measurement evidence could not be loaded. The formal Measurement Books
            remain available below.
          </FormError>
        </>
      ) : mbEntriesState === 'loading' ? (
        <>
          <h2>Measurement evidence</h2>
          <p className="text-muted-foreground" role="status">
            Loading measurement evidence…
          </p>
        </>
      ) : (
        <>
          <h2>Measurement evidence</h2>
          <p className="text-muted-foreground">
            Site measurements recorded as evidence. Billing runs through the formal
            Measurement Books below, which sweep delivered and installed quantities —
            not these entries.
          </p>
          {mbEntries.length > 0 ? (
            <DataTable>
              <caption className="sr-only">
                Site measurement evidence recorded for this Work
              </caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className={numericCell}>
                    Quantity
                  </th>
                  <th scope="col">Measured on</th>
                  <th scope="col">Challan</th>
                  <th scope="col">Book reference</th>
                </tr>
              </thead>
              <tbody>
                {mbEntries.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{entry.itemNumber}</th>
                    <td className={numericCell}>{entry.measuredQuantity}</td>
                    <td>{formatDate(entry.measuredOn)}</td>
                    <td>
                      {entry.deliveryChallanId === null
                        ? '—'
                        : challansState === 'ready'
                          ? (challanNumberById.get(entry.deliveryChallanId) ?? '—')
                          : challansState === 'loading'
                            ? 'Loading…'
                            : 'Unavailable'}
                    </td>
                    <td>{entry.mbBookRef ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <p className="text-muted-foreground">No measurements recorded yet.</p>
          )}
          {/* The loose register is now READ-ONLY. Its manual form was the
              Milestone-5 way to measure, and ADR-0006 decision 2 replaced
              its billing role with bills raised from a finalized
              Measurement Book — so a Work could be measured two ways
              that never met, one of which no longer reaches a bill. The
              rows already recorded stay: they still gate challan
              cancellation and still export. New measurement happens in
              the Measurement Books below, which is where the operator is
              sent rather than left to find it. */}
          {canCreateDocuments && (
            <p className="text-muted-foreground">
              New measurement is recorded in a Measurement Book, below — it sweeps
              the delivered and installed quantities itself, so nothing is typed
              twice.
            </p>
          )}
        </>
      )}

      <MeasurementBooks
        api={api}
        organisationId={organisationId}
        workId={workId}
        canModify={canCreateDocuments}
        canIssue={canIssue}
        canPrepareBill={billsState === 'ready'}
        canCancel={canCancel}
        onBooksKnown={onBooksKnown}
        onBillPrepared={() => {
          // Through the page's shared runner so a failed refresh surfaces
          // as an action error instead of vanishing as an unhandled
          // rejection — the bill itself is already prepared either way.
          void act(async () => {
            setBills(await api.listBills(organisationId, workId));
          }, 'Bills list refreshed.');
        }}
      />
    </>
  );
}
