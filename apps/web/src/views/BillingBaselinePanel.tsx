import { useEffect, useState } from 'react';
import type { WorkBillingBaselineResponse } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate, formatInr } from '../format.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { Field, Hint } from '../ui/form.js';
import { NumericInput } from '../ui/numeric-input.js';
import { Stat } from '../ui/stat.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { ErrorState, LoadingState } from '../ui/state.js';

/**
 * The opening billing position of a Work whose history predates this
 * product (migration 0114; owner ruling, corrections item 23).
 *
 * A Work imported at the v1 cutover arrives with its challans, its
 * installations and its serials and no Measurement Books at all — so the
 * register below it starts at MB-01 on a contract the railway has been
 * paying against for four years. This panel is where that is said: the
 * last railway bill, the last measurement sheet it was raised from, and
 * a per-item statement of what had been billed by then.
 *
 * It sits ABOVE the Measurement Books for the reason `RailwayMeasurementPanel`
 * sits above the bill panel (docs/UX.md § 29): the order on screen is the
 * order the facts depend on each other in.
 *
 * PROPOSE AND PROVE. The uploaded sheet fills the figures in; a person
 * confirms each line by name; the proposal stays on screen beside the
 * stated figure so a change is legible rather than silent. Nothing here
 * computes money — the gross, the deductions and the net all come from
 * the server, because a net receivable computed in a browser is a second
 * net receivable.
 */

const DEDUCTION_LABELS = {
  security_deposit: 'Security deposit',
  retention: 'Retention',
  liquidated_damages: 'Liquidated damages',
  income_tax_tds: 'Income-tax TDS',
  gst_tds: 'GST TDS',
} as const;

type DeductionHeadKey = keyof typeof DEDUCTION_LABELS;
const DEDUCTION_HEADS = Object.keys(DEDUCTION_LABELS) as readonly DeductionHeadKey[];

interface BillingBaselinePanelProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  /** Recording an opening position is a settlement act under the issue
   * authority, exactly like the two railway panels. The server is the
   * arbiter; this only decides what to offer. */
  readonly canIssue: boolean;
}

function fileOf(form: HTMLFormElement, name: string): File | null {
  const input = form.elements.namedItem(name);
  return input instanceof HTMLInputElement ? (input.files?.[0] ?? null) : null;
}

export function BillingBaselinePanel({
  api,
  organisationId,
  workId,
  canIssue,
}: BillingBaselinePanelProps) {
  const [position, setPosition] = useState<WorkBillingBaselineResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, refresh] = useReload();
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmLock, setConfirmLock] = useState(false);
  const [deductions, setDeductions] = useState<Record<string, string>>({});
  // The recorded path for a bill whose own text this product cannot read —
  // a scan, most often. Revealed only when the server has SAID so (the 400
  // arm of BILLING_BASELINE_BILL_UNREADABLE), because typed figures beside
  // a readable bill are two claims about one document and the server
  // refuses them; hidden again when it refuses for exactly that reason
  // (the 409 arm).
  const [billUnreadable, setBillUnreadable] = useState(false);
  const [recorded, setRecorded] = useState({
    billNumber: '',
    billDate: '',
    billAmount: '',
    lastMbSequenceNumber: '',
  });

  useEffect(() => {
    let cancelled = false;
    setPosition(null);
    setLoadError(null);
    api
      .getWorkBillingBaseline(organisationId, workId)
      .then((loaded) => {
        if (cancelled) return;
        setPosition(loaded);
        setDeductions(
          Object.fromEntries(
            loaded.deductions.map((entry) => [entry.head, entry.amount]),
          ),
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof Error
            ? cause.message
            : "This Work's opening billing position could not be read.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  function act(work: () => Promise<WorkBillingBaselineResponse | null>, done: string) {
    setPending(true);
    setActionError(null);
    setNotice(null);
    void work()
      .then((updated) => {
        if (updated !== null) setPosition(updated);
        else refresh();
        setNotice(done);
      })
      .catch((cause: unknown) => {
        setActionError(
          cause instanceof Error ? cause.message : 'That could not be recorded.',
        );
      })
      .finally(() => {
        setPending(false);
      });
  }

  if (loadError !== null) {
    return (
      <section className="data-surface mt-4 flex flex-col gap-3 p-4">
        <h3>Opening billing position</h3>
        <ErrorState onRetry={refresh} retryLabel="Retry opening position">
          {loadError}
        </ErrorState>
      </section>
    );
  }
  if (position === null) {
    return (
      <section className="data-surface mt-4 flex flex-col gap-3 p-4">
        <h3>Opening billing position</h3>
        <LoadingState label="Reading the opening billing position" />
      </section>
    );
  }

  const baseline = position.baseline;
  // Derived on the server: true only while the Work has never numbered a
  // Measurement Book here. A Work with one carries its billing history in
  // this system and has no pre-system position to open.
  const openable = position.openable;
  const locked = baseline !== null && baseline.lockedAt !== null;
  const unconfirmed = position.lines.filter((line) => line.confirmedAt === null);
  const editable = canIssue && !locked;

  return (
    <section className="data-surface mt-4 flex flex-col gap-3 p-4">
      <h3>
        Opening billing position{' '}
        {baseline !== null && (
          <StatusChip status={locked ? 'issued' : 'draft'}>
            {locked ? 'locked' : 'draft'}
          </StatusChip>
        )}
      </h3>

      {actionError !== null && <p role="alert">{actionError}</p>}
      {notice !== null && <p role="status">{notice}</p>}

      {baseline === null ? (
        openable && canIssue ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const file = fileOf(form, 'baselineBill');
              if (file === null) return;
              setPending(true);
              setActionError(null);
              setNotice(null);
              void api
                .uploadBillingBaselineBill(
                  organisationId,
                  workId,
                  file,
                  file.name,
                  billUnreadable
                    ? {
                        billNumber: recorded.billNumber.trim(),
                        billDate: recorded.billDate,
                        billAmount: recorded.billAmount.trim(),
                        lastMbSequenceNumber: Number(recorded.lastMbSequenceNumber),
                      }
                    : undefined,
                )
                .then((updated) => {
                  setPosition(updated);
                  setNotice('Opening bill recorded.');
                  setBillUnreadable(false);
                  form.reset();
                })
                .catch((cause: unknown) => {
                  if (
                    cause instanceof RequestFailedError &&
                    cause.code === 'BILLING_BASELINE_BILL_UNREADABLE'
                  ) {
                    // 400: the document cannot be read, so offer the
                    // recorded path. 409: it CAN be read and refuses typed
                    // figures beside it, so withdraw them.
                    setBillUnreadable(cause.status === 400);
                  }
                  setActionError(
                    cause instanceof Error
                      ? cause.message
                      : 'That could not be recorded.',
                  );
                })
                .finally(() => {
                  setPending(false);
                });
            }}
          >
            <Field className="max-w-none">
              <label htmlFor="baselineBill">Last railway bill (PDF)</label>
              <input
                id="baselineBill"
                name="baselineBill"
                type="file"
                accept="application/pdf,.pdf"
                required
              />
              <Hint>
                The bill this Work was last paid on. Its number, date, amount and
                measurement sequence are read from the document&apos;s own text where it
                has one. Only a Work that has never had a Measurement Book in this
                system has an opening position to state.
              </Hint>
            </Field>
            {billUnreadable && (
              <>
                <Hint>
                  This bill&apos;s own text could not be read — a scan, most often — so
                  its four figures are recorded here, read off the document itself. The
                  row will say a person typed them.
                </Hint>
                <Field>
                  <label htmlFor="recordedBillNumber">Bill number</label>
                  <input
                    id="recordedBillNumber"
                    type="text"
                    required
                    value={recorded.billNumber}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setRecorded((current) => ({ ...current, billNumber: value }));
                    }}
                  />
                </Field>
                <Field>
                  <label htmlFor="recordedBillDate">Bill date</label>
                  <input
                    id="recordedBillDate"
                    type="date"
                    required
                    value={recorded.billDate}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setRecorded((current) => ({ ...current, billDate: value }));
                    }}
                  />
                </Field>
                <Field>
                  <label htmlFor="recordedBillAmount">Bill amount (INR)</label>
                  <NumericInput
                    id="recordedBillAmount"
                    className="text-right font-mono tabular-nums"
                    required
                    value={recorded.billAmount}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setRecorded((current) => ({ ...current, billAmount: value }));
                    }}
                  />
                </Field>
                <Field>
                  <label htmlFor="recordedSequence">
                    Measurement sequence this bill settles
                  </label>
                  <NumericInput
                    id="recordedSequence"
                    className="text-right font-mono tabular-nums"
                    integer
                    required
                    value={recorded.lastMbSequenceNumber}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setRecorded((current) => ({
                        ...current,
                        lastMbSequenceNumber: value,
                      }));
                    }}
                  />
                </Field>
              </>
            )}
            <Button type="submit" disabled={pending}>
              Record opening bill
            </Button>
          </form>
        ) : (
          <p className="text-muted-foreground">
            {openable
              ? 'Recording an opening billing position needs the issue authority.'
              : 'This Work has numbered a Measurement Book in this system, so its billing history is recorded here.'}
          </p>
        )
      ) : (
        <>
          <p className="text-muted-foreground">
            Bill {baseline.billNumber} dated {formatDate(baseline.billDate)} ·{' '}
            {formatInr(baseline.billAmount)} (the railway&apos;s own total, GST
            inclusive) · measurement {String(baseline.lastMbSequenceNumber)}
            {baseline.billSource === 'recorded'
              ? ' · figures recorded by hand from an unreadable document'
              : ' · figures read from the document'}
          </p>

          <div className="flex flex-wrap gap-6">
            <Stat
              label="Billed to date"
              value={formatInr(position.grossBilledToDate)}
            />
            <Stat label="Deductions" value={formatInr(position.deductionsTotal)} />
            <Stat label="Net receivable" value={formatInr(position.netReceivable)} />
          </div>

          {editable && baseline.measurementFilename === null && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const file = fileOf(form, 'baselineMeasurement');
                if (file === null) return;
                act(
                  () =>
                    api.uploadBillingBaselineMeasurement(
                      organisationId,
                      baseline.id,
                      file,
                      file.name,
                    ),
                  'Measurement sheet read; the lines below are proposals.',
                );
                form.reset();
              }}
            >
              <Field className="max-w-none">
                <label htmlFor="baselineMeasurement">
                  Last railway measurement sheet (PDF, optional)
                </label>
                <input
                  id="baselineMeasurement"
                  name="baselineMeasurement"
                  type="file"
                  accept="application/pdf,.pdf"
                />
                <Hint>
                  What those payments were for, item by item. Its remarks fill the lines
                  below as PROPOSALS — nothing is confirmed by uploading it. A Work
                  whose sheet is lost is stated line by line instead.
                </Hint>
              </Field>
              <Button type="submit" variant="outline" disabled={pending}>
                Read measurement sheet
              </Button>
            </form>
          )}

          <DataTable>
            <caption className="sr-only">
              What each item had been billed for when this Work entered the system
            </caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Description</th>
                <th scope="col" className={numericCell}>
                  Supplied
                </th>
                <th scope="col" className={numericCell}>
                  Installed
                </th>
                <th scope="col" className={numericCell}>
                  Amount
                </th>
                <th scope="col">Proposed from</th>
                <th scope="col">Confirmed</th>
              </tr>
            </thead>
            <tbody>
              {position.lines.map((line) => (
                <tr key={line.workItemId}>
                  <th scope="row">{line.itemNumber}</th>
                  <td className={wrapCell}>{line.description}</td>
                  <td className={numericCell}>{line.priorSupplied}</td>
                  <td className={numericCell}>{line.priorInstalled}</td>
                  <td className={numericCell}>{formatInr(line.amount)}</td>
                  {/* The proposal, beside the stated figure and never
                      instead of it: what a parser read and what a person
                      accepted are two statements, and the railway's own
                      sentence is here so the figures can be argued with
                      rather than only accepted. */}
                  <td className={wrapCell}>
                    {line.proposedFromRemark ?? (
                      <span className="text-muted-foreground">entered by hand</span>
                    )}
                  </td>
                  <td>
                    {line.confirmedAt !== null ? (
                      <StatusChip status="issued">confirmed</StatusChip>
                    ) : editable ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          act(
                            () =>
                              api.confirmBillingBaselineLine(
                                organisationId,
                                baseline.id,
                                line.itemNumber,
                              ),
                            `Item ${line.itemNumber} confirmed.`,
                          );
                        }}
                      >
                        Confirm item {line.itemNumber}
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>

          {editable && (
            <p className="text-muted-foreground">
              {unconfirmed.length === 0
                ? 'Every line is confirmed; the opening position can be locked.'
                : `${String(unconfirmed.length)} of ${String(position.lines.length)} lines still to confirm.`}
            </p>
          )}

          {editable && unconfirmed.length === 0 && (
            <Button
              type="button"
              disabled={pending}
              onClick={() => {
                setConfirmLock(true);
              }}
            >
              Lock opening position…
            </Button>
          )}
        </>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          act(
            () =>
              api.setWorkDeductions(organisationId, workId, {
                deductions: DEDUCTION_HEADS.filter(
                  (head) => (deductions[head] ?? '').trim() !== '',
                ).map((head) => ({ head, amount: (deductions[head] ?? '').trim() })),
              }),
            'Opening deductions recorded.',
          );
          form.blur();
        }}
      >
        <h4>Opening deductions</h4>
        <Hint>
          Cumulative to date under each head, from the agency&apos;s own ledger — the
          bills they were withheld on are the bills this system never saw. Editable
          until the opening position is locked, and locked with it.
        </Hint>
        {DEDUCTION_HEADS.map((head) => (
          <Field key={head}>
            <label htmlFor={`deduction-${head}`}>{DEDUCTION_LABELS[head]}</label>
            <NumericInput
              id={`deduction-${head}`}
              className="text-right font-mono tabular-nums"
              value={deductions[head] ?? ''}
              disabled={!canIssue || locked}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDeductions((current) => ({ ...current, [head]: value }));
              }}
            />
          </Field>
        ))}
        {canIssue && !locked && (
          <Button type="submit" variant="outline" disabled={pending}>
            Save deductions
          </Button>
        )}
      </form>

      {confirmLock && baseline !== null && (
        <ConfirmDialog
          title="Lock this Work's opening billing position?"
          description={`Measurement Book numbering on this Work resumes at ${String(
            baseline.lastMbSequenceNumber + 1,
          )}, and every book raised afterwards counts its prior quantities from these figures. The lines and the deductions stop being editable.`}
          confirmLabel="Lock opening position"
          pending={pending}
          onCancel={() => {
            setConfirmLock(false);
          }}
          onConfirm={() => {
            setConfirmLock(false);
            act(
              () => api.lockBillingBaseline(organisationId, baseline.id),
              'Opening position locked.',
            );
          }}
        />
      )}
    </section>
  );
}
