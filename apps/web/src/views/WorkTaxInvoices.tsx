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
import { formatInr, formatDate } from '../format.js';
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

/** Road moves on a vehicle number; every other mode moves on a transport
 * document (railway receipt, airway bill, bill of lading). The 0035 CHECK
 * says the same thing at the database, and NIC refuses the other shape. */
function movesOnVehicle(mode: TransportMode): boolean {
  return mode === 'road';
}

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
  const [detail, setDetail] = useState<TaxInvoiceDetailResponse | null>(null);
  const [ewayBills, setEwayBills] = useState<readonly EwayBill[]>([]);
  const [cancelNote, setCancelNote] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [ewayMode, setEwayMode] = useState<TransportMode>('road');
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
        if (!cancelled) setClients(contacts.filter((contact) => contact.isClient));
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
    setEwayMode('road');
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
                    <StatusChip status="issued">e-invoiced</StatusChip>
                  )}
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
                const created = await api.createWorkTaxInvoice(organisationId, workId, {
                  measurementBookId: formValue(data, 'invoice-mb'),
                  invoiceDate: formValue(data, 'invoice-date'),
                  sacCode: formValue(data, 'invoice-sac'),
                  serviceDescription: formValue(data, 'invoice-description'),
                  gstRate: formValue(data, 'invoice-gst-rate'),
                  placeOfSupply: formValue(data, 'invoice-place-of-supply'),
                  buyerContactId: formValue(data, 'invoice-buyer'),
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
          </h3>

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
            {invoice.fyLabel !== null && (
              <>
                <dt>Financial year</dt>
                <dd>{invoice.fyLabel}</dd>
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
                    await api.updateTaxInvoice(organisationId, invoice.id, {
                      invoiceDate: formValue(data, 'edit-invoice-date'),
                      sacCode: formValue(data, 'edit-invoice-sac'),
                      serviceDescription: formValue(data, 'edit-invoice-description'),
                      gstRate: formValue(data, 'edit-invoice-gst-rate'),
                      placeOfSupply: formValue(data, 'edit-invoice-place-of-supply'),
                      buyerContactId: formValue(data, 'edit-invoice-buyer'),
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
                    The invoice is numbered and ready to register. Send the payload to
                    the GSP, then record exactly what the Invoice Registration Portal
                    answered — the IRN is minted there, never here.
                  </p>
                  <Actions>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void act(async () => {
                          const payload = await api.taxInvoiceIrpPayload(
                            organisationId,
                            invoice.id,
                          );
                          await navigator.clipboard.writeText(
                            JSON.stringify(payload, null, 2),
                          );
                        }, 'The e-invoice payload is on the clipboard, ready for the GSP.');
                      }}
                      disabled={pending}
                    >
                      Copy e-invoice payload
                    </Button>
                  </Actions>
                  {canIssue && (
                    <Disclosure label="Record the IRP response">
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
                                signedQr: formValue(data, 'irp-signed-qr'),
                              },
                            );
                            await refreshList();
                            await openInvoiceDetail(invoice.id);
                          }, 'IRP response recorded — the invoice now carries its IRN.');
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
                <dl>
                  <dt>IRN</dt>
                  <dd className={wrapCell}>{invoice.irn}</dd>
                  <dt>Acknowledgement</dt>
                  <dd>
                    {invoice.ackNumber ?? '—'}
                    {invoice.ackDate !== null && ` · ${formatDate(invoice.ackDate)}`}
                  </dd>
                </dl>
              )}
            </>
          )}

          {invoice.status === 'submitted' && (
            <>
              <h4>E-way bills</h4>
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
                      <th scope="col">Valid until</th>
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
                          {bill.validUntil === null ? '—' : formatDate(bill.validUntil)}
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

              {canModify && (
                <Disclosure label="Draft an e-way bill">
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      const data = new FormData(form);
                      const vehicleNumber = formValue(data, 'eway-vehicle');
                      const docNumber = formValue(data, 'eway-doc-number');
                      const docDate = formValue(data, 'eway-doc-date');
                      const transporterId = formValue(data, 'eway-transporter-id');
                      const transporterName = formValue(data, 'eway-transporter-name');
                      void act(async () => {
                        await api.createInvoiceEwayBill(organisationId, invoice.id, {
                          transportMode: ewayMode,
                          distanceKm: Number(formValue(data, 'eway-distance')),
                          fromPincode: formValue(data, 'eway-from'),
                          toPincode: formValue(data, 'eway-to'),
                          // Empty optionals are omitted rather than sent
                          // blank: the contract's patterns reject '' and a
                          // draft is allowed to be still filling in.
                          ...(transporterId !== '' ? { transporterId } : {}),
                          ...(transporterName !== '' ? { transporterName } : {}),
                          ...(vehicleNumber !== '' ? { vehicleNumber } : {}),
                          ...(docNumber !== ''
                            ? { transportDocNumber: docNumber }
                            : {}),
                          ...(docDate !== '' ? { transportDocDate: docDate } : {}),
                        });
                        setEwayBills(
                          await api.listInvoiceEwayBills(organisationId, invoice.id),
                        );
                        form.reset();
                        setEwayMode('road');
                      }, 'Draft e-way bill created — send it to the GSP, then record what NIC answered.');
                    }}
                  >
                    <FieldRow>
                      <Field>
                        <label htmlFor="eway-mode">Transport mode</label>
                        <select
                          id="eway-mode"
                          name="eway-mode"
                          value={ewayMode}
                          onChange={(event) => {
                            setEwayMode(event.target.value as TransportMode);
                          }}
                        >
                          {(
                            Object.keys(
                              TRANSPORT_MODE_LABELS,
                            ) as readonly TransportMode[]
                          ).map((mode) => (
                            <option key={mode} value={mode}>
                              {TRANSPORT_MODE_LABELS[mode]}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field>
                        <label htmlFor="eway-distance">Distance (km)</label>
                        <input
                          id="eway-distance"
                          name="eway-distance"
                          type="number"
                          min={0}
                          max={4000}
                          required
                        />
                      </Field>
                    </FieldRow>
                    <FieldRow>
                      <Field>
                        <label htmlFor="eway-from">From PIN</label>
                        <input
                          id="eway-from"
                          name="eway-from"
                          inputMode="numeric"
                          pattern="[0-9]{6}"
                          maxLength={6}
                          required
                        />
                      </Field>
                      <Field>
                        <label htmlFor="eway-to">To PIN</label>
                        <input
                          id="eway-to"
                          name="eway-to"
                          inputMode="numeric"
                          pattern="[0-9]{6}"
                          maxLength={6}
                          required
                        />
                      </Field>
                    </FieldRow>
                    {movesOnVehicle(ewayMode) ? (
                      <Field>
                        <label htmlFor="eway-vehicle">Vehicle number</label>
                        <input
                          id="eway-vehicle"
                          name="eway-vehicle"
                          pattern="[A-Z0-9]{6,12}"
                          maxLength={12}
                        />
                        <Hint>
                          Uppercase letters and digits, no spaces. A road movement needs
                          one before NIC will answer.
                        </Hint>
                      </Field>
                    ) : (
                      <FieldRow>
                        <Field>
                          <label htmlFor="eway-doc-number">
                            Transport document number
                          </label>
                          <input
                            id="eway-doc-number"
                            name="eway-doc-number"
                            maxLength={30}
                          />
                          <Hint>
                            The railway receipt, airway bill or bill of lading this
                            consignment moves on.
                          </Hint>
                        </Field>
                        <Field>
                          <label htmlFor="eway-doc-date">Transport document date</label>
                          <input id="eway-doc-date" name="eway-doc-date" type="date" />
                        </Field>
                      </FieldRow>
                    )}
                    <FieldRow>
                      <Field>
                        <label htmlFor="eway-transporter-id">Transporter id</label>
                        <input
                          id="eway-transporter-id"
                          name="eway-transporter-id"
                          maxLength={15}
                        />
                        <Hint>Fifteen characters; your own vehicle needs none.</Hint>
                      </Field>
                      <Field>
                        <label htmlFor="eway-transporter-name">Transporter name</label>
                        <input
                          id="eway-transporter-name"
                          name="eway-transporter-name"
                        />
                      </Field>
                    </FieldRow>
                    <Actions>
                      <Button type="submit" disabled={pending}>
                        Create e-way bill
                      </Button>
                    </Actions>
                  </form>
                </Disclosure>
              )}
            </>
          )}

          {invoice.status === 'submitted' && canCancel && (
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
                    A cancelled invoice keeps its number for ever — the number is never
                    reused — and this note is the record of why.
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
        </section>
      )}
    </>
  );
}
