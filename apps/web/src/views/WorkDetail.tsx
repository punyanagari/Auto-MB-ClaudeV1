import { useCallback, useEffect, useState } from 'react';
import type {
  Bill,
  Challan,
  Instrument,
  InstrumentStatus,
  MbEntry,
  Serial,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import { formatInr } from '../format.js';

interface WorkDetailProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canModify: boolean;
  readonly canRecordEvidence: boolean;
  readonly canIssue: boolean;
  readonly onNewChallan: (workId: string, workCode: string) => void;
  readonly onOpenChallan: (challanId: string) => void;
  readonly onBack: () => void;
}

const DIRECTION_LABELS = {
  below: 'below advertised',
  at_par: 'at par',
  above: 'above advertised',
} as const;

const INSTRUMENT_LABELS: Record<Instrument['kind'], string> = {
  pbg: 'PBG',
  pac: 'PAC',
  doc: 'DOC',
};

interface BillLine {
  readonly itemNumber: string;
  readonly unitCode: string;
  readonly quantity: string;
  readonly rate: string;
  readonly amount: string;
}

/** The snapshot is stored as jsonb and typed unknown in the contract;
 * anything that does not match the expected line shape is dropped rather
 * than rendered as "[object Object]". */
function billLines(snapshot: unknown): readonly BillLine[] {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.filter(
    (line): line is BillLine =>
      typeof line === 'object' &&
      line !== null &&
      typeof (line as BillLine).itemNumber === 'string' &&
      typeof (line as BillLine).quantity === 'string' &&
      typeof (line as BillLine).amount === 'string',
  );
}

export function WorkDetail({
  api,
  organisationId,
  workId,
  canModify,
  canRecordEvidence,
  canIssue,
  onNewChallan,
  onOpenChallan,
  onBack,
}: WorkDetailProps) {
  const [detail, setDetail] = useState<WorkDetailResponse | null>(null);
  const [challans, setChallans] = useState<readonly Challan[] | null>(null);
  const [instruments, setInstruments] = useState<readonly Instrument[]>([]);
  const [mbEntries, setMbEntries] = useState<readonly MbEntry[]>([]);
  const [bills, setBills] = useState<readonly Bill[]>([]);
  const [serials, setSerials] = useState<readonly Serial[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setChallans(null);
    setLoadError(null);
    Promise.all([
      api.getWork(organisationId, workId),
      api.listChallans(organisationId, workId),
      api.listInstruments(organisationId, workId),
      api.listMbEntries(organisationId, workId),
      api.listBills(organisationId, workId),
      api.listWorkSerials(organisationId, workId),
    ])
      .then(
        ([
          loaded,
          loadedChallans,
          loadedInstruments,
          loadedEntries,
          loadedBills,
          loadedSerials,
        ]) => {
          if (cancelled) return;
          setDetail(loaded);
          setChallans(loadedChallans);
          setInstruments(loadedInstruments);
          setMbEntries(loadedEntries);
          setBills(loadedBills);
          setSerials(loadedSerials);
        },
      )
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The Work could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId]);

  const act = useCallback(async (work: () => Promise<void>, done: string) => {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The action failed; nothing was changed.',
      );
    } finally {
      setPending(false);
    }
  }, []);

  if (loadError !== null) {
    return (
      <section className="card" aria-labelledby="work-title">
        <h1 id="work-title" tabIndex={-1}>
          Work
        </h1>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </section>
    );
  }

  if (detail === null) {
    return (
      <section className="card" aria-labelledby="work-title">
        <h1 id="work-title" tabIndex={-1}>
          Work
        </h1>
        <p className="muted" role="status">
          Loading Work…
        </p>
      </section>
    );
  }

  const { work, schedules } = detail;
  const workItems = schedules.flatMap((schedule) => schedule.items);
  const issuedChallans = (challans ?? []).filter(
    (challan) => challan.status === 'issued',
  );
  const challanNumberById = new Map(
    (challans ?? []).map((challan) => [challan.id, challan.challanNumber]),
  );
  const unbilledCount = mbEntries.filter((entry) => entry.billId === null).length;

  return (
    <section className="card card--wide" aria-labelledby="work-title">
      <h1 id="work-title" tabIndex={-1}>
        {work.workCode} — {work.title}
      </h1>
      <dl className="fact-list">
        <div>
          <dt>Letter</dt>
          <dd>
            {work.letterNumber} · {work.letterDate}
          </dd>
        </div>
        <div>
          <dt>Advertised value</dt>
          <dd>{formatInr(work.advertisedValue)}</dd>
        </div>
        <div>
          <dt>Contract value</dt>
          <dd>{formatInr(work.contractValue)}</dd>
        </div>
        <div>
          <dt>Pricing</dt>
          <dd>
            {work.pricingShape === 'letter_percentage' &&
            work.letterPercentage !== null &&
            work.letterPercentageDirection !== null
              ? `${work.letterPercentage}% ${DIRECTION_LABELS[work.letterPercentageDirection]}`
              : 'Per-schedule totals'}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{work.status}</dd>
        </div>
      </dl>

      {schedules.map((schedule) => (
        <div key={schedule.id}>
          <h2>
            Schedule {schedule.scheduleCode}
            <span className="muted"> · {schedule.items.length} items</span>
          </h2>
          <table className="data-table">
            <caption className="visually-hidden">
              Awarded items in schedule {schedule.scheduleCode}
            </caption>
            <thead>
              <tr>
                <th scope="col">Item number</th>
                <th scope="col">Description</th>
                <th scope="col">Unit</th>
                <th scope="col">Awarded quantity</th>
                <th scope="col">Rate (₹)</th>
                <th scope="col">Serial tracking</th>
              </tr>
            </thead>
            <tbody>
              {schedule.items.map((item) => (
                <tr key={item.id}>
                  <th scope="row">{item.itemNumber}</th>
                  <td className="cell--wrap">{item.description}</td>
                  <td>{item.unitCode}</td>
                  <td className="cell--numeric">{item.awardedQuantity}</td>
                  <td className="cell--numeric">{item.effectiveRate}</td>
                  <td>
                    {canModify ? (
                      <button
                        type="button"
                        className="button--ghost"
                        role="switch"
                        aria-checked={item.requiresSerials}
                        aria-label={`Serial tracking for ${item.itemNumber}`}
                        disabled={pending}
                        onClick={() =>
                          void act(
                            async () => {
                              const updated = await api.updateWorkItemSerials(
                                organisationId,
                                item.id,
                                !item.requiresSerials,
                              );
                              setDetail((current) =>
                                current === null
                                  ? current
                                  : {
                                      ...current,
                                      schedules: current.schedules.map((candidate) => ({
                                        ...candidate,
                                        items: candidate.items.map((candidateItem) =>
                                          candidateItem.id === item.id
                                            ? {
                                                ...candidateItem,
                                                requiresSerials:
                                                  updated.requiresSerials,
                                              }
                                            : candidateItem,
                                        ),
                                      })),
                                    },
                              );
                            },
                            item.requiresSerials
                              ? `Serial tracking switched off for ${item.itemNumber}.`
                              : `Serial tracking required for ${item.itemNumber}; challans for it now need one serial per unit before issue.`,
                          )
                        }
                      >
                        {item.requiresSerials ? 'Required' : 'Off'}
                      </button>
                    ) : (
                      <span className={item.requiresSerials ? '' : 'muted'}>
                        {item.requiresSerials ? 'Required' : 'Off'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="card__header">
        <h2>Delivery Challans</h2>
        {canModify &&
          (challans?.some((challan) => challan.status === 'draft') === true ? (
            <button
              type="button"
              onClick={() => {
                const draft = challans.find((challan) => challan.status === 'draft');
                if (draft) onOpenChallan(draft.id);
              }}
            >
              Open draft challan
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                onNewChallan(workId, work.workCode);
              }}
            >
              New Delivery Challan
            </button>
          ))}
      </div>
      {challans !== null && challans.length > 0 ? (
        <table className="data-table">
          <caption className="visually-hidden">Delivery Challans for this Work</caption>
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {challans.map((challan) => (
              <tr key={challan.id}>
                <th scope="row">
                  <button
                    type="button"
                    className="button--link"
                    onClick={() => {
                      onOpenChallan(challan.id);
                    }}
                  >
                    {challan.challanNumber ?? 'Draft'}
                  </button>
                </th>
                <td>{challan.challanDate}</td>
                <td>
                  <span className={`chip chip--${challan.status}`}>
                    {challan.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No Delivery Challans yet.</p>
      )}

      {notice !== null && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}
      {actionError !== null && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}

      <h2>Contract instruments</h2>
      {instruments.length > 0 ? (
        <table className="data-table">
          <caption className="visually-hidden">
            Bank guarantees and certificates held for this Work
          </caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Reference</th>
              <th scope="col" className="cell--numeric">
                Amount
              </th>
              <th scope="col">Issued</th>
              <th scope="col">Expires</th>
              <th scope="col">Status</th>
              {canModify && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {instruments.map((instrument) => (
              <tr key={instrument.id}>
                <td>{INSTRUMENT_LABELS[instrument.kind]}</td>
                <th scope="row">{instrument.reference}</th>
                <td className="cell--numeric">
                  {instrument.amount !== null ? formatInr(instrument.amount) : '—'}
                </td>
                <td>{instrument.issuedOn}</td>
                <td>{instrument.expiresOn ?? '—'}</td>
                <td>
                  <span className={`chip chip--${instrument.status}`}>
                    {instrument.status}
                  </span>
                </td>
                {canModify && (
                  <td>
                    {instrument.status === 'active' ? (
                      <InstrumentStatusEditor
                        instrument={instrument}
                        pending={pending}
                        onApply={(status) =>
                          void act(async () => {
                            const updated = await api.updateInstrument(
                              organisationId,
                              instrument.id,
                              { status },
                            );
                            setInstruments((current) =>
                              current.map((candidate) =>
                                candidate.id === updated.id ? updated : candidate,
                              ),
                            );
                          }, `${instrument.reference} marked ${status}.`)
                        }
                      />
                    ) : (
                      <span className="muted">final</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No PBG, PAC, or document instruments recorded yet.</p>
      )}
      {canModify && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const kind = formValue(data, 'instrument-kind') || 'pbg';
            const reference = formValue(data, 'instrument-reference');
            const amount = formValue(data, 'instrument-amount').trim();
            const issuedOn = formValue(data, 'instrument-issued');
            const expiresOn = formValue(data, 'instrument-expires');
            const notes = formValue(data, 'instrument-notes').trim();
            void act(async () => {
              const created = await api.createInstrument(organisationId, workId, {
                kind: kind as Instrument['kind'],
                reference,
                issuedOn,
                ...(amount.length > 0 ? { amount } : {}),
                ...(expiresOn.length > 0 ? { expiresOn } : {}),
                ...(notes.length > 0 ? { notes } : {}),
              });
              setInstruments((current) => [...current, created]);
              form.reset();
            }, `${reference} recorded.`);
          }}
        >
          <h3>Add instrument</h3>
          <div className="field">
            <label htmlFor="instrument-kind">Kind</label>
            <select id="instrument-kind" name="instrument-kind" required>
              <option value="pbg">PBG — Performance Bank Guarantee</option>
              <option value="pac">PAC — Provisional Acceptance Certificate</option>
              <option value="doc">DOC — other contract document</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="instrument-reference">Reference</label>
            <input
              id="instrument-reference"
              name="instrument-reference"
              required
              maxLength={200}
            />
          </div>
          <div className="field">
            <label htmlFor="instrument-amount">Amount (₹, optional)</label>
            <input
              id="instrument-amount"
              name="instrument-amount"
              inputMode="decimal"
            />
          </div>
          <div className="field">
            <label htmlFor="instrument-issued">Issued on</label>
            <input
              id="instrument-issued"
              name="instrument-issued"
              type="date"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="instrument-expires">Expires on (optional)</label>
            <input id="instrument-expires" name="instrument-expires" type="date" />
          </div>
          <div className="field">
            <label htmlFor="instrument-notes">Notes (optional)</label>
            <input id="instrument-notes" name="instrument-notes" maxLength={2000} />
          </div>
          <div className="actions">
            <button type="submit" disabled={pending}>
              Add instrument
            </button>
          </div>
        </form>
      )}

      <h2>Measurement Book</h2>
      {mbEntries.length > 0 ? (
        <table className="data-table">
          <caption className="visually-hidden">
            Measurement Book entries for this Work
          </caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="cell--numeric">
                Quantity
              </th>
              <th scope="col">Measured on</th>
              <th scope="col">Challan</th>
              <th scope="col">MB book</th>
              <th scope="col">Billing</th>
            </tr>
          </thead>
          <tbody>
            {mbEntries.map((entry) => (
              <tr key={entry.id}>
                <th scope="row">{entry.itemNumber}</th>
                <td className="cell--numeric">{entry.measuredQuantity}</td>
                <td>{entry.measuredOn}</td>
                <td>
                  {entry.deliveryChallanId !== null
                    ? (challanNumberById.get(entry.deliveryChallanId) ?? '—')
                    : '—'}
                </td>
                <td>{entry.mbBookRef ?? '—'}</td>
                <td>
                  {entry.billId !== null ? (
                    <span className="chip chip--confirmed">billed</span>
                  ) : (
                    <span className="muted">unbilled</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No measurements recorded yet.</p>
      )}
      {canRecordEvidence && workItems.length > 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const workItemId = formValue(data, 'mb-item');
            const measuredQuantity = formValue(data, 'mb-quantity');
            const measuredOn = formValue(data, 'mb-date');
            const deliveryChallanId = formValue(data, 'mb-challan');
            const mbBookRef = formValue(data, 'mb-book').trim();
            const remarks = formValue(data, 'mb-remarks').trim();
            void act(async () => {
              const entry = await api.recordMbEntry(organisationId, workId, {
                workItemId,
                measuredQuantity,
                measuredOn,
                ...(deliveryChallanId.length > 0 ? { deliveryChallanId } : {}),
                ...(mbBookRef.length > 0 ? { mbBookRef } : {}),
                ...(remarks.length > 0 ? { remarks } : {}),
              });
              setMbEntries((current) => [...current, entry]);
              form.reset();
            }, 'Measurement recorded.');
          }}
        >
          <h3>Record measurement</h3>
          <div className="field">
            <label htmlFor="mb-item">Work item</label>
            <select id="mb-item" name="mb-item" required>
              {workItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.itemNumber} — {item.description}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="mb-quantity">Measured quantity</label>
            <input id="mb-quantity" name="mb-quantity" inputMode="decimal" required />
          </div>
          <div className="field">
            <label htmlFor="mb-date">Measured on</label>
            <input id="mb-date" name="mb-date" type="date" required />
          </div>
          <div className="field">
            <label htmlFor="mb-challan">Source challan (optional)</label>
            <select id="mb-challan" name="mb-challan">
              <option value="">Not tied to a challan</option>
              {issuedChallans.map((challan) => (
                <option key={challan.id} value={challan.id}>
                  {challan.challanNumber ?? challan.id}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="mb-book">MB book reference (optional)</label>
            <input id="mb-book" name="mb-book" maxLength={100} />
          </div>
          <div className="field">
            <label htmlFor="mb-remarks">Remarks (optional)</label>
            <input id="mb-remarks" name="mb-remarks" maxLength={1000} />
          </div>
          <div className="actions">
            <button type="submit" disabled={pending}>
              Record measurement
            </button>
          </div>
        </form>
      )}

      <div className="card__header">
        <h2>Bills</h2>
        {canIssue && (
          <button
            type="button"
            disabled={pending || unbilledCount === 0}
            onClick={() =>
              void act(async () => {
                await api.prepareBill(organisationId, workId);
                const [freshBills, freshEntries] = await Promise.all([
                  api.listBills(organisationId, workId),
                  api.listMbEntries(organisationId, workId),
                ]);
                setBills(freshBills);
                setMbEntries(freshEntries);
              }, 'Bill prepared from the unbilled measurements.')
            }
          >
            Prepare bill
          </button>
        )}
      </div>
      {canIssue && unbilledCount === 0 && (
        <p className="muted">
          Preparing a bill needs at least one unbilled measurement.
        </p>
      )}
      {bills.length > 0 ? (
        bills.map((bill) => (
          <div key={bill.id}>
            <h3>
              Bill #{bill.billNumber}{' '}
              <span className={`chip chip--${bill.status}`}>{bill.status}</span>
            </h3>
            <table className="data-table">
              <caption className="visually-hidden">
                Lines of bill {bill.billNumber}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Unit</th>
                  <th scope="col" className="cell--numeric">
                    Quantity
                  </th>
                  <th scope="col" className="cell--numeric">
                    Rate
                  </th>
                  <th scope="col" className="cell--numeric">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {billLines(bill.linesSnapshot).map((line) => (
                  <tr key={`${bill.id}-${line.itemNumber}`}>
                    <th scope="row">{line.itemNumber}</th>
                    <td>{line.unitCode}</td>
                    <td className="cell--numeric">{line.quantity}</td>
                    <td className="cell--numeric">{formatInr(line.rate)}</td>
                    <td className="cell--numeric">{formatInr(line.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" colSpan={4}>
                    Total
                  </th>
                  <td className="cell--numeric">
                    <strong>{formatInr(bill.totalAmount)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
            {canIssue && bill.status !== 'paid' && (
              <div className="actions">
                <button
                  type="button"
                  className="button--ghost"
                  disabled={pending}
                  onClick={() => {
                    const next = bill.status === 'prepared' ? 'submitted' : 'paid';
                    void act(async () => {
                      const updated = await api.setBillStatus(organisationId, bill.id, {
                        status: next,
                      });
                      setBills((current) =>
                        current.map((candidate) =>
                          candidate.id === updated.id ? updated : candidate,
                        ),
                      );
                    }, `Bill #${bill.billNumber} marked ${next}.`);
                  }}
                >
                  {bill.status === 'prepared' ? 'Mark submitted' : 'Mark paid'}
                </button>
              </div>
            )}
          </div>
        ))
      ) : (
        <p className="muted">No bills prepared yet.</p>
      )}

      <h2>Serial trace</h2>
      {serials.length > 0 ? (
        <table className="data-table">
          <caption className="visually-hidden">
            Every serial number delivered under this Work
          </caption>
          <thead>
            <tr>
              <th scope="col">Serial</th>
              <th scope="col">Item</th>
              <th scope="col">Challan</th>
              <th scope="col">Installation</th>
            </tr>
          </thead>
          <tbody>
            {serials.map((serial) => (
              <tr key={serial.id}>
                <th scope="row">{serial.serialNumber}</th>
                <td className="cell--wrap">{serial.itemDescription}</td>
                <td>{serial.challanNumber ?? '—'}</td>
                <td>
                  {serial.installedOn !== null ? (
                    <span className="chip chip--installed">
                      installed {serial.installedOn}
                    </span>
                  ) : (
                    <span className="muted">not installed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">
          No serial numbers recorded yet. Serials are recorded on each issued challan.
        </p>
      )}

      <div className="actions">
        <button type="button" className="button--ghost" onClick={onBack}>
          Back to Works
        </button>
      </div>
    </section>
  );
}

interface InstrumentStatusEditorProps {
  readonly instrument: Instrument;
  readonly pending: boolean;
  readonly onApply: (status: Exclude<InstrumentStatus, 'active'>) => void;
}

/** Forward-only transitions out of 'active'; terminal statuses show no
 * controls (the server refuses them with INSTRUMENT_STATUS_TERMINAL). */
function InstrumentStatusEditor({
  instrument,
  pending,
  onApply,
}: InstrumentStatusEditorProps) {
  const [status, setStatus] = useState<Exclude<InstrumentStatus, 'active'>>('released');
  return (
    <span className="actions">
      <label className="visually-hidden" htmlFor={`instrument-status-${instrument.id}`}>
        New status for {instrument.reference}
      </label>
      <select
        id={`instrument-status-${instrument.id}`}
        value={status}
        onChange={(event) => {
          setStatus(event.target.value as Exclude<InstrumentStatus, 'active'>);
        }}
      >
        <option value="released">released</option>
        <option value="expired">expired</option>
        <option value="closed">closed</option>
      </select>
      <button
        type="button"
        className="button--ghost"
        disabled={pending}
        onClick={() => {
          onApply(status);
        }}
      >
        Apply
      </button>
    </span>
  );
}
