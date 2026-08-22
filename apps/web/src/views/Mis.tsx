import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { MisSummaryResponse } from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatCompactInr, formatInr, todayIso } from '../format.js';
import { downloadFile } from '../lib/download.js';
import { describeRefusal } from '../lib/load-failure.js';
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
 * The management summary (migration 0095).
 *
 * Three registers the landing dashboard does not carry, and deliberately
 * only three — `packages/contracts/src/mis.ts` argues which and why. It is
 * a separate screen rather than a fourth panel on the Dashboard because
 * these are month-end roll-ups over the whole invoice and payroll history,
 * and the Dashboard is the screen every session opens with.
 *
 * NOTHING ON THIS SCREEN ADDS ANYTHING UP. Every figure is a decimal
 * string summed by PostgreSQL and printed through `formatInr`; the tiles
 * read the server's own totals rather than folding the rows beneath them,
 * which is the rule `views/Receivables.tsx` records for the same reason.
 *
 * The payroll section is ABSENT rather than empty for a member without the
 * payroll authority: the server answers `payrollCost: null`, and the
 * screen says which authority would fill it instead of drawing a table of
 * zeroes that would read as "nobody is paid anything".
 */

interface MisProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Owner-only, and so is the Tally export it gates. */
  readonly isOwner: boolean;
}

const AGEING_LABELS: Record<string, string> = {
  unsubmitted: 'Not yet submitted',
  '0-30': '0–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
  '90+': 'Over 90 days',
};

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

export function Mis({ api, organisationId, isOwner }: MisProps) {
  const [summary, setSummary] = useState<MisSummaryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [loadVersion, retry] = useReload();
  const { pending, notice, actionError, act } = useAction();

  useEffect(() => {
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
  }, [api, organisationId, loadVersion]);

  const header = (
    <PageHeader
      className="mb-0"
      eyebrow="Administration"
      title="Reports"
      titleId="mis-title"
      description="Output tax, receivables ageing and payroll cost, month by month, across the whole organisation."
    />
  );

  /* The works-analysis reports are their own reads with their own
     authority, so they render whatever the management summary did.
     Before this, an assigned-scope member — refused the summary outright —
     reached a blank Reports screen, and the report that answers "what is
     still to supply on my Works" is exactly the one they can be served. */
  const analysis = <WorksAnalysis api={api} organisationId={organisationId} />;

  if (loadError !== null) {
    return (
      <section aria-labelledby="mis-title" className="flex flex-col gap-5">
        {header}
        {retryable ? (
          <ErrorState onRetry={retry} retryLabel="Retry the summary">
            {loadError}
          </ErrorState>
        ) : (
          <p role="alert" className="m-0 text-sm font-medium text-destructive">
            {loadError}
          </p>
        )}
        {analysis}
      </section>
    );
  }

  if (summary === null) {
    return (
      <section aria-labelledby="mis-title" className="flex flex-col gap-5">
        {header}
        <LoadingState label="the management summary" rows={6} columns={4} />
        {analysis}
      </section>
    );
  }

  const latest = summary.outputTax[0];
  const overdue = summary.receivablesAgeing.find((bucket) => bucket.bucket === '90+');
  const outstanding = summary.receivablesAgeing.reduce(
    (count, bucket) => count + bucket.billCount,
    0,
  );

  return (
    <section aria-labelledby="mis-title" className="flex flex-col gap-5">
      {header}

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && <FormError>{actionError}</FormError>}

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

      {analysis}
    </section>
  );
}
