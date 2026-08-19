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
let triggersByMigration: Record<string, number> = {};

/**
 * How many triggers each migration creates.
 *
 * The panel's coverage reading was "131 triggers, 4 named in tests": the
 * trigger population grows silently because nothing counts it. This census
 * makes each addition an explicit edit, and the value of it is that a
 * trigger cannot arrive without somebody typing a number and, in doing so,
 * asking whether it has a test.
 *
 * PER MIGRATION rather than one shared total, and that shape is the point.
 * A single integer is a line every concurrent pack has to edit, so three
 * packs adding triggers in one wave produce three conflicts on one line,
 * each resolved by re-deriving a number nobody can check by reading the
 * diff. A map is a key ADD: two packs touch different lines, git merges
 * them, and the sum stays exact because a merged migration file never
 * changes again. Migrations that create no trigger are simply absent.
 */
const MIGRATION_TRIGGERS: Readonly<Record<string, number>> = {
  '0001_core.sql': 3,
  '0003_integrity_guards.sql': 8,
  '0006_retention.sql': 5,
  '0008_integrity_hardening.sql': 2,
  '0010_challan_date_guard.sql': 1,
  '0011_completion_extensions.sql': 6,
  '0012_amendments_approvals.sql': 2,
  '0013_masters_profile.sql': 4,
  '0014_issue_challans.sql': 7,
  '0015_serial_enforcement.sql': 1,
  '0017_installation_records.sql': 5,
  '0019_correction_flow.sql': 6,
  '0021_payment_categories.sql': 1,
  '0022_pac_certificates.sql': 5,
  '0023_wave2_hardening.sql': 1,
  '0024_measurement_books.sql': 9,
  '0027_review_hardening_and_rates.sql': 2,
  '0028_contacts_master.sql': 2,
  '0030_amendment_floors.sql': 3,
  '0031_work_completion.sql': 5,
  '0033_procurement_and_tax.sql': 6,
  '0035_tax_invoices_eway.sql': 5,
  '0039_number_series_and_direct_invoices.sql': 1,
  '0040_contract_source_documents.sql': 1,
  '0041_statutory_provider_evidence.sql': 5,
  '0044_tax_invoice_truth_and_render_history.sql': 7,
  '0045_audit_integrity_followup.sql': 5,
  '0046_quantity_ceilings_and_fk_indexes.sql': 2,
  '0048_gst_rate_master.sql': 2,
  '0051_credit_notes.sql': 6,
  '0052_tax_money_backstops.sql': 2,
  '0055_loa_document_discard.sql': 1,
  '0056_delivery_challan_module.sql': 3,
  '0057_itemised_invoices.sql': 5,
  '0058_omission_variation_orders.sql': 2,
  '0060_pdf_signature_verdicts.sql': 1,
  '0064_counter_and_invoice_number_guards.sql': 4,
  '0065_value_domains_and_live_items.sql': 3,
  '0066_received_railway_bills.sql': 4,
  '0067_bill_payments.sql': 4,
  '0068_amc_payment_category.sql': 3,
  '0071_work_supersession.sql': 4,
  '0072_worker_job_queue.sql': 2,
  '0076_eway_bill_source_documents.sql': 4,
  '0077_installation_variation.sql': 3,
  '0078_masters_bank_details_and_canonical_items.sql': 2,
  '0079_company_document_library.sql': 3,
  '0080_payments_workspace.sql': 7,
  '0082_inspection_lifecycle.sql': 8,
  '0083_tenders.sql': 7,
  '0084_production.sql': 13,
  '0086_correspondence_register.sql': 4,
  '0087_stock_ledger.sql': 3,
  '0088_maintenance.sql': 11,
  '0089_employees.sql': 4,
  '0090_payroll.sql': 6,
  '0091_signing_requests.sql': 2,
  '0092_notifications.sql': 4,
  '0094_data_imports.sql': 2,
  '0096_platform_controls.sql': 5,
  '0098_retention_and_liquidated_damages.sql': 6,
  '0099_warranty_dlp.sql': 6,
  '0104_owner_rulings_2026_08_19.sql': 1,
};

const TRIGGER_CENSUS = Object.values(MIGRATION_TRIGGERS).reduce(
  (total, count) => total + count,
  0,
);

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
  triggersByMigration = {};
  files.forEach((name, index) => {
    const created = [...(contents[index] ?? '').matchAll(/^\s*create trigger (\w+)/gim)]
      .length;
    if (created > 0) triggersByMigration[name] = created;
  });
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
    // 0046's installation ceiling goes, trigger and function together â€”
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
    // them being two. Ungated, every write of a work item â€” the bulk
    // insert of an LOA confirmation, a payment-category sweep â€” would run
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
    // item, so the flag is backfilled â€” driven from the INSTALLATIONS
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
    // A contact's four payable fields are all present or all absent â€” a
    // partial set is not a beneficiary anyone can be paid as.
    expect(sql).toContain('CONSTRAINT contacts_bank_details_shape_check');
    // No mapping COLUMN on work_items: the link is derived from the
    // aliases, and a nullable foreign key with no writer would feed
    // counts that all read zero. Asserted over the DDL rather than the
    // whole file, because the header names the column it declines to add
    // and explains why â€” which is the record this test protects.
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
    // assertions here describe the migration, not the live schema â€” an
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
    // own tenant â€” the 0046 review found a definer guard reading across
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
    // The 0047 scope CHECK gains an EXPLICIT credit_note arm â€” the old
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

  it('counts the triggers the series creates, per migration', () => {
    expect(
      createdTriggers.length,
      'the migration series creates a different number of triggers than the ' +
        'census records. Add or correct your migration key in ' +
        'MIGRATION_TRIGGERS in this file, and give the new trigger a test ' +
        'that attacks it with raw SQL.',
    ).toBe(TRIGGER_CENSUS);

    // WHICH migration is wrong, not only that the total is. The per-file
    // numbers exist to make a merge a key-add; they earn their keep again
    // by making a mistake local to the file that made it.
    const wrong = Object.entries(triggersByMigration)
      .filter(([file, count]) => (MIGRATION_TRIGGERS[file] ?? 0) !== count)
      .map(([file, count]) => `${file}: ${String(count)} created`);
    const stale = Object.keys(MIGRATION_TRIGGERS).filter(
      (file) => triggersByMigration[file] === undefined,
    );
    expect(
      wrong,
      'migrations whose trigger count is not what MIGRATION_TRIGGERS says',
    ).toEqual([]);
    expect(
      stale,
      'MIGRATION_TRIGGERS names a migration that creates no trigger',
    ).toEqual([]);
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

  it('binds the company document library in 0079', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0079_company_document_library.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // Categories are a CHECK on text, deliberately, so a sixth bucket is
    // one ordinary statement rather than an enum-type change.
    //
    // This file cannot compare the list against the contract's own
    // COMPANY_DOCUMENT_CATEGORIES: `packages/db` does not depend on
    // `packages/contracts` and adding that edge for one census would buy
    // a workspace dependency to check five strings. The derived
    // comparison lives where both are already in reach and the constraint
    // can be read from the live catalog rather than from this text â€”
    // `apps/server/test/company-documents.integration.test.ts`, "the
    // schema's categories are exactly the contract's".
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
    // route's row lock were somehow not taken. It is also the whole index
    // budget of the table: no `UNIQUE (organisation_id, id)` that nothing
    // references, and no per-tenant object-key unique that the global one
    // below already subsumes.
    expect(sql).toContain(
      'UNIQUE (organisation_id, company_document_id, version_number)',
    );
    expect(sql).not.toContain('UNIQUE (organisation_id, object_key)');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX company_document_versions_object_key_unique',
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
    expect(sql).toContain('company_document_versions_object_key_tenant_prefix_check');
    expect(sql).toMatch(/CHECK \(object_key LIKE organisation_id::text \|\| '\/%'\)/);
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

    // The archived-parent read takes a share lock. Without it the guard
    // is not the second layer this migration claims it is: under READ
    // COMMITTED a bare SELECT would miss an archive that commits between
    // the read and the insert.
    expect(sql).toMatch(/SELECT archived_at INTO parent_archived_at[\s\S]*?FOR SHARE;/);

    // The credential's own UPDATE guard: provenance frozen, archive
    // one-way. Its grant keeps UPDATE, so something has to say what
    // UPDATE is allowed to do.
    expect(sql).toContain("a company document''s tenant and provenance are immutable");
    expect(sql).toContain('an archived company document cannot be un-archived');
    expect(sql).toContain('CREATE TRIGGER company_documents_update_guard');

    // Both guard functions pin their search_path, as 0067 and 0077 do:
    // a trigger that resolves identifiers through the caller's path is a
    // trigger a shadowing object can rewrite.
    for (const guard of [
      'app_private.guard_company_document_update()',
      'app_private.guard_company_document_version()',
    ]) {
      const body = sql.slice(sql.indexOf(`CREATE FUNCTION ${guard}`));
      expect(body.slice(0, 200), guard).toContain(
        'SET search_path = pg_catalog, public',
      );
    }
  });

  it('binds the inspection lifecycle in 0082', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0082_inspection_lifecycle.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // THE NO-RETROACTIVE-BLOCKING GUARANTEE. The dispatch gate is the
    // ABSENCE of a clause row plus a column that defaults false, and this
    // migration writes no clause rows at all. A backfill here would flip
    // behaviour on live data, so its absence is asserted rather than
    // assumed.
    expect(sql).toContain('gates_dispatch boolean NOT NULL DEFAULT false');
    expect(sql).not.toMatch(/INSERT INTO inspection_clauses/i);
    expect(sql).not.toMatch(/UPDATE\s+works\s+SET/i);

    // A consignee-inspected item can never gate despatch.
    expect(sql).toContain('inspection_clauses_consignee_never_gates_check');
    expect(sql).toMatch(/agency <> 'consignee' OR gates_dispatch = false/);

    // States and agencies are CHECKed text, not enum types.
    expect(sql).toContain(
      "agency text NOT NULL CHECK (agency IN ('RDSO', 'RITES', 'consignee'))",
    );
    expect(sql).toMatch(
      /status IN \('requested', 'scheduled', 'closed', 'cancelled'\)/,
    );
    expect(sql).not.toContain('CREATE TYPE');

    // THE GATE IS QUANTITATIVE. One function, summing certified coverage
    // per item and comparing it against cumulative despatch â€” existence
    // would let one call for 10 release 500. Both enforcement points call
    // this same function, which is what stops the two drifting.
    expect(sql).toContain('CREATE FUNCTION app_private.inspection_dispatch_shortfall(');
    expect(sql).toMatch(/SELECT sum\(ici\.quantity\) AS certified/);
    expect(sql).toMatch(/moved\.despatched > coalesce\(cover\.certified, 0\)/);
    // â€¦and it matches the clause's OWN agency and the call's own Work.
    expect(sql).toContain('AND ic.agency = c.agency');
    expect(sql).toContain('AND ici.work_id = c.work_id');

    // Liveness and "today" are each defined once, and today is the
    // ORGANISATION's, not UTC's.
    expect(sql).toContain('CREATE FUNCTION app_private.organisation_today(');
    expect(sql).toContain('CREATE FUNCTION app_private.inspection_certificate_live(');
    expect(sql).toMatch(/\(now\(\) AT TIME ZONE o\.timezone\)::date/);

    // Every trigger function pins its search_path.
    const functions = sql.match(/CREATE FUNCTION app_private\.\w+/g) ?? [];
    expect(functions.length).toBeGreaterThanOrEqual(6);
    expect(sql.match(/SET search_path = pg_catalog, public/g)?.length).toBe(
      functions.length,
    );

    // The INSERT doors are shut: a row cannot be born in a state the
    // transitions would never have reached, and a challan cannot be
    // inserted straight into `issued` past the gate.
    expect(sql).toContain(
      'CREATE TRIGGER inspection_calls_guard_transition\nBEFORE INSERT OR UPDATE ON inspection_calls',
    );
    expect(sql).toMatch(/an inspection call is created as requested, not as/);
    expect(sql).toContain(
      'CREATE TRIGGER delivery_challans_guard_inspection_gate\nBEFORE INSERT OR UPDATE ON delivery_challans',
    );

    // Guards sort alphabetically before the touch trigger, so a refused
    // write raises before updated_at moves (the 0003 ordering note).
    expect(
      sql.indexOf('CREATE TRIGGER inspection_calls_guard_transition'),
    ).toBeLessThan(sql.indexOf('CREATE TRIGGER inspection_calls_touch_updated_at'));

    // Every RAISE carries a named SQLSTATE from the 23C block, so the
    // route can map it to a code instead of surfacing a 500.
    const raises = sql.match(/RAISE EXCEPTION/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(8);
    expect(sql.match(/USING ERRCODE = '23C0\d'/g)?.length).toBe(raises.length);

    // Numbering is a counter, not max()+1 under a works lock.
    expect(sql).toContain('CREATE TABLE inspection_call_counters');
    expect(sql).toContain('UNIQUE (organisation_id, work_id, sequence_number)');

    // Coverage rows prove item and call belong to ONE Work.
    expect(sql).toMatch(
      /FOREIGN KEY \(organisation_id, inspection_call_id, work_id\)\s+REFERENCES inspection_calls\(organisation_id, id, work_id\)/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(organisation_id, work_item_id, work_id\)\s+REFERENCES work_items\(organisation_id, id, work_id\)/,
    );

    // Legal dates are date-only, ordered, and the validity window is
    // bounded so a mistyped year cannot unlock an item forever.
    expect(sql).toContain('requested_on date NOT NULL');
    expect(sql).toContain('inspection_calls_date_order_check');
    expect(sql).toMatch(
      /certificate_valid_until <= certificate_date \+ INTERVAL '5 years'/,
    );

    // The checklist has an organisation-default scope, which is what
    // stops a new Work starting with an empty one.
    expect(sql).toContain('inspection_checklist_fields_default_label_unique');

    // No result column and no media_type: the certificate is the result,
    // and the upload path admits one format and proves it from the bytes.
    expect(sql).not.toMatch(/\bresult text\b/);
    expect(sql).not.toMatch(/^\s*media_type\b/m);

    // The object key carries the tenant prefix here as well as in
    // packages/documents/src/storage.ts, and the file is all-or-nothing.
    expect(sql).toContain('inspection_call_documents_object_key_tenant_prefix_check');
    expect(sql).toContain('inspection_call_documents_file_shape_check');

    // One inward letter and one certificate per call.
    expect(sql).toContain('inspection_call_documents_one_call_letter');
    expect(sql).toContain('inspection_call_documents_one_certificate');

    // Every policy arrives in the ADR-0010 InitPlan shape, and every
    // table forces RLS on its owner too.
    for (const table of [
      'inspection_clauses',
      'inspection_checklist_fields',
      'inspection_calls',
      'inspection_call_counters',
      'inspection_call_items',
      'inspection_call_documents',
    ]) {
      expect(sql).toContain(
        `CREATE POLICY ${table}_tenant_policy ON ${table}\n  USING (organisation_id = (SELECT app_private.current_organisation_id()))`,
      );
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    }

    // A call is correspondence with a government agency and a challan may
    // rest on its certificate: it cancels with a reason and stays.
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON inspection_calls TO auto_mb_app;',
    );
    expect(sql).not.toContain('DELETE ON inspection_calls');
    expect(sql).not.toContain('DELETE ON inspection_call_documents');
  });
  it('binds the tender pipeline in 0083', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0083_tenders.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // Statuses are a CHECK on text, deliberately, for the reason 0079
    // gives about its categories.
    expect(sql).toMatch(
      /status text NOT NULL DEFAULT 'drafted' CHECK \(status IN \(\s*'drafted',\s*'submitted',\s*'opened',\s*'awarded',\s*'lost'\s*\)\)/,
    );
    expect(sql).not.toContain('CREATE TYPE');

    // One tender number, one record, case-folded. One line per demand
    // within a tender, likewise.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX tenders_number_unique\s+ON tenders \(organisation_id, lower\(tender_number\)\);/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX tender_checklist_items_title_unique\s+ON tender_checklist_items \(organisation_id, tender_id, lower\(title\)\);/,
    );

    // The closing moment is an INSTANT, and the schema says why â€” the one
    // place in this series where a legal-looking date is not date-only,
    // because a tender closes at a stated time of day and a bid one
    // minute late is rejected.
    expect(sql).toContain('bid_closes_at timestamptz NOT NULL');
    expect(sql).toContain('The closing INSTANT, not a legal date');

    // Money uses the 0065 domain, never a bare numeric.
    expect(sql).toContain('estimated_value money_amount');
    expect(sql).toContain('emd_amount money_amount');

    // Every child FK is composite, so no row can reach across tenants â€”
    // including the one that reaches into the company document library.
    for (const composite of [
      'FOREIGN KEY (organisation_id, award_loa_document_id)\n    REFERENCES loa_documents(organisation_id, id)',
      'FOREIGN KEY (organisation_id, confirmed_tender_id)\n    REFERENCES tenders(organisation_id, id)',
      'FOREIGN KEY (organisation_id, tender_id)\n    REFERENCES tenders(organisation_id, id)',
      'FOREIGN KEY (organisation_id, company_document_id)\n    REFERENCES company_documents(organisation_id, id)',
    ]) {
      expect(sql).toContain(composite);
    }

    // An award letter belongs only to an awarded tender, and only to one.
    expect(sql).toContain('tenders_award_shape_check');
    expect(sql).toContain('UNIQUE (organisation_id, award_loa_document_id)');

    // The notice's object key carries the tenant prefix here as well as
    // in packages/documents/src/storage.ts.
    expect(sql).toContain('tender_notices_object_key_tenant_prefix_check');
    expect(sql).toMatch(/CHECK \(object_key LIKE organisation_id::text \|\| '\/%'\)/);
    expect(sql).toContain("CHECK (media_type = 'application/pdf')");

    // Four tables, four policies, all in the ADR-0010 InitPlan shape.
    for (const table of [
      'tenders',
      'tender_notices',
      'tender_checklist_items',
      'tender_status_events',
    ]) {
      expect(sql).toContain(
        `CREATE POLICY ${table}_tenant_policy ON ${table}\n  USING (organisation_id = (SELECT app_private.current_organisation_id()))`,
      );
    }

    // DELETE is granted on the checklist and nowhere else: a checklist
    // line is draft working material (AGENTS.md rule 8); a tender, its
    // notice and its trail are records.
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON tenders TO auto_mb_app;');
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON tender_notices TO auto_mb_app;',
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON tender_checklist_items TO auto_mb_app;',
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT ON tender_status_events TO auto_mb_app;',
    );
    expect(sql).not.toContain('DELETE ON tenders');
    expect(sql).not.toContain('DELETE ON tender_status_events');
    expect(sql).not.toContain('DELETE ON tender_notices');

    // The trail runs one way and the terminals are terminal, said in the
    // database rather than in whichever route happened to be called.
    expect(sql).toContain('is already %, which is final');
    expect(sql).toContain('a tender cannot move from % to %');
    expect(sql).toContain(
      'CREATE TRIGGER tenders_status_transition_guard\nBEFORE UPDATE ON tenders',
    );

    // The notice and its extraction are evidence; only the confirmation
    // link moves, and only once.
    expect(sql).toContain(
      'a tender notice and its extraction are immutable; upload the notice again instead',
    );
    expect(sql).toContain('was already confirmed into tender');
    expect(sql).toContain(
      'CREATE TRIGGER tender_notices_evidence_guard\nBEFORE UPDATE ON tender_notices',
    );

    // Provenance and the tenant are immutable on both tables that take
    // UPDATE, and a tender's facts stop being correctable the moment the
    // bid is no longer a draft.
    expect(sql).toContain("a tender''s tenant and provenance are immutable");
    expect(sql).toContain('and its facts can no longer be corrected');
    expect(sql).toContain('CREATE TRIGGER tenders_update_guard');
    expect(sql).toContain(
      "a tender checklist line''s tender and provenance are immutable",
    );
    expect(sql).toContain(
      'the attachment provenance of a tender checklist line moves only with its credential',
    );
    expect(sql).toContain('CREATE TRIGGER tender_checklist_items_update_guard');

    // Every guard function pins its search_path, as 0067, 0077 and 0079
    // do: a trigger that resolves identifiers through the caller's path
    // is a trigger a shadowing object can rewrite.
    for (const guard of [
      'app_private.guard_tender_status()',
      'app_private.guard_tender_update()',
      'app_private.guard_tender_notice()',
      'app_private.guard_tender_checklist_item_update()',
    ]) {
      const body = sql.slice(sql.indexOf(`CREATE FUNCTION ${guard}`));
      expect(body.slice(0, 200), guard).toContain(
        'SET search_path = pg_catalog, public',
      );
    }

    // None of them runs with definer rights: none needs to read across
    // RLS, and a definer trigger on a tenant table is a way out of it.
    for (const guard of [
      'app_private.guard_tender_status()',
      'app_private.guard_tender_update()',
      'app_private.guard_tender_notice()',
      'app_private.guard_tender_checklist_item_update()',
    ]) {
      const body = sql.slice(sql.indexOf(`CREATE FUNCTION ${guard}`));
      expect(body.slice(0, body.indexOf('$$;')), guard).not.toContain(
        'SECURITY DEFINER',
      );
    }
  });

  it('binds OEM production in 0084', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0084_production.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // States are CHECKed text, not enum types, as 0079, 0082 and 0083
    // all are: a sixth value must stay one ordinary statement.
    expect(sql).toMatch(
      /status IN \('planned', 'in_production', 'completed', 'cancelled'\)/,
    );
    expect(sql).not.toContain('CREATE TYPE');

    // THE CYCLE REFUSAL IS THE POINT OF THE PACK, and it lives at the
    // layer no writer can go around. Three parts, each asserted: the
    // one-step CHECK, the recursive search, and the advisory lock that
    // makes the search hold when two sessions add opposite edges at the
    // same moment — the one failure a row lock cannot fix, because the
    // rows that would have to be locked do not exist yet.
    expect(sql).toContain('production_bom_lines_not_self_check');
    expect(sql).toMatch(/CHECK \(parent_item_id <> component_item_id\)/);
    expect(sql).toContain('CREATE FUNCTION app_private.guard_production_bom_edge()');
    expect(sql).toMatch(/WITH RECURSIVE reachable\(item_id\) AS \(/);
    // THE DEPTH BOUND MEASURES BOTH DIRECTIONS. Downward only bounds a
    // bottom-up build and lets a top-down one through entirely, because
    // the new component is a leaf every time.
    expect(sql).toMatch(/WITH RECURSIVE ascent\(item_id, height\) AS \(/);
    expect(sql).toMatch(/WITH RECURSIVE descent\(item_id, depth\) AS \(/);
    expect(sql).toContain(
      'IF reached_above + 1 + reached_below > app_private.production_bom_max_depth()',
    );
    // The requirement explosion aggregates per level rather than walking
    // one row per path, so a shared sub-assembly costs rows once.
    expect(sql).toContain(
      'CREATE FUNCTION app_private.production_bom_requirements(org uuid, root uuid)',
    );
    expect(sql).toContain('GROUP BY line.component_item_id');
    // One readiness expression, read by the register tile and the job
    // card badge alike.
    expect(sql).toContain(
      'CREATE FUNCTION app_private.production_job_card_dispatch_ready(',
    );
    expect(sql).toContain('CREATE FUNCTION app_private.production_unit_incomplete(');
    // The despatch rules hold at the database too, not only at the route.
    expect(sql).toContain(
      'CREATE TRIGGER production_dispatches_guard_write\nBEFORE INSERT ON production_dispatches',
    );
    expect(sql).toContain(
      'CREATE TRIGGER production_dispatch_serials_guard_write\nBEFORE INSERT ON production_dispatch_serials',
    );
    // …and an unresolvable organisation date is refused, not defaulted.
    expect(sql).toContain("USING ERRCODE = '23D17'");
    expect(sql).toMatch(/IF today IS NULL THEN/);
    // The CYCLE clause is what makes the guard terminate even against
    // stored data that already contains a loop, so the guard can never
    // itself be the thing that hangs.
    expect(sql).toMatch(/\) CYCLE item_id SET is_cycle USING path/);
    expect(sql).toMatch(
      /PERFORM pg_advisory_xact_lock\(\s*hashtext\('production_bom_lines'\), hashtext\(NEW\.organisation_id::text\)\s*\);/,
    );
    expect(sql).toContain('app_private.production_bom_max_depth()');

    // SERIAL SCOPES. The finished serial is unique per ORGANISATION, a
    // deliberate departure from challan_item_serials' per-Work scope
    // (0006) that the migration header argues; the component serial is
    // unique per part number, because two part numbers may legitimately
    // carry one supplier serial.
    expect(sql).toContain('UNIQUE (organisation_id, serial_number)');
    expect(sql).toContain('UNIQUE (organisation_id, component_item_id, serial_number)');
    // And a unit leaves the factory exactly once.
    expect(sql).toContain('UNIQUE (organisation_id, production_serial_id)');

    // The despatch boundary is proved by KEYS, not by a trigger: both
    // composite keys carry job_card_id, so a unit from one job card
    // cannot be released on another card's despatch.
    for (const composite of [
      'FOREIGN KEY (organisation_id, job_card_id, item_id)\n    REFERENCES production_job_cards(organisation_id, id, item_id)',
      'FOREIGN KEY (organisation_id, production_dispatch_id, job_card_id)\n    REFERENCES production_dispatches(organisation_id, id, job_card_id)',
      'FOREIGN KEY (organisation_id, production_serial_id, job_card_id)\n    REFERENCES production_serials(organisation_id, id, job_card_id)',
      'FOREIGN KEY (organisation_id, parent_item_id)\n    REFERENCES production_items(organisation_id, id)',
      'FOREIGN KEY (organisation_id, component_item_id)\n    REFERENCES production_items(organisation_id, id)',
    ]) {
      expect(sql, composite).toContain(composite);
    }

    // A job card serves a Work or a private order, never both and never
    // neither — the mock's stored sourceType label expressed as the
    // shape of the row, so the two cannot disagree.
    expect(sql).toContain('production_job_cards_source_shape_check');
    expect(sql).toMatch(
      /\(work_id IS NOT NULL AND customer_name IS NULL\)\s+OR \(work_id IS NULL AND customer_name IS NOT NULL\)/,
    );

    // No readiness is STORED. The mock's own fixture disagrees with its
    // own derived shortage on two of three plans, which is the defect a
    // stored copy of a computed fact produces.
    // No stored COLUMN for any of them. `dispatch_ready` appears as the
    // name of the FUNCTION that derives it, which is the whole point —
    // what must not exist is a column somebody has to keep in step.
    expect(sql).not.toMatch(/^\s+(material_short|material_ready|dispatch_ready) /m);
    // …and nothing here writes to a stock table that does not exist yet.
    expect(sql).not.toMatch(/stock_items|stock_ledger/);

    // Every policy in the ADR-0010 InitPlan shape.
    for (const table of [
      'production_items',
      'production_bom_lines',
      'production_job_cards',
      'production_job_card_counters',
      'production_serials',
      'production_serial_counters',
      'production_component_serials',
      'production_dispatches',
      'production_dispatch_counters',
      'production_dispatch_serials',
    ]) {
      expect(sql, table).toContain(
        `CREATE POLICY ${table}_tenant_policy ON ${table}\n  USING (organisation_id = (SELECT app_private.current_organisation_id()))`,
      );
    }

    // The grants, verbatim. A serial number is stamped on hardware, so
    // none of the four record tables takes an UPDATE at all.
    for (const grant of [
      'GRANT SELECT, INSERT, UPDATE ON production_items TO auto_mb_app;',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON production_bom_lines TO auto_mb_app;',
      'GRANT SELECT, INSERT, UPDATE ON production_job_cards TO auto_mb_app;',
      'GRANT SELECT, INSERT, DELETE ON production_serials TO auto_mb_app;',
      'GRANT SELECT, INSERT, DELETE ON production_component_serials TO auto_mb_app;',
      'GRANT SELECT, INSERT, DELETE ON production_dispatches TO auto_mb_app;',
      'GRANT SELECT, INSERT, DELETE ON production_dispatch_serials TO auto_mb_app;',
    ]) {
      expect(sql, grant).toContain(grant);
    }
    for (const table of [
      'production_items',
      'production_job_cards',
      'production_job_card_counters',
      'production_serial_counters',
      'production_dispatch_counters',
    ]) {
      expect(sql, table).not.toContain(`DELETE ON ${table} TO auto_mb_app`);
    }
    for (const table of [
      'production_serials',
      'production_component_serials',
      'production_dispatches',
      'production_dispatch_serials',
    ]) {
      expect(sql, table).not.toContain(`UPDATE ON ${table} TO auto_mb_app`);
    }

    // Numbering is counters, not max()+1, and all three carry 0064's
    // monotonicity guard (the generic sweep above also counts them).
    for (const counter of [
      'production_job_card_counters',
      'production_serial_counters',
      'production_dispatch_counters',
    ]) {
      expect(sql, counter).toContain(`CREATE TABLE ${counter}`);
    }
    expect(sql).not.toMatch(/max\(sequence_number\)|max\(next_value\)/);

    // Guards sort alphabetically before the touch trigger, so a refused
    // write raises before updated_at moves (the 0003 ordering note).
    expect(sql.indexOf('CREATE TRIGGER production_items_guard_update')).toBeLessThan(
      sql.indexOf('CREATE TRIGGER production_items_touch_updated_at'),
    );
    expect(
      sql.indexOf('CREATE TRIGGER production_job_cards_guard_transition'),
    ).toBeLessThan(sql.indexOf('CREATE TRIGGER production_job_cards_touch_updated_at'));

    // The INSERT doors are shut: a job card cannot be born completed,
    // and a unit cannot be born on a card that is finished or full.
    expect(sql).toContain(
      'CREATE TRIGGER production_job_cards_guard_transition\nBEFORE INSERT OR UPDATE ON production_job_cards',
    );
    expect(sql).toMatch(/a job card is created as planned, not as/);
    expect(sql).toContain(
      'CREATE TRIGGER production_serials_guard_write\nBEFORE INSERT OR DELETE ON production_serials',
    );
    // The ceiling holds under concurrency only because the job card's
    // own row is locked before the count is read.
    expect(sql).toMatch(
      /SELECT status, quantity INTO card_status, card_quantity[\s\S]*?FOR UPDATE;/,
    );
    // Per-unit component capture takes the same lock, on the same row —
    // the JOB CARD, not the unit. Locking the unit would need an UPDATE
    // privilege that § 4 deliberately withholds, and locking a different
    // row from the route's would be a deadlock waiting for two operators.
    expect(sql).toMatch(
      /PERFORM 1 FROM production_job_cards\s+WHERE organisation_id = NEW\.organisation_id AND id = parent_card\s+FOR UPDATE;/,
    );
    expect(sql).not.toMatch(/FROM production_serials[\s\S]{0,200}?FOR UPDATE;/);

    // Every trigger function pins its search_path, and there are no
    // exceptions to count against.
    const functions = sql.match(/CREATE FUNCTION app_private\.\w+/g) ?? [];
    expect(functions.length).toBeGreaterThanOrEqual(6);
    expect(sql.match(/SET search_path = pg_catalog, public/g)?.length).toBe(
      functions.length,
    );
    for (const guard of functions) {
      const body = sql.slice(sql.indexOf(guard));
      expect(body.slice(0, body.indexOf('$$;')), guard).not.toContain(
        'SECURITY DEFINER',
      );
    }

    // Every RAISE carries a named SQLSTATE from the 23D block, which
    // this migration is the first to use, so the route maps it to a code
    // instead of surfacing a bare 23514 as a 500.
    const raises = sql.match(/RAISE EXCEPTION/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(15);
    expect(sql.match(/USING ERRCODE = '23D\d\d'/g)?.length).toBe(raises.length);

    // The despatch boundary is documented where the next pack will look
    // for it, because Inventory's stock ledger takes its foreign key
    // from this section.
    expect(sql).toContain('THE DESPATCH BOUNDARY');
    expect(sql).toContain('REFERENCES production_dispatches(organisation_id, id)');
  });

  it('binds the correspondence register in 0086', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0086_correspondence_register.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // Direction is a CHECK on text, deliberately, for the reason 0079
    // gives about its categories.
    expect(sql).toMatch(
      /direction text NOT NULL CHECK \(direction IN \('outward', 'inward'\)\)/,
    );
    expect(sql).not.toContain('CREATE TYPE');

    // The number is unique, and so is the SEQUENCE it was rendered from:
    // gap-freeness is only provable if two rows cannot share serial 7.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX correspondence_letters_number_unique\s+ON correspondence_letters \(organisation_id, letter_number\);/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX correspondence_letters_sequence_unique\s+ON correspondence_letters \(organisation_id, direction, financial_year, sequence_number\);/,
    );

    // Legal dates are date-only (engineering rule 6). No letter date on
    // this table is a timestamptz.
    for (const column of [
      'letter_date date',
      'sender_letter_date date',
      'response_due_on date',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).not.toContain('letter_date timestamptz');

    // Both composite foreign keys, including the self-reference that
    // makes a thread. A bare REFERENCES on the parent letter would point
    // across the tenant boundary without RLS ever seeing it.
    for (const composite of [
      'FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)',
      'FOREIGN KEY (organisation_id, reply_to_letter_id)\n    REFERENCES correspondence_letters(organisation_id, id)',
    ]) {
      expect(sql).toContain(composite);
    }

    // The scan's object key carries the tenant prefix here as well as in
    // packages/documents/src/storage.ts.
    expect(sql).toContain('correspondence_letters_scan_key_tenant_prefix_check');
    expect(sql).toMatch(
      /CHECK \(scan_object_key IS NULL OR scan_object_key LIKE organisation_id::text \|\| '\/%'\)/,
    );

    // An inward letter without its scan is the laptop folder this module
    // replaces; an outward letter with one is a letter we did not write.
    expect(sql).toContain('correspondence_letters_inward_shape_check');
    expect(sql).toContain('correspondence_letters_outward_shape_check');

    // Two tables, two policies, both in the ADR-0010 InitPlan shape.
    const initPlan =
      'USING (organisation_id = (SELECT app_private.current_organisation_id()))';
    expect(sql).toContain(
      `CREATE POLICY correspondence_letters_tenant_policy ON correspondence_letters
  ${initPlan}`,
    );
    expect(sql).toContain(
      `CREATE POLICY correspondence_letter_counters_tenant_policy
  ON correspondence_letter_counters
  ${initPlan}`,
    );

    // No DELETE anywhere: a letter cancels and keeps its number, and a
    // counter reset would reissue a number a cancelled letter still holds.
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON correspondence_letters TO auto_mb_app;',
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON correspondence_letter_counters TO auto_mb_app;',
    );
    expect(sql).not.toContain('DELETE ON correspondence_letters');
    expect(sql).not.toContain('DELETE ON correspondence_letter_counters');

    // Every named refusal is in this migration's own 23E block, so a
    // route can map them without matching on message text.
    const raises = sql.match(/USING ERRCODE = '(\w+)'/g) ?? [];
    expect(raises.length).toBeGreaterThan(0);
    for (const raise of raises) {
      expect(raise).toMatch(/USING ERRCODE = '23E0\d'/);
    }

    // The register is immutable except for cancellation, and a thread is
    // unwound from its newest end.
    expect(sql).toContain(
      'a registered letter is immutable; cancel it and file the correct one',
    );
    expect(sql).toContain('a cancelled letter cannot be reinstated');
    expect(sql).toContain('has been answered and cannot be cancelled');
    // The cancellation itself is frozen once written. The freeze above
    // has to exempt the triple so the ONE legal update can write it, and
    // this is the guard that closes that exemption behind it — otherwise
    // the reason, the actor and the moment of a cancellation stay
    // rewritable forever on the record that explains a retained number.
    expect(sql).toContain("a letter''s cancellation is immutable once recorded");
    expect(sql).toMatch(
      /IF OLD\.cancelled_at IS NOT NULL\s+AND ROW\(NEW\.cancelled_at, NEW\.cancelled_by_user_id, NEW\.cancellation_reason\)/,
    );

    // Every guard function pins its search_path, as 0067, 0077, 0079 and
    // 0083 do, and none runs with definer rights.
    const functions = sql.match(/CREATE FUNCTION app_private\.\w+/g) ?? [];
    expect(functions.length).toBe(2);
    for (const guard of [
      'app_private.guard_correspondence_letter_update()',
      'app_private.guard_correspondence_letter_thread()',
    ]) {
      const body = sql.slice(sql.indexOf(`CREATE FUNCTION ${guard}`));
      expect(body.slice(0, 200), guard).toContain(
        'SET search_path = pg_catalog, public',
      );
      expect(body.slice(0, body.indexOf('$$;')), guard).not.toContain(
        'SECURITY DEFINER',
      );
    }
  });

  it('binds the stock ledger in 0087', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0087_stock_ledger.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // THE BALANCE IS NEVER A COLUMN ON THE ITEM. The mock stores a
    // mutable `onHand` beside a per-movement `balanceAfter`, which is two
    // writers for one number; the whole pack rests on there being one.
    expect(sql).not.toMatch(/ADD COLUMN\s+on_hand|ADD COLUMN\s+reserved/i);
    expect(sql).not.toMatch(/CREATE TABLE stock_items/i);
    // The one column Inventory adds to the item master, and only that
    // one.
    expect(sql).toContain('ALTER TABLE production_items\n  ADD COLUMN reorder_level');

    // THE CACHED BALANCE IS GUARDED THREE WAYS, and each is asserted
    // because dropping any one of them turns a reconcilable cache into a
    // number that can drift: a CHECK that it is never negative, a trigger
    // that computes it, and no UPDATE grant to move it afterwards.
    expect(sql).toContain(
      'balance_after quantity_amount NOT NULL CHECK (balance_after >= 0)',
    );
    expect(sql).toContain('NEW.balance_after := previous + NEW.quantity;');
    expect(sql).toContain('GRANT SELECT, INSERT ON stock_movements TO auto_mb_app;');
    expect(sql).not.toContain('UPDATE ON stock_movements TO auto_mb_app');
    expect(sql).not.toContain('DELETE ON stock_movements TO auto_mb_app');

    // THE MUTEX IS THE COUNTER. That it is claimed FIRST is proved at
    // runtime, by watching a second writer actually block on the lock —
    // `stock-ledger.integration.test.ts`, "serialises two writers on one
    // part before either reads a balance". It used to be asserted here by
    // comparing substring POSITIONS in the file, which is not the same
    // claim: reordering two statements would have failed it, and moving
    // the balance read into a helper called from the top would have
    // passed it while breaking the lock. A file offset cannot see a lock.
    expect(sql).toContain('INSERT INTO stock_movement_counters');
    expect(sql).toContain('RETURNING next_value INTO NEW.sequence_number;');
    expect(sql).not.toMatch(/max\(sequence_number\)/);
    // 0064's rule: the ledger position may only ever climb.
    expect(sql).toContain('CREATE TRIGGER stock_movement_counters_guard_decrease');

    // TIME ONLY RUNS FORWARD, PER PART. The whole readability of
    // `balance_after` rests on this: a movement posted after another and
    // dated before it leaves a running total that skips a movement
    // earlier than itself.
    expect(sql).toContain("USING ERRCODE = '23F04'");
    expect(sql).toMatch(/SELECT max\(m\.movement_date\) INTO latest_date/);
    expect(sql).toContain('cannot be posted behind it');
    // …and the register's key is the POSTING order, not the wall clock:
    // created_at defaults to transaction start and is not monotonic with
    // respect to commit order.
    expect(sql).toContain(
      'ON stock_movements (organisation_id, movement_date, sequence_number, id);',
    );
    expect(sql).not.toContain('movement_date, created_at');

    // ONE LINE, ONE RECEIPT CHANNEL: a challan item may not claim a line
    // that is received into stock, or its quantity would be counted by
    // neither channel.
    expect(sql).toContain('app_private.guard_challan_line_receipt_channel()');
    expect(sql).toContain('CREATE TRIGGER delivery_challan_items_receipt_channel');
    expect(sql).toContain("USING ERRCODE = '23F05'");

    // R8 reaches through BOTH indirect arms, or they become the way
    // round the direct one.
    expect(sql).toContain('purchase order line % belongs to work %, which is %');
    expect(sql).toContain('job card % serves work %, which is %');
    // The purchase order's status is share-locked while it is depended on.
    expect(sql).toContain('FOR SHARE OF po;');

    // The requirement function nets what the card already holds, and
    // laterals 0084's helper rather than walking the edges again.
    expect(sql).toContain('app_private.production_bom_requirements(org, c.item_id)');
    expect(sql).toContain('SELECT -sum(m.quantity) AS net_out');
    expect(sql).not.toMatch(/WITH RECURSIVE/);

    // The sign belongs to the movement type, and the shape to the source
    // document. Both are CHECKs rather than conventions, so a writer
    // reaching the table another way cannot record an issue that adds
    // stock or a receipt that names nothing.
    expect(sql).toContain('stock_movements_direction_check');
    expect(sql).toContain('stock_movements_source_shape_check');
    for (const type of [
      'production_receipt',
      'purchase_receipt',
      'issue',
      'return',
      'adjustment_in',
      'adjustment_out',
    ]) {
      expect(sql, type).toContain(`'${type}'`);
    }
    expect(sql).not.toContain('CREATE TYPE');

    // 0084 § 7's interface, taken exactly as it was offered — and the
    // key that closes the despatch delete path.
    expect(sql).toContain(
      'FOREIGN KEY (organisation_id, production_dispatch_id)\n    REFERENCES production_dispatches(organisation_id, id)',
    );
    // A despatch reaches the shelf once. Non-partial so the foreign key
    // can use it (fk-index-coverage's rule), which NULL-distinctness
    // makes possible without excluding every other movement.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX stock_movements_dispatch_once\n  ON stock_movements (organisation_id, production_dispatch_id);',
    );
    // The despatch's unit count is production's statement, counted here
    // rather than typed.
    expect(sql).toContain('SELECT count(*) INTO released');

    // The procurement module is EXTENDED, not duplicated: no second
    // purchase-order concept, and the two new columns are nullable so
    // every line that predates this migration behaves as it did.
    expect(sql).not.toMatch(
      /CREATE TABLE supplier_purchase_orders|CREATE TABLE supplier_pos/i,
    );
    expect(sql).toContain('ALTER TABLE purchase_order_lines');
    expect(sql).toContain('ADD COLUMN production_item_id uuid,');
    expect(sql).toContain('ADD COLUMN production_job_card_id uuid,');
    expect(sql).toContain('purchase_order_lines_shortage_shape_check');

    // The explosion terminates because it DELEGATES: 0084's helper is
    // iterative and carries the depth bound itself, so this migration
    // walks no edges of its own. The first cut had a recursive CTE with a
    // CYCLE clause here, which re-walked a shared sub-assembly once per
    // job card that reached it and enumerated a path array per row.
    expect(sql).toContain('app_private.stock_outstanding_requirement');
    expect(sql).toContain('app_private.production_bom_requirements(org, c.item_id)');
    expect(sql).not.toMatch(/CYCLE \w+ SET is_cycle/);
    expect(sql).not.toMatch(/WITH RECURSIVE/);

    // Both tables in the ADR-0010 InitPlan policy shape.
    for (const table of ['stock_movements', 'stock_movement_counters']) {
      expect(sql, table).toContain(
        `CREATE POLICY ${table}_tenant_policy ON ${table}\n  USING (organisation_id = (SELECT app_private.current_organisation_id()))`,
      );
      expect(sql, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    }

    // Every function pins its search_path, and none is SECURITY DEFINER.
    const functions = sql.match(/CREATE FUNCTION app_private\.\w+/g) ?? [];
    expect(functions.length).toBeGreaterThanOrEqual(3);
    expect(sql.match(/SET search_path = pg_catalog, public/g)?.length).toBe(
      functions.length,
    );
    // Bodies only: the header explains in prose why none of them is a
    // definer, and a naive substring search would find that sentence.
    for (const declaration of functions) {
      const source = sql.slice(sql.indexOf(declaration));
      expect(source.slice(0, source.indexOf('$$;')), declaration).not.toContain(
        'SECURITY DEFINER',
      );
    }

    // Every RAISE carries a named SQLSTATE from the 23F block, which this
    // migration is the first to use, so `routes/inventory.ts` maps it to
    // a code instead of surfacing a bare 23514 as a 500.
    const raises = sql.match(/RAISE EXCEPTION/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(10);
    expect(sql.match(/USING ERRCODE = '23F\d\d'/g)?.length).toBe(raises.length);
  });

  it('binds maintenance in 0088', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0088_maintenance.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // FOUR OF THE MOCK'S SIX LINE QUANTITIES HAVE NO WRITER. Only the
    // ordered quantity, the promised return and the write-off are stored;
    // available, reserved, dispatched and received-back are derived, and
    // a column for any of them is the drift this module refused.
    for (const column of [
      'quantity quantity_amount NOT NULL CHECK (quantity > 0)',
      'expected_return_quantity quantity_amount NOT NULL DEFAULT 0',
      'cancelled_quantity quantity_amount NOT NULL DEFAULT 0',
    ]) {
      expect(sql, column).toContain(column);
    }
    expect(sql).not.toMatch(/ADD COLUMN\s+available_quantity/i);
    expect(sql).not.toMatch(/reserved_quantity\s+quantity_amount/i);
    expect(sql).not.toMatch(/dispatched_quantity\s+quantity_amount/i);
    expect(sql).not.toMatch(/received_return_quantity\s+quantity_amount/i);
    // The two functions the derivations go through, so the dispatch
    // ceiling and the closure gate cannot be computed two different ways.
    expect(sql).toContain(
      'app_private.maintenance_line_outstanding(org uuid, line uuid)',
    );
    expect(sql).toContain(
      'app_private.maintenance_line_return_due(org uuid, line uuid)',
    );

    // States are CHECKed text, not an enum, for the reason 0079 and 0086
    // give about theirs.
    expect(sql).toMatch(
      /status IN \('awaiting_approval', 'approved', 'partially_dispatched', 'closed'\)/,
    );
    expect(sql).toMatch(/priority IN \('routine', 'urgent', 'critical'\)/);
    expect(sql).not.toContain('CREATE TYPE');

    // Both numbers are unique, and so is each SEQUENCE they were rendered
    // from: gap-freeness is only provable if two rows cannot share
    // serial 7.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX maintenance_requests_number_unique\s+ON maintenance_requests \(organisation_id, request_number\);/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX maintenance_requests_sequence_unique\s+ON maintenance_requests \(organisation_id, financial_year, sequence_number\);/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX maintenance_dispatches_sequence_per_work\s+ON maintenance_dispatches \(organisation_id, work_id, sequence_number\);/,
    );
    expect(sql).not.toMatch(/max\(sequence_number\)/);
    for (const counter of [
      'maintenance_request_counters',
      'maintenance_dispatch_counters',
    ]) {
      expect(sql, counter).toContain(`CREATE TRIGGER ${counter}_guard_decrease`);
    }

    // Legal dates are date-only (engineering rule 6), and the two that
    // bound against the ORGANISATION's today do so through 0082's helper
    // rather than the server's clock.
    for (const column of [
      'required_by date',
      'dispatch_date date NOT NULL',
      'received_on date NOT NULL',
    ]) {
      expect(sql, column).toContain(column);
    }
    expect(sql).not.toContain('dispatch_date timestamptz');
    expect(
      sql.match(/app_private\.organisation_today\(NEW\.organisation_id\)/g)?.length,
    ).toBe(2);

    // Every foreign key is composite, so none can point across the tenant
    // boundary with RLS never seeing it.
    for (const composite of [
      'FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)',
      'FOREIGN KEY (organisation_id, maintenance_request_id)\n    REFERENCES maintenance_requests(organisation_id, id)',
      'FOREIGN KEY (organisation_id, production_item_id)\n    REFERENCES production_items(organisation_id, id)',
      'FOREIGN KEY (organisation_id, maintenance_request_id, work_id)\n    REFERENCES maintenance_requests(organisation_id, id, work_id)',
      'FOREIGN KEY (organisation_id, maintenance_dispatch_id)\n    REFERENCES maintenance_dispatches(organisation_id, id)',
    ]) {
      expect(sql, composite).toContain(composite);
    }

    // THE LEDGER LEARNS A THIRD SOURCE. An issue may name a job card, a
    // Work, or — from this migration — the maintenance challan that took
    // the material off the shelf. Counted rather than paired, so a fourth
    // source is one more term.
    expect(sql).toContain('ADD COLUMN maintenance_dispatch_id uuid,');
    expect(sql).toContain('DROP CONSTRAINT stock_movements_source_shape_check;');
    expect(sql).toContain('+ (maintenance_dispatch_id IS NOT NULL)::int = 1');
    // The non-partial leading index the new foreign key needs.
    expect(sql).toContain(
      'CREATE INDEX stock_movements_maintenance_dispatch_idx\n  ON stock_movements (organisation_id, maintenance_dispatch_id);',
    );

    // Seven tables, seven policies, all in the ADR-0010 InitPlan shape,
    // and none of them grants DELETE: a request keeps its number, a
    // challan records material that physically left.
    const tables = [
      'maintenance_request_counters',
      'maintenance_requests',
      'maintenance_request_lines',
      'maintenance_dispatch_counters',
      'maintenance_dispatches',
      'maintenance_dispatch_lines',
      'maintenance_returns',
    ];
    for (const table of tables) {
      expect(sql, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(sql, table).toContain(`${table}_tenant_policy`);
      expect(sql, table).not.toContain(`DELETE ON ${table}`);
    }
    // Both arms of all seven policies wrap the helper in a scalar
    // subquery, which is the whole of ADR-0010.
    expect(
      sql.match(
        /organisation_id = \(SELECT app_private\.current_organisation_id\(\)\)/g,
      )?.length,
    ).toBe(tables.length * 2);
    for (const appendOnly of [
      'maintenance_dispatches',
      'maintenance_dispatch_lines',
      'maintenance_returns',
    ]) {
      expect(sql, appendOnly).toContain(
        `GRANT SELECT, INSERT ON ${appendOnly} TO auto_mb_app;`,
      );
      expect(sql, appendOnly).not.toContain(`UPDATE ON ${appendOnly} TO auto_mb_app`);
    }

    // The closure gate is a rule, not a disabled button, and the terms
    // are frozen from the moment the request is raised.
    expect(sql).toContain('material still to dispatch or cancel');
    expect(sql).toContain('defective units still owed back');
    expect(sql).toContain(
      'a raised maintenance request is immutable; close it and raise the corrected one',
    );
    expect(sql).toContain(
      "a maintenance request''s approval is immutable once recorded",
    );

    // Every function pins its search_path, and none is SECURITY DEFINER.
    const functions = sql.match(/CREATE FUNCTION app_private\.\w+/g) ?? [];
    expect(functions.length).toBe(10);
    expect(sql.match(/SET search_path = pg_catalog, public/g)?.length).toBe(
      functions.length,
    );
    for (const declaration of functions) {
      const source = sql.slice(sql.indexOf(declaration));
      expect(source.slice(0, source.indexOf('$$;')), declaration).not.toContain(
        'SECURITY DEFINER',
      );
    }

    // THE RETURN CEILING IS WHAT WENT OUT, not what was promised. Read
    // against the gross promise, a line ordered 4 / promised 4 back /
    // dispatched 1 / written off 3 can never be closed, because
    // `expected_return_quantity` is frozen and nothing can lower it.
    expect(sql).toContain('least(');
    expect(sql).toMatch(
      /least\(\s*l\.expected_return_quantity,\s*coalesce\(\s*\(\s*SELECT sum\(d\.quantity\)\s*FROM maintenance_dispatch_lines d/,
    );

    // A line may only be appended while the request is undecided, and
    // the ledger's third source is validated like the other two.
    expect(sql).toContain('CREATE TRIGGER maintenance_request_lines_guard_insert');
    expect(sql).toContain('and takes no further material lines');
    expect(sql).toContain('CREATE TRIGGER stock_movements_maintenance_source_guard');
    expect(sql).toContain('carries no line for item');
    expect(sql).toContain('serves work %, which is %');
    // …and 0087's function is NOT replaced from here: that would leave
    // its own file describing a function the database no longer has,
    // which the assertions in this suite read.
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION app_private.guard_stock_movement',
    );

    // A withdrawn Work is not a Work, on the request path as on every
    // arm of the ledger's own guard.
    expect(sql).toContain('AND w.deleted_at IS NULL');

    // Every RAISE carries a named SQLSTATE. The module's own rules use
    // the 23G block, which this migration is the first to claim; the
    // four that police the STOCK LEDGER's new source deliberately reuse
    // 0087's 23F02, because `routes/inventory.ts` already maps it and a
    // second code for "the source document does not admit it" would be
    // the same refusal under two names.
    const raises = sql.match(/RAISE EXCEPTION/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(12);
    const named = sql.match(/USING ERRCODE = '(23[FG]\d\d)'/g) ?? [];
    expect(named.length).toBe(raises.length);
    expect(named.filter((code) => code.includes('23F')).length).toBe(4);
  });

  it('binds the employee master and the statutory schedules in 0089', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0089_employees.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // Four tenant tables, all in the ADR-0010 InitPlan policy shape.
    for (const table of [
      'employees',
      'payroll_statutory_rates',
      'professional_tax_slabs',
      'income_tax_slabs',
    ]) {
      expect(sql, table).toContain(
        `CREATE POLICY ${table}_tenant_policy ON ${table}\n  USING (organisation_id = (SELECT app_private.current_organisation_id()))`,
      );
      expect(sql, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      // Masters retire by end-dating and an employee is end-dated by an
      // exit date; nothing here is ever removed.
      expect(sql, table).toContain(
        `GRANT SELECT, INSERT, UPDATE ON ${table} TO auto_mb_app;`,
      );
      expect(sql, table).not.toContain(`DELETE ON ${table} TO auto_mb_app`);
    }

    // THE WHOLE POINT OF THE PACK'S SCHEDULE DESIGN, asserted rather than
    // left to review: a statutory value is a dated ROW, never a constant.
    // Each of the three tables carries the range of dates it was in force
    // for, and the arithmetic resolves it at the run's own month.
    for (const table of [
      'payroll_statutory_rates',
      'professional_tax_slabs',
      'income_tax_slabs',
    ]) {
      const body = sql.slice(sql.indexOf(`CREATE TABLE ${table} (`));
      const columns = body.slice(0, body.indexOf('\n);'));
      expect(columns, table).toContain('effective_from date NOT NULL');
      expect(columns, table).toContain('effective_to date CHECK');
    }

    // No Aadhaar column, ever. Checked against the SQL with its comments
    // stripped, because the migration's own prose explains at length why
    // the number is not here, and a bare substring search would find that
    // explanation and pass on it.
    const code = sql.replace(/--.*$/gm, '').toLowerCase();
    expect(code).not.toContain('aadhaar');
    expect(code).not.toContain('aadhar');

    // The employee is a satellite of the party master, not a second one.
    expect(sql).toContain('FOREIGN KEY (organisation_id, contact_id)');
    expect(sql).toContain('REFERENCES contacts(organisation_id, id)');
    // ...which is only workable because the designation-duplicate rule
    // was narrowed off people: two employees of one name is not a
    // duplicate, it is Tuesday.
    expect(sql).toContain('WHERE active AND NOT is_employee;');

    const functions = sql.match(/CREATE FUNCTION app_private\.\w+/g) ?? [];
    expect(functions.length).toBeGreaterThanOrEqual(1);
    expect(sql.match(/SET search_path = pg_catalog, public/g)?.length).toBe(
      functions.length,
    );
    for (const declaration of functions) {
      const source = sql.slice(sql.indexOf(declaration));
      // Comments stripped first. Each of these functions carries a
      // comment saying WHY it is not a definer — exactly the trap 0087's
      // own test warns about — and a naive substring search finds that
      // sentence rather than a defect.
      expect(
        source.slice(0, source.indexOf('$$;')).replace(/--.*$/gm, ''),
        declaration,
      ).not.toContain('SECURITY DEFINER');
    }

    // Every RAISE carries a named SQLSTATE, and every one that is a
    // payroll refusal is from the 23H block this pack opened, so
    // `routes/hr.ts` maps it to a code instead of surfacing a bare 23514
    // as a 500. The one exception is the bootstrap function this file
    // re-states to grant the owner the payroll authority (create_
    // organisation_with_owner, 0004): its single RAISE keeps 0004's own
    // 28000 "no authenticated user" code, which is not a payroll refusal.
    const raises = sql.match(/RAISE EXCEPTION/g) ?? [];
    const namedPayroll = sql.match(/USING ERRCODE = '23H\d\d'/g) ?? [];
    const bootstrapRaise = sql.match(/USING ERRCODE = '28000'/g) ?? [];
    expect(namedPayroll.length).toBeGreaterThanOrEqual(2);
    expect(namedPayroll.length + bootstrapRaise.length).toBe(raises.length);
  });

  it('binds the payroll run in 0090', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0090_payroll.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    for (const table of ['payroll_runs', 'payroll_run_lines', 'payroll_run_counters']) {
      expect(sql, table).toContain(
        `CREATE POLICY ${table}_tenant_policy ON ${table}\n  USING (organisation_id = (SELECT app_private.current_organisation_id()))`,
      );
      expect(sql, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    }

    // A run is an issued document: no DELETE at any status, not even a
    // draft. It has claimed a number by the time it exists, and a gap in
    // the series is what a provident-fund inspector reads.
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON payroll_runs TO auto_mb_app;',
    );
    expect(sql).not.toContain('DELETE ON payroll_runs TO auto_mb_app');
    // Its LINES do delete, for the recalculation of a draft and nothing
    // else — the guard is what closes that path the moment the run is
    // finalised or cancelled.
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_run_lines TO auto_mb_app;',
    );
    expect(sql).toContain('BEFORE INSERT OR UPDATE OR DELETE ON payroll_run_lines');

    // The number comes off a counter claimed by upsert. NEVER max()+1.
    expect(sql).toContain('CREATE TABLE payroll_run_counters');
    expect(sql).toContain('CREATE TRIGGER payroll_run_counters_guard_decrease');
    expect(sql).not.toMatch(/max\(sequence_number\)/);

    // MONEY ENFORCED TWICE. The arithmetic is a CHECK as well as a
    // computation: the four heads sum to the gross, and the gross less
    // the four EMPLOYEE-side deductions is the net. A payslip that took
    // an employer contribution off somebody's pay is impossible here,
    // not merely unlikely.
    expect(sql).toContain('CONSTRAINT payroll_run_lines_gross_check');
    expect(sql).toContain('CONSTRAINT payroll_run_lines_net_check');

    // The pension share is capped by its OWN ceiling and the employer's
    // fund share is the remainder — a subtraction, never a third rate.
    // The widely quoted 3.67% is only exactly 3.67% at or below the
    // ceiling, so the number must not appear in the arithmetic at all.
    expect(sql).toContain('v_epf_employer := v_epf_total - v_eps_employer;');
    // Matched against ASSIGNMENTS rather than the whole file: the header
    // and two column comments explain the 3.67% figure at length, and a
    // bare search would find the explanation instead of the defect.
    expect(sql).not.toMatch(/:=[^;]*3\.67/);

    // ESI rounds UP, both shares: regulation 40, and rounding an
    // insurance contribution down is a short remittance.
    expect(sql).toContain('v_esi_employee := ceil(');
    expect(sql).toContain('v_esi_employer := ceil(');

    // Surcharge is refused rather than approximated. An under-deduction
    // under section 192 is the employer's own liability, with interest.
    expect(sql).toContain("USING ERRCODE = '23H05'");
    expect(sql).toContain('v_total_income > v_surcharge_floor');

    // Includes the CREATE OR REPLACE of 0080's payment-request guard,
    // which this file re-states to exempt a salary request from
    // maker-checker (§ 4b). Every function here pins its search_path and
    // none is a definer.
    const functions =
      sql.match(/CREATE (?:OR REPLACE )?FUNCTION app_private\.\w+/g) ?? [];
    expect(functions.length).toBeGreaterThanOrEqual(5);
    expect(sql.match(/SET search_path = pg_catalog, public/g)?.length).toBe(
      functions.length,
    );
    for (const declaration of functions) {
      const source = sql.slice(sql.indexOf(declaration));
      // Comments stripped, for the reason the 0089 test above gives.
      expect(
        source.slice(0, source.indexOf('$$;')).replace(/--.*$/gm, ''),
        declaration,
      ).not.toContain('SECURITY DEFINER');
    }

    // Every RAISE carries a named SQLSTATE. The payroll refusals use the
    // 23H block this pack opened; the re-stated 0080 payment-request
    // guard (§ 4b) keeps 0080's own 23B codes, since those are payments
    // refusals `routes/payments.ts` already maps, not payroll ones.
    const raises = sql.match(/RAISE EXCEPTION/g) ?? [];
    const namedPayroll = sql.match(/USING ERRCODE = '23H\d\d'/g) ?? [];
    const namedPayments = sql.match(/USING ERRCODE = '23B\d\d'/g) ?? [];
    expect(namedPayroll.length).toBeGreaterThanOrEqual(15);
    expect(namedPayroll.length + namedPayments.length).toBe(raises.length);
  });

  it('binds the signing queue in 0091', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0091_signing_requests.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // THE AUTHORISATION IS A DIGEST OVER NAMED BYTES, and all three parts
    // of it are NOT NULL columns rather than a convention the route keeps.
    // ADR-0012 § "The approval is the authority, and it must be bound to
    // the bytes" is unimplementable if any of them can be absent.
    // 0065's domain, so the shape cannot drift from every other digest
    // column in the schema.
    expect(sql).toContain('authorised_digest sha256_hex NOT NULL');
    expect(sql).toContain('source_sha256 sha256_hex NOT NULL');
    expect(sql).toContain('expires_at timestamptz NOT NULL');
    // …and the entries that go INSIDE the signed bytes are stored, not
    // recomputed. A preparation taken from the clock at completion time
    // would differ from the one that was authorised, which would make the
    // re-derivation check unpassable rather than strict.
    expect(sql).toContain('claimed_signing_time timestamptz NOT NULL');

    // THE TOKEN IS NEVER STORED. Only its digest, in the one shape the
    // resolver can look up.
    expect(sql).toContain('token_hash sha256_hex NOT NULL');
    expect(sql).not.toMatch(/^\s*(token|secret|bearer_token) text\b/im);

    // THE CERTIFICATE IS PINNED BY THUMBPRINT AND NOTHING ELSE. A
    // subject-name column that a query could match on is exactly the
    // selection mistake the pin exists to prevent, so the subject is
    // stored for display and the uniqueness lives on the thumbprint's
    // shape.
    expect(sql).toContain(
      "certificate_thumbprint text NOT NULL\n    CHECK (certificate_thumbprint ~ '^[0-9A-F]{40}$')",
    );

    // ONE OPEN REQUEST PER DOCUMENT, per register, as partial unique
    // indexes — the same mechanism as one draft challan per Work. Two
    // live authorisations over one document produce two "the" signed
    // copies and no answer to which is the record.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX signing_requests_one_open_per_challan\s+ON signing_requests \(organisation_id, delivery_challan_id\)\s+WHERE delivery_challan_id IS NOT NULL AND status IN \('pending', 'claimed'\);/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX signing_requests_one_open_per_invoice\s+ON signing_requests \(organisation_id, tax_invoice_id\)\s+WHERE tax_invoice_id IS NOT NULL AND status IN \('pending', 'claimed'\);/,
    );

    // THE DOCUMENT IS A REAL FOREIGN KEY, not a (type, id) pair the
    // database cannot check, and the shape CHECK is what ties the two
    // nullable arms to the declared type.
    expect(sql).toContain('signing_requests_document_shape');
    expect(sql).toContain(
      'FOREIGN KEY (organisation_id, delivery_challan_id, work_id)\n    REFERENCES delivery_challans (organisation_id, id, work_id)',
    );
    expect(sql).toContain(
      'FOREIGN KEY (organisation_id, tax_invoice_id, work_id)\n    REFERENCES tax_invoices (organisation_id, id, work_id)',
    );
    // The THIRD column is what makes the denormalised work_id
    // unfalsifiable rather than merely conventional, so the key the
    // invoice register gains for it is asserted too.
    expect(sql).toContain(
      'ADD CONSTRAINT tax_invoices_organisation_id_id_work_id_key\n  UNIQUE (organisation_id, id, work_id);',
    );

    // SIGNED BYTES EXIST EXACTLY WHEN THE VERDICT SAYS SO. The outcome
    // CHECK is the database's copy of the route's acceptance rule: bytes
    // and a `signed_and_intact` verdict arrive together or not at all.
    expect(sql).toContain('signing_requests_outcome_shape');
    expect(sql).toContain("signature_status = 'signed_and_intact'");

    // Both tables in the ADR-0010 InitPlan policy shape, and neither
    // grants DELETE: a signature is a record of an act.
    for (const table of ['signing_requests', 'signing_agents']) {
      expect(sql, table).toContain(
        `CREATE POLICY ${table}_tenant_policy ON ${table}\n  USING (organisation_id = (SELECT app_private.current_organisation_id()))`,
      );
      expect(sql, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(sql, table).toContain(
        `GRANT SELECT, INSERT, UPDATE ON ${table} TO auto_mb_app;`,
      );
      expect(sql, table).not.toContain(`DELETE ON ${table} TO auto_mb_app`);
    }

    // EXACTLY ONE SECURITY DEFINER, and it is the token resolver — the
    // one read that must cross tenancy because the tenant is what the
    // token is being read to discover. Both guards are invoker-rights and
    // every function pins its search_path.
    // The migration's own three. `create_organisation_with_owner` is
    // separately re-created here — CREATE OR REPLACE, so it is not in
    // this match — to give the founding owner the new authority; it keeps
    // 0004's definer status and 0004's search_path, and asserting this
    // migration's conventions over copied code would be asserting the
    // wrong thing.
    const functions = sql.match(/CREATE FUNCTION app_private\.\w+/g) ?? [];
    expect(functions).toHaveLength(3);
    expect(sql.match(/^SET search_path = pg_catalog, public/gm)).toHaveLength(
      functions.length,
    );
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION app_private.create_organisation_with_owner(',
    );
    // Four trues, and the fourth is 0089's. Both 0089 and 0091 replace
    // this function, 0091 runs second, and a replacement states the
    // whole body — so this migration must restate the payroll grant or
    // silently revoke it from every founder. The assertion pins both
    // authorities so dropping either fails here rather than in a
    // founder's first payroll run.
    expect(sql).toContain('can_manage_payroll, status');
    expect(sql).toContain(
      "VALUES (p_id, v_user_id, 'owner', 'all', true, true, true, true, 'active');",
    );
    // Bodies only, in the sibling migrations' idiom: the header explains
    // in prose why the guards are not definers, and a naive substring
    // search would find that sentence.
    const definers = functions.filter((declaration) => {
      const source = sql.slice(sql.indexOf(declaration));
      return source.slice(0, source.indexOf('$$;')).includes('SECURITY DEFINER');
    });
    expect(definers).toEqual(['CREATE FUNCTION app_private.resolve_signing_agent']);
    expect(sql).toContain(
      'CREATE FUNCTION app_private.resolve_signing_agent(p_token_hash text)',
    );
    expect(sql).toContain(
      'ALTER FUNCTION app_private.resolve_signing_agent(text) OWNER TO auto_mb_definer;',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION app_private.resolve_signing_agent(text) FROM PUBLIC;',
    );
    // It answers with three values and no more: an agent that could read
    // its siblings, or a caller that could enumerate agents by anything
    // other than a 64-hex digest, would make the definer a door.
    expect(sql).toContain(
      'RETURNS TABLE (agent_id uuid, organisation_id uuid, operator_user_id text)',
    );
    expect(sql).toContain('WHERE a.token_hash = p_token_hash');
    expect(sql).toContain('AND a.revoked_at IS NULL');

    // SIGNING IS ITS OWN AUTHORITY (owner ruling 2026-08-18), in 0061's
    // and 0080's shape: a per-member column, default false, not
    // backfilled. `issue` does not confer it.
    expect(sql).toContain(
      'ALTER TABLE organisation_memberships\n  ADD COLUMN can_sign_documents boolean NOT NULL DEFAULT false;',
    );

    // EVERY TERMINAL DOOR IS OPEN, and each one closes a wedge that a
    // narrower state machine actually produced:
    //
    //   pending -> failed    a revocation kills requests nobody claimed.
    //                        Without it the revoke transaction raises
    //                        23J01 and rolls the revocation itself back.
    //   claimed -> cancelled the operator's exit from a lease the kiosk
    //                        abandoned. Without it the partial unique
    //                        index blocks the document forever.
    expect(sql).toContain(
      "(OLD.status = 'pending' AND NEW.status IN ('claimed', 'cancelled', 'failed'))",
    );
    expect(sql).toContain(
      "OR (OLD.status = 'claimed' AND NEW.status IN ('signed', 'failed', 'cancelled'))",
    );
    // …and nothing rewinds: `claimed` never returns to `pending`, because
    // the token may already have produced a signature the server has not
    // seen. A kiosk re-takes a lapsed claim by claiming it again, which is
    // not a status change at all.
    expect(sql).not.toMatch(/NEW\.status = 'pending'/);

    // Every RAISE in the migration's OWN guards carries a named SQLSTATE
    // from the 23J block, which this migration is the first to use, so
    // `routes/signing.ts` maps it to a code instead of surfacing a bare
    // 23514 as a 500.
    //
    // Scoped to the guards, because the file also re-creates
    // `create_organisation_with_owner` verbatim from 0004 (plus the new
    // column) and that function carries 0004's own 28000. Widening the
    // 23J rule over it would be asserting the wrong thing about copied
    // code.
    const guards = sql.slice(sql.indexOf('CREATE FUNCTION app_private.guard_signing'));
    const raises = guards.match(/RAISE EXCEPTION/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(6);
    expect(guards.match(/USING ERRCODE = '23J\d\d'/g)?.length).toBe(raises.length);
  });

  it('binds the notification registers in 0092', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0092_notifications.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // NO CREDENTIAL IS EVER STORED. The access token, the Meta app secret
    // and the SMTP password are deployment environment read into an
    // injected adapter (`apps/server/src/notify/transport.ts`), which is
    // the statutory transport's posture and is here for the same reason:
    // a secret in a tenant table is a secret in the organisation's own
    // export and in every backup. What the schema holds is identity.
    expect(sql).not.toMatch(/^\s*(access_token|app_secret|api_key|password)\b/im);
    expect(sql).toContain(
      "waba_phone_number_id text CHECK (waba_phone_number_id ~ '^[0-9]{5,32}$')",
    );

    // THE WEBHOOK RESOLVES A TENANT BY THE PHONE NUMBER ID, before any
    // tenant is bound, so that value has to name one row in the CLUSTER
    // rather than one row per organisation. Partial, because most rows
    // are email rows with no phone number at all.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX notification_channels_waba_phone_number_id_key\n' +
        '  ON notification_channels (waba_phone_number_id)\n' +
        '  WHERE waba_phone_number_id IS NOT NULL;',
    );
    // The same argument for the provider's own message id: a receipt
    // names a message by it and nothing else.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX notification_messages_provider_message_id_key\n' +
        '  ON notification_messages (provider_message_id)\n' +
        '  WHERE provider_message_id IS NOT NULL;',
    );

    // CONSENT IS PER ADDRESS. The column is NOT NULL and shaped per
    // channel, and the message guard compares it against the address the
    // message is going to — which is what stops an agreement given for
    // one number carrying across to whoever holds it next.
    expect(sql).toContain('notification_consents_address_shape');
    expect(sql).toContain("WHEN 'whatsapp' THEN address ~ '^\\+[1-9][0-9]{7,14}$'");
    expect(sql).toContain('OR v_consent.address <> NEW.to_address');

    // THE DELIVERY LEDGER IS FORWARD ONLY, stated in BOTH arms: the
    // definer function's WHERE clause makes a late or duplicate receipt a
    // silent no-op, and the guard makes any other writer's rewind a named
    // refusal.
    expect(sql).toContain(
      "(OLD.status = 'queued' AND NEW.status IN ('sent', 'delivered', 'read', 'failed'))",
    );
    expect(sql).toContain("OR (OLD.status = 'delivered' AND NEW.status = 'read')");
    expect(sql).not.toMatch(/NEW\.status = 'queued'/);
    expect(sql).toContain('notification_messages_outcome_shape');

    // …and the receipt path carries NO `queued` arm at all, which is not
    // an oversight but a consequence: the outcome shape requires a queued
    // row to hold a NULL provider_message_id, and this function finds a
    // row BY that id. An arm admitting `queued` would be a branch no test
    // could ever cover, which is how dead code gets documented as live.
    const receipt = sql.slice(
      sql.indexOf('CREATE FUNCTION app_private.record_notification_receipt'),
      sql.indexOf('CREATE FUNCTION app_private.guard_notification_channel'),
    );
    expect(receipt).toContain("WHEN 'delivered' THEN m.status = 'sent'");
    expect(receipt).not.toMatch(/m\.status IN \('queued'/);

    // THE TEMPLATE LIFECYCLE ADMITS WHAT META ACTUALLY DOES. A rejection
    // is not terminal — Meta's own remedy is edit and resubmit, and an
    // appeal reaches approval through review — and because
    // (organisation_id, name, language) is unique with no DELETE grant, a
    // dead end would burn the template name forever.
    expect(sql).toContain(
      "OR (OLD.status = 'rejected' AND NEW.status IN ('pending', 'disabled'))",
    );
    expect(sql).toContain(
      "(OLD.status = 'draft' AND NEW.status IN ('pending', 'disabled'))",
    );
    // …and `disabled` stays terminal: Meta withdrew it, and getting it
    // back is a new template.
    expect(sql).not.toMatch(/OLD\.status = 'disabled'/);
    // The body is editable exactly while Meta is not holding it.
    expect(sql).toContain("IF OLD.status NOT IN ('draft', 'rejected')");

    // All four tables in the ADR-0010 InitPlan policy shape, and none of
    // them grants DELETE.
    for (const table of [
      'notification_channels',
      'notification_templates',
      'notification_consents',
      'notification_messages',
    ]) {
      expect(sql, table).toContain(
        `CREATE POLICY ${table}_tenant_policy ON ${table}\n  USING (organisation_id = (SELECT app_private.current_organisation_id()))`,
      );
      expect(sql, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(sql, table).toContain(
        `GRANT SELECT, INSERT, UPDATE ON ${table} TO auto_mb_app;`,
      );
      expect(sql, table).not.toContain(`DELETE ON ${table} TO auto_mb_app`);
    }

    // EXACTLY ONE SECURITY DEFINER, and it is the webhook receipt writer
    // — the one write that must cross tenancy, because Meta is not a
    // member of anything and there is no member to bind a transaction
    // as. The four guards are invoker-rights and every function pins its
    // search_path.
    const functions = sql.match(/CREATE FUNCTION app_private\.\w+/g) ?? [];
    expect(functions).toHaveLength(5);
    expect(sql.match(/^SET search_path = pg_catalog, public/gm)).toHaveLength(
      functions.length,
    );
    const definers = functions.filter((declaration) => {
      const source = sql.slice(sql.indexOf(declaration));
      return source.slice(0, source.indexOf('$$;')).includes('SECURITY DEFINER');
    });
    expect(definers).toEqual([
      'CREATE FUNCTION app_private.record_notification_receipt',
    ]);
    expect(sql).toContain(
      'ALTER FUNCTION app_private.record_notification_receipt(\n  text, text, text, timestamptz, text, text\n) OWNER TO auto_mb_definer;',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION app_private.record_notification_receipt(\n  text, text, text, timestamptz, text, text\n) FROM PUBLIC;',
    );
    // It answers with a boolean and nothing else, and is scoped by BOTH
    // the phone number id and the provider message id: a forged receipt
    // cannot move a row belonging to the organisation that does not own
    // the number it arrived on.
    // It answers WHY it did nothing, not merely whether. The receiver has
    // to retry a `missing` receipt — the send's completion transaction
    // has not committed yet — and must never retry the other two, so a
    // boolean could not carry the decision.
    expect(sql).toContain('RETURNS text');
    for (const outcome of ["'applied'", "'ahead'", "'missing'", "'unknown_channel'"]) {
      expect(sql, outcome).toContain(outcome);
    }
    expect(sql).toContain('WHERE c.waba_phone_number_id = p_phone_number_id');
    expect(sql).toContain('AND m.provider_message_id = p_provider_message_id');

    // NOTIFICATIONS IS ITS OWN AUTHORITY (0092), in 0061's, 0080's and
    // 0091's shape: a per-member column, default false, not backfilled.
    expect(sql).toContain(
      'ALTER TABLE organisation_memberships\n  ADD COLUMN can_manage_notifications boolean NOT NULL DEFAULT false;',
    );
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION app_private.create_organisation_with_owner(',
    );
    // FIVE trues, and only the last is this migration's. 0089 added
    // payroll and 0091 added signing; a CREATE OR REPLACE states the
    // whole body, so this migration must restate both or silently revoke
    // them from every founder. The assertion pins all of them so dropping
    // any fails here rather than in a founder's first payroll run.
    expect(sql).toContain('can_manage_payroll, can_manage_notifications, status');
    expect(sql).toContain(
      "VALUES (p_id, v_user_id, 'owner', 'all', true, true, true, true, true, 'active');",
    );

    // Every RAISE in the migration's OWN guards carries a named SQLSTATE
    // from the 23K block, which this migration is the first to use, so
    // `notify/send.ts` maps it to a code instead of surfacing a bare
    // 23514 as a 500. Scoped to the guards, because the file also
    // re-creates `create_organisation_with_owner` and that function
    // carries 0004's own 28000.
    const guards = sql.slice(
      sql.indexOf('CREATE FUNCTION app_private.guard_notification'),
    );
    const raises = guards.match(/RAISE EXCEPTION/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(9);
    expect(guards.match(/USING ERRCODE = '23K\d\d'/g)?.length).toBe(raises.length);
  });

  it('stages the spreadsheet importer in 0094', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0094_data_imports.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // THE NAME. Migration 0025 owns `import_batches` and `import_records`
    // for the v1 cutover CLI, which is a different feature entirely. The
    // prefix is what keeps a recovery package's two import sections from
    // reading as a duplicate of each other, so it is pinned rather than
    // left to whoever edits this next.
    expect(sql).toContain('CREATE TABLE spreadsheet_import_batches (');
    expect(sql).toContain('CREATE TABLE spreadsheet_import_rows (');
    expect(sql).not.toMatch(/CREATE TABLE import_(batches|records|rows)\b/);

    // NOTHING REACHES A LIVE REGISTER UNTIL A PERSON SAYS SO, and the
    // schema's half of that is negative: the staging rows carry no
    // foreign key into the registers they feed, so a staged row can hold
    // anything and commit is the only moment it becomes a claim.
    const rowsTable = sql.slice(
      sql.indexOf('CREATE TABLE spreadsheet_import_rows ('),
      sql.indexOf('COMMENT ON TABLE spreadsheet_import_rows'),
    );
    expect(rowsTable).not.toMatch(/REFERENCES (contacts|canonical_items)\b/);
    // The one reference it does carry is the composite tenant key 0087
    // and 0091 both use, so a row cannot be attached to another tenant's
    // batch even by a writer that arrives another way.
    expect(rowsTable).toContain(
      'FOREIGN KEY (organisation_id, batch_id)\n    REFERENCES spreadsheet_import_batches (organisation_id, id)',
    );

    // CELLS ARE INERT TEXT. A jsonb object, and the CHECK says so — a
    // cell coerced to a number or a date before the target's validator
    // has seen it is a second, weaker validator upstream of the real one.
    expect(rowsTable).toContain(
      "cells jsonb NOT NULL CHECK (jsonb_typeof(cells) = 'object')",
    );
    // A verdict and its evidence agree in BOTH directions: a row in error
    // says why, and a row that is not in error carries no complaint.
    expect(rowsTable).toContain(
      "(status = 'error') = (jsonb_array_length(errors) > 0)",
    );

    // CELLS MAY BE FORGOTTEN AND MAY NOT BE CHANGED. A contacts sheet
    // carries account numbers, and the direct write path treats those as
    // values never audited or logged; staging them past the decision
    // would undo that. Emptying is not editing — it destroys the
    // evidence rather than restating it — so it is the one write the
    // rule admits, and the assertion pins both halves.
    expect(sql).toContain(
      "IF NEW.cells IS DISTINCT FROM OLD.cells AND NEW.cells <> '{}'::jsonb THEN",
    );

    // A LATER SHEET RETIRES THE OPEN ONES. Without it a validated batch
    // stays committable for ever and the ordinary correction loop
    // becomes a trap: fix the workbook, upload again, and the batch with
    // the typo in it is still runnable.
    expect(sql).toContain(
      "status IN ('pending', 'validated', 'completed', 'cancelled', 'superseded')",
    );
    expect(sql).toContain("AND NEW.status IN ('validated', 'cancelled', 'superseded')");
    expect(sql).toContain("AND NEW.status IN ('completed', 'cancelled', 'superseded')");

    // The batch's census cannot claim more imported rows than it judged
    // valid, and the two terminal states each require their own timestamp
    // — so a 'completed' row with no completion is refused by the table
    // rather than by whoever reads it later.
    expect(sql).toContain('imported_row_count <= valid_row_count');
    expect(sql).toContain("(status = 'completed') = (completed_at IS NOT NULL)");
    expect(sql).toContain("(status = 'cancelled') = (cancelled_at IS NOT NULL)");

    // RLS, FORCE and the ADR-0010 InitPlan shape on both tables, and no
    // DELETE grant on either: a batch is the provenance of hundreds of
    // live records and cancels rather than disappearing.
    for (const table of ['spreadsheet_import_batches', 'spreadsheet_import_rows']) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(sql).toContain(
        `CREATE POLICY ${table}_tenant_policy ON ${table}
  USING (organisation_id = (SELECT app_private.current_organisation_id()))`,
      );
      expect(sql).toContain(`GRANT SELECT, INSERT, UPDATE ON ${table} TO auto_mb_app;`);
    }
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*spreadsheet_import/);

    // THE IMPORT AUTHORITY, in 0061's, 0080's, 0089's and 0091's shape: a
    // per-member column, default false, not backfilled.
    expect(sql).toContain(
      'ALTER TABLE organisation_memberships\n  ADD COLUMN can_import_data boolean NOT NULL DEFAULT false;',
    );

    // SIX TRUES, and only the last is this migration's own.
    //
    // `CREATE OR REPLACE` states the whole body, so 0004's two, 0089's
    // payroll grant, 0091's signing grant and 0092's notifications grant
    // must all be restated here or they are silently revoked from every
    // founder — with no error anywhere, because nothing refuses a column
    // left false.
    //
    // 0092's is the one that proves the point. It and this migration were
    // written in parallel; 0092 merged first, and because this file
    // applies second ITS body is the one that survives, so the first
    // composition of the two dropped the notifications grant from every
    // new organisation. Nothing failed — it was found by reading the
    // live function out of `pg_proc` at the merge. Hence this assertion,
    // pinned character for character, so the seventh authority fails
    // here instead.
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION app_private.create_organisation_with_owner(',
    );
    expect(sql).toContain(
      'can_manage_payroll, can_manage_notifications, can_import_data, status',
    );
    expect(sql).toContain(
      "p_id, v_user_id, 'owner', 'all', true, true, true, true, true, true, 'active'",
    );

    // Both guards are invoker-rights with a pinned search_path, and this
    // migration adds NO definer function of its own — every table its
    // guards touch is one the caller may already read under RLS, so a
    // definer here would read across tenants for no gain.
    const functions = sql.match(/CREATE FUNCTION app_private\.\w+/g) ?? [];
    expect(functions).toEqual([
      'CREATE FUNCTION app_private.guard_spreadsheet_import_batch',
      'CREATE FUNCTION app_private.guard_spreadsheet_import_row',
    ]);
    expect(sql.match(/^SET search_path = pg_catalog, public/gm)).toHaveLength(
      functions.length,
    );
    const guardBodies = sql.slice(
      sql.indexOf('CREATE FUNCTION app_private.guard_spreadsheet_import_batch'),
    );
    expect(guardBodies).not.toContain('SECURITY DEFINER');

    // Every refusal carries a SQLSTATE from this migration's own 23L
    // block, so a guard that fires because the route lost a race reaches
    // the caller as a named 409 rather than an unexplained 500. Scoped to
    // the guards, because the file also re-creates
    // `create_organisation_with_owner` and that function carries 0004's
    // own 28000.
    const importRaises = guardBodies.match(/RAISE EXCEPTION/g) ?? [];
    expect(importRaises.length).toBeGreaterThanOrEqual(5);
    expect(guardBodies.match(/USING ERRCODE = '23L\d\d'/g)?.length).toBe(
      importRaises.length,
    );
  });
});

describe('the audit register and its retention policy (0095)', () => {
  it('adds two columns, no table, and no trigger', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0095_audit_trail_and_retention.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");

    // NO NEW TABLE and NO NEW TRIGGER, which is why 0095 is absent from
    // MIGRATION_TRIGGERS above rather than present with a zero — the
    // census refuses a key naming a migration that creates none. The
    // register reads `audit_events` as 0001 left it, through the index
    // 0001 built for the per-Work timeline.
    expect(sql).not.toContain('CREATE TABLE');
    expect(sql).not.toContain('CREATE TRIGGER');
    expect(MIGRATION_TRIGGERS['0095_audit_trail_and_retention.sql']).toBeUndefined();

    // The authority, in the 0080/0089/0091 shape: per-member, default
    // false, not backfilled.
    expect(sql).toContain(
      'ALTER TABLE organisation_memberships\n  ADD COLUMN can_view_audit_trail boolean NOT NULL DEFAULT false;',
    );

    // The retention floor is the statutory one rather than a taste.
    // Section 128 of the Companies Act 2013 sets eight financial years for
    // the books of account, and Rule 3(1) of the Companies (Accounts)
    // Rules carries the audit trail with them, so 96 is a minimum an
    // organisation cannot configure its way below.
    expect(sql).toContain('audit_retention_months integer NOT NULL DEFAULT 96');
    expect(sql).toContain('CHECK (audit_retention_months BETWEEN 96 AND 600)');

    // AND NOTHING DELETES, which is the whole argument of the migration's
    // second half: a purge would need the application role to hold DELETE
    // on a table 0002 deliberately revoked it from — the code being
    // audited handed the ability to edit its own trail.
    expect(sql).not.toMatch(/DELETE FROM audit_events/i);
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*audit_events/i);
  });

  it('restates every grant the definer function already carried', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0095_audit_trail_and_retention.sql'),
      'utf8',
    );
    // The SIXTH restatement of `create_organisation_with_owner` and the
    // third in this wave alone, which is why it is pinned: CREATE OR
    // REPLACE states the whole body rather than amending it, so a grant
    // left out here is a founder who silently cannot use a feature in the
    // organisation they just created. 0094's header records that the
    // hazard already fired once, between itself and 0092.
    //
    // ALL SEVEN, and only one of them is this pack's — the other six are
    // 0004's issue and cancel, 0089's payroll, 0091's signing, 0092's
    // notifications and 0094's import.
    expect(sql).toContain(
      'can_issue_documents, can_cancel_documents, can_sign_documents,\n    can_manage_payroll, can_manage_notifications, can_import_data,\n    can_view_audit_trail, status',
    );
    expect(sql).toContain(
      "p_id, v_user_id, 'owner', 'all', true, true, true, true, true, true, true,",
    );

    // Written out rather than swept from the catalog. Granting whatever
    // `can_%` columns happen to exist would make a NEW authority
    // granted-by-default merely by existing — the opposite of the rule
    // `apps/server/src/authz.ts` states about silent defaults — and it
    // would hand the founder `can_manage_payments`, which 0080 withholds
    // on purpose because sending money out of the bank is the one act it
    // refuses to make automatic.
    expect(sql).not.toMatch(/attname LIKE '?can/);
    expect(sql).not.toContain('can_manage_payments,');
    expect(sql).not.toContain('can_approve_amendments,');
    // A definer function that silently changed hands would be a privilege
    // change nobody reviewed, so ownership and the grant are restated
    // explicitly rather than relied on.
    expect(sql).toContain(
      'ALTER FUNCTION app_private.create_organisation_with_owner(text, text, uuid)\n  OWNER TO auto_mb_definer;',
    );
    expect(sql).toContain('SET search_path = public, app_private, pg_temp');
  });

  it('binds the platform controls in 0096', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0096_platform_controls.sql'),
      'utf8',
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    // All three tables in the ADR-0010 InitPlan policy shape, and none of
    // them grants DELETE. An entitlement row deleted would silently
    // restore the shipped default and erase who decided otherwise; a
    // schedule is switched off rather than forgotten; and an export is a
    // disclosure of the whole organisation, which is not a record that may
    // be removed.
    for (const table of [
      'organisation_entitlements',
      'statutory_job_schedules',
      'organisation_export_requests',
    ]) {
      expect(sql, table).toContain(
        'USING (organisation_id = (SELECT app_private.current_organisation_id()))',
      );
      expect(sql, table).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(sql, table).toContain(
        `GRANT SELECT, INSERT, UPDATE ON ${table} TO auto_mb_app;`,
      );
      expect(sql, table).not.toContain(`DELETE ON ${table} TO auto_mb_app`);
    }

    // THE ARTEFACT'S KEY IS TENANT-PREFIXED IN SQL AS WELL AS IN CODE.
    // `assertSafeObjectKey` validates the shape in
    // packages/documents/src/storage.ts; this refuses a key that names
    // another organisation's directory even when the shape is perfect. Two
    // layers, because a path is a filesystem escape.
    expect(sql).toContain(
      "object_key IS NULL OR object_key LIKE organisation_id::text || '/%'",
    );
    // The digest takes 0065's domain rather than a hand-rolled CHECK.
    expect(sql).toContain('sha256 sha256_hex');

    // A READY ARTEFACT IS ONE FACT WITH SEVERAL PARTS. Without this a row
    // could claim `ready` with no key to fetch, which is the shape that
    // turns a failed build into a download button that 500s.
    expect(sql).toContain('organisation_export_requests_ready_shape');

    // ONE BUILD AT A TIME HAS A DATABASE ARM. It was the one rule in this
    // file enforced only by a route read, which two requests can both
    // pass before either inserts.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX organisation_export_requests_one_build_idx',
    );
    expect(sql).toContain("WHERE state IN ('queued', 'running');");
    // …and the index is only safe because something reconciles a build
    // that nothing will finish. Without the sweep, one dead build
    // disables self-service export for that organisation for ever.
    expect(sql).toContain(
      'CREATE FUNCTION app_private.fail_stalled_organisation_exports(',
    );
    expect(sql).toContain(
      "'the build did not finish; the server process handling it stopped'",
    );

    // A SCHEDULE WHOSE MEMBER HAS LEFT PAUSES ITSELF rather than
    // re-refusing every cadence for ever, and says which kind of "off"
    // it is in so the screen can offer a remedy for one and not the
    // other.
    expect(sql).toContain('disabled_reason text CHECK (');
    expect(sql).toContain(
      "'the member this check ran as is no longer in the organisation'",
    );

    // THE SCHEDULE CARRIES A REAL MEMBERSHIP, not a service identity.
    // ADR-0011 gives the queue no service user, so the recurring facility
    // borrows the membership of whoever enabled the schedule and
    // `bind_tenant` re-proves it at execution.
    expect(sql).toContain('authority_user_id text NOT NULL');
    expect(sql).toContain('v_due.authority_user_id');

    // THE SCHEDULER ENQUEUES AND ADVANCES IN ONE TRANSACTION, under SKIP
    // LOCKED. Two workers ticking together must not produce two identical
    // monthly reports, and a worker that dies mid-tick must have done
    // both or neither.
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('SET last_run_at = now(),');

    // THE QUEUE LEARNS THE SCHEDULED KIND, and the CHECK stays the
    // authority (0072 section 1) rather than the TypeScript union.
    expect(sql).toContain("'instrument_expiry_review'");
    expect(sql).toContain(
      'ALTER TABLE worker_jobs DROP CONSTRAINT worker_jobs_kind_check;',
    );

    // THREE SECURITY DEFINERS, each argued, and every function in the file
    // pins its search_path.
    const functions = sql.match(/CREATE FUNCTION app_private\.\w+/g) ?? [];
    expect(functions).toHaveLength(6);
    expect(sql.match(/^SET search_path = pg_catalog, public/gm)).toHaveLength(
      functions.length,
    );
    const definers = functions.filter((declaration) => {
      const source = sql.slice(sql.indexOf(declaration));
      return source.slice(0, source.indexOf('$$;')).includes('SECURITY DEFINER');
    });
    expect(definers).toEqual([
      'CREATE FUNCTION app_private.enqueue_due_statutory_jobs',
      'CREATE FUNCTION app_private.expire_lapsed_organisation_exports',
      'CREATE FUNCTION app_private.fail_stalled_organisation_exports',
      'CREATE FUNCTION app_private.organisation_job_history',
    ]);
    for (const signature of [
      'app_private.organisation_job_history(integer)',
      'app_private.enqueue_due_statutory_jobs(integer)',
      'app_private.expire_lapsed_organisation_exports(integer)',
      'app_private.fail_stalled_organisation_exports(interval, integer)',
    ]) {
      expect(sql, signature).toContain(`REVOKE ALL ON FUNCTION ${signature}`);
      expect(sql, signature).toContain(`ALTER FUNCTION ${signature}`);
    }

    // THE HISTORY READ IS BOUND, NOT PARAMETERISED. It takes no
    // organisation and refuses an unbound caller outright, which is what
    // keeps 0072's zero-grant posture on `worker_jobs` from being widened
    // into an enumeration oracle. It never returns the claim token.
    expect(sql).toContain(
      'v_organisation_id := app_private.current_organisation_id();',
    );
    expect(sql).toContain(
      "'job history can only be read inside a bound tenant transaction'",
    );
    const history = sql.slice(
      sql.indexOf('CREATE FUNCTION app_private.organisation_job_history'),
    );
    expect(history.slice(0, history.indexOf('$$;'))).not.toContain('claim_token');

    // BOTH AUTHORITIES REACH THE FOUNDER, and the replacement restates
    // every grant that was already there. 0089 and 0091 each replaced this
    // function before this one did, so a replacement that forgot either
    // would silently revoke payroll or signing from every founder — the
    // 0089/0091 collision is the burned precedent this assertion exists
    // against.
    expect(sql).toContain(
      'ALTER TABLE organisation_memberships\n  ADD COLUMN can_manage_entitlements boolean NOT NULL DEFAULT false;',
    );
    expect(sql).toContain(
      'ALTER TABLE organisation_memberships\n  ADD COLUMN can_export_org boolean NOT NULL DEFAULT false;',
    );
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION app_private.create_organisation_with_owner(',
    );
    expect(sql).toContain(
      "'can_manage_payroll, can_manage_entitlements, can_export_org%s, status'",
    );
    expect(sql).toContain(
      "') VALUES ($1, $2, ''owner'', ''all'', true, true, true, true, true, true%s, ''active'')'",
    );
    // AND ALL THREE SIBLING AUTHORITIES OF THE WAVE. 0096 is the last
    // writer of the train (v25 -> v26 -> v27 -> v28), so a replacement
    // that named only its own two would silently revoke notifications,
    // import and audit-trail from every founder created afterwards. Each
    // is set only where its column exists, so this file also runs on a
    // branch that has none of them.
    for (const column of [
      'can_manage_notifications',
      'can_import_data',
      'can_view_audit_trail',
    ]) {
      expect(sql, column).toContain(`'${column}'`);
    }
    expect(sql).toContain('FOREACH v_column IN ARRAY ARRAY[');

    // Every RAISE in the migration's OWN guards carries a named SQLSTATE
    // from the 23N block, so `routes/platform.ts` maps it to a code
    // instead of surfacing a bare 23514 as a 500. Scoped to the guards:
    // the file also re-creates `create_organisation_with_owner` verbatim
    // from 0004 (plus two columns) and that function carries 0004's own
    // 28000, and the two sweeps refuse a bad limit argument with
    // `check_violation` — a programming error no remedy text helps with,
    // which is the same distinction 0072's `claim_next_job` draws.
    const guards = sql.slice(
      sql.indexOf('CREATE FUNCTION app_private.guard_organisation_export_request'),
      sql.indexOf('-- 5. The two cross-tenant sweeps'),
    );
    const raises = guards.match(/RAISE EXCEPTION/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(5);
    expect(guards.match(/USING ERRCODE = '23N\d\d'/g)?.length).toBe(raises.length);
  });

  it('binds the defect liability period in 0099', async () => {
    const sql = await readFile(
      path.join(migrationsDirectory, '0099_warranty_dlp.sql'),
      'utf8',
    );
    expect(sql).toContain("SET lock_timeout = '2s';");
    expect(sql).toContain("SET statement_timeout = '5min';");

    // ONE definition of when a period ends, and the off-by-one that a
    // "last covered day" attracts has one place to be wrong in. Both the
    // insert derivation and the extension ceiling call it, so they cannot
    // drift apart.
    expect(sql).toContain('CREATE FUNCTION app_private.warranty_expiry(');
    expect(sql).toContain(
      'SELECT (start_on + make_interval(months => months))::date - 1',
    );
    expect(sql).toContain('NEW.dlp_expires_on := app_private.warranty_expiry(');
    expect(sql).toContain('app_private.warranty_expiry(NEW.dlp_start_on, 120)');

    // The end date is DERIVED, never taken from the writer: the guard
    // overwrites both columns on insert, the 0077 posture.
    expect(sql).toContain('NEW.original_expires_on := NEW.dlp_expires_on;');

    // Statuses are a CHECK on text, for the reason 0079 gives about its
    // categories; nothing here is an enum type.
    expect(sql).toMatch(
      /status text NOT NULL DEFAULT 'active'\n {4}CHECK \(status IN \('active', 'closed', 'voided'\)\)/,
    );
    expect(sql).not.toContain('CREATE TYPE');

    // Neither "expiring" nor "elapsed" is stored anywhere: both are facts
    // about today and are computed on read (routes/warranty.ts).
    expect(sql).not.toContain("'expiring'");
    expect(sql).not.toContain("'elapsed'");

    // Legal dates are date-only (engineering rule 6). No timestamptz
    // stands in for one: the three timestamps are the two act instants
    // and the touch column.
    for (const column of [
      'dlp_start_on date NOT NULL',
      'original_expires_on date NOT NULL',
      'dlp_expires_on date NOT NULL',
      'closed_on date',
    ]) {
      expect(sql, column).toContain(column);
    }

    // A voided period releases the slot, which is what makes "void and
    // start again" the correction path; a discharged one does not.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX installation_warranties_one_live_per_installation\s+ON installation_warranties \(organisation_id, installation_id\)\s+WHERE status <> 'voided';/,
    );

    // Every child key is composite through the Work, so no row can name
    // an installation or a certificate of another Work — or another
    // tenant.
    for (const composite of [
      'FOREIGN KEY (organisation_id, installation_id, work_id)\n    REFERENCES installations(organisation_id, id, work_id)',
      'FOREIGN KEY (organisation_id, pac_certificate_id, work_id)\n    REFERENCES pac_certificates(organisation_id, id, work_id)',
    ]) {
      expect(sql).toContain(composite);
    }

    // Referential integrity cannot use a partial index, so the two keys
    // the partial indexes above would otherwise appear to cover get plain
    // ones of their own.
    expect(sql).toContain('CREATE INDEX installation_warranties_installation_idx');
    expect(sql).toContain('CREATE INDEX installation_warranties_pac_idx');

    // Every guard function pins its search_path.
    const functions = sql.match(/CREATE FUNCTION app_private\.\w+/g) ?? [];
    expect(functions.length).toBeGreaterThanOrEqual(5);
    expect(sql.match(/SET search_path = pg_catalog, public/g)?.length).toBe(
      functions.length,
    );

    // Every RAISE carries a named SQLSTATE from the 23Q block, which this
    // migration is the first to use, so `routes/warranty.ts` maps each to
    // a refusal instead of surfacing a bare 23514 as a 500.
    const raises = sql.match(/RAISE EXCEPTION/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(12);
    expect(sql.match(/USING ERRCODE = '23Q\d\d'/g)?.length).toBe(raises.length);

    // The installations arm is WHEN-gated on the one transition it has
    // anything to say about; ungated it would run its EXISTS on every
    // installation write.
    expect(sql).toMatch(
      /CREATE TRIGGER installations_guard_warranty_cancel\nBEFORE UPDATE ON installations\nFOR EACH ROW\nWHEN \(OLD\.status = 'recorded' AND NEW\.status = 'cancelled'\)/,
    );

    // Guards sort alphabetically before the touch trigger, so a refused
    // write raises before updated_at moves (the 0003 ordering note).
    expect(
      sql.indexOf('CREATE TRIGGER installation_warranties_guard_transition'),
    ).toBeLessThan(
      sql.indexOf('CREATE TRIGGER installation_warranties_touch_updated_at'),
    );
    expect(sql.indexOf('CREATE TRIGGER work_warranty_terms_guard_update')).toBeLessThan(
      sql.indexOf('CREATE TRIGGER work_warranty_terms_touch_updated_at'),
    );

    // Both policies arrive in the ADR-0010 InitPlan shape, and both
    // tables force RLS on their owner too.
    for (const table of ['work_warranty_terms', 'installation_warranties']) {
      expect(sql).toContain(
        `CREATE POLICY ${table}_tenant_policy ON ${table}\n  USING (organisation_id = (SELECT app_private.current_organisation_id()))`,
      );
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    }

    // A period is the record that a warranty ran: it is voided with a
    // note, never removed, so neither table hands out a DELETE.
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON work_warranty_terms TO auto_mb_app;',
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON installation_warranties TO auto_mb_app;',
    );
    // Matched against the GRANT clause specifically: the file also
    // carries `BEFORE DELETE ON installation_warranties`, which is the
    // guard that says the same thing to a writer holding the privilege
    // some other way.
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*ON work_warranty_terms/);
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*ON installation_warranties/);

    // No counter and no numbering: the module issues no document, so
    // nothing here can gain a series by accident.
    expect(sql).not.toContain('_counters');
  });
});

describe('the statutory seed function (0103)', () => {
  let sql = '';

  beforeAll(async () => {
    sql = await readFile(
      path.join(migrationsDirectory, '0103_statutory_seed_function.sql'),
      'utf8',
    );
  });

  it('creates no table and no trigger', () => {
    // Absent from MIGRATION_TRIGGERS rather than present with a zero, the
    // treatment 0095 gets and for the same reason: the census refuses a
    // key naming a migration that creates none. This migration adds one
    // function and touches nothing else.
    expect(sql).not.toContain('CREATE TABLE');
    expect(sql).not.toContain('CREATE TRIGGER');
    expect(MIGRATION_TRIGGERS['0103_statutory_seed_function.sql']).toBeUndefined();
  });

  it('is invoker-rights with a pinned search_path', () => {
    // THE SECURITY DECISION OF THIS MIGRATION, asserted rather than
    // trusted to the header comment that argues it. The function takes an
    // organisation id, so SECURITY DEFINER owned by the BYPASSRLS role
    // would hand `auto_mb_app` a primitive that writes statutory money
    // rows into ANY organisation, named by argument, outside RLS. Invoker
    // rights mean the four forced-RLS tables admit the writes only for the
    // bound organisation — the function adds no authority at all.
    //
    // A later edit that "fixes" a permission error by adding SECURITY
    // DEFINER fails here, which is the point.
    //
    // Read with the `--` comments stripped, because the migration's header
    // argues the decision in prose and names the thing it refuses; the
    // assertion is about the statements, not about what they are allowed
    // to discuss.
    const statements = sql.replaceAll(/^\s*--.*$/gm, '');
    expect(statements).not.toContain('SECURITY DEFINER');
    expect(statements).toContain('SECURITY INVOKER');
    expect(statements).not.toContain('OWNER TO auto_mb_definer');
    // Pinned regardless of definer rights: a function resolving its own
    // identifiers through the caller's path is a rule a shadowing object
    // in a writable schema can rewrite (0067, 0079, 0087, 0091, 0096).
    expect(sql).toContain('SET search_path = pg_catalog, public');
    // Named grant, not PUBLIC.
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION app_private.seed_default_statutory_rows(uuid)',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION app_private.seed_default_statutory_rows(uuid)',
    );
  });

  it('inserts idempotently into all four statutory registers', () => {
    // The contract organisation creation depends on: a re-run converges
    // and an owner's later corrections are never overwritten. One
    // ON CONFLICT per INSERT, and five INSERTs — the two income-tax
    // regimes are seeded separately because the new regime's single
    // ladder is cross-joined onto three age categories and the old
    // regime's three genuinely differ.
    for (const table of [
      'gst_rates',
      'payroll_statutory_rates',
      'professional_tax_slabs',
      'income_tax_slabs',
    ]) {
      expect(sql, table).toContain(`INSERT INTO ${table} (`);
    }
    expect(sql.match(/INSERT INTO /g)).toHaveLength(5);
    expect(sql.match(/ON CONFLICT \(/g)).toHaveLength(5);
    expect(sql.match(/DO NOTHING;/g)).toHaveLength(5);
    // Both counts are returned, because organisation creation writes one
    // audit event per register and must be able to record a real change
    // and stay silent on a no-op.
    expect(sql).toContain(
      'RETURNS TABLE (gst_rate_rows integer, payroll_rows integer)',
    );
    expect(sql.match(/GET DIAGNOSTICS /g)).toHaveLength(5);
  });

  it('seeds only the organisation it is given', () => {
    // The seeds are per organisation, never global — 0048 § 2 and 0089 § 7
    // both cross-joined `organisations` because they were back-filling
    // every tenant that already existed, and a function that kept doing
    // that would re-seed the whole cluster on every organisation created.
    expect(sql).not.toMatch(/FROM organisations\b/);
    expect(sql.match(/p_organisation_id/g)?.length).toBeGreaterThanOrEqual(6);
  });
});

describe('the owner rulings of 2026-08-19 (0104)', () => {
  let sql = '';

  beforeAll(async () => {
    sql = await readFile(
      path.join(migrationsDirectory, '0104_owner_rulings_2026_08_19.sql'),
      'utf8',
    );
  });

  it('bounds its own locks like every migration that rewrites a column', () => {
    // It drops and re-adds two STORED GENERATED money columns on a table
    // that already holds rows, which takes an ACCESS EXCLUSIVE lock and
    // rewrites the table. Unbounded, that is a production outage rather
    // than a migration.
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
  });

  it('caps liquidated damages at a percentage of the contract value', () => {
    // THE RULING, asserted rather than left to the comment that argues
    // it. `cap_amount` must be generated from the snapshotted contract
    // value and from nothing else; a later edit that reinstated
    // `basis_amount` as the cap basis fails here.
    expect(sql).toContain(
      'ADD COLUMN cap_amount money_amount GENERATED ALWAYS AS (\n' +
        '    round(contract_value_amount * ld_cap_percent / 100, 2)\n' +
        '  ) STORED',
    );
    // And the assessment is still the lesser of the two arms, with the
    // rate arm charging on the basis the assessment states.
    expect(sql).toContain('least(');
    expect(sql).toContain('round(contract_value_amount * ld_cap_percent / 100, 2)');
  });

  it('back-fills the snapshot from the basis, never from the Work', () => {
    // Engineering rule 7 in one statement. Filling it from
    // `works.contract_value` would move `cap_amount` — and through it
    // `assessed_amount` — on assessments an agency has already put in
    // front of a railway, silently, in a money column, including on rows
    // in a terminal state.
    expect(sql).toContain(
      'UPDATE ld_assessments SET contract_value_amount = basis_amount;',
    );
    expect(sql).not.toMatch(/SET contract_value_amount = w\.contract_value/);
  });

  it('steers the contract terms to the ruled five per cent without refusing another figure', () => {
    expect(sql).toContain('ALTER COLUMN ld_cap_percent SET DEFAULT 5;');
    // A DEFAULT and not a CHECK: tenders vary, and a ceiling the product
    // refused to record would send the operator back to a spreadsheet on
    // the one occasion the difference mattered.
    expect(sql).not.toMatch(/ld_cap_percent\s*<=\s*5/);
  });

  it('takes its SQLSTATE from the retention pack, at the next free code', () => {
    expect(sql).toContain("ERRCODE = '23P10'");
    expect(sql).toContain("CONSTRAINT = 'ld_cap_basis_missing'");
    // The freeze reuses 0098's own code and constraint name, because for
    // an operator it is the same rule: the facts an assessment was
    // computed from are written once.
    expect(sql).toContain("ERRCODE = '23P05'");
    expect(sql).toContain("CONSTRAINT = 'ld_assessment_frozen'");
  });

  it('adds one trigger and declares it in the census', () => {
    expect(sql.match(/^CREATE TRIGGER /gm)).toHaveLength(1);
    expect(sql).toContain('CREATE TRIGGER ld_assessments_contract_value_snapshot');
    expect(MIGRATION_TRIGGERS['0104_owner_rulings_2026_08_19.sql']).toBe(1);
    // Alphabetically before `ld_assessments_write_guard`, which is what
    // puts the snapshot on NEW before 0098's guard reads the row.
    expect(
      'ld_assessments_contract_value_snapshot' < 'ld_assessments_write_guard',
    ).toBe(true);
  });

  it('creates the inbound opt-out writer as a narrow definer function', () => {
    // The second write that crosses tenancy for the notifications lane,
    // on exactly the terms 0092's receipt writer sits on: definer rights
    // because Meta is not a member of anything, owned by the BYPASSRLS
    // role, granted by name rather than to PUBLIC, and with its search
    // path pinned.
    expect(sql).toContain('CREATE FUNCTION app_private.record_notification_opt_out(');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain(
      'ALTER FUNCTION app_private.record_notification_opt_out(text, text)\n  OWNER TO auto_mb_definer;',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION app_private.record_notification_opt_out(text, text)',
    );
    expect(sql).toContain('SET search_path = pg_catalog, public, app_private, pg_temp');
  });

  it('lets the opt-out writer move a consent and never create one', () => {
    // An address nobody opted in is unknown rather than opted out, and
    // recording an opt-out against a contact that does not exist would be
    // inventing a party. The grant is the enforcement: no INSERT and no
    // DELETE on the consent table for the definer role.
    expect(sql).toContain(
      'GRANT SELECT, UPDATE ON notification_consents TO auto_mb_definer;',
    );
    expect(sql).not.toMatch(/INSERT INTO notification_consents/);
    expect(sql).toContain("'notification_consent.revoked'");
    expect(sql).toContain("'reason', 'inbound stop'");
  });

  it('creates exactly one SECURITY DEFINER function', () => {
    // The LD snapshot trigger is invoker-rights: it reads `works` inside
    // the transaction that already locked the Work, so definer rights
    // would add authority for nothing.
    const definers = sql
      .split('CREATE FUNCTION ')
      .slice(1)
      .filter((source) =>
        source.slice(0, source.indexOf('$$;')).includes('SECURITY DEFINER'),
      );
    expect(definers).toHaveLength(1);
    expect(sql.match(/CREATE FUNCTION app_private\.\w+/g)).toHaveLength(2);
  });
});
