import { useCallback, useEffect, useState } from 'react';
import type {
  Entitlement,
  JobRun,
  JobSchedule,
  ScheduleCadence,
  ScheduledJobKind,
} from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formatTimestamp } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useAction, useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * Platform: which modules this organisation may use, and which recurring
 * statutory checks run (migration 0096).
 *
 * Owner-only, and in Settings beside the signing kiosk for the same
 * reason that panel is there: these are the organisation's posture rather
 * than its work, and deciding them is a different act by a different
 * person from doing the work they govern.
 *
 * No mock screen; see `docs/UX.md` § 20. Built from the mock's own Card,
 * status chip, dense data table and button anatomy — the same grammar
 * `views/SigningKioskSettings.tsx` and every register use.
 *
 * ## What an operator is actually being asked
 *
 * Two questions with different shapes, which is why they are two panels
 * rather than one list of switches.
 *
 * An ENTITLEMENT answers "may this organisation use this module at all",
 * and its honest default is whatever the product ships — so the row shows
 * the effective value beside the shipped one, says plainly when nobody
 * has ever chosen, and carries the note that says WHY, which is the fact
 * that outlives everybody who remembers the decision.
 *
 * A SCHEDULE answers "should this check run, and how often", and it
 * carries one fact nothing else in the product does: the member whose
 * authority its jobs borrow. ADR-0011 gives the queue no service
 * identity, so when that member leaves the scheduler pauses the check
 * rather than running on a departed person's authority — and the remedy
 * is a control on the row, not a paragraph telling the operator to go and
 * find one.
 */

interface PlatformSettingsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly isOwner: boolean;
  /** The entitlements authority. Owner-only in effect — every route needs
   * both — so the panel needs both to render. */
  readonly canManageEntitlements: boolean;
  /** So the screen can say "you" where every other register does, rather
   * than printing the reader their own opaque account id. */
  readonly currentUserId: string;
}

/** The queue's states, in the product's own chip vocabulary.
 *
 * `refused_bind` is WARNING and not destructive, deliberately: it is not
 * a run that broke, it is a run the database declined to start because
 * the member behind it has gone, and it has a one-click remedy on the row
 * above. `docs/DESIGN.md` § Status badge semantics gives the destructive
 * family to cancelled/rejected/declined; a to-do with a remedy is the
 * warning family's own meaning. */
const RUN_CHIP: Record<JobRun['state'], string> = {
  queued: 'pending',
  claimed: 'claimed',
  done: 'completed',
  failed: 'failed',
  refused_bind: 'review',
};

const CADENCES: readonly ScheduleCadence[] = ['daily', 'weekly', 'monthly'];

/** The reader's own id reads as "you" — `views/Approvals.tsx` sets the
 * precedent, and no screen in this product resolves an account id to a
 * name because nothing puts a name on the wire. */
function actorLabel(userId: string | null, currentUserId: string): string {
  if (userId === null) return '—';
  return userId === currentUserId ? 'you' : userId;
}

export function PlatformSettings({
  api,
  organisationId,
  isOwner,
  canManageEntitlements,
  currentUserId,
}: PlatformSettingsProps) {
  const visible = isOwner && canManageEntitlements;
  const [entitlements, setEntitlements] = useState<readonly Entitlement[] | null>(null);
  const [schedules, setSchedules] = useState<readonly JobSchedule[] | null>(null);
  const [runs, setRuns] = useState<readonly JobRun[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, reload] = useReload();
  const { pending, notice, actionError, act } = useAction();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setEntitlements(null);
    setSchedules(null);
    setLoadError(null);
    Promise.all([
      api.listEntitlements(organisationId),
      api.listJobSchedules(organisationId),
    ])
      .then(([flags, jobs]) => {
        if (cancelled) return;
        setEntitlements(flags.entitlements);
        setSchedules(jobs.schedules);
        setRuns(jobs.runs);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The platform settings could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, visible, loadVersion]);

  const toggleFlag = useCallback(
    (flag: Entitlement) =>
      act(
        async () => {
          // The note is NOT sent, and that is what keeps it: the contract
          // treats an absent note as "leave what is there". Sending
          // `note: null` here would erase "waiting on NIC re-certification"
          // the first time anybody flipped the switch.
          await api.setEntitlement(organisationId, flag.key, {
            enabled: !flag.enabled,
          });
          reload();
        },
        `${flag.label} is now ${flag.enabled ? 'switched off' : 'switched on'}.`,
      ),
    [act, api, organisationId, reload],
  );

  const saveSchedule = useCallback(
    (
      kind: ScheduledJobKind,
      body: { enabled?: boolean; cadence?: ScheduleCadence; horizonDays?: number },
      done: string,
    ) =>
      act(async () => {
        await api.setJobSchedule(organisationId, kind, body);
        reload();
      }, done),
    [act, api, organisationId, reload],
  );

  if (!visible) return null;

  if (loadError !== null && entitlements === null) {
    return (
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Platform</h2>
        </CardHeader>
        <ErrorState onRetry={reload} retryLabel="Retry the platform settings">
          {loadError}
        </ErrorState>
      </Card>
    );
  }

  if (entitlements === null || schedules === null) {
    return (
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Platform</h2>
        </CardHeader>
        <LoadingState label="the platform settings" rows={3} columns={3} />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Platform</h2>
      </CardHeader>

      <h3 className="mt-2 text-sm font-medium">Modules</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Whether this organisation may use a module at all. This is not a permission: a
        member still needs their own authority for anything a module does.
      </p>
      <ul className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
        {entitlements.map((flag) => (
          <li
            key={flag.key}
            className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
          >
            <div className="flex max-w-[36rem] flex-col gap-1">
              <span className="text-sm font-medium">{flag.label}</span>
              <span className="text-xs text-muted-foreground">{flag.description}</span>
              {flag.note !== null && (
                <span className="text-xs text-foreground">Note: {flag.note}</span>
              )}
              <span className="text-xs text-muted-foreground tabular-nums">
                {flag.configured && flag.updatedAt !== null
                  ? `set by ${actorLabel(flag.setBy, currentUserId)} on ${formatTimestamp(flag.updatedAt)}`
                  : `never configured — using the shipped default (${flag.defaultEnabled ? 'on' : 'off'})`}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <StatusChip status={flag.enabled ? 'active' : 'disabled'} />
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => {
                  void toggleFlag(flag);
                }}
              >
                {flag.enabled ? 'Switch off' : 'Switch on'}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="mt-6 text-sm font-medium">Recurring checks</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Each check runs under the authority of the member who last adopted it. If that
        member leaves the organisation the check pauses itself rather than running on
        their behalf; use Run as me to put your own membership behind it. A check
        switched back on runs once straight away, then on its cadence.
      </p>
      {schedules.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            action={{
              label: 'Start the guarantee expiry check',
              onClick: () => {
                void saveSchedule(
                  'instrument_expiry_review',
                  { enabled: true },
                  'The guarantee and certificate expiry check is now running.',
                );
              },
            }}
          >
            No recurring check is configured, so nothing reviews guarantee and
            certificate expiry on a schedule.
          </EmptyState>
        </div>
      ) : (
        <ul className="m-0 mt-3 flex list-none flex-col gap-4 p-0">
          {schedules.map((schedule) => (
            <li
              key={schedule.id}
              className="flex flex-col gap-2 border-b border-border pb-4 last:border-0 last:pb-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div className="flex max-w-[36rem] flex-col gap-1">
                  <span className="text-sm font-medium">{schedule.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {schedule.description}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    next run {formatTimestamp(schedule.nextRunAt)} ·{' '}
                    {schedule.lastEnqueuedAt === null
                      ? 'never run'
                      : `last enqueued ${formatTimestamp(schedule.lastEnqueuedAt)}`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    runs as {actorLabel(schedule.authorityUserId, currentUserId)}
                  </span>
                  {schedule.disabledReason !== null && (
                    <span className="text-xs text-foreground">
                      Paused automatically: {schedule.disabledReason}. Use Run as me to
                      resume it under your own membership.
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {/* Two different kinds of "off", and they must not read
                      the same. A check the SCHEDULER stopped is work to
                      do, which is `paused` — the same reading 0092 gives
                      a throttled template. One an operator stopped is
                      inert, which is `disabled`: unmapped and neutral BY
                      DECISION, recorded beside `paused` in ui/chip.tsx. */}
                  <StatusChip
                    status={
                      schedule.enabled
                        ? 'active'
                        : schedule.disabledReason !== null
                          ? 'paused'
                          : 'disabled'
                    }
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      void saveSchedule(
                        schedule.kind,
                        { enabled: true },
                        `${schedule.label} now runs under your membership.`,
                      );
                    }}
                  >
                    Run as me
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      void saveSchedule(
                        schedule.kind,
                        { enabled: !schedule.enabled },
                        `${schedule.label} is now ${schedule.enabled ? 'switched off' : 'running'}.`,
                      );
                    }}
                  >
                    {schedule.enabled ? 'Switch off' : 'Switch on'}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-4">
                <label className="field">
                  <span>How often</span>
                  <select
                    value={schedule.cadence}
                    disabled={pending}
                    onChange={(event) => {
                      void saveSchedule(
                        schedule.kind,
                        { cadence: event.target.value as ScheduleCadence },
                        `${schedule.label} now runs ${event.target.value}.`,
                      );
                    }}
                  >
                    {CADENCES.map((cadence) => (
                      <option key={cadence} value={cadence}>
                        {cadence}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Days ahead</span>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    defaultValue={schedule.horizonDays}
                    disabled={pending}
                    className="tabular-nums"
                    onBlur={(event) => {
                      const days = Number(event.target.value);
                      if (!Number.isInteger(days) || days < 1 || days > 365) return;
                      if (days === schedule.horizonDays) return;
                      void saveSchedule(
                        schedule.kind,
                        { horizonDays: days },
                        `${schedule.label} now looks ${String(days)} days ahead.`,
                      );
                    }}
                  />
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-6 text-sm font-medium">Run history</h3>
      {runs.length === 0 ? (
        <div className="mt-3">
          <EmptyState>
            No check has run yet. The worker picks up a due schedule within a minute of
            it falling due.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-3">
          <DataTable>
            <caption className="sr-only">
              Recent runs of this organisation&rsquo;s recurring checks
            </caption>
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">Started</th>
                <th scope="col">State</th>
                <th scope="col" className={numericCell}>
                  Found
                </th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    {run.kind === 'instrument_expiry_review' ? 'Expiry' : run.kind}
                  </td>
                  <td className="tabular-nums">{formatTimestamp(run.createdAt)}</td>
                  <td>
                    <StatusChip status={RUN_CHIP[run.state]} />
                  </td>
                  <td className={numericCell}>
                    {typeof run.outcome?.reviewed === 'number'
                      ? String(run.outcome.reviewed)
                      : '—'}
                  </td>
                  <td className={wrapCell}>
                    {run.state === 'refused_bind'
                      ? 'The member this check ran as is no longer in the organisation. Use Run as me above to run it as yourself.'
                      : (run.lastError ?? '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      )}

      {notice !== null && (
        <p className="alert success" role="status">
          {notice}
        </p>
      )}
      {actionError !== null && (
        <p className="alert error" role="alert">
          {actionError}
        </p>
      )}
    </Card>
  );
}
