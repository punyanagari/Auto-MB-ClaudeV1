import { useEffect, useState } from 'react';
import type { WorkDetailResponse } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';

interface WorkDetailProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly onBack: () => void;
}

const DIRECTION_LABELS = {
  below: 'below advertised',
  at_par: 'at par',
  above: 'above advertised',
} as const;

export function WorkDetail({ api, organisationId, workId, onBack }: WorkDetailProps) {
  const [detail, setDetail] = useState<WorkDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    api
      .getWork(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setDetail(loaded);
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

      <div className="actions">
        <button type="button" className="button--ghost" onClick={onBack}>
          Back to Works
        </button>
      </div>
    </section>
  );
}
