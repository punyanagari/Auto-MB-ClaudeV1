import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  Bill,
  ChallanDetailResponse,
  MeasurementBookDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations, withTenant } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Milestone 8 phase 2: the stage-wise Measurement Book lifecycle
 * (ADR-0006; spec §5.9, R19). Three Works:
 *
 * - Work 1 drives the agency workbook scenario (matrix 80/10/0/10, unit
 *   mtr) through MB1..MB4 including a cancellation, proving the remark
 *   wording character-for-character and the TRUE-cumulative memory.
 * - Work 2 proves percentage-resolution failure, the final-MB sweep,
 *   the final-bill stage bases, and no-MB-after-final.
 * - Work 3 proves gapless numbering and claim uniqueness under
 *   concurrency.
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

interface WorkbookFixture {
  readonly case: {
    readonly measurementBooks: ReadonlyArray<{
      readonly mb: number;
      readonly expectedRemark: string;
    }>;
  };
}
const workbook = JSON.parse(
  readFileSync(
    new URL('./fixtures/mb-remark-workbook.v1.json', import.meta.url),
    'utf8',
  ),
) as WorkbookFixture;
const expectedRemark = (mb: number): string => {
  const row = workbook.case.measurementBooks.find((entry) => entry.mb === mb);
  if (!row) throw new Error(`workbook fixture has no MB ${String(mb)}`);
  return row.expectedRemark;
};

const runId = randomBytes(5).toString('hex');
const ownerEmail = `mb-owner-${runId}@integration.test`;
const clerkEmail = `mb-clerk-${runId}@integration.test`;
const siteEmail = `mb-site-${runId}@integration.test`;
const outsiderEmail = `mb-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

const work1Code = `MB1W${runId.slice(0, 4).toUpperCase()}`;
const work2Code = `MB2W${runId.slice(0, 4).toUpperCase()}`;
const work3Code = `MB3W${runId.slice(0, 4).toUpperCase()}`;

let admin: Sql;
let appPool: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let consigneeMasterId: string;

let work1Id: string;
let cableItemId: string;
let work2Id: string;
let supplyItemId: string;
let installItemId: string;
let work3Id: string;
let w3ItemId: string;

// Work 1 running state.
let dc1Id: string;
let dc2Id: string;
let dc3Id: string;
let inst1Id: string;
let inst2Id: string;
let mb1Id: string;
let mb2Id: string;
let mb3Id: string;
let mb4Id: string;
// Work 2 running state.
let dcAId: string;
let instAId: string;
let instBId: string;
let pac1Id: string;
let finalMbId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let clerk: CookieJar;
let site: CookieJar;
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

async function seedWork(input: {
  code: string;
  items: {
    id: string;
    itemNumber: string;
    description: string;
    unit: string;
    quantity: string;
    rate: string;
    paymentCategory: string | null;
  }[];
}): Promise<string> {
  const workId = randomUUID();
  const scheduleId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${input.code}, ${`L-${input.code}`},
      '2025-06-01', ${`MB lifecycle work ${input.code}`}, '100000.00',
      '90000.00', 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  for (const item of input.items) {
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values (
        ${item.id}, ${organisationId}, ${workId}, ${scheduleId},
        ${item.itemNumber}, ${item.description}, ${item.unit},
        ${item.quantity}, ${item.rate}, ${item.paymentCategory}
      )
    `;
  }
  return workId;
}

async function insertMatrixRow(
  workId: string,
  category: string,
  pct: [string, string, string, string],
): Promise<void> {
  await admin`
    insert into payment_matrices (
      organisation_id, work_id, category, pct_supply, pct_installation,
      pct_pac, pct_final_bill, created_by_user_id
    )
    values (${organisationId}, ${workId}, ${category}, ${pct[0]}, ${pct[1]},
            ${pct[2]}, ${pct[3]}, ${ownerUserId})
  `;
}

async function issueChallan(
  workId: string,
  prefix: string,
  items: { workItemId: string; quantity: string }[],
): Promise<string> {
  const draft = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/challans`,
    organisationId,
    payload: {
      challanDate: '2026-07-01',
      prefix,
      consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division' },
      items,
    },
  });
  expect(draft.statusCode, draft.body).toBe(201);
  const challanId = draft.json<ChallanDetailResponse>().challan.id;
  const issued = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${challanId}/issue`,
    organisationId,
  });
  expect(issued.statusCode, issued.body).toBe(201);
  return challanId;
}

async function recordInstallation(
  workId: string,
  workItemId: string,
  quantity: string,
): Promise<string> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/installations`,
    organisationId,
    payload: {
      workItemId,
      quantity,
      installedOn: '2026-07-15',
      newLocation: { name: `Station MB ${randomUUID().slice(0, 8)}`, kind: 'station' },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function recordPac(
  workId: string,
  reference: string,
  items: { workItemId: string; certifiedQuantity: string }[],
): Promise<string> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/pac-certificates`,
    organisationId,
    payload: {
      reference,
      issueDate: '2026-08-01',
      consigneeMasterId,
      items,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function createDraft(
  workId: string,
  body: { mbDate: string; isFinal?: boolean },
): Promise<MeasurementBookDetailResponse> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/measurement-books`,
    organisationId,
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<MeasurementBookDetailResponse>();
}

async function setSources(
  mbId: string,
  sources: { sourceType: string; sourceId: string }[],
) {
  return authed(owner, {
    method: 'PUT',
    url: `/api/measurement-books/${mbId}/sources`,
    organisationId,
    payload: { sources },
  });
}

async function finalize(mbId: string, jar: CookieJar = owner) {
  return authed(jar, {
    method: 'POST',
    url: `/api/measurement-books/${mbId}/finalize`,
    organisationId,
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-mb-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the measurement book integration ' +
        `tests. Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
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

  appPool = createDatabasePool({
    url: appUrl,
    max: 4,
    applicationName: 'auto-mb-mb-app-pool',
  });

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-mb-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'MB Owner');
  clerk = await signUp(clerkEmail, 'MB Clerk');
  site = await signUp(siteEmail, 'MB Site');
  outsider = await signUp(outsiderEmail, 'MB Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'MB Constructions', slug: `mb-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const outsiderOrg = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'MB Outsiders', slug: `mb-out-${runId}` },
  });
  expect(outsiderOrg.statusCode, outsiderOrg.body).toBe(201);
  outsiderOrganisationId = outsiderOrg.json<{ id: string }>().id;

  for (const [email, role] of [
    [clerkEmail, 'office'],
    [siteEmail, 'site'],
  ] as const) {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email, role },
    });
    expect(added.statusCode, added.body).toBe(201);
  }

  const users = await admin<{ id: string; email: string }[]>`
    select "id", "email" from auth_users
    where "email" like ${`%-${runId}@integration.test`}
  `;
  const byEmail = new Map(users.map((row) => [row.email, row.id]));
  ownerUserId = byEmail.get(ownerEmail) ?? '';
  const siteUserId = byEmail.get(siteEmail) ?? '';
  expect(ownerUserId && siteUserId).toBeTruthy();
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
  // The site member sees only assigned Works — and holds no assignment.
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId} and user_id = ${siteUserId}
  `;

  cableItemId = randomUUID();
  work1Id = await seedWork({
    code: work1Code,
    items: [
      {
        id: cableItemId,
        itemNumber: '1',
        description: 'Power cable',
        unit: 'mtr',
        quantity: '10000.000',
        rate: '1.00',
        paymentCategory: null,
      },
    ],
  });
  await insertMatrixRow(work1Id, 'UNCATEGORISED', ['80.00', '10.00', '0.00', '10.00']);

  supplyItemId = randomUUID();
  installItemId = randomUUID();
  work2Id = await seedWork({
    code: work2Code,
    items: [
      {
        id: supplyItemId,
        itemNumber: 'S/1',
        description: 'Point machine supply',
        unit: 'Nos',
        quantity: '100.000',
        rate: '10.00',
        paymentCategory: 'SUPPLY',
      },
      {
        id: installItemId,
        itemNumber: 'S/2',
        description: 'Signal gear erection works',
        unit: 'Nos',
        quantity: '100.000',
        rate: '20.00',
        paymentCategory: 'PURE_INSTALLATION',
      },
    ],
  });

  w3ItemId = randomUUID();
  work3Id = await seedWork({
    code: work3Code,
    items: [
      {
        id: w3ItemId,
        itemNumber: 'C/1',
        description: 'Cable trench',
        unit: 'RMT',
        quantity: '1000.000',
        rate: '5.00',
        paymentCategory: null,
      },
    ],
  });
  await insertMatrixRow(work3Id, 'UNCATEGORISED', ['70.00', '20.00', '0.00', '10.00']);

  consigneeMasterId = randomUUID();
  await admin`
    insert into consignee_masters (
      id, organisation_id, designation, address, created_by_user_id
    )
    values (${consigneeMasterId}, ${organisationId}, 'Sr. DEE (G) NR',
            'Delhi Division office', ${ownerUserId})
  `;
}, 90_000);

afterAll(async () => {
  if (admin) {
    for (const org of [organisationId, outsiderOrganisationId]) {
      if (!org) continue;
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'work_assignments',
          'mb_sources',
          'measurement_book_lines',
          'measurement_book_counters',
          'bills',
          'measurement_books',
          'bill_counters',
          'payment_matrices',
          'pac_certificate_items',
          'pac_certificates',
          'installation_serials',
          'installations',
          'consignee_masters',
          'location_masters',
          'mb_entries',
          'challan_item_serials',
          'challan_receipts',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'loa_documents',
          'work_items',
          'work_schedules',
          'works',
          'organisation_memberships',
          'organisations',
        ]) {
          await admin.unsafe(
            `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
            [org],
          );
        }
      } finally {
        await admin.unsafe(`set session_replication_role = 'origin'`);
      }
    }
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`delete from auth_users where "email" like ${`%-${runId}@integration.test`}`;
  }
  await app?.close();
  await appPool?.end();
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('draft lifecycle (Work 1, the workbook scenario)', () => {
  it('creates one draft per Work, validates the date, and names the existing draft', async () => {
    dc1Id = await issueChallan(work1Id, `${work1Code}DC`, [
      { workItemId: cableItemId, quantity: '5000' },
    ]);

    const future = await authed(owner, {
      method: 'POST',
      url: `/api/works/${work1Id}/measurement-books`,
      organisationId,
      payload: { mbDate: '2030-01-01' },
    });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toMatchObject({ code: 'MB_DATE_FUTURE' });

    const beforeLoa = await authed(owner, {
      method: 'POST',
      url: `/api/works/${work1Id}/measurement-books`,
      organisationId,
      payload: { mbDate: '2025-05-31' },
    });
    expect(beforeLoa.statusCode).toBe(400);
    expect(beforeLoa.json()).toMatchObject({ code: 'MB_DATE_BEFORE_LOA' });

    const detail = await createDraft(work1Id, { mbDate: '2026-08-01' });
    mb1Id = detail.book.id;
    expect(detail.book.status).toBe('draft');
    expect(detail.book.totalAmount).toBeNull();
    expect(detail.lines).toEqual([]);

    // R3-equivalent: the conflict names the existing draft.
    const duplicate = await authed(owner, {
      method: 'POST',
      url: `/api/works/${work1Id}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-01' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      code: 'MB_DRAFT_EXISTS',
      details: { existingRecordId: mb1Id },
    });

    // Writers only.
    const denied = await authed(site, {
      method: 'POST',
      url: `/api/works/${work1Id}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-01' },
    });
    expect([403, 404]).toContain(denied.statusCode);
  });

  it('claims sources and previews the computed lines from live state', async () => {
    const updated = await setSources(mb1Id, [
      { sourceType: 'delivery_challan', sourceId: dc1Id },
    ]);
    expect(updated.statusCode, updated.body).toBe(200);
    const detail = updated.json<MeasurementBookDetailResponse>();
    expect(detail.sources).toHaveLength(1);
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]?.remark).toBe(expectedRemark(1));
    expect(detail.lines[0]?.deltaSupplied).toBe('5000.000');
    expect(detail.previewTotal).toBe('4000.00');
    expect(detail.warnings).toEqual([]);
  });

  it('deletes a draft, removing its claims entirely', async () => {
    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${mb1Id}`,
      organisationId,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    const [claims] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_sources
      where measurement_book_id = ${mb1Id}
    `;
    expect(claims?.count).toBe('0');

    // Recreate and reclaim for the finalize tests.
    const detail = await createDraft(work1Id, { mbDate: '2026-08-01' });
    mb1Id = detail.book.id;
    const reclaimed = await setSources(mb1Id, [
      { sourceType: 'delivery_challan', sourceId: dc1Id },
    ]);
    expect(reclaimed.statusCode, reclaimed.body).toBe(200);
  });
});

describe('finalize: numbering, snapshot, and the workbook remarks', () => {
  it('finalizes MB1 under issue authority with the exact workbook remark', async () => {
    const denied = await finalize(mb1Id, clerk);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });

    const finalized = await finalize(mb1Id);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = finalized.json<MeasurementBookDetailResponse>();
    expect(detail.book.status).toBe('finalized');
    expect(detail.book.mbNumber).toBe(`${work1Code}-MB-01`);
    expect(detail.book.sequenceNumber).toBe(1);
    expect(detail.book.totalAmount).toBe('4000.00');
    expect(detail.book.remarkTemplateVersion).toBe('mb-remark-v1');
    const [line] = detail.lines;
    expect(line?.remark).toBe(expectedRemark(1));
    expect(line?.pctSupply).toBe('80.00');
    expect(line?.pctInstallation).toBe('10.00');
    expect(line?.resolvedCategory).toBe('UNCATEGORISED');
    expect(line?.amountSupply).toBe('4000.00');
    expect(line?.lineTotal).toBe('4000.00');

    // The stored row IS the remark, character for character.
    const [stored] = await admin<{ remark: string; prior_supplied: string }[]>`
      select remark, prior_supplied::text as prior_supplied
      from measurement_book_lines
      where measurement_book_id = ${mb1Id}
    `;
    expect(stored?.remark).toBe(expectedRemark(1));
    expect(stored?.prior_supplied).toBe('0.000');

    // Finalizing again is a clean conflict.
    const again = await finalize(mb1Id);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'MB_STATUS_CONFLICT' });
  });

  it('MB2 carries the true prepaid memory (workbook MB2)', async () => {
    inst1Id = await recordInstallation(work1Id, cableItemId, '1000');
    const draft = await createDraft(work1Id, { mbDate: '2026-08-02' });
    mb2Id = draft.book.id;
    const claimed = await setSources(mb2Id, [
      { sourceType: 'installation', sourceId: inst1Id },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const finalized = await finalize(mb2Id);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = finalized.json<MeasurementBookDetailResponse>();
    expect(detail.book.mbNumber).toBe(`${work1Code}-MB-02`);
    expect(detail.book.totalAmount).toBe('100.00');
    const [line] = detail.lines;
    expect(line?.remark).toBe(expectedRemark(2));
    expect(line?.priorSupplied).toBe('5000.000');
    expect(line?.deltaInstalled).toBe('1000.000');

    const [stored] = await admin<{ remark: string }[]>`
      select remark from measurement_book_lines
      where measurement_book_id = ${mb2Id}
    `;
    expect(stored?.remark).toBe(expectedRemark(2));
  });

  it('finalize with nothing to bill is refused', async () => {
    const draft = await createDraft(work1Id, { mbDate: '2026-08-03' });
    const empty = await finalize(draft.book.id);
    expect(empty.statusCode).toBe(409);
    expect(empty.json()).toMatchObject({ code: 'MB_EMPTY' });
    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${draft.book.id}`,
      organisationId,
    });
    expect(deleted.statusCode).toBe(204);
  });
});

describe('R19: claimed sources cannot be cancelled', () => {
  it('refuses at the API for a claimed challan and installation, naming the MB', async () => {
    const challanCancel = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${dc1Id}/cancel`,
      organisationId,
      payload: { note: 'Attempt against a billed challan.' },
    });
    expect(challanCancel.statusCode).toBe(409);
    expect(challanCancel.json()).toMatchObject({
      code: 'SOURCE_BILLED_IN_MB',
      details: {
        sourceType: 'delivery_challan',
        sourceId: dc1Id,
        holdingMeasurementBookId: mb1Id,
        holdingMbNumber: `${work1Code}-MB-01`,
      },
    });

    const installationCancel = await authed(owner, {
      method: 'POST',
      url: `/api/installations/${inst1Id}/cancel`,
      organisationId,
      payload: { note: 'Attempt against a billed installation.' },
    });
    expect(installationCancel.statusCode).toBe(409);
    expect(installationCancel.json()).toMatchObject({
      code: 'SOURCE_BILLED_IN_MB',
      details: { sourceType: 'installation', sourceId: inst1Id },
    });
  });

  it('refuses at the database for challans and installations', async () => {
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          update delivery_challans
          set status = 'cancelled', cancellation_note = 'db bypass attempt',
              cancelled_by_user_id = ${ownerUserId}, cancelled_at = now()
          where id = ${dc1Id}
        `;
      }),
    ).rejects.toThrowError(/billed in a live Measurement Book/);

    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          update installations
          set status = 'cancelled', cancellation_note = 'db bypass attempt',
              cancelled_by_user_id = ${ownerUserId}, cancelled_at = now()
          where id = ${inst1Id}
        `;
      }),
    ).rejects.toThrowError(/billed in a live Measurement Book/);
  });

  it('a released source can be cancelled; a cancelled source cannot be re-claimed', async () => {
    dc2Id = await issueChallan(work1Id, `${work1Code}DC`, [
      { workItemId: cableItemId, quantity: '400' },
    ]);
    const draft = await createDraft(work1Id, { mbDate: '2026-08-03' });
    mb3Id = draft.book.id;
    const claimed = await setSources(mb3Id, [
      { sourceType: 'delivery_challan', sourceId: dc2Id },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);

    // Claimed by the DRAFT: still uncancellable.
    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${dc2Id}/cancel`,
      organisationId,
      payload: { note: 'Blocked while claimed by a draft.' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'SOURCE_BILLED_IN_MB' });

    // Replacing the selection releases the claim; the cancel then lands.
    const released = await setSources(mb3Id, []);
    expect(released.statusCode, released.body).toBe(200);
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${dc2Id}/cancel`,
      organisationId,
      payload: { note: 'Wrong quantities; re-issue.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    // A cancelled source is not billable — API and database agree.
    const reclaim = await setSources(mb3Id, [
      { sourceType: 'delivery_challan', sourceId: dc2Id },
    ]);
    expect(reclaim.statusCode).toBe(409);
    expect(reclaim.json()).toMatchObject({ code: 'MB_SOURCE_NOT_BILLABLE' });

    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          insert into mb_sources (
            organisation_id, measurement_book_id, work_id, source_type, source_id
          )
          values (${organisationId}, ${mb3Id}, ${work1Id}, 'delivery_challan',
                  ${dc2Id})
        `;
      }),
    ).rejects.toThrowError(/only issued delivery challans are billable/);
  });

  it('a source claimed by another live MB answers a structured 409 naming the holder', async () => {
    const conflicted = await setSources(mb3Id, [
      { sourceType: 'delivery_challan', sourceId: dc1Id },
    ]);
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json()).toMatchObject({
      code: 'MB_SOURCE_ALREADY_BILLED',
      details: {
        sourceType: 'delivery_challan',
        sourceId: dc1Id,
        holdingMeasurementBookId: mb1Id,
        holdingMbNumber: `${work1Code}-MB-01`,
      },
    });
  });

  it('claim uniqueness under concurrency: exactly one insert wins at the index', async () => {
    dc3Id = await issueChallan(work1Id, `${work1Code}DC`, [
      { workItemId: cableItemId, quantity: '1000' },
    ]);
    const claim = () =>
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          insert into mb_sources (
            organisation_id, measurement_book_id, work_id, source_type, source_id
          )
          values (${organisationId}, ${mb3Id}, ${work1Id}, 'delivery_challan',
                  ${dc3Id})
        `;
      });
    const outcomes = await Promise.allSettled([claim(), claim()]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as { code?: string }).code).toBe('23505');
    const [live] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_sources
      where source_type = 'delivery_challan' and source_id = ${dc3Id}
        and released_at is null
    `;
    expect(live?.count).toBe('1');
  });
});

describe('newest-only cancel and the TRUE cumulative', () => {
  it('finalizes MB3 (workbook MB3) and refuses to cancel the older MB2', async () => {
    inst2Id = await recordInstallation(work1Id, cableItemId, '2000');
    const claimed = await setSources(mb3Id, [
      { sourceType: 'delivery_challan', sourceId: dc3Id },
      { sourceType: 'installation', sourceId: inst2Id },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const finalized = await finalize(mb3Id);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = finalized.json<MeasurementBookDetailResponse>();
    expect(detail.book.mbNumber).toBe(`${work1Code}-MB-03`);
    expect(detail.lines[0]?.remark).toBe(expectedRemark(3));

    const notNewest = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mb2Id}/cancel`,
      organisationId,
      payload: { note: 'Older MBs must be uncancellable.' },
    });
    expect(notNewest.statusCode).toBe(409);
    expect(notNewest.json()).toMatchObject({
      code: 'MB_NOT_NEWEST',
      details: {
        newerMeasurementBookId: mb3Id,
        newerMbNumber: `${work1Code}-MB-03`,
      },
    });
  });

  it('cancels the newest MB with a mandatory note, releasing its sources', async () => {
    const missingNote = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mb3Id}/cancel`,
      organisationId,
      payload: { note: '' },
    });
    expect(missingNote.statusCode).toBe(400);

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mb3Id}/cancel`,
      organisationId,
      payload: { note: 'Wrong measurement basis; will re-raise.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const detail = cancelled.json<MeasurementBookDetailResponse>();
    expect(detail.book.status).toBe('cancelled');
    // Cancelled MBs keep their number forever.
    expect(detail.book.mbNumber).toBe(`${work1Code}-MB-03`);
    expect(detail.sources.every((source) => source.releasedAt !== null)).toBe(true);

    const [live] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_sources
      where measurement_book_id = ${mb3Id} and released_at is null
    `;
    expect(live?.count).toBe('0');
  });

  it('excludes the cancelled MB from the prior cumulative (MB4 repeats MB3)', async () => {
    const draft = await createDraft(work1Id, { mbDate: '2026-08-04' });
    mb4Id = draft.book.id;
    const claimed = await setSources(mb4Id, [
      { sourceType: 'delivery_challan', sourceId: dc3Id },
      { sourceType: 'installation', sourceId: inst2Id },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const preview = claimed.json<MeasurementBookDetailResponse>();
    // TRUE cumulative: the cancelled MB3's deltas do NOT count, so the
    // remark repeats MB3's wording exactly.
    expect(preview.lines[0]?.remark).toBe(expectedRemark(3));

    const finalized = await finalize(mb4Id);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = finalized.json<MeasurementBookDetailResponse>();
    // Cancelled numbers are never reused: the corrected MB takes 04.
    expect(detail.book.mbNumber).toBe(`${work1Code}-MB-04`);
    const [line] = detail.lines;
    expect(line?.remark).toBe(expectedRemark(3));
    expect(line?.priorSupplied).toBe('5000.000');
    expect(line?.priorInstalled).toBe('1000.000');
    expect(line?.deltaSupplied).toBe('1000.000');
    expect(line?.deltaInstalled).toBe('2000.000');
    // 1000 x 1.00 x 80% + 2000 x 1.00 x 10% = 800 + 200.
    expect(detail.book.totalAmount).toBe('1000.00');
  });

  it('rejects a NULL-note cancellation at the database', async () => {
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          update measurement_books
          set status = 'cancelled', cancelled_by_user_id = ${ownerUserId},
              cancelled_at = now()
          where id = ${mb4Id}
        `;
      }),
    ).rejects.toThrowError(/check|constraint/i);
  });
});

describe('bill preparation from a finalized MB', () => {
  it('prepares the bill 1:1 with the MB total; the sweep endpoint is gone', async () => {
    const sweepGone = await authed(owner, {
      method: 'POST',
      url: `/api/works/${work1Id}/bills`,
      organisationId,
    });
    expect(sweepGone.statusCode).toBe(404);

    const prepared = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mb4Id}/bill`,
      organisationId,
    });
    expect(prepared.statusCode, prepared.body).toBe(201);
    const bill = prepared.json<Bill>();
    expect(bill.totalAmount).toBe('1000.00');
    expect(bill.mbId).toBe(mb4Id);
    const lines = bill.linesSnapshot as { remark: string; lineTotal: string }[];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.remark).toBe(expectedRemark(3));

    const duplicate = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mb4Id}/bill`,
      organisationId,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'MB_ALREADY_BILLED' });

    // Detail links back to the bill.
    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${mb4Id}`,
      organisationId,
    });
    expect(detail.json<MeasurementBookDetailResponse>().book.billId).toBe(bill.id);
  });

  it('refuses to cancel a billed MB', async () => {
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mb4Id}/cancel`,
      organisationId,
      payload: { note: 'A billed MB is permanently locked.' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'MB_BILLED' });
  });
});

describe('percentage resolution and the final MB (Work 2)', () => {
  it('warns on the draft and fails finalize with ONE 409 naming every item', async () => {
    dcAId = await issueChallan(work2Id, `${work2Code}DC`, [
      { workItemId: supplyItemId, quantity: '4' },
    ]);
    instAId = await recordInstallation(work2Id, installItemId, '3');
    pac1Id = await recordPac(work2Id, `PAC-${runId}-1`, [
      { workItemId: installItemId, certifiedQuantity: '2' },
    ]);

    const draft = await createDraft(work2Id, { mbDate: '2026-08-05' });
    const claimed = await setSources(draft.book.id, [
      { sourceType: 'delivery_challan', sourceId: dcAId },
      { sourceType: 'installation', sourceId: instAId },
      { sourceType: 'pac_certificate', sourceId: pac1Id },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const preview = claimed.json<MeasurementBookDetailResponse>();
    expect(preview.lines).toEqual([]);
    expect(preview.warnings).toEqual([
      { workItemId: supplyItemId, itemNumber: 'S/1', missingCategory: 'SUPPLY' },
      {
        workItemId: installItemId,
        itemNumber: 'S/2',
        missingCategory: 'PURE_INSTALLATION',
      },
    ]);

    const refused = await finalize(draft.book.id);
    expect(refused.statusCode).toBe(409);
    const body = refused.json<{
      code: string;
      message: string;
      details: { items: { itemNumber: string; missingCategory: string }[] };
    }>();
    expect(body.code).toBe('MB_PERCENTAGES_UNRESOLVED');
    expect(body.details.items).toEqual([
      { workItemId: supplyItemId, itemNumber: 'S/1', missingCategory: 'SUPPLY' },
      {
        workItemId: installItemId,
        itemNumber: 'S/2',
        missingCategory: 'PURE_INSTALLATION',
      },
    ]);
    expect(body.message).toContain('S/1');
    expect(body.message).toContain('S/2');

    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${draft.book.id}`,
      organisationId,
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('the final MB must sweep every open source, naming the missed ones', async () => {
    await insertMatrixRow(work2Id, 'SUPPLY', ['90.00', '0.00', '0.00', '10.00']);
    await insertMatrixRow(work2Id, 'PURE_INSTALLATION', [
      '0.00',
      '70.00',
      '10.00',
      '20.00',
    ]);
    // A cancelled installation is not an open source and must not be
    // demanded by the sweep.
    instBId = await recordInstallation(work2Id, installItemId, '1');
    const cancelInstB = await authed(owner, {
      method: 'POST',
      url: `/api/installations/${instBId}/cancel`,
      organisationId,
      payload: { note: 'Recorded in error.' },
    });
    expect(cancelInstB.statusCode, cancelInstB.body).toBe(200);

    const draft = await createDraft(work2Id, { mbDate: '2026-08-06', isFinal: true });
    finalMbId = draft.book.id;
    const partial = await setSources(finalMbId, [
      { sourceType: 'delivery_challan', sourceId: dcAId },
    ]);
    expect(partial.statusCode, partial.body).toBe(200);

    const refused = await finalize(finalMbId);
    expect(refused.statusCode).toBe(409);
    const body = refused.json<{
      code: string;
      details: { missedSources: { sourceType: string; sourceId: string }[] };
    }>();
    expect(body.code).toBe('MB_FINAL_SWEEP_INCOMPLETE');
    const missed = body.details.missedSources.map(
      (s) => `${s.sourceType}:${s.sourceId}`,
    );
    expect(missed).toContain(`installation:${instAId}`);
    expect(missed).toContain(`pac_certificate:${pac1Id}`);
    expect(missed).not.toContain(`installation:${instBId}`);
  });

  it('a source cancelled between draft and finalize surfaces as a clean 409', async () => {
    const swept = await setSources(finalMbId, [
      { sourceType: 'delivery_challan', sourceId: dcAId },
      { sourceType: 'installation', sourceId: instAId },
      { sourceType: 'pac_certificate', sourceId: pac1Id },
    ]);
    expect(swept.statusCode, swept.body).toBe(200);

    // Force-cancel the claimed PAC with triggers disabled — simulating
    // any writer that slipped past the guards. Finalize revalidates
    // under row locks and answers a clean 409, never a broken write.
    await admin.unsafe(`set session_replication_role = 'replica'`);
    try {
      await admin`
        update pac_certificates
        set status = 'cancelled', cancellation_note = 'forced for the race test',
            cancelled_by_user_id = ${ownerUserId}, cancelled_at = now()
        where id = ${pac1Id}
      `;
    } finally {
      await admin.unsafe(`set session_replication_role = 'origin'`);
    }
    const refused = await finalize(finalMbId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'MB_SOURCE_NOT_BILLABLE' });

    await admin.unsafe(`set session_replication_role = 'replica'`);
    try {
      await admin`
        update pac_certificates
        set status = 'recorded', cancellation_note = null,
            cancelled_by_user_id = null, cancelled_at = null
        where id = ${pac1Id}
      `;
    } finally {
      await admin.unsafe(`set session_replication_role = 'origin'`);
    }

    // No lines were written by the refused attempt.
    const [lines] = await admin<{ count: string }[]>`
      select count(*)::text as count from measurement_book_lines
      where measurement_book_id = ${finalMbId}
    `;
    expect(lines?.count).toBe('0');
  });

  it('finalizes the final MB computing the final-bill stage per branch', async () => {
    const finalized = await finalize(finalMbId);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = finalized.json<MeasurementBookDetailResponse>();
    expect(detail.book.isFinal).toBe(true);
    expect(detail.book.mbNumber).toBe(`${work2Code}-MB-01`);

    const supplyLine = detail.lines.find((line) => line.itemNumber === 'S/1');
    const installLine = detail.lines.find((line) => line.itemNumber === 'S/2');
    // SUPPLY branch: final % on 100% of DELIVERED, irrespective of
    // installation (resolveFinalBillBase).
    expect(supplyLine?.deltaSupplied).toBe('4.000');
    expect(supplyLine?.deltaFinalBill).toBe('4.000');
    expect(supplyLine?.amountSupply).toBe('36.00');
    expect(supplyLine?.amountFinalBill).toBe('4.00');
    expect(supplyLine?.lineTotal).toBe('40.00');
    // PURE_INSTALLATION branch: final % on the INSTALLED quantity only.
    expect(installLine?.deltaInstalled).toBe('3.000');
    expect(installLine?.deltaPac).toBe('2.000');
    expect(installLine?.deltaFinalBill).toBe('3.000');
    expect(installLine?.amountInstallation).toBe('42.00');
    expect(installLine?.amountPac).toBe('4.00');
    expect(installLine?.amountFinalBill).toBe('12.00');
    expect(installLine?.lineTotal).toBe('58.00');
    expect(detail.book.totalAmount).toBe('98.00');
  });

  it('permits no further MB once a live final MB exists (API and database)', async () => {
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/works/${work2Id}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-07' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'FINAL_MB_EXISTS' });

    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          insert into measurement_books (
            organisation_id, work_id, mb_date, created_by_user_id
          )
          values (${organisationId}, ${work2Id}, '2026-08-07', ${ownerUserId})
        `;
      }),
    ).rejects.toThrowError(/final Measurement Book exists/);
  });

  it('R19 holds for PAC certificates claimed by the live final MB (API and database)', async () => {
    const apiCancel = await authed(owner, {
      method: 'POST',
      url: `/api/pac-certificates/${pac1Id}/cancel`,
      organisationId,
      payload: { note: 'Attempt against a billed PAC.' },
    });
    expect(apiCancel.statusCode).toBe(409);
    expect(apiCancel.json()).toMatchObject({
      code: 'SOURCE_BILLED_IN_MB',
      details: { sourceType: 'pac_certificate', sourceId: pac1Id },
    });

    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          update pac_certificates
          set status = 'cancelled', cancellation_note = 'db bypass attempt',
              cancelled_by_user_id = ${ownerUserId}, cancelled_at = now()
          where id = ${pac1Id}
        `;
      }),
    ).rejects.toThrowError(/billed in a live Measurement Book/);
  });
});

describe('gapless numbering under concurrent finalize attempts (Work 3)', () => {
  it('two concurrent finalizes yield one number; the next MB takes the next slot', async () => {
    const dc31 = await issueChallan(work3Id, `${work3Code}DC`, [
      { workItemId: w3ItemId, quantity: '2' },
    ]);
    const dc32 = await issueChallan(work3Id, `${work3Code}DC`, [
      { workItemId: w3ItemId, quantity: '3' },
    ]);

    const draftA = await createDraft(work3Id, { mbDate: '2026-08-05' });
    const claimedA = await setSources(draftA.book.id, [
      { sourceType: 'delivery_challan', sourceId: dc31 },
    ]);
    expect(claimedA.statusCode, claimedA.body).toBe(200);

    const [first, second] = await Promise.all([
      finalize(draftA.book.id),
      finalize(draftA.book.id),
    ]);
    const statuses = [first?.statusCode, second?.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const draftB = await createDraft(work3Id, { mbDate: '2026-08-06' });
    const claimedB = await setSources(draftB.book.id, [
      { sourceType: 'delivery_challan', sourceId: dc32 },
    ]);
    expect(claimedB.statusCode, claimedB.body).toBe(200);
    const finalizedB = await finalize(draftB.book.id);
    expect(finalizedB.statusCode, finalizedB.body).toBe(200);
    expect(finalizedB.json<MeasurementBookDetailResponse>().book.mbNumber).toBe(
      `${work3Code}-MB-02`,
    );

    const rows = await admin<{ sequence_number: number; mb_number: string }[]>`
      select sequence_number, mb_number from measurement_books
      where work_id = ${work3Id} and sequence_number is not null
      order by sequence_number
    `;
    expect(rows.map((row) => row.sequence_number)).toEqual([1, 2]);
    expect(rows.map((row) => row.mb_number)).toEqual([
      `${work3Code}-MB-01`,
      `${work3Code}-MB-02`,
    ]);
  });
});

describe('tenancy and scope', () => {
  it('cross-tenant probes answer 404', async () => {
    const detail = await authed(outsider, {
      method: 'GET',
      url: `/api/measurement-books/${mb1Id}`,
      organisationId: outsiderOrganisationId,
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({ code: 'MEASUREMENT_BOOK_NOT_FOUND' });

    const create = await authed(outsider, {
      method: 'POST',
      url: `/api/works/${work1Id}/measurement-books`,
      organisationId: outsiderOrganisationId,
      payload: { mbDate: '2026-08-05' },
    });
    expect(create.statusCode).toBe(404);
    expect(create.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });
  });

  it('assigned-scope members without the assignment get 404', async () => {
    const list = await authed(site, {
      method: 'GET',
      url: `/api/works/${work1Id}/measurement-books`,
      organisationId,
    });
    expect(list.statusCode).toBe(404);
    expect(list.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });

    const detail = await authed(site, {
      method: 'GET',
      url: `/api/measurement-books/${mb1Id}`,
      organisationId,
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });
  });
});

describe('export and timeline', () => {
  it('exports the measurement book sections under export-v5', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const exported = response.json<Record<string, unknown[]>>();
    expect(exported.formatVersion).toBe('export-v5');
    expect(exported.measurementBooks?.length).toBeGreaterThanOrEqual(6);
    expect(exported.measurementBookLines?.length).toBeGreaterThanOrEqual(5);
    expect(exported.mbSources?.length).toBeGreaterThanOrEqual(5);
  });

  it('surfaces measurement book events on the Work timeline', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/works/${work1Id}/timeline?entityTypes=measurement_books&limit=100`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const actions = response
      .json<{ events: { action: string }[] }>()
      .events.map((event) => event.action);
    for (const expected of [
      'measurement_book.created',
      'measurement_book.sources_updated',
      'measurement_book.finalized',
      'measurement_book.cancelled',
    ]) {
      expect(actions, actions.join(', ')).toContain(expected);
    }
  });
});
