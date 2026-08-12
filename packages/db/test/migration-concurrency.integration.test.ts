import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';

const here = path.dirname(fileURLToPath(import.meta.url));
const realMigrationsDirectory = path.resolve(here, '..', 'migrations');

// Every test here is bounded: if lock handling deadlocks, the test fails at
// this timeout instead of hanging the suite.
const TEST_TIMEOUT_MS = 30_000;

let admin: Sql;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-migration-concurrency-admin',
  });
  await admin`select 1 as ready`;
});

afterAll(async () => {
  try {
    // Sweep temp databases leaked by crashed earlier runs (the per-test
    // finally cannot help when the process itself was killed).
    const stale = await admin<{ datname: string }[]>`
      select datname from pg_database
      where datname like 'auto_mb_migration_test_%'
    `;
    for (const database of stale) {
      await admin.unsafe(`drop database if exists ${database.datname} with (force)`);
    }
  } finally {
    await admin?.end();
  }
});

/**
 * Runs `work` against a freshly created, uniquely named database and drops
 * it afterwards, so concurrent-migration experiments can never touch a
 * developer's normal auto_mb database.
 */
async function withTemporaryDatabase(
  work: (pool: Sql) => Promise<void>,
): Promise<void> {
  const databaseName = `auto_mb_migration_test_${randomBytes(6).toString('hex')}`;
  await admin.unsafe(`create database ${databaseName}`);

  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  const pool = createDatabasePool({
    url: url.toString(),
    max: 4,
    applicationName: 'auto-mb-migration-concurrency-test',
  });

  try {
    await work(pool);
  } finally {
    try {
      await pool.end({ timeout: 5 });
    } catch {
      // A wedged pool must not stop the drop below; `with (force)`
      // terminates whatever the pool left behind.
    }
    await admin.unsafe(`drop database if exists ${databaseName} with (force)`);
  }
}

/** Copies the real migration files into a writable temporary directory. */
async function copyMigrationsTo(directory: string): Promise<void> {
  for (const name of await readdir(realMigrationsDirectory)) {
    await copyFile(
      path.join(realMigrationsDirectory, name),
      path.join(directory, name),
    );
  }
}

async function appliedLedger(pool: Sql): Promise<{ id: string; file_name: string }[]> {
  return pool<{ id: string; file_name: string }[]>`
    select id, file_name from schema_migrations order by id
  `;
}

describe('concurrent migration execution', () => {
  it('classifies legacy statutory rows and backfills render evidence without weakening guards', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-migrations-'));
    try {
      const names = (await readdir(realMigrationsDirectory))
        .filter((name) => name.endsWith('.sql'))
        .sort();
      for (const name of names.filter((name) => name.slice(0, 4) <= '0042')) {
        await copyFile(
          path.join(realMigrationsDirectory, name),
          path.join(directory, name),
        );
      }

      await withTemporaryDatabase(async (pool) => {
        await runMigrations(pool, directory);
        const [organisation] = await pool<{ id: string }[]>`
            insert into organisations (name, slug)
            values ('Legacy migration proof', ${`legacy-proof-${randomBytes(4).toString('hex')}`})
            returning id
          `;
        if (!organisation) throw new Error('organisation seed failed');
        const [buyer] = await pool<{ id: string }[]>`
            insert into contacts (
              organisation_id, designation, address, gstin, pincode,
              state_code, locality, is_client, created_by_user_id
            )
            values (
              ${organisation.id}, 'Legacy Buyer', 'Legacy address',
              '27AAAGM0289C1ZL', '400001', '27', 'Mumbai', true, 'migration-test'
            )
            returning id
          `;
        if (!buyer) throw new Error('buyer seed failed');
        const invoiceId = randomUUID();
        const legacyTemplateVersion = `legacy-template-${'x'.repeat(60)}`;
        const [invoice] = await pool<{ id: string }[]>`
            insert into tax_invoices (
              id, organisation_id, status, invoice_number, sequence_number,
              fy_label, invoice_date, sac_code, service_description, gst_rate,
              place_of_supply, buyer_contact_id, buyer_snapshot,
              stated_taxable_value, taxable_value, cgst_amount, sgst_amount,
              igst_amount, round_off, total_amount, issued_snapshot,
              irn, ack_number, ack_date, ack_date_text, signed_qr,
              irp_provider, irp_provider_state, irp_legacy_evidence_missing,
              template_version, rendered_object_key, rendered_sha256,
              submitted_at, submitted_by_user_id, created_by_user_id
            )
            values (
              ${invoiceId}, ${organisation.id}, 'submitted', 'LEGACY/2025-26/001', 1,
              '2025-26', '2026-01-01', '998734', 'Legacy service invoice',
              '18.00', '27', ${buyer.id}, '{}'::jsonb,
              '100.00', '100.00', '9.00', '9.00', '0.00', '0.00',
              '118.00', '{}'::jsonb, ${'a'.repeat(64)}, '112233445566778',
               '2026-01-01T04:30:00Z', '01/01/2026 10:00:00', 'signed-qr',
              'manual', 'registered', false, ${legacyTemplateVersion},
              'legacy/render-proof.pdf',
              ${'c'.repeat(64)},
              now(), 'migration-test', 'migration-test'
            )
            returning id
          `;
        if (!invoice) throw new Error('invoice seed failed');
        const [ewayBill] = await pool<{ id: string }[]>`
            insert into eway_bills (
              organisation_id, tax_invoice_id, status, transport_mode,
              vehicle_number, distance_km, from_pincode, to_pincode,
              ewb_number, ewb_date, valid_until, ewb_date_text,
              valid_until_text, provider, provider_state,
              legacy_evidence_missing, generated_at, generated_by_user_id,
              created_by_user_id
            )
            values (
              ${organisation.id}, ${invoice.id}, 'generated', 'road',
              'MH01AB1234', 120, '400001', '400002', '123456789012',
              '2026-01-01T05:30:00Z', '2026-01-02T05:30:00Z',
              '01/01/2026 11:00:00', '02/01/2026 11:00:00',
              'manual', 'generated', false, now(), 'migration-test',
              'migration-test'
            )
            returning id
          `;
        if (!ewayBill) throw new Error('e-way bill seed failed');

        await copyFile(
          path.join(
            realMigrationsDirectory,
            '0043_legacy_statutory_evidence_truth.sql',
          ),
          path.join(directory, '0043_legacy_statutory_evidence_truth.sql'),
        );
        await runMigrations(pool, directory);

        const [classifiedInvoice] = await pool<
          { irp_legacy_evidence_missing: boolean }[]
        >`
            select irp_legacy_evidence_missing from tax_invoices
            where id = ${invoice.id}
          `;
        const [classifiedEwayBill] = await pool<{ legacy_evidence_missing: boolean }[]>`
            select legacy_evidence_missing from eway_bills
            where id = ${ewayBill.id}
          `;
        expect(classifiedInvoice?.irp_legacy_evidence_missing).toBe(true);
        expect(classifiedEwayBill?.legacy_evidence_missing).toBe(true);

        const triggers = await pool<{ tgname: string; tgenabled: string }[]>`
            select tgname, tgenabled from pg_trigger
            where tgname in (
              'tax_invoices_issued_update_guard',
              'eway_bills_issued_update_guard'
            )
            order by tgname
          `;
        expect(triggers).toEqual([
          { tgname: 'eway_bills_issued_update_guard', tgenabled: 'O' },
          { tgname: 'tax_invoices_issued_update_guard', tgenabled: 'O' },
        ]);
        await expect(
          pool`
              update tax_invoices set irp_legacy_evidence_missing = false
              where id = ${invoice.id}
            `,
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          pool`
              update eway_bills set legacy_evidence_missing = false
              where id = ${ewayBill.id}
            `,
        ).rejects.toMatchObject({ code: '23514' });

        await copyFile(
          path.join(
            realMigrationsDirectory,
            '0044_tax_invoice_truth_and_render_history.sql',
          ),
          path.join(directory, '0044_tax_invoice_truth_and_render_history.sql'),
        );
        await runMigrations(pool, directory);

        const [historicalInvoice] = await pool<
          { reverse_charge_applicable: boolean | null }[]
        >`
            select reverse_charge_applicable from tax_invoices
            where id = ${invoice.id}
          `;
        expect(historicalInvoice?.reverse_charge_applicable).toBeNull();
        const [backfilledRender] = await pool<
          {
            version: number;
            template_version: string;
            object_key: string;
            pdf_sha256: string;
            source_sha256: string | null;
            source_evidence_missing: boolean;
            template_contract_legacy: boolean;
            object_key_scope_missing: boolean;
            logo_evidence_missing: boolean;
          }[]
        >`
            select version, template_version, object_key, pdf_sha256,
                   source_sha256, source_evidence_missing,
                   template_contract_legacy, object_key_scope_missing,
                   logo_evidence_missing
            from tax_invoice_renders where tax_invoice_id = ${invoice.id}
          `;
        expect(backfilledRender).toEqual({
          version: 1,
          template_version: legacyTemplateVersion,
          object_key: 'legacy/render-proof.pdf',
          pdf_sha256: 'c'.repeat(64),
          source_sha256: null,
          source_evidence_missing: true,
          template_contract_legacy: true,
          object_key_scope_missing: true,
          logo_evidence_missing: true,
        });
        await pool`
            insert into tax_invoice_renders (
              organisation_id, tax_invoice_id, version, template_version,
              source_sha256, object_key, pdf_sha256, created_by_user_id
            ) values (
              ${organisation.id}, ${invoice.id}, 2, 'ti-v1', ${'d'.repeat(64)},
              ${`${organisation.id}/ti/${invoice.id}-current.pdf`},
              ${'e'.repeat(64)},
              'migration-test'
            )
          `;
        const [advancedPointer] = await pool<
          {
            template_version: string | null;
            rendered_object_key: string | null;
            rendered_sha256: string | null;
          }[]
        >`
            select template_version, rendered_object_key, rendered_sha256
            from tax_invoices where id = ${invoice.id}
          `;
        expect(advancedPointer).toEqual({
          template_version: 'ti-v1',
          rendered_object_key: `${organisation.id}/ti/${invoice.id}-current.pdf`,
          rendered_sha256: 'e'.repeat(64),
        });
        await expect(
          pool`
              insert into tax_invoice_renders (
                organisation_id, tax_invoice_id, version, template_version,
                source_sha256, source_evidence_missing,
                object_key, pdf_sha256, created_by_user_id
              ) values (
                ${organisation.id}, ${invoice.id}, 3, 'ti-v1', NULL, true,
                ${`${organisation.id}/ti/${invoice.id}-missing-source.pdf`},
                ${'f'.repeat(64)},
                'migration-test'
              )
            `,
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          pool`
              insert into tax_invoice_renders (
                organisation_id, tax_invoice_id, version, template_version,
                source_sha256, object_key, pdf_sha256, created_by_user_id
              ) values (
                ${organisation.id}, ${invoice.id}, 3, 'ti-v1', ${'f'.repeat(64)},
                ${`00000000-0000-0000-0000-000000000000/ti/${invoice.id}-foreign.pdf`},
                ${'1'.repeat(64)}, 'migration-test'
              )
            `,
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          pool`
              update tax_invoices
              set rendered_object_key = 'untracked.pdf'
              where id = ${invoice.id}
            `,
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          pool`
              update tax_invoice_renders set object_key = 'rewritten.pdf'
              where tax_invoice_id = ${invoice.id}
            `,
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          pool`
              delete from tax_invoice_renders where tax_invoice_id = ${invoice.id}
            `,
        ).rejects.toMatchObject({ code: '23514' });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('upgrades a true pre-0041 database through 0041..0045 in a single run', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-migrations-'));
    try {
      const names = (await readdir(realMigrationsDirectory))
        .filter((name) => name.endsWith('.sql'))
        .sort();
      for (const name of names.filter((name) => name.slice(0, 4) <= '0040')) {
        await copyFile(
          path.join(realMigrationsDirectory, name),
          path.join(directory, name),
        );
      }

      await withTemporaryDatabase(async (pool) => {
        await runMigrations(pool, directory);

        // The stage genuinely predates the checkpoint migrations.
        const [newest] = await pool<{ id: string | null }[]>`
          select max(id) as id from schema_migrations
        `;
        expect(newest?.id).toBe('0040');

        const [organisation] = await pool<{ id: string }[]>`
          insert into organisations (name, slug)
          values ('Pre-0041 staged proof', ${`pre41-proof-${randomBytes(4).toString('hex')}`})
          returning id
        `;
        if (!organisation) throw new Error('organisation seed failed');

        // A draft direct invoice whose buyer is only provable through the
        // audit trail: at this stage buyer_contact_id does not exist and the
        // draft shape forbids a buyer snapshot, so the 0041 backfill must
        // recover the buyer from audit evidence.
        const [buyer] = await pool<{ id: string }[]>`
          insert into contacts (
            organisation_id, designation, address, gstin, pincode,
            state_code, is_client, created_by_user_id
          )
          values (
            ${organisation.id}, 'Pre-0041 Buyer', 'Pre-0041 buyer address',
            '27AAAGM0289C1ZL', '400001', '27', true, 'migration-test'
          )
          returning id
        `;
        if (!buyer) throw new Error('buyer seed failed');
        const invoiceId = randomUUID();
        await pool`
          insert into tax_invoices (
            id, organisation_id, status, invoice_date, sac_code,
            service_description, gst_rate, place_of_supply,
            stated_taxable_value, created_by_user_id
          )
          values (
            ${invoiceId}, ${organisation.id}, 'draft', current_date, '998734',
            'Pre-0041 direct service invoice', '18.00', '27',
            '100.00', 'migration-test'
          )
        `;
        await pool`
          insert into audit_events (
            organisation_id, actor_user_id, action, entity_type, entity_id, details
          )
          values (
            ${organisation.id}, 'migration-test', 'tax_invoice.created',
            'tax_invoices', ${invoiceId},
            ${pool.json({ buyerContactId: buyer.id })}
          )
        `;

        // A live merge that predates the provenance table: a record MB merged
        // into an on-account draft, with the merge audit payload the old
        // route wrote. The 0045 backfill must turn this into provenance rows.
        const [work] = await pool<{ id: string }[]>`
          insert into works (
            organisation_id, work_code, letter_number, letter_date, title,
            advertised_value, contract_value, pricing_shape, created_by_user_id
          )
          values (
            ${organisation.id}, 'PRE41', 'LOA/PRE41/1', '2025-01-01',
            'Pre-0041 staged upgrade work', '100000.00', '100000.00',
            'per_schedule', 'migration-test'
          )
          returning id
        `;
        if (!work) throw new Error('work seed failed');
        const [consignee] = await pool<{ id: string }[]>`
          insert into contacts (
            organisation_id, designation, address, is_consignee, created_by_user_id
          )
          values (
            ${organisation.id}, 'Pre-0041 Consignee', 'Pre-0041 consignee address',
            true, 'migration-test'
          )
          returning id
        `;
        if (!consignee) throw new Error('consignee seed failed');
        const [target] = await pool<{ id: string }[]>`
          insert into measurement_books (
            organisation_id, work_id, kind, status, mb_date, created_by_user_id
          )
          values (
            ${organisation.id}, ${work.id}, 'on_account', 'draft',
            current_date, 'migration-test'
          )
          returning id
        `;
        if (!target) throw new Error('target measurement book seed failed');
        const [record] = await pool<{ id: string }[]>`
          insert into measurement_books (
            organisation_id, work_id, kind, status, mb_date,
            consignee_contact_id, merged_into_id, created_by_user_id
          )
          values (
            ${organisation.id}, ${work.id}, 'record', 'merged', current_date,
            ${consignee.id}, ${target.id}, 'migration-test'
          )
          returning id
        `;
        if (!record) throw new Error('record measurement book seed failed');
        const mergedSourceId = randomUUID();
        await pool`
          insert into audit_events (
            organisation_id, actor_user_id, action, entity_type, entity_id, details
          )
          values (
            ${organisation.id}, 'migration-test', 'measurement_book.merged',
            'measurement_books', ${target.id},
            ${pool.json({
              records: [
                {
                  recordMbId: record.id,
                  sources: [
                    { sourceType: 'delivery_challan', sourceId: mergedSourceId },
                  ],
                },
              ],
            })}
          )
        `;

        // All five checkpoint migrations arrive together and apply in one run.
        for (const name of names.filter(
          (name) => name.slice(0, 4) >= '0041' && name.slice(0, 4) <= '0045',
        )) {
          await copyFile(
            path.join(realMigrationsDirectory, name),
            path.join(directory, name),
          );
        }
        await runMigrations(pool, directory);

        const ledger = await appliedLedger(pool);
        expect(ledger.slice(-5).map((row) => row.id)).toEqual([
          '0041',
          '0042',
          '0043',
          '0044',
          '0045',
        ]);

        // 0041 recovered the draft's buyer from the audit trail and left the
        // untouched provider state truthful; 0044's operator-confirmation
        // column stays NULL on historical rows.
        const [upgradedInvoice] = await pool<
          {
            buyer_contact_id: string;
            irp_provider_state: string;
            irp_legacy_evidence_missing: boolean;
            reverse_charge_applicable: boolean | null;
          }[]
        >`
          select buyer_contact_id, irp_provider_state,
                 irp_legacy_evidence_missing, reverse_charge_applicable
          from tax_invoices where id = ${invoiceId}
        `;
        expect(upgradedInvoice).toEqual({
          buyer_contact_id: buyer.id,
          irp_provider_state: 'not_requested',
          irp_legacy_evidence_missing: false,
          reverse_charge_applicable: null,
        });

        // The tables 0041, 0044, and 0045 introduce all exist.
        const [createdTables] = await pool<{ count: number }[]>`
          select count(*)::int as count from pg_catalog.pg_tables
          where schemaname = 'public' and tablename in (
            'statutory_provider_operations',
            'tax_invoice_renders',
            'measurement_book_merge_provenance'
          )
        `;
        expect(createdTables?.count).toBe(3);

        // 0042 added explicit locality to both parties.
        const localityColumns = await pool<{ table_name: string }[]>`
          select table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'locality'
            and table_name in ('organisations', 'contacts')
          order by table_name
        `;
        expect(localityColumns.map((row) => row.table_name)).toEqual([
          'contacts',
          'organisations',
        ]);

        // 0045 backfilled normalized merge provenance from the audit payload.
        const provenance = await pool<
          {
            target_measurement_book_id: string;
            record_measurement_book_id: string;
            work_id: string;
            source_type: string | null;
            source_id: string | null;
            created_by_user_id: string;
          }[]
        >`
          select target_measurement_book_id, record_measurement_book_id,
                 work_id, source_type, source_id, created_by_user_id
          from measurement_book_merge_provenance
          where organisation_id = ${organisation.id}
        `;
        expect(provenance).toEqual([
          {
            target_measurement_book_id: target.id,
            record_measurement_book_id: record.id,
            work_id: work.id,
            source_type: 'delivery_challan',
            source_id: mergedSourceId,
            created_by_user_id: 'migration-test',
          },
        ]);

        // 0045's record-consignee shape holds for new rows on the upgraded
        // database: a record draft without a consignee is refused.
        await expect(
          pool`
            insert into measurement_books (
              organisation_id, work_id, kind, status, mb_date, created_by_user_id
            )
            values (
              ${organisation.id}, ${work.id}, 'record', 'draft',
              current_date, 'migration-test'
            )
          `,
        ).rejects.toMatchObject({ code: '23514' });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it(
    'lets two simultaneous runners bootstrap a fresh database exactly once',
    async () => {
      await withTemporaryDatabase(async (pool) => {
        await Promise.all([
          runMigrations(pool, realMigrationsDirectory),
          runMigrations(pool, realMigrationsDirectory),
        ]);

        const [ledgerTables] = await pool<{ count: number }[]>`
          select count(*)::int as count from pg_catalog.pg_tables
          where schemaname = 'public' and tablename = 'schema_migrations'
        `;
        expect(ledgerTables?.count).toBe(1);

        const migrationFiles = (await readdir(realMigrationsDirectory))
          .filter((name) => name.endsWith('.sql'))
          .sort();
        const ledger = await appliedLedger(pool);
        expect(ledger.map((row) => row.file_name)).toEqual(migrationFiles);

        // Applied exactly once each: ledger ids are the primary key, so a
        // double apply would have failed the second runner outright.
        expect(new Set(ledger.map((row) => row.id)).size).toBe(ledger.length);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'applies one new pending migration exactly once under two simultaneous runners',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-migrations-'));
      try {
        await copyMigrationsTo(directory);
        await withTemporaryDatabase(async (pool) => {
          await runMigrations(pool, directory);

          await writeFile(
            path.join(directory, '0999_concurrency_probe.sql'),
            'CREATE TABLE migration_concurrency_probe (id integer PRIMARY KEY);\n',
          );
          await Promise.all([
            runMigrations(pool, directory),
            runMigrations(pool, directory),
          ]);

          const ledger = await appliedLedger(pool);
          expect(ledger.filter((row) => row.id === '0999')).toEqual([
            { id: '0999', file_name: '0999_concurrency_probe.sql' },
          ]);

          const [probe] = await pool<{ count: number }[]>`
            select count(*)::int as count from pg_catalog.pg_tables
            where schemaname = 'public' and tablename = 'migration_concurrency_probe'
          `;
          expect(probe?.count).toBe(1);
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'releases the lock after a failed migration so a corrected run proceeds',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-migrations-'));
      try {
        await copyMigrationsTo(directory);
        const brokenPath = path.join(directory, '0999_concurrency_probe.sql');
        await writeFile(
          brokenPath,
          'CREATE TABLE migration_concurrency_probe (id integer PRIMARY KEY;\n',
        );

        await withTemporaryDatabase(async (pool) => {
          await expect(runMigrations(pool, directory)).rejects.toThrow();

          // The failed migration rolled back: no ledger row, no table.
          const ledgerAfterFailure = await appliedLedger(pool);
          expect(ledgerAfterFailure.some((row) => row.id === '0999')).toBe(false);

          await writeFile(
            brokenPath,
            'CREATE TABLE migration_concurrency_probe (id integer PRIMARY KEY);\n',
          );
          // Hangs here if the failed run leaked its advisory lock.
          await runMigrations(pool, directory);

          const ledger = await appliedLedger(pool);
          expect(ledger.some((row) => row.id === '0999')).toBe(true);
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
