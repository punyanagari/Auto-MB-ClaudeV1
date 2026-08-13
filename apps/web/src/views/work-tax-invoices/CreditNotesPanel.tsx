import { useState } from 'react';
import type { CreditNote, TaxInvoice } from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../../api.js';
import { formatDate, formatInr, formatTimestamp } from '../../format.js';
import { openPdf } from '../../lib/openPdf.js';
import { Button } from '../../ui/button.js';
import { StatusChip } from '../../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../../ui/table.js';
import { Field, FieldRow, Actions, Hint } from '../../ui/form.js';
import { Disclosure } from '../../ui/disclosure.js';
import type { ActRunner } from './shared.js';

interface CreditNotesPanelProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly invoice: TaxInvoice;
  readonly creditNotes: readonly CreditNote[];
  readonly canModify: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly pending: boolean;
  readonly act: ActRunner;
  /** Reloads the register, the invoice detail, and its credit notes. */
  readonly refresh: () => Promise<void>;
}

/**
 * The Section 34 credit-note flow (0051): a note credits the invoice IN
 * FULL, supersedes it, and releases its Measurement Book — the lawful
 * remedy once NIC's 24-hour IRN cancellation window has closed. The
 * note is an IRN document of its own (type CRN).
 */
export function CreditNotesPanel({
  api,
  organisationId,
  invoice,
  creditNotes,
  canModify,
  canIssue,
  canCancel,
  pending,
  act,
  refresh,
}: CreditNotesPanelProps) {
  const [creditNoteCancelNote, setCreditNoteCancelNote] = useState('');
  if (invoice.status !== 'submitted' && invoice.status !== 'superseded') return null;
  const liveNote = creditNotes.find((note) => note.status !== 'cancelled') ?? null;
  return (
    <>
      <h4>Credit note (Section 34)</h4>
      <p className="text-muted-foreground">
        A credit note credits this invoice IN FULL and supersedes it, releasing its
        Measurement Book for a corrected invoice — the lawful remedy once NIC&apos;s
        24-hour IRN cancellation window has closed. The note is an IRN document of its
        own (type CRN) with its own gap-free number, reporting deadline and cancellation
        window.
      </p>
      {invoice.status === 'superseded' && (
        <p>
          <strong>Superseded:</strong> an issued credit note replaced this invoice in
          full. Its issued facts and IRN evidence stay frozen; the Measurement Book it
          billed is released.
        </p>
      )}
      {creditNotes.length > 0 && (
        <DataTable>
          <caption className="sr-only">
            Credit notes raised against this invoice
          </caption>
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
              <th scope="col" className={numericCell}>
                Total credited
              </th>
            </tr>
          </thead>
          <tbody>
            {creditNotes.map((note) => (
              <tr key={note.id}>
                <th scope="row">{note.noteNumber ?? 'Draft'}</th>
                <td>{formatDate(note.noteDate)}</td>
                <td>
                  <StatusChip status={note.status}>{note.status}</StatusChip>
                  {note.irn !== null && (
                    <StatusChip status={note.irpProviderState}>
                      {`IRP · ${note.irpProviderState}`}
                    </StatusChip>
                  )}
                  {note.status === 'issued' &&
                    (note.irpReportingOverdue ? (
                      <StatusChip status="expired">IRP overdue</StatusChip>
                    ) : (
                      note.irpReportingDeadline !== null &&
                      note.irpProviderState !== 'registered' && (
                        <StatusChip status="review">
                          IRP due {formatDate(note.irpReportingDeadline)}
                        </StatusChip>
                      )
                    ))}
                </td>
                <td className={numericCell}>
                  {note.totalAmount === null ? '—' : formatInr(note.totalAmount)}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {liveNote === null &&
        (invoice.status === 'submitted' && canModify ? (
          <Disclosure label="Draft a credit note against this invoice">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void act(async () => {
                  const numberPrefix = formValue(data, 'cn-number-prefix');
                  await api.createCreditNote(organisationId, invoice.id, {
                    noteDate: formValue(data, 'cn-date'),
                    reason: formValue(data, 'cn-reason'),
                    ...(numberPrefix === '' ? {} : { numberPrefix }),
                  });
                  await refresh();
                }, 'Draft credit note created — review it and issue when it is right. Issuing supersedes the invoice.');
              }}
            >
              <FieldRow>
                <Field>
                  <label htmlFor="cn-date">Credit note date</label>
                  <input id="cn-date" name="cn-date" type="date" required />
                  <Hint>Cannot precede the invoice date or be in the future.</Hint>
                </Field>
                <Field>
                  <label htmlFor="cn-number-prefix">Number prefix override</label>
                  <input
                    id="cn-number-prefix"
                    name="cn-number-prefix"
                    pattern="[A-Z][A-Z0-9]{0,7}"
                    maxLength={8}
                    placeholder={invoice.numberPrefix ?? ''}
                  />
                  <Hint>Blank follows the invoice&apos;s own prefix.</Hint>
                </Field>
              </FieldRow>
              <Field>
                <label htmlFor="cn-reason">Reason (prints on the face)</label>
                <textarea
                  id="cn-reason"
                  name="cn-reason"
                  rows={2}
                  required
                  minLength={3}
                  maxLength={2000}
                />
                <Hint>
                  Section 34 requires the reason on the face of the credit note.
                </Hint>
              </Field>
              <Actions>
                <Button type="submit" disabled={pending}>
                  Create draft credit note
                </Button>
              </Actions>
            </form>
          </Disclosure>
        ) : null)}
      {liveNote !== null && liveNote.status === 'draft' && (
        <Actions>
          {canIssue && (
            <Button
              onClick={() => {
                void act(async () => {
                  await api.issueCreditNote(organisationId, liveNote.id);
                  await refresh();
                }, 'Credit note issued — it is numbered at full invoice value and the invoice is superseded; its Measurement Book is released.');
              }}
              disabled={pending}
            >
              Issue credit note (supersedes the invoice)
            </Button>
          )}
          {canModify && (
            <Button
              variant="ghost"
              onClick={() => {
                void act(async () => {
                  await api.deleteCreditNote(organisationId, liveNote.id);
                  await refresh();
                }, 'Draft credit note deleted.');
              }}
              disabled={pending}
            >
              Delete draft
            </Button>
          )}
        </Actions>
      )}
      {liveNote !== null && liveNote.status !== 'draft' && (
        <>
          <dl>
            <dt>Credit note</dt>
            <dd>
              {liveNote.noteNumber} · {formatDate(liveNote.noteDate)} ·{' '}
              {liveNote.totalAmount === null ? '—' : formatInr(liveNote.totalAmount)}
            </dd>
            <dt>Reason</dt>
            <dd className={wrapCell}>{liveNote.reason}</dd>
            <dt>Recipient ITC (Section 34(2))</dt>
            <dd>{liveNote.recipientItcStatus.replaceAll('_', ' ')}</dd>
            {liveNote.irpReportingDeadline !== null && (
              <>
                <dt>IRP reporting deadline</dt>
                <dd>{formatDate(liveNote.irpReportingDeadline)}</dd>
              </>
            )}
            {liveNote.irn !== null && (
              <>
                <dt>IRN</dt>
                <dd className={wrapCell}>{liveNote.irn}</dd>
                <dt>Acknowledgement</dt>
                <dd>
                  {liveNote.ackNumber ?? '—'}
                  {liveNote.ackDateText !== null && ` · ${liveNote.ackDateText}`}
                </dd>
                {liveNote.irpProviderState === 'registered' && (
                  <>
                    <dt>IRN cancellation window</dt>
                    <dd>
                      {liveNote.irpCancelWindowClosesAt === null
                        ? 'Closed — the acknowledgement instant cannot be proven'
                        : liveNote.irpCancelWindowOpen
                          ? `Open until ${formatTimestamp(liveNote.irpCancelWindowClosesAt)}`
                          : `Closed ${formatTimestamp(liveNote.irpCancelWindowClosesAt)}`}
                    </dd>
                  </>
                )}
              </>
            )}
          </dl>
          <Actions>
            {canIssue &&
              liveNote.irn === null &&
              liveNote.irpProviderState !== 'cancelling' && (
                <Button
                  onClick={() => {
                    void act(async () => {
                      if (liveNote.irpProviderState === 'registering') {
                        await api.recoverCreditNoteProviderOperation(
                          organisationId,
                          liveNote.id,
                        );
                      } else {
                        await api.registerCreditNoteIrp(organisationId, liveNote.id);
                      }
                      await refresh();
                    }, 'Whitebooks request finished. Provider state is refreshed; unknown results are never submitted twice.');
                  }}
                  disabled={pending}
                >
                  {liveNote.irpProviderState === 'registering'
                    ? 'Check stalled CRN registration'
                    : liveNote.irpProviderState === 'registration_unknown'
                      ? 'Reconcile CRN with Whitebooks'
                      : liveNote.irpProviderState === 'registration_failed'
                        ? 'Retry confirmed CRN rejection'
                        : 'Register CRN with Whitebooks'}
                </Button>
              )}
            <Button
              variant="secondary"
              onClick={() => {
                void act(async () => {
                  const payload = await api.creditNoteIrpPayload(
                    organisationId,
                    liveNote.id,
                  );
                  await navigator.clipboard.writeText(payload);
                }, 'The credit-note (CRN) payload is on the clipboard, ready for the GSP.');
              }}
              disabled={pending}
            >
              Copy CRN payload
            </Button>
            {canModify && (
              <Button
                variant="secondary"
                onClick={() => {
                  void act(
                    async () => {
                      await api.renderCreditNote(organisationId, liveNote.id);
                      await refresh();
                    },
                    liveNote.renderedAvailable
                      ? 'Credit note PDF regenerated from frozen facts and current IRP evidence.'
                      : 'Credit note PDF generated from frozen facts.',
                  );
                }}
                disabled={pending}
              >
                {liveNote.renderedAvailable ? 'Regenerate CN PDF' : 'Generate CN PDF'}
              </Button>
            )}
            {liveNote.renderedAvailable && (
              <Button
                variant="ghost"
                onClick={() => {
                  void act(async () => {
                    await openPdf(() =>
                      api.downloadCreditNotePdf(organisationId, liveNote.id),
                    );
                  }, 'Credit note PDF opened.');
                }}
                disabled={pending}
              >
                Open CN PDF
              </Button>
            )}
          </Actions>
          {canModify && (
            <Field>
              <label htmlFor="cn-recipient-itc">
                Recipient ITC reversal (recorded, never enforced)
              </label>
              <select
                id="cn-recipient-itc"
                value={liveNote.recipientItcStatus}
                onChange={(event) => {
                  const next = event.currentTarget.value as
                    'not_applicable' | 'reversal_confirmed' | 'pending';
                  void act(async () => {
                    await api.updateCreditNoteRecipientItc(
                      organisationId,
                      liveNote.id,
                      {
                        recipientItcStatus: next,
                      },
                    );
                    await refresh();
                  }, 'Recipient ITC status recorded on the credit note.');
                }}
                disabled={pending}
              >
                <option value="not_applicable">Not applicable</option>
                <option value="pending">Pending</option>
                <option value="reversal_confirmed">Reversal confirmed</option>
              </select>
              <Hint>
                Section 34(2) as amended (Oct 2025): the tax reduction is conditional on
                the recipient reversing ITC. Recorded as evidence only.
              </Hint>
            </Field>
          )}
          {canCancel &&
            liveNote.irpProvider === 'whitebooks' &&
            liveNote.irpProviderState === 'registered' &&
            !liveNote.irpCancelWindowOpen && (
              <p className="text-muted-foreground">
                NIC accepts an IRN cancellation only within 24 hours of acknowledgement;
                this credit note&apos;s window has closed, so it remains registered and
                cannot be cancelled.
              </p>
            )}
          {canCancel &&
            liveNote.irpProvider === 'whitebooks' &&
            ((liveNote.irpProviderState === 'registered' &&
              liveNote.irpCancelWindowOpen) ||
              liveNote.irpProviderState === 'cancelling') && (
              <Disclosure label="Cancel credit note IRN at Whitebooks">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void act(async () => {
                      if (liveNote.irpProviderState === 'cancelling') {
                        await api.recoverCreditNoteProviderOperation(
                          organisationId,
                          liveNote.id,
                        );
                      } else {
                        await api.cancelCreditNoteIrp(organisationId, liveNote.id, {
                          reasonCode: formValue(data, 'cn-irp-cancel-reason') as
                            '1' | '2' | '3' | '4',
                          remark: formValue(data, 'cn-irp-cancel-remark'),
                        });
                      }
                      await refresh();
                    }, 'Whitebooks CRN cancellation check finished. Provider state is refreshed.');
                  }}
                >
                  <FieldRow>
                    <Field>
                      <label htmlFor="cn-irp-cancel-reason">Reason</label>
                      <select
                        id="cn-irp-cancel-reason"
                        name="cn-irp-cancel-reason"
                        defaultValue="2"
                      >
                        <option value="1">Duplicate</option>
                        <option value="2">Data entry mistake</option>
                        <option value="3">Order cancelled</option>
                        <option value="4">Other</option>
                      </select>
                    </Field>
                    <Field>
                      <label htmlFor="cn-irp-cancel-remark">Remark</label>
                      <input
                        id="cn-irp-cancel-remark"
                        name="cn-irp-cancel-remark"
                        required
                        minLength={3}
                        maxLength={2000}
                      />
                    </Field>
                  </FieldRow>
                  <Actions>
                    <Button type="submit" disabled={pending}>
                      {liveNote.irpProviderState === 'cancelling'
                        ? 'Check stalled CRN cancellation'
                        : 'Cancel CRN IRN at provider'}
                    </Button>
                  </Actions>
                </form>
              </Disclosure>
            )}
          {canCancel &&
            (liveNote.irpProviderState === 'not_requested' ||
              liveNote.irpProviderState === 'cancelled') && (
              <Disclosure label="Cancel this credit note (revives the invoice)">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                      await api.cancelCreditNote(organisationId, liveNote.id, {
                        note: creditNoteCancelNote,
                      });
                      setCreditNoteCancelNote('');
                      await refresh();
                    }, 'Credit note cancelled — the invoice reverts to submitted (only possible while its Measurement Book has not been re-invoiced).');
                  }}
                >
                  <Field>
                    <label htmlFor="cn-cancel-note">Why it is being cancelled</label>
                    <textarea
                      id="cn-cancel-note"
                      name="cn-cancel-note"
                      rows={2}
                      required
                      minLength={3}
                      maxLength={2000}
                      value={creditNoteCancelNote}
                      onChange={(event) => {
                        setCreditNoteCancelNote(event.currentTarget.value);
                      }}
                    />
                    <Hint>
                      Refused once the released Measurement Book has been re-invoiced —
                      the superseded invoice cannot be revived then.
                    </Hint>
                  </Field>
                  <Actions>
                    <Button type="submit" variant="destructive" disabled={pending}>
                      Cancel credit note
                    </Button>
                  </Actions>
                </form>
              </Disclosure>
            )}
        </>
      )}
    </>
  );
}
