import { Fragment, useCallback, useEffect, useState } from 'react';
import { CalendarX2, ChevronDown, ChevronRight, LockKeyhole } from 'lucide-react';
import type {
  PayrollRun as PayrollRunRecord,
  PayrollRunLine,
  PayrollRunSummary,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate, formatInr, formatTimestampDate } from '../format.js';
import { describeLoadFailure } from '../lib/load-failure.js';
import {
  employeeRegisterHash,
  navigateOnClick,
  paymentsHash,
} from '../lib/workspace-routes.js';
import { Button, buttonVariants } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { Modal } from '../ui/dialog.js';
import { Actions, Field, FormError } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * The monthly payroll run (migration 0090).
 *
 * The mock draws it at `app/hr/payroll/page.tsx` through
 * `components/payroll-run-workspace.tsx` at fdfd610: a month picker, a
 * run status, a table whose header groups Earnings against Statutory
 * deductions against Net, an expandable computation per employee, and a
 * statutory-filings card. Everything but the last is here in the mock's
 * own grammar; `docs/UX.md` § 15 records why the filings card is not, and
 * what stands in its place.
 *
 * NOT ONE FIGURE ON THIS SCREEN IS COMPUTED HERE. Every amount arrives as
 * a decimal string that `app_private.calculate_payroll_run` produced in
 * SQL numeric, totals included. A payroll is the surface where browser
 * arithmetic would show first — a paise of drift per head per month is a
 * contribution that does not reconcile with what was remitted — so the
 * browser formats and never adds.
 */

interface PayrollRunProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly canModify: boolean;
  readonly onOpenEmployees: () => void;
}

/** `2026-08-01` → `August 2026`. Pure string work on a date-only value:
 * a legal date never round-trips through a timezone (rule 6), and the
 * month label of a payroll period is exactly the kind of value a UTC
 * round-trip moves by one. */
function monthLabel(periodMonth: string): string {
  const [year, month] = periodMonth.split('-');
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return `${names[Number(month) - 1] ?? month} ${year ?? ''}`.trim();
}

/** Tokens in a statutory-parameter name that are acronyms or provisions,
 * uppercased so the CA-facing basis table reads "ESI employee" and
 * "Rebate 87A", not "esi employee" or the raw column key. */
const PARAMETER_ACRONYMS = new Set(['epf', 'eps', 'esi', 'tds', 'hra', '87a']);

/**
 * A statutory parameter, decoded for the Statutory-basis table the
 * chartered accountant reads. The unit is in the name's suffix
 * (`_percent` / `_rupees`), so `esi_employee_percent` `0.7500` becomes
 * "ESI employee" at "0.75%", and `epf_monthly_wage_ceiling_rupees`
 * `15000.0000` becomes "EPF monthly wage ceiling" at "₹15,000". No raw
 * keys, no unitless numbers.
 */
function decodeStatutoryParameter(
  parameter: string,
  value: string,
): {
  readonly label: string;
  readonly display: string;
} {
  const isPercent = parameter.endsWith('_percent');
  const isRupees = parameter.endsWith('_rupees');
  const words = parameter
    .replace(/_(percent|rupees)$/, '')
    .split('_')
    .map((word) => (PARAMETER_ACRONYMS.has(word) ? word.toUpperCase() : word));
  const label = words.join(' ').replace(/^./, (c) => c.toUpperCase());
  const display = isPercent
    ? `${String(Number(value))}%`
    : isRupees
      ? formatInr(value)
      : value;
  return { label, display };
}

const RUN_STATUS_LABELS: Record<PayrollRunRecord['status'], string> = {
  draft: 'Draft',
  finalized: 'Finalised',
  cancelled: 'Cancelled',
};

export function PayrollRun({
  api,
  organisationId,
  canModify,
  onOpenEmployees,
}: PayrollRunProps) {
  // The whole summary, not a stripped {id, periodMonth}. Two runs for one
  // month — a cancelled one and its live replacement — both read "August
  // 2026" without the number and the status beside them.
  const [runs, setRuns] = useState<readonly PayrollRunSummary[] | null>(null);
  const [run, setRun] = useState<PayrollRunRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);

  const reload = useCallback(() => {
    setLoadVersion((current) => current + 1);
  }, []);

  /* One read on mount and one per selection: the register of runs, then
     whichever run is showing. The register's own rows carry no lines, so
     the detail is a second request rather than a list that grows with
     the headcount. */
  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setRuns(null);
    setLoadError(null);
    void (async () => {
      try {
        // Every run, paged through to the end rather than the first 24 —
        // a four-year organisation has fifty-odd monthly runs and a
        // silent truncation would hide the older half of them from the
        // picker. The count is bounded (twelve a year), so the whole
        // register is a handful of pages, not a growing list.
        const all: PayrollRunSummary[] = [];
        let cursor: string | undefined;
        do {
          const page = await api.listPayrollRuns(organisationId, {
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          });
          all.push(...page.runs);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined && !cancelled);
        if (cancelled) return;
        setRuns(all);
        const newest = all[0];
        if (newest === undefined) return;
        const detail = await api.getPayrollRun(organisationId, newest.id);
        if (!cancelled) setRun(detail.run);
      } catch (cause: unknown) {
        if (cancelled) return;
        setRuns(null);
        setLoadError(describeLoadFailure(cause, 'The payroll register').message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  async function act(work: () => Promise<PayrollRunRecord>, success: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const updated = await work();
      setRun(updated);
      // Keep the picker's option in step with the detail: a run just
      // cancelled must not still read "Draft" in the month dropdown.
      setRuns(
        (current) =>
          current?.map((entry) => (entry.id === updated.id ? updated : entry)) ??
          current,
      );
      setNotice(success);
    } catch (cause: unknown) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The payroll run could not be changed.',
      );
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <PageHeader
      eyebrow="People and payroll"
      title="Monthly payroll"
      titleId="payroll-title"
      description="Earnings, the statutory deductions the law takes off them, and the salary requests a finalised run raises on the Payments register."
      action={
        <div className="flex flex-wrap items-end gap-2">
          <a
            href={employeeRegisterHash()}
            onClick={navigateOnClick(onOpenEmployees)}
            className={buttonVariants({ variant: 'outline' })}
          >
            Employees
          </a>
        </div>
      }
    />
  );

  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorState onRetry={reload} retryLabel="Retry the payroll register">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (runs === null) {
    return (
      <>
        {header}
        <LoadingState label="the payroll register" rows={6} columns={6} />
      </>
    );
  }

  return (
    <>
      {header}

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field className="min-w-48">
            <label htmlFor="payroll-month">Payroll month</label>
            <select
              id="payroll-month"
              className="input"
              value={run?.id ?? ''}
              onChange={(event) => {
                const id = event.target.value;
                if (id === '') {
                  setRun(null);
                  return;
                }
                void act(
                  async () => (await api.getPayrollRun(organisationId, id)).run,
                  '',
                );
              }}
            >
              {runs.length === 0 && <option value="">No run yet</option>}
              {runs.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {monthLabel(entry.periodMonth)} · {entry.runNumber} ·{' '}
                  {RUN_STATUS_LABELS[entry.status]}
                </option>
              ))}
            </select>
          </Field>
          {canModify && (
            <OpenRunControl
              api={api}
              organisationId={organisationId}
              busy={busy}
              onOpened={(opened) => {
                // The full record IS a summary plus lines; store it so the
                // picker's new option carries the number and status.
                setRuns((current) => [opened, ...(current ?? [])]);
                setRun(opened);
                setNotice(`${opened.runNumber} opened.`);
              }}
              onError={setActionError}
            />
          )}
        </div>
      </Card>

      {notice !== null && notice !== '' && (
        <p role="status" className="m-0 mb-3 text-sm text-success">
          {notice}
        </p>
      )}
      {actionError !== null && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {actionError}
        </div>
      )}

      {run === null ? (
        <Card>
          <EmptyState>
            No payroll run has been opened. A run covers one month, is calculated from
            the employee register, and becomes a record of what was paid once it is
            finalised.
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="m-0 text-base font-semibold">
                  {monthLabel(run.periodMonth)} payroll run
                </h2>
                <p className="m-0 mt-1 text-sm text-muted-foreground">
                  <span className="font-mono">{run.runNumber}</span>
                  {' · '}
                  {run.calculatedAt === null
                    ? 'Not yet calculated'
                    : `Calculated ${formatTimestampDate(run.calculatedAt)}`}
                </p>
                <p className="m-0 mt-2">
                  <StatusChip status={run.status}>
                    {RUN_STATUS_LABELS[run.status]}
                  </StatusChip>
                </p>
                {run.status === 'finalized' && (
                  // The door the finalise toast used to point at without
                  // one: the salary requests this run raised are on the
                  // Payments register, waiting to be approved and paid.
                  <p className="m-0 mt-2 text-sm">
                    <a
                      href={paymentsHash()}
                      className="font-medium text-primary hover:underline"
                    >
                      Its salary requests are on the Payments register →
                    </a>
                  </p>
                )}
                {run.cancelReason !== null && (
                  <p className="m-0 mt-2 text-sm text-muted-foreground">
                    Cancelled: {run.cancelReason}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="metric-value m-0">{formatInr(run.totalNet)}</p>
                <p className="m-0 text-xs text-muted-foreground">
                  Total net pay · {run.employeeCount} employees
                </p>
              </div>
            </div>

            {canModify && run.status === 'draft' && (
              <Actions className="mb-4 justify-start">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void act(
                      async () =>
                        (await api.calculatePayrollRun(organisationId, run.id)).run,
                      'Payroll calculated.',
                    );
                  }}
                >
                  {run.calculatedAt === null ? 'Calculate payroll' : 'Recalculate'}
                </Button>
                <Button
                  disabled={busy || run.calculatedAt === null || run.lines.length === 0}
                  onClick={() => {
                    void act(
                      async () =>
                        (await api.finalizePayrollRun(organisationId, run.id)).run,
                      'Payroll finalised. A salary request is waiting for approval on the Payments register for every employee.',
                    );
                  }}
                >
                  <LockKeyhole data-icon="inline-start" aria-hidden="true" />
                  Finalise run
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setCancelling(true);
                  }}
                >
                  Cancel run…
                </Button>
              </Actions>
            )}
            {canModify && run.status === 'finalized' && (
              <Actions className="mb-4 justify-start">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setCancelling(true);
                  }}
                >
                  Cancel run…
                </Button>
              </Actions>
            )}

            {run.lines.length === 0 ? (
              <EmptyState>
                {run.calculatedAt === null
                  ? 'Calculate the run to work out what each employee is owed for the month.'
                  : 'Nobody was employed during this month, so the run has no payslips.'}
              </EmptyState>
            ) : (
              <DataTable>
                <caption className="sr-only">
                  Every employee&rsquo;s payslip for {monthLabel(run.periodMonth)}: days
                  paid, earnings, each statutory deduction with the employer&rsquo;s
                  matching contribution, and the net
                </caption>
                {/* The mock's grouped two-row header: Earnings, then the
                    five Statutory-deduction columns, then Net. It is the
                    CA-facing table and the grouping is the readability —
                    it says at a glance which columns come OFF the gross
                    and which is the result. `colgroup` borders and the
                    `colSpan` groups are the mock's own. */}
                <thead>
                  <tr>
                    <th scope="col" rowSpan={2}>
                      Employee
                    </th>
                    <th scope="col" rowSpan={2}>
                      Attendance
                    </th>
                    <th scope="col" className="text-center!">
                      Earnings
                    </th>
                    <th scope="col" colSpan={5} className="border-l text-center!">
                      Statutory deductions
                    </th>
                    <th scope="col" className="border-l text-center!">
                      Net
                    </th>
                  </tr>
                  <tr>
                    <th scope="col" className="text-right!">
                      Gross
                    </th>
                    <th scope="col" className="border-l text-right!">
                      PF employee
                    </th>
                    <th scope="col" className="text-right!">
                      PF employer
                    </th>
                    <th scope="col" className="text-right!">
                      ESI
                    </th>
                    <th scope="col" className="text-right!">
                      PT
                    </th>
                    <th scope="col" className="text-right!">
                      TDS s.192
                    </th>
                    <th scope="col" className="border-l text-right!">
                      Net pay
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {run.lines.map((line) => (
                    // Keyed on the EMPLOYEE, not the line id. Recalculating
                    // a draft deletes every line and writes fresh ones with
                    // new ids (migration 0090), so keying the open panel on
                    // line.id would collapse it and drop focus to the body
                    // on every recalculation — a keyboard user re-tabs from
                    // the top for each of forty people. The employee is
                    // stable across the rebuild.
                    <Fragment key={line.employeeId}>
                      <tr>
                        <th scope="row" className={wrapCell}>
                          <button
                            type="button"
                            className="flex items-center gap-2 text-left"
                            aria-expanded={expanded === line.employeeId}
                            /* Names the panel it opens. `aria-expanded`
                               alone tells a screen reader that SOMETHING
                               expanded and not what, which is what
                               `test/a11y-invariants.test.ts` refuses. */
                            aria-controls={`payslip-${line.employeeId}`}
                            onClick={() => {
                              setExpanded(
                                expanded === line.employeeId ? null : line.employeeId,
                              );
                            }}
                          >
                            {expanded === line.employeeId ? (
                              <ChevronDown className="size-4" aria-hidden="true" />
                            ) : (
                              <ChevronRight className="size-4" aria-hidden="true" />
                            )}
                            <span>
                              <span className="block font-medium">
                                {line.employeeName}
                              </span>
                              <span className="font-mono text-xs text-muted-foreground">
                                {line.employeeCode}
                              </span>
                            </span>
                          </button>
                        </th>
                        <td className="text-xs">
                          <span className="font-mono tabular-nums">
                            {line.paidDays}/{line.calendarDays}
                          </span>{' '}
                          days
                          {/* Warning-toned when there IS a loss of pay,
                              muted when there is none — the mock tints it,
                              and a paid-days shortfall is exactly the row a
                              payroll clerk scans for. Colour is not the
                              only signal: the number itself carries it. */}
                          <span
                            className={`block ${
                              Number(line.lopDays) > 0
                                ? 'text-warning-foreground'
                                : 'text-muted-foreground'
                            }`}
                          >
                            Loss of pay {line.lopDays}
                          </span>
                        </td>
                        <td className={numericCell}>{formatInr(line.grossEarnings)}</td>
                        <td className={`${numericCell} border-l`}>
                          {formatInr(line.epfEmployee)}
                        </td>
                        <td className={numericCell}>{formatInr(line.epfEmployer)}</td>
                        <td className={numericCell}>
                          {line.esiCovered
                            ? formatInr(line.esiEmployee)
                            : 'Not covered'}
                        </td>
                        <td className={numericCell}>
                          {formatInr(line.professionalTax)}
                        </td>
                        <td className={numericCell}>{formatInr(line.tds)}</td>
                        <td className={`${numericCell} border-l font-semibold`}>
                          {formatInr(line.netPay)}
                        </td>
                      </tr>
                      {expanded === line.employeeId && (
                        <tr>
                          <td
                            id={`payslip-${line.employeeId}`}
                            colSpan={9}
                            className="bg-muted/25 px-4 py-4"
                          >
                            <LineBreakdown
                              line={line}
                              esiCeiling={
                                run.statutoryBasis.find(
                                  (entry) =>
                                    entry.parameter ===
                                    'esi_monthly_gross_ceiling_rupees',
                                )?.value ?? null
                              }
                              runId={run.id}
                              draft={run.status === 'draft' && canModify}
                              busy={busy}
                              onSetLossOfPay={(lopDays) => {
                                void act(
                                  async () =>
                                    (
                                      await api.setPayrollLineLossOfPay(
                                        organisationId,
                                        run.id,
                                        line.id,
                                        { lopDays },
                                      )
                                    ).run,
                                  'Loss of pay recorded and the run recalculated.',
                                );
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>

          {run.lines.length > 0 && (
            <>
              <Card className="mt-4">
                <h2 className="m-0 text-base font-semibold">What is remitted</h2>
                <p className="m-0 mt-1 mb-4 text-sm text-muted-foreground">
                  Both halves of every contribution. The employer&rsquo;s shares are a
                  cost to the organisation and never come off a payslip — the net above
                  is the gross less the employee&rsquo;s four heads and nothing else.
                </p>
                <DataTable>
                  <caption className="sr-only">
                    What the organisation deducts and what it owes, head by head
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Head</th>
                      <th scope="col" className="text-right!">
                        Deducted from employees
                      </th>
                      <th scope="col" className="text-right!">
                        Employer&rsquo;s own contribution
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Provident fund</th>
                      <td className={numericCell}>{formatInr(run.totalEpfEmployee)}</td>
                      <td className={numericCell}>{formatInr(run.totalEpfEmployer)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Pension scheme</th>
                      <td className={numericCell}>—</td>
                      <td className={numericCell}>{formatInr(run.totalEpsEmployer)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Employees&rsquo; State Insurance</th>
                      <td className={numericCell}>{formatInr(run.totalEsiEmployee)}</td>
                      <td className={numericCell}>{formatInr(run.totalEsiEmployer)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Profession tax</th>
                      <td className={numericCell}>
                        {formatInr(run.totalProfessionalTax)}
                      </td>
                      <td className={numericCell}>—</td>
                    </tr>
                    <tr>
                      <th scope="row">Income tax, section 192</th>
                      <td className={numericCell}>{formatInr(run.totalTds)}</td>
                      <td className={numericCell}>—</td>
                    </tr>
                  </tbody>
                </DataTable>
              </Card>

              <Card className="mt-4">
                <h2 className="m-0 text-base font-semibold">Statutory basis</h2>
                <p className="m-0 mt-1 mb-4 text-sm text-muted-foreground">
                  The notified rates and ceilings in force in{' '}
                  {monthLabel(run.periodMonth)}, which is what this run was computed
                  against. A run for an earlier month reads that month&rsquo;s figures,
                  not these. Awaiting a chartered accountant&rsquo;s sign-off before the
                  product is used to file a return.
                </p>
                <DataTable>
                  <caption className="sr-only">
                    Each statutory rate and ceiling this run applied, with the
                    notification it comes from
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Parameter</th>
                      <th scope="col" className="text-right!">
                        In force
                      </th>
                      <th scope="col">Effective from</th>
                      <th scope="col">Notification</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.statutoryBasis.map((entry) => {
                      const decoded = decodeStatutoryParameter(
                        entry.parameter,
                        entry.value,
                      );
                      return (
                        <tr key={`${entry.parameter}-${entry.effectiveFrom}`}>
                          <th scope="row">{decoded.label}</th>
                          <td className={numericCell}>{decoded.display}</td>
                          <td className="font-mono text-[13px] tabular-nums">
                            {formatDate(entry.effectiveFrom)}
                          </td>
                          <td className={wrapCell}>{entry.notification}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </DataTable>
              </Card>
            </>
          )}
        </>
      )}

      {cancelling && run !== null && (
        <CancelRunDialog
          busy={busy}
          runNumber={run.runNumber}
          finalized={run.status === 'finalized'}
          onClose={() => {
            setCancelling(false);
          }}
          onConfirm={(reason) => {
            setCancelling(false);
            void act(
              async () =>
                (await api.cancelPayrollRun(organisationId, run.id, { reason })).run,
              'Payroll run cancelled. It keeps its number.',
            );
          }}
        />
      )}
    </>
  );
}

/**
 * One employee's monthly computation, opened from their row.
 *
 * The mock puts a two-column breakdown here — the computation on the left
 * and an "Income-tax regime" card on the right comparing the old and new
 * regimes with one badged Recommended. The comparison is NOT here, and
 * `docs/UX.md` § 15 records why: recommending a tax regime to a named
 * person is advice, the counterfactual depends on declarations the
 * employee may not have made, and the product would be stating a figure
 * it has no basis for. What is shown is the regime the employee actually
 * elected and the year this run estimated under it.
 */
/**
 * The reason an employee is not in ESI this month, in the employee's own
 * words. Three genuinely different answers the mock collapsed into one
 * "above the ceiling", which is wrong for the two-thirds of them that are
 * not: a ₹19,800 earner in an uncovered establishment reads "Not covered"
 * in the table and must not read "above the ceiling" in the breakdown.
 *
 * Derived from the figures already on screen — the line's gross against
 * the ceiling the run was computed with (its snapshot basis) — so no new
 * server field is needed. Not money arithmetic: a comparison for wording.
 */
function esiNotCoveredReason(gross: string, ceiling: string | null): string {
  if (ceiling === null) return 'Not covered';
  return Number(gross) > Number(ceiling)
    ? `Above the ${formatInr(ceiling)} wage ceiling`
    : 'Establishment not covered';
}

function LineBreakdown({
  line,
  esiCeiling,
  runId,
  draft,
  busy,
  onSetLossOfPay,
}: {
  readonly line: PayrollRunLine;
  /** The ESI gross ceiling this run was computed against, from its basis
   * snapshot; null if the run recorded none. */
  readonly esiCeiling: string | null;
  readonly runId: string;
  readonly draft: boolean;
  readonly busy: boolean;
  readonly onSetLossOfPay: (lopDays: string) => void;
}) {
  const [lop, setLop] = useState(line.lopDays);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
      <div>
        <p className="section-label">Monthly computation</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Line label="Basic" value={formatInr(line.basic)} />
          <Line label="Dearness allowance" value={formatInr(line.dearnessAllowance)} />
          <Line
            label="House rent allowance"
            value={formatInr(line.houseRentAllowance)}
          />
          <Line label="Other allowances" value={formatInr(line.otherAllowances)} />
          <Line label="Gross earnings" value={formatInr(line.grossEarnings)} strong />
          <Line label="Provident-fund wage" value={formatInr(line.pfWages)} />
          <Line label="PF employee" value={`− ${formatInr(line.epfEmployee)}`} />
          <Line
            label="ESI employee"
            value={
              line.esiCovered
                ? `− ${formatInr(line.esiEmployee)}`
                : esiNotCoveredReason(line.grossEarnings, esiCeiling)
            }
          />
          <Line label="Profession tax" value={`− ${formatInr(line.professionalTax)}`} />
          <Line label="TDS section 192" value={`− ${formatInr(line.tds)}`} />
          <Line label="Net pay" value={formatInr(line.netPay)} strong />
        </dl>
      </div>
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border p-3">
          <p className="section-label">Income tax for the year</p>
          <p className="mt-2 text-sm">
            {line.taxRegime === 'new'
              ? 'New regime, section 115BAC'
              : 'Old regime, as elected'}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <Line
              label="Income projected for the year"
              value={formatInr(line.projectedAnnualIncome)}
            />
            <Line
              label="Tax estimated on it"
              value={formatInr(line.projectedAnnualTax)}
            />
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            This month&rsquo;s deduction is that year&rsquo;s estimate less what has
            already been deducted, spread over the months still to be paid.
          </p>
        </div>

        {draft && (
          <div className="rounded-lg border p-3">
            <Field>
              <label htmlFor={`lop-${line.id}`}>Loss-of-pay days</label>
              <input
                id={`lop-${line.id}`}
                className="input w-32 font-mono tabular-nums"
                inputMode="decimal"
                value={lop}
                onChange={(event) => {
                  setLop(event.target.value);
                }}
              />
            </Field>
            <Actions className="mt-3 justify-start">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || lop === line.lopDays}
                onClick={() => {
                  onSetLossOfPay(lop.trim());
                }}
                data-run-id={runId}
              >
                Record and recalculate
              </Button>
            </Actions>
          </div>
        )}
      </div>
    </div>
  );
}

function Line({
  label,
  value,
  strong,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`m-0 mt-1 font-mono tabular-nums${strong === true ? ' font-semibold' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}

/** Opening a month. Separate from the picker beside it because opening a
 * run claims a number, which is not something a select should do as a
 * side effect of being changed. */
function OpenRunControl({
  api,
  organisationId,
  busy,
  onOpened,
  onError,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly busy: boolean;
  readonly onOpened: (run: PayrollRunRecord) => void;
  readonly onError: (message: string) => void;
}) {
  const [month, setMonth] = useState('');
  const [pending, setPending] = useState(false);

  return (
    <>
      <Field className="min-w-40">
        <label htmlFor="payroll-open-month">Open a month</label>
        <input
          id="payroll-open-month"
          type="month"
          className="input"
          value={month}
          onChange={(event) => {
            setMonth(event.target.value);
          }}
        />
      </Field>
      <Button
        variant="outline"
        disabled={busy || pending || month === ''}
        onClick={() => {
          setPending(true);
          api
            .openPayrollRun(organisationId, { periodMonth: `${month}-01` })
            .then((payload) => {
              setMonth('');
              onOpened(payload.run);
            })
            .catch((cause: unknown) => {
              onError(
                cause instanceof RequestFailedError
                  ? cause.message
                  : 'The payroll run could not be opened.',
              );
            })
            .finally(() => {
              setPending(false);
            });
        }}
      >
        <CalendarX2 data-icon="inline-start" aria-hidden="true" />
        {pending ? 'Opening…' : 'Open run'}
      </Button>
    </>
  );
}

function CancelRunDialog({
  busy,
  runNumber,
  finalized,
  onClose,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly runNumber: string;
  readonly finalized: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal onClose={onClose} labelledBy="cancel-run-title" className="w-full max-w-md">
      <h2 id="cancel-run-title" className="m-0 text-base font-semibold">
        Cancel {runNumber}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The run keeps its number forever and nothing reuses it. The month can then be
        run again.
        {finalized
          ? ' This run has raised its salary requests; cancelling closes the ones still awaiting approval. It is refused if any has already been approved or paid on the Payments register — that money is committed.'
          : ''}
      </p>
      <Field className="mt-4">
        <label htmlFor="cancel-run-reason">Reason</label>
        <input
          id="cancel-run-reason"
          className="input"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      {reason.trim().length > 0 && reason.trim().length < 3 && (
        <FormError>A reason is at least three characters.</FormError>
      )}
      <Actions>
        <Button variant="outline" onClick={onClose}>
          Keep the run
        </Button>
        <Button
          disabled={busy || reason.trim().length < 3}
          onClick={() => {
            onConfirm(reason.trim());
          }}
        >
          Cancel the run
        </Button>
      </Actions>
    </Modal>
  );
}
