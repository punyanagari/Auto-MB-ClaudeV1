import { useState } from 'react';
import type { EwayBill, TransportMode } from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable } from '../ui/table.js';
import { Field, FieldRow, Actions, FormError } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';
import { openPdf } from '../lib/openPdf.js';
import type { ActRunner } from './work-tax-invoices/shared.js';

const TRANSPORT_MODE_LABELS: Record<TransportMode, string> = {
  road: 'Road',
  rail: 'Rail',
  air: 'Air',
  ship: 'Ship',
};

/** Which document the consignment travels under, and whether the server
 * would accept a bill raised from it.
 *
 * `eligible` is the SERVER's answer, never the screen's: ADR-0013 puts
 * the applicability rule in one place and this panel offers the action
 * exactly where that rule would allow it. `refusal` is why not, in the
 * operator's own words, when the source is a document this product can
 * see but NIC will not issue a bill for.
 */
export interface EwayBillSourceDescriptor {
  readonly kind: 'tax_invoice' | 'delivery_challan';
  readonly id: string;
  /** The document's own number, for the panel's own sentences. */
  readonly number: string | null;
  readonly eligible: boolean;
  readonly refusal: string | null;
}

interface EwayBillsPanelProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly source: EwayBillSourceDescriptor;
  readonly ewayBills: readonly EwayBill[];
  readonly canModify: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  /** The compliance authority (migration 0061). Gates the NIC portal
   * controls only — cancelling the LOCAL e-way-bill record is not a
   * portal act and keeps the cancel authority alone. */
  readonly canManageStatutory: boolean;
  readonly pending: boolean;
  readonly act: ActRunner;
  readonly onEwayBillsChanged: (bills: readonly EwayBill[]) => void;
}

/**
 * The e-way bill lifecycle for whichever document moves the goods
 * (ADR-0013): a submitted tax invoice, or an issued standalone Delivery
 * Challan. One panel, because the routes key on the BILL rather than on
 * its source, and one operator question — "what is moving, under what
 * number, and is it still valid".
 *
 * Applicability is the server's answer, read from `source.eligible`. A
 * service-only document is refused there, and the panel says so instead
 * of offering an action that would be refused: an e-way bill moves goods,
 * and NIC's error 4009 is the reason.
 */
export function EwayBillsPanel({
  api,
  organisationId,
  source,
  ewayBills,
  canModify,
  canIssue,
  canCancel,
  canManageStatutory,
  pending,
  act,
  onEwayBillsChanged,
}: EwayBillsPanelProps) {
  const [draftOpen, setDraftOpen] = useState(false);
  const mayReconcile = canIssue && canManageStatutory;
  const mayCancelAtPortal = canCancel && canManageStatutory;
  const reloadEwayBills = async () => {
    onEwayBillsChanged(
      source.kind === 'tax_invoice'
        ? await api.listInvoiceEwayBills(organisationId, source.id)
        : await api.listChallanEwayBills(organisationId, source.id),
    );
  };
  const hasLiveBill = ewayBills.some((bill) => bill.status !== 'cancelled');
  return (
    <>
      <h4>E-way bills</h4>
      {source.refusal !== null && <FormError>{source.refusal}</FormError>}
      {source.eligible && canModify && !hasLiveBill && (
        <>
          <Actions>
            <Button
              variant="secondary"
              onClick={() => {
                setDraftOpen((open) => !open);
              }}
              disabled={pending}
              aria-expanded={draftOpen}
              aria-controls="eway-new-form"
            >
              {draftOpen ? 'Close carriage details' : 'Raise an e-way bill'}
            </Button>
          </Actions>
          {draftOpen && (
            <form
              id="eway-new-form"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const mode = formValue(data, 'eway-new-mode') as TransportMode;
                const vehicle = formValue(data, 'eway-new-vehicle').trim();
                const docNumber = formValue(data, 'eway-new-doc-number').trim();
                const docDate = formValue(data, 'eway-new-doc-date').trim();
                const transporterName = formValue(data, 'eway-new-transporter').trim();
                void act(async () => {
                  const body = {
                    transportMode: mode,
                    distanceKm: Number(formValue(data, 'eway-new-distance')),
                    fromPincode: formValue(data, 'eway-new-from'),
                    toPincode: formValue(data, 'eway-new-to'),
                    ...(vehicle === '' ? {} : { vehicleNumber: vehicle }),
                    ...(docNumber === '' ? {} : { transportDocNumber: docNumber }),
                    ...(docDate === '' ? {} : { transportDocDate: docDate }),
                    ...(transporterName === '' ? {} : { transporterName }),
                  };
                  if (source.kind === 'tax_invoice') {
                    await api.createInvoiceEwayBill(organisationId, source.id, body);
                  } else {
                    await api.createChallanEwayBill(organisationId, source.id, body);
                  }
                  await reloadEwayBills();
                  setDraftOpen(false);
                }, 'E-way bill drafted. Nothing has been sent to NIC yet — generate it when the carriage is final.');
              }}
            >
              <FieldRow>
                <Field>
                  <label htmlFor="eway-new-mode">Transport mode</label>
                  <select id="eway-new-mode" name="eway-new-mode" defaultValue="road">
                    <option value="road">Road</option>
                    <option value="rail">Rail</option>
                    <option value="air">Air</option>
                    <option value="ship">Ship</option>
                  </select>
                </Field>
                <Field>
                  <label htmlFor="eway-new-distance">Distance (km)</label>
                  <input
                    id="eway-new-distance"
                    name="eway-new-distance"
                    type="number"
                    min={0}
                    max={4000}
                    required
                  />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field>
                  <label htmlFor="eway-new-from">From PIN</label>
                  <input
                    id="eway-new-from"
                    name="eway-new-from"
                    pattern="[0-9]{6}"
                    required
                  />
                </Field>
                <Field>
                  <label htmlFor="eway-new-to">To PIN</label>
                  <input
                    id="eway-new-to"
                    name="eway-new-to"
                    pattern="[0-9]{6}"
                    required
                  />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field>
                  <label htmlFor="eway-new-vehicle">Vehicle number</label>
                  <input
                    id="eway-new-vehicle"
                    name="eway-new-vehicle"
                    pattern="[A-Z0-9]{6,12}"
                  />
                  <p className="text-muted-foreground">
                    A road movement names a vehicle; rail, air and ship name a transport
                    document instead.
                  </p>
                </Field>
                <Field>
                  <label htmlFor="eway-new-transporter">Transporter</label>
                  <input
                    id="eway-new-transporter"
                    name="eway-new-transporter"
                    maxLength={200}
                  />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field>
                  <label htmlFor="eway-new-doc-number">Transport document</label>
                  <input
                    id="eway-new-doc-number"
                    name="eway-new-doc-number"
                    maxLength={30}
                  />
                </Field>
                <Field>
                  <label htmlFor="eway-new-doc-date">Transport document date</label>
                  <input id="eway-new-doc-date" name="eway-new-doc-date" type="date" />
                </Field>
              </FieldRow>
              <Actions>
                <Button type="submit" disabled={pending}>
                  Save draft
                </Button>
              </Actions>
            </form>
          )}
        </>
      )}
      {ewayBills.length > 0 ? (
        <DataTable>
          <caption className="sr-only">
            E-way bills raised to move this{' '}
            {source.kind === 'tax_invoice' ? 'invoice' : 'delivery challan'}
          </caption>
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
                  mayReconcile &&
                  // Reconcile-by-lookup is the invoice path's alone: NIC's
                  // lookup is by IRN and a challan-sourced bill has none, so
                  // the route refuses it (EWAY_PROVIDER_STATE_CONFLICT). An
                  // unknown challan generation is reconciled on the portal by
                  // hand, so offer no dead button here.
                  !(
                    bill.providerState === 'generation_unknown' &&
                    source.kind === 'delivery_challan'
                  ) ? (
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
                  ) : bill.status !== 'draft' && canModify ? (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          void act(async () => {
                            await api.renderEwayBill(organisationId, bill.id);
                            await reloadEwayBills();
                          }, 'E-way bill summary rendered. It is a convenience print; the NIC portal document remains the statutory original.');
                        }}
                        disabled={pending}
                      >
                        {bill.renderedAvailable === true
                          ? 'Re-render PDF'
                          : 'Render PDF'}
                      </Button>
                      {bill.renderedAvailable === true && (
                        <Button
                          variant="secondary"
                          onClick={() => {
                            void act(async () => {
                              await openPdf(() =>
                                api.downloadEwayBillPdf(organisationId, bill.id),
                              );
                            }, 'E-way bill summary opened in a new tab.');
                          }}
                          disabled={pending}
                        >
                          Open PDF
                        </Button>
                      )}
                    </>
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
          No e-way bill has been raised for this{' '}
          {source.kind === 'tax_invoice' ? 'invoice' : 'delivery challan'}.
        </p>
      )}

      {ewayBills.some((bill) => bill.renderedAvailable === true) && (
        // Standing legal text, not a transient success notice: a FormNotice
        // self-destructs after a few seconds, and this disclaimer must stay
        // visible for as long as a rendered summary exists.
        <p className="text-muted-foreground">
          The rendered summary is a convenience print of the facts recorded here. The
          statutory e-way bill is the one held on the NIC portal.
        </p>
      )}

      {mayCancelAtPortal &&
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

      {mayCancelAtPortal &&
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
