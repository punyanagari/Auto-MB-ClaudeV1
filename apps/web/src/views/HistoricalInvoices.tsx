import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ImportedInvoice, ImportedInvoiceImportResult } from '@auto-mb/contracts';
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

/** One request's worth of rows. The whole register is 638 invoices, so a
 * financial year arrives whole and the register is two pages. */
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

/** The financial years the register can be narrowed to, newest first.
 * Derived from the rows on screen rather than hard-coded, so a register
 * that starts in 2023 does not offer 2019. */
function financialYearsOf(invoices: readonly ImportedInvoice[]): number[] {
  const years = new Set<number>();
  for (const invoice of invoices) {
    const [year, month] = invoice.invoiceDate.split('-').map(Number);
    if (year === undefined || month === undefined) continue;
    // April opens the Indian financial year, so January to March belongs
    // to the year before.
    years.add(month >= 4 ? year : year - 1);
  }
  return [...years].sort((a, b) => b - a);
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
  const [totals, setTotals] = useState<{
    readonly invoiceCount: number;
    readonly linkedCount: number;
    readonly totalValue: string;
  } | null>(null);
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

  const narrowed = workId !== null;
  const filtered =
    filter.customer !== '' || filter.linked !== '' || filter.financialYear !== '';
  const years = financialYearsOf(invoices ?? []);
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

  return (
    <>
      <PageHeader
        eyebrow="Documents"
        titleId="historical-invoices-title"
        title="Historical invoices"
        description="Invoices raised in Zoho Books before this system. Read-only: they are a record of what was billed, and nothing measures, bills or settles against them."
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
            .
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
                  Historical invoices with their number, date, customer, value, the Work
                  they are filed against, how they were filed and whether the invoice
                  reached the e-invoice portal
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
                      <td className={numericCell}>{formatInr(row.total)}</td>
                      <td>
                        {row.workId !== null && row.workCode !== null ? (
                          <WorkLink
                            workId={row.workId}
                            workCode={row.workCode}
                            workTitle={row.workCode}
                            tab="bills"
                            onOpenWork={onOpenWork}
                          />
                        ) : (
                          <span className="text-muted-foreground">Not filed</span>
                        )}
                      </td>
                      <td>{row.linkMethod ?? '—'}</td>
                      <td>
                        {/* DERIVED from the IRN, not copied from the
                            export's own status column — see the header. */}
                        <StatusChip status={row.issued ? 'issued' : 'draft'} />
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
