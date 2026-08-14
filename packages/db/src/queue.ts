import type { Sql, TransactionSql } from 'postgres';
import { jsonb } from './json.js';
import { TenantBindRefusedError, withTenant } from './tenant.js';

/**
 * The application's entire access to the job queue (migration 0072,
 * ADR-0011).
 *
 * `worker_jobs` carries no grant to the application role at all, so every
 * function here is a call into a SECURITY DEFINER function rather than a
 * query. That is deliberate and it is the reason this module is thin:
 * there is nothing to compose, and any statement added here that touched
 * the table directly would simply fail with `permission denied`, which is
 * the intended shape of the boundary.
 */

/** The job kinds this queue knows. A kind added here must also be added
 * to the CHECK constraint in migration 0072 — the database is the
 * authority, and an unknown kind is refused there rather than accepted
 * and then never dispatched. */
export const JOB_KINDS = ['loa_document_intake'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Every state a queue row can hold. `refused_bind` is terminal by
 * ADR-0011: the commissioning user's membership did not survive to
 * execution, and no retry could change that. */
export const JOB_STATES = [
  'queued',
  'claimed',
  'done',
  'failed',
  'refused_bind',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** References, never content. The queue row names what to work on; the
 * bytes and every result stay behind tenant RLS. */
export type JobPayloadRef = Record<string, unknown>;

export interface ClaimedJob {
  readonly id: string;
  readonly organisationId: string;
  readonly userId: string;
  readonly kind: JobKind;
  readonly payloadRef: JobPayloadRef;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Handed over exactly once by the claim, and required back by
   * `completeJob`/`failJob`. Never logged. */
  readonly claimToken: string;
}

interface ClaimRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly user_id: string;
  readonly kind: JobKind;
  readonly payload_ref: JobPayloadRef;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly claim_token: string;
}

/**
 * Enqueues a job from INSIDE the caller's already-bound tenant
 * transaction.
 *
 * The signature is the point: it takes a `TransactionSql`, not a pool, so
 * it cannot be called anywhere but inside a transaction, and it takes no
 * organisation and no user, so it cannot name a tenant. Migration 0072's
 * `enqueue_job` reads both from the binding `bind_tenant` already proved,
 * which is what makes a cross-tenant enqueue unexpressible rather than
 * merely guarded (ADR-0011 §2).
 *
 * Enqueuing inside the request's transaction also means the job and the
 * row it describes commit together: a job never references a document
 * whose insert rolled back, and a committed document never lacks its job.
 */
export async function enqueueJob(
  tx: TransactionSql,
  kind: JobKind,
  payloadRef: JobPayloadRef,
): Promise<string> {
  const [row] = await tx<{ enqueue_job: string }[]>`
    select app_private.enqueue_job(${kind}, ${jsonb(tx, payloadRef)})
  `;
  if (row === undefined) throw new Error('enqueue_job returned no id');
  return row.enqueue_job;
}

/**
 * Takes the next runnable job, or nothing.
 *
 * Runs outside any tenant binding, and must: the worker has to find the
 * job before it can know whose authority to run it under. This is the one
 * cross-tenant read in the product, which is exactly why it lives behind
 * a definer function on a table the application role cannot see.
 *
 * The lease is what makes a crashed worker recoverable — see
 * `claim_next_job` in migration 0072 — so `leaseSeconds` should exceed
 * the slowest plausible run of the slowest job kind. Too short and a
 * healthy worker's job is stolen mid-flight; the losing worker then finds
 * `completeJob` returns false and says so rather than corrupting anything.
 */
export async function claimNextJob(
  sql: Sql,
  claimedBy: string,
  leaseSeconds: number,
): Promise<ClaimedJob | undefined> {
  const rows = await sql<ClaimRow[]>`
    select * from app_private.claim_next_job(${claimedBy}, ${leaseSeconds})
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    organisationId: row.organisation_id,
    userId: row.user_id,
    kind: row.kind,
    payloadRef: row.payload_ref,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    claimToken: row.claim_token,
  };
}

/** Marks a claimed job done. Returns false if the claim was no longer
 * held — a lost lease race, not a fault. */
export async function completeJob(
  sql: Sql,
  job: ClaimedJob,
  outcome: Record<string, unknown> | null,
): Promise<boolean> {
  const [row] = await sql<{ complete_job: boolean }[]>`
    select app_private.complete_job(
      ${job.id}::uuid,
      ${job.claimToken}::uuid,
      ${outcome === null ? null : jsonb(sql, outcome)}
    )
  `;
  return row?.complete_job === true;
}

/**
 * Records a failure. `retryAt` absent means terminal.
 *
 * The retry budget is enforced in the database, not here: `fail_job`
 * returns the job to `queued` only while attempts remain. A worker that
 * miscounted would otherwise retry a poisoned job forever.
 */
export async function failJob(
  sql: Sql,
  job: ClaimedJob,
  error: string,
  retryAt?: Date,
): Promise<boolean> {
  const [row] = await sql<{ fail_job: boolean }[]>`
    select app_private.fail_job(
      ${job.id}::uuid,
      ${job.claimToken}::uuid,
      ${error},
      ${retryAt ?? null}::timestamptz,
      'failed'
    )
  `;
  return row?.fail_job === true;
}

/**
 * Parks a job in the terminal `refused_bind` state.
 *
 * Called for exactly one condition: `bind_tenant` refused the recorded
 * `(organisation, user)` pair at execution time, because the membership
 * that existed when the job was enqueued no longer does. ADR-0011 makes
 * this terminal rather than retryable, and the reasoning is worth keeping
 * next to the call: retrying would re-refuse on every attempt and then
 * settle in `failed`, where it would look like a broken job rather than a
 * revoked user. The operator remedy — re-request the work under a live
 * user — is only obvious if the queue says what actually happened.
 */
export async function refuseJobBind(
  sql: Sql,
  job: ClaimedJob,
  error: string,
): Promise<boolean> {
  const [row] = await sql<{ fail_job: boolean }[]>`
    select app_private.fail_job(
      ${job.id}::uuid,
      ${job.claimToken}::uuid,
      ${error},
      null::timestamptz,
      'refused_bind'
    )
  `;
  return row?.fail_job === true;
}

/**
 * Runs `work` under the job's recorded authority.
 *
 * This is the whole of ADR-0011's decision 1 in one function: an ordinary
 * `withTenant` with the `(organisation, user)` the enqueuing transaction
 * stamped, so `bind_tenant` re-proves the membership at execution and
 * every RLS policy applies exactly as it does on the request path. The
 * worker holds no privilege a request handler does not — it connects as
 * the same `auto_mb_app` role, with the same absence of BYPASSRLS.
 *
 * `TenantBindRefusedError` is allowed to travel: the caller turns it into
 * `refused_bind`. Nothing here catches it, so a bind refusal can never be
 * mistaken for a job that ran and failed.
 */
export async function withJobAuthority<T>(
  sql: Sql,
  job: ClaimedJob,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withTenant(
    sql,
    { organisationId: job.organisationId, userId: job.userId },
    work,
  );
}

export { TenantBindRefusedError };
