import { useEffect, useState } from 'react';
import type { DashboardResponse } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formatInr, progressPercent } from '../format.js';

interface DashboardProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly onOpenWork: (workId: string) => void;
}

const SEVERITY_CLASS = {
  danger: 'alert--danger',
  warning: 'alert--warning',
  notice: 'alert--notice',
} as const;

const SEVERITY_LABEL = {
  danger: 'Urgent',
  warning: 'Warning',
  notice: 'Info',
} as const;

export function Dashboard({ api, organisationId, onOpenWork }: DashboardProps) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .dashboard(organisationId)
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : 'The dashboard failed to load.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  if (error !== null) {
    return (
      <section className="card">
        <h1 tabIndex={-1}>Dashboard</h1>
        <p role="alert" className="form-error">
          {error}
        </p>
      </section>
    );
  }
  if (data === null) {
    return (
      <section className="card">
        <h1 tabIndex={-1}>Dashboard</h1>
        <p className="muted" role="status">
          Loading…
        </p>
      </section>
    );
  }

  return (
    <>
      <section aria-label="Overview" className="stat-row">
        <div className="stat-tile">
          <span className="stat-tile__label">Works</span>
          <span className="stat-tile__value">{data.totals.works}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile__label">Contract value</span>
          <span className="stat-tile__value">
            {formatInr(data.totals.contractValue)}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile__label">Delivered value</span>
          <span className="stat-tile__value">
            {formatInr(data.totals.deliveredValue)}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile__label">Billed value</span>
          <span className="stat-tile__value">{formatInr(data.totals.billedValue)}</span>
        </div>
      </section>

      <section className="card">
        <h1 tabIndex={-1}>Dashboard</h1>
        <h2>Needs attention</h2>
        {data.alerts.length === 0 ? (
          <p className="muted">
            Nothing needs attention. New warnings appear here — expiring bank
            guarantees, letters waiting for review, open drafts, and unpaid bills.
          </p>
        ) : (
          <ul className="alert-list">
            {data.alerts.map((alert, index) => (
              <li
                key={`${alert.kind}-${String(index)}`}
                className={`alert ${SEVERITY_CLASS[alert.severity]}`}
              >
                <span className={`chip alert__chip--${alert.severity}`}>
                  {SEVERITY_LABEL[alert.severity]}
                </span>
                <span className="alert__message">{alert.message}</span>
                {alert.dueInDays !== null && (
                  <span className="alert__due">
                    {alert.dueInDays < 0
                      ? `${String(-alert.dueInDays)} days overdue`
                      : alert.dueInDays === 0
                        ? 'due today'
                        : `${String(alert.dueInDays)} days left`}
                  </span>
                )}
                {alert.workId !== null && (
                  <button
                    type="button"
                    className="button--link"
                    onClick={() => {
                      if (alert.workId !== null) onOpenWork(alert.workId);
                    }}
                  >
                    Open {alert.workCode ?? 'work'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <h2>Delivery progress</h2>
        {data.works.length === 0 ? (
          <p className="muted">
            No Works yet. Upload an LOA letter to create the first Work.
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Work</th>
                <th scope="col">Progress</th>
                <th scope="col" className="cell--numeric">
                  Delivered
                </th>
                <th scope="col" className="cell--numeric">
                  Contract value
                </th>
                <th scope="col" className="cell--numeric">
                  Challans
                </th>
              </tr>
            </thead>
            <tbody>
              {data.works.map((work) => {
                const percent = progressPercent(work.deliveredValue, work.contractValue);
                return (
                  <tr key={work.workId}>
                    <th scope="row">
                      <button
                        type="button"
                        className="button--link"
                        onClick={() => {
                          onOpenWork(work.workId);
                        }}
                      >
                        {work.workCode}
                      </button>
                      <span className="muted work-title"> {work.title}</span>
                    </th>
                    <td>
                      <div
                        className="progress"
                        role="progressbar"
                        aria-valuenow={percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${work.workCode} delivery progress`}
                      >
                        <div
                          className="progress__bar"
                          style={{ width: `${String(percent)}%` }}
                        />
                      </div>
                      <span className="muted progress__text">{percent}%</span>
                    </td>
                    <td className="cell--numeric">{formatInr(work.deliveredValue)}</td>
                    <td className="cell--numeric">{formatInr(work.contractValue)}</td>
                    <td className="cell--numeric">{work.issuedChallans}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
