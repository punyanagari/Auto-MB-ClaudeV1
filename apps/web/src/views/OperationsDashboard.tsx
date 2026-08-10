import { useEffect, useMemo, useState } from 'react';
import type { DashboardAlert, DashboardResponse } from '@auto-mb/contracts';
import {
  AlertTriangle,
  ArrowRight,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  FileSearch,
  FileText,
  Upload,
} from 'lucide-react';
import type { ApiClient } from '../api.js';
import { formatCompactInr, formatInr, progressPercent } from '../format.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { ProgressBar } from '../ui/progress.js';
import { FormError } from '../ui/form.js';

interface OperationsDashboardProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly canModify: boolean;
  readonly onOpenWork: (workId: string) => void;
  readonly onOpenWorks: () => void;
  readonly onUploadLoa: () => void;
  readonly onOpenApprovals: () => void;
}

const ALERT_TONE: Record<
  DashboardAlert['severity'],
  {
    readonly badge: 'destructive' | 'warning' | 'info';
    readonly label: string;
    readonly surface: string;
  }
> = {
  danger: {
    badge: 'destructive',
    label: 'Urgent',
    surface: 'border-destructive/20 bg-destructive/[0.035]',
  },
  warning: {
    badge: 'warning',
    label: 'Due soon',
    surface: 'border-warning/25 bg-warning/[0.045]',
  },
  notice: {
    badge: 'info',
    label: 'Review',
    surface: 'border-primary/15 bg-primary/[0.025]',
  },
};

function dueLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days < 0) return `${String(-days)} days overdue`;
  if (days === 0) return 'Due today';
  return `${String(days)} days left`;
}

export function OperationsDashboard({
  api,
  organisationId,
  canModify,
  onOpenWork,
  onOpenWorks,
  onUploadLoa,
  onOpenApprovals,
}: OperationsDashboardProps) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .dashboard(organisationId)
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'The dashboard could not be loaded.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  const sortedWorks = useMemo(
    () =>
      [...(data?.works ?? [])].sort((left, right) => {
        if (left.status === right.status) {
          return right.contractValue.localeCompare(left.contractValue);
        }
        if (left.status === 'active') return -1;
        if (right.status === 'active') return 1;
        return left.status.localeCompare(right.status);
      }),
    [data],
  );

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
      <div className="flex flex-col gap-5" aria-busy="true">
        <div>
          <p className="mb-1 text-xs font-semibold tracking-[0.16em] text-primary uppercase">
            Operations overview
          </p>
          <h1 tabIndex={-1}>Dashboard</h1>
          <p className="text-muted-foreground" role="status">
            Loading the latest contract position…
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <div
              key={index}
              className="h-28 animate-pulse rounded-2xl border border-border bg-card"
            />
          ))}
        </div>
      </div>
    );
  }

  const deliveryPercent = progressPercent(
    data.totals.deliveredValue,
    data.totals.contractValue,
  );
  const billedPercent = progressPercent(
    data.totals.billedValue,
    data.totals.contractValue,
  );
  const activeWorks = data.works.filter((work) => work.status === 'active').length;
  const completedWorks = data.works.filter(
    (work) => work.status === 'completed',
  ).length;
  const urgentAlerts = data.alerts.filter(
    (alert) => alert.severity === 'danger',
  ).length;

  const metrics = [
    {
      label: 'Active Works',
      value: String(activeWorks),
      helper: `${String(completedWorks)} completed`,
      icon: BriefcaseBusiness,
      tone: 'bg-primary/10 text-primary',
    },
    {
      label: 'Delivered value',
      value: formatCompactInr(data.totals.deliveredValue),
      helper: `${String(deliveryPercent)}% of contract value`,
      icon: CheckCircle2,
      tone: 'bg-success/10 text-success',
    },
    {
      label: 'Billed value',
      value: formatCompactInr(data.totals.billedValue),
      helper: `${String(billedPercent)}% of contract value`,
      icon: FileText,
      tone: 'bg-primary/10 text-primary',
    },
    {
      label: 'Open drafts',
      value: String(data.totals.openDrafts),
      helper: 'Documents still in progress',
      icon: Clock3,
      tone: 'bg-warning/15 text-warning-foreground',
    },
    {
      label: 'LOAs to review',
      value: String(data.totals.loaAwaitingReview),
      helper:
        urgentAlerts > 0 ? `${String(urgentAlerts)} urgent alerts` : 'No urgent alerts',
      icon: FileSearch,
      tone: 'bg-destructive/10 text-destructive',
    },
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-1 text-xs font-semibold tracking-[0.16em] text-primary uppercase">
            Operations overview
          </p>
          <h1 tabIndex={-1} className="mb-1 text-3xl leading-tight">
            Dashboard
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Contract execution, deadlines and payment position in one place.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Button variant="outline" onClick={onOpenWorks}>
            View all Works
          </Button>
          {canModify && (
            <Button onClick={onUploadLoa}>
              <Upload aria-hidden="true" />
              Upload LOA
            </Button>
          )}
        </div>
      </header>

      <section
        aria-label="Organisation summary"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
      >
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <article
              key={metric.label}
              className="group rounded-2xl border border-border/80 bg-card p-5 shadow-[0_1px_2px_rgba(16,24,40,0.03),0_8px_24px_rgba(16,24,40,0.035)] transition-transform hover:-translate-y-0.5"
            >
              <div className="mb-5 flex items-start justify-between gap-3">
                <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {metric.label}
                </span>
                <span
                  className={`inline-flex size-9 items-center justify-center rounded-xl ${metric.tone}`}
                >
                  <Icon className="size-4" aria-hidden="true" />
                </span>
              </div>
              <strong className="block text-2xl font-semibold tracking-tight tabular-nums">
                {metric.value}
              </strong>
              <span className="mt-1 block text-xs text-muted-foreground">
                {metric.helper}
              </span>
            </article>
          );
        })}
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(21rem,0.6fr)]">
        <Card className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 className="m-0 text-base">Needs attention</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                The highest-priority actions across the organisation.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onOpenApprovals}>
              Approval queue
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
          {data.alerts.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center">
              <span className="mb-3 inline-flex size-11 items-center justify-center rounded-2xl bg-success/10 text-success">
                <CheckCircle2 aria-hidden="true" />
              </span>
              <p className="font-medium">Nothing needs immediate attention.</p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Expiring guarantees, overdue completion dates, LOA reviews and open
                drafts will appear here.
              </p>
            </div>
          ) : (
            <ul className="m-0 divide-y divide-border p-0">
              {data.alerts.slice(0, 7).map((alert, index) => {
                const tone = ALERT_TONE[alert.severity];
                const due = dueLabel(alert.dueInDays);
                return (
                  <li
                    key={`${alert.kind}-${String(index)}`}
                    className={`flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center ${tone.surface}`}
                  >
                    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-card shadow-sm">
                      {alert.severity === 'danger' ? (
                        <AlertTriangle className="size-4 text-destructive" />
                      ) : (
                        <Clock3 className="size-4 text-warning-foreground" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={tone.badge}>{tone.label}</Badge>
                        {due !== null && (
                          <span className="text-xs font-medium text-muted-foreground tabular-nums">
                            {due}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm leading-5">{alert.message}</p>
                    </div>
                    {alert.workId !== null && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (alert.workId !== null) onOpenWork(alert.workId);
                        }}
                      >
                        Open {alert.workCode ?? 'Work'}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="flex flex-col">
          <div>
            <h2 className="m-0 text-base">Execution progress</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Delivered and billed value against the current contract portfolio.
            </p>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center py-7">
            <div
              className="relative grid size-44 place-items-center rounded-full"
              style={{
                background: `conic-gradient(var(--primary) ${String(
                  deliveryPercent * 3.6,
                )}deg, var(--muted) 0deg)`,
              }}
              role="img"
              aria-label={`${String(deliveryPercent)} percent of contract value delivered`}
            >
              <div className="grid size-32 place-items-center rounded-full bg-card text-center shadow-inner">
                <span>
                  <strong className="block text-3xl font-semibold tracking-tight tabular-nums">
                    {deliveryPercent}%
                  </strong>
                  <span className="text-xs text-muted-foreground">delivered</span>
                </span>
              </div>
            </div>
            <dl className="mt-6 grid w-full grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl bg-muted/55 p-3">
                <dt className="text-xs text-muted-foreground">Contract value</dt>
                <dd className="mt-1 font-semibold tabular-nums">
                  {formatCompactInr(data.totals.contractValue)}
                </dd>
              </div>
              <div className="rounded-xl bg-primary/5 p-3">
                <dt className="text-xs text-muted-foreground">Billed</dt>
                <dd className="mt-1 font-semibold text-primary tabular-nums">
                  {formatCompactInr(data.totals.billedValue)}
                </dd>
              </div>
            </dl>
          </div>
        </Card>
      </section>

      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="m-0 text-base">Work portfolio</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Live delivery and billing progress for the largest current Works.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onOpenWorks}>
            View all Works
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
        {sortedWorks.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
            <BriefcaseBusiness className="mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">No Works have been created yet.</p>
            {canModify && (
              <Button className="mt-4" onClick={onUploadLoa}>
                Upload the first LOA
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">Work execution and billing progress</caption>
              <thead>
                <tr className="border-b border-border bg-muted/35 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  <th className="px-5 py-3">Work</th>
                  <th className="px-5 py-3">Delivery progress</th>
                  <th className="px-5 py-3 text-right">Delivered</th>
                  <th className="px-5 py-3 text-right">Billed</th>
                  <th className="px-5 py-3 text-right">DCs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedWorks.slice(0, 8).map((work) => {
                  const percent = progressPercent(
                    work.deliveredValue,
                    work.contractValue,
                  );
                  return (
                    <tr
                      key={work.workId}
                      className="transition-colors hover:bg-muted/35"
                    >
                      <th scope="row" className="px-5 py-4 text-left font-normal">
                        <button
                          type="button"
                          className="font-semibold text-primary hover:underline"
                          onClick={() => {
                            onOpenWork(work.workId);
                          }}
                        >
                          {work.workCode}
                        </button>
                        <p className="mt-0.5 max-w-lg text-xs text-muted-foreground">
                          {work.title}
                        </p>
                      </th>
                      <td className="px-5 py-4">
                        <div className="flex min-w-44 items-center gap-3">
                          <ProgressBar
                            value={percent}
                            label={`${work.workCode} delivery progress`}
                            className="h-2 flex-1 bg-muted"
                          />
                          <span className="w-9 text-right text-xs font-semibold tabular-nums">
                            {percent}%
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-right font-mono text-xs tabular-nums">
                        {formatInr(work.deliveredValue)}
                      </td>
                      <td className="px-5 py-4 text-right font-mono text-xs tabular-nums">
                        {formatInr(work.billedValue)}
                      </td>
                      <td className="px-5 py-4 text-right font-mono text-xs tabular-nums">
                        {work.issuedChallans}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
