import { useEffect, useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import type { MisSummaryResponse, WorksAnalysisReport } from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import { formatCompactInr, formatInr, todayIso } from '../format.js';
import { downloadFile } from '../lib/download.js';
import { describeRefusal } from '../lib/load-failure.js';
import { navigateOnClick, type MisTab } from '../lib/workspace-routes.js';
import { useAction, useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { DateField } from '../ui/date-field.js';
import { FormError, FormNotice } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { Stat } from '../ui/stat.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell } from '../ui/table.js';
import { WorksAnalysis } from './WorksAnalysis.js';

/**
 * Reports: four registers behind one address.
 *
 * This screen was one enormous scroll — the month-end tiles, three
 * month-by-month registers, the Tally export and three full portfolio
 * analyses, every one of them loaded on every visit. Four things were
 * wrong with that and only one of them was the length: an operator who
 * came for the receivables ageing paid for the whole schedule of every
 * active Work, an operator who came for one Work's position had to scroll
 * past the organisation's tax position to find it, and neither could link
 * anybody to what they were looking at.
 *
 * So it is TABBED, and the tab is an address (`lib/workspace-routes.ts`):
 *
 *   * **Work analysis** — the selector-driven single report. Reads
 *     nothing until Run; see `views/WorksAnalysis.tsx`.
 *   * **Accounts** — output tax by month and receivables ageing, with the
 *     month-end tiles above them.
 *   * **Payroll** — payroll cost by month.
 *   * **Tally** — the ways into the two Tally surfaces that already
 *     exist, and the export.
 *
 * The management summary read (`/api/mis/summary`) serves Accounts and
 * Payroll and is made only on those two tabs. That is the whole point of
 * the split: `packages/contracts/src/mis.ts` argues these are month-end
 * roll-ups, and a month-end roll-up should not be the price of opening a
 * report about one Work.
 *
 * NOTHING ON THIS SCREEN ADDS ANYTHING UP. Every figure is a decimal
 * string summed by PostgreSQL and printed through `formatInr`; the tiles
 * read the server's own totals rather than folding the rows beneath them,
 * which is the rule `views/Receivables.tsx` records for the same reason.
 *
 * The payroll section is ABSENT rather than empty for a member without the
 * payroll authority: the server answers `payrollCost: null`, and the tab
 * says which authority would fill it instead of drawing a table of zeroes
 * that would read as "nobody is paid anything". The Accounts tab carries
 * the summary's own refusal for an assigned-scope member, unchanged — the
 * works-analysis reports beside it NARROW instead, which is the
 * distinction `docs/UX.md` § 38 argues.
 */

interface MisProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Owner-only, and so is the Tally export it gates. */
  readonly isOwner: boolean;
  readonly tab: MisTab;
  /** The works-analysis report that has been run, from the address. */
  readonly report: WorksAnalysisReport | null;
  readonly selection: string | null;
  readonly onOpenTab: (tab: MisTab) => void;
  readonly onRunReport: (report: WorksAnalysisReport, selection: string | null) => void;
  /** Where the Tally tab's two doors lead. Real hrefs, so a middle click
   * opens them in a tab exactly as the address promises. */
  readonly onOpenTallyCensus: () => void;
  readonly onOpenHistoricalInvoices: () => void;
}

const AGEING_LABELS: Record<string, string> = {
  unsubmitted: 'Not yet submitted',
  '0-30': '0–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
  '90+': 'Over 90 days',
};

const TABS: readonly (readonly [MisTab, string])[] = [
  ['analysis', 'Work analysis'],
  ['accounts', 'Accounts'],
  ['payroll', 'Payroll'],
  ['tally', 'Tally'],
];

/** The month key as a reader's month. Built from the string rather than
 * through a `Date`, because `'2026-05'` parsed as a date is midnight UTC
 * and prints as April for anyone west of Greenwich. */
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function monthLabel(month: string): string {
  const [year, index] = month.split('-');
  const name = MONTH_NAMES[Number(index) - 1];
  return name === undefined ? month : `${name} ${String(year)}`;
}

/**
 * The first day of the Indian financial year that `today` falls in.
 *
 * April to March, so January, February and March belong to the year that
 * STARTED the previous April. The naive `${currentYear}-04-01` produced a
 * window whose start was after its end for the whole of the fourth quarter,
 * and the Tally form then refused itself on first submit with a 400 nobody
 * had touched anything to cause.
 *
 * String arithmetic on a date-only value, per `AGENTS.md` rule 6: nothing
 * here round-trips through a timezone.
 */
export function financialYearStart(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return `${String(month < 4 ? year - 1 : year)}-04-01`;
}

export function Mis({
  api,
  organisationId,
  isOwner,
  tab,
  report,
  selection,
  onOpenTab,
  onRunReport,
  onOpenTallyCensus,
  onOpenHistoricalInvoices,
}: MisProps) {
  const [summary, setSummary] = useState<MisSummaryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [loadVersion, retry] = useReload();

  /* The month-end read is made on the two tabs that show it and nowhere
     else. Before this it ran on every arrival at Reports, including the
     arrivals that only wanted a Work's pending position. */
  const needsSummary = tab === 'accounts' || tab === 'payroll';

  useEffect(() => {
    if (!needsSummary) return;
    let cancelled = false;
    setSummary(null);
    setLoadError(null);
    api
      .misSummary(organisationId)
      .then((loaded) => {
        if (!cancelled) setSummary(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const failure = describeRefusal(cause, 'The management summary');
        setLoadError(failure.message);
        setRetryable(failure.retryable);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion, needsSummary]);

  /* The summary's states, rendered by both tabs that read it. A refusal is
     a wall rather than an outage — an assigned-scope member is told which
     authority opens it — so it prints as a persistent alert with no retry,
     exactly as it did on the stacked screen. */
  const summaryState =
    loadError !== null ? (
      retryable ? (
        <ErrorState onRetry={retry} retryLabel="Retry the summary">
          {loadError}
        </ErrorState>
      ) : (
        <p role="alert" className="m-0 text-sm font-medium text-destructive">
          {loadError}
        </p>
      )
    ) : summary === null ? (
      <LoadingState label="the management summary" rows={6} columns={4} />
    ) : null;

  return (
    <section aria-labelledby="mis-title" className="flex flex-col gap-5">
      <PageHeader
        className="mb-0"
        eyebrow="Administration"
        title="Reports"
        titleId="mis-title"
        description="One report at a time: a Work’s position, the month-end registers, and the Tally handover."
      />

      {/* The Work page's own section rail (`views/WorkDetail.tsx`): a 44px
          underline tab on a horizontally scrollable rule, weight rather
          than colour carrying the active state. Sticky under the shell
          header, and it raises `--sticky-inset` for the panel below so a
          table's pinned heading stacks under the tabs instead of behind
          them — the reservation `ui/schedule-section.tsx` established. */}
      <nav
        className="sticky top-[var(--header-h)] z-2 -mt-1 flex max-w-full items-center gap-1 overflow-x-auto border-b border-border bg-background"
        aria-label="Report sections"
      >
        {TABS.map(([key, label]) => {
          const current = tab === key;
          return (
            <a
              key={key}
              href={`#/reports${key === 'analysis' ? '' : `/${key}`}`}
              className={cn(
                '-mb-px inline-flex h-11 shrink-0 items-center border-b-2 border-transparent px-3',
                'text-sm whitespace-nowrap no-underline transition-colors',
                current
                  ? 'border-primary font-medium text-foreground'
                  : 'font-normal text-muted-foreground hover:text-foreground',
              )}
              aria-current={current ? 'page' : undefined}
              onClick={navigateOnClick(() => {
                onOpenTab(key);
              })}
            >
              {label}
            </a>
          );
        })}
      </nav>

      <div
        className="flex flex-col gap-5"
        style={
          {
            '--sticky-inset': 'calc(var(--header-h) + var(--reports-tabs-h))',
          } as React.CSSProperties
        }
      >
        {tab === 'analysis' && (
          <WorksAnalysis
            api={api}
            organisationId={organisationId}
            runReport={report}
            runSelection={selection}
            onRun={onRunReport}
          />
        )}

        {tab === 'accounts' && <AccountsTab summary={summary} state={summaryState} />}

        {tab === 'payroll' && <PayrollTab summary={summary} state={summaryState} />}

        {tab === 'tally' && (
          <TallyTab
            api={api}
            organisationId={organisationId}
            isOwner={isOwner}
            onOpenCensus={onOpenTallyCensus}
            onOpenHistoricalInvoices={onOpenHistoricalInvoices}
          />
        )}
      </div>
    </section>
  );
}

function AccountsTab({
  summary,
  state,
}: {
  readonly summary: MisSummaryResponse | null;
  readonly state: React.ReactNode;
}) {
  if (summary === null) return <>{state}</>;

  const latest = summary.outputTax[0];
  const overdue = summary.receivablesAgeing.find((bucket) => bucket.bucket === '90+');
  const outstanding = summary.receivablesAgeing.reduce(
    (count, bucket) => count + bucket.billCount,
    0,
  );

  return (
    <>
      {/* The hairline tile grid the mock's dashboard uses. Every figure
          here is one the server sent; nothing is summed on this side. */}
      <section
        aria-label="Latest month"
        className="data-surface grid grid-cols-2 gap-px bg-border lg:grid-cols-4"
      >
        <div className="bg-card p-4 sm:p-5">
          <Stat
            label="Invoiced (latest month)"
            value={latest === undefined ? '—' : formatCompactInr(latest.total)}
            hint={
              latest === undefined
                ? 'No invoice has been submitted yet'
                : `${monthLabel(latest.month)} · ${String(latest.invoiceCount)} invoices`
            }
          />
        </div>
        <div className="bg-card p-4 sm:p-5">
          {/* `gstTotal` is CGST + SGST + IGST summed by PostgreSQL. This
              tile used to print the invoice TOTAL as "GST" whenever the
              month held an intra-state invoice, which overstated the tax
              by the taxable value — and the alternative the screen is
              forbidden is adding the three arms up here. A month can hold
              both kinds of invoice, so no single arm is "the GST" either. */}
          <Stat
            label="Taxable value"
            value={latest === undefined ? '—' : formatCompactInr(latest.taxableValue)}
            hint={
              latest === undefined
                ? 'Nothing declared'
                : `GST ${formatCompactInr(latest.gstTotal)} on the face of the invoices`
            }
          />
        </div>
        <div className="bg-card p-4 sm:p-5">
          <Stat
            label="Outstanding over 90 days"
            value={overdue === undefined ? '—' : formatCompactInr(overdue.outstanding)}
            hint={`${String(overdue?.billCount ?? 0)} of ${String(outstanding)} open bills`}
            tone={
              overdue !== undefined && overdue.billCount > 0 ? 'warning' : 'default'
            }
          />
        </div>
        <div className="bg-card p-4 sm:p-5">
          <Stat
            label="Awaiting a railway figure"
            value={String(summary.indeterminateBills)}
            hint="Measurement not yet closed, so nothing is outstanding yet"
          />
        </div>
      </section>

      <Card className="flex flex-col gap-4">
        <CardHeader>
          <div className="flex flex-col gap-1">
            <h2 className="text-base leading-snug font-medium">Output tax by month</h2>
            <p className="text-sm text-muted-foreground">
              Invoices that declared a liability — submitted and superseded — and the
              credit notes that reverse them, on the frozen figures each document was
              raised with. Credit notes are shown as their own column rather than
              netted, because “invoiced this, credited that” is the pair an accountant
              checks. A month with neither is not listed.
            </p>
          </div>
        </CardHeader>
        {summary.outputTax.length === 0 ? (
          <EmptyState>
            No tax invoice has been submitted yet. Invoices are raised on a Work, from a
            finalized Measurement Book.
          </EmptyState>
        ) : (
          <DataTable>
            <caption className="sr-only">
              Output tax by month with invoice count, taxable value, CGST, SGST, IGST,
              invoice total and credit notes
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col" className={numericCell}>
                  Invoices
                </th>
                <th scope="col" className={numericCell}>
                  Taxable value
                </th>
                <th scope="col" className={numericCell}>
                  CGST
                </th>
                <th scope="col" className={numericCell}>
                  SGST
                </th>
                <th scope="col" className={numericCell}>
                  IGST
                </th>
                <th scope="col" className={numericCell}>
                  Invoiced
                </th>
                <th scope="col" className={numericCell}>
                  Credited
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.outputTax.map((month) => (
                <tr key={month.month}>
                  <th scope="row">{monthLabel(month.month)}</th>
                  <td className={numericCell}>{month.invoiceCount}</td>
                  <td className={numericCell}>{formatInr(month.taxableValue)}</td>
                  <td className={numericCell}>{formatInr(month.cgst)}</td>
                  <td className={numericCell}>{formatInr(month.sgst)}</td>
                  <td className={numericCell}>{formatInr(month.igst)}</td>
                  <td className={numericCell}>{formatInr(month.total)}</td>
                  <td className={numericCell}>
                    {month.creditNoteCount === 0 ? '—' : formatInr(month.creditTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <CardHeader>
          <div className="flex flex-col gap-1">
            <h2 className="text-base leading-snug font-medium">Receivables ageing</h2>
            <p className="text-sm text-muted-foreground">
              Days since the bill was submitted to the railway. A bill whose Measurement
              Book is not closed has no certified figure yet, so it is counted apart
              rather than shown as nil.
            </p>
          </div>
        </CardHeader>
        <DataTable scroll={false}>
          <caption className="sr-only">
            Outstanding receivables by age, with the number of bills in each band
          </caption>
          <thead>
            <tr>
              <th scope="col">Age</th>
              <th scope="col" className={numericCell}>
                Bills
              </th>
              <th scope="col" className={numericCell}>
                Outstanding
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.receivablesAgeing.map((bucket) => (
              <tr key={bucket.bucket}>
                <th scope="row">{AGEING_LABELS[bucket.bucket] ?? bucket.bucket}</th>
                <td className={numericCell}>{bucket.billCount}</td>
                <td className={numericCell}>{formatInr(bucket.outstanding)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Card>
    </>
  );
}

function PayrollTab({
  summary,
  state,
}: {
  readonly summary: MisSummaryResponse | null;
  readonly state: React.ReactNode;
}) {
  if (summary === null) return <>{state}</>;
  return (
    <Card className="flex flex-col gap-4">
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="text-base leading-snug font-medium">Payroll cost</h2>
          <p className="text-sm text-muted-foreground">
            Finalized runs only, by the month they pay for.
          </p>
        </div>
      </CardHeader>
      {summary.payrollCost === null ? (
        <p className="m-0 text-sm text-muted-foreground">
          Your membership does not carry the payroll authority, which is what this
          section reads. The rest of this page is unaffected; an owner grants the
          authority on the Members screen.
        </p>
      ) : summary.payrollCost.length === 0 ? (
        <EmptyState>
          No payroll run has been finalized yet. A run is prepared and finalized from
          the Employees register.
        </EmptyState>
      ) : (
        <DataTable>
          <caption className="sr-only">
            Payroll cost by month with runs, headcount, gross pay, deductions and net
            pay
          </caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col" className={numericCell}>
                Runs
              </th>
              <th scope="col" className={numericCell}>
                Employees
              </th>
              <th scope="col" className={numericCell}>
                Gross
              </th>
              <th scope="col" className={numericCell}>
                Deductions
              </th>
              <th scope="col" className={numericCell}>
                Net paid
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.payrollCost.map((month) => (
              <tr key={month.month}>
                <th scope="row">{monthLabel(month.month)}</th>
                <td className={numericCell}>{month.runCount}</td>
                <td className={numericCell}>{month.headcount}</td>
                <td className={numericCell}>{formatInr(month.grossPay)}</td>
                <td className={numericCell}>{formatInr(month.deductions)}</td>
                <td className={numericCell}>{formatInr(month.netPay)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Card>
  );
}

/**
 * The Tally tab: the doors, not a rebuild.
 *
 * Two Tally surfaces already exist and each is where its own work
 * belongs — the ledger census is a register of somebody else's masters
 * (`views/TallyMasters.tsx`, § 37) and the voucher import sits on the
 * billing history it reconciles (`views/HistoricalInvoices.tsx`, § 39).
 * Neither is moved or embedded: they are LINKED, because the alternative
 * is two screens in two places disagreeing about the same rows.
 */
function TallyTab({
  api,
  organisationId,
  isOwner,
  onOpenCensus,
  onOpenHistoricalInvoices,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly isOwner: boolean;
  readonly onOpenCensus: () => void;
  readonly onOpenHistoricalInvoices: () => void;
}) {
  const { pending, notice, actionError, act } = useAction();
  return (
    <>
      <Card className="flex flex-col gap-4">
        <CardHeader>
          <div className="flex flex-col gap-1">
            <h2 className="text-base leading-snug font-medium">Tally surfaces</h2>
            <p className="text-sm text-muted-foreground">
              What this application and TallyPrime each hold, and the two places they
              meet. Both open in their own screens — nothing here is a second copy of
              them.
            </p>
          </div>
        </CardHeader>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          <li className="flex flex-col gap-1">
            <a
              href="#/tally-masters"
              className="inline-flex w-fit items-center gap-1.5 text-sm font-medium"
              onClick={navigateOnClick(onOpenCensus)}
            >
              Tally ledger census
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
            <span className="text-sm text-muted-foreground">
              This organisation’s chart of accounts as TallyPrime holds it, imported
              from the company’s own masters.
            </span>
          </li>
          <li className="flex flex-col gap-1">
            <a
              href="#/historical-invoices"
              className="inline-flex w-fit items-center gap-1.5 text-sm font-medium"
              onClick={navigateOnClick(onOpenHistoricalInvoices)}
            >
              Tally voucher import
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
            <span className="text-sm text-muted-foreground">
              Sales vouchers imported from TallyPrime, on the billing-history register
              they reconcile against.
            </span>
          </li>
        </ul>
        <p className="m-0 text-sm text-muted-foreground">
          The accountant’s export pack lands on this tab when that wave ships.
        </p>
      </Card>

      {isOwner && (
        <Card className="flex flex-col gap-4">
          <CardHeader>
            <div className="flex flex-col gap-1">
              <h2 className="text-base leading-snug font-medium">Tally export</h2>
              <p className="text-sm text-muted-foreground">
                Sales, credit note and receipt vouchers for one period, in Tally’s own
                import envelope. Every figure is the frozen one on the document, never
                recomputed. Import it into the company your accountant already keeps.
              </p>
              <p className="text-sm text-muted-foreground">
                One way only. Nothing comes back: edits made in Tally are not read here,
                and re-exporting a period already imported offers the same vouchers
                again. Export at most one financial year at a time.
              </p>
            </div>
          </CardHeader>
          {notice !== null && <FormNotice>{notice}</FormNotice>}
          {actionError !== null && <FormError>{actionError}</FormError>}
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const from = formValue(data, 'tally-from');
              const to = formValue(data, 'tally-to');
              void act(
                () =>
                  downloadFile(
                    () => api.downloadTallyExport(organisationId, { from, to }),
                    `tally-${from}-to-${to}.xml`,
                  ),
                'The Tally file was downloaded.',
              );
            }}
          >
            <DateField
              id="tally-from"
              name="tally-from"
              label="From"
              required
              defaultValue={financialYearStart(todayIso())}
              fieldClassName="my-0"
            />
            <DateField
              id="tally-to"
              name="tally-to"
              label="To"
              required
              defaultValue={todayIso()}
              fieldClassName="my-0"
            />
            <Button type="submit" variant="outline" disabled={pending}>
              <Download aria-hidden="true" className="size-4" />
              Export Tally XML
            </Button>
          </form>
        </Card>
      )}
    </>
  );
}
