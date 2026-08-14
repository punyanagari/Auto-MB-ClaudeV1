import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { UNGRANTED_BY_DESIGN } from '../src/bootstrap.js';
import { TenantBindRefusedError, withTenant } from '../src/tenant.js';
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  refuseJobBind,
  withJobAuthority,
  type ClaimedJob,
} from '../src/queue.js';
import {
  SETUP_TIMEOUT_MS,
  adminUrl,
  createTemporaryDatabase,
  dropStaleTemporaryDatabases,
  dropTemporaryDatabase,
  migrateToHead,
  seedTenant,
  type TemporaryDatabase,
  type Tenant,
} from './support/invariant-db.js';

/**
 * The five guards ADR-0011 requires of pack P18's implementation, in the
 * order the ADR lists them:
 *
 *   (a) `auto_mb_app` holds zero direct grants on the queue table.
 *   (b) a cross-tenant enqueue via crafted arguments is impossible.
 *   (c) a revoked-membership job parks as `refused_bind`, with the bind
 *       refused before the payload's referent is read.
 *   (d) a claim that expires re-queues.
 *   (e) is a documentation guard (the ADR-0008 tripwire) and lives in
 *       `scripts/check-config.mjs`, because it is a fact about the deploy
 *       files rather than about the database.
 *
 * Plus the concurrency property the queue exists for: two workers, one
 * job, exactly one claim.
 *
 * Everything runs against a private database migrated to head, through
 * the APPLICATION role wherever the guard is about what that role can do —
 * asserting a restriction while connected as the owner would prove
 * nothing, since the owner is a superuser.
 */

let database: TemporaryDatabase;
let root: Sql;
let admin: Sql;
let app: Sql;
let tenant: Tenant;
let otherTenant: Tenant;

beforeAll(async () => {
  root = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'worker-queue-root',
  });
  await dropStaleTemporaryDatabases(root, 'auto_mb_worker_queue_test_');
  database = await createTemporaryDatabase(root, 'auto_mb_worker_queue_test_');
  await migrateToHead(database);
  admin = database.pool;
  app = database.appPool;
  tenant = await seedTenant(admin);
  otherTenant = await seedTenant(admin);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (database) await dropTemporaryDatabase(root, database);
  await root?.end({ timeout: 5 });
}, SETUP_TIMEOUT_MS);

// Each test reasons about "the next claimable job", so it must start from
// an empty queue; otherwise a leftover row from an earlier test is what
// the claim returns and the assertion is about the wrong job. Through the
// owner pool, because nothing else can touch this table.
beforeEach(async () => {
  await admin`delete from worker_jobs`;
});

/** Enqueues through the application role, inside a real bound tenant
 * transaction — the only way the product ever enqueues. */
async function enqueueAs(
  who: Tenant,
  payload: Record<string, unknown>,
): Promise<string> {
  return withTenant(
    app,
    { organisationId: who.organisationId, userId: who.userId },
    (tx) => enqueueJob(tx, 'loa_document_intake', payload),
  );
}

async function stateOf(jobId: string): Promise<{
  state: string;
  attempts: number;
  organisation_id: string;
  user_id: string;
  last_error: string | null;
  finished_at: Date | null;
}> {
  const [row] = await admin<
    {
      state: string;
      attempts: number;
      organisation_id: string;
      user_id: string;
      last_error: string | null;
      finished_at: Date | null;
    }[]
  >`
    select state, attempts, organisation_id, user_id, last_error, finished_at
    from worker_jobs where id = ${jobId}
  `;
  if (row === undefined) throw new Error(`no worker_jobs row ${jobId}`);
  return row;
}

// ---------------------------------------------------------------------
// (a)

describe('ADR-0011 guard (a): the queue table is unreachable from the application role', () => {
  it('grants the application role no privilege of any kind on worker_jobs', async () => {
    // Table-scope privileges, one at a time, so the failure names which
    // one somebody added rather than just "not zero".
    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
    ]) {
      const [row] = await admin<{ ok: boolean }[]>`
        select has_table_privilege('auto_mb_app', 'worker_jobs', ${privilege}) as ok
      `;
      expect(
        row?.ok,
        `auto_mb_app must hold no ${privilege} on worker_jobs (ADR-0011). ` +
          'The queue is reachable only through the app_private definer functions.',
      ).toBe(false);
    }

    // `has_table_privilege` at table scope would miss a COLUMN-level
    // grant, which is a real and easy mistake, so the ACL itself is read.
    const [acl] = await admin<{ relacl: string | null }[]>`
      select relacl::text as relacl from pg_class where relname = 'worker_jobs'
    `;
    expect(acl?.relacl ?? '').not.toContain('auto_mb_app');

    const columnGrants = await admin<{ column_name: string }[]>`
      select column_name from information_schema.column_privileges
      where table_name = 'worker_jobs' and grantee = 'auto_mb_app'
    `;
    expect(columnGrants).toEqual([]);
  });

  it('records the zero-grant state as a decision in the privilege matrix', () => {
    // The catalog assertion above proves today's database. This proves the
    // INTENT is written down where the matrix lives, so a future author
    // adding the table to TABLE_PRIVILEGES has to remove it from here
    // first and read the reason on the way past.
    expect(Object.keys(UNGRANTED_BY_DESIGN)).toContain('worker_jobs');
  });

  it('refuses a direct read through the application role', async () => {
    // The end-to-end statement of the same fact: not "the catalog says
    // no privilege" but "the query actually fails".
    await expect(app`select count(*) from worker_jobs`).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('keeps row security enabled and forced, with no policy to widen it', async () => {
    const [row] = await admin<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      select relrowsecurity, relforcerowsecurity
      from pg_class where relname = 'worker_jobs'
    `;
    expect(row?.relrowsecurity).toBe(true);
    expect(row?.relforcerowsecurity).toBe(true);

    // Deliberately zero: a tenant policy cannot express a cross-tenant
    // claim, and ENABLE + FORCE with no policy is deny-all for everything
    // that is not BYPASSRLS. If a policy ever appears here, somebody has
    // decided the queue is tenant-scoped after all, and that is an ADR.
    const policies = await admin<{ policyname: string }[]>`
      select policyname from pg_policies where tablename = 'worker_jobs'
    `;
    expect(policies).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// (b)

describe('ADR-0011 guard (b): a job cannot be enqueued for another tenant', () => {
  it('stamps the organisation from the binding and ignores crafted arguments', async () => {
    // The attack, as directly as it can be written: a caller legitimately
    // bound to their OWN organisation enqueues a payload that names
    // somebody else's, in every field name the schema might plausibly have
    // used. There is no organisation parameter to pass, so this is the
    // strongest form the attempt can take.
    const jobId = await enqueueAs(tenant, {
      documentId: 'crafted',
      organisation_id: otherTenant.organisationId,
      organisationId: otherTenant.organisationId,
      user_id: otherTenant.userId,
      userId: otherTenant.userId,
    });

    const row = await stateOf(jobId);
    expect(row.organisation_id).toBe(tenant.organisationId);
    expect(row.organisation_id).not.toBe(otherTenant.organisationId);
    expect(row.user_id).toBe(tenant.userId);
    expect(row.user_id).not.toBe(otherTenant.userId);
  });

  it('refuses to enqueue at all outside a bound tenant transaction', async () => {
    // Without a binding there is no organisation to stamp, so the function
    // raises rather than inventing one. 28A01 is the same SQLSTATE
    // bind_tenant raises: "you hold no membership here", whether that is
    // discovered at bind time or at enqueue time.
    await expect(
      app`select app_private.enqueue_job('loa_document_intake', '{"documentId":"x"}'::jsonb)`,
    ).rejects.toMatchObject({ code: '28A01' });
  });
});

// ---------------------------------------------------------------------
// (c)

describe('ADR-0011 guard (c): a revoked membership parks the job, it does not run it', () => {
  it('refuses the bind before the payload referent is read, and parks as refused_bind', async () => {
    const jobId = await enqueueAs(tenant, { documentId: 'revoked-membership' });

    // The membership disappears between enqueue and execution — exactly
    // the race ADR-0011 names.
    await admin`
      update organisation_memberships set status = 'disabled'
      where organisation_id = ${tenant.organisationId} and user_id = ${tenant.userId}
    `;

    const job = await claimNextJob(app, 'guard-c-worker', 60);
    expect(job?.id).toBe(jobId);
    if (job === undefined) throw new Error('claim failed');

    // The handler's first statement would be the payload read. It must
    // never run: `withJobAuthority` opens the transaction with
    // `bind_tenant` as its first statement, which refuses, so `work` is
    // not entered at all.
    let payloadWasRead = false;
    await expect(
      withJobAuthority(app, job, async (tx) => {
        payloadWasRead = true;
        return tx`select 1 as reached`;
      }),
    ).rejects.toBeInstanceOf(TenantBindRefusedError);
    expect(
      payloadWasRead,
      'the bind must be refused before any statement of the job body runs',
    ).toBe(false);

    await refuseJobBind(app, job, 'membership revoked between enqueue and execution');

    const row = await stateOf(jobId);
    expect(row.state).toBe('refused_bind');
    expect(row.finished_at).not.toBeNull();

    // Terminal: a further claim must not pick it up again. A retried
    // refusal would re-refuse on every attempt and end in `failed`, where
    // it would read as a broken job rather than a revoked user.
    const again = await claimNextJob(app, 'guard-c-worker', 60);
    expect(again?.id).not.toBe(jobId);

    await admin`
      update organisation_memberships set status = 'active'
      where organisation_id = ${tenant.organisationId} and user_id = ${tenant.userId}
    `;
  });
});

// ---------------------------------------------------------------------
// (d)

describe('ADR-0011 guard (d): an expired claim returns to the queue', () => {
  it('lets a second worker take a job whose lease has lapsed', async () => {
    const jobId = await enqueueAs(tenant, { documentId: 'expiring-lease' });

    // A one-second lease, then the clock is moved rather than waited on:
    // the expiry is a `claim_expires_at < now()` comparison, so pushing
    // the stored instant into the past is the same event as time passing,
    // and the test does not sleep.
    const first = await claimNextJob(app, 'worker-that-dies', 1);
    expect(first?.id).toBe(jobId);
    expect((await stateOf(jobId)).attempts).toBe(1);

    // Nothing else may take it while the lease holds.
    const tooSoon = await claimNextJob(app, 'worker-B', 60);
    expect(tooSoon?.id).not.toBe(jobId);

    await admin`
      update worker_jobs set claim_expires_at = now() - interval '1 second'
      where id = ${jobId}
    `;

    const second = await claimNextJob(app, 'worker-that-lives', 60);
    expect(second?.id, 'an expired claim must be re-claimable').toBe(jobId);
    // The attempt counter moved, so a job that repeatedly kills its worker
    // still exhausts its budget instead of looping without end.
    expect((await stateOf(jobId)).attempts).toBe(2);

    // And the worker that died cannot complete the job it no longer holds:
    // its token is stale, so `complete_job` matches nothing and says so.
    if (first === undefined || second === undefined) throw new Error('claim failed');
    expect(await completeJob(app, first, { stale: true })).toBe(false);
    expect(await completeJob(app, second, { ok: true })).toBe(true);
    expect((await stateOf(jobId)).state).toBe('done');
  });
});

// ---------------------------------------------------------------------
// Concurrency: the property FOR UPDATE SKIP LOCKED is here for.

describe('the queue under concurrency', () => {
  it('gives one job to exactly one of two simultaneous workers', async () => {
    const jobId = await enqueueAs(tenant, { documentId: 'contended' });

    // Two claims issued together on separate pooled connections. SKIP
    // LOCKED means the loser steps over the locked row rather than
    // queueing behind it, so it returns empty-handed immediately instead
    // of blocking and then claiming the same job.
    const [a, b] = await Promise.all([
      claimNextJob(app, 'worker-A', 60),
      claimNextJob(app, 'worker-B', 60),
    ]);

    const winners = [a, b].filter((claim) => claim?.id === jobId);
    expect(winners, 'exactly one worker may hold a claim on a given job').toHaveLength(
      1,
    );
  });

  it('gives two jobs to two workers rather than serialising them', async () => {
    const first = await enqueueAs(tenant, { documentId: 'parallel-1' });
    const second = await enqueueAs(tenant, { documentId: 'parallel-2' });

    const [a, b] = await Promise.all([
      claimNextJob(app, 'worker-A', 60),
      claimNextJob(app, 'worker-B', 60),
    ]);

    const claimed = new Set([a?.id, b?.id]);
    expect(claimed.has(first)).toBe(true);
    expect(claimed.has(second)).toBe(true);
  });

  it('refuses completion by anyone but the claimant', async () => {
    const jobId = await enqueueAs(tenant, { documentId: 'wrong-claimant' });
    const job = await claimNextJob(app, 'worker-A', 60);
    if (job === undefined) throw new Error('claim failed');
    expect(job.id).toBe(jobId);

    // A forged token. Nothing can read the real one — the table has no
    // grant — so this is the best an attacker with arbitrary SQL as the
    // application role can do, and it does nothing.
    const forged: ClaimedJob = {
      ...job,
      claimToken: '00000000-0000-4000-8000-000000000000',
    };
    expect(await completeJob(app, forged, null)).toBe(false);
    expect(await failJob(app, forged, 'forged')).toBe(false);
    expect((await stateOf(jobId)).state).toBe('claimed');

    expect(await completeJob(app, job, null)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Retry budget, enforced by the database rather than trusted to the worker.

describe('the retry budget', () => {
  it('re-queues while attempts remain and goes terminal when they do not', async () => {
    const jobId = await enqueueAs(tenant, { documentId: 'retries' });
    await admin`update worker_jobs set max_attempts = 2 where id = ${jobId}`;

    const first = await claimNextJob(app, 'worker-A', 60);
    if (first === undefined) throw new Error('claim failed');
    expect(await failJob(app, first, 'transient', new Date(Date.now() - 1_000))).toBe(
      true,
    );
    expect((await stateOf(jobId)).state).toBe('queued');

    const second = await claimNextJob(app, 'worker-A', 60);
    if (second === undefined) throw new Error('reclaim failed');
    expect(second.attempts).toBe(2);
    // The worker asks for a retry again, but the budget is spent, so the
    // database overrules it. A worker that miscounted would otherwise
    // retry a poisoned job forever.
    expect(
      await failJob(app, second, 'still broken', new Date(Date.now() - 1_000)),
    ).toBe(true);
    const row = await stateOf(jobId);
    expect(row.state).toBe('failed');
    expect(row.last_error).toBe('still broken');
  });
});
