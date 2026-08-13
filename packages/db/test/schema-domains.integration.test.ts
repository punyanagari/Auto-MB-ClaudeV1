import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { withTenant } from '../src/tenant.js';
import {
  SETUP_TIMEOUT_MS,
  type TemporaryDatabase,
  type Tenant,
  adminUrl,
  createTemporaryDatabase,
  dropStaleTemporaryDatabases,
  dropTemporaryDatabase,
  migrateThrough,
  migrateToHead,
  refused,
  seedTenant,
} from './support/invariant-db.js';

/**
 * The three value domains introduced by migration 0065, and the live-items
 * view that comes with them.
 *
 * The schema wrote the same three value shapes by hand more than seventy
 * times: a 64-character SHA-256 digest as `text` with an inline regex
 * CHECK, money as `numeric(18,2)`, and a measured quantity as
 * `numeric(18,3)`. A shape repeated by hand is a shape that drifts — a
 * future money column typed `numeric(12,2)` would have been accepted
 * silently. 0065 names each shape and adopts it everywhere, which lets the
 * rule below be absolute rather than a list with exceptions:
 *
 *   * no public table carries a bare `numeric(18,2)` or `numeric(18,3)`
 *     column;
 *   * every digest column uses `sha256_hex`.
 *
 * The first describe block proves the schema at 0064 fails both, so the
 * assertions are not passing on an empty set.
 */

/** This suite's own throwaway-database prefix; the stale sweep is scoped
 * to it so a sibling suite running in parallel is never disturbed. */
const PREFIX = 'auto_mb_domains_test_';

const DIGEST_COLUMN = /(sha256|hash)/;

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly type: string;
}

/** Every column of every public BASE TABLE with its rendered type; a
 * domain renders as the domain's name, which is exactly the difference
 * this suite asserts on. */
function readColumns(pool: Sql): Promise<ColumnRow[]> {
  return pool<ColumnRow[]>`
    select c.relname as table_name, a.attname as column_name,
           format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum
  `;
}

let admin: Sql;
/**
 * One database carries both halves: it is staged at 0064, inspected, then
 * migrated the rest of the way and inspected again. Same rows, same
 * cluster, one migration run instead of two.
 */
let database: TemporaryDatabase;
let disposeStaging: () => Promise<void>;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-domains-admin',
  });
  await admin`select 1 as ready`;
  await dropStaleTemporaryDatabases(admin, PREFIX);
  database = await createTemporaryDatabase(admin, PREFIX);
  disposeStaging = await migrateThrough(database, '0064');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  try {
    if (database) await dropTemporaryDatabase(admin, database);
    if (disposeStaging) await disposeStaging();
  } finally {
    await admin?.end();
  }
}, SETUP_TIMEOUT_MS);

describe('the schema at 0064 has no domains and no live-items view', () => {
  it('declares none of the three domains', async () => {
    const rows = await database.pool<{ typname: string }[]>`
      select t.typname from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typtype = 'd'
    `;
    expect(rows.map((row) => row.typname)).toEqual([]);
  });

  it('writes the money and quantity shapes by hand instead', async () => {
    const columns = await readColumns(database.pool);
    const bare = columns.filter(
      (column) => column.type === 'numeric(18,2)' || column.type === 'numeric(18,3)',
    );
    expect(bare.length).toBe(52);
    const digests = columns.filter(
      (column) => DIGEST_COLUMN.test(column.column_name) && column.type === 'text',
    );
    expect(digests.length).toBeGreaterThanOrEqual(20);
  });

  it('has no work_items_live relation', async () => {
    const rows = await database.pool<{ relname: string }[]>`
      select relname from pg_class where relname = 'work_items_live'
    `;
    expect(rows).toEqual([]);
  });
});

describe('the schema at head names all three shapes', () => {
  let columns: ColumnRow[];

  beforeAll(async () => {
    await migrateToHead(database);
    columns = await readColumns(database.pool);
  }, SETUP_TIMEOUT_MS);

  it('declares the three domains over the right base types', async () => {
    const rows = await database.pool<
      { typname: string; base: string; constraints: string | null }[]
    >`
      select t.typname,
             format_type(t.typbasetype, t.typtypmod) as base,
             (select string_agg(pg_get_constraintdef(con.oid), ' | ')
                from pg_constraint con where con.contypid = t.oid) as constraints
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typtype = 'd'
      order by t.typname
    `;
    expect(rows.map((row) => row.typname)).toEqual([
      'money_amount',
      'quantity_amount',
      'sha256_hex',
    ]);
    expect(rows.find((row) => row.typname === 'money_amount')?.base).toBe(
      'numeric(18,2)',
    );
    expect(rows.find((row) => row.typname === 'quantity_amount')?.base).toBe(
      'numeric(18,3)',
    );
    const digest = rows.find((row) => row.typname === 'sha256_hex');
    expect(digest?.base).toBe('text');
    expect(digest?.constraints).toContain('[0-9a-f]{64}');
  });

  it('leaves no bare money or quantity column anywhere', () => {
    const bare = columns
      .filter(
        (column) => column.type === 'numeric(18,2)' || column.type === 'numeric(18,3)',
      )
      .map((column) => `${column.table_name}.${column.column_name} ${column.type}`);
    expect(
      bare,
      `columns still written as a bare numeric shape: ${bare.join(', ')}. ` +
        'Money is money_amount and a measured quantity is quantity_amount; ' +
        'the whole point of naming them is that the next column cannot ' +
        'quietly pick a different precision.',
    ).toEqual([]);
    // ...and the adoption really happened, rather than the columns having
    // been dropped.
    const adopted = columns.filter(
      (column) => column.type === 'money_amount' || column.type === 'quantity_amount',
    );
    expect(adopted.length).toBe(55);
  });

  it('types every digest column as sha256_hex', () => {
    const wrong = columns
      .filter(
        (column) =>
          DIGEST_COLUMN.test(column.column_name) && column.type !== 'sha256_hex',
      )
      .map((column) => `${column.table_name}.${column.column_name} ${column.type}`);
    expect(wrong, `digest columns not typed sha256_hex: ${wrong.join(', ')}`).toEqual(
      [],
    );
    expect(columns.filter((column) => column.type === 'sha256_hex').length).toBe(22);
  });

  it('refuses a value the digest domain does not admit', async () => {
    const tenant = await seedTenant(database.pool);
    const refusal = await refused(
      database.pool`
        insert into loa_documents (
          organisation_id, object_key, original_filename, media_type,
          size_bytes, sha256, uploaded_by_user_id
        )
        values (
          ${tenant.organisationId}, ${`loa/${randomUUID()}.pdf`}, 'notice.pdf',
          'application/pdf', 1024, 'not-a-digest', 'domain-test'
        )
      `,
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('sha256_hex');
  });

  it('keeps the three tax-invoice triggers 0065 rebuilt around the ALTERs', async () => {
    // The money columns of tax_invoices are named in BEFORE UPDATE OF
    // trigger lists, which blocks ALTER COLUMN TYPE; 0065 drops and
    // recreates exactly three triggers to get past it. If one came back
    // wrong, the money guard it carries would be gone.
    const rows = await database.pool<{ tgname: string; definition: string }[]>`
      select t.tgname, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname = 'tax_invoices'
        and t.tgname in (
          'tax_invoices_render_pointer_guard',
          'tax_invoices_split_place_guard',
          'tax_invoices_tax_heads_guard'
        )
      order by t.tgname
    `;
    expect(rows.map((row) => row.tgname)).toEqual([
      'tax_invoices_render_pointer_guard',
      'tax_invoices_split_place_guard',
      'tax_invoices_tax_heads_guard',
    ]);
    expect(rows[0]?.definition).toContain(
      'UPDATE OF template_version, rendered_object_key, rendered_sha256',
    );
    expect(rows[1]?.definition).toContain(
      'INSERT OR UPDATE OF status, place_of_supply, cgst_amount, sgst_amount, igst_amount',
    );
    expect(rows[2]?.definition).toContain(
      'INSERT OR UPDATE OF status, line_shape, gst_rate, taxable_value, cgst_amount, sgst_amount, igst_amount',
    );
  });

  describe('work_items_live', () => {
    let tenant: Tenant;
    let liveId: string;
    let deletedId: string;

    beforeAll(async () => {
      tenant = await seedTenant(database.pool);
      const [schedule] = await database.pool<{ id: string }[]>`
        insert into work_schedules (organisation_id, work_id, schedule_code, title, position)
        values (${tenant.organisationId}, ${tenant.workId}, 'A', 'Schedule A', 1)
        returning id
      `;
      if (!schedule) throw new Error('schedule seed failed');
      const [live] = await database.pool<{ id: string }[]>`
        insert into work_items (
          organisation_id, work_id, schedule_id, item_number, description,
          unit_code, awarded_quantity, effective_rate
        )
        values (
          ${tenant.organisationId}, ${tenant.workId}, ${schedule.id}, 'A/1',
          'Point machine', 'Nos', 5.000, 100.00
        )
        returning id
      `;
      const [deleted] = await database.pool<{ id: string }[]>`
        insert into work_items (
          organisation_id, work_id, schedule_id, item_number, description,
          unit_code, awarded_quantity, effective_rate, deleted_at
        )
        values (
          ${tenant.organisationId}, ${tenant.workId}, ${schedule.id}, 'A/2',
          'Omitted item', 'Nos', 2.000, 50.00, now()
        )
        returning id
      `;
      if (!live || !deleted) throw new Error('work item seed failed');
      liveId = live.id;
      deletedId = deleted.id;
    }, SETUP_TIMEOUT_MS);

    it('hides soft-deleted items', async () => {
      const rows = await database.pool<{ id: string }[]>`
        select id from work_items_live where work_id = ${tenant.workId}
      `;
      expect(rows.map((row) => row.id)).toEqual([liveId]);
      const all = await database.pool<{ id: string }[]>`
        select id from work_items where work_id = ${tenant.workId} order by item_number
      `;
      expect(all.map((row) => row.id).sort()).toEqual([liveId, deletedId].sort());
    });

    it('is security_invoker, so tenancy is the base table policy', async () => {
      const [view] = await database.pool<{ options: string[] | null }[]>`
        select reloptions as options from pg_class
        where relname = 'work_items_live' and relkind = 'v'
      `;
      expect(view?.options ?? []).toContain('security_invoker=true');
    });

    it('shows another tenant nothing through the application role', async () => {
      const other = await seedTenant(database.pool);
      const mine = await withTenant(
        database.appPool,
        { organisationId: tenant.organisationId, userId: tenant.userId },
        (tx) => tx<{ id: string }[]>`select id from work_items_live`,
      );
      expect(mine.map((row) => row.id)).toEqual([liveId]);
      const theirs = await withTenant(
        database.appPool,
        { organisationId: other.organisationId, userId: other.userId },
        (tx) => tx<{ id: string }[]>`select id from work_items_live`,
      );
      expect(theirs).toEqual([]);
    });

    it('answers nothing at all without a bound tenant', async () => {
      const rows = (await database.appPool.unsafe(
        'select count(*)::int as count from work_items_live',
      )) as unknown as { count: number }[];
      expect(rows[0]?.count).toBe(0);
    });
  });
});
