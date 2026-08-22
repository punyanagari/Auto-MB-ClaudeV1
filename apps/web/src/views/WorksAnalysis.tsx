import { useCallback, useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type {
  CombinedPendingRow,
  DivisionAnalysisResponse,
  ItemGroupProposal,
  ItemGroupProposalsResponse,
  MappedItemAnalysisResponse,
  Work,
  WorkAnalysisResponse,
  WorksAnalysisReport,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatInr, formatRate } from '../format.js';
import { describeRefusal } from '../lib/load-failure.js';
import { openPdf } from '../lib/openPdf.js';
import { useAction, useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { DownloadButton } from '../ui/download-button.js';
import { Field, FormError, FormNotice, Hint } from '../ui/form.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * Works analysis: three reports under the Reports screen.
 *
 * `packages/contracts/src/works-analysis.ts` states what every figure means
 * and which sources are in it. NOTHING ON THIS SCREEN ADDS ANYTHING UP:
 * every number below is a decimal string the server summed in PostgreSQL,
 * printed through `formatInr` or verbatim. The rule is `views/Mis.tsx`'s and
 * `AGENTS.md` rule 5's, and it matters more here than anywhere else in the
 * product, because these tables exist to be totalled.
 *
 * ## Three cards, three loads
 *
 * Each report loads and fails on its own. They read different ledgers and an
 * operator wants the division position whether or not the item master is in
 * a state to answer, so one refusal must not blank the other two — which is
 * the failure the management summary above them has, where a single load
 * carries the whole screen.
 *
 * ## Column priority
 *
 * The pending tables are eleven columns wide, which no phone renders. The
 * ones an operator ordering material can lose first — the sanctioned,
 * supplied and installed positions, which are context for the pending
 * figure rather than the figure — hide below `lg`; the rate spread and the
 * line counts hide below `md`. What survives at every width is the item,
 * the unit, what is pending, and what it is worth.
 */

interface WorksAnalysisProps {
  readonly api: ApiClient;
  readonly organisationId: string;
}

/** The three report names, so a document control cannot name one the server
 * does not answer to. */
const REPORT_LABEL: Readonly<Record<WorksAnalysisReport, string>> = {
  work: 'Work analysis',
  division: 'Division analysis',
  'mapped-item': 'Item analysis',
};

export function WorksAnalysis({ api, organisationId }: WorksAnalysisProps) {
  return (
    <>
      <WorkAnalysisCard api={api} organisationId={organisationId} />
      <DivisionAnalysisCard api={api} organisationId={organisationId} />
      <MappedItemAnalysisCard api={api} organisationId={organisationId} />
      <ItemGroupProposalsCard api={api} organisationId={organisationId} />
    </>
  );
}

/** The two document controls every report carries: the page to read and the
 * workbook to work in. A PDF is OPENED and a workbook is SAVED — the
 * distinction `lib/download.ts` records, applied here rather than
 * re-argued. */
function ReportDocuments({
  api,
  organisationId,
  report,
  workId,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly report: WorksAnalysisReport;
  readonly workId?: string;
}) {
  const { pending, notice, actionError, act } = useAction();
  const options = workId === undefined ? {} : { workId };
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

/* --- report A: one Work ---------------------------------------------- */

function WorkAnalysisCard({ api, organisationId }: WorksAnalysisProps) {
  const [works, setWorks] = useState<readonly Work[] | null>(null);
  const [workId, setWorkId] = useState<string>('');
  const [analysis, setAnalysis] = useState<WorkAnalysisResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    api
      .listWorks(organisationId)
      .then((loaded) => {
        if (cancelled) return;
        setWorks(loaded);
        // The first Work rather than an empty select: a report screen that
        // opens showing nothing reads as a report screen with no data.
        setWorkId((current) => (current === '' ? (loaded[0]?.id ?? '') : current));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadError(describeRefusal(cause, 'The Work list').message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  useEffect(() => {
    if (workId === '') return;
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
          <p className="text-sm text-muted-foreground">
            One Work, item by item: what is sanctioned, what has been supplied and
            installed, what is still to supply, install and inspect, and what has been
            billed against it. Every figure is the server’s.
          </p>
        </div>
      </CardHeader>

      <Field>
        <label htmlFor="works-analysis-work">Work</label>
        <select
          id="works-analysis-work"
          value={workId}
          disabled={works === null}
          onChange={(event) => {
            setWorkId(event.target.value);
          }}
        >
          {works === null && <option value="">Loading…</option>}
          {(works ?? []).map((work) => (
            <option key={work.id} value={work.id}>
              {work.workCode} — {work.title}
            </option>
          ))}
        </select>
      </Field>

      {/* Each card names its own retry. Four cards sharing "Try again"
          would give an operator four identical controls and no way to
          tell which outage they are answering. */}
      {loadError !== null && (
        <ErrorState onRetry={retry} retryLabel="Retry the Work analysis">
          {loadError}
        </ErrorState>
      )}

      {loadError === null && works !== null && works.length === 0 && (
        <EmptyState>
          No Work has been recorded yet. A Work analysis is a report on one contract.
        </EmptyState>
      )}

      {loadError === null && workId !== '' && analysis === null && (
        <LoadingState label="the Work analysis" rows={6} columns={6} />
      )}

      {analysis !== null && (
        <>
          <ReportDocuments
            api={api}
            organisationId={organisationId}
            report="work"
            workId={analysis.work.id}
          />
          <WorkFacts analysis={analysis} />
          <WorkQuantityTable analysis={analysis} />
          <WorkValueTable analysis={analysis} />
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

function WorkQuantityTable({ analysis }: { readonly analysis: WorkAnalysisResponse }) {
  return (
    <section aria-label="Quantity position">
      <h3 className="m-0 text-sm font-medium">Quantity position</h3>
      <DataTable>
        <caption className="sr-only">
          Quantity position per item: sanctioned, supplied, installed, pending to
          supply, pending to install, and supplied but not installed
        </caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Description</th>
            <th className="hidden md:table-cell" scope="col">
              Unit
            </th>
            <th className={`${numericCell} hidden lg:table-cell`} scope="col">
              Rate
            </th>
            <th className={`${numericCell} hidden lg:table-cell`} scope="col">
              Sanctioned
            </th>
            <th className={`${numericCell} hidden lg:table-cell`} scope="col">
              Supplied
            </th>
            <th className={`${numericCell} hidden lg:table-cell`} scope="col">
              Installed
            </th>
            <th className={numericCell} scope="col">
              Pending to supply
            </th>
            <th className={numericCell} scope="col">
              Pending to install
            </th>
            <th className={`${numericCell} hidden md:table-cell`} scope="col">
              Supplied, not installed
            </th>
            <th className={`${numericCell} hidden md:table-cell`} scope="col">
              Installed above sanction
            </th>
          </tr>
        </thead>
        <tbody>
          {analysis.items.map((item) => (
            <tr key={item.workItemId}>
              <th scope="row">{item.itemNumber}</th>
              <td className={wrapCell}>{item.description}</td>
              <td className="hidden md:table-cell">{item.unitCode}</td>
              <td className={`${numericCell} hidden lg:table-cell`}>
                {formatRate(item.rate)}
              </td>
              <td className={`${numericCell} hidden lg:table-cell`}>
                {item.sanctionedQuantity}
              </td>
              <td className={`${numericCell} hidden lg:table-cell`}>
                {item.deliveredQuantity}
              </td>
              <td className={`${numericCell} hidden lg:table-cell`}>
                {item.installedQuantity}
              </td>
              <td className={numericCell}>{item.pendingSupplyQuantity}</td>
              <td className={numericCell}>{item.pendingInstallQuantity}</td>
              <td className={`${numericCell} hidden md:table-cell`}>
                {item.suppliedNotInstalledQuantity}
              </td>
              <td className={`${numericCell} hidden md:table-cell`}>
                {item.installedAboveSanctionedQuantity}
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
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

function WorkValueTable({ analysis }: { readonly analysis: WorkAnalysisResponse }) {
  const { totals } = analysis;
  return (
    <section aria-label="Value position">
      <h3 className="m-0 text-sm font-medium">Value position</h3>
      <DataTable>
        <caption className="sr-only">
          Value position per item: sanctioned, supplied, installed, pending to supply,
          pending to install, billed, and unbilled executed value
        </caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Description</th>
            <th className={`${numericCell} hidden lg:table-cell`} scope="col">
              Sanctioned
            </th>
            <th className={`${numericCell} hidden lg:table-cell`} scope="col">
              Supplied
            </th>
            <th className={`${numericCell} hidden lg:table-cell`} scope="col">
              Installed
            </th>
            <th className={numericCell} scope="col">
              Pending to supply
            </th>
            <th className={numericCell} scope="col">
              Pending to install
            </th>
            <th className={`${numericCell} hidden md:table-cell`} scope="col">
              Billed
            </th>
            <th className={numericCell} scope="col">
              Unbilled executed
            </th>
          </tr>
        </thead>
        <tbody>
          {analysis.items.map((item) => (
            <tr key={item.workItemId}>
              <th scope="row">{item.itemNumber}</th>
              <td className={wrapCell}>{item.description}</td>
              <td className={`${numericCell} hidden lg:table-cell`}>
                {formatInr(item.sanctionedValue)}
              </td>
              <td className={`${numericCell} hidden lg:table-cell`}>
                {formatInr(item.deliveredValue)}
              </td>
              <td className={`${numericCell} hidden lg:table-cell`}>
                {formatInr(item.installedValue)}
              </td>
              <td className={numericCell}>{formatInr(item.pendingSupplyValue)}</td>
              <td className={numericCell}>{formatInr(item.pendingInstallValue)}</td>
              <td className={`${numericCell} hidden md:table-cell`}>
                {formatInr(item.billedValue)}
              </td>
              <td className={numericCell}>
                {item.unbilledExecutedValue === null
                  ? '—'
                  : formatInr(item.unbilledExecutedValue)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              Total
            </th>
            <td className={`${numericCell} hidden lg:table-cell`}>
              {formatInr(totals.sanctionedValue)}
            </td>
            <td className={`${numericCell} hidden lg:table-cell`}>
              {formatInr(totals.deliveredValue)}
            </td>
            <td className={`${numericCell} hidden lg:table-cell`}>
              {formatInr(totals.installedValue)}
            </td>
            <td className={numericCell}>
              <strong>{formatInr(totals.pendingSupplyValue)}</strong>
            </td>
            <td className={numericCell}>
              <strong>{formatInr(totals.pendingInstallValue)}</strong>
            </td>
            <td className={`${numericCell} hidden md:table-cell`}>
              {formatInr(totals.billedValue)}
            </td>
            <td className={numericCell}>
              <strong>{formatInr(totals.unbilledExecutedValue)}</strong>
            </td>
          </tr>
        </tfoot>
      </DataTable>
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
      {clauses.length === 0 ? (
        <EmptyState>
          No item on this Work carries an inspection clause. Clauses are set on the
          Work’s Inspection tab.
        </EmptyState>
      ) : (
        <DataTable>
          <caption className="sr-only">
            Inspection position per item: agency, clause quantity, called, passed, and
            pending to inspect
          </caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Description</th>
              <th scope="col">Agency</th>
              <th className={`${numericCell} hidden md:table-cell`} scope="col">
                Clause quantity
              </th>
              <th className={`${numericCell} hidden lg:table-cell`} scope="col">
                Called
              </th>
              <th className={`${numericCell} hidden lg:table-cell`} scope="col">
                Passed
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
                <td className={`${numericCell} hidden md:table-cell`}>
                  {item.inspectionQuantity ?? '—'}
                </td>
                <td className={`${numericCell} hidden lg:table-cell`}>
                  {item.inspectionCalledQuantity}
                </td>
                <td className={`${numericCell} hidden lg:table-cell`}>
                  {item.inspectionPassedQuantity}
                </td>
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
                <th scope="row" colSpan={3}>
                  {group.agency ?? 'No clause'} · {group.itemCount} item(s)
                </th>
                <td className={`${numericCell} hidden md:table-cell`}>
                  {group.clauseQuantity}
                </td>
                <td className={`${numericCell} hidden lg:table-cell`}>
                  {group.calledQuantity}
                </td>
                <td className={`${numericCell} hidden lg:table-cell`}>
                  {group.passedQuantity}
                </td>
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

function PendingTable({
  caption,
  rows,
  total,
  empty,
}: {
  readonly caption: string;
  readonly rows: readonly CombinedPendingRow[];
  readonly total?: { readonly supply: string; readonly install: string };
  readonly empty: string;
}) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <DataTable>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th className="hidden lg:table-cell" scope="col">
            Group
          </th>
          <th scope="col">Unit</th>
          <th className={`${numericCell} hidden md:table-cell`} scope="col">
            Rate
          </th>
          <th className={`${numericCell} hidden md:table-cell`} scope="col">
            Works
          </th>
          <th className={`${numericCell} hidden lg:table-cell`} scope="col">
            Sanctioned
          </th>
          <th className={`${numericCell} hidden lg:table-cell`} scope="col">
            Supplied
          </th>
          <th className={`${numericCell} hidden lg:table-cell`} scope="col">
            Installed
          </th>
          <th className={numericCell} scope="col">
            Pending to supply
          </th>
          <th className={numericCell} scope="col">
            Pending supply value
          </th>
          <th className={`${numericCell} hidden md:table-cell`} scope="col">
            Pending to install
          </th>
          <th className={`${numericCell} hidden md:table-cell`} scope="col">
            Pending install value
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.canonicalItemId ?? row.label}:${row.unitCode}`}>
            <th className={wrapCell} scope="row">
              {row.label}
            </th>
            <td className="hidden lg:table-cell">
              {row.groupName ?? (row.canonicalItemId === null ? 'Not mapped' : '—')}
            </td>
            <td>{row.unitCode}</td>
            <td className={`${numericCell} hidden md:table-cell`}>
              {rateText(row.rateLow, row.rateHigh)}
            </td>
            <td className={`${numericCell} hidden md:table-cell`}>{row.workCount}</td>
            <td className={`${numericCell} hidden lg:table-cell`}>
              {row.sanctionedQuantity}
            </td>
            <td className={`${numericCell} hidden lg:table-cell`}>
              {row.deliveredQuantity}
            </td>
            <td className={`${numericCell} hidden lg:table-cell`}>
              {row.installedQuantity}
            </td>
            <td className={numericCell}>{row.pendingSupplyQuantity}</td>
            <td className={numericCell}>{formatInr(row.pendingSupplyValue)}</td>
            <td className={`${numericCell} hidden md:table-cell`}>
              {row.pendingInstallQuantity}
            </td>
            <td className={`${numericCell} hidden md:table-cell`}>
              {formatInr(row.pendingInstallValue)}
            </td>
          </tr>
        ))}
      </tbody>
      {total !== undefined && (
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>
              Total
            </th>
            <td className={`${numericCell} hidden md:table-cell`} />
            <td className={`${numericCell} hidden md:table-cell`} />
            <td className={`${numericCell} hidden lg:table-cell`} />
            <td className={`${numericCell} hidden lg:table-cell`} />
            <td className={`${numericCell} hidden lg:table-cell`} />
            <td className={numericCell} />
            <td className={numericCell}>
              <strong>{formatInr(total.supply)}</strong>
            </td>
            <td className={`${numericCell} hidden md:table-cell`} />
            <td className={`${numericCell} hidden md:table-cell`}>
              <strong>{formatInr(total.install)}</strong>
            </td>
          </tr>
        </tfoot>
      )}
    </DataTable>
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

function DivisionAnalysisCard({ api, organisationId }: WorksAnalysisProps) {
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

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="text-base leading-snug font-medium">Division analysis</h2>
          <p className="text-sm text-muted-foreground">
            Pending quantities combined across the active Works of each railway
            division, so one order can cover a division. A Work’s division is derived
            from the division codes on its own consignee contacts; a Work whose
            consignees carry more than one is listed under “no division on record”
            rather than filed under a guess.
          </p>
        </div>
      </CardHeader>
      <ReportDocuments api={api} organisationId={organisationId} report="division" />
      <GroupingHint />
      {loadError !== null && (
        <ErrorState onRetry={retry} retryLabel="Retry the division analysis">
          {loadError}
        </ErrorState>
      )}
      {loadError === null && analysis === null && (
        <LoadingState label="the division analysis" rows={6} columns={6} />
      )}
      {analysis?.divisions.length === 0 && (
        <EmptyState>
          No active Work carries a pending quantity. Everything sanctioned has been
          supplied and installed.
        </EmptyState>
      )}
      {analysis?.divisions.map((division) => (
        <section
          key={division.divisionCode ?? 'none'}
          aria-label={
            division.divisionCode === null
              ? 'No division on record'
              : `Division ${division.divisionCode}`
          }
        >
          <h3 className="m-0 text-sm font-medium">
            {division.divisionCode === null
              ? 'No division on record'
              : `Division ${division.divisionCode}`}
          </h3>
          <p className="m-0 text-sm text-muted-foreground">
            {division.works.length} Work(s):{' '}
            {division.works.map((work) => work.workCode).join(', ') || '—'}
          </p>
          <PendingTable
            caption={`Pending quantities combined across the Works of ${division.divisionCode ?? 'no recorded division'}`}
            rows={division.rows}
            total={{
              supply: division.totals.pendingSupplyValue,
              install: division.totals.pendingInstallValue,
            }}
            empty="Nothing is pending across this division’s Works."
          />
        </section>
      ))}
    </Card>
  );
}

function MappedItemAnalysisCard({ api, organisationId }: WorksAnalysisProps) {
  const [analysis, setAnalysis] = useState<MappedItemAnalysisResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    setLoadError(null);
    api
      .mappedItemAnalysis(organisationId)
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
  }, [api, organisationId, loadVersion]);

  const mapped = (analysis?.rows ?? []).filter((row) => row.canonicalItemId !== null);
  const unmapped = (analysis?.rows ?? []).filter((row) => row.canonicalItemId === null);

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="text-base leading-snug font-medium">Item analysis</h2>
          <p className="text-sm text-muted-foreground">
            Pending quantities combined per item master, across every active Work. This
            is the whole portfolio’s ordering position for one product.
          </p>
        </div>
      </CardHeader>
      <ReportDocuments api={api} organisationId={organisationId} report="mapped-item" />
      <GroupingHint />
      {loadError !== null && (
        <ErrorState onRetry={retry} retryLabel="Retry the item analysis">
          {loadError}
        </ErrorState>
      )}
      {loadError === null && analysis === null && (
        <LoadingState label="the item analysis" rows={6} columns={6} />
      )}
      {analysis !== null && (
        <>
          <section aria-label="Mapped items">
            <h3 className="m-0 text-sm font-medium">Mapped items</h3>
            <PendingTable
              caption="Pending quantities combined per item master across every active Work"
              rows={mapped}
              total={{
                supply: analysis.totals.pendingSupplyValue,
                install: analysis.totals.pendingInstallValue,
              }}
              empty="No schedule line maps to an item master yet. Master items and their alternative wordings are recorded on the Masters screen."
            />
          </section>
          <section aria-label="Not mapped to an item master">
            <h3 className="m-0 text-sm font-medium">Not mapped to an item master</h3>
            <p className="m-0 text-sm text-muted-foreground">
              {analysis.unmappedLineCount} live schedule line(s) match no active master
              item. They are listed one description at a time and combine with nothing,
              because nothing has yet said they name the same product.
            </p>
            <PendingTable
              caption="Pending quantities of schedule lines that map to no item master"
              rows={unmapped}
              empty="Every live schedule line maps to an item master."
            />
          </section>
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
 */
function ItemGroupProposalsCard({ api, organisationId }: WorksAnalysisProps) {
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
      void act(
        async () => {
          await api.saveCanonicalItem(organisationId, null, {
            name,
            groupName,
            defaultUnit: unit,
            aliases: proposal.aliases,
          });
          retry();
        },
        `“${name}” is now an item master, and its ${String(proposal.aliases.length)} other wording(s) are its aliases.`,
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
          <input
            id={nameId}
            name={nameId}
            required
            minLength={2}
            maxLength={200}
            defaultValue={proposal.proposedName}
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
