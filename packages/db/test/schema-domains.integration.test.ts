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
    // 55 before 0082, which adds inspection_clauses.inspection_quantity
    // and inspection_call_items.quantity; 0080 adds four money columns
    // of its own (the payment-request amount, the vendor-invoice amount,
    // and the vendor payment's gross/tds/net less the two counted as one
    // pair) plus the TDS taxable amount; 0083 adds a tender's estimated
    // value and its EMD; 0084 adds one, the bill-of-material line
    // quantity — a job card's own quantity is a whole-unit integer, not
    // a measured quantity, because every unit becomes a serial; and 0087
    // adds three, the item's reorder level and the stock movement's own
    // quantity and running balance; 0088 adds five, all quantities of
    // material — what a maintenance line asked for, how much of it is
    // owed back, how much was written off, how much went on one challan,
    // and how much came back defective; 0089 adds twelve — the employee's
    // six salary and declaration figures, the four bounds and amounts of a
    // profession-tax band, and an income-tax band's two — and 0090
    // nineteen, which is a payslip: four earnings heads and their gross,
    // the provident-fund wage and its three contributions and pension
    // ceiling, the insurance wage, two shares and ceiling, the profession
    // tax, the two annual projections, the tax deducted, and the net;
    // and 0098 adds six — the retention release's amount, and the five
    // money figures of a liquidated-damages assessment: the basis it is
    // charged on, the uncapped figure, the cap, the assessment itself and
    // what the railway actually levied. Four of those five are GENERATED
    // columns, and adopting the domain on a generated column is what
    // keeps the arithmetic at the scale money is stored rather than at
    // whatever the expression happened to produce.
    //
    // 0104 adds the twelfth and last of them: the Work's contract value
    // as it stood when an assessment was made, snapshotted onto the row
    // so the cap can be generated from it. The owner ruling of
    // 2026-08-19 made the cap a percentage of the whole contract rather
    // than of the assessment basis, and a generated column cannot reach
    // another table for the figure.
    //
    // 0106 adds two more, both on `mb_measured_overrides`: the supplied
    // and installed quantities an operator reduced a draft Measurement
    // Book's line to. They are quantities that are compared against
    // `delivery_challan_items.quantity` and `installations.quantity`
    // inside a trigger, so a different precision here would be a silent
    // rounding difference on a comparison that decides what is billed.
    //
    // 0115 adds nine, all of them figures another system computed: the
    // historical invoice's sub-total, total, balance and round-off, and
    // its lines' line total and three tax-head amounts, plus the line
    // quantity. They are stored and never recomputed — the 0052 backstops
    // judge invoices this application raised — and adopting the domains is
    // what stops a register of somebody else's arithmetic being held at a
    // precision this schema does not use anywhere else.
    //
    // NINE and not ten: the line's `item_price` is a RATE and takes 0027's
    // numeric(18,6) instead. The real export carries three fraction digits
    // there, so money scale would have rounded a unit price away in
    // silence — which is the exact failure the domains exist to make
    // impossible, arrived at from the other direction.
    //
    // 0114 adds twelve, all on the opening billing position of a
    // pre-system Work: the recorded bill's own amount, the four stage
    // quantities and the amount of a baseline line, the same five again
    // as the machine's un-overwritten proposal, and the deduction
    // entry's amount. They are the figures the Measurement Book engine
    // adds to its prior-cumulative memory and the receivables position
    // is summed from, so a different precision here would be a rounding
    // difference on numbers that decide what is billed next.
    expect(adopted.length).toBe(135);
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
    // 22 before 0076, which adds eway_bills.rendered_sha256 plus the
    // render ledger's source_sha256 and pdf_sha256; 26 after 0079, whose
    // company_document_versions.sha256 is the digest of a stored
    // credential PDF and adopts the domain from the start; 27 after 0082,
    // which adds the inspection document's; 28 after 0083 adds
    // tender_notices.sha256, the digest of a stored NIT; 29 after 0086
    // adds correspondence_letters.scan_sha256, the digest of a received
    // letter's scan; 33 after 0091 adds four — the signing queue's
    // source and signed digests, the digest the token is authorised to
    // sign, and the kiosk credential's own token hash, which is a
    // password-equivalent stored only as its SHA-256; 34 after 0094 adds
    // the import batch's source_sha256, the digest of the uploaded
    // workbook — which is what the bytes were kept for, since the file
    // itself is not stored; 35 after 0096 adds
    // organisation_export_requests.sha256, the digest of the stored
    // whole-organisation package, which is what a recipient checks the
    // file they were handed against; 36 after 0109 adds
    // vendor_invoices.document_sha256, the digest of the vendor's own tax
    // invoice — the one upload in this application a state transition
    // depends on, since a purchase order does not close without it; 37
    // after 0111 adds railway_measurements.sha256, the digest of the
    // railway's own measurement sheet — the document the gate on a
    // received bill reads, so the bytes a verdict was computed over stay
    // identifiable.
    // 39 after 0114 adds two — the digests of the last railway bill an
    // imported Work was paid on and of the measurement sheet that bill
    // was raised from, which are the two documents its opening position
    // rests on and therefore the two a reviewer has to be able to
    // identify.
    expect(columns.filter((column) => column.type === 'sha256_hex').length).toBe(39);
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

    it('pins every tenant-derived view to security_invoker', async () => {
      // A view over tenant tables that loses `security_invoker` runs with
      // its OWNER's privileges, and the owner is `auto_mb_owner`, which is
      // BYPASSRLS. Dropping the option is a one-word edit in a CREATE VIEW
      // and turns a read of the caller's own rows into a read of every
      // organisation's — so the property is asserted over the population
      // rather than view by view, and a new view is covered the day it
      // lands instead of the day somebody remembers.
      //
      // `consignee_masters` (0028) has its own behavioural proof in the
      // tenancy suite; `work_items_live` (0065) has one above; and
      // `bill_settlement_positions` (0067) is the reason this census
      // exists as a census.
      const views = await database.pool<
        { relname: string; options: string[] | null }[]
      >`
        select c.relname, c.reloptions as options
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v'
        order by c.relname
      `;
      expect(views.length).toBeGreaterThanOrEqual(3);
      const definer = views
        .filter((view) => !(view.options ?? []).includes('security_invoker=true'))
        .map((view) => view.relname);
      expect(
        definer,
        `views that would read past row-level security: ${definer.join(', ')}`,
      ).toEqual([]);
      expect(views.map((view) => view.relname)).toContain('bill_settlement_positions');
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
