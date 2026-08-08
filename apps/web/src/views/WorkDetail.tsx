import { useEffect, useState } from 'react';
import type { Challan, WorkDetailResponse } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';

interface WorkDetailProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canModify: boolean;
  readonly onNewChallan: (workId: string, workCode: string) => void;
  readonly onOpenChallan: (challanId: string) => void;
  readonly onBack: () => void;
}

const DIRECTION_LABELS = {
  below: 'below advertised',
  at_par: 'at par',
  above: 'above advertised',
} as const;

export function WorkDetail({
  api,
  organisationId,
  workId,
  canModify,
  onNewChallan,
  onOpenChallan,
  onBack,
}: WorkDetailProps) {
  const [detail, setDetail] = useState<WorkDetailResponse | null>(null);
  const [challans, setChallans] = useState<readonly Challan[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setChallans(null);
    setLoadError(null);
    Promise.all([
      api.getWork(organisationId, workId),
      api.listChallans(organisationId, workId),
    ])
      .then(([loaded, loadedChallans]) => {
        if (cancelled) return;
        setDetail(loaded);
        setChallans(loadedChallans);
      })
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
          <dd>₹{work.advertisedValue}</dd>
        </div>
        <div>
          <dt>Contract value</dt>
          <dd>₹{work.contractValue}</dd>
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

      <div className="actions">
        <button type="button" className="button--ghost" onClick={onBack}>
          Back to Works
        </button>
      </div>
    </section>
  );
}
