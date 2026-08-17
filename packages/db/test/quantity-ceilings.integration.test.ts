import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';

// These tests prove the database-level quantity rules around a Work item:
// the delivery ceiling migration 0046 introduced, the installation ceiling it
// also introduced and migration 0077 REPLACED with a derived pending-variation
// flag, and the migration-time assertions that arrived with 0046. Everything
// runs against real PostgreSQL: a trigger is only as good as the plan the
// server actually executes, and the concurrency proofs need genuine row locks.
//
// The staged "pre-0046" block at the bottom is deliberately unchanged. It
// applies migrations up to 0046 and no further, so it still proves what 0046
// did on the database it was written for — which is the history 0077 is a
// decision against, not a contradiction of.
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';

const here = path.dirname(fileURLToPath(import.meta.url));
const realMigrationsDirectory = path.resolve(here, '..', 'migrations');

// Every lock-sensitive test is bounded: a trigger that deadlocks fails at this
// timeout instead of hanging the suite.
const TEST_TIMEOUT_MS = 60_000;
const STAGED_TIMEOUT_MS = 180_000;

let admin: Sql;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-quantity-ceilings-admin',
  });
  await admin`select 1 as ready`;
});

afterAll(async () => {
  try {
    // Sweep databases leaked by a crashed earlier run; the per-test finally
    // cannot help when the process itself was killed.
    const stale = await admin<{ datname: string }[]>`
      select datname from pg_database
      where datname like 'auto_mb_ceiling_test_%'
    `;
    for (const database of stale) {
      await admin.unsafe(`drop database if exists ${database.datname} with (force)`);
    }
  } finally {
    await admin?.end();
  }
});

interface TemporaryDatabase {
  readonly name: string;
  readonly pool: Sql;
}

async function createTemporaryDatabase(): Promise<TemporaryDatabase> {
  const name = `auto_mb_ceiling_test_${randomBytes(6).toString('hex')}`;
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    name,
    pool: createDatabasePool({
      url: url.toString(),
      max: 6,
      applicationName: 'auto-mb-quantity-ceilings-test',
    }),
  };
}

async function dropTemporaryDatabase(database: TemporaryDatabase): Promise<void> {
  try {
    await database.pool.end({ timeout: 5 });
  } catch {
    // A wedged pool must not stop the drop below; `with (force)` terminates
    // whatever the pool left behind.
  }
  await admin.unsafe(`drop database if exists ${database.name} with (force)`);
}

/** Copies the migrations whose four-digit id is at most `throughId`. */
async function stageMigrations(directory: string, throughId: string): Promise<void> {
  const names = (await readdir(realMigrationsDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of names.filter((name) => name.slice(0, 4) <= throughId)) {
    await copyFile(
      path.join(realMigrationsDirectory, name),
      path.join(directory, name),
    );
  }
}

interface Seed {
  readonly organisationId: string;
  readonly workId: string;
  readonly scheduleId: string;
  readonly workItemId: string;
  readonly locationId: string;
}

/** One tenant, one Work, one schedule, one item of `sanctionedQuantity`, and a
 * location master to install at. Each call is independent, so tests never
 * contend for the same rows. */
async function seedWork(
  pool: Sql,
  sanctionedQuantity: string,
  options: { readonly allowExcessDelivery?: boolean } = {},
): Promise<Seed> {
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  const [organisation] = await pool<{ id: string }[]>`
    insert into organisations (name, slug)
    values (${`Ceiling tenant ${suffix}`}, ${`ceiling-${suffix.toLowerCase()}`})
    returning id
  `;
  if (!organisation) throw new Error('organisation seed failed');
  const [work] = await pool<{ id: string }[]>`
    insert into works (
      organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, allow_excess_delivery,
      created_by_user_id
    )
    values (
      ${organisation.id}, ${`W${suffix}`}, ${`LOA/${suffix}`}, '2025-01-01',
      'Quantity ceiling work', '100000.00', '100000.00', 'per_schedule',
      ${options.allowExcessDelivery ?? false}, 'ceiling-test'
    )
    returning id
  `;
  if (!work) throw new Error('work seed failed');
  const [schedule] = await pool<{ id: string }[]>`
    insert into work_schedules (organisation_id, work_id, schedule_code, title, position)
    values (${organisation.id}, ${work.id}, 'S1', 'Schedule 1', 1)
    returning id
  `;
  if (!schedule) throw new Error('schedule seed failed');
  const [item] = await pool<{ id: string }[]>`
    insert into work_items (
      organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate
    )
    values (
      ${organisation.id}, ${work.id}, ${schedule.id}, 'I-1',
      'Ceiling item one', 'NOS', ${sanctionedQuantity}, '100.000000'
    )
    returning id
  `;
  if (!item) throw new Error('work item seed failed');
  const [location] = await pool<{ id: string }[]>`
    insert into location_masters (organisation_id, name, kind, created_by_user_id)
    values (${organisation.id}, 'Ceiling site', 'installation_point', 'ceiling-test')
    returning id
  `;
  if (!location) throw new Error('location seed failed');
  return {
    organisationId: organisation.id,
    workId: work.id,
    scheduleId: schedule.id,
    workItemId: item.id,
    locationId: location.id,
  };
}

/** A draft Delivery Challan carrying one line of `quantity` for the seeded
 * item. Only one draft per Work exists at a time, so each seed gets its own. */
async function draftChallan(pool: Sql, seed: Seed, quantity: string): Promise<string> {
  const [challan] = await pool<{ id: string }[]>`
    insert into delivery_challans (
      organisation_id, work_id, challan_date, prefix, consignee_snapshot,
      created_by_user_id
    )
    values (
      ${seed.organisationId}, ${seed.workId}, current_date, 'DC',
      ${pool.json({ name: 'Ceiling consignee', address: 'Somewhere' })},
      'ceiling-test'
    )
    returning id
  `;
  if (!challan) throw new Error('challan seed failed');
  await pool`
    insert into delivery_challan_items (
      organisation_id, delivery_challan_id, work_id, work_item_id,
      description_snapshot, unit_snapshot, quantity, rate_snapshot,
      line_amount, position
    )
    values (
      ${seed.organisationId}, ${challan.id}, ${seed.workId}, ${seed.workItemId},
      'Ceiling item one', 'NOS', ${quantity}, '100.000000',
      (${quantity}::numeric(18,3) * 100)::numeric(18,2), 1
    )
  `;
  return challan.id;
}

/** The exact write the issue route performs at the draft -> issued transition. */
function issueChallan(
  pool: Sql,
  challanId: string,
  sequence: number,
): Promise<unknown> {
  return pool`
    update delivery_challans
    set status = 'issued', challan_number = ${`DC/${String(sequence)}`},
        sequence_number = ${sequence},
        issued_snapshot = ${pool.json({ templateVersion: 'ceiling-test' })},
        issued_at = now(), issued_by_user_id = 'ceiling-test'
    where id = ${challanId}
  `;
}

function recordInstallation(
  pool: Sql,
  seed: Seed,
  quantity: string,
): Promise<{ id: string }[]> {
  return pool<{ id: string }[]>`
    insert into installations (
      organisation_id, work_id, work_item_id, quantity, installed_on,
      location_id, location_name, recorded_by_user_id
    )
    values (
      ${seed.organisationId}, ${seed.workId}, ${seed.workItemId}, ${quantity},
      current_date, ${seed.locationId}, 'Ceiling site', 'ceiling-test'
    )
    returning id
  `;
}

interface RefusedWrite {
  readonly code: string | undefined;
  readonly message: string;
}

/** Narrows a settled outcome that must be a refusal into its SQLSTATE and
 * message, so both halves can be asserted without an `any`-typed asymmetric
 * matcher. */
function refusalOf(outcome: unknown): RefusedWrite {
  if (!(outcome instanceof Error)) {
    throw new Error('the write was accepted, but it should have been refused');
  }
  const failure = outcome as Error & { code?: unknown };
  return {
    code: typeof failure.code === 'string' ? failure.code : undefined,
    message: failure.message,
  };
}

/** Awaits a write that must be refused. */
async function refused(write: Promise<unknown>): Promise<RefusedWrite> {
  return refusalOf(
    await write.then(
      (value: unknown) => value,
      (error: unknown) => error,
    ),
  );
}

/** The item's derived variation flag (migration 0077): true exactly when its
 * cumulative installed quantity stands above the sanctioned quantity. */
async function pendingVariationOf(pool: Sql, workItemId: string): Promise<boolean> {
  const [item] = await pool<{ pending_variation: boolean }[]>`
    select pending_variation from work_items where id = ${workItemId}
  `;
  if (!item) throw new Error('work item read returned no row');
  return item.pending_variation;
}

/** Blocks until the backend `pid` is waiting on a lock, so a concurrency proof
 * asserts real blocking rather than a lucky interleaving. */
async function waitUntilBlockedOnLock(pool: Sql, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await pool<{ wait_event_type: string | null }[]>`
      select wait_event_type from pg_stat_activity where pid = ${pid}
    `;
    if (row?.wait_event_type === 'Lock') return;
    await delay(50);
  }
  throw new Error(`backend ${String(pid)} never blocked on a lock`);
}

describe('database quantity ceilings', () => {
  let database: TemporaryDatabase;
  let pool: Sql;

  beforeAll(async () => {
    database = await createTemporaryDatabase();
    pool = database.pool;
    await runMigrations(pool, realMigrationsDirectory);
  }, STAGED_TIMEOUT_MS);

  afterAll(async () => {
    await dropTemporaryDatabase(database);
  });

  it('refuses issuing a Delivery Challan beyond the sanctioned quantity', async () => {
    const seed = await seedWork(pool, '10.000');
    const challanId = await draftChallan(pool, seed, '12.000');

    const refusal = await refused(issueChallan(pool, challanId, 1));
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('delivery ceiling');

    const [challan] = await pool<{ status: string }[]>`
      select status from delivery_challans where id = ${challanId}
    `;
    expect(challan?.status).toBe('draft');
  });

  it('refuses a second issue whose cumulative delivery crosses the ceiling', async () => {
    const seed = await seedWork(pool, '10.000');
    const first = await draftChallan(pool, seed, '7.000');
    await issueChallan(pool, first, 1);
    const second = await draftChallan(pool, seed, '4.000');

    const refusal = await refused(issueChallan(pool, second, 2));
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('11.000 against 10.000');
  });

  it('ignores cancelled Delivery Challans when measuring the delivery ceiling', async () => {
    const seed = await seedWork(pool, '10.000');
    const first = await draftChallan(pool, seed, '7.000');
    await issueChallan(pool, first, 1);
    await pool`
      update delivery_challans
      set status = 'cancelled', cancelled_at = now(),
          cancelled_by_user_id = 'ceiling-test',
          cancellation_note = 'released for the ceiling proof'
      where id = ${first}
    `;

    const second = await draftChallan(pool, seed, '10.000');
    await issueChallan(pool, second, 2);

    const [issued] = await pool<{ status: string }[]>`
      select status from delivery_challans where id = ${second}
    `;
    expect(issued?.status).toBe('issued');
  });

  it('lets allow_excess_delivery lift the delivery ceiling', async () => {
    const seed = await seedWork(pool, '10.000', { allowExcessDelivery: true });
    const challanId = await draftChallan(pool, seed, '12.000');

    await issueChallan(pool, challanId, 1);

    const [challan] = await pool<{ status: string }[]>`
      select status from delivery_challans where id = ${challanId}
    `;
    expect(challan?.status).toBe('issued');
  });

  it('admits installation past the sanctioned quantity and flags the variation', async () => {
    // Migration 0077, and the excess-delivery toggle is beside the point
    // in both directions: it never reached this rule when the rule was a
    // cap, and it does not reach the flag that replaced it.
    const seed = await seedWork(pool, '10.000', { allowExcessDelivery: true });
    const challanId = await draftChallan(pool, seed, '12.000');
    await issueChallan(pool, challanId, 1);

    await recordInstallation(pool, seed, '10.000');
    expect(await pendingVariationOf(pool, seed.workItemId)).toBe(false);

    await recordInstallation(pool, seed, '1.000');

    const [installed] = await pool<{ total: string }[]>`
      select coalesce(sum(quantity), 0)::text as total from installations
      where work_item_id = ${seed.workItemId} and status = 'recorded'
    `;
    expect(installed?.total).toBe('11.000');
    expect(await pendingVariationOf(pool, seed.workItemId)).toBe(true);
  });

  it('accepts delivery and installation exactly at the sanctioned quantity', async () => {
    const seed = await seedWork(pool, '10.000');
    const challanId = await draftChallan(pool, seed, '10.000');
    await issueChallan(pool, challanId, 1);
    await recordInstallation(pool, seed, '6.000');
    await recordInstallation(pool, seed, '4.000');

    const [installed] = await pool<{ total: string }[]>`
      select coalesce(sum(quantity), 0)::text as total from installations
      where work_item_id = ${seed.workItemId} and status = 'recorded'
    `;
    expect(installed?.total).toBe('10.000');
    // Exactly at the sanctioned quantity owes no variation: the flag is
    // strictly-greater-than, like the ceiling it replaced.
    expect(await pendingVariationOf(pool, seed.workItemId)).toBe(false);
  });

  it('clears the variation flag when the excess installation is cancelled', async () => {
    const seed = await seedWork(pool, '10.000');
    const [recorded] = await recordInstallation(pool, seed, '10.000');
    if (!recorded) throw new Error('installation insert returned no row');
    const [excess] = await recordInstallation(pool, seed, '1.000');
    if (!excess) throw new Error('installation insert returned no row');
    expect(await pendingVariationOf(pool, seed.workItemId)).toBe(true);

    await pool`
      update installations
      set status = 'cancelled', cancelled_at = now(),
          cancelled_by_user_id = 'ceiling-test',
          cancellation_note = 'released for the variation proof'
      where id = ${excess.id}
    `;

    const [installed] = await pool<{ total: string }[]>`
      select coalesce(sum(quantity), 0)::text as total from installations
      where work_item_id = ${seed.workItemId} and status = 'recorded'
    `;
    expect(installed?.total).toBe('10.000');
    expect(await pendingVariationOf(pool, seed.workItemId)).toBe(false);
  });

  it('clears the variation flag when the amendment sanctions the excess', async () => {
    const seed = await seedWork(pool, '10.000');
    await recordInstallation(pool, seed, '12.000');
    expect(await pendingVariationOf(pool, seed.workItemId)).toBe(true);

    // The variation order arrives and the amendment raises the ceiling —
    // the one move the 0030 floor permits while an excess stands.
    await pool`
      update work_items set effective_quantity = '12.000'
      where id = ${seed.workItemId}
    `;
    expect(await pendingVariationOf(pool, seed.workItemId)).toBe(false);

    // And the floor still refuses the opposite move, which is what keeps
    // a measured excess from being paperwork'd away: the sanctioned
    // quantity cannot go back below the twelve that are in the ground.
    const refusal = await refused(pool`
      update work_items set effective_quantity = '10.000'
      where id = ${seed.workItemId}
    `);
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('amendment floor');
    expect(refusal.message).toContain('already-installed 12.000');
    expect(await pendingVariationOf(pool, seed.workItemId)).toBe(false);
  });

  it('refuses a hand-set variation flag no measurement supports', async () => {
    // The column is DERIVED. A direct writer that asserts it is corrected
    // in place rather than believed — the trigger recomputes on every
    // work_items write, in both directions.
    const seed = await seedWork(pool, '10.000');
    await pool`
      update work_items set pending_variation = true where id = ${seed.workItemId}
    `;
    expect(await pendingVariationOf(pool, seed.workItemId)).toBe(false);

    await recordInstallation(pool, seed, '11.000');
    await pool`
      update work_items set pending_variation = false where id = ${seed.workItemId}
    `;
    expect(await pendingVariationOf(pool, seed.workItemId)).toBe(true);
  });

  it(
    'raises the variation flag against two simultaneous recordings',
    async () => {
      const seed = await seedWork(pool, '10.000');
      const first = await pool.reserve();
      const second = await pool.reserve();
      try {
        const [firstBackend] = await first<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        const [secondBackend] = await second<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        if (!firstBackend || !secondBackend) throw new Error('no backend pid');

        await first.unsafe('begin');
        await second.unsafe('begin');

        // Six each: either alone fits under ten, together they do not.
        // Both are now accepted — what must not happen is that each one
        // reads its own six, concludes "not over", and leaves twelve
        // installed with nothing saying so.
        await first`
          insert into installations (
            organisation_id, work_id, work_item_id, quantity, installed_on,
            location_id, location_name, recorded_by_user_id
          )
          values (
            ${seed.organisationId}, ${seed.workId}, ${seed.workItemId}, '6.000',
            current_date, ${seed.locationId}, 'Ceiling site', 'ceiling-test'
          )
        `;
        const pending = second`
          insert into installations (
            organisation_id, work_id, work_item_id, quantity, installed_on,
            location_id, location_name, recorded_by_user_id
          )
          values (
            ${seed.organisationId}, ${seed.workId}, ${seed.workItemId}, '6.000',
            current_date, ${seed.locationId}, 'Ceiling site', 'ceiling-test'
          )
        `.catch((error: unknown) => error);

        // The second writer is genuinely parked on the work item row lock the
        // first writer's trigger took, not merely slower.
        await waitUntilBlockedOnLock(pool, secondBackend.pid);

        await first.unsafe('commit');
        const outcome = await pending;
        if (outcome instanceof Error) throw outcome;
        await second.unsafe('commit');

        const [installed] = await pool<{ total: string }[]>`
          select coalesce(sum(quantity), 0)::text as total from installations
          where work_item_id = ${seed.workItemId} and status = 'recorded'
        `;
        expect(installed?.total).toBe('12.000');
        expect(await pendingVariationOf(pool, seed.workItemId)).toBe(true);
      } finally {
        first.release();
        second.release();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'measures a waiting issue against a ceiling lowered while it waited',
    async () => {
      const seed = await seedWork(pool, '10.000');
      const challanId = await draftChallan(pool, seed, '8.000');
      const amender = await pool.reserve();
      const issuer = await pool.reserve();
      try {
        const [issuerBackend] = await issuer<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        if (!issuerBackend) throw new Error('no backend pid');

        await amender.unsafe('begin');
        await issuer.unsafe('begin');

        // An amendment takes the item row first, exactly as the apply path does.
        await amender`
          select id from work_items where id = ${seed.workItemId} for update
        `;
        const pending = issueChallan(issuer, challanId, 1).catch(
          (error: unknown) => error,
        );
        await waitUntilBlockedOnLock(pool, issuerBackend.pid);

        // Five is still above nothing delivered, so the 0030 floor permits it.
        await amender`
          update work_items set effective_quantity = '5.000'
          where id = ${seed.workItemId}
        `;
        await amender.unsafe('commit');

        const refusal = refusalOf(await pending);
        expect(refusal.code).toBe('23514');
        expect(refusal.message).toContain('8.000 against 5.000');
        await issuer.unsafe('rollback');
      } finally {
        amender.release();
        issuer.release();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('migration 0046 against a pre-0046 database', () => {
  it(
    'accepts over-ceiling delivery and installation writes before 0046 and refuses them after',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ceilings-'));
      const database = await createTemporaryDatabase();
      try {
        const pool = database.pool;
        await stageMigrations(directory, '0045');
        await runMigrations(pool, directory);

        const [staged] = await pool<{ id: string | null }[]>`
          select max(id) as id from schema_migrations
        `;
        expect(staged?.id).toBe('0045');

        // RED: on the audited database both writes are accepted, which is the
        // breach finding 2.1 describes — and the 0030 floor would then ratify
        // it forever.
        const before = await seedWork(pool, '10.000');
        const beforeChallan = await draftChallan(pool, before, '12.000');
        await issueChallan(pool, beforeChallan, 1);
        await recordInstallation(pool, before, '12.000');

        const [beforeState] = await pool<{ status: string; installed: string }[]>`
          select challan.status,
                 (
                   select coalesce(sum(i.quantity), 0)::text from installations i
                   where i.work_item_id = ${before.workItemId} and i.status = 'recorded'
                 ) as installed
          from delivery_challans challan where challan.id = ${beforeChallan}
        `;
        expect(beforeState).toEqual({ status: 'issued', installed: '12.000' });

        await copyFile(
          path.join(
            realMigrationsDirectory,
            '0046_quantity_ceilings_and_fk_indexes.sql',
          ),
          path.join(directory, '0046_quantity_ceilings_and_fk_indexes.sql'),
        );
        await runMigrations(pool, directory);

        // GREEN: the identical writes on an identical Work are now refused.
        const after = await seedWork(pool, '10.000');
        const afterChallan = await draftChallan(pool, after, '12.000');
        const deliveryRefusal = await refused(issueChallan(pool, afterChallan, 1));
        expect(deliveryRefusal.code).toBe('23514');
        expect(deliveryRefusal.message).toContain('delivery ceiling');
        const installationRefusal = await refused(
          recordInstallation(pool, after, '12.000'),
        );
        expect(installationRefusal.code).toBe('23514');
        expect(installationRefusal.message).toContain('installation ceiling');

        // 0046 refuses new breaches; it does not rewrite the history it found.
        const [preserved] = await pool<{ status: string }[]>`
          select status from delivery_challans where id = ${beforeChallan}
        `;
        expect(preserved?.status).toBe('issued');

        // The foreign keys that had no usable index now have one.
        const indexes = await pool<{ indexname: string }[]>`
          select indexname from pg_indexes
          where schemaname = 'public' and indexname in (
            'challan_item_serials_challan_idx', 'mb_entries_challan_idx',
            'work_items_schedule_idx', 'installation_serials_serial_idx',
            'eway_bills_invoice_idx', 'measurement_book_merge_provenance_record_idx',
            'loa_documents_confirmed_work_idx'
          )
          order by indexname
        `;
        expect(indexes.map((row) => row.indexname)).toEqual([
          'challan_item_serials_challan_idx',
          'eway_bills_invoice_idx',
          'installation_serials_serial_idx',
          'loa_documents_confirmed_work_idx',
          'mb_entries_challan_idx',
          'measurement_book_merge_provenance_record_idx',
          'work_items_schedule_idx',
        ]);
      } finally {
        await dropTemporaryDatabase(database);
        await rm(directory, { recursive: true, force: true });
      }
    },
    STAGED_TIMEOUT_MS,
  );

  it(
    'refuses to apply while a merged Measurement Book has no provenance row',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ceilings-'));
      const database = await createTemporaryDatabase();
      try {
        const pool = database.pool;
        await stageMigrations(directory, '0045');
        await runMigrations(pool, directory);

        const seed = await seedWork(pool, '10.000');
        const [consignee] = await pool<{ id: string }[]>`
          insert into contacts (
            organisation_id, designation, address, is_consignee, created_by_user_id
          )
          values (
            ${seed.organisationId}, 'Ceiling Consignee', 'Consignee address',
            true, 'ceiling-test'
          )
          returning id
        `;
        if (!consignee) throw new Error('consignee seed failed');
        const [target] = await pool<{ id: string }[]>`
          insert into measurement_books (
            organisation_id, work_id, kind, status, mb_date, created_by_user_id
          )
          values (
            ${seed.organisationId}, ${seed.workId}, 'on_account', 'draft',
            current_date, 'ceiling-test'
          )
          returning id
        `;
        if (!target) throw new Error('target measurement book seed failed');
        const [record] = await pool<{ id: string }[]>`
          insert into measurement_books (
            organisation_id, work_id, kind, status, mb_date,
            consignee_contact_id, created_by_user_id
          )
          values (
            ${seed.organisationId}, ${seed.workId}, 'record', 'draft',
            current_date, ${consignee.id}, 'ceiling-test'
          )
          returning id
        `;
        if (!record) throw new Error('record measurement book seed failed');

        // A non-route writer merges without leaving provenance — the loss
        // 0045's preflight/backfill asymmetry could not detect.
        await pool`
          update measurement_books
          set status = 'merged', merged_into_id = ${target.id}
          where id = ${record.id}
        `;

        await copyFile(
          path.join(
            realMigrationsDirectory,
            '0046_quantity_ceilings_and_fk_indexes.sql',
          ),
          path.join(directory, '0046_quantity_ceilings_and_fk_indexes.sql'),
        );
        const refusal = await refused(runMigrations(pool, directory));
        expect(refusal.message).toContain('no merge provenance row');
        const [ledger] = await pool<{ id: string | null }[]>`
          select max(id) as id from schema_migrations
        `;
        expect(ledger?.id).toBe('0045');

        // The repair the message names: restore the record to the shape the
        // 0045 insert guard demands, capture its provenance, merge again.
        await pool`
          update measurement_books set status = 'draft', merged_into_id = null
          where id = ${record.id}
        `;
        await pool`
          insert into measurement_book_merge_provenance (
            organisation_id, target_measurement_book_id,
            record_measurement_book_id, work_id, created_by_user_id
          )
          values (
            ${seed.organisationId}, ${target.id}, ${record.id}, ${seed.workId},
            'ceiling-test'
          )
        `;
        await pool`
          update measurement_books
          set status = 'merged', merged_into_id = ${target.id}
          where id = ${record.id}
        `;

        await runMigrations(pool, directory);
        const [repaired] = await pool<{ id: string | null }[]>`
          select max(id) as id from schema_migrations
        `;
        expect(repaired?.id).toBe('0046');
      } finally {
        await dropTemporaryDatabase(database);
        await rm(directory, { recursive: true, force: true });
      }
    },
    STAGED_TIMEOUT_MS,
  );

  it(
    'stops the tax invoice Measurement Book guard from reading another tenant',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ceilings-'));
      const database = await createTemporaryDatabase();
      try {
        const pool = database.pool;
        await stageMigrations(directory, '0045');
        await runMigrations(pool, directory);

        const invoicing = await seedWork(pool, '10.000');
        const neighbour = await seedWork(pool, '10.000');
        const [neighbourConsignee] = await pool<{ id: string }[]>`
          insert into contacts (
            organisation_id, designation, address, is_consignee, created_by_user_id
          )
          values (
            ${neighbour.organisationId}, 'Neighbour Consignee', 'Consignee address',
            true, 'ceiling-test'
          )
          returning id
        `;
        if (!neighbourConsignee) throw new Error('neighbour consignee seed failed');
        // A record Measurement Book that belongs to a DIFFERENT tenant. Only a
        // guard reading across tenants can say anything about its kind.
        const [foreignBook] = await pool<{ id: string }[]>`
          insert into measurement_books (
            organisation_id, work_id, kind, status, mb_date,
            consignee_contact_id, created_by_user_id
          )
          values (
            ${neighbour.organisationId}, ${neighbour.workId}, 'record', 'draft',
            current_date, ${neighbourConsignee.id}, 'ceiling-test'
          )
          returning id
        `;
        if (!foreignBook) throw new Error('foreign measurement book seed failed');
        const [buyer] = await pool<{ id: string }[]>`
          insert into contacts (
            organisation_id, designation, address, gstin, pincode, state_code,
            is_client, created_by_user_id
          )
          values (
            ${invoicing.organisationId}, 'Ceiling Buyer', 'Buyer address',
            '27AAAGM0289C1ZL', '400001', '27', true, 'ceiling-test'
          )
          returning id
        `;
        if (!buyer) throw new Error('buyer seed failed');

        const draftInvoice = (): Promise<unknown> => pool`
          insert into tax_invoices (
            organisation_id, status, invoice_date, sac_code, service_description,
            gst_rate, place_of_supply, buyer_contact_id, work_id,
            measurement_book_id, created_by_user_id
          )
          values (
            ${invoicing.organisationId}, 'draft', current_date, '998734',
            'Cross-tenant guard proof', '18.00', '27', ${buyer.id},
            ${invoicing.workId}, ${foreignBook.id}, 'ceiling-test'
          )
        `;

        // RED: the 0039 guard looked the Measurement Book up by id alone, so it
        // reported a neighbour tenant's book by kind before the composite
        // foreign key ever ran.
        const crossTenantRefusal = await refused(draftInvoice());
        expect(crossTenantRefusal.message).toContain('is a record MB');

        await copyFile(
          path.join(
            realMigrationsDirectory,
            '0046_quantity_ceilings_and_fk_indexes.sql',
          ),
          path.join(directory, '0046_quantity_ceilings_and_fk_indexes.sql'),
        );
        await runMigrations(pool, directory);

        // GREEN: outside its own tenant the book is simply not there.
        const scopedRefusal = await refused(draftInvoice());
        expect(scopedRefusal.message).toContain('is missing');
      } finally {
        await dropTemporaryDatabase(database);
        await rm(directory, { recursive: true, force: true });
      }
    },
    STAGED_TIMEOUT_MS,
  );
});
