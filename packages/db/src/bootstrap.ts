import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createDatabasePool } from './pool.js';
import { runMigrations } from './migration-runner.js';
import { ensureApplicationRole, ensureDefinerRole } from './roles.js';

export { ensureApplicationRole, ensureDefinerRole } from './roles.js';

/**
 * Idempotent production bootstrap (external review, ops batch): creates
 * or updates the application role, runs migrations, then deterministically
 * reapplies the full privilege matrix — so a database whose migrations ran
 * before the role existed (where the migrations' role-guarded grant blocks
 * were skipped) converges to the same state as a fresh one. Finally proves
 * a query through the application role.
 *
 * The matrix below is the CANONICAL final state, mirroring migrations
 * all migrations after all revokes. Adding a table? Update the matrix AND the
 * tenancy suite's table lists — the catalog-driven drift test in
 * `test/bootstrap.integration.test.ts` (audit finding 10) fails the build
 * if a table exists in the database and not here.
 */

/** table → privileges the application role holds. Exported so the
 * catalog-driven drift test (audit finding 10) can diff it against
 * `information_schema` rather than against a second hand-kept list. */
export const TABLE_PRIVILEGES: Record<string, string> = {
  // The migration ledger is administrator state: `runMigrations` writes it
  // under the owner role and the application must never be able to forge
  // migration history. It is READABLE, though, and deliberately so — the
  // `/api/ready` schema-version gate (apps/server/src/routes/health.ts)
  // compares the applied ledger with the migration directory the image
  // carries, and 503s when the image is ahead of the database. Without this
  // grant a container started against an unmigrated database reports itself
  // ready. SELECT only; no INSERT/UPDATE/DELETE, proved in
  // test/bootstrap.integration.test.ts.
  schema_migrations: 'SELECT',
  // Business tables that must never lose rows keep no DELETE (0003).
  organisations: 'SELECT, INSERT, UPDATE',
  works: 'SELECT, INSERT, UPDATE',
  work_items: 'SELECT, INSERT, UPDATE',
  // The live-items VIEW over work_items (0065): security_invoker, so the
  // base table's RLS is re-checked for the caller and this grant adds no
  // visibility. Read-only — writes go to work_items.
  work_items_live: 'SELECT',
  loa_documents: 'SELECT, INSERT, UPDATE',
  delivery_challan_counters: 'SELECT, INSERT, UPDATE',
  // The standalone Delivery Challan's per-financial-year sequence (0056):
  // numbering state, so no DELETE, like every other counter. Found missing
  // by the catalog-driven drift test below — the migration's own grant sits
  // in a role-guarded block, so a database migrated before the application
  // role existed would have had no grant at all and nothing to repair it.
  standalone_challan_counters: 'SELECT, INSERT, UPDATE',
  // Drafts and structural rows remain deletable.
  organisation_memberships: 'SELECT, INSERT, UPDATE, DELETE',
  work_schedules: 'SELECT, INSERT, UPDATE, DELETE',
  delivery_challans: 'SELECT, INSERT, UPDATE, DELETE',
  delivery_challan_items: 'SELECT, INSERT, UPDATE, DELETE',
  challan_item_serials: 'SELECT, INSERT, UPDATE, DELETE',
  issue_challans: 'SELECT, INSERT, UPDATE, DELETE',
  issue_challan_lines: 'SELECT, INSERT, UPDATE, DELETE',
  work_assignments: 'SELECT, INSERT, DELETE',
  // Retention financial records: no DELETE (0006).
  challan_receipts: 'SELECT, INSERT, UPDATE',
  work_instruments: 'SELECT, INSERT, UPDATE',
  bills: 'SELECT, INSERT, UPDATE',
  bill_counters: 'SELECT, INSERT, UPDATE',
  // The payment register (0067). A recorded receipt of money is never
  // edited and never deleted: UPDATE exists only so it can be VOIDED,
  // which the 0067 guard is the only permitted use of. A deduction has no
  // UPDATE at all — a wrong breakup is corrected by voiding the whole
  // advice and recording it again, so there is nothing to edit in place.
  bill_payments: 'SELECT, INSERT, UPDATE',
  bill_payment_deductions: 'SELECT, INSERT',
  // The outstanding-with-railway VIEW over the four tables that decide
  // it (0067): security_invoker, so their RLS is re-checked for the
  // caller and this grant adds no visibility. Read-only by construction.
  bill_settlement_positions: 'SELECT',
  mb_entries: 'SELECT, INSERT, UPDATE',
  // Master data retires via the active flag; no DELETE exists (0013).
  location_masters: 'SELECT, INSERT, UPDATE',
  unit_masters: 'SELECT, INSERT, UPDATE',
  organisation_signatories: 'SELECT, INSERT, UPDATE',
  // The canonical item catalogue (0078): a master like the three above,
  // so it retires by flag and holds no DELETE. Its link to work_items is
  // derived from the aliases rather than stored, so nothing here cascades.
  canonical_items: 'SELECT, INSERT, UPDATE',
  // The organisation's own bank accounts (0078). Same master posture; the
  // route never projects the stored account number.
  organisation_bank_accounts: 'SELECT, INSERT, UPDATE',
  // The unified Contacts master (0028): retire-not-delete like every
  // master. consignee_masters is a compatibility VIEW over contacts since
  // 0028 (security_invoker, so base grants and RLS are re-checked for the
  // caller); its own ACL stays narrow — read for pickers, insert for the
  // importer's master upsert.
  contacts: 'SELECT, INSERT, UPDATE',
  consignee_masters: 'SELECT, INSERT',
  // Work<->consignee association (0028): a preference list, not a
  // document — unlinking deletes nothing but the preference.
  work_consignees: 'SELECT, INSERT, DELETE',
  // Extension requests (0011): drafts deletable, counters keep no DELETE.
  extension_requests: 'SELECT, INSERT, UPDATE, DELETE',
  extension_request_counters: 'SELECT, INSERT, UPDATE',
  // Issue Challan numbering state: no DELETE, like the DC counter (0014).
  issue_challan_counters: 'SELECT, INSERT, UPDATE',
  // Amendment approvals are a decision ledger: no DELETE (0012).
  approval_requests: 'SELECT, INSERT, UPDATE',
  // A cited variation order is the evidence an omission was authorised:
  // written once at upload and never rewritten, so no UPDATE and no
  // DELETE either (0058).
  amendment_variation_orders: 'SELECT, INSERT',
  // The railway's own On-Account Bill, received rather than authored
  // (0066). Its bytes and every fact extracted from them are immutable;
  // UPDATE exists only so the row can be discarded when a bill was
  // attached to the wrong Measurement Book, and there is no DELETE
  // because a settlement document does not leave.
  received_railway_bills: 'SELECT, INSERT, UPDATE',
  // The company document library (0078). The credential takes UPDATE for
  // archiving and renaming and no DELETE, because a bid that cited it has
  // to stay explicable; its versions are stored evidence, so they are
  // append-only — no UPDATE, no DELETE, and a trigger that says the same.
  company_documents: 'SELECT, INSERT, UPDATE',
  company_document_versions: 'SELECT, INSERT',
  // The record that a confirmed Work was withdrawn and what replaced it
  // (0071). UPDATE binds the successor once; no DELETE, because this is
  // the only place the withdrawal is written down.
  work_supersessions: 'SELECT, INSERT, UPDATE',
  // Installation records cancel with a note, never delete; attachments
  // release, never delete (0017).
  installations: 'SELECT, INSERT, UPDATE',
  installation_serials: 'SELECT, INSERT, UPDATE',
  // Correction notices are numbered legal records that cancel, never
  // disappear; the counter is numbering state (0019).
  correction_notices: 'SELECT, INSERT, UPDATE',
  correction_notice_counters: 'SELECT, INSERT, UPDATE',
  // Payment matrix rows are per-Work payment configuration, not issued
  // documents: finalised MBs snapshot their percentages, so deleting a
  // row for an unused category is legitimate (0021).
  payment_matrices: 'SELECT, INSERT, UPDATE, DELETE',
  // PAC certificates cancel with a note, never delete; their certified
  // lines are frozen by trigger (0022).
  pac_certificates: 'SELECT, INSERT, UPDATE',
  pac_certificate_items: 'SELECT, INSERT, UPDATE',
  // Measurement Books: drafts (and their source claims) delete, guarded
  // by trigger; finalized snapshots and numbering state keep no DELETE
  // (0024).
  measurement_books: 'SELECT, INSERT, UPDATE, DELETE',
  mb_sources: 'SELECT, INSERT, UPDATE, DELETE',
  measurement_book_lines: 'SELECT, INSERT, UPDATE',
  measurement_book_counters: 'SELECT, INSERT, UPDATE',
  measurement_book_merge_provenance: 'SELECT, INSERT',
  // Procurement and statutory documents (0033, 0035, 0039, 0041).
  // Parent/line drafts delete through guarded routes; counters and provider
  // operations are durable state and keep no DELETE privilege.
  purchase_orders: 'SELECT, INSERT, UPDATE, DELETE',
  purchase_order_lines: 'SELECT, INSERT, UPDATE, DELETE',
  purchase_order_counters: 'SELECT, INSERT, UPDATE',
  budgetary_quotations: 'SELECT, INSERT, UPDATE, DELETE',
  budgetary_quotation_lines: 'SELECT, INSERT, UPDATE, DELETE',
  budgetary_quotation_counters: 'SELECT, INSERT, UPDATE',
  tax_invoices: 'SELECT, INSERT, UPDATE, DELETE',
  // An ITEMISED invoice's lines (0057): edited and discarded freely while
  // the parent invoice is a draft, and refused every write by the 0057
  // mutation guard once it is not — so DELETE here is a draft-editing
  // privilege, not a history-erasing one (the delivery_challan_items
  // posture, 0001).
  tax_invoice_lines: 'SELECT, INSERT, UPDATE, DELETE',
  tax_invoice_counters: 'SELECT, INSERT, UPDATE',
  // The Section 34 credit note (0051): drafts delete, issued notes
  // cancel; the counter is numbering state and never deletes.
  credit_notes: 'SELECT, INSERT, UPDATE, DELETE',
  credit_note_counters: 'SELECT, INSERT, UPDATE',
  // The GST rate master (0048): rates retire via end-dating, so like
  // every master there is no DELETE.
  gst_rates: 'SELECT, INSERT, UPDATE',
  tax_invoice_renders: 'SELECT, INSERT',
  eway_bills: 'SELECT, INSERT, UPDATE, DELETE',
  // The printable e-way bill summary (0076): append-only like its
  // tax-invoice sibling above. A render is evidence of what was printed,
  // so the application role may add one and never rewrite one.
  eway_bill_renders: 'SELECT, INSERT',
  document_number_series: 'SELECT, INSERT, UPDATE, DELETE',
  statutory_provider_operations: 'SELECT, INSERT, UPDATE',
  // Shared throttle state (0054): windows decay and clear by DELETE; the
  // lock row upserts (INSERT ... ON CONFLICT UPDATE) and clears by DELETE.
  rate_limit_attempts: 'SELECT, INSERT, DELETE',
  account_lockout_locks: 'SELECT, INSERT, UPDATE, DELETE',
  // Append-only trails (0002, 0005).
  audit_events: 'SELECT, INSERT',
  identity_audit_events: 'SELECT, INSERT',
  // Cutover provenance is a ledger: append-only for the application role;
  // the importer itself runs as the administrator role (0025).
  import_batches: 'SELECT, INSERT',
  import_records: 'SELECT, INSERT',
  // Better Auth owns these shapes (0004).
  auth_users: 'SELECT, INSERT, UPDATE, DELETE',
  auth_sessions: 'SELECT, INSERT, UPDATE, DELETE',
  auth_accounts: 'SELECT, INSERT, UPDATE, DELETE',
  auth_verifications: 'SELECT, INSERT, UPDATE, DELETE',
  auth_two_factors: 'SELECT, INSERT, UPDATE, DELETE',
};

/**
 * Tables that deliberately hold NO privilege for the application role, and
 * the reason each one holds none. Membership here is a decision, exactly
 * like membership in `TABLE_PRIVILEGES`; the drift test in
 * `test/bootstrap.integration.test.ts` requires every base table to be in
 * one set or the other, so a new table cannot end up ungranted by
 * forgetfulness and then be read as ungranted by design.
 *
 * `applyGrants` REVOKEs on these and grants nothing, which is what makes
 * the state converge on a database where somebody once added a grant by
 * hand.
 */
export const UNGRANTED_BY_DESIGN: Record<string, string> = {
  // The job queue (0072, ADR-0011). Inherently cross-tenant — the worker
  // must claim a job before it knows whose it is, so no tenant policy can
  // express the read — and therefore reachable only through the four
  // SECURITY DEFINER functions. A direct SELECT grant here would turn any
  // SQL-injection foothold into an enumeration oracle over every
  // organisation's job metadata, which is precisely the exposure ADR-0011
  // refused. The zero-grant state is asserted against the catalog in
  // packages/db/test/worker-queue.integration.test.ts (ADR guard (a)).
  worker_jobs: 'reachable only through app_private definer functions (ADR-0011)',
};

const FUNCTION_GRANTS = [
  'app_private.current_organisation_id()',
  'app_private.current_user_id()',
  'app_private.create_organisation_with_owner(text, text, uuid)',
  // The tenant binding (0069). Every tenant transaction opens with this
  // call, so a database whose migrations ran before the application role
  // existed — or one restored onto a fresh cluster with --no-owner — must
  // get the grant and the definer ownership back here, exactly like the
  // three above. Without the ownership repair the membership proof inside
  // it reads organisation_memberships through RLS and finds nothing, and
  // every bind fails 28000.
  'app_private.bind_tenant(uuid, text)',
  // The job queue (0072). Same restore hazard as the four above, and a
  // worse failure if it is missed: these functions are the ONLY access to
  // `worker_jobs`, so a fresh-cluster restore that left them owned by the
  // restoring role would stop the worker dead rather than degrading it.
  'app_private.enqueue_job(text, jsonb)',
  'app_private.claim_next_job(text, integer)',
  'app_private.complete_job(uuid, uuid, jsonb)',
  'app_private.fail_job(uuid, uuid, text, timestamptz, text)',
  'app_private.release_job(uuid, uuid, text)',
];

/** Functions that MUST be owned by the BYPASSRLS definer role: they are
 * SECURITY DEFINER and read organisation_memberships from inside the RLS
 * policies themselves. After a restore onto a fresh cluster
 * (pg_restore --no-owner) they come back owned by the restoring role and
 * organisation creation breaks; the bootstrap repairs ownership. */
const DEFINER_FUNCTIONS = FUNCTION_GRANTS;

export async function applyGrants(admin: Sql): Promise<void> {
  await admin.unsafe(`GRANT USAGE ON SCHEMA public, app_private TO auto_mb_app`);
  for (const fn of FUNCTION_GRANTS) {
    await admin.unsafe(`GRANT EXECUTE ON FUNCTION ${fn} TO auto_mb_app`);
  }
  for (const [table, privileges] of Object.entries(TABLE_PRIVILEGES)) {
    // Revoke-then-grant makes the final state deterministic even on a
    // database that once carried wider privileges.
    await admin.unsafe(`REVOKE ALL ON ${table} FROM auto_mb_app`);
    await admin.unsafe(`GRANT ${privileges} ON ${table} TO auto_mb_app`);
  }
  // The revoke half alone, for the tables whose canonical state is no
  // privilege at all. Without this the matrix could only ever widen
  // access: a grant added by hand to `worker_jobs` would survive every
  // bootstrap, because a table outside the loop above is never revoked.
  for (const table of Object.keys(UNGRANTED_BY_DESIGN)) {
    await admin.unsafe(`REVOKE ALL ON ${table} FROM auto_mb_app`);
  }
  // Definer posture (mirrors migration 0004): schema usage, the tables
  // the definer functions touch, and — critically after a fresh-cluster
  // restore — ownership of the SECURITY DEFINER functions themselves.
  await admin.unsafe(`GRANT USAGE ON SCHEMA public, app_private TO auto_mb_definer`);
  await admin.unsafe(
    `GRANT SELECT, INSERT ON organisations, organisation_memberships, audit_events
     TO auto_mb_definer`,
  );
  // Migration 0072: `reconcile_terminal_job` moves an LOA document out of
  // its in-flight state when the job reading it dies. Narrow on purpose —
  // no INSERT, no DELETE — and repaired here for the same reason the rest
  // of the matrix is: a fresh-cluster restore brings the function back
  // without the grant, and reconciliation would then fail silently at the
  // exact moment a job was already failing.
  await admin.unsafe(`GRANT SELECT, UPDATE ON loa_documents TO auto_mb_definer`);
  // 0072's enqueue_job runs as auto_mb_definer and reads the binding
  // through these two. They are definer-OWNED after the loop below, which
  // makes the grant redundant here — but only after it, and only while
  // that stays true, so it is stated rather than inferred.
  await admin.unsafe(
    `GRANT EXECUTE ON FUNCTION app_private.current_user_id(),
       app_private.current_organisation_id() TO auto_mb_definer`,
  );
  await admin.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON worker_jobs TO auto_mb_definer`,
  );
  for (const fn of DEFINER_FUNCTIONS) {
    await admin.unsafe(`ALTER FUNCTION ${fn} OWNER TO auto_mb_definer`);
    await admin.unsafe(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
    await admin.unsafe(`GRANT EXECUTE ON FUNCTION ${fn} TO auto_mb_app`);
  }
}

export async function verifyApplicationConnection(appUrl: string): Promise<void> {
  const app = createDatabasePool({
    url: appUrl,
    max: 1,
    applicationName: 'auto-mb-bootstrap-proof',
  });
  try {
    // Privilege proof: without a bound tenant, forced RLS yields zero
    // rows — but a missing grant or wrong password throws instead.
    await app`select count(*)::int as visible from organisations`;
  } finally {
    await app.end({ timeout: 5 });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');
  if (!appPassword) throw new Error('AUTO_MB_APP_DB_PASSWORD is required');
  // Restore sequencing (docs/RUNBOOK.md): a dump's ACLs reference the
  // cluster-level roles, which never travel with it, so on a FRESH
  // cluster the roles must exist BEFORE pg_restore runs. --roles-only
  // creates them and stops — migrations would otherwise create a schema
  // the restore is about to bring back.
  const rolesOnly = process.argv.includes('--roles-only');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDirectory = path.resolve(here, '..', 'migrations');
  const admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-bootstrap',
  });
  try {
    await ensureApplicationRole(admin, appPassword);
    await ensureDefinerRole(admin);
    console.log('application and definer roles ensured');
    if (!rolesOnly) {
      await runMigrations(admin, migrationsDirectory);
      await applyGrants(admin);
      console.log('privilege matrix applied');
      const appUrl = process.env.DATABASE_URL;
      if (appUrl) {
        await verifyApplicationConnection(appUrl);
        console.log('application connection verified');
      }
    }
  } finally {
    await admin.end();
  }
  console.log(rolesOnly ? 'roles bootstrap complete' : 'bootstrap complete');
}
