import { useEffect, useState } from 'react';
import type {
  LdAssessment,
  RetentionReleaseBasis,
  WorkRetentionResponse,
} from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { useAction, useReload } from '../lib/view-state.js';
import { describeLoadFailure } from '../lib/load-failure.js';
import { formatDate, formatInr } from '../format.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { Disclosure } from '../ui/disclosure.js';
import { Actions, Field, FieldError, FieldRow, Hint } from '../ui/form.js';
import { Stat } from '../ui/stat.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * What the railway is still holding, and what it kept because the work
 * was late.
 *
 * The mock draws the home for this: its Instruments section says it is
 * where an agency tracks "bank guarantees, EMD and security deposits held
 * against this work" (`components/work-registers.tsx` at fdfd610), and its
 * own seed data carries a security-deposit instrument whose bank reads
 * "Deducted from bills". This section is what that fiction is when it is
 * true — the deposit is not a document somebody typed in, it is the
 * running total of what the railway actually withheld across every bill,
 * less what it has given back. `docs/UX.md` § 21 records the divergence.
 *
 * TWO THINGS ON THIS SCREEN ARE NEVER SUBTRACTED FROM EACH OTHER, and the
 * layout is what keeps them apart. "Assessed" is the agency's own reading
 * of the contract; "deducted" is what the railway took under the
 * liquidated-damages head on a payment advice. Their difference is a
 * conversation to have, not a balance to display, so they sit in two
 * tiles and there is no third tile between them.
 *
 * Every figure here is a decimal string the server computed in exact SQL
 * numerics — the liquidated-damages arithmetic is generated columns on
 * the table itself. Nothing on this page adds money up.
 */

interface WorkRetentionProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  /** Holds can_manage_retention (migration 0098). Without it the section
   * reads and offers nothing: the server refuses either way, and hiding
   * the forms only spares the useless attempt. */
  readonly canManageRetention: boolean;
}

/** The shape a money field has to have before it is worth sending: a
 * non-negative rupee figure with at most two decimals, which is what the
 * `money_amount` column stores and what the contract schema admits. Used
 * only to enable a confirm button — whether the AMOUNT is within the
 * assessment is money arithmetic and is decided by the server, twice. */
const MONEY_PATTERN = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,2})?$/;

const BASIS_LABELS: Record<RetentionReleaseBasis, string> = {
  pac: 'Provisional Acceptance Certificate',
  defect_liability_end: 'End of defect liability',
  bank_guarantee_substitution: 'Bank guarantee lodged',
  other: 'Other',
};

/** The two chargeable periods a railway clause actually states, plus the
 * escape hatch for one that states something else. The value is a number
 * of DAYS for the reason migration 0098 § 1 gives at length: a calendar
 * month is not a fixed quantity, so "per month" over a delay measured in
 * days has two defensible readings that give different money. */
const PERIOD_CHOICES: readonly { readonly days: number; readonly label: string }[] = [
  { days: 7, label: 'Per week (7 days)' },
  { days: 30, label: 'Per month (30 days)' },
];

/** One trimmed field, or undefined when it was left blank. Undefined
 * rather than an empty string because for a term the two say different
 * things: a rate left blank is a rate the contract does not state, and
 * reading it as zero would assert a nil rate nobody agreed. */
function fieldOrUndefined(form: HTMLFormElement, name: string): string | undefined {
  const value = new FormData(form).get(name);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function integerOrUndefined(form: HTMLFormElement, name: string): number | undefined {
  const raw = fieldOrUndefined(form, name);
  if (raw === undefined) return undefined;
  // Integers, not money: a period in days and a liability in months are
  // counts, and `Number` on a count is exact. Every MONEY figure on this
  // screen stays a string all the way to the server.
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function WorkRetention({
  api,
  organisationId,
  workId,
  canManageRetention,
}: WorkRetentionProps) {
  const [data, setData] = useState<WorkRetentionResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [loadVersion, refresh] = useReload();
  const { pending, notice, actionError, act } = useAction(
    'The action could not be completed.',
  );
  /** The release whose withdrawal is being confirmed, and the reason
   * typed into that confirmation. Withdrawing a record that money came
   * back is irreversible and the reason is required, so it is a modal
   * decision rather than a button that acts on the first click. */
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');
  /** The assessment being decided, and which of the three decisions. One
   * modal for all three because all three are irreversible and all three
   * need something typed: a levy needs the amount the railway actually
   * took, a waiver and a cancellation each need a reason. */
  const [deciding, setDeciding] = useState<{
    readonly assessment: LdAssessment;
    readonly decision: 'levy' | 'waive' | 'cancel';
  } | null>(null);
  const [decisionReason, setDecisionReason] = useState('');
  const [leviedAmount, setLeviedAmount] = useState('');
  const [basis, setBasis] = useState<RetentionReleaseBasis>('pac');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    api
      .getWorkRetention(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const failure = describeLoadFailure(cause, 'Retention and damages');
        setLoadError(failure.message);
        setRetryable(failure.retryable);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  async function run(work: () => Promise<void>, done: string) {
    await act(async () => {
      await work();
    }, done);
    refresh();
  }

  if (loadError !== null) {
    return retryable ? (
      <ErrorState onRetry={refresh} retryLabel="Retry retention and damages">
        {loadError}
      </ErrorState>
    ) : (
      <p role="alert" className="m-0 text-sm font-medium text-destructive">
        {loadError}
      </p>
    );
  }
  if (data === null) {
    return <LoadingState label="retention and liquidated damages" rows={3} />;
  }

  const { position, terms, releases, assessments, instruments } = data;
  const ldTermsRecorded =
    terms !== null &&
    terms.ldRatePercent !== null &&
    terms.ldPeriodDays !== null &&
    terms.ldCapPercent !== null;
  const canAssess =
    canManageRetention && ldTermsRecorded && data.currentCompletionDate !== null;
  const draft = assessments.find((assessment) => assessment.status === 'draft');

  return (
    /* `.data-surface`, the mock's shared panel wrapper (docs/DESIGN.md
       § Component-layer conventions), the same wrapper the bill
       settlement section uses on the Bills tab. */
    <section
      className="data-surface mt-4 flex flex-col gap-3 p-4"
      aria-labelledby="retention-heading"
    >
      <h3 id="retention-heading" className="m-0 text-sm font-medium">
        Retention and liquidated damages
      </h3>

      {actionError !== null && (
        <p role="alert" className="m-0 text-sm font-medium text-destructive">
          {actionError}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="m-0 text-sm text-success">
          {notice}
        </p>
      )}

      {/* The retention ledger, in the three figures it takes to state it
          honestly plus the ceiling the contract set. Held is what the
          railway actually withheld across every bill; a ceiling nobody
          recorded shows as a dash rather than as zero. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Retention held"
          value={formatInr(position.retentionHeldTotal)}
          hint="Security deposit withheld across this Work's bills"
        />
        <Stat label="Released" value={formatInr(position.retentionReleasedTotal)} />
        <Stat label="Still held" value={formatInr(position.retentionBalance)} />
        <Stat
          label="Contractual ceiling"
          value={
            position.retentionCeilingAmount === null
              ? '—'
              : formatInr(position.retentionCeilingAmount)
          }
          hint={
            terms?.retentionLimitPercent === null || terms === null
              ? 'No ceiling recorded on this Work'
              : `${terms.retentionLimitPercent}% of the contract value`
          }
        />
      </div>

      {/* The two liquidated-damages figures, side by side and never
          netted. See the module comment. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Stat
          label="Damages levied"
          value={formatInr(position.ldLeviedTotal)}
          hint="What this organisation has recorded as levied"
        />
        <Stat
          label="Damages deducted"
          value={formatInr(position.ldDeductedTotal)}
          hint="What the railway took under this head on its payment advices"
        />
      </div>

      {/* ---- The contract's terms --------------------------------------- */}
      <h4 className="m-0 mt-2 text-sm font-medium">Contract terms</h4>
      {terms === null ? (
        <EmptyState>
          No retention or liquidated-damages terms are recorded for this Work.
          Liquidated damages cannot be assessed until the rate, the chargeable period
          and the cap are read off the letter.
        </EmptyState>
      ) : (
        <dl className="m-0 flex flex-col gap-2 p-0 text-xs">
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
            <dt className="text-muted-foreground">Retention per bill</dt>
            <dd className="m-0 font-medium tabular-nums">
              {terms.retentionPercent === null ? '—' : `${terms.retentionPercent}%`}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
            <dt className="text-muted-foreground">Defect liability</dt>
            <dd className="m-0 font-medium tabular-nums">
              {terms.defectLiabilityMonths === null
                ? '—'
                : `${String(terms.defectLiabilityMonths)} months`}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
            <dt className="text-muted-foreground">Liquidated damages</dt>
            <dd className="m-0 font-medium tabular-nums">
              {ldTermsRecorded
                ? `${terms.ldRatePercent ?? ''}% per ${String(
                    terms.ldPeriodDays ?? 0,
                  )} days, capped at ${terms.ldCapPercent ?? ''}%`
                : '—'}
            </dd>
          </div>
          {terms.sourceClause !== null && (
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
              <dt className="text-muted-foreground">Clause</dt>
              <dd className="m-0 font-medium">{terms.sourceClause}</dd>
            </div>
          )}
        </dl>
      )}

      {canManageRetention && (
        <Disclosure
          label={terms === null ? 'Record contract terms' : 'Edit contract terms'}
          startOpen={terms === null}
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const body = {
                ...maybe(
                  'retentionPercent',
                  fieldOrUndefined(form, 'retentionPercent'),
                ),
                ...maybe(
                  'retentionLimitPercent',
                  fieldOrUndefined(form, 'retentionLimitPercent'),
                ),
                ...maybe(
                  'defectLiabilityMonths',
                  integerOrUndefined(form, 'defectLiabilityMonths'),
                ),
                ...maybe('ldRatePercent', fieldOrUndefined(form, 'ldRatePercent')),
                ...maybe('ldPeriodDays', integerOrUndefined(form, 'ldPeriodDays')),
                ...maybe('ldCapPercent', fieldOrUndefined(form, 'ldCapPercent')),
                ...maybe('sourceClause', fieldOrUndefined(form, 'sourceClause')),
              };
              void run(async () => {
                await api.saveWorkRetentionTerms(organisationId, workId, body);
              }, 'Contract terms saved.');
            }}
          >
            <FieldRow>
              <Field>
                <label htmlFor="retention-percent">Retention per bill (%)</label>
                <input
                  id="retention-percent"
                  name="retentionPercent"
                  type="text"
                  inputMode="decimal"
                  disabled={pending}
                  defaultValue={terms?.retentionPercent ?? ''}
                  className="font-mono tabular-nums"
                />
                <Hint>What the railway withholds from each on-account bill.</Hint>
              </Field>
              <Field>
                <label htmlFor="retention-limit-percent">Ceiling (% of contract)</label>
                <input
                  id="retention-limit-percent"
                  name="retentionLimitPercent"
                  type="text"
                  inputMode="decimal"
                  disabled={pending}
                  defaultValue={terms?.retentionLimitPercent ?? ''}
                  className="font-mono tabular-nums"
                />
                <Hint>
                  Shown beside what was actually withheld; it refuses no deduction.
                </Hint>
              </Field>
              <Field>
                <label htmlFor="defect-liability-months">
                  Defect liability (months)
                </label>
                <input
                  id="defect-liability-months"
                  name="defectLiabilityMonths"
                  type="number"
                  min={0}
                  max={120}
                  disabled={pending}
                  defaultValue={terms?.defectLiabilityMonths ?? ''}
                  className="font-mono tabular-nums"
                />
              </Field>
            </FieldRow>

            <FieldRow>
              <Field>
                <label htmlFor="ld-rate-percent">Damages rate (%)</label>
                <input
                  id="ld-rate-percent"
                  name="ldRatePercent"
                  type="text"
                  inputMode="decimal"
                  disabled={pending}
                  defaultValue={terms?.ldRatePercent ?? ''}
                  className="font-mono tabular-nums"
                />
                <Hint>Per chargeable period, of the assessment basis.</Hint>
              </Field>
              <Field>
                <label htmlFor="ld-period-days">Chargeable period</label>
                <select
                  id="ld-period-days"
                  name="ldPeriodDays"
                  disabled={pending}
                  defaultValue={terms?.ldPeriodDays ?? ''}
                >
                  <option value="">Not recorded</option>
                  {PERIOD_CHOICES.map((choice) => (
                    <option key={choice.days} value={choice.days}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                <Hint>
                  A period is a number of days, so no calendar has to be guessed at.
                </Hint>
              </Field>
              <Field>
                <label htmlFor="ld-cap-percent">Damages cap (%)</label>
                <input
                  id="ld-cap-percent"
                  name="ldCapPercent"
                  type="text"
                  inputMode="decimal"
                  disabled={pending}
                  defaultValue={terms?.ldCapPercent ?? ''}
                  className="font-mono tabular-nums"
                />
                <Hint>The maximum, of the assessment basis. Usually 10%.</Hint>
              </Field>
            </FieldRow>

            <Field>
              <label htmlFor="source-clause">Clause</label>
              <input
                id="source-clause"
                name="sourceClause"
                type="text"
                maxLength={200}
                disabled={pending}
                defaultValue={terms?.sourceClause ?? ''}
              />
              <Hint>
                The clause number to quote back at the railway. The three damages fields
                are recorded together or not at all.
              </Hint>
            </Field>

            <Actions>
              <Button type="submit" disabled={pending}>
                Save terms
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}

      {/* ---- Releases --------------------------------------------------- */}
      <h4 className="m-0 mt-2 text-sm font-medium">Retention released</h4>
      {releases.length === 0 ? (
        <EmptyState>
          No retention has been released on this Work yet. A release is recorded when
          the railway returns the deposit — at the acceptance certificate, at the end of
          the defect-liability period, or against a bank guarantee.
        </EmptyState>
      ) : (
        <DataTable>
          <caption className="sr-only">Retention released on this Work</caption>
          <thead>
            <tr>
              <th scope="col">Released on</th>
              <th scope="col" className={wrapCell}>
                Basis
              </th>
              <th scope="col">Reference</th>
              <th scope="col" className={numericCell}>
                Amount
              </th>
              {canManageRetention && <th scope="col">Action</th>}
            </tr>
          </thead>
          <tbody>
            {releases.map((release) => (
              <tr key={release.id}>
                <th scope="row" className="tabular-nums">
                  {formatDate(release.releasedOn)}
                  {release.voidedAt !== null && (
                    // The reason is the whole point of withdrawing rather
                    // than deleting. "(withdrawn)" alone says a record was
                    // retracted and hides why, which is the question
                    // anybody reading the ledger a year later is asking.
                    <span className="block font-normal text-muted-foreground">
                      Withdrawn: {release.voidReason ?? 'no reason recorded'}
                    </span>
                  )}
                </th>
                <td className={wrapCell}>
                  {BASIS_LABELS[release.basis]}
                  {release.workInstrumentReference !== null &&
                    ` · ${release.workInstrumentReference}`}
                  {release.description !== null && ` · ${release.description}`}
                </td>
                <td className="tabular-nums">{release.reference ?? '—'}</td>
                <td className={numericCell}>{formatInr(release.amount)}</td>
                {canManageRetention && (
                  <td>
                    {release.voidedAt === null && (
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() => {
                          setWithdrawReason('');
                          setWithdrawing(release.id);
                        }}
                      >
                        Withdraw
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {canManageRetention && (
        <Disclosure label="Record a release" startOpen={false}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const releasedOn = fieldOrUndefined(form, 'releasedOn') ?? '';
              const amount = fieldOrUndefined(form, 'amount') ?? '';
              const body = {
                releasedOn,
                amount,
                basis,
                ...maybe(
                  'workInstrumentId',
                  fieldOrUndefined(form, 'workInstrumentId'),
                ),
                ...maybe('reference', fieldOrUndefined(form, 'reference')),
                ...maybe('description', fieldOrUndefined(form, 'description')),
              };
              void run(async () => {
                await api.recordRetentionRelease(organisationId, workId, body);
                form.reset();
                setBasis('pac');
              }, 'Release recorded; the retention balance has moved.');
            }}
          >
            <FieldRow>
              <Field>
                <label htmlFor="released-on">Released on</label>
                <input
                  id="released-on"
                  name="releasedOn"
                  type="date"
                  required
                  disabled={pending}
                />
              </Field>
              <Field>
                <label htmlFor="release-amount">Amount</label>
                <input
                  id="release-amount"
                  name="amount"
                  type="text"
                  inputMode="decimal"
                  required
                  disabled={pending}
                  className="font-mono tabular-nums"
                />
                <Hint>
                  At most {formatInr(position.retentionBalance)} — what is still held.
                </Hint>
              </Field>
              <Field>
                <label htmlFor="release-basis">Basis</label>
                <select
                  id="release-basis"
                  value={basis}
                  disabled={pending}
                  onChange={(event) => {
                    setBasis(event.currentTarget.value as RetentionReleaseBasis);
                  }}
                >
                  {(Object.keys(BASIS_LABELS) as readonly RetentionReleaseBasis[]).map(
                    (value) => (
                      <option key={value} value={value}>
                        {BASIS_LABELS[value]}
                      </option>
                    ),
                  )}
                </select>
              </Field>
            </FieldRow>

            <FieldRow>
              {basis === 'bank_guarantee_substitution' && (
                <Field>
                  <label htmlFor="release-instrument">Guarantee</label>
                  <select
                    id="release-instrument"
                    name="workInstrumentId"
                    required
                    disabled={pending}
                    defaultValue=""
                  >
                    <option value="">Choose a guarantee</option>
                    {instruments.map((instrument) => (
                      <option key={instrument.id} value={instrument.id}>
                        {instrument.kind.toUpperCase()} {instrument.reference}
                        {instrument.amount !== null &&
                          ` · ${formatInr(instrument.amount)}`}
                      </option>
                    ))}
                  </select>
                  <Hint>
                    Only this Work&rsquo;s active instruments. Record the guarantee
                    above first if it is not listed.
                  </Hint>
                </Field>
              )}
              <Field>
                <label htmlFor="release-reference">Reference</label>
                <input
                  id="release-reference"
                  name="reference"
                  type="text"
                  maxLength={100}
                  disabled={pending}
                  className="font-mono"
                />
                <Hint>The railway&rsquo;s release letter or advice number.</Hint>
              </Field>
              {basis === 'other' && (
                <Field>
                  <label htmlFor="release-description">What the release is</label>
                  <input
                    id="release-description"
                    name="description"
                    type="text"
                    required
                    minLength={3}
                    maxLength={200}
                    disabled={pending}
                  />
                  <Hint>Required: an unnamed release cannot be reconciled later.</Hint>
                </Field>
              )}
            </FieldRow>

            <Actions>
              <Button type="submit" disabled={pending}>
                Record release
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}

      {/* ---- Liquidated damages ----------------------------------------- */}
      <h4 className="m-0 mt-2 text-sm font-medium">Liquidated damages</h4>
      {assessments.length === 0 ? (
        <EmptyState>
          No liquidated damages have been assessed on this Work.
          {ldTermsRecorded
            ? ' An assessment measures the delay from the contractual completion date and applies the contract’s own rate and cap.'
            : ' Record the contract’s damages terms above first — a rate, a chargeable period and a cap.'}
        </EmptyState>
      ) : (
        <DataTable>
          <caption className="sr-only">
            Liquidated-damages assessments on this Work
          </caption>
          <thead>
            <tr>
              <th scope="col">Assessed on</th>
              <th scope="col" className={wrapCell}>
                Delay
              </th>
              <th scope="col" className={numericCell}>
                Assessed
              </th>
              <th scope="col" className={numericCell}>
                Levied
              </th>
              <th scope="col">Status</th>
              {canManageRetention && <th scope="col">Action</th>}
            </tr>
          </thead>
          <tbody>
            {assessments.map((assessment) => (
              <tr key={assessment.id}>
                <th scope="row" className="tabular-nums">
                  {formatDate(assessment.assessedOn)}
                  {assessment.outcomeReason !== null && (
                    <span className="block font-normal text-muted-foreground">
                      {assessment.outcomeReason}
                    </span>
                  )}
                </th>
                <td className={wrapCell}>
                  <span className="tabular-nums">
                    {String(assessment.delayDays)} days
                  </span>{' '}
                  from {formatDate(assessment.scheduledCompletionDate)} to{' '}
                  {formatDate(assessment.assessedToDate)}
                  <span className="block text-muted-foreground">
                    {String(assessment.chargeablePeriods)} × {assessment.ldRatePercent}%
                    of {formatInr(assessment.basisAmount)} ({assessment.basisLabel})
                    {/* The cap is the fact worth arguing about, so it is
                        stated whenever it bit rather than left to be
                        inferred from two numbers that do not multiply
                        out. */}
                    {assessment.assessedAmount !== assessment.uncappedAmount &&
                      ` · capped at ${assessment.ldCapPercent}%, from ${formatInr(
                        assessment.uncappedAmount,
                      )}`}
                  </span>
                </td>
                <td className={numericCell}>{formatInr(assessment.assessedAmount)}</td>
                <td className={numericCell}>
                  {assessment.leviedAmount === null
                    ? '—'
                    : formatInr(assessment.leviedAmount)}
                </td>
                <td>
                  <StatusChip status={assessment.status} />
                </td>
                {canManageRetention && (
                  <td>
                    {(assessment.status === 'draft' ||
                      assessment.status === 'levied') && (
                      <span className="flex flex-wrap gap-2">
                        {assessment.status === 'draft' && (
                          <Button
                            variant="outline"
                            disabled={pending}
                            onClick={() => {
                              // Defaulted to the assessment, which is what
                              // the railway takes when it does not
                              // negotiate — and is the ceiling either way.
                              setLeviedAmount(assessment.assessedAmount);
                              setDeciding({ assessment, decision: 'levy' });
                            }}
                          >
                            Levy
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            setDecisionReason('');
                            setDeciding({ assessment, decision: 'waive' });
                          }}
                        >
                          Waive
                        </Button>
                        <Button
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            setDecisionReason('');
                            setDeciding({ assessment, decision: 'cancel' });
                          }}
                        >
                          Cancel
                        </Button>
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {canManageRetention && !canAssess && (
        <p className="m-0 text-sm text-muted-foreground">
          {!ldTermsRecorded
            ? 'Record the contract’s damages terms above before assessing: the rate, the chargeable period and the cap are read from there and never typed into an assessment.'
            : 'This Work has no contractual completion date, so there is nothing to measure a delay against. Record the completion dates on the Work first.'}
        </p>
      )}

      {canAssess && draft === undefined && (
        <Disclosure label="Assess liquidated damages" startOpen={false}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const assessedOn = fieldOrUndefined(form, 'assessedOn') ?? '';
              const assessedToDate = fieldOrUndefined(form, 'assessedToDate') ?? '';
              const body = {
                assessedOn,
                assessedToDate,
                ...maybe('basisAmount', fieldOrUndefined(form, 'basisAmount')),
                ...maybe('basisLabel', fieldOrUndefined(form, 'basisLabel')),
              };
              void run(async () => {
                await api.assessLd(organisationId, workId, body);
                form.reset();
              }, 'Assessment made; the arithmetic is on the row.');
            }}
          >
            <FieldRow>
              <Field>
                <label htmlFor="assessed-to-date">Delay measured to</label>
                <input
                  id="assessed-to-date"
                  name="assessedToDate"
                  type="date"
                  required
                  disabled={pending}
                />
                <Hint>
                  The completion date, or today for a delay still running. The delay is
                  measured from{' '}
                  {data.currentCompletionDate === null
                    ? 'the contractual completion date'
                    : formatDate(data.currentCompletionDate)}
                  , extensions included.
                </Hint>
              </Field>
              <Field>
                <label htmlFor="assessed-on">Assessed on</label>
                <input
                  id="assessed-on"
                  name="assessedOn"
                  type="date"
                  required
                  disabled={pending}
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field>
                <label htmlFor="basis-amount">Basis</label>
                <input
                  id="basis-amount"
                  name="basisAmount"
                  type="text"
                  inputMode="decimal"
                  disabled={pending}
                  className="font-mono tabular-nums"
                />
                <Hint>
                  Blank charges the whole contract value,{' '}
                  {formatInr(position.contractValue)}. Set it where the contract charges
                  only the delayed portion.
                </Hint>
              </Field>
              <Field>
                <label htmlFor="basis-label">What the basis is</label>
                <input
                  id="basis-label"
                  name="basisLabel"
                  type="text"
                  maxLength={200}
                  disabled={pending}
                />
                <Hint>
                  Read years later instead of a bare number. Left blank it names the
                  contract value.
                </Hint>
              </Field>
            </FieldRow>
            <Actions>
              <Button type="submit" disabled={pending}>
                Assess
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}

      {withdrawing !== null && (
        <ConfirmDialog
          title="Withdraw this release?"
          description="The release stops counting, and the amount goes back to being held by the railway. The record itself stays, with the reason given below."
          confirmLabel="Withdraw release"
          cancelLabel="Keep release"
          pending={pending}
          onCancel={() => {
            setWithdrawing(null);
          }}
          confirmDisabled={withdrawReason.trim().length < 3}
          onConfirm={() => {
            const reason = withdrawReason.trim();
            // Belt as well as braces: the button is disabled above, and a
            // press that somehow arrives anyway must not silently do
            // nothing.
            if (reason.length < 3) return;
            const releaseId = withdrawing;
            void run(async () => {
              await api.voidRetentionRelease(organisationId, releaseId, reason);
              setWithdrawing(null);
            }, 'Release withdrawn; the amount is held again.');
          }}
        >
          <Field>
            <label htmlFor="release-withdraw-reason">Why it is being withdrawn</label>
            <input
              id="release-withdraw-reason"
              type="text"
              value={withdrawReason}
              disabled={pending}
              aria-describedby="release-withdraw-reason-hint"
              aria-invalid={withdrawReason !== '' && withdrawReason.trim().length < 3}
              onChange={(event) => {
                setWithdrawReason(event.currentTarget.value);
              }}
            />
            {withdrawReason !== '' && withdrawReason.trim().length < 3 ? (
              <FieldError id="release-withdraw-reason-hint">
                A reason of at least three characters is required, because it is what
                the record keeps in place of the release.
              </FieldError>
            ) : (
              <Hint id="release-withdraw-reason-hint">
                At least three characters. It is kept with the record.
              </Hint>
            )}
          </Field>
        </ConfirmDialog>
      )}

      {deciding !== null && (
        <ConfirmDialog
          title={
            deciding.decision === 'levy'
              ? 'Record what the railway levied?'
              : deciding.decision === 'waive'
                ? 'Waive these damages?'
                : 'Cancel this assessment?'
          }
          description={
            deciding.decision === 'levy'
              ? 'The railway imposed these damages. A levy is written once and can never exceed the assessment; if the railway took more, assess again on the basis it used.'
              : deciding.decision === 'waive'
                ? 'The railway did not take these damages, or gave them back. The assessment stays on the record with the reason below, and any levy already recorded stays visible beside it.'
                : 'The assessment was made in error. It stays on the record with the reason below, so the mistake and the correction are both explicable.'
          }
          confirmLabel={
            deciding.decision === 'levy'
              ? 'Record levy'
              : deciding.decision === 'waive'
                ? 'Waive damages'
                : 'Cancel assessment'
          }
          cancelLabel="Keep as it is"
          pending={pending}
          onCancel={() => {
            setDeciding(null);
          }}
          confirmDisabled={
            deciding.decision === 'levy'
              ? !MONEY_PATTERN.test(leviedAmount.trim())
              : decisionReason.trim().length < 3
          }
          onConfirm={() => {
            const { assessment, decision } = deciding;
            if (decision === 'levy') {
              const amount = leviedAmount.trim();
              // Belt as well as braces: the button is disabled above, and
              // a press that somehow arrives anyway must not silently do
              // nothing. The amount is never COMPARED here — whether it
              // fits the assessment is money arithmetic, and the server
              // decides it twice.
              if (!MONEY_PATTERN.test(amount)) return;
              void run(async () => {
                await api.decideLdAssessment(organisationId, assessment.id, {
                  decision: 'levy',
                  leviedAmount: amount,
                });
                setDeciding(null);
              }, 'Levy recorded against this assessment.');
              return;
            }
            const reason = decisionReason.trim();
            if (reason.length < 3) return;
            void run(
              async () => {
                await api.decideLdAssessment(organisationId, assessment.id, {
                  decision,
                  reason,
                });
                setDeciding(null);
              },
              decision === 'waive' ? 'Damages waived.' : 'Assessment cancelled.',
            );
          }}
        >
          {deciding.decision === 'levy' ? (
            <Field>
              <label htmlFor="ld-levied-amount">What the railway levied</label>
              <input
                id="ld-levied-amount"
                type="text"
                inputMode="decimal"
                value={leviedAmount}
                disabled={pending}
                aria-describedby="ld-levied-amount-hint"
                aria-invalid={
                  leviedAmount !== '' && !MONEY_PATTERN.test(leviedAmount.trim())
                }
                className="font-mono tabular-nums"
                onChange={(event) => {
                  setLeviedAmount(event.currentTarget.value);
                }}
              />
              {leviedAmount !== '' && !MONEY_PATTERN.test(leviedAmount.trim()) ? (
                <FieldError id="ld-levied-amount-hint">
                  A rupee amount with at most two decimal places.
                </FieldError>
              ) : (
                <Hint id="ld-levied-amount-hint">
                  At most {formatInr(deciding.assessment.assessedAmount)}, the
                  assessment. Ordinarily negotiated below it.
                </Hint>
              )}
            </Field>
          ) : (
            <Field>
              <label htmlFor="ld-decision-reason">Why</label>
              <input
                id="ld-decision-reason"
                type="text"
                value={decisionReason}
                disabled={pending}
                aria-describedby="ld-decision-reason-hint"
                aria-invalid={decisionReason !== '' && decisionReason.trim().length < 3}
                onChange={(event) => {
                  setDecisionReason(event.currentTarget.value);
                }}
              />
              {decisionReason !== '' && decisionReason.trim().length < 3 ? (
                <FieldError id="ld-decision-reason-hint">
                  A reason of at least three characters is required, because it is what
                  the record keeps in place of the assessment.
                </FieldError>
              ) : (
                <Hint id="ld-decision-reason-hint">
                  At least three characters. It is kept with the record.
                </Hint>
              )}
            </Field>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

/** `{ key: value }` when the value is present, `{}` when it is not.
 *
 * The request bodies here use optional properties rather than nullable
 * ones, and `exactOptionalPropertyTypes` refuses `{ key: undefined }` for
 * an optional property — so a spread is the honest way to omit a field
 * the operator left blank. */
function maybe<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
