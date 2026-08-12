import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organisationA, organisationB } from './fixtures.js';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';
import { withTenant, withUserContext } from '../src/tenant.js';

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
  'extension_requests',
  'extension_request_counters',
  'approval_requests',
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
  // The procurement wave and the tax facts that ride with it (0033).
  'purchase_orders',
  'purchase_order_lines',
  'purchase_order_counters',
  'budgetary_quotations',
  'budgetary_quotation_lines',
  'budgetary_quotation_counters',
  // The GST tax invoice and the e-way bill that moves it (0035).
  'tax_invoices',
  'tax_invoice_renders',
  'tax_invoice_counters',
  'eway_bills',
  'statutory_provider_operations',
  // Number formats the organisation defines for itself (0039).
  'document_number_series',
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
    // Merge provenance is append-only operational evidence (0045).
    table !== 'measurement_book_merge_provenance',
);

/** Tables where 0003 revoked DELETE outright (reservation anchors and
 * numbering state): a delete attempt raises 42501 rather than matching
 * zero rows. */
const DELETE_REVOKED_TABLES = [
  'organisations',
  'works',
  'work_items',
  'loa_documents',
  'delivery_challan_counters',
  'issue_challan_counters',
  'challan_receipts',
  'work_instruments',
  'bill_counters',
  'bills',
  'mb_entries',
  // Masters retire via the active flag; the app role holds no DELETE
  // (0013; contacts follows in 0028).
  'contacts',
  'location_masters',
  'unit_masters',
  'organisation_signatories',
  'extension_request_counters',
  'approval_requests',
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
  // Cutover provenance is an append-only ledger (0025).
  'import_batches',
  'import_records',
  // Numbering state for the procurement documents (0033).
  'purchase_order_counters',
  'budgetary_quotation_counters',
  // Invoice numbering is a GST rule-46 serial; the invoice itself
  // cancels, never deletes, once submitted (0035).
  'tax_invoice_counters',
] as const satisfies readonly TenantTable[];

/** Tables the application role may still DELETE (drafts, lines,
 * memberships, schedules): cross-tenant deletes match zero rows. */
const DELETE_ALLOWED_TABLES = [
  // Restoring a document's default number format DELETES the row that
  // overrode it â€” configuration, cleared in place (0039).
  'document_number_series',
  // A draft invoice or e-way bill may be discarded; anything submitted or
  // generated cancels instead (0035).
  'tax_invoices',
  'eway_bills',
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

/** Deletes both fixture organisations' rows, children first. */
async function removeSeedResidue(): Promise<void> {
  const organisationIds = [organisationA.id, organisationB.id];
  // Fixture cleanup as superuser: the bill/MB immutability triggers
  // (rightly) block ordinary deletes.
  await admin.unsafe(`set session_replication_role = 'replica'`);
  try {
    for (const table of [...TENANT_TABLES].reverse()) {
      await admin.unsafe(
        `delete from ${table} where ${organisationColumn(table)} = any($1::uuid[])`,
        [organisationIds],
      );
    }
  } finally {
    await admin.unsafe(`set session_replication_role = 'origin'`);
  }
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
  return withTenant(app, { organisationId, userId }, async (tx) => {
    // The bootstrap function is the only path that can create an
    // organisation under the membership floor: it atomically creates the
    // organisation, the owner membership, and the audit event.
    await tx`
      select app_private.create_organisation_with_owner(${name}, ${slug}, ${organisationId})
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

    await tx`
      insert into loa_documents (
        organisation_id, object_key, original_filename, sha256,
        media_type, size_bytes, uploaded_by_user_id
      )
      values (
        ${organisationId}, ${`${organisationId}/loa/${workCode}.pdf`}, ${`${workCode}.pdf`},
        ${shaFill.repeat(64)}, 'application/pdf', 1024, ${userId}
      )
    `;

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
      values (${organisationId}, ${work.idïÍ½¶‰Ëkºwµçd¹Ñ½	•É•…Ñ•ÉQ¡…¹=ÉÅÕ…° È¤ì((€€€€€€¼¼ƒŠ™‰ÕĞÑ¡”…ÁÁ±¥…Ñ¥½¸É½±”Í••Ì¹½¹”½˜¥Ğİ¥Ñ¡½ÕĞÑ•¹…¹Ğ½¹Ñ•áĞ¸(€€€€€½¹ÍĞÉ½İÌ€ô€¡…İ…¥Ğ…ÁÀ¹Õ¹Í…™” (€€€€€€€Í•±•Ğ½Õ¹Ğ ¨¤èé¥¹Ğ…Ì½Õ¹Ğ™É½´€‘íÑ…‰±•õ€°(€€€€€€¤¤…ÌÕ¹­¹½İ¸…Ìì½Õ¹Ğè¹Õµ‰•Èõmtì(€€€€€•áÁ•Ğ¡É½İÍlÁtü¹½Õ¹Ğ°Ñ…‰±”¤¹Ñ½	” À¤ì(€€€ô(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” É½ÍÌµÑ•¹…¹Ğ¥Í½±…Ñ¥½¸½¸•Ù•ÉäÑ•¹…¹ĞÑ…‰±”œ°€ ¤€ôøì(€¥Ğ ¡¥‘•Ì=É…¹¥Í…Ñ¥½¸É½İÌ™É½´=É…¹¥Í…Ñ¥½¸É•…‘Ì½¸•Ù•ÉäÑ•¹…¹ĞÑ…‰±”œ°…Íå¹Œ€ ¤€ôøì(€€€…İ…¥Ğİ¥Ñ¡Q•¹…¹Ğ (€€€€€…ÁÀ°(€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€™½È€¡½¹ÍĞÑ…‰±”½˜Q99Q}Q	1L¤ì(€€€€€€€€€•áÁ•Ğ (€€€€€€€€€€€…İ…¥Ğ½Õ¹ÑÌ¡Ñà…ÌÕ¹­¹½İ¸…ÌMÅ°°Ñ…‰±”°½É…¹¥Í…Ñ¥½¹¹¥¤°(€€€€€€€€€€€€‘íÑ…‰±•ô½İ¸É½İÍ€°(€€€€€€€€€€¤¹Ñ½	•É•…Ñ•ÉQ¡…¹=ÉÅÕ…° Ä¤ì(€€€€€€€€€•áÁ•Ğ (€€€€€€€€€€€…İ…¥Ğ½Õ¹ÑÌ¡Ñà…ÌÕ¹­¹½İ¸…ÌMÅ°°Ñ…‰±”°½É…¹¥Í…Ñ¥½¹¹¥¤°(€€€€€€€€€€€€‘íÑ…‰±•ô™½É•¥¸É½İÍ€°(€€€€€€€€€€¤¹Ñ½	” À¤ì(€€€€€€€ô((€€€€€€€½¹ÍĞİ½É­Ì€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtùÍ•±•Ğ¥™É½´İ½É­Í€ì(€€€€€€€•áÁ•Ğ¡İ½É­Ì¹µ…À ¡É½Ü¤€ôøÉ½Ü¹¥¤¤¹Ñ½ÅÕ…°¡mÉ…Á¡¹İ½É­%‘t¤ì(€€€€€ô°(€€€€¤ì(€ô¤ì((€¥Ğ µ…­•Ì=É…¹¥Í…Ñ¥½¸É½İÌÕ¹É•…¡…‰±”™½È=É…¹¥Í…Ñ¥½¸ÕÁ‘…Ñ•Ì…¹‘•±•Ñ•Ìœ°…Íå¹Œ€ ¤€ôøì(€€€…İ…¥Ğİ¥Ñ¡Q•¹…¹Ğ (€€€€€…ÁÀ°(€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€™½È€¡½¹ÍĞÑ…‰±”½˜9I%}UAQ}Q	1L¤ì(€€€€€€€€€½¹ÍĞ½±Õµ¸€ô½É…¹¥Í…Ñ¥½¹½±Õµ¸¡Ñ…‰±”¤ì(€€€€€€€€€½¹ÍĞÕÁ‘…Ñ•€ô…İ…¥ĞÑà¹Õ¹Í…™” (€€€€€€€€€€€ÕÁ‘…Ñ”€‘íÑ…‰±•ôÍ•Ğ€‘í½±Õµ¹ô€ô€‘í½±Õµ¹ôİ¡•É”€‘í½±Õµ¹ô€ô€Å€°(€€€€€€€€€€€m½É…¹¥Í…Ñ¥½¹¹¥‘t°(€€€€€€€€€€¤ì(€€€€€€€€€•áÁ•Ğ¡ÕÁ‘…Ñ•¹½Õ¹Ğ°€‘íÑ…‰±•ôÕÁ‘…Ñ•€¤¹Ñ½	” À¤ì(€€€€€€€ô((€€€€€€€™½È€¡½¹ÍĞÑ…‰±”½˜1Q}11=]}Q	1L¤ì(€€€€€€€€€½¹ÍĞ½±Õµ¸€ô½É…¹¥Í…Ñ¥½¹½±Õµ¸¡Ñ…‰±”¤ì(€€€€€€€€€½¹ÍĞ‘•±•Ñ•€ô…İ…¥ĞÑà¹Õ¹Í…™”¡‘•±•Ñ”™É½´€‘íÑ…‰±•ôİ¡•É”€‘í½±Õµ¹ô€ô€Å€°l(€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹¹¥°(€€€€€€€€€t¤ì(€€€€€€€€€•áÁ•Ğ¡‘•±•Ñ•¹½Õ¹Ğ°€‘íÑ…‰±•ô‘•±•Ñ•€¤¹Ñ½	” À¤ì(€€€€€€€ô(€€€€€ô°(€€€€¤ì((€€€½¹ÍĞmÕ¹Ñ½Õ¡•‘t€ô…İ…¥Ğ…‘µ¥¸ğ(€€€€€ìÑ¥Ñ±”èÍÑÉ¥¹œõmt(€€€€ùÍ•±•ĞÑ¥Ñ±”™É½´İ½É­Ìİ¡•É”¥€ô€‘íÉ…Á¡¹İ½É­%‘õ€ì(€€€•áÁ•Ğ¡Õ¹Ñ½Õ¡•ü¹Ñ¥Ñ±”¤¹Ñ½	” %¹Ñ•É…Ñ¥½¸Ñ•ÍĞİ½É¬™½ÈÑ•¹…¹Ğ¥Í½±…Ñ¥½¸œ¤ì(€€€•áÁ•Ğ¡…İ…¥Ğ½Õ¹ÑÌ¡…‘µ¥¸°€‘•±¥Ù•Éå}¡…±±…¹}¥Ñ•µÌœ°½É…¹¥Í…Ñ¥½¹¹¥¤¤¹Ñ½	” Ä¤ì(€ô¤ì((€¥Ğ É•™ÕÍ•Ì1Q½ÕÑÉ¥¡Ğ½¸É•Í•ÉÙ…Ñ¥½¸µ…¹¡½ÈÑ…‰±•Ì°•Ù•¸¥¹Í¥‘”Ñ¡”½İ¸Ñ•¹…¹Ğœ°…Íå¹Œ€ ¤€ôøì(€€€™½È€¡½¹ÍĞÑ…‰±”½˜1Q}IY=-}Q	1L¤ì(€€€€€½¹ÍĞ½±Õµ¸€ô½É…¹¥Í…Ñ¥½¹½±Õµ¸¡Ñ…‰±”¤ì(€€€€€…İ…¥Ğ•áÁ•Ğ (€€€€€€€İ¥Ñ¡Q•¹…¹Ğ¡…ÁÀ°ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°€¡Ñà¤€ôø(€€€€€€€€€Ñà¹Õ¹Í…™”¡‘•±•Ñ”™É½´€‘íÑ…‰±•ôİ¡•É”€‘í½±Õµ¹ô€ô€Å€°m½É…¹¥Í…Ñ¥½¹¹¥‘t¤°(€€€€€€€€¤°(€€€€€€€€‘íÑ…‰±•ô‘•±•Ñ•€°(€€€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€œĞÈÔÀÄœô¤ì(€€€ô(€ô¤ì((€¥Ğ µ…¥¹Ñ…¥¹ÌÕÁ‘…Ñ•‘}…Ğ½¸µ½‘¥™¥…Ñ¥½¸Ñ¡É½Õ Ñ¡”Ñ½Õ ÑÉ¥•Èœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞ‰•™½É”€ô…İ…¥Ğİ¥Ñ¡Q•¹…¹Ğ (€€€€€…ÁÀ°(€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€½¹ÍĞmÉ½İt€ô…İ…¥ĞÑàñìÕÁ‘…Ñ•‘}…ĞèÍÑÉ¥¹œõmtù€(€€€€€€€€€Í•±•ĞÕÁ‘…Ñ•‘}…Ğ™É½´İ½É­Ìİ¡•É”¥€ô€‘íÉ…Á¡¹İ½É­%‘ô(€€€€€€€€ì(€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€ÕÁ‘…Ñ”İ½É­ÌÍ•ĞÑ¥Ñ±”€ô€%¹Ñ•É…Ñ¥½¸Ñ•ÍĞİ½É¬™½ÈÑ•¹…¹Ğ¥Í½±…Ñ¥½¸œ(€€€€€€€€€İ¡•É”¥€ô€‘íÉ…Á¡¹İ½É­%‘ô(€€€€€€€€ì(€€€€€€€É•ÑÕÉ¸É½Üü¹ÕÁ‘…Ñ•‘}…Ğì(€€€€€ô°(€€€€¤ì((€€€½¹ÍĞm…™Ñ•Ét€ô…İ…¥Ğ…‘µ¥¸ñì¹•İ•Èè‰½½±•…¸õmtù€(€€€€€Í•±•ĞÕÁ‘…Ñ•‘}…Ğ€ø€‘í‰•™½É”€üü¹Õ±±ôèéÑ¥µ•ÍÑ…µÁÑè…Ì¹•İ•È(€€€€€™É½´İ½É­Ìİ¡•É”¥€ô€‘íÉ…Á¡¹İ½É­%‘ô(€€€€ì(€€€•áÁ•Ğ¡…™Ñ•Èü¹¹•İ•È¤¹Ñ½	”¡ÑÉÕ”¤ì(€ô¤ì((€¥Ğ É•©•ÑÌİÉ¥Ñ¥¹œÉ½İÌÍÑ…µÁ•İ¥Ñ …¹½Ñ¡•È½É…¹¥Í…Ñ¥½¸¥œ°…Íå¹Œ€ ¤€ôøì(€€€…İ…¥Ğ•áÁ•Ğ (€€€€€İ¥Ñ¡Q•¹…¹Ğ (€€€€€€€…ÁÀ°(€€€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼İ½É­Ì€ (€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°İ½É­}½‘”°±•ÑÑ•É}¹Õµ‰•È°±•ÑÑ•É}‘…Ñ”°Ñ¥Ñ±”°(€€€€€€€€€€€…‘Ù•ÉÑ¥Í•‘}Ù…±Õ”°½¹ÑÉ…Ñ}Ù…±Õ”°ÁÉ¥¥¹}Í¡…Á”°É•…Ñ•‘}‰å}ÕÍ•É}¥(€€€€€€€€€€¤(€€€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹¹¥‘ô°€%9PµµY%0œ°€1=½%9PµµY%0œ°€œÈÀÈØ´ÀÄ´ÄÔœ°(€€€€€€€€€€€€ÑÑ•µÁÑ•É½ÍÌµÑ•¹…¹Ğ¥¹Í•ÉĞœ°€œÄ¸ÀÀœ°€œÄ¸ÀÀœ°€Á•É}Í¡•‘Õ±”œ°€‘íÕÍ•Éô(€€€€€€€€€€¤(€€€€€€€€ì(€€€€€€€ô°(€€€€€€¤°(€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€œĞÈÔÀÄœô¤ì((€€€…İ…¥Ğ•áÁ•Ğ (€€€€€İ¥Ñ¡Q•¹…¹Ğ (€€€€€€€…ÁÀ°(€€€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼…Õ‘¥Ñ}•Ù•¹ÑÌ€¡½É…¹¥Í…Ñ¥½¹}¥°…Ñ¥½¸°•¹Ñ¥Ñå}ÑåÁ”¤(€€€€€€€€€€€Ù…±Õ•Ì€ ‘í½É…¹¥Í…Ñ¥½¹¹¥‘ô°€¥¹Ñ•É…Ñ¥½¸¹•Ù¥°œ°€İ½É­Ìœ¤(€€€€€€€€€€ì(€€€€€€€ô°(€€€€€€¤°(€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€œĞÈÔÀÄœô¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” ÍÑ…ÑÕÑ½Éä‘½Õµ•¹Ğ‘•±•Ñ”Õ…É‘Ìœ°€ ¤€ôøì(€¥Ğ …±±½İÌÁÉ¥ÍÑ¥¹”‘É…™ÑÌ‰ÕĞÉ•©•ÑÌ¥ÍÍÕ•½ÈÁÉ½Ù¥‘•ÈµÑ½Õ¡•É•½É‘ÌÑ¡É½Õ Ñ¡”…ÁÀÉ½±”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞÁÉ¥ÍÑ¥¹•É…™Ñ%€ô…İ…¥Ğİ¥Ñ¡Q•¹…¹Ğ (€€€€€…ÁÀ°(€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€½¹ÍĞm‰Õå•Ét€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€Í•±•Ğ¥™É½´½¹Ñ…ÑÌ½É‘•È‰äÉ•…Ñ•‘}…Ğ°¥±¥µ¥Ğ€Ä(€€€€€€€€ì(€€€€€€€¥˜€ …‰Õå•È¤Ñ¡É½Ü¹•ÜÉÉ½È Í••‰Õå•Èµ¥ÍÍ¥¹œœ¤ì(€€€€€€€½¹ÍĞm‘É…™Ñt€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼Ñ…á}¥¹Ù½¥•Ì€ (€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°¥¹Ù½¥•}‘…Ñ”°Í…}½‘”°Í•ÉÙ¥•}‘•ÍÉ¥ÁÑ¥½¸°(€€€€€€€€€€€ÍÑ}É…Ñ”°Á±…•}½™}ÍÕÁÁ±ä°É•Ù•ÉÍ•}¡…É•}…ÁÁ±¥…‰±”°(€€€€€€€€€€€ÍÑ…Ñ•‘}Ñ…á…‰±•}Ù…±Õ”°‰Õå•É}½¹Ñ…Ñ}¥°É•…Ñ•‘}‰å}ÕÍ•É}¥(€€€€€€€€€€¤(€€€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹¹¥‘ô°€œÈÀÈØ´ÀÈ´Ààœ°€œääàÜÌĞœ°(€€€€€€€€€€€€AÉ¥ÍÑ¥¹”‘¥É•Ğ‘É…™Ğ™½È‘•±•Ñ”ÁÉ½½˜œ°€œÄà¸ÀÀœ°€œÈÜœ°™…±Í”°(€€€€€€€€€€€€œÄÀÀ¸ÀÀœ°€‘í‰Õå•È¹¥‘ô°€‘íÕÍ•Éô(€€€€€€€€€€¤(€€€€€€€€€É•ÑÕÉ¹¥¹œ¥(€€€€€€€€ì(€€€€€€€¥˜€ …‘É…™Ğ¤Ñ¡É½Ü¹•ÜÉÉ½È ‘É…™Ğ¥¹Í•ÉĞÉ•ÑÕÉ¹•¹¼É½Üœ¤ì(€€€€€€€½¹ÍĞ‘•±•Ñ•€ô…İ…¥ĞÑá‘•±•Ñ”™É½´Ñ…á}¥¹Ù½¥•Ìİ¡•É”¥€ô€‘í‘É…™Ğ¹¥‘õ€ì(€€€€€€€•áÁ•Ğ¡‘•±•Ñ•¹½Õ¹Ğ¤¹Ñ½	” Ä¤ì(€€€€€€€É•ÑÕÉ¸‘É…™Ğ¹¥ì(€€€€€ô°(€€€€¤ì(€€€½¹ÍĞm½¹•t€ô…İ…¥Ğ…‘µ¥¸ñì¥èÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ğ¥™É½´Ñ…á}¥¹Ù½¥•Ìİ¡•É”¥€ô€‘íÁÉ¥ÍÑ¥¹•É…™Ñ%‘ô(€€€€ì(€€€•áÁ•Ğ¡½¹”¤¹Ñ½	•U¹‘•™¥¹• ¤ì((€€€½¹ÍĞÑ½Õ¡•‘É…™Ñ%€ô…İ…¥Ğİ¥Ñ¡Q•¹…¹Ğ (€€€€€…ÁÀ°(€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€½¹ÍĞm‰Õå•Ét€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€Í•±•Ğ¥™É½´½¹Ñ…ÑÌ½É‘•È‰äÉ•…Ñ•‘}…Ğ°¥±¥µ¥Ğ€Ä(€€€€€€€€ì(€€€€€€€¥˜€ …‰Õå•È¤Ñ¡É½Ü¹•ÜÉÉ½È Í••‰Õå•Èµ¥ÍÍ¥¹œœ¤ì(€€€€€€€½¹ÍĞm‘É…™Ñt€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼Ñ…á}¥¹Ù½¥•Ì€ (€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°¥¹Ù½¥•}‘…Ñ”°Í…}½‘”°Í•ÉÙ¥•}‘•ÍÉ¥ÁÑ¥½¸°(€€€€€€€€€€€ÍÑ}É…Ñ”°Á±…•}½™}ÍÕÁÁ±ä°É•Ù•ÉÍ•}¡…É•}…ÁÁ±¥…‰±”°(€€€€€€€€€€€ÍÑ…Ñ•‘}Ñ…á…‰±•}Ù…±Õ”°‰Õå•É}½¹Ñ…Ñ}¥°É•…Ñ•‘}‰å}ÕÍ•É}¥(€€€€€€€€€€¤(€€€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹¹¥‘ô°€œÈÀÈØ´ÀÈ´Ààœ°€œääàÜÌĞœ°(€€€€€€€€€€€€AÉ½Ù¥‘•ÈµÑ½Õ¡•‘¥É•Ğ‘É…™Ğ™½È‘•±•Ñ”ÁÉ½½˜œ°€œÄà¸ÀÀœ°€œÈÜœ°(€€€€€€€€€€€™…±Í”°€œÄÀÀ¸ÀÀœ°€‘í‰Õå•È¹¥‘ô°€‘íÕÍ•Éô(€€€€€€€€€€¤(€€€€€€€€€É•ÑÕÉ¹¥¹œ¥(€€€€€€€€ì(€€€€€€€¥˜€ …‘É…™Ğ¤Ñ¡É½Ü¹•ÜÉÉ½È Ñ½Õ¡•‘É…™Ğ¥¹Í•ÉĞÉ•ÑÕÉ¹•¹¼É½Üœ¤ì(€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼ÍÑ…ÑÕÑ½Éå}ÁÉ½Ù¥‘•É}½Á•É…Ñ¥½¹Ì€ (€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°Ñ…á}¥¹Ù½¥•}¥°ÁÉ½Ù¥‘•È°•¹Ù¥É½¹µ•¹Ğ°(€€€€€€€€€€€½Á•É…Ñ¥½¸°ÍÑ…ÑÕÌ°É•ÅÕ•ÍÑ}Í¡„ÈÔØ°ÁÉ½Ù¥‘•É}½‘”°(€€€€€€€€€€€É•…Ñ•‘}‰å}ÕÍ•É}¥°½µÁ±•Ñ•‘}…Ğ(€€€€€€€€€€¤(€€€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹¹¥‘ô°€‘í‘É…™Ğ¹¥‘ô°€İ¡¥Ñ•‰½½­Ìœ°€Í…¹‘‰½àœ°(€€€€€€€€€€€€É•¥ÍÑ•É}¥ÉÀœ°€™…¥±•œ°€‘ìœ¹É•Á•…Ğ ØĞ¥ô°€QMQ}%1UIœ°(€€€€€€€€€€€€‘íÕÍ•Éô°¹½Ü ¤(€€€€€€€€€€¤(€€€€€€€€ì(€€€€€€€É•ÑÕÉ¸‘É…™Ğ¹¥ì(€€€€€ô°(€€€€¤ì(€€€…İ…¥Ğ•áÁ•Ğ (€€€€€İ¥Ñ¡Q•¹…¹Ğ (€€€€€€€…ÁÀ°(€€€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€€€€¡Ñà¤€ôøÑá‘•±•Ñ”™É½´Ñ…á}¥¹Ù½¥•Ìİ¡•É”¥€ô€‘íÑ½Õ¡•‘É…™Ñ%‘õ€°(€€€€€€¤°(€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€œÈÌÔÄĞœô¤ì((€€€½¹ÍĞì¥¹Ù½¥•%°ÁÉ¥ÍÑ¥¹•İ…å	¥±±%ô€ô…İ…¥Ğİ¥Ñ¡Q•¹…¹Ğ (€€€€€…ÁÀ°(€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€½¹ÍĞm¥¹Ù½¥•t€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€Í•±•Ğ¥™É½´Ñ…á}¥¹Ù½¥•Ìİ¡•É”ÍÑ…ÑÕÌ€ô€ÍÕ‰µ¥ÑÑ•œ(€€€€€€€€€½É‘•È‰äÉ•…Ñ•‘}…Ğ°¥±¥µ¥Ğ€Ä(€€€€€€€€ì(€€€€€€€¥˜€ …¥¹Ù½¥”¤Ñ¡É½Ü¹•ÜÉÉ½È Í••ÍÕ‰µ¥ÑÑ•¥¹Ù½¥”µ¥ÍÍ¥¹œœ¤ì(€€€€€€€½¹ÍĞm•İ…å	¥±±t€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€Í•±•Ğ¥™É½´•İ…å}‰¥±±Ìİ¡•É”Ñ…á}¥¹Ù½¥•}¥€ô€‘í¥¹Ù½¥”¹¥‘ô(€€€€€€€€ì(€€€€€€€¥˜€ …•İ…å	¥±°¤Ñ¡É½Ü¹•ÜÉÉ½È Í••ÁÉ¥ÍÑ¥¹””µİ…ä‰¥±°µ¥ÍÍ¥¹œœ¤ì(€€€€€€€½¹ÍĞ‘•±•Ñ•€ô…İ…¥ĞÑá‘•±•Ñ”™É½´•İ…å}‰¥±±Ìİ¡•É”¥€ô€‘í•İ…å	¥±°¹¥‘õ€ì(€€€€€€€•áÁ•Ğ¡‘•±•Ñ•¹½Õ¹Ğ¤¹Ñ½	” Ä¤ì(€€€€€€€É•ÑÕÉ¸ì¥¹Ù½¥•%è¥¹Ù½¥”¹¥°ÁÉ¥ÍÑ¥¹•İ…å	¥±±%è•İ…å	¥±°¹¥ôì(€€€€€ô°(€€€€¤ì(€€€•áÁ•Ğ¡ÁÉ¥ÍÑ¥¹•İ…å	¥±±%¤¹Ñ½	••™¥¹• ¤ì((€€€½¹ÍĞÑ½Õ¡•‘İ…å	¥±±%€ô…İ…¥Ğİ¥Ñ¡Q•¹…¹Ğ (€€€€€…ÁÀ°(€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€½¹ÍĞm•İ…å	¥±±t€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼•İ…å}‰¥±±Ì€ (€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°Ñ…á}¥¹Ù½¥•}¥°‘¥ÍÑ…¹•}­´°™É½µ}Á¥¹½‘”°(€€€€€€€€€€€Ñ½}Á¥¹½‘”°É•…Ñ•‘}‰å}ÕÍ•É}¥(€€€€€€€€€€¤(€€€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹¹¥‘ô°€‘í¥¹Ù½¥•%‘ô°€ÄÈÀ°€œĞÈÈÀÄÀœ°€œĞÀÀÀÀÄœ°€‘íÕÍ•Éô(€€€€€€€€€€¤(€€€€€€€€€É•ÑÕÉ¹¥¹œ¥(€€€€€€€€ì(€€€€€€€¥˜€ …•İ…å	¥±°¤Ñ¡É½Ü¹•ÜÉÉ½È É•Á±…•µ•¹Ğ”µİ…ä‰¥±°µ¥ÍÍ¥¹œœ¤ì(€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼ÍÑ…ÑÕÑ½Éå}ÁÉ½Ù¥‘•É}½Á•É…Ñ¥½¹Ì€ (€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°•İ…å}‰¥±±}¥°ÁÉ½Ù¥‘•È°•¹Ù¥É½¹µ•¹Ğ°(€€€€€€€€€€€½Á•É…Ñ¥½¸°ÍÑ…ÑÕÌ°É•ÅÕ•ÍÑ}Í¡„ÈÔØ°ÁÉ½Ù¥‘•É}½‘”°(€€€€€€€€€€€É•…Ñ•‘}‰å}ÕÍ•É}¥°½µÁ±•Ñ•‘}…Ğ(€€€€€€€€€€¤(€€€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹¹¥‘ô°€‘í•İ…å	¥±°¹¥‘ô°€İ¡¥Ñ•‰½½­Ìœ°€Í…¹‘‰½àœ°(€€€€€€€€€€€€•¹•É…Ñ•}•İ…å}‰¥±°œ°€™…¥±•œ°€‘ì”œ¹É•Á•…Ğ ØĞ¥ô°€QMQ}%1UIœ°(€€€€€€€€€€€€‘íÕÍ•Éô°¹½Ü ¤(€€€€€€€€€€¤(€€€€€€€€ì(€€€€€€€É•ÑÕÉ¸•İ…å	¥±°¹¥ì(€€€€€ô°(€€€€¤ì(€€€…İ…¥Ğ•áÁ•Ğ (€€€€€İ¥Ñ¡Q•¹…¹Ğ (€€€€€€€…ÁÀ°(€€€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€€€€¡Ñà¤€ôøÑá‘•±•Ñ”™É½´•İ…å}‰¥±±Ìİ¡•É”¥€ô€‘íÑ½Õ¡•‘İ…å	¥±±%‘õ€°(€€€€€€¤°(€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€œÈÌÔÄĞœô¤ì(€€€…İ…¥Ğ•áÁ•Ğ (€€€€€İ¥Ñ¡Q•¹…¹Ğ (€€€€€€€…ÁÀ°(€€€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€€€€¡Ñà¤€ôøÑá‘•±•Ñ”™É½´Ñ…á}¥¹Ù½¥•Ìİ¡•É”¥€ô€‘í¥¹Ù½¥•%‘õ€°(€€€€€€¤°(€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€œÈÌÔÄĞœô¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” µ•µ‰•ÉÍ¡¥À™±½½Èœ°€ ¤€ôøì(€¥Ğ ‘½•Ì¹½Ğ‰¥¹Ñ•¹…¹Ğ½¹Ñ•áĞ™½È„¹½¸µµ•µ‰•È°•Ù•¸İ¥Ñ „Ù…±¥½É…¹¥Í…Ñ¥½¸¥œ°…Íå¹Œ€ ¤€ôøì(€€€€¼¼ÕÍ•É¥Ì¹½Ğ„µ•µ‰•È½˜½É…¹¥Í…Ñ¥½¸è•Ù•ÉäÉ•…¥Ì•µÁÑä…¹(€€€€¼¼•Ù•ÉäİÉ¥Ñ”¥Ì‘•¹¥•°¹¼µ…ÑÑ•Èİ¡…ĞÑ¡”¡…¹‘±•ÈÍÑ…µÁ•¸(€€€…İ…¥Ğİ¥Ñ¡Q•¹…¹Ğ (€€€€€…ÁÀ°(€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€½¹ÍĞm‰½Õ¹‘t€ô…İ…¥ĞÑàñì½É…¹¥Í…Ñ¥½¹}¥èÍÑÉ¥¹œğ¹Õ±°õmtù€(€€€€€€€€€Í•±•Ğ…ÁÁ}ÁÉ¥Ù…Ñ”¹ÕÉÉ•¹Ñ}½É…¹¥Í…Ñ¥½¹}¥ ¤…Ì½É…¹¥Í…Ñ¥½¹}¥(€€€€€€€€ì(€€€€€€€•áÁ•Ğ¡‰½Õ¹ü¹½É…¹¥Í…Ñ¥½¹}¥¤¹Ñ½	•9Õ±° ¤ì((€€€€€€€™½È€¡½¹ÍĞÑ…‰±”½˜Q99Q}Q	1L¤ì(€€€€€€€€€•áÁ•Ğ (€€€€€€€€€€€…İ…¥Ğ½Õ¹ÑÌ¡Ñà…ÌÕ¹­¹½İ¸…ÌMÅ°°Ñ…‰±”°½É…¹¥Í…Ñ¥½¹¹¥¤°(€€€€€€€€€€€Ñ…‰±”°(€€€€€€€€€€¤¹Ñ½	” À¤ì(€€€€€€€ô(€€€€€ô°(€€€€¤ì((€€€…İ…¥Ğ•áÁ•Ğ (€€€€€İ¥Ñ¡Q•¹…¹Ğ (€€€€€€€…ÁÀ°(€€€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€€€€¡Ñà¤€ôøÑá€(€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼…Õ‘¥Ñ}•Ù•¹ÑÌ€¡½É…¹¥Í…Ñ¥½¹}¥°…Ñ¥½¸°•¹Ñ¥Ñå}ÑåÁ”¤(€€€€€€€€€Ù…±Õ•Ì€ ‘í½É…¹¥Í…Ñ¥½¹¹¥‘ô°€¥¹Ñ•É…Ñ¥½¸¹™±½½Èµ‰É•… œ°€İ½É­Ìœ¤(€€€€€€€€°(€€€€€€¤°(€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€œĞÈÔÀÄœô¤ì(€ô¤ì((€¥Ğ ‘½•Ì¹½Ğ‰¥¹Ñ•¹…¹Ğ½¹Ñ•áĞ™½È„‘¥Í…‰±•µ•µ‰•ÉÍ¡¥Àœ°…Íå¹Œ€ ¤€ôøì(€€€…İ…¥Ğ…‘µ¥¹€(€€€€€ÕÁ‘…Ñ”½É…¹¥Í…Ñ¥½¹}µ•µ‰•ÉÍ¡¥ÁÌÍ•ĞÍÑ…ÑÕÌ€ô€‘¥Í…‰±•œ(€€€€€İ¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹¹¥‘ô…¹ÕÍ•É}¥€ô€‘íÕÍ•É	ô(€€€€ì(€€€ÑÉäì(€€€€€…İ…¥Ğİ¥Ñ¡Q•¹…¹Ğ (€€€€€€€…ÁÀ°(€€€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€½¹ÍĞİ½É­Ì€ô…İ…¥ĞÑáÍ•±•Ğ¥™É½´İ½É­Í€ì(€€€€€€€€€•áÁ•Ğ¡İ½É­Ì¤¹Ñ½!…Ù•1•¹Ñ  À¤ì(€€€€€€€ô°(€€€€€€¤ì(€€€ô™¥¹…±±äì(€€€€€…İ…¥Ğ…‘µ¥¹€(€€€€€€€ÕÁ‘…Ñ”½É…¹¥Í…Ñ¥½¹}µ•µ‰•ÉÍ¡¥ÁÌÍ•ĞÍÑ…ÑÕÌ€ô€…Ñ¥Ù”œ(€€€€€€€İ¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹¹¥‘ô…¹ÕÍ•É}¥€ô€‘íÕÍ•É	ô(€€€€€€ì(€€€ô(€ô¤ì((€¥Ğ É•™ÕÍ•Ì½É…¹¥Í…Ñ¥½¸‰½½ÑÍÑÉ…Àİ¥Ñ¡½ÕĞ„ÕÍ•È½¹Ñ•áĞœ°…Íå¹Œ€ ¤€ôøì(€€€…İ…¥Ğ•áÁ•Ğ (€€€€€…ÁÀ¹‰•¥¸ (€€€€€€€€¡Ñà¤€ôøÑá€(€€€€€€€Í•±•Ğ…ÁÁ}ÁÉ¥Ù…Ñ”¹É•…Ñ•}½É…¹¥Í…Ñ¥½¹}İ¥Ñ¡}½İ¹•È 9¼UÍ•È=Éœœ°€¹¼µÕÍ•Èµ½Éœœ¤(€€€€€€°(€€€€€€¤°(€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€œÈàÀÀÀœô¤ì(€ô¤ì((€¥Ğ ±•ÑÌ„µ•µ‰•È±¥ÍĞÑ¡•¥È½É…¹¥Í…Ñ¥½¹Ì‰•™½É”Í•±•Ñ¥¹œ½¹”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞ½É…¹¥Í…Ñ¥½¹Ì€ô…İ…¥Ğİ¥Ñ¡UÍ•É½¹Ñ•áĞ (€€€€€…ÁÀ°(€€€€€ÕÍ•É°(€€€€€€¡Ñà¤€ôø(€€€€€€€Ñàñì¥èÍÑÉ¥¹œì¹…µ”èÍÑÉ¥¹œõmtù€(€€€€€€€€€Í•±•Ğ¥°¹…µ”™É½´½É…¹¥Í…Ñ¥½¹Ì½É‘•È‰ä¥(€€€€€€€€°(€€€€¤ì(€€€•áÁ•Ğ¡½É…¹¥Í…Ñ¥½¹Ì¤¹Ñ½ÅÕ…°¡mì¥è½É…¹¥Í…Ñ¥½¹¹¥°¹…µ”è½É…¹¥Í…Ñ¥½¹¹¹…µ”õt¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” µ•µ‰•ÉÍ¡¥À±¥ÍÑ¥¹œ‰•™½É”½É…¹¥Í…Ñ¥½¸Í•±•Ñ¥½¸œ°€ ¤€ôøì(€¥Ğ ±•ÑÌ„ÕÍ•ÈÍ•”½¹±äÑ¡•¥È½İ¸µ•µ‰•ÉÍ¡¥ÁÌİ¥Ñ ¹¼½É…¹¥Í…Ñ¥½¸½¹Ñ•áĞœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞµ•µ‰•ÉÍ¡¥ÁÌ€ô…İ…¥Ğİ¥Ñ¡UÍ•É½¹Ñ•áĞ (€€€€€…ÁÀ°(€€€€€ÕÍ•É°(€€€€€€¡Ñà¤€ôø(€€€€€€€Ñàñì½É…¹¥Í…Ñ¥½¹}¥èÍÑÉ¥¹œìÕÍ•É}¥èÍÑÉ¥¹œõmtù€(€€€€€€€Í•±•Ğ½É…¹¥Í…Ñ¥½¹}¥°ÕÍ•É}¥™É½´½É…¹¥Í…Ñ¥½¹}µ•µ‰•ÉÍ¡¥ÁÌ(€€€€€€°(€€€€¤ì(€€€•áÁ•Ğ¡µ•µ‰•ÉÍ¡¥ÁÌ¤¹Ñ½ÅÕ…°¡l(€€€€€ì½É…¹¥Í…Ñ¥½¹}¥è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É}¥èÕÍ•Éô°(€€€t¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” …Õ‘¥ĞÑÉ…¥°…ÁÁ•¹µ½¹±äÕ…É…¹Ñ•”œ°€ ¤€ôøì(€¥Ğ …•ÁÑÌ¥¹Í•ÉÑÌ‰ÕĞÉ•™ÕÍ•ÌÕÁ‘…Ñ”°‘•±•Ñ”°…¹ÑÉÕ¹…Ñ”™É½´Ñ¡”…ÁÁ±¥…Ñ¥½¸É½±”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞ•Ù•¹Ñ%€ô…İ…¥Ğİ¥Ñ¡Q•¹…¹Ğ (€€€€€…ÁÀ°(€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€½¹ÍĞm•Ù•¹Ñt€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼…Õ‘¥Ñ}•Ù•¹ÑÌ€¡½É…¹¥Í…Ñ¥½¹}¥°…Ñ½É}ÕÍ•É}¥°…Ñ¥½¸°•¹Ñ¥Ñå}ÑåÁ”°•¹Ñ¥Ñå}¥¤(€€€€€€€€€Ù…±Õ•Ì€ ‘í½É…¹¥Í…Ñ¥½¹¹¥‘ô°€‘íÕÍ•Éô°€¥¹Ñ•É…Ñ¥½¸¹Ñ•ÍĞœ°€İ½É­Ìœ°€‘íÉ…Á¡¹İ½É­%‘ô¤(€€€€€€€€€É•ÑÕÉ¹¥¹œ¥(€€€€€€€€ì(€€€€€€€¥˜€ …•Ù•¹Ğ¤Ñ¡É½Ü¹•ÜÉÉ½È …Õ‘¥Ğ¥¹Í•ÉĞÉ•ÑÕÉ¹•¹¼É½Üœ¤ì(€€€€€€€É•ÑÕÉ¸•Ù•¹Ğ¹¥ì(€€€€€ô°(€€€€¤ì((€€€…İ…¥Ğ•áÁ•Ğ (€€€€€İ¥Ñ¡Q•¹…¹Ğ (€€€€€€€…ÁÀ°(€€€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…İ…¥ĞÑáÕÁ‘…Ñ”…Õ‘¥Ñ}•Ù•¹ÑÌÍ•Ğ…Ñ¥½¸€ô€¥¹Ñ•É…Ñ¥½¸¹Ñ…µÁ•É•œİ¡•É”¥€ô€‘í•Ù•¹Ñ%‘õ€ì(€€€€€€€ô°(€€€€€€¤°(€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€œĞÈÔÀÄœô¤ì((€€€…İ…¥Ğ•áÁ•Ğ (€€€€€İ¥Ñ¡Q•¹…¹Ğ (€€€€€€€…ÁÀ°(€€€€€€€ì½É…¹¥Í…Ñ¥½¹%è½É…¹¥Í…Ñ¥½¹¹¥°ÕÍ•É%èÕÍ•Éô°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…İ…¥ĞÑá‘•±•Ñ”™É½´…Õ‘¥Ñ}•Ù•¹ÑÌİ¡•É”¥€ô€‘í•Ù•¹Ñ%‘õ€ì(€€€€€€€ô°(€€€€€€¤°(€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€œĞÈÔÀÄœô¤ì((€€€€¼¼]É…ÁÁ•¥¸„ÑÉ…¹Í…Ñ¥½¸Ñ¡…Ğ…±İ…åÌÑ¡É½İÌè¥˜Ñ¡”QIU9QÉ•Ù½­”(€€€€¼¼•Ù•ÈÉ•É•ÍÍ•Ì°Ñ¡”‘…Ñ„¥ÌÉ½±±•‰…¬…¹Ñ¡”Ñ•ÍĞ™…¥±Ì½¸Ñ¡”(€€€€¼¼İÉ½¹œÉ•©•Ñ¥½¸¥¹ÍÑ•…½˜‘•ÍÑÉ½å¥¹œÑ¡”Í¡…É•…Õ‘¥ĞÑ…‰±”¸(€€€…İ…¥Ğ•áÁ•Ğ (€€€€€…ÁÀ¹‰•¥¸¡…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€…İ…¥ĞÑà¹Õ¹Í…™” ÑÉÕ¹…Ñ”…Õ‘¥Ñ}•Ù•¹ÑÌœ¤ì(€€€€€€€Ñ¡É½Ü¹•ÜÉÉ½È ÑÉÕ¹…Ñ”Õ¹•áÁ•Ñ•‘±äÍÕ••‘•œ¤ì(€€€€€ô¤°(€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€œĞÈÔÀÄœô¤ì(€ô¤ì)ô¤ì(