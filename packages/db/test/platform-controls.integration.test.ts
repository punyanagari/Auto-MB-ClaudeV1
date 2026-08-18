import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { withTenant } from '../src/tenant.js';
import {
  enqueueDueStatutoryJobs,
  expireLapsedOrganisationExports,
  failStalledOrganisationExports,
} from '../src/queue.js';
import {
  adminUrl,
  createTemporaryDatabase,
  dropStaleTemporaryDatabases,
  dropTemporaryDatabase,
  migrateToHead,
  refused,
  seedTenant,
  SETUP_TIMEOUT_MS,
  type TemporaryDatabase,
  type Tenant,
} from './support/invariant-db.js';

/**
 * The platform controls (migration 0096), attacked live.
 *
 * `migration-contract.test.ts` reads the file; this drives the database.
 * Three things are worth a real cluster and nothing else here is:
 *
 *   THE SCHEDULER'S EXACTLY-ONCE PROPERTY. A monthly statutory check that
 *   fires twice is two reports and a support call, and the guarantee lives
 *   entirely in one statement's `FOR UPDATE SKIP LOCKED` plus the enqueue
 *   and the advance sharing a transaction. Neither is visible in the
 *   source of any one function.
 *
 *   THE SWEEP'S ORDERING. It must mark the row before it hands the key
 *   back, so the failure mode is an orphan file rather than a `ready` row
 *   pointing at nothing.
 *
 *   THE GUARDS, through the APPLICATION role. A guard proved as the owner
 *   proves nothing about what the product can do.
 */

let root: Sql;
let database: TemporaryDatabase;
let admin: Sql;
let app: Sql;
let tenant: Tenant;
let other: Tenant;

beforeAll(async () => {
  root = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-platform-root',
  });
  await dropStaleTemporaryDatabases(root, 'auto_mb_platform_test_');
  database = await createTemporaryDatabase(root, 'auto_mb_platform_test_');
  await migrateToHead(database);
  admin = database.pool;
  app = database.appPool;
  tenant = await seedTenant(admin);
  other = await seedTenant(admin);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await dropTemporaryDatabase(root, database);
  await root?.end({ timeout: 5 });
}, SETUP_TIMEOUT_MS);

async function seedSchedule(target: Tenant, dueMinutesAgo: number): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    insert into statutory_job_schedules (
      organisation_id, kind, cadence, authority_user_id, next_run_at
    )
    values (
      ${target.organisationId}, 'instrument_expiry_review', 'weekly',
      ${target.userId}, now() - make_interval(mins => ${dueMinutesAgo})
    )
    returning id
  `;
  if (!row) throw new Error('schedule seed failed');
  return row.id;
}

describe('the recurring statutory scheduler', () => {
  it('enqueues a due schedule once, stamped with the membership it borrows', async () => {
    const scheduleId = await seedSchedule(tenant, 5);

    expect(await enqueueDueStatutoryJobs(app, 50)).toBe(1);

    const [job] = await admin<
      {
        organisation_id: string;
        user_id: string;
        kind: string;
        payload_ref: { scheduleId?: string; horizonDays?: number };
      }[]
    >`
      select organisation_id, user_id, kind, payload_ref
      from worker_jobs where payload_ref->>'scheduleId' = ${scheduleId}
    `;
    // ADR-0011's rule, kept: the queue row names a real member, so
    // `bind_tenant` has a membership to re-prove at execution.
    expect(job?.organisation_id).toBe(tenant.organisationId);
    expect(job?.user_id).toBe(tenant.userId);
    expect(job?.kind).toBe('instrument_expiry_review');
    expect(job?.payload_ref.horizonDays).toBe(45);

    // A SECOND TICK ENQUEUES NOTHING. The advance and the insert commit
    // together, so the schedule is no longer due the instant the job
    // exists — this is the assertion that would fail if the function ever
    // grew a read-then-write shape.
    expect(await enqueueDueStatutoryJobs(app, 50)).toBe(0);

    const [advanced] = await admin<{ future: boolean; last_job_id: string | null }[]>`
      select next_run_at > now() as future, last_job_id
      from statutory_job_schedules where id = ${scheduleId}
    `;
    expect(advanced?.future).toBe(true);
    expect(advanced?.last_job_id).not.toBeNull();

    await admin`delete from worker_jobs where payload_ref->>'scheduleId' = ${scheduleId}`;
    await admin`delete from statutory_job_schedules where id = ${scheduleId}`;
  });

  it('advances from now, so a worker that was down does not fire a week of runs at once', async () => {
    // Thirty days late on a weekly cadence. A naive `next_run_at +
    // interval` would leave the schedule due four more times and enqueue
    // four identical reports over the next four ticks.
    const scheduleId = await seedSchedule(tenant, 60 * 24 * 30);

    expect(await enqueueDueStatutoryJobs(app, 50)).toBe(1);
    expect(await enqueueDueStatutoryJobs(app, 50)).toBe(0);

    const [row] = await admin<{ days_ahead: number }[]>`
      select extract(day from next_run_at - now())::int as days_ahead
      from statutory_job_schedules where id = ${scheduleId}
    `;
    expect(row?.days_ahead).toBe(6);

    await admin`delete from worker_jobs where payload_ref->>'scheduleId' = ${scheduleId}`;
    await admin`delete from statutory_job_schedules where id = ${scheduleId}`;
  });

  it('leaves a disabled schedule alone', async () => {
    const scheduleId = await seedSchedule(tenant, 5);
    await admin`
      update statutory_job_schedules set enabled = false where id = ${scheduleId}
    `;
    expect(await enqueueDueStatutoryJobs(app, 50)).toBe(0);
    await admin`delete from statutory_job_schedules where id = ${scheduleId}`;
  });

  it('takes disjoint schedules when two workers tick at the same instant', async () => {
    // The exactly-once property is `FOR UPDATE SKIP LOCKED`, and a test
    // that calls the function twice in sequence proves the ADVANCE, not
    // the lock. This drives two OVERLAPPING transactions: the first holds
    // its schedule locked while the second sweeps, and the second must
    // step over it rather than block on it or take it too.
    const mine = await seedSchedule(tenant, 5);
    const theirs = await seedSchedule(other, 5);

    let firstCount = 0;
    let secondCount = 0;
    await admin.begin(async (first) => {
      // Locks exactly one schedule and does NOT commit yet.
      const [locked] = await first<{ id: string }[]>`
        select id from statutory_job_schedules
        where id = ${mine} for update
      `;
      expect(locked?.id).toBe(mine);

      // A second connection sweeps while that lock is held.
      secondCount = await enqueueDueStatutoryJobs(app, 50);
    });
    firstCount = await enqueueDueStatutoryJobs(app, 50);

    // The sweep that ran under the lock skipped the locked row and took
    // the other organisation's; the later one picked up what was skipped.
    // Two enqueues in total, never three and never one.
    expect(secondCount).toBe(1);
    expect(firstCount).toBe(1);

    const [jobs] = await admin<{ count: number }[]>`
      select count(*)::int as count from worker_jobs
      where payload_ref->>'scheduleId' in (${mine}, ${theirs})
    `;
    expect(jobs?.count).toBe(2);

    await admin`
      delete from worker_jobs
      where payload_ref->>'scheduleId' in (${mine}, ${theirs})
    `;
    await admin`delete from statutory_job_schedules where id in (${mine}, ${theirs})`;
  });

  it('pauses a schedule whose member has left instead of refusing for ever', async () => {
    const scheduleId = await seedSchedule(tenant, 5);
    expect(await enqueueDueStatutoryJobs(app, 50)).toBe(1);

    // The queue's own verdict when bind_tenant refuses the recorded
    // membership. Driving the state directly rather than deleting a
    // membership keeps this a test of the SCHEDULER's reaction.
    await admin`
      update worker_jobs set state = 'refused_bind', finished_at = now()
      where payload_ref->>'scheduleId' = ${scheduleId}
    `;
    await admin`
      update statutory_job_schedules set next_run_at = now() - interval '1 minute'
      where id = ${scheduleId}
    `;

    // The next tick must PAUSE rather than enqueue: without this the
    // schedule re-refuses every cadence for ever and the queue's
    // refused_bind count stops meaning anything.
    expect(await enqueueDueStatutoryJobs(app, 50)).toBe(0);
    const [row] = await admin<{ enabled: boolean; disabled_reason: string | null }[]>`
      select enabled, disabled_reason from statutory_job_schedules
      where id = ${scheduleId}
    `;
    expect(row?.enabled).toBe(false);
    expect(row?.disabled_reason).toContain('no longer in the organisation');

    await admin`delete from worker_jobs where payload_ref->>'scheduleId' = ${scheduleId}`;
    await admin`delete from statutory_job_schedules where id = ${scheduleId}`;
  });

  it('refuses to repoint a schedule at a different check', async () => {
    const scheduleId = await seedSchedule(tenant, 5);
    const failure = await refused(
      withTenant(
        app,
        { organisationId: tenant.organisationId, userId: tenant.userId },
        (tx) => tx`
          update statutory_job_schedules
             set organisation_id = ${other.organisationId}
           where id = ${scheduleId}
        `,
      ),
    );
    // The 23N block, not a bare 23514, so `routes/platform.ts` can name it.
    expect(failure.code).toBe('23N03');
    await admin`delete from statutory_job_schedules where id = ${scheduleId}`;
  });
});

describe('the organisation export artefact', () => {
  /** Retires whatever build is in flight for this tenant.
   *
   * The partial unique index admits ONE queued-or-running row per
   * organisation, so a test that leaves one blocks every later insert.
   * Failing it is the same transition the stall sweep makes, so this
   * cleans up through the state machine rather than around it. */
  async function clearLiveExports(target: Tenant): Promise<void> {
    await admin`
      update organisation_export_requests
         set state = 'failed', completed_at = now(),
             failure_reason = 'retired by the test fixture'
       where organisation_id = ${target.organisationId}
         and state in ('queued', 'running')
    `;
  }

  async function seedReadyExport(
    target: Tenant,
    expiresIn: string,
  ): Promise<{ id: string; key: string }> {
    await clearLiveExports(target);
    const [row] = await admin<{ id: string }[]>`
      insert into organisation_export_requests (
        organisation_id, requested_by_user_id
      )
      values (${target.organisationId}, ${target.userId})
      returning id
    `;
    if (!row) throw new Error('export seed failed');
    const key = `${target.organisationId}/exports/${row.id}.json`;
    await admin`
      update organisation_export_requests
         set state = 'running', started_at = now() where id = ${row.id}
    `;
    await admin`
      update organisation_export_requests
         set state = 'ready', completed_at = now(), object_key = ${key},
             byte_size = 128, sha256 = ${'a'.repeat(64)},
             format_version = 'export-v28',
             expires_at = now() + ${expiresIn}::interval
       where id = ${row.id}
    `;
    return { id: row.id, key };
  }

  it('marks a lapsed artefact expired and hands back its key to delete', async () => {
    const artefact = await seedReadyExport(tenant, '-1 hour');

    const keys = await expireLapsedOrganisationExports(app, 50);
    expect(keys).toContain(artefact.key);

    const [row] = await admin<{ state: string; object_key: string | null }[]>`
      select state, object_key from organisation_export_requests
      where id = ${artefact.id}
    `;
    // The row is marked BEFORE the bytes go, which is why the key comes
    // back rather than being deleted in SQL: the failure this order
    // produces is an orphan file, and the other order's failure is a
    // download button that 500s.
    expect(row?.state).toBe('expired');
    expect(row?.object_key).toBeNull();

    // Idempotent: a second sweep finds nothing to hand back.
    expect(await expireLapsedOrganisationExports(app, 50)).not.toContain(artefact.key);
  });

  it('leaves a live artefact alone', async () => {
    const artefact = await seedReadyExport(tenant, '7 days');
    expect(await expireLapsedOrganisationExports(app, 50)).not.toContain(artefact.key);
    const [row] = await admin<{ state: string }[]>`
      select state from organisation_export_requests where id = ${artefact.id}
    `;
    expect(row?.state).toBe('ready');
  });

  it('refuses a key that names another organisation directory', async () => {
    const failure = await refused(
      admin`
        insert into organisation_export_requests (
          organisation_id, requested_by_user_id, state, object_key,
          byte_size, sha256, format_version, expires_at, completed_at
        )
        values (
          ${tenant.organisationId}, ${tenant.userId}, 'queued',
          ${`${other.organisationId}/exports/stolen.json`},
          1, ${'b'.repeat(64)}, 'export-v28', now() + interval '1 day', now()
        )
      `,
    );
    // The CHECK, not the guard: two layers on the tenant prefix, because a
    // path is a filesystem escape and `assertSafeObjectKey` only knows the
    // key's shape.
    expect(failure.code).toBe('23514');
  });

  it('refuses a ready row with nothing to fetch', async () => {
    await clearLiveExports(tenant);
    const [row] = await admin<{ id: string }[]>`
      insert into organisation_export_requests (
        organisation_id, requested_by_user_id
      )
      values (${tenant.organisationId}, ${tenant.userId})
      returning id
    `;
    const id = row?.id ?? '';
    await admin`
      update organisation_export_requests
         set state = 'running', started_at = now() where id = ${id}
    `;
    const failure = await refused(
      admin`
        update organisation_export_requests
           set state = 'ready', completed_at = now()
         where id = ${id}
      `,
    );
    expect(failure.code).toBe('23514');
    await clearLiveExports(tenant);
  });

  it('refuses a state that rewinds', async () => {
    const artefact = await seedReadyExport(tenant, '7 days');
    const failure = await refused(
      withTenant(
        app,
        { organisationId: tenant.organisationId, userId: tenant.userId },
        (tx) => tx`
          update organisation_export_requests set state = 'queued'
          where id = ${artefact.id}
        `,
      ),
    );
    // A ready row that could return to queued would re-use an id an
    // operator has already been given a download link for.
    expect(failure.code).toBe('23N01');
  });

  it('refuses an edit to the digest of a built artefact', async () => {
    const artefact = await seedReadyExport(tenant, '7 days');
    const failure = await refused(
      withTenant(
        app,
        { organisationId: tenant.organisationId, userId: tenant.userId },
        (tx) => tx`
          update organisation_export_requests set sha256 = ${'f'.repeat(64)}
          where id = ${artefact.id}
        `,
      ),
    );
    // Without this the recorded SHA-256 would be a claim rather than a
    // check, and the whole point of printing it in full is that a
    // recipient can verify the file against it.
    expect(failure.code).toBe('23N02');
  });

  it('fails a build nothing will finish, so the organisation is not locked out', async () => {
    // The export builds in the API process, so a restart leaves the row
    // in `running` with nothing behind it — and the partial unique index
    // below makes that ONE row disable self-service export for the
    // organisation for ever. This sweep is the reconciliation, and it is
    // the reason the index is safe to have.
    await clearLiveExports(tenant);
    const [row] = await admin<{ id: string }[]>`
      insert into organisation_export_requests (
        organisation_id, requested_by_user_id, requested_at
      )
      values (${tenant.organisationId}, ${tenant.userId}, now() - interval '3 hours')
      returning id
    `;
    const id = row?.id ?? '';
    await admin`
      update organisation_export_requests
         set state = 'running', started_at = now() - interval '3 hours'
       where id = ${id}
    `;

    expect(
      await failStalledOrganisationExports(app, '1 hour', 50),
    ).toBeGreaterThanOrEqual(1);

    const [failed] = await admin<{ state: string; failure_reason: string | null }[]>`
      select state, failure_reason from organisation_export_requests where id = ${id}
    `;
    expect(failed?.state).toBe('failed');
    expect(failed?.failure_reason).toContain('did not finish');
  });

  it('leaves a build that is still plausibly running alone', async () => {
    await clearLiveExports(tenant);
    const [row] = await admin<{ id: string }[]>`
      insert into organisation_export_requests (
        organisation_id, requested_by_user_id
      )
      values (${tenant.organisationId}, ${tenant.userId})
      returning id
    `;
    const id = row?.id ?? '';
    expect(await failStalledOrganisationExports(app, '1 hour', 50)).toBe(0);
    const [alive] = await admin<{ state: string }[]>`
      select state from organisation_export_requests where id = ${id}
    `;
    expect(alive?.state).toBe('queued');
    await admin`
      update organisation_export_requests
         set state = 'failed', completed_at = now(), failure_reason = 'test cleanup'
       where id = ${id}
    `;
  });

  it('refuses a sweep window short enough to kill a live build', async () => {
    const failure = await refused(
      app`select app_private.fail_stalled_organisation_exports(interval '1 minute', 10)`,
    );
    // A sweep that could take a build still in flight would fail a healthy
    // export AND free the slot for a second one racing the first.
    expect(failure.code).toBe('23514');
  });

  it('admits one build at a time in the DATABASE, not only in the route', async () => {
    await clearLiveExports(tenant);
    const [first] = await admin<{ id: string }[]>`
      insert into organisation_export_requests (
        organisation_id, requested_by_user_id
      )
      values (${tenant.organisationId}, ${tenant.userId})
      returning id
    `;
    // The route pre-checks the same rule, but two requests can both pass
    // that check before either inserts. This is the arm that holds.
    const failure = await refused(
      withTenant(
        app,
        { organisationId: tenant.organisationId, userId: tenant.userId },
        (tx) => tx`
          insert into organisation_export_requests (
            organisation_id, requested_by_user_id
          )
          values (${tenant.organisationId}, ${tenant.userId})
        `,
      ),
    );
    expect(failure.code).toBe('23505');
    await admin`
      update organisation_export_requests
         set state = 'failed', completed_at = now(), failure_reason = 'test cleanup'
       where id = ${first?.id ?? ''}
    `;
  });

  it('lets the download counters move on a built artefact', async () => {
    const artefact = await seedReadyExport(tenant, '7 days');
    await withTenant(
      app,
      { organisationId: tenant.organisationId, userId: tenant.userId },
      (tx) => tx`
        update organisation_export_requests
           set download_count = download_count + 1, last_downloaded_at = now()
         where id = ${artefact.id}
      `,
    );
    const [row] = await admin<{ download_count: number }[]>`
      select download_count from organisation_export_requests
      where id = ${artefact.id}
    `;
    expect(row?.download_count).toBe(1);
  });
});

describe('the run history read', () => {
  it('refuses an unbound caller rather than answering empty', async () => {
    const failure = await refused(
      app`select * from app_private.organisation_job_history(10)`,
    );
    // The same SQLSTATE `bind_tenant` and `enqueue_job` raise: "you hold no
    // membership here" is one answer however it is discovered.
    expect(failure.code).toBe('28A01');
  });

  it('refuses a page size outside one to two hundred', async () => {
    for (const limit of [0, 201]) {
      const failure = await refused(
        withTenant(
          app,
          { organisationId: tenant.organisationId, userId: tenant.userId },
          (tx) => tx`select * from app_private.organisation_job_history(${limit})`,
        ),
      );
      expect(failure.code, `limit ${String(limit)}`).toBe('23514');
    }
  });

  it('answers only the bound organisation, and never the claim token', async () => {
    const mine = await seedSchedule(tenant, 5);
    const theirs = await seedSchedule(other, 5);
    await enqueueDueStatutoryJobs(app, 50);

    const rows = await withTenant(
      app,
      { organisationId: tenant.organisationId, userId: tenant.userId },
      (tx) =>
        tx<Record<string, unknown>[]>`
          select * from app_private.organisation_job_history(50)
        `,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('claim_token');
      expect(Object.keys(row)).not.toContain('user_id');
    }

    const theirJobs = await admin<{ id: string }[]>`
      select id from worker_jobs where organisation_id = ${other.organisationId}
    `;
    expect(theirJobs.length).toBeGreaterThanOrEqual(1);
    const visible = new Set(rows.map((row) => row.id));
    for (const job of theirJobs) expect(visible.has(job.id)).toBe(false);

    await admin`
      delete from worker_jobs
      where payload_ref->>'scheduleId' in (${mine}, ${theirs})
    `;
    await admin`delete from statutory_job_schedules where id in (${mine}, ${theirs})`;
  });
});

describe('the queue table itself', () => {
  it('still holds no privilege for the application role', async () => {
    // 0096 grants the definer role more, never the application role. A
    // direct read here would be the enumeration oracle ADR-0011 refused.
    const failure = await refused(app`select count(*) from worker_jobs`);
    expect(failure.code).toBe('42501');
  });
});
