import type { Contact, GstRateMaster, TaxInvoiceLineShape } from '@auto-mb/contracts';
import { formValue } from '../../api.js';
import { todayIso } from '../../format.js';
import { Field, FieldRow, Hint } from '../../ui/form.js';
import { InvoiceLineEditor, type DraftLine } from './InvoiceLineEditor.js';
import { BuyerOptions, GstRateOptions } from './shared.js';

/**
 * Everything a tax invoice states about itself that is the same whether
 * it bills a Measurement Book or a private customer.
 *
 * Only two facts differ between the two forms: an MB-backed invoice names
 * the Measurement Book it bills, and a direct one states the taxable value
 * it would otherwise have measured. Everything else — the date, the line
 * shape and the line content, the GST rate, the place of supply, the
 * buyer, the ship-to, the references and the note — is one document model
 * with one set of rules, so it is one component rather than two that drift.
 *
 * The fields are uncontrolled and read back by name at submit, which is
 * why `readInvoiceFacts` lives here beside them: the names are an internal
 * detail of this block and no caller should have to know them.
 */

/** The `id`/`name` prefix a mounted copy of this block uses, so two forms
 * can exist without colliding labels. */
export type InvoiceFieldPrefix = 'invoice' | 'direct-invoice';

interface InvoiceFactFieldsProps {
  readonly idPrefix: InvoiceFieldPrefix;
  readonly lineShape: TaxInvoiceLineShape;
  readonly onLineShapeChange: (shape: TaxInvoiceLineShape) => void;
  readonly lines: readonly DraftLine[];
  readonly onLinesChange: (lines: readonly DraftLine[]) => void;
  readonly clients: readonly Contact[];
  readonly shipToContacts: readonly Contact[];
  readonly gstRates: readonly GstRateMaster[];
  /** What the invoice date may not precede, stated for the operator. The
   * MB-backed form names its Measurement Book; the direct form has no
   * such floor and passes nothing. */
  readonly invoiceDateHint?: string;
  /** What choosing itemised lines commits this document to. The rule
   * differs by form — an MB-backed invoice's lines must add up to the
   * measured total, a direct one's lines ARE the total — so the sentence
   * belongs to the caller. */
  readonly lineShapeHint: string;
}

/** The document facts both invoice forms collect, read back from the
 * submitted form. The optional ones are OMITTED rather than sent empty:
 * the request schema forbids additional properties and refuses a blank
 * string where it expects a reference. */
export function readInvoiceFacts(data: FormData, idPrefix: InvoiceFieldPrefix) {
  const customerPoReference = formValue(data, `${idPrefix}-customer-po`);
  const unitLabel = formValue(data, `${idPrefix}-unit-label`);
  const notes = formValue(data, `${idPrefix}-notes`);
  const shipToContactId = formValue(data, `${idPrefix}-ship-to`);
  const numberPrefix = formValue(data, `${idPrefix}-number-prefix`);
  return {
    invoiceDate: formValue(data, `${idPrefix}-date`),
    placeOfSupply: formValue(data, `${idPrefix}-place-of-supply`),
    reverseChargeApplicable: formValue(data, `${idPrefix}-reverse-charge`) === 'true',
    buyerContactId: formValue(data, `${idPrefix}-buyer`),
    ...(customerPoReference === '' ? {} : { customerPoReference }),
    ...(unitLabel === '' ? {} : { unitLabel }),
    ...(notes === '' ? {} : { notes }),
    ...(shipToContactId === '' ? {} : { shipToContactId }),
    ...(numberPrefix === '' ? {} : { numberPrefix }),
  };
}

/** The cumulative shape's three header fields, read back the same way.
 * An itemised invoice has none of them — its document is its lines. */
export function readCumulativeFacts(data: FormData, idPrefix: InvoiceFieldPrefix) {
  return {
    sacCode: formValue(data, `${idPrefix}-sac`),
    serviceDescription: formValue(data, `${idPrefix}-description`),
    gstRate: formValue(data, `${idPrefix}-gst-rate`),
  };
}

export function InvoiceFactFields({
  idPrefix,
  lineShape,
  onLineShapeChange,
  lines,
  onLinesChange,
  clients,
  shipToContacts,
  gstRates,
  invoiceDateHint,
  lineShapeHint,
}: InvoiceFactFieldsProps) {
  const itemised = lineShape === 'itemised';
  return (
    <>
      <FieldRow>
        <Field>
          <label htmlFor={`${idPrefix}-date`}>Invoice date</label>
          <input
            id={`${idPrefix}-date`}
            name={`${idPrefix}-date`}
            type="date"
            required
            defaultValue={todayIso()}
          />
          {invoiceDateHint !== undefined && <Hint>{invoiceDateHint}</Hint>}
        </Field>
        <Field>
          <label htmlFor={`${idPrefix}-line-shape`}>Invoice lines</label>
          <select
            id={`${idPrefix}-line-shape`}
            value={lineShape}
            onChange={(event) => {
              onLineShapeChange(
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
          <Hint>{lineShapeHint}</Hint>
        </Field>
      </FieldRow>
      {!itemised && (
        <Field>
          <label htmlFor={`${idPrefix}-sac`}>SAC code</label>
          <input
            id={`${idPrefix}-sac`}
            name={`${idPrefix}-sac`}
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
        <label htmlFor={`${idPrefix}-reverse-charge`}>
          Tax payable on reverse charge
        </label>
        <select
          id={`${idPrefix}-reverse-charge`}
          name={`${idPrefix}-reverse-charge`}
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
          idPrefix={idPrefix}
          lines={lines}
          gstRates={gstRates}
          onChange={onLinesChange}
        />
      ) : (
        <Field>
          <label htmlFor={`${idPrefix}-description`}>Service description</label>
          <textarea
            id={`${idPrefix}-description`}
            name={`${idPrefix}-description`}
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
            <label htmlFor={`${idPrefix}-gst-rate`}>GST rate (%)</label>
            {gstRates.length > 0 ? (
              <select
                id={`${idPrefix}-gst-rate`}
                name={`${idPrefix}-gst-rate`}
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
                id={`${idPrefix}-gst-rate`}
                name={`${idPrefix}-gst-rate`}
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
          <label htmlFor={`${idPrefix}-place-of-supply`}>Place of supply</label>
          <input
            id={`${idPrefix}-place-of-supply`}
            name={`${idPrefix}-place-of-supply`}
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
        <label htmlFor={`${idPrefix}-buyer`}>Buyer</label>
        <select
          id={`${idPrefix}-buyer`}
          name={`${idPrefix}-buyer`}
          required
          defaultValue=""
        >
          <option value="" disabled>
            Pick a client contact
          </option>
          <BuyerOptions clients={clients} allContacts={shipToContacts} />
        </select>
        <Hint>
          Snapshotted at submit, so a correction to the contact before submitting is
          reflected and one after it is not. The buyer needs an address, state code and
          PIN by then.
        </Hint>
      </Field>
      <FieldRow>
        <Field>
          <label htmlFor={`${idPrefix}-customer-po`}>Customer PO/reference</label>
          <input
            id={`${idPrefix}-customer-po`}
            name={`${idPrefix}-customer-po`}
            minLength={3}
            maxLength={500}
          />
        </Field>
        <Field>
          <label htmlFor={`${idPrefix}-number-prefix`}>Number prefix override</label>
          <input
            id={`${idPrefix}-number-prefix`}
            name={`${idPrefix}-number-prefix`}
            pattern="[A-Z][A-Z0-9]{0,7}"
            maxLength={8}
            placeholder="P10"
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field>
          <label htmlFor={`${idPrefix}-unit-label`}>Unit label</label>
          <input
            id={`${idPrefix}-unit-label`}
            name={`${idPrefix}-unit-label`}
            maxLength={20}
            placeholder="set"
          />
        </Field>
        <Field>
          <label htmlFor={`${idPrefix}-ship-to`}>Ship to (optional)</label>
          <select
            id={`${idPrefix}-ship-to`}
            name={`${idPrefix}-ship-to`}
            defaultValue=""
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
        <label htmlFor={`${idPrefix}-notes`}>Invoice notes</label>
        <textarea
          id={`${idPrefix}-notes`}
          name={`${idPrefix}-notes`}
          rows={2}
          minLength={3}
          maxLength={4000}
        />
        <Hint>Blank uses the organisation&rsquo;s standing invoice note.</Hint>
      </Field>
    </>
  );
}
