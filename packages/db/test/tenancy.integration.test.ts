import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organisationA, organisationB } from './fixtures.js';
import type { Sql, TransactionSql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';
import { ensureClusterRoles } from '../src/roles.js';
import { removeOrganisationResidue } from '../src/testing.js';
import {
  TENANT_BIND_REFUSED_SQLSTATE,
  TenantBindRefusedError,
  withTenant,
  withTenantSnapshot,
  withUserContext,
} from '../src/tenant.js';
import { bindTenantGucsDirectly } from './support/invariant-db.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';
const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD ?? 'local-app-change-me';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(here, '..', 'migrations');

const userA = 'integration-user-a';
const userB = 'integration-user-b';

/** Every tenant-owned table, children after parents. Additions to the
 * schema must be added here so the isolation proofs stay complete; the
 * completeness test below fails if this list drifts from the database. */
/**
 * Tables that carry an `organisation_id` column and are nonetheless NOT
 * tenant-scoped in the sense this suite proves â€” so they are excluded from
 * the completeness census above rather than being quietly missing from it.
 *
 * `worker_jobs` (0072) is the only one, and the exclusion is load-bearing
 * in both directions. Its `organisation_id` is real and is exactly what
 * the worker binds before touching anything, but the ROW is not reachable
 * by the application role at all: ADR-0011 gives the table no grant and no
 * policy, so every proof in this suite â€” which drives reads and writes
 * through `auto_mb_app` â€” would fail with `permission denied` rather than
 * demonstrating isolation. The isolation that matters for the queue is
 * proved where it actually lives, in
 * `packages/db/test/worker-queue.integration.test.ts`: that the table is
 * unreadable, that `enqueue_job` takes its organisation from the binding
 * and not from its arguments, and that execution re-proves the membership.
 */
const NOT_TENANT_SCOPED = new Set(['worker_jobs']);

const TENANT_TABLES = [
  'organisations',
  'organisation_memberships',
  'works',
  'work_schedules',
  'work_items',
  'loa_documents',
  'delivery_challans',
  'delivery_challan_items',
  'delivery_challan_counters',
  'issue_challans',
  'issue_challan_lines',
  'issue_challan_counters',
  'audit_events',
  'challan_receipts',
  'challan_item_serials',
  'work_instruments',
  'bill_counters',
  'bills',
  // The payment register and its typed deduction rows (0067).
  'bill_payments',
  'bill_payment_deductions',
  // The outbound half of the cash position (0080): employee payment
  // requests with their per-financial-year counter, and the vendor
  // liability ledger with its payments.
  'payment_requests',
  'payment_request_counters',
  'vendor_invoices',
  'vendor_payments',
  'mb_entries',
  'work_assignments',
  // The unified Contacts master and the Work<->consignee association
  // (0028). consignee_masters is a VIEW over contacts since 0028 â€” views
  // are compatibility surfaces, not tenant tables; RLS lives on contacts.
  'contacts',
  'work_consignees',
  'location_masters',
  'unit_masters',
  'organisation_signatories',
  // The canonical item catalogue and the organisation's own bank accounts
  // (0078). Masters, so both retire by flag and hold no DELETE.
  'canonical_items',
  'organisation_bank_accounts',
  'extension_requests',
  'extension_request_counters',
  'approval_requests',
  // The railway variation order cited for an omission (0058): uploaded
  // evidence, so the application role holds SELECT and INSERT only.
  'amendment_variation_orders',
  // The record that a confirmed Work was withdrawn and what replaced it
  // (0071).
  'work_supersessions',
  'installations',
  'installation_serials',
  'correction_notices',
  'correction_notice_counters',
  'payment_matrices',
  'pac_certificates',
  'pac_certificate_items',
  'measurement_books',
  'measurement_book_merge_provenance',
  'measurement_book_lines',
  'mb_sources',
  'measurement_book_counters',
  'import_batches',
  'import_records',
  // The railway's own received On-Account Bill (0066).
  'received_railway_bills',
  // The procurement wave and the tax facts that ride with it (0033).
  'purchase_orders',
  'purchase_order_lines',
  'purchase_order_counters',
  'budgetary_quotations',
  'budgetary_quotation_lines',
  'budgetary_quotation_counters',
  // The GST tax invoice and the e-way bill that moves it (0035).
  'tax_invoices',
  // The lines of an ITEMISED invoice (0057).
  'tax_invoice_lines',
  'tax_invoice_renders',
  'tax_invoice_counters',
  // The Section 34 credit note and its FY counter (0051).
  'credit_notes',
  'credit_note_counters',
  'eway_bills',
  // The printable e-way bill summary, append-only like the invoice's (0076).
  'eway_bill_renders',
  'statutory_provider_operations',
  // Number formats the organisation defines for itself (0039).
  'document_number_series',
  // The GST rate master (0048).
  'gst_rates',
  // Standalone Delivery Challan numbering, per financial year (0056).
  'standalone_challan_counters',
  // The company document library: reusable organisation-level
  // credentials and the versioned files behind them (0079).
  'company_documents',
  'company_document_versions',
  // The tender pipeline: the confirmed tender, the notice it was read
  // from, the bid checklist that points into the library above, and the
  // status trail (0083).
  'tenders',
  'tender_notices',
  'tender_checklist_items',
  'tender_status_events',
  // The inspection lifecycle: the contract clause per item, the agency's
  // document checklist, and the calls, their coverage and their evidence
  // (0082).
  'inspection_clauses',
  'inspection_checklist_fields',
  'inspection_calls',
  'inspection_call_counters',
  'inspection_call_items',
  'inspection_call_documents',
  // The correspondence register: the inward/outward letters and the two
  // numbering series behind them (0086).
  'correspondence_letters',
  'correspondence_letter_counters',
  // OEM production: the item master, its recursive bill of material, the
  // job card and its numbering, the finished serials and their series,
  // the per-unit component genealogy, and the despatch that hands units
  // to stock (0084). Children follow their parents.
  'production_items',
  'production_bom_lines',
  'production_job_card_counters',
  'production_job_cards',
  'production_serial_counters',
  'production_serials',
  'production_component_serials',
  'production_dispatch_counters',
  'production_dispatches',
  'production_dispatch_serials',
  // The stock ledger: the per-item position and the append-only
  // movements it orders (0087). The counter precedes the movements
  // because the guard claims it as the first write of every one.
  'stock_movement_counters',
  'stock_movements',
  // The signing queue (0091): the kiosk credential first, because every
  // request is authorised against one.
  'signing_agents',
  'signing_requests',
  // Payroll (0089, 0090). The schedules first because the runs read
  // them, the employee before the lines that snapshot them, and the
  // counter before the runs it numbers.
  'payroll_statutory_rates',
  'professional_tax_slabs',
  'income_tax_slabs',
  'employees',
  'payroll_run_counters',
  'payroll_runs',
  'payroll_run_lines',
  // Maintenance (0088): the request, what it asked for, the dispatch
  // challans that answered it and the defective units that came back.
  // Counters precede the documents they number, and the request precedes
  // everything that hangs off it.
  'maintenance_request_counters',
  'maintenance_requests',
  'maintenance_request_lines',
  'maintenance_dispatch_counters',
  'maintenance_dispatches',
  'maintenance_dispatch_lines',
  'maintenance_returns',
] as const;

type TenantTable = (typeof TENANT_TABLES)[number];

/** audit_events has its own append-only proof: the application role has no
 * UPDATE/DELETE privilege at all, so generic zero-row mutation assertions
 * (which expect privilege to exist but RLS to hide rows) do not apply. */
const GENERIC_UPDATE_TABLES = TENANT_TABLES.filter(
  (table) =>
    table !== 'audit_events' &&
    table !== 'work_assignments' &&
    // The Work<->consignee association is create/delete only, like
    // work_assignments: no UPDATE privilege exists (0028).
    table !== 'work_consignees' &&
    // Cutover provenance is append-only for the application role (0025):
    // UPDATE raises 42501 instead of matching zero rows.
    table !== 'import_batches' &&
    table !== 'import_records' &&
    // Completed provider operations are append-only by trigger; the
    // dedicated provider test proves their one permitted pending->terminal
    // transition.
    table !== 'statutory_provider_operations' &&
    // Render versions are append-only; the application role has no UPDATE.
    table !== 'tax_invoice_renders' &&
    table !== 'eway_bill_renders' &&
    // Merge provenance is append-only operational evidence (0045).
    table !== 'measurement_book_merge_provenance' &&
    // A cited variation order is immutable evidence (0058): the
    // application role has no UPDATE, and a trigger refuses one anyway.
    table !== 'amendment_variation_orders' &&
    // A deduction is corrected by voiding its whole payment advice, so
    // the application role has no UPDATE and the 0067 guard refuses one
    // anyway.
    table !== 'bill_payment_deductions' &&
    // A company document version is evidence: append-only for the
    // application role and refused by trigger anyway (0079).
    table !== 'company_document_versions' &&
    // Coverage of an inspection call is settled before the agency comes;
    // the 0082 guard refuses an UPDATE-shaped change to it, and the
    // application role holds no UPDATE on the table at all.
    table !== 'inspection_call_items' &&
    // The tender status trail is append-only: the application role has
    // no UPDATE, so a cross-tenant one raises 42501 rather than matching
    // zero rows (0083).
    table !== 'tender_status_events' &&
    // A serial number is stamped on hardware, so it is never corrected:
    // the application role holds no UPDATE on the finished serial, its
    // component genealogy, the despatch, or the despatch's lines, and a
    // cross-tenant UPDATE raises 42501 rather than matching zero rows
    // (0084).
    table !== 'production_serials' &&
    table !== 'production_component_serials' &&
    table !== 'production_dispatches' &&
    table !== 'production_dispatch_serials' &&
    // A stock movement states what happened; a balance that can be
    // edited is not a ledger. The application role holds no UPDATE, so a
    // cross-tenant one raises 42501 rather than matching zero rows
    // (0087).
    table !== 'stock_movements' &&
    // The dispatch challan, its lines and a defective-unit receipt all
    // record something that physically happened: material left a store,
    // a receiver signed, a broken unit arrived at a bench. The
    // application role holds no UPDATE on any of the three, so a
    // cross-tenant one raises 42501 rather than matching zero rows
    // (0088).
    table !== 'maintenance_dispatches' &&
    table !== 'maintenance_dispatch_lines' &&
    table !== 'maintenance_returns',
);

/** Tables where 0003 revoked DELETE outright (reservation anchors and
 * numbering state): a delete attempt raises 42501 rather than matching
 * zero rows. */
const DELETE_REVOKED_TABLES = [
  'organisations',
  // A settlement document does not leave; a bill attached to the wrong
  // measurement discards in place (0066).
  'received_railway_bills',
  'works',
  'work_items',
  'loa_documents',
  'delivery_challan_counters',
  'issue_challan_counters',
  'challan_receipts',
  'work_instruments',
  'bill_counters',
  'bills',
  // A recorded receipt of money is voided, never deleted, and its
  // deductions go with it (0067).
  'bill_payments',
  'bill_payment_deductions',
  // The outbound half of the cash position (0080): employee payment
  // requests with their per-financial-year counter, and the vendor
  // liability ledger with its payments.
  'payment_requests',
  'payment_request_counters',
  'vendor_invoices',
  'vendor_payments',
  'mb_entries',
  // Masters retire via the active flag; the app role holds no DELETE
  // (0013; contacts follows in 0028).
  'contacts',
  'location_masters',
  'unit_masters',
  'organisation_signatories',
  // Masters retire via the active flag (0078), like their three
  // neighbours above.
  'canonical_items',
  'organisation_bank_accounts',
  'extension_request_counters',
  'approval_requests',
  // A cited variation order is immutable evidence: no UPDATE and no
  // DELETE privilege at all (0058).
  'amendment_variation_orders',
  // A supersession is the only record that a Work was withdrawn: it binds
  // its successor once and is never removed (0071).
  'work_supersessions',
  // Installation records cancel with a note; attachments release (0017).
  'installations',
  'installation_serials',
  // Correction notices are numbered legal records: cancel, never delete;
  // the counter is numbering state (0019).
  'correction_notices',
  'correction_notice_counters',
  // PAC certificates cancel with a note; their lines are frozen (0022).
  'pac_certificates',
  'pac_certificate_items',
  // Measurement Book snapshots are immutable legal records; the counter
  // is numbering state (0024).
  'measurement_book_lines',
  'measurement_book_counters',
  'measurement_book_merge_provenance',
  'statutory_provider_operations',
  'tax_invoice_renders',
  'eway_bill_renders',
  // Cutover provenance is an append-only ledger (0025).
  'import_batches',
  'import_records',
  // Numbering state for the procurement documents (0033).
  'purchase_order_counters',
  'budgetary_quotation_counters',
  // Invoice numbering is a GST rule-46 serial; the invoice itself
  // cancels, never deletes, once submitted (0035).
  'tax_invoice_counters',
  // Credit note numbering is the same rule-46A serial (0051).
  'credit_note_counters',
  // Standalone challan numbering: a released number is never reused, so
  // the counter row never deletes (0056).
  'standalone_challan_counters',
  // The GST rate master retires rows by end-dating; no DELETE (0048).
  'gst_rates',
  // A company credential is archived, never deleted -- a bid that cited
  // it has to stay explicable -- and its versions are evidence (0079).
  'company_documents',
  'company_document_versions',
  // An inspection call is correspondence with a government agency and a
  // challan may have been issued on its certificate: it cancels with a
  // reason and stays. Its documents record what the call was held to,
  // even the demands it never met (0082).
  'inspection_calls',
  'inspection_call_documents',
  // A counter records what a series reached; resetting it would reissue a
  // number a cancelled call still holds (0082).
  'inspection_call_counters',
  // A tender is the answer to "why did we not bid", its notice is the
  // evidence the record was read from, and the trail is append-only. Only
  // the checklist deletes, and it is in DELETE_ALLOWED_TABLES below
  // (0083).
  'tenders',
  'tender_notices',
  'tender_status_events',
  // A letter that went out or came in is a record of what was on the
  // paper: it cancels with a reason and keeps its number forever, so the
  // series stays provably gap-free (0086).
  'correspondence_letters',
  'correspondence_letter_counters',
  // A part number is printed on physical labels and a job card holds a
  // number that must never be reissued; both retire or cancel instead.
  // Counters record how far a series has gone (0084).
  'production_items',
  'production_job_cards',
  'production_job_card_counters',
  'production_serial_counters',
  'production_dispatch_counters',
  // A movement posted in error is reversed by an adjustment carrying the
  // reason, never deleted; the counter records how far the ledger has
  // gone (0087).
  'stock_movements',
  'stock_movement_counters',
  // A signature on an issued document is a record of an act, and the
  // credential that made it outlives the machine it sat in: a request
  // raised in error cancels with a reason, and an agent revokes (0091).
  'signing_requests',
  'signing_agents',
  // A maintenance request carries a number from the moment it is raised
  // and closes rather than disappearing; its lines are cancelled with a
  // reason rather than removed; the challan, its lines and the defective
  // receipts are the record of material that moved. Nothing here deletes
  // (0088).
  'maintenance_request_counters',
  'maintenance_requests',
  'maintenance_request_lines',
  'maintenance_dispatch_counters',
  'maintenance_dispatches',
  'maintenance_dispatch_lines',
  'maintenance_returns',
] as const satisfies readonly TenantTable[];

/** Tables the application role may still DELETE (drafts, lines,
 * memberships, schedules): cross-tenant deletes match zero rows. */
const DELETE_ALLOWED_TABLES = [
  // A payslip is cleared and rewritten every time a DRAFT run is
  // recalculated, which is the only reason DELETE exists on the table at
  // all; the 0090 guard refuses every delete once the run is finalised
  // or cancelled.
  'payroll_run_lines',
  // A bid-checklist line is draft working material while the bid is
  // being assembled, so it deletes; the route refuses it from submission
  // onwards, when the list becomes the record of what went out (0083).
  'tender_checklist_items',
  // A bill-of-material line is design working material and is removed
  // rather than cancelled. A unit recorded in error, a mis-scanned
  // component serial, and a despatch raised in error all delete while
  // the unit is still in the factory; the foreign keys from the despatch
  // tables are what close each of those paths afterwards (0084).
  'production_bom_lines',
  'production_serials',
  'production_component_serials',
  'production_dispatches',
  'production_dispatch_serials',
  // Restoring a document's default number format DELETES the row that
  // overrode it â€” configuration, cleared in place (0039).
  'document_number_series',
  // A draft invoice or e-way bill may be discarded; anything submitted or
  // generated cancels instead (0035).
  'tax_invoices',
  'eway_bills',
  // A draft credit note may be discarded; an issued one cancels (0051).
  'credit_notes',
  // A draft order or quotation is not yet a document and may be discarded;
  // once issued the status moves to cancelled or withdrawn instead (0033).
  'purchase_orders',
  'purchase_order_lines',
  'budgetary_quotations',
  'budgetary_quotation_lines',
  'organisation_memberships',
  'work_schedules',
  'delivery_challans',
  'delivery_challan_items',
  // An itemised invoice's lines are draft-editable exactly like challan
  // lines; the 0057 guard refuses every write once the invoice is issued.
  'tax_invoice_lines',
  'issue_challans',
  'issue_challan_lines',
  'challan_item_serials',
  'work_assignments',
  // Unlinking a Work<->consignee association deletes only the preference;
  // documents keep their snapshots (0028).
  'work_consignees',
  'extension_requests',
  // Payment matrix rows are per-Work configuration, not issued
  // documents; finalised MBs snapshot their percentages (0021).
  'payment_matrices',
  // Measurement Book drafts (and their source claims) delete, guarded
  // by trigger (0024).
  'measurement_books',
  'mb_sources',
  // Inspection configuration is configuration: clearing an item's agency
  // or dropping a demanded document is how an operator says the contract
  // does not ask for it, and the coverage of a call that has not yet gone
  // to the agency is still being decided (0082).
  'inspection_clauses',
  'inspection_checklist_fields',
  'inspection_call_items',
] as const satisfies readonly TenantTable[];

/** organisations carries the tenant id in `id`; every other table in
 * `organisation_id`. */
function organisationColumn(table: TenantTable): string {
  return table === 'organisations' ? 'id' : 'organisation_id';
}

interface TenantGraph {
  readonly workId: string;
  readonly scheduleId: string;
  readonly workItemId: string;
  readonly challanId: string;
  readonly auditEventId: string;
}

let admin: Sql;
let app: Sql;
let graphA: TenantGraph;
let graphB: TenantGraph;

/** Deletes both fixture organisations' rows â€” the shared helper discovers
 * the closure from the catalog and censuses foreign keys afterwards. */
async function removeSeedResidue(): Promise<void> {
  await removeOrganisationResidue(admin, [organisationA.id, organisationB.id]);
}

async function countAs(
  pool: Sql,
  table: TenantTable,
  organisationId: string,
): Promise<number> {
  // Table and column names come from the hard-coded list above, never from
  // input; only the organisation id is parameterised.
  const rows = (await pool.unsafe(
    `select count(*)::int as count from ${table} where ${organisationColumn(table)} = $1`,
    [organisationId],
  )) as unknown as { count: number }[];
  return rows[0]?.count ?? 0;
}

/**
 * Seeds one organisation with a row in every tenant-owned table, inserted
 * through the application role inside a tenant-scoped transaction â€” the
 * same path product code will use.
 */
async function seedTenantGraph(
  organisationId: string,
  name: string,
  slug: string,
  userId: string,
  workCode: string,
  shaFill: string,
): Promise<TenantGraph> {
  // The bootstrap function is the only path that can create an
  // organisation under the membership floor: it atomically creates the
  // organisation, the owner membership, and the audit event. It runs with
  // a USER context and no organisation, exactly as POST /api/organisations
  // does â€” since migration 0069 a tenant binding is refused outright when
  // no membership backs it, and at this point the membership is the thing
  // being created.
  await withUserContext(app, userId, async (tx) => {
    await tx`
      select app_private.create_organisation_with_owner(${name}, ${slug}, ${organisationId})
    `;
  });

  return withTenant(app, { organisationId, userId }, async (tx) => {
    // The 0052 split guard judges every money-carrying invoice against the
    // organisation's own state; the seeded invoice below is an intra-state
    // (27 -> 27) CGST/SGST split, so the organisation must carry state 27.
    await tx`
      update organisations set state_code = '27' where id = ${organisationId}
    `;
    const [work] = await tx<{ id: string }[]>`
      insert into works (
        organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${organisationId}, ${workCode}, ${`LOA/${workCode}`}, '2026-01-15',
        'Integration test work for tenant isolation',
        '100000.00', '95000.00', 'per_schedule', ${userId}
      )
      returning id
    `;
    if (!work) throw new Error('seed work insert returned no row');

    const [schedule] = await tx<{ id: string }[]>`
      insert into work_schedules (organisation_id, work_id, schedule_code, title, position)
      values (${organisationId}, ${work.id}, 'SCH-1', 'Integration schedule', 1)
      returning id
    `;
    if (!schedule) throw new Error('seed schedule insert returned no row');

    const [workItem] = await tx<{ id: string }[]>`
      insert into work_items (
        organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${organisationId}, ${work.id}, ${schedule.id}, '1',
        'Integration test item', 'Nos', '10.000', '100.00'
      )
      returning id
    `;
    if (!workItem) throw new Error('seed work item insert returned no row');

    const [loaDocument] = await tx<{ id: string }[]>`
      insert into loa_documents (
        organisation_id, object_key, original_filename, sha256,
        media_type, size_bytes, uploaded_by_user_id
      )
      values (
        ${organisationId}, ${`${organisationId}/loa/${workCode}.pdf`}, ${`${workCode}.pdf`},
        ${shaFill.repeat(64)}, 'application/pdf', 1024, ${userId}
      )
      returning id
    `;
    if (!loaDocument) throw new Error('seed LOA document insert returned no row');

    const [challan] = await tx<{ id: string }[]>`
      insert into delivery_challans (
        organisation_id, work_id, challan_date, prefix, created_by_user_id
      )
      values (${organisationId}, ${work.id}, '2026-02-01', 'DC', ${userId})
      returning id
    `;
    if (!challan) throw new Error('seed challan insert returned no row');

    await tx`
      insert into delivery_challan_items (
        organisation_id, delivery_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, rate_snapshot,
        line_amount, position
      )
      values (
        ${organisationId}, ${challan.id}, ${work.id}, ${workItem.id},
        'Integration test item', 'Nos', '1.000', '100.00', '100.00', 1
      )
    `;

    await tx`
      insert into delivery_challan_counters (organisation_id, work_id)
      values (${organisationId}, ${work.id})
    `;

    // Milestone 7 Issue Challan tables: one row each.
    const [issueChallan] = await tx<{ id: string }[]>`
      insert into issue_challans (
        organisation_id, work_id, movement_type, challan_date, prefix,
        issued_to_name, created_by_user_id
      )
      values (${organisationId}, ${work.id}, 'issue', '2026-02-01',
              ${`${workCode}-IC`}, 'Integration site engineer', ${userId})
      returning id
    `;
    if (!issueChallan) throw new Error('seed issue challan insert returned no row');
    await tx`
      insert into issue_challan_lines (
        organisation_id, issue_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, position
      )
      values (
        ${organisationId}, ${issueChallan.id}, ${work.id}, ${workItem.id},
        'Integration test item', 'Nos', '1.000', 1
      )
    `;
    await tx`
      insert into issue_challan_counters (organisation_id, work_id)
      values (${organisationId}, ${work.id})
    `;

    const [auditEvent] = await tx<{ id: string }[]>`
      insert into audit_events (organisation_id, actor_user_id, action, entity_type, entity_id)
      values (${organisationId}, ${userId}, 'integration.seed', 'works', ${work.id})
      returning id
    `;
    if (!auditEvent) throw new Error('seed audit insert returned no row');

    // Milestone 5 retention tables: one row each.
    const [challanItem] = await tx<{ id: string }[]>`
      select id from delivery_challan_items
      where delivery_challan_id = ${challan.id}
    `;
    if (!challanItem) throw new Error('seed challan item lookup returned no row');
    await tx`
      insert into challan_receipts (
        organisation_id, delivery_challan_id, work_id, received_on,
        received_by, recorded_by_user_id
      )
      values (${organisationId}, ${challan.id}, ${work.id}, '2026-02-02',
              'Integration consignee', ${userId})
    `;
    await tx`
      insert into challan_item_serials (
        organisation_id, work_id, delivery_challan_id,
        delivery_challan_item_id, serial_number
      )
      values (${organisationId}, ${work.id}, ${challan.id}, ${challanItem.id},
              ${`SN-${workCode}`})
    `;
    await tx`
      insert into work_assignments (
        organisation_id, work_id, user_id, created_by_user_id
      )
      values (${organisationId}, ${work.id}, ${userId}, ${userId})
    `;
    await tx`
      insert into work_instruments (
        organisation_id, work_id, kind, reference, issued_on,
        created_by_user_id
      )
      values (${organisationId}, ${work.id}, 'pbg', ${`PBG-${workCode}`},
              '2026-01-20', ${userId})
    `;
    await tx`
      insert into bill_counters (organisation_id, work_id)
      values (${organisationId}, ${work.id})
    `;
    await tx`
      insert into bills (
        organisation_id, work_id, bill_number, lines_snapshot, total_amount,
        prepared_by_user_id
      )
      values (${organisationId}, ${work.id}, 1, '[]'::jsonb, 0, ${userId})
    `;
    await tx`
      insert into mb_entries (
        organisation_id, work_id, work_item_id, measured_quantity,
        measured_on, recorded_by_user_id
      )
      values (${organisationId}, ${work.id}, ${workItem.id}, '1.000',
              '2026-02-03', ${userId})
    `;
    const [approvalRequest] = await tx<{ id: string }[]>`
      insert into approval_requests (
        organisation_id, entity_type, entity_id, work_id, proposed, diff,
        reason, requested_by_user_id
      )
      values (
        ${organisationId}, 'work_item_amendment', ${workItem.id}, ${work.id},
        '{"kind":"change_item"}'::jsonb, '[]'::jsonb,
        'Integration seed amendment', ${userId}
      )
      returning id
    `;
    if (!approvalRequest) throw new Error('seed approval insert returned no row');

    // The record of a Work withdrawn by an approved supersede request
    // (0071). Seeded against the same approval row; the isolation proof
    // needs the row to exist, not the Work to be soft-deleted.
    await tx`
      insert into work_supersessions (
        organisation_id, superseded_work_id, loa_document_id,
        approval_request_id, reason, superseded_by_user_id
      )
      values (
        ${organisationId}, ${work.id}, ${loaDocument.id},
        ${approvalRequest.id}, 'Integration seed supersession', ${userId}
      )
    `;

    // The railway variation order an omission cites (0058). Only verified
    // orders exist, so the seed writes one.
    await tx`
      insert into amendment_variation_orders (
        organisation_id, approval_request_id, work_id, loa_number, loa_date,
        agreement_number, variation_number, object_key, original_filename,
        sha256, media_type, size_bytes, verdict, verified,
        uploaded_by_user_id
      )
      values (
        ${organisationId}, ${approvalRequest.id}, ${work.id},
        ${`${workCode}-LOA`}, '2026-01-02', ${`${workCode}/AGR/1`}, '1',
        ${`${organisationId}/variationorder/seed.pdf`}, 'variation-1.pdf',
        ${'a'.repeat(64)}, 'application/pdf', 1024,
        '{"verified":true,"claims":[],"failedClaims":[]}'::jsonb, true,
        ${userId}
      )
    `;

    // Milestone 7 correction-flow tables: one row each.
    await tx`
      insert into correction_notices (
        organisation_id, work_id, delivery_challan_id, approval_request_id,
        notice_number, sequence_number, snapshot, template_version,
        created_by_user_id
      )
      values (
        ${organisationId}, ${work.id}, ${challan.id}, ${approvalRequest.id},
        ${`${workCode}-CN-01`}, 1, '{}'::jsonb, 'correction-notice-v1',
        ${userId}
      )
    `;
    await tx`
      insert into correction_notice_counters (organisation_id, work_id)
      values (${organisationId}, ${work.id})
    `;

    // Milestone 7 masters tables (contacts since 0028): one row each,
    // plus the Work<->consignee association.
    const [consigneeContact] = await tx<{ id: string }[]>`
      insert into contacts (
        organisation_id, designation, address, is_consignee,
        created_by_user_id
      )
      values (${organisationId}, ${`Sr. DEE ${workCode}`},
              'Integration division office', true, ${userId})
      returning id
    `;
    if (!consigneeContact) throw new Error('seed contact insert returned no row');
    await tx`
      insert into work_consignees (
        organisation_id, work_id, contact_id, created_by_user_id
      )
      values (${organisationId}, ${work.id}, ${consigneeContact.id}, ${userId})
    `;
    const [locationMaster] = await tx<{ id: string }[]>`
      insert into location_masters (organisation_id, name, kind, created_by_user_id)
      values (${organisationId}, ${`Station ${workCode}`}, 'station', ${userId})
      returning id
    `;
    if (!locationMaster) throw new Error('seed location insert returned no row');
    await tx`
      insert into unit_masters (organisation_id, name, created_by_user_id)
      values (${organisationId}, ${`Unit-${workCode}`}, ${userId})
    `;
    await tx`
      insert into organisation_signatories (
        organisation_id, name, designation, created_by_user_id
      )
      values (${organisationId}, ${`Signatory ${workCode}`}, 'Director', ${userId})
    `;
    await tx`
      insert into canonical_items (
        organisation_id, name, group_name, default_unit, aliases,
        created_by_user_id
      )
      values (
        ${organisationId}, ${`Horn speaker ${workCode}`}, 'Audio', 'Nos',
        ${[`horn speaker ${workCode.toLowerCase()}`]}, ${userId}
      )
    `;
    await tx`
      insert into organisation_bank_accounts (
        organisation_id, account_holder, bank_name, account_number, ifsc,
        branch, created_by_user_id
      )
      values (
        ${organisationId}, ${`Holder ${workCode}`}, 'State Bank of India',
        ${`5010${shaFill.repeat(8).slice(0, 8)}`.toUpperCase().slice(0, 12)},
        'SBIN0000300', 'Andheri East', ${userId}
      )
    `;

    // Milestone 6 completion/extension tables: the one-time completion
    // date set (allowed by the works guard), then a draft extension.
    await tx`
      update works
      set original_completion_date = '2026-12-31',
          current_completion_date = '2026-12-31'
      where id = ${work.id}
    `;
    await tx`
      insert into extension_requests (
        organisation_id, work_id, proposed_completion_date, reason,
        addressee, created_by_user_id
      )
      values (${organisationId}, ${work.id}, '2027-03-31',
              'Integration test extension reason', 'Sr. DEE (G)', ${userId})
    `;
    await tx`
      insert into extension_request_counters (organisation_id, work_id)
      values (${organisationId}, ${work.id})
    `;

    // Milestone 7 installation tables: one recorded installation with a
    // serial attachment, the location name snapshotted from the master.
    const [installation] = await tx<{ id: string }[]>`
      insert into installations (
        organisation_id, work_id, work_item_id, quantity, installed_on,
        location_id, location_name, recorded_by_user_id
      )
      values (
        ${organisationId}, ${work.id}, ${workItem.id}, '1.000', '2026-02-03',
        ${locationMaster.id}, ${`Station ${workCode}`}, ${userId}
      )
      returning id
    `;
    if (!installation) throw new Error('seed installation insert returned no row');
    await tx`
      insert into installation_serials (
        organisation_id, installation_id, work_id, challan_item_serial_id
      )
      select ${organisationId}, ${installation.id}, ${work.id}, s.id
      from challan_item_serials s
      where s.work_id = ${work.id} and s.serial_number = ${`SN-${workCode}`}
    `;

    // Milestone 8 payment matrix: one row.
    await tx`
      insert into payment_matrices (
        organisation_id, work_id, category, pct_supply, pct_installation,
        pct_pac, pct_final_bill, created_by_user_id
      )
      values (${organisationId}, ${work.id}, 'SUPPLY', 80.00, 10.00, 0.00,
              10.00, ${userId})
    `;

    // Milestone 8 phase 1 PAC tables: one recorded certificate with one
    // certified line, the consignee designation snapshotted from the
    // contact (consignee_master_id references contacts since 0028).
    const [pacCertificate] = await tx<{ id: string }[]>`
      insert into pac_certificates (
        organisation_id, work_id, reference, issue_date, consignee_master_id,
        consignee_designation, recorded_by_user_id
      )
      values (
        ${organisationId}, ${work.id}, ${`PAC-${workCode}`}, '2026-02-04',
        ${consigneeContact.id}, ${`Sr. DEE ${workCode}`}, ${userId}
      )
      returning id
    `;
    if (!pacCertificate) throw new Error('seed PAC certificate insert returned no row');
    await tx`
      insert into pac_certificate_items (
        organisation_id, pac_certificate_id, work_id, work_item_id,
        certified_quantity
      )
      values (${organisationId}, ${pacCertificate.id}, ${work.id},
              ${workItem.id}, '1.000')
    `;

    // Milestone 8 phase 2 Measurement Book tables: a draft claiming the
    // recorded installation, one snapshot line written while draft (the
    // line guard requires it), then the finalize-shaped update.
    const [measurementBook] = await tx<{ id: string }[]>`
      insert into measurement_books (
        organisation_id, work_id, mb_date, created_by_user_id
      )
      values (${organisationId}, ${work.id}, '2026-02-05', ${userId})
      returning id
    `;
    if (!measurementBook)
      throw new Error('seed measurement book insert returned no row');
    await tx`
      insert into mb_sources (
        organisation_id, measurement_book_id, work_id, source_type, source_id
      )
      values (${organisationId}, ${measurementBook.id}, ${work.id},
              'installation', ${installation.id})
    `;
    await tx`
      insert into measurement_book_lines (
        organisation_id, measurement_book_id, work_id, work_item_id,
        item_number, description, unit_code, payment_category,
        resolved_category, pct_supply, pct_installation, pct_pac,
        pct_final_bill, effective_rate, delta_installed, prior_supplied,
        amount_supply, amount_installation, amount_pac, amount_final_bill,
        line_total, remark
      )
      values (
        ${organisationId}, ${measurementBook.id}, ${work.id}, ${workItem.id},
        '1', 'Integration test item', 'Nos', 'SUPPLY', 'SUPPLY',
        80.00, 10.00, 0.00, 10.00, '100.00', '1.000', '1.000',
        '0.00', '10.00', '0.00', '0.00', '10.00',
        'Prepaid 80% for 1 Nos. Now to pay 10% for 1 Nos.'
      )
    `;
    await tx`
      update measurement_books
      set status = 'finalized', mb_number = ${`${workCode}-MB-01`},
          sequence_number = 1, total_amount = '10.00',
          remark_template_version = 'mb-remark-v1',
          finalized_by_user_id = ${userId}, finalized_at = now()
      where id = ${measurementBook.id}
    `;
    await tx`
      insert into measurement_book_counters (organisation_id, work_id, next_value)
      values (${organisationId}, ${work.id}, 1)
    `;

    // The railway's own On-Account Bill against that finalized book
    // (0066). Present in both organisations so the cross-tenant reads
    // below have something of each other's to fail to see.
    //
    // It carries a settleable verdict, which it did not before 0067. The
    // payment register cannot hold a row against an unclosed measurement
    // â€” that is 0067's gate, not an incidental precondition â€” so a suite
    // that must seed one row in every tenant table now has to close this
    // book, and closing it is what reads the verdict. The per-signature
    // RULING stays the server's and is proved in the railway-bill suites;
    // what the database asks for is exactly this shape, and stating that
    // shape is not a claim about any real document.
    const [railwayBill] = await tx<{ id: string }[]>`
      insert into received_railway_bills (
        organisation_id, work_id, measurement_book_id, object_key,
        original_filename, sha256, media_type, size_bytes, bill_number,
        bill_date, bill_amount, rate_inclusive_of_gst, measurement_number,
        measurement_sequence, letter_number, extraction_payload,
        uploaded_by_user_id, signature_status, signature_verdict,
        signature_verified_at
      )
      values (
        ${organisationId}, ${work.id}, ${measurementBook.id},
        ${`${organisationId}/railwaybill/${measurementBook.id}.pdf`},
        'bill.pdf', ${'b'.repeat(64)}, 'application/pdf', 2048,
        ${`${workCode}/B1`}, '2026-02-06', '10.00', true,
        '00341490147964/CSTM/1139316/OAM/FL2/01', 1, ${`LOA-${workCode}`},
        '{"billNumber": "seed"}'::jsonb, ${userId}, 'signed_and_intact',
        '{"signatures": [{"index": 1}, {"index": 2}, {"index": 3}]}'::jsonb,
        now()
      )
      returning id
    `;
    if (!railwayBill) throw new Error('seed railway bill insert returned no row');
    await tx`
      update measurement_books
      set closed_at = now(), closed_by_user_id = ${userId},
          closed_by_received_bill_id = ${railwayBill.id}
      where id = ${measurementBook.id}
    `;

    // A bill prepared from that closed book, and the payment register
    // against it (0067). Bill 1 above is a Milestone 5 sweep-era row with
    // no `mb_id` and can never take a payment; this is the modern shape.
    // The figures are the point rather than the amounts: â‚¹10 billed, â‚¹7
    // received, â‚¹2 kept in two named heads, â‚¹1 still outstanding â€” the
    // three-figure position the register exists to state.
    const [mbBill] = await tx<{ id: string }[]>`
      insert into bills (
        organisation_id, work_id, bill_number, lines_snapshot, total_amount,
        prepared_by_user_id, mb_id
      )
      values (
        ${organisationId}, ${work.id}, 2, '[]'::jsonb, '10.00', ${userId},
        ${measurementBook.id}
      )
      returning id
    `;
    if (!mbBill) throw new Error('seed measurement-book bill insert returned no row');
    const [billPayment] = await tx<{ id: string }[]>`
      insert into bill_payments (
        organisation_id, bill_id, received_on, received_amount, reference,
        recorded_by_user_id
      )
      values (
        ${organisationId}, ${mbBill.id}, '2026-02-20', '7.00',
        ${`UTR-${workCode}`}, ${userId}
      )
      returning id
    `;
    if (!billPayment) throw new Error('seed bill payment insert returned no row');
    await tx`
      insert into bill_payment_deductions (
        organisation_id, bill_payment_id, category, amount, description
      )
      values
        (${organisationId}, ${billPayment.id}, 'GST_TDS', '1.00', null),
        (${organisationId}, ${billPayment.id}, 'SECURITY_DEPOSIT', '1.00', null)
    `;

    /* The outbound half of the cash position (0080). The beneficiary is
       a contacts row carrying both payable roles, so one party serves
       the employee register and the vendor ledger and the seed does not
       need two. */
    const [payee] = await tx<{ id: string }[]>`
      insert into contacts (
        organisation_id, designation, is_vendor, is_employee,
        created_by_user_id
      )
      values (${organisationId}, ${`Payee ${workCode}`}, true, true, ${userId})
      returning id
    `;
    if (!payee) throw new Error('seed payee contact insert returned no row');
    await tx`
      insert into payment_request_counters (organisation_id, fy_label, next_value)
      values (${organisationId}, '2026-27', 3)
    `;
    /* Two rows, because the no-context and cross-tenant assertions each
       want at least one and the suite checks for two. Both are created
       in a state the 0080 insert guard permits. */
    await tx`
      insert into payment_requests (
        organisation_id, fy_label, sequence_number, request_number, kind,
        work_id, beneficiary_contact_id, purpose, category, amount,
        proof_reference, proof_filename, status, requested_by_user_id
      )
      values
        (${organisationId}, '2026-27', 1, ${`PR/2026-27/001-${workCode}`},
         'advance', ${work.id}, ${payee.id}, 'Site travel', 'travel', '100.00',
         ${`${organisationId}/proof/a.pdf`}, 'a.pdf', 'submitted', ${userId}),
        (${organisationId}, '2026-27', 2, ${`PR/2026-27/002-${workCode}`},
         'reimbursement', null, ${payee.id}, 'Inspection travel', 'travel',
         '200.00', ${`${organisationId}/proof/b.pdf`}, 'b.pdf', 'submitted',
         ${userId})
    `;
    const [vendorInvoice] = await tx<{ id: string }[]>`
      insert into vendor_invoices (
        organisation_id, vendor_contact_id, invoice_number, invoice_date,
        credit_days, amount, recorded_by_user_id
      )
      values (
        ${organisationId}, ${payee.id}, ${`VI-${workCode}`}, '2026-02-01', 30,
        '500.00', ${userId}
      )
      returning id
    `;
    if (!vendorInvoice) throw new Error('seed vendor invoice insert returned no row');
    await tx`
      insert into vendor_payments (
        organisation_id, vendor_invoice_id, paid_on, gross_amount,
        tds_amount, net_amount, tds_section, tds_rate,
        tds_taxable_amount, tds_taxable_basis, reference,
        recorded_by_user_id
      )
      values (
        ${organisationId}, ${vendorInvoice.id}, '2026-02-10', '100.00',
        '2.00', '98.00', '194C', '2.00', '100.00', 'payment',
        ${`VP-${workCode}`}, ${userId}
      )
    `;

    // 0045 normalized merge provenance: a live target plus one selected
    // record that had no own source (the NULL pair is its membership sentinel).
    const [mergeTarget] = await tx<{ id: string }[]>`
      insert into measurement_books (
        organisation_id, work_id, mb_date, kind, created_by_user_id
      ) values (${organisationId}, ${work.id}, '2026-02-05', 'on_account', ${userId})
      returning id
    `;
    if (!mergeTarget) throw new Error('seed merge target insert returned no row');
    const [mergedRecord] = await tx<{ id: string }[]>`
      insert into measurement_books (
        organisation_id, work_id, mb_date, kind,
        consignee_contact_id, created_by_user_id
      ) values (
        ${organisationId}, ${work.id}, '2026-02-05', 'record',
        ${consigneeContact.id}, ${userId}
      )
      returning id
    `;
    if (!mergedRecord) throw new Error('seed merged record insert returned no row');
    await tx`
      insert into measurement_book_merge_provenance (
        organisation_id, target_measurement_book_id,
        record_measurement_book_id, work_id, source_type, source_id,
        created_by_user_id
      ) values (
        ${organisationId}, ${mergeTarget.id}, ${mergedRecord.id}, ${work.id},
        null, null, ${userId}
      )
    `;
    await tx`
      update measurement_books
      set status = 'merged', merged_into_id = ${mergeTarget.id}
      where id = ${mergedRecord.id}
    `;

    // Wave 5 cutover provenance tables: one batch with one record.
    const [importBatch] = await tx<{ id: string }[]>`
      insert into import_batches (
        organisation_id, source_system, importer_version, input_digest, dry_run
      )
      values (${organisationId}, 'auto-mb-v1', 'integration-test',
              ${shaFill.repeat(64)}, false)
      returning id
    `;
    if (!importBatch) throw new Error('seed import batch insert returned no row');
    await tx`
      insert into import_records (
        organisation_id, entity_type, source_system, source_id, target_id,
        batch_id, payload_fingerprint
      )
      values (${organisationId}, 'work', 'auto-mb-v1', ${`w-${workCode}`},
              ${work.id}, ${importBatch.id}, ${shaFill.repeat(64)})
    `;

    // Wave 6 procurement (0033): one issued purchase order with a line and
    // its counter, and one issued budgetary quotation with a line and its
    // counter. Issued rather than draft so the shape CHECKs are exercised
    // and the one-draft-per-Work index cannot collide across the two
    // organisations this seed runs for.
    const [purchaseOrder] = await tx<{ id: string }[]>`
      insert into purchase_orders (
        organisation_id, work_id, vendor_contact_id, po_date,
        created_by_user_id
      )
      values (${organisationId}, ${work.id}, ${consigneeContact.id},
              '2026-02-01', ${userId})
      returning id
    `;
    if (!purchaseOrder) throw new Error('seed purchase order insert returned no row');
    await tx`
      insert into purchase_order_lines (
        organisation_id, purchase_order_id, work_item_id, line_number,
        description, unit_code, quantity, rate, line_amount
      )
      values (${organisationId}, ${purchaseOrder.id}, ${workItem.id}, 1,
              'Seeded purchase order line', 'Nos', '10.000', '100.000000',
              '1000.00')
    `;
    // Lines first, then issue: the 0033 guard fixes an issued order's lines.
    await tx`
      update purchase_orders
         set status = 'issued', po_number = ${`${workCode}-PO-01`},
             sequence_number = 1,
             vendor_snapshot = ${tx.json({ designation: 'Vendor' })},
             total_amount = '1000.00', issued_at = now(),
             issued_by_user_id = ${userId}
       where id = ${purchaseOrder.id}
    `;
    await tx`
      insert into purchase_order_counters (organisation_id, work_id, next_value)
      values (${organisationId}, ${work.id}, 2)
    `;

    const [quotation] = await tx<{ id: string }[]>`
      insert into budgetary_quotations (
        organisation_id, addressed_to, subject, bq_date, created_by_user_id
      )
      values (${organisationId}, 'Sr. DEE (G) CR', 'Budgetary quotation',
              '2026-01-20', ${userId})
      returning id
    `;
    if (!quotation) throw new Error('seed budgetary quotation insert returned no row');
    await tx`
      insert into budgetary_quotation_lines (
        organisation_id, budgetary_quotation_id, line_number, description,
        unit_code, quantity, rate, line_amount
      )
      values (${organisationId}, ${quotation.id}, 1, 'Seeded quotation line',
              'Nos', '5.000', '100.000000', '500.00')
    `;
    await tx`
      update budgetary_quotations
         set status = 'issued', bq_number = ${`BQ-${workCode}-01`},
             sequence_number = 1, total_amount = '500.00', issued_at = now(),
             issued_by_user_id = ${userId}
       where id = ${quotation.id}
    `;
    await tx`
      insert into budgetary_quotation_counters (organisation_id, next_value)
      values (${organisationId}, 2)
    `;
    await tx`
      insert into document_number_series (organisation_id, document_type, template)
      values (${organisationId}, 'tax_invoice', 'P{DIV}{FY2}{SEQ:3}')
    `;

    // The GST rate master (0048). This organisation was created AFTER the
    // migration ran, so the migration's per-organisation seed did not
    // reach it; one row proves the isolation posture. 18% from GST
    // introduction covers the seeded tax invoice below (2026-02-07),
    // which the 0048 guard trigger now demands.
    await tx`
      insert into gst_rates (
        organisation_id, rate, label, effective_from, created_by_user_id
      )
      values (${organisationId}, '18.00', 'Standard 18%', '2017-07-01', ${userId})
    `;

    // Wave 6 tax documents (0035). The 0035 insert guards demand a
    // finalized MB behind an invoice and a submitted invoice behind an
    // e-way bill, so the seed writes exactly that chain.
    const [finalizedMb] = await tx<{ id: string }[]>`
      insert into measurement_books (
        organisation_id, work_id, kind, status, mb_date, mb_number,
        sequence_number, total_amount, remark_template_version,
        finalized_at, finalized_by_user_id, created_by_user_id
      )
      values (${organisationId}, ${work.id}, 'on_account', 'finalized',
              '2026-02-06', ${`${workCode}-MB-99`}, 99, '118.00', 'v1',
              now(), ${userId}, ${userId})
      returning id
    `;
    if (!finalizedMb) throw new Error('seed finalized MB insert returned no row');
    const [taxInvoice] = await tx<{ id: string }[]>`
      insert into tax_invoices (
        organisation_id, work_id, measurement_book_id, status,
        invoice_number, number_prefix, sequence_number, fy_label,
        invoice_date, sac_code,
        service_description, gst_rate, place_of_supply, buyer_contact_id,
        buyer_snapshot,
        taxable_value, cgst_amount, sgst_amount, igst_amount, round_off,
        total_amount, issued_snapshot, reverse_charge_applicable,
        submitted_at, submitted_by_user_id, created_by_user_id
      )
      values (${organisationId}, ${work.id}, ${finalizedMb.id}, 'submitted',
              ${`TI/2026-27/${workCode}`}, 'TI', 1, '2026-27', '2026-02-07',
              '995461', 'Works contract services per MB', '18.00', '27',
              ${consigneeContact.id},
              ${tx.json({ name: 'Sr. DEE (G) CR', stateCode: '27' })},
              '100.00', '9.00', '9.00', '0.00', '0.00', '118.00',
              ${tx.json({ templateVersion: 'ti-v1' })}, false, now(), ${userId},
              ${userId})
      returning id
    `;
    if (!taxInvoice) throw new Error('seed tax invoice insert returned no row');
    await tx`
      insert into tax_invoice_renders (
        organisation_id, tax_invoice_id, version, template_version,
        source_sha256, object_key, pdf_sha256, created_by_user_id
      )
      values (
        ${organisationId}, ${taxInvoice.id}, 1, 'ti-v1', ${'b'.repeat(64)},
        ${`${organisationId}/ti/${taxInvoice.id}-seed.pdf`}, ${'c'.repeat(64)},
        ${userId}
      )
    `;
    await tx`
      insert into statutory_provider_operations (
        organisation_id, tax_invoice_id, provider, environment, operation,
        status, request_sha256, created_by_user_id, completed_at
      )
      values (
        ${organisationId}, ${taxInvoice.id}, 'whitebooks', 'sandbox',
        'reconcile_irp', 'unknown', ${'a'.repeat(64)}, ${userId}, now()
      )
    `;
    await tx`
      insert into tax_invoice_counters (organisation_id, fy_label, next_value)
      values (${organisationId}, '2026-27', 2)
    `;
    // An ITEMISED direct invoice and its line (0057). Drafted, so the
    // header money and the line money are both open and the deferred
    // shape check sees a coherent pair: itemised, at least one line, no
    // frozen money anywhere.
    const [itemisedInvoice] = await tx<{ id: string }[]>`
      insert into tax_invoices (
        organisation_id, status, line_shape, invoice_date, place_of_supply,
        buyer_contact_id, stated_taxable_value, reverse_charge_applicable,
        number_prefix, created_by_user_id
      )
      values (${organisationId}, 'draft', 'itemised', '2026-02-07', '27',
              ${consigneeContact.id}, '100.00', false, 'TI', ${userId})
      returning id
    `;
    if (!itemisedInvoice) {
      throw new Error('seed itemised tax invoice insert returned no row');
    }
    await tx`
      insert into tax_invoice_lines (
        organisation_id, tax_invoice_id, position, is_service,
        hsn_sac_code, description, quantity, unit_label, unit_rate, gst_rate
      )
      values (${organisationId}, ${itemisedInvoice.id}, 1, false,
              '85444999', 'Signalling cable', '2.000', 'm', '50.00', '18.00')
    `;
    // A draft credit note against the seeded submitted invoice (0051):
    // a draft carries no number/money, so the cross-record and
    // full-value guards accept it without superseding the invoice.
    await tx`
      insert into credit_notes (
        organisation_id, tax_invoice_id, work_id, note_date, reason,
        created_by_user_id
      )
      values (
        ${organisationId}, ${taxInvoice.id}, ${work.id}, '2026-02-08',
        'Tenant isolation seed credit note', ${userId}
      )
    `;
    await tx`
      insert into credit_note_counters (organisation_id, fy_label, next_value)
      values (${organisationId}, '2026-27', 1)
    `;
    await tx`
      insert into standalone_challan_counters (organisation_id, fy_label, next_value)
      values (${organisationId}, '2026-27', 1)
    `;
    await tx`
      insert into eway_bills (
        organisation_id, tax_invoice_id, distance_km, from_pincode,
        to_pincode, created_by_user_id
      )
      values (${organisationId}, ${taxInvoice.id}, 120, '422010', '400001',
              ${userId})
    `;
    // A second, CANCELLED bill on the same invoice: the 0035 partial
    // unique index counts only live ones, so this coexists with the
    // pristine draft above rather than replacing it (the delete-guard
    // suite below needs that draft to stay pristine). It exists to carry
    // a printable summary (0076), which 0076's insert guard refuses to
    // attach to a draft.
    const [renderedEwayBill] = await tx<{ id: string }[]>`
      insert into eway_bills (
        organisation_id, tax_invoice_id, status, vehicle_number, distance_km,
        from_pincode, to_pincode, ewb_number, ewb_date, valid_until,
        ewb_date_text, valid_until_text, provider, provider_state,
        generated_at, generated_by_user_id, cancelled_at, cancelled_by_user_id,
        cancellation_note, created_by_user_id
      )
      values (
        ${organisationId}, ${taxInvoice.id}, 'cancelled', 'MH12AB1234', 120,
        '422010', '400001', '123456789012', now(), now() + interval '1 day',
        '14/08/2026 10:00:00 AM', '15/08/2026 10:00:00 AM', 'manual',
        'generated', now(), ${userId}, now(), ${userId},
        'seed: consignment withdrawn', ${userId}
      )
      returning id
    `;
    if (!renderedEwayBill) throw new Error('seed eway bill insert returned no row');
    await tx`
      insert into eway_bill_renders (
        organisation_id, eway_bill_id, version, template_version,
        source_sha256, object_key, pdf_sha256, created_by_user_id
      )
      values (
        ${organisationId}, ${renderedEwayBill.id}, 1, 'ewb-v1', ${'d'.repeat(64)},
        ${`${organisationId}/ewb/${renderedEwayBill.id}-seed.pdf`},
        ${'e'.repeat(64)}, ${userId}
      )
    `;

    // One company credential and one version of it (0079). It hangs off
    // no Work at all â€” that is the point of the library â€” so it is
    // seeded from the organisation alone.
    const [companyDocument] = await tx<{ id: string }[]>`
      insert into company_documents (
        organisation_id, title, category, created_by_user_id
      )
      values (
        ${organisationId}, ${`GST registration ${workCode}`}, 'statutory',
        ${userId}
      )
      returning id
    `;
    if (!companyDocument) throw new Error('seed company document returned no row');
    await tx`
      insert into company_document_versions (
        organisation_id, company_document_id, version_number, object_key,
        original_filename, sha256, media_type, size_bytes, valid_from,
        expires_on, uploaded_by_user_id
      )
      values (
        ${organisationId}, ${companyDocument.id}, 1,
        ${`${organisationId}/orgdoc/${companyDocument.id}.pdf`},
        'gst-registration.pdf', ${'f'.repeat(64)}, 'application/pdf', 4096,
        '2026-04-01', '2027-03-31', ${userId}
      )
    `;

    // The inspection lifecycle (0082): one clause that gates despatch,
    // one checklist demand, and one call in its first state covering the
    // item, with its checklist snapshot. Seeded `requested` on purpose â€”
    // it is the state in which coverage may still be deleted, which is
    // what the DELETE-allowed sweep exercises.
    await tx`
      insert into inspection_clauses (
        organisation_id, work_id, work_item_id, agency, vendor_premises,
        gates_dispatch, created_by_user_id
      )
      values (
        ${organisationId}, ${work.id}, ${workItem.id}, 'RDSO',
        'RailTech Components', true, ${userId}
      )
    `;
    await tx`
      insert into inspection_checklist_fields (
        organisation_id, work_id, agency, label, mandatory, position
      )
      values (
        ${organisationId}, ${work.id}, 'RDSO', 'Routine Test Report', true, 0
      )
    `;
    await tx`
      insert into inspection_call_counters (organisation_id, work_id, next_value)
      values (${organisationId}, ${work.id}, 2)
    `;
    const [inspectionCall] = await tx<{ id: string }[]>`
      insert into inspection_calls (
        organisation_id, work_id, sequence_number, agency, requested_on,
        created_by_user_id
      )
      values (
        ${organisationId}, ${work.id}, 1, 'RDSO', '2026-01-05', ${userId}
      )
      returning id
    `;
    if (!inspectionCall) throw new Error('seed inspection call returned no row');
    await tx`
      insert into inspection_call_items (
        organisation_id, inspection_call_id, work_id, work_item_id, quantity
      )
      values (
        ${organisationId}, ${inspectionCall.id}, ${work.id}, ${workItem.id}, 5
      )
    `;
    await tx`
      insert into inspection_call_documents (
        organisation_id, inspection_call_id, kind, label, mandatory, position
      )
      values (
        ${organisationId}, ${inspectionCall.id}, 'evidence',
        'Routine Test Report', true, 1
      )
    `;

    // One tender, the notice it was confirmed from, one checklist line
    // answered by the credential above, and the trail row its creation
    // wrote (0083). Like the library, none of it hangs off a Work.
    const [tender] = await tx<{ id: string }[]>`
      insert into tenders (
        organisation_id, tender_number, authority, title, bid_closes_at,
        estimated_value, emd_amount, created_by_user_id
      )
      values (
        ${organisationId}, ${`NIT/${workCode}`}, 'Western Railway',
        'Supply of passenger information systems',
        '2027-01-15T09:30:00Z', 84000000.00, 1680000.00, ${userId}
      )
      returning id
    `;
    if (!tender) throw new Error('seed tender insert returned no row');
    await tx`
      insert into tender_notices (
        organisation_id, object_key, original_filename, sha256, media_type,
        size_bytes, extraction_status, extraction_payload,
        confirmed_tender_id, uploaded_by_user_id
      )
      values (
        ${organisationId}, ${`${organisationId}/nit/${tender.id}.pdf`},
        'nit.pdf', ${'a'.repeat(64)}, 'application/pdf', 2048, 'review',
        '{"review":{"seeded":true}}'::jsonb, ${tender.id}, ${userId}
      )
    `;
    await tx`
      insert into tender_checklist_items (
        organisation_id, tender_id, title, mandatory, company_document_id,
        attached_at, attached_by_user_id, created_by_user_id
      )
      values (
        ${organisationId}, ${tender.id}, 'GST registration', true,
        ${companyDocument.id}, now(), ${userId}, ${userId}
      )
    `;
    await tx`
      insert into tender_status_events (
        organisation_id, tender_id, from_status, to_status, note, actor_user_id
      )
      values (
        ${organisationId}, ${tender.id}, null, 'drafted',
        'seed: created from the tender notice', ${userId}
      )
    `;

    // One outward letter and the counter that numbered it (0086). Filed
    // against the Work, so the composite foreign key is exercised too.
    await tx`
      insert into correspondence_letter_counters (
        organisation_id, direction, fy_label, next_value
      )
      values (${organisationId}, 'outward', '2026-27', 2)
    `;
    await tx`
      insert into correspondence_letters (
        organisation_id, work_id, direction, letter_number, financial_year,
        sequence_number, letter_date, subject, counterparty_name, body,
        created_by_user_id
      )
      values (
        ${organisationId}, ${work.id}, 'outward', 'OUT/26-27/001', '2026-27',
        1, '2026-06-12', 'Submission of approved makes',
        'Sr. DSTE/MMCT', 'Seed letter body.', ${userId}
      )
    `;

    // OEM production (0084): a manufactured board, one serial-controlled
    // component, the bill-of-material edge between them, a job card
    // against the Work, one finished unit with one component consumed
    // into it, and the despatch that released it. Seeded as a complete
    // chain because every table has to carry a row for the sweeps above,
    // and the chain is the only order that satisfies its own guards.
    const [product] = await tx<{ id: string }[]>`
      insert into production_items (
        organisation_id, item_code, name, category, unit, manufactured,
        serial_prefix, serial_controlled, created_by_user_id
      )
      values (
        ${organisationId}, ${`PEB-${workCode}`}, 'IP display board',
        'Display boards', 'Nos', true, ${`SEED${workCode.slice(-4)}`}, true,
        ${userId}
      )
      returning id
    `;
    if (!product) throw new Error('seed production item returned no row');
    const [component] = await tx<{ id: string }[]>`
      insert into production_items (
        organisation_id, item_code, name, category, unit, serial_controlled,
        created_by_user_id
      )
      values (
        ${organisationId}, ${`SMPS-${workCode}`}, '24 V 10 A SMPS',
        'Power supplies', 'Nos', true, ${userId}
      )
      returning id
    `;
    if (!component) throw new Error('seed production component returned no row');
    await tx`
      insert into production_bom_lines (
        organisation_id, parent_item_id, component_item_id, quantity,
        created_by_user_id
      )
      values (${organisationId}, ${product.id}, ${component.id}, 1, ${userId})
    `;
    await tx`
      insert into production_job_card_counters (organisation_id, fy_label, next_value)
      values (${organisationId}, '2026-27', 2)
    `;
    const [jobCard] = await tx<{ id: string }[]>`
      insert into production_job_cards (
        organisation_id, fy_label, sequence_number, item_id, quantity,
        work_id, source_reference, due_date, created_by_user_id
      )
      values (
        ${organisationId}, '2026-27', 1, ${product.id}, 4, ${work.id},
        ${`${workCode} · A2/1`}, '2026-09-15', ${userId}
      )
      returning id
    `;
    if (!jobCard) throw new Error('seed job card returned no row');
    await tx`
      insert into production_serial_counters (
        organisation_id, production_item_id, next_value
      )
      values (${organisationId}, ${product.id}, 2)
    `;
    const [unit] = await tx<{ id: string }[]>`
      insert into production_serials (
        organisation_id, job_card_id, item_id, serial_number, sequence_number,
        created_by_user_id
      )
      values (
        ${organisationId}, ${jobCard.id}, ${product.id},
        ${`SEED${workCode.slice(-4)}-00001`}, 1, ${userId}
      )
      returning id
    `;
    if (!unit) throw new Error('seed production serial returned no row');
    await tx`
      insert into production_component_serials (
        organisation_id, finished_serial_id, component_item_id, serial_number,
        created_by_user_id
      )
      values (
        ${organisationId}, ${unit.id}, ${component.id},
        ${`SMPS24-${workCode.slice(-4)}`}, ${userId}
      )
    `;
    await tx`
      insert into production_dispatch_counters (
        organisation_id, job_card_id, next_value
      )
      values (${organisationId}, ${jobCard.id}, 2)
    `;
    const [dispatch] = await tx<{ id: string }[]>`
      insert into production_dispatches (
        organisation_id, job_card_id, sequence_number, dispatched_on,
        created_by_user_id
      )
      values (
        ${organisationId}, ${jobCard.id}, 1,
        -- The despatch guard (0084) refuses a date after the
        -- organisation's own today, so the seed dates it in the past
        -- rather than pinning a future day that goes stale.
        current_date - 1, ${userId}
      )
      returning id
    `;
    if (!dispatch) throw new Error('seed production dispatch returned no row');
    await tx`
      insert into production_dispatch_serials (
        organisation_id, production_dispatch_id, production_serial_id,
        job_card_id
      )
      values (
        ${organisationId}, ${dispatch.id}, ${unit.id}, ${jobCard.id}
      )
    `;

    // The stock ledger (0087): the despatch above taken onto the shelf.
    // One movement is all the sweeps need, and taking it from the
    // despatch keeps the seed a real chain rather than a bare row —
    // `stock_movement_counters` is seeded by the guard as a side effect,
    // which is the only way that row is ever created.
    await tx`
      insert into stock_movements (
        organisation_id, production_item_id, movement_type, quantity,
        movement_date, production_dispatch_id, created_by_user_id
      )
      values (
        ${organisationId}, ${product.id}, 'production_receipt', 1,
        '2026-08-01', ${dispatch.id}, ${userId}
      )
    `;

    // The signing queue (0091). Its request has to hang off an ISSUED
    // document — the guard refuses a draft, which is the point of it — so
    // this seeds a second challan carrying a number and a render, and
    // then the kiosk credential the request is authorised against.
    const [issued] = await tx<{ id: string }[]>`
      insert into delivery_challans (
        organisation_id, work_id, challan_date, prefix, status,
        challan_number, sequence_number, issued_snapshot, issued_at,
        rendered_object_key, rendered_sha256, created_by_user_id, issued_by_user_id
      )
      values (
        ${organisationId}, ${work.id}, '2026-02-02', 'DC', 'issued',
        ${`DC/SIG/${workCode}`}, 9001, ${tx.json({})}, now(),
        ${`${organisationId}/dc/signed-seed.pdf`}, ${'c'.repeat(64)},
        ${userId}, ${userId}
      )
      returning id
    `;
    if (!issued) throw new Error('seed issued challan insert returned no row');

    const [agent] = await tx<{ id: string }[]>`
      insert into signing_agents (
        organisation_id, label, token_hash, certificate_thumbprint,
        certificate_subject, certificate_serial, certificate_not_after,
        certificate_chain_pem, operator_user_id, created_by_user_id
      )
      values (
        ${organisationId}, 'Integration kiosk',
        ${randomBytes(32).toString('hex')}, ${'A'.repeat(40)},
        'CN=INTEGRATION SIGNER', 'AB01', '2030-01-01T00:00:00Z',
        '-----BEGIN CERTIFICATE-----\nseed\n-----END CERTIFICATE-----\n',
        ${userId}, ${userId}
      )
      returning id
    `;
    if (!agent) throw new Error('seed signing agent insert returned no row');

    await tx`
      insert into signing_requests (
        organisation_id, document_type, delivery_challan_id, work_id,
        source_object_key, source_sha256, authorised_digest,
        claimed_signing_time, signer_name, signing_reason, signing_location,
        expires_at, signing_agent_id, certificate_thumbprint,
        requested_by_user_id
      )
      values (
        ${organisationId}, 'delivery_challan', ${issued.id}, ${work.id},
        ${`${organisationId}/dc/signed-seed.pdf`}, ${'c'.repeat(64)},
        ${'d'.repeat(64)}, now(), 'INTEGRATION SIGNER',
        'Issued by the contractor', 'Nagpur', now() + interval '7 days',
        ${agent.id}, ${'A'.repeat(40)}, ${userId}
      )
    `;

    // Payroll (0089, 0090). A whole chain rather than seven bare rows:
    // the schedules a run reads, an employee hanging off a contact, and
    // a draft run calculated by the real function — which is what seeds
    // `payroll_run_lines` and, through the route's own upsert shape,
    // gives `payroll_run_counters` a row to sweep.
    for (const [parameter, value] of [
      ['epf_employee_percent', '12'],
      ['epf_employer_total_percent', '12'],
      ['eps_employer_percent', '8.33'],
      ['eps_monthly_wage_ceiling_rupees', '15000'],
      ['epf_monthly_wage_ceiling_rupees', '15000'],
      ['esi_employee_percent', '0.75'],
      ['esi_employer_percent', '3.25'],
      ['esi_monthly_gross_ceiling_rupees', '21000'],
      ['income_tax_cess_percent', '4'],
      ['income_tax_surcharge_floor_rupees', '5000000'],
      ['standard_deduction_new_rupees', '75000'],
      ['rebate_87a_new_income_limit_rupees', '1200000'],
      ['rebate_87a_new_cap_rupees', '60000'],
    ] as const) {
      await tx`
        insert into payroll_statutory_rates (
          organisation_id, parameter, value, effective_from, notification
        )
        values (
          ${organisationId}, ${parameter}, ${value}::numeric(14,4),
          '2014-09-01'::date, 'tenancy fixture'
        )
      `;
    }
    for (const [from, to, amount] of [
      ['0', '10000.01', '0'],
      ['10000.01', null, '200'],
    ] as const) {
      await tx`
        insert into professional_tax_slabs (
          organisation_id, state_code, payee_category, effective_from,
          monthly_wage_from, monthly_wage_to, monthly_amount, notification
        )
        values (
          ${organisationId}, '27', 'male', '2023-04-01'::date,
          ${from}::numeric(18,2), ${to}::numeric(18,2),
          ${amount}::numeric(18,2), 'tenancy fixture'
        )
      `;
    }
    for (const [from, to, rate] of [
      ['0', '400000', '0'],
      ['400000', null, '5'],
    ] as const) {
      await tx`
        insert into income_tax_slabs (
          organisation_id, regime, payee_category, effective_from,
          annual_income_from, annual_income_to, rate, notification
        )
        values (
          ${organisationId}, 'new', 'general', '2025-04-01'::date,
          ${from}::numeric(18,2), ${to}::numeric(18,2),
          ${rate}::numeric(5,2), 'tenancy fixture'
        )
      `;
    }
    const [payrollContact] = await tx<{ id: string }[]>`
      insert into contacts (
        organisation_id, designation, is_employee, created_by_user_id
      )
      values (${organisationId}, 'Payroll fixture person', true, ${userId})
      returning id
    `;
    if (!payrollContact) throw new Error('seed payroll contact returned no row');
    const [employee] = await tx<{ id: string }[]>`
      insert into employees (
        organisation_id, contact_id, employee_code, date_of_joining,
        date_of_birth, pf_covered, pf_wage_basis, esi_applicable,
        professional_tax_state_code, professional_tax_category, tax_regime,
        basic_monthly, created_by_user_id
      )
      values (
        ${organisationId}, ${payrollContact.id}, 'FIX-001', '2024-04-01',
        '1990-01-01', true, 'ceiling', true, '27', 'male', 'new',
        30000.00, ${userId}
      )
      returning id
    `;
    if (!employee) throw new Error('seed employee returned no row');
    await tx`
      insert into payroll_run_counters (organisation_id, fy_label, next_value)
      values (${organisationId}, '2026-27', 2)
    `;
    const [payrollRun] = await tx<{ id: string }[]>`
      insert into payroll_runs (
        organisation_id, fy_label, sequence_number, run_number, period_month,
        created_by_user_id
      )
      values (
        ${organisationId}, '2026-27', 1, 'PAY/2026-27/001', '2026-07-01',
        ${userId}
      )
      returning id
    `;
    if (!payrollRun) throw new Error('seed payroll run returned no row');
    await tx`select app_private.calculate_payroll_run(${payrollRun.id})`;
    // Maintenance (0088): one request, one material line naming the part
    // seeded above, one dispatch challan against it, and one defective
    // unit received back. A real chain rather than seven bare rows —
    // every guard in the module runs over this seed, so a rule that
    // contradicts its own lifecycle fails here rather than in review.
    await tx`
      insert into maintenance_request_counters (organisation_id, fy_label, next_value)
      values (${organisationId}, '2026-27', 2)
    `;
    const [maintenanceRequest] = await tx<{ id: string }[]>`
      insert into maintenance_requests (
        organisation_id, work_id, request_number, financial_year,
        sequence_number, station, requester_name, priority, fault_summary,
        created_by_user_id
      )
      values (
        ${organisationId}, ${work.id}, ${`MR/26-27/${workCode.slice(-4)}`},
        '2026-27', 1, 'Churchgate', 'Amit Patil', 'urgent',
        'Replace failed platform display power supplies', ${userId}
      )
      returning id
    `;
    if (!maintenanceRequest)
      throw new Error('seed maintenance request returned no row');
    const [maintenanceLine] = await tx<{ id: string }[]>`
      insert into maintenance_request_lines (
        organisation_id, maintenance_request_id, production_item_id,
        description, unit, quantity, expected_return_quantity, position
      )
      values (
        ${organisationId}, ${maintenanceRequest.id}, ${component.id},
        '24V industrial SMPS', 'Nos', 2, 2, 1
      )
      returning id
    `;
    if (!maintenanceLine) throw new Error('seed maintenance line returned no row');
    // Approved AFTER its lines exist, because that is the order the
    // lifecycle runs in and the line-insert guard enforces it: a request
    // that is already approved takes no further material.
    await tx`
      update maintenance_requests
      set status = 'approved',
          approval_comment = 'Approved against available maintenance stock',
          approved_by_user_id = ${userId}, approved_at = now()
      where id = ${maintenanceRequest.id}
    `;
    await tx`
      insert into maintenance_dispatch_counters (organisation_id, work_id, next_value)
      values (${organisationId}, ${work.id}, 2)
    `;
    const [maintenanceDispatch] = await tx<{ id: string }[]>`
      insert into maintenance_dispatches (
        organisation_id, maintenance_request_id, work_id, challan_number,
        sequence_number, dispatch_date, stock_location, receiver_name,
        created_by_user_id
      )
      values (
        ${organisationId}, ${maintenanceRequest.id}, ${work.id},
        ${`${workCode}/MNT/001`}, 1,
        -- The dispatch guard refuses a date after the organisation's own
        -- today, so the seed dates it in the past.
        current_date - 1, 'Central store', 'Site supervisor', ${userId}
      )
      returning id
    `;
    if (!maintenanceDispatch) {
      throw new Error('seed maintenance dispatch returned no row');
    }
    await tx`
      insert into maintenance_dispatch_lines (
        organisation_id, maintenance_dispatch_id, maintenance_request_line_id,
        quantity
      )
      values (
        ${organisationId}, ${maintenanceDispatch.id}, ${maintenanceLine.id}, 2
      )
    `;
    await tx`
      insert into maintenance_returns (
        organisation_id, maintenance_request_id, maintenance_request_line_id,
        quantity, received_on, condition_note, repair_disposition, received_by,
        created_by_user_id
      )
      values (
        ${organisationId}, ${maintenanceRequest.id}, ${maintenanceLine.id}, 1,
        current_date - 1, 'Burnt output stage', 'Bench repair',
        'Store clerk', ${userId}
      )
      returning id
    `;

    return {
      workId: work.id,
      scheduleId: schedule.id,
      workItemId: workItem.id,
      challanId: challan.id,
      auditEventId: auditEvent.id,
    };
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-db-integration-admin',
  });

  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for integration tests. Start it with ' +
        '`docker compose up -d postgres` (or point DATABASE_ADMIN_URL and ' +
        `DATABASE_URL at a running instance). Underlying error: ${String(error)}`,
    );
  }

  // The docker-compose init script creates the application role on first
  // boot; CI service containers and bare instances do not run it, so the
  // suite converges the roles itself before migrating (race-safe: sibling
  // suites and packages bootstrap the same cluster-level roles in
  // parallel).
  await ensureClusterRoles(admin, appPassword);

  await runMigrations(admin, migrationsDirectory);

  app = createDatabasePool({
    url: appUrl,
    max: 5,
    applicationName: 'auto-mb-db-integration-app',
  });

  // Remove residue from earlier runs, children first (admin bypasses RLS).
  // The fixed fixture UUIDs make the suite deterministic and self-cleaning,
  // at the documented cost that two invocations must not run concurrently
  // against the same database.
  await removeSeedResidue();

  graphA = await seedTenantGraph(
    organisationA.id,
    organisationA.name,
    'integration-org-a',
    userA,
    'INT-A-1',
    'a',
  );
  graphB = await seedTenantGraph(
    organisationB.id,
    organisationB.name,
    'integration-org-b',
    userB,
    'INT-B-1',
    'b',
  );
});

afterAll(async () => {
  try {
    // beforeAll may have failed before the admin pool existed.
    if ((admin as Sql | undefined) !== undefined) await removeSeedResidue();
  } finally {
    await app?.end();
    await admin?.end();
  }
});

describe('application role security posture', () => {
  it('is not superuser and cannot bypass RLS', async () => {
    const [role] = await app<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('does not own any tenant table', async () => {
    const rows = await admin<{ tablename: string; tableowner: string }[]>`
      select tablename, tableowner from pg_tables
      where schemaname = 'public' and tablename = any(${admin.array([...TENANT_TABLES])})
      order by tablename
    `;
    expect(rows.map((row) => row.tablename).sort()).toEqual([...TENANT_TABLES].sort());
    for (const row of rows) {
      expect(row.tableowner).not.toBe('auto_mb_app');
    }
  });

  it('has RLS enabled and forced on every public table except the ledger, live in the catalog', async () => {
    const rows = await admin<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relnamespace = 'public'::regnamespace
        and relkind = 'r'
        and relname <> 'schema_migrations'
      order by relname
    `;
    expect(rows.length).toBeGreaterThanOrEqual(TENANT_TABLES.length);
    for (const table of TENANT_TABLES) {
      expect(rows.map((row) => row.relname)).toContain(table);
    }
    for (const row of rows) {
      expect(row, row.relname).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    }
  });

  it('covers every organisation-scoped table in the database with this suite', async () => {
    // If a new table with an organisation_id column lands without being
    // added to TENANT_TABLES, this fails instead of silently narrowing the
    // proofs below. Restricted to BASE TABLES: the consignee_masters
    // compatibility VIEW (0028) also exposes organisation_id, but a view
    // has no RLS of its own â€” with security_invoker the base table's
    // policy applies, and that base table (contacts) is in the list.
    const rows = await admin<{ table_name: string }[]>`
      select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'organisation_id'
        and t.table_type = 'BASE TABLE'
      order by c.table_name
    `;
    const expected = TENANT_TABLES.filter((table) => table !== 'organisations');
    const found = rows
      .map((row) => row.table_name)
      .filter((table) => !NOT_TENANT_SCOPED.has(table));
    expect(found.sort()).toEqual([...expected].sort());
  });

  it('keeps the consignee_masters compatibility view invoker-scoped over contacts', async () => {
    // The 0028 view must stay security_invoker (the caller's own RLS and
    // grants apply underneath) â€” a definer view would read contacts with
    // the view owner's privileges and could leak across tenants.
    const [view] = await admin<{ options: string[] | null }[]>`
      select reloptions as options from pg_class
      where relname = 'consignee_masters' and relkind = 'v'
    `;
    expect(view).toBeDefined();
    expect(view?.options ?? []).toContain('security_invoker=true');

    // Behavioural proof: the view answers nothing without a bound tenant
    // and only the caller's rows with one â€” the contacts policy applied
    // through the view.
    const bare = (await app.unsafe(
      `select count(*)::int as count from consignee_masters`,
    )) as unknown as { count: number }[];
    expect(bare[0]?.count).toBe(0);

    await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const rows = await tx<{ organisation_id: string }[]>`
          select organisation_id from consignee_masters
        `;
        expect(rows.length).toBeGreaterThanOrEqual(1);
        for (const row of rows) {
          expect(row.organisation_id).toBe(organisationA.id);
        }
      },
    );
  });
});

describe('no-context behaviour on every tenant table', () => {
  it('returns zero rows from every tenant table without organisation context', async () => {
    for (const table of TENANT_TABLES) {
      // The data exists (verified through the admin connection)â€¦
      const adminVisible =
        (await countAs(admin, table, organisationA.id)) +
        (await countAs(admin, table, organisationB.id));
      expect(adminVisible, `${table} seed data`).toBeGreaterThanOrEqual(2);

      // â€¦but the application role sees none of it without tenant context.
      const rows = (await app.unsafe(
        `select count(*)::int as count from ${table}`,
      )) as unknown as { count: number }[];
      expect(rows[0]?.count, table).toBe(0);
    }
  });
});

describe('cross-tenant isolation on every tenant table', () => {
  it('hides Organisation B rows from Organisation A reads on every tenant table', async () => {
    await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        for (const table of TENANT_TABLES) {
          expect(
            await countAs(tx as unknown as Sql, table, organisationA.id),
            `${table} own rows`,
          ).toBeGreaterThanOrEqual(1);
          expect(
            await countAs(tx as unknown as Sql, table, organisationB.id),
            `${table} foreign rows`,
          ).toBe(0);
        }

        const works = await tx<{ id: string }[]>`select id from works`;
        expect(works.map((row) => row.id)).toEqual([graphA.workId]);
      },
    );
  });

  it('makes Organisation B rows unreachable for Organisation A updates and deletes', async () => {
    await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        for (const table of GENERIC_UPDATE_TABLES) {
          const column = organisationColumn(table);
          const updated = await tx.unsafe(
            `update ${table} set ${column} = ${column} where ${column} = $1`,
            [organisationB.id],
          );
          expect(updated.count, `${table} update`).toBe(0);
        }

        for (const table of DELETE_ALLOWED_TABLES) {
          const column = organisationColumn(table);
          const deleted = await tx.unsafe(`delete from ${table} where ${column} = $1`, [
            organisationB.id,
          ]);
          expect(deleted.count, `${table} delete`).toBe(0);
        }
      },
    );

    const [untouched] = await admin<
      { title: string }[]
    >`select title from works where id = ${graphB.workId}`;
    expect(untouched?.title).toBe('Integration test work for tenant isolation');
    expect(await countAs(admin, 'delivery_challan_items', organisationB.id)).toBe(1);
  });

  it('refuses DELETE outright on reservation-anchor tables, even inside the own tenant', async () => {
    for (const table of DELETE_REVOKED_TABLES) {
      const column = organisationColumn(table);
      await expect(
        withTenant(app, { organisationId: organisationA.id, userId: userA }, (tx) =>
          tx.unsafe(`delete from ${table} where ${column} = $1`, [organisationA.id]),
        ),
        `${table} delete`,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('maintains updated_at on modification through the touch trigger', async () => {
    const before = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const [row] = await tx<{ updated_at: string }[]>`
          select updated_at from works where id = ${graphA.workId}
        `;
        await tx`
          update works set title = 'Integration test work for tenant isolation'
          where id = ${graphA.workId}
        `;
        return row?.updated_at;
      },
    );

    const [after] = await admin<{ newer: boolean }[]>`
      select updated_at > ${before ?? null}::timestamptz as newer
      from works where id = ${graphA.workId}
    `;
    expect(after?.newer).toBe(true);
  });

  it('rejects writing rows stamped with another organisation id', async () => {
    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userA },
        async (tx) => {
          await tx`
          insert into works (
            organisation_id, work_code, letter_number, letter_date, title,
            advertised_value, contract_value, pricing_shape, created_by_user_id
          )
          values (
            ${organisationB.id}, 'INT-A-EVIL', 'LOA/INT-A-EVIL', '2026-01-15',
            'Attempted cross-tenant insert', '1.00', '1.00', 'per_schedule', ${userA}
          )
        `;
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userA },
        async (tx) => {
          await tx`
            insert into audit_events (organisation_id, action, entity_type)
            values (${organisationB.id}, 'integration.evil', 'works')
          `;
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('statutory document delete guards', () => {
  it('allows pristine drafts but rejects issued or provider-touched records through the app role', async () => {
    const pristineDraftId = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const [buyer] = await tx<{ id: string }[]>`
          select id from contacts order by created_at, id limit 1
        `;
        if (!buyer) throw new Error('seed buyer missing');
        const [draft] = await tx<{ id: string }[]>`
          insert into tax_invoices (
            organisation_id, invoice_date, sac_code, service_description,
            gst_rate, place_of_supply, reverse_charge_applicable,
            stated_taxable_value, buyer_contact_id, created_by_user_id
          )
          values (
            ${organisationA.id}, '2026-02-08', '998734',
            'Pristine direct draft for delete proof', '18.00', '27', false,
            '100.00', ${buyer.id}, ${userA}
          )
          returning id
        `;
        if (!draft) throw new Error('draft insert returned no row');
        const deleted = await tx`delete from tax_invoices where id = ${draft.id}`;
        expect(deleted.count).toBe(1);
        return draft.id;
      },
    );
    const [gone] = await admin<{ id: string }[]>`
      select id from tax_invoices where id = ${pristineDraftId}
    `;
    expect(gone).toBeUndefined();

    const touchedDraftId = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const [buyer] = await tx<{ id: string }[]>`
          select id from contacts order by created_at, id limit 1
        `;
        if (!buyer) throw new Error('seed buyer missing');
        const [draft] = await tx<{ id: string }[]>`
          insert into tax_invoices (
            organisation_id, invoice_date, sac_code, service_description,
            gst_rate, place_of_supply, reverse_charge_applicable,
            stated_taxable_value, buyer_contact_id, created_by_user_id
          )
          values (
            ${organisationA.id}, '2026-02-08', '998734',
            'Provider-touched direct draft for delete proof', '18.00', '27',
            false, '100.00', ${buyer.id}, ${userA}
          )
          returning id
        `;
        if (!draft) throw new Error('touched draft insert returned no row');
        await tx`
          insert into statutory_provider_operations (
            organisation_id, tax_invoice_id, provider, environment,
            operation, status, request_sha256, provider_code,
            created_by_user_id, completed_at
          )
          values (
            ${organisationA.id}, ${draft.id}, 'whitebooks', 'sandbox',
            'register_irp', 'failed', ${'d'.repeat(64)}, 'TEST_FAILURE',
            ${userA}, now()
          )
        `;
        return draft.id;
      },
    );
    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userA },
        (tx) => tx`delete from tax_invoices where id = ${touchedDraftId}`,
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const { invoiceId, pristineEwayBillId } = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const [invoice] = await tx<{ id: string }[]>`
          select id from tax_invoices where status = 'submitted'
          order by created_at, id limit 1
        `;
        if (!invoice) throw new Error('seed submitted invoice missing');
        const [ewayBill] = await tx<{ id: string }[]>`
          select id from eway_bills where tax_invoice_id = ${invoice.id}
        `;
        if (!ewayBill) throw new Error('seed pristine e-way bill missing');
        const deleted = await tx`delete from eway_bills where id = ${ewayBill.id}`;
        expect(deleted.count).toBe(1);
        return { invoiceId: invoice.id, pristineEwayBillId: ewayBill.id };
      },
    );
    expect(pristineEwayBillId).toBeDefined();

    const touchedEwayBillId = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const [ewayBill] = await tx<{ id: string }[]>`
          insert into eway_bills (
            organisation_id, tax_invoice_id, distance_km, from_pincode,
            to_pincode, created_by_user_id
          )
          values (
            ${organisationA.id}, ${invoiceId}, 120, '422010', '400001', ${userA}
          )
          returning id
        `;
        if (!ewayBill) throw new Error('replacement e-way bill missing');
        await tx`
          insert into statutory_provider_operations (
            organisation_id, eway_bill_id, provider, environment,
            operation, status, request_sha256, provider_code,
            created_by_user_id, completed_at
          )
          values (
            ${organisationA.id}, ${ewayBill.id}, 'whitebooks', 'sandbox',
            'generate_eway_bill', 'failed', ${'e'.repeat(64)}, 'TEST_FAILURE',
            ${userA}, now()
          )
        `;
        return ewayBill.id;
      },
    );
    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userA },
        (tx) => tx`delete from eway_bills where id = ${touchedEwayBillId}`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userA },
        (tx) => tx`delete from tax_invoices where id = ${invoiceId}`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

/**
 * The floor is `app_private.current_organisation_id()`, which every policy
 * calls and which proves an ACTIVE membership on the definer's authority.
 *
 * Since migration 0069 `withTenant` also proves the binding before the
 * transaction runs anything, so a non-member binding no longer reaches the
 * policies at all. That is a semantics improvement, not the floor â€” and
 * the difference matters enough that both are asserted here.
 * `bindDirectly` writes the two GUCs the way `tenant.ts` did before 0069,
 * which is what any future code path that skipped `bind_tenant` would do;
 * the assertions after it are the floor holding on its own.
 */
async function bindDirectly<T>(
  organisationId: string,
  userId: string,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return bindTenantGucsDirectly(app, organisationId, userId, work);
}

describe('membership floor', () => {
  it('binds an active member through the raw GUCs, so the negative cases mean something', async () => {
    // The positive control for `bindDirectly` itself. Every assertion
    // below reads "nothing is visible" through this same path, and a
    // coordinated rename of the two GUCs would make all of them
    // vacuously true â€” an unbound transaction also sees nothing. This
    // case fails in exactly that scenario, so the negatives keep their
    // meaning.
    await bindDirectly(organisationA.id, userA, async (tx) => {
      const [bound] = await tx<{ organisation_id: string | null }[]>`
        select app_private.current_organisation_id() as organisation_id
      `;
      expect(bound?.organisation_id).toBe(organisationA.id);
      const works = await tx<{ id: string }[]>`select id from works`;
      expect(works.map((row) => row.id)).toEqual([graphA.workId]);
    });
  });

  it('refuses the binding outright for a non-member, before any statement runs', async () => {
    // The bind-refusal contract, asserted once and here: the typed error
    // `@auto-mb/db` raises, Auto-MB's own SQLSTATE underneath it, and that
    // the callback never ran. The SQLSTATE is deliberately NOT 28000 â€”
    // that is PostgreSQL's own invalid_authorization_specification, which
    // a pg_hba or LOGIN failure raises, and a caller mapping it to
    // "not a member" would report an authentication outage as a fleet of
    // permission refusals.
    let statementsRan = 0;
    const outcome = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userB },
      async (tx) => {
        statementsRan += 1;
        return tx`select 1 as unreachable`;
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(TenantBindRefusedError);
    expect((outcome as TenantBindRefusedError).organisationId).toBe(organisationA.id);
    expect(
      ((outcome as TenantBindRefusedError).cause as { code?: string } | undefined)
        ?.code,
    ).toBe(TENANT_BIND_REFUSED_SQLSTATE);
    expect(statementsRan).toBe(0);
  });

  it('lets a genuine driver failure keep its own shape', async () => {
    // The other half of the discrimination: only the bind statement is
    // wrapped and only Auto-MB's SQLSTATE is converted, so an error the
    // callback itself raises â€” including one carrying a PostgreSQL class
    // 28 code â€” is never relabelled a membership decision.
    const outcome = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      (tx) => tx`
        do $$ begin
          raise exception 'simulated connection authorisation failure'
            using errcode = '28000';
        end $$
      `,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).not.toBeInstanceOf(TenantBindRefusedError);
    expect(outcome).toMatchObject({ code: '28000' });
  });

  it('does not bind tenant context for a non-member, even with a valid organisation id', async () => {
    // userB is not a member of organisation A: every read is empty and
    // every write is denied, no matter what the handler stamped â€” and this
    // holds with the GUCs written directly, without bind_tenant's help.
    await bindDirectly(organisationA.id, userB, async (tx) => {
      const [bound] = await tx<{ organisation_id: string | null }[]>`
        select app_private.current_organisation_id() as organisation_id
      `;
      expect(bound?.organisation_id).toBeNull();

      for (const table of TENANT_TABLES) {
        expect(
          await countAs(tx as unknown as Sql, table, organisationA.id),
          table,
        ).toBe(0);
      }
    });

    await expect(
      bindDirectly(
        organisationA.id,
        userB,
        (tx) => tx`
          insert into audit_events (organisation_id, action, entity_type)
          values (${organisationA.id}, 'integration.floor-breach', 'works')
        `,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('does not bind tenant context for a disabled membership', async () => {
    await admin`
      update organisation_memberships set status = 'disabled'
      where organisation_id = ${organisationB.id} and user_id = ${userB}
    `;
    try {
      // Disabling the membership is enough to fail the bind â€¦
      await expect(
        withTenant(
          app,
          { organisationId: organisationB.id, userId: userB },
          (tx) => tx`select 1`,
        ),
      ).rejects.toBeInstanceOf(TenantBindRefusedError);
      // â€¦ and enough for the policies to deny on their own if something
      // wrote the GUCs without asking.
      await bindDirectly(organisationB.id, userB, async (tx) => {
        const works = await tx`select id from works`;
        expect(works).toHaveLength(0);
      });
    } finally {
      await admin`
        update organisation_memberships set status = 'active'
        where organisation_id = ${organisationB.id} and user_id = ${userB}
      `;
    }
  });

  it('refuses organisation bootstrap without a user context', async () => {
    await expect(
      app.begin(
        (tx) => tx`
        select app_private.create_organisation_with_owner('No User Org', 'no-user-org')
      `,
      ),
    ).rejects.toMatchObject({ code: '28000' });
  });

  it('lets a member list their organisations before selecting one', async () => {
    const organisations = await withUserContext(
      app,
      userA,
      (tx) =>
        tx<{ id: string; name: string }[]>`
          select id, name from organisations order by id
        `,
    );
    expect(organisations).toEqual([{ id: organisationA.id, name: organisationA.name }]);
  });
});

describe('membership listing before organisation selection', () => {
  it('lets a user see only their own memberships with no organisation context', async () => {
    const memberships = await withUserContext(
      app,
      userB,
      (tx) =>
        tx<{ organisation_id: string; user_id: string }[]>`
        select organisation_id, user_id from organisation_memberships
      `,
    );
    expect(memberships).toEqual([
      { organisation_id: organisationB.id, user_id: userB },
    ]);
  });
});

describe('audit trail append-only guarantee', () => {
  it('accepts inserts but refuses update, delete, and truncate from the application role', async () => {
    const eventId = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const [event] = await tx<{ id: string }[]>`
          insert into audit_events (organisation_id, actor_user_id, action, entity_type, entity_id)
          values (${organisationA.id}, ${userA}, 'integration.test', 'works', ${graphA.workId})
          returning id
        `;
        if (!event) throw new Error('audit insert returned no row');
        return event.id;
      },
    );

    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userA },
        async (tx) => {
          await tx`update audit_events set action = 'integration.tampered' where id = ${eventId}`;
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userA },
        async (tx) => {
          await tx`delete from audit_events where id = ${eventId}`;
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Wrapped in a transaction that always throws: if the TRUNCATE revoke
    // ever regresses, the data is rolled back and the test fails on the
    // wrong rejection instead of destroying the shared audit table.
    await expect(
      app.begin(async (tx) => {
        await tx.unsafe('truncate audit_events');
        throw new Error('truncate unexpectedly succeeded');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('withTenantSnapshot', () => {
  /** Inserts a Work into Organisation A from a SEPARATE connection and
   * commits, so an already-open transaction can be tested against it. */
  async function commitConcurrentWork(workCode: string): Promise<string> {
    return withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const [work] = await tx<{ id: string }[]>`
          insert into works (
            organisation_id, work_code, letter_number, letter_date, title,
            advertised_value, contract_value, pricing_shape, created_by_user_id
          )
          values (
            ${organisationA.id}, ${workCode}, ${`LOA/${workCode}`}, '2026-01-15',
            'Concurrent writer probe', '100000.00', '95000.00', 'per_schedule',
            ${userA}
          )
          returning id
        `;
        if (!work) throw new Error('concurrent work insert returned no row');
        return work.id;
      },
    );
  }

  async function countWorks(tx: TransactionSql): Promise<number> {
    const rows = await tx<{ count: number }[]>`
      select count(*)::int as count from works
      where organisation_id = ${organisationA.id}
    `;
    return rows[0]?.count ?? 0;
  }

  const created: string[] = [];
  afterAll(async () => {
    if (created.length > 0) {
      await admin`delete from works where id = any(${created}::uuid[])`;
    }
  });

  it('reads one snapshot for the whole transaction', async () => {
    const workCode = `SNAP-${Date.now().toString(36).toUpperCase()}`;
    const { before, after } = await withTenantSnapshot(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const before = await countWorks(tx);
        created.push(await commitConcurrentWork(workCode));
        return { before, after: await countWorks(tx) };
      },
    );
    // The writer committed between the two reads and is still invisible:
    // this is the property the organisation export depends on.
    expect(after).toBe(before);
  });

  it('differs from withTenant, which sees the concurrent commit', async () => {
    // The control. Without it the test above would also pass against a
    // database that simply had no concurrent writer.
    const workCode = `RC-${Date.now().toString(36).toUpperCase()}`;
    const { before, after } = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const before = await countWorks(tx);
        created.push(await commitConcurrentWork(workCode));
        return { before, after: await countWorks(tx) };
      },
    );
    expect(after).toBe(before + 1);
  });

  it('runs at repeatable read and stays read-write', async () => {
    const isolation = await withTenantSnapshot(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        // A write proves the transaction is not READ ONLY: the export
        // records its own audit event inside this transaction.
        await tx`
          insert into audit_events (
            organisation_id, actor_user_id, action, entity_type, entity_id
          )
          values (
            ${organisationA.id}, ${userA}, 'integration.snapshot', 'works',
            ${graphA.workId}
          )
        `;
        const rows = await tx<{ level: string }[]>`
          select current_setting('transaction_isolation') as level
        `;
        return rows[0]?.level ?? '';
      },
    );
    expect(isolation).toBe('repeatable read');
  });

  it('keeps the tenant binding transaction-local, exactly like withTenant', async () => {
    // The security property. Both GUCs are set with is_local = true, so
    // they die with the transaction instead of riding the pooled
    // connection into the next borrower's work. The pool is forced to one
    // connection so the follow-up read is guaranteed to land on the same
    // backend the snapshot transaction used.
    const single = createDatabasePool({
      url: appUrl,
      max: 1,
      applicationName: 'auto-mb-db-integration-snapshot-local',
    });
    try {
      const bound = await withTenantSnapshot(
        single,
        { organisationId: organisationA.id, userId: userA },
        async (tx) => {
          const rows = await tx<{ organisation_id: string | null }[]>`
            select app_private.current_organisation_id() as organisation_id
          `;
          return rows[0]?.organisation_id ?? null;
        },
      );
      expect(bound).toBe(organisationA.id);

      const [leaked] = await single<
        { organisation: string; user: string; visible: number }[]
      >`
        select current_setting('app.organisation_id', true) as organisation,
               current_setting('app.user_id', true) as "user",
               (select count(*)::int from works) as visible
      `;
      expect(leaked?.organisation ?? '').toBe('');
      expect(leaked?.user ?? '').toBe('');
      // And with no binding, RLS shows nothing at all.
      expect(leaked?.visible).toBe(0);
    } finally {
      await single.end();
    }
  });
});
