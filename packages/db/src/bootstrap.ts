import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createDatabasePool } from './pool.js';
import { runMigrations } from './migration-runner.js';
import { ensureApplicationRole, ensureDefinerRole } from './roles.js';

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
  // The outbound half of the cash position (0080). No DELETE anywhere:
  // a payment record is voided or cancelled, never removed. UPDATE is
  // granted on all four because each has a legitimate in-place
  // transition — a request's status, an invoice's cancellation, a
  // payment's void, a counter's increment — and each is narrowed by its
  // own trigger to exactly that transition.
  payment_requests: 'SELECT, INSERT, UPDATE',
  payment_request_counters: 'SELECT, INSERT, UPDATE',
  vendor_invoices: 'SELECT, INSERT, UPDATE',
  vendor_payments: 'SELECT, INSERT, UPDATE',
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
  // A contact's address list (0116). The parent's grant exactly: a
  // document may have copied one of these rows, so addresses retire by
  // flag and no DELETE exists.
  contact_addresses: 'SELECT, INSERT, UPDATE',
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
  // The railway's own measurement, the document the bill above is raised
  // from (0111). Same posture for the same reason: UPDATE exists only for
  // the discard, and no DELETE because the gate it opened has to stay
  // explicable. Its confirmations are append-only — a statement a named
  // person made about one line is not editable, and withdrawing it is
  // discarding the measurement and uploading another.
  railway_measurements: 'SELECT, INSERT, UPDATE',
  railway_measurement_confirmations: 'SELECT, INSERT',
  // The company document library (0079). The credential takes UPDATE for
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
  // The downward measured-quantity adjustments (0106): draft-only state,
  // deleted with the draft they belong to and replaced wholesale by the
  // route that sets them, so DELETE here is a draft-editing privilege.
  // The 0106 guard refuses every write once the book has left `draft`.
  mb_measured_overrides: 'SELECT, INSERT, UPDATE, DELETE',
  measurement_book_lines: 'SELECT, INSERT, UPDATE',
  measurement_book_counters: 'SELECT, INSERT, UPDATE',
  measurement_book_merge_provenance: 'SELECT, INSERT',
  // Procurement and statutory documents (0033, 0035, 0039, 0041).
  // Parent/line drafts delete through guarded routes; counters and provider
  // operations are durable state and keep no DELETE privilege.
  purchase_orders: 'SELECT, INSERT, UPDATE, DELETE',
  purchase_order_lines: 'SELECT, INSERT, UPDATE, DELETE',
  purchase_order_counters: 'SELECT, INSERT, UPDATE',
  organisation_purchase_order_counters: 'SELECT, INSERT, UPDATE',
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
  // The tender pipeline (0083). A tender is updated for its status trail
  // and its award link and never deleted; the notice is evidence whose
  // one mutable column is the confirmation link; the trail is
  // append-only. The checklist alone takes DELETE: a line is draft
  // working material while the bid is being assembled (AGENTS.md rule 8),
  // and the route refuses it from submission onwards.
  tenders: 'SELECT, INSERT, UPDATE',
  tender_notices: 'SELECT, INSERT, UPDATE',
  tender_checklist_items: 'SELECT, INSERT, UPDATE, DELETE',
  tender_status_events: 'SELECT, INSERT',
  // The correspondence register (0086). A letter that went out or came in
  // is a record: it takes UPDATE for the cancellation triple alone and
  // never DELETE, and the counter behind it must never be reset because a
  // cancelled letter still holds its number.
  correspondence_letters: 'SELECT, INSERT, UPDATE',
  correspondence_letter_counters: 'SELECT, INSERT, UPDATE',
  // OEM production (0084). The item master retires via its active flag
  // like every master since 0013, so no DELETE; a bill of material is
  // design working material and deletes. A job card carries a number and
  // cancels rather than disappearing. Serials and their genealogy are
  // never UPDATEd — a serial number is stamped on hardware, not
  // corrected — and delete only while the unit is still in the factory,
  // which the references from the despatch tables enforce. A despatch
  // states a past fact, so it never updates either.
  production_items: 'SELECT, INSERT, UPDATE',
  production_bom_lines: 'SELECT, INSERT, UPDATE, DELETE',
  production_job_cards: 'SELECT, INSERT, UPDATE',
  production_job_card_counters: 'SELECT, INSERT, UPDATE',
  production_serials: 'SELECT, INSERT, DELETE',
  production_serial_counters: 'SELECT, INSERT, UPDATE',
  production_component_serials: 'SELECT, INSERT, DELETE',
  production_dispatches: 'SELECT, INSERT, DELETE',
  production_dispatch_counters: 'SELECT, INSERT, UPDATE',
  production_dispatch_serials: 'SELECT, INSERT, DELETE',
  // The stock ledger (0087). The movement table is append-only in the
  // strongest sense the schema can state: no UPDATE, because a balance
  // that can be edited is not a ledger, and no DELETE either, because a
  // movement posted in error is reversed by an adjustment carrying the
  // reason. The counter records how far the ledger has gone and only
  // ever climbs.
  stock_movements: 'SELECT, INSERT',
  stock_movement_counters: 'SELECT, INSERT, UPDATE',
  // The signing queue (0091). No DELETE on either: a signature on an
  // issued document is a record of an act, and the credential that made
  // it outlives the machine it sat in. A request raised in error is
  // cancelled with a reason and an agent is revoked, both of which are
  // updates.
  signing_requests: 'SELECT, INSERT, UPDATE',
  signing_agents: 'SELECT, INSERT, UPDATE',
  // Notifications (0092). None of the four deletes. A channel is what
  // every historical message went out through, a template is what every
  // logged message was rendered from, a consent record absent is
  // indistinguishable from consent never given, and the delivery log is
  // the answer to "did you tell us". Disabling, withdrawing and opting
  // out are the operations.
  notification_channels: 'SELECT, INSERT, UPDATE',
  notification_templates: 'SELECT, INSERT, UPDATE',
  notification_consents: 'SELECT, INSERT, UPDATE',
  notification_messages: 'SELECT, INSERT, UPDATE',
  // The spreadsheet importer's staging area (0094). No DELETE: a batch
  // is the answer to "where did these eight hundred contacts come from",
  // and an abandoned one is cancelled with a reason rather than removed.
  // The rows go with it — they are the only surviving record of what the
  // uploaded file said, because the workbook itself is never stored.
  spreadsheet_import_batches: 'SELECT, INSERT, UPDATE',
  spreadsheet_import_rows: 'SELECT, INSERT, UPDATE',
  // Payroll (0089, 0090). The three schedules and the employee master
  // retire by end-dating, exactly as gst_rates does, so none of them
  // holds DELETE. Nor does a payroll run at any status: it has claimed a
  // number by the time it exists, and an abandoned draft is cancelled
  // with a reason rather than removed. Its LINES are the one exception,
  // and a narrow one — a draft is recalculated by clearing them and
  // writing them again, and the 0090 guard refuses every delete the
  // moment the run is finalised or cancelled.
  payroll_statutory_rates: 'SELECT, INSERT, UPDATE',
  professional_tax_slabs: 'SELECT, INSERT, UPDATE',
  income_tax_slabs: 'SELECT, INSERT, UPDATE',
  employees: 'SELECT, INSERT, UPDATE',
  payroll_run_counters: 'SELECT, INSERT, UPDATE',
  payroll_runs: 'SELECT, INSERT, UPDATE',
  payroll_run_lines: 'SELECT, INSERT, UPDATE, DELETE',
  // Maintenance: the site material request and everything it produces
  // (0088). The request and its lines take UPDATE for exactly two acts —
  // the status walk, and writing a line off — and no DELETE, because a
  // request carries a number from the moment it is raised. The dispatch
  // challan, its lines and the defective returns are append-only in the
  // ledger's sense: they record something that physically happened.
  maintenance_request_counters: 'SELECT, INSERT, UPDATE',
  maintenance_requests: 'SELECT, INSERT, UPDATE',
  maintenance_request_lines: 'SELECT, INSERT, UPDATE',
  maintenance_dispatch_counters: 'SELECT, INSERT, UPDATE',
  maintenance_dispatches: 'SELECT, INSERT',
  maintenance_dispatch_lines: 'SELECT, INSERT',
  maintenance_returns: 'SELECT, INSERT',
  // The platform controls (0096). None of the three holds DELETE, and
  // each for its own reason: deleting an entitlement row would silently
  // restore the shipped default and erase who decided otherwise, a
  // schedule is switched off rather than forgotten so a check an operator
  // expected is visibly not running, and an export is a disclosure of the
  // entire organisation — a record of a disclosure that can be removed is
  // not a record. Expiry empties the storage, never the row.
  organisation_entitlements: 'SELECT, INSERT, UPDATE',
  statutory_job_schedules: 'SELECT, INSERT, UPDATE',
  organisation_export_requests: 'SELECT, INSERT, UPDATE',
  // The defect liability period and the Work's warranty term (0099). The
  // term is a clause read off a contract and is corrected in place; the
  // period is the record that a warranty ran, so it is voided with a note
  // and neither of them deletes.
  work_warranty_terms: 'SELECT, INSERT, UPDATE',
  installation_warranties: 'SELECT, INSERT, UPDATE',
  // Append-only trails (0002, 0005).
  audit_events: 'SELECT, INSERT',
  identity_audit_events: 'SELECT, INSERT',
  // Cutover provenance is a ledger: append-only for the application role;
  // the importer itself runs as the administrator role (0025).
  import_batches: 'SELECT, INSERT',
  import_records: 'SELECT, INSERT',
  // The inspection lifecycle (0082). Configuration deletes; the call and
  // its evidence do not — a challan may have been issued on the strength
  // of the certificate, so a call cancels with a reason and stays, and
  // the demands it was held to survive even when they were never met.
  inspection_clauses: 'SELECT, INSERT, UPDATE, DELETE',
  inspection_checklist_fields: 'SELECT, INSERT, UPDATE, DELETE',
  inspection_calls: 'SELECT, INSERT, UPDATE',
  inspection_call_counters: 'SELECT, INSERT, UPDATE',
  inspection_call_items: 'SELECT, INSERT, DELETE',
  inspection_call_documents: 'SELECT, INSERT, UPDATE',
  // Retention, security deposit and liquidated damages (0098). The terms
  // are configuration and delete; the release and the assessment are
  // money records and do not. A release recorded in error is WITHDRAWN
  // with a reason and an assessment made in error is CANCELLED with one,
  // both of which are updates, so the mistake and the correction stay on
  // the record together.
  work_retention_terms: 'SELECT, INSERT, UPDATE, DELETE',
  retention_releases: 'SELECT, INSERT, UPDATE',
  ld_assessments: 'SELECT, INSERT, UPDATE',
  // The derived retention position (0098): security_invoker, so the base
  // tables' RLS is re-checked for the caller and this grant adds no
  // visibility. Read-only — every write goes to the three tables above.
  work_retention_positions: 'SELECT',
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
  // The kiosk token resolver (0091) and the webhook receipt writer
  // (0092). Both are SECURITY DEFINER and both were missing from this
  // list, which is a restore hazard with no symptom: after
  // `pg_restore --no-owner` they come back owned by the restoring role,
  // so the resolver reads `signing_agents` through RLS and finds nothing
  // — every kiosk poll answers "no such token" — and the receipt writer
  // reads `notification_channels` the same way, so every WhatsApp
  // delivery receipt silently no-ops and the delivery log freezes at
  // `sent` forever. Neither failure raises anything.
  'app_private.resolve_signing_agent(text)',
  'app_private.record_notification_receipt(text, text, text, timestamptz, text, text)',
  // The inbound opt-out writer (0104, owner ruling of 2026-08-19). Same
  // restore hazard and a worse consequence than the receipt writer's: a
  // restore that left it owned by the restoring role would read
  // `notification_channels` through RLS, find nothing, and silently
  // answer `unknown_channel` to every STOP — so the product would keep
  // messaging people who had asked it to stop, with nothing raised
  // anywhere.
  'app_private.record_notification_opt_out(text, text)',
  // The two worker ticks (0096). Same restore hazard as the queue's own
  // five: they are the ONLY way a recurring check is enqueued or a lapsed
  // export artefact is reclaimed, and a restore that left them owned by
  // the restoring role would stop both silently — nothing errors, the
  // schedules simply stop firing and the whole-organisation bundles stop
  // expiring.
  'app_private.enqueue_due_statutory_jobs(integer)',
  'app_private.expire_lapsed_organisation_exports(integer)',
  // The platform screen's run history (0096). The application role holds
  // no privilege on `worker_jobs`, so this definer read is the only way
  // an organisation can be told what its own scheduled checks found.
  'app_private.organisation_job_history(integer)',
  'app_private.fail_stalled_organisation_exports(interval, integer)',
];

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
  // The statutory seeder (0103). Deliberately NOT in FUNCTION_GRANTS: that
  // list also forces `auto_mb_definer` ownership, and this function is
  // INVOKER-rights on purpose — it takes an organisation id, so definer
  // rights would hand the application role a cross-tenant write into four
  // statutory money registers. Only the EXECUTE grant needs repairing
  // after a fresh-cluster restore drops the ACL; without it organisation
  // creation fails with a bare permission-denied.
  await admin.unsafe(
    `GRANT EXECUTE ON FUNCTION app_private.seed_default_statutory_rows(uuid)
     TO auto_mb_app`,
  );
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
  // The tables the two definer functions above reach. BYPASSRLS lifts the
  // POLICY, never the table privilege, so these grants are separate from
  // the ownership repair and are exactly as narrow as each function is:
  // the kiosk resolver only reads, and the receipt writer reads a channel
  // to find the tenant and moves one message row forwards.
  await admin.unsafe(`GRANT SELECT ON signing_agents TO auto_mb_definer`);
  await admin.unsafe(`GRANT SELECT ON notification_channels TO auto_mb_definer`);
  await admin.unsafe(
    `GRANT SELECT, UPDATE ON notification_messages TO auto_mb_definer`,
  );
  // Migration 0104: the inbound-STOP writer moves consents to opted_out
  // across tenancy. SELECT and UPDATE only — it never creates a consent
  // row, because an address nobody opted in is unknown rather than opted
  // out, and it never deletes one, because 0092 grants no DELETE on this
  // table to anybody.
  await admin.unsafe(
    `GRANT SELECT, UPDATE ON notification_consents TO auto_mb_definer`,
  );
  // Migration 0096: the two worker ticks read and advance these across
  // tenants, because a due schedule and a lapsed artefact both have to be
  // found before any tenant is bound. SELECT and UPDATE only — the ticks
  // advance existing rows and never create or remove one, and the INSERT
  // they do make goes to `worker_jobs` above.
  await admin.unsafe(
    `GRANT SELECT, UPDATE ON statutory_job_schedules, organisation_export_requests
     TO auto_mb_definer`,
  );
  // These functions MUST be owned by the BYPASSRLS definer role: they are
  // SECURITY DEFINER and read organisation_memberships from inside the RLS
  // policies themselves. After a restore onto a fresh cluster
  // (pg_restore --no-owner) they come back owned by the restoring role and
  // organisation creation breaks; the bootstrap repairs ownership.
  for (const fn of FUNCTION_GRANTS) {
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

/**
 * The whole idempotent sequence described at the top of this file, as a
 * function so an entry point can run it and then do more.
 *
 * The shipped image's entry point is `apps/server/src/bootstrap.ts`, which
 * deploy/Dockerfile.server bundles into the image's compiled bootstrap
 * entry point: it calls this and then the optional test-user seeder,
 * which needs Better
 * Auth and therefore cannot live in this package. Running this module
 * directly — `pnpm --filter @auto-mb/db bootstrap` — is the same sequence
 * without that step.
 *
 * `migrationsDirectory` is resolved from THIS module's own URL, which is
 * what makes both callers correct: under tsx it is
 * `packages/db/migrations`, and inside the esbuild bundle every
 * `import.meta.url` is the bundle's own path, so it is
 * `apps/server/migrations` — exactly where the Dockerfile copies them.
 */
export async function runDatabaseBootstrap(options: {
  /**
   * Restore sequencing (docs/RUNBOOK.md): a dump's ACLs reference the
   * cluster-level roles, which never travel with it, so on a FRESH cluster
   * the roles must exist BEFORE pg_restore runs. This creates them and
   * stops — migrations would otherwise create a schema the restore is
   * about to bring back.
   */
  readonly rolesOnly: boolean;
}): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');
  if (!appPassword) throw new Error('AUTO_MB_APP_DB_PASSWORD is required');

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
    if (!options.rolesOnly) {
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
  console.log(options.rolesOnly ? 'roles bootstrap complete' : 'bootstrap complete');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await runDatabaseBootstrap({ rolesOnly: process.argv.includes('--roles-only') });
}
