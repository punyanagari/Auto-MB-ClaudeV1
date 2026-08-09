import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  SerialListResponse,
  SerialSearchResponse,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

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
const ownerEmail = `se-owner-${runId}@integration.test`;
const siteEmail = `se-site-${runId}@integration.test`;
const outsiderEmail = `se-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let otherOrganisationId: string;
let ownerUserId: string;
let siteUserId: string;

// Work 1: the main enforcement fixture (flagged item F, unflagged item U).
let work1Id: string;
let itemFId: string;
let itemUId: string;
// Work 2: lookup volume + scope filtering (NOT assigned to the site member).
let work2Id: string;
let itemWId: string;
// Works 3/4: dedicated concurrency arenas.
let work3Id: string;
let itemC1Id: string;
let work4Id: string;
let itemD1Id: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
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

async function insertWork(options: {
  workCode: string;
  items: {
    id: string;
    itemNumber: string;
    description: string;
    awardedQuantity: string;
    requiresSerials: boolean;
  }[];
}): Promise<string> {
  const workId = randomUUID();
  const scheduleId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, letter_percentage,
      letter_percentage_direction, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${options.workCode},
      ${`se-letter-${options.workCode}-${runId}`}, '2025-06-01',
      ${`Serial fixture work ${options.workCode}`},
      1000.00, 900.00, 'per_schedule', null, null, ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  for (const item of options.items) {
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, requires_serials
      )
      values (
        ${item.id}, ${organisationId}, ${workId}, ${scheduleId},
        ${item.itemNumber}, ${item.description}, 'Nos',
        ${item.awardedQuantity}, 100.00, ${item.requiresSerials}
      )
    `;
  }
  return workId;
}

async function draftChallan(
  workId: string,
  prefix: string,
  items: { workItemId: string; quantity: string }[],
): Promise<ChallanDetailResponse> {
  const draft = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/challans`,
    organisationId,
    payload: {
      challanDate: '2026-08-08',
      // Challan numbers are unique per organisation, so each fixture
      // Work issues under its own prefix.
      prefix,
      consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division' },
      items,
    },
  });
  expect(draft.statusCode, draft.body).toBe(201);
  return draft.json<ChallanDetailResponse>();
}

function lineOf(detail: ChallanDetailResponse, workItemId: string): string {
  const line = detail.items.find((item) => item.workItemId === workItemId);
  if (!line) throw new Error('expected challan line missing');
  return line.id;
}

async function serialCount(challanItemId: string): Promise<number> {
  const [row] = await admin<{ count: string }[]>`
    select count(*)::text as count from challan_item_serials
    where delivery_challan_item_id = ${challanItemId}
  `;
  return Number(row?.count ?? '0');
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-serials-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the serial integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-se-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'SE Owner');
  site = await signUp(siteEmail, 'SE Site');
  outsider = await signUp(outsiderEmail, 'SE Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'SE Constructions', slug: `se-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const otherCreated = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'SE Other Org', slug: `se-other-${runId}` },
  });
  expect(otherCreated.statusCode, otherCreated.body).toBe(201);
  otherOrganisationId = otherCreated.json<{ id: string }>().id;

  const addedSite = await authed(owner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId,
    payload: { email: siteEmail, role: 'site' },
  });
  expect(addedSite.statusCode, addedSite.body).toBe(201);

  const users = await admin<{ id: string; email: string }[]>`
    select "id", "email" from auth_users
    where "email" in (${ownerEmail}, ${siteEmail})
  `;
  const ownerUser = users.find((user) => user.email === ownerEmail);
  const siteUser = users.find((user) => user.email === siteEmail);
  if (!ownerUser || !siteUser) throw new Error('fixture users missing');
  ownerUserId = ownerUser.id;
  siteUserId = siteUser.id;

  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
  // The site member only reaches assigned Works.
  await admin`
    update organisation_memberships
    set work_scope = 'assigned'
    where organisation_id = ${organisationId} and user_id = ${siteUserId}
  `;

  itemFId = randomUUID();
  itemUId = randomUUID();
  itemWId = randomUUID();
  itemC1Id = randomUUID();
  itemD1Id = randomUUID();
  work1Id = await insertWork({
    workCode: `SEW1-${runId.toUpperCase()}`,
    items: [
      {
        id: itemFId,
        itemNumber: 'A/1',
        description: 'Flagged switchboard',
        awardedQuantity: '10.000',
        requiresSerials: false,
      },
      {
        id: itemUId,
        itemNumber: 'A/2',
        description: 'Unflagged cable set',
        awardedQuantity: '10.000',
        requiresSerials: false,
      },
    ],
  });
  work2Id = await insertWork({
    workCode: `SEW2-${runId.toUpperCase()}`,
    items: [
      {
        id: itemWId,
        itemNumber: 'B/1',
        description: 'Bulk serialised meters',
        awardedQuantity: '60.000',
        requiresSerials: false,
      },
    ],
  });
  work3Id = await insertWork({
    workCode: `SEW3-${runId.toUpperCase()}`,
    items: [
      {
        id: itemC1Id,
        itemNumber: 'C/1',
        description: 'Race arena item',
        awardedQuantity: '10.000',
        requiresSerials: true,
      },
    ],
  });
  work4Id = await insertWork({
    workCode: `SEW4-${runId.toUpperCase()}`,
    items: [
      {
        id: itemD1Id,
        itemNumber: 'D/1',
        description: 'Delete-race item',
        awardedQuantity: '5.000',
        requiresSerials: true,
      },
    ],
  });

  await admin`
    insert into work_assignments (
      organisation_id, work_id, user_id, created_by_user_id
    )
    values (${organisationId}, ${work1Id}, ${siteUserId}, ${ownerUserId})
  `;
}, 60_000);

afterAll(async () => {
  if (admin) {
    for (const orgId of [organisationId, otherOrganisationId]) {
      if (!orgId) continue;
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'challan_item_serials',
          'challan_receipts',
          'mb_entries',
          'bills',
          'bill_counters',
          'work_instruments',
          'work_assignments',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'work_items',
          'work_schedules',
          'loa_documents',
          'works',
          'organisation_memberships',
          'organisations',
        ]) {
          await admin.unsafe(
            `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
            [orgId],
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
        where "email" like ${`se-%-${runId}@integration.test`}
      )
    `;
    await admin`
      delete from auth_users where "email" like ${`se-%-${runId}@integration.test`}
    `;
  }
  await app?.close();
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('requires_serials flag management', () => {
  it('is owner/office only', async () => {
    const denied = await authed(site, {
      method: 'PATCH',
      url: `/api/work-items/${itemFId}/requires-serials`,
      organisationId,
      payload: { requiresSerials: true },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
  });

  it('denies cross-tenant toggles as not-found', async () => {
    const denied = await authed(outsider, {
      method: 'PATCH',
      url: `/api/work-items/${itemFId}/requires-serials`,
      organisationId: otherOrganisationId,
      payload: { requiresSerials: true },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
  });

  it('toggles the flag on, audited, and surfaces it on the Work detail', async () => {
    const toggled = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${itemFId}/requires-serials`,
      organisationId,
      payload: { requiresSerials: true },
    });
    expect(toggled.statusCode, toggled.body).toBe(200);
    expect(toggled.json()).toMatchObject({
      workItemId: itemFId,
      itemNumber: 'A/1',
      requiresSerials: true,
    });

    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/works/${work1Id}`,
      organisationId,
    });
    expect(detail.statusCode).toBe(200);
    const items = detail
      .json<WorkDetailResponse>()
      .schedules.flatMap((schedule) => schedule.items);
    expect(items.find((item) => item.id === itemFId)?.requiresSerials).toBe(true);
    expect(items.find((item) => item.id === itemUId)?.requiresSerials).toBe(false);

    const [event] = await admin<{ details: unknown }[]>`
      select details from audit_events
      where organisation_id = ${organisationId}
        and action = 'work_item.requires_serials_changed'
        and entity_id = ${itemFId}
    `;
    expect(event).toBeDefined();
  });
});

describe('draft-time serial recording and issue enforcement', () => {
  let challan1Id: string;
  let lineFId: string;
  let lineUId: string;

  it('records serials on DRAFT lines with the same cap and uniqueness', async () => {
    const draft = await draftChallan(work1Id, 'DC', [
      { workItemId: itemFId, quantity: '3' },
      { workItemId: itemUId, quantity: '2' },
    ]);
    challan1Id = draft.challan.id;
    lineFId = lineOf(draft, itemFId);
    lineUId = lineOf(draft, itemUId);

    const recorded = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan1Id}/serials`,
      organisationId,
      payload: { challanItemId: lineFId, serialNumbers: ['F-SN-1', 'F-SN-2'] },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    expect(recorded.json<SerialListResponse>().serials).toHaveLength(2);

    const duplicate = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan1Id}/serials`,
      organisationId,
      payload: { challanItemId: lineFId, serialNumbers: ['F-SN-2'] },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'DUPLICATE_SERIAL' });

    const overflow = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan1Id}/serials`,
      organisationId,
      payload: { challanItemId: lineFId, serialNumbers: ['F-SN-3', 'F-SN-4'] },
    });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json()).toMatchObject({ code: 'SERIAL_LIMIT' });
  });

  it('lets draft-stage mistakes be deleted and the serial re-used', async () => {
    const wrong = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan1Id}/serials`,
      organisationId,
      payload: { challanItemId: lineFId, serialNumbers: ['F-TYPO'] },
    });
    expect(wrong.statusCode, wrong.body).toBe(201);
    const typo = wrong
      .json<SerialListResponse>()
      .serials.find((serial) => serial.serialNumber === 'F-TYPO');
    expect(typo).toBeDefined();

    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/serials/${typo?.id ?? ''}`,
      organisationId,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await serialCount(lineFId)).toBe(2);

    const [event] = await admin<{ id: string }[]>`
      select id from audit_events
      where organisation_id = ${organisationId} and action = 'serial.deleted'
    `;
    expect(event).toBeDefined();
  });

  it('refuses to issue while a flagged line is one serial short', async () => {
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan1Id}/issue`,
      organisationId,
    });
    expect(refused.statusCode).toBe(409);
    const body = refused.json<{ code: string; message: string }>();
    expect(body.code).toBe('SERIALS_INCOMPLETE');
    // Per-line explanation: which item, how many of how many.
    expect(body.message).toContain('A/1');
    expect(body.message).toContain('2 of 3.000');
    // The unflagged short line is NOT reported.
    expect(body.message).not.toContain('A/2');
  });

  it('issues once the count is exact, with unflagged lines untouched', async () => {
    const third = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan1Id}/serials`,
      organisationId,
      payload: { challanItemId: lineFId, serialNumbers: ['F-SN-3'] },
    });
    expect(third.statusCode, third.body).toBe(201);

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan1Id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json<ChallanDetailResponse>().challan.challanNumber).toBe('DC/1');
    // The unflagged line issued with zero serials — post-issue recording
    // remains its flow.
    expect(await serialCount(lineUId)).toBe(0);
  });

  it('keeps the post-issue recording flow for unflagged items', async () => {
    const recorded = await authed(site, {
      method: 'POST',
      url: `/api/challans/${challan1Id}/serials`,
      organisationId,
      payload: { challanItemId: lineUId, serialNumbers: ['U-SN-1'] },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
  });

  it('locks serials of issued flagged lines against deletion, API and database', async () => {
    const [serial] = await admin<{ id: string }[]>`
      select id from challan_item_serials
      where delivery_challan_item_id = ${lineFId} limit 1
    `;
    expect(serial).toBeDefined();

    const refused = await authed(owner, {
      method: 'DELETE',
      url: `/api/serials/${serial?.id ?? ''}`,
      organisationId,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'SERIAL_LOCKED' });

    // The 0015 trigger holds even for a direct superuser delete.
    await expect(
      admin`delete from challan_item_serials where id = ${serial?.id ?? ''}`,
    ).rejects.toThrow(/immutable/);
  });

  it('blocks turning the flag ON while an issued line is incomplete, and explains', async () => {
    // A/2 shipped 2 on the issued DC/1 but has only 1 serial recorded.
    const refused = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${itemUId}/requires-serials`,
      organisationId,
      payload: { requiresSerials: true },
    });
    expect(refused.statusCode).toBe(409);
    const body = refused.json<{ code: string; message: string }>();
    expect(body.code).toBe('SERIALS_INCOMPLETE_FOR_FLAG');
    expect(body.message).toContain('DC/1');
    expect(body.message).toContain('1 of 2.000');

    // Completing the record makes the toggle legal.
    const completing = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan1Id}/serials`,
      organisationId,
      payload: { challanItemId: lineUId, serialNumbers: ['U-SN-2'] },
    });
    expect(completing.statusCode, completing.body).toBe(201);
    const allowed = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${itemUId}/requires-serials`,
      organisationId,
      payload: { requiresSerials: true },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);

    // R7, last sentence: the flag is ONE-WAY once serials exist. A/2
    // already carries U-SN-1 and U-SN-2, so switching it off is refused
    // — turning it off would orphan those serials and silently drop the
    // R6 traceability guarantee.
    const off = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${itemUId}/requires-serials`,
      organisationId,
      payload: { requiresSerials: false },
    });
    expect(off.statusCode, off.body).toBe(409);
    expect(off.json()).toMatchObject({ code: 'SERIALS_EXIST_FOR_FLAG' });
    expect(off.json<{ message: string }>().message).toContain('2 serial(s)');

    // The 0030 trigger holds the same direction against a direct
    // superuser update — the route is not the only guard.
    await expect(
      admin`update work_items set requires_serials = false where id = ${itemUId}`,
    ).rejects.toThrow(/serial tracking cannot be switched off/i);
  });

  it('still lets the flag go off on an item with no serials at all', async () => {
    // D/1 is serial-flagged but nothing has been captured against it, so
    // the toggle is genuinely two-way: nothing would be orphaned. (Turned
    // back on afterwards — the delete-race suite below relies on it.)
    const off = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${itemD1Id}/requires-serials`,
      organisationId,
      payload: { requiresSerials: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ requiresSerials: false });

    const on = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${itemD1Id}/requires-serials`,
      organisationId,
      payload: { requiresSerials: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ requiresSerials: true });
  });
});

describe('tenant-wide serial lookup', () => {
  beforeAll(async () => {
    // Work 2: 51 serials on one draft line for the truncation proof.
    const draft = await draftChallan(work2Id, 'W2', [
      { workItemId: itemWId, quantity: '60' },
    ]);
    const lineW = lineOf(draft, itemWId);
    const serials = Array.from(
      { length: 51 },
      (_, index) => `LOOK-${String(index + 1).padStart(3, '0')}`,
    );
    const recorded = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draft.challan.id}/serials`,
      organisationId,
      payload: { challanItemId: lineW, serialNumbers: serials },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);

    // Receipt + installation state for the issued DC/1 of Work 1.
    const [challan1] = await admin<{ id: string }[]>`
      select id from delivery_challans
      where work_id = ${work1Id} and status = 'issued'
    `;
    if (!challan1) throw new Error('issued work-1 challan missing');
    const receipt = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan1.id}/receipt`,
      organisationId,
      payload: { receivedOn: '2026-08-08', receivedBy: 'SSE / TRD Depot' },
    });
    expect(receipt.statusCode, receipt.body).toBe(201);

    const [installTarget] = await admin<{ id: string }[]>`
      select id from challan_item_serials
      where organisation_id = ${organisationId} and serial_number = 'F-SN-1'
    `;
    if (!installTarget) throw new Error('serial F-SN-1 missing');
    const installed = await authed(owner, {
      method: 'PUT',
      url: `/api/serials/${installTarget.id}/installation`,
      organisationId,
      payload: { installedOn: '2026-08-08', remarks: 'Bay 4' },
    });
    expect(installed.statusCode, installed.body).toBe(200);
  }, 30_000);

  it('rejects queries under 2 characters', async () => {
    const short = await authed(owner, {
      method: 'GET',
      url: '/api/serials/search?q=F',
      organisationId,
    });
    expect(short.statusCode).toBe(400);
  });

  it('finds serials case-insensitively with full delivery context', async () => {
    const found = await authed(owner, {
      method: 'GET',
      url: '/api/serials/search?q=f-sn-1',
      organisationId,
    });
    expect(found.statusCode, found.body).toBe(200);
    const body = found.json<SerialSearchResponse>();
    expect(body.truncated).toBe(false);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({
      serialNumber: 'F-SN-1',
      workId: work1Id,
      workCode: `SEW1-${runId.toUpperCase()}`,
      itemDescription: 'Flagged switchboard',
      challanNumber: 'DC/1',
      challanDate: '2026-08-08',
      challanStatus: 'issued',
      receiptRecorded: true,
      installedOn: '2026-08-08',
    });
  });

  it('caps results at 50 and reports truncation', async () => {
    const truncated = await authed(owner, {
      method: 'GET',
      url: '/api/serials/search?q=look',
      organisationId,
    });
    expect(truncated.statusCode, truncated.body).toBe(200);
    const body = truncated.json<SerialSearchResponse>();
    expect(body.matches).toHaveLength(50);
    expect(body.truncated).toBe(true);
    // Draft-line serials point at the draft (no number yet).
    expect(body.matches[0]).toMatchObject({
      challanNumber: null,
      challanStatus: 'draft',
      receiptRecorded: false,
    });

    const narrowed = await authed(owner, {
      method: 'GET',
      url: '/api/serials/search?q=LOOK-05',
      organisationId,
    });
    expect(narrowed.statusCode).toBe(200);
    const narrowedBody = narrowed.json<SerialSearchResponse>();
    expect(narrowedBody.truncated).toBe(false);
    expect(
      narrowedBody.matches.map((match) => match.serialNumber).sort(),
    ).toStrictEqual(['LOOK-050', 'LOOK-051']);
  });

  it('treats LIKE wildcards in the query as literals', async () => {
    const wildcard = await authed(owner, {
      method: 'GET',
      url: `/api/serials/search?q=${encodeURIComponent('%%')}`,
      organisationId,
    });
    expect(wildcard.statusCode).toBe(200);
    expect(wildcard.json<SerialSearchResponse>().matches).toHaveLength(0);
  });

  it('filters assigned-scope members to their Works', async () => {
    // Work 2 is not assigned to the site member: its serials are invisible.
    const hidden = await authed(site, {
      method: 'GET',
      url: '/api/serials/search?q=look',
      organisationId,
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(hidden.json<SerialSearchResponse>().matches).toHaveLength(0);

    // Work 1 is assigned: its serials are found.
    const visible = await authed(site, {
      method: 'GET',
      url: '/api/serials/search?q=f-sn',
      organisationId,
    });
    expect(visible.statusCode).toBe(200);
    const matches = visible.json<SerialSearchResponse>().matches;
    expect(matches.length).toBeGreaterThanOrEqual(3);
    expect(matches.every((match) => match.workId === work1Id)).toBe(true);
  });

  it('is tenant-isolated', async () => {
    // The other organisation sees none of these serials under its own id…
    const empty = await authed(outsider, {
      method: 'GET',
      url: '/api/serials/search?q=look',
      organisationId: otherOrganisationId,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<SerialSearchResponse>().matches).toHaveLength(0);

    // …and cannot bind this organisation at all.
    const forbidden = await authed(outsider, {
      method: 'GET',
      url: '/api/serials/search?q=look',
      organisationId,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'NOT_A_MEMBER' });
  });

  it('denies cross-tenant serial deletion as not-found', async () => {
    const [serial] = await admin<{ id: string }[]>`
      select id from challan_item_serials
      where organisation_id = ${organisationId} and serial_number = 'LOOK-001'
    `;
    expect(serial).toBeDefined();
    const denied = await authed(outsider, {
      method: 'DELETE',
      url: `/api/serials/${serial?.id ?? ''}`,
      organisationId: otherOrganisationId,
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toMatchObject({ code: 'SERIAL_NOT_FOUND' });
  });
});

describe('concurrency: serial evidence versus issue', () => {
  it('a serial recorded concurrently with issue never yields an incomplete flagged line', async () => {
    const draft = await draftChallan(work3Id, 'W3', [
      { workItemId: itemC1Id, quantity: '2' },
    ]);
    const lineId = lineOf(draft, itemC1Id);
    const first = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draft.challan.id}/serials`,
      organisationId,
      payload: { challanItemId: lineId, serialNumbers: ['C-SN-1'] },
    });
    expect(first.statusCode, first.body).toBe(201);

    const [record, issue] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/challans/${draft.challan.id}/serials`,
        organisationId,
        payload: { challanItemId: lineId, serialNumbers: ['C-SN-2'] },
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/challans/${draft.challan.id}/issue`,
        organisationId,
      }),
    ]);

    // Both interleavings are legal; the invariant is that an ISSUED
    // flagged line is complete. Recording succeeds in either order
    // (draft or issued challans accept serials under the cap).
    expect(record.statusCode, record.body).toBe(201);
    expect([201, 409]).toContain(issue.statusCode);
    const [challan] = await admin<{ status: string }[]>`
      select status from delivery_challans where id = ${draft.challan.id}
    `;
    const count = await serialCount(lineId);
    if (challan?.status === 'issued') {
      expect(issue.statusCode).toBe(201);
      expect(count).toBe(2);
    } else {
      expect(issue.statusCode).toBe(409);
      expect(issue.json()).toMatchObject({ code: 'SERIALS_INCOMPLETE' });
      expect(challan?.status).toBe('draft');
    }
  });

  it('a serial deleted concurrently with issue cannot leave an issued incomplete line', async () => {
    const draft = await draftChallan(work4Id, 'W4', [
      { workItemId: itemD1Id, quantity: '1' },
    ]);
    const lineId = lineOf(draft, itemD1Id);
    const recorded = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draft.challan.id}/serials`,
      organisationId,
      payload: { challanItemId: lineId, serialNumbers: ['D-SN-1'] },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const serialId = recorded.json<SerialListResponse>().serials[0]?.id;
    if (serialId === undefined) throw new Error('recorded serial missing');

    const [deletion, issue] = await Promise.all([
      authed(owner, {
        method: 'DELETE',
        url: `/api/serials/${serialId}`,
        organisationId,
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/challans/${draft.challan.id}/issue`,
        organisationId,
      }),
    ]);

    const [challan] = await admin<{ status: string }[]>`
      select status from delivery_challans where id = ${draft.challan.id}
    `;
    const count = await serialCount(lineId);
    if (issue.statusCode === 201) {
      // Issue won the challan lock: the delete found an issued flagged
      // line and was refused; the record stays complete.
      expect(challan?.status).toBe('issued');
      expect(deletion.statusCode).toBe(409);
      expect(count).toBe(1);
    } else {
      // The delete won: the flagged line went incomplete and the issue
      // was refused inside its transaction.
      expect(issue.statusCode).toBe(409);
      expect(issue.json()).toMatchObject({ code: 'SERIALS_INCOMPLETE' });
      expect(deletion.statusCode).toBe(204);
      expect(challan?.status).toBe('draft');
      expect(count).toBe(0);
    }
  });
});
