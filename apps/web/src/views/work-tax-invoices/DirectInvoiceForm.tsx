import { useState } from 'react';
import type {
  Contact,
  GstRateMaster,
  TaxInvoiceDetailResponse,
  TaxInvoiceLineShape,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../../api.js';
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

interface DirectInvoiceFormProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly clients: readonly Contact[];
  readonly shipToContacts: readonly Contact[];
  readonly gstRates: readonly GstRateMaster[];
  readonly defaultInvoiceShape: TaxInvoiceLineShape;
  readonly startOpen: boolean;
  readonly pending: boolean;
  readonly act: ActRunner;
  readonly onCreated: (created: TaxInvoiceDetailResponse) => Promise<void>;
}

/**
 * The DIRECT invoice: a GST invoice raised against a private customer,
 * outside any works contract.
 *
 * It descends from no LOA, so it names no Work and no Measurement Book —
 * and therefore has nothing that measured what the supply is worth. It
 * states that figure instead, which is the one field this form has and
 * the Work's does not. Everything downstream is the same code path: the
 * same number series, the same GST split, the same buyer snapshot, the
 * same IRP payload, the same PDF.
 *
 * A CUMULATIVE invoice states its taxable value. An ITEMISED one does not
 * state it at all: the lines already say what the supply is worth, and
 * asking for the same figure twice would invite the two to disagree — so
 * the field disappears with the shape and the server sums the lines.
 */
export function DirectInvoiceForm({
  api,
  organisationId,
  clients,
  shipToContacts,
  gstRates,
  defaultInvoiceShape,
  startOpen,
  pending,
  act,
  onCreated,
}: DirectInvoiceFormProps) {
  const [lineShape, setLineShape] = useState<TaxInvoiceLineShape>(defaultInvoiceShape);
  const [lines, setLines] = useState<readonly DraftLine[]>(() => [emptyDraftLine()]);
  const itemised = lineShape === 'itemised';
  return (
    <Disclosure label="Raise an invoice for a private customer" startOpen={startOpen}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          void act(async () => {
            const common = readInvoiceFacts(data, 'direct-invoice');
            const created = await api.createDirectTaxInvoice(
              organisationId,
              itemised
                ? { ...common, lineShape: 'itemised', lines: toLineInputs(lines) }
                : {
                    ...common,
                    ...readCumulativeFacts(data, 'direct-invoice'),
                    taxableValue: formValue(data, 'direct-invoice-taxable-value'),
                  },
            );
            await onCreated(created);
            form.reset();
            setLines([emptyDraftLine()]);
          }, 'Draft tax invoice created — review it below and submit when it is right.');
        }}
      >
        <InvoiceFactFields
          idPrefix="direct-invoice"
          lineShape={lineShape}
          onLineShapeChange={setLineShape}
          lines={lines}
          onLinesChange={setLines}
          clients={clients}
          shipToContacts={shipToContacts}
          gstRates={gstRates}
          lineShapeHint="A choice about this invoice, not about the buyer. Itemised lines state their own values, and their sum is what the invoice is worth."
        />
        {!itemised && (
          <Field>
            <label htmlFor="direct-invoice-taxable-value">Taxable value</label>
            <input
              id="direct-invoice-taxable-value"
              name="direct-invoice-taxable-value"
              inputMode="decimal"
              required
              placeholder="125000.00"
            />
            <Hint>
              What the supply is worth BEFORE tax, in rupees. Stated rather than
              measured, because no Measurement Book stands behind this invoice. GST is
              added on top at submit.
            </Hint>
          </Field>
        )}
        <Actions>
          <Button type="submit" disabled={pending}>
            Create draft
          </Button>
        </Actions>
      </form>
    </Disclosure>
  );
}
