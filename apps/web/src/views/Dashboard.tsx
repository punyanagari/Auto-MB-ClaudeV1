import { useEffect, useState } from 'react';
import type { DashboardResponse } from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formatInr, progressPercent } from '../format.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { ProgressBar } from '../ui/progress.js';
import { DataTable, numericCell } from '../ui/table.js';
import { FormError } from '../ui/form.js';

interface DashboardProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly onOpenWork: (workId: string) => void;
}

/* Severity used to ride a stripe down the left edge. It still tints the row,
 * but around the whole hairline border at the same weight as every other
 * card, so the list reads as one stack rather than a tab rack. The severity
 * itself is named in words by the badge — this is the scanning aid. */
const SEVERITY_BORDER = {
  danger: 'border-destructive/40',
  warning: 'border-warning/40',
  notice: 'border-info/40',
} as const;

const SEVERITY_TONE = {
  danger: 'destructive',
  warning: 'warning',
  notice: 'info',
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
      <Card>
        <h1 tabIndex={-1}>Dashboard</h1>
        <FormError>{error}</FormError>
      </Card>
    );
  }
  if (data === null) {
    return (
      <Card>
        <h1 tabIndex={-1}>Dashboard</h1>
        <p className="text-muted-foreground" role="status">
          Loading…
        </p>
      </Card>
    );
  }

  return (
    <>
      <section
        aria-label="Overview"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <div className="rounded-lg border border-border bg-card p-5">
          <span className="mb-1 block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Works
          </span>
          <span className="block text-2xl font-semibold tracking-tight tabular-nums">
            {data.totals.works}
          </span>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <span className="mb-1 block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Contract value
          </span>
          <span className="block text-2xl font-semibold tracking-tight tabular-nums">
            {formatInr(data.totals.contractValue)}
          </span>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <span className="mb-1 block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Delivered value
          </span>
          <span className="block text-2xl font-semibold tracking-tight tabular-nums">
            {formatInr(data.totals.deliveredValue)}
          </span>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <span className="mb-1 block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Billed value
          </span>
          <span className="block text-2xl font-semibold tracking-tight tabular-nums">
            {formatInr(data.totals.billedValue)}
          </span>
        </div>
      </section>

      <Card>
        <h1 tabIndex={-1}>Dashboard</h1>
        <h2>Needs attention</h2>
        {data.alerts.length === 0 ? (
          <p className="text-muted-foreground">
            Nothing needs attention. New warnings appear here — expiring bank
            guarantees, letters waiting for review, open drafts, and unpaid bills.
          </p>
        ) : (
          <ul className="my-3 flex list-none flex-col gap-2 p-0">
            {data.alerts.map((alert, index) => (
              <li
                key={`${alert.kind}-${String(index)}`}
                className={`flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 ${SEVERITY_BORDER[alert.severity]}`}
              >
                <Badge variant={SEVERITY_TONE[alert.severity]}>
                  {SEVERITY_LABEL[alert.severity]}
                </Badge>
                <span className="min-w-48 flex-1 text-sm">{alert.message}</span>
                {alert.dueInDays !== null && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {alert.dueInDays < 0
                      ? `${String(-alert.dueInDays)} days overdue`
                      : alert.dueInDays === 0
                        ? 'due today'
                        : `${String(alert.dueInDays)} days left`}
                  </span>
                )}
                {alert.workId !== null && (
                  <Button
                    variant="link"
                    size="inline"
                    className="font-medium"
                    onClick={() => {
                      if (alert.workId !== null) onOpenWork(alert.workId);
                    }}
                  >
                    Open {alert.workCode ?? 'work'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <h2>Delivery progress</h2>
        {data.works.length === 0 ? (
          <p className="text-muted-foreground">
            No Works yet. Upload an LOA letter to create the first Work.
          </p>
        ) : (
          <DataTable>
            <thead>
              <tr>
                <th scope="col">Work</th>
                <th scope="col">Progress</th>
                <th scope="col" className={numericCell}>
                  Delivered
                </th>
                <th scope="col" className={numericCell}>
                  Contract value
                </th>
                <th scope="col" className={numericCell}>
                  Challans
                </th>
              </tr>
            </thead>
            <tbody>
              {data.works.map((work) => {
                const percent = progressPercent(
                  work.deliveredValue,
                  work.contractValue,
                );
                return (
                  <tr key={work.workId}>
                    <th scope="row">
                      <Button
                        variant="link"
                        size="inline"
                        className="font-medium"
                        onClick={() => {
                          onOpenWork(work.workId);
                        }}
                      >
                        {work.workCode}
                      </Button>
                      <span className="text-muted-foreground"> {work.title}</span>
                    </th>
                    <td>
                      <ProgressBar
                        value={percent}
                        label={`${work.workCode} delivery progress`}
                        className="h-1.5 min-w-24 bg-secondary"
                      />
                      <span className="font-mono text-xs font-medium text-muted-foreground tabular-nums">
                        {percent}%
                      </span>
                    </td>
                    <td className={numericCell}>{formatInr(work.deliveredValue)}</td>
                    <td className={numericCell}>{formatInr(work.contractValue)}</td>
                    <td className={numericCell}>{work.issuedChallans}</td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </Card>
    </>
  );
}
