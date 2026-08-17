import type { BillListResponse, Challan, MbEntry, WorkItem } from '@auto-mb/contracts';
import type { Dispatch, SetStateAction } from 'react';
import { formValue, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { Button } from '../ui/button.js';
import { DataTable, numericCell } from '../ui/table.js';
import { Field, Actions, FormError } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';
import { MeasurementBooks } from './MeasurementBooks.js';

interface WorkMeasurementProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly workItems: readonly WorkItem[];
  readonly mbEntries: readonly MbEntry[];
  readonly mbEntriesState: 'loading' | 'unavailable' | 'ready';
  readonly setMbEntries: Dispatch<SetStateAction<readonly MbEntry[]>>;
  /** Issued challans only: a measurement may cite delivered material, never
   * a draft. */
  readonly issuedChallans: readonly Challan[];
  readonly challanNumberById: ReadonlyMap<string, string | null>;
  readonly challansState: 'loading' | 'unavailable' | 'ready';
  /** Applies a re-read of the Work's bills — the list AND the summary
   * above it, which is why this takes the whole response rather than a
   * bills array. Preparing a bill from a Measurement Book moves both. */
  readonly setBills: (bills: BillListResponse) => void;
  readonly billsState: 'loading' | 'unavailable' | 'ready';
  readonly canRecordSiteEvidence: boolean;
  readonly canCreateDocuments: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly pending: boolean;
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
  workItems,
  mbEntries,
  mbEntriesState,
  setMbEntries,
  issuedChallans,
  challanNumberById,
  challansState,
  setBills,
  billsState,
  canRecordSiteEvidence,
  canCreateDocuments,
  canIssue,
  canCancel,
  pending,
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
          {canRecordSiteEvidence && workItems.length > 0 && (
            <Disclosure label="New measurement" startOpen={mbEntries.length === 0}>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const data = new FormData(form);
                  const workItemId = formValue(data, 'mb-item');
                  const measuredQuantity = formValue(data, 'mb-quantity');
                  const measuredOn = formValue(data, 'mb-date');
                  const deliveryChallanId =
                    challansState === 'ready' ? formValue(data, 'mb-challan') : '';
                  const mbBookRef = formValue(data, 'mb-book').trim();
                  const remarks = formValue(data, 'mb-remarks').trim();
                  void act(async () => {
                    const entry = await api.recordMbEntry(organisationId, workId, {
                      workItemId,
                      measuredQuantity,
                      measuredOn,
                      ...(deliveryChallanId.length > 0 ? { deliveryChallanId } : {}),
                      ...(mbBookRef.length > 0 ? { mbBookRef } : {}),
                      ...(remarks.length > 0 ? { remarks } : {}),
                    });
                    setMbEntries((current) => [...current, entry]);
                    form.reset();
                  }, 'Measurement recorded.');
                }}
              >
                <Field>
                  <label htmlFor="mb-item">Work item</label>
                  <select id="mb-item" name="mb-item" required>
                    {workItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.itemNumber} — {item.description}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <label htmlFor="mb-quantity">Measured quantity</label>
                  <input
                    id="mb-quantity"
                    name="mb-quantity"
                    inputMode="decimal"
                    required
                  />
                </Field>
                <Field>
                  <label htmlFor="mb-date">Measured on</label>
                  <input id="mb-date" name="mb-date" type="date" required />
                </Field>
                <Field>
                  <label htmlFor="mb-challan">Source challan (optional)</label>
                  {challansState === 'ready' ? (
                    <select id="mb-challan" name="mb-challan">
                      <option value="">Not tied to a challan</option>
                      {issuedChallans.map((challan) => (
                        <option key={challan.id} value={challan.id}>
                          {challan.challanNumber ?? challan.id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p id="mb-challan" className="text-muted-foreground" role="status">
                      {challansState === 'loading'
                        ? 'Loading source Challans…'
                        : 'Source Challans are unavailable; this measurement will be saved without one.'}
                    </p>
                  )}
                </Field>
                <Field>
                  <label htmlFor="mb-book">MB book reference (optional)</label>
                  <input id="mb-book" name="mb-book" maxLength={100} />
                </Field>
                <Field>
                  <label htmlFor="mb-remarks">Remarks (optional)</label>
                  <input id="mb-remarks" name="mb-remarks" maxLength={1000} />
                </Field>
                <Actions>
                  <Button type="submit" disabled={pending}>
                    Record measurement
                  </Button>
                </Actions>
              </form>
            </Disclosure>
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
