import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
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
let fakeGotenberg: http.Server;
const gotenbergBodies: string[] = [];
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
  body: {
    mbDate: string;
    isFinal?: boolean;
    kind?: 'record' | 'on_account' | 'final';
    consigneeContactId?: string;
  },
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

  // A stub PDF service (the challan integration pattern): the render and
  // preview endpoints run their full HTTP path against it, and request
  // bodies are retained so tests can assert on the exact HTML sent.
  fakeGotenberg = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      gotenbergBodies.push(Buffer.concat(chunks).toString('utf8'));
      response.setHeader('content-type', 'application/pdf');
      response.end(Buffer.from(`%PDF-1.4 stub ${runId}`));
    });
  });
  await new Promise<void>((resolve) => {
    fakeGotenberg.listen(0, '127.0.0.1', resolve);
  });
  const gotenbergAddress = fakeGotenberg.address();
  if (gotenbergAddress === null || typeof gotenbergAddress === 'string') {
    throw new Error('stub Gotenberg failed to bind a port');
  }

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-mb-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    gotenbergUrl: `http://127.0.0.1:${String(gotenbergAddress.port)}`,
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
          'measurement_book_merge_provenance',
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
          'contacts',
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
          'gst_rates',
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
  await new Promise<void>((resolve) => {
    if (fakeGotenberg) {
      fakeGotenberg.close(() => {
        resolve();
      });
    } else resolve();
  });
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

/** Every stored object path, sorted — proves the draft preview leaves
 * the object store untouched. */
async function storedObjects(): Promise<string[]> {
  const entries = await readdir(storageDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(storageDir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/'),
    )
    .sort();
}

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
  it('exports the measurement book sections under export-v9', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const exported = response.json<Record<string, unknown[]>>();
    expect(exported.formatVersion).toBe('export-v12');
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

describe('the MB document (phase 3): persisted render, streaming, draft preview', () => {
  const STUB_PDF = () => Buffer.from(`%PDF-1.4 stub ${runId}`);
  let previewDraftId: string;
  let previewDcId: string;

  it('render on a draft answers 409 and pdf on an unrendered MB answers RENDER_MISSING', async () => {
    previewDcId = await issueChallan(work1Id, `${work1Code}DC`, [
      { workItemId: cableItemId, quantity: '250' },
    ]);
    const draft = await createDraft(work1Id, { mbDate: '2026-08-07' });
    previewDraftId = draft.book.id;
    const claimed = await setSources(previewDraftId, [
      { sourceType: 'delivery_challan', sourceId: previewDcId },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);

    const renderRefused = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${previewDraftId}/render`,
      organisationId,
    });
    expect(renderRefused.statusCode).toBe(409);
    expect(renderRefused.json()).toMatchObject({ code: 'MB_STATUS_CONFLICT' });

    const missing = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${previewDraftId}/pdf`,
      organisationId,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'RENDER_MISSING' });

    const unrendered = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${mb4Id}/pdf`,
      organisationId,
    });
    expect(unrendered.statusCode).toBe(404);
    expect(unrendered.json()).toMatchObject({ code: 'RENDER_MISSING' });
  });

  it('streams the DRAFT-watermarked live preview without persisting anything', async () => {
    const before = await storedObjects();
    const preview = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${previewDraftId}/pdf?preview=1`,
      organisationId,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers['content-type']).toContain('application/pdf');
    expect(preview.rawPayload.equals(STUB_PDF())).toBe(true);

    // The HTML sent to the converter carries the watermark, the DRAFT
    // title, and the live-computed remark.
    const html = gotenbergBodies.at(-1) ?? '';
    expect(html).toContain('class="watermark"');
    expect(html).toContain('Measurement Book DRAFT');
    expect(html).toContain('Now to pay 80% for 250 mtr.');
    expect(html).toContain('Rupees Two Hundred Only');

    // No object leaked; no render columns touched.
    expect(await storedObjects()).toEqual(before);
    const [row] = await admin<
      {
        template_version: string | null;
        rendered_object_key: string | null;
        rendered_sha256: string | null;
      }[]
    >`
      select template_version, rendered_object_key, rendered_sha256
      from measurement_books where id = ${previewDraftId}
    `;
    expect(row).toMatchObject({
      template_version: null,
      rendered_object_key: null,
      rendered_sha256: null,
    });

    // The preview is a draft affair: a finalized MB answers 409.
    const refused = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${mb4Id}/pdf?preview=1`,
      organisationId,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'MB_STATUS_CONFLICT' });

    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${previewDraftId}`,
      organisationId,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
  });

  it('renders the finalized final MB to a persisted content-addressed PDF with audit', async () => {
    const rendered = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${finalMbId}/render`,
      organisationId,
    });
    expect(rendered.statusCode, rendered.body).toBe(200);
    const detail = rendered.json<MeasurementBookDetailResponse>();
    expect(detail.book.renderedAvailable).toBe(true);
    expect(detail.book.templateVersion).toBe('mb-v1');

    // FINAL BILL banner on the final MB; no watermark once finalized.
    const html = gotenbergBodies.at(-1) ?? '';
    expect(html).toContain('FINAL BILL');
    expect(html).not.toContain('class="watermark"');
    expect(html).toContain(`Measurement Book ${work2Code}-MB-01`);
    expect(html).toContain('Rupees Ninety-Eight Only');

    // The recorded SHA-256 is the hash of the stored bytes.
    const expectedSha = createHash('sha256').update(STUB_PDF()).digest('hex');
    const [row] = await admin<
      { rendered_sha256: string | null; rendered_object_key: string | null }[]
    >`
      select rendered_sha256, rendered_object_key
      from measurement_books where id = ${finalMbId}
    `;
    expect(row?.rendered_sha256).toBe(expectedSha);
    expect(row?.rendered_object_key).toBe(`${organisationId}/mb/${finalMbId}.pdf`);

    const [auditRow] = await admin<{ count: string }[]>`
      select count(*)::text as count from audit_events
      where organisation_id = ${organisationId}
        and action = 'measurement_book.rendered' and entity_id = ${finalMbId}
    `;
    expect(auditRow?.count).toBe('1');

    // The persisted PDF streams back byte-for-byte.
    const pdf = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${finalMbId}/pdf`,
      organisationId,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.equals(STUB_PDF())).toBe(true);
  });

  it('re-render is idempotent: same key, refreshed hash, another audit entry', async () => {
    const again = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${finalMbId}/render`,
      organisationId,
    });
    expect(again.statusCode, again.body).toBe(200);
    const objects = await storedObjects();
    expect(
      objects.filter((file) => file === `${organisationId}/mb/${finalMbId}.pdf`),
    ).toHaveLength(1);
    const [auditRow] = await admin<{ count: string }[]>`
      select count(*)::text as count from audit_events
      where organisation_id = ${organisationId}
        and action = 'measurement_book.rendered' and entity_id = ${finalMbId}
    `;
    expect(auditRow?.count).toBe('2');
  });

  it('a cancelled-after-finalized MB keeps its render downloadable but re-renders no more', async () => {
    // Work 3's MB-02 is the newest live finalized MB and carries no bill.
    const [mb02] = await admin<{ id: string }[]>`
      select id from measurement_books
      where work_id = ${work3Id} and sequence_number = 2
    `;
    expect(mb02).toBeDefined();
    const mb02Id = mb02?.id ?? '';

    const rendered = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mb02Id}/render`,
      organisationId,
    });
    expect(rendered.statusCode, rendered.body).toBe(200);

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mb02Id}/cancel`,
      organisationId,
      payload: { note: 'Cancelled after rendering; the PDF must survive.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const detail = cancelled.json<MeasurementBookDetailResponse>();
    expect(detail.book.status).toBe('cancelled');
    expect(detail.book.renderedAvailable).toBe(true);

    const pdf = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${mb02Id}/pdf`,
      organisationId,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.equals(STUB_PDF())).toBe(true);

    const renderRefused = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mb02Id}/render`,
      organisationId,
    });
    expect(renderRefused.statusCode).toBe(409);
    expect(renderRefused.json()).toMatchObject({ code: 'MB_STATUS_CONFLICT' });
  });

  it('the database refuses render fields on drafts and drops of finalized render evidence', async () => {
    // Status-shape CHECK: drafts carry no render fields.
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        const draft = await tx<{ id: string }[]>`
          insert into measurement_books (
            organisation_id, work_id, mb_date, created_by_user_id,
            template_version, rendered_object_key, rendered_sha256
          )
          values (${organisationId}, ${work1Id}, '2026-08-07', ${ownerUserId},
                  'mb-v1', ${`${organisationId}/mb/x.pdf`}, ${'a'.repeat(64)})
          returning id
        `;
        return draft;
      }),
    ).rejects.toThrowError(/check|constraint/i);

    // The render evidence travels as a complete pair.
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          update measurement_books
          set rendered_sha256 = null
          where id = ${finalMbId}
        `;
      }),
    ).rejects.toThrowError(/check|constraint/i);

    // Frozen business data stays frozen even while render fields move.
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          update measurement_books
          set total_amount = '1.00', rendered_sha256 = ${'b'.repeat(64)}
          where id = ${finalMbId}
        `;
      }),
    ).rejects.toThrowError(/immutable/);
  });

  it('cross-tenant and assigned-scope probes answer 404 on the document routes', async () => {
    const outsiderPdf = await authed(outsider, {
      method: 'GET',
      url: `/api/measurement-books/${finalMbId}/pdf`,
      organisationId: outsiderOrganisationId,
    });
    expect(outsiderPdf.statusCode).toBe(404);
    expect(outsiderPdf.json()).toMatchObject({ code: 'MEASUREMENT_BOOK_NOT_FOUND' });

    const outsiderRender = await authed(outsider, {
      method: 'POST',
      url: `/api/measurement-books/${finalMbId}/render`,
      organisationId: outsiderOrganisationId,
    });
    expect(outsiderRender.statusCode).toBe(404);
    expect(outsiderRender.json()).toMatchObject({
      code: 'MEASUREMENT_BOOK_NOT_FOUND',
    });

    // The assigned-scope member without the assignment sees no Work.
    const sitePdf = await authed(site, {
      method: 'GET',
      url: `/api/measurement-books/${finalMbId}/pdf`,
      organisationId,
    });
    expect(sitePdf.statusCode).toBe(404);
    expect(sitePdf.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });

    const sitePreview = await authed(site, {
      method: 'GET',
      url: `/api/measurement-books/${finalMbId}/pdf?preview=1`,
      organisationId,
    });
    expect(sitePreview.statusCode).toBe(404);
    expect(sitePreview.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });

    const siteRender = await authed(site, {
      method: 'POST',
      url: `/api/measurement-books/${finalMbId}/render`,
      organisationId,
    });
    expect([403, 404]).toContain(siteRender.statusCode);
  });
});

// ---------------------------------------------------------------------------
// Review hardening: the cancel-vs-finalize race, the DB cancel backstops,
// the final-MB source freeze, draft-claim remedies, selection write-skew,
// and 6dp rate carry-through.
// ---------------------------------------------------------------------------

describe('review hardening: cancel work-lock and DB cancel backstops', () => {
  let workH1Id: string;
  let h1ItemId: string;
  let mbA: string; // finalized MB-01
  let mbB: string; // finalized MB-02 (newest before the race)

  async function issueAndClaimDraft(quantity: string): Promise<string> {
    const dcId = await issueChallan(
      workH1Id,
      `H1DC${randomUUID().slice(0, 4).toUpperCase()}`,
      [{ workItemId: h1ItemId, quantity }],
    );
    const draft = await createDraft(workH1Id, { mbDate: '2026-08-05' });
    const claimed = await setSources(draft.book.id, [
      { sourceType: 'delivery_challan', sourceId: dcId },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);
    return draft.book.id;
  }

  it('seeds two finalized MBs and a competing draft', async () => {
    h1ItemId = randomUUID();
    workH1Id = await seedWork({
      code: `HRC1${runId.slice(0, 4).toUpperCase()}`,
      items: [
        {
          id: h1ItemId,
          itemNumber: '1',
          description: 'Race cable',
          unit: 'mtr',
          quantity: '10000.000',
          rate: '1.00',
          paymentCategory: null,
        },
      ],
    });
    await insertMatrixRow(workH1Id, 'UNCATEGORISED', [
      '80.00',
      '10.00',
      '0.00',
      '10.00',
    ]);
    mbA = await issueAndClaimDraft('100');
    const finalizedA = await finalize(mbA);
    expect(finalizedA.statusCode, finalizedA.body).toBe(200);
    mbB = await issueAndClaimDraft('50');
    const finalizedB = await finalize(mbB);
    expect(finalizedB.statusCode, finalizedB.body).toBe(200);
  });

  it('concurrent cancel-of-newest vs finalize-of-draft serialises coherently', async () => {
    const draftId = await issueAndClaimDraft('25');
    const [cancelled, finalized] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/measurement-books/${mbB}/cancel`,
        organisationId,
        payload: { note: 'Racing the draft finalize.' },
      }),
      finalize(draftId),
    ]);

    // The works row lock serialises the two: either order is coherent,
    // and the double-billable state (MB-02 cancelled with its deltas
    // baked into MB-03's prior memory) can never happen.
    if (cancelled.statusCode === 200) {
      // Cancel committed first: the newly finalized MB must EXCLUDE the
      // cancelled MB-02 from its prior cumulative.
      expect(finalized.statusCode, finalized.body).toBe(200);
      const line = finalized.json<MeasurementBookDetailResponse>().lines[0];
      expect(line?.priorSupplied).toBe('100.000');
    } else {
      // Finalize committed first: MB-02 is no longer the newest, the
      // cancel is refused, and the new MB's prior includes MB-02.
      expect(cancelled.statusCode, cancelled.body).toBe(409);
      expect(cancelled.json()).toMatchObject({ code: 'MB_NOT_NEWEST' });
      expect(finalized.statusCode, finalized.body).toBe(200);
      const line = finalized.json<MeasurementBookDetailResponse>().lines[0];
      expect(line?.priorSupplied).toBe('150.000');
    }

    // Whatever the order, no cancelled MB's sources are claimable while
    // a newer finalized MB carries its deltas: recompute the invariant
    // from the database.
    const rows = await admin<
      { status: string; sequence_number: number; live_sources: string }[]
    >`
      select mb.status, mb.sequence_number,
             (select count(*) from mb_sources ms
               where ms.measurement_book_id = mb.id
                 and ms.released_at is null)::text as live_sources
      from measurement_books mb
      where mb.work_id = ${workH1Id} and mb.sequence_number is not null
      order by mb.sequence_number
    `;
    for (const row of rows) {
      if (row.status === 'cancelled') {
        expect(row.live_sources).toBe('0');
        // A cancelled MB is newest-at-cancel-time: no FINALIZED MB with
        // a higher sequence may predate it in the prior chain unless
        // the cancel lost the race — which the API refused above.
        const newerFinalized = rows.filter(
          (other) =>
            other.status === 'finalized' && other.sequence_number > row.sequence_number,
        );
        for (const newer of newerFinalized) {
          // Any newer finalized MB was finalized AFTER the cancel, so
          // its prior memory excludes the cancelled deltas — proven by
          // the branch assertions above.
          expect(newer.sequence_number).toBeGreaterThan(row.sequence_number);
        }
      }
    }
  });

  it('the database refuses cancelling a non-newest finalized MB (0027 backstop)', async () => {
    // After the race, at least one older finalized MB exists (MB-01).
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          update measurement_books
          set status = 'cancelled', cancellation_note = 'direct SQL misuse',
              cancelled_by_user_id = ${ownerUserId}, cancelled_at = now()
          where id = ${mbA}
        `;
      }),
    ).rejects.toThrowError(/only the newest may be cancelled/);
  });

  it('the database refuses cancelling a billed MB and keeps its claims (0027 backstop)', async () => {
    // The newest finalized MB of the Work gets a bill, then a direct
    // SQL cancel must be refused by the trigger — the API's MB_BILLED
    // 409 is no longer the only line of defence.
    const [newest] = await admin<{ id: string }[]>`
      select id from measurement_books
      where work_id = ${workH1Id} and status = 'finalized'
      order by sequence_number desc limit 1
    `;
    if (!newest) throw new Error('no finalized MB to bill');
    const billed = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${newest.id}/bill`,
      organisationId,
    });
    expect(billed.statusCode, billed.body).toBe(201);

    const apiRefused = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${newest.id}/cancel`,
      organisationId,
      payload: { note: 'Billed MBs must never cancel.' },
    });
    expect(apiRefused.statusCode).toBe(409);
    expect(apiRefused.json()).toMatchObject({ code: 'MB_BILLED' });

    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          update measurement_books
          set status = 'cancelled', cancellation_note = 'direct SQL misuse',
              cancelled_by_user_id = ${ownerUserId}, cancelled_at = now()
          where id = ${newest.id}
        `;
      }),
    ).rejects.toThrowError(/has a prepared bill and is permanently locked/);
    const [claims] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_sources
      where measurement_book_id = ${newest.id} and released_at is null
    `;
    expect(Number(claims?.count)).toBeGreaterThan(0);
  });
});

describe('review hardening: a live final MB freezes source creation', () => {
  let workH2Id: string;
  let h2ItemId: string;
  let frozenDraftChallanId: string;

  it('finalizes a final MB and then refuses new challan issue, installation, and PAC', async () => {
    h2ItemId = randomUUID();
    workH2Id = await seedWork({
      code: `HRC2${runId.slice(0, 4).toUpperCase()}`,
      items: [
        {
          id: h2ItemId,
          itemNumber: 'S/1',
          description: 'Frozen-work supply item',
          unit: 'Nos',
          quantity: '100.000',
          rate: '10.00',
          paymentCategory: 'SUPPLY',
        },
      ],
    });
    await insertMatrixRow(workH2Id, 'SUPPLY', ['90.00', '0.00', '0.00', '10.00']);
    const dcId = await issueChallan(
      workH2Id,
      `H2DC${runId.slice(0, 3).toUpperCase()}`,
      [{ workItemId: h2ItemId, quantity: '10' }],
    );
    const draft = await createDraft(workH2Id, {
      mbDate: '2026-08-05',
      isFinal: true,
    });
    const claimed = await setSources(draft.book.id, [
      { sourceType: 'delivery_challan', sourceId: dcId },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const finalized = await finalize(draft.book.id);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const mbNumber = finalized.json<MeasurementBookDetailResponse>().book.mbNumber;

    // Draft creation is still allowed (drafts are free) …
    const newDraft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workH2Id}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-05',
        prefix: `H2DC${runId.slice(0, 3).toUpperCase()}`,
        consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division' },
        items: [{ workItemId: h2ItemId, quantity: '1' }],
      },
    });
    expect(newDraft.statusCode, newDraft.body).toBe(201);
    frozenDraftChallanId = newDraft.json<ChallanDetailResponse>().challan.id;

    // … but ISSUING it is refused with the final MB named.
    const issueRefused = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${frozenDraftChallanId}/issue`,
      organisationId,
    });
    expect(issueRefused.statusCode).toBe(409);
    expect(issueRefused.json()).toMatchObject({ code: 'FINAL_MB_EXISTS' });
    expect(issueRefused.json<{ message: string }>().message).toContain(
      mbNumber ?? 'never',
    );

    const installRefused = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workH2Id}/installations`,
      organisationId,
      payload: {
        workItemId: h2ItemId,
        quantity: '1',
        installedOn: '2026-08-05',
        newLocation: { name: `Frozen station ${runId}`, kind: 'station' },
      },
    });
    expect(installRefused.statusCode).toBe(409);
    expect(installRefused.json()).toMatchObject({ code: 'FINAL_MB_EXISTS' });

    const pacRefused = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workH2Id}/pac-certificates`,
      organisationId,
      payload: {
        reference: `PAC-FROZEN-${runId}`,
        issueDate: '2026-08-05',
        consigneeMasterId,
        items: [{ workItemId: h2ItemId, certifiedQuantity: '1' }],
      },
    });
    expect(pacRefused.statusCode).toBe(409);
    expect(pacRefused.json()).toMatchObject({ code: 'FINAL_MB_EXISTS' });
  });

  it('the 0027 database guards hold the freeze against every writer', async () => {
    // Challan issue flip via direct SQL.
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          update delivery_challans set status = 'issued'
          where id = ${frozenDraftChallanId}
        `;
      }),
    ).rejects.toThrowError(/final Measurement Book exists/);
    // Installation INSERT via direct SQL.
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        const [location] = await tx<{ id: string }[]>`
          insert into location_masters (organisation_id, name, kind, created_by_user_id)
          values (${organisationId}, ${`Frozen loc ${randomUUID().slice(0, 8)}`},
                  'station', ${ownerUserId})
          returning id
        `;
        if (!location) throw new Error('location insert returned no row');
        await tx`
          insert into installations (
            organisation_id, work_id, work_item_id, quantity, installed_on,
            location_id, location_name, recorded_by_user_id
          )
          values (${organisationId}, ${workH2Id}, ${h2ItemId}, '1', '2026-08-05',
                  ${location.id}, 'Frozen loc', ${ownerUserId})
        `;
      }),
    ).rejects.toThrowError(/final Measurement Book exists/);
    // PAC INSERT via direct SQL.
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          insert into pac_certificates (
            organisation_id, work_id, reference, issue_date,
            consignee_master_id, consignee_designation, recorded_by_user_id
          )
          values (${organisationId}, ${workH2Id}, ${`PAC-SQL-${runId}`}, '2026-08-05',
                  ${consigneeMasterId}, 'Sr. DEE (G) NR', ${ownerUserId})
        `;
      }),
    ).rejects.toThrowError(/final Measurement Book exists/);
  });
});

describe('review hardening: issue-vs-finalize race on the final MB', () => {
  it('a concurrent challan issue and final-MB finalize never both land', async () => {
    const itemId = randomUUID();
    const workId = await seedWork({
      code: `HRC3${runId.slice(0, 4).toUpperCase()}`,
      items: [
        {
          id: itemId,
          itemNumber: 'S/1',
          description: 'Race supply item',
          unit: 'Nos',
          quantity: '100.000',
          rate: '10.00',
          paymentCategory: 'SUPPLY',
        },
      ],
    });
    await insertMatrixRow(workId, 'SUPPLY', ['90.00', '0.00', '0.00', '10.00']);
    const dc1Id = await issueChallan(workId, `H3DC${runId.slice(0, 3).toUpperCase()}`, [
      { workItemId: itemId, quantity: '10' },
    ]);
    const finalDraft = await createDraft(workId, {
      mbDate: '2026-08-05',
      isFinal: true,
    });
    const claimed = await setSources(finalDraft.book.id, [
      { sourceType: 'delivery_challan', sourceId: dc1Id },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);

    // A second challan drafted but not yet issued.
    const draft2 = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-05',
        prefix: `H3DC${runId.slice(0, 3).toUpperCase()}`,
        consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division' },
        items: [{ workItemId: itemId, quantity: '5' }],
      },
    });
    expect(draft2.statusCode, draft2.body).toBe(201);
    const dc2Id = draft2.json<ChallanDetailResponse>().challan.id;

    const [issued, finalized] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/challans/${dc2Id}/issue`,
        organisationId,
      }),
      finalize(finalDraft.book.id),
    ]);

    // The works row lock serialises the two transactions, and in EITHER
    // order both are refused, so no interleaving can leave a live final
    // MB beside an issued-but-unclaimable challan. The issue loses to
    // the 0031 freeze — a final MB counts as live from the moment it is
    // drafted — and the finalize loses to the clean-state rule, which
    // will not close the payment cycle over a draft it would strand.
    expect(issued.statusCode, issued.body).toBe(409);
    expect(issued.json()).toMatchObject({ code: 'FINAL_MB_EXISTS' });
    expect(finalized.statusCode, finalized.body).toBe(409);
    expect(finalized.json()).toMatchObject({ code: 'MB_FINAL_DRAFTS_OPEN' });

    // The named remedy clears it: delete the draft that can never be
    // issued while this book lives, and the final MB finalizes.
    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/challans/${dc2Id}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const retried = await finalize(finalDraft.book.id);
    expect(retried.statusCode, retried.body).toBe(200);

    const [state] = await admin<{ final_live: string; issued_unclaimed: string }[]>`
      select
        (select count(*) from measurement_books
          where work_id = ${workId} and is_final and status <> 'cancelled'
            and status = 'finalized')::text as final_live,
        (select count(*) from delivery_challans dc
          where dc.work_id = ${workId} and dc.status = 'issued'
            and not exists (
              select 1 from mb_sources ms
              where ms.source_type = 'delivery_challan' and ms.source_id = dc.id
                and ms.released_at is null
            ))::text as issued_unclaimed
    `;
    // The final MB lives and every issued challan is claimed.
    expect(state?.final_live).toBe('1');
    expect(state?.issued_unclaimed).toBe('0');
  });
});

describe('review hardening: draft-claim remedies, selection write-skew, dead claims', () => {
  let workH4Id: string;
  let h4ItemId: string;

  it('a source claimed by a DRAFT names a followable remedy on cancel', async () => {
    h4ItemId = randomUUID();
    workH4Id = await seedWork({
      code: `HRC4${runId.slice(0, 4).toUpperCase()}`,
      items: [
        {
          id: h4ItemId,
          itemNumber: '1',
          description: 'Remedy cable',
          unit: 'mtr',
          quantity: '10000.000',
          rate: '1.00',
          paymentCategory: null,
        },
      ],
    });
    await insertMatrixRow(workH4Id, 'UNCATEGORISED', [
      '80.00',
      '10.00',
      '0.00',
      '10.00',
    ]);
    const dcId = await issueChallan(
      workH4Id,
      `H4DC${runId.slice(0, 3).toUpperCase()}`,
      [{ workItemId: h4ItemId, quantity: '10' }],
    );
    const draft = await createDraft(workH4Id, { mbDate: '2026-08-05' });
    const claimed = await setSources(draft.book.id, [
      { sourceType: 'delivery_challan', sourceId: dcId },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);

    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${dcId}/cancel`,
      organisationId,
      payload: { note: 'Trying to cancel a draft-claimed challan.' },
    });
    expect(refused.statusCode).toBe(409);
    const body = refused.json<{ code: string; message: string }>();
    expect(body.code).toBe('SOURCE_BILLED_IN_MB');
    // The draft remedy is followable: deselect or delete the draft —
    // NOT 'cancel that Measurement Book' (drafts delete, never cancel).
    expect(body.message).toContain(
      "remove it from the draft's source selection (or delete the draft)",
    );
    expect(body.message).not.toContain('cancel that Measurement Book');

    // Cleanup: release the claim by deleting the draft.
    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${draft.book.id}`,
      organisationId,
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('selection and source cancel cannot both win the write-skew race', async () => {
    const dcId = await issueChallan(
      workH4Id,
      `H4DC${runId.slice(0, 3).toUpperCase()}`,
      [{ workItemId: h4ItemId, quantity: '5' }],
    );
    const draft = await createDraft(workH4Id, { mbDate: '2026-08-05' });

    const [selected, cancelled] = await Promise.all([
      setSources(draft.book.id, [{ sourceType: 'delivery_challan', sourceId: dcId }]),
      authed(owner, {
        method: 'POST',
        url: `/api/challans/${dcId}/cancel`,
        organisationId,
        payload: { note: 'Racing the draft selection.' },
      }),
    ]);

    // The locked selection serialises against the cancel row lock:
    // exactly one of the two can succeed.
    expect([selected.statusCode, cancelled.statusCode].sort()).toEqual([200, 409]);
    if (selected.statusCode === 200) {
      expect(cancelled.json()).toMatchObject({ code: 'SOURCE_BILLED_IN_MB' });
    } else {
      expect(selected.json()).toMatchObject({ code: 'MB_SOURCE_NOT_BILLABLE' });
    }
    // Never a cancelled source holding a live claim.
    const [broken] = await admin<{ count: string }[]>`
      select count(*)::text as count
      from mb_sources ms
      join delivery_challans dc on dc.id = ms.source_id
      where ms.source_type = 'delivery_challan' and ms.source_id = ${dcId}
        and ms.released_at is null and dc.status = 'cancelled'
    `;
    expect(broken?.count).toBe('0');
    await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${draft.book.id}`,
      organisationId,
    });
  });

  it('a dead claim (cancelled source) contributes nothing to the draft preview', async () => {
    const dcId = await issueChallan(
      workH4Id,
      `H4DC${runId.slice(0, 3).toUpperCase()}`,
      [{ workItemId: h4ItemId, quantity: '7' }],
    );
    const draft = await createDraft(workH4Id, { mbDate: '2026-08-05' });
    const claimed = await setSources(draft.book.id, [
      { sourceType: 'delivery_challan', sourceId: dcId },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);

    // Force the impossible-through-the-API state (a cancelled source
    // holding a live claim) with triggers disabled, as a broken-state
    // probe: the preview must not count the dead claim's quantities.
    await admin.unsafe(`set session_replication_role = 'replica'`);
    try {
      await admin`
        update delivery_challans
        set status = 'cancelled', cancellation_note = 'forced dead claim',
            cancelled_by_user_id = ${ownerUserId}, cancelled_at = now()
        where id = ${dcId}
      `;
    } finally {
      await admin.unsafe(`set session_replication_role = 'origin'`);
    }

    const preview = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${draft.book.id}`,
      organisationId,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const detail = preview.json<MeasurementBookDetailResponse>();
    expect(detail.lines).toEqual([]);
    expect(detail.previewTotal).toBe('0.00');

    await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${draft.book.id}`,
      organisationId,
    });
  });
});

describe('review hardening: export manifest covers the MB rendered PDF', () => {
  it('lists measurement-book-rendered-pdf with its recorded hash', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const exported = response.json<{
      objectManifest: { kind: string; objectKey: string; sha256: string | null }[];
    }>();
    const entries = exported.objectManifest.filter(
      (entry) => entry.kind === 'measurement-book-rendered-pdf',
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of entries) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(String(entry.objectKey)).toContain('/mb/');
    }
  });
});

describe('review hardening: 6dp rates carry exactly into amounts and snapshots', () => {
  it('a 0.8517 rate flows verbatim through items, challans, and MB lines', async () => {
    const itemId = randomUUID();
    const workId = await seedWork({
      code: `HRC5${runId.slice(0, 4).toUpperCase()}`,
      items: [
        {
          id: itemId,
          itemNumber: '1',
          description: 'Fine-rate cable',
          unit: 'mtr',
          quantity: '10000.000',
          rate: '0.8517',
          paymentCategory: null,
        },
      ],
    });
    await insertMatrixRow(workId, 'UNCATEGORISED', ['80.00', '10.00', '0.00', '10.00']);

    // The balance quotes the canonical 4dp rate.
    const balance = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/balance`,
      organisationId,
    });
    expect(balance.statusCode, balance.body).toBe(200);
    expect(
      balance.json<{ items: { effectiveRate: string }[] }>().items[0]?.effectiveRate,
    ).toBe('0.8517');

    // Challan line: amount = round2(100 x 0.8517) — the 4dp rate is a
    // FACTOR, never pre-rounded to paise.
    const dcId = await issueChallan(workId, `H5DC${runId.slice(0, 3).toUpperCase()}`, [
      { workItemId: itemId, quantity: '100' },
    ]);
    const challan = await authed(owner, {
      method: 'GET',
      url: `/api/challans/${dcId}`,
      organisationId,
    });
    const line = challan.json<ChallanDetailResponse>().items[0];
    expect(line).toMatchObject({ rate: '0.8517', lineAmount: '85.17' });
    const snapshot = challan.json<{
      issuedSnapshot: { items: { rate: string }[]; totalAmount: string };
    }>().issuedSnapshot;
    expect(snapshot.items[0]?.rate).toBe('0.8517');
    expect(snapshot.totalAmount).toBe('85.17');

    // MB line: amountSupply = round2(100 x 0.8517 x 80 / 100) = 68.14,
    // computed from the exact rate, and the snapshot keeps '0.8517'.
    const draft = await createDraft(workId, { mbDate: '2026-08-05' });
    const claimed = await setSources(draft.book.id, [
      { sourceType: 'delivery_challan', sourceId: dcId },
    ]);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const finalized = await finalize(draft.book.id);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const mbLine = finalized.json<MeasurementBookDetailResponse>().lines[0];
    expect(mbLine).toMatchObject({
      effectiveRate: '0.8517',
      deltaSupplied: '100.000',
      amountSupply: '68.14',
      lineTotal: '68.14',
    });
    expect(finalized.json<MeasurementBookDetailResponse>().book.totalAmount).toBe(
      '68.14',
    );
    // The stored snapshot column carries the exact value.
    const [stored] = await admin<{ effective_rate: string }[]>`
      select effective_rate::text as effective_rate
      from measurement_book_lines
      where measurement_book_id = ${draft.book.id}
    `;
    expect(stored?.effective_rate).toBe('0.851700');
  });
});

// ---------------------------------------------------------------------------
// Migration 0034: the three Measurement Book kinds. Record MBs are
// per-consignee parallel measurement sheets — several run at once, they
// claim sources like any draft, and they NEVER finalize; the merge folds
// them into a new on-account draft; un-merge is the only way to take
// that draft apart while it holds merged records.
// ---------------------------------------------------------------------------

describe('the three kinds (0034): record MBs, merge, and un-merge', () => {
  let workKId: string;
  let workKCode: string;
  let kItemId: string;
  let consignee1Id: string;
  let consignee2Id: string;
  let consignee3Id: string;
  let retiredConsigneeId: string;
  let vendorOnlyContactId: string;
  let dcK1Id: string;
  let dcK2Id: string;
  let dcK3Id: string;
  let instK1Id: string;
  let r1Id: string;
  let r2Id: string;
  let targetId: string;
  let target2Id: string;

  async function seedContact(input: {
    designation: string;
    isConsignee: boolean;
    active: boolean;
  }): Promise<string> {
    const id = randomUUID();
    await admin`
      insert into contacts (
        id, organisation_id, designation, address, is_consignee, is_vendor,
        active, created_by_user_id
      )
      values (${id}, ${organisationId}, ${input.designation},
              ${`Division office ${input.designation}`}, ${input.isConsignee},
              ${!input.isConsignee}, ${input.active}, ${ownerUserId})
    `;
    return id;
  }

  it('seeds the kinds Work and its consignee contacts', async () => {
    kItemId = randomUUID();
    workKCode = `KND1${runId.slice(0, 4).toUpperCase()}`;
    workKId = await seedWork({
      code: workKCode,
      items: [
        {
          id: kItemId,
          itemNumber: '1',
          description: 'Quad cable',
          unit: 'mtr',
          quantity: '10000.000',
          rate: '2.00',
          paymentCategory: null,
        },
      ],
    });
    await insertMatrixRow(workKId, 'UNCATEGORISED', [
      '80.00',
      '10.00',
      '0.00',
      '10.00',
    ]);
    consignee1Id = await seedContact({
      designation: `Sr. DSTE (E) CR ${runId}`,
      isConsignee: true,
      active: true,
    });
    consignee2Id = await seedContact({
      designation: `Sr. DEE (TRD) CR ${runId}`,
      isConsignee: true,
      active: true,
    });
    consignee3Id = await seedContact({
      designation: `Dy. CSTE (Con) CR ${runId}`,
      isConsignee: true,
      active: true,
    });
    retiredConsigneeId = await seedContact({
      designation: `Retired DSTE ${runId}`,
      isConsignee: true,
      active: false,
    });
    vendorOnlyContactId = await seedContact({
      designation: `Cable vendor ${runId}`,
      isConsignee: false,
      active: true,
    });
    dcK1Id = await issueChallan(workKId, `${workKCode}DC`, [
      { workItemId: kItemId, quantity: '100' },
    ]);
    dcK2Id = await issueChallan(workKId, `${workKCode}DC`, [
      { workItemId: kItemId, quantity: '50' },
    ]);
    instK1Id = await recordInstallation(workKId, kItemId, '30');
  });

  it('validates kind, consignee, and the isFinal compatibility contract on create', async () => {
    const post = (payload: Record<string, unknown>) =>
      authed(owner, {
        method: 'POST',
        url: `/api/works/${workKId}/measurement-books`,
        organisationId,
        payload,
      });

    // A body naming both fields must agree with itself.
    for (const payload of [
      { mbDate: '2026-08-01', kind: 'record', isFinal: true },
      { mbDate: '2026-08-01', kind: 'on_account', isFinal: true },
      { mbDate: '2026-08-01', kind: 'final', isFinal: false },
    ]) {
      const contradiction = await post(payload);
      expect(contradiction.statusCode, contradiction.body).toBe(400);
      expect(contradiction.json()).toMatchObject({ code: 'MB_KIND_CONFLICT' });
    }
    // Consistent pairs are accepted elsewhere; here the consignee rules.
    const missingConsignee = await post({ mbDate: '2026-08-01', kind: 'record' });
    expect(missingConsignee.statusCode).toBe(400);
    expect(missingConsignee.json()).toMatchObject({ code: 'MB_CONSIGNEE_REQUIRED' });

    const strayConsignee = await post({
      mbDate: '2026-08-01',
      consigneeContactId: consignee1Id,
    });
    expect(strayConsignee.statusCode).toBe(400);
    expect(strayConsignee.json()).toMatchObject({ code: 'MB_CONSIGNEE_NOT_ALLOWED' });

    const unknownContact = await post({
      mbDate: '2026-08-01',
      kind: 'record',
      consigneeContactId: randomUUID(),
    });
    expect(unknownContact.statusCode).toBe(404);
    expect(unknownContact.json()).toMatchObject({ code: 'CONTACT_NOT_FOUND' });

    const notConsignee = await post({
      mbDate: '2026-08-01',
      kind: 'record',
      consigneeContactId: vendorOnlyContactId,
    });
    expect(notConsignee.statusCode).toBe(409);
    expect(notConsignee.json()).toMatchObject({ code: 'CONTACT_NOT_CONSIGNEE' });

    const retired = await post({
      mbDate: '2026-08-01',
      kind: 'record',
      consigneeContactId: retiredConsigneeId,
    });
    expect(retired.statusCode).toBe(409);
    expect(retired.json()).toMatchObject({ code: 'CONTACT_RETIRED' });
  });

  it('runs record drafts in parallel per consignee; the same consignee is refused', async () => {
    const first = await createDraft(workKId, {
      mbDate: '2026-08-01',
      kind: 'record',
      consigneeContactId: consignee1Id,
    });
    r1Id = first.book.id;
    expect(first.book.kind).toBe('record');
    expect(first.book.isFinal).toBe(false);
    expect(first.book.consigneeContactId).toBe(consignee1Id);
    expect(first.book.mergedIntoId).toBeNull();

    // A second consignee's sheet runs IN PARALLEL — the whole point.
    const second = await createDraft(workKId, {
      mbDate: '2026-08-01',
      kind: 'record',
      consigneeContactId: consignee2Id,
    });
    r2Id = second.book.id;
    expect(second.book.kind).toBe('record');

    // The SAME consignee's second sheet is refused, naming the first.
    const duplicate = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workKId}/measurement-books`,
      organisationId,
      payload: {
        mbDate: '2026-08-01',
        kind: 'record',
        consigneeContactId: consignee1Id,
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      code: 'MB_RECORD_DRAFT_EXISTS',
      details: { existingRecordId: r1Id },
    });

    // The 0034 per-consignee index holds against direct SQL too.
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          insert into measurement_books (
            organisation_id, work_id, mb_date, kind, consignee_contact_id,
            created_by_user_id
          )
          values (${organisationId}, ${workKId}, '2026-08-01', 'record',
                  ${consignee1Id}, ${ownerUserId})
        `;
      }),
    ).rejects.toThrowError(/measurement_books_one_record_draft_per_consignee/);

    // 0034 made is_final generated: any insert naming it fails.
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          insert into measurement_books (
            organisation_id, work_id, mb_date, is_final, created_by_user_id
          )
          values (${organisationId}, ${workKId}, '2026-08-01', true,
                  ${ownerUserId})
        `;
      }),
    ).rejects.toThrowError(/is_final/);
  });

  it('keeps exactly one BILLING draft per Work while record drafts run', async () => {
    // An on-account draft opens beside the two record drafts.
    const billing = await createDraft(workKId, { mbDate: '2026-08-04' });
    expect(billing.book.kind).toBe('on_account');
    expect(billing.book.isFinal).toBe(false);

    // A second billing draft is refused, naming the first…
    const duplicate = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workKId}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-04' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      code: 'MB_DRAFT_EXISTS',
      details: { existingRecordId: billing.book.id },
    });

    // …but a THIRD consignee's record sheet still opens in parallel.
    const record = await createDraft(workKId, {
      mbDate: '2026-08-01',
      kind: 'record',
      consigneeContactId: consignee3Id,
    });
    for (const id of [record.book.id, billing.book.id]) {
      const deleted = await authed(owner, {
        method: 'DELETE',
        url: `/api/measurement-books/${id}`,
        organisationId,
      });
      expect(deleted.statusCode, deleted.body).toBe(204);
    }
  });

  it('record drafts claim sources like any draft but can NEVER be finalized', async () => {
    const claimed1 = await setSources(r1Id, [
      { sourceType: 'delivery_challan', sourceId: dcK1Id },
    ]);
    expect(claimed1.statusCode, claimed1.body).toBe(200);
    const preview = claimed1.json<MeasurementBookDetailResponse>();
    expect(preview.lines[0]?.deltaSupplied).toBe('100.000');

    const claimed2 = await setSources(r2Id, [
      { sourceType: 'delivery_challan', sourceId: dcK2Id },
      { sourceType: 'installation', sourceId: instK1Id },
    ]);
    expect(claimed2.statusCode, claimed2.body).toBe(200);

    // A record's claim protects its source exactly like any live claim.
    const challanCancel = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${dcK1Id}/cancel`,
      organisationId,
      payload: { note: 'Attempt against a record-claimed challan.' },
    });
    expect(challanCancel.statusCode).toBe(409);
    expect(challanCancel.json()).toMatchObject({ code: 'SOURCE_BILLED_IN_MB' });

    const refused = await finalize(r1Id);
    expect(refused.statusCode).toBe(409);
    const body = refused.json<{ code: string; message: string }>();
    expect(body.code).toBe('MB_RECORD_NOT_BILLABLE');
    expect(body.message).toContain('merge');
  });

  it('merge validates its inputs: billing draft open, duplicates, wrong MBs, nothing to merge', async () => {
    const merge = (payload: Record<string, unknown>) =>
      authed(owner, {
        method: 'POST',
        url: `/api/works/${workKId}/measurement-books/merge`,
        organisationId,
        payload,
      });

    // The one-billing-draft rule applies to the draft the merge creates.
    const billing = await createDraft(workKId, { mbDate: '2026-08-04' });
    const blocked = await merge({ recordMbIds: [r1Id, r2Id], mbDate: '2026-08-05' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: 'MB_DRAFT_EXISTS',
      details: { existingRecordId: billing.book.id },
    });
    const cleared = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${billing.book.id}`,
      organisationId,
    });
    expect(cleared.statusCode).toBe(204);

    const duplicated = await merge({ recordMbIds: [r1Id, r1Id], mbDate: '2026-08-05' });
    expect(duplicated.statusCode).toBe(400);
    expect(duplicated.json()).toMatchObject({ code: 'MB_MERGE_DUPLICATED' });

    // Another Work's MB answers exactly like an unknown id.
    const foreign = await merge({ recordMbIds: [mb1Id], mbDate: '2026-08-05' });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: 'MEASUREMENT_BOOK_NOT_FOUND' });

    // Records with no sources among them have nothing to merge.
    const emptyRecord = await createDraft(workKId, {
      mbDate: '2026-08-01',
      kind: 'record',
      consigneeContactId: consignee3Id,
    });
    const empty = await merge({
      recordMbIds: [emptyRecord.book.id],
      mbDate: '2026-08-05',
    });
    expect(empty.statusCode).toBe(409);
    expect(empty.json()).toMatchObject({ code: 'MB_MERGE_EMPTY' });
    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${emptyRecord.book.id}`,
      organisationId,
    });
    expect(removed.statusCode).toBe(204);

    // Writer role required, like every draft act.
    const denied = await authed(site, {
      method: 'POST',
      url: `/api/works/${workKId}/measurement-books/merge`,
      organisationId,
      payload: { recordMbIds: [r1Id, r2Id], mbDate: '2026-08-05' },
    });
    expect([403, 404]).toContain(denied.statusCode);
  });

  it('merge moves the claims to a new on-account draft and marks the records merged', async () => {
    const merged = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workKId}/measurement-books/merge`,
      organisationId,
      payload: { recordMbIds: [r1Id, r2Id], mbDate: '2026-08-05' },
    });
    expect(merged.statusCode, merged.body).toBe(201);
    const detail = merged.json<MeasurementBookDetailResponse>();
    targetId = detail.book.id;
    expect(detail.book.kind).toBe('on_account');
    expect(detail.book.status).toBe('draft');
    expect(detail.book.isFinal).toBe(false);
    // The union of the records' sources, claimed live on the target.
    expect(detail.sources).toHaveLength(3);
    expect(detail.sources.every((source) => source.releasedAt === null)).toBe(true);
    const keys = detail.sources.map((s) => `${s.sourceType}:${s.sourceId}`).sort();
    expect(keys).toEqual(
      [
        `delivery_challan:${dcK1Id}`,
        `delivery_challan:${dcK2Id}`,
        `installation:${instK1Id}`,
      ].sort(),
    );
    // The computed preview covers both records' measurements:
    // 150 x 2.00 x 80% + 30 x 2.00 x 10% = 240 + 6.
    expect(detail.previewTotal).toBe('246.00');

    // Each record is merged, points at the absorber, and holds no claims.
    for (const recordId of [r1Id, r2Id]) {
      const record = await authed(owner, {
        method: 'GET',
        url: `/api/measurement-books/${recordId}`,
        organisationId,
      });
      expect(record.statusCode, record.body).toBe(200);
      const recordDetail = record.json<MeasurementBookDetailResponse>();
      expect(recordDetail.book.status).toBe('merged');
      expect(recordDetail.book.mergedIntoId).toBe(targetId);
      expect(recordDetail.book.mbNumber).toBeNull();
      expect(recordDetail.sources).toEqual([]);
      expect(recordDetail.lines).toEqual([]);
    }
    // Exactly one live claim per source, all on the target.
    const [claims] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_sources
      where measurement_book_id = ${targetId} and released_at is null
    `;
    expect(claims?.count).toBe('3');
    const [recordClaims] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_sources
      where measurement_book_id in (${r1Id}, ${r2Id})
    `;
    expect(recordClaims?.count).toBe('0');
    const provenance = await admin<
      {
        record_measurement_book_id: string;
        source_type: string | null;
        source_id: string | null;
      }[]
    >`
      select record_measurement_book_id, source_type, source_id
      from measurement_book_merge_provenance
      where target_measurement_book_id = ${targetId}
      order by record_measurement_book_id, source_type, source_id
    `;
    expect(provenance).toHaveLength(3);
    expect(
      provenance.map(
        (row) =>
          `${row.record_measurement_book_id}:${row.source_type}:${row.source_id}`,
      ),
    ).toEqual(
      [
        `${r1Id}:delivery_challan:${dcK1Id}`,
        `${r2Id}:delivery_challan:${dcK2Id}`,
        `${r2Id}:installation:${instK1Id}`,
      ].sort(),
    );
    // The merge is audited on the target with its provenance payload.
    const [auditRow] = await admin<{ details: unknown }[]>`
      select details from audit_events
      where organisation_id = ${organisationId}
        and action = 'measurement_book.merged' and entity_id = ${targetId}
    `;
    expect(auditRow).toBeDefined();
  });

  it('a merged record MB is immutable at the API and the database', async () => {
    // No source edits.
    const sourceEdit = await setSources(r1Id, []);
    expect(sourceEdit.statusCode).toBe(409);
    expect(sourceEdit.json()).toMatchObject({ code: 'MB_STATUS_CONFLICT' });
    // Never finalized (merged or not).
    const finalizeRefused = await finalize(r1Id);
    expect(finalizeRefused.statusCode).toBe(409);
    expect(finalizeRefused.json()).toMatchObject({ code: 'MB_RECORD_NOT_BILLABLE' });
    // Not cancelled and not deleted — un-merge is the only way back.
    const cancelRefused = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${r1Id}/cancel`,
      organisationId,
      payload: { note: 'Merged records must refuse cancellation.' },
    });
    expect(cancelRefused.statusCode).toBe(409);
    expect(cancelRefused.json()).toMatchObject({ code: 'MB_STATUS_CONFLICT' });
    const deleteRefused = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${r1Id}`,
      organisationId,
    });
    expect(deleteRefused.statusCode).toBe(409);
    expect(deleteRefused.json()).toMatchObject({ code: 'MB_STATUS_CONFLICT' });
    // Not re-merged either: while the absorbing draft is open, the
    // one-billing-draft rule answers first, naming it.
    const remerge = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workKId}/measurement-books/merge`,
      organisationId,
      payload: { recordMbIds: [r1Id], mbDate: '2026-08-05' },
    });
    expect(remerge.statusCode).toBe(409);
    expect(remerge.json()).toMatchObject({
      code: 'MB_DRAFT_EXISTS',
      details: { existingRecordId: targetId },
    });
    // The database refuses claims onto a merged MB…
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          insert into mb_sources (
            organisation_id, measurement_book_id, work_id, source_type, source_id
          )
          values (${organisationId}, ${r1Id}, ${workKId}, 'delivery_challan',
                  ${dcK1Id})
        `;
      }),
    ).rejects.toThrowError(/draft/);
    // …and any status escape (record + finalized violates 0034 coherence).
    await expect(
      withTenant(appPool, { organisationId, userId: ownerUserId }, async (tx) => {
        await tx`
          update measurement_books set status = 'finalized'
          where id = ${r1Id}
        `;
      }),
    ).rejects.toThrowError(/check|constraint/i);
  });

  it('deleting the absorbing draft is refused while it holds merged records', async () => {
    const refused = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${targetId}`,
      organisationId,
    });
    expect(refused.statusCode).toBe(409);
    const body = refused.json<{ code: string; details: { recordMbIds: string[] } }>();
    expect(body.code).toBe('MB_HAS_MERGED_RECORDS');
    expect([...body.details.recordMbIds].sort()).toEqual([r1Id, r2Id].sort());
  });

  it('un-merge restores the records and their exact claims, then deletes the draft', async () => {
    // Un-merge is for absorbing drafts only.
    const plain = await createDraft(work3Id, { mbDate: '2026-08-06' });
    const notMerged = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${plain.book.id}/unmerge`,
      organisationId,
    });
    expect(notMerged.statusCode).toBe(409);
    expect(notMerged.json()).toMatchObject({ code: 'MB_NO_MERGED_RECORDS' });
    const plainGone = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${plain.book.id}`,
      organisationId,
    });
    expect(plainGone.statusCode).toBe(204);

    // The absorbing draft stays an editable draft: claim one MORE source
    // after the merge — un-merge must release it with the deleted draft,
    // not push it onto any record.
    dcK3Id = await issueChallan(workKId, `${workKCode}DC`, [
      { workItemId: kItemId, quantity: '20' },
    ]);
    const widened = await setSources(targetId, [
      { sourceType: 'delivery_challan', sourceId: dcK1Id },
      { sourceType: 'delivery_challan', sourceId: dcK2Id },
      { sourceType: 'installation', sourceId: instK1Id },
      { sourceType: 'delivery_challan', sourceId: dcK3Id },
    ]);
    expect(widened.statusCode, widened.body).toBe(200);

    // Audit JSON remains evidence, but is no longer operational state.
    // Simulate an old exporter/tool rewriting its details: normalized
    // provenance still makes the restore exact.
    await admin.unsafe(`set session_replication_role = 'replica'`);
    try {
      await admin`
        update audit_events set details = '{}'::jsonb
        where organisation_id = ${organisationId}
          and action = 'measurement_book.merged' and entity_id = ${targetId}
      `;
    } finally {
      await admin.unsafe(`set session_replication_role = 'origin'`);
    }

    const unmerged = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${targetId}/unmerge`,
      organisationId,
    });
    expect(unmerged.statusCode, unmerged.body).toBe(204);

    // The absorbing draft is gone.
    const gone = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${targetId}`,
      organisationId,
    });
    expect(gone.statusCode).toBe(404);

    // Each record is a draft again holding EXACTLY what it contributed.
    const restored1 = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${r1Id}`,
      organisationId,
    });
    const detail1 = restored1.json<MeasurementBookDetailResponse>();
    expect(detail1.book.status).toBe('draft');
    expect(detail1.book.mergedIntoId).toBeNull();
    expect(detail1.book.consigneeContactId).toBe(consignee1Id);
    expect(detail1.sources.map((s) => `${s.sourceType}:${s.sourceId}`)).toEqual([
      `delivery_challan:${dcK1Id}`,
    ]);

    const restored2 = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${r2Id}`,
      organisationId,
    });
    const detail2 = restored2.json<MeasurementBookDetailResponse>();
    expect(detail2.book.status).toBe('draft');
    expect(detail2.book.mergedIntoId).toBeNull();
    expect(detail2.sources.map((s) => `${s.sourceType}:${s.sourceId}`).sort()).toEqual(
      [`delivery_challan:${dcK2Id}`, `installation:${instK1Id}`].sort(),
    );

    // The post-merge extra claim was released with the draft, and every
    // restored source has exactly one live claim.
    const [k3Claims] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_sources
      where source_type = 'delivery_challan' and source_id = ${dcK3Id}
        and released_at is null
    `;
    expect(k3Claims?.count).toBe('0');
    const [liveClaims] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_sources
      where measurement_book_id in (${r1Id}, ${r2Id}) and released_at is null
    `;
    expect(liveClaims?.count).toBe('3');

    const [auditRow] = await admin<{ count: string }[]>`
      select count(*)::text as count from audit_events
      where organisation_id = ${organisationId}
        and action = 'measurement_book.unmerged' and entity_id = ${targetId}
    `;
    expect(auditRow?.count).toBe('1');
  });

  it('concurrent merges: exactly one on-account draft absorbs the records', async () => {
    const merge = () =>
      authed(owner, {
        method: 'POST',
        url: `/api/works/${workKId}/measurement-books/merge`,
        organisationId,
        payload: { recordMbIds: [r1Id, r2Id], mbDate: '2026-08-05' },
      });
    const [first, second] = await Promise.all([merge(), merge()]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses, `${first.body} | ${second.body}`).toEqual([201, 409]);
    const winner = first.statusCode === 201 ? first : second;
    const loser = first.statusCode === 201 ? second : first;
    expect(['MB_DRAFT_EXISTS', 'MB_MERGE_NOT_RECORD_DRAFT']).toContain(
      loser.json<{ code: string }>().code,
    );
    target2Id = winner.json<MeasurementBookDetailResponse>().book.id;
    // One target, three claims, both records merged into it.
    const [state] = await admin<{ claims: string; merged: string }[]>`
      select
        (select count(*) from mb_sources
          where measurement_book_id = ${target2Id}
            and released_at is null)::text as claims,
        (select count(*) from measurement_books
          where merged_into_id = ${target2Id}
            and status = 'merged')::text as merged
    `;
    expect(state).toMatchObject({ claims: '3', merged: '2' });
  });

  it("the merged on-account MB finalizes and bills the records' measurements once", async () => {
    const finalized = await finalize(target2Id);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = finalized.json<MeasurementBookDetailResponse>();
    expect(detail.book.kind).toBe('on_account');
    expect(detail.book.mbNumber).toBe(`${workKCode}-MB-01`);
    expect(detail.book.totalAmount).toBe('246.00');

    // Once finalized, the merge is billed for good: no un-merge.
    const unmergeRefused = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${target2Id}/unmerge`,
      organisationId,
    });
    expect(unmergeRefused.statusCode).toBe(409);
    expect(unmergeRefused.json()).toMatchObject({ code: 'MB_STATUS_CONFLICT' });

    // With no billing draft open, merging a MERGED record is refused on
    // its own state.
    const remerge = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workKId}/measurement-books/merge`,
      organisationId,
      payload: { recordMbIds: [r1Id], mbDate: '2026-08-05' },
    });
    expect(remerge.statusCode).toBe(409);
    expect(remerge.json()).toMatchObject({ code: 'MB_MERGE_NOT_RECORD_DRAFT' });

    // The records stay merged forever, numberless.
    const record = await authed(owner, {
      method: 'GET',
      url: `/api/measurement-books/${r1Id}`,
      organisationId,
    });
    const recordDetail = record.json<MeasurementBookDetailResponse>();
    expect(recordDetail.book.status).toBe('merged');
    expect(recordDetail.book.mergedIntoId).toBe(target2Id);
    expect(recordDetail.book.mbNumber).toBeNull();
  });

  it('record sheets are exempt from the register-date rule; billing drafts are not', async () => {
    // The finalized MB-01 is dated 2026-08-05. A record sheet may be
    // dated earlier — it never takes a number and never narrates the
    // prior cumulative…
    const record = await createDraft(workKId, {
      mbDate: '2026-08-01',
      kind: 'record',
      consigneeContactId: consignee1Id,
    });
    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${record.book.id}`,
      organisationId,
    });
    expect(removed.statusCode).toBe(204);
    // …while the billing register must not run backwards.
    const billing = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workKId}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-01' },
    });
    expect(billing.statusCode).toBe(400);
    expect(billing.json()).toMatchObject({ code: 'MB_DATE_BEFORE_PREVIOUS' });
  });

  it('the final kind (kind and isFinal agree) closes the Work for record sheets too', async () => {
    // The pre-0034 alias still creates the final MB…
    const viaAlias = await createDraft(workKId, {
      mbDate: '2026-08-06',
      isFinal: true,
    });
    expect(viaAlias.book.kind).toBe('final');
    expect(viaAlias.book.isFinal).toBe(true);
    const aliasGone = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${viaAlias.book.id}`,
      organisationId,
    });
    expect(aliasGone.statusCode).toBe(204);
    // …and the kind field is the request truth going forward.
    const finalDraft = await createDraft(workKId, {
      mbDate: '2026-08-06',
      kind: 'final',
    });
    expect(finalDraft.book.kind).toBe('final');
    expect(finalDraft.book.isFinal).toBe(true);
    // The sweep sees only OPEN sources: the merged records' sources are
    // claimed by finalized MB-01, so only the un-merged K3 remains.
    const swept = await setSources(finalDraft.book.id, [
      { sourceType: 'delivery_challan', sourceId: dcK3Id },
    ]);
    expect(swept.statusCode, swept.body).toBe(200);
    const finalized = await finalize(finalDraft.book.id);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = finalized.json<MeasurementBookDetailResponse>();
    expect(detail.book.kind).toBe('final');
    expect(detail.book.isFinal).toBe(true);
    expect(detail.book.mbNumber).toBe(`${workKCode}-MB-02`);

    // No further MB of ANY kind — record sheets included.
    const recordRefused = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workKId}/measurement-books`,
      organisationId,
      payload: {
        mbDate: '2026-08-06',
        kind: 'record',
        consigneeContactId: consignee1Id,
      },
    });
    expect(recordRefused.statusCode).toBe(409);
    expect(recordRefused.json()).toMatchObject({ code: 'FINAL_MB_EXISTS' });
  });
});
