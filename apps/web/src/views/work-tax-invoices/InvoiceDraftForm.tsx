import { useState } from 'react';
import type {
  Contact,
  GstRateMaster,
  MeasurementBook,
  TaxInvoiceDetailResponse,
  TaxInvoiceLineShape,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../../api.js';
import { formatDate, formatInr } from '../../format.js';
import { Button } from '../../ui/button.js';
import { Field, FieldRow, Actions, Hint } from '../../ui/form.js';
import { Disclosure } from '../../ui/disclosure.js';
import {
  emptyDraftLine,
  InvoiceLineEditor,
  toLineInputs,
  type DraftLine,
} from './InvoiceLineEditor.js';
import { GstRateOptions, type ActRunner } from './shared.js';

interface InvoiceDraftFormProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly billableBooks: readonly MeasurementBook[];
  readonly clients: readonly Contact[];
  readonly shipToContacts: readonly Contact[];
  readonly gstRates: readonly GstRateMaster[];
  /** Which shape this form STARTS on — the organisation's own default
   * (migration 0057). It seeds the switch below and nothing else: the
   * shape is a per-document choice the operator makes here. */
  readonly defaultInvoiceShape: TaxInvoiceLineShape;
  readonly startOpen: boolean;
  readonly pending: boolean;
  readonly act: ActRunner;
  readonly onCreated: (created: TaxInvoiceDetailResponse) => Promise<void>;
}

/**
 * The draft form behind its named action. It offers BOTH shapes
 * (migration 0057): one cumulative service line at a SAC for the whole
 * Measurement Book total — one SAC, one description, one rate — or an
 * itemised document whose HSN/SAC lines each carry their own quantity,
 * rate and GST rate.
 *
 * The switch starts on the organisation's default and is a choice about
 * THIS document. It is never derived from the buyer: the same railway
 * consignee may take a cumulative bill on one Work and an itemised goods
 * supply on the next.
 */
export function InvoiceDraftForm({
  api,
  organisationId,
  workId,
  billableBooks,
  clients,
  shipToContacts,
  gstRates,
  defaultInvoiceShape,
  startOpen,
  pending,
  act,
  onCreated,
}: InvoiceDraftFormProps) {
  const [lineShape, setLineShape] = useState<TaxInvoiceLineShape>(defaultInvoiceShape);
  const [lines, setLines] = useState<readonly DraftLine[]>(() => [emptyDraftLine()]);
  const itemised = lineShape === 'itemised';
  return (
    <Disclosure label="Draft a tax invoice" startOpen={startOpen}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          void act(async () => {
            const customerPoReference = formValue(data, 'invoice-customer-po');
            const unitLabel = formValue(data, 'invoice-unit-label');
            const notes = formValue(data, 'invoice-notes');
            const shipToContactId = formValue(data, 'invoice-ship-to');
            const numberPrefix = formValue(data, 'invoice-number-prefix');
            const common = {
              measurementBookId: formValue(data, 'invoice-mb'),
              invoiceDate: formValue(data, 'invoice-date'),
              placeOfSupply: formValue(data, 'invoice-place-of-supply'),
              reverseChargeApplicable:
                formValue(data, 'invoice-reverse-charge') === 'true',
              buyerContactId: formValue(data, 'invoice-buyer'),
              ...(customerPoReference === '' ? {} : { customerPoReference }),
              ...(unitLabel === '' ? {} : { unitLabel }),
              ...(notes === '' ? {} : { notes }),
              ...(shipToContactId === '' ? {} : { shipToContactId }),
              ...(numberPrefix === '' ? {} : { numberPrefix }),
            };
            const created = await api.createWorkTaxInvoice(
              organisationId,
              workId,
              itemised
                ? { ...common, lineShape: 'itemised', lines: toLineInputs(lines) }
                : {
                    ...common,
                    sacCode: formValue(data, 'invoice-sac'),
                    serviceDescription: formValue(data, 'invoice-description'),
                    gstRate: formValue(data, 'invoice-gst-rate'),
                  },
            );
            await onCreated(created);
            form.reset();
            setLines([emptyDraftLine()]);
          }, 'Draft tax invoice created — review it below and submit when it is right.');
        }}
      >
        <Field>
          <label htmlFor="invoice-mb">Measurement Book to bill</label>
          <select id="invoice-mb" name="invoice-mb" required defaultValue="">
            <option value="" disabled>
              Pick a finalized Measurement Book
            </option>
            {billableBooks.map((book) => (
              <option key={book.id} value={book.id}>
                {book.mbNumber ?? 'MB'} · {formatDate(book.mbDate)} ·{' '}
                {book.totalAmount === null ? '—' : formatInr(book.totalAmount)}
                {book.isFinal ? ' · final' : ''}
              </option>
            ))}
          </select>
          <Hint>
            Only finalized on-account and final Measurement Books can be invoiced, and
            each is billable once. Record Measurement Books are merged into an
            on-account one first.
          </Hint>
        </Field>
        <FieldRow>
          <Field>
            <label htmlFor="invoice-date">Invoice date</label>
            <input id="invoice-date" name="invoice-date" type="date" required />
            <Hint>Cannot precede the Measurement Book it bills.</Hint>
          </Field>
          <Field>
            <label htmlFor="invoice-line-shape">Invoice lines</label>
            <select
              id="invoice-line-shape"
              value={lineShape}
              onChange={(event) => {
                setLineShape(
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
              A choice about this invoice, not about the buyer. Itemised lines must add
              up to the Measurement Book total.
            </Hint>
          </Field>
        </FieldRow>
        {!itemised && (
          <Field>
            <label htmlFor="invoice-sac">SAC code</label>
            <input
              id="invoice-sac"
              name="invoice-sac"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              placeholder="998734"
            />
            <Hint>Six digits — the service code the whole invoice is raised at.</Hint>
          </Field>
        )}
        <Field>
          <label htmlFor="invoice-reverse-charge">Tax payable on reverse charge</label>
          <select
            id="invoice-reverse-charge"
            name="invoice-reverse-charge"
            required
            defaultValue=""
          >
            <option value="" disabled>
              Confirm who pays GST
            </option>
            <option value="false">No — supplier pays GST (forward charge)</option>
            <option value="true">
              Yes — recipient pays GST (issuance not supported yet)
            </option>
          </select>
          <Hint>
            This legal fact is frozen at submit. Reverse-charge invoices stay as drafts
            because their tax calculation is not implemented.
          </Hint>
        </Field>
        {itemised ? (
          <InvoiceLineEditor
            idPrefix="invoice"
            lines={lines}
            gstRates={gstRates}
            onChange={setLines}
          />
        ) : (
          <Field>
            <label htmlFor="invoice-description">Service description</label>
            <textarea
              id="invoice-description"
              name="invoice-description"
              rows={3}
              required
              minLength={3}
              maxLength={1000}
            />
            <Hint>What the invoice says it is for — it prints as the single line.</Hint>
          </Field>
        )}
        <FieldRow>
          {!itemised && (
            <Field>
              <label htmlFor="invoice-gst-rate">GST rate (%)</label>
              {gstRates.length > 0 ? (
                <select
                  id="invoice-gst-rate"
                  name="invoice-gst-rate"
                  required
                  defaultValue=""
                >
                  <option value="" disabled>
                    Pick a notified rate
                  </option>
                  <GstRateOptions rates={gstRates} />
                </select>
              ) : (
                <input
                  id="invoice-gst-rate"
                  name="invoice-gst-rate"
                  inputMode="decimal"
                  required
                  placeholder="18"
                />
              )}
              <Hint>
                Only rates the GST rate master lists for the invoice date are accepted.
                The CGST/SGST split is half each.
              </Hint>
            </Field>
          )}
          <Field>
            <label htmlFor="invoice-place-of-supply">Place of supply</label>
            <input
              id="invoice-place-of-supply"
              name="invoice-place-of-supply"
              inputMode="numeric"
              pattern="[0-9]{2}"
              maxLength={2}
              required
              placeholder="27"
            />
            <Hint>
              Two-digit state code. Against your own state it decides CGST+SGST (within
              the state) or IGST (across states) at submit.
            </Hint>
          </Field>
        </FieldRow>
        <Field>
          <label htmlFor="invoice-buyer">Buyer</label>
          <select id="invoice-buyer" name="invoice-buyer" required defaultValue="">
            <option value="" disabled>
              Pick a client contact
            </option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.designation}
              </option>
            ))}
          </select>
          <Hint>
            Snapshotted at submit, so a correction to the contact before submitting is
            reflected and one after it is not. The buyer needs an address, state code
            and PIN by then.
          </Hint>
        </Field>
        <FieldRow>
          <Field>
            <label htmlFor="invoice-customer-po">Customer PO/reference</label>
            <input
              id="invoice-customer-po"
              name="invoice-customer-po"
              minLength={3}
              maxLength={500}
            />
          </Field>
          <Field>
            <label htmlFor="invoice-number-prefix">Number prefix override</label>
            <input
              id="invoice-number-prefix"
              name="invoice-number-prefix"
              pattern="[A-Z][A-Z0-9]{0,7}"
              maxLength={8}
              placeholder="P10"
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field>
            <label htmlFor="invoice-unit-label">Unit label</label>
            <input
              id="invoice-unit-label"
              name="invoice-unit-label"
              maxLength={20}
              placeholder="set"
            />
          </Field>
          <Field>
            <label htmlFor="invoice-ship-to">Ship to (optional)</label>
            <select id="invoice-ship-to" name="invoice-ship-to" defaultValue="">
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
          <label htmlFor="invoice-notes">Invoice notes</label>
          <textarea
            id="invoice-notes"
            name="invoice-notes"
            rows={2}
            minLength={3}
            maxLength={4000}
          />
          <Hint>Blank uses the organisation's standing invoice note.</Hint>
        </Field>
        <Actions>
          <Button type="submit" disabled={pending}>
            Create draft
          </Button>
        </Actions>
      </form>
    </Disclosure>
  );
}
