import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
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
    if (organisationId) {
      await admin.unsafe(`set session_replication_role = 'replica'`);
      for (const table of [
        'audit_events',
        'mb_entries',
        'bills',
        'bill_counters',
        'challan_item_serials',
        'challan_receipts',
        'work_instruments',
        'delivery_challan_items',
        'delivery_challan_counters',
        'delivery_challans',
        'work_items',
        'work_schedules',
        'works',
        'organisation_memberships',
        'organisations',
      ]) {
        await admin.unsafe(
          `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
          [organisationId],
        );
      }
      await admin.unsafe(`set session_replication_role = 'origin'`);
    }
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
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const exported = response.json<Record<string, unknown[]>>();
    expect(exported.formatVersion).toBe('export-v5');
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
  });
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
