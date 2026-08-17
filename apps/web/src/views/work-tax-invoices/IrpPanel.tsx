import type { TaxInvoice } from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../../api.js';
import { formatTimestamp, formatTimestampDate } from '../../format.js';
import { Button } from '../../ui/button.js';
import { StatusChip } from '../../ui/chip.js';
import { wrapCell } from '../../ui/table.js';
import { Field, FieldRow, Actions, Hint, FormError } from '../../ui/form.js';
import { Disclosure } from '../../ui/disclosure.js';
import type { ActRunner } from './shared.js';

interface IrpPanelProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly invoice: TaxInvoice;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  /** The compliance authority (migration 0061). Every control in this
   * panel except the local payload copy talks to — or records what is
   * claimed to have come back from — the IRP, so each needs this in
   * addition to its document authority. */
  readonly canManageStatutory: boolean;
  readonly pending: boolean;
  readonly act: ActRunner;
  /** Reloads the register and reopens this invoice's detail. */
  readonly refresh: () => Promise<void>;
}

/**
 * Government e-invoicing for a submitted invoice. The IRN,
 * acknowledgement and signed QR are never minted locally: the payload
 * goes out to the GSP, the IRP answers, and what it answered is
 * recorded verbatim. Manual compatibility evidence stays labelled
 * unverified and can never overwrite a provider attempt.
 */
export function IrpPanel({
  api,
  organisationId,
  invoice,
  canIssue,
  canCancel,
  canManageStatutory,
  pending,
  act,
  refresh,
}: IrpPanelProps) {
  if (invoice.status !== 'submitted') return null;
  const mayRegister = canIssue && canManageStatutory;
  const mayCancel = canCancel && canManageStatutory;
  return (
    /* `.data-surface`, the mock's shared panel wrapper (docs/DESIGN.md
       § Component-layer conventions), so the transport reads as one card
       beside the invoice it belongs to rather than as loose markup under a
       bold line. The statutory states below stay spelled out — a provider
       state is never reduced to a colour or an icon. */
    <section
      className="data-surface mt-4 flex flex-col gap-3 p-4"
      aria-labelledby="irp-panel-heading"
    >
      <h4 id="irp-panel-heading" className="m-0 text-sm font-medium">
        Government e-invoicing
      </h4>
      {invoice.irn === null ? (
        <>
          <p className="m-0 text-sm text-muted-foreground">
            Issued locally. Whitebooks can register the frozen invoice at the IRP. An
            unknown result is reconciled by document details and is never blindly
            generated twice.
          </p>
          <Actions>
            {mayRegister && invoice.irpProviderState !== 'cancelling' && (
              <Button
                onClick={() => {
                  void act(async () => {
                    if (invoice.irpProviderState === 'registering') {
                      await api.recoverTaxInvoiceProviderOperation(
                        organisationId,
                        invoice.id,
                      );
                    } else {
                      await api.registerTaxInvoiceIrp(organisationId, invoice.id);
                    }
                    await refresh();
                  }, 'Whitebooks request finished. Provider state is refreshed below; unknown results are never submitted twice.');
                }}
                disabled={pending}
              >
                {invoice.irpProviderState === 'registering'
                  ? 'Check stalled registration'
                  : invoice.irpProviderState === 'registration_unknown'
                    ? 'Reconcile with Whitebooks'
                    : invoice.irpProviderState === 'registration_failed'
                      ? 'Retry confirmed rejection'
                      : 'Register with Whitebooks'}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                void act(async () => {
                  const payload = await api.taxInvoiceIrpPayload(
                    organisationId,
                    invoice.id,
                  );
                  await navigator.clipboard.writeText(payload);
                }, 'The e-invoice payload is on the clipboard, ready for the GSP.');
              }}
              disabled={pending}
            >
              Copy e-invoice payload
            </Button>
          </Actions>
          <p className="m-0 text-sm text-muted-foreground">
            Provider state: <strong>{invoice.irpProviderState}</strong>
          </p>
          {mayRegister && (
            <Disclosure label="Manual compatibility import (unverified)">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void act(async () => {
                    await api.recordTaxInvoiceIrpResponse(organisationId, invoice.id, {
                      irn: formValue(data, 'irp-irn'),
                      ackNumber: formValue(data, 'irp-ack-number'),
                      ackDate: new Date(formValue(data, 'irp-ack-date')).toISOString(),
                      ackDateText: formValue(data, 'irp-ack-date-text'),
                      signedQr: formValue(data, 'irp-signed-qr'),
                      ...(formValue(data, 'irp-signed-invoice') === ''
                        ? {}
                        : { signedInvoice: formValue(data, 'irp-signed-invoice') }),
                    });
                    await refresh();
                  }, 'Manual IRP details recorded as unverified evidence.');
                }}
              >
                <Field>
                  <label htmlFor="irp-irn">IRN</label>
                  <input
                    id="irp-irn"
                    name="irp-irn"
                    required
                    pattern="[0-9a-f]{64}"
                    maxLength={64}
                  />
                  <Hint>Sixty-four hexadecimal characters, exactly as returned.</Hint>
                </Field>
                <FieldRow>
                  <Field>
                    <label htmlFor="irp-ack-number">Acknowledgement number</label>
                    <input id="irp-ack-number" name="irp-ack-number" required />
                  </Field>
                  <Field>
                    <label htmlFor="irp-ack-date">Acknowledgement date</label>
                    <input
                      id="irp-ack-date"
                      name="irp-ack-date"
                      type="datetime-local"
                      required
                    />
                  </Field>
                </FieldRow>
                <Field>
                  <label htmlFor="irp-ack-date-text">
                    Portal acknowledgement text (exact)
                  </label>
                  <input
                    id="irp-ack-date-text"
                    name="irp-ack-date-text"
                    placeholder="30/07/2026 12:09:00"
                    required
                  />
                  <Hint>
                    Copy the wall-clock text exactly. This evidence remains marked
                    manually entered and unverified.
                  </Hint>
                </Field>
                <Field>
                  <label htmlFor="irp-signed-qr">Signed QR</label>
                  <textarea id="irp-signed-qr" name="irp-signed-qr" rows={3} required />
                  <Hint>
                    The signed payload the portal returned; it prints as the QR code on
                    the invoice.
                  </Hint>
                </Field>
                <Field>
                  <label htmlFor="irp-signed-invoice">
                    Signed invoice (optional in manual mode)
                  </label>
                  <textarea
                    id="irp-signed-invoice"
                    name="irp-signed-invoice"
                    rows={3}
                  />
                </Field>
                <Actions>
                  <Button type="submit" disabled={pending}>
                    Record response
                  </Button>
                </Actions>
              </form>
            </Disclosure>
          )}
        </>
      ) : (
        <>
          <p className="m-0">
            <StatusChip status={invoice.irpProviderState}>
              {invoice.irpProvider === 'whitebooks'
                ? `Whitebooks · ${invoice.irpProviderState}`
                : invoice.irpProviderState === 'registered_unverified'
                  ? 'manual — unverified'
                  : `manual — ${invoice.irpProviderState} · unverified`}
            </StatusChip>
          </p>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">IRN</dt>
            <dd className={`m-0 font-mono ${wrapCell}`}>{invoice.irn}</dd>
            <dt className="text-muted-foreground">Acknowledgement</dt>
            <dd className="m-0 tabular-nums">
              {invoice.ackNumber ?? '—'}
              {invoice.ackDateText !== null && ` · ${invoice.ackDateText}`}
              {invoice.ackDateText === null &&
                invoice.ackDate !== null &&
                ` · ${formatTimestampDate(invoice.ackDate)}`}
            </dd>
            {invoice.irpProviderState === 'registered' && (
              <>
                <dt className="text-muted-foreground">IRN cancellation window</dt>
                <dd className="m-0">
                  {invoice.irpCancelWindowClosesAt === null
                    ? 'Closed — the acknowledgement instant cannot be proven from the retained evidence'
                    : invoice.irpCancelWindowOpen
                      ? `Open until ${formatTimestamp(invoice.irpCancelWindowClosesAt)}`
                      : `Closed ${formatTimestamp(invoice.irpCancelWindowClosesAt)}`}
                </dd>
              </>
            )}
          </dl>
          {invoice.irpLegacyEvidenceMissing && (
            <FormError>
              This migrated IRP record lacks some historical evidence. No value was
              invented to fill the gap.
            </FormError>
          )}
          {mayCancel &&
            invoice.irpProvider === 'whitebooks' &&
            invoice.irpProviderState === 'registered' &&
            !invoice.irpCancelWindowOpen && (
              <p className="m-0 text-sm text-muted-foreground">
                NIC accepts an IRN cancellation only within 24 hours of acknowledgement
                {invoice.irpCancelWindowClosesAt === null
                  ? ', and this record’s acknowledgement instant cannot be proven'
                  : `; this one closed ${formatTimestamp(invoice.irpCancelWindowClosesAt)}`}
                . Issue a credit note against this invoice instead — it supersedes the
                invoice and releases its Measurement Book.
              </p>
            )}
          {mayCancel &&
            invoice.irpProvider === 'whitebooks' &&
            ((invoice.irpProviderState === 'registered' &&
              invoice.irpCancelWindowOpen) ||
              invoice.irpProviderState === 'cancelling') && (
              <Disclosure label="Cancel IRN at Whitebooks">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void act(async () => {
                      if (invoice.irpProviderState === 'cancelling') {
                        await api.recoverTaxInvoiceProviderOperation(
                          organisationId,
                          invoice.id,
                        );
                      } else {
                        await api.cancelTaxInvoiceIrp(organisationId, invoice.id, {
                          reasonCode: formValue(data, 'irp-cancel-reason') as
                            '1' | '2' | '3' | '4',
                          remark: formValue(data, 'irp-cancel-remark'),
                        });
                      }
                      await refresh();
                    }, 'Whitebooks cancellation check finished. Provider state is refreshed below; local cancellation stays locked until confirmed.');
                  }}
                >
                  <FieldRow>
                    <Field>
                      <label htmlFor="irp-cancel-reason">Reason</label>
                      <select
                        id="irp-cancel-reason"
                        name="irp-cancel-reason"
                        defaultValue="2"
                      >
                        <option value="1">Duplicate</option>
                        <option value="2">Data entry mistake</option>
                        <option value="3">Order cancelled</option>
                        <option value="4">Other</option>
                      </select>
                    </Field>
                    <Field>
                      <label htmlFor="irp-cancel-remark">Remark</label>
                      <input
                        id="irp-cancel-remark"
                        name="irp-cancel-remark"
                        required
                        minLength={3}
                        maxLength={2000}
                      />
                    </Field>
                  </FieldRow>
                  <Actions>
                    <Button type="submit" disabled={pending}>
                      {invoice.irpProviderState === 'cancelling'
                        ? 'Check stalled cancellation'
                        : 'Cancel IRN at provider'}
                    </Button>
                  </Actions>
                </form>
              </Disclosure>
            )}
          {mayCancel &&
            ((invoice.irpProvider === 'manual' &&
              invoice.irpProviderState === 'registered_unverified') ||
              invoice.irpProviderState === 'cancellation_unknown') && (
              <Disclosure label="Record externally confirmed IRP cancellation (unverified)">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void act(async () => {
                      await api.recordTaxInvoiceIrpCancellation(
                        organisationId,
                        invoice.id,
                        {
                          reasonCode: formValue(data, 'manual-irp-cancel-reason') as
                            '1' | '2' | '3' | '4',
                          remark: formValue(data, 'manual-irp-cancel-remark'),
                          cancelledAt: new Date(
                            formValue(data, 'manual-irp-cancel-date'),
                          ).toISOString(),
                          cancelledAtText: formValue(
                            data,
                            'manual-irp-cancel-date-text',
                          ),
                        },
                      );
                      await refresh();
                    }, 'Manual external cancellation evidence recorded as unverified.');
                  }}
                >
                  <FieldRow>
                    <Field>
                      <label htmlFor="manual-irp-cancel-reason">Reason code</label>
                      <select
                        id="manual-irp-cancel-reason"
                        name="manual-irp-cancel-reason"
                        defaultValue="2"
                      >
                        <option value="1">Duplicate</option>
                        <option value="2">Data entry mistake</option>
                        <option value="3">Order cancelled</option>
                        <option value="4">Other</option>
                      </select>
                    </Field>
                    <Field>
                      <label htmlFor="manual-irp-cancel-date">Normalized instant</label>
                      <input
                        id="manual-irp-cancel-date"
                        name="manual-irp-cancel-date"
                        type="datetime-local"
                        required
                      />
                    </Field>
                  </FieldRow>
                  <Field>
                    <label htmlFor="manual-irp-cancel-date-text">
                      Portal cancellation text (exact)
                    </label>
                    <input
                      id="manual-irp-cancel-date-text"
                      name="manual-irp-cancel-date-text"
                      placeholder="30/07/2026 13:15:00"
                      required
                    />
                  </Field>
                  <Field>
                    <label htmlFor="manual-irp-cancel-remark">Remark</label>
                    <input
                      id="manual-irp-cancel-remark"
                      name="manual-irp-cancel-remark"
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
            )}
        </>
      )}
    </section>
  );
}
