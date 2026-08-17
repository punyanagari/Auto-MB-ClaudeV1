import { useEffect, useMemo, useState } from 'react';
import type {
  Contact,
  DashboardAlert,
  DashboardBillSettlement,
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
import { PageHeader } from '../ui/page-header.js';
import { ProgressBar } from '../ui/progress.js';
import { Stat } from '../ui/stat.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
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

/**
 * The settlement position behind a bill alert: the railway's own bill, and
 * the three figures §5.7 says it takes to state the position honestly.
 *
 * Rendered only where there IS arithmetic. While the measurement is open
 * there is no reference figure and no outstanding one, and a row of
 * dashes beside two zeroes would say less than the alert's own sentence
 * already does. Nothing here divides, adds or compares money — every
 * figure arrives from the server as an exact decimal string.
 */
function SettlementFigures({
  settlement,
}: {
  readonly settlement: DashboardBillSettlement;
}) {
  const { reference, outstanding } = settlement;
  if (reference === null || outstanding === null) return null;
  const figures = [
    { label: 'Railway bill', amount: reference, lead: false },
    { label: 'Received', amount: settlement.received, lead: false },
    { label: 'Deducted', amount: settlement.deducted, lead: false },
    // The one an operator is actually reading for, and the one the old
    // single sentence could not say.
    { label: 'Outstanding', amount: outstanding, lead: true },
  ];
  return (
    <dl className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
      {figures.map((figure) => (
        <div key={figure.label} className="flex items-baseline gap-1">
          <dt className="text-muted-foreground">{figure.label}</dt>
          <dd
            className={`m-0 font-mono tabular-nums ${figure.lead ? 'font-semibold' : ''}`}
          >
            {formatInr(figure.amount)}
          </dd>
        </div>
      ))}
    </dl>
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

  /* The mock's stat row (`app/page`): a `.data-surface` panel split by
     hairline gaps into equal cells, each one a `Stat` — the 11px uppercase
     label, the mono tabular figure, the qualifier beneath. The retired
     tiles carried a coloured icon chip and a lift-on-hover; the mock has
     neither, and a dashboard's job is to be read, not to respond.

     `tone` is emphasis only, never the message: what is wrong is said in
     the hint, which is why the two tiles that can carry bad news still
     spell it out in words. */
  const metrics = [
    {
      label: 'Active Works',
      value: String(activeWorks),
      hint: `${String(completedWorks)} completed`,
      tone: 'default',
    },
    {
      label: 'Delivered value',
      value: formatCompactInr(data.totals.deliveredValue),
      hint: `${String(deliveryPercent)}% of contract value`,
      tone: 'success',
    },
    {
      label: 'Billed value',
      value: formatCompactInr(data.totals.billedValue),
      hint:
        executedLabel === null
          ? 'No contract value recorded'
          : `${executedLabel} of contract value`,
      tone: 'default',
    },
    {
      label: 'Open drafts',
      value: String(data.totals.openDrafts),
      hint: 'Documents still in progress',
      tone: data.totals.openDrafts > 0 ? 'warning' : 'default',
    },
    {
      label: 'LOAs to review',
      value: String(data.totals.loaAwaitingReview),
      hint:
        urgentAlerts > 0 ? `${String(urgentAlerts)} urgent alerts` : 'No urgent alerts',
      tone: urgentAlerts > 0 ? 'warning' : 'default',
    },
  ] as const;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Operations overview"
        title="Dashboard"
        description="Contract execution, deadlines and payment position in one place."
        className="mb-0"
        action={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Button variant="outline" onClick={onOpenWorks}>
              View all Works
            </Button>
            {canModify && (
              <Button onClick={onUploadLoa}>
                <Upload data-icon="inline-start" aria-hidden="true" />
                Upload LOA
              </Button>
            )}
          </div>
        }
      />

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
        className="data-surface grid grid-cols-2 gap-px bg-border lg:grid-cols-5"
      >
        {metrics.map((metric) => (
          <div key={metric.label} className="bg-card p-4 sm:p-5">
            <Stat
              label={metric.label}
              value={metric.value}
              hint={metric.hint}
              tone={metric.tone}
            />
          </div>
        ))}
      </section>

      {/* The mock's two-column body (`app/page`): the Works panel on
          the left at three columns of five, what needs a decision on the
          right at two. The retired third panel — a conic-gradient donut of
          the delivery percentage over two value chips — is gone rather
          than re-skinned: the mock draws no such thing, and every figure
          it carried is already in the stat row above it (delivered value
          with its percentage, billed value, contract value). */}
      <section className="grid gap-5 lg:grid-cols-5">
        <Card className="min-w-0 p-0 lg:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 className="m-0 text-base">Work portfolio</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Live delivery and billing progress for the largest current Works.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onOpenWorks}>
              View all Works
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
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
            <div className="px-3 pb-3">
              {/* The shared register table, so the dashboard's numbers sit
                  in the same grammar as every other ledger in the product:
                  sticky 11px uppercase heading, hairline rules, mono
                  tabular figures right-aligned. It replaces a hand-rolled
                  table that had invented its own padding, heading styles
                  and hover.

                  Its scrollport is left on. Five columns of Work code,
                  progress bar and three money figures do not fit a
                  320px phone, and without a box of its own the table
                  pushes the whole dashboard sideways —
                  `e2e/responsive.spec.ts` measures exactly that. */}
              <DataTable>
                <caption className="sr-only">
                  Work execution and billing progress
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Work</th>
                    <th scope="col">Delivery progress</th>
                    <th scope="col" className={numericCell}>
                      Delivered
                    </th>
                    <th scope="col" className={numericCell}>
                      Billed
                    </th>
                    <th scope="col" className={numericCell}>
                      DCs
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedWorks.slice(0, 8).map((work) => {
                    const percent = progressPercent(
                      work.deliveredValue,
                      work.contractValue,
                    );
                    return (
                      <tr key={work.workId}>
                        <th scope="row">
                          {/* A real link so a Work can be middle-clicked
                              into its own tab; a left click stays in-app. */}
                          <a
                            href={workHash(work.workId)}
                            className="font-mono font-semibold"
                            onClick={navigateOnClick(() => {
                              onOpenWork(work.workId);
                            })}
                          >
                            {work.workCode}
                          </a>
                          <p
                            className={`mt-0.5 text-xs text-muted-foreground ${wrapCell}`}
                          >
                            {work.title}
                          </p>
                        </th>
                        <td>
                          <div className="flex min-w-40 items-center gap-2">
                            <ProgressBar
                              value={percent}
                              label={`${work.workCode} delivery progress`}
                              className="h-1.5 flex-1 bg-muted"
                            />
                            <span className="w-9 text-right font-mono text-xs text-muted-foreground tabular-nums">
                              {percent}%
                            </span>
                          </div>
                        </td>
                        <td className={numericCell}>
                          {formatInr(work.deliveredValue)}
                        </td>
                        <td className={numericCell}>{formatInr(work.billedValue)}</td>
                        <td className={numericCell}>{work.issuedChallans}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            </div>
          )}
        </Card>

        <Card className="min-w-0 p-0 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 className="m-0 text-base">Needs attention</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                The highest-priority actions across the organisation.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onOpenApprovals}>
              Approval queue
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
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
              {/* The first seven of a list the server has already ranked
                  by severity, so what this drops is always the least
                  urgent. It used to drop whatever the server happened to
                  build last, which on a busy organisation could be an
                  overdue PBG. */}
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
                      {alert.settlement !== null && (
                        <SettlementFigures settlement={alert.settlement} />
                      )}
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
      </section>
    </div>
  );
}
