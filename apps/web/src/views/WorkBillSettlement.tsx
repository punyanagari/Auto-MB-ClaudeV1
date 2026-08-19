import { useEffect, useState } from 'react';
import { BILL_DEDUCTION_HEAD_RULES } from '@auto-mb/contracts';
import type {
  BillDeductionCategory,
  BillSettlementPosition,
  RecordBillPaymentRequest,
} from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { Disclosure } from '../ui/disclosure.js';
import { Actions, Field, FieldError, FieldRow, Hint } from '../ui/form.js';
import { Stat } from '../ui/stat.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { describeLoadFailure } from '../lib/load-failure.js';
import { formatDate, formatInr, todayIso } from '../format.js';

/**
 * What the railway actually paid, and what is still outstanding with it.
 *
 * The one thing this screen exists to keep straight is that money the
 * railway KEPT is settled money. A bill of ten lakh credited as nine lakh
 * fifty-two thousand is fully settled if forty-eight thousand went to GST
 * TDS, income-tax TDS and retention — and nearly five per cent short if it
 * did not. Reporting a single net figure conflates the two, which is why
 * the position is always three numbers and the register always shows the
 * breakup beside the credit.
 *
 * Every figure here is computed on the server in exact SQL numerics and
 * arrives as a decimal string. Nothing on this page adds money up.
 */

interface WorkBillSettlementProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
}

/**
 * The named heads, in the order a railway payment advice prints them.
 *
 * Derived from `BILL_DEDUCTION_HEAD_RULES` rather than restated: the
 * labels and the statutory hints used to be typed out here as well as in
 * the migration, the contract and the route, and four copies of "section
 * 194C" is three chances to update the wrong one. `OTHER` is excluded
 * because it is not a field on the advice — it is the described row the
 * operator adds when the railway kept something unnamed.
 */
const DEDUCTION_FIELDS: readonly {
  readonly category: BillDeductionCategory;
  readonly label: string;
  readonly hint?: string;
}[] = BILL_DEDUCTION_HEAD_RULES.filter((rule) => rule.head !== 'OTHER').map((rule) => ({
  category: rule.head,
  label: rule.label,
  hint:
    rule.provision === null
      ? rule.reconciledThrough
      : `${rule.provision.citation} — ${rule.reconciledThrough}`,
}));

const CATEGORY_LABELS: Record<BillDeductionCategory, string> = Object.fromEntries(
  BILL_DEDUCTION_HEAD_RULES.map((rule) => [rule.head, rule.label]),
) as Record<BillDeductionCategory, string>;

/** One trimmed field, or null when it was left blank.
 *
 * Null rather than an empty string because for a money field the two say
 * different things: a head left blank does not appear on this advice, and
 * reading it as zero would put an empty row in the register for every head
 * the railway did not use. */
function fieldOrNull(form: HTMLFormElement, name: string): string | null {
  const value = new FormData(form).get(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function deductionsFrom(form: HTMLFormElement): RecordBillPaymentRequest['deductions'] {
  const deductions: RecordBillPaymentRequest['deductions'][number][] = [];
  for (const field of DEDUCTION_FIELDS) {
    const amount = fieldOrNull(form, field.category);
    if (amount !== null) deductions.push({ category: field.category, amount });
  }
  const other = fieldOrNull(form, 'OTHER');
  if (other !== null) {
    const description = fieldOrNull(form, 'otherDescription');
    deductions.push({
      category: 'OTHER',
      amount: other,
      ...(description === null ? {} : { description }),
    });
  }
  return deductions;
}

export function WorkBillSettlement({
  api,
  organisationId,
  workId,
  canIssue,
  canCancel,
}: WorkBillSettlementProps) {
  const [positions, setPositions] = useState<readonly BillSettlementPosition[] | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [loadVersion, refresh] = useReload();
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** The receipt whose withdrawal is being confirmed, and the reason
   * typed into that confirmation. Withdrawing a recorded receipt of money
   * is irreversible and the reason is required, so it is a modal decision
   * rather than a button that acts on the first click. */
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');

  useEffect(() => {
    let cancelled = false;
    setPositions(null);
    setLoadError(null);
    api
      .listBillSettlement(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setPositions(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const failure = describeLoadFailure(cause, 'Payments against bills');
        setLoadError(failure.message);
        setRetryable(failure.retryable);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  async function act(work: () => Promise<void>, success: string) {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(success);
      refresh();
    } catch (cause: unknown) {
      setActionError(
        cause instanceof Error ? cause.message : 'The action could not be completed.',
      );
    } finally {
      setPending(false);
    }
  }

  if (loadError !== null) {
    return retryable ? (
      <ErrorState onRetry={refresh} retryLabel="Retry payments against bills">
        {loadError}
      </ErrorState>
    ) : (
      <p role="alert" className="m-0 text-sm font-medium text-destructive">
        {loadError}
      </p>
    );
  }
  if (positions === null) {
    return <LoadingState label="payments against this Work's bills" rows={3} />;
  }

  return (
    /* `.data-surface`, the mock's shared panel wrapper (docs/DESIGN.md
       § Component-layer conventions, ported from the mock at a8e1fde),
       rather than the outlined box this screen used to draw for itself. */
    <section
      className="data-surface mt-4 flex flex-col gap-3 p-4"
      aria-labelledby="bill-settlement-heading"
    >
      <h3 id="bill-settlement-heading" className="m-0 text-sm font-medium">
        Outstanding with the railway
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

      {positions.length === 0 ? (
        <EmptyState>
          No bill has been prepared for this Work, so nothing is outstanding with the
          railway yet.
        </EmptyState>
      ) : (
        positions.map((position) => (
          <article key={position.billId} className="flex flex-col gap-2">
            <h4 className="m-0 text-sm font-medium">
              Bill <span className="tabular-nums">#{position.billNumber}</span>
              {position.measurementBookNumber !== null && (
                <span className="font-normal text-muted-foreground">
                  {' '}
                  from{' '}
                  <span className="tabular-nums">{position.measurementBookNumber}</span>
                </span>
              )}
            </h4>

            {position.railwayBillAmount === null ? (
              <p className="m-0 text-sm text-muted-foreground">
                The railway has not settled this measurement, so there is no agreed
                amount to be outstanding against and no payment can be recorded yet.
                Record the On-Account Bill on the Measurement tab first.
              </p>
            ) : (
              /* The mock's own bill-settlement row (`app/works/[code]/page`
                 at fdfe5ef): a grid of `Stat` tiles rather than a two-column
                 definition list, so the figures read as an instrument
                 panel and their digits line up in columns. Four tiles where
                 the mock draws three — outstanding is the figure this
                 screen exists for and it is not derivable by eye from the
                 other three.

                 Every value is the server's exact decimal string through
                 `formatInr`; nothing here is rounded to the mock's compact
                 crore form, because these are the numbers an operator takes
                 to the railway. */
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label={
                    position.railwayBillNumber === null
                      ? 'Railway bill'
                      : `Railway bill ${position.railwayBillNumber}`
                  }
                  value={formatInr(position.railwayBillAmount)}
                  {...(position.railwayBillDate === null
                    ? {}
                    : { hint: `Dated ${formatDate(position.railwayBillDate)}` })}
                />
                <Stat label="Received" value={formatInr(position.receivedTotal)} />
                <Stat label="Deducted" value={formatInr(position.deductionTotal)} />
                <Stat
                  label="Outstanding"
                  value={
                    position.outstandingAmount === null
                      ? '—'
                      : formatInr(position.outstandingAmount)
                  }
                />
              </div>
            )}

            {position.payments.length > 0 && (
              <DataTable>
                <caption className="sr-only">
                  Payments received against bill {position.billNumber}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Received on</th>
                    <th scope="col">Reference</th>
                    <th scope="col" className={numericCell}>
                      Credited
                    </th>
                    <th scope="col" className={wrapCell}>
                      Deductions
                    </th>
                    <th scope="col" className={numericCell}>
                      Settles
                    </th>
                    {canCancel && <th scope="col">Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {position.payments.map((payment) => (
                    <tr key={payment.id}>
                      <th scope="row" className="tabular-nums">
                        {formatDate(payment.receivedOn)}
                        {payment.voidedAt !== null && (
                          // The reason is the whole point of withdrawing
                          // rather than deleting. "(voided)" on its own
                          // says a receipt was retracted and hides why,
                          // which is the question anybody reading the
                          // register a year later is asking.
                          <span className="block font-normal text-muted-foreground">
                            Withdrawn: {payment.voidReason ?? 'no reason recorded'}
                          </span>
                        )}
                      </th>
                      <td className="tabular-nums">{payment.reference ?? '—'}</td>
                      <td className={numericCell}>
                        {formatInr(payment.receivedAmount)}
                      </td>
                      <td className={wrapCell}>
                        {payment.deductions.length === 0
                          ? '—'
                          : payment.deductions
                              .map(
                                (deduction) =>
                                  `${CATEGORY_LABELS[deduction.category]} ${formatInr(
                                    deduction.amount,
                                  )}`,
                              )
                              .join(', ')}
                      </td>
                      <td className={numericCell}>{formatInr(payment.grossAmount)}</td>
                      {canCancel && (
                        <td>
                          {/* Gated on the bill's status exactly as the
                              receipt form is: a paid bill's register is
                              closed in BOTH directions, so a Withdraw
                              button here is a button whose only outcome
                              is a 409. */}
                          {payment.voidedAt === null && position.status !== 'paid' && (
                            <Button
                              variant="outline"
                              disabled={pending}
                              onClick={() => {
                                setWithdrawReason('');
                                setWithdrawing(payment.id);
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

            {canIssue &&
              position.railwayBillAmount !== null &&
              position.status !== 'paid' && (
                <Disclosure
                  label={`New receipt against bill #${String(position.billNumber)}`}
                  startOpen={position.payments.length === 0}
                >
                  <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      const receivedOn = fieldOrNull(form, 'receivedOn') ?? '';
                      const receivedAmount = fieldOrNull(form, 'receivedAmount') ?? '';
                      const reference = fieldOrNull(form, 'reference');
                      void act(async () => {
                        await api.recordBillPayment(organisationId, position.billId, {
                          receivedOn,
                          receivedAmount,
                          ...(reference === null ? {} : { reference }),
                          deductions: deductionsFrom(form),
                        });
                        form.reset();
                      }, 'Receipt recorded against this bill.');
                    }}
                  >
                    <FieldRow>
                      <Field>
                        <label htmlFor={`received-on-${position.billId}`}>
                          Received on
                        </label>
                        <input
                          id={`received-on-${position.billId}`}
                          name="receivedOn"
                          type="date"
                          required
                          defaultValue={todayIso()}
                          disabled={pending}
                        />
                      </Field>
                      <Field>
                        <label htmlFor={`received-amount-${position.billId}`}>
                          Amount credited
                        </label>
                        <input
                          id={`received-amount-${position.billId}`}
                          name="receivedAmount"
                          type="text"
                          inputMode="decimal"
                          required
                          disabled={pending}
                          className="font-mono tabular-nums"
                        />
                        <Hint>
                          What reached the bank, before adding back anything the railway
                          kept.
                        </Hint>
                      </Field>
                      <Field>
                        <label htmlFor={`reference-${position.billId}`}>
                          Reference
                        </label>
                        <input
                          id={`reference-${position.billId}`}
                          name="reference"
                          type="text"
                          disabled={pending}
                          className="font-mono"
                        />
                        <Hint>The UTR, advice number or cheque number, if quoted.</Hint>
                      </Field>
                    </FieldRow>

                    <FieldRow>
                      {DEDUCTION_FIELDS.map((field) => (
                        <Field key={field.category}>
                          <label htmlFor={`${field.category}-${position.billId}`}>
                            {field.label}
                          </label>
                          <input
                            id={`${field.category}-${position.billId}`}
                            name={field.category}
                            type="text"
                            inputMode="decimal"
                            disabled={pending}
                            className="font-mono tabular-nums"
                          />
                          {field.hint !== undefined && <Hint>{field.hint}</Hint>}
                        </Field>
                      ))}
                    </FieldRow>

                    <FieldRow>
                      <Field>
                        <label htmlFor={`other-${position.billId}`}>
                          Other deduction
                        </label>
                        <input
                          id={`other-${position.billId}`}
                          name="OTHER"
                          type="text"
                          inputMode="decimal"
                          disabled={pending}
                          className="font-mono tabular-nums"
                        />
                      </Field>
                      <Field>
                        <label htmlFor={`other-description-${position.billId}`}>
                          What the other deduction is
                        </label>
                        <input
                          id={`other-description-${position.billId}`}
                          name="otherDescription"
                          type="text"
                          disabled={pending}
                        />
                        <Hint>
                          Required whenever an other deduction is entered: an unnamed
                          head cannot be reconciled later.
                        </Hint>
                      </Field>
                    </FieldRow>

                    <Actions>
                      <Button type="submit" disabled={pending}>
                        Record receipt
                      </Button>
                    </Actions>
                  </form>
                </Disclosure>
              )}
          </article>
        ))
      )}

      {withdrawing !== null && (
        <ConfirmDialog
          title="Withdraw this receipt?"
          description="The receipt and its deductions stop counting towards the bill, and the amount becomes outstanding with the railway again. The record itself stays, with the reason given below."
          confirmLabel="Withdraw receipt"
          cancelLabel="Keep receipt"
          pending={pending}
          onCancel={() => {
            setWithdrawing(null);
          }}
          confirmDisabled={withdrawReason.trim().length < 3}
          onConfirm={() => {
            const reason = withdrawReason.trim();
            // Belt as well as braces: the button is disabled above, and a
            // press that somehow arrives anyway must not silently do
            // nothing — a confirm button that neither acts nor explains
            // is the failure this replaced.
            if (reason.length < 3) return;
            const paymentId = withdrawing;
            void act(async () => {
              await api.voidBillPayment(organisationId, paymentId, reason);
              setWithdrawing(null);
            }, 'Receipt withdrawn; the amount is outstanding again.');
          }}
        >
          <Field>
            <label htmlFor="withdraw-reason">Why it is being withdrawn</label>
            <input
              id="withdraw-reason"
              type="text"
              value={withdrawReason}
              disabled={pending}
              aria-describedby="withdraw-reason-hint"
              aria-invalid={withdrawReason !== '' && withdrawReason.trim().length < 3}
              onChange={(event) => {
                setWithdrawReason(event.currentTarget.value);
              }}
            />
            {withdrawReason !== '' && withdrawReason.trim().length < 3 ? (
              <FieldError id="withdraw-reason-hint">
                A reason of at least three characters is required, because it is what
                the record keeps in place of the receipt.
              </FieldError>
            ) : (
              <Hint id="withdraw-reason-hint">
                At least three characters. It is kept with the record.
              </Hint>
            )}
          </Field>
        </ConfirmDialog>
      )}
    </section>
  );
}
