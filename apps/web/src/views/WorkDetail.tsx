import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ApprovalRequest,
  Bill,
  Challan,
  CorrectionNotice,
  Instrument,
  IssueChallan,
  MbEntry,
  PurchaseOrder,
  Serial,
  UnfinishedWorkItem,
  WorkCompletionBlocker,
  WorkCompletionReadiness,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import { formatInr } from '../format.js';
import { cn } from '../lib/cn.js';
import { Button } from '../ui/button.js';
import { Badge } from '../ui/badge.js';
import { Card } from '../ui/card.js';
import { DataTable, numericCell } from '../ui/table.js';
import { Field, Actions, FormError, FormNotice } from '../ui/form.js';
import { Timeline } from './Timeline.js';
import { CompletionExtensions } from './CompletionExtensions.js';
import { WorkConsignees } from './WorkConsignees.js';
import { WorkInstruments } from './WorkInstruments.js';
import { WorkBills } from './WorkBills.js';
import { WorkIssueChallans } from './WorkIssueChallans.js';
import { WorkAmendments } from './WorkAmendments.js';
import { WorkSchedules } from './WorkSchedules.js';
import { WorkMeasurement } from './WorkMeasurement.js';
import { WorkDeliveries } from './WorkDeliveries.js';
import { WorkPurchaseOrders } from './WorkPurchaseOrders.js';
import { WorkTaxInvoices } from './WorkTaxInvoices.js';

interface WorkDetailProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canModify: boolean;
  readonly canRecordEvidence: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  /** Holds can_approve_amendments β€” gates manual back-fill deletion. */
  readonly canApprove: boolean;
  readonly isOwner: boolean;
  readonly onNewChallan: (workId: string, workCode: string) => void;
  readonly onOpenChallan: (challanId: string) => void;
  readonly onNewIssueChallan: (workId: string) => void;
  readonly onOpenIssueChallan: (challanId: string) => void;
  readonly onBack: () => void;
  /** Lifted so the tab survives a trip into a challan and back. Omitted, the
   * page keeps its own tab β€” which is what the component tests rely on. */
  readonly tab?: WorkTab;
  readonly onTabChange?: (tab: WorkTab) => void;
}

/** The Work page's areas. Eleven sections used to stack on one scroll; each
 * now answers for itself, and Overview summarises the rest. */
const WORK_TABS = [
  'overview',
  'schedules',
  'deliveries',
  'procurement',
  'issues',
  'measurement',
  'bills',
  'instruments',
  'amendments',
  'timeline',
] as const;

export type WorkTab = (typeof WORK_TABS)[number];

const WORK_TAB_LABELS: Record<WorkTab, string> = {
  overview: 'Overview',
  schedules: 'Schedules & items',
  deliveries: 'Deliveries',
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
} as const;

type RelatedLabel = (typeof RELATED)[keyof typeof RELATED];
type RelatedState = 'loading' | 'unavailable' | 'ready';
const ALL_RELATED_LABELS = Object.values(RELATED);
const RELATED_BY_TAB: Partial<Record<WorkTab, readonly RelatedLabel[]>> = {
  deliveries: [RELATED.challans],
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
  children,
}: {
  readonly labels: readonly RelatedLabel[];
  readonly pending: ReadonlySet<RelatedLabel>;
  readonly failures: ReadonlySet<RelatedLabel>;
  readonly children: ReactNode;
}) {
  const failed = labels.filter((label) => failures.has(label));
  if (failed.length > 0) {
    return (
      <FormError>
        This section is unavailable because {failed.join(', ')} could not be loaded. Try
        again later.
      </FormError>
    );
  }
  if (labels.some((label) => pending.has(label))) {
    return (
      <p className="text-muted-foreground" role="status">
        Loading this Work sectionβ€¦
      </p>
    );
  }
  return children;
}

/** The work items carrying an undecided omission proposal (R7). The
 * approved omission soft-deletes the item, so it leaves the detail
 * response entirely β€” the only omission state worth a chip is the
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
};

/** The remedy is opposite for the two directions, so the worklist says
 * which one each row needs rather than leaving the operator to compare
 * the numbers. */
const DIRECTION_REMEDIES: Record<UnfinishedWorkItem['direction'], string> = {
  short: 'short β€” amend the quantity down',
  excess: 'over-delivered β€” amend the quantity up',
};

const DIRECTION_LABELS = {
  below: 'below advertised',
  at_par: 'at par',
  above: 'above advertised',
} as const;

/** Why a Work will not close: the records still holding a claim on it, and
 * the items not yet at their sanctioned quantity. Rendered from the
 * readiness read before the operator writes anything, and again from the
 * refusal if one somehow gets past it β€” one component so the two can never
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
              <th scope="col">Remedy</th>
              <th scope="col">Required</th>
              <th scope="col">Delivered</th>
              <th scope="col">Installed</th>
            </tr>
          </thead>
          <tbody>
            {unfinished.map((item) => (
              <tr key={item.workItemId}>
                <th scope="row">{item.itemNumber}</th>
                <td>{item.category ?? 'uncategorised'}</td>
                <td>{REQUIREMENT_LABELS[item.requirement]}</td>
                <td>{DIRECTION_REMEDIES[item.direction]}</td>
                <td className={numericCell}>{item.requiredQuantity}</td>
                <td className={numericCell}>{item.deliveredQuantity}</td>
                <td className={numericCell}>{item.installedQuantity}</td>
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
  canCancel,
  canApprove,
  isOwner,
  onNewChallan,
  onOpenChallan,
  onNewIssueChallan,
  onOpenIssueChallan,
  onBack,
  tab: controlledTab,
  onTabChange,
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
  const [serials, setSerials] = useState<readonly Serial[]>([]);
  const [amendments, setAmendments] = useState<readonly ApprovalRequest[]>([]);
  const [correctionNotices, setCorrectionNotices] = useState<
    readonly CorrectionNotice[]
  >([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [relatedPending, setRelatedPending] = useState<ReadonlySet<RelatedLabel>>(
    new Set(),
  );
  const [relatedFailures, setRelatedFailures] = useState<ReadonlySet<RelatedLabel>>(
    new Set(),
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [unfinished, setUnfinished] = useState<readonly UnfinishedWorkItem[]>([]);
  const [blockers, setBlockers] = useState<readonly WorkCompletionBlocker[]>([]);
  /** What the server would say to a completion attempt, asked before the
   * operator writes a note. Null while it is still being read. */
  const [readiness, setReadiness] = useState<WorkCompletionReadiness | null>(null);
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
    setSerials([]);
    setAmendments([]);
    setCorrectionNotices([]);
    setLoadError(null);
    setRelatedPending(new Set(ALL_RELATED_LABELS));
    setRelatedFailures(new Set());
    setReadiness(null);

    // The Work identity and schedules are the page's critical read. Load them
    // independently so a temporary failure in one supporting register cannot
    // replace the entire Work with an error card.
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
    loadRelated(RELATED.bills, api.listBills(organisationId, workId), setBills);
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
    // Asked separately, and allowed to fail. It decides whether the
    // completion form is worth offering, not whether the page can be read;
    // a Work that cannot load its shortfall still has nine other areas.
    // Unknown falls back to offering the form β€” what the page did before it
    // thought to ask β€” and the server still refuses with the worklist.
    api
      .workCompletionReadγ^Έ¶‰ΛkΊwµη@€€€€€€€€€¥τ(€€€€€€€€€€π½‘ψ(€€€€€€€€π½‘¥Ψψ(€€€€€€π½‘°ψ((€€€€€μΌ¨±•Ω•ΈΝ•Ρ¥½ΉΜΥΝ•ΡΌΝΡ…¬½Έ½Ή”ΝΙ½±°Έ… …Ι•„Ή½ά…ΉΝέ•ΙΜ(€€€€€€€€€™½Θ¥ΡΝ•±°…ΉΡ΅”½ΥΉΡΜΝ΅½άέ΅…Π¥Μ¥ΉΝ¥‘”‰•™½Ι”¥Π¥Μ½Α•Ή•Έ€¨½τ(€€€€€€ρΉ…Ψ(€€€€€€€±…ΝΝ9…µ”τ‰µΠ΄Πµ΄Θ™±•ΰ¥Ρ•µΜµ•ΉΡ•Θ…ΐ΄ΐΈΤ½Ω•Ι™±½άµΰµ…ΥΡΌ‰½Ι‘•Θµ‰½Ι‘•Θµ‰½Ι‘•Θ(€€€€€€€…Ι¥„µ±…‰•°τ‰]½Ι¬Ν•Ρ¥½ΉΜ(€€€€€€ψ(€€€€€€€ν]=I-}Q	LΉµ…ΐ ΅…Ή‘¥‘…Ρ”¤€τψμ(€€€€€€€€€½ΉΝΠ½ΥΉΠ€τΡ…‰½ΥΉΡΝm…Ή‘¥‘…Ρ•tμ(€€€€€€€€€½ΉΝΠΥΙΙ•ΉΠ€τΡ…€τττ…Ή‘¥‘…Ρ”μ(€€€€€€€€€Ι•ΡΥΙΈ€ (€€€€€€€€€€€€ρ‰ΥΡΡ½Έ(€€€€€€€€€€€€€­•δυν…Ή‘¥‘…Ρ•τ(€€€€€€€€€€€€€ΡεΑ”τ‰‰ΥΡΡ½Έ(€€€€€€€€€€€€€±…ΝΝ9…µ”υνΈ (€€€€€€€€€€€€€€€€µµµΑΰ¥Ή±¥Ή”µ™±•ΰ¥Ρ•µΜµ•ΉΡ•Θ…ΐ΄Θ‰½Ι‘•Θµ΄Θ‰½Ι‘•ΘµΡΙ…ΉΝΑ…Ι•ΉΠΑΰ΄ΜΑδ΄Θ°(€€€€€€€€€€€€€€€€Ρ•αΠµΝ΄έ΅¥Ρ•ΝΑ…”µΉ½έΙ…ΐΡΙ…ΉΝ¥Ρ¥½Έµ½±½ΙΜ°(€€€€€€€€€€€€€€€ΥΙΙ•ΉΠ(€€€€€€€€€€€€€€€€€€ό€‰½Ι‘•ΘµΑΙ¥µ…Ιδ™½ΉΠµΝ•µ¥‰½±Ρ•αΠµ™½Ι•Ι½ΥΉ(€€€€€€€€€€€€€€€€€€θ€Ρ•αΠµµΥΡ•µ™½Ι•Ι½ΥΉ΅½Ω•ΘιΡ•αΠµ™½Ι•Ι½ΥΉ°(€€€€€€€€€€€€€€¥τ(€€€€€€€€€€€€€…Ι¥„µΥΙΙ•ΉΠυνΥΙΙ•ΉΠ€ό€Α…”€θΥΉ‘•™¥Ή•‘τ(€€€€€€€€€€€€€½Ή±¥¬υμ ¤€τψμ(€€€€€€€€€€€€€€€Ν•ΡQ…΅…Ή‘¥‘…Ρ”¤μ(€€€€€€€€€€€€€υτ(€€€€€€€€€€€€ψ(€€€€€€€€€€€€€ν]=I-}Q	}1	1Mm…Ή‘¥‘…Ρ•uτ(€€€€€€€€€€€€€ν½ΥΉΠ€„ττΉΥ±°€€ (€€€€€€€€€€€€€€€€ρΝΑ…Έ(€€€€€€€€€€€€€€€€€±…ΝΝ9…µ”υνΈ (€€€€€€€€€€€€€€€€€€€€Ι½ΥΉ‘•µΝ΄Αΰ΄ΔΈΤΑδµΑΰ™½ΉΠµµ½ΉΌΡ•αΠµlΔΕΑαt™½ΉΠµΝ•µ¥‰½±Ρ…‰Υ±…ΘµΉΥµΜ°(€€€€€€€€€€€€€€€€€€€ΥΙΙ•ΉΠ(€€€€€€€€€€€€€€€€€€€€€€ό€‰µΑΙ¥µ…ΙδΡ•αΠµΑΙ¥µ…Ιδµ™½Ι•Ι½ΥΉ(€€€€€€€€€€€€€€€€€€€€€€θ€‰µµΥΡ•Ρ•αΠµµΥΡ•µ™½Ι•Ι½ΥΉ°(€€€€€€€€€€€€€€€€€€¥τ(€€€€€€€€€€€€€€€€ψ(€€€€€€€€€€€€€€€€€ν½ΥΉΡτ(€€€€€€€€€€€€€€€€π½ΝΑ…Έψ(€€€€€€€€€€€€€€¥τ(€€€€€€€€€€€€π½‰ΥΡΡ½Έψ(€€€€€€€€€€¤μ(€€€€€€€τ¥τ(€€€€€€π½Ή…Ψψ((€€€€€νΡ…€τττ€½Ω•ΙΩ¥•ά€€ (€€€€€€€€πψ(€€€€€€€€€μΌ¨Q΅”έ΅½±”ΝΡ…Ρ”½„]½Ι¬°‰•™½Ι”…ΉεΡ΅¥Ή¥Μ½Α•Ή•Έ… •±°(€€€€€€€€€€€€€…ΙΙ¥•ΜΡ΅”½ΥΉΠ¥ΡΜΡ…Ν΅½έΜ°ΝΌΡ΅”ΝΥµµ…Ιδ…ΉΡ΅”Ρ…ΝΡΙ¥ΐ(€€€€€€€€€€€€€…ΈΉ•Ω•Θ‘¥Ν…Ι•”ƒP‰½Ρ Ι•…Ρ΅”Ν…µ”‘•Ι¥Ω…Ρ¥½ΈΈ€¨½τ(€€€€€€€€€€ρ‘¥Ψ±…ΝΝ9…µ”τ‰µ΄ΠΙ¥Ι¥µ½±ΜµmΙ•Α•…Π΅…ΥΡΌµ™¥Π±µ¥Ήµ…ΰ ΔΥΙ•΄°Ε™Θ¤¥t½Ω•Ι™±½άµ΅¥‘‘•ΈΙ½ΥΉ‘•µα°‰½Ι‘•Θ‰½Ι‘•Θµ‰½Ι‘•Θ‰µ…Ιψ(€€€€€€€€€€€ν]=I-}Q	LΉ™¥±Ρ•Θ (€€€€€€€€€€€€€€΅…Ή‘¥‘…Ρ”¤€τψ…Ή‘¥‘…Ρ”€„ττ€½Ω•ΙΩ¥•ά€…Ή‘¥‘…Ρ”€„ττ€Ρ¥µ•±¥Ή”°(€€€€€€€€€€€€¤Ήµ…ΐ ΅…Ή‘¥‘…Ρ”¤€τψμ(€€€€€€€€€€€€€½ΉΝΠΙ•±…Ρ•‘MΡ…Ρ”€τΙ•±…Ρ•‘MΡ…Ρ•½ΙQ…΅…Ή‘¥‘…Ρ”¤μ(€€€€€€€€€€€€€Ι•ΡΥΙΈ€ (€€€€€€€€€€€€€€€€ρ‰ΥΡΡ½Έ(€€€€€€€€€€€€€€€€€­•δυν…Ή‘¥‘…Ρ•τ(€€€€€€€€€€€€€€€€€ΡεΑ”τ‰‰ΥΡΡ½Έ(€€€€€€€€€€€€€€€€€±…ΝΝ9…µ”τ‰™±•ΰΥΙΝ½ΘµΑ½¥ΉΡ•Θ™±•ΰµ½°¥Ρ•µΜµΝΡΙ•Ρ …ΐ΄Θ‰½Ι‘•ΘµΠ‰½Ι‘•Θµ°‰½Ι‘•Θµ‰½Ι‘•ΘΑΰ΄ΠΑδ΄ΜΡ•αΠµ±•™ΠΡΙ…ΉΝ¥Ρ¥½Έµ½±½ΙΜ΅½Ω•Θι‰µµΥΡ•(€€€€€€€€€€€€€€€€€½Ή±¥¬υμ ¤€τψμ(€€€€€€€€€€€€€€€€€€€Ν•ΡQ…΅…Ή‘¥‘…Ρ”¤μ(€€€€€€€€€€€€€€€€€υτ(€€€€€€€€€€€€€€€€ψ(€€€€€€€€€€€€€€€€€€ρΝΑ…Έ±…ΝΝ9…µ”τ‰™±•ΰ¥Ρ•µΜµ‰…Ν•±¥Ή”…ΐ΄Θψ(€€€€€€€€€€€€€€€€€€€€ρΝΑ…Έ±…ΝΝ9…µ”τ‰Ρ•αΠµΝ΄™½ΉΠµΝ•µ¥‰½±ψ(€€€€€€€€€€€€€€€€€€€€€ν]=I-}Q	}1	1Mm…Ή‘¥‘…Ρ•uτ(€€€€€€€€€€€€€€€€€€€€π½ΝΑ…Έψ(€€€€€€€€€€€€€€€€€€€€ρΝΑ…Έ±…ΝΝ9…µ”τ‰µ°µ…ΥΡΌ™½ΉΠµµ½ΉΌΡ•αΠµ±™½ΉΠµΝ•µ¥‰½±ΡΙ…­¥ΉµΡ¥΅ΠΡ…‰Υ±…ΘµΉΥµΜψ(€€€€€€€€€€€€€€€€€€€€€νΡ…‰½ΥΉΡΝm…Ή‘¥‘…Ρ•t€όό€Pτ(€€€€€€€€€€€€€€€€€€€€π½ΝΑ…Έψ(€€€€€€€€€€€€€€€€€€π½ΝΑ…Έψ(€€€€€€€€€€€€€€€€€€ρΝΑ…Έ±…ΝΝ9…µ”τ‰™±•ΰ™±•ΰµ½°…ΐ΄ΔΡ•αΠµlΔΕΑαtΡ•αΠµµΥΡ•µ™½Ι•Ι½ΥΉψ(€€€€€€€€€€€€€€€€€€€νΙ•±…Ρ•‘MΡ…Ρ”€τττ€Ι•…‘δ€ό€ (€€€€€€€€€€€€€€€€€€€€€€΅ΝΥµµ…Ιε1¥Ή•Νm…Ή‘¥‘…Ρ•t€όόmt¤Ήµ…ΐ ΅±¥Ή”¤€τψ€ (€€€€€€€€€€€€€€€€€€€€€€€€ρΝΑ…Έ±…ΝΝ9…µ”τ‰™±•ΰ¥Ρ•µΜµ‰…Ν•±¥Ή”…ΐ΄Θ­•δυν±¥Ή”Ή±…‰•±τψ(€€€€€€€€€€€€€€€€€€€€€€€€€ν±¥Ή”Ή±…‰•±τ(€€€€€€€€€€€€€€€€€€€€€€€€€€ρΝΑ…Έ±…ΝΝ9…µ”τ‰µ°µ…ΥΡΌ™½ΉΠµµ½ΉΌΡ•αΠµΝ•½Ή‘…Ιδµ™½Ι•Ι½ΥΉΡ…‰Υ±…ΘµΉΥµΜψ(€€€€€€€€€€€€€€€€€€€€€€€€€€€ν±¥Ή”ΉΩ…±Υ•τ(€€€€€€€€€€€€€€€€€€€€€€€€€€π½ΝΑ…Έψ(€€€€€€€€€€€€€€€€€€€€€€€€π½ΝΑ…Έψ(€€€€€€€€€€€€€€€€€€€€€€¤¤(€€€€€€€€€€€€€€€€€€€€¤€θ€ (€€€€€€€€€€€€€€€€€€€€€€ρΝΑ…Έψ(€€€€€€€€€€€€€€€€€€€€€€€νΙ•±…Ρ•‘MΡ…Ρ”€τττ€±½…‘¥Ή€ό€1½…‘¥Ή€θ€UΉ…Ω…¥±…‰±”τ(€€€€€€€€€€€€€€€€€€€€€€π½ΝΑ…Έψ(€€€€€€€€€€€€€€€€€€€€¥τ(€€€€€€€€€€€€€€€€€€π½ΝΑ…Έψ(€€€€€€€€€€€€€€€€π½‰ΥΡΡ½Έψ(€€€€€€€€€€€€€€¤μ(€€€€€€€€€€€τ¥τ(€€€€€€€€€€π½‘¥Ψψ((€€€€€€€€€€ρΝ•Ρ¥½Έ…Ι¥„µ±…‰•±±•‘‰δτ‰έ½Ι¬µ½µΑ±•Ρ¥½Έµ΅•…‘¥Ήψ(€€€€€€€€€€€€ρ Θ¥τ‰έ½Ι¬µ½µΑ±•Ρ¥½Έµ΅•…‘¥Ήω½µΑ±•Ρ¥½ΈΝΡ…ΡΥΜπ½ Θψ(€€€€€€€€€€€νέ½Ι¬ΉΝΡ…ΡΥΜ€τττ€½µΑ±•Ρ•€ό€ (€€€€€€€€€€€€€€πψ(€€€€€€€€€€€€€€€€ρΐψ(€€€€€€€€€€€€€€€€€Q΅¥Μ]½Ι¬¥Μ€ρΝΡΙ½Ήω½µΑ±•Ρ•π½ΝΡΙ½Ήψ(€€€€€€€€€€€€€€€€€νέ½Ι¬Ή½µΑ±•Ρ•‘Π€τττΉΥ±°(€€€€€€€€€€€€€€€€€€€€ό€(€€€€€€€€€€€€€€€€€€€€θ€½Έ€‘νέ½Ι¬Ή½µΑ±•Ρ•‘ΠΉΝ±¥” ΐ°€Δΐ¥υτ(€€€€€€€€€€€€€€€€€€Έ9ΌΉ•ά΅…±±…Έ°¥ΉΝΡ…±±…Ρ¥½Έ°A•ΙΡ¥™¥…Ρ”°5•…ΝΥΙ•µ•ΉΠ	½½¬°(€€€€€€€€€€€€€€€€€•αΡ•ΉΝ¥½ΈΙ•ΕΥ•ΝΠ°½Θ΅…Ή”ΑΙ½Α½Ν…°…Έ‰”Ι•½Ι‘•ΥΉΡ¥°¥Π¥Μ(€€€€€€€€€€€€€€€€€Ι•½Α•Ή•Έ(€€€€€€€€€€€€€€€€π½ΐψ(€€€€€€€€€€€€€€€νέ½Ι¬Ή½µΑ±•Ρ¥½Ή9½Ρ”€„ττΉΥ±°€€ (€€€€€€€€€€€€€€€€€€ρΐ±…ΝΝ9…µ”τ‰Ρ•αΠµµΥΡ•µ™½Ι•Ι½ΥΉψ(€€€€€€€€€€€€€€€€€€€½µΑ±•Ρ¥½ΈΉ½Ρ”θνέ½Ι¬Ή½µΑ±•Ρ¥½Ή9½Ρ•τ(€€€€€€€€€€€€€€€€€€π½ΐψ(€€€€€€€€€€€€€€€€¥τ(€€€€€€€€€€€€€€πΌψ(€€€€€€€€€€€€¤€θ€ (€€€€€€€€€€€€€€ρΐ±…ΝΝ9…µ”τ‰Ρ•αΠµµΥΡ•µ™½Ι•Ι½ΥΉψ(€€€€€€€€€€€€€€€]½Ι¬½µΑ±•Ρ•Μ½Ή±δ…Π€Δΐΐ”•α•ΥΡ•Ω…±Υ”€΅•Ω•Ιδ¥Ρ•΄™Υ±±δ‘•±¥Ω•Ι•(€€€€€€€€€€€€€€€…Ή½½Θ¥ΉΝΡ…±±•Α•Θ¥ΡΜΑ…εµ•ΉΠ…Ρ•½Ιδ¤Έ½Θ„Ν΅½ΙΠ±½ΝΥΙ”°…µ•Ή(€€€€€€€€€€€€€€€Ρ΅”ΕΥ…ΉΡ¥Ρ¥•Μ‘½έΈΡ΅Ι½Υ Ρ΅”…ΑΑΙ½Ω…°Α…Ρ ™¥ΙΝΠΈ(€€€€€€€€€€€€€€π½ΐψ(€€€€€€€€€€€€¥τ((€€€€€€€€€€€ν…Ή5½‘¥™δ€έ½Ι­Ρ¥Ω”€Ι•…‘¥Ή•ΝΜόΉΙ•…‘δ€τττ™…±Ν”€€ (€€€€€€€€€€€€€€Ό¨Q΅”Ν΅½ΙΡ™…±°ΝΡ…Ή‘Μέ΅•Ι”Ρ΅”™½Ι΄έ½Υ±‰”Έ!¥‘¥ΉΡ΅”(€€€€€€€€€€€€€€€€½ΉΡΙ½°½Έ¥ΡΜ½έΈέ½Υ±±•…Ω”…Έ½Α•Ι…Ρ½Θέ΅Ό…µ”΅•Ι”ΡΌ(€€€€€€€€€€€€€€€€±½Ν”Ρ΅”]½Ι¬έ¥Ρ Ή½Ρ΅¥ΉΡΌΙ•…μΡ΅¥Μ¥ΜΡ΅”Ν…µ”(€€€€€€€€€€€€€€€€έ½Ι­±¥ΝΠΡ΅”Ι•™ΥΝ…°έ½Υ±΅…Ω”Ι•ΡΥΙΉ•°µ¥ΉΥΜΡ΅”έ…ΝΡ•(€€€€€€€€€€€€€€€€½µΑ±•Ρ¥½ΈΉ½Ρ”Έ€¨Ό(€€€€€€€€€€€€€€ρ½µΑ±•Ρ¥½ΉM΅½ΙΡ™…±°(€€€€€€€€€€€€€€€‰±½­•ΙΜυνΙ•…‘¥Ή•ΝΜΉ‰±½­•ΙΝτ(€€€€€€€€€€€€€€€ΥΉ™¥Ή¥Ν΅•υνΙ•…‘¥Ή•ΝΜΉΥΉ™¥Ή¥Ν΅•‘τ(€€€€€€€€€€€€€€€±•…τ‰Q΅¥Μ]½Ι¬…ΉΉ½Π‰”½µΑ±•Ρ•ε•ΠΈ(€€€€€€€€€€€€€€Όψ(€€€€€€€€€€€€¥τ((€€€€€€€€€€€ν…Ή5½‘¥™δ€έ½Ι­Ρ¥Ω”€Ι•…‘¥Ή•ΝΜόΉΙ•…‘δ€„ττ™…±Ν”€€ (€€€€€€€€€€€€€€ρ™½Ι΄(€€€€€€€€€€€€€€€½ΉMΥ‰µ¥Πυμ΅•Ω•ΉΠ¤€τψμ(€€€€€€€€€€€€€€€€€•Ω•ΉΠΉΑΙ•Ω•ΉΡ•™…Υ±Π ¤μ(€€€€€€€€€€€€€€€€€½ΉΝΠ‘…Ρ„€τΉ•ά½Ιµ…Ρ„΅•Ω•ΉΠΉΥΙΙ•ΉΡQ…Ι•Π¤μ(€€€€€€€€€€€€€€€€€½ΉΝΠΉ½Ρ”€τ™½ΙµY…±Υ”΅‘…Ρ„°€½µΑ±•Ρ¥½ΈµΉ½Ρ”¤μ(€€€€€€€€€€€€€€€€€Ω½¥ΡΙ…ΉΝ¥Ρ¥½Έ΅…ΝεΉ€ ¤€τψμ(€€€€€€€€€€€€€€€€€€€½ΉΝΠΥΑ‘…Ρ•€τ…έ…¥Π…Α¤Ή½µΑ±•Ρ•]½Ι¬΅½Ι…Ή¥Ν…Ρ¥½Ή%°έ½Ι­%°μ(€€€€€€€€€€€€€€€€€€€€€Ή½Ρ”°(€€€€€€€€€€€€€€€€€€€τ¤μ(€€€€€€€€€€€€€€€€€€€Ι•ΡΥΙΈΥΑ‘…Ρ•Ήέ½Ι¬μ(€€€€€€€€€€€€€€€€€τ°€]½Ι¬µ…Ι­•½µΑ±•Ρ•Έ¤μ(€€€€€€€€€€€€€€€υτ(€€€€€€€€€€€€€€ψ(€€€€€€€€€€€€€€€€ρ¥•±ψ(€€€€€€€€€€€€€€€€€€ρ±…‰•°΅Ρµ±½Θτ‰έ½Ι¬µ½µΑ±•Ρ¥½ΈµΉ½Ρ”ψ(€€€€€€€€€€€€€€€€€€€]΅δΡ΅¥Μ]½Ι¬¥Μ‰•¥Ή½µΑ±•Ρ•(€€€€€€€€€€€€€€€€€€π½±…‰•°ψ(€€€€€€€€€€€€€€€€€€ρΡ•αΡ…Ι•„(€€€€€€€€€€€€€€€€€€€¥τ‰έ½Ι¬µ½µΑ±•Ρ¥½ΈµΉ½Ρ”(€€€€€€€€€€€€€€€€€€€Ή…µ”τ‰½µΑ±•Ρ¥½ΈµΉ½Ρ”(€€€€€€€€€€€€€€€€€€€Ι•ΕΥ¥Ι•(€€€€€€€€€€€€€€€€€€€µ¥Ή1•ΉΡ υμΝτ(€€€€€€€€€€€€€€€€€€€µ…α1•ΉΡ υμΘΐΐΑτ(€€€€€€€€€€€€€€€€€€€Ι½έΜυμΙτ(€€€€€€€€€€€€€€€€€€Όψ(€€€€€€€€€€€€€€€€π½¥•±ψ(€€€€€€€€€€€€€€€€ρΡ¥½ΉΜψ(€€€€€€€€€€€€€€€€€€ρ	ΥΡΡ½ΈΡεΑ”τ‰ΝΥ‰µ¥Π‘¥Ν…‰±•υνΑ•Ή‘¥Ήτψ(€€€€€€€€€€€€€€€€€€€½µΑ±•Ρ”]½Ι¬(€€€€€€€€€€€€€€€€€€π½	ΥΡΡ½Έψ(€€€€€€€€€€€€€€€€π½Ρ¥½ΉΜψ(€€€€€€€€€€€€€€π½™½Ι΄ψ(€€€€€€€€€€€€¥τ((€€€€€€€€€€€ν…Ή5½‘¥™δ€€…έ½Ι­Ρ¥Ω”€€ (€€€€€€€€€€€€€€ρ™½Ι΄(€€€€€€€€€€€€€€€½ΉMΥ‰µ¥Πυμ΅•Ω•ΉΠ¤€τψμ(€€€€€€€€€€€€€€€€€•Ω•ΉΠΉΑΙ•Ω•ΉΡ•™…Υ±Π ¤μ(€€€€€€€€€€€€€€€€€½ΉΝΠ‘…Ρ„€τΉ•ά½Ιµ…Ρ„΅•Ω•ΉΠΉΥΙΙ•ΉΡQ…Ι•Π¤μ(€€€€€€€€€€€€€€€€€½ΉΝΠΉ½Ρ”€τ™½ΙµY…±Υ”΅‘…Ρ„°€Ι•½Α•ΈµΉ½Ρ”¤μ(€€€€€€€€€€€€€€€€€Ω½¥ΡΙ…ΉΝ¥Ρ¥½Έ΅…ΝεΉ€ ¤€τψμ(€€€€€€€€€€€€€€€€€€€½ΉΝΠΥΑ‘…Ρ•€τ…έ…¥Π…Α¤ΉΙ•½Α•Ή]½Ι¬΅½Ι…Ή¥Ν…Ρ¥½Ή%°έ½Ι­%°μ(€€€€€€€€€€€€€€€€€€€€€Ή½Ρ”°(€€€€€€€€€€€€€€€€€€€τ¤μ(€€€€€€€€€€€€€€€€€€€Ι•ΡΥΙΈΥΑ‘…Ρ•Ήέ½Ι¬μ(€€€€€€€€€€€€€€€€€τ°€]½Ι¬Ι•½Α•Ή•Έ¤μ(€€€€€€€€€€€€€€€υτ(€€€€€€€€€€€€€€ψ(€€€€€€€€€€€€€€€€ρ¥•±ψ(€€€€€€€€€€€€€€€€€€ρ±…‰•°΅Ρµ±½Θτ‰έ½Ι¬µΙ•½Α•ΈµΉ½Ρ”ψ(€€€€€€€€€€€€€€€€€€€]΅δΡ΅¥Μ]½Ι¬¥Μ‰•¥ΉΙ•½Α•Ή•(€€€€€€€€€€€€€€€€€€π½±…‰•°ψ(€€€€€€€€€€€€€€€€€€ρΡ•αΡ…Ι•„(€€€€€€€€€€€€€€€€€€€¥τ‰έ½Ι¬µΙ•½Α•ΈµΉ½Ρ”(€€€€€€€€€€€€€€€€€€€Ή…µ”τ‰Ι•½Α•ΈµΉ½Ρ”(€€€€€€€€€€€€€€€€€€€Ι•ΕΥ¥Ι•(€€€€€€€€€€€€€€€€€€€µ¥Ή1•ΉΡ υμΝτ(€€€€€€€€€€€€€€€€€€€µ…α1•ΉΡ υμΘΐΐΑτ(€€€€€€€€€€€€€€€€€€€Ι½έΜυμΙτ(€€€€€€€€€€€€€€€€€€Όψ(€€€€€€€€€€€€€€€€π½¥•±ψ(€€€€€€€€€€€€€€€€ρΡ¥½ΉΜψ(€€€€€€€€€€€€€€€€€€ρ	ΥΡΡ½ΈΡεΑ”τ‰ΝΥ‰µ¥Π‘¥Ν…‰±•υνΑ•Ή‘¥Ήτψ(€€€€€€€€€€€€€€€€€€€I•½Α•Έ]½Ι¬(€€€€€€€€€€€€€€€€€€π½	ΥΡΡ½Έψ(€€€€€€€€€€€€€€€€π½Ρ¥½ΉΜψ(€€€€€€€€€€€€€€π½™½Ι΄ψ(€€€€€€€€€€€€¥τ((€€€€€€€€€€€μΌ¨Q΅”Ν…µ”ΡέΌ±¥ΝΡΜ°έ΅•Ρ΅•ΘΡ΅•δέ•Ι”…Ν­•™½ΘΥΐ™Ι½ΉΠ½Θ(€€€€€€€€€€€€€€€…µ”‰…¬™Ι½΄„Ι•™ΥΝ•…ΡΡ•µΑΠΈ€¨½τ(€€€€€€€€€€€€ρ½µΑ±•Ρ¥½ΉM΅½ΙΡ™…±°‰±½­•ΙΜυν‰±½­•ΙΝτΥΉ™¥Ή¥Ν΅•υνΥΉ™¥Ή¥Ν΅•‘τ€Όψ(€€€€€€€€€€π½Ν•Ρ¥½Έψ((€€€€€€€€€€ρ½µΑ±•Ρ¥½ΉαΡ•ΉΝ¥½ΉΜ(€€€€€€€€€€€…Α¤υν…Α¥τ(€€€€€€€€€€€½Ι…Ή¥Ν…Ρ¥½Ή%υν½Ι…Ή¥Ν…Ρ¥½Ή%‘τ(€€€€€€€€€€€έ½Ι­%υνέ½Ι­%‘τ(€€€€€€€€€€€…Ή5½‘¥™δυν…ΉΙ•…Ρ•½Υµ•ΉΡΝτ(€€€€€€€€€€€…Ή%ΝΝΥ”υν…Ή%ΝΝΥ•½Υµ•ΉΡΝτ(€€€€€€€€€€€…ΉΑΑΙ½Ω”υν…ΉΑΑΙ½Ω•τ(€€€€€€€€€€Όψ((€€€€€€€€€€ρ]½Ι­½ΉΝ¥Ή••Μ(€€€€€€€€€€€…Α¤υν…Α¥τ(€€€€€€€€€€€½Ι…Ή¥Ν…Ρ¥½Ή%υν½Ι…Ή¥Ν…Ρ¥½Ή%‘τ(€€€€€€€€€€€έ½Ι­%υνέ½Ι­%‘τ(€€€€€€€€€€€…Ή5½‘¥™δυν…Ή5½‘¥™ετ(€€€€€€€€€€Όψ(€€€€€€€€πΌψ(€€€€€€¥τ((€€€€€νΡ…€τττ€Ν΅•‘Υ±•Μ€€ (€€€€€€€€ρ]½Ι­M΅•‘Υ±•Μ(€€€€€€€€€…Α¤υν…Α¥τ(€€€€€€€€€½Ι…Ή¥Ν…Ρ¥½Ή%υν½Ι…Ή¥Ν…Ρ¥½Ή%‘τ(€€€€€€€€€έ½Ι­%υνέ½Ι­%‘τ(€€€€€€€€€Ν΅•‘Υ±•ΜυνΝ΅•‘Υ±•Ντ(€€€€€€€€€έ½Ι­%Ρ•µΜυνέ½Ι­%Ρ•µΝτ(€€€€€€€€€Α•Ή‘¥ΉI•µ½Ω…±ΜυνΑ•Ή‘¥ΉI•µ½Ω…±Ντ(€€€€€€€€€Ν•Ρ•Ρ…¥°υνΝ•Ρ•Ρ…¥±τ(€€€€€€€€€…Ή5½‘¥™δυν…Ή5½‘¥™δ€Ι•±…Ρ•‘MΡ…Ρ•½Θ΅mI1QΉ…µ•Ή‘µ•ΉΡΝt¤€τττ€Ι•…‘δτ(€€€€€€€€€Α•Ή‘¥ΉυνΑ•Ή‘¥Ήτ(€€€€€€€€€…Πυν…Ρτ(€€€€€€€€Όψ(€€€€€€¥τ((€€€€€νΡ…€τττ€‘•±¥Ω•Ι¥•Μ€€ (€€€€€€€€ρ]½Ι­•±¥Ω•Ι¥•Μ(€€€€€€€€€…Α¤υν…Α¥τ(€€€€€€€€€½Ι…Ή¥Ν…Ρ¥½Ή%υν½Ι…Ή¥Ν…Ρ¥½Ή%‘τ(€€€€€€€€€έ½Ι­%υνέ½Ι­%‘τ(€€€€€€€€€έ½Ι¬υνέ½Ι­τ(€€€€€€€€€έ½Ι­%Ρ•µΜυνέ½Ι­%Ρ•µΝτ(€€€€€€€€€΅…±±…ΉΜυν΅…±±…ΉΝτ(€€€€€€€€€΅…±±…ΉΝMΡ…Ρ”υνΙ•±…Ρ•‘MΡ…Ρ•½Θ΅mI1QΉ΅…±±…ΉΝt¥τ(€€€€€€€€€½ΙΙ•Ρ¥½Ή9½Ρ¥•Μυν½ΙΙ•Ρ¥½Ή9½Ρ¥•Ντ(€€€€€€€€€½ΙΙ•Ρ¥½Ή9½Ρ¥•ΝMΡ…Ρ”υνΙ•±…Ρ•‘MΡ…Ρ•½Θ΅mI1QΉ½ΙΙ•Ρ¥½Ή9½Ρ¥•Νt¥τ(€€€€€€€€€Ν•Ρ½ΙΙ•Ρ¥½Ή9½Ρ¥•ΜυνΝ•Ρ½ΙΙ•Ρ¥½Ή9½Ρ¥•Ντ(€€€€€€€€€Ν•Ι¥…±ΜυνΝ•Ι¥…±Ντ(€€€€€€€€€Ν•Ι¥…±ΝMΡ…Ρ”υνΙ•±…Ρ•‘MΡ…Ρ•½Θ΅mI1QΉΝ•Ι¥…±Νt¥τ(€€€€€€€€€Ν•ΡM•Ι¥…±ΜυνΝ•ΡM•Ι¥…±Ντ(€€€€€€€€€…ΉΙ•…Ρ•½Υµ•ΉΡΜυν…ΉΙ•…Ρ•½Υµ•ΉΡΝτ(€€€€€€€€€…ΉI•½Ι‘M¥Ρ•Ω¥‘•Ή”υν…ΉI•½Ι‘M¥Ρ•Ω¥‘•Ή•τ(€€€€€€€€€½Ή9•έ΅…±±…Έυν½Ή9•έ΅…±±…Ήτ(€€€€€€€€€½Ή=Α•Ή΅…±±…Έυν½Ή=Α•Ή΅…±±…Ήτ(€€€€€€€€€Α•Ή‘¥ΉυνΑ•Ή‘¥Ήτ(€€€€€€€€€…Πυν…Ρτ(€€€€€€€€Όψ(€€€€€€¥τ((€€€€€νΡ…€τττ€ΑΙ½ΥΙ•µ•ΉΠ€€ (€€€€€€€€ρI•±…Ρ•‘M•Ρ¥½Ή…Ρ”(€€€€€€€€€±…‰•±ΜυνmI1QΉΑΥΙ΅…Ν•=Ι‘•ΙΝuτ(€€€€€€€€€Α•Ή‘¥ΉυνΙ•±…Ρ•‘A•Ή‘¥Ήτ(€€€€€€€€€™…¥±ΥΙ•ΜυνΙ•±…Ρ•‘…¥±ΥΙ•Ντ(€€€€€€€€ψ(€€€€€€€€€€ρ]½Ι­AΥΙ΅…Ν•=Ι‘•ΙΜ(€€€€€€€€€€€…Α¤υν…Α¥τ(€€€€€€€€€€€½Ι…Ή¥Ν…Ρ¥½Ή%υν½Ι…Ή¥Ν…Ρ¥½Ή%‘τ(€€€€€€€€€€€έ½Ι­%υνέ½Ι­%‘τ(€€€€€€€€€€€έ½Ι­%Ρ•µΜυνέ½Ι­%Ρ•µΝτ(€€€€€€€€€€€ΑΥΙ΅…Ν•=Ι‘•ΙΜυνΑΥΙ΅…Ν•=Ι‘•ΙΝτ(€€€€€€€€€€€Ν•ΡAΥΙ΅…Ν•=Ι‘•ΙΜυνΝ•ΡAΥΙ΅…Ν•=Ι‘•ΙΝτ(€€€€€€€€€€€…Ή5½‘¥™δυν…Ή5½‘¥™ετ(€€€€€€€€€€€…ΉΙ•…Ρ•½Υµ•ΉΡΜυν…ΉΙ•…Ρ•½Υµ•ΉΡΝτ(€€€€€€€€€€€…Ή%ΝΝΥ”υν…Ή%ΝΝΥ•½Υµ•ΉΡΝτ(€€€€€€€€€€€…Ή…Ή•°υν…Ή…Ή•±τ(€€€€€€€€€€€Α•Ή‘¥ΉυνΑ•Ή‘¥Ήτ(€€€€€€€€€€€…Πυν…Ρτ(€€€€€€€€€€Όψ(€€€€€€€€π½I•±…Ρ•‘M•Ρ¥½Ή…Ρ”ψ(€€€€€€¥τ((€€€€€νΡ…€τττ€¥ΝΝΥ•Μ€€ (€€€€€€€€ρI•±…Ρ•‘M•Ρ¥½Ή…Ρ”(€€€€€€€€€±…‰•±ΜυνmI1QΉ¥ΝΝΥ•΅…±±…ΉΝuτ(€€€€€€€€€Α•Ή‘¥ΉυνΙ•±…Ρ•‘A•Ή‘¥Ήτ(€€€€€€€€€™…¥±ΥΙ•ΜυνΙ•±…Ρ•‘…¥±ΥΙ•Ντ(€€€€€€€€ψ(€€€€€€€€€€ρ]½Ι­%ΝΝΥ•΅…±±…ΉΜ(€€€€€€€€€€€έ½Ι­%υνέ½Ι­%‘τ(€€€€€€€€€€€¥ΝΝΥ•΅…±±…ΉΜυν¥ΝΝΥ•΅…±±…ΉΝτ(€€€€€€€€€€€…ΉΙ•…Ρ•½Υµ•ΉΡΜυν…ΉΙ•…Ρ•½Υµ•ΉΡΝτ(€€€€€€€€€€€½Ή9•έ%ΝΝΥ•΅…±±…Έυν½Ή9•έ%ΝΝΥ•΅…±±…Ήτ(€€€€€€€€€€€½Ή=Α•Ή%ΝΝΥ•΅…±±…Έυν½Ή=Α•Ή%ΝΝΥ•΅…±±…Ήτ(€€€€€€€€€€Όψ(€€€€€€€€π½I•±…Ρ•‘M•Ρ¥½Ή…Ρ”ψ(€€€€€€¥τ((€€€€€νΡ…€τττ€µ•…ΝΥΙ•µ•ΉΠ€€ (€€€€€€€€ρ]½Ι­5•…ΝΥΙ•µ•ΉΠ(€€€€€€€€€…Α¤υν…Α¥τ(€€€€€€€€€½Ι…Ή¥Ν…Ρ¥½Ή%υν½Ι…Ή¥Ν…Ρ¥½Ή%‘τ(€€€€€€€€€έ½Ι­%υνέ½Ι­%‘τ(€€€€€€€€€έ½Ι­%Ρ•µΜυνέ½Ι­%Ρ•µΝτ(€€€€€€€€€µ‰ΉΡΙ¥•Μυνµ‰ΉΡΙ¥•Ντ(€€€€€€€€€µ‰ΉΡΙ¥•ΝMΡ…Ρ”υνΙ•±…Ρ•‘MΡ…Ρ•½Θ΅mI1QΉµ•…ΝΥΙ•µ•ΉΡΝt¥τ(€€€€€€€€€Ν•Ρ5‰ΉΡΙ¥•ΜυνΝ•Ρ5‰ΉΡΙ¥•Ντ(€€€€€€€€€¥ΝΝΥ•‘΅…±±…ΉΜυν¥ΝΝΥ•‘΅…±±…ΉΝτ(€€€€€€€€€΅…±±…Ή9Υµ‰•Ι	ε%υν΅…±±…Ή9Υµ‰•Ι	ε%‘τ(€€€€€€€€€΅…±±…ΉΝMΡ…Ρ”υνΙ•±…Ρ•‘MΡ…Ρ•½Θ΅mI1QΉ΅…±±…ΉΝt¥τ(€€€€€€€€€Ν•Ρ	¥±±ΜυνΝ•Ρ	¥±±Ντ(€€€€€€€€€‰¥±±ΝMΡ…Ρ”υνΙ•±…Ρ•‘MΡ…Ρ•½Θ΅mI1QΉ‰¥±±Νt¥τ(€€€€€€€€€…ΉI•½Ι‘M¥Ρ•Ω¥‘•Ή”υν…ΉI•½Ι‘M¥Ρ•Ω¥‘•Ή•τ(€€€€€€€€€…ΉΙ•…Ρ•½Υµ•ΉΡΜυν…ΉΙ•…Ρ•½Υµ•ΉΡΝτ(€€€€€€€€€…Ή%ΝΝΥ”υν…Ή%ΝΝΥ•τ(€€€€€€€€€…Ή…Ή•°υν…Ή…Ή•±τ(€€€€€€€€€Α•Ή‘¥ΉυνΑ•Ή‘¥Ήτ(€€€€€€€€€…Πυν…Ρτ(€€€€€€€€Όψ(€€€€€€¥τ((€€€€€νΡ…€τττ€‰¥±±Μ€€ (€€€€€€€€πψ(€€€€€€€€€€ρI•±…Ρ•‘M•Ρ¥½Ή…Ρ”(€€€€€€€€€€€±…‰•±ΜυνmI1QΉ‰¥±±Νuτ(€€€€€€€€€€€Α•Ή‘¥ΉυνΙ•±…Ρ•‘A•Ή‘¥Ήτ(€€€€€€€€€€€™…¥±ΥΙ•ΜυνΙ•±…Ρ•‘…¥±ΥΙ•Ντ(€€€€€€€€€€ψ(€€€€€€€€€€€€ρ]½Ι­	¥±±Μ(€€€€€€€€€€€€€…Α¤υν…Α¥τ(€€€€€€€€€€€€€½Ι…Ή¥Ν…Ρ¥½Ή%υν½Ι…Ή¥Ν…Ρ¥½Ή%‘τ(€€€€€€€€€€€€€‰¥±±Μυν‰¥±±Ντ(€€€€€€€€€€€€€Ν•Ρ	¥±±ΜυνΝ•Ρ	¥±±Ντ(€€€€€€€€€€€€€…Ή%ΝΝΥ”υν…Ή%ΝΝΥ•τ(€€€€€€€€€€€€€Α•Ή‘¥ΉυνΑ•Ή‘¥Ήτ(€€€€€€€€€€€€€…Πυν…Ρτ(€€€€€€€€€€€€Όψ(€€€€€€€€€€π½I•±…Ρ•‘M•Ρ¥½Ή…Ρ”ψ(€€€€€€€€€μΌ¨Q΅”MP‘½Υµ•ΉΠΝ¥ΡΜέ¥Ρ Ρ΅”µ½Ή•δ¥Π‰¥±±ΜθΡ΅”‰¥±°¥Μ(€€€€€€€€€€€€€έ΅…ΠΡ΅”½ΉΡΙ…Π½έ•Μ°Ρ΅”Ρ…ΰ¥ΉΩ½¥”¥Μέ΅…ΠΡ΅”±…ά(€€€€€€€€€€€€€Ι•ΕΥ¥Ι•Μ™½Θ¥ΠΈ€¨½τ(€€€€€€€€€€ρ]½Ι­Q…α%ΉΩ½¥•Μ(€€€€€€€€€€€…Α¤υν…Α¥τ(€€€€€€€€€€€½Ι…Ή¥Ν…Ρ¥½Ή%υν½Ι…Ή¥Ν…Ρ¥½Ή%‘τ(€€€€€€€€€€€έ½Ι­%υνέ½Ι­%‘τ(€€€€€€€€€€€…Ή5½‘¥™δυν…Ή5½‘¥™ετ(€€€€€€€€€€€…ΉΙ•…Ρ•½Υµ•ΉΡΜυν…ΉΙ•…Ρ•½Υµ•ΉΡΝτ(€€€€€€€€€€€…Ή%ΝΝΥ”υν…Ή%ΝΝΥ•½Υµ•ΉΡΝτ(€€€€€€€€€€€…Ή…Ή•°υν…Ή…Ή•±τ(€€€€€€€€€€€Α•Ή‘¥ΉυνΑ•Ή‘¥Ήτ(€€€€€€€€€€€…Πυν…Ρτ(€€€€€€€€€€Όψ(€€€€€€€€πΌψ(€€€€€€¥τ((€€€€€νΡ…€τττ€¥ΉΝΡΙΥµ•ΉΡΜ€€ (€€€€€€€€ρI•±…Ρ•‘M•Ρ¥½Ή…Ρ”(€€€€€€€€€±…‰•±ΜυνmI1QΉ¥ΉΝΡΙΥµ•ΉΡΝuτ(€€€€€€€€€Α•Ή‘¥ΉυνΙ•±…Ρ•‘A•Ή‘¥Ήτ(€€€€€€€€€™…¥±ΥΙ•ΜυνΙ•±…Ρ•‘…¥±ΥΙ•Ντ(€€€€€€€€ψ(€€€€€€€€€€ρ]½Ι­%ΉΝΡΙΥµ•ΉΡΜ(€€€€€€€€€€€…Α¤υν…Α¥τ(€€€€€€€€€€€½Ι…Ή¥Ν…Ρ¥½Ή%υν½Ι…Ή¥Ν…Ρ¥½Ή%‘τ(€€€€€€€€€€€έ½Ι­%υνέ½Ι­%‘τ(€€€€€€€€€€€έ½Ι¬υνέ½Ι­τ(€€€€€€€€€€€έ½Ι­%Ρ•µΜυνέ½Ι­%Ρ•µΝτ(€€€€€€€€€€€¥ΉΝΡΙΥµ•ΉΡΜυν¥ΉΝΡΙΥµ•ΉΡΝτ(€€€€€€€€€€€Ν•Ρ%ΉΝΡΙΥµ•ΉΡΜυνΝ•Ρ%ΉΝΡΙΥµ•ΉΡΝτ(€€€€€€€€€€€…Ή5½‘¥™δυν…Ή5½‘¥™ετ(€€€€€€€€€€€…ΉΙ•…Ρ•½Υµ•ΉΡΜυν…ΉΙ•…Ρ•½Υµ•ΉΡΝτ(€€€€€€€€€€€Α•Ή‘¥ΉυνΑ•Ή‘¥Ήτ(€€€€€€€€€€€…Πυν…Ρτ(€€€€€€€€€€Όψ(€€€€€€€€π½I•±…Ρ•‘M•Ρ¥½Ή…Ρ”ψ(€€€€€€¥τ((€€€€€νΡ…€τττ€…µ•Ή‘µ•ΉΡΜ€€ (€€€€€€€€ρI•±…Ρ•‘M•Ρ¥½Ή…Ρ”(€€€€€€€€€±…‰•±ΜυνmI1QΉ…µ•Ή‘µ•ΉΡΝuτ(€€€€€€€€€Α•Ή‘¥ΉυνΙ•±…Ρ•‘A•Ή‘¥Ήτ(€€€€€€€€€™…¥±ΥΙ•ΜυνΙ•±…Ρ•‘…¥±ΥΙ•Ντ(€€€€€€€€ψ(€€€€€€€€€€ρ]½Ι­µ•Ή‘µ•ΉΡΜ(€€€€€€€€€€€…Α¤υν…Α¥τ(€€€€€€€€€€€½Ι…Ή¥Ν…Ρ¥½Ή%υν½Ι…Ή¥Ν…Ρ¥½Ή%‘τ(€€€€€€€€€€€έ½Ι­%υνέ½Ι­%‘τ(€€€€€€€€€€€…µ•Ή‘µ•ΉΡΜυν…µ•Ή‘µ•ΉΡΝτ(€€€€€€€€€€€Ν•Ρµ•Ή‘µ•ΉΡΜυνΝ•Ρµ•Ή‘µ•ΉΡΝτ(€€€€€€€€€€€Ν•Ρ•Ρ…¥°υνΝ•Ρ•Ρ…¥±τ(€€€€€€€€€€€Ν΅•‘Υ±•ΜυνΝ΅•‘Υ±•Ντ(€€€€€€€€€€€έ½Ι­%Ρ•µΜυνέ½Ι­%Ρ•µΝτ(€€€€€€€€€€€…ΉΙ•…Ρ•½Υµ•ΉΡΜυν…ΉΙ•…Ρ•½Υµ•ΉΡΝτ(€€€€€€€€€€€Α•Ή‘¥ΉυνΑ•Ή‘¥Ήτ(€€€€€€€€€€€…Πυν…Ρτ(€€€€€€€€€€Όψ(€€€€€€€€π½I•±…Ρ•‘M•Ρ¥½Ή…Ρ”ψ(€€€€€€¥τ((€€€€€νΡ…€τττ€Ρ¥µ•±¥Ή”€€ (€€€€€€€€ρQ¥µ•±¥Ή”(€€€€€€€€€…Α¤υν…Α¥τ(€€€€€€€€€½Ι…Ή¥Ν…Ρ¥½Ή%υν½Ι…Ή¥Ν…Ρ¥½Ή%‘τ(€€€€€€€€€Ν½Α”υνμ­¥Ήθ€έ½Ι¬°έ½Ι­%υτ(€€€€€€€€Όψ(€€€€€€¥τ((€€€€€νΉ½Ρ¥”€„ττΉΥ±°€€ρ½Ιµ9½Ρ¥”ωνΉ½Ρ¥•τπ½½Ιµ9½Ρ¥”ωτ(€€€€€ν…Ρ¥½ΉΙΙ½Θ€„ττΉΥ±°€€ρ½ΙµΙΙ½Θων…Ρ¥½ΉΙΙ½Ιτπ½½ΙµΙΙ½Θωτ((€€€€€€ρΡ¥½ΉΜψ(€€€€€€€€ρ	ΥΡΡ½ΈΩ…Ι¥…ΉΠτ‰½ΥΡ±¥Ή”½Ή±¥¬υν½Ή	…­τψ(€€€€€€€€€	…¬ΡΌ]½Ι­Μ(€€€€€€€€π½	ΥΡΡ½Έψ(€€€€€€π½Ρ¥½ΉΜψ(€€€€π½…Ιψ(€€¤μ)τ(