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

function openPdf(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
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
                    <StatusChip status="issued">
                      {row.irpProvider === 'whitebooks'
                        ? 'IRP registered'
                        : 'manual IRP evidence Â· unverified'}
                    </StatusChip>
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
                const customerPoReference = formValue(
                  data,
                  'invoice-customer-po',
                );
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
                <option value="false">No â€” supplier pays GST (forward charge)</option>
                <option value="true">
                  Yes â€” recipient pays GST (issuance not supported yet)
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
             ×~üÒÚ$z{-®éÜj×¶&–ÆÂç&÷f–FW%7FFRÓÓÒvvVæW&F–ærp¢òt6†V6²7FÆÆVB÷W&F–öâp¢¢&–ÆÂç&÷f–FW%7FFRÓÓÒvvVæW&F–öå÷Væ¶æ÷vâp¢òu&V6öæ6–ÆRp¢¢tvVæW&FRBv†—FV&öö·2wĞ¢Âô'WGFöãà¢’¢€¢~(	Bp¢—Ğ¢Â÷FCà¢Â÷G#à¢’—Ğ¢Â÷F&öG“à¢ÂôFFF&ÆSà¢’¢€¢Ç6Æ74æÖSÒ'FW‡BÖ×WFVBÖf÷&Vw&÷VæB#à¢æòR×v’&–ÆÂ†2&VVâ&—6VBf÷"F†—2–çfö–6Rà¢Â÷à¢—Ğ ¢¶6ä6æ6VÂb`¢Wv”&–ÆÇ0¢æf–ÇFW"€¢†&–ÆÂ’Óà¢&–ÆÂç7FGW2ÓÓÒvvVæW&FVBrb`¢&–ÆÂç&÷f–FW"ÓÓÒwv†—FV&öö·2rb`¢†&–ÆÂç&÷f–FW%7FFRÓÓÒvvVæW&FVBrÇÀ¢&–ÆÂç&÷f–FW%7FFRÓÓÒv6æ6VÆÆ–ærr’À¢¢æÖ‚†&–ÆÂ’Óâ€¢ÄF—66Æ÷7W&P¢¶W“×¶&÷f–FW"Ö6æ6VÂÒG¶&–ÆÂæ–GÖĞ¢Æ&VÃ×¶6æ6VÂUt"G¶&–ÆÂæWv$çVÖ&W"óò&–ÆÂæ–GÒBv†—FV&öö·6Ğ¢à¢Æf÷&Ğ¢öå7V&Ö—C×²†WfVçB’Óâ°¢WfVçBç&WfVçDFVfVÇB‚“°¢6öç7BFFÒæWrf÷&ÔFF†WfVçBæ7W'&VçEF&vWB“°¢fö–B7B†7–æ2‚’Óâ°¢–b†&–ÆÂç&÷f–FW%7FFRÓÓÒv6æ6VÆÆ–ærr’°¢v—B’ç&V6÷fW$Wv”&–ÆÅ&÷f–FW$÷W&F–öâ€¢÷&væ—6F–öä–BÀ¢&–ÆÂæ–BÀ¢“°¢ÒVÇ6R°¢v—B’æ6æ6VÄWv”&–ÆÄE&÷f–FW"€¢÷&væ—6F–öä–BÀ¢&–ÆÂæ–BÀ¢°¢&V6öä6öFS¢f÷&ÕfÇVR€¢FFÀ¢Wv’×&÷f–FW"×&V6öâÒG¶&–ÆÂæ–GÖÀ¢’2srÂs"rÂs2rÂsBrÀ¢&VÖ&³¢f÷&ÕfÇVR€¢FFÀ¢Wv’×&÷f–FW"×&VÖ&²ÒG¶&–ÆÂæ–GÖÀ¢’À¢ÒÀ¢“°¢Ğ¢6WDWv”&–ÆÇ2€¢v—B’æÆ—7D–çfö–6TWv”&–ÆÇ2€¢÷&væ—6F–öä–BÀ¢–çfö–6Ræ–BÀ¢’À¢“°¢ÒÂuv†—FV&öö·2Ut"6æ6VÆÆF–öâ6†V6²f–æ—6†VBâ&÷f–FW"7FFR—2&Vg&W6†VB&VÆ÷s²F†RÆö6Â&V6÷&B7F—27F—fRVçF–Â6öæf—&ÖVBâr“°¢×Ğ¢à¢Äf–VÆE&÷sà¢Äf–VÆCà¢ÆÆ&VÂ‡FÖÄf÷#×¶Wv’×&÷f–FW"×&V6öâÒG¶&–ÆÂæ–GÖÓà¢&V6öà¢ÂöÆ&VÃà¢Ç6VÆV7@¢–C×¶Wv’×&÷f–FW"×&V6öâÒG¶&–ÆÂæ–GÖĞ¢æÖS×¶Wv’×&÷f–FW"×&V6öâÒG¶&–ÆÂæ–GÖĞ¢FVfVÇEfÇVSÒ#" ¢à¢Æ÷F–öâfÇVSÒ##äGWÆ–6FSÂö÷F–öãà¢Æ÷F–öâfÇVSÒ#"#ä÷&FW"6æ6VÆÆVCÂö÷F–öãà¢Æ÷F–öâfÇVSÒ#2#äFFVçG'’Ö—7F¶SÂö÷F–öãà¢Æ÷F–öâfÇVSÒ#B#ä÷F†W#Âö÷F–öãà¢Â÷6VÆV7Cà¢Âôf–VÆCà¢Äf–VÆCà¢ÆÆ&VÂ‡FÖÄf÷#×¶Wv’×&÷f–FW"×&VÖ&²ÒG¶&–ÆÂæ–GÖÓà¢&VÖ&°¢ÂöÆ&VÃà¢Æ–çW@¢–C×¶Wv’×&÷f–FW"×&VÖ&²ÒG¶&–ÆÂæ–GÖĞ¢æÖS×¶Wv’×&÷f–FW"×&VÖ&²ÒG¶&–ÆÂæ–GÖĞ¢&WV—&V@¢Ö–äÆVæwFƒ×³7Ğ¢Ö„ÆVæwFƒ×³#Ğ¢óà¢Âôf–VÆCà¢Âôf–VÆE&÷sà¢Ä7F–öç3à¢Ä'WGFöâG—SÒ'7V&Ö—B"F—6&ÆVC×·VæF–æwÓà¢¶&–ÆÂç&÷f–FW%7FFRÓÓÒv6æ6VÆÆ–ærp¢òt6†V6²7FÆÆVB6æ6VÆÆF–öâp¢¢t6æ6VÂB&÷f–FW"wĞ¢Âô'WGFöãà¢Âô7F–öç3à¢Âöf÷&Óà¢ÂôF—66Æ÷7W&Sà¢’—Ğ ¢¶6ä6æ6VÂb`¢Wv”&–ÆÇ0¢æf–ÇFW"€¢†&–ÆÂ’Óà¢†&–ÆÂç7FGW2ÓÓÒvvVæW&FVBrÇÂ&–ÆÂç7FGW2ÓÓÒv6æ6VÆÆVBr’b`¢‚†&–ÆÂç&÷f–FW"ÓÓÒvÖçVÂrb`¢&–ÆÂç&÷f–FW%7FFRÓÓÒvvVæW&FVBr’ÇÀ¢&–ÆÂç&÷f–FW%7FFRÓÓÒv6æ6VÆÆF–öå÷Væ¶æ÷vâr’À¢¢æÖ‚†&–ÆÂ’Óâ€¢ÄF—66Æ÷7W&P¢¶W“×¶ÖçVÂ×&÷f–FW"Ö6æ6VÂÒG¶&–ÆÂæ–GÖĞ¢Æ&VÃ×¶&V6÷&BW‡FW&æÆÇ’6öæf—&ÖVB6æ6VÆÆF–öâf÷"Ut"G¶&–ÆÂæWv$çVÖ&W"óò&–ÆÂæ–GÒ‡VçfW&–f–VB–Ğ¢à¢Æf÷&Ğ¢öå7V&Ö—C×²†WfVçB’Óâ°¢WfVçBç&WfVçDFVfVÇB‚“°¢6öç7BFFÒæWrf÷&ÔFF†WfVçBæ7W'&VçEF&vWB“°¢fö–B7B†7–æ2‚’Óâ°¢v—B’ç&V6÷&DWv”&–ÆÄ6æ6VÆÆF–öâ€¢÷&væ—6F–öä–BÀ¢&–ÆÂæ–BÀ¢°¢&V6öä6öFS¢f÷&ÕfÇVR€¢FFÀ¢Wv’ÖÖçVÂ×&V6öâÒG¶&–ÆÂæ–GÖÀ¢’2srÂs"rÂs2rÂsBrÀ¢&VÖ&³¢f÷&ÕfÇVR€¢FFÀ¢Wv’ÖÖçVÂ×&VÖ&²ÒG¶&–ÆÂæ–GÖÀ¢’À¢6æ6VÆÆVDC¢æWrFFR€¢f÷&ÕfÇVR€¢FFÀ¢Wv’ÖÖçVÂÖFFRÒG¶&–ÆÂæ–GÖÀ¢’À¢’çFô•4õ7G&–ær‚’À¢6æ6VÆÆVDEFW‡C¢f÷&ÕfÇVR€¢FFÀ¢Wv’ÖÖçVÂÖFFR×FW‡BÒG¶&–ÆÂæ–GÖÀ¢’À¢ÒÀ¢“°¢6WDWv”&–ÆÇ2€¢v—B’æÆ—7D–çfö–6TWv”&–ÆÇ2€¢÷&væ—6F–öä–BÀ¢–çfö–6Ræ–BÀ¢’À¢“°¢ÒÂtW‡FW&æÂUt"6æ6VÆÆF–öâWf–FVæ6R&V6÷&FVB2ÖçVÆÇ’VçFW&VBæBVçfW&–f–VBâr“°¢×Ğ¢à¢Äf–VÆE&÷sà¢Äf–VÆCà¢ÆÆ&VÂ‡FÖÄf÷#×¶Wv’ÖÖçVÂ×&V6öâÒG¶&–ÆÂæ–GÖÓà¢&V6öà¢ÂöÆ&VÃà¢Ç6VÆV7@¢–C×¶Wv’ÖÖçVÂ×&V6öâÒG¶&–ÆÂæ–GÖĞ¢æÖS×¶Wv’ÖÖçVÂ×&V6öâÒG¶&–ÆÂæ–GÖĞ¢FVfVÇEfÇVSÒ#" ¢à¢Æ÷F–öâfÇVSÒ##äGWÆ–6FSÂö÷F–öãà¢Æ÷F–öâfÇVSÒ#"#ä÷&FW"6æ6VÆÆVCÂö÷F–öãà¢Æ÷F–öâfÇVSÒ#2#äFFVçG'’Ö—7F¶SÂö÷F–öãà¢Æ÷F–öâfÇVSÒ#B#ä÷F†W#Âö÷F–öãà¢Â÷6VÆV7Cà¢Âôf–VÆCà¢Äf–VÆCà¢ÆÆ&VÂ‡FÖÄf÷#×¶Wv’ÖÖçVÂÖFFRÒG¶&–ÆÂæ–GÖÓà¢æ÷&ÖÆ—¦VB–ç7Fç@¢ÂöÆ&VÃà¢Æ–çW@¢–C×¶Wv’ÖÖçVÂÖFFRÒG¶&–ÆÂæ–GÖĞ¢æÖS×¶Wv’ÖÖçVÂÖFFRÒG¶&–ÆÂæ–GÖĞ¢G—SÒ&FFWF–ÖRÖÆö6Â ¢&WV—&V@¢óà¢Âôf–VÆCà¢Âôf–VÆE&÷sà¢Äf–VÆCà¢ÆÆ&VÂ‡FÖÄf÷#×¶Wv’ÖÖçVÂÖFFR×FW‡BÒG¶&–ÆÂæ–GÖÓà¢÷'FÂ6æ6VÆÆF–öâFW‡B†W†7B¢ÂöÆ&VÃà¢Æ–çW@¢–C×¶Wv’ÖÖçVÂÖFFR×FW‡BÒG¶&–ÆÂæ–GÖĞ¢æÖS×¶Wv’ÖÖçVÂÖFFR×FW‡BÒG¶&–ÆÂæ–GÖĞ¢Æ6V†öÆFW#Ò#ó‚ó##b#£3£ ¢&WV—&V@¢óà¢Âôf–VÆCà¢Äf–VÆCà¢ÆÆ&VÂ‡FÖÄf÷#×¶Wv’ÖÖçVÂ×&VÖ&²ÒG¶&–ÆÂæ–GÖÓà¢&VÖ&°¢ÂöÆ&VÃà¢Æ–çW@¢–C×¶Wv’ÖÖçVÂ×&VÖ&²ÒG¶&–ÆÂæ–GÖĞ¢æÖS×¶Wv’ÖÖçVÂ×&VÖ&²ÒG¶&–ÆÂæ–GÖĞ¢&WV—&V@¢Ö–äÆVæwFƒ×³7Ğ¢Ö„ÆVæwFƒ×³#Ğ¢óà¢Âôf–VÆCà¢Ä7F–öç3à¢Ä'WGFöâG—SÒ'7V&Ö—B"F—6&ÆVC×·VæF–æwÓà¢&V6÷&BVçfW&–f–VB6æ6VÆÆF–öà¢Âô'WGFöãà¢Âô7F–öç3à¢Âöf÷&Óà¢ÂôF—66Æ÷7W&Sà¢’—Ğ ¢¶6ä6æ6VÂb`¢Wv”&–ÆÇ0¢æf–ÇFW"€¢†&–ÆÂ’Óà¢&–ÆÂç7FGW2ÓÓÒvvVæW&FVBrb`¢&–ÆÂç&÷f–FW%7FFRÓÓÒv6æ6VÆÆVBrÀ¢¢æÖ‚†&–ÆÂ’Óâ€¢ÄF—66Æ÷7W&P¢¶W“×¶Æö6ÂÖ6æ6VÂÒG¶&–ÆÂæ–GÖĞ¢Æ&VÃ×¶6æ6VÂÆö6ÂUt"&V6÷&BG¶&–ÆÂæWv$çVÖ&W"óò&–ÆÂæ–GÖĞ¢à¢Æf÷&Ğ¢öå7V&Ö—C×²†WfVçB’Óâ°¢WfVçBç&WfVçDFVfVÇB‚“°¢6öç7BFFÒæWrf÷&ÔFF†WfVçBæ7W'&VçEF&vWB“°¢fö–B7B†7–æ2‚’Óâ°¢v—B’æ6æ6VÄWv”&–ÆÂ†÷&væ—6F–öä–BÂ&–ÆÂæ–BÂ°¢æ÷FS¢f÷&ÕfÇVR€¢FFÀ¢Wv’ÖÆö6ÂÖ6æ6VÂÖæ÷FRÒG¶&–ÆÂæ–GÖÀ¢’À¢Ò“°¢6WDWv”&–ÆÇ2€¢v—B’æÆ—7D–çfö–6TWv”&–ÆÇ2€¢÷&væ—6F–öä–BÀ¢–çfö–6Ræ–BÀ¢’À¢“°¢ÒÂtÆö6ÂUt"&V6÷&B6æ6VÆÆVC²öff–6–Â–FVçF—G’æBfÆ–F—G’Wf–FVæ6RvW&R&WF–æVBâr“°¢×Ğ¢à¢Äf–VÆCà¢ÆÆ&VÂ‡FÖÄf÷#×¶Wv’ÖÆö6ÂÖ6æ6VÂÖæ÷FRÒG¶&–ÆÂæ–GÖÓà¢Æö6Â6æ6VÆÆF–öâæ÷FP¢ÂöÆ&VÃà¢ÇFW‡F&V¢–C×¶Wv’ÖÆö6ÂÖ6æ6VÂÖæ÷FRÒG¶&–ÆÂæ–GÖĞ¢æÖS×¶Wv’ÖÆö6ÂÖ6æ6VÂÖæ÷FRÒG¶&–ÆÂæ–GÖĞ¢&WV—&V@¢Ö–äÆVæwFƒ×³7Ğ¢Ö„ÆVæwFƒ×³#Ğ¢&÷w3×³'Ğ¢óà¢Âôf–VÆCà¢Ä7F–öç3à¢Ä'WGFöâG—SÒ'7V&Ö—B"F—6&ÆVC×·VæF–æwÓà¢6æ6VÂÆö6Â&V6÷&@¢Âô'WGFöãà¢Âô7F–öç3à¢Âöf÷&Óà¢ÂôF—66Æ÷7W&Sà¢’—Ğ ¢Âóà¢—Ğ ¢¶–çfö–6Rç7FGW2ÓÓÒw7V&Ö—GFVBrb`¢6ä6æ6VÂb`¢†–çfö–6Ræ—'&÷f–FW%7FFRÓÓÒvæ÷E÷&WVW7FVBrÇÀ¢–çfö–6Ræ—'&÷f–FW%7FFRÓÓÒv6æ6VÆÆVBr’bb€¢ÄF—66Æ÷7W&RÆ&VÃÒ$6æ6VÂF†—2–çfö–6R#à¢Æf÷&Ğ¢öå7V&Ö—C×²†WfVçB’Óâ°¢WfVçBç&WfVçDFVfVÇB‚“°¢fö–B7B†7–æ2‚’Óâ°¢v—B’æ6æ6VÅF„–çfö–6R†÷&væ—6F–öä–BÂ–çfö–6Ræ–BÂ°¢æ÷FS¢6æ6VÄæ÷FRÀ¢Ò“°¢v—B&Vg&W6„Æ—7B‚“°¢v—B÷Vä–çfö–6TFWF–Â†–çfö–6Ræ–B“°¢6WD6æ6VÄæ÷FR‚rr“°¢ÒÂuF‚–çfö–6R6æ6VÆÆVB(	BF†RÖV7W&VÖVçB&öö²—B&–ÆÆVB—2&VÆV6VBf÷"6÷'&V7FVB–çfö–6Râr“°¢×Ğ¢à¢Äf–VÆCà¢ÆÆ&VÂ‡FÖÄf÷#Ò&–çfö–6RÖ6æ6VÂÖæ÷FR#åv‡’—B—2&V–ær6æ6VÆÆVCÂöÆ&VÃà¢ÇFW‡F&V¢–CÒ&–çfö–6RÖ6æ6VÂÖæ÷FR ¢æÖSÒ&–çfö–6RÖ6æ6VÂÖæ÷FR ¢&÷w3×³'Ğ¢&WV—&V@¢Ö–äÆVæwFƒ×³7Ğ¢Ö„ÆVæwFƒ×³#Ğ¢fÇVS×¶6æ6VÄæ÷FWĞ¢öä6†ævS×²†WfVçB’Óâ°¢6WD6æ6VÄæ÷FR†WfVçBæ7W'&VçEF&vWBçfÇVR“°¢×Ğ¢óà¢Ä†–çCà¢6æ6VÆÆVB–çfö–6R¶VW2—G2çVÖ&W"f÷"WfW"(	BF†RçVÖ&W"—2æWfW ¢&WW6VB(	BæBF†—2æ÷FR—2F†R&V6÷&Böbv‡’à¢Âô†–çCà¢Âôf–VÆCà¢Ä7F–öç3à¢Ä'WGFöâG—SÒ'7V&Ö—B"f&–çCÒ&FW7G'V7F—fR"F—6&ÆVC×·VæF–æwÓà¢6æ6VÂ–çfö–6P¢Âô'WGFöãà¢Âô7F–öç3à¢Âöf÷&Óà¢ÂôF—66Æ÷7W&Sà¢—Ğ¢¶–çfö–6Rç7FGW2ÓÓÒw7V&Ö—GFVBrb`¢6ä6æ6VÂb`¢–çfö–6Ræ—'&÷f–FW%7FFRÓÒvæ÷E÷&WVW7FVBrb`¢–çfö–6Ræ—'&÷f–FW%7FFRÓÒv6æ6VÆÆVBrbb€¢Ç6Æ74æÖSÒ'FW‡BÖ×WFVBÖf÷&Vw&÷VæB#à¢Æö6Â–çfö–6R6æ6VÆÆF–öâ—2Æö6¶VBv†–ÆR•%7FFR—7²rwĞ¢Ç7G&öæsç¶–çfö–6Ræ—'&÷f–FW%7FFWÓÂ÷7G&öæsââ&W6öÇfR&Vv—7G&F–öâæ@¢6æ6VÂç’Ut"æB•$âf—'7Bà¢Â÷à¢—Ğ¢Â÷6V7F–öãà¢—Ğ¢Âóà¢“°§Ğ