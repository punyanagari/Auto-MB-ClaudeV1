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

  it('binds the delivery and installation quantity ceilings in 0046', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0046_quantity_ceilings_and_fk_indexes.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    expect(sql).toContain('installations_quantity_ceiling_guard');
    expect(sql).toContain('delivery_challans_quantity_ceiling_guard');
    // The ceiling reads happen under a work_items row lock, which is what makes
    // two simultaneous writers serialise instead of each passing a stale sum.
    expect(sql).toContain('FOR UPDATE OF item');
    // allow_excess_delivery is consulted by the delivery guard only; the
    // installation guard must never read it.
    const installationGuard = sql.slice(
      sql.indexOf('CREATE FUNCTION app_private.guard_installation_quantity_ceiling()'),
      sql.indexOf('CREATE TRIGGER installations_quantity_ceiling_guard'),
    );
    expect(installationGuard).toContain('FOR UPDATE');
    expect(installationGuard).not.toContain('allow_excess_delivery');
    // The cross-tenant read in the 0039 tax invoice guard is closed.
    expect(sql).toContain('AND organisation_id = NEW.organisation_id');
  });

  it('binds number-template counter scope in 0047', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0047_number_template_scope.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    // Challan templates need a per-Work mark, invoice templates the
    // financial year; the preflight names offenders before the
    // constraint's generic violation could.
    expect(sql).toContain('document_number_series_scope');
    expect(sql).toMatch(/template LIKE '%\{WORK%' OR template LIKE '%\{PREFIX%'/);
    expect(sql).toMatch(/WHEN 'tax_invoice' THEN\s+template LIKE '%\{FY%'/);
    expect(sql).toContain('RAISE EXCEPTION');
  });

  it('binds the GST rate master guard in 0048', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0048_gst_rate_master.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    expect(sql).toContain('CREATE TABLE gst_rates');
    // Rates retire by end-dating; a window must not end before it starts.
    expect(sql).toMatch(/effective_to IS NULL OR effective_to >= effective_from/);
    // One row per notified (rate, start) pair per organisation.
    expect(sql).toContain('UNIQUE (organisation_id, rate, effective_from)');
    // The guard is SECURITY DEFINER, so it must scope its read to the row's
    // own tenant — the 0046 review found a definer guard reading across
    // tenants once, and this trigger must not repeat it.
    expect(sql).toContain('tax_invoices_gst_rate_guard');
    expect(sql).toContain('g.organisation_id = NEW.organisation_id');
    // The preflight names offenders before the trigger could strand them.
    expect(sql).toContain('RAISE EXCEPTION');
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
