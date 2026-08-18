import { useEffect, useState } from 'react';
import { ArrowRight, IndianRupee, Search } from 'lucide-react';
import { BILL_DEDUCTION_HEAD_RULES } from '@auto-mb/contracts';
import type {
  BillDeductionCategory,
  ReceivablesRegisterEntry,
  ReceivablesRegisterSummary,
} from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formatDate, formatInr, formatTimestampDate } from '../format.js';
import { describeLoadFailure } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { navigateOnClick, workHash } from '../lib/workspace-routes.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { PageHeader } from '../ui/page-header.js';
import { Sheet } from '../ui/sheet.js';
import { Stat } from '../ui/stat.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * The railway receivables register.
 *
 * Replicates `app/receivables/page.tsx` and
 * `components/railway-receivables-workspace.tsx` of the mock at fdfd610:
 * four stat tiles over a card holding a search box, three filter selects
 * and the bill table, with a right-hand sheet carrying the deduction
 * waterfall and the lifecycle strip.
 *
 * Three places the mock's data model and this product's disagree, resolved
 * towards the product in the mock's own visual grammar:
 *
 *   * **The mock's stages are `submitted → passed → paid`.** The product's
 *     bill status is `prepared → submitted → paid`, and "passed" is not a
 *     status at all — it is the railway's own On-Account Bill arriving and
 *     closing the Measurement Book, which is what gives the position an
 *     agreed figure. So the chip reads the real status and the lifecycle
 *     strip reads the three real events. All three words are already in
 *     the product's status vocabulary (`docs/DESIGN.md` § Status badge
 *     semantics), so nothing is added to the tone map for this screen.
 *   * **The mock advances a bill from its sheet with one button.** A real
 *     receipt is a date, a credited amount, a reference and up to seven
 *     statutory heads, and that form already exists on the Work's Bills
 *     tab (`views/WorkBillSettlement.tsx`) with its own validation and its
 *     own withdrawal path. The sheet links to it rather than carrying a
 *     second copy of a money form.
 *   * **Money is exact, not compact.** The mock prints
 *     `formatINR(value, true)` — crore-rounded — everywhere. This is the
 *     screen an operator chases a payment from, and `₹3.74 Cr` is not a
 *     figure anyone takes to a railway finance office. The recorded
 *     precedent is the unbillable-variation exposure panel
 *     (`views/MeasurementBooks.tsx`): exact decimal strings for money an
 *     operator acts on. Every figure here is the server's own string
 *     through `formatInr`.
 *
 * Nothing on this page adds money up. The waterfall's heads, its net
 * payable and the four tiles are all summed in SQL and arrive as decimal
 * strings (`routes/bill-payments.ts`).
 */

const CATEGORY_LABELS: Record<BillDeductionCategory, string> = Object.fromEntries(
  BILL_DEDUCTION_HEAD_RULES.map((rule) => [rule.head, rule.label]),
) as Record<BillDeductionCategory, string>;

/** The filter's status options, in lifecycle order rather than
 * alphabetical — the register is read as a pipeline. */
const STATUS_FILTERS = ['all', 'prepared', 'submitted', 'paid'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const ALL = 'all';

/** A bill with no railway bill against it has no financial year yet, and
 * the filter has to be able to say so: "not yet passed" is a real answer
 * to "which year is this in", and the rows it selects are exactly the ones
 * somebody is chasing. */
const UNPASSED = 'unpassed';

interface ReceivablesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly onOpenWork: (workId: string) => void;
}

export function Receivables({ api, organisationId, onOpenWork }: ReceivablesProps) {
  const [entries, setEntries] = useState<readonly ReceivablesRegisterEntry[] | null>(
    null,
  );
  const [summary, setSummary] = useState<ReceivablesRegisterSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [loadVersion, retry] = useReload();
  const [selectedBillId, setSelectedBillId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>(ALL);
  const [work, setWork] = useState<string>(ALL);
  const [financialYear, setFinancialYear] = useState<string>(ALL);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setLoadError(null);
    api
      .listReceivables(organisationId)
      .then((loaded) => {
        if (cancelled) return;
        setEntries(loaded.entries);
        setSummary(loaded.summary);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const failure = describeLoadFailure(cause, 'The receivables register');
        setLoadError(failure.message);
        setRetryable(failure.retryable);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const header = (
    <PageHeader
      eyebrow="Railway finance"
      title="Receivables"
      titleId="receivables-title"
      description="Track Railway bills from submission through passing, deductions and payment receipt. Money the railway kept is settled; only what never arrived is outstanding."
    />
  );

  if (loadError !== null) {
    return (
      <>
        {header}
        {retryable ? (
          <ErrorState onRetry={retry} retryLabel="Retry receivables">
            {loadError}
          </ErrorState>
        ) : (
          <p role="alert" className="m-0 text-sm font-medium text-destructive">
            {loadError}
          </p>
        )}
      </>
    );
  }

  if (entries === null || summary === null) {
    return (
      <>
        {header}
        <LoadingState label="the receivables register" rows={5} columns={4} />
      </>
    );
  }

  const workCodes = [...new Set(entries.map((entry) => entry.workCode))].sort();
  const years = [
    ...new Set(
      entries
        .map((entry) => entry.financialYear)
        .filter((year): year is string => year !== null),
    ),
  ].sort((left, right) => right.localeCompare(left));
  const needle = query.trim().toLowerCase();
  const shown = entries.filter(
    (entry) =>
      (status === ALL || entry.status === status) &&
      (work === ALL || entry.workCode === work) &&
      (financialYear === ALL ||
        (financialYear === UNPASSED
          ? entry.financialYear === null
          : entry.financialYear === financialYear)) &&
      (needle === '' ||
        `${String(entry.billNumber)} ${entry.workCode} ${entry.workTitle} ${
          entry.measurementBookNumber ?? ''
        } ${entry.railwayBillNumber ?? ''}`
          .toLowerCase()
          .includes(needle)),
  );
  const selected = entries.find((entry) => entry.billId === selectedBillId) ?? null;

  return (
    <>
      {header}
      <section aria-labelledby="receivables-title" className="flex flex-col gap-5">
        {/* The mock's four tiles, in its order and with its hints. Every
            figure is the server's, summed over the whole register rather
            than over the rows the filters happen to leave on screen — a
            tile that moved when a filter changed would be answering a
            different question than the one it is labelled with. */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card>
            <Stat
              label="Claimed"
              value={formatInr(summary.claimedTotal)}
              hint={`${String(entries.length)} bills`}
            />
          </Card>
          <Card>
            <Stat
              label="Passed"
              value={formatInr(summary.passedTotal)}
              hint="Acknowledged by the railway"
            />
          </Card>
          <Card>
            <Stat
              label="Received"
              value={formatInr(summary.receivedTotal)}
              hint="Bank credits recorded"
              tone="success"
            />
          </Card>
          <Card>
            <Stat
              label="Outstanding"
              value={formatInr(summary.outstandingTotal)}
              hint="Net of what the railway kept"
            />
          </Card>
        </div>

        <Card className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <label className="sr-only" htmlFor="receivables-search">
                Search receivables
              </label>
              <input
                id="receivables-search"
                className="pl-9"
                placeholder="Search bill, Work or measurement"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                }}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Filter
                id="receivables-status"
                label="Status"
                value={status}
                options={STATUS_FILTERS.map((option) => ({
                  value: option,
                  label: option === ALL ? 'All statuses' : option,
                }))}
                onChange={(value) => {
                  setStatus(value as StatusFilter);
                }}
              />
              <Filter
                id="receivables-work"
                label="Work"
                value={work}
                options={[
                  { value: ALL, label: 'All Works' },
                  ...workCodes.map((code) => ({ value: code, label: code })),
                ]}
                onChange={setWork}
              />
              <Filter
                id="receivables-fy"
                label="Financial year"
                value={financialYear}
                options={[
                  { value: ALL, label: 'All years' },
                  ...years.map((year) => ({ value: year, label: year })),
                  { value: UNPASSED, label: 'Not yet passed' },
                ]}
                onChange={setFinancialYear}
              />
            </div>
          </div>

          {shown.length === 0 ? (
            <EmptyState>
              {entries.length === 0
                ? 'No bill has been prepared yet, so nothing is outstanding with the railway. A bill is prepared from a finalized Measurement Book on the Work it belongs to.'
                : 'No receivable matches those filters.'}
            </EmptyState>
          ) : (
            <DataTable>
              <caption className="sr-only">
                Railway receivables: one row per prepared bill, with what was claimed,
                what the railway passed, and what has been received
              </caption>
              <thead>
                <tr>
                  <th scope="col">Bill</th>
                  <th scope="col">Work / measurement</th>
                  <th scope="col">Status</th>
                  <th scope="col" className={numericCell}>
                    Claimed
                  </th>
                  <th scope="col" className={numericCell}>
                    Passed
                  </th>
                  <th scope="col" className={numericCell}>
                    Received
                  </th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((entry) => (
                  <tr key={entry.billId}>
                    <th scope="row" className="tabular-nums">
                      #{entry.billNumber}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {entry.financialYear === null
                          ? 'Not yet passed'
                          : `FY ${entry.financialYear}`}
                      </span>
                    </th>
                    <td className={wrapCell}>
                      {/* A real anchor with a hash href, not a click
                          handler on a row: middle-click and open-in-new-tab
                          have to work on a register. */}
                      <a
                        href={workHash(entry.workId, 'bills')}
                        onClick={navigateOnClick(() => {
                          onOpenWork(entry.workId);
                        })}
                      >
                        {entry.workCode}
                      </a>
                      <span className="block text-xs text-muted-foreground">
                        {entry.measurementBookNumber ?? 'No measurement linked'}
                      </span>
                    </td>
                    <td>
                      <StatusChip status={entry.status}>{entry.status}</StatusChip>
                    </td>
                    <td className={numericCell}>{formatInr(entry.preparedAmount)}</td>
                    <td className={numericCell}>
                      {entry.railwayBillAmount === null
                        ? '—'
                        : formatInr(entry.railwayBillAmount)}
                    </td>
                    <td className={numericCell}>{formatInr(entry.receivedTotal)}</td>
                    <td>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setSelectedBillId(entry.billId);
                        }}
                      >
                        <ArrowRight data-icon="inline-start" aria-hidden="true" />
                        Open
                        <span className="sr-only"> bill {entry.billNumber}</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>
      </section>

      {selected !== null && (
        <BillSheet
          entry={selected}
          onClose={() => {
            setSelectedBillId(null);
          }}
          onOpenWork={onOpenWork}
        />
      )}
    </>
  );
}

/** One filter select. Three of them sit in a row on this screen, so the
 * label/select pairing is written once rather than three times. */
function Filter({
  id,
  label,
  value,
  options,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * One bill's settlement, as the mock's right-hand sheet.
 *
 * The waterfall is the mock's, row for row: the passed amount, one line
 * per deduction head, the net payable, what was received, and what is
 * still outstanding. Every one of those is a server figure — the heads are
 * aggregated in SQL across the bill's live receipts and the net is
 * computed there too, so the browser only prints and never subtracts.
 */
function BillSheet({
  entry,
  onClose,
  onOpenWork,
}: {
  readonly entry: ReceivablesRegisterEntry;
  readonly onClose: () => void;
  readonly onOpenWork: (workId: string) => void;
}) {
  const paid = entry.payments.find((payment) => payment.voidedAt === null) ?? null;
  return (
    <Sheet
      side="right"
      title={`Bill #${String(entry.billNumber)}`}
      description={`${entry.workCode} · ${entry.workTitle}`}
      onClose={onClose}
      footer={
        /* The sheet reads; the Work's Bills tab is where money is
           recorded. A plain button rather than an anchor styled as one:
           this closes a modal on its way out, so opening it in a new tab
           would leave the sheet behind on the old one. The row underneath
           carries the real anchor for anyone who wants the Work itself. */
        <Button
          onClick={() => {
            onOpenWork(entry.workId);
          }}
        >
          <IndianRupee data-icon="inline-start" aria-hidden="true" />
          {entry.status === 'paid' ? 'Open bill register' : 'Record a receipt'}
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={entry.status}>{entry.status}</StatusChip>
          <span className="text-xs text-muted-foreground">
            {entry.financialYear === null
              ? 'Not yet passed by the railway'
              : `FY ${entry.financialYear}`}
          </span>
        </div>

        {entry.railwayBillAmount === null ? (
          <p className="m-0 text-sm text-muted-foreground">
            The railway has not settled this measurement, so there is no agreed amount
            to be outstanding against and no receipt can be recorded yet. Record the
            On-Account Bill on the Work&rsquo;s Measurement tab first.
          </p>
        ) : (
          <section className="flex flex-col gap-3">
            <div>
              <p className="section-label">Deduction waterfall</p>
              <p className="m-0 mt-1 text-sm text-muted-foreground">
                Reconciliation from the passed amount to what is still outstanding.
              </p>
            </div>
            <div className="flex flex-col rounded-lg border border-border">
              <WaterfallRow
                label={
                  entry.railwayBillNumber === null
                    ? 'Passed amount'
                    : `Passed amount (${entry.railwayBillNumber})`
                }
                value={formatInr(entry.railwayBillAmount)}
                strong
              />
              {entry.deductionsByHead.map((head) => (
                <WaterfallRow
                  key={head.category}
                  label={CATEGORY_LABELS[head.category]}
                  value={`−${formatInr(head.amount)}`}
                />
              ))}
              <WaterfallRow
                label="Net payable"
                value={
                  entry.netPayableAmount === null
                    ? '—'
                    : formatInr(entry.netPayableAmount)
                }
                strong
              />
              <WaterfallRow
                label="Received"
                value={formatInr(entry.receivedTotal)}
                tone="success"
              />
              <WaterfallRow
                label="Outstanding"
                value={
                  entry.outstandingAmount === null
                    ? '—'
                    : formatInr(entry.outstandingAmount)
                }
                strong
              />
            </div>
          </section>
        )}

        {/* The mock's lifecycle strip, reading the product's three real
            events rather than its own three stages. */}
        <section className="flex flex-col gap-3">
          <p className="section-label">Lifecycle</p>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            <LifecycleStep
              label="Submitted"
              detail={
                entry.submittedAt === null
                  ? 'Prepared, not yet submitted'
                  : formatTimestampDate(entry.submittedAt)
              }
              done={entry.submittedAt !== null}
            />
            <LifecycleStep
              label="Passed by the railway"
              detail={
                entry.railwayBillDate === null
                  ? 'Awaiting the On-Account Bill'
                  : formatDate(entry.railwayBillDate)
              }
              done={entry.railwayBillDate !== null}
            />
            <LifecycleStep
              label="Received"
              detail={
                paid === null
                  ? 'No receipt recorded'
                  : `${formatDate(paid.receivedOn)}${
                      paid.reference === null ? '' : ` · ${paid.reference}`
                    }`
              }
              done={paid !== null}
            />
          </ol>
        </section>
      </div>
    </Sheet>
  );
}

function WaterfallRow({
  label,
  value,
  strong,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
  readonly tone?: 'success';
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-3 py-2.5 last:border-b-0">
      <span
        className={strong ? 'text-sm font-medium' : 'text-sm text-muted-foreground'}
      >
        {label}
      </span>
      <span
        className={[
          'font-mono text-sm tabular-nums',
          strong === true ? 'font-semibold' : '',
          tone === 'success' ? 'text-success' : '',
        ]
          .filter((part) => part !== '')
          .join(' ')}
      >
        {value}
      </span>
    </div>
  );
}

/** One step of the lifecycle strip. The state is carried by the word in
 * `detail` as well as by the dot, so it is never colour-alone. */
function LifecycleStep({
  label,
  detail,
  done,
}: {
  readonly label: string;
  readonly detail: string;
  readonly done: boolean;
}) {
  return (
    <li className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className={
          done
            ? 'size-2 shrink-0 rounded-full bg-success'
            : 'size-2 shrink-0 rounded-full bg-muted-foreground/40'
        }
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </li>
  );
}
