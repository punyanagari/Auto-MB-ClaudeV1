import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type {
  ImportedInvoice,
  ImportedInvoiceImportResult,
  ImportedInvoiceList,
  TallyInvoiceImportResult,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatDate, formatInr } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Field, FormError, FormNotice } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { WorkLink } from '../ui/work-link.js';

/**
 * The historical invoice register — every invoice this organisation
 * raised in Zoho Books before this application existed (migration 0115).
 *
 * READ-ONLY HISTORY, and the screen says so rather than implying it. There
 * is no "new invoice" control here and there never will be: an invoice
 * raised from now on is a `tax_invoices` row with a Measurement Book
 * behind it, and the Invoices register next door is where that happens.
 * What this screen answers is the question the office actually asks about
 * the years before the cutover — what have we billed this customer, and
 * what has been billed on this Work.
 *
 * TWO COLUMNS ARE NOT WHAT THEY LOOK LIKE, and both are labelled for it:
 *
 *   * the status is DERIVED from whether the invoice reached the IRP, not
 *     copied from the export's own status column, which reads `Draft` on
 *     most of a filed year;
 *   * there is no balance column at all. The export carries one and it is
 *     stored as evidence, but the receipts against these invoices are in
 *     Tally — a receivable rendered from a system that never saw the
 *     money would be believed.
 *
 * TWO SYSTEMS FEED IT, and the source column says which (0119, owner
 * ruling 23). Zoho Books held the billing from January 2023; TallyPrime
 * held it from 2020 and still holds the accounting books, so the three
 * years before Zoho come from Tally's own sales vouchers. Where BOTH hold
 * an invoice, Zoho is authoritative and the Tally voucher is provenance —
 * so the register carries one row and a cross-reference, never two rows
 * for one document.
 *
 * A DISPUTED ROW IS NOT AN ERROR (ruling 21). It is an invoice the two
 * systems state different values for, with both values imported and
 * neither overwritten, and it is out of the billed total until the owner
 * rules on it — exactly as a voided invoice is. The header says what the
 * total leaves out rather than leaving the arithmetic to be
 * reverse-engineered.
 *
 * THE IMPORT IS A CONVERSATION, not a button. The file is read twice
 * against the same bytes: once to say what it WOULD do — which Work each
 * invoice would be filed against, on what evidence, and which invoices
 * could not be linked at all — and once, after the operator has read
 * that, to write. Uploading the same export again adds what is missing
 * and rewrites nothing, so a re-export is safe rather than frightening.
 *
 * The mock draws no historical-invoices screen; this is built in its
 * existing grammar under AGENTS.md § Design contract 2 and 4, and
 * `docs/UX.md` § 34 records the stance.
 */

/** One request's worth of rows. The whole register is 638 invoices, so it
 * arrives in seven pages and a single financial year usually in one. */
const PAGE_SIZE = 100;

/** How many rows of the preview the confirmation step draws before it
 * stops. An operator confirms a summary and a sample, not 638 lines —
 * and every unlinked invoice is drawn regardless, because those are the
 * ones the decision is actually about. */
const PREVIEW_ROWS = 25;

interface HistoricalInvoicesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The `?work=` deep link. Null reads across every Work in reach. */
  readonly workId: string | null;
  /** Whether this member holds the import authority (migration 0094).
   * Withheld rather than offered-and-refused: the register is readable by
   * every writer, and only the upload is gated. */
  readonly canImport: boolean;
  readonly onOpenWork: (workId: string) => void;
  readonly onClearWorkFilter: () => void;
}

interface RegisterFilter {
  readonly customer: string;
  readonly linked: string;
  readonly financialYear: string;
}

/** No filter, as one stable object so clearing it does not change
 * `fetchPage`'s identity and refire the read. */
const NO_FILTER: RegisterFilter = { customer: '', linked: '', financialYear: '' };

/** What a voucher would become, in the operator's words rather than the
 * wire's. */
const TALLY_OUTCOME_LABEL: Record<string, string> = {
  linked: 'Tied to an invoice',
  imported: 'Joins the register',
  already_read: 'Already read',
  skipped: 'Skipped',
};

/** Zoho's own cancellation, and the one reading of `zohoStatus` this
 * register trusts: a voided invoice billed nobody anything. It stays on
 * the register — it is part of the record — and it is out of the billed
 * total the header reports, which the server computes. */
function voided(invoice: ImportedInvoice): boolean {
  return (invoice.zohoStatus ?? '').trim().toLowerCase() === 'void';
}

/** The Indian financial year a date falls in, named by its opening
 * calendar year: April opens it, so January to March belongs to the year
 * before. */
function financialYearOf(date: string): number | null {
  const [year, month] = date.split('-').map(Number);
  if (year === undefined || month === undefined || Number.isNaN(year)) return null;
  return month >= 4 ? year : year - 1;
}

/**
 * The financial years the filter offers, newest first.
 *
 * FROM THE REGISTER'S OWN SPAN, not from the rows on screen. Deriving them
 * from the loaded page looked equivalent and was not: the register is
 * paginated newest-first, so the first page of 638 invoices is the most
 * recent hundred, and the filter offered only the years those hundred fell
 * in — every earlier year was missing from the control that exists to
 * reach it. The read reports the oldest and newest invoice date over the
 * whole filtered register (one aggregate it was already making), and the
 * range between them is what the dropdown lists.
 */
function financialYears(
  earliest: string | null,
  latest: string | null,
): readonly number[] {
  const from = earliest === null ? null : financialYearOf(earliest);
  const to = latest === null ? null : financialYearOf(latest);
  if (from === null || to === null) return [];
  const years: number[] = [];
  for (let year = to; year >= from; year -= 1) years.push(year);
  return years;
}

export function HistoricalInvoices({
  api,
  organisationId,
  workId,
  canImport,
  onOpenWork,
  onClearWorkFilter,
}: HistoricalInvoicesProps) {
  const [invoices, setInvoices] = useState<readonly ImportedInvoice[] | null>(null);
  /* The register's own summary, which arrives with the FIRST page only:
     a request carrying a cursor is continuing a walk whose totals this
     screen already has on screen and does not redraw. So a later page
     leaves them alone rather than replacing them with null. */
  const [totals, setTotals] = useState<ImportedInvoiceList['totals']>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState<RegisterFilter>(NO_FILTER);
  const [loadVersion, retry] = useReload();

  /* The import conversation: the file the operator chose, what a preview
     of it said, and what committing it did. */
  const fileInput = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportedInvoiceImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  /* The same conversation for the TallyPrime half (0119), in its own
     panel and with its own state. Not one panel with a format toggle: the
     two files are different exports of different systems and the reports
     that come back answer different questions — one proposes Works, the
     other reconciles two registers against each other. */
  const tallyInput = useRef<HTMLInputElement>(null);
  const [tallyChosen, setTallyChosen] = useState<File | null>(null);
  const [tallyPreview, setTallyPreview] = useState<TallyInvoiceImportResult | null>(
    null,
  );
  const [tallyError, setTallyError] = useState<string | null>(null);
  const [tallyNotice, setTallyNotice] = useState<string | null>(null);

  /* The filter belongs to the WHOLE register and the Work-narrowed view
     does not offer it, so a filter left set from the register would be
     invisible state that comes back when the chip is cleared. Dropped as
     the view changes, in render rather than in an effect, so the read
     below never fires twice. */
  const [filterWorkId, setFilterWorkId] = useState(workId);
  if (filterWorkId !== workId) {
    setFilterWorkId(workId);
    setFilter(NO_FILTER);
  }

  const fetchPage = useCallback(
    async (cursor?: string) =>
      api.listImportedInvoices(organisationId, {
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(workId !== null ? { work: workId } : {}),
        ...(filter.customer !== '' ? { customer: filter.customer } : {}),
        ...(filter.linked !== ''
          ? { linked: filter.linked as 'linked' | 'unlinked' }
          : {}),
        ...(filter.financialYear !== ''
          ? { financialYear: Number(filter.financialYear) }
          : {}),
      }),
    [api, organisationId, workId, filter],
  );

  useEffect(() => {
    let cancelled = false;
    setInvoices(null);
    setTotals(null);
    setNextCursor(null);
    setLoadError(null);
    fetchPage()
      .then((page) => {
        if (cancelled) return;
        setInvoices(page.invoices);
        setTotals(page.totals);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          errorMessage(cause, 'The historical invoices could not be loaded.'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, loadVersion]);

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
        errorMessage(
          cause,
          'The next page of historical invoices could not be loaded.',
        ),
      );
    } finally {
      setPending(false);
    }
  }

  async function runImport(mode: 'preview' | 'commit'): Promise<void> {
    if (chosen === null) return;
    setPending(true);
    setImportError(null);
    setImportNotice(null);
    try {
      const result = await api.importZohoInvoices(organisationId, chosen, mode);
      if (mode === 'preview') {
        setPreview(result);
        return;
      }
      setPreview(null);
      setChosen(null);
      if (fileInput.current !== null) fileInput.current.value = '';
      setImportNotice(
        `${String(result.importedCount)} invoice(s) brought in from ${result.filename}; ${String(result.alreadyImportedCount)} were already on the register.`,
      );
      retry();
    } catch (cause) {
      setImportError(errorMessage(cause, 'The export could not be read.'));
    } finally {
      setPending(false);
    }
  }

  async function runTallyImport(mode: 'preview' | 'commit'): Promise<void> {
    if (tallyChosen === null) return;
    setPending(true);
    setTallyError(null);
    setTallyNotice(null);
    try {
      const result = await api.importTallyInvoices(organisationId, tallyChosen, mode);
      if (mode === 'preview') {
        setTallyPreview(result);
        return;
      }
      setTallyPreview(null);
      setTallyChosen(null);
      if (tallyInput.current !== null) tallyInput.current.value = '';
      setTallyNotice(
        `${String(result.importedLinkCount)} voucher(s) tied to the register from ${result.filename}, of which ${String(result.importedInvoiceCount)} brought in an invoice Zoho never held.`,
      );
      retry();
    } catch (cause) {
      setTallyError(errorMessage(cause, 'The voucher export could not be read.'));
    } finally {
      setPending(false);
    }
  }

  const narrowed = workId !== null;
  const filtered =
    filter.customer !== '' || filter.linked !== '' || filter.financialYear !== '';
  const years = financialYears(
    totals?.earliestDate ?? null,
    totals?.latestDate ?? null,
  );
  /* Every unlinked invoice, then enough linked ones to see the shape of
     the proposal. The unlinked half is what the operator is deciding
     about, so it is never the half that gets truncated. */
  const previewRows =
    preview === null
      ? []
      : [
          ...preview.invoices.filter((row) => row.workId === null),
          ...preview.invoices.filter((row) => row.workId !== null),
        ].slice(0, PREVIEW_ROWS);
  /* Disputed first, then the ones that would join the register, then
     everything else — the same rule the Zoho preview follows: the half
     the operator is deciding about is never the half that gets
     truncated. */
  const tallyVoucherRows =
    tallyPreview === null
      ? []
      : [
          ...tallyPreview.vouchers.filter((row) => row.disputed),
          ...tallyPreview.vouchers.filter(
            (row) => !row.disputed && row.outcome === 'imported',
          ),
          ...tallyPreview.vouchers.filter(
            (row) => !row.disputed && row.outcome !== 'imported',
          ),
        ].slice(0, PREVIEW_ROWS);

  return (
    <>
      <PageHeader
        eyebrow="Documents"
        titleId="historical-invoices-title"
        title="Historical invoices"
        description="Invoices raised in Zoho Books and TallyPrime before this system. Read-only: they are a record of what was billed, and nothing measures, bills or settles against them."
      />

      <section
        aria-labelledby="historical-invoices-title"
        className="flex flex-col gap-4"
      >
        {narrowed && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Filtered to one Work</span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClearWorkFilter}
              aria-label="Clear the Work filter and read the whole register"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        )}

        {totals !== null && (
          <p className="text-[13px] text-muted-foreground">
            <span className="font-mono tabular-nums">
              {String(totals.invoiceCount)}
            </span>{' '}
            invoice(s),{' '}
            <span className="font-mono tabular-nums">{String(totals.linkedCount)}</span>{' '}
            filed against a Work, billing{' '}
            <span className="font-mono tabular-nums">
              {formatInr(totals.totalValue)}
            </span>
            .{' '}
            <span className="font-mono tabular-nums">
              {String(totals.tallySourcedCount)}
            </span>{' '}
            came from TallyPrime rather than Zoho. Invoices Zoho voided
            {totals.disputedUnresolvedCount > 0 ? (
              <>
                , and the{' '}
                <span className="font-mono tabular-nums">
                  {String(totals.disputedUnresolvedCount)}
                </span>{' '}
                whose TallyPrime and Zoho figures disagree and have not been ruled on,
              </>
            ) : null}{' '}
            are on the register and out of that total.
          </p>
        )}

        {canImport && (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold">Bring in a Zoho Books export</h2>
            <p className="text-[13px] text-muted-foreground">
              Export the invoice register from Zoho Books as CSV and choose it here.
              Nothing is written until you have read what it would do. Uploading the
              same file twice adds what is missing and changes nothing else.
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <Field className="my-0">
                <label htmlFor="zoho-export">Zoho Books export (.csv)</label>
                <input
                  ref={fileInput}
                  id="zoho-export"
                  name="zoho-export"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    setChosen(event.currentTarget.files?.[0] ?? null);
                    setPreview(null);
                    setImportError(null);
                    setImportNotice(null);
                  }}
                />
              </Field>
              <Button
                variant="outline"
                disabled={chosen === null || pending}
                onClick={() => void runImport('preview')}
              >
                Read the file
              </Button>
            </div>

            {importError !== null && <FormError>{importError}</FormError>}
            {importNotice !== null && <FormNotice>{importNotice}</FormNotice>}

            {preview !== null && (
              <div className="flex flex-col gap-3">
                <p className="text-[13px]">
                  <span className="font-mono tabular-nums">
                    {String(preview.invoiceCount)}
                  </span>{' '}
                  invoice(s) over{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.lineCount)}
                  </span>{' '}
                  line(s).{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.alreadyImportedCount)}
                  </span>{' '}
                  already on the register,{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.proposedLinkCount)}
                  </span>{' '}
                  would be filed against a Work, and{' '}
                  <span className="font-mono tabular-nums">
                    {String(preview.unlinkedCount)}
                  </span>{' '}
                  would not.
                </p>
                {preview.unmatchedCustomers.length > 0 && (
                  <p className="text-[13px] text-muted-foreground">
                    No customer in the contacts master matches:{' '}
                    {preview.unmatchedCustomers.join(', ')}. They are imported with the
                    name the invoice carried; add them to the master and file them
                    afterwards.
                  </p>
                )}
                <DataTable>
                  <caption className="sr-only">
                    What the export would do: each invoice with its number, date,
                    customer, value, the Work it would be filed against and the evidence
                    for it
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Invoice</th>
                      <th scope="col">Date</th>
                      <th scope="col">Customer</th>
                      <th scope="col" className={numericCell}>
                        Value
                      </th>
                      <th scope="col">Work</th>
                      <th scope="col">Because</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row) => (
                      <tr key={row.zohoInvoiceId}>
                        <th scope="row" className="font-mono">
                          {row.invoiceNumber}
                        </th>
                        <td>{formatDate(row.invoiceDate)}</td>
                        <td className={wrapCell}>{row.customerName}</td>
                        <td className={numericCell}>{formatInr(row.total)}</td>
                        <td className="font-mono">{row.workCode ?? '—'}</td>
                        <td className={wrapCell}>
                          {row.alreadyImported
                            ? 'Already imported'
                            : (row.linkEvidence ?? 'No Work could be identified')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
                {preview.invoices.length > previewRows.length && (
                  <p className="text-[13px] text-muted-foreground">
                    Showing {String(previewRows.length)} of{' '}
                    {String(preview.invoices.length)}; every invoice with no Work is
                    listed first.
                  </p>
                )}
                <div>
                  <Button
                    disabled={pending}
                    onClick={() => {
                      void runImport('commit');
                    }}
                  >
                    Import these invoices
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {canImport && (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold">
              Bring in a TallyPrime sales voucher export
            </h2>
            {/* THE NARROWING IS THE INSTRUCTION, not a nicety. The whole
                voucher file is 3.18 GB and no upload here will take it;
                narrowed to the three sales-side types it is 61 MB. Saying
                so here is what stops an operator waiting ten minutes for
                a refusal. */}
            <p className="text-[13px] text-muted-foreground">
              In TallyPrime, open the Day Book, narrow it to Sales, Credit Note and
              Debit Note over the whole period, and export it as XML. Do not export
              every voucher: the unfiltered file is several gigabytes and cannot be
              uploaded. Nothing is written until you have read what it would do, and
              uploading the same file twice adds what is missing and changes nothing
              else.
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <Field className="my-0">
                <label htmlFor="tally-vouchers">TallyPrime vouchers (.xml)</label>
                <input
                  ref={tallyInput}
                  id="tally-vouchers"
                  name="tally-vouchers"
                  type="file"
                  accept=".xml,application/xml,text/xml"
                  onChange={(event) => {
                    setTallyChosen(event.currentTarget.files?.[0] ?? null);
                    setTallyPreview(null);
                    setTallyError(null);
                    setTallyNotice(null);
                  }}
                />
              </Field>
              <Button
                variant="outline"
                disabled={tallyChosen === null || pending}
                onClick={() => void runTallyImport('preview')}
              >
                Read the file
              </Button>
            </div>

            {tallyError !== null && <FormError>{tallyError}</FormError>}
            {tallyNotice !== null && <FormNotice>{tallyNotice}</FormNotice>}

            {tallyPreview !== null && (
              <div className="flex flex-col gap-3">
                <p className="text-[13px]">
                  <span className="font-mono tabular-nums">
                    {String(tallyPreview.voucherCount)}
                  </span>{' '}
                  voucher(s) in the file, of which{' '}
                  <span className="font-mono tabular-nums">
                    {String(tallyPreview.salesCount)}
                  </span>{' '}
                  are sales.{' '}
                  <span className="font-mono tabular-nums">
                    {String(
                      tallyPreview.exactMatchCount + tallyPreview.serialMatchCount,
                    )}
                  </span>{' '}
                  correspond to an invoice already on the register (
                  <span className="font-mono tabular-nums">
                    {String(tallyPreview.serialMatchCount)}
                  </span>{' '}
                  of them by serial rather than by an exact number), and{' '}
                  <span className="font-mono tabular-nums">
                    {String(tallyPreview.unmatchedCount)}
                  </span>{' '}
                  would join the register as billing Zoho never held.
                </p>
                {tallyPreview.previouslyLinkedCount > 0 && (
                  <p className="text-[13px] text-muted-foreground">
                    {/* Reported rather than passed over: these mint nothing,
                        and the usual cause is a reference edited in
                        TallyPrime — which an operator can only act on if
                        the screen says it happened. */}
                    <span className="font-mono tabular-nums">
                      {String(tallyPreview.previouslyLinkedCount)}
                    </span>{' '}
                    voucher(s) matched an invoice in an earlier import and match none
                    now. Their existing links stand and no new rows are created; check
                    whether their numbers changed in TallyPrime.
                  </p>
                )}
                {/* Stated even at zero, every one of them. A count of
                    what could not be used is worth more than a count of
                    what could, and silence reads as absence of the
                    problem rather than absence of the check. */}
                <p className="text-[13px] text-muted-foreground">
                  <span className="font-mono tabular-nums">
                    {String(tallyPreview.cancelledCount)}
                  </span>{' '}
                  cancelled and{' '}
                  <span className="font-mono tabular-nums">
                    {String(tallyPreview.optionalCount)}
                  </span>{' '}
                  optional voucher(s) are skipped
                  {tallyPreview.skippedVoucherNumbers.length > 0
                    ? `: ${tallyPreview.skippedVoucherNumbers.slice(0, 20).join(', ')}`
                    : ''}
                  .{' '}
                  <span className="font-mono tabular-nums">
                    {String(tallyPreview.creditNoteCount + tallyPreview.debitNoteCount)}
                  </span>{' '}
                  credit and debit note(s) were read and are not imported — they reverse
                  an invoice rather than raising one.{' '}
                  <span className="font-mono tabular-nums">
                    {String(tallyPreview.serialCollisionCount)}
                  </span>{' '}
                  near-match(es) shared a serial with an unrelated invoice and were
                  refused.{' '}
                  <span className="font-mono tabular-nums">
                    {String(tallyPreview.invoicesWithNoVoucherCount)}
                  </span>{' '}
                  invoice(s) on the register have no voucher in this file.
                </p>
                {tallyPreview.disputedComponentCount > 0 && (
                  <p className="text-[13px]">
                    <span className="font-mono tabular-nums">
                      {String(tallyPreview.disputedComponentCount)}
                    </span>{' '}
                    group(s) of documents carry different totals in the two systems,
                    across{' '}
                    <span className="font-mono tabular-nums">
                      {String(tallyPreview.disputedLinkCount)}
                    </span>{' '}
                    correspondence(s). Both figures are imported and flagged; a disputed
                    figure joins no total until it is ruled on.
                  </p>
                )}
                <DataTable>
                  <caption className="sr-only">
                    What the voucher export would do: each voucher with its number,
                    date, party, value, what would become of it and the evidence
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Voucher</th>
                      <th scope="col">Date</th>
                      <th scope="col">Party</th>
                      <th scope="col" className={numericCell}>
                        Value
                      </th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Because</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tallyVoucherRows.map((row) => (
                      <tr key={row.tallyGuid}>
                        <th scope="row" className="font-mono">
                          {row.voucherNumber ?? row.reference ?? '—'}
                        </th>
                        <td>{formatDate(row.voucherDate)}</td>
                        <td className={wrapCell}>{row.partyLedger}</td>
                        <td className={numericCell}>{formatInr(row.amount)}</td>
                        <td>{TALLY_OUTCOME_LABEL[row.outcome]}</td>
                        <td className={wrapCell}>
                          {row.skipReason ??
                            (row.disputed
                              ? `Value disagrees: TallyPrime ${formatInr(row.componentTallyTotal ?? row.amount)} against Zoho ${formatInr(row.componentInvoiceTotal ?? row.amount)}`
                              : row.matchEvidence !== null
                                ? `Matched ${row.invoiceNumber ?? row.matchEvidence}${row.matchMethod === 'serial_tolerant' ? ' on the serial, confirmed on the value or the customer' : ''}`
                                : 'No invoice on the register matches this voucher')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
                {tallyPreview.vouchers.length > tallyVoucherRows.length && (
                  <p className="text-[13px] text-muted-foreground">
                    Showing {String(tallyVoucherRows.length)} of{' '}
                    {String(tallyPreview.vouchers.length)}; every disputed and unmatched
                    voucher is listed first.
                  </p>
                )}
                {tallyPreview.refusals.length > 0 && (
                  <p className="text-[13px] text-muted-foreground">
                    {String(tallyPreview.refusals.length)} voucher(s) could not be read:{' '}
                    {tallyPreview.refusals
                      .slice(0, 5)
                      .map(
                        (refusal) =>
                          `line ${String(refusal.lineNumber)} — ${refusal.reason}`,
                      )
                      .join(' ')}
                  </p>
                )}
                <div>
                  <Button
                    disabled={pending}
                    onClick={() => {
                      void runTallyImport('commit');
                    }}
                  >
                    Import these vouchers
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {!narrowed && (
          <form
            className="flex flex-wrap items-end gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setFilter({
                customer: formValue(data, 'historical-customer'),
                linked: formValue(data, 'historical-linked'),
                financialYear: formValue(data, 'historical-fy'),
              });
            }}
          >
            <Field className="my-0">
              <label htmlFor="historical-customer">Customer</label>
              <input
                id="historical-customer"
                name="historical-customer"
                type="text"
                maxLength={300}
                placeholder="Exactly as the invoice named them"
              />
            </Field>
            <Field className="my-0">
              <label htmlFor="historical-linked">Work</label>
              <select id="historical-linked" name="historical-linked">
                <option value="">Filed or not</option>
                <option value="linked">Filed against a Work</option>
                <option value="unlinked">Not filed against a Work</option>
              </select>
            </Field>
            <Field className="my-0">
              <label htmlFor="historical-fy">Financial year</label>
              <select id="historical-fy" name="historical-fy">
                <option value="">Every year</option>
                {years.map((year) => (
                  <option key={year} value={String(year)}>
                    {String(year)}&ndash;{String((year + 1) % 100).padStart(2, '0')}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="outline">
              Apply filters
            </Button>
          </form>
        )}

        {loadError !== null && (
          <ErrorState onRetry={retry} retryLabel="Retry historical invoices">
            {loadError}
          </ErrorState>
        )}
        {loadError === null && invoices === null && (
          <LoadingState label="the historical invoices" rows={5} columns={6} />
        )}

        {invoices !== null &&
          (invoices.length > 0 ? (
            <>
              <DataTable>
                <caption className="sr-only">
                  Historical invoices with their number, date, customer, value, which
                  system they were read from, the Work they are filed against, how they
                  were filed and whether the invoice reached the e-invoice portal
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Invoice</th>
                    <th scope="col">Date</th>
                    <th scope="col">Customer</th>
                    <th scope="col" className={numericCell}>
                      Value
                    </th>
                    <th scope="col">Source</th>
                    <th scope="col">Work</th>
                    <th scope="col">Filed by</th>
                    <th scope="col">e-Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((row) => (
                    <tr key={row.id}>
                      <th scope="row" className="font-mono">
                        {row.invoiceNumber}
                      </th>
                      <td>{formatDate(row.invoiceDate)}</td>
                      <td className={wrapCell}>{row.customerName}</td>
                      <td className={numericCell}>
                        {formatInr(row.total)}
                        {/* OWNER RULING 21. The lamp sits on the VALUE
                            because that is what is disputed — the row is
                            not in doubt, the figure is — and the header
                            says such a figure is out of the billed
                            total. */}
                        {row.disputed && (
                          <div className="mt-1">
                            {/* `tone` rather than a new word in the shared
                                status map: "disputed" means a value two
                                systems disagree about HERE and would mean
                                something else on a register of disputed
                                claims, which is exactly the case
                                `chip.tsx` reserves the override for.

                                A RULED-ON DISAGREEMENT IS NOT THE SAME
                                STATE as one still waiting, and only the
                                second is work: the lamp goes neutral once
                                somebody has decided, and the row's place
                                in the billed total follows the ruling
                                rather than the flag. */}
                            {row.disputeResolved ? (
                              <StatusChip status="disputed" tone="neutral">
                                Disagreement ruled on
                              </StatusChip>
                            ) : (
                              <StatusChip status="disputed" tone="warning">
                                Value disputed
                              </StatusChip>
                            )}
                          </div>
                        )}
                      </td>
                      <td>
                        {/* WHICH SYSTEM THIS WAS READ FROM (0119). A Tally
                            row is billing Zoho never held; a Zoho row that
                            names vouchers is one both systems hold, where
                            Zoho is authoritative and the voucher is
                            provenance. The voucher number is shown only
                            where exactly one corresponds — naming the
                            first of three would imply it was the only
                            one. */}
                        <StatusChip status={row.source} tone="neutral">
                          {row.source === 'tally' ? 'TallyPrime' : 'Zoho Books'}
                        </StatusChip>
                        {row.tallyVoucherCount > 0 && (
                          <div className="mt-1 font-mono text-xs text-muted-foreground">
                            {/* One voucher that TallyPrime numbered is
                                named; one it did not is still ONE, and
                                "1 vouchers" is the kind of thing that
                                teaches an operator the screen was not
                                read by anybody. */}
                            {row.tallyVoucherNumber ??
                              `${String(row.tallyVoucherCount)} ${
                                row.tallyVoucherCount === 1 ? 'voucher' : 'vouchers'
                              }`}
                          </div>
                        )}
                      </td>
                      <td>
                        {/* A Work that has since been superseded (0071) is
                            named and NOT linked: the invoice stays filed
                            against it — what was billed against that
                            contract is still what was billed — but the
                            workspace no longer lists it, so a link would
                            open a 404. */}
                        {row.workId !== null &&
                        row.workCode !== null &&
                        !row.workWithdrawn ? (
                          <WorkLink
                            workId={row.workId}
                            workCode={row.workCode}
                            workTitle={row.workCode}
                            tab="bills"
                            onOpenWork={onOpenWork}
                          />
                        ) : row.workCode !== null ? (
                          <span className="font-mono text-muted-foreground">
                            {row.workCode} (withdrawn)
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Not filed</span>
                        )}
                      </td>
                      <td>{row.linkMethod ?? '—'}</td>
                      <td>
                        {/* DERIVED from the IRN, not copied from the
                            export's own status column — see the header.
                            With ONE exception, and it is the one reading of
                            that column this register does trust: `Void` is
                            not a workflow flag nobody advanced, it is Zoho
                            saying the document was cancelled. Such an
                            invoice may still carry the IRN it was
                            registered under, so deriving from the IRN alone
                            would draw a cancelled document as issued. */}
                        <StatusChip
                          status={
                            voided(row) ? 'cancelled' : row.issued ? 'issued' : 'draft'
                          }
                        />
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
          ) : narrowed ? (
            <EmptyState
              action={{
                label: 'Read the whole register',
                onClick: onClearWorkFilter,
              }}
            >
              No historical invoice is filed against this Work. An invoice raised before
              this system is filed against a Work from the register, which is where the
              Zoho export is read.
            </EmptyState>
          ) : filtered ? (
            <EmptyState>
              No historical invoice matches these filters. Clear them to read the whole
              register.
            </EmptyState>
          ) : (
            <EmptyState>
              No historical invoice has been imported yet.{' '}
              {canImport
                ? 'Export the invoice register from Zoho Books as CSV and bring it in above.'
                : 'Somebody holding the data-import authority brings the Zoho Books export in.'}
            </EmptyState>
          ))}
      </section>
    </>
  );
}
