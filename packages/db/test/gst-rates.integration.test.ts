import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';

// These tests prove the database-level GST rate guard introduced by
// migration 0048 (audit finding 19), and its migration-time preflight.
// Everything runs against real PostgreSQL: the guard is a SECURITY
// DEFINER trigger whose tenancy predicate only a real cross-tenant row
// can prove, and the preflight only fires against a genuinely staged
// upgrade.
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';

const here = path.dirname(fileURLToPath(import.meta.url));
const realMigrationsDirectory = path.resolve(here, '..', 'migrations');

const TEST_TIMEOUT_MS = 120_000;

let admin: Sql;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-gst-rates-admin',
  });
  await admin`select 1 as ready`;
});

afterAll(async () => {
  try {
    // Sweep databases leaked by a crashed earlier run; the per-test
    // finally cannot help when the process itself was killed.
    const stale = await admin<{ datname: string }[]>`
      select datname from pg_database
      where datname like 'auto_mb_gst_test_%'
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
  const name = `auto_mb_gst_test_${randomBytes(6).toString('hex')}`;
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    name,
    pool: createDatabasePool({
      url: url.toString(),
      max: 4,
      applicationName: 'auto-mb-gst-rates-test',
    }),
  };
}

async function dropTemporaryDatabase(database: TemporaryDatabase): Promise<void> {
  try {
    await database.pool.end({ timeout: 5 });
  } catch {
    // A wedged pool must not stop the drop below; `with (force)`
    // terminates whatever the pool left behind.
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

interface Tenant {
  readonly organisationId: string;
  readonly buyerId: string;
}

/** One organisation with a client contact — everything a DIRECT tax
 * invoice needs. Each call is independent. */
async function seedTenant(pool: Sql): Promise<Tenant> {
  const suffix = randomBytes(4).toString('hex');
  const [organisation] = await pool<{ id: string }[]>`
    insert into organisations (name, slug)
    values (${`GST guard tenant ${suffix}`}, ${`gst-guard-${suffix}`})
    returning id
  `;
  if (!organisation) throw new Error('organisation seed failed');
  const [buyer] = await pool<{ id: string }[]>`
    insert into contacts (
      organisation_id, designation, address, gstin, pincode, state_code,
      is_client, created_by_user_id
    )
    values (
      ${organisation.id}, 'GST Guard Buyer', 'Buyer address',
      '27AAAGM0289C1ZL', '400001', '27', true, 'gst-guard-test'
    )
    returning id
  `;
  if (!buyer) throw new Error('buyer seed failed');
  return { organisationId: organisation.id, buyerId: buyer.id };
}

/** The exact write a compromised or buggy application-side caller would
 * make: a direct draft invoice, straight SQL, no route in between. */
function draftInvoice(
  pool: Sql,
  tenant: Tenant,
  gstRate: string,
  invoiceDate: string,
): Promise<unknown> {
  return pool`
    insert into tax_invoices (
      organisation_id, status, invoice_date, sac_code, service_description,
      gst_rate, place_of_supply, buyer_contact_id, stated_taxable_value,
      created_by_user_id
    )
    values (
      ${tenant.organisationId}, 'draft', ${invoiceDate}, '998734',
      'GST guard raw-SQL proof', ${gstRate}, '27', ${tenant.buyerId},
      '100.00', 'gst-guard-test'
    )
  `;
}

async function refused(work: Promise<unknown>): Promise<{ message: string }> {
  try {
    await work;
  } catch (error) {
    return { message: String(error) };
  }
  throw new Error('expected the statement to be refused');
}

describe('gst_rates guard trigger (0048)', () => {
  it(
    'stops a direct SQL insert whose rate no master row of the SAME tenant covers',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-gst-'));
      const database = await createTemporaryDatabase();
      try {
        const pool = database.pool;
        await stageMigrations(directory, '0048');
        await runMigrations(pool, directory);

        // Both tenants were created AFTER 0048 ran, so neither carries
        // the migration seed; covered gets 18% by hand, bare gets nothing.
        const covered = await seedTenant(pool);
        const bare = await seedTenant(pool);
        await pool`
          insert into gst_rates (
            organisation_id, rate, label, effective_from, created_by_user_id
          )
          values (${covered.organisationId}, '18.00', 'Standard 18%',
                  '2017-07-01', 'gst-guard-test')
        `;

        // Covered tenant, covered pair: accepted.
        await draftInvoice(pool, covered, '18.00', '2026-02-15');

        // Covered tenant, off-master rate: the 1.8-instead-of-18 typo the
        // route also refuses — this proves the DATABASE refuses it too.
        const typo = await refused(draftInvoice(pool, covered, '1.80', '2026-02-15'));
        expect(typo.message).toContain('not notified');

        // Covered tenant, rate outside its window: 18% began 2017-07-01.
        const early = await refused(draftInvoice(pool, covered, '18.00', '2017-06-30'));
        expect(early.message).toContain('not notified');

        // The tenancy predicate: the BARE tenant asks for 18% — a rate the
        // OTHER tenant's master covers. A guard reading across tenants
        // would accept; this one must not (the 0046 review found exactly
        // that class of definer-guard bug once).
        const crossTenant = await refused(
          draftInvoice(pool, bare, '18.00', '2026-02-15'),
        );
        expect(crossTenant.message).toContain('not notified');

        // An UPDATE of the deciding columns re-fires the guard.
        const moved = await refused(pool`
          update tax_invoices set invoice_date = '2017-06-30'
          where organisation_id = ${covered.organisationId}
        `);
        expect(moved.message).toContain('not notified');
      } finally {
        await dropTemporaryDatabase(database);
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('0048 preflight over stored invoices', () => {
  it(
    'refuses the upgrade while a stored invoice carries a pair the seed would not cover, naming it',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-gst-'));
      const database = await createTemporaryDatabase();
      try {
        const pool = database.pool;
        await stageMigrations(directory, '0047');
        await runMigrations(pool, directory);

        // A pre-0048 database legitimately holds this row: nothing bounded
        // the rate, so a 2.50% invoice exists. The seed's notified history
        // does not cover 2.50%, and the guard trigger would strand the row.
        const tenant = await seedTenant(pool);
        const poisonedId = randomUUID();
        await pool`
          insert into tax_invoices (
            id, organisation_id, status, invoice_date, sac_code,
            service_description, gst_rate, place_of_supply, buyer_contact_id,
            stated_taxable_value, created_by_user_id
          )
          values (
            ${poisonedId}, ${tenant.organisationId}, 'draft', '2026-01-10',
            '998734', 'Pre-0048 off-master invoice', '2.50', '27',
            ${tenant.buyerId}, '100.00', 'gst-guard-test'
          )
        `;

        await copyFile(
          path.join(realMigrationsDirectory, '0048_gst_rate_master.sql'),
          path.join(directory, '0048_gst_rate_master.sql'),
        );
        const failure = await refused(runMigrations(pool, directory));
        expect(failure.message).toContain('rate master does not cover');
        expect(failure.message).toContain(poisonedId);
        expect(failure.message).toContain('2.50');

        // The failed migration rolled back whole: no table, no ledger row.
        const [ledger] = await pool<{ id: string | null }[]>`
          select max(id) as id from schema_migrations
        `;
        expect(ledger?.id).toBe('0047');

        // The operator follows the message — corrects the invoice data —
        // and the rerun succeeds and seeds the existing organisation.
        await pool`
          update tax_invoices set gst_rate = '18.00' where id = ${poisonedId}
        `;
        await runMigrations(pool, directory);
        const [seeded] = await pool<{ count: number }[]>`
          select count(*)::int as count from gst_rates
          where organisation_id = ${tenant.organisationId}
        `;
        expect(seeded?.count).toBe(9);
      } finally {
        await dropTemporaryDatabase(database);
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
