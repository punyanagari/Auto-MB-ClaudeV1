import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  ApprovalRequest,
  Bill,
  BillListResponse,
  BillSummary,
  Challan,
  CorrectionNotice,
  Instrument,
  InstallationCounts,
  IssueChallan,
  MbEntry,
  PaymentMatrixCategory,
  PaymentMatrixRow,
  PurchaseOrder,
  Serial,
  UnfinishedWorkItem,
  WorkCompletionBlocker,
  SupersedeEligibilityResponse,
  WorkCompletionReadiness,
  WorkDetailResponse,
  WorkSupersession,
} from '@auto-mb/contracts';
import { CircleAlert } from 'lucide-react';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import {
  formatCompactInr,
  formatDate,
  formatInr,
  formatTimestampDate,
} from '../format.js';
import { cn } from '../lib/cn.js';
import { errorMessage } from '../lib/load-failure.js';
import { categoryLabelOf } from '../lib/payment-matrix.js';
import { useReload } from '../lib/view-state.js';
import { wayfindingOf, type Wayfind } from '../lib/wayfinding.js';
import { Button } from '../ui/button.js';
import { Badge } from '../ui/badge.js';
import { Card } from '../ui/card.js';
import { Stat } from '../ui/stat.js';
import { DataTable, numericCell } from '../ui/table.js';
import { Field, Actions, FormError, FormNotice } from '../ui/form.js';
import { ErrorState, LoadingState } from '../ui/state.js';
import { Timeline } from './Timeline.js';
import { CompletionExtensions } from './CompletionExtensions.js';
import { WorkConsignees } from './WorkConsignees.js';
import { WorkInstruments } from './WorkInstruments.js';
import { WorkBills } from './WorkBills.js';
import { WorkIssueChallans } from './WorkIssueChallans.js';
import { WorkAmendments } from './WorkAmendments.js';
import { WorkInspectionClause } from './WorkInspectionClause.js';
import { WorkSchedules } from './WorkSchedules.js';
import { WorkMeasurement } from './WorkMeasurement.js';
import { WorkBillingReadiness } from './WorkBillingReadiness.js';
import { WorkBillSettlement } from './WorkBillSettlement.js';
import { WorkDeliveries } from './WorkDeliveries.js';
import { WorkInstallations } from './WorkInstallations.js';
import { WorkPaymentSetup } from './WorkPaymentSetup.js';
import { WorkPurchaseOrders } from './WorkPurchaseOrders.js';
import { WorkTaxInvoices } from './WorkTaxInvoices.js';

interface WorkDetailProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canModify: boolean;
  readonly canRecordEvidence: boolean;
  readonly canIssue: boolean;
  readonly canSign: boolean;
  readonly canCancel: boolean;
  /** Holds can_approve_amendments — gates manual back-fill deletion. */
  readonly canApprove: boolean;
  /** Holds can_manage_statutory_reporting — gates the IRP/NIC portal
   * surfaces inside the tax-invoice tab (migration 0061). */
  readonly canManageStatutory: boolean;
  /** Holds can_manage_retention — gates the retention ledger and the
   * liquidated-damages assessments inside the instruments tab
   * (migration 0098). */
  readonly canManageRetention: boolean;
  readonly isOwner: boolean;
  readonly onNewChallan: (workId: string, workCode: string) => void;
  readonly onOpenChallan: (challanId: string) => void;
  readonly onNewIssueChallan: (workId: string) => void;
  readonly onOpenIssueChallan: (challanId: string) => void;
  readonly onBack: () => void;
  /** Lifted so the tab survives a trip into a challan and back. Omitted, the
   * page keeps its own tab — which is what the component tests rely on. */
  readonly tab?: WorkTab;
  readonly onTabChange?: (tab: WorkTab) => void;
  /** This Work was created moments ago by confirming its letter, and the
   * payment setup has not been offered yet. True exactly once, from the
   * navigation that followed the confirmation: the shell holds it in
   * memory, so a revisit, a refresh or a shared link never re-opens it. */
  readonly promptPaymentSetup?: boolean;
  /** The prompt is spent — saved or dismissed. */
  readonly onPaymentSetupClosed?: () => void;
}

/** The Work page's areas. Eleven sections used to stack on one scroll; each
 * now answers for itself, and Overview summarises the rest.
 *
 * Exported so `lib/workspace-routes.ts`, which parses a tab name out of a
 * hash fragment, can be held to exactly this list by a test rather than by
 * a comment asking the next author to remember. */
export const WORK_TABS = [
  'overview',
  'schedules',
  'deliveries',
  'installations',
  'procurement',
  'issues',
  'measurement',
  'bills',
  // Ninth, where the mock's own section rail puts it
  // (`components/work-section-nav.tsx` at fdfe5ef) — after the money and
  // before the instruments, not beside Installations where it first
  // landed.
  'inspection',
  'instruments',
  'amendments',
  'timeline',
] as const;

export type WorkTab = (typeof WORK_TABS)[number];

const WORK_TAB_LABELS: Record<WorkTab, string> = {
  overview: 'Overview',
  schedules: 'Schedules & items',
  deliveries: 'Deliveries',
  installations: 'Installations',
  // The mock's own label for this section
  // (`components/work-section-nav.tsx` at fdfe5ef), which names the
  // contract clause rather than the activity.
  inspection: 'Inspection clause',
  procurement: 'Procurement',
  issues: 'Issues',
  measurement: 'Measurement',
  bills: 'Bills',
  instruments: 'Instruments',
  amendments: 'Amendments',
  timeline: 'Timeline',
};

const RELATED = {
  challans: 'Delivery Challans',
  instruments: 'instruments',
  measurements: 'Measurement Book entries',
  bills: 'bills',
  serials: 'serials',
  issueChallans: 'Issue Challans',
  amendments: 'amendments',
  correctionNotices: 'correction notices',
  purchaseOrders: 'purchase orders',
  paymentMatrix: 'the payment matrix',
} as const;

type RelatedLabel = (typeof RELATED)[keyof typeof RELATED];
type RelatedState = 'loading' | 'unavailable' | 'ready';
const ALL_RELATED_LABELS = Object.values(RELATED);
const RELATED_BY_TAB: Partial<Record<WorkTab, readonly RelatedLabel[]>> = {
  deliveries: [RELATED.challans],
  // Installations is deliberately absent: the tab loads its own records
  // when it is opened, so the Work page has no pending read to gate it on
  // and no failure of its own to report. Its count comes off the Work read
  // (`installationCounts`), which is why opening a Work no longer costs a
  // serial-expanded installation list.
  procurement: [RELATED.purchaseOrders],
  issues: [RELATED.issueChallans],
  measurement: [RELATED.measurements],
  bills: [RELATED.bills],
  instruments: [RELATED.instruments],
  amendments: [RELATED.amendments],
};

function RelatedSectionGate({
  labels,
  pending,
  failures,
  onRetry,
  children,
}: {
  readonly labels: readonly RelatedLabel[];
  readonly pending: ReadonlySet<RelatedLabel>;
  readonly failures: ReadonlySet<RelatedLabel>;
  /** Re-runs every supporting register that failed — the same handler the
   * card-level banner uses, so a tab's own failure is fixable from the tab
   * rather than only from the top of the page. */
  readonly onRetry: () => void;
  readonly children: ReactNode;
}) {
  const failed = labels.filter((label) => failures.has(label));
  if (failed.length > 0) {
    return (
      <ErrorState onRetry={onRetry} retryLabel="Retry this section">
        This section is unavailable because {failed.join(', ')} could not be loaded.
      </ErrorState>
    );
  }
  if (labels.some((label) => pending.has(label))) {
    return <LoadingState label="this Work section" rows={3} columns={3} />;
  }
  return children;
}

/** The work items carrying an undecided omission proposal (R7). The
 * approved omission soft-deletes the item, so it leaves the detail
 * response entirely — the only omission state worth a chip is the
 * pending one. The pre-R7 reading, "effective quantity 0 means omitted",
 * is retired deliberately: R12 makes a zero effective quantity invalid,
 * so the reading can no longer be true of any live item. */
function pendingRemovalItemIds(
  amendments: readonly ApprovalRequest[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const amendment of amendments) {
    if (
      amendment.status !== 'pending' ||
      amendment.entityType !== 'work_item_amendment' ||
      amendment.entityId === null
    ) {
      continue;
    }
    const proposed = amendment.proposed as { kind?: unknown } | null;
    if (proposed?.kind === 'remove_item') ids.add(amendment.entityId);
  }
  return ids;
}

/** The two R8 completion 409s carry the operator's worklist in
 * `details`; anything that does not match the expected shape is dropped
 * rather than rendered as "[object Object]". */
function unfinishedItemsOf(error: unknown): readonly UnfinishedWorkItem[] {
  if (
    !(error instanceof RequestFailedError) ||
    error.code !== 'WORK_NOT_FULLY_EXECUTED'
  ) {
    return [];
  }
  const details = error.details as { unfinishedItems?: unknown } | null;
  return Array.isArray(details?.unfinishedItems)
    ? (details.unfinishedItems as readonly UnfinishedWorkItem[])
    : [];
}

function completionBlockersOf(error: unknown): readonly WorkCompletionBlocker[] {
  if (!(error instanceof RequestFailedError) || error.code !== 'WORK_NOT_CLEAN') {
    return [];
  }
  const details = error.details as { blockers?: unknown } | null;
  return Array.isArray(details?.blockers)
    ? (details.blockers as readonly WorkCompletionBlocker[])
    : [];
}

const REQUIREMENT_LABELS: Record<UnfinishedWorkItem['requirement'], string> = {
  delivery: 'full delivery',
  installation: 'full installation',
  delivery_and_installation: 'full delivery and installation',
  service: 'full certification',
};

const DIRECTION_LABELS = {
  below: 'below advertised',
  at_par: 'at par',
  above: 'above advertised',
} as const;

/** One cell of the Work header's figure strip: its name at the left rule,
 * its value hard against the right one. The mock's local `Figure`
 * (Auto-MB-Vercel-du, app/works/[code]/page.tsx at fdfe5ef), kept local
 * here too — it is this header's layout, not a shape other screens reuse,
 * and `ui/stat.tsx` is the shared tile for the ones that do. */
function Figure({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-44 flex-1 items-baseline justify-between gap-4 border-r border-border px-4 py-3 last:border-r-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="m-0 font-mono text-sm font-semibold whitespace-nowrap tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/** Why a Work will not close: the records still holding a claim on it, and
 * the items not yet at their sanctioned quantity. Rendered from the
 * readiness read before the operator writes anything, and again from the
 * refusal if one somehow gets past it — one component so the two can never
 * describe the same Work differently. */
function CompletionShortfall({
  blockers,
  unfinished,
  lead,
}: {
  readonly blockers: readonly WorkCompletionBlocker[];
  readonly unfinished: readonly UnfinishedWorkItem[];
  readonly lead?: string;
}) {
  if (blockers.length === 0 && unfinished.length === 0) return null;
  return (
    <>
      {lead !== undefined && <p className="font-medium">{lead}</p>}
      {blockers.length > 0 && (
        <DataTable>
          <caption>Finish or discard these records before completing the Work</caption>
          <thead>
            <tr>
              <th scope="col">Record</th>
            </tr>
          </thead>
          <tbody>
            {blockers.map((blocker) => (
              <tr key={blocker.recordId}>
                <th scope="row">{blocker.label}</th>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {unfinished.length > 0 && (
        <DataTable scroll>
          <caption>Items not yet at 100% executed value</caption>
          <thead>
            <tr>
              <th scope="col">Item number</th>
              <th scope="col">Payment category</th>
              <th scope="col">Requires</th>
              <th scope="col">Required</th>
              <th scope="col">Delivered</th>
              <th scope="col">Installed</th>
              <th scope="col">Certified</th>
            </tr>
          </thead>
          <tbody>
            {unfinished.map((item) => (
              <tr key={item.workItemId}>
                <th scope="row">{item.itemNumber}</th>
                {/* NULL is "not selected yet" since migration 0105, and
                    it is the reason an item can sit here billing
                    nothing — so the cell says that rather than naming a
                    category the item does not have. */}
                <td>{item.category ?? 'not selected'}</td>
                <td>{REQUIREMENT_LABELS[item.requirement]}</td>
                <td className={numericCell}>{item.requiredQuantity}</td>
                <td className={numericCell}>{item.deliveredQuantity}</td>
                <td className={numericCell}>{item.installedQuantity}</td>
                <td className={numericCell}>{item.certifiedQuantity}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  );
}

export function WorkDetail({
  api,
  organisationId,
  workId,
  canModify,
  canRecordEvidence,
  canIssue,
  canSign,
  canCancel,
  canApprove,
  canManageStatutory,
  canManageRetention,
  isOwner,
  onNewChallan,
  onOpenChallan,
  onNewIssueChallan,
  onOpenIssueChallan,
  onBack,
  tab: controlledTab,
  onTabChange,
  promptPaymentSetup = false,
  onPaymentSetupClosed,
}: WorkDetailProps) {
  const [detail, setDetail] = useState<WorkDetailResponse | null>(null);
  const [challans, setChallans] = useState<readonly Challan[] | null>(null);
  const [issueChallans, setIssueChallans] = useState<readonly IssueChallan[] | null>(
    null,
  );
  const [purchaseOrders, setPurchaseOrders] = useState<readonly PurchaseOrder[] | null>(
    null,
  );
  const [instruments, setInstruments] = useState<readonly Instrument[]>([]);
  const [mbEntries, setMbEntries] = useState<readonly MbEntry[]>([]);
  const [bills, setBills] = useState<readonly Bill[]>([]);
  /** The Work's billing position, as the server summed it. Null until the
   * bills read lands (or when it failed), which is what the tile row above
   * the Bills tab waits on. */
  const [billSummary, setBillSummary] = useState<BillSummary | null>(null);
  /** One read answers both: the list the tab shows and the three figures
   * above it. Split here so `WorkBills` keeps its plain array setter for
   * the local status move, which changes no total. */
  const applyBills = useCallback((response: BillListResponse) => {
    setBills(response.bills);
    setBillSummary(response.summary);
  }, []);
  const [serials, setSerials] = useState<readonly Serial[]>([]);
  /** The Installations tab's tally, for its badge and its summary tiles.
   *
   * It arrives on the Work read rather than from the records, because the
   * records are the one list on this page that is expensive to count: the
   * installation list expands every record's serials, so a Work opened by
   * someone who never touches the tab was paying a serial-joined query for
   * two integers. The tab still owns its own load, its retry and its
   * refresh-after-record — it just no longer duplicates one the page has
   * already made. `null` only until the Work itself arrives; recording or
   * cancelling on the tab patches it back through `onCountsChanged`, so
   * the badge tracks the tab without a page reload. */
  const [installationCounts, setInstallationCounts] =
    useState<InstallationCounts | null>(null);
  /** Same arrangement for the two other tabs whose registers load only on
   * open: the formal Measurement Books and the tax invoices ride the Work
   * read as counts, and the tabs patch them back when their own lists
   * load or change, so the badges track the tabs without a reload. */
  const [measurementBookCount, setMeasurementBookCount] = useState<number | null>(null);
  const [taxInvoiceCount, setTaxInvoiceCount] = useState<number | null>(null);
  const [amendments, setAmendments] = useState<readonly ApprovalRequest[]>([]);
  const [correctionNotices, setCorrectionNotices] = useState<
    readonly CorrectionNotice[]
  >([]);
  const [paymentMatrixRows, setPaymentMatrixRows] = useState<
    readonly PaymentMatrixRow[]
  >([]);
  /** Open while the operator asked for the payment setup from the
   * overview prompt, as distinct from being offered it by the
   * navigation that created the Work. */
  const [paymentSetupOpen, setPaymentSetupOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retryWork] = useReload();
  const [relatedPending, setRelatedPending] = useState<ReadonlySet<RelatedLabel>>(
    new Set(),
  );
  const [relatedFailures, setRelatedFailures] = useState<ReadonlySet<RelatedLabel>>(
    new Set(),
  );
  const [actionError, setActionError] = useState<{
    readonly message: string;
    /** Where the refusal is actually fixed, when it names another screen. */
    readonly wayfind: Wayfind | null;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [unfinished, setUnfinished] = useState<readonly UnfinishedWorkItem[]>([]);
  const [blockers, setBlockers] = useState<readonly WorkCompletionBlocker[]>([]);
  /** What the server would say to a completion attempt, asked before the
   * operator writes a note. Null while it is still being read. */
  const [readiness, setReadiness] = useState<WorkCompletionReadiness | null>(null);
  /** Whether this Work may still be withdrawn (migration 0071). Null while
   * unread, and left null when the read fails: the Amendments tab then
   * offers nothing, which is the honest state for a question that could
   * not be asked. */
  const [supersede, setSupersede] = useState<SupersedeEligibilityResponse | null>(null);
  /** The supersession this Work is the successor of, if any. Null both
   * while unread and for the overwhelming majority of Works, which
   * replaced nothing — the panel renders only when a row comes back. */
  const [supersession, setSupersession] = useState<WorkSupersession | null>(null);
  const [ownTab, setOwnTab] = useState<WorkTab>('overview');
  const relatedGenerationRef = useRef(0);
  const tab = controlledTab ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;

  useEffect(() => {
    let cancelled = false;
    const generation = ++relatedGenerationRef.current;
    setDetail(null);
    setChallans(null);
    setIssueChallans(null);
    setPurchaseOrders(null);
    setInstruments([]);
    setMbEntries([]);
    setBills([]);
    setBillSummary(null);
    setSerials([]);
    setInstallationCounts(null);
    setMeasurementBookCount(null);
    setTaxInvoiceCount(null);
    setAmendments([]);
    setCorrectionNotices([]);
    setLoadError(null);
    setRelatedPending(new Set(ALL_RELATED_LABELS));
    setRelatedFailures(new Set());
    setReadiness(null);
    setSupersede(null);
    setSupersession(null);

    // The Work identity and schedules are the page's critical read. Load them
    // independently so a temporary failure in one supporting register cannot
    // replace the entire Work with an error card.
    api
      .getWork(organisationId, workId)
      .then((loaded) => {
        if (cancelled) return;
        setDetail(loaded);
        setInstallationCounts(loaded.installationCounts);
        setMeasurementBookCount(loaded.measurementBookCount);
        setTaxInvoiceCount(loaded.taxInvoiceCount);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The Work could not be loaded.'));
      });

    function settleRelated(label: RelatedLabel, failed: boolean): void {
      setRelatedPending((current) => {
        const next = new Set(current);
        next.delete(label);
        return next;
      });
      if (failed) {
        setRelatedFailures((current) => new Set(current).add(label));
      }
    }

    function loadRelated<T>(
      label: RelatedLabel,
      request: Promise<T>,
      apply: (value: T) => void,
    ): void {
      void request.then(
        (value) => {
          if (cancelled) return;
          apply(value);
          settleRelated(label, false);
        },
        () => {
          if (cancelled) return;
          settleRelated(label, true);
        },
      );
    }

    // Supporting registers settle independently. One slow or unavailable API
    // cannot hold back successful data or turn an unknown list into a fake empty one.
    loadRelated(
      RELATED.challans,
      api.listChallans(organisationId, workId),
      setChallans,
    );
    loadRelated(
      RELATED.instruments,
      api.listInstruments(organisationId, workId),
      setInstruments,
    );
    loadRelated(
      RELATED.measurements,
      api.listMbEntries(organisationId, workId),
      setMbEntries,
    );
    loadRelated(RELATED.bills, api.listBills(organisationId, workId), applyBills);
    loadRelated(
      RELATED.serials,
      api.listWorkSerials(organisationId, workId),
      setSerials,
    );
    loadRelated(
      RELATED.issueChallans,
      api.listIssueChallans(organisationId, workId),
      setIssueChallans,
    );
    loadRelated(
      RELATED.amendments,
      api.listWorkAmendments(organisationId, workId),
      setAmendments,
    );
    loadRelated(
      RELATED.correctionNotices,
      api.listWorkCorrectionNotices(organisationId, workId),
      setCorrectionNotices,
    );
    loadRelated(
      RELATED.purchaseOrders,
      api.listWorkPurchaseOrders(organisationId, workId),
      setPurchaseOrders,
    );
    // Read on the Work page, not only inside the matrix editor, because
    // the overview asks a question of it: whether any item on this Work
    // would bill through a category that has no row. That is the state
    // the Measurement Book refuses in, and the page that can see it is
    // the page that should say so.
    loadRelated(
      RELATED.paymentMatrix,
      api.getPaymentMatrix(organisationId, workId),
      setPaymentMatrixRows,
    );
    // Asked separately, and allowed to fail. It decides whether the
    // completion form is worth offering, not whether the page can be read;
    // a Work that cannot load its shortfall still has nine other areas.
    // Unknown falls back to offering the form — what the page did before it
    // thought to ask — and the server still refuses with the worklist.
    api
      .workCompletionReadiness(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setReadiness(loaded);
      })
      .catch(() => {
        if (!cancelled) setReadiness(null);
      });
    // Where this Work came from: read for everyone, because a successor's
    // provenance is part of reading the Work rather than part of changing
    // it. Allowed to fail — the page has ten other areas.
    api
      .getWorkSupersession(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setSupersession(loaded);
      })
      .catch(() => {
        if (!cancelled) setSupersession(null);
      });
    // The eligibility census reads seventeen registers. It is asked ONLY
    // for a member who could act on the answer: a viewer, or a site member
    // recording evidence, is never offered the supersede panel, so asking
    // on their behalf would spend the census on every Work page open in
    // the organisation to render nothing. Allowed to fail for the same
    // reason as the readiness read, and the server refuses again on the
    // way in either way.
    if (canModify) {
      api
        .getSupersedeEligibility(organisationId, workId)
        .then((loaded) => {
          if (!cancelled) setSupersede(loaded);
        })
        .catch(() => {
          if (!cancelled) setSupersede(null);
        });
    }
    return () => {
      cancelled = true;
      if (relatedGenerationRef.current === generation) {
        relatedGenerationRef.current += 1;
      }
    };
  }, [api, organisationId, workId, loadVersion, canModify, applyBills]);

  /** Re-reads eligibility after the Work's own state moves — filing a
   * supersede request has to hide the form that filed it rather than
   * leave it inviting a 409 (the server refuses a second pending request
   * on the same Work). */
  const reloadSupersede = useCallback(async (): Promise<void> => {
    if (!canModify) return;
    try {
      setSupersede(await api.getSupersedeEligibility(organisationId, workId));
    } catch {
      setSupersede(null);
    }
  }, [api, organisationId, workId, canModify]);

  function retryFailedSections(): void {
    const labels = new Set(relatedFailures);
    if (labels.size === 0) return;
    const generation = relatedGenerationRef.current;
    setRelatedPending((current) => new Set([...current, ...labels]));
    setRelatedFailures((current) => {
      const next = new Set(current);
      for (const label of labels) next.delete(label);
      return next;
    });

    function retryRelated<T>(
      label: RelatedLabel,
      request: Promise<T>,
      apply: (value: T) => void,
    ): void {
      void request.then(
        (value) => {
          if (relatedGenerationRef.current !== generation) return;
          apply(value);
          setRelatedPending((current) => {
            const next = new Set(current);
            next.delete(label);
            return next;
          });
        },
        () => {
          if (relatedGenerationRef.current !== generation) return;
          setRelatedFailures((current) => new Set(current).add(label));
          setRelatedPending((current) => {
            const next = new Set(current);
            next.delete(label);
            return next;
          });
        },
      );
    }

    if (labels.has(RELATED.challans)) {
      retryRelated(
        RELATED.challans,
        api.listChallans(organisationId, workId),
        setChallans,
      );
    }
    if (labels.has(RELATED.instruments)) {
      retryRelated(
        RELATED.instruments,
        api.listInstruments(organisationId, workId),
        setInstruments,
      );
    }
    if (labels.has(RELATED.measurements)) {
      retryRelated(
        RELATED.measurements,
        api.listMbEntries(organisationId, workId),
        setMbEntries,
      );
    }
    if (labels.has(RELATED.bills)) {
      retryRelated(RELATED.bills, api.listBills(organisationId, workId), applyBills);
    }
    if (labels.has(RELATED.serials)) {
      retryRelated(
        RELATED.serials,
        api.listWorkSerials(organisationId, workId),
        setSerials,
      );
    }
    if (labels.has(RELATED.issueChallans)) {
      retryRelated(
        RELATED.issueChallans,
        api.listIssueChallans(organisationId, workId),
        setIssueChallans,
      );
    }
    if (labels.has(RELATED.amendments)) {
      retryRelated(
        RELATED.amendments,
        api.listWorkAmendments(organisationId, workId),
        setAmendments,
      );
    }
    if (labels.has(RELATED.correctionNotices)) {
      retryRelated(
        RELATED.correctionNotices,
        api.listWorkCorrectionNotices(organisationId, workId),
        setCorrectionNotices,
      );
    }
    if (labels.has(RELATED.purchaseOrders)) {
      retryRelated(
        RELATED.purchaseOrders,
        api.listWorkPurchaseOrders(organisationId, workId),
        setPurchaseOrders,
      );
    }
    if (labels.has(RELATED.paymentMatrix)) {
      retryRelated(
        RELATED.paymentMatrix,
        api.getPaymentMatrix(organisationId, workId),
        setPaymentMatrixRows,
      );
    }
  }

  const act = useCallback(
    async (work: () => Promise<void>, done: string) => {
      setPending(true);
      setActionError(null);
      setNotice(null);
      try {
        await work();
        setNotice(done);
      } catch (cause) {
        setActionError({
          message: errorMessage(cause),
          wayfind: wayfindingOf(cause, { workId }),
        });
      } finally {
        setPending(false);
      }
    },
    [workId],
  );

  /** The R8 lifecycle transitions. Unlike `act`, these keep the 409's
   * structured worklist so the panel can render it: the message alone
   * would send the operator hunting for the short items. */
  const transition = useCallback(
    async (run: () => Promise<WorkDetailResponse['work']>, done: string) => {
      setPending(true);
      setActionError(null);
      setNotice(null);
      setUnfinished([]);
      setBlockers([]);
      try {
        const updated = await run();
        setDetail((current) =>
          current === null ? current : { ...current, work: updated },
        );
        setNotice(done);
      } catch (cause) {
        setUnfinished(unfinishedItemsOf(cause));
        setBlockers(completionBlockersOf(cause));
        setActionError({
          message: errorMessage(cause),
          wayfind: wayfindingOf(cause, { workId }),
        });
      } finally {
        setPending(false);
      }
    },
    [workId],
  );

  /**
   * The Work's items, flattened once per Work rather than once per
   * render.
   *
   * Nine things read this list, and one of them — the payment setup
   * dialog — memoises its keyword proposals on the array identity. A
   * fresh array on every render re-ran that memo whenever any of the ten
   * supporting registers settled, which is several times per second
   * while the page is loading.
   */
  const workItems = useMemo(
    () => (detail?.schedules ?? []).flatMap((schedule) => schedule.items),
    [detail],
  );

  /**
   * Why this Work is not ready to bill, in the two ways it can fail:
   * a category in use with no matrix row, and an item whose category
   * nobody has chosen. The same resolution the server's
   * `resolvePaymentPercentages` performs.
   *
   * They are counted apart because the remedies are different, and the
   * banner used to conflate them: NULL fell through to UNCATEGORISED, so
   * an item nobody had looked at made the banner demand a matrix row
   * that would not have helped, while the item stayed unbillable.
   *
   * This is the durable half of the payment setup prompt. The dialog is
   * offered once by the navigation that created the Work; this is
   * derived from the data instead, so a Work whose configuration is
   * still incomplete keeps saying so — and stops as soon as it is not.
   */
  const uncoveredCategories = useMemo<readonly PaymentMatrixCategory[]>(() => {
    const configured = new Set(paymentMatrixRows.map((row) => row.category));
    const used = new Set<PaymentMatrixCategory>(
      workItems
        .map((item) => item.paymentCategory ?? null)
        .filter((category): category is PaymentMatrixCategory => category !== null),
    );
    return [...used].filter((category) => !configured.has(category)).sort();
  }, [workItems, paymentMatrixRows]);

  /** Items with no payment category chosen at all (migration 0105).
   * They bill nothing and no matrix row can change that. */
  const unselectedItemCount = useMemo(
    () => workItems.filter((item) => (item.paymentCategory ?? null) === null).length,
    [workItems],
  );

  if (loadError !== null) {
    return (
      <Card aria-labelledby="work-title">
        <h1 id="work-title" tabIndex={-1}>
          Work
        </h1>
        <ErrorState onRetry={retryWork} retryLabel="Retry Work">
          {loadError}
        </ErrorState>
      </Card>
    );
  }

  if (detail === null) {
    return (
      <Card aria-labelledby="work-title">
        <h1 id="work-title" tabIndex={-1}>
          Work
        </h1>
        <LoadingState label="the Work" rows={5} columns={3} />
      </Card>
    );
  }

  const failedSections = ALL_RELATED_LABELS.filter((label) =>
    relatedFailures.has(label),
  );
  function relatedStateFor(labels: readonly RelatedLabel[]): RelatedState {
    if (labels.some((label) => relatedFailures.has(label))) return 'unavailable';
    if (labels.some((label) => relatedPending.has(label))) return 'loading';
    return 'ready';
  }
  function relatedStateForTab(candidate: WorkTab): RelatedState {
    return relatedStateFor(RELATED_BY_TAB[candidate] ?? []);
  }

  const { work, schedules } = detail;
  const pendingRemovals = pendingRemovalItemIds(amendments);
  const issuedChallans = (challans ?? []).filter(
    (challan) => challan.status === 'issued',
  );
  const challanNumberById = new Map(
    (challans ?? []).map((challan) => [challan.id, challan.challanNumber]),
  );
  // R8: a completed Work accepts no new operational documents until it
  // is reopened, so every create/record surface below closes with it.
  // The server refuses regardless (and the database backstops that) —
  // hiding the forms just stops the operator walking into the refusal.
  const workActive = work.status === 'active';
  const canCreateDocuments = canModify && workActive;
  const canRecordSiteEvidence = canRecordEvidence && workActive;
  const canIssueDocuments = canIssue && workActive;
  const summaryLines: Partial<
    Record<WorkTab, readonly { readonly label: string; readonly value: string }[]>
  > = {
    schedules: [
      { label: 'Schedules', value: String(schedules.length) },
      {
        label: 'Serial-tracked',
        value:
          relatedStateFor([RELATED.serials]) === 'ready' ? String(serials.length) : '—',
      },
    ],
    deliveries: [
      { label: 'Issued', value: String(issuedChallans.length) },
      {
        label: 'Draft',
        value: String((challans ?? []).filter((c) => c.status === 'draft').length),
      },
      {
        label: 'Correction notices',
        value:
          relatedStateFor([RELATED.correctionNotices]) === 'ready'
            ? String(correctionNotices.length)
            : '—',
      },
    ],
    installations: [
      // An em dash until the count is actually known. A zero the page has
      // not measured reads as "nothing installed", which is a different
      // claim from "not read yet".
      {
        label: 'Recorded',
        value: installationCounts === null ? '—' : String(installationCounts.recorded),
      },
      {
        label: 'Cancelled',
        value: installationCounts === null ? '—' : String(installationCounts.cancelled),
      },
      {
        label: 'Serials traced',
        value:
          relatedStateFor([RELATED.serials]) === 'ready' ? String(serials.length) : '—',
      },
    ],
    procurement: [
      {
        label: 'Issued',
        value: String(
          (purchaseOrders ?? []).filter((po) => po.status === 'issued').length,
        ),
      },
      {
        label: 'Draft',
        value: String(
          (purchaseOrders ?? []).filter((po) => po.status === 'draft').length,
        ),
      },
    ],
    issues: [
      {
        label: 'Draft',
        value: String((issueChallans ?? []).filter((c) => c.status === 'draft').length),
      },
    ],
    measurement: [
      // Em dash until the Work read lands — an unmeasured zero reads as
      // "no books", which is a different claim from "not read yet".
      {
        label: 'Measurement Books',
        value: measurementBookCount === null ? '—' : String(measurementBookCount),
      },
      { label: 'Entries recorded', value: String(mbEntries.length) },
    ],
    bills: [
      { label: 'Prepared', value: String(bills.length) },
      {
        label: 'Tax invoices',
        value: taxInvoiceCount === null ? '—' : String(taxInvoiceCount),
      },
    ],
    instruments: [
      {
        label: 'Active',
        value: String(instruments.filter((i) => i.status === 'active').length),
      },
    ],
    amendments: [
      {
        label: 'Awaiting decision',
        value: String(amendments.filter((a) => a.status === 'pending').length),
      },
    ],
  };
  const tabCounts: Record<WorkTab, number | null> = {
    overview: null,
    schedules: relatedStateForTab('schedules') === 'ready' ? workItems.length : null,
    deliveries:
      relatedStateForTab('deliveries') === 'ready' ? (challans?.length ?? 0) : null,
    installations:
      installationCounts === null
        ? null
        : installationCounts.recorded + installationCounts.cancelled,
    // No badge: the Work read carries no inspection count, and the tab
    // loads its own configuration. A number here would have to come from
    // a read the page does not do, and a fabricated zero beside a mapped
    // clause is worse than no number at all.
    inspection: null,
    procurement:
      relatedStateForTab('procurement') === 'ready'
        ? (purchaseOrders?.length ?? 0)
        : null,
    issues:
      relatedStateForTab('issues') === 'ready' ? (issueChallans?.length ?? 0) : null,
    // Books and invoices render inside their tabs from their own reads,
    // so the badges add the counts carried on the Work read — an entry
    // count alone claimed zero measurements beside an existing book.
    measurement:
      relatedStateForTab('measurement') === 'ready'
        ? mbEntries.length + (measurementBookCount ?? 0)
        : null,
    bills:
      relatedStateForTab('bills') === 'ready'
        ? bills.length + (taxInvoiceCount ?? 0)
        : null,
    instruments:
      relatedStateForTab('instruments') === 'ready' ? instruments.length : null,
    amendments: relatedStateForTab('amendments') === 'ready' ? amendments.length : null,
    timeline: null,
  };
  return (
    <Card className="w-full" aria-labelledby="work-title">
      {/* The mock's Work header (Auto-MB-Vercel-du,
          app/works/[code]/page.tsx at fdfe5ef): an eyebrow and status
          above a mono contract number, the name of the work beneath it,
          and the letter that awarded it in a quiet line under that.
          The title is a span inside the heading rather than the mock's
          sibling paragraph — it renders identically, and it keeps the
          code AND the name in the heading's accessible name, which is
          what navigation announces when focus lands here. */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="section-label">Work contract</span>
            <Badge variant={work.status === 'completed' ? 'success' : 'info'}>
              {work.status}
            </Badge>
          </div>
          <h1 id="work-title" tabIndex={-1} className="m-0">
            <span className="block font-mono text-3xl font-semibold tracking-[-0.04em]">
              {work.workCode}
            </span>
            <span className="mt-1 block max-w-2xl text-sm font-normal tracking-normal text-pretty text-muted-foreground">
              {work.title}
            </span>
          </h1>
          <p className="m-0 text-xs text-muted-foreground">
            {work.letterNumber} · LOA {formatDate(work.letterDate)}
          </p>
        </div>
      </div>
      {supersession !== null && (
        // Where this Work came from. The withdrawn Work is not openable —
        // every Works route filters it out — so this line is the only
        // place its identity, its reason and its date are readable, and it
        // says so rather than offering a link that would 404.
        <section
          aria-label="Supersedes an earlier Work"
          className="mt-3 rounded-md border border-border bg-muted/40 p-3"
        >
          <p className="m-0 text-sm">
            Supersedes{' '}
            <span className="font-mono tabular-nums">
              {supersession.supersededWorkCode}
            </span>{' '}
            (
            <span className="font-mono tabular-nums">
              {supersession.supersededLetterNumber}
            </span>
            ), withdrawn on {formatTimestampDate(supersession.supersededAt)}. That Work
            is no longer open; this one replaced it.
          </p>
          <p className="m-0 mt-1 text-sm text-muted-foreground">
            Reason given: {supersession.reason}
          </p>
        </section>
      )}
      {failedSections.length > 0 && (
        <ErrorState
          onRetry={retryFailedSections}
          retryLabel="Retry supporting sections"
        >
          Some Work sections could not be loaded: {failedSections.join(', ')}. The
          available Work information remains open.
        </ErrorState>
      )}
      {/* The mock's figure strip: a row of rules the reader scans across
          rather than a stack of labelled pairs. Three figures and not the
          mock's four — its "Supplied" and "Certified value" are computed
          in its fixture, and the equivalents here belong to the ledger
          and the bills sections, which own the reads that produce them. */}
      <dl className="mt-3 mb-4 flex min-w-0 flex-wrap overflow-x-auto rounded-xl border border-border bg-card p-0">
        <Figure label="Advertised value" value={formatInr(work.advertisedValue)} />
        <Figure label="Contract value" value={formatInr(work.contractValue)} />
        <Figure
          label="Pricing"
          value={
            work.pricingShape === 'letter_percentage' &&
            work.letterPercentage !== null &&
            work.letterPercentageDirection !== null
              ? `${work.letterPercentage}% ${DIRECTION_LABELS[work.letterPercentageDirection]}`
              : 'Per-schedule totals'
          }
        />
      </dl>

      {/* Eleven sections used to stack on one scroll. Each area now answers
          for itself, and the counts show what is inside before it is opened.
          The rail is the mock's work-section nav (Auto-MB-Vercel-du,
          components/work-section-nav.tsx at fdfe5ef): a 44px underline tab
          on a horizontally scrollable rule, weight rather than colour
          carrying the active state. The count pill has no mock counterpart
          — the mock's Work has no data behind it to count — so it is built
          from the mock's own muted and primary tints. */}
      <nav
        className="mt-4 mb-4 flex max-w-full items-center gap-1 overflow-x-auto border-b border-border"
        aria-label="Work sections"
      >
        {WORK_TABS.map((candidate) => {
          const count = tabCounts[candidate];
          const current = tab === candidate;
          return (
            <button
              key={candidate}
              type="button"
              className={cn(
                '-mb-px inline-flex h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-3',
                'text-sm whitespace-nowrap transition-colors',
                current
                  ? 'border-primary font-medium text-foreground'
                  : 'font-normal text-muted-foreground hover:text-foreground',
              )}
              aria-current={current ? 'page' : undefined}
              onClick={() => {
                setTab(candidate);
              }}
            >
              {WORK_TAB_LABELS[candidate]}
              {count !== null && (
                <span
                  className={cn(
                    'rounded-sm px-1.5 py-px font-mono text-xs font-semibold tabular-nums',
                    current
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === 'overview' && (
        <>
          {/* The whole state of a Work, before anything is opened. Each cell
              carries the count its tab shows, so the summary and the tab strip
              can never disagree — both read the same derivation. */}
          <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] overflow-hidden rounded-xl border border-border bg-card">
            {WORK_TABS.filter(
              (candidate) => candidate !== 'overview' && candidate !== 'timeline',
            ).map((candidate) => {
              const relatedState = relatedStateForTab(candidate);
              return (
                <button
                  key={candidate}
                  type="button"
                  className="flex cursor-pointer flex-col items-stretch gap-2 border-t border-l border-border px-4 py-3 text-left transition-colors hover:bg-muted"
                  onClick={() => {
                    setTab(candidate);
                  }}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold">
                      {WORK_TAB_LABELS[candidate]}
                    </span>
                    <span className="ml-auto font-mono text-lg font-semibold tracking-tight tabular-nums">
                      {tabCounts[candidate] ?? '—'}
                    </span>
                  </span>
                  <span className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {relatedState === 'ready' ? (
                      (summaryLines[candidate] ?? []).map((line) => (
                        <span className="flex items-baseline gap-2" key={line.label}>
                          {line.label}
                          <span className="ml-auto font-mono text-secondary-foreground tabular-nums">
                            {line.value}
                          </span>
                        </span>
                      ))
                    ) : (
                      <span>
                        {relatedState === 'loading' ? 'Loading…' : 'Unavailable'}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {/* The durable half of the payment setup prompt.
              The dialog itself is offered once, by the navigation that
              followed the letter's confirmation, because that is when the
              letter is still in the operator's hands. A modal that
              re-opened on every visit until it was answered would be a
              nag; a Work that quietly bills nothing because a matrix row
              was never entered is worse. So the question is asked here
              instead, derived from the Work's own data: it appears
              exactly while an item would bill through a category with no
              row, and it goes away by itself when that stops being true.
              Read-only members see nothing — the remedy is not theirs. */}
          {canModify &&
            relatedStateFor([RELATED.paymentMatrix]) === 'ready' &&
            (uncoveredCategories.length > 0 || unselectedItemCount > 0) && (
              <p className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                <CircleAlert
                  className="mt-0.5 size-4 shrink-0 self-center text-warning-foreground"
                  aria-hidden="true"
                />
                <span>
                  {uncoveredCategories.length > 0 && (
                    <>
                      This Work has no payment matrix row for{' '}
                      {uncoveredCategories
                        .map((category) => categoryLabelOf(category, paymentMatrixRows))
                        .join(', ')}
                      , so a Measurement Book cannot be finalized for the items that
                      bill through {uncoveredCategories.length === 1 ? 'it' : 'them'}.
                    </>
                  )}
                  {unselectedItemCount > 0 && (
                    <>
                      {uncoveredCategories.length > 0 ? ' ' : ''}
                      {unselectedItemCount} item
                      {unselectedItemCount === 1 ? ' has' : 's have'} no payment
                      category chosen, so{' '}
                      {unselectedItemCount === 1 ? 'it bills' : 'they bill'} nothing
                      until answered — no matrix row changes that.
                    </>
                  )}
                </span>
                <Button
                  variant="link"
                  size="inline"
                  onClick={() => {
                    setPaymentSetupOpen(true);
                  }}
                >
                  Open payment setup
                </Button>
              </p>
            )}

          <section aria-labelledby="work-completion-heading">
            <h2 id="work-completion-heading">Completion status</h2>
            {work.status === 'completed' ? (
              <>
                <p>
                  This Work is <strong>completed</strong>
                  {work.completedAt === null
                    ? ''
                    : ` on ${formatTimestampDate(work.completedAt)}`}
                  . No new challan, installation, PAC certificate, Measurement Book,
                  extension request, or change proposal can be recorded until it is
                  reopened.
                </p>
                {work.completionNote !== null && (
                  <p className="text-muted-foreground">
                    Completion note: {work.completionNote}
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">
                A Work completes only at 100% executed value (every item fully delivered
                and/or installed per its payment category). For a short closure, amend
                the quantities down through the approval path first.
              </p>
            )}

            {canModify && workActive && readiness?.ready === false && (
              /* The shortfall stands where the form would be. Hiding the
                 control on its own would leave an operator who came here to
                 close the Work with nothing to read; this is the same
                 worklist the refusal would have returned, minus the wasted
                 completion note. */
              <CompletionShortfall
                blockers={readiness.blockers}
                unfinished={readiness.unfinished}
                lead="This Work cannot be completed yet."
              />
            )}

            {canModify && workActive && readiness?.ready !== false && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  const note = formValue(data, 'completion-note');
                  void transition(async () => {
                    const updated = await api.completeWork(organisationId, workId, {
                      note,
                    });
                    return updated.work;
                  }, 'Work marked completed.');
                }}
              >
                <Field>
                  <label htmlFor="work-completion-note">
                    Why this Work is being completed
                  </label>
                  <textarea
                    id="work-completion-note"
                    name="completion-note"
                    required
                    minLength={3}
                    maxLength={2000}
                    rows={2}
                  />
                </Field>
                <Actions>
                  <Button type="submit" disabled={pending}>
                    Complete Work
                  </Button>
                </Actions>
              </form>
            )}

            {canModify && !workActive && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  const note = formValue(data, 'reopen-note');
                  void transition(async () => {
                    const updated = await api.reopenWork(organisationId, workId, {
                      note,
                    });
                    return updated.work;
                  }, 'Work reopened.');
                }}
              >
                <Field>
                  <label htmlFor="work-reopen-note">
                    Why this Work is being reopened
                  </label>
                  <textarea
                    id="work-reopen-note"
                    name="reopen-note"
                    required
                    minLength={3}
                    maxLength={2000}
                    rows={2}
                  />
                </Field>
                <Actions>
                  <Button type="submit" disabled={pending}>
                    Reopen Work
                  </Button>
                </Actions>
              </form>
            )}

            {/* The same two lists, whether they were asked for up front or
                came back from a refused attempt. */}
            <CompletionShortfall blockers={blockers} unfinished={unfinished} />
          </section>

          <CompletionExtensions
            api={api}
            organisationId={organisationId}
            workId={workId}
            canModify={canCreateDocuments}
            canIssue={canIssueDocuments}
            canApprove={canApprove}
          />

          <WorkConsignees
            api={api}
            organisationId={organisationId}
            workId={workId}
            canModify={canModify}
          />
        </>
      )}

      {tab === 'schedules' && (
        <WorkSchedules
          api={api}
          organisationId={organisationId}
          workId={workId}
          schedules={schedules}
          workItems={workItems}
          pendingRemovals={pendingRemovals}
          setDetail={setDetail}
          canModify={canModify && relatedStateFor([RELATED.amendments]) === 'ready'}
          pending={pending}
          act={act}
        />
      )}

      {tab === 'deliveries' && (
        <>
          {/* The cap this toggle lifts is the DELIVERY cap and nothing
              else, so it belongs above the deliveries it governs rather
              than in the Work header, where it was the one control amid
              read-only figures and read as a Work-wide setting. Same
              route, same owner-only gate, same copy — placement only.
              The mock has no counterpart — its Work cannot be configured
              — so this keeps the mock's quiet label-and-control row
              rather than inventing a panel for one checkbox. */}
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="section-label">Excess delivery</span>
            <span>
              {isOwner ? (
                <label>
                  <input
                    type="checkbox"
                    checked={work.allowExcessDelivery ?? false}
                    disabled={pending}
                    onChange={(event) => {
                      const next = event.currentTarget.checked;
                      void act(
                        async () => {
                          const updated = await api.setWorkSettings(
                            organisationId,
                            workId,
                            next,
                          );
                          setDetail((current) =>
                            current === null
                              ? current
                              : {
                                  ...current,
                                  work: {
                                    ...current.work,
                                    allowExcessDelivery: updated.allowExcessDelivery,
                                  },
                                },
                          );
                        },
                        next
                          ? 'Excess delivery allowed — issues may now exceed the sanctioned quantities.'
                          : 'Excess delivery disallowed again.',
                      );
                    }}
                  />{' '}
                  Allow issuing beyond sanctioned quantities
                </label>
              ) : (
                <span>
                  {(work.allowExcessDelivery ?? false) ? 'Allowed' : 'Not allowed'}
                </span>
              )}
            </span>
          </div>
          <WorkDeliveries
            api={api}
            organisationId={organisationId}
            workId={workId}
            work={work}
            challans={challans}
            challansState={relatedStateFor([RELATED.challans])}
            correctionNotices={correctionNotices}
            correctionNoticesState={relatedStateFor([RELATED.correctionNotices])}
            setCorrectionNotices={setCorrectionNotices}
            canCreateDocuments={canCreateDocuments}
            onNewChallan={onNewChallan}
            onOpenChallan={onOpenChallan}
            onOpenInstallations={() => {
              setTab('installations');
            }}
            pending={pending}
            act={act}
          />
        </>
      )}

      {tab === 'installations' && (
        <WorkInstallations
          api={api}
          organisationId={organisationId}
          workId={workId}
          workItems={workItems}
          serials={serials}
          serialsState={relatedStateFor([RELATED.serials])}
          setSerials={setSerials}
          canRecordSiteEvidence={canRecordSiteEvidence}
          onCountsChanged={setInstallationCounts}
        />
      )}

      {tab === 'procurement' && (
        <RelatedSectionGate
          labels={[RELATED.purchaseOrders]}
          pending={relatedPending}
          failures={relatedFailures}
          onRetry={retryFailedSections}
        >
          <WorkPurchaseOrders
            api={api}
            organisationId={organisationId}
            workId={workId}
            workItems={workItems}
            purchaseOrders={purchaseOrders}
            setPurchaseOrders={setPurchaseOrders}
            canModify={canModify}
            canCreateDocuments={canCreateDocuments}
            canIssue={canIssueDocuments}
            canCancel={canCancel}
            pending={pending}
            act={act}
          />
        </RelatedSectionGate>
      )}

      {tab === 'issues' && (
        <RelatedSectionGate
          labels={[RELATED.issueChallans]}
          pending={relatedPending}
          failures={relatedFailures}
          onRetry={retryFailedSections}
        >
          <WorkIssueChallans
            workId={workId}
            issueChallans={issueChallans}
            canCreateDocuments={canCreateDocuments}
            onNewIssueChallan={onNewIssueChallan}
            onOpenIssueChallan={onOpenIssueChallan}
          />
        </RelatedSectionGate>
      )}

      {tab === 'measurement' && (
        <WorkMeasurement
          api={api}
          organisationId={organisationId}
          workId={workId}
          mbEntries={mbEntries}
          mbEntriesState={relatedStateFor([RELATED.measurements])}
          challanNumberById={challanNumberById}
          challansState={relatedStateFor([RELATED.challans])}
          setBills={applyBills}
          billsState={relatedStateFor([RELATED.bills])}
          canCreateDocuments={canCreateDocuments}
          canIssue={canIssue}
          canCancel={canCancel}
          onBooksKnown={setMeasurementBookCount}
          act={act}
        />
      )}

      {tab === 'bills' && (
        <>
          {/* The mock's tile row (Auto-MB-Vercel-du,
              app/works/[code]/page.tsx at fdfe5ef): its own grid, its own
              `.data-surface` tiles, its own hints. The mock adds these
              figures up in its fixture; here they are summed in SQL
              numeric and arrive on the bills read, because money is never
              added up in the browser (AGENTS.md rule 5, docs/UX.md
              principle 9).

              The mock's fourth tile, unbillable exposure, is deliberately
              not here: this build already reports that figure where it is
              actionable — on the Measurement Book it would be billed
              through (`MeasurementBooks.tsx`, `unbillableVariationExposure`)
              — and a second copy on the Work would be the same warning
              twice. The grid keeps the mock's four columns regardless,
              which is what the mock itself renders whenever exposure is
              zero.

              No loading or failure branch of its own: both belong to the
              bills read, and the gate below already tells that story
              once. */}
          {billSummary !== null && (
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="data-surface bg-card p-4">
                <Stat
                  label="Measured"
                  value={formatCompactInr(billSummary.measured)}
                  hint="Sanctioned and ready for billing"
                />
              </div>
              <div className="data-surface bg-card p-4">
                <Stat
                  label="Billed"
                  value={formatCompactInr(billSummary.billed)}
                  hint={`${String(bills.length)} railway bills`}
                />
              </div>
              <div className="data-surface bg-card p-4">
                <Stat
                  label="Unbilled"
                  value={formatCompactInr(billSummary.unbilled)}
                  hint="Sanctioned value not yet claimed"
                />
              </div>
            </div>
          )}
          {/* Whether an invoice can actually be reached from here —
              asked up front, with a link per unmet prerequisite, instead
              of letting the operator discover each refusal in turn. */}
          <WorkBillingReadiness
            api={api}
            organisationId={organisationId}
            workId={workId}
            workItems={workItems}
          />
          <RelatedSectionGate
            labels={[RELATED.bills]}
            pending={relatedPending}
            failures={relatedFailures}
            onRetry={retryFailedSections}
          >
            <WorkBills
              api={api}
              organisationId={organisationId}
              bills={bills}
              setBills={setBills}
              canIssue={canIssue}
              pending={pending}
              act={act}
            />
          </RelatedSectionGate>
          {/* And what the railway actually paid against those bills. It
              belongs on this tab rather than on one of its own: a bill and
              its settlement are the same fact read from two ends, and
              splitting them puts the amount on one screen and the word
              "paid" on another — which is how the register came to be a
              spreadsheet in the first place. */}
          {/* `canIssue`, deliberately, and NOT `canIssueDocuments`. R8
              closes every create/record surface with the Work, and this is
              the one that must not close with it: recording that the
              railway paid moves no quantity and creates no document, and
              payment legitimately continues for months after execution
              finishes. `routes/retention.ts` says so in as many words and
              refuses nothing here, so gating the form on `workActive`
              would hide the only way to satisfy a "Mark paid" button that
              stays visible — an operator on a completed Work could see the
              refusal and have no route out of it. */}
          <WorkBillSettlement
            api={api}
            organisationId={organisationId}
            workId={workId}
            canIssue={canIssue}
            canCancel={canCancel}
          />
          {/* The GST document sits with the money it bills: the bill is
              what the contract owes, the tax invoice is what the law
              requires for it. */}
          <WorkTaxInvoices
            canSign={canSign}
            api={api}
            organisationId={organisationId}
            workId={workId}
            canModify={canModify}
            canCreateDocuments={canCreateDocuments}
            canIssue={canIssueDocuments}
            canCancel={canCancel}
            canManageStatutory={canManageStatutory}
            pending={pending}
            act={act}
            onInvoicesKnown={setTaxInvoiceCount}
          />
        </>
      )}

      {/* Inspection is deliberately outside `RELATED_BY_TAB`, for the reason
          Installations is: the tab loads its own configuration when it is
          opened, so the Work page holds no pending read to gate it on and
          no failure of its own to report. */}
      {tab === 'inspection' && (
        <WorkInspectionClause
          api={api}
          organisationId={organisationId}
          workId={workId}
          canModify={canModify}
          canGate={isOwner}
        />
      )}

      {tab === 'instruments' && (
        <RelatedSectionGate
          labels={[RELATED.instruments]}
          pending={relatedPending}
          failures={relatedFailures}
          onRetry={retryFailedSections}
        >
          <WorkInstruments
            api={api}
            organisationId={organisationId}
            workId={workId}
            work={work}
            schedules={schedules}
            instruments={instruments}
            setInstruments={setInstruments}
            canModify={canModify}
            canCreateDocuments={canCreateDocuments}
            canManageRetention={canManageRetention}
            pending={pending}
            act={act}
          />
        </RelatedSectionGate>
      )}

      {tab === 'amendments' && (
        <RelatedSectionGate
          labels={[RELATED.amendments]}
          pending={relatedPending}
          failures={relatedFailures}
          onRetry={retryFailedSections}
        >
          <WorkAmendments
            api={api}
            organisationId={organisationId}
            workId={workId}
            amendments={amendments}
            setAmendments={setAmendments}
            setDetail={setDetail}
            schedules={schedules}
            workItems={workItems}
            canCreateDocuments={canCreateDocuments}
            supersede={supersede}
            reloadSupersede={reloadSupersede}
            pending={pending}
            act={act}
          />
        </RelatedSectionGate>
      )}

      {tab === 'timeline' && (
        <Timeline
          api={api}
          organisationId={organisationId}
          scope={{ kind: 'work', workId }}
        />
      )}

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && (
        <FormError>
          {actionError.message}
          {actionError.wayfind !== null && (
            <>
              {' '}
              <a href={actionError.wayfind.hash}>{actionError.wayfind.label}</a>
            </>
          )}
        </FormError>
      )}

      <Actions>
        <Button variant="outline" onClick={onBack}>
          Back to Works
        </Button>
      </Actions>

      {/* Two ways in, one dialog. The navigation that followed the
          confirmation of this Work's letter offers it once, unasked; the
          overview prompt above opens it again for as long as the
          configuration is incomplete. Either way it writes nothing on its
          own — Later dismisses, and the same two editors live permanently
          under Schedules & items — and neither is offered to someone who
          could not act on it. */}
      {(promptPaymentSetup || paymentSetupOpen) && canModify && (
        <WorkPaymentSetup
          api={api}
          organisationId={organisationId}
          workId={workId}
          workItems={workItems}
          onClose={() => {
            setPaymentSetupOpen(false);
            onPaymentSetupClosed?.();
          }}
          onSaved={(saved) => {
            setDetail((current) =>
              current === null
                ? current
                : {
                    ...current,
                    schedules: current.schedules.map((schedule) => ({
                      ...schedule,
                      items: schedule.items.map((item) => {
                        const updated = saved.find(
                          (candidate) => candidate.id === item.id,
                        );
                        return updated === undefined
                          ? item
                          : { ...item, paymentCategory: updated.paymentCategory };
                      }),
                    })),
                  },
            );
            // Re-read the matrix rather than trusting what was sent: the
            // save may have been refused in part, another operator may
            // have configured a row meanwhile, and the overview prompt
            // above answers from these rows. One GET is cheaper than a
            // prompt that lies in either direction.
            void api
              .getPaymentMatrix(organisationId, workId)
              .then(setPaymentMatrixRows)
              .catch(() => undefined);
            setNotice('Payment setup saved for this Work.');
            setPaymentSetupOpen(false);
            onPaymentSetupClosed?.();
          }}
        />
      )}
    </Card>
  );
}
