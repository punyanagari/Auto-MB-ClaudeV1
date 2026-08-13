import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  PaymentMatrixResponse,
  PaymentMatrixRow,
  TimelineResponse,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Milestone 8 phase 1 (legacy spec §8, rule R10; ADR-0006 decision 5):
 * item payment categories and the per-Work payment matrix. Database
 * CHECKs (category vocabulary, 0–100 percentages, exact sum of 100),
 * matrix CRUD with writer-role/work-scope/cross-tenant enforcement,
 * category assignment at LOA confirmation and its later audited edit,
 * upsert concurrency, and the audit/timeline/export surfaces.
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
const ownerEmail = `pay-owner-${runId}@integration.test`;
const officeEmail = `pay-office-${runId}@integration.test`;
const viewerEmail = `pay-viewer-${runId}@integration.test`;
const assignedEmail = `pay-assigned-${runId}@integration.test`;
const outsiderEmail = `pay-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let workId: string;
let itemAId: string;
let itemBId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
let viewer: CookieJar;
let assigned: CookieJar;
let outsider: CookieJar;

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

async function signUp(email: string, name: string): Promise<CookieJar> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name },
  });
  expect(response.statusCode, `sign-up ${email}: ${response.body}`).toBe(200);
  return { cookie: extractCookies(response.headers['set-cookie']) };
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

const FULL_SUPPLY = {
  pctSupply: '80.00',
  pctInstallation: '10.00',
  pctPac: '0.00',
  pctFinalBill: '10.00',
};

async function putMatrixRow(
  jar: CookieJar,
  category: string,
  body: Record<string, string> = FULL_SUPPLY,
  work = workId,
  organisation = organisationId,
) {
  return authed(jar, {
    method: 'PUT',
    url: `/api/works/${work}/payment-matrix/${category}`,
    organisationId: organisation,
    payload: body,
  });
}

async function listMatrix(work = workId): Promise<PaymentMatrixResponse> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/works/${work}/payment-matrix`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PaymentMatrixResponse>();
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-payment-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the payment integration tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }

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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-pay-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'PAY Owner');
  office = await signUp(officeEmail, 'PAY Office');
  viewer = await signUp(viewerEmail, 'PAY Viewer');
  assigned = await signUp(assignedEmail, 'PAY Assigned');
  outsider = await signUp(outsiderEmail, 'PAY Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'PAY Constructions', slug: `pay-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'PAY Outsiders', slug: `pay-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [officeEmail, 'office'],
    [viewerEmail, 'viewer'],
    [assignedEmail, 'office'],
  ] as const) {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email, role },
    });
    expect(added.statusCode, added.body).toBe(201);
  }

  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing');
  ownerUserId = ownerUser.id;

  // The assigned-scope member sees only Works they are assigned to; no
  // assignment is granted, so every Work-addressed route answers 404.
  const [assignedUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${assignedEmail}
  `;
  if (!assignedUser) throw new Error('assigned user missing');
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId} and user_id = ${assignedUser.id}
  `;

  workId = randomUUID();
  const scheduleId = randomUUID();
  itemAId = randomUUID();
  itemBId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`PAYW-${runId.toUpperCase()}`},
      ${`pay-letter-${runId}`}, '2025-06-01', 'Payment matrix fixture work',
      2000.00, 1800.00, 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate
    )
    values
      (${itemAId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
       'Cable set', 'Set', 10.000, 250.00),
      (${itemBId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/2',
       'Junction box', 'Nos', 2.000, 120.00)
  `;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  if (storageDir !== undefined) {
    await rm(storageDir, { recursive: true, force: true });
  }
});

describe('database CHECK constraints (0021)', () => {
  it('rejects an out-of-vocabulary work_items.payment_category', async () => {
    await expect(
      admin`
        update work_items set payment_category = 'FREEFORM' where id = ${itemAId}
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts each of the four categories and NULL', async () => {
    for (const category of [
      'SUPPLY',
      'SUPPLY_AND_INSTALLATION',
      'PURE_INSTALLATION',
      'SPARE_SUPPLY',
      null,
    ]) {
      await admin`
        update work_items set payment_category = ${category} where id = ${itemAId}
      `;
    }
    const [row] = await admin<{ payment_category: string | null }[]>`
      select payment_category from work_items where id = ${itemAId}
    `;
    expect(row?.payment_category).toBeNull();
  });

  it('rejects a matrix row whose percentages do not sum to exactly 100', async () => {
    await expect(
      admin`
        insert into payment_matrices (
          organisation_id, work_id, category, pct_supply, pct_installation,
          pct_pac, pct_final_bill, created_by_user_id
        )
        values (${organisationId}, ${workId}, 'SUPPLY', 80.00, 10.00, 0.00,
                9.99, ${ownerUserId})
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a matrix row with a stage percentage outside 0–100', async () => {
    await expect(
      admin`
        insert into payment_matrices (
          organisation_id, work_id, category, pct_supply, pct_installation,
          pct_pac, pct_final_bill, created_by_user_id
        )
        values (${organisationId}, ${workId}, 'SUPPLY', 110.00, -10.00, 0.00,
                0.00, ${ownerUserId})
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an unknown matrix category at the database', async () => {
    await expect(
      admin`
        insert into payment_matrices (
          organisation_id, work_id, category, pct_supply, pct_installation,
          pct_pac, pct_final_bill, created_by_user_id
        )
        values (${organisationId}, ${workId}, 'MISC', 100.00, 0.00, 0.00,
                0.00, ${ownerUserId})
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('payment matrix CRUD', () => {
  it('upserts, lists, and deletes rows as a writer, with before/after audits', async () => {
    const created = await putMatrixRow(office, 'SUPPLY');
    expect(created.statusCode, created.body).toBe(200);
    const createdRow = created.json<PaymentMatrixRow>();
    expect(createdRow).toMatchObject({
      workId,
      category: 'SUPPLY',
      pctSupply: '80.00',
      pctInstallation: '10.00',
      pctPac: '0.00',
      pctFinalBill: '10.00',
    });

    const updated = await putMatrixRow(office, 'SUPPLY', {
      pctSupply: '70.00',
      pctInstallation: '20.00',
      pctPac: '0.00',
      pctFinalBill: '10.00',
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<PaymentMatrixRow>().pctSupply).toBe('70.00');

    const uncategorised = await putMatrixRow(office, 'UNCATEGORISED', {
      pctSupply: '60.00',
      pctInstallation: '20.00',
      pctPac: '10.00',
      pctFinalBill: '10.00',
    });
    expect(uncategorised.statusCode, uncategorised.body).toBe(200);

    const listed = await listMatrix();
    expect(listed.rows.map((row) => row.category).sort()).toEqual([
      'SUPPLY',
      'UNCATEGORISED',
    ]);

    const removed = await authed(office, {
      method: 'DELETE',
      url: `/api/works/${workId}/payment-matrix/UNCATEGORISED`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await listMatrix()).rows.map((row) => row.category)).toEqual(['SUPPLY']);

    const removedAgain = await authed(office, {
      method: 'DELETE',
      url: `/api/works/${workId}/payment-matrix/UNCATEGORISED`,
      organisationId,
    });
    expect(removedAgain.statusCode).toBe(404);

    const events = await admin<
      { action: string; details: { before?: unknown; after?: unknown } }[]
    >`
      select action, details from audit_events
      where organisation_id = ${organisationId}
        and entity_type = 'payment_matrices'
      order by occurred_at, id
    `;
    const actions = events.map((event) => event.action);
    expect(actions).toContain('payment_matrix.row_created');
    expect(actions).toContain('payment_matrix.row_updated');
    expect(actions).toContain('payment_matrix.row_deleted');
    const updateEvent = events.find(
      (event) => event.action === 'payment_matrix.row_updated',
    );
    expect(updateEvent?.details.before).toMatchObject({ pctSupply: '80.00' });
    expect(updateEvent?.details.after).toMatchObject({ pctSupply: '70.00' });
    const deleteEvent = events.find(
      (event) => event.action === 'payment_matrix.row_deleted',
    );
    expect(deleteEvent?.details.before).toMatchObject({ pctSupply: '60.00' });
  });

  it('surfaces matrix history on the Work timeline', async () => {
    const timeline = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/timeline?entityTypes=payment_matrices`,
      organisationId,
    });
    expect(timeline.statusCode, timeline.body).toBe(200);
    const { events } = timeline.json<TimelineResponse>();
    // The SUPPLY row's create + update; the deleted UNCATEGORISED row's
    // events no longer resolve to a live row and drop off the per-Work
    // view (they remain in audit_events and the export).
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((event) => event.entityType === 'payment_matrices')).toBe(true);
  });

  it('rejects a sum that is not exactly 100 with a friendly 400', async () => {
    const response = await putMatrixRow(office, 'SPARE_SUPPLY', {
      pctSupply: '80.00',
      pctInstallation: '10.00',
      pctPac: '5.00',
      pctFinalBill: '10.00',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('PAYMENT_MATRIX_SUM_INVALID');
  });

  it('rejects percentages outside 0–100 or with more than two decimals', async () => {
    for (const pctSupply of ['100.001', '101', '-1']) {
      const response = await putMatrixRow(office, 'SPARE_SUPPLY', {
        pctSupply,
        pctInstallation: '0.00',
        pctPac: '0.00',
        pctFinalBill: '0.00',
      });
      expect(response.statusCode, `${pctSupply}: ${response.body}`).toBe(400);
    }
  });

  it('rejects an unknown category with 400', async () => {
    const response = await putMatrixRow(office, 'MISC');
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe(
      'PAYMENT_MATRIX_CATEGORY_INVALID',
    );
  });

  it('denies viewers the mutations but serves them the list', async () => {
    const denied = await putMatrixRow(viewer, 'SUPPLY');
    expect(denied.statusCode).toBe(403);
    const deniedDelete = await authed(viewer, {
      method: 'DELETE',
      url: `/api/works/${workId}/payment-matrix/SUPPLY`,
      organisationId,
    });
    expect(deniedDelete.statusCode).toBe(403);
    const listed = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/payment-matrix`,
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<PaymentMatrixResponse>().rows.length).toBeGreaterThan(0);
  });

  it('answers 404 across tenants and for out-of-scope assigned members', async () => {
    // Outsider organisation: same Work id, foreign tenant — invisible.
    const crossTenant = await putMatrixRow(
      outsider,
      'SUPPLY',
      FULL_SUPPLY,
      workId,
      outsiderOrganisationId,
    );
    expect(crossTenant.statusCode).toBe(404);
    const crossTenantList = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${workId}/payment-matrix`,
      organisationId: outsiderOrganisationId,
    });
    expect(crossTenantList.statusCode).toBe(404);

    // Assigned-scope member with no assignment to this Work: 404, not 403.
    const outOfScope = await putMatrixRow(assigned, 'SUPPLY');
    expect(outOfScope.statusCode).toBe(404);
    const outOfScopeList = await authed(assigned, {
      method: 'GET',
      url: `/api/works/${workId}/payment-matrix`,
      organisationId,
    });
    expect(outOfScopeList.statusCode).toBe(404);
  });

  it('keeps concurrent upserts of the same category clean — last write wins, one row', async () => {
    const [first, second] = await Promise.all([
      putMatrixRow(owner, 'PURE_INSTALLATION', {
        pctSupply: '0.00',
        pctInstallation: '90.00',
        pctPac: '0.00',
        pctFinalBill: '10.00',
      }),
      putMatrixRow(office, 'PURE_INSTALLATION', {
        pctSupply: '0.00',
        pctInstallation: '80.00',
        pctPac: '10.00',
        pctFinalBill: '10.00',
      }),
    ]);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    const rows = await admin<{ pct_installation: string }[]>`
      select pct_installation::text as pct_installation from payment_matrices
      where work_id = ${workId} and category = 'PURE_INSTALLATION'
    `;
    expect(rows).toHaveLength(1);
    expect(['90.00', '80.00']).toContain(rows[0]?.pct_installation);
  });
});

describe('item payment categories', () => {
  it('persists reviewer-set categories at LOA confirmation', async () => {
    // A review-status document whose items the reviewer enters manually
    // (the parser never proposes categories, so manual rows exercise
    // exactly the reviewer-judgement path).
    const documentId = randomUUID();
    await admin`
      insert into loa_documents (
        id, organisation_id, object_key, original_filename, sha256,
        media_type, size_bytes, extraction_status, extraction_payload,
        uploaded_by_user_id
      )
      values (
        ${documentId}, ${organisationId},
        ${`${organisationId}/loa/${documentId}.pdf`}, 'pay-fixture.pdf',
        ${'c'.repeat(64)}, 'application/pdf', 1024, 'review', '{}'::jsonb,
        ${ownerUserId}
      )
    `;
    const confirmed = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: {
        workCode: `PAYC-${runId.toUpperCase()}`,
        letterNumber: `pay-confirm-${runId}`,
        letterDate: '2025-07-01',
        title: 'Categorised confirmation fixture',
        advertisedValue: '1000.00',
        contractValue: '900.00',
        pricingShape: 'per_schedule',
        schedules: [
          {
            scheduleCode: 'A',
            title: 'Schedule A',
            items: [
              {
                itemNumber: 'A/1',
                description: 'Supplied panels',
                unitCode: 'Nos',
                awardedQuantity: '10.000',
                effectiveRate: '100.00',
                manualEntry: true,
                paymentCategory: 'SUPPLY',
              },
              {
                itemNumber: 'A/2',
                description: 'Uncategorised sundries',
                unitCode: 'Lot',
                awardedQuantity: '1.000',
                effectiveRate: '50.00',
                manualEntry: true,
              },
            ],
          },
        ],
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const detail = confirmed.json<WorkDetailResponse>();
    const items = detail.schedules[0]?.items ?? [];
    expect(items.find((item) => item.itemNumber === 'A/1')?.paymentCategory).toBe(
      'SUPPLY',
    );
    expect(items.find((item) => item.itemNumber === 'A/2')?.paymentCategory).toBeNull();

    const fetched = await authed(owner, {
      method: 'GET',
      url: `/api/works/${detail.work.id}`,
      organisationId,
    });
    expect(fetched.statusCode, fetched.body).toBe(200);
    const fetchedItems = fetched.json<WorkDetailResponse>().schedules[0]?.items ?? [];
    expect(
      fetchedItems.find((item) => item.itemNumber === 'A/1')?.paymentCategory,
    ).toBe('SUPPLY');
  });

  it('rejects an invalid category at the confirmation boundary', async () => {
    const documentId = randomUUID();
    await admin`
      insert into loa_documents (
        id, organisation_id, object_key, original_filename, sha256,
        media_type, size_bytes, extraction_status, extraction_payload,
        uploaded_by_user_id
      )
      values (
        ${documentId}, ${organisationId},
        ${`${organisationId}/loa/${documentId}.pdf`}, 'pay-bad.pdf',
        ${'d'.repeat(64)}, 'application/pdf', 1024, 'review', '{}'::jsonb,
        ${ownerUserId}
      )
    `;
    const confirmed = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: {
        workCode: `PAYX-${runId.toUpperCase()}`,
        letterNumber: `pay-bad-${runId}`,
        letterDate: '2025-07-01',
        title: 'Bad category fixture',
        advertisedValue: '10.00',
        contractValue: '10.00',
        pricingShape: 'per_schedule',
        schedules: [
          {
            scheduleCode: 'A',
            title: 'Schedule A',
            items: [
              {
                itemNumber: 'A/1',
                description: 'Panels',
                unitCode: 'Nos',
                awardedQuantity: '1.000',
                effectiveRate: '10.00',
                manualEntry: true,
                paymentCategory: 'FREEFORM',
              },
            ],
          },
        ],
      },
    });
    expect(confirmed.statusCode).toBe(400);
  });

  it('edits the category later under the writer role, with a before/after audit', async () => {
    const set = await authed(office, {
      method: 'PATCH',
      url: `/api/work-items/${itemAId}/payment-category`,
      organisationId,
      payload: { paymentCategory: 'SUPPLY_AND_INSTALLATION' },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json<{ paymentCategory: string | null }>().paymentCategory).toBe(
      'SUPPLY_AND_INSTALLATION',
    );

    const cleared = await authed(office, {
      method: 'PATCH',
      url: `/api/work-items/${itemAId}/payment-category`,
      organisationId,
      payload: { paymentCategory: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(
      cleared.json<{ paymentCategory: string | null }>().paymentCategory,
    ).toBeNull();

    const events = await admin<
      {
        action: string;
        details: {
          before?: Record<string, unknown>;
          after?: Record<string, unknown>;
        };
      }[]
    >`
      select action, details from audit_events
      where organisation_id = ${organisationId}
        and entity_type = 'work_items' and entity_id = ${itemAId}
        and action = 'work_item.payment_category_changed'
      order by occurred_at, id
    `;
    expect(events.length).toBeGreaterThanOrEqual(2);
    const setEvent = events[events.length - 2];
    const clearEvent = events[events.length - 1];
    expect(setEvent?.details.before).toMatchObject({ paymentCategory: null });
    expect(setEvent?.details.after).toMatchObject({
      paymentCategory: 'SUPPLY_AND_INSTALLATION',
    });
    expect(clearEvent?.details.before).toMatchObject({
      paymentCategory: 'SUPPLY_AND_INSTALLATION',
    });
    expect(clearEvent?.details.after).toMatchObject({ paymentCategory: null });
  });

  it('gates the category edit on the writer role and work scope', async () => {
    const deniedRole = await authed(viewer, {
      method: 'PATCH',
      url: `/api/work-items/${itemBId}/payment-category`,
      organisationId,
      payload: { paymentCategory: 'SUPPLY' },
    });
    expect(deniedRole.statusCode).toBe(403);

    const deniedScope = await authed(assigned, {
      method: 'PATCH',
      url: `/api/work-items/${itemBId}/payment-category`,
      organisationId,
      payload: { paymentCategory: 'SUPPLY' },
    });
    expect(deniedScope.statusCode).toBe(404);

    const crossTenant = await authed(outsider, {
      method: 'PATCH',
      url: `/api/work-items/${itemBId}/payment-category`,
      organisationId: outsiderOrganisationId,
      payload: { paymentCategory: 'SUPPLY' },
    });
    expect(crossTenant.statusCode).toBe(404);

    const rejectedValue = await authed(office, {
      method: 'PATCH',
      url: `/api/work-items/${itemBId}/payment-category`,
      organisationId,
      payload: { paymentCategory: 'FREEFORM' },
    });
    expect(rejectedValue.statusCode).toBe(400);
  });
});

describe('export surface', () => {
  it('includes payment matrix rows in the organisation export', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const exported = response.json<{
      paymentMatrices: { work_id: string; category: string }[];
    }>();
    expect(Array.isArray(exported.paymentMatrices)).toBe(true);
    expect(
      exported.paymentMatrices.some(
        (row) => row.work_id === workId && row.category === 'SUPPLY',
      ),
    ).toBe(true);
  });
});
