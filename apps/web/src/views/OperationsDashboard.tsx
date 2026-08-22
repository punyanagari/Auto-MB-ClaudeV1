import { useEffect, useRef, useState } from 'react';
import type {
  Contact,
  DashboardResponse,
  OrganisationProfile,
  Signatory,
} from '@auto-mb/contracts';
import { CheckCircle2, CircleAlert, Upload } from 'lucide-react';
import type { ApiClient } from '../api.js';
import { formatCompactInr, formatServerPercent } from '../format.js';
import { missingOrganisationFacts } from '../lib/organisation-facts.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import {
  mastersHash,
  SETTINGS_HASH,
  workspaceHashOf,
} from '../lib/workspace-routes.js';
import { Card } from '../ui/card.js';
import { PageHeader } from '../ui/page-header.js';
import { Stat } from '../ui/stat.js';
import { FormError } from '../ui/form.js';
import { AttentionStrip } from './dashboard/AttentionStrip.js';
import {
  BilledReceivedChart,
  BilledReceivedLegend,
} from './dashboard/BilledReceivedChart.js';
import { CompletionPanel } from './dashboard/CompletionPanel.js';
import { DeadlineStrip } from './dashboard/DeadlineStrip.js';
import {
  WorkExecutionBars,
  WorkExecutionLegend,
} from './dashboard/WorkExecutionBars.js';

interface OperationsDashboardProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly canModify: boolean;
  readonly onOpenWork: (workId: string) => void;
  /** Opens the Work at its extension composer — `?focus=extension` on the
   * Work address, so the operator lands on the field they have to fill
   * rather than at the top of a long Overview. */
  readonly onRequestExtension: (workId: string) => void;
  readonly onOpenWorks: () => void;
  readonly onOpenHistoricalInvoices: () => void;
  readonly onUploadLoa: () => void;
}

const UPLOAD_HASH = workspaceHashOf({ view: { name: 'upload', tenderId: null } });
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
  const [loadVersion, retry] = useReload();

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
          <Button variant="outline" size="sm" onClick={retry}>
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
 * The signed-in landing screen.
 *
 * WHAT IT IS FOR, since it stopped being a list of Works. The register in
 * the rail lists Works better than a truncated copy of it ever did — it
 * sorts, filters and pages — so the dashboard was spending its best space
 * repeating a screen one click away. It now answers four questions
 * instead, in the order an operator asks them (owner decision 2026-08-22,
 * `docs/UX.md` § 38):
 *
 *   1. Where does the running portfolio stand?      — the four tiles
 *   2. Is anything on fire?                         — the attention strip
 *   3. What is about to lapse, and what did we bill
 *      against what came in?                        — completion + billing
 *   4. Which Works are behind, and what falls due?   — execution + deadlines
 *
 * NOTHING ON THIS SCREEN COMPUTES MONEY. Every rupee figure, every
 * percentage and every day count arrives from `/api/dashboard` as an
 * exact string the server derived; this file formats and positions them.
 * Percentages become bar lengths, which is drawing, not arithmetic.
 */
export function OperationsDashboard({
  api,
  organisationId,
  canModify,
  onOpenWork,
  onRequestExtension,
  onOpenWorks,
  onOpenHistoricalInvoices,
  onUploadLoa,
}: OperationsDashboardProps) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* The two panels the attention strip sends a reader to. They are on
     this screen rather than behind a route, so the strip moves the
     viewport instead of navigating. */
  const completionsRef = useRef<HTMLElement | null>(null);
  const deadlinesRef = useRef<HTMLElement | null>(null);

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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className="h-28 animate-pulse rounded-2xl border border-border bg-card"
            />
          ))}
        </div>
      </div>
    );
  }

  const { signals } = data;
  // The server's ratio, never a division here: each Work's GST basis
  // decides what its contract value is comparable with (migration 0062),
  // and the browser does not know it.
  const executedLabel = formatServerPercent(signals.activeExecutedPercent);

  /* The mock's stat row (`app/page`): a `.data-surface` panel split by
     hairline gaps into equal cells, each one a `Stat` — the 11px uppercase
     label, the mono tabular figure, the qualifier beneath.

     Four tiles, and all four about the ACTIVE portfolio. A completed
     Work's contract value never leaves a whole-register total, so the old
     headline drifted upward forever and described nothing anybody could
     act on. `totals` still carries the whole-register reading for
     anything that wants it. */
  const metrics = [
    {
      label: 'Active Works',
      value: String(signals.activeWorks),
      hint: `${String(data.totals.works)} in the register`,
      tone: 'default',
    },
    /* TWO TILES, TWO BASES, AND EACH ONE SAYS WHICH.
     *
     * These used to be one sentence — "₹45.2 L, of which executed ₹300
     * (0.0066%)" — and the three numbers in it did not share a basis. The
     * two rupee figures are the letters' own printed amounts added up,
     * and a portfolio mixing GST-inclusive and GST-exclusive letters
     * makes that sum a figure on no basis at all; the percentage
     * restates every term as taxable value before dividing, because
     * `executed-value.ts` names taxable value as the only honest basis
     * for a cross-Work ratio. So the sentence stated a ratio that was
     * true of neither amount printed beside it.
     *
     * Split rather than reconciled. The headline stays the rupees an
     * owner reads off the letters — that is what the tile is for — and
     * says so. The ratio moves to its own tile with the two taxable
     * figures it is genuinely the quotient of, and says that. Neither
     * tile now contains a number that disagrees with its neighbours. */
    {
      label: 'Active contract value',
      value: formatCompactInr(signals.activeContractValue),
      // Short enough to survive the tile's single truncating line at
      // 320px; the basis it is NOT on is named by the tile beside it.
      hint: 'The letters’ own figures',
      tone: 'default',
    },
    {
      label: 'Executed value',
      value: executedLabel ?? '—',
      hint:
        executedLabel === null
          ? 'No contract value recorded'
          : `${formatCompactInr(signals.activeBilledTaxableValue)} of ${formatCompactInr(signals.activeContractTaxableValue)} taxable`,
      tone: 'default',
    },
    {
      label: 'Receivable outstanding',
      value: formatCompactInr(signals.receivableOutstanding),
      hint:
        signals.receivableIndeterminate === 0
          ? 'Against the railway’s own certified bills'
          : signals.receivableIndeterminate === 1
            ? '1 bill awaits a railway figure'
            : `${String(signals.receivableIndeterminate)} bills await a railway figure`,
      tone: signals.receivableIndeterminate > 0 ? 'warning' : 'default',
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

      {/* First run. Above everything on purpose: four zero tiles and
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
        aria-label="Active portfolio"
        className="data-surface grid grid-cols-2 gap-px bg-border lg:grid-cols-4"
      >
        {/* `min-w-0` is the width guard `ui/card.tsx` documents, applied to
            a grid cell: a grid item's default `min-width: auto` refuses to
            shrink below its content, so one long mono figure would widen
            its column past half a 320px screen and scroll the page
            sideways. */}
        {metrics.map((metric) => (
          <div key={metric.label} className="min-w-0 bg-card p-4 sm:p-5">
            <Stat
              label={metric.label}
              value={metric.value}
              hint={metric.hint}
              tone={metric.tone}
            />
          </div>
        ))}
      </section>

      {/* WHOSE PORTFOLIO THIS IS. A member scoped to their assignments
          gets tiles summing their slice, and a total that is not the
          organisation's has to say so — otherwise it reads as the
          organisation's and is quietly, plausibly wrong. Rendered only
          for the members it applies to; a full-scope reader needs no
          sentence explaining that everything means everything. */}
      {signals.assignedScopeOnly && (
        <p className="m-0 -mt-2 text-xs text-muted-foreground">
          Across the Works you are assigned to, not the whole organisation.
        </p>
      )}

      <AttentionStrip
        signals={signals}
        completionsRef={completionsRef}
        deadlinesRef={deadlinesRef}
      />

      <section className="grid gap-5 lg:grid-cols-5">
        <Card
          ref={completionsRef}
          tabIndex={-1}
          aria-labelledby="dashboard-completions-heading"
          className="min-w-0 p-0 lg:col-span-2"
        >
          <div className="border-b border-border px-5 py-4">
            <h2 id="dashboard-completions-heading" className="m-0 text-base">
              Completion dates
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Active Works reaching their contract completion date within 60 days.
            </p>
          </div>
          <CompletionPanel
            completions={data.completions}
            onOpenWork={onOpenWork}
            onRequestExtension={onRequestExtension}
          />
        </Card>

        <Card
          aria-labelledby="dashboard-billing-heading"
          className="min-w-0 lg:col-span-3"
        >
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="dashboard-billing-heading" className="m-0 text-base">
                Billed against received
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Tax invoices submitted, net of credit notes, beside the money that
                reached the bank. Both figures include GST.
              </p>
            </div>
            <BilledReceivedLegend />
          </div>
          <BilledReceivedChart
            months={data.monthlyBilling}
            billingSince={signals.billingSince}
            onOpenHistorical={onOpenHistoricalInvoices}
          />
        </Card>
      </section>

      <Card aria-labelledby="dashboard-execution-heading" className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 id="dashboard-execution-heading" className="m-0 text-base">
              Supply and installation
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Every active Work against its contract value, nearest completion date
              first.
            </p>
          </div>
          <WorkExecutionLegend />
        </div>
        <div className="py-1">
          <WorkExecutionBars rows={data.execution} onOpenWork={onOpenWork} />
        </div>
      </Card>

      <Card
        ref={deadlinesRef}
        tabIndex={-1}
        aria-labelledby="dashboard-deadlines-heading"
      >
        <div className="mb-1">
          <h2 id="dashboard-deadlines-heading" className="m-0 text-base">
            Next 90 days
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Completion dates, guarantee and certificate expiries, and defect liability
            periods ending.
          </p>
        </div>
        <DeadlineStrip
          deadlines={data.deadlines}
          expired={data.alerts.filter((alert) => alert.kind === 'instrument_expired')}
          onOpenWork={onOpenWork}
        />
      </Card>
    </div>
  );
}
