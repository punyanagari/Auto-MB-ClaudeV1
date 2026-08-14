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
let createdTriggers: string[] = [];

/**
 * The number of CREATE TRIGGER statements the migration series contains.
 *
 * The panel's coverage reading was "131 triggers, 4 named in tests": the
 * trigger population grows silently because nothing counts it. This census
 * makes each addition an explicit edit. Raising the number is a normal
 * part of adding a trigger — the value of the constant is that it cannot
 * happen without somebody typing the new total and, in doing so, asking
 * whether the trigger has a test.
 */
const TRIGGER_CENSUS = 156;

/**
 * The one counter table that must NOT carry a monotonicity guard.
 *
 * Migration 0029 gave the manual back-fill of paper extension letters a
 * delete path whose mechanism is a counter DECREMENT: the top-of-sequence
 * row is deleted, the counter steps back, and the slot is handed out
 * again, so the extension sequence never gains a gap. 0029 relaxed the
 * table's own CHECK to `next_value >= 0` for the same reason. Its
 * invariant is gaplessness, not monotonicity.
 */
const COUNTER_DECREASE_EXEMPT = ['extension_request_counters'];

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
  createdTriggers = [...allSql.matchAll(/^\s*create trigger (\w+)/gim)].map(
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

  it('binds the tax-invoice money backstops in 0052', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0052_tax_money_backstops.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    expect(sql).toContain('tax_invoices_tax_heads_guard');
    expect(sql).toContain('tax_invoices_split_place_guard');
    // The heads check mirrors the submit route's arithmetic on both
    // branches; the head PLACEMENT is the split guard's job.
    expect(sql).toContain('2 * round(NEW.taxable_value * NEW.gst_rate / 200, 2)');
    expect(sql).toContain('round(NEW.taxable_value * NEW.gst_rate / 100, 2)');
    // The split guard is SECURITY DEFINER, so its organisation read must
    // be tenant-pinned by the row's own key, never by the session binding
    // (which is unbound for admin/direct writers). The comments discuss
    // current_organisation_id, so the refusal is asserted over code only.
    const splitGuardCode = sql
      .slice(
        sql.indexOf('CREATE FUNCTION app_private.guard_tax_invoice_split_place'),
        sql.indexOf('CREATE TRIGGER tax_invoices_split_place_guard'),
      )
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(splitGuardCode).toContain('WHERE org.id = NEW.organisation_id');
    expect(splitGuardCode).not.toContain('current_organisation_id');
    // The preflight judges history by the state FROZEN at submit, falling
    // back to the live organisation state, and names offenders.
    expect(sql).toContain("issued_snapshot->'supplier'->>'stateCode'");
    expect(sql).toContain('RAISE EXCEPTION');
  });

  it('binds the credit-note guards and the supersession arms in 0051', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0051_credit_notes.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    expect(sql).toContain('CREATE TABLE credit_notes');
    expect(sql).toContain('CREATE TABLE credit_note_counters');
    // One live credit note per invoice; supersession releases the MB.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX credit_notes_one_live_per_invoice\s+ON credit_notes \(organisation_id, tax_invoice_id\)\s+WHERE status <> 'cancelled';/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX tax_invoices_one_live_per_mb\s+ON tax_invoices \(organisation_id, measurement_book_id\)\s+WHERE status NOT IN \('cancelled', 'superseded'\);/,
    );
    // Full value is database-proven, and supersession is trigger-gated
    // on an issued credit note in both directions.
    expect(sql).toContain('guard_credit_note_full_value');
    expect(sql).toContain('a tax invoice is superseded only by an issued credit note');
    expect(sql).toContain(
      'the invoice stays superseded while an issued credit note exists',
    );
    // The 0047 scope CHECK gains an EXPLICIT credit_note arm — the old
    // ELSE true must not silently exempt the new type (finding 8).
    expect(sql).toMatch(/WHEN 'credit_note' THEN\s+template LIKE '%\{FY%'/);
    // The provider ledger gains its third, mutually exclusive target.
    expect(sql).toContain('statutory_provider_operations_one_pending_credit_note');
    expect(sql).toMatch(/'register_crn', 'reconcile_crn', 'cancel_crn'/);
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

  it('counts the triggers the series creates', () => {
    expect(
      createdTriggers.length,
      'the migration series creates a different number of triggers than the ' +
        'census records. Update TRIGGER_CENSUS in this file, and give the new ' +
        'trigger a test that attacks it with raw SQL.',
    ).toBe(TRIGGER_CENSUS);
  });

  it('guards every counter table against a decreasing counter (0064)', () => {
    // Numbering state is the one thing a document series cannot recover
    // from: a counter that moves backwards reissues a number that is
    // already on paper. Six of the eleven counter tables carried the 0003
    // guard and four more gained it in 0064, so the rule is stated here
    // over the migration text rather than left to whoever writes the next
    // counter to remember. The eleventh is exempt for a documented reason
    // and must stay named, not merely absent.
    const counterTables = createdTables
      .filter((table) => table.endsWith('_counters'))
      .filter((table) => !COUNTER_DECREASE_EXEMPT.includes(table));
    expect(counterTables.length).toBeGreaterThanOrEqual(10);
    for (const exempt of COUNTER_DECREASE_EXEMPT) {
      expect(createdTables, `${exempt} is not a counter table`).toContain(exempt);
    }
    const flattened = allSql.replace(/\s+/g, ' ');
    for (const table of counterTables) {
      const statement =
        `CREATE TRIGGER ${table}_guard_decrease BEFORE UPDATE ON ${table} ` +
        'FOR EACH ROW EXECUTE FUNCTION ';
      const at = flattened.indexOf(statement);
      expect(
        at,
        `${table} has no monotonicity trigger. Add one: ${statement}` +
          'app_private.guard_counter_decrease();',
      ).toBeGreaterThanOrEqual(0);
      // 0051 and 0056 wrote their own copies of the function rather than
      // reusing 0003's, so the name is matched by shape, not literally.
      expect(flattened.slice(at, flattened.indexOf(';', at) + 1)).toMatch(
        /app_private\.guard_[a-z_]*counter[a-z_]*_decrease\(\);$/,
      );
    }
  });

  it('binds counter monotonicity and invoice sequence uniqueness in 0064', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0064_counter_and_invoice_number_guards.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    // The shared guard names the table that refused, so one message can
    // serve eleven tables.
    expect(sql).toContain("RAISE EXCEPTION '% must not decrease', TG_TABLE_NAME");
    // The exemption is recorded in the migration that would otherwise
    // have broken the 0029 delete path.
    expect(sql).toContain('deliberately NOT guarded');
    expect(sql).toContain('extension_request_counters');
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX tax_invoices_sequence_per_fy\s+ON tax_invoices \(organisation_id, fy_label, sequence_number\)\s+WHERE sequence_number IS NOT NULL;/,
    );
    // The preflight names offending rows before the index could report a
    // uniqueness violation with no way to find them.
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('sequence numbers repeat inside a financial year');
  });

  it('names the three repeated value shapes in 0065', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0065_value_domains_and_live_items.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    expect(sql).toContain('CREATE DOMAIN sha256_hex AS text');
    expect(sql).toContain('CREATE DOMAIN money_amount AS numeric(18, 2)');
    expect(sql).toContain('CREATE DOMAIN quantity_amount AS numeric(18, 3)');
    // The live-items view must stay invoker-scoped: a definer view would
    // read work_items with the view owner's privileges.
    expect(sql).toContain(
      'CREATE VIEW work_items_live\nWITH (security_invoker = true)',
    );
    expect(sql).toContain('WHERE deleted_at IS NULL');
    // Three column-scoped triggers block ALTER COLUMN TYPE and are dropped
    // and recreated inside this migration's transaction. Every drop must
    // have its matching create, or a money guard would be gone.
    for (const trigger of [
      'tax_invoices_render_pointer_guard',
      'tax_invoices_split_place_guard',
      'tax_invoices_tax_heads_guard',
    ]) {
      expect(sql).toContain(`DROP TRIGGER ${trigger} ON tax_invoices;`);
      expect(sql).toContain(`CREATE TRIGGER ${trigger}`);
    }
  });
});
