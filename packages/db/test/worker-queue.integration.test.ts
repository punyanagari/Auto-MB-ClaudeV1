import { randomUUID } from 'node:crypto';
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
  releaseJob,
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
  // Guard (c) revokes a membership to provoke the bind refusal. Restoring
  // it here rather than only at the end of that test means a failure
  // there cannot cascade: every later test would otherwise refuse its own
  // bind and report a membership problem it did not cause.
  await admin`
    update organisation_memberships set status = 'active'
    where organisation_id = ${tenant.organisationId} and user_id = ${tenant.userId}
  `;
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

  it('grants EXECUTE on the queue functions to nobody but the application role', async () => {
    // The four functions ARE the queue's entire surface, so their ACLs are
    // as load-bearing as the table's. PostgreSQL grants EXECUTE to PUBLIC
    // on a newly created function by default: a restore, or a hand-edited
    // function recreated without the REVOKE, comes back reachable by every
    // role in the cluster while the table's zero grants still look correct.
    const rows = await admin<{ proname: string; acl: string | null }[]>`
      select p.proname, array_to_string(p.proacl, ',') as acl
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private'
        and p.proname in (
          'enqueue_job', 'claim_next_job', 'complete_job', 'fail_job',
          'release_job', 'reconcile_terminal_job', 'purge_finished_jobs'
        )
      order by p.proname
    `;
    expect(rows).toHaveLength(7);

    for (const row of rows) {
      const acl = row.acl ?? '';
      // `=X/` with an empty grantee is PUBLIC. Its presence would mean any
      // role at all can call it.
      expect(acl, `${row.proname} must not grant EXECUTE to PUBLIC`).not.toMatch(
        /(^|,)=X?\*?\//,
      );
    }

    const callable = new Map(rows.map((row) => [row.proname, row.acl ?? '']));
    // The five the worker and the request path actually call.
    for (const fn of [
      'enqueue_job',
      'claim_next_job',
      'complete_job',
      'fail_job',
      'release_job',
    ]) {
      expect(callable.get(fn), `${fn} must be callable by auto_mb_app`).toContain(
        'auto_mb_app=X',
      );
    }
    // And the two that are not part of that surface: an internal
    // reconciliation helper and an operator's bulk delete.
    for (const fn of ['reconcile_terminal_job', 'purge_finished_jobs']) {
      expect(
        callable.get(fn),
        `${fn} must NOT be callable by auto_mb_app`,
      ).not.toContain('auto_mb_app=X');
    }
  });

  it('carries no default privilege that would grant a future queue object away', async () => {
    // ALTER DEFAULT PRIVILEGES is invisible in every check above: it does
    // not appear on the table or the functions, it applies to whatever is
    // created NEXT. A default privilege naming auto_mb_app in the schemas
    // this queue lives in would quietly grant the next queue table or
    // function away at creation time.
    const defaults = await admin<{ defaclacl: string | null }[]>`
      select array_to_string(d.defaclacl, ',') as defaclacl
      from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace
      where n.nspname in ('public', 'app_private')
    `;
    for (const row of defaults) {
      expect(row.defaclacl ?? '').not.toContain('auto_mb_app');
    }
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

  it('parks a job that exhausts its budget by expiry alone, rather than re-claiming it for ever', async () => {
    // The hole the review found. `fail_job` enforces the retry budget, and
    // a crashed worker never calls `fail_job` — so a job that reliably
    // kills whatever picks it up (an OOM on a huge letter is the realistic
    // one) was re-claimed on every expiry with nothing counting. Every
    // worker that touched it died; the queue looked busy; the job was
    // immortal.
    const jobId = await enqueueAs(tenant, { documentId: 'kills-its-worker' });
    await admin`update worker_jobs set max_attempts = 3 where id = ${jobId}`;

    // Three claims, each abandoned exactly as a crash abandons one: the
    // lease expires and nothing reports an outcome.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await claimNextJob(app, `worker-that-dies-${String(attempt)}`, 60);
      expect(claim?.id, `attempt ${String(attempt)} should claim the job`).toBe(jobId);
      expect((await stateOf(jobId)).attempts).toBe(attempt);
      await admin`
        update worker_jobs set claim_expires_at = now() - interval '1 second'
        where id = ${jobId}
      `;
    }

    // The budget is spent. The next claim must not hand it out again — and
    // must not merely skip it either, because a row nothing will ever
    // claim is invisible, which is how the first bug looked too.
    const afterBudget = await claimNextJob(app, 'worker-that-lives', 60);
    expect(afterBudget?.id).not.toBe(jobId);

    const row = await stateOf(jobId);
    expect(row.state, 'an over-budget expired claim must be parked, not left').toBe(
      'failed',
    );
    expect(row.attempts).toBe(3);
    expect(row.finished_at).not.toBeNull();
    expect(row.last_error).toContain('lease expired');
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

// ---------------------------------------------------------------------
// The document lifecycle, tied to the job lifecycle.

describe('a terminal job does not strand its document', () => {
  /** A minimal LOA row in the state the upload route now writes. */
  async function pendingDocument(): Promise<string> {
    const sha = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    const [row] = await admin<{ id: string }[]>`
      insert into loa_documents (
        organisation_id, object_key, original_filename, sha256, media_type,
        size_bytes, extraction_status, uploaded_by_user_id
      )
      values (
        ${tenant.organisationId},
        ${`${tenant.organisationId}/loa/${randomUUID()}.pdf`},
        'stranded.pdf', ${sha.slice(0, 64)},
        'application/pdf', 1024, 'pending', ${tenant.userId}
      )
      returning id
    `;
    if (row === undefined) throw new Error('document seed failed');
    return row.id;
  }

  async function extractionStatusOf(documentId: string): Promise<string> {
    const [row] = await admin<{ extraction_status: string }[]>`
      select extraction_status from loa_documents where id = ${documentId}
    `;
    return row?.extraction_status ?? '(missing)';
  }

  it('moves the document to failed when the job runs out of attempts', async () => {
    // Before the review this left the document in `pending` for ever, with
    // a queue that reported the failure and a screen that said the letter
    // was still being read.
    const documentId = await pendingDocument();
    const jobId = await enqueueAs(tenant, { documentId });
    await admin`update worker_jobs set max_attempts = 1 where id = ${jobId}`;

    const job = await claimNextJob(app, 'worker-A', 60);
    if (job === undefined) throw new Error('claim failed');
    await failJob(app, job, 'extraction blew up', new Date(Date.now() - 1_000));

    expect((await stateOf(jobId)).state).toBe('failed');
    expect(await extractionStatusOf(documentId)).toBe('failed');
  });

  it('moves the document to failed when the bind is refused', async () => {
    const documentId = await pendingDocument();
    const jobId = await enqueueAs(tenant, { documentId });
    const job = await claimNextJob(app, 'worker-A', 60);
    if (job === undefined) throw new Error('claim failed');

    await refuseJobBind(app, job, 'membership revoked');

    expect((await stateOf(jobId)).state).toBe('refused_bind');
    // The letter reads as failed, which is a state the UI shows and offers
    // a remedy for; `refused_bind` is the queue's word, not the operator's.
    expect(await extractionStatusOf(documentId)).toBe('failed');
  });

  it('moves the document to failed when an expired claim exhausts the budget', async () => {
    // The path with no worker left alive to reconcile anything: the
    // parking is done by somebody else's claim_next_job.
    const documentId = await pendingDocument();
    const jobId = await enqueueAs(tenant, { documentId });
    await admin`update worker_jobs set max_attempts = 1 where id = ${jobId}`;

    const job = await claimNextJob(app, 'worker-that-dies', 60);
    expect(job?.id).toBe(jobId);
    await admin`
      update worker_jobs set claim_expires_at = now() - interval '1 second'
      where id = ${jobId}
    `;

    await claimNextJob(app, 'worker-that-lives', 60);

    expect((await stateOf(jobId)).state).toBe('failed');
    expect(await extractionStatusOf(documentId)).toBe('failed');
  });

  it('leaves a document alone once it has actually been read', async () => {
    // A job that dies AFTER its work committed must not overwrite the
    // result with a failure.
    const documentId = await pendingDocument();
    const jobId = await enqueueAs(tenant, { documentId });
    await admin`update worker_jobs set max_attempts = 1 where id = ${jobId}`;
    await admin`
      update loa_documents set extraction_status = 'review'
      where id = ${documentId}
    `;

    const job = await claimNextJob(app, 'worker-A', 60);
    if (job === undefined) throw new Error('claim failed');
    await failJob(app, job, 'died after committing');

    expect((await stateOf(jobId)).state).toBe('failed');
    expect(await extractionStatusOf(documentId)).toBe('review');
  });
});

describe('releasing a job a worker cannot run', () => {
  it('returns it to the queue without spending an attempt', async () => {
    // The rolling-deploy case: an old worker claims a kind only the new
    // ones implement. Failing-with-retry would still spend an attempt, and
    // five such claims would kill a job the new workers would have run.
    const jobId = await enqueueAs(tenant, { documentId: 'unknown-kind' });

    const job = await claimNextJob(app, 'old-worker', 60);
    if (job === undefined) throw new Error('claim failed');
    expect((await stateOf(jobId)).attempts).toBe(1);

    expect(await releaseJob(app, job, 'no handler for job kind')).toBe(true);

    const row = await stateOf(jobId);
    expect(row.state).toBe('queued');
    expect(row.attempts, 'a release must give the attempt back').toBe(0);

    // Held briefly, so one worker cannot spin on it.
    const immediately = await claimNextJob(app, 'old-worker', 60);
    expect(immediately?.id).not.toBe(jobId);

    await admin`update worker_jobs set run_after = now() where id = ${jobId}`;
    const later = await claimNextJob(app, 'new-worker', 60);
    expect(later?.id).toBe(jobId);
  });

  it('refuses a release from anyone but the claimant', async () => {
    const jobId = await enqueueAs(tenant, { documentId: 'release-wrong-claimant' });
    const job = await claimNextJob(app, 'worker-A', 60);
    if (job === undefined) throw new Error('claim failed');
    const forged: ClaimedJob = {
      ...job,
      claimToken: '00000000-0000-4000-8000-000000000000',
    };
    expect(await releaseJob(app, forged, 'forged')).toBe(false);
    expect((await stateOf(jobId)).state).toBe('claimed');
  });
});

describe('purge_finished_jobs', () => {
  it('removes only finished rows past the window, and refuses a silly window', async () => {
    // Two rows: one that finishes long ago, one that never finishes. The
    // purge must take exactly the first.
    await enqueueAs(tenant, { documentId: 'long-done' });
    const job = await claimNextJob(app, 'worker-A', 60);
    if (job === undefined) throw new Error('claim failed');
    const queuedId = await enqueueAs(tenant, { documentId: 'still-queued' });
    await completeJob(app, job, null);
    await admin`
      update worker_jobs set finished_at = now() - interval '90 days'
      where id = ${job.id}
    `;

    const [purged] = await admin<{ purge_finished_jobs: number }[]>`
      select app_private.purge_finished_jobs(interval '30 days')
    `;
    expect(purged?.purge_finished_jobs).toBe(1);

    const remaining = await admin<{ id: string }[]>`
      select id from worker_jobs
    `;
    const ids = remaining.map((row) => row.id);
    expect(ids, 'the finished row is gone').not.toContain(job.id);
    expect(ids, 'an unfinished row is untouched whatever its age').toContain(queuedId);

    await expect(
      admin`select app_private.purge_finished_jobs(interval '1 hour')`,
    ).rejects.toThrow(/younger than a day/);
  });
});

describe('SKIP LOCKED, deterministically', () => {
  it('steps over a row another session holds locked instead of waiting for it', async () => {
    // The concurrency tests above fire two claims together and assert that
    // exactly one wins, which is the real-world property but is decided by
    // whichever transaction gets there first. This one removes the race: a
    // second connection takes and HOLDS the row lock, so the claim meets a
    // definitely-locked row.
    //
    // Without SKIP LOCKED the claim would block until the holder commits;
    // with it, the claim steps over and takes the next job. Both halves
    // are asserted, because "returned nothing" alone would also be true of
    // a query that matched nothing.
    const lockedId = await enqueueAs(tenant, { documentId: 'held-under-lock' });
    const reachableId = await enqueueAs(tenant, { documentId: 'not-locked' });

    let release = (): void => {};
    const lockHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => {};
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });

    // The owner pool, on its own connection, holding a row lock open. The
    // claim below runs on the separate application pool, so this is two
    // real sessions rather than two statements on one.
    const holding = admin.begin(async (tx) => {
      await tx`select id from worker_jobs where id = ${lockedId} for update`;
      locked();
      await lockHeld;
    });

    try {
      await lockTaken;

      const claimed = await claimNextJob(app, 'stepping-over', 60);
      expect(claimed?.id, 'the locked row must be skipped, not waited for').not.toBe(
        lockedId,
      );
      expect(claimed?.id, 'and the next runnable job taken instead').toBe(reachableId);
    } finally {
      // Always, or the transaction above holds the lock for the rest of
      // the file and every later test blocks on it.
      release();
      await holding;
    }

    // Once the lock is gone the skipped job is claimable, which proves it
    // was stepped over rather than consumed or filtered out.
    const afterRelease = await claimNextJob(app, 'after-release', 60);
    expect(afterRelease?.id).toBe(lockedId);
  });
});
