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
 * The invoice is CUMULATIVE â€” one service line at a SAC for the whole MB
 * total, never a per-item HSN document â€” which is why the form asks for
 * one SAC and one description rather than editing lines. Submitting is
 * what closes the MB it bills, so it is the money moment: the number, the
 * buyer snapshot and every amount freeze together, and only a cancellation
 * (with a note) releases the MB for a corrected invoice.
 *
 * The IRN, acknowledgement and signed QR are NOT minted here. The payload
 * goes out to the GSP, the IRP answers, and what it answered is recorded
 * verbatim â€” same for the e-way bill's number and validity window, which
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
          Loading tax invoicesâ€¦
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
        The GST invoice for a finalized Measurement Book â€” one cumulative service line
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
                <td>{row.mbNumber ?? 'â€”'}</td>
                <td>{formatDate(row.invoiceDate)}</td>
                <td>
                  <StatusChip status={row.status}>{row.status}</StatusChip>
                  {row.irn !== null && (
                    <StatusChip status="issued">e-invoiced</StatusChip>
                  )}
                </td>
                <td className={numericCell}>
                  {row.totalAmount === null ? 'â€”' : formatInr(row.totalAmount)}
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
              }, 'Draft tax invoice created â€” review it below and submit when it is right.');
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
                    {book.mbNumber ?? 'MB'} Â· {formatDate(book.mbDate)} Â·{' '}
                    {book.totalAmount === null ? 'â€”' : formatInr(book.totalAmount)}
                    {book.isFinal ? ' Â· final' : ''}
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
                  Six digits â€” the service code the whole invoice is raised at.
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
                What the invoice says it is for â€” it prints as the single line.
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
            <dd>{invoice.mbNumber ?? 'â€”'}</dd>
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
            <Dßnú¶‰žËkºwµç@€€€€€€€€€€€€€€€€€)M=8¹ÍÑÉ¥¹¥™ä¡Á…å±½…°¹Õ±°°€È¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€€€€€€€€€€€€€ô°€Q¡””µ¥¹Ù½¥”Á…å±½…¥Ì½¸Ñ¡”±¥Á‰½…É°É•…‘ä™½ÈÑ¡”M@¸œ¤ì(€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€½Áä”µ¥¹Ù½¥”Á…å±½…(€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€€€€€€€€í…¹%ÍÍÕ”€˜˜€ (€€€€€€€€€€€€€€€€€€€€ñ¥Í±½ÍÕÉ”±…‰•°ô‰I•½ÉÑ¡”%I@É•ÍÁ½¹Í”ˆø(€€€€€€€€€€€€€€€€€€€€€€ñ™½É´(€€€€€€€€€€€€€€€€€€€€€€€½¹MÕ‰µ¥Ðõì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€½¹ÍÐ‘…Ñ„€ô¹•Ü½Éµ…Ñ„¡•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€Ù½¥…Ð¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€…Ý…¥Ð…Á¤¹É•½É‘Q…á%¹Ù½¥•%ÉÁI•ÍÁ½¹Í” (€€€€€€€€€€€€€€€€€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¥¹Ù½¥”¹¥°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¥É¸è™½ÉµY…±Õ”¡‘…Ñ„°€¥ÉÀµ¥É¸œ¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€…­9Õµ‰•Èè™½ÉµY…±Õ”¡‘…Ñ„°€¥ÉÀµ…¬µ¹Õµ‰•Èœ¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€…­…Ñ”è¹•Ü…Ñ” (€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€™½ÉµY…±Õ”¡‘…Ñ„°€¥ÉÀµ…¬µ‘…Ñ”œ¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¤¹Ñ½%M=MÑÉ¥¹œ ¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Í¥¹•‘EÈè™½ÉµY…±Õ”¡‘…Ñ„°€¥ÉÀµÍ¥¹•µÅÈœ¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ô°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€€€…Ý…¥ÐÉ•™É•Í¡1¥ÍÐ ¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€€€…Ý…¥Ð½Á•¹%¹Ù½¥••Ñ…¥°¡¥¹Ù½¥”¹¥¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€ô°€%I@É•ÍÁ½¹Í”É•½É‘•ƒŠPÑ¡”¥¹Ù½¥”¹½Ü…ÉÉ¥•Ì¥ÑÌ%I8¸œ¤ì(€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰¥ÉÀµ¥É¸ˆù%I8ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€€€¥ô‰¥ÉÀµ¥É¸ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰¥ÉÀµ¥É¸ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€€€€€€€Á…ÑÑ•É¸ô‰lÀ´å„µ™uìØÑôˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìØÑô(€€€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ!¥¹Ðø(€€€€€€€€€€€€€€€€€€€€€€€€€€€M¥áÑäµ™½ÕÈ¡•á…‘•¥µ…°¡…É…Ñ•ÉÌ°•á…Ñ±ä…ÌÉ•ÑÕÉ¹•¸(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½!¥¹Ðø(€€€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥•±‘I½Üø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰¥ÉÀµ…¬µ¹Õµ‰•Èˆø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€­¹½Ý±•‘•µ•¹Ð¹Õµ‰•È(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ¥ô‰¥ÉÀµ…¬µ¹Õµ‰•Èˆ¹…µ”ô‰¥ÉÀµ…¬µ¹Õµ‰•ÈˆÉ•ÅÕ¥É•€¼ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰¥ÉÀµ…¬µ‘…Ñ”ˆù­¹½Ý±•‘•µ•¹Ð‘…Ñ”ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¥ô‰¥ÉÀµ…¬µ‘…Ñ”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰¥ÉÀµ…¬µ‘…Ñ”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ÑåÁ”ô‰‘…Ñ•Ñ¥µ”µ±½…°ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€ð½¥•±‘I½Üø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰¥ÉÀµÍ¥¹•µÅÈˆùM¥¹•EHð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑ•áÑ…É•„(€€€€€€€€€€€€€€€€€€€€€€€€€€€¥ô‰¥ÉÀµÍ¥¹•µÅÈˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰¥ÉÀµÍ¥¹•µÅÈˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€É½ÝÌõìÍô(€€€€€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ!¥¹Ðø(€€€€€€€€€€€€€€€€€€€€€€€€€€€Q¡”Í¥¹•Á…å±½…Ñ¡”Á½ÉÑ…°É•ÑÕÉ¹•ì¥ÐÁÉ¥¹ÑÌ…ÌÑ¡”EH(€€€€€€€€€€€€€€€€€€€€€€€€€€€½‘”½¸Ñ¡”¥¹Ù½¥”¸(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½!¥¹Ðø(€€€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸ÑåÁ”ô‰ÍÕ‰µ¥Ðˆ‘¥Í…‰±•õíÁ•¹‘¥¹ôø(€€€€€€€€€€€€€€€€€€€€€€€€€€€I•½ÉÉ•ÍÁ½¹Í”(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€€€€€€€€€€€€€ð½™½É´ø(€€€€€€€€€€€€€€€€€€€€ð½¥Í±½ÍÕÉ”ø(€€€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€€€ð¼ø(€€€€€€€€€€€€€€¤€è€ (€€€€€€€€€€€€€€€€ñ‘°ø(€€€€€€€€€€€€€€€€€€ñ‘Ðù%I8ð½‘Ðø(€€€€€€€€€€€€€€€€€€ñ‘±…ÍÍ9…µ”õíÝÉ…Á•±±ôùí¥¹Ù½¥”¹¥É¹ôð½‘ø(€€€€€€€€€€€€€€€€€€ñ‘Ðù­¹½Ý±•‘•µ•¹Ðð½‘Ðø(€€€€€€€€€€€€€€€€€€ñ‘ø(€€€€€€€€€€€€€€€€€€€í¥¹Ù½¥”¹…­9Õµ‰•È€üü€ŸŠPô(€€€€€€€€€€€€€€€€€€€í¥¹Ù½¥”¹…­…Ñ”€„ôô¹Õ±°€˜˜€ƒ
Ü€‘í™½Éµ…Ñ…Ñ”¡¥¹Ù½¥”¹…­…Ñ”¥õô(€€€€€€€€€€€€€€€€€€ð½‘ø(€€€€€€€€€€€€€€€€ð½‘°ø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€ð¼ø(€€€€€€€€€€¥ô((€€€€€€€€€í¥¹Ù½¥”¹ÍÑ…ÑÕÌ€ôôô€ÍÕ‰µ¥ÑÑ•œ€˜˜€ (€€€€€€€€€€€€ðø(€€€€€€€€€€€€€€ñ ÐùµÝ…ä‰¥±±Ìð½ Ðø(€€€€€€€€€€€€€í•Ý…å	¥±±Ì¹±•¹Ñ €ø€À€ü€ (€€€€€€€€€€€€€€€€ñ…Ñ…Q…‰±”ø(€€€€€€€€€€€€€€€€€€ñ…ÁÑ¥½¸±…ÍÍ9…µ”ô‰ÍÈµ½¹±äˆø(€€€€€€€€€€€€€€€€€€€µÝ…ä‰¥±±ÌÉ…¥Í•Ñ¼µ½Ù”Ñ¡¥Ì¥¹Ù½¥”(€€€€€€€€€€€€€€€€€€ð½…ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€ñÑ¡•…ø(€€€€€€€€€€€€€€€€€€€€ñÑÈø(€€€€€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆù]¹Õµ‰•Èð½Ñ ø(€€€€€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆù5½‘”ð½Ñ ø(€€€€€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùI½ÕÑ”ð½Ñ ø(€€€€€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùMÑ…ÑÕÌð½Ñ ø(€€€€€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùY…±¥Õ¹Ñ¥°ð½Ñ ø(€€€€€€€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€€€€€€€ð½Ñ¡•…ø(€€€€€€€€€€€€€€€€€€ñÑ‰½‘äø(€€€€€€€€€€€€€€€€€€€í•Ý…å	¥±±Ì¹µ…À ¡‰¥±°¤€ôø€ (€€€€€€€€€€€€€€€€€€€€€€ñÑÈ­•äõí‰¥±°¹¥‘ôø(€€€€€€€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰É½Üˆùí‰¥±°¹•Ý‰9Õµ‰•È€üü€É…™Ðôð½Ñ ø(€€€€€€€€€€€€€€€€€€€€€€€€ñÑùíQI9MA=IQ}5=}1	1Mm‰¥±°¹ÑÉ…¹ÍÁ½ÉÑ5½‘•uôð½Ñø(€€€€€€€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€€€€€€í‰¥±°¹™É½µA¥¹½‘•ôƒŠHí‰¥±°¹Ñ½A¥¹½‘•ôƒ
Üí‰¥±°¹‘¥ÍÑ…¹•-µô­´(€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñMÑ…ÑÕÍ¡¥ÀÍÑ…ÑÕÌõí‰¥±°¹ÍÑ…ÑÕÍôùí‰¥±°¹ÍÑ…ÑÕÍôð½MÑ…ÑÕÍ¡¥Àø(€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€€€€€€í‰¥±°¹Ù…±¥‘U¹Ñ¥°€ôôô¹Õ±°€ü€ŸŠPœ€è™½Éµ…Ñ…Ñ”¡‰¥±°¹Ù…±¥‘U¹Ñ¥°¥ô(€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€€€€€€€€€¤¥ô(€€€€€€€€€€€€€€€€€€ð½Ñ‰½‘äø(€€€€€€€€€€€€€€€€ð½…Ñ…Q…‰±”ø(€€€€€€€€€€€€€€¤€è€ (€€€€€€€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€€€€€€€€€€€9¼”µÝ…ä‰¥±°¡…Ì‰••¸É…¥Í•™½ÈÑ¡¥Ì¥¹Ù½¥”¸(€€€€€€€€€€€€€€€€ð½Àø(€€€€€€€€€€€€€€¥ô((€€€€€€€€€€€€€í…¹5½‘¥™ä€˜˜€ (€€€€€€€€€€€€€€€€ñ¥Í±½ÍÕÉ”±…‰•°ô‰É…™Ð…¸”µÝ…ä‰¥±°ˆø(€€€€€€€€€€€€€€€€€€ñ™½É´(€€€€€€€€€€€€€€€€€€€½¹MÕ‰µ¥Ðõì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€€€€€€€€€€€€€€€€€€€½¹ÍÐ™½É´€ô•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ðì(€€€€€€€€€€€€€€€€€€€€€½¹ÍÐ‘…Ñ„€ô¹•Ü½Éµ…Ñ„¡™½É´¤ì(€€€€€€€€€€€€€€€€€€€€€½¹ÍÐÙ•¡¥±•9Õµ‰•È€ô™½ÉµY…±Õ”¡‘…Ñ„°€•Ý…äµÙ•¡¥±”œ¤ì(€€€€€€€€€€€€€€€€€€€€€½¹ÍÐ‘½9Õµ‰•È€ô™½ÉµY…±Õ”¡‘…Ñ„°€•Ý…äµ‘½Œµ¹Õµ‰•Èœ¤ì(€€€€€€€€€€€€€€€€€€€€€½¹ÍÐ‘½…Ñ”€ô™½ÉµY…±Õ”¡‘…Ñ„°€•Ý…äµ‘½Œµ‘…Ñ”œ¤ì(€€€€€€€€€€€€€€€€€€€€€½¹ÍÐÑÉ…¹ÍÁ½ÉÑ•É%€ô™½ÉµY…±Õ”¡‘…Ñ„°€•Ý…äµÑÉ…¹ÍÁ½ÉÑ•Èµ¥œ¤ì(€€€€€€€€€€€€€€€€€€€€€½¹ÍÐÑÉ…¹ÍÁ½ÉÑ•É9…µ”€ô™½ÉµY…±Õ”¡‘…Ñ„°€•Ý…äµÑÉ…¹ÍÁ½ÉÑ•Èµ¹…µ”œ¤ì(€€€€€€€€€€€€€€€€€€€€€Ù½¥…Ð¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€…Ý…¥Ð…Á¤¹É•…Ñ•%¹Ù½¥•Ý…å	¥±°¡½É…¹¥Í…Ñ¥½¹%°¥¹Ù½¥”¹¥°ì(€€€€€€€€€€€€€€€€€€€€€€€€€ÑÉ…¹ÍÁ½ÉÑ5½‘”è•Ý…å5½‘”°(€€€€€€€€€€€€€€€€€€€€€€€€€‘¥ÍÑ…¹•-´è9Õµ‰•È¡™½ÉµY…±Õ”¡‘…Ñ„°€•Ý…äµ‘¥ÍÑ…¹”œ¤¤°(€€€€€€€€€€€€€€€€€€€€€€€€€™É½µA¥¹½‘”è™½ÉµY…±Õ”¡‘…Ñ„°€•Ý…äµ™É½´œ¤°(€€€€€€€€€€€€€€€€€€€€€€€€€Ñ½A¥¹½‘”è™½ÉµY…±Õ”¡‘…Ñ„°€•Ý…äµÑ¼œ¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€¼¼µÁÑä½ÁÑ¥½¹…±Ì…É”½µ¥ÑÑ•É…Ñ¡•ÈÑ¡…¸Í•¹Ð(€€€€€€€€€€€€€€€€€€€€€€€€€€¼¼‰±…¹¬èÑ¡”½¹ÑÉ…ÐÌÁ…ÑÑ•É¹ÌÉ•©•Ð€œœ…¹„(€€€€€€€€€€€€€€€€€€€€€€€€€€¼¼‘É…™Ð¥Ì…±±½Ý•Ñ¼‰”ÍÑ¥±°™¥±±¥¹œ¥¸¸(€€€€€€€€€€€€€€€€€€€€€€€€€€¸¸¸¡ÑÉ…¹ÍÁ½ÉÑ•É%€„ôô€œœ€üìÑÉ…¹ÍÁ½ÉÑ•É%ô€èíô¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€¸¸¸¡ÑÉ…¹ÍÁ½ÉÑ•É9…µ”€„ôô€œœ€üìÑÉ…¹ÍÁ½ÉÑ•É9…µ”ô€èíô¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€¸¸¸¡Ù•¡¥±•9Õµ‰•È€„ôô€œœ€üìÙ•¡¥±•9Õµ‰•Èô€èíô¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€¸¸¸¡‘½9Õµ‰•È€„ôô€œœ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€üìÑÉ…¹ÍÁ½ÉÑ½9Õµ‰•Èè‘½9Õµ‰•Èô(€€€€€€€€€€€€€€€€€€€€€€€€€€€€èíô¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€¸¸¸¡‘½…Ñ”€„ôô€œœ€üìÑÉ…¹ÍÁ½ÉÑ½…Ñ”è‘½…Ñ”ô€èíô¤°(€€€€€€€€€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€€€€€€€€€€€Í•ÑÝ…å	¥±±Ì (€€€€€€€€€€€€€€€€€€€€€€€€€…Ý…¥Ð…Á¤¹±¥ÍÑ%¹Ù½¥•Ý…å	¥±±Ì¡½É…¹¥Í…Ñ¥½¹%°¥¹Ù½¥”¹¥¤°(€€€€€€€€€€€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€€€€€€€€€€€€€™½É´¹É•Í•Ð ¤ì(€€€€€€€€€€€€€€€€€€€€€€€Í•ÑÝ…å5½‘” É½…œ¤ì(€€€€€€€€€€€€€€€€€€€€€ô°€É…™Ð”µÝ…ä‰¥±°É•…Ñ•ƒŠPÍ•¹¥ÐÑ¼Ñ¡”M@°Ñ¡•¸É•½ÉÝ¡…Ð9%…¹ÍÝ•É•¸œ¤ì(€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€ñ¥•±‘I½Üø(€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰•Ý…äµµ½‘”ˆùQÉ…¹ÍÁ½ÉÐµ½‘”ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€ñÍ•±•Ð(€€€€€€€€€€€€€€€€€€€€€€€€€¥ô‰•Ý…äµµ½‘”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰•Ý…äµµ½‘”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€Ù…±Õ”õí•Ý…å5½‘•ô(€€€€€€€€€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€Í•ÑÝ…å5½‘”¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”…ÌQÉ…¹ÍÁ½ÉÑ5½‘”¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€€€€€ì (€€€€€€€€€€€€€€€€€€€€€€€€€€€=‰©•Ð¹­•åÌ (€€€€€€€€€€€€€€€€€€€€€€€€€€€€€QI9MA=IQ}5=}1	1L°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€¤…ÌÉ•…‘½¹±äQÉ…¹ÍÁ½ÉÑ5½‘•mt(€€€€€€€€€€€€€€€€€€€€€€€€€€¤¹µ…À ¡µ½‘”¤€ôø€ (€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸­•äõíµ½‘•ôÙ…±Õ”õíµ½‘•ôø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€íQI9MA=IQ}5=}1	1Mmµ½‘•uô(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€€€¤¥ô(€€€€€€€€€€€€€€€€€€€€€€€€ð½Í•±•Ðø(€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰•Ý…äµ‘¥ÍÑ…¹”ˆù¥ÍÑ…¹”€¡­´¤ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€¥ô‰•Ý…äµ‘¥ÍÑ…¹”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰•Ý…äµ‘¥ÍÑ…¹”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€ÑåÁ”ô‰¹Õµ‰•Èˆ(€€€€€€€€€€€€€€€€€€€€€€€€€µ¥¸õìÁô(€€€€€€€€€€€€€€€€€€€€€€€€€µ…àõìÐÀÀÁô(€€€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€ð½¥•±‘I½Üø(€€€€€€€€€€€€€€€€€€€€ñ¥•±‘I½Üø(€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰•Ý…äµ™É½´ˆùÉ½´A%8ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€¥ô‰•Ý…äµ™É½´ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰•Ý…äµ™É½´ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€¥¹ÁÕÑ5½‘”ô‰¹Õµ•É¥Œˆ(€€€€€€€€€€€€€€€€€€€€€€€€€Á…ÑÑ•É¸ô‰lÀ´åuìÙôˆ(€€€€€€€€€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÙô(€€€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰•Ý…äµÑ¼ˆùQ¼A%8ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€¥ô‰•Ý…äµÑ¼ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰•Ý…äµÑ¼ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€¥¹ÁÕÑ5½‘”ô‰¹Õµ•É¥Œˆ(€€€€€€€€€€€€€€€€€€€€€€€€€Á…ÑÑ•É¸ô‰lÀ´åuìÙôˆ(€€€€€€€€€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÙô(€€€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€ð½¥•±‘I½Üø(€€€€€€€€€€€€€€€€€€€íµ½Ù•Í=¹Y•¡¥±”¡•Ý…å5½‘”¤€ü€ (€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰•Ý…äµÙ•¡¥±”ˆùY•¡¥±”¹Õµ‰•Èð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€¥ô‰•Ý…äµÙ•¡¥±”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰•Ý…äµÙ•¡¥±”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€Á…ÑÑ•É¸ô‰mµhÀ´åuìØ°ÄÉôˆ(€€€€€€€€€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÄÉô(€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ!¥¹Ðø(€€€€€€€€€€€€€€€€€€€€€€€€€UÁÁ•É…Í”±•ÑÑ•ÉÌ…¹‘¥¥ÑÌ°¹¼ÍÁ…•Ì¸É½…µ½Ù•µ•¹Ð¹••‘Ì(€€€€€€€€€€€€€€€€€€€€€€€€€½¹”‰•™½É”9%Ý¥±°…¹ÍÝ•È¸(€€€€€€€€€€€€€€€€€€€€€€€€ð½!¥¹Ðø(€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€¤€è€ (€€€€€€€€€€€€€€€€€€€€€€ñ¥•±‘I½Üø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰•Ý…äµ‘½Œµ¹Õµ‰•Èˆø(€€€€€€€€€€€€€€€€€€€€€€€€€€€QÉ…¹ÍÁ½ÉÐ‘½Õµ•¹Ð¹Õµ‰•È(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€€€¥ô‰•Ý…äµ‘½Œµ¹Õµ‰•Èˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰•Ý…äµ‘½Œµ¹Õµ‰•Èˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÌÁô(€€€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ!¥¹Ðø(€€€€€€€€€€€€€€€€€€€€€€€€€€€Q¡”É…¥±Ý…äÉ••¥ÁÐ°…¥ÉÝ…ä‰¥±°½È‰¥±°½˜±…‘¥¹œÑ¡¥Ì(€€€€€€€€€€€€€€€€€€€€€€€€€€€½¹Í¥¹µ•¹Ðµ½Ù•Ì½¸¸(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½!¥¹Ðø(€€€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰•Ý…äµ‘½Œµ‘…Ñ”ˆùQÉ…¹ÍÁ½ÉÐ‘½Õµ•¹Ð‘…Ñ”ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ¥ô‰•Ý…äµ‘½Œµ‘…Ñ”ˆ¹…µ”ô‰•Ý…äµ‘½Œµ‘…Ñ”ˆÑåÁ”ô‰‘…Ñ”ˆ€¼ø(€€€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€€€ð½¥•±‘I½Üø(€€€€€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€€€€€€€ñ¥•±‘I½Üø(€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰•Ý…äµÑÉ…¹ÍÁ½ÉÑ•Èµ¥ˆùQÉ…¹ÍÁ½ÉÑ•È¥ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€¥ô‰•Ý…äµÑÉ…¹ÍÁ½ÉÑ•Èµ¥ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰•Ý…äµÑÉ…¹ÍÁ½ÉÑ•Èµ¥ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÄÕô(€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ!¥¹Ðù¥™Ñ••¸¡…É…Ñ•ÉÌìå½ÕÈ½Ý¸Ù•¡¥±”¹••‘Ì¹½¹”¸ð½!¥¹Ðø(€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰•Ý…äµÑÉ…¹ÍÁ½ÉÑ•Èµ¹…µ”ˆùQÉ…¹ÍÁ½ÉÑ•È¹…µ”ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€¥ô‰•Ý…äµÑÉ…¹ÍÁ½ÉÑ•Èµ¹…µ”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰•Ý…äµÑÉ…¹ÍÁ½ÉÑ•Èµ¹…µ”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€€€€ð½¥•±‘I½Üø(€€€€€€€€€€€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸ÑåÁ”ô‰ÍÕ‰µ¥Ðˆ‘¥Í…‰±•õíÁ•¹‘¥¹ôø(€€€€€€€€€€€€€€€€€€€€€€€É•…Ñ””µÝ…ä‰¥±°(€€€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€€€€€€€€€ð½™½É´ø(€€€€€€€€€€€€€€€€ð½¥Í±½ÍÕÉ”ø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€ð¼ø(€€€€€€€€€€¥ô((€€€€€€€€€í¥¹Ù½¥”¹ÍÑ…ÑÕÌ€ôôô€ÍÕ‰µ¥ÑÑ•œ€˜˜…¹…¹•°€˜˜€ (€€€€€€€€€€€€ñ¥Í±½ÍÕÉ”±…‰•°ô‰…¹•°Ñ¡¥Ì¥¹Ù½¥”ˆø(€€€€€€€€€€€€€€ñ™½É´(€€€€€€€€€€€€€€€½¹MÕ‰µ¥Ðõì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€€€€€€€€€€€€€€€Ù½¥…Ð¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€€€€€€€€€…Ý…¥Ð…Á¤¹…¹•±Q…á%¹Ù½¥”¡½É…¹¥Í…Ñ¥½¹%°¥¹Ù½¥”¹¥°ì(€€€€€€€€€€€€€€€€€€€€€¹½Ñ”è…¹•±9½Ñ”°(€€€€€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€€€€€€€…Ý…¥ÐÉ•™É•Í¡1¥ÍÐ ¤ì(€€€€€€€€€€€€€€€€€€€…Ý…¥Ð½Á•¹%¹Ù½¥••Ñ…¥°¡¥¹Ù½¥”¹¥¤ì(€€€€€€€€€€€€€€€€€€€Í•Ñ…¹•±9½Ñ” œœ¤ì(€€€€€€€€€€€€€€€€€ô°€Q…à¥¹Ù½¥”…¹•±±•ƒŠPÑ¡”5•…ÍÕÉ•µ•¹Ð	½½¬¥Ð‰¥±±•¥ÌÉ•±•…Í•™½È„½ÉÉ•Ñ•¥¹Ù½¥”¸œ¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰¥¹Ù½¥”µ…¹•°µ¹½Ñ”ˆù]¡ä¥Ð¥Ì‰•¥¹œ…¹•±±•ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€ñÑ•áÑ…É•„(€€€€€€€€€€€€€€€€€€€¥ô‰¥¹Ù½¥”µ…¹•°µ¹½Ñ”ˆ(€€€€€€€€€€€€€€€€€€€¹…µ”ô‰¥¹Ù½¥”µ…¹•°µ¹½Ñ”ˆ(€€€€€€€€€€€€€€€€€€€É½ÝÌõìÉô(€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€µ¥¹1•¹Ñ õìÍô(€€€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÈÀÀÁô(€€€€€€€€€€€€€€€€€€€Ù…±Õ”õí…¹•±9½Ñ•ô(€€€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€Í•Ñ…¹•±9½Ñ”¡•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¹Ù…±Õ”¤ì(€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€ñ!¥¹Ðø(€€€€€€€€€€€€€€€€€€€…¹•±±•¥¹Ù½¥”­••ÁÌ¥ÑÌ¹Õµ‰•È™½È•Ù•ÈƒŠPÑ¡”¹Õµ‰•È¥Ì¹•Ù•È(€€€€€€€€€€€€€€€€€€€É•ÕÍ•ƒŠP…¹Ñ¡¥Ì¹½Ñ”¥ÌÑ¡”É•½É½˜Ý¡ä¸(€€€€€€€€€€€€€€€€€€ð½!¥¹Ðø(€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸ÑåÁ”ô‰ÍÕ‰µ¥ÐˆÙ…É¥…¹Ðô‰‘•ÍÑÉÕÑ¥Ù”ˆ‘¥Í…‰±•õíÁ•¹‘¥¹ôø(€€€€€€€€€€€€€€€€€€€…¹•°¥¹Ù½¥”(€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€€€€€ð½™½É´ø(€€€€€€€€€€€€ð½¥Í±½ÍÕÉ”ø(€€€€€€€€€€¥ô(€€€€€€€€ð½Í•Ñ¥½¸ø(€€€€€€¥ô(€€€€ð¼ø(€€¤ì)ô(