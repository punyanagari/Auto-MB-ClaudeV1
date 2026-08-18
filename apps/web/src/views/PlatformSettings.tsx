import { useCallback, useEffect, useState } from 'react';
import type {
  Entitlement,
  EntitlementFlagKey,
  JobRun,
  JobSchedule,
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
 * the effective value beside the shipped one, and says plainly when
 * nobody has ever chosen.
 *
 * A SCHEDULE answers "should this check run, and how often", and it
 * carries one fact nothing else in the product does: the member whose
 * authority its jobs borrow. ADR-0011 gives the queue no service
 * identity, so a schedule enabled by somebody who has since left parks
 * its next run rather than running on their authority — and the remedy is
 * for a current member to save the schedule again. The run history is
 * where that is visible, so it is on the same panel rather than behind a
 * link.
 */

interface PlatformSettingsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly isOwner: boolean;
  /** The entitlements authority. Owner-only in effect — every route needs
   * both — so the panel needs both to render. */
  readonly canManageEntitlements: boolean;
}

/** The queue's states, in the product's own chip vocabulary. `done` is
 * neutral rather than success: a check that ran is not a step that
 * closed, and painting every completed sweep green would make the one
 * that found something invisible. */
const RUN_CHIP: Record<JobRun['state'], string> = {
  queued: 'pending',
  claimed: 'recording',
  done: 'completed',
  failed: 'rejected',
  refused_bind: 'rejected',
};

export function PlatformSettings({
  api,
  organisationId,
  isOwner,
  canManageEntitlements,
}: PlatformSettingsProps) {
  const visible = isOwner && canManageEntitlements;
  const [entitlements, setEntitlements] = useState<readonly Entitlement[] | null>(
    null,
  );
  const [schedules, setSchedules] = useState<readonly JobSchedule[] | null>(null);
  const [runs, setRuns] = useState<readonly JobRun[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, reload] = useReload();
  const { pending, actionError, act } = useAction();

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
      act(async () => {
        await api.setEntitlement(organisationId, flag.key as EntitlementFlagKey, {
          enabled: !flag.enabled,
        });
        reload();
      }, `${flag.label} is now ${flag.enabled ? 'switched off' : 'switched on'}.`),
    [act, api, organisationId, reload],
  );

  const saveSchedule = useCallback(
    (kind: ScheduledJobKind, enabled: boolean, label: string) =>
      act(async () => {
        await api.setJobSchedule(organisationId, kind, { enabled });
        reload();
      }, `${label} is now ${enabled ? 'running' : 'switched off'}.`),
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
        Whether this organisation may use a module at all. This is not a
        permission: a member still needs their own authority for anything a
        module does.
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
              <span className="text-xs text-muted-foreground tabular-nums">
                {flag.configured && flag.updatedAt !== null
                  ? `set by ${flag.setBy ?? 'an owner'} on ${formatTimestamp(flag.updatedAt)}`
                  : `never configured — using the shipped default (${flag.defaultEnabled ? 'on' : 'off'})`}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <StatusChip status={flag.enabled ? 'active' : 'cancelled'} />
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
        Each check runs under the authority of the member who last saved it. If
        that member leaves the organisation the run is refused rather than
        carried out on their behalf — save the check again to put your own
        membership behind it.
      </p>
      {schedules.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            action={{
              label: 'Start the guarantee expiry check',
              onClick: () => {
                void saveSchedule(
                  'instrument_expiry_review',
                  true,
                  'The guarantee and certificate expiry check',
                );
              },
            }}
          >
            No recurring check is configured, so nothing reviews guarantee and
            certificate expiry on a schedule.
          </EmptyState>
        </div>
      ) : (
        <ul className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
          {schedules.map((schedule) => (
            <li
              key={schedule.id}
              className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
            >
              <div className="flex max-w-[36rem] flex-col gap-1">
                <span className="text-sm font-medium">{schedule.label}</span>
                <span className="text-xs text-muted-foreground">
                  {schedule.description}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {schedule.cadence}, {schedule.horizonDays} days ahead · next run{' '}
                  {formatTimestamp(schedule.nextRunAt)} ·{' '}
                  {schedule.lastRunAt === null
                    ? 'never run'
                    : `last run ${formatTimestamp(schedule.lastRunAt)}`}
                </span>
                <span className="text-xs text-muted-foreground">
                  runs as {schedule.authorityUserId}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <StatusChip status={schedule.enabled ? 'active' : 'on-hold'} />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    void saveSchedule(
                      schedule.kind,
                      !schedule.enabled,
                      schedule.label,
                    );
                  }}
                >
                  {schedule.enabled ? 'Switch off' : 'Switch on'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-6 text-sm font-medium">Run history</h3>
      {runs.length === 0 ? (
        <div className="mt-3">
          <EmptyState>
            No check has run yet. The worker picks up a due schedule within a
            minute of it falling due.
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
                  <td>{run.kind === 'instrument_expiry_review' ? 'Expiry' : run.kind}</td>
                  <td className={numericCell}>{formatTimestamp(run.createdAt)}</td>
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
                      ? 'The member this check runs as is no longer in the organisation. Save the check again to run it as yourself.'
                      : (run.lastError ?? '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      )}

      {actionError !== null && (
        <p className="alert error" role="alert">
          {actionError}
        </p>
      )}
    </Card>
  );
}
