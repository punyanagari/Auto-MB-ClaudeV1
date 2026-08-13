import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import {
  createDatabasePool,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Proofs for the 2026-08-08 integrity hardening: the bill/measurement
 * race, the cancellation-with-evidence guard, instrument status
 * transitions, measurement provenance validation, serial lineage at the
 * database level, and the extended export.
 */

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';
const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD ?? 'local-app-change-me';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(
  here,
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
);

const runId = randomBytes(5).toString('hex');
const ownerEmail = `integrity-owner-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;
let workId: string;
let workItemId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

async function authed(
  jar: CookieJar,
  options: InjectOptions & { organisationId?: string },
) {
  const { organisationId: org, ...rest } = options;
  return app.inject({
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      cookie: jar.cookie,
      ...(org !== undefined ? { 'x-organisation-id': org } : {}),
    },
  });
}

/** Issues a fresh challan carrying `quantity` of the seeded item and
 * returns its id. */
async function issueChallan(quantity: string): Promise<string> {
  const created = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/challans`,
    organisationId,
    payload: {
      challanDate: '2026-08-08',
      prefix: 'INT',
      consignee: { name: 'Integrity Store', address: 'Depot 9, Nashik' },
      items: [{ workItemId, quantity }],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const challanId = created.json<{ challan: { id: string } }>().challan.id;
  const issued = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${challanId}/issue`,
    organisationId,
  });
  expect(issued.statusCode, issued.body).toBe(201);
  return challanId;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 2,
    applicationName: 'auto-mb-integrity-admin',
  });
  await admin`select 1 as ready`;
  const escapedPassword = appPassword.replaceAll("'", "''");
  await admin.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
        CREATE ROLE auto_mb_app LOGIN PASSWORD '${escapedPassword}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END
    $$;
  `);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-integrity-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  const signedUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: ownerEmail, password, name: 'Integrity Owner' },
  });
  expect(signedUp.statusCode, signedUp.body).toBe(200);
  owner = { cookie: extractCookies(signedUp.headers['set-cookie']) };

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Integrity Constructions', slug: `integrity-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;
  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing');
  ownerUserId = ownerUser.id;
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  // One Work with one generous item.
  workId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, 'INTG-1', 'L-90/2026', '2026-01-10',
      'Integrity proof work', '1000000.00', '900000.00', 'per_schedule',
      ${ownerUserId}
    )
  `;
  const scheduleId = randomUUID();
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  workItemId = randomUUID();
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number,
      description, unit_code, awarded_quantity, effective_rate
    )
    values (
      ${workItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
      'Integrity test item', 'Nos', '100000.000', '10.00'
    )
  `;
}, 60_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId]);
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`
      delete from auth_users where "email" like ${`%-${runId}@integration.test`}
    `;
    await admin.end();
  }
  if (app) await app.close();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('site measurement evidence after the sweep removal', () => {
  it('keeps mb-entries recordable but the Milestone 5 bill sweep endpoint is gone', async () => {
    await issueChallan('50000.000');

    // mb_entries stay recordable site measurement evidence (ADR-0006
    // decision 4): the delivered-quantity cap and endpoint are intact.
    const measured = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/mb-entries`,
      organisationId,
      payload: {
        workItemId,
        measuredQuantity: '1.000',
        measuredOn: '2026-08-08',
      },
    });
    expect(measured.statusCode, measured.body).toBe(201);

    // The 100%-of-measured sweep (POST /api/works/:id/bills) is REMOVED:
    // bills are prepared from a finalized Measurement Book instead
    // (measurement-books.integration.test.ts proves that path).
    const sweep = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/bills`,
      organisationId,
    });
    expect(sweep.statusCode).toBe(404);
  });
});

describe('cancellation after downstream evidence', () => {
  it('refuses to cancel once a receipt exists, and the DB backs it up', async () => {
    const challanId = await issueChallan('10.000');
    const receipt = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/receipt`,
      organisationId,
      payload: { receivedOn: '2026-08-08', receivedBy: 'Store keeper' },
    });
    expect(receipt.statusCode, receipt.body).toBe(201);

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/cancel`,
      organisationId,
      payload: { note: 'Trying to cancel a received delivery.' },
    });
    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.json<{ code: string }>().code).toBe('CHALLAN_HAS_EVIDENCE');

    // The database refuses even a direct update (admin bypasses RLS but
    // not the trigger).
    await expect(
      admin`
        update delivery_challans set status = 'cancelled'
        where id = ${challanId}
      `,
    ).rejects.toThrow(/downstream evidence/);

    // A clean issued challan still cancels normally.
    const cleanId = await issueChallan('5.000');
    const cleanCancel = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${cleanId}/cancel`,
      organisationId,
      payload: { note: 'Never delivered.' },
    });
    expect(cleanCancel.statusCode, cleanCancel.body).toBe(200);
  });

  it('refuses to cancel once a measurement references the challan', async () => {
    const challanId = await issueChallan('10.000');
    const measured = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/mb-entries`,
      organisationId,
      payload: {
        workItemId,
        deliveryChallanId: challanId,
        measuredQuantity: '2.000',
        measuredOn: '2026-08-08',
      },
    });
    expect(measured.statusCode, measured.body).toBe(201);

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/cancel`,
      organisationId,
      payload: { note: 'Trying to cancel a measured delivery.' },
    });
    expect(cancelled.statusCode).toBe(409);
  });
});

describe('measurement provenance', () => {
  it('rejects a challan reference from another Work', async () => {
    const foreignWorkId = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${foreignWorkId}, ${organisationId}, 'INTG-2', 'L-91/2026',
        '2026-01-10', 'Foreign work', '1000.00', '900.00', 'per_schedule',
        ${ownerUserId}
      )
    `;
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${foreignWorkId}/mb-entries`,
      organisationId,
      payload: {
        workItemId,
        deliveryChallanId: randomUUID(),
        measuredQuantity: '1.000',
        measuredOn: '2026-08-08',
      },
    });
    // The item belongs to the other Work, so the item check fires first;
    // a fabricated challan id on the right Work also dies.
    expect([404, 409]).toContain(response.statusCode);

    const fabricated = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/mb-entries`,
      organisationId,
      payload: {
        workItemId,
        deliveryChallanId: randomUUID(),
        measuredQuantity: '1.000',
        measuredOn: '2026-08-08',
      },
    });
    expect(fabricated.statusCode).toBe(404);
    expect(fabricated.json<{ code: string }>().code).toBe('CHALLAN_NOT_FOUND');
  });

  it('the serial lineage FK rejects a line that belongs to another challan', async () => {
    const challanA = await issueChallan('4.000');
    const challanB = await issueChallan('4.000');
    const [lineB] = await admin<{ id: string }[]>`
      select id from delivery_challan_items
      where delivery_challan_id = ${challanB}
    `;
    if (!lineB) throw new Error('challan B line missing');
    await expect(
      admin`
        insert into challan_item_serials (
          organisation_id, work_id, delivery_challan_id,
          delivery_challan_item_id, serial_number
        )
        values (
          ${organisationId}, ${workId}, ${challanA}, ${lineB.id},
          ${`SN-MISMATCH-${runId}`}
        )
      `,
    ).rejects.toThrow(/foreign key/);
  });
});

describe('instrument status transitions', () => {
  it('is forward-only from active, enforced by API and database', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/instruments`,
      organisationId,
      payload: {
        kind: 'pbg',
        reference: `BG-INT-${runId}`,
        amount: '50000.00',
        issuedOn: '2026-01-15',
        expiresOn: '2027-01-15',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const instrumentId = created.json<{ id: string }>().id;

    const released = await authed(owner, {
      method: 'PUT',
      url: `/api/instruments/${instrumentId}`,
      organisationId,
      payload: { status: 'released' },
    });
    expect(released.statusCode, released.body).toBe(200);

    const revived = await authed(owner, {
      method: 'PUT',
      url: `/api/instruments/${instrumentId}`,
      organisationId,
      payload: { status: 'active' },
    });
    expect(revived.statusCode).toBe(409);
    expect(revived.json<{ code: string }>().code).toBe('INSTRUMENT_STATUS_TERMINAL');

    await expect(
      admin`
        update work_instruments set status = 'active'
        where id = ${instrumentId}
      `,
    ).rejects.toThrow(/terminal/);
  });
});

describe('export completeness', () => {
  it('includes every Milestone 5 table in the business record', async () => {
    const importBatchId = randomUUID();
    const importRecordId = randomUUID();
    await admin`
      insert into import_batches (
        id, organisation_id, source_system, importer_version, input_digest,
        finished_at, reconciliation
      )
      values (
        ${importBatchId}, ${organisationId}, 'audit-fixture', 'v1',
        ${'a'.repeat(64)}, now(), ${admin.json({ imported: 1, rejected: 0 })}
      )
    `;
    await admin`
      insert into import_records (
        id, organisation_id, entity_type, source_system, source_id,
        target_id, batch_id, payload_fingerprint, payload
      )
      values (
        ${importRecordId}, ${organisationId}, 'work', 'audit-fixture',
        ${`legacy-${runId}`}, ${workId}, ${importBatchId}, ${'b'.repeat(64)},
        ${admin.json({ legacyField: 'preserved exactly' })}
      )
    `;
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const exported = response.json<Record<string, unknown[]>>();
    expect(exported.formatVersion).toBe('export-v12');
    expect(exported.challanReceipts?.length).toBeGreaterThan(0);
    expect(exported.workInstruments?.length).toBeGreaterThan(0);
    expect(exported.mbEntries?.length).toBeGreaterThan(0);
    expect(Array.isArray(exported.bills)).toBe(true);
    expect(Array.isArray(exported.challanItemSerials)).toBe(true);
    // export-v3: assignments, the full organisation profile, and a
    // portable manifest of every referenced stored object.
    expect(Array.isArray(exported.workAssignments)).toBe(true);
    expect(
      Object.keys(exported.organisation as unknown as Record<string, unknown>),
    ).toEqual(expect.arrayContaining(['address', 'gstin', 'logo_object_key']));
    // This fixture seeds Works directly, so the manifest may hold no
    // uploads — its presence and shape are the contract here.
    expect(Array.isArray(exported.objectManifest)).toBe(true);
    // export-v4: the Milestone 7 records — installations with their
    // serial attachments, the approval ledger, and correction notices.
    expect(Array.isArray(exported.installations)).toBe(true);
    expect(Array.isArray(exported.installationSerials)).toBe(true);
    expect(Array.isArray(exported.approvalRequests)).toBe(true);
    expect(Array.isArray(exported.correctionNotices)).toBe(true);
    // Wave 2 hardening: the Issue Challan register (with its lines and
    // replacement provenance) and extension requests complete export-v4.
    expect(Array.isArray(exported.issueChallans)).toBe(true);
    expect(Array.isArray(exported.issueChallanLines)).toBe(true);
    expect(Array.isArray(exported.extensionRequests)).toBe(true);
    // export-v5: the Milestone 8 phase-1 records.
    expect(Array.isArray(exported.paymentMatrices)).toBe(true);
    expect(Array.isArray(exported.pacCertificates)).toBe(true);
    expect(Array.isArray(exported.pacCertificateItems)).toBe(true);
    // export-v5 completion (Milestone 8 phase 2): the Measurement Book
    // lifecycle record — the format version deliberately stays v5.
    expect(Array.isArray(exported.measurementBooks)).toBe(true);
    expect(Array.isArray(exported.measurementBookLines)).toBe(true);
    expect(Array.isArray(exported.mbSources)).toBe(true);
    // M6/7 retrofit (migration 0028): the unified Contacts master and the
    // Work<->consignee association — additive sections, still export-v5.
    expect(Array.isArray(exported.contacts)).toBe(true);
    expect(Array.isArray(exported.workConsignees)).toBe(true);
    // export-v9: current masters, procurement, statutory documents,
    // cutover provenance, retained invoice renders, provider-operation
    // history, and recovery-critical number counters.
    for (const section of [
      'locationMasters',
      'unitMasters',
      // export-v9: the GST rate master (0048).
      'gstRates',
      'organisationSignatories',
      'purchaseOrders',
      'purchaseOrderLines',
      'budgetaryQuotations',
      'budgetaryQuotationLines',
      'taxInvoices',
      // export-v11: the lines of an ITEMISED invoice (0057).
      'taxInvoiceLines',
      'taxInvoiceRenders',
      // export-v10: the Section 34 credit note register (0051).
      'creditNotes',
      'measurementBookMergeProvenance',
      'ewayBills',
      'importBatches',
      'importRecords',
      'documentNumberSeries',
      'statutoryProviderOperations',
      'deliveryChallanCounters',
      'billCounters',
      'extensionRequestCounters',
      'issueChallanCounters',
      'correctionNoticeCounters',
      'measurementBookCounters',
      'purchaseOrderCounters',
      'budgetaryQuotationCounters',
      'taxInvoiceCounters',
      // export-v10: gap-free credit-note numbering state (0051).
      'creditNoteCounters',
    ]) {
      expect(Array.isArray(exported[section])).toBe(true);
    }
    expect(exported.importBatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: importBatchId,
          reconciliation: { imported: 1, rejected: 0 },
        }),
      ]),
    );
    expect(exported.importRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: importRecordId,
          source_id: `legacy-${runId}`,
          payload: { legacyField: 'preserved exactly' },
        }),
      ]),
    );
  });
});

/**
 * Audit finding 11's acceptance condition. The completeness assertions
 * above are a hand-maintained list, which is precisely what the audit said
 * not to rely on: a new tenant table lands, nobody remembers to add it to
 * the export, and the register is quietly no longer the complete business
 * record while CI stays green. This test derives the required set from the
 * database catalog instead, so the omission is a failure rather than an
 * oversight.
 */
describe('export completeness is catalog-driven', () => {
  /**
   * Export sections whose name is not the plain camelCase of their table.
   * These are the only hand-written entries and each is a naming decision
   * already published in the package's format: adding a table cannot get
   * past the test by being listed here, because a new table's absence
   * fails the assertion below regardless.
   */
  const SECTION_NAME_OVERRIDES: Readonly<Record<string, string>> = {
    // The organisation's own row is exported singular, as an object.
    organisations: 'organisation',
    // The membership register is published under its business name.
    organisation_memberships: 'members',
  };

  function sectionNameOf(table: string): string {
    const override = SECTION_NAME_OVERRIDES[table];
    if (override !== undefined) return override;
    return table.replace(/_([a-z0-9])/g, (_match, character: string) =>
      character.toUpperCase(),
    );
  }

  it('exports every organisation-scoped table the catalog knows about', async () => {
    // A tenant table is one carrying organisation_id, plus `organisations`
    // itself — the same definition the tenancy suite's own drift check
    // uses. BASE TABLE only: the consignee_masters compatibility view
    // (0028) exposes organisation_id but owns no rows of its own; its base
    // table `contacts` is in the set.
    const rows = await admin<{ table_name: string }[]>`
      select t.table_name
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_type = 'BASE TABLE'
        and (
          t.table_name = 'organisations'
          or exists (
            select 1
            from information_schema.columns c
            where c.table_schema = t.table_schema
              and c.table_name = t.table_name
              and c.column_name = 'organisation_id'
          )
        )
      order by t.table_name
    `;
    const tenantTables = rows.map((row) => row.table_name);
    // Guard against the query silently matching nothing and the test
    // passing vacuously on an unmigrated database.
    expect(tenantTables.length).toBeGreaterThan(50);

    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode).toBe(200);
    const exported: Record<string, unknown> = response.json();

    const missing = tenantTables.filter(
      (table) => exported[sectionNameOf(table)] === undefined,
    );
    expect(
      missing,
      `tenant tables absent from the organisation export: ${missing
        .map((table) => `${table} (expected section "${sectionNameOf(table)}")`)
        .join(', ')}. Add the table to routes/export.ts, or add a section-name ` +
        'override here if it is published under a different name.',
    ).toEqual([]);
  });
});

describe('the export is one consistent snapshot', () => {
  /**
   * The export runs about forty-five sequential SELECTs. Under READ
   * COMMITTED each takes its own snapshot, so a writer that commits
   * midway is invisible to the earlier queries and visible to the later
   * ones — and the package comes out referentially broken.
   *
   * The race is made deterministic with a table lock. `loa_documents` is
   * read after `works` and before `delivery_challans`, so an ACCESS
   * EXCLUSIVE lock on it parks the export exactly between the parent read
   * and the child read. A Work and a challan on it then commit into that
   * window. Under READ COMMITTED the package would carry the challan
   * without its Work; on the transaction's own snapshot it carries
   * neither.
   */
  it('excludes a Work and its challan that commit mid-export, rather than splitting them', async () => {
    const locker = createDatabasePool({
      url: adminUrl,
      max: 1,
      applicationName: 'auto-mb-integrity-export-lock',
    });
    const writer = createDatabasePool({
      url: adminUrl,
      max: 2,
      applicationName: 'auto-mb-integrity-export-writer',
    });
    const raceWorkId = randomUUID();
    const raceChallanId = randomUUID();
    try {
      let releaseLock!: () => void;
      const lockReleased = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let lockTaken!: () => void;
      const locked = new Promise<void>((resolve) => {
        lockTaken = resolve;
      });
      const holding = locker.begin(async (tx) => {
        await tx`lock table loa_documents in access exclusive mode`;
        lockTaken();
        await lockReleased;
      });
      await locked;

      // Not awaited: the export must be in flight and blocked.
      const exporting = authed(owner, {
        method: 'GET',
        url: '/api/export',
        organisationId,
      });
      const deadline = Date.now() + 20_000;
      for (;;) {
        const [waiting] = await writer<{ count: number }[]>`
          select count(*)::int as count from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%loa_documents%'
        `;
        if ((waiting?.count ?? 0) > 0) break;
        if (Date.now() > deadline) {
          throw new Error('the export never blocked on the loa_documents lock');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const raceScheduleId = randomUUID();
      await writer`
        insert into works (
          id, organisation_id, work_code, letter_number, letter_date, title,
          advertised_value, contract_value, pricing_shape, created_by_user_id
        )
        values (
          ${raceWorkId}, ${organisationId}, ${`RACE-${runId.toUpperCase()}`},
          ${`race-letter-${runId}`}, '2025-06-01', 'Mid-export race work',
          1000.00, 900.00, 'per_schedule', ${ownerUserId}
        )
      `;
      await writer`
        insert into work_schedules (
          id, organisation_id, work_id, schedule_code, title, position
        )
        values (${raceScheduleId}, ${organisationId}, ${raceWorkId}, 'A',
                'Schedule A', 1)
      `;
      await writer`
        insert into delivery_challans (
          id, organisation_id, work_id, challan_date, prefix,
          consignee_snapshot, created_by_user_id
        )
        values (
          ${raceChallanId}, ${organisationId}, ${raceWorkId}, '2026-08-08',
          'RACE', ${writer.json({ name: 'Race Store', address: 'Depot 9, Nashik' })},
          ${ownerUserId}
        )
      `;

      releaseLock();
      await holding;
      const response = await exporting;
      expect(response.statusCode, response.body).toBe(200);
      const exported = response.json<{
        works: { id: string }[];
        deliveryChallans: { id: string; work_id: string }[];
        deliveryChallanItems: { delivery_challan_id: string }[];
      }>();

      // The package is internally consistent: every challan's Work is in
      // it, and every challan item's challan is in it.
      const workIds = new Set(exported.works.map((row) => row.id));
      for (const challan of exported.deliveryChallans) {
        expect(workIds, `challan ${challan.id} without its Work`).toContain(
          challan.work_id,
        );
      }
      const challanIds = new Set(exported.deliveryChallans.map((row) => row.id));
      for (const item of exported.deliveryChallanItems) {
        expect(challanIds).toContain(item.delivery_challan_id);
      }
      // And specifically: the racing pair commits after the transaction's
      // snapshot, so neither half is in the package.
      expect(workIds.has(raceWorkId)).toBe(false);
      expect(challanIds.has(raceChallanId)).toBe(false);
    } finally {
      // Child first, so the fixture unwinds without touching FK triggers.
      await writer`delete from delivery_challans where id = ${raceChallanId}`;
      await writer`delete from work_schedules where work_id = ${raceWorkId}`;
      await writer`delete from works where id = ${raceWorkId}`;
      await locker.end();
      await writer.end();
    }
  }, 60_000);
});

describe('signed copy evidence', () => {
  it('stores a content-addressed key and the SHA-256', async () => {
    const challanId = await issueChallan('3.000');
    const first = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/signed-copy`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from(`%PDF-1.4 signed one ${runId}`),
    });
    expect(first.statusCode, first.body).toBe(200);
    const [afterFirst] = await admin<
      { signed_copy_object_key: string; signed_copy_sha256: string }[]
    >`
      select signed_copy_object_key, signed_copy_sha256
      from delivery_challans where id = ${challanId}
    `;
    expect(afterFirst?.signed_copy_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(afterFirst?.signed_copy_object_key).toContain(
      afterFirst?.signed_copy_sha256.slice(0, 16),
    );

    const second = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/signed-copy`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from(`%PDF-1.4 signed two ${runId}`),
    });
    expect(second.statusCode, second.body).toBe(200);
    const [afterSecond] = await admin<{ signed_copy_object_key: string }[]>`
      select signed_copy_object_key from delivery_challans
      where id = ${challanId}
    `;
    // The replacement lives at a NEW key; the first object is untouched.
    expect(afterSecond?.signed_copy_object_key).not.toBe(
      afterFirst?.signed_copy_object_key,
    );
  });
});
