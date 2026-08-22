import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { FileText, Play } from 'lucide-react';
import {
  defaultWorksAnalysisColumns,
  WORKS_ANALYSIS_COLUMNS,
  WORKS_ANALYSIS_REPORTS,
  type CombinedPendingRow,
  type CombinedPendingTotals,
  type DivisionAnalysisResponse,
  type ItemGroupProposal,
  type ItemGroupProposalsResponse,
  type MappedItemAnalysisResponse,
  type Work,
  type WorkAnalysisItem,
  type WorkAnalysisResponse,
  type WorksAnalysisOptionsResponse,
  type WorksAnalysisReport,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import { formatInr, formatRate } from '../format.js';
import { describeRefusal } from '../lib/load-failure.js';
import { openPdf } from '../lib/openPdf.js';
import { useAction, useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { Combobox, type ComboboxOption } from '../ui/combobox.js';
import { DownloadButton } from '../ui/download-button.js';
import { Field, FormError, FormNotice, Hint } from '../ui/form.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * Works analysis: ONE report at a time, chosen and then run.
 *
 * `packages/contracts/src/works-analysis.ts` states what every figure means
 * and which sources are in it. NOTHING ON THIS SCREEN ADDS ANYTHING UP:
 * every number below is a decimal string the server summed in PostgreSQL,
 * printed through `formatInr` or verbatim. The rule is `views/Mis.tsx`'s and
 * `AGENTS.md` rule 5's, and it matters more here than anywhere else in the
 * product, because these tables exist to be totalled.
 *
 * ## Nothing is read until Run
 *
 * The first shape of this screen drew all three reports at once, on mount.
 * Two of them are portfolio-wide reads across every active Work's schedule
 * — the heaviest in the product — and an operator who opened Reports to
 * check one Work paid for all three every time. So the screen is a
 * SELECTOR: report type, the picker that report needs, the columns to
 * carry, and a Run control. The reads start when Run is pressed and not
 * before, and the empty state above them says so in one sentence.
 *
 * The run is part of the ADDRESS (`lib/workspace-routes.ts`), not state
 * inside this component. That is what makes a configured report something
 * an operator can bookmark and send to somebody else, and what makes Back
 * retrace the reports they ran rather than leaving the screen entirely.
 *
 * ## The columns are the operator's
 *
 * The pending tables are thirteen columns wide, which no phone renders and
 * no purchase officer wants. The chips choose which of them travel — to
 * the table on screen AND into the PDF and the workbook, through the
 * document routes' `columns` parameter. § 19 records that a REGISTER
 * export deliberately ignores the screen's filters; this is a report
 * rather than a register, and a file that carried columns the screen did
 * not show would be a different document from the one being read.
 *
 * Responsive hiding survives underneath: a column the operator kept can
 * still be dropped by a narrow viewport, because the chips say what is
 * WANTED and the breakpoint says what FITS.
 */

interface WorksAnalysisProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The report that has been run, from the address. Null before Run. */
  readonly runReport: WorksAnalysisReport | null;
  /** What that report is about: the Work id, the division code (`none` for
   * the Works whose consignees name no division), or null. */
  readonly runSelection: string | null;
  /** Runs the configured report by making it the address. */
  readonly onRun: (report: WorksAnalysisReport, selection: string | null) => void;
}

/** The three report names, so a document control cannot name one the server
 * does not answer to. */
const REPORT_LABEL: Readonly<Record<WorksAnalysisReport, string>> = {
  work: 'Work analysis',
  division: 'Division analysis',
  'mapped-item': 'Item analysis',
};

const REPORT_DESCRIPTION: Readonly<Record<WorksAnalysisReport, string>> = {
  work: 'One Work, item by item: what is sanctioned, what has been supplied and installed, what is still to supply, install and inspect, and what has been billed against it.',
  division:
    'Pending quantities combined across the active Works of each railway division, so one order can cover a division.',
  'mapped-item':
    'Pending quantities combined per item master, across every active Work. The whole portfolio’s ordering position for one product.',
};

/** The division the report files a Work under when its consignees name none
 * or name more than one. Shared with `routes/works-analysis.ts`, which
 * narrows the exported document on the same token; a real division code is
 * `^[0-9]{2,5}$` and cannot collide with it. */
const NO_DIVISION = 'none';

/* --- columns ---------------------------------------------------------- */

/**
 * One column of a report table.
 *
 * `header` is the chip vocabulary and the document's own heading — the
 * three surfaces name a column with the same words, which is what lets a
 * chosen set travel in a URL a person can read.
 */
interface ReportColumn<Row> {
  readonly header: string;
  readonly numeric?: boolean;
  /** Hidden below this breakpoint whatever the chips say: the chip is what
   * the operator WANTS, the breakpoint is what the screen FITS. */
  readonly hide?: 'md' | 'lg';
  readonly cell: (row: Row) => ReactNode;
  /** The `tfoot` cell, on the tables that carry a total. */
  readonly total?: ReactNode;
}

function columnClass<Row>(column: ReportColumn<Row>): string {
  return cn(
    column.numeric === true && numericCell,
    column.hide === 'md' && 'hidden md:table-cell',
    column.hide === 'lg' && 'hidden lg:table-cell',
  );
}

function chosenColumns<Row>(
  columns: readonly ReportColumn<Row>[],
  chosen: ReadonlySet<string>,
): readonly ReportColumn<Row>[] {
  return columns.filter((column) => chosen.has(column.header));
}

/**
 * The chip row: tap to include, tap again to leave out.
 *
 * `aria-pressed` toggles inside a `role="group"`, the pattern `ui/tab-rail`
 * and the inspection agency pills already use and the one
 * `test/a11y-invariants` will accept without a roving tabindex.
 */
function ColumnChips({
  report,
  chosen,
  onToggle,
}: {
  readonly report: WorksAnalysisReport;
  readonly chosen: ReadonlySet<string>;
  readonly onToggle: (header: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 text-sm font-medium">Columns</p>
      <div
        role="group"
        aria-label="Columns to include"
        className="flex flex-wrap items-center gap-1"
      >
        {WORKS_ANALYSIS_COLUMNS[report].map((column) => {
          const on = chosen.has(column.header);
          return (
            <button
              key={column.header}
              type="button"
              aria-pressed={on}
              onClick={() => {
                onToggle(column.header);
              }}
              className={cn(
                'h-7 rounded-md px-2.5 text-xs font-medium transition-colors',
                on
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {column.header}
            </button>
          );
        })}
      </div>
      <Hint>
        The columns you keep are the columns the PDF and the workbook carry. Item and
        description always travel.
      </Hint>
    </div>
  );
}

/* --- the selector ------------------------------------------------------ */

export function WorksAnalysis({
  api,
  organisationId,
  runReport,
  runSelection,
  onRun,
}: WorksAnalysisProps) {
  const [works, setWorks] = useState<readonly Work[] | null>(null);
  const [worksError, setWorksError] = useState<string | null>(null);
  const [worksVersion, retryWorks] = useReload();

  const [report, setReport] = useState<WorksAnalysisReport>(runReport ?? 'work');
  const [workId, setWorkId] = useState(
    runReport === 'work' ? (runSelection ?? '') : '',
  );
  const [division, setDivision] = useState(
    runReport === 'division' ? (runSelection ?? '') : '',
  );
  const [item, setItem] = useState(
    runReport === 'mapped-item' ? (runSelection ?? '') : '',
  );
  const [columns, setColumns] = useState<ReadonlySet<string>>(
    () => new Set(defaultWorksAnalysisColumns(runReport ?? 'work')),
  );
  /** What the two portfolio reports can be narrowed to, read from the
   * server before either is run.
   *
   * The first cut filled the division picker FROM the division report, so
   * an operator who wanted one division had to read every division first
   * and there was no item picker at all. That is a picker that cannot be
   * used to choose, and the owner rejected it. `/api/reports/analysis/
   * options` is the cheap read that answers it instead: headings and item
   * keys, no quantities. */
  const [options, setOptions] = useState<WorksAnalysisOptionsResponse | null>(null);

  /* The address is the source of truth for what is RUN. Following it here
     keeps the selector describing the report on screen after a Back press
     or a shared link, instead of showing the last thing this component was
     asked to run. */
  useEffect(() => {
    if (runReport === null) return;
    setReport(runReport);
    setColumns(new Set(defaultWorksAnalysisColumns(runReport)));
    if (runReport === 'work') setWorkId(runSelection ?? '');
    if (runReport === 'division') setDivision(runSelection ?? '');
    if (runReport === 'mapped-item') setItem(runSelection ?? '');
  }, [runReport, runSelection]);

  /* The pickers' own lists, and the only reads this screen makes before
     Run: a selector with nothing to select is not a selector. Both are
     register-shaped rather than portfolio roll-ups — the Work list, and
     the headings and item keys the two portfolio reports can be narrowed
     to. Neither reads a challan, an installation or a rupee. */
  useEffect(() => {
    let cancelled = false;
    api
      .listWorks(organisationId)
      .then((loaded) => {
        if (cancelled) return;
        setWorks(loaded);
        setWorkId((current) => (current === '' ? (loaded[0]?.id ?? '') : current));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setWorksError(describeRefusal(cause, 'The Work list').message);
      });
    api
      .worksAnalysisOptions(organisationId)
      .then((loaded) => {
        if (!cancelled) setOptions(loaded);
      })
      .catch(() => {
        /* A picker that could not load its choices leaves the report
           runnable across the whole portfolio, which is what it did
           before this existed. Failing the screen over a dropdown would
           take away the report as well as the narrowing. */
        if (!cancelled) setOptions({ divisions: [], items: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, worksVersion]);

  const toggle = useCallback((header: string) => {
    setColumns((current) => {
      const next = new Set(current);
      if (!next.delete(header)) next.add(header);
      return next;
    });
  }, []);

  /* The chips belong to the report being CONFIGURED. Where that is not the
     report on screen — the operator has changed the type but not pressed
     Run — the result keeps the defaults of what it actually is, rather
     than being filtered by another report's vocabulary. */
  const shownColumns =
    runReport === null || runReport === report
      ? columns
      : new Set(defaultWorksAnalysisColumns(runReport));

  const canRun = report !== 'work' || workId !== '';

  /* A Work row is its CODE and as much of the title as the row fits. The
     code is what the operator knows and what the paperwork carries; the
     title is there to confirm the choice, not to be read to the end. */
  const workOptions: readonly ComboboxOption[] = (works ?? []).map((work) => ({
    value: work.id,
    code: work.workCode,
    label: work.title,
  }));

  /* "Every division" and "Every item" are options rather than a separate
     control, because they are what the report answers when nothing is
     chosen — the same empty value the address carries as no segment. */
  const divisionOptions: readonly ComboboxOption[] = [
    { value: '', label: 'Every division' },
    ...(options?.divisions ?? []).map((code) => ({
      value: code ?? NO_DIVISION,
      label: code === null ? 'No division on record' : `Division ${code}`,
    })),
  ];

  const itemOptions: readonly ComboboxOption[] = [
    { value: '', label: 'Every item' },
    ...(options?.items ?? []).map((entry) => ({
      value: entry.key,
      label: entry.mapped ? entry.label : `${entry.label} (not mapped)`,
    })),
  ];

  return (
    <>
      <Card className="flex flex-col gap-4">
        <CardHeader>
          <div className="flex flex-col gap-1">
            <h2 className="text-base leading-snug font-medium">Report</h2>
            <p className="text-sm text-muted-foreground">
              {REPORT_DESCRIPTION[report]} Every figure is the server’s.
            </p>
          </div>
        </CardHeader>

        <div className="grid gap-3 md:grid-cols-2">
          <Field>
            <label htmlFor="works-analysis-report">Report type</label>
            <select
              id="works-analysis-report"
              value={report}
              onChange={(event) => {
                const next = event.target.value as WorksAnalysisReport;
                setReport(next);
                setColumns(new Set(defaultWorksAnalysisColumns(next)));
              }}
            >
              {WORKS_ANALYSIS_REPORTS.map((name) => (
                <option key={name} value={name}>
                  {REPORT_LABEL[name]}
                </option>
              ))}
            </select>
          </Field>

          {report === 'work' && (
            <Field>
              <label htmlFor="works-analysis-work">Work</label>
              <Combobox
                id="works-analysis-work"
                value={workId}
                disabled={works === null}
                options={workOptions}
                onChange={setWorkId}
                placeholder={works === null ? 'Loading…' : 'Type a code or a title'}
                noMatchLabel="No Work matches that code or title."
              />
            </Field>
          )}

          {report === 'division' && (
            <Field>
              <label htmlFor="works-analysis-division">Railway division</label>
              <Combobox
                id="works-analysis-division"
                value={division}
                options={divisionOptions}
                onChange={setDivision}
                noMatchLabel="No division matches that."
              />
            </Field>
          )}

          {report === 'mapped-item' && (
            <Field>
              <label htmlFor="works-analysis-item">Item</label>
              <Combobox
                id="works-analysis-item"
                value={item}
                options={itemOptions}
                onChange={setItem}
                noMatchLabel="No item matches that."
              />
            </Field>
          )}
        </div>

        <ColumnChips report={report} chosen={columns} onToggle={toggle} />

        {/* The picker's own wait, announced. A disabled select reading
            "Loading…" is a visual cue only, and every load on this screen
            owes an operator using a screen reader the same sentence. */}
        {worksError === null && works === null && (
          <p role="status" className="m-0 text-sm text-muted-foreground">
            Loading Works…
          </p>
        )}

        {worksError !== null && (
          <ErrorState onRetry={retryWorks} retryLabel="Retry the Work list">
            {worksError}
          </ErrorState>
        )}

        {worksError === null && report === 'work' && works?.length === 0 && (
          <EmptyState>
            No Work has been recorded yet. A Work analysis is a report on one contract.
          </EmptyState>
        )}

        <div>
          <Button
            type="button"
            disabled={!canRun}
            onClick={() => {
              const chosen =
                report === 'work' ? workId : report === 'division' ? division : item;
              onRun(report, chosen === '' ? null : chosen);
            }}
          >
            <Play aria-hidden="true" className="size-4" />
            Run report
          </Button>
        </div>
      </Card>

      {runReport === null ? (
        <EmptyState>
          No report has been run. Choose a report type above, pick the columns you want,
          and run it — nothing is read until you do.
        </EmptyState>
      ) : (
        <RunResult
          api={api}
          organisationId={organisationId}
          report={runReport}
          selection={runSelection}
          columns={shownColumns}
        />
      )}
    </>
  );
}

function RunResult({
  api,
  organisationId,
  report,
  selection,
  columns,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly report: WorksAnalysisReport;
  readonly selection: string | null;
  readonly columns: ReadonlySet<string>;
}) {
  if (report === 'work') {
    // The address guarantees a Work id on this report, so the picker's
    // empty state above is the only place "no Work" is answered.
    return selection === null ? null : (
      <WorkAnalysisCard
        api={api}
        organisationId={organisationId}
        workId={selection}
        columns={columns}
      />
    );
  }
  if (report === 'division') {
    return (
      <DivisionAnalysisCard
        api={api}
        organisationId={organisationId}
        division={selection}
        columns={columns}
      />
    );
  }
  return (
    <>
      <MappedItemAnalysisCard
        api={api}
        organisationId={organisationId}
        item={selection}
        columns={columns}
      />
      {/* The proposals are about the UNMAPPED descriptions the whole
          portfolio holds. Narrowed to one item they would be a list of
          one thing that cannot be grouped with itself, so they render
          under the portfolio-wide run and not under a narrowed one. */}
      {selection === null && (
        <ItemGroupProposalsCard api={api} organisationId={organisationId} />
      )}
    </>
  );
}

/** The two document controls every report carries: the page to read and the
 * workbook to work in. A PDF is OPENED and a workbook is SAVED — the
 * distinction `lib/download.ts` records, applied here rather than
 * re-argued. Both carry the chosen columns, and the division report carries
 * the chosen division, so the file is the report on the screen. */
function ReportDocuments({
  api,
  organisationId,
  report,
  workId,
  division,
  item,
  columns,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly report: WorksAnalysisReport;
  readonly workId?: string;
  readonly division?: string;
  readonly item?: string;
  readonly columns: ReadonlySet<string>;
}) {
  const { pending, notice, actionError, act } = useAction();
  const options = {
    ...(workId === undefined ? {} : { workId }),
    ...(division === undefined ? {} : { division }),
    ...(item === undefined ? {} : { item }),
    columns: [...columns],
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => {
            void act(
              () =>
                openPdf(() =>
                  api.downloadWorksAnalysis(organisationId, report, 'pdf', options),
                ),
              null,
            );
          }}
        >
          <FileText aria-hidden="true" className="size-4" />
          {REPORT_LABEL[report]} PDF
        </Button>
        <DownloadButton
          label="Export .xlsx"
          filename={`${report}-analysis.xlsx`}
          fetchBlob={() =>
            api.downloadWorksAnalysis(organisationId, report, 'xlsx', options)
          }
        />
      </div>
      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && <FormError>{actionError}</FormError>}
    </div>
  );
}

/** One table, drawn from the columns the operator kept. The leading
 * identity column is passed separately because it never leaves. */
function ReportTable<Row>({
  caption,
  rows,
  rowKey,
  identity,
  columns,
  identityTotal,
  identityWrap,
}: {
  readonly caption: string;
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly identity: {
    readonly header: string;
    readonly cell: (row: Row) => ReactNode;
    /** The second, always-present column: a description or a group name. */
    readonly second?: {
      readonly header: string;
      readonly cell: (row: Row) => ReactNode;
    };
  };
  readonly columns: readonly ReportColumn<Row>[];
  /** The `tfoot` row header, where the table carries a total. */
  readonly identityTotal?: ReactNode;
  readonly identityWrap?: boolean;
}) {
  return (
    <DataTable>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{identity.header}</th>
          {identity.second !== undefined && (
            <th scope="col">{identity.second.header}</th>
          )}
          {columns.map((column) => (
            <th key={column.header} scope="col" className={columnClass(column)}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            <th scope="row" className={identityWrap === true ? wrapCell : undefined}>
              {identity.cell(row)}
            </th>
            {identity.second !== undefined && (
              <td className={wrapCell}>{identity.second.cell(row)}</td>
            )}
            {columns.map((column) => (
              <td key={column.header} className={columnClass(column)}>
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {identityTotal !== undefined && (
        <tfoot>
          <tr>
            <th scope="row" colSpan={identity.second === undefined ? 1 : 2}>
              {identityTotal}
            </th>
            {columns.map((column) => (
              <td key={column.header} className={columnClass(column)}>
                {column.total ?? null}
              </td>
            ))}
          </tr>
        </tfoot>
      )}
    </DataTable>
  );
}

/* --- report A: one Work ---------------------------------------------- */

function WorkAnalysisCard({
  api,
  organisationId,
  workId,
  columns,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly columns: ReadonlySet<string>;
}) {
  const [analysis, setAnalysis] = useState<WorkAnalysisResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    setLoadError(null);
    api
      .workAnalysis(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setAnalysis(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLoadError(describeRefusal(cause, 'The Work analysis').message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="text-base leading-snug font-medium">Work analysis</h2>
          {analysis !== null && (
            <p className="text-sm text-muted-foreground">
              {analysis.work.workCode} — {analysis.work.title}
            </p>
          )}
        </div>
      </CardHeader>

      {/* Each report names its own retry, so an operator answering an
          outage knows which read they are re-running. */}
      {loadError !== null && (
        <ErrorState onRetry={retry} retryLabel="Retry the Work analysis">
          {loadError}
        </ErrorState>
      )}

      {loadError === null && analysis === null && (
        <LoadingState label="the Work analysis" rows={6} columns={6} />
      )}

      {analysis !== null && (
        <>
          <ReportDocuments
            api={api}
            organisationId={organisationId}
            report="work"
            workId={analysis.work.id}
            columns={columns}
          />
          <WorkFacts analysis={analysis} />
          <WorkQuantityTable analysis={analysis} columns={columns} />
          <WorkValueTable analysis={analysis} columns={columns} />
          <WorkInspectionTable analysis={analysis} />
          <WorkPaymentTable analysis={analysis} />
        </>
      )}
    </Card>
  );
}

function WorkFacts({ analysis }: { readonly analysis: WorkAnalysisResponse }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-muted-foreground">
      <li>
        Railway division:{' '}
        {analysis.divisionCode ??
          (analysis.divisionSource === 'ambiguous'
            ? `not settled — this Work’s documents name ${analysis.divisionCandidates.join(', ')}`
            : 'no division on record')}
        . Derived from the division codes on this Work’s own consignee contacts; this
        schema records no client contact on a Work.
      </li>
      {analysis.work.allowExcessDelivery && (
        <li>
          Excess delivery is permitted on this Work, so delivery may exceed the
          sanctioned quantity. Pending to supply never goes below zero.
        </li>
      )}
      {analysis.baselineLocked && (
        <li>
          A locked opening billing baseline is included in the supplied, installed and
          billed positions below.
        </li>
      )}
      {analysis.totals.itemsWithoutMatrixRow > 0 && (
        <li>
          {analysis.totals.itemsWithoutMatrixRow} item(s) resolve through no
          payment-matrix row. Their unbilled executed value shows a dash rather than a
          zero, because there is no percentage to bill them at.
        </li>
      )}
    </ul>
  );
}

function WorkQuantityTable({
  analysis,
  columns,
}: {
  readonly analysis: WorkAnalysisResponse;
  readonly columns: ReadonlySet<string>;
}) {
  const all: readonly ReportColumn<WorkAnalysisItem>[] = [
    { header: 'Unit', hide: 'md', cell: (item) => item.unitCode },
    {
      header: 'Rate',
      numeric: true,
      hide: 'lg',
      cell: (item) => formatRate(item.rate),
    },
    {
      header: 'Sanctioned',
      numeric: true,
      hide: 'lg',
      cell: (item) => item.sanctionedQuantity,
    },
    {
      header: 'Supplied',
      numeric: true,
      hide: 'lg',
      cell: (item) => item.deliveredQuantity,
    },
    {
      header: 'Installed',
      numeric: true,
      hide: 'lg',
      cell: (item) => item.installedQuantity,
    },
    {
      header: 'Pending to supply',
      numeric: true,
      cell: (item) => item.pendingSupplyQuantity,
    },
    {
      header: 'Pending to install',
      numeric: true,
      cell: (item) => item.pendingInstallQuantity,
    },
    {
      header: 'Supplied, not installed',
      numeric: true,
      hide: 'md',
      cell: (item) => item.suppliedNotInstalledQuantity,
    },
    {
      header: 'Installed above sanction',
      numeric: true,
      hide: 'md',
      cell: (item) => item.installedAboveSanctionedQuantity,
    },
  ];
  return (
    <section aria-label="Quantity position">
      <h3 className="m-0 text-sm font-medium">Quantity position</h3>
      <ReportTable
        caption="Quantity position per item: sanctioned, supplied, installed, pending to supply, pending to install, and supplied but not installed"
        rows={analysis.items}
        rowKey={(item) => item.workItemId}
        identity={{
          header: 'Item',
          cell: (item) => item.itemNumber,
          second: { header: 'Description', cell: (item) => item.description },
        }}
        columns={chosenColumns(all, columns)}
      />
      {/* No quantity total: this column holds several units, and a sum
          across units is a number no heading repairs. The value table
          below is where the totals belong. */}
      <Hint>
        Quantities are not totalled here: the column spans several units. The value
        table below carries the totals.
      </Hint>
    </section>
  );
}

function WorkValueTable({
  analysis,
  columns,
}: {
  readonly analysis: WorkAnalysisResponse;
  readonly columns: ReadonlySet<string>;
}) {
  const { totals } = analysis;
  const all: readonly ReportColumn<WorkAnalysisItem>[] = [
    {
      header: 'Sanctioned',
      numeric: true,
      hide: 'lg',
      cell: (item) => formatInr(item.sanctionedValue),
      total: formatInr(totals.sanctionedValue),
    },
    {
      header: 'Supplied',
      numeric: true,
      hide: 'lg',
      cell: (item) => formatInr(item.deliveredValue),
      total: formatInr(totals.deliveredValue),
    },
    {
      header: 'Installed',
      numeric: true,
      hide: 'lg',
      cell: (item) => formatInr(item.installedValue),
      total: formatInr(totals.installedValue),
    },
    {
      header: 'Pending to supply',
      numeric: true,
      cell: (item) => formatInr(item.pendingSupplyValue),
      total: <strong>{formatInr(totals.pendingSupplyValue)}</strong>,
    },
    {
      header: 'Pending to install',
      numeric: true,
      cell: (item) => formatInr(item.pendingInstallValue),
      total: <strong>{formatInr(totals.pendingInstallValue)}</strong>,
    },
    {
      header: 'Supplied, not installed',
      numeric: true,
      hide: 'md',
      cell: (item) => formatInr(item.suppliedNotInstalledValue),
      total: formatInr(totals.suppliedNotInstalledValue),
    },
    {
      header: 'Billed',
      numeric: true,
      hide: 'md',
      cell: (item) => formatInr(item.billedValue),
      total: formatInr(totals.billedValue),
    },
    {
      header: 'Unbilled executed',
      numeric: true,
      // A dash, never a zero: an item resolving through no payment-matrix
      // row has no percentage to bill at, which is a different answer
      // from "nothing is owed".
      cell: (item) =>
        item.unbilledExecutedValue === null
          ? '—'
          : formatInr(item.unbilledExecutedValue),
      total: <strong>{formatInr(totals.unbilledExecutedValue)}</strong>,
    },
  ];
  return (
    <section aria-label="Value position">
      <h3 className="m-0 text-sm font-medium">Value position</h3>
      <ReportTable
        caption="Value position per item: sanctioned, supplied, installed, pending to supply, pending to install, billed, and unbilled executed value"
        rows={analysis.items}
        rowKey={(item) => item.workItemId}
        identity={{
          header: 'Item',
          cell: (item) => item.itemNumber,
          second: { header: 'Description', cell: (item) => item.description },
        }}
        columns={chosenColumns(all, columns)}
        identityTotal="Total"
      />
    </section>
  );
}

function WorkInspectionTable({
  analysis,
}: {
  readonly analysis: WorkAnalysisResponse;
}) {
  const clauses = analysis.items.filter((item) => item.inspectionAgency !== null);
  return (
    <section aria-label="Inspection position">
      <h3 className="m-0 text-sm font-medium">Inspection position</h3>
      <Hint>
        Certified is what a live certificate of the clause’s own agency covers — the
        dispatch gate’s own figure, so a RITES certificate never answers an RDSO clause
        and an expired one covers nothing. Pending to inspect is the sanctioned quantity
        less that. The lot size is the contract’s inspecting lot, offered when a call is
        raised; the gate never reads it.
      </Hint>
      {clauses.length === 0 ? (
        <EmptyState>
          No item on this Work carries an inspection clause. Clauses are set on the
          Work’s Inspection tab.
        </EmptyState>
      ) : (
        <DataTable>
          <caption className="sr-only">
            Inspection position per item: agency, whether it gates despatch, lot size,
            called, certified under a live certificate, and pending to inspect
          </caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Description</th>
              <th scope="col">Agency</th>
              <th className="hidden lg:table-cell" scope="col">
                Gates despatch
              </th>
              <th className={`${numericCell} hidden lg:table-cell`} scope="col">
                Lot size
              </th>
              <th className={`${numericCell} hidden md:table-cell`} scope="col">
                Called
              </th>
              <th className={numericCell} scope="col">
                Certified (live)
              </th>
              <th className={numericCell} scope="col">
                Pending to inspect
              </th>
              <th className={numericCell} scope="col">
                Pending value
              </th>
            </tr>
          </thead>
          <tbody>
            {clauses.map((item) => (
              <tr key={item.workItemId}>
                <th scope="row">{item.itemNumber}</th>
                <td className={wrapCell}>{item.description}</td>
                <td>{item.inspectionAgency}</td>
                <td className="hidden lg:table-cell">
                  {item.gatesDispatch ? 'Yes' : 'No'}
                </td>
                <td className={`${numericCell} hidden lg:table-cell`}>
                  {item.inspectionLotSize ?? '—'}
                </td>
                <td className={`${numericCell} hidden md:table-cell`}>
                  {item.inspectionCalledQuantity}
                </td>
                <td className={numericCell}>{item.inspectionCertifiedQuantity}</td>
                <td className={numericCell}>{item.pendingInspectionQuantity ?? '—'}</td>
                <td className={numericCell}>
                  {item.pendingInspectionValue === null
                    ? '—'
                    : formatInr(item.pendingInspectionValue)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {analysis.inspection.map((group) => (
              <tr key={group.agency ?? 'none'}>
                <th scope="row" colSpan={4}>
                  {group.agency ?? 'No clause'} · {group.itemCount} item(s)
                </th>
                <td className={`${numericCell} hidden lg:table-cell`}>
                  {group.lotSizeTotal}
                </td>
                <td className={`${numericCell} hidden md:table-cell`}>
                  {group.calledQuantity}
                </td>
                <td className={numericCell}>{group.certifiedQuantity}</td>
                <td className={numericCell}>{group.pendingQuantity}</td>
                <td className={numericCell}>{formatInr(group.pendingValue)}</td>
              </tr>
            ))}
          </tfoot>
        </DataTable>
      )}
    </section>
  );
}

function WorkPaymentTable({ analysis }: { readonly analysis: WorkAnalysisResponse }) {
  const { payment } = analysis;
  return (
    <section aria-label="Payment position">
      <h3 className="m-0 text-sm font-medium">Payment position</h3>
      <Hint>
        Per bill, never per item: a receipt settles a bill, and a bill closes a
        Measurement Book covering many items. The reference is the railway’s own figure,
        and a deduction counts as settled — money the railway kept is not money it still
        owes. Historical and imported invoices are excluded.
      </Hint>
      {analysis.bills.length === 0 ? (
        <EmptyState>No bill has been raised on this Work.</EmptyState>
      ) : (
        <DataTable>
          <caption className="sr-only">
            Bills on this Work with the prepared amount, the railway’s figure, received,
            deducted and outstanding
          </caption>
          <thead>
            <tr>
              <th scope="col">Bill</th>
              <th className="hidden md:table-cell" scope="col">
                Status
              </th>
              <th className={`${numericCell} hidden lg:table-cell`} scope="col">
                Prepared
              </th>
              <th className={numericCell} scope="col">
                Railway’s figure
              </th>
              <th className={numericCell} scope="col">
                Received
              </th>
              <th className={`${numericCell} hidden md:table-cell`} scope="col">
                Deducted
              </th>
              <th className={numericCell} scope="col">
                Outstanding
              </th>
            </tr>
          </thead>
          <tbody>
            {analysis.bills.map((bill) => (
              <tr key={bill.billId}>
                <th scope="row">{bill.billNumber}</th>
                <td className="hidden md:table-cell">{bill.status}</td>
                <td className={`${numericCell} hidden lg:table-cell`}>
                  {formatInr(bill.preparedAmount)}
                </td>
                <td className={numericCell}>
                  {bill.railwayBillAmount === null
                    ? '—'
                    : formatInr(bill.railwayBillAmount)}
                </td>
                <td className={numericCell}>{formatInr(bill.receivedTotal)}</td>
                <td className={`${numericCell} hidden md:table-cell`}>
                  {formatInr(bill.deductionTotal)}
                </td>
                <td className={numericCell}>
                  {bill.outstandingAmount === null
                    ? '—'
                    : formatInr(bill.outstandingAmount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                {payment.billCount} bill(s)
                {payment.indeterminateBills > 0
                  ? `, ${payment.indeterminateBills} awaiting a railway figure`
                  : ''}
              </th>
              <td className={`${numericCell} hidden lg:table-cell`} />
              <td className={numericCell}>{formatInr(payment.railwayTotal)}</td>
              <td className={numericCell}>{formatInr(payment.receivedTotal)}</td>
              <td className={`${numericCell} hidden md:table-cell`}>
                {formatInr(payment.deductionTotal)}
              </td>
              <td className={numericCell}>
                <strong>{formatInr(payment.outstandingTotal)}</strong>
              </td>
            </tr>
          </tfoot>
        </DataTable>
      )}
    </section>
  );
}

/* --- reports B and C: combined pending -------------------------------- */

/** The rate column of a combined row. Equal bounds print as one figure; a
 * spread prints as a range, because the lines under the row carry different
 * accepted rates and a single number would invent one. */
function rateText(low: string, high: string): string {
  return low === high ? formatRate(low) : `${formatRate(low)} – ${formatRate(high)}`;
}

function pendingColumns(
  total: CombinedPendingTotals | undefined,
): readonly ReportColumn<CombinedPendingRow>[] {
  return [
    {
      header: 'Group',
      hide: 'lg',
      cell: (row) =>
        row.groupName ?? (row.canonicalItemId === null ? 'Not mapped' : '—'),
    },
    { header: 'Unit', cell: (row) => row.unitCode },
    {
      header: 'Rate',
      numeric: true,
      hide: 'md',
      cell: (row) => rateText(row.rateLow, row.rateHigh),
    },
    // Never totalled: one Work appears under many rows, so a sum here
    // would count that Work once per product.
    { header: 'Works', numeric: true, hide: 'md', cell: (row) => row.workCount },
    {
      header: 'Lines',
      numeric: true,
      hide: 'lg',
      cell: (row) => row.lineCount,
      ...(total === undefined ? {} : { total: String(total.lineCount) }),
    },
    {
      header: 'Sanctioned',
      numeric: true,
      hide: 'lg',
      cell: (row) => row.sanctionedQuantity,
    },
    {
      header: 'Supplied',
      numeric: true,
      hide: 'lg',
      cell: (row) => row.deliveredQuantity,
    },
    {
      header: 'Installed',
      numeric: true,
      hide: 'lg',
      cell: (row) => row.installedQuantity,
    },
    {
      header: 'Pending to supply',
      numeric: true,
      cell: (row) => row.pendingSupplyQuantity,
    },
    {
      header: 'Pending supply value',
      numeric: true,
      cell: (row) => formatInr(row.pendingSupplyValue),
      ...(total === undefined
        ? {}
        : { total: <strong>{formatInr(total.pendingSupplyValue)}</strong> }),
    },
    {
      header: 'Pending to install',
      numeric: true,
      hide: 'md',
      cell: (row) => row.pendingInstallQuantity,
    },
    {
      header: 'Pending install value',
      numeric: true,
      hide: 'md',
      cell: (row) => formatInr(row.pendingInstallValue),
      ...(total === undefined
        ? {}
        : { total: <strong>{formatInr(total.pendingInstallValue)}</strong> }),
    },
  ];
}

function PendingTable({
  caption,
  rows,
  total,
  empty,
  columns,
}: {
  readonly caption: string;
  readonly rows: readonly CombinedPendingRow[];
  /** This table's OWN totals. A table shown its neighbour's total is a
   * table whose rows do not add up to the figure under them. */
  readonly total?: CombinedPendingTotals;
  readonly empty: string;
  readonly columns: ReadonlySet<string>;
}) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <ReportTable
      caption={caption}
      rows={rows}
      rowKey={(row) => `${row.canonicalItemId ?? row.label}:${row.unitCode}`}
      identity={{ header: 'Item', cell: (row) => row.label }}
      identityWrap
      columns={chosenColumns(pendingColumns(total), columns)}
      {...(total === undefined
        ? {}
        : {
            // The count is a LABELLED fact in the row header rather than a
            // figure under the Works column, for the reason above.
            identityTotal: `Total · ${String(total.rowCount)} row(s), ${String(total.lineCount)} line(s)`,
          })}
    />
  );
}

/** The grouping rule, said once and shown wherever a combined row is. */
function GroupingHint() {
  return (
    <Hint>
      Lines combine only where an item-master mapping exists — a description equal to a
      master item’s name or one of its aliases. Nothing is merged on resemblance. A
      master item quantified in two units gets two rows, and where the lines carry
      different accepted rates the rate shows as a range.
    </Hint>
  );
}

function DivisionAnalysisCard({
  api,
  organisationId,
  division,
  columns,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly division: string | null;
  readonly columns: ReadonlySet<string>;
}) {
  const [analysis, setAnalysis] = useState<DivisionAnalysisResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    setLoadError(null);
    api
      .divisionAnalysis(organisationId)
      .then((loaded) => {
        if (!cancelled) setAnalysis(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLoadError(describeRefusal(cause, 'The division analysis').message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  /* Narrowed on the response, exactly as `routes/works-analysis.ts`
     narrows the document: one read groups every division, and the choice
     is which heading to read. */
  const shown =
    division === null
      ? (analysis?.divisions ?? [])
      : (analysis?.divisions ?? []).filter(
          (entry) => (entry.divisionCode ?? NO_DIVISION) === division,
        );

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="text-base leading-snug font-medium">Division analysis</h2>
          <p className="text-sm text-muted-foreground">
            A Work’s division is derived from the division codes on its own consignee
            contacts; a Work whose consignees carry more than one is listed under “no
            division on record” rather than filed under a guess.
          </p>
        </div>
      </CardHeader>
      <ReportDocuments
        api={api}
        organisationId={organisationId}
        report="division"
        columns={columns}
        {...(division === null ? {} : { division })}
      />
      <GroupingHint />
      {loadError !== null && (
        <ErrorState onRetry={retry} retryLabel="Retry the division analysis">
          {loadError}
        </ErrorState>
      )}
      {loadError === null && analysis === null && (
        <LoadingState label="the division analysis" rows={6} columns={6} />
      )}
      {analysis !== null && shown.length === 0 && (
        <EmptyState>
          {division === null
            ? 'No active Work carries a pending quantity. Everything sanctioned has been supplied and installed.'
            : 'Nothing is pending in that division. Run the report across every division to see where the pending position is.'}
        </EmptyState>
      )}
      {shown.map((entry) => (
        <section
          key={entry.divisionCode ?? 'none'}
          aria-label={
            entry.divisionCode === null
              ? 'No division on record'
              : `Division ${entry.divisionCode}`
          }
        >
          <h3 className="m-0 text-sm font-medium">
            {entry.divisionCode === null
              ? 'No division on record'
              : `Division ${entry.divisionCode}`}
          </h3>
          <p className="m-0 text-sm text-muted-foreground">
            {entry.works.length} Work(s):{' '}
            {entry.works.map((work) => work.workCode).join(', ') || '—'}
          </p>
          <PendingTable
            caption={`Pending quantities combined across the Works of ${entry.divisionCode ?? 'no recorded division'}`}
            rows={entry.rows}
            total={entry.totals}
            empty="Nothing is pending across this division’s Works."
            columns={columns}
          />
        </section>
      ))}
    </Card>
  );
}

function MappedItemAnalysisCard({
  api,
  organisationId,
  item,
  columns,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** One item group's key, or null for the whole portfolio. */
  readonly item: string | null;
  readonly columns: ReadonlySet<string>;
}) {
  const [analysis, setAnalysis] = useState<MappedItemAnalysisResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();

  /* Narrowed by the SERVER rather than by filtering the response here,
     which is the difference between this and the division report: a
     division group arrives with its own totals already summed, and one
     item's do not exist until somebody adds the rows up. Nothing on this
     screen adds anything up (AGENTS.md rule 5), so the read takes the key
     and the totals come back this item's own. */
  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    setLoadError(null);
    api
      .mappedItemAnalysis(organisationId, item ?? undefined)
      .then((loaded) => {
        if (!cancelled) setAnalysis(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLoadError(describeRefusal(cause, 'The item analysis').message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, item, loadVersion]);

  const mapped = (analysis?.rows ?? []).filter((row) => row.canonicalItemId !== null);
  const unmapped = (analysis?.rows ?? []).filter((row) => row.canonicalItemId === null);

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="text-base leading-snug font-medium">Item analysis</h2>
          <p className="text-sm text-muted-foreground">
            {item === null
              ? 'Pending quantities combined per item master, across every active Work. This is the whole portfolio’s ordering position for one product.'
              : 'One item, across every active Work. The totals below are this item’s own.'}
          </p>
        </div>
      </CardHeader>
      <ReportDocuments
        api={api}
        organisationId={organisationId}
        report="mapped-item"
        columns={columns}
        {...(item === null ? {} : { item })}
      />
      <GroupingHint />
      {loadError !== null && (
        <ErrorState onRetry={retry} retryLabel="Retry the item analysis">
          {loadError}
        </ErrorState>
      )}
      {loadError === null && analysis === null && (
        <LoadingState label="the item analysis" rows={6} columns={6} />
      )}
      {/* A chosen key is EITHER a master item or one unmapped
          description, never both, so a narrowed report draws the one
          section its rows are in. Both empty means the key matches
          nothing — a stale bookmark, or an item that has since been
          fully supplied. */}
      {analysis !== null && item !== null && analysis.rows.length === 0 && (
        <EmptyState>
          Nothing is pending on that item. Run the report across every item to see where
          the pending position is.
        </EmptyState>
      )}
      {analysis !== null && (
        <>
          {(item === null || mapped.length > 0) && (
            <section aria-label="Mapped items">
              <h3 className="m-0 text-sm font-medium">Mapped items</h3>
              <PendingTable
                caption="Pending quantities combined per item master across every active Work"
                rows={mapped}
                total={analysis.mappedTotals}
                empty="No schedule line maps to an item master yet. Master items and their alternative wordings are recorded on the Masters screen."
                columns={columns}
              />
            </section>
          )}
          {(item === null || unmapped.length > 0) && (
            <section aria-label="Not mapped to an item master">
              <h3 className="m-0 text-sm font-medium">Not mapped to an item master</h3>
              <p className="m-0 text-sm text-muted-foreground">
                {analysis.unmappedLineCount} live schedule line(s) match no active
                master item. They are listed one description at a time and combine with
                nothing, because nothing has yet said they name the same product.
              </p>
              <PendingTable
                caption="Pending quantities of schedule lines that map to no item master"
                rows={unmapped}
                total={analysis.unmappedTotals}
                empty="Every live schedule line maps to an item master."
                columns={columns}
              />
            </section>
          )}
        </>
      )}
    </Card>
  );
}

/* --- the proposals ---------------------------------------------------- */

/**
 * Proposed item groups, and the one control that confirms one.
 *
 * PROPOSE AND PROVE. The list is a read that writes nothing: it holds no
 * state, expires the moment the descriptions change, and disappears when the
 * group is confirmed. Confirming is a POST to the item master — the same
 * control the Masters screen uses — so a confirmed group persists exactly
 * where every other mapping lives, and starts combining in the report above
 * on the next load. There is no third state.
 *
 * It renders UNDER the item analysis and only when that report has been
 * run, because a proposal is only actionable beside the unmapped rows it
 * would combine. On the old stacked screen it was a permanent fourth card
 * that read every schedule line on every visit to Reports.
 */
function ItemGroupProposalsCard({ api, organisationId }: WorksAnalysisPropsBase) {
  const [proposals, setProposals] = useState<ItemGroupProposalsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();
  const { pending, notice, actionError, act } = useAction();

  useEffect(() => {
    let cancelled = false;
    setProposals(null);
    setLoadError(null);
    api
      .itemGroupProposals(organisationId)
      .then((loaded) => {
        if (!cancelled) setProposals(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLoadError(describeRefusal(cause, 'The grouping proposals').message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const confirm = useCallback(
    (proposal: ItemGroupProposal, name: string, groupName: string, unit: string) => {
      /* EVERY wording in the group becomes an alias except the one the
         operator settled on as the name — including the proposed name
         itself when they renamed it.

         Sending `proposal.aliases` alone was a silent hole: the mapping
         matches a description against the name or an alias, so a group
         confirmed under a name of the operator's own left the proposed
         wording matching nothing. The group would confirm and immediately
         stop combining the very lines it was raised about, and the
         proposal would come back on the next load. */
      const wordings = [proposal.proposedName, ...proposal.aliases].filter(
        (wording) => wording.trim().toLowerCase() !== name.trim().toLowerCase(),
      );
      void act(
        async () => {
          await api.saveCanonicalItem(organisationId, null, {
            name,
            groupName,
            defaultUnit: unit,
            aliases: wordings,
          });
          retry();
        },
        `“${name}” is now an item master, and its ${String(wordings.length)} other wording(s) are its aliases.`,
      );
    },
    [act, api, organisationId, retry],
  );

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="text-base leading-snug font-medium">Proposed item groups</h2>
          <p className="text-sm text-muted-foreground">
            Unmapped descriptions that differ only in case, punctuation or spacing.
            These are PROPOSALS: nothing here is written until you confirm it, and
            confirming one records a master item with the other wordings as its aliases.
            Nothing is ever merged on resemblance alone.
          </p>
        </div>
      </CardHeader>

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && <FormError>{actionError}</FormError>}
      {loadError !== null && (
        <ErrorState onRetry={retry} retryLabel="Retry the grouping proposals">
          {loadError}
        </ErrorState>
      )}
      {loadError === null && proposals === null && (
        <LoadingState label="the grouping proposals" rows={3} columns={3} />
      )}
      {proposals?.proposals.length === 0 && (
        <EmptyState>
          No two unmapped descriptions differ only in punctuation or spacing. Anything
          still unmapped needs a master item of its own, on the Masters screen.
        </EmptyState>
      )}
      {proposals?.proposals.map((proposal) => (
        <ProposalForm
          key={proposal.key}
          proposal={proposal}
          pending={pending}
          onConfirm={confirm}
        />
      ))}
    </Card>
  );
}

interface WorksAnalysisPropsBase {
  readonly api: ApiClient;
  readonly organisationId: string;
}

function ProposalForm({
  proposal,
  pending,
  onConfirm,
}: {
  readonly proposal: ItemGroupProposal;
  readonly pending: boolean;
  readonly onConfirm: (
    proposal: ItemGroupProposal,
    name: string,
    groupName: string,
    unit: string,
  ) => void;
}) {
  const nameId = `proposal-name-${proposal.key}`;
  const groupId = `proposal-group-${proposal.key}`;
  const unitId = `proposal-unit-${proposal.key}`;
  return (
    <form
      className="flex flex-col gap-3 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onConfirm(
          proposal,
          formValue(data, nameId),
          formValue(data, groupId),
          formValue(data, unitId),
        );
      }}
    >
      <p className="m-0 text-sm">
        {proposal.lineCount} line(s) across {proposal.workCount} Work(s), rate{' '}
        {rateText(proposal.rateLow, proposal.rateHigh)}
        {proposal.unitCodes.length > 1 && (
          <>
            {' '}
            · <strong>units differ: {proposal.unitCodes.join(', ')}</strong>
          </>
        )}
      </p>
      <ul className="m-0 list-disc pl-5 text-sm text-muted-foreground">
        {[proposal.proposedName, ...proposal.aliases].map((wording) => (
          <li key={wording}>{wording}</li>
        ))}
      </ul>
      {proposal.unitCodes.length > 1 && (
        <FormError>
          These lines are quantified in different units, so they may not be the same
          product. Check before confirming — a master item has one default unit, and the
          report never adds quantities across units.
        </FormError>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field>
          <label htmlFor={nameId}>Item name</label>
          {/* A master item's name is capped at 200 in the database, and a
              schedule description has no ceiling at all — so the prefill is
              trimmed to fit and the FULL wording travels as an alias, which
              is the half the mapping actually reads. */}
          <input
            id={nameId}
            name={nameId}
            required
            minLength={2}
            maxLength={200}
            defaultValue={proposal.proposedName.slice(0, 200)}
          />
        </Field>
        <Field>
          <label htmlFor={groupId}>Group</label>
          <input id={groupId} name={groupId} required minLength={2} maxLength={100} />
        </Field>
        <Field>
          <label htmlFor={unitId}>Default unit</label>
          <input
            id={unitId}
            name={unitId}
            required
            maxLength={20}
            defaultValue={proposal.unitCodes[0] ?? ''}
          />
        </Field>
        <Button type="submit" variant="outline" disabled={pending}>
          Confirm this group
        </Button>
      </div>
    </form>
  );
}
