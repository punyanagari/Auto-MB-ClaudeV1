import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';
import { withTenant } from '../src/tenant.js';
import {
  SETUP_TIMEOUT_MS,
  migrationsDirectory,
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
 * Document numbering, proved at the database.
 *
 * Two invariants the product has always assumed and the schema enforced
 * only in part until migration 0064:
 *
 *   1. A counter never moves backwards. A decreased counter is how a
 *      number gets reused, and a reused number on a statutory document is
 *      the failure the whole guard family exists to prevent. Six of the
 *      eleven counter tables carried the trigger; five did not, including
 *      `tax_invoice_counters`, which numbers the GST invoice.
 *
 *   2. A tax invoice sequence number is unique inside its financial year.
 *      `invoice_number` was unique per organisation, but the (year,
 *      sequence) pair the number is RENDERED from was not, so a template
 *      or prefix change could produce two invoices both claiming to be
 *      number 7 of 2026-27.
 *
 * Each is proved twice: once against a database staged at 0063, where the
 * bad write is accepted, and once against the head of the series, where it
 * is refused. The 0063 half is the regression guard — it fails if a future
 * change quietly removes what 0064 added, because then both halves would
 * behave the same and the "accepted" assertions would break.
 */

/** This suite's own throwaway-database prefix; the stale sweep is scoped
 * to it so a sibling suite running in parallel is never disturbed. */
const PREFIX = 'auto_mb_numbering_test_';

/**
 * Every MONOTONIC counter table, with the shape of the row it counts
 * against and the text its refusal carries. Catalog-asserted below
 * together with the exemption, so a new counter table cannot be added
 * without appearing in one list or the other.
 *
 * Eight share `app_private.guard_counter_decrease()`, whose message names
 * the table through TG_TABLE_NAME. `credit_note_counters` (0051) and
 * `standalone_challan_counters` (0056) have their own copies of the
 * function with a prose message; those two are left alone here because
 * `apps/server/test/delivery-challan-module.integration.test.ts` asserts
 * on one of the messages, and the behaviour is identical either way.
 */
const COUNTER_TABLES = [
  { table: 'bill_counters', scope: 'work', refusal: 'bill_counters' },
  {
    // The payment-request sequence (0080), per organisation and per
    // financial year. Monotonic: a payment request that has been given a
    // number keeps it, so rewinding would re-issue one.
    table: 'payment_request_counters',
    scope: 'financial-year',
    refusal: 'payment_request_counters',
  },
  {
    table: 'budgetary_quotation_counters',
    scope: 'organisation',
    refusal: 'budgetary_quotation_counters',
  },
  {
    table: 'correction_notice_counters',
    scope: 'work',
    refusal: 'correction_notice_counters',
  },
  {
    table: 'credit_note_counters',
    scope: 'financial-year',
    refusal: 'credit note counters',
  },
  {
    table: 'delivery_challan_counters',
    scope: 'work',
    refusal: 'delivery_challan_counters',
  },
  { table: 'issue_challan_counters', scope: 'work', refusal: 'issue_challan_counters' },
  {
    // The inspection call sequence (0082). Per Work, like the challan
    // counters beside it: a cancelled call keeps its number forever, so
    // the counter must never wind back.
    table: 'inspection_call_counters',
    scope: 'work',
    refusal: 'inspection_call_counters',
  },
  {
    table: 'measurement_book_counters',
    scope: 'work',
    refusal: 'measurement_book_counters',
  },
  {
    table: 'purchase_order_counters',
    scope: 'work',
    refusal: 'purchase_order_counters',
  },
  {
    table: 'standalone_challan_counters',
    scope: 'financial-year',
    refusal: 'standalone challan counters',
  },
  {
    table: 'tax_invoice_counters',
    scope: 'financial-year',
    refusal: 'tax_invoice_counters',
  },
  {
    // The letter series (0086), one per direction per financial year and
    // organisation-wide within that. Monotonic for the same reason as the
    // rest: a cancelled letter keeps its number forever, so winding the
    // counter back would hand the same number out twice.
    table: 'correspondence_letter_counters',
    scope: 'direction-financial-year',
    refusal: 'correspondence_letter_counters',
  },
  {
    // The job-card sequence (0084), per organisation and per financial
    // year like the payment requests above it. Monotonic: a cancelled
    // job card keeps its number, so rewinding would re-issue one.
    table: 'production_job_card_counters',
    scope: 'financial-year',
    refusal: 'production_job_card_counters',
  },
  {
    // The finished-serial sequence (0084), per manufactured item. The
    // strictest of the family: its numbers are stamped on hardware, and
    // a unit deleted in error does NOT release its number.
    table: 'production_serial_counters',
    scope: 'production-item',
    refusal: 'production_serial_counters',
  },
  {
    // The despatch sequence (0084), per job card.
    table: 'production_dispatch_counters',
    scope: 'job-card',
    refusal: 'production_dispatch_counters',
  },
] as const;

/** The four that migration 0064 added the trigger to. Named here so the
 * "was genuinely missing" half of each proof cannot silently shrink. */
const UNGUARDED_BEFORE_0064 = [
  'bill_counters',
  'budgetary_quotation_counters',
  'purchase_order_counters',
  'tax_invoice_counters',
] as const;

/**
 * The one counter that must stay decrementable.
 *
 * Migration 0029 made deleting the top-of-sequence manual back-fill of a
 * paper extension letter work by stepping this counter BACK, so the slot
 * is handed out again and the extension sequence never gains a gap; the
 * decrement not matching a row is how a non-top delete is refused. 0029
 * relaxed the table's CHECK to `next_value >= 0` for the same reason.
 * Guarding it would break that delete path — proved below in both
 * directions.
 */
const DECREASE_EXEMPT = 'extension_request_counters';

const FY = '2026-27';

let admin: Sql;

/** Creates the counter row each table counts against and returns the
 * predicate that identifies it. */
interface CounterShape {
  readonly table: string;
  readonly scope:
    | 'work'
    | 'financial-year'
    | 'direction-financial-year'
    | 'organisation'
    | 'production-item'
    | 'job-card';
}

/**
 * The manufactured item and the job card the 0084 counters hang off.
 *
 * Seeded here rather than in the shared `seedTenant`, because these two
 * rows are this file's business alone and every other suite that takes a
 * tenant would otherwise pay for them. The job card is created `planned`,
 * which is the only state its own transition guard admits at birth.
 */
async function seedProductionAnchors(
  pool: Sql,
  tenant: Tenant,
): Promise<{ itemId: string; jobCardId: string }> {
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  const [item] = await pool<{ id: string }[]>`
    insert into production_items (
      organisation_id, item_code, name, category, unit, manufactured,
      serial_prefix, serial_controlled, created_by_user_id
    )
    values (
      ${tenant.organisationId}, ${`INV-${suffix}`}, 'Invariant fixture board',
      'Display boards', 'Nos', true, ${`INV${suffix}`}, true, 'invariant-test'
    )
    returning id
  `;
  if (!item) throw new Error('production item seed failed');
  const [jobCard] = await pool<{ id: string }[]>`
    insert into production_job_cards (
      organisation_id, fy_label, sequence_number, item_id, quantity, work_id,
      source_reference, due_date, created_by_user_id
    )
    values (
      ${tenant.organisationId}, ${FY}, 1, ${item.id}, 1, ${tenant.workId},
      'invariant fixture', '2026-12-31', 'invariant-test'
    )
    returning id
  `;
  if (!jobCard) throw new Error('production job card seed failed');
  return { itemId: item.id, jobCardId: jobCard.id };
}

async function seedCounter(
  pool: Sql,
  table: CounterShape,
  tenant: Tenant,
): Promise<string> {
  switch (table.scope) {
    case 'work':
      await pool.unsafe(
        `insert into ${table.table} (organisation_id, work_id, next_value)
         values ($1, $2, 5)`,
        [tenant.organisationId, tenant.workId],
      );
      return `organisation_id = '${tenant.organisationId}' and work_id = '${tenant.workId}'`;
    case 'financial-year':
      await pool.unsafe(
        `insert into ${table.table} (organisation_id, fy_label, next_value)
         values ($1, $2, 5)`,
        [tenant.organisationId, FY],
      );
      return `organisation_id = '${tenant.organisationId}' and fy_label = '${FY}'`;
    case 'direction-financial-year':
      await pool.unsafe(
        `insert into ${table.table} (organisation_id, direction, fy_label, next_value)
         values ($1, 'outward', $2, 5)`,
        [tenant.organisationId, FY],
      );
      return `organisation_id = '${tenant.organisationId}' and direction = 'outward' and fy_label = '${FY}'`;
    case 'organisation':
      await pool.unsafe(
        `insert into ${table.table} (organisation_id, next_value)
         values ($1, 5)`,
        [tenant.organisationId],
      );
      return `organisation_id = '${tenant.organisationId}'`;
    case 'production-item': {
      const { itemId } = await seedProductionAnchors(pool, tenant);
      await pool.unsafe(
        `insert into ${table.table} (organisation_id, production_item_id, next_value)
         values ($1, $2, 5)`,
        [tenant.organisationId, itemId],
      );
      return `organisation_id = '${tenant.organisationId}' and production_item_id = '${itemId}'`;
    }
    case 'job-card': {
      const { jobCardId } = await seedProductionAnchors(pool, tenant);
      await pool.unsafe(
        `insert into ${table.table} (organisation_id, job_card_id, next_value)
         values ($1, $2, 5)`,
        [tenant.organisationId, jobCardId],
      );
      return `organisation_id = '${tenant.organisationId}' and job_card_id = '${jobCardId}'`;
    }
  }
}

/** Raw SQL, no route in between: the exact writer class the trigger binds. */
function decrease(pool: Sql, table: string, predicate: string): Promise<unknown> {
  return pool.unsafe(`update ${table} set next_value = 1 where ${predicate}`);
}

interface InvoiceNumber {
  readonly sequence: number;
  readonly label: string;
}

/** A SUBMITTED direct invoice carrying an explicit (financial year,
 * sequence) pair, shaped to satisfy every constraint that predates 0064 so
 * only the new unique index can refuse it. */
function submittedInvoice(
  pool: Sql,
  tenant: Tenant,
  number: InvoiceNumber,
): Promise<unknown> {
  return pool`
    insert into tax_invoices (
      organisation_id, status, invoice_number, sequence_number, fy_label,
      invoice_date, sac_code, service_description, gst_rate, place_of_supply,
      buyer_contact_id, buyer_snapshot, stated_taxable_value, taxable_value,
      cgst_amount, sgst_amount, igst_amount, round_off, total_amount,
      issued_snapshot, reverse_charge_applicable,
      submitted_at, submitted_by_user_id, created_by_user_id
    )
    values (
      ${tenant.organisationId}, 'submitted', ${number.label},
      ${number.sequence}, ${FY}, '2026-06-15', '998734',
      'Numbering invariant proof', '18.00', '27', ${tenant.buyerId},
      ${pool.json({ designation: 'Invariant Buyer' })},
      '100.00', '100.00', '9.00', '9.00', '0.00', '0.00', '118.00',
      ${pool.json({ templateVersion: 'invariant-test', supplier: { stateCode: '27' } })},
      false, now(), 'invariant-test', 'invariant-test'
    )
  `;
}

/** The reservation the submit route makes, verbatim
 * (apps/server/src/routes/tax-invoices/submit.ts). */
function reserveInvoiceNumber(pool: TransactionSql, organisationId: string) {
  return pool<{ next_value: number }[]>`
    insert into tax_invoice_counters (organisation_id, fy_label)
    values (${organisationId}, ${FY})
    on conflict (organisation_id, fy_label)
    do update set next_value = tax_invoice_counters.next_value + 1
    returning next_value
  `;
}

/**
 * One database carries both halves: it is staged at 0063, attacked, then
 * migrated the rest of the way and attacked again. That is a stronger
 * proof than two databases (the same rows survive the upgrade) and costs
 * one migration run instead of two.
 */
let database: TemporaryDatabase;
let disposeStaging: () => Promise<void>;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-numbering-admin',
  });
  await admin`select 1 as ready`;
  await dropStaleTemporaryDatabases(admin, PREFIX);
  database = await createTemporaryDatabase(admin, PREFIX);
  disposeStaging = await migrateThrough(database, '0063');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  try {
    if (database) await dropTemporaryDatabase(admin, database);
    if (disposeStaging) await disposeStaging();
  } finally {
    await admin?.end();
  }
}, SETUP_TIMEOUT_MS);

describe('the schema at 0063 accepts both bad writes', () => {
  /** The invoices this block leaves behind, so the repair below can find
   * them: 0064's preflight refuses the upgrade while they exist. */
  const duplicates: string[] = [];

  afterAll(async () => {
    // The repair the preflight message asks the operator to make. Issued
    // invoices are undeletable by design, which is what
    // session_replication_role exists for in fixture teardown.
    await database.pool.unsafe(`set session_replication_role = 'replica'`);
    try {
      for (const organisationId of duplicates) {
        await database.pool`
          delete from tax_invoices where organisation_id = ${organisationId}
        `;
      }
    } finally {
      await database.pool.unsafe(`set session_replication_role = 'origin'`);
    }
  }, SETUP_TIMEOUT_MS);

  it.each(UNGUARDED_BEFORE_0064)('lets %s go backwards', async (name) => {
    const table = COUNTER_TABLES.find((entry) => entry.table === name);
    if (!table) throw new Error(`unknown counter table ${name}`);
    const tenant = await seedTenant(database.pool);
    const predicate = await seedCounter(database.pool, table, tenant);
    await decrease(database.pool, table.table, predicate);
    const [row] = (await database.pool.unsafe(
      `select next_value from ${table.table} where ${predicate}`,
    )) as unknown as { next_value: number }[];
    expect(
      row?.next_value,
      'the counter moved backwards, which is the gap 0064 closes',
    ).toBe(1);
  });

  it('lets two invoices share a sequence number inside one financial year', async () => {
    const tenant = await seedTenant(database.pool);
    duplicates.push(tenant.organisationId);
    const suffix = randomBytes(3).toString('hex');
    await submittedInvoice(database.pool, tenant, {
      sequence: 7,
      label: `TI/${FY}/007/${suffix}`,
    });
    // Same year, same sequence, different rendered number: two documents
    // both claiming to be the seventh invoice of the year.
    await submittedInvoice(database.pool, tenant, {
      sequence: 7,
      label: `TI-ALT/${FY}/007/${suffix}`,
    });
    const [count] = await database.pool<{ n: string }[]>`
      select count(*)::text as n from tax_invoices
      where organisation_id = ${tenant.organisationId}
        and fy_label = ${FY} and sequence_number = 7
    `;
    expect(count?.n).toBe('2');
  });

  it('refuses the 0064 upgrade while a stored invoice repeats a sequence', async () => {
    // A database that already carries the bad rows must not be upgraded
    // silently, and must not be left half-upgraded: the migration names
    // the offending (organisation, year, sequence) and rolls back whole.
    const tenant = await seedTenant(database.pool);
    duplicates.push(tenant.organisationId);
    const suffix = randomBytes(3).toString('hex');
    await submittedInvoice(database.pool, tenant, {
      sequence: 9,
      label: `TI/${FY}/009/${suffix}`,
    });
    await submittedInvoice(database.pool, tenant, {
      sequence: 9,
      label: `TI-ALT/${FY}/009/${suffix}`,
    });

    const failure = await refused(runMigrations(database.pool, migrationsDirectory));
    expect(failure.message).toContain(
      'sequence numbers repeat inside a financial year',
    );
    expect(failure.message).toContain(tenant.organisationId);

    const [ledger] = await database.pool<{ id: string | null }[]>`
      select max(id) as id from schema_migrations
    `;
    expect(ledger?.id).toBe('0063');
  });
});

describe('the schema at head refuses both', () => {
  beforeAll(async () => {
    await migrateToHead(database);
  }, SETUP_TIMEOUT_MS);

  it('carries a decrease guard on every counter table in the catalog', async () => {
    const rows = await database.pool<{ table_name: string }[]>`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname like '%\\_counters'
      order by 1
    `;
    // The declared lists are the contract: a new counter table must be
    // added to one of them, which is the moment somebody decides whether
    // it is monotonic. Being in neither is a failure, not a default.
    expect(rows.map((row) => row.table_name).sort()).toEqual(
      [...COUNTER_TABLES.map((entry) => entry.table), DECREASE_EXEMPT].sort(),
    );

    const guards = await database.pool<
      { table_name: string; refuses_decrease: boolean }[]
    >`
      select c.relname as table_name,
             pg_get_functiondef(p.oid) like '%NEW.next_value < OLD.next_value%'
               as refuses_decrease
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and n.nspname = 'public'
        and c.relname like '%\\_counters'
        and (t.tgtype & 1) <> 0 and (t.tgtype & 2) <> 0 and (t.tgtype & 16) <> 0
    `;
    const guarded = new Set(
      guards.filter((row) => row.refuses_decrease).map((row) => row.table_name),
    );
    const unguarded = COUNTER_TABLES.map((entry) => entry.table).filter(
      (table) => !guarded.has(table),
    );
    expect(
      unguarded,
      `counter tables with no BEFORE UPDATE monotonicity guard: ${unguarded.join(', ')}`,
    ).toEqual([]);
  });

  it.each(COUNTER_TABLES)('refuses a decrease of $table', async (table) => {
    const tenant = await seedTenant(database.pool);
    const predicate = await seedCounter(database.pool, table, tenant);

    const refusal = await refused(decrease(database.pool, table.table, predicate));
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('must not decrease');
    expect(refusal.message, 'the refusal names the counter that refused').toContain(
      table.refusal,
    );

    // Forward movement is untouched — the guard must not wedge numbering.
    await database.pool.unsafe(
      `update ${table.table} set next_value = next_value + 1 where ${predicate}`,
    );
    const [row] = (await database.pool.unsafe(
      `select next_value from ${table.table} where ${predicate}`,
    )) as unknown as { next_value: number }[];
    expect(row?.next_value).toBe(6);
  });

  it('leaves the extension counter decrementable, because 0029 needs it', async () => {
    // The exemption, proved rather than asserted in a comment. Deleting
    // the top-of-sequence manual back-fill IS a counter decrement (0029);
    // a monotonicity guard here would refuse the product's own delete
    // path, which is why extension_request_counters is not in
    // COUNTER_TABLES.
    const tenant = await seedTenant(database.pool);
    const predicate = await seedCounter(
      database.pool,
      { table: DECREASE_EXEMPT, scope: 'work' },
      tenant,
    );
    await decrease(database.pool, DECREASE_EXEMPT, predicate);
    const [row] = (await database.pool.unsafe(
      `select next_value from ${DECREASE_EXEMPT} where ${predicate}`,
    )) as unknown as { next_value: number }[];
    expect(row?.next_value).toBe(1);

    // And it may reach zero: deleting the very first letter reopens slot
    // one, which the 0029 CHECK relaxation exists for.
    await database.pool.unsafe(
      `update ${DECREASE_EXEMPT} set next_value = 0 where ${predicate}`,
    );
    const [zeroed] = (await database.pool.unsafe(
      `select next_value from ${DECREASE_EXEMPT} where ${predicate}`,
    )) as unknown as { next_value: number }[];
    expect(zeroed?.next_value).toBe(0);
  });

  it('refuses a second invoice with the same sequence in the same year', async () => {
    const tenant = await seedTenant(database.pool);
    const suffix = randomBytes(3).toString('hex');
    await submittedInvoice(database.pool, tenant, {
      sequence: 7,
      label: `TI/${FY}/007/${suffix}`,
    });
    const refusal = await refused(
      submittedInvoice(database.pool, tenant, {
        sequence: 7,
        label: `TI-ALT/${FY}/007/${suffix}`,
      }),
    );
    expect(refusal.code).toBe('23505');
    expect(refusal.message).toContain('tax_invoices_sequence_per_fy');
  });

  it('leaves the same sequence free in another year and another tenant', async () => {
    const tenant = await seedTenant(database.pool);
    const other = await seedTenant(database.pool);
    const suffix = randomBytes(3).toString('hex');
    await submittedInvoice(database.pool, tenant, {
      sequence: 11,
      label: `TI/${FY}/011/${suffix}`,
    });
    // The index is per (organisation, year): the same sequence under a
    // DIFFERENT tenant must still be accepted, or the guard would leak one
    // organisation's numbering into another's.
    await submittedInvoice(database.pool, other, {
      sequence: 11,
      label: `TI/${FY}/011/other-${suffix}`,
    });
    const [rows] = await database.pool<{ n: string }[]>`
      select count(*)::text as n from tax_invoices
      where sequence_number = 11 and fy_label = ${FY}
        and organisation_id in (${tenant.organisationId}, ${other.organisationId})
    `;
    expect(rows?.n).toBe('2');
  });

  it('gives two simultaneous reservations two different numbers', async () => {
    const tenant = await seedTenant(database.pool);
    // Both transactions open before either commits: the second UPDATE
    // blocks on the first's row lock rather than reading a stale value.
    const [first, second] = await Promise.all([
      database.pool.begin(async (tx) => {
        const [row] = await reserveInvoiceNumber(tx, tenant.organisationId);
        return row?.next_value;
      }),
      database.pool.begin(async (tx) => {
        const [row] = await reserveInvoiceNumber(tx, tenant.organisationId);
        return row?.next_value;
      }),
    ]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    expect([first, second].sort((a, b) => Number(a) - Number(b))).toEqual([1, 2]);
  });

  it('lets only one of two simultaneous invoices take a given number', async () => {
    const tenant = await seedTenant(database.pool);
    const suffix = randomBytes(3).toString('hex');
    // Two writers that both decided on sequence 21 — the failure mode a
    // corrupted counter, a restored backup or a hand repair produces.
    const outcomes = await Promise.allSettled([
      submittedInvoice(database.pool, tenant, {
        sequence: 21,
        label: `TI/${FY}/021/a-${suffix}`,
      }),
      submittedInvoice(database.pool, tenant, {
        sequence: 21,
        label: `TI/${FY}/021/b-${suffix}`,
      }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = rejected[0];
    if (failure?.status !== 'rejected') throw new Error('expected one rejection');
    expect((failure.reason as { code?: string }).code).toBe('23505');
  });

  it('denies a counter write bound to another tenant', async () => {
    const mine = await seedTenant(database.pool);
    const theirs = await seedTenant(database.pool);
    await seedCounter(
      database.pool,
      { table: 'tax_invoice_counters', scope: 'financial-year' },
      theirs,
    );

    // Bound to MY organisation, the application role must not see or move
    // the other tenant's counter. Row-level security answers zero rows
    // rather than raising, so the proof is that the value is unchanged.
    await withTenant(
      database.appPool,
      { organisationId: mine.organisationId, userId: mine.userId },
      async (tx) => {
        const moved = await tx`
          update tax_invoice_counters set next_value = 99
          where organisation_id = ${theirs.organisationId} and fy_label = ${FY}
        `;
        expect(moved.count).toBe(0);
        const visible = await tx`
          select next_value from tax_invoice_counters
          where organisation_id = ${theirs.organisationId}
        `;
        expect(visible).toHaveLength(0);
      },
    );

    const [row] = await database.pool<{ next_value: number }[]>`
      select next_value from tax_invoice_counters
      where organisation_id = ${theirs.organisationId} and fy_label = ${FY}
    `;
    expect(row?.next_value).toBe(5);
  });
});
