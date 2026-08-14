import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';

/*
 * Migration 0071: the database half of superseding a confirmed Work.
 *
 * TWO HOLES THIS FILE EXISTS TO CLOSE, both provable on the pre-fix
 * schema and both closed on the current one. Each is asserted twice — once
 * against a database staged through migration 0070, where it succeeds, and
 * once against the full schema, where it is refused. The staged half is
 * the pack's guard-fails-on-the-pre-fix-tree proof, kept in the repository
 * rather than run once and written down.
 *
 *   1. `works.deleted_at` has existed since migration 0001 with no writer
 *      and no guard. Every read filters on it, so setting it hides a Work
 *      from the whole product — and before 0071 it could be set on a Work
 *      carrying issued challans, installations and invoices, which stay in
 *      their registers pointing at a Work nothing can open.
 *
 *   2. A confirmed LOA document could be returned to 'review' with its
 *      `confirmed_work_id` cleared. Migration 0055 guards the DISCARD
 *      transition of a confirmed document and only that one, so the letter
 *      a live Work's every item cites as its source evidence could quietly
 *      stop admitting the Work existed.
 *
 * The rest of the file is the rule itself: what may be superseded, what
 * may not, and what a superseded Work and its released letter may still do.
 */

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';

const here = path.dirname(fileURLToPath(import.meta.url));
const realMigrationsDirectory = path.resolve(here, '..', 'migrations');

const TEST_TIMEOUT_MS = 120_000;

let admin: Sql;

interface TemporaryDatabase {
  readonly name: string;
  readonly pool: Sql;
}

/** The schema before 0071, and the schema with it. Built once each. */
let preFix: TemporaryDatabase;
let current: TemporaryDatabase;

async function createTemporaryDatabase(): Promise<TemporaryDatabase> {
  const name = `auto_mb_supersede_test_${randomBytes(6).toString('hex')}`;
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    name,
    pool: createDatabasePool({
      url: url.toString(),
      max: 4,
      applicationName: 'auto-mb-supersede-test',
    }),
  };
}

async function dropTemporaryDatabase(database: TemporaryDatabase): Promise<void> {
  try {
    await database.pool.end({ timeout: 5 });
  } catch {
    // A wedged pool must not stop the drop; `with (force)` clears it.
  }
  await admin.unsafe(`drop database if exists ${database.name} with (force)`);
}

/** Migrates a fresh database with only the migrations up to `throughId`. */
async function migratedThrough(throughId: string): Promise<TemporaryDatabase> {
  const database = await createTemporaryDatabase();
  const staging = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-supersede-'));
  try {
    const names = (await readdir(realMigrationsDirectory))
      .filter((name) => name.endsWith('.sql') && name.slice(0, 4) <= throughId)
      .sort();
    for (const name of names) {
      await copyFile(
        path.join(realMigrationsDirectory, name),
        path.join(staging, name),
      );
    }
    await runMigrations(database.pool, staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return database;
}

interface Seed {
  readonly organisationId: string;
  readonly workId: string;
  readonly workCode: string;
  readonly letterNumber: string;
  readonly scheduleId: string;
  readonly workItemId: string;
  readonly loaDocumentId: string;
}

/** One tenant, one confirmed Work, and the LOA document it was confirmed
 * from — the exact shape the supersede rule talks about. */
async function seedConfirmedWork(pool: Sql): Promise<Seed> {
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  const [organisation] = await pool<{ id: string }[]>`
    insert into organisations (name, slug)
    values (${`Supersede tenant ${suffix}`}, ${`supersede-${suffix.toLowerCase()}`})
    returning id
  `;
  if (!organisation) throw new Error('organisation seed failed');
  const workCode = `W${suffix}`;
  const letterNumber = `LOA/${suffix}`;
  const [work] = await pool<{ id: string }[]>`
    insert into works (
      organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${organisation.id}, ${workCode}, ${letterNumber}, '2026-01-01',
      'Supersede fixture work', '100000.00', '100000.00', 'per_schedule',
      'supersede-test'
    )
    returning id
  `;
  if (!work) throw new Error('work seed failed');
  const [schedule] = await pool<{ id: string }[]>`
    insert into work_schedules (
      organisation_id, work_id, schedule_code, title, position
    )
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
      'Supersede fixture item', 'NOS', '10.000', '100.000000'
    )
    returning id
  `;
  if (!item) throw new Error('work item seed failed');
  const [document] = await pool<{ id: string }[]>`
    insert into loa_documents (
      organisation_id, object_key, original_filename, sha256, media_type,
      size_bytes, uploaded_by_user_id, extraction_status, confirmed_work_id
    )
    values (
      ${organisation.id}, ${`${organisation.id}/loa/${suffix}.pdf`},
      ${`${suffix}.pdf`}, ${randomBytes(32).toString('hex')},
      'application/pdf', 2048, 'supersede-test', 'confirmed', ${work.id}
    )
    returning id
  `;
  if (!document) throw new Error('LOA document seed failed');
  return {
    organisationId: organisation.id,
    workId: work.id,
    workCode,
    letterNumber,
    scheduleId: schedule.id,
    workItemId: item.id,
    loaDocumentId: document.id,
  };
}

/** A bare additional Work in an existing tenant, for the successor tests. */
async function addWork(
  pool: Sql,
  organisationId: string,
  tag: string,
): Promise<string> {
  const suffix = randomBytes(3).toString('hex').toUpperCase();
  const [work] = await pool<{ id: string }[]>`
    insert into works (
      organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${organisationId}, ${`W${suffix}`}, ${`LOA/${tag}/${suffix}`}, '2026-01-01',
      ${`Supersede fixture ${tag}`}, '100000.00', '100000.00', 'per_schedule',
      'supersede-test'
    )
    returning id
  `;
  if (!work) throw new Error('extra work seed failed');
  return work.id;
}

/** A draft Delivery Challan: the cheapest downstream document to make. */
async function addChallan(pool: Sql, seed: Seed): Promise<string> {
  const [challan] = await pool<{ id: string }[]>`
    insert into delivery_challans (
      organisation_id, work_id, challan_date, prefix, consignee_snapshot,
      created_by_user_id
    )
    values (
      ${seed.organisationId}, ${seed.workId}, '2026-02-01', 'DC',
      ${pool.json({ name: 'Supersede consignee', address: 'Somewhere' })},
      'supersede-test'
    )
    returning id
  `;
  if (!challan) throw new Error('challan seed failed');
  return challan.id;
}

/** The approval request a supersession must name, and the supersession
 * itself. Written the way `applyWorkSupersede` writes it. */
async function supersede(
  pool: Sql,
  seed: Seed,
): Promise<{ readonly approvalId: string; readonly supersessionId: string }> {
  const [approval] = await pool<{ id: string }[]>`
    insert into approval_requests (
      organisation_id, entity_type, entity_id, work_id, proposed, diff,
      reason, requested_by_user_id
    )
    values (
      ${seed.organisationId}, 'work_supersede', ${seed.workId}, ${seed.workId},
      ${pool.json({ kind: 'work_supersede' })}, ${pool.json([])},
      'The letter was read at the advertised rates.', 'supersede-test'
    )
    returning id
  `;
  if (!approval) throw new Error('approval seed failed');
  const [supersession] = await pool<{ id: string }[]>`
    insert into work_supersessions (
      organisation_id, superseded_work_id, loa_document_id,
      approval_request_id, reason, superseded_by_user_id
    )
    values (
      ${seed.organisationId}, ${seed.workId}, ${seed.loaDocumentId},
      ${approval.id}, 'The letter was read at the advertised rates.',
      'supersede-test'
    )
    returning id
  `;
  if (!supersession) throw new Error('supersession seed failed');
  await pool`update works set deleted_at = now() where id = ${seed.workId}`;
  await pool`
    update loa_documents
    set extraction_status = 'review', confirmed_work_id = null
    where id = ${seed.loaDocumentId}
  `;
  return { approvalId: approval.id, supersessionId: supersession.id };
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-supersede-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the work-supersession tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }
  const stale = await admin<{ datname: string }[]>`
    select datname from pg_database where datname like 'auto_mb_supersede_test_%'
  `;
  for (const database of stale) {
    await admin.unsafe(`drop database if exists ${database.datname} with (force)`);
  }
  preFix = await migratedThrough('0070');
  current = await migratedThrough('0071');
}, 300_000);

afterAll(async () => {
  try {
    if (preFix !== undefined) await dropTemporaryDatabase(preFix);
    if (current !== undefined) await dropTemporaryDatabase(current);
  } finally {
    await admin?.end();
  }
  // Two forced drops, and a forced drop waits on whatever the pools left
  // behind: well outside the default ten-second hook budget on a loaded
  // machine.
}, 120_000);

describe('the pre-0071 schema, where the holes are', () => {
  it(
    'lets a Work carrying a delivery challan be soft-deleted out of the product',
    async () => {
      const seed = await seedConfirmedWork(preFix.pool);
      await addChallan(preFix.pool, seed);

      await expect(
        preFix.pool`update works set deleted_at = now() where id = ${seed.workId}`,
      ).resolves.toBeDefined();

      // And the challan is still there, in a register, naming a Work that
      // every read in the product now filters away.
      const [challans] = await preFix.pool<{ count: number }[]>`
        select count(*)::int as count from delivery_challans
        where work_id = ${seed.workId}
      `;
      expect(challans?.count).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lets a confirmed LOA document stop admitting the live Work it produced',
    async () => {
      const seed = await seedConfirmedWork(preFix.pool);

      await expect(
        preFix.pool`
          update loa_documents
          set extraction_status = 'review', confirmed_work_id = null
          where id = ${seed.loaDocumentId}
        `,
      ).resolves.toBeDefined();

      const [work] = await preFix.pool<{ deleted_at: Date | null }[]>`
        select deleted_at from works where id = ${seed.workId}
      `;
      expect(work?.deleted_at).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the works soft-delete guard', () => {
  it(
    'refuses a soft delete that no supersession asked for',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      await expect(
        current.pool`update works set deleted_at = now() where id = ${seed.workId}`,
      ).rejects.toThrow(/citing a live supersede request/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a soft delete while a downstream document names the Work',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      await addChallan(current.pool, seed);
      await expect(supersede(current.pool, seed)).rejects.toThrow(
        /while a delivery challan names it/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a soft delete while a live change request names the Work',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      await current.pool`
        insert into approval_requests (
          organisation_id, entity_type, entity_id, work_id, proposed, diff,
          reason, requested_by_user_id
        )
        values (
          ${seed.organisationId}, 'work_item_amendment', ${seed.workItemId},
          ${seed.workId}, ${current.pool.json({ kind: 'change_item' })},
          ${current.pool.json([])}, 'Quantity understated in the letter.',
          'supersede-test'
        )
      `;
      await expect(supersede(current.pool, seed)).rejects.toThrow(
        /while a live change request names it/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lets a rejected change request through — it moved nothing',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      await current.pool`
        insert into approval_requests (
          organisation_id, entity_type, entity_id, work_id, proposed, diff,
          reason, requested_by_user_id, status, decided_by_user_id,
          decided_at, decision_note
        )
        values (
          ${seed.organisationId}, 'work_item_amendment', ${seed.workItemId},
          ${seed.workId}, ${current.pool.json({ kind: 'change_item' })},
          ${current.pool.json([])}, 'Quantity understated in the letter.',
          'supersede-test', 'rejected', 'supersede-test', now(),
          'The letter says what it says.'
        )
      `;
      await expect(supersede(current.pool, seed)).resolves.toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'freezes the Work once it is superseded, including the stamp itself',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      await supersede(current.pool, seed);

      await expect(
        current.pool`
          update works set title = 'Rewritten after the fact'
          where id = ${seed.workId}
        `,
      ).rejects.toThrow(/superseded and is immutable/);
      await expect(
        current.pool`update works set deleted_at = null where id = ${seed.workId}`,
      ).rejects.toThrow(/superseded and is immutable/);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the LOA release guard', () => {
  it(
    'refuses to release the letter of a live Work',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      await expect(
        current.pool`
          update loa_documents
          set extraction_status = 'review', confirmed_work_id = null
          where id = ${seed.loaDocumentId}
        `,
      ).rejects.toThrow(/source of truth of a live Work/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses any exit from confirmation other than back to review',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      await expect(
        current.pool`
          update loa_documents set extraction_status = 'pending', confirmed_work_id = null
          where id = ${seed.loaDocumentId}
        `,
      ).rejects.toThrow(/only by returning to review with no Work/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'releases the letter once its Work is superseded, and lets it be discarded',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      await supersede(current.pool, seed);

      const [document] = await current.pool<
        { extraction_status: string; confirmed_work_id: string | null }[]
      >`
        select extraction_status, confirmed_work_id from loa_documents
        where id = ${seed.loaDocumentId}
      `;
      expect(document?.extraction_status).toBe('review');
      expect(document?.confirmed_work_id).toBeNull();

      // The remedy migration 0063 prescribes, now reachable: a letter whose
      // percentages cannot be read may be thrown away and uploaded again.
      await expect(
        current.pool`
          update loa_documents
          set extraction_status = 'discarded', discarded_at = now(),
              discarded_by_user_id = 'supersede-test',
              discard_reason = 'The scan is illegible at the schedule headers.'
          where id = ${seed.loaDocumentId}
        `,
      ).resolves.toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * Confirms the successor: the Work row and its binding, in ONE
 * transaction.
 *
 * The two halves cannot be separated. The reserved-identity guard is a
 * DEFERRED constraint trigger, so it asks "is this row the successor?" at
 * COMMIT — inserting the Work in one transaction and binding it in the
 * next means the first commit sees an unbound supersession still holding
 * the identity, and is refused. That is the guard working: in the product
 * both halves are the confirm route's single transaction.
 */
async function confirmSuccessor(
  pool: Sql,
  seed: Seed,
  supersessionId: string,
  title = 'Successor work',
): Promise<string> {
  return pool.begin(async (tx) => {
    const [successor] = await tx<{ id: string }[]>`
      insert into works (
        organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${seed.organisationId}, ${seed.workCode}, ${seed.letterNumber},
        '2026-01-01', ${title}, '100000.00', '100000.00', 'per_schedule',
        'supersede-test'
      )
      returning id
    `;
    if (!successor) throw new Error('successor insert returned no row');
    await tx`
      update work_supersessions
      set successor_work_id = ${successor.id}, successor_bound_at = now(),
          successor_bound_by_user_id = 'supersede-test'
      where id = ${supersessionId}
    `;
    return successor.id;
  });
}

describe('the guard reads the approval it is shown', () => {
  /** Writes a supersession citing `approvalId` and tries the soft delete. */
  async function withdrawCiting(seed: Seed, approvalId: string): Promise<void> {
    await current.pool`
      insert into work_supersessions (
        organisation_id, superseded_work_id, loa_document_id,
        approval_request_id, reason, superseded_by_user_id
      )
      values (
        ${seed.organisationId}, ${seed.workId}, ${seed.loaDocumentId},
        ${approvalId}, 'The letter was read at the advertised rates.',
        'supersede-test'
      )
    `;
    await current.pool`update works set deleted_at = now() where id = ${seed.workId}`;
  }

  async function approvalRow(
    seed: Seed,
    fields: {
      readonly entityType: string;
      readonly status: string;
      readonly workId?: string;
      readonly entityId?: string;
    },
  ): Promise<string> {
    const decided = fields.status !== 'pending';
    const [approval] = await current.pool<{ id: string }[]>`
      insert into approval_requests (
        organisation_id, entity_type, entity_id, work_id, proposed, diff,
        reason, requested_by_user_id, status, decided_by_user_id, decided_at,
        decision_note
      )
      values (
        ${seed.organisationId}, ${fields.entityType},
        ${fields.entityId ?? seed.workId}, ${fields.workId ?? seed.workId},
        ${current.pool.json({ kind: 'work_supersede' })}, ${current.pool.json([])},
        'A reason of at least three characters.', 'supersede-test',
        ${fields.status}, ${decided ? 'supersede-test' : null},
        ${decided ? new Date() : null},
        ${fields.status === 'rejected' ? 'The letter says what it says.' : null}
      )
      returning id
    `;
    if (!approval) throw new Error('approval seed failed');
    return approval.id;
  }

  it(
    'refuses a supersession citing a REJECTED supersede request',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      const approvalId = await approvalRow(seed, {
        entityType: 'work_supersede',
        status: 'rejected',
      });
      await expect(withdrawCiting(seed, approvalId)).rejects.toThrow(
        /citing a live supersede request/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a supersession citing an approval of a different KIND',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      const approvalId = await approvalRow(seed, {
        entityType: 'work_item_amendment',
        status: 'approved',
        entityId: seed.workItemId,
      });
      await expect(withdrawCiting(seed, approvalId)).rejects.toThrow(
        /citing a live supersede request/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a supersession citing another Work's supersede request",
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      const other = await addWork(current.pool, seed.organisationId, 'OTHER');
      const approvalId = await approvalRow(seed, {
        entityType: 'work_supersede',
        status: 'pending',
        workId: other,
        entityId: other,
      });
      await expect(withdrawCiting(seed, approvalId)).rejects.toThrow(
        /citing a live supersede request/,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the reserved identity', () => {
  it(
    'holds the freed work code for the successor, and releases it on discard',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      await supersede(current.pool, seed);

      // The identity is free of the unique index but reserved by the
      // deferred guard, which speaks at COMMIT.
      await expect(
        current.pool.begin(async (tx) => {
          await tx`
            insert into works (
              organisation_id, work_code, letter_number, letter_date, title,
              advertised_value, contract_value, pricing_shape, created_by_user_id
            )
            values (
              ${seed.organisationId}, ${seed.workCode}, ${`LOA/UNRELATED/${seed.workCode}`},
              '2026-01-01', 'An unrelated Work stealing the code', '1.00', '1.00',
              'per_schedule', 'supersede-test'
            )
          `;
        }),
      ).rejects.toThrow(/reserved for the successor/);

      // Discarding the released letter ends the reservation: no successor
      // can ever arrive through it. The guard reads the supersession's own
      // stamp rather than the document's status, deliberately — it runs at
      // COMMIT of every works INSERT, and reading loa_documents there
      // would make every Work creation wait on any lock held on that
      // table. The route writes both together; the test does the same.
      await current.pool.begin(async (tx) => {
        await tx`
          update loa_documents
          set extraction_status = 'discarded', discarded_at = now(),
              discarded_by_user_id = 'supersede-test',
              discard_reason = 'The scan is illegible at the schedule headers.'
          where id = ${seed.loaDocumentId}
        `;
        await tx`
          update work_supersessions set released_letter_discarded_at = now()
          where loa_document_id = ${seed.loaDocumentId}
            and successor_work_id is null
        `;
      });
      await expect(
        current.pool`
          insert into works (
            organisation_id, work_code, letter_number, letter_date, title,
            advertised_value, contract_value, pricing_shape, created_by_user_id
          )
          values (
            ${seed.organisationId}, ${seed.workCode}, ${`LOA/REUPLOAD/${seed.workCode}`},
            '2026-01-01', 'The re-uploaded letter''s Work', '1.00', '1.00',
            'per_schedule', 'supersede-test'
          )
        `,
      ).resolves.toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the successor', () => {
  it(
    'reuses the contract identity a superseded Work no longer claims',
    async () => {
      const seed = await seedConfirmedWork(current.pool);

      // Before: the identity is taken.
      await expect(
        current.pool`
          insert into works (
            organisation_id, work_code, letter_number, letter_date, title,
            advertised_value, contract_value, pricing_shape, created_by_user_id
          )
          values (
            ${seed.organisationId}, ${seed.workCode}, ${seed.letterNumber},
            '2026-01-01', 'Successor work', '100000.00', '100000.00',
            'per_schedule', 'supersede-test'
          )
        `,
      ).rejects.toThrow();

      const { supersessionId } = await supersede(current.pool, seed);

      const successorId = await confirmSuccessor(current.pool, seed, supersessionId);
      expect(successorId).toBeDefined();

      // Provenance in both directions, from one row.
      const [forward] = await current.pool<{ successor_work_id: string }[]>`
        select successor_work_id from work_supersessions
        where superseded_work_id = ${seed.workId}
      `;
      expect(forward?.successor_work_id).toBe(successorId);
      const [backward] = await current.pool<{ superseded_work_id: string }[]>`
        select superseded_work_id from work_supersessions
        where successor_work_id = ${successorId}
      `;
      expect(backward?.superseded_work_id).toBe(seed.workId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is bound once and never rewritten',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      const { supersessionId } = await supersede(current.pool, seed);
      // Both candidates belong to the superseded Work's own organisation:
      // every reference here is org-paired, so a successor from another
      // tenant is refused by the foreign key before any rule speaks.
      const first = await addWork(current.pool, seed.organisationId, 'FIRST');
      const second = await addWork(current.pool, seed.organisationId, 'SECOND');

      await current.pool`
        update work_supersessions
        set successor_work_id = ${first}, successor_bound_at = now(),
            successor_bound_by_user_id = 'supersede-test'
        where id = ${supersessionId}
      `;
      await expect(
        current.pool`
          update work_supersessions set successor_work_id = ${second}
          where id = ${supersessionId}
        `,
      ).rejects.toThrow(/already names its successor/);
      await expect(
        current.pool`
          update work_supersessions set reason = 'Something else entirely'
          where id = ${supersessionId}
        `,
      ).rejects.toThrow(/immutable/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a THIRD live Work on the shared identity',
    async () => {
      // The direction the partial index has to hold once the successor is
      // live: reuse is a one-for-one replacement, not a licence to keep
      // adding Works under one contract's identity.
      const seed = await seedConfirmedWork(current.pool);
      const { supersessionId } = await supersede(current.pool, seed);
      await confirmSuccessor(current.pool, seed, supersessionId);

      await expect(
        current.pool`
          insert into works (
            organisation_id, work_code, letter_number, letter_date, title,
            advertised_value, contract_value, pricing_shape, created_by_user_id
          )
          values (
            ${seed.organisationId}, ${seed.workCode}, ${seed.letterNumber},
            '2026-01-01', 'A third claimant', '100000.00', '100000.00',
            'per_schedule', 'supersede-test'
          )
        `,
      ).rejects.toThrow(/works_live_work_code_key/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'freezes the whole binding once the successor is named',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      const { supersessionId } = await supersede(current.pool, seed);
      await confirmSuccessor(current.pool, seed, supersessionId);

      // Not only the id: the stamps that say when and by whom. A binding
      // whose actor can be rewritten is not evidence of who re-created the
      // Work.
      await expect(
        current.pool`
          update work_supersessions set successor_bound_by_user_id = 'someone-else'
          where id = ${supersessionId}
        `,
      ).rejects.toThrow(/already names its successor/);
      await expect(
        current.pool`
          update work_supersessions set successor_bound_at = now() - interval '1 day'
          where id = ${supersessionId}
        `,
      ).rejects.toThrow(/already names its successor/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a second supersession of the same Work',
    async () => {
      const seed = await seedConfirmedWork(current.pool);
      await supersede(current.pool, seed);
      // The Work is frozen, so the second attempt cannot even reach the
      // unique index; both refusals are the rule, stated once each.
      await expect(supersede(current.pool, seed)).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );
});
