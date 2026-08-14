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
import { Field, Actions, Hint } from '../../ui/form.js';
import { Disclosure } from '../../ui/disclosure.js';
import {
  InvoiceFactFields,
  readCumulativeFacts,
  readInvoiceFacts,
} from './InvoiceFactFields.js';
import { emptyDraftLine, toLineInputs, type DraftLine } from './InvoiceLineEditor.js';
import { type ActRunner } from './shared.js';

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
 *
 * The Measurement Book is the only fact this form asks for that the
 * direct-invoice form does not; every other field is the shared
 * `InvoiceFactFields` block, so the two forms cannot drift apart.
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
            const common = {
              measurementBookId: formValue(data, 'invoice-mb'),
              ...readInvoiceFacts(data, 'invoice'),
            };
            const created = await api.createWorkTaxInvoice(
              organisationId,
              workId,
              itemised
                ? { ...common, lineShape: 'itemised', lines: toLineInputs(lines) }
                : { ...common, ...readCumulativeFacts(data, 'invoice') },
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
        <InvoiceFactFields
          idPrefix="invoice"
          lineShape={lineShape}
          onLineShapeChange={setLineShape}
          lines={lines}
          onLinesChange={setLines}
          clients={clients}
          shipToContacts={shipToContacts}
          gstRates={gstRates}
          invoiceDateHint="Cannot precede the Measurement Book it bills."
          lineShapeHint="A choice about this invoice, not about the buyer. Itemised lines must add up to the Measurement Book total."
        />
        <Actions>
          <Button type="submit" disabled={pending}>
            Create draft
          </Button>
        </Actions>
      </form>
    </Disclosure>
  );
}
