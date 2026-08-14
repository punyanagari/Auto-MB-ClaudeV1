import type { ClaimedJob, JobKind, Sql, TransactionSql } from '@auto-mb/db';
import {
  TenantBindRefusedError,
  claimNextJob,
  completeJob,
  failJob,
  refuseJobBind,
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
): Promise<'done' | 'retry' | 'failed' | 'refused_bind'> {
  const handler = handlers[job.kind];
  if (handler === undefined) {
    // A kind the database admits and this worker does not implement. That
    // is a deployment skew — an older worker against a newer schema — and
    // it must not consume the retry budget silently, so it is logged as an
    // error and retried: the job is probably fine, this process is not.
    log.error({ jobId: job.id, kind: job.kind, message: 'no handler for job kind' });
    await failJob(sql, job, `no handler for job kind ${job.kind}`, nextRetry(job));
    return 'retry';
  }

  try {
    const outcome = await handler({
      job,
      log,
      tenant: (work) => withJobAuthority(sql, job, work),
    });
    const held = await completeJob(sql, job, outcome);
    if (!held) {
      // The lease lapsed while the work ran and somebody else owns the job
      // now. Normal under a lease, not a fault — but worth saying, because
      // a steady stream of these means the lease is too short.
      log.info({
        jobId: job.id,
        kind: job.kind,
        message: 'claim lost before completion',
      });
    }
    return 'done';
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
  let consecutiveClaimFailures = 0;

  while (!options.signal.aborted) {
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

    const outcome = await runJob(sql, job, options.handlers, options.log);
    options.log.info({ jobId: job.id, kind: job.kind, outcome });
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}
