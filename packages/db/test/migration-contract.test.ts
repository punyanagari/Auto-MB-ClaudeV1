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
const TRIGGER_CENSUS = 165;

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

  it('lifts the installation ceiling and derives the variation flag in 0077', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0077_installation_variation.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    // 0046's installation ceiling goes, trigger and function together —
    // a dropped trigger over a surviving function is a guard that comes
    // back the next time somebody re-creates the trigger.
    expect(sql).toContain('DROP TRIGGER installations_quantity_ceiling_guard');
    expect(sql).toContain(
      'DROP FUNCTION app_private.guard_installation_quantity_ceiling();',
    );
    // The DELIVERY ceiling is a different rule and must survive untouched.
    expect(sql).not.toContain('delivery_challans_quantity_ceiling_guard');
    expect(sql).toContain(
      'ADD COLUMN pending_variation boolean NOT NULL DEFAULT false',
    );
    // ONE definition of "over-installed": both triggers and the backfill
    // read the same function, so the three cannot drift apart. It is
    // called by name from inside trigger bodies, which resolves under the
    // invoking role, so the grant has to be real rather than assumed.
    expect(sql).toContain('CREATE FUNCTION app_private.work_item_over_installed(');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION\n      app_private.work_item_over_installed(uuid, uuid, numeric) TO auto_mb_app;',
    );
    expect([...sql.matchAll(/sum\(i\.quantity\)/g)]).toHaveLength(1);
    // Both halves of the derivation: the item side overwrites whatever a
    // writer supplied, and the installation side locks the item row before
    // it reads the sum, so two concurrent recordings cannot both conclude
    // they fit.
    expect(sql).toContain('NEW.pending_variation :=');
    expect(sql).toContain('CREATE TRIGGER installations_pending_variation_sync');
    const installationSync = sql.slice(
      sql.indexOf('CREATE FUNCTION app_private.refresh_work_item_pending_variation()'),
      sql.indexOf('CREATE TRIGGER installations_pending_variation_sync'),
    );
    expect(installationSync).toContain('FOR UPDATE');
    // Both work_items triggers are WHEN-gated, and that is the point of
    // them being two. Ungated, every write of a work item — the bulk
    // insert of an LOA confirmation, a payment-category sweep — would run
    // the installations aggregate for an answer that cannot have changed.
    expect(sql).toMatch(
      /CREATE TRIGGER work_items_pending_variation_insert\nBEFORE INSERT ON work_items\nFOR EACH ROW WHEN \(NEW\.pending_variation\)/,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER work_items_pending_variation_sync\nBEFORE UPDATE ON work_items\nFOR EACH ROW WHEN \(/,
    );
    expect(sql).toContain(
      'OLD.effective_quantity IS DISTINCT FROM NEW.effective_quantity',
    );
    expect(sql).toContain(
      'OLD.pending_variation IS DISTINCT FROM NEW.pending_variation',
    );
    // Neither trigger may consult the excess-delivery toggle: that lifts
    // the delivery cap and has never had anything to say about
    // installation.
    expect(sql).not.toContain('allow_excess_delivery');
    // A database restored from before 0046 can hold an over-installed
    // item, so the flag is backfilled — driven from the INSTALLATIONS
    // side, because the ADD COLUMN above holds ACCESS EXCLUSIVE on
    // work_items and an item with no installation cannot be
    // over-installed.
    expect(sql).toMatch(
      /UPDATE work_items item\nSET pending_variation = app_private\.work_item_over_installed\(/,
    );
    expect(sql).toMatch(/WHERE EXISTS \(\n {2}SELECT 1 FROM installations i/);
    // No index on the flag: nothing filters on it at scale, and the
    // per-Work reads that show it already have work_items_work_idx.
    expect(sql).not.toContain('CREATE INDEX');
  });

  it('binds the bank-detail shapes and derives item mapping in 0078', async () => {
    const sql = await readFile(
      path.join(
        migrationsDirectory,
        '0078_masters_bank_details_and_canonical_items.sql',
      ),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    // The two shapes the server also proves. Bound on BOTH tables that
    // store a bank account, because a rule enforced on one of two writers
    // is a rule with a door in it.
    expect([...sql.matchAll(/\^\[A-Z\]\{4\}0\[A-Z0-9\]\{6\}\$/g)]).toHaveLength(2);
    // The digit lookahead travels with the alphanumeric range on both
    // tables: without it, the route's space-stripping turns a note into
    // a nine-character all-letter "account number" that passes.
    expect([
      ...sql.matchAll(/'\^\(\?=\.\*\[0-9\]\)\[0-9A-Z\]\{6,18\}\$'/g),
    ]).toHaveLength(2);
    // A contact's four payable fields are all present or all absent — a
    // partial set is not a beneficiary anyone can be paid as.
    expect(sql).toContain('CONSTRAINT contacts_bank_details_shape_check');
    // No mapping COLUMN on work_items: the link is derived from the
    // aliases, and a nullable foreign key with no writer would feed
    // counts that all read zero. Asserted over the DDL rather than the
    // whole file, because the header names the column it declines to add
    // and explains why — which is the record this test protects.
    expect(sql).not.toMatch(/ADD COLUMN canonical_item_id/);
    expect(sql).not.toContain('ALTER TABLE work_items');
    // One canonical item per wording, case- and space-insensitively: two
    // rows claiming one wording would both count the same schedule lines.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX canonical_items_name_per_org\s+ON canonical_items \(organisation_id, lower\(btrim\(name\)\)\);/,
    );
    // A retired organisation bank account stops blocking its own number,
    // which is how one retired in error comes back.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX organisation_bank_accounts_live_account\s+ON organisation_bank_accounts \(organisation_id, ifsc, account_number\)\s+WHERE active;/,
    );
    // Both new tables are masters: they retire by flag, so neither hands
    // the application role a DELETE.
    for (const table of ['canonical_items', 'organisation_bank_accounts']) {
      expect(sql, table).toContain(`GRANT SELECT, INSERT, UPDATE ON ${table}`);
      expect(sql, table).not.toContain(`DELETE ON ${table}`);
    }
  });

  it('binds the delivery and installation quantity ceilings in 0046', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0046_quantity_ceilings_and_fk_indexes.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    // What 0046 wrote, asserted over 0046's own bytes. Its installation
    // ceiling was lifted by 0077 (owner decision, 2026-08-17) and the
    // assertions here describe the migration, not the live schema — an
    // applied migration's text never changes, so this stays true.
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

  it("binds the challan's stage-3b statutory facts in 0075", async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0075_delivery_challan_statutory_facts.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    // The line facts take 0057's shape, including the CHECK that pairs
    // code length to kind, plus the unclassified branch this table needs.
    expect(sql).toContain('delivery_challan_items_code_shape');
    expect(sql).toMatch(/\(is_service AND hsn_sac_code ~ '\^\[0-9\]\{6\}\$'\)/);
    expect(sql).toMatch(/\(NOT is_service AND hsn_sac_code ~ '\^\[0-9\]\{6,8\}\$'\)/);
    // Both-or-neither is its own equality, not folded into the OR chain: a
    // three-valued disjunction passes a CHECK on a half-classified line
    // because it evaluates to NULL, so the pairing is stated as an equality
    // that is FALSE (never NULL) when exactly one column is null.
    expect(sql).toContain('(hsn_sac_code IS NULL) = (is_service IS NULL)');
    // The header facts: NIC's movement vocabulary and the transport
    // shapes 0035 proved on eway_bills.
    expect(sql).toMatch(
      /movement_reason IN \('supply', 'job_work', 'for_own_use', 'others'\)/,
    );
    expect(sql).toContain("vehicle_number ~ '^[A-Z0-9]{6,12}$'");
    expect(sql).toContain("transporter_id ~ '^[0-9]{2}[0-9A-Z]{13}$'");
    expect(sql).toContain(
      'transport_distance_km >= 0 AND transport_distance_km <= 4000',
    );
    expect(sql).toContain('delivery_challans_transport_doc_shape');
    // Every new header column is frozen at issue: the guard's row
    // comparison is what makes an issued challan safe to raise a bill on.
    for (const column of [
      'movement_reason',
      'consignee_gstin',
      'transporter_id',
      'transporter_name',
      'vehicle_number',
      'transport_doc_number',
      'transport_doc_date',
      'transport_distance_km',
    ]) {
      expect(sql, column).toContain(`NEW.${column}`);
      expect(sql, column).toContain(`OLD.${column}`);
    }
    expect(sql).toContain(
      "RAISE EXCEPTION 'issued Delivery Challan business data is immutable'",
    );
  });

  it('makes an e-way bill name exactly one source document in 0076', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0076_eway_bill_source_documents.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    expect(sql).toContain(
      'ALTER TABLE eway_bills ALTER COLUMN tax_invoice_id DROP NOT NULL;',
    );
    expect(sql).toContain('eway_bills_source_shape');
    expect(sql).toMatch(
      /\(tax_invoice_id IS NOT NULL AND delivery_challan_id IS NULL\)\s+OR\s+\(tax_invoice_id IS NULL AND delivery_challan_id IS NOT NULL\)/,
    );
    // One live bill per source, the challan half of 0035's rule.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX eway_bills_one_live_per_challan\s+ON eway_bills \(organisation_id, delivery_challan_id\)\s+WHERE status <> 'cancelled';/,
    );
    // Referential integrity cannot use a partial index, so the FK gets an
    // unconditional one of its own.
    expect(sql).toMatch(
      /CREATE INDEX eway_bills_challan_idx\s+ON eway_bills \(organisation_id, delivery_challan_id\);/,
    );
    // The insert guard reads whichever source the row names, and the
    // definer read is pinned to the row's own tenant on BOTH branches.
    const insertGuard = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION app_private.guard_eway_invoice()'),
      sql.indexOf(
        'CREATE OR REPLACE FUNCTION app_private.guard_eway_bill_issued_update()',
      ),
    );
    expect(insertGuard).toContain('SECURITY DEFINER');
    expect([
      ...insertGuard.matchAll(/WHERE organisation_id = NEW\.organisation_id/g),
    ]).toHaveLength(2);
    expect(insertGuard).toContain("v_kind <> 'standalone'");
    // A row naming neither source defers to the CHECK rather than
    // reporting a NULL challan as missing.
    expect(insertGuard).toContain(
      'NEW.tax_invoice_id IS NULL AND NEW.delivery_challan_id IS NULL',
    );
    expect(insertGuard).toContain("v_status <> 'issued'");
    // The source is frozen once the bill leaves draft.
    expect(sql).toContain('NEW.delivery_challan_id');
    expect(sql).toContain('OLD.delivery_challan_id');
    // The printable summary is append-only, generated-only, contiguous.
    expect(sql).toContain('CREATE TABLE eway_bill_renders');
    expect(sql).toContain('eway_bill_renders_pdf_key_scope');
    expect(sql).toContain("RAISE EXCEPTION 'e-way bill renders are append-only'");
    expect(sql).toContain('a draft e-way bill has no NIC facts to print');
    expect(sql).toContain('e-way bill render versions are contiguous from one');
    expect(sql).toContain('eway_bills_render_pointer_shape');
    // The parent pointer is scope-checked directly and may only advance to
    // the latest retained render (0044's render-pointer machinery, ported).
    expect(sql).toContain('eway_bills_rendered_key_scope');
    expect(sql).toContain("rendered_object_key LIKE organisation_id::text || '/ewb/%'");
    expect(sql).toContain(
      'CREATE FUNCTION app_private.guard_eway_bill_render_pointer()',
    );
    expect(sql).toContain('CREATE TRIGGER eway_bills_render_pointer_guard');
    expect(sql).toContain(
      'e-way bill render pointer must match its latest retained version',
    );
    expect(sql).toContain(
      'CREATE FUNCTION app_private.advance_eway_bill_render_pointer()',
    );
    expect(sql).toContain('CREATE TRIGGER eway_bill_renders_advance_pointer');
    // The render-INSERT guard is INVOKER-rights, deliberately: RLS hides a
    // foreign-tenant parent so a probe collapses to one generic message.
    const renderInsertGuard = sql.slice(
      sql.indexOf('CREATE FUNCTION app_private.guard_eway_bill_render_insert()'),
      sql.indexOf('CREATE TRIGGER eway_bill_renders_insert_guard'),
    );
    expect(renderInsertGuard).not.toContain('SECURITY DEFINER');
  });

  it('binds the company document library in 0078', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0078_company_document_library.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // Categories are a CHECK on text, deliberately, so a sixth bucket is
    // one ordinary statement rather than an enum-type change.
    expect(sql).toMatch(
      /category text NOT NULL CHECK \(category IN \(\s*'statutory',\s*'financial',\s*'eligibility',\s*'certification',\s*'company'\s*\)\)/,
    );
    expect(sql).not.toContain('CREATE TYPE');

    // One live credential per name, case-folded. Two rows both called
    // "GST Registration" is the mistake this catches; a renewal belongs
    // on the existing row as a new version.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX company_documents_live_title_unique\s+ON company_documents \(organisation_id, lower\(title\)\)\s+WHERE archived_at IS NULL;/,
    );

    // Version numbers are unique within their credential, which is what
    // makes two renewals uploaded in the same second safe even if the
    // route's row lock were somehow not taken.
    expect(sql).toContain(
      'UNIQUE (organisation_id, company_document_id, version_number)',
    );

    // Legal dates are date-only (engineering rule 6) and the window has
    // to open before it closes.
    expect(sql).toContain('valid_from date');
    expect(sql).toContain('expires_on date');
    expect(sql).toContain('company_document_versions_validity_order_check');
    expect(sql).toMatch(
      /valid_from IS NULL OR expires_on IS NULL OR expires_on >= valid_from/,
    );

    // The stored object key carries the tenant prefix here as well as in
    // packages/documents/src/storage.ts. Two layers, because a path is a
    // filesystem escape.
    expect(sql).toContain(
      'company_document_versions_object_key_tenant_prefix_check',
    );
    expect(sql).toMatch(
      /CHECK \(object_key LIKE organisation_id::text \|\| '\/%'\)/,
    );
    expect(sql).toContain("CHECK (media_type = 'application/pdf')");

    // Both policies arrive in the ADR-0010 InitPlan shape.
    for (const table of ['company_documents', 'company_document_versions']) {
      expect(sql).toContain(
        `CREATE POLICY ${table}_tenant_policy ON ${table}\n  USING (organisation_id = (SELECT app_private.current_organisation_id()))`,
      );
    }

    // Evidence never leaves and is never rewritten: no DELETE anywhere,
    // and no UPDATE on the versions.
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON company_documents TO auto_mb_app;',
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT ON company_document_versions TO auto_mb_app;',
    );
    expect(sql).not.toContain('DELETE ON company_document');

    // The trigger says the same thing to a writer that reached the table
    // some other way, and refuses to hang new evidence off an archived
    // credential.
    expect(sql).toContain(
      'a company document version is immutable; upload a new version instead',
    );
    expect(sql).toContain('is archived and takes no new versions');
    expect(sql).toContain(
      'CREATE TRIGGER company_document_versions_append_only_guard\nBEFORE INSERT OR UPDATE ON company_document_versions',
    );
  });
});
