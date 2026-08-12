import { useEffect, useState } from 'react';
import type {
  Contact,
  EwayBill,
  MeasurementBook,
  TaxInvoice,
  TaxInvoiceDetailResponse,
  TransportMode,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatInr, formatDate, formatTimestampDate } from '../format.js';
import { openPdf } from '../lib/openPdf.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, FieldRow, Actions, Hint, FormError } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';

interface WorkTaxInvoicesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canModify: boolean;
  /** Drafting an invoice additionally requires the Work to be active. */
  readonly canCreateDocuments: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly pending: boolean;
  /** The page's shared action runner: reports, refreshes, and clears. */
  readonly act: (run: () => Promise<void>, message: string) => Promise<void>;
}

const TRANSPORT_MODE_LABELS: Record<TransportMode, string> = {
  road: 'Road',
  rail: 'Rail',
  air: 'Air',
  ship: 'Ship',
};

/**
 * The GST tax invoice raised against a finalized Measurement Book, and
 * the e-way bill that moves it.
 *
 * The invoice is CUMULATIVE — one service line at a SAC for the whole MB
 * total, never a per-item HSN document — which is why the form asks for
 * one SAC and one description rather than editing lines. Submitting is
 * what closes the MB it bills, so it is the money moment: the number, the
 * buyer snapshot and every amount freeze together, and only a cancellation
 * (with a note) releases the MB for a corrected invoice.
 *
 * The IRN, acknowledgement and signed QR are NOT minted here. The payload
 * goes out to the GSP, the IRP answers, and what it answered is recorded
 * verbatim — same for the e-way bill's number and validity window, which
 * come back from NIC.
 */
export function WorkTaxInvoices({
  api,
  organisationId,
  workId,
  canModify,
  canCreateDocuments,
  canIssue,
  canCancel,
  pending,
  act,
}: WorkTaxInvoicesProps) {
  const [invoices, setInvoices] = useState<readonly TaxInvoice[] | null>(null);
  const [books, setBooks] = useState<readonly MeasurementBook[]>([]);
  const [clients, setClients] = useState<readonly Contact[]>([]);
  const [shipToContacts, setShipToContacts] = useState<readonly Contact[]>([]);
  const [detail, setDetail] = useState<TaxInvoiceDetailResponse | null>(null);
  const [ewayBills, setEwayBills] = useState<readonly EwayBill[]>([]);
  const [cancelNote, setCancelNote] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setInvoices(null);
    setLoadError(false);
    api
      .listWorkTaxInvoices(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setInvoices(loaded);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    // The pickers are conveniences: neither an unavailable Measurement
    // Book list nor an unavailable contact master must stop the invoices
    // that already exist from being read.
    api
      .listWorkMeasurementBooks(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setBooks(loaded.books);
      })
      .catch(() => {
        // The create form simply is not offered without a billable MB.
      });
    api
      .listContacts(organisationId)
      .then((contacts) => {
        if (!cancelled) {
          setClients(contacts.filter((contact) => contact.isClient));
          setShipToContacts(contacts);
        }
      })
      .catch(() => {
        // Likewise: no buyer picker, no create form.
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  async function refreshList() {
    setInvoices(await api.listWorkTaxInvoices(organisationId, workId));
  }

  async function openInvoiceDetail(invoiceId: string) {
    const loaded = await api.getTaxInvoice(organisationId, invoiceId);
    setDetail(loaded);
    setCancelNote('');
    setConfirmingDelete(false);
    // E-way bills exist only for a submitted invoice; asking for a
    // draft's would be a guaranteed empty round trip.
    setEwayBills(
      loaded.invoice.status === 'submitted'
        ? await api.listInvoiceEwayBills(organisationId, invoiceId)
        : [],
    );
  }

  function openInvoice(invoiceId: string, label: string) {
    void act(async () => {
      await openInvoiceDetail(invoiceId);
    }, `Tax invoice ${label} opened below.`);
  }

  if (loadError) {
    return (
      <>
        <h2>Tax Invoices</h2>
        <FormError>
          Tax invoices could not be loaded. Existing invoices remain unknown, so
          drafting is paused.
        </FormError>
        <Button
          variant="outline"
          onClick={() => {
            setLoadVersion((current) => current + 1);
          }}
        >
          Retry tax invoices
        </Button>
      </>
    );
  }

  if (invoices === null) {
    return (
      <>
        <h2>Tax Invoices</h2>
        <p className="text-muted-foreground" role="status">
          Loading tax invoices…
        </p>
      </>
    );
  }

  const invoice = detail?.invoice ?? null;
  // A Measurement Book is billable once, so an MB already carrying a live
  // invoice leaves the picker; a cancelled invoice puts it back.
  const billedBookIds = new Set(
    invoices
      .filter((row) => row.status !== 'cancelled')
      .map((row) => row.measurementBookId),
  );
  const billableBooks = books.filter(
    (book) =>
      book.status === 'finalized' &&
      book.kind !== 'record' &&
      !billedBookIds.has(book.id),
  );
  const canDraft =
    canModify && canCreateDocuments && billableBooks.length > 0 && clients.length > 0;

  return (
    <>
      <h2>Tax Invoices</h2>
      <p className="text-muted-foreground">
        The GST invoice for a finalized Measurement Book — one cumulative service line
        at its SAC for the whole MB total, not a line per item. Submitting assigns the
        next gap-free number for the financial year, snapshots the buyer, freezes every
        amount, and closes the Measurement Book it bills.
      </p>

      {invoices.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Tax invoices raised for this Work</caption>
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Measurement Book</th>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
              <th scope="col" className={numericCell}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <Button
                    variant="link"
                    size="inline"
                    className="font-medium"
                    onClick={() => {
                      openInvoice(row.id, row.invoiceNumber ?? 'draft');
                    }}
                    disabled={pending}
                  >
                    {row.invoiceNumber ?? 'Draft'}
                  </Button>
                </th>
                <td>{row.mbNumber ?? '—'}</td>
                <td>{formatDate(row.invoiceDate)}</td>
                <td>
                  <StatusChip status={row.status}>{row.status}</StatusChip>
                  {row.irn !== null && (
                    <StatusChip status="issued">
                      {row.irpProvider === 'whitebooks'
                        ? 'IRP registered'
                        : 'manual IRP evidence · unverified'}
                    </StatusChip>
                  )}
                  {/* The frozen reporting window (migration 0049): amber
                      while it is open, red once it has lawfully closed.
                      A signal only — local validity never changes. */}
                  {row.status === 'submitted' &&
                    (row.irpReportingOverdue ? (
                      <StatusChip status="expired">IRP overdue</StatusChip>
                    ) : (
                      row.irpReportingDeadline !== null &&
                      row.irpProviderState !== 'registered' && (
                        <StatusChip status="review">
                          IRP due {formatDate(row.irpReportingDeadline)}
                        </StatusChip>
                      )
                    ))}
                </td>
                <td className={numericCell}>
                  {row.totalAmount === null ? '—' : formatInr(row.totalAmount)}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">
          No tax invoice has been raised for this Work yet.
        </p>
      )}

      {canDraft && (
        <Disclosure label="Draft a tax invoice" startOpen={invoices.length === 0}>
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
                const created = await api.createWorkTaxInvoice(organisationId, workId, {
                  measurementBookId: formValue(data, 'invoice-mb'),
                  invoiceDate: formValue(data, 'invoice-date'),
                  sacCode: formValue(data, 'invoice-sac'),
                  serviceDescription: formValue(data, 'invoice-description'),
                  gstRate: formValue(data, 'invoice-gst-rate'),
                  placeOfSupply: formValue(data, 'invoice-place-of-supply'),
                  reverseChargeApplicable:
                    formValue(data, 'invoice-reverse-charge') === 'true',
                  buyerContactId: formValue(data, 'invoice-buyer'),
                  ...(customerPoReference === '' ? {} : { customerPoReference }),
                  ...(unitLabel === '' ? {} : { unitLabel }),
                  ...(notes === '' ? {} : { notes }),
                  ...(shipToContactId === '' ? {} : { shipToContactId }),
                  ...(numberPrefix === '' ? {} : { numberPrefix }),
                });
                await refreshList();
                await openInvoiceDetail(created.invoice.id);
                form.reset();
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
                Only finalized on-account and final Measurement Books can be invoiced,
                and each is billable once. Record Measurement Books are merged into an
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
                <Hint>
                  Six digits — the service code the whole invoice is raised at.
                </Hint>
              </Field>
            </FieldRow>
            <Field>
              <label htmlFor="invoice-reverse-charge">
                Tax payable on reverse charge
              </label>
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
                This legal fact is frozen at submit. Reverse-charge invoices stay as
                drafts because their tax calculation is not implemented.
              </Hint>
            </Field>
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
              <Hint>
                What the invoice says it is for — it prints as the single line.
              </Hint>
            </Field>
            <FieldRow>
              <Field>
                <label htmlFor="invoice-gst-rate">GST rate (%)</label>
                <input
                  id="invoice-gst-rate"
                  name="invoice-gst-rate"
                  inputMode="decimal"
                  required
                  placeholder="18"
                />
                <Hint>The total rate; the CGST/SGST split is half each.</Hint>
              </Field>
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
                  Two-digit state code. Against your own state it decides CGST+SGST
                  (within the state) or IGST (across states) at submit.
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
                Snapshotted at submit, so a correction to the contact before submitting
                is reflected and one after it is not. The buyer needs an address, state
                code and PIN by then.
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
      )}

      {invoice !== null && (
        <section>
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
                invoice.irpProviderState !== 'registered' && (
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
              registration is refused. Cancel it with a note and raise a corrected
              invoice if it must be reported.
            </p>
          )}

          <dl>
            <dt>Measurement Book</dt>
            <dd>{invoice.mbNumber ?? '—'}</dd>
            <dt>Invoice date</dt>
            <dd>{formatDate(invoice.invoiceDate)}</dd>
            <dt>SAC</dt>
            <dd>{invoice.sacCode}</dd>
            <dt>GST rate</dt>
            <dd>{invoice.gstRate}%</dd>
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

          <p className={wrapCell}>{invoice.serviceDescription}</p>

          {invoice.status === 'submitted' || invoice.status === 'cancelled' ? (
            <DataTable>
              <caption className="sr-only">
                The amounts frozen when this invoice was submitted
              </caption>
              <tbody>
                <tr>
                  <th scope="row">Taxable value</th>
                  <td className={numericCell}>
                    {invoice.taxableValue === null
                      ? '—'
                      : formatInr(invoice.taxableValue)}
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
                        {invoice.cgstAmount === null
                          ? '—'
                          : formatInr(invoice.cgstAmount)}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">SGST</th>
                      <td className={numericCell}>
                        {invoice.sgstAmount === null
                          ? '—'
                          : formatInr(invoice.sgstAmount)}
                      </td>
                    </tr>
                  </>
                )}
                <tr>
                  <th scope="row">Total</th>
                  <td className={numericCell}>
                    {invoice.totalAmount === null
                      ? '—'
                      : formatInr(invoice.totalAmount)}
                  </td>
                </tr>
              </tbody>
            </DataTable>
          ) : (
            <p className="text-muted-foreground">
              The amounts are computed from the Measurement Book total at submit, so a
              draft carries none yet.
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
                    const customerPoReference = formValue(
                      data,
                      'edit-invoice-customer-po',
                    );
                    const unitLabel = formValue(data, 'edit-invoice-unit-label');
                    const notes = formValue(data, 'edit-invoice-notes');
                    const shipToContactId = formValue(data, 'edit-invoice-ship-to');
                    const numberPrefix = formValue(data, 'edit-invoice-number-prefix');
                    await api.updateTaxInvoice(organisationId, invoice.id, {
                      invoiceDate: formValue(data, 'edit-invoice-date'),
                      sacCode: formValue(data, 'edit-invoice-sac'),
                      serviceDescription: formValue(data, 'edit-invoice-description'),
                      gstRate: formValue(data, 'edit-invoice-gst-rate'),
                      placeOfSupply: formValue(data, 'edit-invoice-place-of-supply'),
                      reverseChargeApplicable:
                        formValue(data, 'edit-invoice-reverse-charge') === 'true',
                      buyerContactId: formValue(data, 'edit-invoice-buyer'),
                      ...(customerPoReference === '' ? {} : { customerPoReference }),
                      ...(unitLabel === '' ? {} : { unitLabel }),
                      ...(notes === '' ? {} : { notes }),
                      ...(shipToContactId === '' ? {} : { shipToContactId }),
                      ...(numberPrefix === '' ? {} : { numberPrefix }),
                    });
                    await refreshList();
                    await openInvoiceDetail(invoice.id);
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
                    <label htmlFor="edit-invoice-sac">SAC code</label>
                    <input
                      id="edit-invoice-sac"
                      name="edit-invoice-sac"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      required
                      defaultValue={invoice.sacCode}
                    />
                  </Field>
                </FieldRow>
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
                    <option value="false">
                      No — supplier pays GST (forward charge)
                    </option>
                    <option value="true">
                      Yes — recipient pays GST (issuance not supported yet)
                    </option>
                  </select>
                </Field>
                <Field>
                  <label htmlFor="edit-invoice-description">Service description</label>
                  <textarea
                    id="edit-invoice-description"
                    name="edit-invoice-description"
                    rows={3}
                    required
                    minLength={3}
                    maxLength={1000}
                    defaultValue={invoice.serviceDescription}
                  />
                </Field>
                <FieldRow>
                  <Field>
                    <label htmlFor="edit-invoice-gst-rate">GST rate (%)</label>
                    <input
                      id="edit-invoice-gst-rate"
                      name="edit-invoice-gst-rate"
                      inputMode="decimal"
                      required
                      defaultValue={invoice.gstRate}
                    />
                  </Field>
                  <Field>
                    <label htmlFor="edit-invoice-place-of-supply">
                      Place of supply
                    </label>
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
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.designation}
                      </option>
                    ))}
                  </select>
                </Field>
                <FieldRow>
                  <Field>
                    <label htmlFor="edit-invoice-customer-po">
                      Customer PO/reference
                    </label>
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
                    await refreshList();
                    await openInvoiceDetail(invoice.id);
                  }, 'Tax invoice submitted — it is numbered, its amounts are frozen, and the Measurement Book it bills is closed.');
                }}
                disabled={pending}
              >
                Submit invoice
              </Button>
            )}
            {invoice.status === 'draft' && canModify && !confirmingDelete && (
              <Button
                variant="ghost"
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
                      await refreshList();
                      await openInvoiceDetail(invoice.id);
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
          </Actions>

          {confirmingDelete && invoice.status === 'draft' && (
            <Actions>
              <p role="status">
                Delete this draft tax invoice? Nothing has been numbered, so nothing is
                lost but the typing.
              </p>
              <Button
                variant="destructive"
                onClick={() => {
                  void act(async () => {
                    await api.deleteTaxInvoice(organisationId, invoice.id);
                    setDetail(null);
                    setConfirmingDelete(false);
                    await refreshList();
                  }, 'Draft tax invoice deleted.');
                }}
                disabled={pending}
              >
                Delete it
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirmingDelete(false);
                }}
                disabled={pending}
              >
                Keep it
              </Button>
            </Actions>
          )}

          {invoice.status === 'submitted' && (
            <>
              <h4>Government e-invoicing</h4>
              {invoice.irn === null ? (
                <>
                  <p className="text-muted-foreground">
                    Issued locally. Whitebooks can register the frozen invoice at the
                    IRP. An unknown result is reconciled by document details and is
                    never blindly generated twice.
                  </p>
                  <Actions>
                    {canIssue && invoice.irpProviderState !== 'cancelling' && (
                      <Button
                        onClick={() => {
                          void act(async () => {
                            if (invoice.irpProviderState === 'registering') {
                              await api.recoverTaxInvoiceProviderOperation(
                                organisationId,
                                invoice.id,
                              );
                            } else {
                              await api.registerTaxInvoiceIrp(
                                organisationId,
                                invoice.id,
                              );
                            }
                            await refreshList();
                            await openInvoiceDetail(invoice.id);
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
                  <p className="text-muted-foreground">
                    Provider state: <strong>{invoice.irpProviderState}</strong>
                  </p>
                  {canIssue && (
                    <Disclosure label="Manual compatibility import (unverified)">
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          const data = new FormData(event.currentTarget);
                          void act(async () => {
                            await api.recordTaxInvoiceIrpResponse(
                              organisationId,
                              invoice.id,
                              {
                                irn: formValue(data, 'irp-irn'),
                                ackNumber: formValue(data, 'irp-ack-number'),
                                ackDate: new Date(
                                  formValue(data, 'irp-ack-date'),
                                ).toISOString(),
                                ackDateText: formValue(data, 'irp-ack-date-text'),
                                signedQr: formValue(data, 'irp-signed-qr'),
                                ...(formValue(data, 'irp-signed-invoice') === ''
                                  ? {}
                                  : {
                                      signedInvoice: formValue(
                                        data,
                                        'irp-signed-invoice',
                                      ),
                                    }),
                              },
                            );
                            await refreshList();
                            await openInvoiceDetail(invoice.id);
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
                          <Hint>
                            Sixty-four hexadecimal characters, exactly as returned.
                          </Hint>
                        </Field>
                        <FieldRow>
                          <Field>
                            <label htmlFor="irp-ack-number">
                              Acknowledgement number
                            </label>
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
                            Copy the wall-clock text exactly. This evidence remains
                            marked manually entered and unverified.
                          </Hint>
                        </Field>
                        <Field>
                          <label htmlFor="irp-signed-qr">Signed QR</label>
                          <textarea
                            id="irp-signed-qr"
                            name="irp-signed-qr"
                            rows={3}
                            required
                          />
                          <Hint>
                            The signed payload the portal returned; it prints as the QR
                            code on the invoice.
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
                  <p>
                    <StatusChip status={invoice.irpProviderState}>
                      {invoice.irpProvider === 'whitebooks'
                        ? `Whitebooks · ${invoice.irpProviderState}`
                        : `Manual evidence · ${invoice.irpProviderState} · unverified`}
                    </StatusChip>
                  </p>
                  <dl>
                    <dt>IRN</dt>
                    <dd className={wrapCell}>{invoice.irn}</dd>
                    <dt>Acknowledgement</dt>
                    <dd>
                      {invoice.ackNumber ?? '—'}
                      {invoice.ackDateText !== null && ` · ${invoice.ackDateText}`}
                      {invoice.ackDateText === null &&
                        invoice.ackDate !== null &&
                        ` · ${formatTimestampDate(invoice.ackDate)}`}
                    </dd>
                  </dl>
                  {invoice.irpLegacyEvidenceMissing && (
                    <FormError>
                      This migrated IRP record lacks some historical evidence. No value
                      was invented to fill the gap.
                    </FormError>
                  )}
                  {canCancel &&
                    invoice.irpProvider === 'whitebooks' &&
                    (invoice.irpProviderState === 'registered' ||
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
                                await api.cancelTaxInvoiceIrp(
                                  organisationId,
                                  invoice.id,
                                  {
                                    reasonCode: formValue(data, 'irp-cancel-reason') as
                                      '1' | '2' | '3' | '4',
                                    remark: formValue(data, 'irp-cancel-remark'),
                                  },
                                );
                              }
                              await refreshList();
                              await openInvoiceDetail(invoice.id);
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
                  {canCancel &&
                    ((invoice.irpProvider === 'manual' &&
                      invoice.irpProviderState === 'registered') ||
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
                                  reasonCode: formValue(
                                    data,
                                    'manual-irp-cancel-reason',
                                  ) as '1' | '2' | '3' | '4',
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
                              await refreshList();
                              await openInvoiceDetail(invoice.id);
                            }, 'Manual external cancellation evidence recorded as unverified.');
                          }}
                        >
                          <FieldRow>
                            <Field>
                              <label htmlFor="manual-irp-cancel-reason">
                                Reason code
                              </label>
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
                              <label htmlFor="manual-irp-cancel-date">
                                Normalized instant
                              </label>
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
            </>
          )}

          {invoice.status === 'submitted' && (
            <>
              <h4>E-way bills</h4>
              <FormError>
                Fresh E-way Bill generation is unavailable for this cumulative SAC
                service invoice. Historical records remain readable, reconcilable, and
                cancellable. Goods/HSN and delivery-challan lines must be added before
                generation can be enabled safely.
              </FormError>
              {ewayBills.length > 0 ? (
                <DataTable>
                  <caption className="sr-only">
                    E-way bills raised to move this invoice
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
                            (bill.validUntil === null
                              ? '—'
                              : formatDate(bill.validUntil))}
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
                                  setEwayBills(
                                    await api.listInvoiceEwayBills(
                                      organisationId,
                                      invoice.id,
                                    ),
                                  );
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
                              await api.cancelEwayBillAtProvider(
                                organisationId,
                                bill.id,
                                {
                                  reasonCode: formValue(
                                    data,
                                    `eway-provider-reason-${bill.id}`,
                                  ) as '1' | '2' | '3' | '4',
                                  remark: formValue(
                                    data,
                                    `eway-provider-remark-${bill.id}`,
                                  ),
                                },
                              );
                            }
                            setEwayBills(
                              await api.listInvoiceEwayBills(
                                organisationId,
                                invoice.id,
                              ),
                            );
                          }, 'Whitebooks EWB cancellation check finished. Provider state is refreshed below; the local record stays active until confirmed.');
                        }}
                      >
                        <FieldRow>
                          <Field>
                            <label htmlFor={`eway-provider-reason-${bill.id}`}>
                              Reason
                            </label>
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
                            <label htmlFor={`eway-provider-remark-${bill.id}`}>
                              Remark
                            </label>
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
                      ((bill.provider === 'manual' &&
                        bill.providerState === 'generated') ||
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
                            await api.recordEwayBillCancellation(
                              organisationId,
                              bill.id,
                              {
                                reasonCode: formValue(
                                  data,
                                  `eway-manual-reason-${bill.id}`,
                                ) as '1' | '2' | '3' | '4',
                                remark: formValue(
                                  data,
                                  `eway-manual-remark-${bill.id}`,
                                ),
                                cancelledAt: new Date(
                                  formValue(data, `eway-manual-date-${bill.id}`),
                                ).toISOString(),
                                cancelledAtText: formValue(
                                  data,
                                  `eway-manual-date-text-${bill.id}`,
                                ),
                              },
                            );
                            setEwayBills(
                              await api.listInvoiceEwayBills(
                                organisationId,
                                invoice.id,
                              ),
                            );
                          }, 'External EWB cancellation evidence recorded as manually entered and unverified.');
                        }}
                      >
                        <FieldRow>
                          <Field>
                            <label htmlFor={`eway-manual-reason-${bill.id}`}>
                              Reason
                            </label>
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
                          <label htmlFor={`eway-manual-remark-${bill.id}`}>
                            Remark
                          </label>
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
                    (bill) =>
                      bill.status === 'generated' && bill.providerState === 'cancelled',
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
                              note: formValue(
                                data,
                                `eway-local-cancel-note-${bill.id}`,
                              ),
                            });
                            setEwayBills(
                              await api.listInvoiceEwayBills(
                                organisationId,
                                invoice.id,
                              ),
                            );
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
          )}

          {invoice.status === 'submitted' &&
            canCancel &&
            (invoice.irpProviderState === 'not_requested' ||
              invoice.irpProviderState === 'cancelled') && (
              <Disclosure label="Cancel this invoice">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                      await api.cancelTaxInvoice(organisationId, invoice.id, {
                        note: cancelNote,
                      });
                      await refreshList();
                      await openInvoiceDetail(invoice.id);
                      setCancelNote('');
                    }, 'Tax invoice cancelled — the Measurement Book it billed is released for a corrected invoice.');
                  }}
                >
                  <Field>
                    <label htmlFor="invoice-cancel-note">
                      Why it is being cancelled
                    </label>
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
                      A cancelled invoice keeps its number for ever — the number is
                      never reused — and this note is the record of why.
                    </Hint>
                  </Field>
                  <Actions>
                    <Button type="submit" variant="destructive" disabled={pending}>
                      Cancel invoice
                    </Button>
                  </Actions>
                </form>
              </Disclosure>
            )}
          {invoice.status === 'submitted' &&
            canCancel &&
            invoice.irpProviderState !== 'not_requested' &&
            invoice.irpProviderState !== 'cancelled' && (
              <p className="text-muted-foreground">
                Local invoice cancellation is locked while IRP state is{' '}
                <strong>{invoice.irpProviderState}</strong>. Resolve registration and
                cancel any EWB and IRN first.
              </p>
            )}
        </section>
      )}
    </>
  );
}
