import type { Bill, Challan, MbEntry, WorkItem } from '@auto-mb/contracts';
import type { Dispatch, SetStateAction } from 'react';
import { formValue, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell } from '../ui/table.js';
import { Field, Actions } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';
import { MeasurementBooks } from './MeasurementBooks.js';

interface WorkMeasurementProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly workItems: readonly WorkItem[];
  readonly mbEntries: readonly MbEntry[];
  readonly setMbEntries: Dispatch<SetStateAction<readonly MbEntry[]>>;
  /** Issued challans only: a measurement may cite delivered material, never
   * a draft. */
  readonly issuedChallans: readonly Challan[];
  readonly challanNumberById: ReadonlyMap<string, string | null>;
  readonly setBills: Dispatch<SetStateAction<readonly Bill[]>>;
  readonly canRecordSiteEvidence: boolean;
  readonly canCreateDocuments: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly pending: boolean;
  /** The page's shared action runner: reports, refreshes, and clears. */
  readonly act: (run: () => Promise<void>, message: string) => Promise<void>;
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
  setMbEntries,
  issuedChallans,
  challanNumberById,
  setBills,
  canRecordSiteEvidence,
  canCreateDocuments,
  canIssue,
  canCancel,
  pending,
  act,
}: WorkMeasurementProps) {
  return (
    <>
      <h2>Measurement Book</h2>
      {mbEntries.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Measurement Book entries for this Work</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className={numericCell}>
                Quantity
              </th>
              <th scope="col">Measured on</th>
              <th scope="col">Challan</th>
              <th scope="col">MB book</th>
              <th scope="col">Billing</th>
            </tr>
          </thead>
          <tbody>
            {mbEntries.map((entry) => (
              <tr key={entry.id}>
                <th scope="row">{entry.itemNumber}</th>
                <td className={numericCell}>{entry.measuredQuantity}</td>
                <td>{entry.measuredOn}</td>
                <td>
                  {entry.deliveryChallanId !== null
                    ? (challanNumberById.get(entry.deliveryChallanId) ?? '—')
                    : '—'}
                </td>
                <td>{entry.mbBookRef ?? '—'}</td>
                <td>
                  {entry.billId !== null ? (
                    <StatusChip status="confirmed">billed</StatusChip>
                  ) : (
                    <span className="text-muted-foreground">unbilled</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">No measurements recorded yet.</p>
      )}
      {canRecordSiteEvidence && workItems.length > 0 && (
        <Disclosure label="Record measurement" startOpen={mbEntries.length === 0}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              const workItemId = formValue(data, 'mb-item');
              const measuredQuantity = formValue(data, 'mb-quantity');
              const measuredOn = formValue(data, 'mb-date');
              const deliveryChallanId = formValue(data, 'mb-challan');
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
              <input id="mb-quantity" name="mb-quantity" inputMode="decimal" required />
            </Field>
            <Field>
              <label htmlFor="mb-date">Measured on</label>
              <input id="mb-date" name="mb-date" type="date" required />
            </Field>
            <Field>
              <label htmlFor="mb-challan">Source challan (optional)</label>
              <select id="mb-challan" name="mb-challan">
                <option value="">Not tied to a challan</option>
                {issuedChallans.map((challan) => (
                  <option key={challan.id} value={challan.id}>
                    {challan.challanNumber ?? challan.id}
                  </option>
                ))}
              </select>
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

      <MeasurementBooks
        api={api}
        organisationId={organisationId}
        workId={workId}
        canModify={canCreateDocuments}
        canIssue={canIssue}
        canCancel={canCancel}
        onBillPrepared={() => {
          void api.listBills(organisationId, workId).then(setBills);
        }}
      />
    </>
  );
}
