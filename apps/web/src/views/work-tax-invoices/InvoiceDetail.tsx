import { useState } from 'react';
import type {
  Contact,
  GstRateMaster,
  TaxInvoice,
  TaxInvoiceLine,
  TaxInvoiceLineShape,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../../api.js';
import { formatDate, formatInr } from '../../format.js';
import { openPdf } from '../../lib/openPdf.js';
import { Button } from '../../ui/button.js';
import { ConfirmDialog } from '../../ui/confirm.js';
import { StatusChip } from '../../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../../ui/table.js';
import { Field, FieldRow, Actions, Hint } from '../../ui/form.js';
import { Disclosure } from '../../ui/disclosure.js';
import {
  draftLinesOf,
  emptyDraftLine,
  InvoiceLineEditor,
  toLineInputs,
  type DraftLine,
} from './InvoiceLineEditor.js';
import { BuyerOptions, GstRateOptions, type ActRunner } from './shared.js';
import { NumericInput } from '../../ui/numeric-input.js';

interface InvoiceDetailProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly invoice: TaxInvoice;
  /** The lines of an ITEMISED invoice, in print order; empty for a
   * cumulative one, whose single line lives in the header fields. */
  readonly lines: readonly TaxInvoiceLine[];
  readonly clients: readonly Contact[];
  readonly shipToContacts: readonly Contact[];
  readonly gstRates: readonly GstRateMaster[];
  readonly canModify: boolean;
  readonly canIssue: boolean;
  /** The signing authority (0091), separate from canIssue. */
  readonly canSign: boolean;
  readonly pending: boolean;
  readonly act: ActRunner;
  /** Reloads the register and reopens this invoice's detail. */
  readonly refresh: () => Promise<void>;
  /** Clears the open detail and reloads the register after the draft is
   * deleted. */
  readonly onDeleted: () => Promise<void>;
}

/** The opened invoice: its frozen facts, the draft edit form, and the
 * draft/submitted lifecycle actions. Mounted with key=invoice id so the
 * delete confirmation resets whenever another invoice is opened. */
export function InvoiceDetail({
  api,
  organisationId,
  invoice,
  lines,
  clients,
  shipToContacts,
  gstRates,
  canModify,
  canIssue,
  canSign,
  pending,
  act,
  refresh,
  onDeleted,
}: InvoiceDetailProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editShape, setEditShape] = useState<TaxInvoiceLineShape>(invoice.lineShape);
  const [editLines, setEditLines] = useState<readonly DraftLine[]>(() =>
    lines.length > 0 ? draftLinesOf(lines) : [emptyDraftLine()],
  );
  const editItemised = editShape === 'itemised';
  return (
    <>
      <h3>
        {invoice.invoiceNumber ?? 'Draft tax invoice'}{' '}
        <StatusChip status={invoice.status}>{invoice.status}</StatusChip>
        {invoice.status === 'submitted' &&
          (invoice.irpReportingOverdue ? (
            <>
              {' '}
              <StatusChip status="expired">IRP overdue</StatusChip>
            </>
          ) : (
            invoice.irpReportingDeadline !== null &&
            invoice.irpProviderState !== 'registered' &&
            invoice.irpProviderState !== 'registered_unverified' && (
              <>
                {' '}
                <StatusChip status="review">
                  IRP due {formatDate(invoice.irpReportingDeadline)}
                </StatusChip>
              </>
            )
          ))}
      </h3>

      {invoice.status === 'submitted' && invoice.irpReportingOverdue && (
        <p className="text-muted-foreground">
          The IRP reporting window closed on{' '}
          {invoice.irpReportingDeadline === null
            ? '—'
            : formatDate(invoice.irpReportingDeadline)}{' '}
          with the invoice unregistered. It remains valid locally; a fresh IRP
          registration is refused. Cancel it with a note and raise a corrected invoice
          if it must be reported.
        </p>
      )}

      <dl>
        <dt>Measurement Book</dt>
        <dd>{invoice.mbNumber ?? '—'}</dd>
        <dt>Invoice date</dt>
        <dd>{formatDate(invoice.invoiceDate)}</dd>
        <dt>Lines</dt>
        <dd>
          {invoice.lineShape === 'itemised'
            ? 'Itemised HSN/SAC lines'
            : 'One cumulative service line'}
        </dd>
        {invoice.sacCode !== null && (
          <>
            <dt>SAC</dt>
            <dd>{invoice.sacCode}</dd>
          </>
        )}
        {invoice.gstRate !== null && (
          <>
            <dt>GST rate</dt>
            <dd>{invoice.gstRate}%</dd>
          </>
        )}
        <dt>Place of supply</dt>
        <dd>{invoice.placeOfSupply}</dd>
        <dt>Reverse charge</dt>
        <dd>
          {invoice.reverseChargeApplicable === null
            ? 'Not captured'
            : invoice.reverseChargeApplicable
              ? 'Yes'
              : 'No'}
        </dd>
        {invoice.customerPoReference !== null && (
          <>
            <dt>Customer PO/reference</dt>
            <dd>{invoice.customerPoReference}</dd>
          </>
        )}
        {invoice.unitLabel !== null && (
          <>
            <dt>Unit</dt>
            <dd>{invoice.unitLabel}</dd>
          </>
        )}
        {invoice.fyLabel !== null && (
          <>
            <dt>Financial year</dt>
            <dd>{invoice.fyLabel}</dd>
          </>
        )}
        {invoice.irpReportingDeadline !== null && (
          <>
            <dt>IRP reporting deadline</dt>
            <dd>{formatDate(invoice.irpReportingDeadline)}</dd>
          </>
        )}
      </dl>

      {invoice.lineShape === 'itemised' ? (
        <DataTable>
          <caption className="sr-only">The lines this invoice bills</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Description</th>
              <th scope="col">HSN / SAC</th>
              <th scope="col">Qty</th>
              <th scope="col">Unit</th>
              <th scope="col">Rate</th>
              <th scope="col">GST rate</th>
              <th scope="col">Taxable value</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.position}</td>
                <td className={wrapCell}>{line.description}</td>
                <td>
                  {line.hsnSacCode}
                  {line.isService ? ' · service' : ' · goods'}
                </td>
                <td className={numericCell}>{line.quantity}</td>
                <td>{line.unitLabel ?? '—'}</td>
                <td className={numericCell}>{formatInr(line.unitRate)}</td>
                <td className={numericCell}>{line.gstRate}%</td>
                <td className={numericCell}>
                  {line.taxableValue === null ? '—' : formatInr(line.taxableValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className={wrapCell}>{invoice.serviceDescription}</p>
      )}

      {invoice.status === 'submitted' || invoice.status === 'cancelled' ? (
        <DataTable>
          <caption className="sr-only">
            The amounts frozen when this invoice was submitted
          </caption>
          <tbody>
            <tr>
              <th scope="row">Taxable value</th>
              <td className={numericCell}>
                {invoice.taxableValue === null ? '—' : formatInr(invoice.taxableValue)}
              </td>
            </tr>
            {/* Exactly one of the two splits is live: CGST+SGST within
                the state, IGST across it. Showing the zero half would
                only invite the reader to wonder what it means. */}
            {invoice.igstAmount !== null && Number(invoice.igstAmount) > 0 ? (
              <tr>
                <th scope="row">IGST</th>
                <td className={numericCell}>{formatInr(invoice.igstAmount)}</td>
              </tr>
            ) : (
              <>
                <tr>
                  <th scope="row">CGST</th>
                  <td className={numericCell}>
                    {invoice.cgstAmount === null ? '—' : formatInr(invoice.cgstAmount)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">SGST</th>
                  <td className={numericCell}>
                    {invoice.sgstAmount === null ? '—' : formatInr(invoice.sgstAmount)}
                  </td>
                </tr>
              </>
            )}
            <tr>
              <th scope="row">Total</th>
              <td className={numericCell}>
                {invoice.totalAmount === null ? '—' : formatInr(invoice.totalAmount)}
              </td>
            </tr>
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">
          The amounts are computed at submit — from the Measurement Book total for a
          cumulative invoice, from the lines for an itemised one — so a draft carries
          none yet.
        </p>
      )}

      {invoice.cancellationNote !== null && (
        <p>
          <strong>Cancelled:</strong> {invoice.cancellationNote}
        </p>
      )}

      {invoice.status === 'draft' && canModify && (
        <Disclosure label="Edit this draft">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void act(async () => {
                const customerPoReference = formValue(data, 'edit-invoice-customer-po');
                const unitLabel = formValue(data, 'edit-invoice-unit-label');
                const notes = formValue(data, 'edit-invoice-notes');
                const shipToContactId = formValue(data, 'edit-invoice-ship-to');
                const numberPrefix = formValue(data, 'edit-invoice-number-prefix');
                const common = {
                  invoiceDate: formValue(data, 'edit-invoice-date'),
                  placeOfSupply: formValue(data, 'edit-invoice-place-of-supply'),
                  reverseChargeApplicable:
                    formValue(data, 'edit-invoice-reverse-charge') === 'true',
                  buyerContactId: formValue(data, 'edit-invoice-buyer'),
                  ...(customerPoReference === '' ? {} : { customerPoReference }),
                  ...(unitLabel === '' ? {} : { unitLabel }),
                  ...(notes === '' ? {} : { notes }),
                  ...(shipToContactId === '' ? {} : { shipToContactId }),
                  ...(numberPrefix === '' ? {} : { numberPrefix }),
                };
                await api.updateTaxInvoice(
                  organisationId,
                  invoice.id,
                  editItemised
                    ? {
                        ...common,
                        lineShape: 'itemised',
                        lines: toLineInputs(editLines),
                      }
                    : {
                        ...common,
                        sacCode: formValue(data, 'edit-invoice-sac'),
                        serviceDescription: formValue(data, 'edit-invoice-description'),
                        gstRate: formValue(data, 'edit-invoice-gst-rate'),
                      },
                );
                await refresh();
              }, 'Draft tax invoice updated.');
            }}
          >
            <FieldRow>
              <Field>
                <label htmlFor="edit-invoice-date">Invoice date</label>
                <input
                  id="edit-invoice-date"
                  name="edit-invoice-date"
                  type="date"
                  required
                  defaultValue={invoice.invoiceDate}
                />
              </Field>
              <Field>
                <label htmlFor="edit-invoice-line-shape">Invoice lines</label>
                <select
                  id="edit-invoice-line-shape"
                  value={editShape}
                  onChange={(event) => {
                    setEditShape(
                      event.currentTarget.value === 'itemised'
                        ? 'itemised'
                        : 'service_cumulative',
                    );
                  }}
                >
                  <option value="service_cumulative">
                    One cumulative service line (SAC)
                  </option>
                  <option value="itemised">Itemised HSN/SAC lines</option>
                </select>
                <Hint>
                  Editable while this invoice is a draft; frozen with every other
                  business fact once it is submitted.
                </Hint>
              </Field>
            </FieldRow>
            {!editItemised && (
              <Field>
                <label htmlFor="edit-invoice-sac">SAC code</label>
                <input
                  id="edit-invoice-sac"
                  name="edit-invoice-sac"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  defaultValue={invoice.sacCode ?? ''}
                />
              </Field>
            )}
            <Field>
              <label htmlFor="edit-invoice-reverse-charge">
                Tax payable on reverse charge
              </label>
              <select
                id="edit-invoice-reverse-charge"
                name="edit-invoice-reverse-charge"
                required
                defaultValue={
                  invoice.reverseChargeApplicable === null
                    ? ''
                    : String(invoice.reverseChargeApplicable)
                }
              >
                <option value="" disabled>
                  Confirm who pays GST
                </option>
                <option value="false">No — supplier pays GST (forward charge)</option>
                <option value="true">
                  Yes — recipient pays GST (issuance not supported yet)
                </option>
              </select>
            </Field>
            {editItemised ? (
              <InvoiceLineEditor
                idPrefix="edit-invoice"
                lines={editLines}
                gstRates={gstRates}
                onChange={setEditLines}
              />
            ) : (
              <Field>
                <label htmlFor="edit-invoice-description">Service description</label>
                <textarea
                  id="edit-invoice-description"
                  name="edit-invoice-description"
                  rows={3}
                  required
                  minLength={3}
                  maxLength={1000}
                  defaultValue={invoice.serviceDescription ?? ''}
                />
              </Field>
            )}
            <FieldRow>
              {!editItemised && (
                <Field>
                  <label htmlFor="edit-invoice-gst-rate">GST rate (%)</label>
                  {gstRates.length > 0 ? (
                    <select
                      id="edit-invoice-gst-rate"
                      name="edit-invoice-gst-rate"
                      required
                      defaultValue={invoice.gstRate ?? ''}
                    >
                      <GstRateOptions rates={gstRates} />
                    </select>
                  ) : (
                    <NumericInput
                      id="edit-invoice-gst-rate"
                      name="edit-invoice-gst-rate"
                      required
                      defaultValue={invoice.gstRate ?? ''}
                    />
                  )}
                </Field>
              )}
              <Field>
                <label htmlFor="edit-invoice-place-of-supply">Place of supply</label>
                <input
                  id="edit-invoice-place-of-supply"
                  name="edit-invoice-place-of-supply"
                  inputMode="numeric"
                  pattern="[0-9]{2}"
                  maxLength={2}
                  required
                  defaultValue={invoice.placeOfSupply}
                />
              </Field>
            </FieldRow>
            <Field>
              <label htmlFor="edit-invoice-buyer">Buyer</label>
              <select
                id="edit-invoice-buyer"
                name="edit-invoice-buyer"
                required
                defaultValue={invoice.buyerContactId ?? ''}
              >
                <option value="" disabled>
                  Pick a client contact
                </option>
                <BuyerOptions
                  clients={clients}
                  allContacts={shipToContacts}
                  currentBuyerId={invoice.buyerContactId}
                />
              </select>
            </Field>
            <FieldRow>
              <Field>
                <label htmlFor="edit-invoice-customer-po">Customer PO/reference</label>
                <input
                  id="edit-invoice-customer-po"
                  name="edit-invoice-customer-po"
                  minLength={3}
                  maxLength={500}
                  defaultValue={invoice.customerPoReference ?? ''}
                />
              </Field>
              <Field>
                <label htmlFor="edit-invoice-number-prefix">
                  Number prefix override
                </label>
                <input
                  id="edit-invoice-number-prefix"
                  name="edit-invoice-number-prefix"
                  pattern="[A-Z][A-Z0-9]{0,7}"
                  maxLength={8}
                  defaultValue={invoice.numberPrefix ?? ''}
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field>
                <label htmlFor="edit-invoice-unit-label">Unit label</label>
                <input
                  id="edit-invoice-unit-label"
                  name="edit-invoice-unit-label"
                  maxLength={20}
                  defaultValue={invoice.unitLabel ?? ''}
                />
              </Field>
              <Field>
                <label htmlFor="edit-invoice-ship-to">Ship to (optional)</label>
                <select
                  id="edit-invoice-ship-to"
                  name="edit-invoice-ship-to"
                  defaultValue={invoice.shipToContactId ?? ''}
                >
                  <option value="">Same as buyer</option>
                  {shipToContacts.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.designation}
                    </option>
                  ))}
                </select>
              </Field>
            </FieldRow>
            <Field>
              <label htmlFor="edit-invoice-notes">Invoice notes</label>
              <textarea
                id="edit-invoice-notes"
                name="edit-invoice-notes"
                rows={2}
                minLength={3}
                maxLength={4000}
                defaultValue={invoice.notes ?? ''}
              />
            </Field>
            <Actions>
              <Button type="submit" disabled={pending}>
                Save draft
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}

      <Actions>
        {invoice.status === 'draft' && canIssue && (
          <Button
            onClick={() => {
              void act(async () => {
                await api.submitTaxInvoice(organisationId, invoice.id);
                await refresh();
              }, 'Tax invoice submitted — it is numbered, its amounts are frozen, and the Measurement Book it bills is closed.');
            }}
            disabled={pending}
          >
            Submit invoice
          </Button>
        )}
        {invoice.status === 'draft' && canModify && (
          <Button
            variant="ghost"
            aria-haspopup="dialog"
            onClick={() => {
              setConfirmingDelete(true);
            }}
            disabled={pending}
          >
            Delete draft
          </Button>
        )}
        {invoice.status === 'submitted' && canModify && (
          <Button
            variant="secondary"
            onClick={() => {
              void act(
                async () => {
                  await api.renderTaxInvoice(organisationId, invoice.id);
                  await refresh();
                },
                invoice.renderedAvailable
                  ? 'Tax invoice PDF regenerated from frozen invoice facts and current IRP evidence.'
                  : 'Tax invoice PDF generated from frozen invoice facts.',
              );
            }}
            disabled={pending}
          >
            {invoice.renderedAvailable ? 'Regenerate PDF' : 'Generate PDF'}
          </Button>
        )}
        {invoice.renderedAvailable && (
          <Button
            variant="ghost"
            onClick={() => {
              void act(async () => {
                await openPdf(() =>
                  api.downloadTaxInvoicePdf(organisationId, invoice.id),
                );
              }, 'Tax invoice PDF opened.');
            }}
            disabled={pending}
          >
            Open PDF
          </Button>
        )}
        {/* SEND FOR SIGNING (0091, ADR-0012). A submitted invoice with a
            render, for a member holding the signing authority. */}
        {invoice.status === 'submitted' && invoice.renderedAvailable && canSign && (
          <Button
            variant="ghost"
            onClick={() => {
              void act(async () => {
                await api.createSigningRequest(organisationId, {
                  documentType: 'tax_invoice',
                  documentId: invoice.id,
                });
              }, 'Sent to the signing queue.');
            }}
            disabled={pending}
          >
            Send for signing
          </Button>
        )}
      </Actions>

      {confirmingDelete && invoice.status === 'draft' && (
        <ConfirmDialog
          title="Delete this draft tax invoice?"
          description="Nothing has been numbered, so nothing is lost but the typing."
          cancelLabel="Keep it"
          confirmLabel="Delete it"
          pending={pending}
          onCancel={() => {
            setConfirmingDelete(false);
          }}
          onConfirm={() => {
            void act(async () => {
              await api.deleteTaxInvoice(organisationId, invoice.id);
              setConfirmingDelete(false);
              await onDeleted();
            }, 'Draft tax invoice deleted.');
          }}
        />
      )}
    </>
  );
}

interface InvoiceCancelPanelProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly invoice: TaxInvoice;
  readonly pending: boolean;
  readonly act: ActRunner;
  readonly refresh: () => Promise<void>;
}

/** Local cancellation of a submitted invoice — offered only while no IRP
 * registration is live; otherwise the lock is explained instead. The
 * caller gates on canCancel. */
export function InvoiceCancelPanel({
  api,
  organisationId,
  invoice,
  pending,
  act,
  refresh,
}: InvoiceCancelPanelProps) {
  const [cancelNote, setCancelNote] = useState('');
  if (invoice.status !== 'submitted') return null;
  if (
    invoice.irpProviderState !== 'not_requested' &&
    invoice.irpProviderState !== 'cancelled'
  ) {
    return (
      <p className="text-muted-foreground">
        Local invoice cancellation is locked while IRP state is{' '}
        <strong>{invoice.irpProviderState}</strong>. Resolve registration and cancel any
        EWB and IRN first.
      </p>
    );
  }
  return (
    <Disclosure label="Cancel this invoice">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await api.cancelTaxInvoice(organisationId, invoice.id, {
              note: cancelNote,
            });
            await refresh();
            setCancelNote('');
          }, 'Tax invoice cancelled — the Measurement Book it billed is released for a corrected invoice.');
        }}
      >
        <Field>
          <label htmlFor="invoice-cancel-note">Why it is being cancelled</label>
          <textarea
            id="invoice-cancel-note"
            name="invoice-cancel-note"
            rows={2}
            required
            minLength={3}
            maxLength={2000}
            value={cancelNote}
            onChange={(event) => {
              setCancelNote(event.currentTarget.value);
            }}
          />
          <Hint>
            A cancelled invoice keeps its number for ever — the number is never reused —
            and this note is the record of why.
          </Hint>
        </Field>
        <Actions>
          <Button type="submit" variant="destructive" disabled={pending}>
            Cancel invoice
          </Button>
        </Actions>
      </form>
    </Disclosure>
  );
}
