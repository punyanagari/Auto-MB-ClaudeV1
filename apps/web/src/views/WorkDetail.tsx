import { useCallback, useEffect, useState } from 'react';
import type {
  ApprovalRequest,
  Bill,
  Challan,
  CorrectionNotice,
  Instrument,
  InstrumentStatus,
  IssueChallan,
  MbEntry,
  Serial,
  UnfinishedWorkItem,
  WorkCompletionBlocker,
  WorkDetailResponse,
  WorkItem,
} from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import { formatInr, formatRate } from '../format.js';
import { Timeline } from './Timeline.js';
import { CompletionExtensions } from './CompletionExtensions.js';
import { WorkConsignees } from './WorkConsignees.js';
import { Installations } from './Installations.js';
import { PaymentMatrix } from './PaymentMatrix.js';
import { PacCertificates } from './PacCertificates.js';
import { MeasurementBooks } from './MeasurementBooks.js';

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

const MOVEMENT_LABELS: Record<IssueChallan['movementType'], string> = {
  issue: 'Issue',
  loan: 'Loan',
  return: 'Return',
};
/** Renders "original → effective" when an approved amendment changed the
 * value, and the original alone otherwise. */
/** The Work page's areas. Eleven sections used to stack on one scroll; each
 * now answers for itself, and Overview summarises the rest. */
const WORK_TABS = [
  'overview',
  'schedules',
  'deliveries',
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
  issues: 'Issues',
  measurement: 'Measurement',
  bills: 'Bills',
  instruments: 'Instruments',
  amendments: 'Amendments',
  timeline: 'Timeline',
};

function Amended({
  original,
  effective,
}: {
  readonly original: string;
  readonly effective: string | null | undefined;
}) {
  if (effective === null || effective === undefined || effective === original) {
    return <>{original}</>;
  }
  return (
    <>
      <s className="muted">{original}</s> → <strong>{effective}</strong>
    </>
  );
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

function itemFlags(item: WorkItem, pendingRemovals: ReadonlySet<string>) {
  return {
    removalPending: pendingRemovals.has(item.id),
    added: item.amendmentAdded === true,
  };
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

const INSTRUMENT_LABELS: Record<Instrument['kind'], string> = {
  pbg: 'PBG',
  pac: 'PAC',
  doc: 'DOC',
};

interface BillLine {
  readonly itemNumber: string;
  readonly unitCode: string;
  readonly quantity: string;
  readonly rate: string;
  readonly amount: string;
}

/** The snapshot is stored as jsonb and typed unknown in the contract;
 * anything that does not match the expected line shape is dropped rather
 * than rendered as "[object Object]". */
function billLines(snapshot: unknown): readonly BillLine[] {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.filter(
    (line): line is BillLine =>
      typeof line === 'object' &&
      line !== null &&
      typeof (line as BillLine).itemNumber === 'string' &&
      typeof (line as BillLine).quantity === 'string' &&
      typeof (line as BillLine).amount === 'string',
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
  const [ownTab, setOwnTab] = useState<WorkTab>('overview');
  const tab = controlledTab ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setChallans(null);
    setIssueChallans(null);
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
  const tabCounts: Record<WorkTab, number | null> = {
    overview: null,
    schedules: workItems.length,
    deliveries: challans?.length ?? 0,
    issues: issueChallans?.length ?? 0,
    measurement: mbEntries.length,
    bills: bills.length,
    instruments: instruments.length,
    amendments: amendments.length,
    timeline: null,
  };
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
            <span
              className={
                work.status === 'completed'
                  ? 'chip chip--completed'
                  : 'chip chip--active'
              }
            >
              {work.status}
            </span>
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
      <nav className="work-tabs" aria-label="Work sections">
        {WORK_TABS.map((candidate) => {
          const count = tabCounts[candidate];
          return (
            <button
              key={candidate}
              type="button"
              className="work-tabs__tab"
              aria-current={tab === candidate ? 'page' : undefined}
              onClick={() => {
                setTab(candidate);
              }}
            >
              {WORK_TAB_LABELS[candidate]}
              {count !== null && <span className="work-tabs__count">{count}</span>}
            </button>
          );
        })}
      </nav>

      {tab === 'overview' && (
        <>
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
                  <p className="muted">Completion note: {work.completionNote}</p>
                )}
              </>
            ) : (
              <p className="muted">
                A Work completes only at 100% executed value (every item fully delivered
                and/or installed per its payment category). For a short closure, amend
                the quantities down through the approval path first.
              </p>
            )}

            {canModify && workActive && (
              <form
                className="stacked-form"
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
                <div className="field">
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
                </div>
                <div className="actions">
                  <button type="submit" disabled={pending}>
                    Complete Work
                  </button>
                </div>
              </form>
            )}

            {canModify && !workActive && (
              <form
                className="stacked-form"
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
                <div className="field">
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
                </div>
                <div className="actions">
                  <button type="submit" disabled={pending}>
                    Reopen Work
                  </button>
                </div>
              </form>
            )}

            {blockers.length > 0 && (
              <table className="data-table">
                <caption>
                  Finish or discard these records before completing the Work
                </caption>
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
              </table>
            )}

            {unfinished.length > 0 && (
              <table className="data-table">
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
                      <td className="cell--numeric">{item.requiredQuantity}</td>
                      <td className="cell--numeric">{item.deliveredQuantity}</td>
                      <td className="cell--numeric">{item.installedQuantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {tab === 'schedules' && (
        <>
          {schedules.map((schedule) => (
            <div key={schedule.id}>
              <h2>
                Schedule {schedule.scheduleCode}
                <span className="muted"> · {schedule.items.length} items</span>
              </h2>
              <table className="data-table">
                <caption className="visually-hidden">
                  Awarded items in schedule {schedule.scheduleCode}; amended values show
                  the original beside the sanctioned change
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Item number</th>
                    <th scope="col">Description</th>
                    <th scope="col">Unit</th>
                    <th scope="col">Awarded quantity</th>
                    <th scope="col">Rate (₹)</th>
                    <th scope="col">Serial tracking</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.items.map((item) => {
                    const flags = itemFlags(item, pendingRemovals);
                    return (
                      <tr key={item.id}>
                        <th scope="row">
                          {item.itemNumber}
                          {flags.added && (
                            <span className="chip chip--issued">added</span>
                          )}
                          {flags.removalPending && (
                            <span className="chip chip--pending">omission pending</span>
                          )}
                        </th>
                        <td className="cell--wrap">
                          <Amended
                            original={item.description}
                            effective={item.effectiveDescription}
                          />
                        </td>
                        <td>
                          <Amended
                            original={item.unitCode}
                            effective={item.effectiveUnit}
                          />
                        </td>
                        <td className="cell--numeric">
                          <Amended
                            original={item.awardedQuantity}
                            effective={item.effectiveQuantity}
                          />
                        </td>
                        <td className="cell--numeric">
                          <Amended
                            original={item.effectiveRate}
                            effective={item.effectiveUnitRate}
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {schedule.items.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">{item.itemNumber}</th>
                      <td className="cell--wrap">{item.description}</td>
                      <td>{item.unitCode}</td>
                      <td className="cell--numeric">{item.awardedQuantity}</td>
                      <td className="cell--numeric">{item.effectiveRate}</td>
                      <td>
                        {canModify ? (
                          <button
                            type="button"
                            className="button--ghost"
                            role="switch"
                            aria-checked={item.requiresSerials === true}
                            aria-label={`Serial tracking for ${item.itemNumber}`}
                            disabled={pending}
                            onClick={() =>
                              void act(
                                async () => {
                                  const updated = await api.updateWorkItemSerials(
                                    organisationId,
                                    item.id,
                                    !item.requiresSerials,
                                  );
                                  setDetail((current) =>
                                    current === null
                                      ? current
                                      : {
                                          ...current,
                                          schedules: current.schedules.map(
                                            (candidate) => ({
                                              ...candidate,
                                              items: candidate.items.map(
                                                (candidateItem) =>
                                                  candidateItem.id === item.id
                                                    ? {
                                                        ...candidateItem,
                                                        requiresSerials:
                                                          updated.requiresSerials,
                                                      }
                                                    : candidateItem,
                                              ),
                                            }),
                                          ),
                                        },
                                  );
                                },
                                item.requiresSerials
                                  ? `Serial tracking switched off for ${item.itemNumber}.`
                                  : `Serial tracking required for ${item.itemNumber}; challans for it now need one serial per unit before issue.`,
                              )
                            }
                          >
                            {item.requiresSerials ? 'Required' : 'Off'}
                          </button>
                        ) : (
                          <span className={item.requiresSerials ? '' : 'muted'}>
                            {item.requiresSerials ? 'Required' : 'Off'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <PaymentMatrix
            api={api}
            organisationId={organisationId}
            workId={workId}
            workItems={workItems}
            canModify={canModify}
            onItemCategoryChanged={(workItemId, paymentCategory) => {
              setDetail((current) =>
                current === null
                  ? current
                  : {
                      ...current,
                      schedules: current.schedules.map((candidate) => ({
                        ...candidate,
                        items: candidate.items.map((candidateItem) =>
                          candidateItem.id === workItemId
                            ? { ...candidateItem, paymentCategory }
                            : candidateItem,
                        ),
                      })),
                    },
              );
            }}
          />
        </>
      )}

      {tab === 'amendments' && (
        <>
          <h2>Amendments</h2>
          <p className="muted">
            Sanctioned changes to quantities, rates, descriptions, and items. The
            awarded LOA values are never overwritten; approved amendments apply as
            effective values shown beside the originals above.
          </p>
          {amendments.length > 0 ? (
            <table className="data-table">
              <caption className="visually-hidden">
                Amendment requests for this Work
              </caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Change</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {amendments.map((amendment) => (
                  <tr key={amendment.id}>
                    <th scope="row">{amendment.itemNumber ?? '—'}</th>
                    <td className="cell--wrap">
                      {amendment.diff
                        .map(
                          (entry) =>
                            `${entry.field}: ${entry.before ?? '—'} → ${entry.after ?? '—'}`,
                        )
                        .join('; ')}
                    </td>
                    <td className="cell--wrap">{amendment.reason}</td>
                    <td>
                      <span className={`chip chip--${amendment.status}`}>
                        {amendment.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No amendments proposed yet.</p>
          )}
          {canCreateDocuments && (
            <AmendmentForm
              items={workItems}
              schedules={schedules}
              pending={pending}
              onProposeChange={(body) => {
                void act(async () => {
                  await api.proposeAmendment(organisationId, workId, body);
                  const [freshDetail, freshAmendments] = await Promise.all([
                    api.getWork(organisationId, workId),
                    api.listWorkAmendments(organisationId, workId),
                  ]);
                  setDetail(freshDetail);
                  setAmendments(freshAmendments);
                }, 'Amendment recorded — it applies once approved (immediately if you hold the approval authority).');
              }}
              onProposeAdd={(body) => {
                void act(async () => {
                  await api.proposeAddItem(organisationId, workId, body);
                  const [freshDetail, freshAmendments] = await Promise.all([
                    api.getWork(organisationId, workId),
                    api.listWorkAmendments(organisationId, workId),
                  ]);
                  setDetail(freshDetail);
                  setAmendments(freshAmendments);
                }, 'Amendment recorded — it applies once approved (immediately if you hold the approval authority).');
              }}
              onProposeRemove={(body) => {
                void act(async () => {
                  await api.proposeItemRemoval(organisationId, workId, body);
                  const [freshDetail, freshAmendments] = await Promise.all([
                    api.getWork(organisationId, workId),
                    api.listWorkAmendments(organisationId, workId),
                  ]);
                  setDetail(freshDetail);
                  setAmendments(freshAmendments);
                }, 'Omission recorded — it applies once approved (immediately if you hold the approval authority).');
              }}
            />
          )}
        </>
      )}

      {tab === 'deliveries' && (
        <>
          <div className="card__header">
            <h2>Delivery Challans</h2>
            {canCreateDocuments &&
              (challans?.some((challan) => challan.status === 'draft') === true ? (
                <button
                  type="button"
                  onClick={() => {
                    const draft = challans.find(
                      (challan) => challan.status === 'draft',
                    );
                    if (draft) onOpenChallan(draft.id);
                  }}
                >
                  Open draft challan
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    onNewChallan(workId, work.workCode);
                  }}
                >
                  New Delivery Challan
                </button>
              ))}
          </div>
          {challans !== null && challans.length > 0 ? (
            <table className="data-table">
              <caption className="visually-hidden">
                Delivery Challans for this Work
              </caption>
              <thead>
                <tr>
                  <th scope="col">Number</th>
                  <th scope="col">Date</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {challans.map((challan) => (
                  <tr key={challan.id}>
                    <th scope="row">
                      <button
                        type="button"
                        className="button--link"
                        onClick={() => {
                          onOpenChallan(challan.id);
                        }}
                      >
                        {challan.challanNumber ?? 'Draft'}
                      </button>
                    </th>
                    <td>{challan.challanDate}</td>
                    <td>
                      <span className={`chip chip--${challan.status}`}>
                        {challan.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No Delivery Challans yet.</p>
          )}

          {correctionNotices.length > 0 && (
            <>
              <h2>Correction notices</h2>
              <table className="data-table">
                <caption className="visually-hidden">
                  Correction notices issued for this Work
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Notice</th>
                    <th scope="col">Status</th>
                    <th scope="col">Issued</th>
                    <th scope="col">PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {correctionNotices.map((correctionNotice) => (
                    <tr key={correctionNotice.id}>
                      <th scope="row">{correctionNotice.noticeNumber}</th>
                      <td>
                        <span className={`chip chip--${correctionNotice.status}`}>
                          {correctionNotice.status}
                        </span>
                      </td>
                      <td>{correctionNotice.createdAt.slice(0, 10)}</td>
                      <td>
                        {correctionNotice.renderedAvailable ? (
                          <button
                            type="button"
                            className="button--ghost"
                            disabled={pending}
                            onClick={() =>
                              void act(async () => {
                                const blob = await api.downloadCorrectionNoticePdf(
                                  organisationId,
                                  correctionNotice.id,
                                );
                                const url = URL.createObjectURL(blob);
                                window.open(url, '_blank', 'noopener');
                                setTimeout(() => {
                                  URL.revokeObjectURL(url);
                                }, 60_000);
                              }, 'Correction notice PDF opened in a new tab.')
                            }
                          >
                            Open PDF
                          </button>
                        ) : canCreateDocuments &&
                          correctionNotice.status === 'issued' ? (
                          <button
                            type="button"
                            className="button--ghost"
                            disabled={pending}
                            onClick={() =>
                              void act(async () => {
                                await api.renderCorrectionNotice(
                                  organisationId,
                                  correctionNotice.id,
                                );
                                setCorrectionNotices(
                                  await api.listWorkCorrectionNotices(
                                    organisationId,
                                    workId,
                                  ),
                                );
                              }, 'Correction notice PDF generated.')
                            }
                          >
                            Generate PDF
                          </button>
                        ) : (
                          <span className="muted">not rendered</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {tab === 'issues' && (
        <>
          <div className="card__header">
            <h2>Issue Challans</h2>
            {canCreateDocuments &&
              (issueChallans?.some((challan) => challan.status === 'draft') === true ? (
                <button
                  type="button"
                  onClick={() => {
                    const draft = issueChallans.find(
                      (challan) => challan.status === 'draft',
                    );
                    if (draft) onOpenIssueChallan(draft.id);
                  }}
                >
                  Open draft Issue Challan
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    onNewIssueChallan(workId);
                  }}
                >
                  New Issue Challan
                </button>
              ))}
          </div>
          {issueChallans !== null && issueChallans.length > 0 ? (
            <table className="data-table">
              <caption className="visually-hidden">
                Issue Challans for this Work
              </caption>
              <thead>
                <tr>
                  <th scope="col">Number</th>
                  <th scope="col">Movement</th>
                  <th scope="col">Date</th>
                  <th scope="col">Issued to</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {issueChallans.map((challan) => (
                  <tr key={challan.id}>
                    <th scope="row">
                      <button
                        type="button"
                        className="button--link"
                        onClick={() => {
                          onOpenIssueChallan(challan.id);
                        }}
                      >
                        {challan.challanNumber ?? 'Draft'}
                      </button>
                    </th>
                    <td>{MOVEMENT_LABELS[challan.movementType]}</td>
                    <td>{challan.challanDate}</td>
                    <td className="cell--wrap">{challan.issuedToName}</td>
                    <td>
                      <span className={`chip chip--${challan.status}`}>
                        {challan.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              No Issue Challans yet. Issue Challans record material sent out to site,
              job work, loans, and returns.
            </p>
          )}
        </>
      )}

      {notice !== null && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}
      {actionError !== null && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}

      {tab === 'overview' && (
        <>
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

      {tab === 'instruments' && (
        <>
          <h2>Contract instruments</h2>
          {typeof work.pbgRequiredAmount === 'string' ? (
            <dl className="fact-list" aria-label="PBG requirement from the letter">
              <div>
                <dt>PBG required by the letter</dt>
                <dd>{formatInr(work.pbgRequiredAmount)}</dd>
              </div>
              <div>
                <dt>Submission window</dt>
                <dd>
                  {work.pbgSubmissionDays !== null
                    ? `${String(work.pbgSubmissionDays)} days from the letter date`
                    : '—'}
                  {work.pbgExtensionDays !== null &&
                    ` (+${String(work.pbgExtensionDays)} days extension)`}
                </dd>
              </div>
              <div>
                <dt>Penal interest</dt>
                <dd>
                  {work.pbgPenalInterestPercent !== null
                    ? `${work.pbgPenalInterestPercent}% p.a.`
                    : '—'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="muted">
              The letter records no Performance Bank Guarantee requirement.
            </p>
          )}
          {instruments.length > 0 ? (
            <table className="data-table">
              <caption className="visually-hidden">
                Bank guarantees and certificates held for this Work
              </caption>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Reference</th>
                  <th scope="col" className="cell--numeric">
                    Amount
                  </th>
                  <th scope="col">Issued</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Status</th>
                  {canModify && <th scope="col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {instruments.map((instrument) => (
                  <tr key={instrument.id}>
                    <td>{INSTRUMENT_LABELS[instrument.kind]}</td>
                    <th scope="row">{instrument.reference}</th>
                    <td className="cell--numeric">
                      {instrument.amount !== null ? formatInr(instrument.amount) : '—'}
                    </td>
                    <td>{instrument.issuedOn}</td>
                    <td>{instrument.expiresOn ?? '—'}</td>
                    <td>
                      <span className={`chip chip--${instrument.status}`}>
                        {instrument.status}
                      </span>
                    </td>
                    {canModify && (
                      <td>
                        {instrument.status === 'active' ? (
                          <InstrumentStatusEditor
                            instrument={instrument}
                            pending={pending}
                            onApply={(status) =>
                              void act(async () => {
                                const updated = await api.updateInstrument(
                                  organisationId,
                                  instrument.id,
                                  { status },
                                );
                                setInstruments((current) =>
                                  current.map((candidate) =>
                                    candidate.id === updated.id ? updated : candidate,
                                  ),
                                );
                              }, `${instrument.reference} marked ${status}.`)
                            }
                          />
                        ) : (
                          <span className="muted">final</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No PBG, PAC, or document instruments recorded yet.</p>
          )}
          {canModify && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const kind = formValue(data, 'instrument-kind') || 'pbg';
                const reference = formValue(data, 'instrument-reference');
                const amount = formValue(data, 'instrument-amount').trim();
                const issuedOn = formValue(data, 'instrument-issued');
                const expiresOn = formValue(data, 'instrument-expires');
                const notes = formValue(data, 'instrument-notes').trim();
                void act(async () => {
                  const created = await api.createInstrument(organisationId, workId, {
                    kind: kind as Instrument['kind'],
                    reference,
                    issuedOn,
                    ...(amount.length > 0 ? { amount } : {}),
                    ...(expiresOn.length > 0 ? { expiresOn } : {}),
                    ...(notes.length > 0 ? { notes } : {}),
                  });
                  setInstruments((current) => [...current, created]);
                  form.reset();
                }, `${reference} recorded.`);
              }}
            >
              <h3>Add instrument</h3>
              <div className="field">
                <label htmlFor="instrument-kind">Kind</label>
                <select id="instrument-kind" name="instrument-kind" required>
                  <option value="pbg">PBG — Performance Bank Guarantee</option>
                  <option value="pac">PAC — Provisional Acceptance Certificate</option>
                  <option value="doc">DOC — other contract document</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="instrument-reference">Reference</label>
                <input
                  id="instrument-reference"
                  name="instrument-reference"
                  required
                  maxLength={200}
                />
              </div>
              <div className="field">
                <label htmlFor="instrument-amount">Amount (₹, optional)</label>
                <input
                  id="instrument-amount"
                  name="instrument-amount"
                  inputMode="decimal"
                />
              </div>
              <div className="field">
                <label htmlFor="instrument-issued">Issued on</label>
                <input
                  id="instrument-issued"
                  name="instrument-issued"
                  type="date"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="instrument-expires">Expires on (optional)</label>
                <input id="instrument-expires" name="instrument-expires" type="date" />
              </div>
              <div className="field">
                <label htmlFor="instrument-notes">Notes (optional)</label>
                <input id="instrument-notes" name="instrument-notes" maxLength={2000} />
              </div>
              <div className="actions">
                <button type="submit" disabled={pending}>
                  Add instrument
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {tab === 'measurement' && (
        <>
          <h2>Measurement Book</h2>
          {mbEntries.length > 0 ? (
            <table className="data-table">
              <caption className="visually-hidden">
                Measurement Book entries for this Work
              </caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="cell--numeric">
                    Quantity
                  </th>
                  <th scope="col">Measured on</th>
                  <th scope="col">Challan</th>
                  <th scope="col">MB book</th>
                  <th scope="col">Billing</th>
                </tr>
              </thead>
              <tbody>
                {mbEntries.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{entry.itemNumber}</th>
                    <td className="cell--numeric">{entry.measuredQuantity}</td>
                    <td>{entry.measuredOn}</td>
                    <td>
                      {entry.deliveryChallanId !== null
                        ? (challanNumberById.get(entry.deliveryChallanId) ?? '—')
                        : '—'}
                    </td>
                    <td>{entry.mbBookRef ?? '—'}</td>
                    <td>
                      {entry.billId !== null ? (
                        <span className="chip chip--confirmed">billed</span>
                      ) : (
                        <span className="muted">unbilled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No measurements recorded yet.</p>
          )}
          {canRecordSiteEvidence && workItems.length > 0 && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const workItemId = formValue(data, 'mb-item');
                const measuredQuantity = formValue(data, 'mb-quantity');
                const measuredOn = formValue(data, 'mb-date');
                const deliveryChallanId = formValue(data, 'mb-challan');
                const mbBookRef = formValue(data, 'mb-book').trim();
                const remarks = formValue(data, 'mb-remarks').trim();
                void act(async () => {
                  const entry = await api.recordMbEntry(organisationId, workId, {
                    workItemId,
                    measuredQuantity,
                    measuredOn,
                    ...(deliveryChallanId.length > 0 ? { deliveryChallanId } : {}),
                    ...(mbBookRef.length > 0 ? { mbBookRef } : {}),
                    ...(remarks.length > 0 ? { remarks } : {}),
                  });
                  setMbEntries((current) => [...current, entry]);
                  form.reset();
                }, 'Measurement recorded.');
              }}
            >
              <h3>Record measurement</h3>
              <div className="field">
                <label htmlFor="mb-item">Work item</label>
                <select id="mb-item" name="mb-item" required>
                  {workItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.itemNumber} — {item.description}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="mb-quantity">Measured quantity</label>
                <input
                  id="mb-quantity"
                  name="mb-quantity"
                  inputMode="decimal"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="mb-date">Measured on</label>
                <input id="mb-date" name="mb-date" type="date" required />
              </div>
              <div className="field">
                <label htmlFor="mb-challan">Source challan (optional)</label>
                <select id="mb-challan" name="mb-challan">
                  <option value="">Not tied to a challan</option>
                  {issuedChallans.map((challan) => (
                    <option key={challan.id} value={challan.id}>
                      {challan.challanNumber ?? challan.id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="mb-book">MB book reference (optional)</label>
                <input id="mb-book" name="mb-book" maxLength={100} />
              </div>
              <div className="field">
                <label htmlFor="mb-remarks">Remarks (optional)</label>
                <input id="mb-remarks" name="mb-remarks" maxLength={1000} />
              </div>
              <div className="actions">
                <button type="submit" disabled={pending}>
                  Record measurement
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {tab === 'bills' && (
        <>
          <div className="card__header">
            <h2>Bills</h2>
          </div>
          {canIssue && (
            <p className="muted">
              Bills are prepared from a finalized stage-wise Measurement Book — use the
              Measurement Books section below.
            </p>
          )}
          {bills.length > 0 ? (
            bills.map((bill) => (
              <div key={bill.id}>
                <h3>
                  Bill #{bill.billNumber}{' '}
                  <span className={`chip chip--${bill.status}`}>{bill.status}</span>
                </h3>
                <table className="data-table">
                  <caption className="visually-hidden">
                    Lines of bill {bill.billNumber}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col">Unit</th>
                      <th scope="col" className="cell--numeric">
                        Quantity
                      </th>
                      <th scope="col" className="cell--numeric">
                        Rate
                      </th>
                      <th scope="col" className="cell--numeric">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {billLines(bill.linesSnapshot).map((line) => (
                      <tr key={`${bill.id}-${line.itemNumber}`}>
                        <th scope="row">{line.itemNumber}</th>
                        <td>{line.unitCode}</td>
                        <td className="cell--numeric">{line.quantity}</td>
                        <td className="cell--numeric">{formatRate(line.rate)}</td>
                        <td className="cell--numeric">{formatInr(line.amount)}</td>
                      </tr>
                    ))}
                    <tr>
                      <th scope="row" colSpan={4}>
                        Total
                      </th>
                      <td className="cell--numeric">
                        <strong>{formatInr(bill.totalAmount)}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
                {canIssue && bill.status !== 'paid' && (
                  <div className="actions">
                    <button
                      type="button"
                      className="button--ghost"
                      disabled={pending}
                      onClick={() => {
                        const next = bill.status === 'prepared' ? 'submitted' : 'paid';
                        void act(async () => {
                          const updated = await api.setBillStatus(
                            organisationId,
                            bill.id,
                            {
                              status: next,
                            },
                          );
                          setBills((current) =>
                            current.map((candidate) =>
                              candidate.id === updated.id ? updated : candidate,
                            ),
                          );
                        }, `Bill #${bill.billNumber} marked ${next}.`);
                      }}
                    >
                      {bill.status === 'prepared' ? 'Mark submitted' : 'Mark paid'}
                    </button>
                  </div>
                )}
              </div>
            ))
          ) : (
            <p className="muted">No bills prepared yet.</p>
          )}
        </>
      )}

      {tab === 'deliveries' && (
        <>
          <Installations
            api={api}
            organisationId={organisationId}
            workId={workId}
            canRecordEvidence={canRecordSiteEvidence}
            workItems={workItems}
            serials={serials}
            onSerialsChanged={setSerials}
          />
        </>
      )}

      {tab === 'instruments' && (
        <>
          <PacCertificates
            api={api}
            organisationId={organisationId}
            workId={workId}
            canModify={canCreateDocuments}
            workItems={workItems}
          />
        </>
      )}

      {tab === 'measurement' && (
        <>
          <MeasurementBooks
            api={api}
            organisationId={organisationId}
            workId={workId}
            canModify={canCreateDocuments}
            canIssue={canIssue}
            canCancel={canCancel}
            onBillPrepared={() => {
              void api.listBills(organisationId, workId).then(setBills);
            }}
          />
        </>
      )}

      {tab === 'deliveries' && (
        <>
          <h2>Serial trace</h2>
          {serials.length > 0 ? (
            <table className="data-table">
              <caption className="visually-hidden">
                Every serial number delivered under this Work
              </caption>
              <thead>
                <tr>
                  <th scope="col">Serial</th>
                  <th scope="col">Item</th>
                  <th scope="col">Challan</th>
                  <th scope="col">Installation</th>
                </tr>
              </thead>
              <tbody>
                {serials.map((serial) => (
                  <tr key={serial.id}>
                    <th scope="row">{serial.serialNumber}</th>
                    <td className="cell--wrap">{serial.itemDescription}</td>
                    <td>{serial.challanNumber ?? '—'}</td>
                    <td>
                      {serial.installedOn !== null ? (
                        <span className="chip chip--installed">
                          installed {serial.installedOn}
                          {typeof serial.installationLocation === 'string'
                            ? ` at ${serial.installationLocation}`
                            : ''}
                        </span>
                      ) : (
                        <span className="muted">not installed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              No serial numbers recorded yet. Serials are recorded on each issued
              challan.
            </p>
          )}
        </>
      )}

      {tab === 'timeline' && (
        <>
          <Timeline
            api={api}
            organisationId={organisationId}
            scope={{ kind: 'work', workId }}
          />
        </>
      )}

      <div className="actions">
        <button type="button" className="button--ghost" onClick={onBack}>
          Back to Works
        </button>
      </div>
    </section>
  );
}

interface AmendmentFormProps {
  readonly items: readonly WorkItem[];
  readonly schedules: WorkDetailResponse['schedules'];
  readonly pending: boolean;
  readonly onProposeChange: (body: {
    workItemId: string;
    reason: string;
    changes: {
      quantity?: string;
      rate?: string;
      description?: string;
      unit?: string;
    };
  }) => void;
  readonly onProposeAdd: (body: {
    reason: string;
    scheduleId: string;
    itemNumber: string;
    description: string;
    unitCode: string;
    quantity: string;
    rate: string;
  }) => void;
  readonly onProposeRemove: (body: { workItemId: string; reason: string }) => void;
}

/** Proposes an amendment: change an item's values, omit it, or add a new
 * item to a schedule. Every proposal needs a reason; approval authority
 * decides whether it applies immediately or waits in the queue.
 *
 * Omission files through the R7 removal path, not through a change to
 * quantity 0: the removal soft-deletes the item, keeps its number
 * reserved for the life of the Work, and refuses while any delivery,
 * installation, PAC or billing evidence names it. A quantity-0 change
 * would leave the item live, and R12 refuses zero quantities anyway. */
function AmendmentForm({
  items,
  schedules,
  pending,
  onProposeChange,
  onProposeAdd,
  onProposeRemove,
}: AmendmentFormProps) {
  const [kind, setKind] = useState<'change' | 'omit' | 'add'>('change');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const reason = formValue(data, 'amendment-reason').trim();
        if (kind === 'add') {
          onProposeAdd({
            reason,
            scheduleId: formValue(data, 'amendment-schedule'),
            itemNumber: formValue(data, 'amendment-item-number').trim(),
            description: formValue(data, 'amendment-description').trim(),
            unitCode: formValue(data, 'amendment-unit').trim(),
            quantity: formValue(data, 'amendment-quantity').trim(),
            rate: formValue(data, 'amendment-rate').trim(),
          });
          return;
        }
        const workItemId = formValue(data, 'amendment-item');
        if (kind === 'omit') {
          onProposeRemove({ workItemId, reason });
          return;
        }
        const quantity = formValue(data, 'amendment-quantity').trim();
        const rate = formValue(data, 'amendment-rate').trim();
        const description = formValue(data, 'amendment-description').trim();
        const unit = formValue(data, 'amendment-unit').trim();
        onProposeChange({
          workItemId,
          reason,
          changes: {
            ...(quantity.length > 0 ? { quantity } : {}),
            ...(rate.length > 0 ? { rate } : {}),
            ...(description.length > 0 ? { description } : {}),
            ...(unit.length > 0 ? { unit } : {}),
          },
        });
      }}
    >
      <h3>Propose an amendment</h3>
      <div className="field">
        <label htmlFor="amendment-kind">Amendment</label>
        <select
          id="amendment-kind"
          name="amendment-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as 'change' | 'omit' | 'add');
          }}
        >
          <option value="change">Change an item</option>
          <option value="omit">Omit an item</option>
          <option value="add">Add a new item</option>
        </select>
      </div>
      {kind !== 'add' && (
        <div className="field">
          <label htmlFor="amendment-item">Item to amend</label>
          <select id="amendment-item" name="amendment-item" required>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.itemNumber} — {item.description}
              </option>
            ))}
          </select>
        </div>
      )}
      {kind === 'add' && (
        <>
          <div className="field">
            <label htmlFor="amendment-schedule">Schedule</label>
            <select id="amendment-schedule" name="amendment-schedule" required>
              {schedules.map((schedule) => (
                <option key={schedule.id} value={schedule.id}>
                  {schedule.scheduleCode} — {schedule.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="amendment-item-number">Item number</label>
            <input
              id="amendment-item-number"
              name="amendment-item-number"
              required
              maxLength={100}
            />
          </div>
        </>
      )}
      {kind !== 'omit' && (
        <>
          <div className="field">
            <label htmlFor="amendment-quantity">
              {kind === 'add' ? 'Quantity' : 'New quantity (optional)'}
            </label>
            <input
              id="amendment-quantity"
              name="amendment-quantity"
              inputMode="decimal"
              required={kind === 'add'}
            />
          </div>
          <div className="field">
            <label htmlFor="amendment-rate">
              {kind === 'add' ? 'Rate (₹)' : 'New rate (₹, optional)'}
            </label>
            <input
              id="amendment-rate"
              name="amendment-rate"
              inputMode="decimal"
              required={kind === 'add'}
            />
          </div>
          <div className="field">
            <label htmlFor="amendment-description">
              {kind === 'add' ? 'Description' : 'New description (optional)'}
            </label>
            <input
              id="amendment-description"
              name="amendment-description"
              required={kind === 'add'}
              maxLength={4000}
            />
          </div>
          <div className="field">
            <label htmlFor="amendment-unit">
              {kind === 'add' ? 'Unit' : 'New unit (optional)'}
            </label>
            <input
              id="amendment-unit"
              name="amendment-unit"
              required={kind === 'add'}
              maxLength={20}
            />
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="amendment-reason">Reason</label>
        <input
          id="amendment-reason"
          name="amendment-reason"
          required
          minLength={3}
          maxLength={2000}
        />
      </div>
      <div className="actions">
        <button type="submit" disabled={pending}>
          Submit amendment
        </button>
      </div>
    </form>
  );
}

interface InstrumentStatusEditorProps {
  readonly instrument: Instrument;
  readonly pending: boolean;
  readonly onApply: (status: Exclude<InstrumentStatus, 'active'>) => void;
}

/** Forward-only transitions out of 'active'; terminal statuses show no
 * controls (the server refuses them with INSTRUMENT_STATUS_TERMINAL). */
function InstrumentStatusEditor({
  instrument,
  pending,
  onApply,
}: InstrumentStatusEditorProps) {
  const [status, setStatus] = useState<Exclude<InstrumentStatus, 'active'>>('released');
  return (
    <span className="actions">
      <label className="visually-hidden" htmlFor={`instrument-status-${instrument.id}`}>
        New status for {instrument.reference}
      </label>
      <select
        id={`instrument-status-${instrument.id}`}
        value={status}
        onChange={(event) => {
          setStatus(event.target.value as Exclude<InstrumentStatus, 'active'>);
        }}
      >
        <option value="released">released</option>
        <option value="expired">expired</option>
        <option value="closed">closed</option>
      </select>
      <button
        type="button"
        className="button--ghost"
        disabled={pending}
        onClick={() => {
          onApply(status);
        }}
      >
        Apply
      </button>
    </span>
  );
}
