import { useEffect, useMemo, useState } from 'react';
import type {
  Contact,
  DashboardAlert,
  DashboardResponse,
  OrganisationProfile,
  Signatory,
} from '@auto-mb/contracts';
import {
  AlertTriangle,
  ArrowRight,
  BriefcaseBusiness,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileSearch,
  FileText,
  Upload,
} from 'lucide-react';
import type { ApiClient } from '../api.js';
import {
  compareDecimalStrings,
  formatCompactInr,
  formatInr,
  formatServerPercent,
  progressPercent,
} from '../format.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import {
  mastersHash,
  navigateOnClick,
  SETTINGS_HASH,
  workHash,
  workspaceHashOf,
} from '../lib/workspace-routes.js';
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

const UPLOAD_HASH = workspaceHashOf({ view: { name: 'upload' } });
/** The register that lists uploaded letters and their Review action. */
const WORKS_HASH = workspaceHashOf({ view: { name: 'works' } });

interface SetupStep {
  readonly key: string;
  readonly label: string;
  readonly ok: boolean;
  /** What is still missing. Shown only while not ok. */
  readonly detail: string;
  readonly fix: { readonly label: string; readonly hash: string };
}

/** The seller facts a submitted invoice needs — the same list
 * `WorkBillingReadiness` mirrors, asked one screen earlier so a new
 * organisation meets them before a Work depends on them. */
function missingOrganisationFacts(profile: OrganisationProfile): readonly string[] {
  return [
    ...((profile.stateCode ?? null) === null ? ['GST state code'] : []),
    ...(profile.gstin === null ? ['GSTIN'] : []),
    ...(profile.address === null ? ['address'] : []),
    ...((profile.pincode ?? null) === null ? ['PIN code'] : []),
    ...((profile.locality ?? null) === null ? ['locality'] : []),
  ];
}

/**
 * What a brand-new organisation has to do before this product can produce
 * a document, on the one screen it lands on.
 *
 * Rendered only while the organisation has no Works, because that is the
 * only moment the answer is the same for everyone; after the first Work the
 * per-Work `WorkBillingReadiness` panel takes over, and this reuses its
 * shape deliberately — a prerequisite, what is missing, and a link to the
 * screen that fixes it. Everything is derived from reads the app already
 * exposes; nothing here is a new server concept.
 *
 * A read-only member gets one sentence instead: sending someone to a screen
 * whose buttons their role does not have is the dead end this replaces, not
 * a fix for it.
 */
function SetupChecklist({
  api,
  organisationId,
  canModify,
  loaAwaitingReview,
  onUploadLoa,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly canModify: boolean;
  /** A letter already uploaded and waiting to be confirmed into a Work.
   * The first step is then half-done, and saying so is the difference
   * between guidance and nagging. */
  readonly loaAwaitingReview: number;
  readonly onUploadLoa: () => void;
}) {
  const [profile, setProfile] = useState<OrganisationProfile | null>(null);
  const [signatories, setSignatories] = useState<readonly Signatory[] | null>(null);
  const [contacts, setContacts] = useState<readonly Contact[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setSignatories(null);
    setContacts(null);
    setFailed(false);
    // A read-only member is answered with one sentence below and never
    // sees the checklist, so the three reads behind it are not made.
    if (!canModify) return;
    Promise.all([
      api.organisationProfile(organisationId),
      api.listSignatories(organisationId),
      api.listContacts(organisationId),
    ])
      .then(([organisationProfile, signatoryRows, contactRows]) => {
        if (cancelled) return;
        // A stubbed or degraded client may resolve nothing; render the
        // failed state rather than crashing on a missing profile.
        if ((organisationProfile as OrganisationProfile | undefined) === undefined) {
          setFailed(true);
          return;
        }
        setProfile(organisationProfile);
        setSignatories(signatoryRows ?? []);
        setContacts(contactRows ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, canModify, loadVersion]);

  if (!canModify) {
    return (
      <Card aria-labelledby="setup-checklist-heading">
        <h2 id="setup-checklist-heading" className="m-0 text-base">
          Nothing is set up yet
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This organisation has no Works. An owner or office member uploads the first
          Letter of Acceptance; everything you can see follows from it.
        </p>
      </Card>
    );
  }

  if (failed) {
    return (
      <Card aria-labelledby="setup-checklist-heading">
        <h2 id="setup-checklist-heading" className="m-0 text-base">
          First steps
        </h2>
        <FormError>
          The setup checklist could not be loaded. Nothing is blocked — uploading the
          first Letter of Acceptance still works.
        </FormError>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onUploadLoa}>
            <Upload aria-hidden="true" />
            Upload the first LOA
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoadVersion((current) => current + 1);
            }}
          >
            Retry the checklist
          </Button>
        </div>
      </Card>
    );
  }

  if (profile === null || signatories === null || contacts === null) {
    return (
      <Card aria-labelledby="setup-checklist-heading">
        <h2 id="setup-checklist-heading" className="m-0 text-base">
          First steps
        </h2>
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          Checking what this organisation still needs…
        </p>
      </Card>
    );
  }

  const missingOrgFacts = missingOrganisationFacts(profile);
  const activeSignatories = signatories.filter((row) => row.active);
  const activeClients = contacts.filter((row) => row.isClient && row.active);

  const steps: readonly SetupStep[] = [
    {
      key: 'loa',
      label: 'Upload the first Letter of Acceptance',
      // Only rendered with zero Works, so this step is never done here.
      ok: false,
      detail:
        loaAwaitingReview > 0
          ? `${String(loaAwaitingReview)} uploaded letter${loaAwaitingReview === 1 ? '' : 's'} ${loaAwaitingReview === 1 ? 'is' : 'are'} waiting for review. Confirming the extraction creates the Work.`
          : 'The letter is where a Work comes from — its schedules, quantities and rates are read from it, not typed.',
      fix:
        loaAwaitingReview > 0
          ? { label: 'Review the uploaded letter', hash: WORKS_HASH }
          : { label: 'Upload a Letter of Acceptance', hash: UPLOAD_HASH },
    },
    {
      key: 'signatory',
      label: 'Record who signs your documents',
      ok: activeSignatories.length > 0,
      detail:
        'Challans, measurement books and invoices print a signatory; there is none to choose yet.',
      fix: { label: 'Open Masters → Signatories', hash: mastersHash('signatories') },
    },
    {
      key: 'client',
      label: 'Add the railway unit you invoice',
      ok: activeClients.length > 0,
      detail:
        'A tax invoice names a client contact as the buyer, with its address, state code and PIN.',
      fix: { label: 'Open Masters → Contacts', hash: mastersHash('contacts') },
    },
    {
      key: 'org-gst',
      label: "Complete your organisation's GST profile",
      ok: missingOrgFacts.length === 0,
      detail: `Missing: ${missingOrgFacts.join(', ')}. An invoice cannot be submitted without them.`,
      fix: { label: 'Open organisation settings', hash: SETTINGS_HASH },
    },
  ];

  const done = steps.filter((step) => step.ok).length;

  return (
    <Card aria-labelledby="setup-checklist-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="setup-checklist-heading" className="m-0 text-base">
            First steps
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {done} of {steps.length}
            </span>{' '}
            done. Nothing here blocks the next — the letter can be uploaded first and
            the masters filled in as documents need them.
          </p>
        </div>
        <Button onClick={onUploadLoa}>
          <Upload aria-hidden="true" />
          Upload the first LOA
        </Button>
      </div>
      <ol className="my-3 flex list-none flex-col gap-2 p-0">
        {steps.map((step) => (
          <li key={step.key} className="flex items-start gap-2 text-[13px]">
            {step.ok ? (
              <CheckCircle2
                className="mt-0.5 size-4 shrink-0 text-success"
                aria-hidden="true"
              />
            ) : (
              <CircleAlert
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span>
              <span className="font-medium">{step.label}</span>
              <span className="sr-only">{step.ok ? ' — done' : ' — still to do'}</span>
              {!step.ok && (
                <>
                  {' '}
                  <span className="text-muted-foreground">{step.detail}</span>{' '}
                  <a href={step.fix.hash}>{step.fix.label}</a>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

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
          return compareDecimalStrings(right.contractValue, left.contractValue);
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
  // Executed value against contract — the number work completion is
  // argued about. Taken from the server, never divided here: each Work's
  // GST basis decides what its contract value is comparable with, and the
  // browser does not know it (migration 0062).
  const executedLabel = formatServerPercent(data.totals.executedPercent);
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
      helper:
        executedLabel === null
          ? 'No contract value recorded'
          : `${executedLabel} of contract value`,
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
          <h1 tabIndex={-1} className="mb-1">
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

      {/* First run. Above the metrics on purpose: five zero tiles and
          "nothing needs attention" are an accurate description of an
          organisation that has not started, and useless as a next move. */}
      {data.works.length === 0 && (
        <SetupChecklist
          api={api}
          organisationId={organisationId}
          canModify={canModify}
          loaAwaitingReview={data.totals.loaAwaitingReview}
          onUploadLoa={onUploadLoa}
        />
      )}

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
                    {alert.workId !== null ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (alert.workId !== null) onOpenWork(alert.workId);
                        }}
                      >
                        Open {alert.workCode ?? 'Work'}
                      </Button>
                    ) : alert.kind === 'loa_review_pending' ? (
                      <Button variant="outline" size="sm" onClick={onOpenWorks}>
                        Review LOAs
                      </Button>
                    ) : null}
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
            {/* The action lives once, in the First steps panel at the top
                of this screen; a second copy of the same button here read
                as a second, different thing to do. */}
            <p className="font-medium">
              {canModify
                ? 'No Works yet — the first one is created from an uploaded Letter of Acceptance.'
                : 'No Works yet. An owner or office member uploads the first Letter of Acceptance.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">Work execution and billing progress</caption>
              <thead>
                <tr className="border-b border-border bg-muted/35 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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
                        {/* A real link so a Work can be middle-clicked
                            into its own tab; a left click stays in-app. */}
                        <a
                          href={workHash(work.workId)}
                          className="font-semibold text-primary no-underline hover:underline"
                          onClick={navigateOnClick(() => {
                            onOpenWork(work.workId);
                          })}
                        >
                          {work.workCode}
                        </a>
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
