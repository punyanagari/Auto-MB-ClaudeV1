import { useCallback, useEffect, useState } from 'react';
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
  /** Holds can_approve_amendments — gates manual back-fill deletion. */
  readonly canApprove: boolean;
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
};

/** The remedy is opposite for the two directions, so the worklist says
 * which one each row needs rather than leaving the operator to compare
 * the numbers. */
const DIRECTION_REMEDIES: Record<UnfinishedWorkItem['direction'], string> = {
  short: 'short — amend the quantity down',
  excess: 'over-delivered — amend the quantity up',
};

const DIRECTION_LABELS = {
  below: 'below advertised',
  at_par: 'at par',
  above: 'above advertised',
} as const;

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
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [unfinished, setUnfinished] = useState<readonly UnfinishedWorkItem[]>([]);
  const [blockers, setBlockers] = useState<readonly WorkCompletionBlocker[]>([]);
  /** What the server would say to a completion attempt, asked before the
   * operator writes a note. Null while it is still being read. */
  const [readiness, setReadiness] = useState<WorkCompletionReadiness | null>(null);
  const [ownTab, setOwnTab] = useState<WorkTab>('overview');
  const tab = controlledTab ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setChallans(null);
    setIssueChallans(null);
    setPurchaseOrders(null);
    setLoadError(null);
    Promise.all([
      api.getWork(organisationId, workId),
      api.listChallans(organisationId, workId),
      api.listInstruments(organisationId, workId),
      api.listMbEntries(organisationId, workId),
      api.listBills(organisationId, workId),
      api.listWorkSerials(organisationId, workId),
      api.listIssueChallans(organisationId, workId),
      api.listWorkAmendments(organisationId, workId),
      api.listWorkCorrectionNotices(organisationId, workId),
      api.listWorkPurchaseOrders(organisationId, workId),
    ])
      .then(
        ([
          loaded,
          loadedChallans,
          loadedInstruments,
          loadedEntries,
          loadedBills,
          loadedSerials,
          loadedIssueChallans,
          loadedAmendments,
          loadedCorrectionNotices,
          loadedPurchaseOrders,
        ]) => {
          if (cancelled) return;
          setDetail(loaded);
          setChallans(loadedChallans);
          setInstruments(loadedInstruments);
          setMbEntries(loadedEntries);
          setBills(loadedBills);
          setSerials(loadedSerials);
          setIssueChallans(loadedIssueChallans);
          setAmendments(loadedAmendments);
          setCorrectionNotices(loadedCorrectionNotices);
          setPurchaseOrders(loadedPurchaseOrders);
        },
      )
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The Work could not be loaded.',
        );
      });
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
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId]);

  const act = useCallback(async (work: () => Promise<void>, done: string) => {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The action failed; nothing was changed.',
      );
    } finally {
      setPending(false);
    }
  }, []);

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
        setActionError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The action failed; nothing was changed.',
        );
      } finally {
        setPending(false);
      }
    },
    [],
  );

  if (loadError !== null) {
    return (
      <Card aria-labelledby="work-title">
        <h1 id="work-title" tabIndex={-1}>
          Work
        </h1>
        <FormError>{loadError}</FormError>
      </Card>
    );
  }

  if (detail === null) {
    return (
      <Card aria-labelledby="work-title">
        <h1 id="work-title" tabIndex={-1}>
          Work
        </h1>
        <p className="text-muted-foreground" role="status">
          Loading Work…
        </p>
      </Card>
    );
  }

  const { work, schedules } = detail;
  const workItems = schedules.flatMap((schedule) => schedule.items);
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
      { label: 'Serial-tracked', value: String(serials.length) },
    ],
    deliveries: [
      { label: 'Issued', value: String(issuedChallans.length) },
      {
        label: 'Draft',
        value: String((challans ?? []).filter((c) => c.status === 'draft').length),
      },
      { label: 'Correction notices', value: String(correctionNotices.length) },
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
    measurement: [{ label: 'Entries recorded', value: String(mbEntries.length) }],
    bills: [{ label: 'Prepared', value: String(bills.length) }],
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
    schedules: workItems.length,
    deliveries: challans?.length ?? 0,
    procurement: purchaseOrders?.length ?? 0,
    issues: issueChallans?.length ?? 0,
    measurement: mbEntries.length,
    bills: bills.length,
    instruments: instruments.length,
    amendments: amendments.length,
    timeline: null,
  };
  return (
    <Card className="w-full" aria-labelledby="work-title">
      <h1 id="work-title" tabIndex={-1}>
        {work.workCode} — {work.title}
      </h1>
      <dl className="mt-3 mb-4 flex flex-wrap gap-x-8 gap-y-4 p-0 [&>div]:min-w-32 [&_dt]:mb-0.5 [&_dt]:text-[11px] [&_dt]:font-semibold [&_dt]:tracking-[0.025em] [&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-medium">
        <div>
          <dt>Letter</dt>
          <dd>
            {work.letterNumber} · {work.letterDate}
          </dd>
        </div>
        <div>
          <dt>Advertised value</dt>
          <dd>{formatInr(work.advertisedValue)}</dd>
        </div>
        <div>
          <dt>Contract value</dt>
          <dd>{formatInr(work.contractValue)}</dd>
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
          <dd>
            <Badge variant={work.status === 'completed' ? 'success' : 'info'}>
              {work.status}
            </Badge>
          </dd>
        </div>
        <div>
          <dt>Excess delivery</dt>
          <dd>
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
          </dd>
        </div>
      </dl>

      {/* Eleven sections used to stack on one scroll. Each area now answers
          for itself, and the counts show what is inside before it is opened. */}
      <nav
        className="mt-4 mb-2 flex items-center gap-0.5 overflow-x-auto border-b border-border"
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
                '-mb-px inline-flex items-center gap-2 border-b-2 border-transparent px-3 py-2',
                'text-sm whitespace-nowrap transition-colors',
                current
                  ? 'border-primary font-semibold text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
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
                    'rounded-sm px-1.5 py-px font-mono text-[11px] font-semibold tabular-nums',
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
            ).map((candidate) => (
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
                    {tabCounts[candidate] ?? 0}
                  </span>
                </span>
                <span className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                  {(summaryLines[candidate] ?? []).map((line) => (
                    <span className="flex items-baseline gap-2" key={line.label}>
                      {line.label}
                      <span className="ml-auto font-mono text-secondary-foreground tabular-nums">
                        {line.value}
                      </span>
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>

          <section aria-labelledby="work-completion-heading">
            <h2 id="work-completion-heading">Completion status</h2>
            {work.status === 'completed' ? (
              <>
                <p>
                  This Work is <strong>completed</strong>
                  {work.completedAt === null
                    ? ''
                    : ` on ${work.completedAt.slice(0, 10)}`}
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
          canModify={canModify}
          pending={pending}
          act={act}
        />
      )}

      {tab === 'deliveries' && (
        <WorkDeliveries
          api={api}
          organisationId={organisationId}
          workId={workId}
          work={work}
          workItems={workItems}
          challans={challans}
          correctionNotices={correctionNotices}
          setCorrectionNotices={setCorrectionNotices}
          serials={serials}
          setSerials={setSerials}
          canCreateDocuments={canCreateDocuments}
          canRecordSiteEvidence={canRecordSiteEvidence}
          onNewChallan={onNewChallan}
          onOpenChallan={onOpenChallan}
          pending={pending}
          act={act}
        />
      )}

      {tab === 'procurement' && (
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
      )}

      {tab === 'issues' && (
        <WorkIssueChallans
          workId={workId}
          issueChallans={issueChallans}
          canCreateDocuments={canCreateDocuments}
          onNewIssueChallan={onNewIssueChallan}
          onOpenIssueChallan={onOpenIssueChallan}
        />
      )}

      {tab === 'measurement' && (
        <WorkMeasurement
          api={api}
          organisationId={organisationId}
          workId={workId}
          workItems={workItems}
          mbEntries={mbEntries}
          setMbEntries={setMbEntries}
          issuedChallans={issuedChallans}
          challanNumberById={challanNumberById}
          setBills={setBills}
          canRecordSiteEvidence={canRecordSiteEvidence}
          canCreateDocuments={canCreateDocuments}
          canIssue={canIssue}
          canCancel={canCancel}
          pending={pending}
          act={act}
        />
      )}

      {tab === 'bills' && (
        <>
          <WorkBills
            api={api}
            organisationId={organisationId}
            bills={bills}
            setBills={setBills}
            canIssue={canIssue}
            pending={pending}
            act={act}
          />
          {/* The GST document sits with the money it bills: the bill is
              what the contract owes, the tax invoice is what the law
              requires for it. */}
          <WorkTaxInvoices
            api={api}
            organisationId={organisationId}
            workId={workId}
            canModify={canModify}
            canCreateDocuments={canCreateDocuments}
            canIssue={canIssueDocuments}
            canCancel={canCancel}
            pending={pending}
            act={act}
          />
        </>
      )}

      {tab === 'instruments' && (
        <WorkInstruments
          api={api}
          organisationId={organisationId}
          workId={workId}
          work={work}
          workItems={workItems}
          instruments={instruments}
          setInstruments={setInstruments}
          canModify={canModify}
          canCreateDocuments={canCreateDocuments}
          pending={pending}
          act={act}
        />
      )}

      {tab === 'amendments' && (
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
          pending={pending}
          act={act}
        />
      )}

      {tab === 'timeline' && (
        <Timeline
          api={api}
          organisationId={organisationId}
          scope={{ kind: 'work', workId }}
        />
      )}

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && <FormError>{actionError}</FormError>}

      <Actions>
        <Button variant="outline" onClick={onBack}>
          Back to Works
        </Button>
      </Actions>
    </Card>
  );
}
