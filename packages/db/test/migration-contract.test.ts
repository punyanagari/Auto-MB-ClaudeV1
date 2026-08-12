import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// Static, database-free checks over the migration files. These are
// supplementary to the live catalog assertions in
// tenancy.integration.test.ts; the table list here is DERIVED from the SQL
// so new migrations cannot silently escape the contract.
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(here, '..', 'migrations');

let allSql = '';
let createdTables: string[] = [];

beforeAll(async () => {
  const files = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  expect(files.length).toBeGreaterThanOrEqual(3);
  const contents = await Promise.all(
    files.map((name) => readFile(path.join(migrationsDirectory, name), 'utf8')),
  );
  allSql = contents.join('\n');
  createdTables = [...allSql.matchAll(/^create table (\w+)/gim)].map(
    (match) => match[1] ?? '',
  );
});

describe('tenant migration contract', () => {
  it('bounds and serialises the one-time legacy statutory classification', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0043_legacy_statutory_evidence_truth.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    expect(sql).toContain(
      'LOCK TABLE tax_invoices, eway_bills IN ACCESS EXCLUSIVE MODE;',
    );
    expect(sql).toContain(
      'ALTER TABLE tax_invoices DISABLE TRIGGER tax_invoices_issued_update_guard;',
    );
    expect(sql).toContain(
      'ALTER TABLE tax_invoices ENABLE TRIGGER tax_invoices_issued_update_guard;',
    );
    expect(sql).toContain(
      'ALTER TABLE eway_bills DISABLE TRIGGER eway_bills_issued_update_guard;',
    );
    expect(sql).toContain(
      'ALTER TABLE eway_bills ENABLE TRIGGER eway_bills_issued_update_guard;',
    );
  });

  it('enables and forces RLS on every table any migration creates', () => {
    expect(createdTables.length).toBeGreaterThanOrEqual(15);
    for (const table of createdTables) {
      expect(allSql, table).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
      );
      expect(allSql, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    }
  });

  it('asserts full RLS coverage at migration time as well', () => {
    // 0003 refuses to complete when any public table other than
    // schema_migrations lacks enabled+forced RLS.
    expect(allSql).toContain('NOT (c.relrowsecurity AND c.relforcerowsecurity)');
  });

  it('keeps audit events append-only for the application role specifically', () => {
    expect(allSql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM auto_mb_app;/,
    );
  });

  it('revokes DELETE on reservation-anchor tables from the application role', () => {
    expect(allSql).toMatch(
      /REVOKE DELETE ON\s+organisations,\s+works,\s+work_items,\s+loa_documents,\s+delivery_challan_counters\s+FROM auto_mb_app;/,
    );
  });

  it('enforces one draft Delivery Challan per Work with a partial unique index', () => {
    expect(allSql).toMatch(
      /CREATE UNIQUE INDEX delivery_challans_one_draft_per_work\s+ON delivery_challans \(organisation_id, work_id\)\s+WHERE status = 'draft';/,
    );
  });

  it('serialises challan sequence numbers per Work with a partial unique index', () => {
    expect(allSql).toMatch(
      /CREATE UNIQUE INDEX delivery_challans_sequence_per_work\s+ON delivery_challans \(organisation_id, work_id, sequence_number\)\s+WHERE sequence_number IS NOT NULL;/,
    );
  });

  it('normalizes merge provenance and narrows PO draft scope in 0045', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0045_audit_integrity_followup.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain('CREATE TABLE measurement_book_merge_provenance');
    expect(sql).toContain('measurement_book_merge_provenance_source_owner');
    expect(sql).toContain('measurement_book_merge_provenance_truncate_guard');
    expect(sql).toContain('purchase_orders_one_draft_per_work_vendor');
    expect(sql).toContain('purchase_orders_update_guard');
    expect(sql).toContain('budgetary_quotations_update_guard');
  });
});
