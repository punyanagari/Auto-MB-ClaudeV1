import { useCallback, useEffect, useState } from 'react';
import type {
  Contact,
  CreditNote,
  EwayBill,
  GstRateMaster,
  TaxInvoiceDetailResponse,
  TaxInvoiceLineShape,
  TaxInvoiceRegisterEntry,
} from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import { formatDate, formatInr } from '../format.js';
import { describeLoadFailure, type LoadFailure } from '../lib/load-failure.js';
import {
  mastersHash,
  navigateOnClick,
  workspaceHashOf,
} from '../lib/workspace-routes.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DateField } from '../ui/date-field.js';
import { FormError } from '../ui/form.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { WorkLink } from '../ui/work-link.js';
import { DirectInvoiceForm } from './work-tax-invoices/DirectInvoiceForm.js';
import { OpenedInvoice } from './work-tax-invoices/OpenedInvoice.js';

/**
 * The organisation-wide tax-invoice register, and the home of the DIRECT
 * invoice.
 *
 * Invoices have always been reachable one Work at a time, which answers
 * "what has this contract billed" and cannot answer what the office
 * asks: what have we billed, to whom, and what is still unregistered at
 * the IRP. And a DIRECT invoice — raised against a private customer,
 * outside any works contract — had no screen at all: the server has
 * drafted, numbered, rendered and registered them since migration 0039,
 * and there was no Work to reach one through.
 *
 * So the register reads across, and raising a direct invoice happens
 * here. Raising a WORK's invoice still happens on the Work, because it
 * bills a finalized Measurement Book of that Work and the picker for
 * that is the Work's own. A direct invoice has no such parent, which is
 * exactly why it belongs to the module rather than to a contract.
 *
 * One invoice opens into one detail surface, `OpenedInvoice` — the same
 * component the Work's Bills tab opens — so the PDF, the IRP transport
 * and the credit note are the same controls wherever the document was
 * reached from.
 *
 * The list is paged and its one filter is a date window, for the reason
 * `docs/UX.md` gives every global register: it carries the filter its
 * question needs and no more. Cancelled and superseded invoices stay
 * listed, because a numbered document that was cancelled is precisely
 * the fact a register must keep reporting.
 */

/** One request's worth of rows. Large enough that the common answer — a
 * quarter's billing — arrives whole, small enough to be a bounded read. */
const PAGE_SIZE = 100;

interface InvoicesRegisterProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly canModify: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly canManageStatutory: boolean;
  /** The invoice the route names, or null for the register itself. */
  readonly openInvoiceId: string | null;
  readonly onOpenInvoice: (invoiceId: string | null) => void;
  /** Opens a Work at its Bills tab; the workspace shell owns the actual
   * navigation so the dirty-editor guard still applies. */
  readonly onOpenWork: (workId: string) => void;
}

export function InvoicesRegister({
  api,
  organisationId,
  canModify,
  canIssue,
  canCancel,
  canManageStatutory,
  openInvoiceId,
  onOpenInvoice,
  onOpenWork,
}: InvoicesRegisterProps) {
  const [invoices, setInvoices] = useState<readonly TaxInvoiceRegisterEntry[] | null>(
    null,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The window the operator has actually asked for, as opposed to what
   * they are still typing: the inputs are uncontrolled and only applied
   * on submit, so a half-typed year never fires a request. */
  const [dateWindow, setDateWindow] = useState<{
    readonly from: string;
    readonly to: string;
  }>({ from: '', to: '' });
  /** Bumped by the failure state's retry, to re-run the load below. */
  const [loadVersion, setLoadVersion] = useState(0);

  const [clients, setClients] = useState<readonly Contact[]>([]);
  const [shipToContacts, setShipToContacts] = useState<readonly Contact[]>([]);
  const [gstRates, setGstRates] = useState<readonly GstRateMaster[]>([]);
  const [defaultInvoiceShape, setDefaultInvoiceShape] =
    useState<TaxInvoiceLineShape>('service_cumulative');
  /** A picker that could not be read. The register still renders — this
   * says which action is missing and why. */
  const [pickerFailure, setPickerFailure] = useState<LoadFailure | null>(null);

  const [detail, setDetail] = useState<TaxInvoiceDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [ewayBills, setEwayBills] = useState<readonly EwayBill[]>([]);
  const [creditNotes, setCreditNotes] = useState<readonly CreditNote[]>([]);

  const fetchPage = useCallback(
    (cursor?: string) =>
      api.listTaxInvoices(organisationId, {
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(dateWindow.from !== '' ? { invoicedFrom: dateWindow.from } : {}),
        ...(dateWindow.to !== '' ? { invoicedTo: dateWindow.to } : {}),
      }),
    [api, organisationId, dateWindow],
  );

  useEffect(() => {
    let cancelled = false;
    setInvoices(null);
    setNextCursor(null);
    setLoadError(null);
    fetchPage()
      .then((page) => {
        if (cancelled) return;
        setInvoices(page.invoices);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The tax invoices could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, loadVersion]);

  // The masters the draft form needs. They are conveniences: an
  // unavailable contact master must not stop the invoices that already
  // exist from being read — but its failure must not be silent either,
  // because a missing form and an empty organisation look identical.
  useEffect(() => {
    let cancelled = false;
    setPickerFailure(null);
    api
      .listContacts(organisationId)
      .then((contacts) => {
        if (cancelled) return;
        setClients(contacts.filter((contact) => contact.isClient && contact.active));
        setShipToContacts(contacts);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setPickerFailure(describeLoadFailure(cause, 'Contacts'));
      });
    api
      .listGstRates(organisationId)
      .then((rates) => {
        if (!cancelled) setGstRates(rates);
      })
      .catch(() => {
        // Deliberately silent, as on the Work's invoice tab: the rate
        // picker degrades to a plain input, and the server refuses a rate
        // the master does not notify. Nothing is hidden.
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
  }, [api, organisationId, loadVersion]);

  const loadDetail = useCallback(
    async (invoiceId: string) => {
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
    },
    [api, organisationId],
  );

  // The opened invoice follows the ROUTE, so a refresh, a Back and a
  // pasted link all land on the same document.
  useEffect(() => {
    let cancelled = false;
    if (openInvoiceId === null) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    setDetail(null);
    setDetailError(null);
    loadDetail(openInvoiceId).catch((cause: unknown) => {
      if (cancelled) return;
      setDetailError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'That tax invoice could not be loaded.',
      );
    });
    return () => {
      cancelled = true;
    };
  }, [openInvoiceId, loadDetail, loadVersion]);

  const act = useCallback(async (run: () => Promise<void>, done: string) => {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await run();
      setNotice(done);
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The action failed; nothing was changed.',
      );
    } finally {
      setPending(false);
    }
  }, []);

  function retry(): void {
    setLoadVersion((current) => current + 1);
  }

  async function refreshList(): Promise<void> {
    const page = await fetchPage();
    setInvoices(page.invoices);
    setNextCursor(page.nextCursor);
  }

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    setPending(true);
    setLoadError(null);
    try {
      const page = await fetchPage(nextCursor);
      setInvoices((current) => [...(current ?? []), ...page.invoices]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setLoadError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The next page of tax invoices could not be loaded.',
      );
    } finally {
      setPending(false);
    }
  }

  const filtered = dateWindow.from !== '' || dateWindow.to !== '';
  const canDraftDirect = canModify && clients.length > 0;
  // The one prerequisite an operator can fix elsewhere right now: no
  // client contact exists to name as the buyer. Shown as a disabled
  // action with the way there, instead of silently hiding the workflow.
  const draftBlockedByMissingClient = canModify && clients.length === 0;

  return (
    <>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-semibold tracking-widest text-primary uppercase">
            Documents
          </p>
          <h1 id="invoices-title" tabIndex={-1}>
            Invoices
          </h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Every GST tax invoice in the organisation, newest first — raised against a
            Work&rsquo;s finalized Measurement Book, or directly against a private
            customer. A Work&rsquo;s invoice is drafted on the Work; a direct one is
            drafted here.
          </p>
        </div>
      </header>

      <section aria-labelledby="invoices-title" className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setDateWindow({
              from: formValue(data, 'invoiced-from'),
              to: formValue(data, 'invoiced-to'),
            });
          }}
        >
          <DateField
            id="invoiced-from"
            name="invoiced-from"
            label="Invoiced on or after"
            fieldClassName="my-0"
          />
          <DateField
            id="invoiced-to"
            name="invoiced-to"
            label="Invoiced on or before"
            fieldClassName="my-0"
          />
          <Button type="submit" variant="outline">
            Apply dates
          </Button>
        </form>

        {notice !== null && <p role="status">{notice}</p>}
        {actionError !== null && <FormError>{actionError}</FormError>}

        {loadError !== null && (
          <ErrorState onRetry={retry} retryLabel="Retry invoices">
            {loadError}
          </ErrorState>
        )}
        {loadError === null && invoices === null && (
          <LoadingState label="the tax invoices" rows={5} columns={5} />
        )}

        {invoices !== null &&
          (invoices.length > 0 ? (
            <>
              <DataTable>
                <caption className="sr-only">
                  Tax invoices with number, buyer, date, taxable value, GST, status, IRP
                  state and source
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Number</th>
                    <th scope="col">Buyer</th>
                    <th scope="col">Date</th>
                    <th scope="col" className={numericCell}>
                      Taxable value
                    </th>
                    <th scope="col" className={numericCell}>
                      GST
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">IRP</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        <a
                          href={workspaceHashOf({
                            view: { name: 'invoice', invoiceId: row.id },
                          })}
                          className="font-medium text-primary underline-offset-4 hover:underline"
                          onClick={navigateOnClick(() => {
                            onOpenInvoice(row.id);
                          })}
                        >
                          {row.invoiceNumber ?? 'Draft'}
                        </a>
                      </th>
                      <td className={wrapCell}>{row.buyerName}</td>
                      {/* Left-aligned, as the Delivery Challan and
                          installation registers' date columns are. */}
                      <td>{formatDate(row.invoiceDate)}</td>
                      <td className={numericCell}>
                        {row.taxableValue === null ? '—' : formatInr(row.taxableValue)}
                      </td>
                      <td className={numericCell}>
                        {row.gstAmount === null ? '—' : formatInr(row.gstAmount)}
                      </td>
                      <td>
                        <StatusChip status={row.status} />
                      </td>
                      <td>
                        <IrpCell row={row} />
                      </td>
                      <td>
                        {row.workId !== null &&
                        row.workCode !== null &&
                        row.workTitle !== null ? (
                          <WorkLink
                            workId={row.workId}
                            workCode={row.workCode}
                            workTitle={row.workTitle}
                            tab="bills"
                            onOpenWork={onOpenWork}
                          />
                        ) : (
                          'Direct'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
              {nextCursor !== null && (
                <div>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => void loadMore()}
                  >
                    Load more invoices
                  </Button>
                </div>
              )}
            </>
          ) : filtered ? (
            <EmptyState>
              No invoices were raised in these dates. Widen the window, or clear both
              dates to read the whole register.
            </EmptyState>
          ) : (
            <EmptyState>
              No tax invoice has been raised yet. A Work&rsquo;s invoice is raised on
              that Work, from a finalized Measurement Book; an invoice for a private
              customer is raised here.
            </EmptyState>
          ))}

        {/* A 403 is not a transient failure and has no retry: it is the
            permission-limited state `docs/UX.md` keeps separate from a
            service failure, so it reads as an inline refusal rather than
            offering an action that would refuse identically. */}
        {pickerFailure !== null &&
          (pickerFailure.retryable ? (
            <ErrorState retryLabel="Retry contacts" onRetry={retry}>
              {pickerFailure.message} Raising a direct invoice is unavailable until it
              loads — the invoices above are unaffected.
            </ErrorState>
          ) : (
            <FormError>
              {pickerFailure.message} Raising a direct invoice is unavailable — the
              invoices above are unaffected.
            </FormError>
          ))}

        {draftBlockedByMissingClient && (
          <div>
            <Button disabled aria-disabled="true">
              Raise an invoice for a private customer
            </Button>
            <p className="text-muted-foreground">
              A direct invoice needs a client contact to name as the buyer, and this
              organisation has none yet.{' '}
              <a href={mastersHash('contacts')}>Add one under Masters → Contacts</a>,
              then return here.
            </p>
          </div>
        )}

        {canDraftDirect && (
          <DirectInvoiceForm
            api={api}
            organisationId={organisationId}
            clients={clients}
            shipToContacts={shipToContacts}
            gstRates={gstRates}
            defaultInvoiceShape={defaultInvoiceShape}
            startOpen={false}
            pending={pending}
            act={act}
            onCreated={async (created) => {
              await refreshList();
              onOpenInvoice(created.invoice.id);
            }}
          />
        )}

        {detailError !== null && (
          <ErrorState onRetry={retry} retryLabel="Retry this invoice">
            {detailError}
          </ErrorState>
        )}

        {detail !== null && (
          <OpenedInvoice
            api={api}
            organisationId={organisationId}
            detail={detail}
            ewayBills={ewayBills}
            creditNotes={creditNotes}
            clients={clients}
            shipToContacts={shipToContacts}
            gstRates={gstRates}
            canModify={canModify}
            canIssue={canIssue}
            canCancel={canCancel}
            canManageStatutory={canManageStatutory}
            pending={pending}
            act={act}
            refresh={async () => {
              await refreshList();
              if (openInvoiceId !== null) await loadDetail(openInvoiceId);
            }}
            onDeleted={async () => {
              await refreshList();
              onOpenInvoice(null);
            }}
            onEwayBillsChanged={setEwayBills}
          />
        )}
      </section>
    </>
  );
}

/** The statutory state, kept visibly separate from the local one: a
 * locally issued invoice is never represented as IRP-registered without
 * provider evidence, and the frozen reporting window (migration 0049) is
 * a signal about lawful reporting, never about local validity. */
function IrpCell({ row }: { readonly row: TaxInvoiceRegisterEntry }) {
  if (row.irn !== null) {
    return (
      <StatusChip
        status={row.irpProvider === 'whitebooks' ? 'issued' : 'registered_unverified'}
      >
        {row.irpProvider === 'whitebooks' ? 'Registered' : 'Manual — unverified'}
      </StatusChip>
    );
  }
  if (row.status !== 'submitted') return <>—</>;
  if (row.irpReportingOverdue) {
    return <StatusChip status="expired">Overdue</StatusChip>;
  }
  if (row.irpReportingDeadline !== null) {
    return (
      <StatusChip status="review">
        Due {formatDate(row.irpReportingDeadline)}
      </StatusChip>
    );
  }
  return <>—</>;
}
