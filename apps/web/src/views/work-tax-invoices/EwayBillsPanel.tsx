import type { EwayBill, TaxInvoice, TransportMode } from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../../api.js';
import { formatDate } from '../../format.js';
import { Button } from '../../ui/button.js';
import { StatusChip } from '../../ui/chip.js';
import { DataTable } from '../../ui/table.js';
import { Field, FieldRow, Actions, FormError } from '../../ui/form.js';
import { Disclosure } from '../../ui/disclosure.js';
import type { ActRunner } from './shared.js';

const TRANSPORT_MODE_LABELS: Record<TransportMode, string> = {
  road: 'Road',
  rail: 'Rail',
  air: 'Air',
  ship: 'Ship',
};

interface EwayBillsPanelProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly invoice: TaxInvoice;
  readonly ewayBills: readonly EwayBill[];
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly pending: boolean;
  readonly act: ActRunner;
  readonly onEwayBillsChanged: (bills: readonly EwayBill[]) => void;
}

/**
 * The e-way bills that moved a submitted invoice. Fresh generation is
 * unavailable for the cumulative SAC service invoice (owner decision on
 * audit finding 1); historical records remain readable, reconcilable
 * and cancellable, with provider and local cancellation kept separate.
 */
export function EwayBillsPanel({
  api,
  organisationId,
  invoice,
  ewayBills,
  canIssue,
  canCancel,
  pending,
  act,
  onEwayBillsChanged,
}: EwayBillsPanelProps) {
  if (invoice.status !== 'submitted') return null;
  const reloadEwayBills = async () => {
    onEwayBillsChanged(await api.listInvoiceEwayBills(organisationId, invoice.id));
  };
  return (
    <>
      <h4>E-way bills</h4>
      <FormError>
        Fresh E-way Bill generation is unavailable for this cumulative SAC service
        invoice. Historical records remain readable, reconcilable, and cancellable.
        Goods/HSN and delivery-challan lines must be added before generation can be
        enabled safely.
      </FormError>
      {ewayBills.length > 0 ? (
        <DataTable>
          <caption className="sr-only">E-way bills raised to move this invoice</caption>
          <thead>
            <tr>
              <th scope="col">EWB number</th>
              <th scope="col">Mode</th>
              <th scope="col">Route</th>
              <th scope="col">Status</th>
              <th scope="col">Provider</th>
              <th scope="col">Valid until</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {ewayBills.map((bill) => (
              <tr key={bill.id}>
                <th scope="row">{bill.ewbNumber ?? 'Draft'}</th>
                <td>{TRANSPORT_MODE_LABELS[bill.transportMode]}</td>
                <td>
                  {bill.fromPincode} → {bill.toPincode} · {bill.distanceKm} km
                </td>
                <td>
                  <StatusChip status={bill.status}>{bill.status}</StatusChip>
                </td>
                <td>
                  <StatusChip status={bill.providerState}>
                    {bill.provider === 'manual'
                      ? `${bill.providerState} · unverified`
                      : bill.providerState}
                  </StatusChip>
                </td>
                <td>
                  {bill.validUntilText ??
                    (bill.validUntil === null ? '—' : formatDate(bill.validUntil))}
                </td>
                <td>
                  {bill.status === 'draft' &&
                  canIssue &&
                  (bill.providerState === 'generating' ||
                    bill.providerState === 'generation_unknown') ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void act(async () => {
                          if (bill.providerState === 'generating') {
                            await api.recoverEwayBillProviderOperation(
                              organisationId,
                              bill.id,
                            );
                          } else {
                            await api.generateEwayBill(organisationId, bill.id);
                          }
                          await reloadEwayBills();
                        }, 'Whitebooks EWB check finished. Provider state is refreshed below; an unknown result is never generated again blindly.');
                      }}
                      disabled={pending}
                    >
                      {bill.providerState === 'generating'
                        ? 'Check stalled operation'
                        : bill.providerState === 'generation_unknown'
                          ? 'Reconcile'
                          : 'Generate at Whitebooks'}
                    </Button>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">
          No e-way bill has been raised for this invoice.
        </p>
      )}

      {canCancel &&
        ewayBills
          .filter(
            (bill) =>
              bill.status === 'generated' &&
              bill.provider === 'whitebooks' &&
              (bill.providerState === 'generated' ||
                bill.providerState === 'cancelling'),
          )
          .map((bill) => (
            <Disclosure
              key={`provider-cancel-${bill.id}`}
              label={`Cancel EWB ${bill.ewbNumber ?? bill.id} at Whitebooks`}
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void act(async () => {
                    if (bill.providerState === 'cancelling') {
                      await api.recoverEwayBillProviderOperation(
                        organisationId,
                        bill.id,
                      );
                    } else {
                      await api.cancelEwayBillAtProvider(organisationId, bill.id, {
                        reasonCode: formValue(
                          data,
                          `eway-provider-reason-${bill.id}`,
                        ) as '1' | '2' | '3' | '4',
                        remark: formValue(data, `eway-provider-remark-${bill.id}`),
                      });
                    }
                    await reloadEwayBills();
                  }, 'Whitebooks EWB cancellation check finished. Provider state is refreshed below; the local record stays active until confirmed.');
                }}
              >
                <FieldRow>
                  <Field>
                    <label htmlFor={`eway-provider-reason-${bill.id}`}>Reason</label>
                    <select
                      id={`eway-provider-reason-${bill.id}`}
                      name={`eway-provider-reason-${bill.id}`}
                      defaultValue="2"
                    >
                      <option value="1">Duplicate</option>
                      <option value="2">Order cancelled</option>
                      <option value="3">Data entry mistake</option>
                      <option value="4">Other</option>
                    </select>
                  </Field>
                  <Field>
                    <label htmlFor={`eway-provider-remark-${bill.id}`}>Remark</label>
                    <input
                      id={`eway-provider-remark-${bill.id}`}
                      name={`eway-provider-remark-${bill.id}`}
                      required
                      minLength={3}
                      maxLength={2000}
                    />
                  </Field>
                </FieldRow>
                <Actions>
                  <Button type="submit" disabled={pending}>
                    {bill.providerState === 'cancelling'
                      ? 'Check stalled cancellation'
                      : 'Cancel at provider'}
                  </Button>
                </Actions>
              </form>
            </Disclosure>
          ))}

      {canCancel &&
        ewayBills
          .filter(
            (bill) =>
              (bill.status === 'generated' || bill.status === 'cancelled') &&
              ((bill.provider === 'manual' && bill.providerState === 'generated') ||
                bill.providerState === 'cancellation_unknown'),
          )
          .map((bill) => (
            <Disclosure
              key={`manual-provider-cancel-${bill.id}`}
              label={`Record externally confirmed cancellation for EWB ${bill.ewbNumber ?? bill.id} (unverified)`}
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void act(async () => {
                    await api.recordEwayBillCancellation(organisationId, bill.id, {
                      reasonCode: formValue(data, `eway-manual-reason-${bill.id}`) as
                        '1' | '2' | '3' | '4',
                      remark: formValue(data, `eway-manual-remark-${bill.id}`),
                      cancelledAt: new Date(
                        formValue(data, `eway-manual-date-${bill.id}`),
                      ).toISOString(),
                      cancelledAtText: formValue(
                        data,
                        `eway-manual-date-text-${bill.id}`,
                      ),
                    });
                    await reloadEwayBills();
                  }, 'External EWB cancellation evidence recorded as manually entered and unverified.');
                }}
              >
                <FieldRow>
                  <Field>
                    <label htmlFor={`eway-manual-reason-${bill.id}`}>Reason</label>
                    <select
                      id={`eway-manual-reason-${bill.id}`}
                      name={`eway-manual-reason-${bill.id}`}
                      defaultValue="2"
                    >
                      <option value="1">Duplicate</option>
                      <option value="2">Order cancelled</option>
                      <option value="3">Data entry mistake</option>
                      <option value="4">Other</option>
                    </select>
                  </Field>
                  <Field>
                    <label htmlFor={`eway-manual-date-${bill.id}`}>
                      Normalized instant
                    </label>
                    <input
                      id={`eway-manual-date-${bill.id}`}
                      name={`eway-manual-date-${bill.id}`}
                      type="datetime-local"
                      required
                    />
                  </Field>
                </FieldRow>
                <Field>
                  <label htmlFor={`eway-manual-date-text-${bill.id}`}>
                    Portal cancellation text (exact)
                  </label>
                  <input
                    id={`eway-manual-date-text-${bill.id}`}
                    name={`eway-manual-date-text-${bill.id}`}
                    placeholder="11/08/2026 12:30:00"
                    required
                  />
                </Field>
                <Field>
                  <label htmlFor={`eway-manual-remark-${bill.id}`}>Remark</label>
                  <input
                    id={`eway-manual-remark-${bill.id}`}
                    name={`eway-manual-remark-${bill.id}`}
                    required
                    minLength={3}
                    maxLength={2000}
                  />
                </Field>
                <Actions>
                  <Button type="submit" disabled={pending}>
                    Record unverified cancellation
                  </Button>
                </Actions>
              </form>
            </Disclosure>
          ))}

      {canCancel &&
        ewayBills
          .filter(
            (bill) => bill.status === 'generated' && bill.providerState === 'cancelled',
          )
          .map((bill) => (
            <Disclosure
              key={`local-cancel-${bill.id}`}
              label={`Cancel local EWB record ${bill.ewbNumber ?? bill.id}`}
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void act(async () => {
                    await api.cancelEwayBill(organisationId, bill.id, {
                      note: formValue(data, `eway-local-cancel-note-${bill.id}`),
                    });
                    await reloadEwayBills();
                  }, 'Local EWB record cancelled; official identity and validity evidence were retained.');
                }}
              >
                <Field>
                  <label htmlFor={`eway-local-cancel-note-${bill.id}`}>
                    Local cancellation note
                  </label>
                  <textarea
                    id={`eway-local-cancel-note-${bill.id}`}
                    name={`eway-local-cancel-note-${bill.id}`}
                    required
                    minLength={3}
                    maxLength={2000}
                    rows={2}
                  />
                </Field>
                <Actions>
                  <Button type="submit" disabled={pending}>
                    Cancel local record
                  </Button>
                </Actions>
              </form>
            </Disclosure>
          ))}
    </>
  );
}
