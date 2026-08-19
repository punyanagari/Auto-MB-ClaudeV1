import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  AmcCycleProposalResponse,
  ChallanDetailResponse,
  MbMeasuredAboveSourceDetails,
  MeasurementBookDetailResponse,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * The two locked corrections of 2026-08-19 that touch measurement and
 * maintenance money, end to end against a real database.
 *
 *   Work M  the downward-only measured quantity on a draft Measurement
 *           Book's lines (migration 0106): the route's refusals, the
 *           trigger's refusals against raw SQL, what a finalized book
 *           snapshots, and what happens to an adjustment when its draft
 *           goes.
 *   Work A  the AMC billing cadence (migration 0107): the schedule-edit
 *           route and the columns it must not open, the running-total
 *           split the proposal endpoint answers with, and the period
 *           language the Measurement Book remark renders from it.
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
const ownerEmail = `mq-owner-${runId}@integration.test`;
const siteEmail = `mq-site-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let fakeGotenberg: http.Server;
let organisationId: string;
let ownerUserId: string;
let consigneeMasterId: string;
const consigneeContactAId = randomUUID();
const consigneeContactBId = randomUUID();

let measureWorkId: string;
let cableItemId: string;
let spareItemId: string;
let amcWorkId: string;
let amcScheduleId: string;
let supplyScheduleId: string;
let amcItemId: string;
let supplyItemId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let site: CookieJar;

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
  schedules: { id: string; code: string; position: number }[];
  items: {
    id: string;
    scheduleId: string;
    itemNumber: string;
    description: string;
    unit: string;
    quantity: string;
    rate: string;
    paymentCategory: string | null;
  }[];
}): Promise<string> {
  const workId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${input.code}, ${`L-${input.code}`},
      '2025-06-01', ${`Corrections work ${input.code}`}, '100000.00',
      '90000.00', 'per_schedule', ${ownerUserId}
    )
  `;
  for (const schedule of input.schedules) {
    await admin`
      insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
      values (${schedule.id}, ${organisationId}, ${workId}, ${schedule.code},
              ${`Schedule ${schedule.code}`}, ${schedule.position})
    `;
  }
  for (const item of input.items) {
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values (
        ${item.id}, ${organisationId}, ${workId}, ${item.scheduleId},
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

async function createRecordDraft(
  workId: string,
  mbDate: string,
  consigneeContactId: string,
): Promise<MeasurementBookDetailResponse> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/measurement-books`,
    organisationId,
    payload: { mbDate, kind: 'record', consigneeContactId },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<MeasurementBookDetailResponse>();
}

async function createDraft(
  workId: string,
  body: { mbDate: string; kind?: 'on_account' | 'final' },
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
  const response = await authed(owner, {
    method: 'PUT',
    url: `/api/measurement-books/${mbId}/sources`,
    organisationId,
    payload: { sources },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<MeasurementBookDetailResponse>();
}

async function setMeasured(
  mbId: string,
  overrides: {
    workItemId: string;
    measuredSupplied: string | null;
    measuredInstalled: string | null;
  }[],
  jar: CookieJar = owner,
) {
  return authed(jar, {
    method: 'PUT',
    url: `/api/measurement-books/${mbId}/measured-quantities`,
    organisationId,
    payload: { overrides },
  });
}

async function setCycle(
  workId: string,
  scheduleId: string,
  body: { billingPeriods: number | null; cycleNoun: string | null },
  jar: CookieJar = owner,
) {
  return authed(jar, {
    method: 'PUT',
    url: `/api/works/${workId}/schedules/${scheduleId}/amc-cycle`,
    organisationId,
    payload: body,
  });
}

async function certify(
  workId: string,
  reference: string,
  items: { workItemId: string; certifiedQuantity: string }[],
): Promise<string> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/pac-certificates`,
    organisationId,
    payload: { reference, issueDate: '2026-08-01', consigneeMasterId, items },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function proposal(workId: string): Promise<AmcCycleProposalResponse> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/works/${workId}/amc-cycle-proposal`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AmcCycleProposalResponse>();
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-mq-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  fakeGotenberg = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/pdf');
      response.end(Buffer.from(`%PDF-1.4 stub ${runId}`));
    });
  });
  await new Promise<void>((resolve) => {
    fakeGotenberg.listen(0, '127.0.0.1', resolve);
  });
  const address = fakeGotenberg.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub Gotenberg failed to bind a port');
  }

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-mq-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    gotenbergUrl: `http://127.0.0.1:${String(address.port)}`,
  });

  owner = await signUp(ownerEmail, 'MQ Owner');
  site = await signUp(siteEmail, 'MQ Site');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'MQ Constructions', slug: `mq-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const added = await authed(owner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId,
    payload: { email: siteEmail, role: 'site' },
  });
  expect(added.statusCode, added.body).toBe(201);

  const users = await admin<{ id: string; email: string }[]>`
    select "id", "email" from auth_users
    where "email" like ${`%-${runId}@integration.test`}
  `;
  ownerUserId = users.find((row) => row.email === ownerEmail)?.id ?? '';
  expect(ownerUserId).toBeTruthy();
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  // Two consignee CONTACTS, so two record Measurement Books can run in
  // parallel and be merged (the merge path D1 exercises).
  for (const [index, id] of [consigneeContactAId, consigneeContactBId].entries()) {
    await admin`
      insert into contacts (
        id, organisation_id, designation, address, is_consignee, is_vendor,
        active, created_by_user_id
      )
      values (${id}, ${organisationId}, ${`SSE MQ ${String(index + 1)}`},
              'Division office', true, false, true, ${ownerUserId})
    `;
  }

  consigneeMasterId = randomUUID();
  await admin`
    insert into consignee_masters (
      id, organisation_id, designation, address, created_by_user_id
    )
    values (${consigneeMasterId}, ${organisationId}, 'Sr. DSTE MQ',
            'Divisional office', ${ownerUserId})
  `;

  cableItemId = randomUUID();
  spareItemId = randomUUID();
  const measureScheduleId = randomUUID();
  measureWorkId = await seedWork({
    code: `MQ1${runId.slice(0, 4).toUpperCase()}`,
    schedules: [{ id: measureScheduleId, code: 'A', position: 1 }],
    items: [
      {
        id: cableItemId,
        scheduleId: measureScheduleId,
        itemNumber: '1',
        description: 'Power cable',
        unit: 'mtr',
        quantity: '10000.000',
        rate: '100.00',
        paymentCategory: 'SUPPLY',
      },
      {
        id: spareItemId,
        scheduleId: measureScheduleId,
        itemNumber: '2',
        description: 'Cable gland',
        unit: 'Nos',
        quantity: '500.000',
        rate: '20.00',
        paymentCategory: 'SUPPLY',
      },
    ],
  });
  await insertMatrixRow(measureWorkId, 'SUPPLY', ['80.00', '0.00', '0.00', '20.00']);

  amcScheduleId = randomUUID();
  supplyScheduleId = randomUUID();
  amcItemId = randomUUID();
  supplyItemId = randomUUID();
  amcWorkId = await seedWork({
    code: `MQ2${runId.slice(0, 4).toUpperCase()}`,
    schedules: [
      { id: amcScheduleId, code: 'B', position: 1 },
      { id: supplyScheduleId, code: 'C', position: 2 },
    ],
    items: [
      {
        id: amcItemId,
        scheduleId: amcScheduleId,
        itemNumber: 'B/1',
        description: 'Comprehensive AMC of coach guidance display boards',
        unit: 'Nos',
        quantity: '96.000',
        rate: '500.00',
        paymentCategory: 'AMC',
      },
      {
        id: supplyItemId,
        scheduleId: supplyScheduleId,
        itemNumber: 'C/1',
        description: 'Point machine supply',
        unit: 'Nos',
        quantity: '100.000',
        rate: '10.00',
        paymentCategory: 'SUPPLY',
      },
    ],
  });
  await insertMatrixRow(amcWorkId, 'AMC', ['0.00', '0.00', '95.00', '5.00']);
  await insertMatrixRow(amcWorkId, 'SUPPLY', ['80.00', '0.00', '0.00', '20.00']);
}, 120_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId]);
    await admin`delete from auth_users where "email" like ${`%-${runId}@integration.test`}`;
  }
  await app?.close();
  await admin?.end();
  fakeGotenberg?.close();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('the downward-only measured quantity on a draft (migration 0106)', () => {
  let challanId: string;
  let draftId: string;

  it('previews the claimed quantity before anybody adjusts it', async () => {
    challanId = await issueChallan(measureWorkId, 'MQ', [
      { workItemId: cableItemId, quantity: '10.000' },
    ]);
    draftId = (await createDraft(measureWorkId, { mbDate: '2026-08-01' })).book.id;
    const detail = await setSources(draftId, [
      { sourceType: 'delivery_challan', sourceId: challanId },
    ]);
    const [line] = detail.lines;
    expect(line?.deltaSupplied).toBe('10.000');
    // Equal on a line nobody adjusted, which is what makes "computed vs
    // entered" honest on the screen rather than decorative.
    expect(line?.sourceSupplied).toBe('10.000');
    expect(detail.previewTotal).toBe('800.00');
  });

  it('reduces the line, and reprices it in the same answer', async () => {
    const response = await setMeasured(draftId, [
      { workItemId: cableItemId, measuredSupplied: '8', measuredInstalled: null },
    ]);
    expect(response.statusCode, response.body).toBe(200);
    const detail = response.json<MeasurementBookDetailResponse>();
    const [line] = detail.lines;
    expect(line?.deltaSupplied).toBe('8.000');
    expect(line?.sourceSupplied).toBe('10.000');
    expect(line?.amountSupply).toBe('640.00');
    expect(detail.previewTotal).toBe('640.00');
    expect(line?.remark).toBe('Now to pay 80% for 8 mtr.');
  });

  it('accepts the cap boundary exactly', async () => {
    const response = await setMeasured(draftId, [
      { workItemId: cableItemId, measuredSupplied: '10.000', measuredInstalled: null },
    ]);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<MeasurementBookDetailResponse>().lines[0]?.deltaSupplied).toBe(
      '10.000',
    );
  });

  it('refuses one thousandth above it, naming the line and both figures', async () => {
    const response = await setMeasured(draftId, [
      { workItemId: cableItemId, measuredSupplied: '10.001', measuredInstalled: null },
    ]);
    expect(response.statusCode, response.body).toBe(409);
    const body = response.json<{
      code: string;
      details: MbMeasuredAboveSourceDetails;
    }>();
    expect(body.code).toBe('MB_MEASURED_ABOVE_SOURCE');
    expect(body.details.items).toEqual([
      {
        workItemId: cableItemId,
        itemNumber: '1',
        stage: 'supplied',
        entered: '10.001',
        measured: '10.000',
      },
    ]);
  });

  it('refuses a negative figure and a duplicated line before it opens a transaction', async () => {
    const negative = await setMeasured(draftId, [
      { workItemId: cableItemId, measuredSupplied: '-1', measuredInstalled: null },
    ]);
    expect(negative.statusCode).toBe(400);
    expect(negative.json<{ code: string }>().code).toBe('MB_MEASURED_NEGATIVE');

    const duplicated = await setMeasured(draftId, [
      { workItemId: cableItemId, measuredSupplied: '1', measuredInstalled: null },
      { workItemId: cableItemId, measuredSupplied: '2', measuredInstalled: null },
    ]);
    expect(duplicated.statusCode).toBe(400);
    expect(duplicated.json<{ code: string }>().code).toBe('MB_MEASURED_DUPLICATED');
  });

  it('answers an item of another Work exactly like an unknown one', async () => {
    const response = await setMeasured(draftId, [
      { workItemId: amcItemId, measuredSupplied: '1', measuredInstalled: null },
    ]);
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('WORK_ITEM_NOT_FOUND');
  });

  it('refuses a member without the writer role', async () => {
    const response = await setMeasured(
      draftId,
      [{ workItemId: cableItemId, measuredSupplied: '1', measuredInstalled: null }],
      site,
    );
    expect(response.statusCode).toBe(403);
  });

  it('refuses an adjustment on an item this book claims nothing of', async () => {
    // Its cap is zero, so the only figure the cap admits is zero — and a
    // zero adjustment is what would put the item's line ON the book and
    // then block finalize on an item nobody selected a source for.
    const spare = randomUUID();
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      select ${spare}, ${organisationId}, ${measureWorkId}, wi.schedule_id,
             'Z/9', 'Unclaimed spare', 'Nos', '5.000', '10.00', 'SUPPLY'
      from work_items wi where wi.id = ${cableItemId}
    `;
    const response = await setMeasured(draftId, [
      { workItemId: spare, measuredSupplied: '0', measuredInstalled: null },
    ]);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('MB_MEASURED_ITEM_NOT_CLAIMED');
    await admin`delete from work_items where id = ${spare}`;
  });

  it('clears an adjustment when the entered figure equals the claimed one', async () => {
    // The client sends null for "no adjustment", and the route stores no
    // row rather than a row of nulls — so a draft nobody adjusted carries
    // no adjustment rows at all.
    const response = await setMeasured(draftId, [
      { workItemId: cableItemId, measuredSupplied: null, measuredInstalled: null },
    ]);
    expect(response.statusCode, response.body).toBe(200);
    const [row] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_measured_overrides
      where measurement_book_id = ${draftId}
    `;
    expect(row?.count).toBe('0');
  });

  it('refuses an adjustment above the claimed quantity in the DATABASE, against raw SQL', async () => {
    // The route is not the only writer, and 23R01 is what the rule is
    // actually held by.
    await expect(
      admin`
        insert into mb_measured_overrides (
          organisation_id, measurement_book_id, work_id, work_item_id,
          measured_supplied
        )
        values (${organisationId}, ${draftId}, ${measureWorkId}, ${cableItemId},
                '11.000')
      `,
    ).rejects.toMatchObject({ code: '23R01' });
  });

  it('refuses a negative one in the database too', async () => {
    await expect(
      admin`
        insert into mb_measured_overrides (
          organisation_id, measurement_book_id, work_id, work_item_id,
          measured_supplied
        )
        values (${organisationId}, ${draftId}, ${measureWorkId}, ${cableItemId},
                '-1.000')
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a row that adjusts neither stage', async () => {
    await expect(
      admin`
        insert into mb_measured_overrides (
          organisation_id, measurement_book_id, work_id, work_item_id
        )
        values (${organisationId}, ${draftId}, ${measureWorkId}, ${cableItemId})
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('SNAPSHOTS the adjusted quantity when the book is finalized, like any line', async () => {
    const applied = await setMeasured(draftId, [
      { workItemId: cableItemId, measuredSupplied: '8', measuredInstalled: null },
    ]);
    expect(applied.statusCode, applied.body).toBe(200);

    const finalized = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${draftId}/finalize`,
      organisationId,
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = finalized.json<MeasurementBookDetailResponse>();
    expect(detail.book.totalAmount).toBe('640.00');
    const [line] = detail.lines;
    expect(line?.deltaSupplied).toBe('8.000');
    // The snapshot has no column for what the sources measured before the
    // adjustment, and says so rather than guessing.
    expect(line?.sourceSupplied).toBeNull();

    const rows = await admin<{ delta_supplied: string }[]>`
      select delta_supplied::text as delta_supplied
      from measurement_book_lines where measurement_book_id = ${draftId}
    `;
    expect(rows[0]?.delta_supplied).toBe('8.000');
  });

  it('freezes the adjustment once the book has left draft, in the database', async () => {
    await expect(
      admin`
        update mb_measured_overrides set measured_supplied = '1.000'
        where measurement_book_id = ${draftId}
      `,
    ).rejects.toMatchObject({ code: '23R02' });
    await expect(
      admin`delete from mb_measured_overrides where measurement_book_id = ${draftId}`,
    ).rejects.toMatchObject({ code: '23R02' });
  });

  it('refuses to adjust a finalized book through the route as well', async () => {
    const response = await setMeasured(draftId, [
      { workItemId: cableItemId, measuredSupplied: '1', measuredInstalled: null },
    ]);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('MB_STATUS_CONFLICT');
  });

  it('refuses to number a book every line of which was adjusted to nothing', async () => {
    const secondChallan = await issueChallan(measureWorkId, 'MQ', [
      { workItemId: cableItemId, quantity: '5.000' },
    ]);
    const zeroed = (await createDraft(measureWorkId, { mbDate: '2026-08-02' })).book.id;
    await setSources(zeroed, [
      { sourceType: 'delivery_challan', sourceId: secondChallan },
    ]);
    const applied = await setMeasured(zeroed, [
      { workItemId: cableItemId, measuredSupplied: '0', measuredInstalled: null },
    ]);
    expect(applied.statusCode, applied.body).toBe(200);
    const detail = applied.json<MeasurementBookDetailResponse>();
    // The line STAYS, so the field that would undo the zero is still on
    // screen — and finalize still refuses, because it asks the
    // quantities rather than the line count.
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]?.deltaSupplied).toBe('0.000');
    expect(detail.previewTotal).toBe('0.00');

    const finalized = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${zeroed}/finalize`,
      organisationId,
    });
    expect(finalized.statusCode).toBe(409);
    expect(finalized.json<{ code: string }>().code).toBe('MB_EMPTY');

    // And the adjustment dies with the draft.
    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${zeroed}`,
      organisationId,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    const [gone] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_measured_overrides
      where measurement_book_id = ${zeroed}
    `;
    expect(gone?.count).toBe('0');
  });

  it('leaves an adjusted-to-nothing line OUT of the finalized snapshot', async () => {
    // The zero line is a draft affordance — it exists so the field that
    // would undo it is still on screen. It has no business in an
    // immutable snapshot, in the printed document, or in the bill.
    const both = await issueChallan(measureWorkId, 'MQZ', [
      { workItemId: cableItemId, quantity: '6.000' },
      { workItemId: spareItemId, quantity: '4.000' },
    ]);
    const mixed = (await createDraft(measureWorkId, { mbDate: '2026-08-06' })).book.id;
    await setSources(mixed, [{ sourceType: 'delivery_challan', sourceId: both }]);
    const applied = await setMeasured(mixed, [
      { workItemId: spareItemId, measuredSupplied: '0', measuredInstalled: null },
    ]);
    expect(applied.statusCode, applied.body).toBe(200);
    // Both lines are on the DRAFT.
    expect(applied.json<MeasurementBookDetailResponse>().lines).toHaveLength(2);

    const finalized = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mixed}/finalize`,
      organisationId,
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    // One line on the BOOK.
    const detail = finalized.json<MeasurementBookDetailResponse>();
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]?.workItemId).toBe(cableItemId);
    const rows = await admin<{ count: string }[]>`
      select count(*)::text as count from measurement_book_lines
      where measurement_book_id = ${mixed}
    `;
    expect(rows[0]?.count).toBe('1');

    // And the bill's own copy carries neither the dropped line nor the
    // four draft-only fields.
    const bill = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mixed}/bill`,
      organisationId,
    });
    expect(bill.statusCode, bill.body).toBe(201);
    const snapshot = bill.json<{ linesSnapshot: Record<string, unknown>[] }>()
      .linesSnapshot;
    expect(snapshot).toHaveLength(1);
    expect(Object.keys(snapshot[0] ?? {})).not.toContain('sourceSupplied');
    expect(Object.keys(snapshot[0] ?? {})).not.toContain('overrideSupplied');
  });
});

describe('an adjustment travels with its sources through a merge', () => {
  it('bills what the record measured, not what its challan claimed', async () => {
    // Two consignees, two record sheets, one challan each. The first
    // measures eight of its claimed ten; the second measures all five of
    // its own. The merged book has to bill thirteen.
    const challanA = await issueChallan(measureWorkId, 'MQA', [
      { workItemId: cableItemId, quantity: '10.000' },
    ]);
    const challanB = await issueChallan(measureWorkId, 'MQB', [
      { workItemId: cableItemId, quantity: '5.000' },
    ]);
    const recordA = (
      await createRecordDraft(measureWorkId, '2026-08-10', consigneeContactAId)
    ).book.id;
    const recordB = (
      await createRecordDraft(measureWorkId, '2026-08-10', consigneeContactBId)
    ).book.id;
    await setSources(recordA, [{ sourceType: 'delivery_challan', sourceId: challanA }]);
    await setSources(recordB, [{ sourceType: 'delivery_challan', sourceId: challanB }]);
    const adjusted = await setMeasured(recordA, [
      { workItemId: cableItemId, measuredSupplied: '8', measuredInstalled: null },
    ]);
    expect(adjusted.statusCode, adjusted.body).toBe(200);

    const merged = await authed(owner, {
      method: 'POST',
      url: `/api/works/${measureWorkId}/measurement-books/merge`,
      organisationId,
      payload: { recordMbIds: [recordA, recordB], mbDate: '2026-08-11' },
    });
    expect(merged.statusCode, merged.body).toBe(201);
    const target = merged.json<MeasurementBookDetailResponse>();

    // 8 from the adjusted sheet plus 5 from the untouched one.
    expect(target.lines[0]?.deltaSupplied).toBe('13.000');
    expect(target.lines[0]?.sourceSupplied).toBe('15.000');
    expect(target.lines[0]?.overrideSupplied).toBe('13.000');
    // And the records keep no adjustment row to be stranded on a merged
    // book, where 0106's guard would refuse every attempt to remove it.
    const [left] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_measured_overrides
      where measurement_book_id = any(${[recordA, recordB]}::uuid[])
    `;
    expect(left?.count).toBe('0');

    // FINALIZING bills the same thirteen, which is the half a preview
    // alone would not prove.
    const finalized = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${target.book.id}/finalize`,
      organisationId,
      payload: {},
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const rows = await admin<{ delta_supplied: string }[]>`
      select delta_supplied::text as delta_supplied
      from measurement_book_lines where measurement_book_id = ${target.book.id}
    `;
    expect(rows[0]?.delta_supplied).toBe('13.000');
  });
});

describe('the AMC billing cadence (migration 0107)', () => {
  it('proposes nothing before a schedule states a cadence', async () => {
    expect(await proposal(amcWorkId)).toEqual({ schedules: [] });
  });

  it('refuses half a cadence, and a phrase where a word belongs', async () => {
    const half = await setCycle(amcWorkId, amcScheduleId, {
      billingPeriods: 8,
      cycleNoun: null,
    });
    expect(half.statusCode).toBe(400);
    expect(half.json<{ code: string }>().code).toBe('AMC_CYCLE_INCOMPLETE');

    const phrase = await setCycle(amcWorkId, amcScheduleId, {
      billingPeriods: 8,
      cycleNoun: '1 quarter',
    });
    expect(phrase.statusCode).toBe(400);
    expect(phrase.json<{ code: string }>().code).toBe('AMC_CYCLE_INCOMPLETE');
  });

  it('answers a schedule of another Work exactly like an unknown one', async () => {
    const response = await setCycle(measureWorkId, amcScheduleId, {
      billingPeriods: 8,
      cycleNoun: 'quarter',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('SCHEDULE_NOT_FOUND');
  });

  it('refuses a member without the writer role', async () => {
    const response = await setCycle(
      amcWorkId,
      amcScheduleId,
      { billingPeriods: 8, cycleNoun: 'quarter' },
      site,
    );
    expect(response.statusCode).toBe(403);
  });

  it('sets the cadence, and the Work reads it back', async () => {
    const response = await setCycle(amcWorkId, amcScheduleId, {
      billingPeriods: 8,
      cycleNoun: 'quarter',
    });
    expect(response.statusCode, response.body).toBe(204);

    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/works/${amcWorkId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const work = detail.json<WorkDetailResponse>();
    const amcSchedule = work.schedules.find(
      (schedule) => schedule.id === amcScheduleId,
    );
    expect(amcSchedule?.amcBillingPeriods).toBe(8);
    expect(amcSchedule?.amcCycleNoun).toBe('quarter');
    const supplySchedule = work.schedules.find(
      (schedule) => schedule.id === supplyScheduleId,
    );
    expect(supplySchedule?.amcBillingPeriods).toBeNull();
  });

  it('records the change on the Work timeline', async () => {
    const timeline = await authed(owner, {
      method: 'GET',
      url: `/api/works/${amcWorkId}/timeline`,
      organisationId,
    });
    expect(timeline.statusCode, timeline.body).toBe(200);
    const events = timeline.json<{
      events: { action: string; entityType: string }[];
    }>();
    expect(
      events.events.some(
        (event) =>
          event.action === 'work_schedule.amc_cycle_set' &&
          event.entityType === 'work_schedules',
      ),
    ).toBe(true);
  });

  it('opens the schedule for the cadence and for NOTHING else, in the database', async () => {
    // 0107's whole reason for existing: opening UPDATE for two columns
    // opens the table's UPDATE privilege for the schedule's identity and
    // for accepted_percentage, the multiplier every derived rate on the
    // Work is computed through.
    await expect(
      admin`update work_schedules set title = 'Renamed' where id = ${amcScheduleId}`,
    ).rejects.toMatchObject({ code: '23R03' });
    await expect(
      admin`
        update work_schedules set accepted_percentage = '10.000',
                                  accepted_percentage_direction = 'below'
        where id = ${amcScheduleId}
      `,
    ).rejects.toMatchObject({ code: '23R03' });
    await expect(
      admin`update work_schedules set position = 9 where id = ${amcScheduleId}`,
    ).rejects.toMatchObject({ code: '23R03' });
  });

  it('refuses a half-stated pair in the database as well', async () => {
    await expect(
      admin`
        update work_schedules set amc_cycle_noun = null where id = ${amcScheduleId}
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('proposes the first period as the running-total split, and proves it divides', async () => {
    const answer = await proposal(amcWorkId);
    expect(answer.schedules).toHaveLength(1);
    const [schedule] = answer.schedules;
    expect(schedule?.scheduleCode).toBe('B');
    expect(schedule?.billingPeriods).toBe(8);
    expect(schedule?.cycleNoun).toBe('quarter');
    const [item] = schedule?.items ?? [];
    expect(item?.workItemId).toBe(amcItemId);
    expect(item?.totalQuantity).toBe('96.000');
    expect(item?.certifiedQuantity).toBe('0.000');
    expect(item?.periodsCertified).toBe(0);
    expect(item?.nextPeriod).toBe(1);
    expect(item?.proposedQuantity).toBe('12.000');
    expect(item?.divides).toBe(true);
  });

  it('moves to the next period once a certificate covers this one', async () => {
    await certify(amcWorkId, `PAC-Q1-${runId}`, [
      { workItemId: amcItemId, certifiedQuantity: '12.000' },
    ]);
    const [item] = (await proposal(amcWorkId)).schedules[0]?.items ?? [];
    expect(item?.certifiedQuantity).toBe('12.000');
    expect(item?.periodsCertified).toBe(1);
    expect(item?.nextPeriod).toBe(2);
    expect(item?.proposedQuantity).toBe('12.000');
  });

  it('renders the period language in the Measurement Book remark', async () => {
    const draft = await createDraft(amcWorkId, { mbDate: '2026-08-05' });
    const pacRows = await admin<{ id: string }[]>`
      select id from pac_certificates
      where work_id = ${amcWorkId} and status = 'recorded'
    `;
    const detail = await setSources(
      draft.book.id,
      pacRows.map((row) => ({ sourceType: 'pac_certificate', sourceId: row.id })),
    );
    expect(detail.lines[0]?.remark).toBe('Now to pay 95% for 1 quarter.');
    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${draft.book.id}`,
      organisationId,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
  });

  it('proposes nothing once every period is certified, and the periods sum to Q exactly', async () => {
    // The remaining seven, one at a time, taking each period's proposal
    // as the certificate — which is what an operator following the
    // screen does. Nothing is left over and nothing is short, because
    // the split is a running total rather than Q/M repeated.
    for (let period = 2; period <= 8; period += 1) {
      const [item] = (await proposal(amcWorkId)).schedules[0]?.items ?? [];
      expect(item?.nextPeriod, `period ${String(period)}`).toBe(period);
      await certify(amcWorkId, `PAC-Q${String(period)}-${runId}`, [
        { workItemId: amcItemId, certifiedQuantity: item?.proposedQuantity ?? '0' },
      ]);
    }
    const [item] = (await proposal(amcWorkId)).schedules[0]?.items ?? [];
    expect(item?.certifiedQuantity).toBe('96.000');
    expect(item?.periodsCertified).toBe(8);
    expect(item?.nextPeriod).toBeNull();
    expect(item?.proposedQuantity).toBeNull();
  });

  it('reconciles against a certificate taken SHORT of its period, in both directions', async () => {
    // The railway certifies what it accepted, not what this product
    // proposed. A period taken short must not shift every later period
    // by the same amount and leave the contract short of Q — and one
    // taken long must not push the total over the 0068 cap.
    const short = randomUUID();
    const shortSchedule = randomUUID();
    const shortItem = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (${short}, ${organisationId}, ${`MQ3${runId.slice(0, 4).toUpperCase()}`},
              ${`L-MQ3${runId}`}, '2025-06-01', 'Drift work', '100000.00',
              '90000.00', 'per_schedule', ${ownerUserId})
    `;
    await admin`
      insert into work_schedules (
        id, organisation_id, work_id, schedule_code, title, position,
        amc_billing_periods, amc_cycle_noun
      )
      values (${shortSchedule}, ${organisationId}, ${short}, 'D', 'Schedule D', 1,
              4, 'quarter')
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values (${shortItem}, ${organisationId}, ${short}, ${shortSchedule}, 'D/1',
              'Comprehensive AMC of display boards', 'Nos', '100.000', '50.00',
              'AMC')
    `;
    await insertMatrixRow(short, 'AMC', ['0.00', '0.00', '95.00', '5.00']);

    // A hand-certified 10 where the split's first period is 25.
    await certify(short, `PAC-SHORT-${runId}`, [
      { workItemId: shortItem, certifiedQuantity: '10.000' },
    ]);
    let item = (await proposal(short)).schedules[0]?.items[0];
    // No period is closed yet, and the proposal is what it takes to
    // REACH the first period's cumulative — not another whole period.
    expect(item?.periodsCertified).toBe(0);
    expect(item?.nextPeriod).toBe(1);
    expect(item?.proposedQuantity).toBe('15.000');

    // Now the other direction: certify 13 instead of the proposed 15.
    await certify(short, `PAC-LONG-${runId}`, [
      { workItemId: shortItem, certifiedQuantity: '13.000' },
    ]);
    item = (await proposal(short)).schedules[0]?.items[0];
    expect(item?.certifiedQuantity).toBe('23.000');
    expect(item?.periodsCertified).toBe(0);
    expect(item?.proposedQuantity).toBe('2.000');

    // Following the proposal from here lands on exactly Q, whatever the
    // drift was — which is the property the whole cadence rests on.
    for (let period = 1; period <= 4; period += 1) {
      const next = (await proposal(short)).schedules[0]?.items[0];
      if (next?.proposedQuantity == null) break;
      await certify(short, `PAC-R${String(period)}-${runId}`, [
        { workItemId: shortItem, certifiedQuantity: next.proposedQuantity },
      ]);
    }
    item = (await proposal(short)).schedules[0]?.items[0];
    expect(item?.certifiedQuantity).toBe('100.000');
    expect(item?.nextPeriod).toBeNull();
  });

  it('reconciles a cadence changed mid-contract', async () => {
    // Certify two quarters of eight, then switch the schedule to four
    // periods. The remainder formula recomputes against what is actually
    // certified, so the contract still closes on exactly Q.
    const mid = randomUUID();
    const midSchedule = randomUUID();
    const midItem = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (${mid}, ${organisationId}, ${`MQ4${runId.slice(0, 4).toUpperCase()}`},
              ${`L-MQ4${runId}`}, '2025-06-01', 'Mid-term work', '100000.00',
              '90000.00', 'per_schedule', ${ownerUserId})
    `;
    await admin`
      insert into work_schedules (
        id, organisation_id, work_id, schedule_code, title, position,
        amc_billing_periods, amc_cycle_noun
      )
      values (${midSchedule}, ${organisationId}, ${mid}, 'E', 'Schedule E', 1,
              8, 'quarter')
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values (${midItem}, ${organisationId}, ${mid}, ${midSchedule}, 'E/1',
              'Comprehensive AMC of clocks', 'Nos', '96.000', '50.00', 'AMC')
    `;
    await insertMatrixRow(mid, 'AMC', ['0.00', '0.00', '95.00', '5.00']);

    for (const period of [1, 2]) {
      const next = (await proposal(mid)).schedules[0]?.items[0];
      await certify(mid, `PAC-M${String(period)}-${runId}`, [
        { workItemId: midItem, certifiedQuantity: next?.proposedQuantity ?? '0' },
      ]);
    }
    expect((await proposal(mid)).schedules[0]?.items[0]?.certifiedQuantity).toBe(
      '24.000',
    );

    const switched = await setCycle(mid, midSchedule, {
      billingPeriods: 4,
      cycleNoun: 'half-year',
    });
    expect(switched.statusCode, switched.body).toBe(204);
    // 24 of 96 over four periods is exactly one closed period.
    const after = (await proposal(mid)).schedules[0]?.items[0];
    expect(after?.periodsCertified).toBe(1);
    expect(after?.proposedQuantity).toBe('24.000');

    for (let period = 2; period <= 4; period += 1) {
      const next = (await proposal(mid)).schedules[0]?.items[0];
      if (next?.proposedQuantity == null) break;
      await certify(mid, `PAC-N${String(period)}-${runId}`, [
        { workItemId: midItem, certifiedQuantity: next.proposedQuantity },
      ]);
    }
    const closed = (await proposal(mid)).schedules[0]?.items[0];
    expect(closed?.certifiedQuantity).toBe('96.000');
    expect(closed?.nextPeriod).toBeNull();
  });

  it('refuses to change a cadence on a completed Work', async () => {
    // On a Work of its own, so the shared one is never left completed
    // for the cases after this. The 0031 guard wants the completing
    // member and the note, which is how the route moves the status.
    const closed = randomUUID();
    const closedSchedule = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (${closed}, ${organisationId}, ${`MQ5${runId.slice(0, 4).toUpperCase()}`},
              ${`L-MQ5${runId}`}, '2025-06-01', 'Closed work', '100000.00',
              '90000.00', 'per_schedule', ${ownerUserId})
    `;
    await admin`
      insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
      values (${closedSchedule}, ${organisationId}, ${closed}, 'F', 'Schedule F', 1)
    `;
    await admin`
      update works
      set status = 'completed', completed_at = now(),
          completed_by_user_id = ${ownerUserId},
          completion_note = 'closed for this case'
      where id = ${closed}
    `;
    const response = await setCycle(closed, closedSchedule, {
      billingPeriods: 4,
      cycleNoun: 'quarter',
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('WORK_COMPLETED');
  });

  it('says so when the cadence does not divide the sanctioned quantity evenly', async () => {
    // 96 over 7 periods: 13.714, 13.714, 13.715, ... The owner accepted
    // the third-decimal wobble; the response still refuses to present it
    // as an even split.
    const changed = await setCycle(amcWorkId, amcScheduleId, {
      billingPeriods: 7,
      cycleNoun: 'quarter',
    });
    expect(changed.statusCode, changed.body).toBe(204);
    const [item] = (await proposal(amcWorkId)).schedules[0]?.items ?? [];
    expect(item?.divides).toBe(false);
  });

  it('clears the cadence with two nulls, and proposes nothing again', async () => {
    const cleared = await setCycle(amcWorkId, amcScheduleId, {
      billingPeriods: null,
      cycleNoun: null,
    });
    expect(cleared.statusCode, cleared.body).toBe(204);
    expect(await proposal(amcWorkId)).toEqual({ schedules: [] });
  });
});
