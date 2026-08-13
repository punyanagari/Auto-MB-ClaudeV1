import { useEffect, useState } from 'react';
import type {
  Contact,
  CreditNote,
  EwayBill,
  GstRateMaster,
  MeasurementBook,
  TaxInvoice,
  TaxInvoiceDetailResponse,
  TaxInvoiceLineShape,
} from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { describeLoadFailure, type LoadFailure } from '../lib/load-failure.js';
import { mastersHash } from '../lib/workspace-routes.js';
import { Button } from '../ui/button.js';
import { FormError } from '../ui/form.js';
import { ErrorState, LoadingState } from '../ui/state.js';
import { CreditNotesPanel } from './work-tax-invoices/CreditNotesPanel.js';
import { EwayBillsPanel } from './work-tax-invoices/EwayBillsPanel.js';
import { InvoiceDraftForm } from './work-tax-invoices/InvoiceDraftForm.js';
import {
  InvoiceCancelPanel,
  InvoiceDetail,
} from './work-tax-invoices/InvoiceDetail.js';
import { InvoiceList } from './work-tax-invoices/InvoiceList.js';
import { IrpPanel } from './work-tax-invoices/IrpPanel.js';

interface WorkTaxInvoicesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canModify: boolean;
  /** Drafting an invoice additionally requires the Work to be active. */
  readonly canCreateDocuments: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  /** The compliance authority (migration 0061). Every IRP/NIC portal
   * control needs it IN ADDITION to canIssue/canCancel. */
  readonly canManageStatutory: boolean;
  readonly pending: boolean;
  /** The page's shared action runner: reports, refreshes, and clears. */
  readonly act: (run: () => Promise<void>, message: string) => Promise<void>;
}

/**
 * The GST tax invoice raised against a finalized Measurement Book, and
 * the e-way bill that moves it.
 *
 * The invoice's LINE SHAPE is a per-document choice (migration 0057):
 * one cumulative service line at a SAC for the whole MB total, or
 * itemised HSN/SAC lines each with their own quantity, rate and GST rate.
 * The organisation's default seeds the create form and nothing else — the
 * shape is never derived from the buyer, because practice varies by
 * company and the same consignee may take either. Submitting is what
 * closes the MB it bills, so it is the money moment: the number, the
 * buyer snapshot and every amount freeze together, and only a cancellation
 * (with a note) releases the MB for a corrected invoice.
 *
 * The IRN, acknowledgement and signed QR are NOT minted here. The payload
 * goes out to the GSP, the IRP answers, and what it answered is recorded
 * verbatim — same for the e-way bill's number and validity window, which
 * come back from NIC.
 *
 * This file orchestrates state and data loading; the surfaces live in
 * ./work-tax-invoices/ (list, draft form, detail, IRP, credit notes,
 * e-way bills).
 */
export function WorkTaxInvoices({
  api,
  organisationId,
  workId,
  canModify,
  canCreateDocuments,
  canIssue,
  canCancel,
  canManageStatutory,
  pending,
  act,
}: WorkTaxInvoicesProps) {
  const [invoices, setInvoices] = useState<readonly TaxInvoice[] | null>(null);
  const [books, setBooks] = useState<readonly MeasurementBook[]>([]);
  const [clients, setClients] = useState<readonly Contact[]>([]);
  const [shipToContacts, setShipToContacts] = useState<readonly Contact[]>([]);
  const [gstRates, setGstRates] = useState<readonly GstRateMaster[]>([]);
  // The create form's STARTING shape (migration 0057). A default only —
  // the operator chooses per document — so an unavailable profile simply
  // starts the form on the cumulative service invoice.
  const [defaultInvoiceShape, setDefaultInvoiceShape] =
    useState<TaxInvoiceLineShape>('service_cumulative');
  const [detail, setDetail] = useState<TaxInvoiceDetailResponse | null>(null);
  const [ewayBills, setEwayBills] = useState<readonly EwayBill[]>([]);
  const [creditNotes, setCreditNotes] = useState<readonly CreditNote[]>([]);
  const [loadError, setLoadError] = useState(false);
  /** A picker that could not be read. The invoices still render — this
   * says which action is missing and why (audit finding 27 residue). */
  const [pickerFailure, setPickerFailure] = useState<LoadFailure | null>(null);
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
    //
    // But their failure must not be SILENT either (audit finding 27's
    // residue). Swallowing it made an unreachable Measurement Book list
    // indistinguishable from a Work with nothing billable: the create
    // form simply was not offered, and the operator was left to conclude
    // there was nothing to bill. That is the same lie as an empty
    // register, told about an action instead of a record.
    setPickerFailure(null);
    api
      .listWorkMeasurementBooks(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setBooks(loaded.books);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setPickerFailure(describeLoadFailure(cause, 'Measurement Books'));
        }
      });
    api
      .listContacts(organisationId)
      .then((contacts) => {
        if (!cancelled) {
          setClients(contacts.filter((contact) => contact.isClient));
          setShipToContacts(contacts);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setPickerFailure(
            (current) =>
              // First failure wins: two banners saying the same outage twice
              // is noise, and the retry re-runs every load anyway.
              current ?? describeLoadFailure(cause, 'Contacts'),
          );
        }
      });
    api
      .listGstRates(organisationId)
      .then((rates) => {
        if (!cancelled) setGstRates(rates);
      })
      .catch(() => {
        // Deliberately still silent, and the only one: the rate picker
        // degrades to a plain input the operator can type into, and the
        // server refuses a rate the master does not notify. Nothing is
        // hidden and no action is withdrawn, so there is nothing to warn
        // about.
      });
    api
      .organisationProfile(organisationId)
      .then((profile) => {
        if (!cancelled && profile.defaultInvoiceShape !== undefined) {
          setDefaultInvoiceShape(profile.defaultInvoiceShape);
        }
      })
      .catch(() => {
        // The form starts on the cumulative shape, which is what every
        // invoice raised before this setting existed was.
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
    // E-way bills exist only for a submitted invoice; asking for a
    // draft's would be a guaranteed empty round trip.
    setEwayBills(
      loaded.invoice.status === 'submitted'
        ? await api.listInvoiceEwayBills(organisationId, invoiceId)
        : [],
    );
    // Credit notes ride submitted and superseded invoices (0051).
    setCreditNotes(
      loaded.invoice.status === 'submitted' || loaded.invoice.status === 'superseded'
        ? await api.listInvoiceCreditNotes(organisationId, invoiceId)
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
        <ErrorState
          retryLabel="Retry tax invoices"
          onRetry={() => {
            setLoadVersion((current) => current + 1);
          }}
        >
          Tax invoices could not be loaded. Existing invoices remain unknown, so
          drafting is paused.
        </ErrorState>
      </>
    );
  }

  if (invoices === null) {
    return (
      <>
        <h2>Tax Invoices</h2>
        <LoadingState label="the tax invoices" rows={4} columns={4} />
      </>
    );
  }

  const invoice = detail?.invoice ?? null;
  // A Measurement Book is billable once, so an MB already carrying a live
  // invoice leaves the picker; a cancelled OR superseded invoice puts it
  // back (supersession by an issued credit note releases the MB, 0051).
  const billedBookIds = new Set(
    invoices
      .filter((row) => row.status !== 'cancelled' && row.status !== 'superseded')
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
  // The one prerequisite an operator can fix elsewhere right now: a
  // billable MB exists but no client contact does. Shown as a disabled
  // action with the way there, instead of silently hiding the workflow.
  const draftBlockedByMissingClient =
    canModify && canCreateDocuments && billableBooks.length > 0 && clients.length === 0;

  const refreshOpenInvoice = async () => {
    if (invoice === null) return;
    await refreshList();
    await openInvoiceDetail(invoice.id);
  };

  return (
    <>
      <h2>Tax Invoices</h2>
      <p className="text-muted-foreground">
        The GST invoice for a finalized Measurement Book — one cumulative service line
        at its SAC for the whole MB total, not a line per item. Submitting assigns the
        next gap-free number for the financial year, snapshots the buyer, freezes every
        amount, and closes the Measurement Book it bills.
      </p>

      <InvoiceList invoices={invoices} pending={pending} onOpen={openInvoice} />

      {/* A 403 is not a transient failure and has no retry: it is the
          permission-limited state `docs/UX.md` keeps separate from a
          service failure, so it reads as an inline refusal rather than
          offering an action that would refuse identically. */}
      {pickerFailure !== null &&
        (pickerFailure.retryable ? (
          <ErrorState
            retryLabel="Retry"
            onRetry={() => {
              setLoadVersion((current) => current + 1);
            }}
          >
            {pickerFailure.message} Drafting is unavailable until it loads — the
            invoices above are unaffected, and this does not mean there is nothing to
            bill.
          </ErrorState>
        ) : (
          <FormError>
            {pickerFailure.message} Drafting is unavailable — the invoices above are
            unaffected, and this does not mean there is nothing to bill.
          </FormError>
        ))}

      {draftBlockedByMissingClient && (
        <>
          <Button disabled aria-disabled="true">
            Draft a tax invoice
          </Button>
          <p className="text-muted-foreground">
            Drafting needs a client contact to name as the buyer, and this organisation
            has none yet.{' '}
            <a href={mastersHash('contacts')}>Add one under Masters → Contacts</a>, then
            return here.
          </p>
        </>
      )}

      {canDraft && (
        <InvoiceDraftForm
          api={api}
          organisationId={organisationId}
          workId={workId}
          billableBooks={billableBooks}
          clients={clients}
          shipToContacts={shipToContacts}
          gstRates={gstRates}
          defaultInvoiceShape={defaultInvoiceShape}
          startOpen={invoices.length === 0}
          pending={pending}
          act={act}
          onCreated={async (created) => {
            await refreshList();
            await openInvoiceDetail(created.invoice.id);
          }}
        />
      )}

      {invoice !== null && (
        <section>
          <InvoiceDetail
            key={`${invoice.id}-${invoice.status}`}
            api={api}
            organisationId={organisationId}
            invoice={invoice}
            lines={detail?.lines ?? []}
            clients={clients}
            shipToContacts={shipToContacts}
            gstRates={gstRates}
            canModify={canModify}
            canIssue={canIssue}
            pending={pending}
            act={act}
            refresh={refreshOpenInvoice}
            onDeleted={async () => {
              setDetail(null);
              await refreshList();
            }}
          />

          <IrpPanel
            api={api}
            organisationId={organisationId}
            invoice={invoice}
            canIssue={canIssue}
            canCancel={canCancel}
            canManageStatutory={canManageStatutory}
            pending={pending}
            act={act}
            refresh={refreshOpenInvoice}
          />

          <CreditNotesPanel
            key={`credit-notes-${invoice.id}`}
            api={api}
            organisationId={organisationId}
            invoice={invoice}
            creditNotes={creditNotes}
            canModify={canModify}
            canIssue={canIssue}
            canCancel={canCancel}
            canManageStatutory={canManageStatutory}
            pending={pending}
            act={act}
            refresh={refreshOpenInvoice}
          />

          <EwayBillsPanel
            api={api}
            organisationId={organisationId}
            invoice={invoice}
            ewayBills={ewayBills}
            canIssue={canIssue}
            canCancel={canCancel}
            canManageStatutory={canManageStatutory}
            pending={pending}
            act={act}
            onEwayBillsChanged={setEwayBills}
          />

          {canCancel && (
            <InvoiceCancelPanel
              key={`cancel-${invoice.id}`}
              api={api}
              organisationId={organisationId}
              invoice={invoice}
              pending={pending}
              act={act}
              refresh={refreshOpenInvoice}
            />
          )}
        </section>
      )}
    </>
  );
}
