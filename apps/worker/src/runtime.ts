import { setTimeout as delay } from 'node:timers/promises';
import type { ClaimedJob, JobKind, Sql, TransactionSql } from '@auto-mb/db';
import {
  TenantBindRefusedError,
  claimNextJob,
  completeJob,
  failJob,
  refuseJobBind,
  releaseJob,
  withJobAuthority,
} from '@auto-mb/db';

/**
 * The worker's execution model, in one file, because it is the part
 * ADR-0011 actually decided and it should be readable in one sitting.
 */

export interface JobContext {
  /** The job's own row, including the ids the work runs under. */
  readonly job: ClaimedJob;
  readonly log: JobLogger;
  /**
   * Opens a transaction bound to the job's recorded `(organisation, user)`.
   *
   * A closure rather than a ready-made transaction, for the same reason
   * `tenant-route.ts` hands request handlers a closure: these jobs run slow
   * external work — pdftotext takes tens of seconds — and a transaction
   * held open across it would pin a pooled connection for the duration.
   * So a handler reads what it needs, closes, does the slow part, and
   * opens again to write.
   *
   * Every call re-binds, so every call re-proves the membership. A job
   * whose user is revoked midway through gets the refusal on the writing
   * transaction rather than committing on stale authority.
   */
  readonly tenant: <T>(work: (tx: TransactionSql) => Promise<T>) => Promise<T>;
}

export type JobHandler = (
  context: JobContext,
) => Promise<Record<string, unknown> | null>;

export type JobHandlers = Readonly<Record<JobKind, JobHandler>>;

/**
 * What became of one claim.
 *
 * `released` and `lost` are separate from the rest on purpose: neither is
 * a job that ran. `released` is this worker handing back a kind it cannot
 * execute, without spending an attempt; `lost` is this worker finishing
 * work whose lease had already passed to somebody else. Folding either
 * into `done` would make the worker report successes it did not have.
 */
export type JobOutcome =
  'done' | 'lost' | 'released' | 'retry' | 'failed' | 'refused_bind';

export interface JobLogger {
  info(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

/**
 * A job whose failure is permanent — bad input, a missing referent, a
 * document the organisation has since discarded. Retrying would burn the
 * budget re-discovering the same answer, so the handler says so and the
 * job goes terminal on the first attempt.
 */
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

/** Exponential backoff, capped. Attempt 1 waits ~10s, attempt 5 ~160s. */
export function retryDelayMs(attempts: number): number {
  const base = 10_000 * 2 ** Math.max(0, attempts - 1);
  return Math.min(base, 300_000);
}

/**
 * Runs one job to a terminal or retryable outcome and reports which.
 *
 * The ordering here is the security-relevant part and it is deliberate:
 *
 *   1. `withJobAuthority` opens a tenant transaction with the job's
 *      recorded `(organisation, user)`. `bind_tenant` re-proves the
 *      membership right there — the same proof, in the same place, as any
 *      request handler.
 *   2. ONLY THEN does the handler run, and it reads the payload's referent
 *      through RLS like everything else. A job whose bind was refused
 *      never reaches step 2, so nothing about the tenant's data is
 *      touched, read, or logged on behalf of a user who has lost their
 *      membership (ADR-0011 guard (c)).
 *
 * A refused bind is terminal. Everything else retries until the budget the
 * database holds runs out, except a `PermanentJobError`, which the handler
 * raises when it knows a retry is pointless.
 */
export async function runJob(
  sql: Sql,
  job: ClaimedJob,
  handlers: JobHandlers,
  log: JobLogger,
): Promise<JobOutcome> {
  const handler = handlers[job.kind];
  if (handler === undefined) {
    // A kind the database admits and this worker does not implement: a
    // deployment skew, an older worker against a newer schema. The job is
    // probably fine and this process is not, so it is handed BACK rather
    // than failed — `releaseJob` returns it to the queue and gives back
    // the attempt the claim consumed.
    //
    // That distinction is the whole point. Failing with a retry still
    // spends an attempt, so five such claims during a rolling deploy —
    // about two and a half minutes — would terminally kill a job the new
    // workers would have run correctly.
    log.error({ jobId: job.id, kind: job.kind, message: 'no handler for job kind' });
    await releaseJob(sql, job, `no handler for job kind ${job.kind}`);
    return 'released';
  }

  let outcome: Record<string, unknown> | null;
  try {
    outcome = await handler({
      job,
      log,
      tenant: (work) => withJobAuthority(sql, job, work),
    });
  } catch (error) {
    if (error instanceof TenantBindRefusedError) {
      // ADR-0011: work commissioned by a user who has since lost the
      // tenancy does not run on their authority, and the queue says so in
      // its own state rather than burying it in an exhausted retry count.
      log.error({
        jobId: job.id,
        kind: job.kind,
        organisationId: job.organisationId,
        message: 'tenant bind refused; job parked as refused_bind',
      });
      await refuseJobBind(sql, job, error.message);
      return 'refused_bind';
    }

    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PermanentJobError) {
      log.error({ jobId: job.id, kind: job.kind, message, permanent: true });
      await failJob(sql, job, message);
      return 'failed';
    }

    log.error({ jobId: job.id, kind: job.kind, message, attempts: job.attempts });
    await failJob(sql, job, message, nextRetry(job));
    return job.attempts >= job.maxAttempts ? 'failed' : 'retry';
  }

  // Recording the success sits OUTSIDE the handler's try, deliberately.
  //
  // Inside it, a `complete_job` that failed on a dropped connection was
  // caught by the same `catch` as a job that broke, and answered by
  // calling `fail_job` — reporting the work as failed when it had in fact
  // committed. Out here, that failure propagates to the loop, which backs
  // off; the claim's lease then expires and the job runs again.
  //
  // Running again is safe because the handlers are resumable: the LOA
  // intake job re-claims its own `processing` document and every write it
  // makes is guarded on state it can only satisfy once. So the honest
  // outcome of "the work committed but I could not say so" is to say
  // nothing and let the job be redone, rather than to record the opposite
  // of what happened.
  const held = await completeJob(sql, job, outcome);
  if (!held) {
    // The lease lapsed while the work ran and somebody else owns the job
    // now. Normal under a lease, not a fault — but this is not `done`
    // either, because this worker completed nothing: the row belongs to
    // another claimant. A steady stream of these means the lease is too
    // short for the workload.
    log.info({
      jobId: job.id,
      kind: job.kind,
      message: 'claim lost before completion; another worker owns this job',
    });
    return 'lost';
  }
  return 'done';
}

function nextRetry(job: ClaimedJob): Date {
  return new Date(Date.now() + retryDelayMs(job.attempts));
}

export interface WorkerLoopOptions {
  readonly claimedBy: string;
  readonly leaseSeconds: number;
  readonly idlePollMs: number;
  readonly signal: AbortSignal;
  readonly handlers: JobHandlers;
  readonly log: JobLogger;
  /** Injected so tests can drive the loop without real time passing. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Periodic work that is not a job (migration 0096): enqueueing recurring
   * checks that have come due, and reclaiming expired export artefacts.
   *
   * A TICK ON THIS LOOP RATHER THAN A SCHEDULER, and the reason is
   * operational rather than aesthetic. pg_cron needs an extension the
   * managed-database story does not promise, a host crontab needs a second
   * deployment artefact with its own credential and its own monitoring,
   * and a timer inside this process needs leader election the moment there
   * are two workers. All three buy a precision these daily and monthly
   * checks do not want, at the price of a component that can fail
   * silently. This cannot: if the worker is down the queue is visibly not
   * draining, which is the first thing docs/RUNBOOK.md § 7b tells an
   * operator to look at.
   *
   * A tick that throws is logged and the loop carries on — a scheduler
   * that killed the worker would take the job queue down with it.
   */
  readonly tick?: () => Promise<void>;
  /** How rarely the tick may run. Not the poll interval: an idle worker
   * polls every second, and running two cross-tenant sweeps that often
   * would be a steady background load for checks whose useful resolution
   * is hours. */
  readonly tickIntervalMs?: number;
  /** Injected so tests can drive the tick without real time passing. */
  readonly now?: () => number;
}

/**
 * Claim, run, repeat, until the signal aborts.
 *
 * Draining rather than sleeping between jobs: after a successful claim the
 * loop immediately asks again, so a backlog is worked through at full rate
 * and the poll interval only governs an idle queue. A claim that raises —
 * the database went away — backs off like a failed job rather than
 * spinning on a dead connection.
 */
export async function runWorkerLoop(
  sql: Sql,
  options: WorkerLoopOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const tickIntervalMs = options.tickIntervalMs ?? 60_000;
  let consecutiveClaimFailures = 0;
  let consecutiveOutcomeFailures = 0;
  // Zero, so the first tick happens at start-up rather than a minute in: a
  // worker that has just been restarted after being down is exactly when a
  // due schedule is most likely to be waiting.
  let lastTickAt = 0;

  while (!options.signal.aborted) {
    // BEFORE the claim, so a schedule that comes due is picked up by the
    // same iteration that then claims its job, instead of waiting for the
    // next poll.
    if (options.tick !== undefined && now() - lastTickAt >= tickIntervalMs) {
      lastTickAt = now();
      try {
        await options.tick();
      } catch (error) {
        options.log.error({
          message: 'the scheduler tick failed; it will be retried',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let job: ClaimedJob | undefined;
    try {
      job = await claimNextJob(sql, options.claimedBy, options.leaseSeconds);
      consecutiveClaimFailures = 0;
    } catch (error) {
      consecutiveClaimFailures += 1;
      options.log.error({
        message: 'could not claim a job',
        error: error instanceof Error ? error.message : String(error),
        consecutiveClaimFailures,
      });
      await sleep(retryDelayMs(consecutiveClaimFailures), options.signal);
      continue;
    }

    if (job === undefined) {
      await sleep(options.idlePollMs, options.signal);
      continue;
    }

    // `runJob` reports outcomes rather than raising for job failures, but
    // it is not exception-free: its LAST act on every path is a call into
    // the database — complete_job, fail_job, refuseJobBind, releaseJob —
    // and a connection that dies in that window throws out of it.
    //
    // Unhandled, that rejection escapes the loop and ends the process. The
    // orchestrator restarts it, the restarted worker claims the same job,
    // and if the database is still unwell it dies again — a crash loop
    // where a backoff belongs, on the one class of fault most likely to be
    // transient. So the loop treats it exactly like a failed claim: log,
    // back off, carry on. The job itself is safe either way, because its
    // lease expires and it returns to the queue.
    try {
      const outcome = await runJob(sql, job, options.handlers, options.log);
      options.log.info({ jobId: job.id, kind: job.kind, outcome });
      consecutiveOutcomeFailures = 0;
    } catch (error) {
      // Counted separately from claim failures, and NOT reset by a
      // successful claim. A database that accepts claims and then drops
      // the connection on every completion would otherwise never escalate
      // past the first delay, because each iteration would clear the
      // counter it had just incremented.
      consecutiveOutcomeFailures += 1;
      options.log.error({
        jobId: job.id,
        kind: job.kind,
        message:
          'the job outcome could not be recorded; it will be retried ' +
          'when its lease expires',
        error: error instanceof Error ? error.message : String(error),
        consecutiveOutcomeFailures,
      });
      await sleep(retryDelayMs(consecutiveOutcomeFailures), options.signal);
    }
  }
}

/** Abort resolves rather than rejects: a shutdown mid-wait is the loop
 * ending, not an error for it to report. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal }).catch(() => undefined);
}

/**
 * Runs every currently runnable job to completion and reports how many.
 *
 * For tests and for operators draining a queue by hand. The product's own
 * worker uses `runWorkerLoop`; this is the same claim/run/report sequence
 * without the waiting, so an integration test can assert the state a job
 * produces without sleeping or racing a background process.
 *
 * `limit` is a stop, not a target: a handler that re-enqueues its own kind
 * would otherwise spin here for ever.
 */
export async function drainJobs(
  sql: Sql,
  options: {
    readonly handlers: JobHandlers;
    readonly log: JobLogger;
    readonly limit?: number;
  },
): Promise<number> {
  const limit = options.limit ?? 100;
  let ran = 0;
  while (ran < limit) {
    const job = await claimNextJob(sql, 'drain', 300);
    if (job === undefined) return ran;
    await runJob(sql, job, options.handlers, options.log);
    ran += 1;
  }
  return ran;
}
