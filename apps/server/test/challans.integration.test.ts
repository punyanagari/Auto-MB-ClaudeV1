import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  Contact,
  PurchaseOrderDetailResponse,
  WorkBalanceResponse,
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
const ownerEmail = `dc-owner-${runId}@integration.test`;
const clerkEmail = `dc-clerk-${runId}@integration.test`;
const viewerEmail = `dc-viewer-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let fakeGotenberg: http.Server;
const gotenbergBodies: string[] = [];
let organisationId: string;
let ownerUserId: string;
let workId: string;
let itemAId: string;
let itemBId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let clerk: CookieJar;
let viewer: CookieJar;

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

const CONSIGNEE = {
  name: 'Sr. DEE (G) NR',
  address: 'Delhi Division, New Delhi',
};

function draftBody(
  items: { workItemId: string; quantity: string; purchaseOrderLineId?: string }[],
) {
  return {
    challanDate: '2026-08-08',
    prefix: 'DC',
    consignee: CONSIGNEE,
    items,
  };
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-challan-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the challan integration tests. ' +
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

  // A stub PDF service: the render endpoint's full HTTP path runs against
  // it without depending on a real Gotenberg container. The real service
  // is proven at staging (docs/ROADMAP.md Milestone 4). Request bodies
  // are retained so tests can assert on the exact HTML the route sent.
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-dc-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    gotenbergUrl: `http://127.0.0.1:${String(gotenbergAddress.port)}`,
  });

  owner = await signUp(ownerEmail, 'DC Owner');
  clerk = await signUp(clerkEmail, 'DC Clerk');
  viewer = await signUp(viewerEmail, 'DC Viewer');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'DC Constructions', slug: `dc-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  for (const [email, role] of [
    [clerkEmail, 'office'],
    [viewerEmail, 'viewer'],
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

  // Issue/cancel are explicit authorities, granted here to the owner only:
  // the clerk keeps drafting rights without either authority.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  // Fixture Work: two items, 5.000 and 2.000 awarded.
  workId = randomUUID();
  const scheduleId = randomUUID();
  itemAId = randomUUID();
  itemBId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, letter_percentage,
      letter_percentage_direction, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`DCW-${runId.toUpperCase()}`},
      ${`dc-letter-${runId}`}, '2025-06-01', 'Challan fixture work',
      1000.00, 900.00, 'per_schedule', null, null, ${ownerUserId}
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
       'Main switchboard', 'Nos', 5.000, 100.00),
      (${itemBId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/2',
       'Cable set', 'Set', 2.000, 250.50)
  `;
}, 60_000);

afterAll(async () => {
  if (admin) {
    if (organisationId) {
      // The immutability triggers (rightly) block deleting issued challan
      // rows; fixture cleanup is exactly the case session_replication_role
      // exists for.
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'approval_requests',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'purchase_order_lines',
          'purchase_order_counters',
          'purchase_orders',
          'contacts',
          'work_items',
          'work_schedules',
          'loa_documents',
          'works',
          'organisation_memberships',
          'organisations',
        ]) {
          await admin.unsafe(
            `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
            [organisationId],
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
  await admin?.end();
  if (fakeGotenberg) {
    await new Promise<void>((resolve) => {
      fakeGotenberg.close(() => {
        resolve();
      });
    });
  }
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('Delivery Challan lifecycle', () => {
  let firstChallanId: string;
  let secondChallanId: string;

  it('drafts a challan with snapshotted lines and exact line amounts', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: draftBody([{ workItemId: itemAId, quantity: '3' }]),
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<ChallanDetailResponse>();
    firstChallanId = detail.challan.id;
    expect(detail.challan.status).toBe('draft');
    expect(detail.challan.challanNumber).toBeNull();
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({
      description: 'Main switchboard',
      unit: 'Nos',
      rate: '100.00',
      lineAmount: '300.00',
    });
  });

  it('enforces one draft per Work, naming the existing draft in the 409', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: draftBody([{ workItemId: itemBId, quantity: '1' }]),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'DRAFT_EXISTS',
      details: { existingRecordId: firstChallanId },
    });
  });

  it('rejects challan dates outside the product-contract window', async () => {
    // Not in the futureâ€¦
    const future = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        ...draftBody([{ workItemId: itemAId, quantity: '1' }]),
        challanDate: '2031-01-01',
      },
    });
    expect(future.statusCode, future.body).toBe(400);
    expect(future.json()).toMatchObject({ code: 'CHALLAN_DATE_INVALID' });

    // â€¦and never before the Work's LOA letter date (2025-06-01 here).
    const beforeLetter = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        ...draftBody([{ workItemId: itemAId, quantity: '1' }]),
        challanDate: '2025-05-31',
      },
    });
    expect(beforeLetter.statusCode, beforeLetter.body).toBe(400);
    expect(beforeLetter.json()).toMatchObject({ code: 'CHALLAN_DATE_INVALID' });
  });

  it('refuses draft edits to read-only roles and accepts them from office', async () => {
    const denied = await authed(viewer, {
      method: 'PUT',
      url: `/api/challans/${firstChallanId}`,
      organisationId,
      payload: draftBody([{ workItemId: itemAId, quantity: '3' }]),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });

    const updated = await authed(clerk, {
      method: 'PUT',
      url: `/api/challans/${firstChallanId}`,
      organisationId,
      payload: draftBody([
        { workItemId: itemAId, quantity: '3' },
        { workItemId: itemBId, quantity: '1.5' },
      ]),
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const detail = updated.json<ChallanDetailResponse>();
    expect(detail.items).toHaveLength(2);
    expect(detail.items[1]).toMatchObject({
      lineAmount: '375.75',
      position: 2,
    });
  });

  it('requires explicit issue authority', async () => {
    const response = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${firstChallanId}/issue`,
      organisationId,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });
  });

  it('issues with a serialised number and an immutable snapshot', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${firstChallanId}/issue`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<ChallanDetailResponse>();
    expect(detail.challan.status).toBe('issued');
    expect(detail.challan.challanNumber).toBe('DC/1');
    expect(detail.challan.sequenceNumber).toBe(1);
    expect(detail.challan.issuedAt).not.toBeNull();
    const snapshot = detail.issuedSnapshot as {
      challanNumber: string;
      totalAmount: string;
      items: { itemNumber: string; lineAmount: string }[];
      consignee: { name: string };
    };
    expect(snapshot.challanNumber).toBe('DC/1');
    expect(snapshot.totalAmount).toBe('675.75');
    expect(snapshot.items.map((item) => item.itemNumber)).toEqual(['A/1', 'A/2']);
    expect(snapshot.consignee.name).toBe(CONSIGNEE.name);
  });

  it('reflects issued quantities in the Work balance', async () => {
    const response = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/balance`,
      organisationId,
    });
    expect(response.statusCode).toBe(200);
    const balance = response.json<WorkBalanceResponse>();
    const itemA = balance.items.find((item) => item.workItemId === itemAId);
    expect(Number(itemA?.deliveredQuantity)).toBe(3);
    expect(Number(itemA?.remainingQuantity)).toBe(2);
  });

  it('returns the Organisation-local legal date in the Work balance', async () => {
    const [original] = await admin<{ timezone: string }[]>`
      select timezone
      from organisations
      where id = ${organisationId}
    `;
    expect(original).toBeDefined();

    try {
      await admin`
        update organisations
        set timezone = case
          when (now() at time zone 'Etc/GMT+12')::date <>
               (now() at time zone 'UTC')::date
            then 'Etc/GMT+12'
          else 'Pacific/Kiritimati'
óÞ¶¶‰žËkºwµçPÝ…ÌÍ…Ù•¸Q¡”‘É…™Ð(€€€€¼¼ÍÑ¥±°…ÉÉ¥•ÌÑ¡”ÍÕÁ•ÉÍ•‘•Í¹…ÁÍ¡½Ð°…¹¥ÍÍÕ”Ý½Õ±™É••é”¥Ð(€€€€¼¼¥¹Ñ¼Ñ¡”‘½Õµ•¹Ð¡…¹‘•Ñ¼Ñ¡”½¹Í¥¹•”¸(€€€½¹ÍÐ…µ•¹‘•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÍÑ…±•]½É­%‘ô½…µ•¹‘µ•¹ÑÍ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€Ý½É­%Ñ•µ%èÍÑ…±•%Ñ•µ%°(€€€€€€€É•…Í½¸è€I…Ñ”É•Ù¥Í•‰äÙ…É¥…Ñ¥½¸€Ð¸œ°(€€€€€€€¡…¹•ÌèìÉ…Ñ”è€œÄÄÀ¸ÀÀœô°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡…µ•¹‘•¹ÍÑ…ÑÕÍ½‘”°…µ•¹‘•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì((€€€½¹ÍÐ‰±½­•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í‘É…™Ñ%‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡‰±½­•¹ÍÑ…ÑÕÍ½‘”°‰±½­•¹‰½‘ä¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡‰±½­•¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€IQ}MQ1œô¤ì(€€€½¹ÍÐµ•ÍÍ…”€ô‰±½­•¹©Í½¸ñìµ•ÍÍ…”èÍÑÉ¥¹œôø ¤¹µ•ÍÍ…”ì(€€€•áÁ•Ð¡µ•ÍÍ…”¤¹Ñ½½¹Ñ…¥¸ ¼Äœ¤ì(€€€•áÁ•Ð¡µ•ÍÍ…”¤¹Ñ½½¹Ñ…¥¸ É…Ñ”œ¤ì((€€€€¼¼9½Ñ¡¥¹œÝ…Ì¹Õµ‰•É•½È¥ÍÍÕ•‰äÑ¡”É•™ÕÍ•…ÑÑ•µÁÐ¸(€€€½¹ÍÐÍÑ¥±°€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í‘É…™Ñ%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡ÍÑ¥±°¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¡…±±…¸¹ÍÑ…ÑÕÌ¤¹Ñ½	” ‘É…™Ðœ¤ì(€€€•áÁ•Ð¡ÍÑ¥±°¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¡…±±…¸¹¡…±±…¹9Õµ‰•È¤¹Ñ½	•9Õ±° ¤ì(€ô¤ì((€¥Ð ¥ÍÍÕ•Ì…ÐÑ¡”…µ•¹‘•É…Ñ”½¹”Ñ¡”‘É…™Ð¥ÌÉ”µÍ…Ù•œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ±¥ÍÐ€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÍÑ…±•]½É­%‘ô½¡…±±…¹Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€½¹ÍÐ‘É…™Ð€ô±¥ÍÐ(€€€€€€¹©Í½¸ñì¡…±±…¹Ìè¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í•l¡…±±…¸umtôø ¤(€€€€€€¹¡…±±…¹Ì¹™¥¹ ¡¡…±±…¸¤€ôø¡…±±…¸¹ÍÑ…ÑÕÌ€ôôô€‘É…™Ðœ¤ì(€€€¥˜€ …‘É…™Ð¤Ñ¡É½Ü¹•ÜÉÉ½È ÍÑ…±”‘É…™Ðµ¥ÍÍ¥¹œœ¤ì((€€€€¼¼I”µÍ…Ù¥¹œÑ¡”‘É…™Ð¥ÌÑ¡”‘½Õµ•¹Ñ•É•Á…¥ÈèÑ¡”½Á•É…Ñ½ÈÍ••Ì(€€€€¼¼Ñ¡”¹•Ü…µ½Õ¹ÑÌ½¸ÍÉ••¸‰•™½É”Ñ¡•ä½µµ¥ÐÑ¼Ñ¡•´¸(€€€½¹ÍÐÉ•Í…Ù•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í‘É…™Ð¹¥‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€€¸¸¹‘É…™Ñ	½‘ä¡mìÝ½É­%Ñ•µ%èÍÑ…±•%Ñ•µ%°ÅÕ…¹Ñ¥Ñäè€œÈœõt¤°(€€€€€€€ÁÉ•™¥àè€Lœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•Í…Ù•¹ÍÑ…ÑÕÍ½‘”°É•Í…Ù•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡É•Í…Ù•¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¥Ñ•µÍlÁt¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€É…Ñ”è€œÄÄÀ¸ÀÀœ°(€€€€€±¥¹•µ½Õ¹Ðè€œÈÈÀ¸ÀÀœ°(€€€ô¤ì((€€€½¹ÍÐ¥ÍÍÕ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í‘É…™Ð¹¥‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡¥ÍÍÕ•¹ÍÑ…ÑÕÍ½‘”°¥ÍÍÕ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐÍ¹…ÁÍ¡½Ð€ô¥ÍÍÕ•¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¥ÍÍÕ•‘M¹…ÁÍ¡½Ð…Ìì(€€€€€Ñ½Ñ…±µ½Õ¹ÐèÍÑÉ¥¹œì(€€€€€¥Ñ•µÌèìÉ…Ñ”èÍÑÉ¥¹œõmtì(€€€ôì(€€€•áÁ•Ð¡Í¹…ÁÍ¡½Ð¹¥Ñ•µÍlÁtü¹É…Ñ”¤¹Ñ½	” œÄÄÀ¸ÀÀœ¤ì(€€€•áÁ•Ð¡Í¹…ÁÍ¡½Ð¹Ñ½Ñ…±µ½Õ¹Ð¤¹Ñ½	” œÈÈÀ¸ÀÀœ¤ì(€ô¤ì((€¥Ð ±•…Ù•Ì„‘É…™Ð…±½¹”Ý¡•¸Ñ¡”…µ•¹‘µ•¹ÐÑ½Õ¡•½¹±äÑ¡”ÅÕ…¹Ñ¥Ñäœ°…Íå¹Œ€ ¤€ôøì(€€€€¼¼Q¡”•¥±¥¹œ¡•¬…±É•…‘ä½Ù•ÉÌÅÕ…¹Ñ¥Ñäì„ÅÕ…¹Ñ¥Ñäµ½¹±ä(€€€€¼¼…µ•¹‘µ•¹ÐµÕÍÐ¹½ÐÍÑÉ…¹„‘É…™ÐÑ¡…Ð¥ÌÍÑ¥±°Ý¥Ñ¡¥¸¥Ð¸(€€€½¹ÍÐÉ•…Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÍÑ…±•]½É­%‘ô½¡…±±…¹Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€€¸¸¹‘É…™Ñ	½‘ä¡mìÝ½É­%Ñ•µ%èÍÑ…±•%Ñ•µ%°ÅÕ…¹Ñ¥Ñäè€œÄœõt¤°(€€€€€€€ÁÉ•™¥àè€Lœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐ‘É…™Ñ%€ôÉ•…Ñ•¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¡…±±…¸¹¥ì((€€€½¹ÍÐ…µ•¹‘•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÍÑ…±•]½É­%‘ô½…µ•¹‘µ•¹ÑÍ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€Ý½É­%Ñ•µ%èÍÑ…±•%Ñ•µ%°(€€€€€€€É•…Í½¸è€EÕ…¹Ñ¥ÑäÉ…¥Í•‰äÙ…É¥…Ñ¥½¸€Ô¸œ°(€€€€€€€¡…¹•ÌèìÅÕ…¹Ñ¥Ñäè€œØœô°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡…µ•¹‘•¹ÍÑ…ÑÕÍ½‘”°…µ•¹‘•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì((€€€½¹ÍÐ¥ÍÍÕ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í‘É…™Ñ%‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡¥ÍÍÕ•¹ÍÑ…ÑÕÍ½‘”°¥ÍÍÕ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€ô¤ì)ô¤ì((¼¨¨(€¨Q¡”€ÀÀÌÌÉ••¥ÁÐ±¥¹¬°•¹Ñ¼•¹Ñ¡É½Õ Ñ¡”A$è„¡…±±…¸±¥¹”¹…µ•Ì(€¨Ñ¡”%MMUÁÕÉ¡…Í”µ½É‘•È±¥¹”¥ÐÉ••¥Ù•Ì……¥¹ÍÐ€¡¹¼µ½É”…‘µ¥¸ME0ƒŠP(€¨Ñ¡”Ý½É­…É½Õ¹Ñ¡”±¥™•å±”…¹ÁÕÉ¡…Í”µ½É‘•ÈÍÕ¥Ñ•Ì…ÉÉä¤¸Q¡”±¥¹¬(€¨¥ÌÙ…±¥‘…Ñ•€¡Í…µ”]½É¬°½É‘•È…ÑÕ…±±ä¥ÍÍÕ•¤°Í•ÉÙ•‰…¬°É•ÝÉ¥ÑÑ•¸(€¨™É••±äÝ¡¥±”Ñ¡”¡…±±…¸¥Ì„‘É…™Ð°…¹½Ù•ÈµÉ••¥ÁÐ¥Ì„]I9%9½¸(€¨Ñ¡”É•…µ½‘•°ƒŠPÙ•¹‘½ÉÌ½Ù•ÈµÍ¡¥À°…¹Ñ¡”‘•±¥Ù•Éä‘½Õµ•¹ÐµÕÍÐ(€¨É•½ÉÝ¡…Ð…ÑÕ…±±ä…ÉÉ¥Ù•¸(€¨¼)‘•ÍÉ¥‰” ¡…±±…¸±¥¹•ÌÉ••¥Ù•……¥¹ÍÐÁÕÉ¡…Í”µ½É‘•È±¥¹•Ì€ ÀÀÌÌÉ••¥ÁÐ±¥¹¬¤œ°€ ¤€ôøì(€±•Ð±¥¹­]½É­%èÍÑÉ¥¹œì(€±•Ð±¥¹­%Ñ•µ%èÍÑÉ¥¹œì(€±•ÐÙ•¹‘½É½¹Ñ…Ñ%èÍÑÉ¥¹œì(€±•ÐÁÕÉ¡…Í•=É‘•É%èÍÑÉ¥¹œì(€±•ÐÁ½9Õµ‰•ÈèÍÑÉ¥¹œì(€±•ÐÁ½1¥¹•%èÍÑÉ¥¹œì(€±•Ð‘É…™ÑA½1¥¹•%èÍÑÉ¥¹œì(€±•ÐÉ½ÍÍ]½É­A½1¥¹•%èÍÑÉ¥¹œì(€±•Ð¡…±±…¹%èÍÑÉ¥¹œì((€€¼¨¨É•…Ñ•Ì„ÁÕÉ¡…Í”½É‘•È½¸Ñ¡”]½É¬Ý¥Ñ ½¹”±¥¹”½É‘•É¥¹œ(€€€¨ÅÕ…¹Ñ¥Ñå€½˜Ñ…É•Ñ%Ñ•µ%‘€°…¹¥ÍÍÕ•Ì¥Ð¸€¨¼(€…Íå¹Œ™Õ¹Ñ¥½¸¥ÍÍÕ•‘AÕÉ¡…Í•=É‘•È (€€€Ñ…É•Ñ]½É­%èÍÑÉ¥¹œ°(€€€Ñ…É•Ñ%Ñ•µ%èÍÑÉ¥¹œ°(€€€ÅÕ…¹Ñ¥ÑäèÍÑÉ¥¹œ°(€€¤èAÉ½µ¥Í”ñì¥èÍÑÉ¥¹œì±¥¹•%èÍÑÉ¥¹œì¹Õµ‰•ÈèÍÑÉ¥¹œôøì(€€€½¹ÍÐÉ•…Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÑ…É•Ñ]½É­%‘ô½ÁÕÉ¡…Í”µ½É‘•ÉÍ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èìÙ•¹‘½É½¹Ñ…Ñ%°Á½…Ñ”è€œÈÀÈÔ´ÀÜ´ÀÄœô°(€€€ô¤ì(€€€•áÁ•Ð¡É•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐ¥€ôÉ•…Ñ•¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹ÁÕÉ¡…Í•=É‘•È¹¥ì(€€€½¹ÍÐ±¥¹•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘í¥‘ô½±¥¹•Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€±¥¹•Ìèl(€€€€€€€€€ì(€€€€€€€€€€€Ý½É­%Ñ•µ%èÑ…É•Ñ%Ñ•µ%°(€€€€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸è€Éµ½ÕÉ•…‰±”‘ÉÕµÌœ°(€€€€€€€€€€€Õ¹¥Ñ½‘”è€9½Ìœ°(€€€€€€€€€€€ÅÕ…¹Ñ¥Ñä°(€€€€€€€€€€€É…Ñ”è€œäÀ¸ÀÀœ°(€€€€€€€€€ô°(€€€€€€€t°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡±¥¹•¹ÍÑ…ÑÕÍ½‘”°±¥¹•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐ¥ÍÍÕ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘í¥‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡¥ÍÍÕ•¹ÍÑ…ÑÕÍ½‘”°¥ÍÍÕ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐ‘•Ñ…¥°€ô¥ÍÍÕ•¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€½¹ÍÐ±¥¹•%€ô‘•Ñ…¥°¹±¥¹•ÍlÁtü¹¥ì(€€€½¹ÍÐ¹Õµ‰•È€ô‘•Ñ…¥°¹ÁÕÉ¡…Í•=É‘•È¹Á½9Õµ‰•Èì(€€€¥˜€ …±¥¹•%ñð¹Õµ‰•È€ôôô¹Õ±°¤ì(€€€€€Ñ¡É½Ü¹•ÜÉÉ½È ¥ÍÍÕ•ÁÕÉ¡…Í”½É‘•È…µ”‰…¬¥¹½µÁ±•Ñ”œ¤ì(€€€ô(€€€É•ÑÕÉ¸ì¥°±¥¹•%°¹Õµ‰•Èôì(€ô((€‰•™½É•±°¡…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ±¥¹­•€ô…Ý…¥Ð™É•Í¡]½É¬ @œ°ì(€€€€€‘•ÍÉ¥ÁÑ¥½¸è€Éµ½ÕÉ•…‰±”‘ÉÕ´œ°(€€€€€Õ¹¥Ðè€9½Ìœ°(€€€€€ÅÕ…¹Ñ¥Ñäè€œÄÀ¸ÀÀÀœ°(€€€€€É…Ñ”è€œÄÀÀ¸ÀÀœ°(€€€ô¤ì(€€€±¥¹­]½É­%€ô±¥¹­•¹Ý½É­%ì(€€€±¥¹­%Ñ•µ%€ô±¥¹­•¹Ý½É­%Ñ•µ%ì((€€€€¼¼Q¡”Ù•¹‘½È¥ÌÉ•…Ñ•Q!I=U Ñ¡”½¹Ñ…ÑÌA$èÑ¡”¥ÍY•¹‘½È™±…œ(€€€€¼¼¥ÌÑ¡”µ…ÍÑ•ÉÌ¡…±˜½˜Ñ¡¥ÌÍ±¥”°Í¼Ñ¡”Í••‘¥¹œÑ¡…ÐÕÍ•Ñ¼‰”(€€€€¼¼…‘µ¥¸ME0¥Ì¹½ÜÑ¡”ÁÉ½‘ÕÐÁ…Ñ ¸(€€€½¹ÍÐÙ•¹‘½È€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€œ½…Á¤½µ…ÍÑ•ÉÌ½½¹Ñ…ÑÌœ°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€‘•Í¥¹…Ñ¥½¸è	¡…É…Ð…‰±•ÌAÙÐ1Ñ€‘íÉÕ¹%‘õ€°(€€€€€€€…‘‘É•ÍÌè€A±½Ð€ÄÈ°5%°AÕ¹”œ°(€€€€€€€¥ÍY•¹‘½ÈèÑÉÕ”°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡Ù•¹‘½È¹ÍÑ…ÑÕÍ½‘”°Ù•¹‘½È¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€•áÁ•Ð¡Ù•¹‘½È¹©Í½¸ñ½¹Ñ…Ðø ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€¥ÍY•¹‘½ÈèÑÉÕ”°(€€€€€¥Í½¹Í¥¹•”è™…±Í”°(€€€ô¤ì(€€€Ù•¹‘½É½¹Ñ…Ñ%€ôÙ•¹‘½È¹©Í½¸ñ½¹Ñ…Ðø ¤¹¥ì((€€€½¹ÍÐ½É‘•È€ô…Ý…¥Ð¥ÍÍÕ•‘AÕÉ¡…Í•=É‘•È¡±¥¹­]½É­%°±¥¹­%Ñ•µ%°€œÐœ¤ì(€€€ÁÕÉ¡…Í•=É‘•É%€ô½É‘•È¹¥ì(€€€Á½1¥¹•%€ô½É‘•È¹±¥¹•%ì(€€€Á½9Õµ‰•È€ô½É‘•È¹¹Õµ‰•Èì((€€€€¼¼Í•½¹]½É¬Ý¥Ñ ¥ÑÌ½Ý¸%MMU½É‘•Èè¥ÑÌ±¥¹•ÌµÕÍÐÍÑ…ä(€€€€¼¼¥¹Ù¥Í¥‰±”Ñ¼Ñ¡¥Ì]½É¬Ì¡…±±…¹Ì¸(€€€½¹ÍÐ½Ñ¡•È€ô…Ý…¥Ð™É•Í¡]½É¬ `œ°ì(€€€€€‘•ÍÉ¥ÁÑ¥½¸è€½É•¥¸É•±…äÍ•Ðœ°(€€€€€Õ¹¥Ðè€9½Ìœ°(€€€€€ÅÕ…¹Ñ¥Ñäè€œÄÀ¸ÀÀÀœ°(€€€€€É…Ñ”è€œÄÀÀ¸ÀÀœ°(€€€ô¤ì(€€€É½ÍÍ]½É­A½1¥¹•%€ô€¡…Ý…¥Ð¥ÍÍÕ•‘AÕÉ¡…Í•=É‘•È¡½Ñ¡•È¹Ý½É­%°½Ñ¡•È¹Ý½É­%Ñ•µ%°€œÐœ¤¤(€€€€€€¹±¥¹•%ì((€€€€¼¼¹…¸½Á•¸IP½É‘•È½¸Ñ¡¥Ì]½É¬è¥Ð•á¥ÍÑÌ°‰ÕÐ¹½Ñ¡¥¹œ¡…Ì(€€€€¼¼‰••¸½É‘•É•™É½´Ñ¡”Ù•¹‘½Èå•Ð°Í¼¹½Ñ¡¥¹œ…¸‰”É••¥Ù•½¸¥Ð¸(€€€½¹ÍÐ‘É…™Ð€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘í±¥¹­]½É­%‘ô½ÁÕÉ¡…Í”µ½É‘•ÉÍ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èìÙ•¹‘½É½¹Ñ…Ñ%°Á½…Ñ”è€œÈÀÈÔ´ÀÜ´ÀÄœô°(€€€ô¤ì(€€€•áÁ•Ð¡‘É…™Ð¹ÍÑ…ÑÕÍ½‘”°‘É…™Ð¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐ‘É…™Ñ=É‘•É%€ô‘É…™Ð¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹ÁÕÉ¡…Í•=É‘•È¹¥ì(€€€½¹ÍÐ‘É…™Ñ1¥¹•Ì€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘í‘É…™Ñ=É‘•É%‘ô½±¥¹•Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€±¥¹•Ìèl(€€€€€€€€€ì(€€€€€€€€€€€Ý½É­%Ñ•µ%è±¥¹­%Ñ•µ%°(€€€€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸è€…‰±”‘ÉÕµÌ°Í•½¹±½Ðœ°(€€€€€€€€€€€Õ¹¥Ñ½‘”è€9½Ìœ°(€€€€€€€€€€€ÅÕ…¹Ñ¥Ñäè€œÈœ°(€€€€€€€€€€€É…Ñ”è€œäÀ¸ÀÀœ°(€€€€€€€€€ô°(€€€€€€€t°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡‘É…™Ñ1¥¹•Ì¹ÍÑ…ÑÕÍ½‘”°‘É…™Ñ1¥¹•Ì¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐ‘É…™Ñ1¥¹•%€ô‘É…™Ñ1¥¹•Ì¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹±¥¹•ÍlÁtü¹¥ì(€€€¥˜€ …‘É…™Ñ1¥¹•%¤Ñ¡É½Ü¹•ÜÉÉ½È ‘É…™ÐÁÕÉ¡…Í”½É‘•È±¥¹”µ¥ÍÍ¥¹œœ¤ì(€€€‘É…™ÑA½1¥¹•%€ô‘É…™Ñ1¥¹•%ì(€ô°€ÐÕ|ÀÀÀ¤ì((€¥Ð ±¥¹­Ì„‘É…™Ð±¥¹”Ñ¼…¸¥ÍÍÕ•ÁÕÉ¡…Í”µ½É‘•È±¥¹”…¹Í•ÉÙ•Ì¥Ð‰…¬œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•…Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘í±¥¹­]½É­%‘ô½¡…±±…¹Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€€¸¸¹‘É…™Ñ	½‘ä¡l(€€€€€€€€€ìÝ½É­%Ñ•µ%è±¥¹­%Ñ•µ%°ÅÕ…¹Ñ¥Ñäè€œÌœ°ÁÕÉ¡…Í•=É‘•É1¥¹•%èÁ½1¥¹•%ô°(€€€€€€€t¤°(€€€€€€€ÁÉ•™¥àè€@œ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐ‘•Ñ…¥°€ôÉ•…Ñ•¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€¡…±±…¹%€ô‘•Ñ…¥°¹¡…±±…¸¹¥ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹¥Ñ•µÍlÁtü¹ÁÕÉ¡…Í•=É‘•É1¥¹•%¤¹Ñ½	”¡Á½1¥¹•%¤ì(€€€€¼¼Q¡É•”½˜Ñ¡”™½ÕÈ½É‘•É•èÝ¥Ñ¡¥¸Ñ¡”½É‘•È°¹½Ñ¡¥¹œÑ¼Ý…É¸…‰½ÕÐ¸(€€€•áÁ•Ð¡‘•Ñ…¥°¹Ý…É¹¥¹Ì¤¹Ñ½ÅÕ…°¡mt¤ì(€ô¤ì((€¥Ð ‰É•™ÕÍ•Ì…¹½Ñ¡•È]½É¬Ì½É‘•È±¥¹”€ ÐÀÐ¤…¹„‘É…™Ð½É‘•È€ ÐÀä¤°ÝÉ¥Ñ¥¹œ¹½Ñ¡¥¹œˆ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•ÝÉ¥Ñ”€ô€¡ÁÕÉ¡…Í•=É‘•É1¥¹•%èÍÑÉ¥¹œ¤€ôø(€€€€€…ÕÑ¡•¡½Ý¹•È°ì(€€€€€€€µ•Ñ¡½è€AUPœ°(€€€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í¡…±±…¹%‘õ€°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€Á…å±½…èì(€€€€€€€€€€¸¸¹‘É…™Ñ	½‘ä¡l(€€€€€€€€€€€ìÝ½É­%Ñ•µ%è±¥¹­%Ñ•µ%°ÅÕ…¹Ñ¥Ñäè€œÌœ°ÁÕÉ¡…Í•=É‘•É1¥¹•%ô°(€€€€€€€€€t¤°(€€€€€€€€€ÁÉ•™¥àè€@œ°(€€€€€€€ô°(€€€€€ô¤ì((€€€€¼¼¹½Ñ¡•È]½É¬ÌÁÉ½ÕÉ•µ•¹Ð…¹ÍÝ•ÉÌ•á…Ñ±ä±¥­”…¸Õ¹­¹½Ý¸¥¸(€€€½¹ÍÐÉ½ÍÍ]½É¬€ô…Ý…¥ÐÉ•ÝÉ¥Ñ”¡É½ÍÍ]½É­A½1¥¹•%¤ì(€€€•áÁ•Ð¡É½ÍÍ]½É¬¹ÍÑ…ÑÕÍ½‘”°É½ÍÍ]½É¬¹‰½‘ä¤¹Ñ½	” ÐÀÐ¤ì(€€€•áÁ•Ð¡É½ÍÍ]½É¬¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€A=}1%9}9=Q}=U9œô¤ì(€€€•áÁ•Ð¡É½ÍÍ]½É¬¹©Í½¸ñìµ•ÍÍ…”èÍÑÉ¥¹œôø ¤¹µ•ÍÍ…”¤¹Ñ½½¹Ñ…¥¸ 1¥¹”€Äœ¤ì((€€€½¹ÍÐÕ¹­¹½Ý¸€ô…Ý…¥ÐÉ•ÝÉ¥Ñ” œÀÀÀÀÀÀÀÀ´ÀÀÀÀ´ÐÀÀÀ´àÀÀÀ´ÀÀÀÀÀÀÀÀÀÀÀÀœ¤ì(€€€•áÁ•Ð¡Õ¹­¹½Ý¸¹ÍÑ…ÑÕÍ½‘”°Õ¹­¹½Ý¸¹‰½‘ä¤¹Ñ½	” ÐÀÐ¤ì(€€€•áÁ•Ð¡Õ¹­¹½Ý¸¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€A=}1%9}9=Q}=U9œô¤ì((€€€€¼¼‘É…™Ð½É‘•È¡…Ì¹½Ð‰••¸Á±…•½¸Ñ¡”Ù•¹‘½Èå•Ð¸(€€€½¹ÍÐ¹½Ñ%ÍÍÕ•€ô…Ý…¥ÐÉ•ÝÉ¥Ñ”¡‘É…™ÑA½1¥¹•%¤ì(€€€•áÁ•Ð¡¹½Ñ%ÍÍÕ•¹ÍÑ…ÑÕÍ½‘”°¹½Ñ%ÍÍÕ•¹‰½‘ä¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡¹½Ñ%ÍÍÕ•¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€A=}9=Q}%MMUœô¤ì(€€€•áÁ•Ð¡¹½Ñ%ÍÍÕ•¹©Í½¸ñìµ•ÍÍ…”èÍÑÉ¥¹œôø ¤¹µ•ÍÍ…”¤¹Ñ½½¹Ñ…¥¸ ‘É…™Ðœ¤ì((€€€€¼¼Ù•ÉäÉ•™ÕÍ…°É½±±•¥ÑÌÉ•ÝÉ¥Ñ”‰…¬èÑ¡”Í…Ù•±¥¹¬¥ÌÕ¹Ñ½Õ¡•¸(€€€½¹ÍÐÉ•É•…€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í¡…±±…¹%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•É•…¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¥Ñ•µÍlÁt¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÅÕ…¹Ñ¥Ñäè€œÌ¸ÀÀÀœ°(€€€€€ÁÕÉ¡…Í•=É‘•É1¥¹•%èÁ½1¥¹•%°(€€€ô¤ì(€ô¤ì((€¥Ð ­••ÁÌ‘É…™ÐÉ•ÝÉ¥Ñ•ÌÝ½É­¥¹œèÑ¡”±¥¹¬…¸‰”‘É½ÁÁ•…¹É”µÁ½¥¹Ñ•œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ‘É½ÁÁ•€ô…Ý…¥Ð…ÕÑ¡•¡±•É¬°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í¡…±±…¹%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€€¸¸¹‘É…™Ñ	½‘ä¡mìÝ½É­%Ñ•µ%è±¥¹­%Ñ•µ%°ÅÕ…¹Ñ¥Ñäè€œÌœõt¤°(€€€€€€€ÁÉ•™¥àè€@œ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡‘É½ÁÁ•¹ÍÑ…ÑÕÍ½‘”°‘É½ÁÁ•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð (€€€€€‘É½ÁÁ•¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¥Ñ•µÍlÁtü¹ÁÕÉ¡…Í•=É‘•É1¥¹•%°(€€€€¤¹Ñ½	•9Õ±° ¤ì((€€€½¹ÍÐÉ•±¥¹­•€ô…Ý…¥Ð…ÕÑ¡•¡±•É¬°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í¡…±±…¹%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€€¸¸¹‘É…™Ñ	½‘ä¡l(€€€€€€€€€ìÝ½É­%Ñ•µ%è±¥¹­%Ñ•µ%°ÅÕ…¹Ñ¥Ñäè€œÌœ°ÁÕÉ¡…Í•=É‘•É1¥¹•%èÁ½1¥¹•%ô°(€€€€€€€t¤°(€€€€€€€ÁÉ•™¥àè€@œ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•±¥¹­•¹ÍÑ…ÑÕÍ½‘”°É•±¥¹­•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡É•±¥¹­•¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¥Ñ•µÍlÁtü¹ÁÕÉ¡…Í•=É‘•É1¥¹•%¤¹Ñ½	” (€€€€€Á½1¥¹•%°(€€€€¤ì(€ô¤ì((€¥Ð Ý…É¹ÌƒŠP¹•Ù•ÈÉ•™ÕÍ•ÌƒŠPÝ¡•¸Ñ¡”‘•±¥Ù•Éä½Ù•ÈµÉ••¥Ù•ÌÑ¡”½É‘•É•ÅÕ…¹Ñ¥Ñäœ°…Íå¹Œ€ ¤€ôøì(€€€€¼¼Q¡”Ù•¹‘½ÈÍ¡¥ÁÁ•™¥Ù”……¥¹ÍÐÑ¡”™½ÕÈ½É‘•É•¸Q¡”Í…Ù”¥Ì(€€€€¼¼…•ÁÑ•ìÑ¡”É•ÍÁ½¹Í”…ÉÉ¥•ÌÑ¡”½Ù•ÈµÉ••¥ÁÐ¹½Ñ¥”¥¹ÍÑ•…¸(€€€½¹ÍÐÍ…Ù•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í¡…±±…¹%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€€¸¸¹‘É…™Ñ	½‘ä¡l(€€€€€€€€€ìÝ½É­%Ñ•µ%è±¥¹­%Ñ•µ%°ÅÕ…¹Ñ¥Ñäè€œÔœ°ÁÕÉ¡…Í•=É‘•É1¥¹•%èÁ½1¥¹•%ô°(€€€€€€€t¤°(€€€€€€€ÁÉ•™¥àè€@œ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡Í…Ù•¹ÍÑ…ÑÕÍ½‘”°Í…Ù•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡Í…Ù•¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹Ý…É¹¥¹Ì¤¹Ñ½ÅÕ…°¡l(€€€€€ì(€€€€€€€ÁÕÉ¡…Í•=É‘•É1¥¹•%èÁ½1¥¹•%°(€€€€€€€Á½9Õµ‰•È°(€€€€€€€Á½1¥¹•9Õµ‰•Èè€Ä°(€€€€€€€‘•ÍÉ¥ÁÑ¥½¸è€Éµ½ÕÉ•…‰±”‘ÉÕµÌœ°(€€€€€€€½É‘•É•‘EÕ…¹Ñ¥Ñäè€œÐ¸ÀÀÀœ°(€€€€€€€É••¥Ù•‘EÕ…¹Ñ¥Ñäè€œÔ¸ÀÀÀœ°(€€€€€ô°(€€€t¤ì((€€€€¼¼%ÍÍÕ”¥Ì•ÅÕ…±±äÕ¹É•™ÕÍ•°…¹Ñ¡”¹½Ñ¥”ÍÑ…åÌ½¸Ñ¡”É•…µ½‘•°(€€€€¼¼¹½ÜÑ¡…ÐÑ¡”É••¥ÁÑÌ…É”É•…°¸(€€€½¹ÍÐ¥ÍÍÕ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í¡…±±…¹%‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡¥ÍÍÕ•¹ÍÑ…ÑÕÍ½‘”°¥ÍÍÕ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€•áÁ•Ð¡¥ÍÍÕ•¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹Ý…É¹¥¹Ì¤¹Ñ½ÅÕ…°¡l(€€€€€•áÁ•Ð¹½‰©•Ñ½¹Ñ…¥¹¥¹œ¡ì(€€€€€€€ÁÕÉ¡…Í•=É‘•É1¥¹•%èÁ½1¥¹•%°(€€€€€€€½É‘•É•‘EÕ…¹Ñ¥Ñäè€œÐ¸ÀÀÀœ°(€€€€€€€É••¥Ù•‘EÕ…¹Ñ¥Ñäè€œÔ¸ÀÀÀœ°(€€€€€ô¤°(€€€t¤ì((€€€€¼¼Q¡”É••¥ÁÐ™••‘ÌÑ¡”ÁÕÉ¡…Í”µ½É‘•È‰…±…¹”•á…Ñ±ä…ÌÑ¡”(€€€€¼¼…‘µ¥¸µME0Ý½É­…É½Õ¹ÕÍ•Ñ¼è™Õ±±äÉ••¥Ù•°Á•¹‘¥¹œ™±½½É•…Ð€À¸(€€€½¹ÍÐ½É‘•È€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘íÁÕÉ¡…Í•=É‘•É%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡½É‘•È¹ÍÑ…ÑÕÍ½‘”°½É‘•È¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡½É‘•È¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹±¥¹•ÍlÁt¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€É••¥Ù•‘EÕ…¹Ñ¥Ñäè€œÔ¸ÀÀÀœ°(€€€€€Á•¹‘¥¹EÕ…¹Ñ¥Ñäè€œÀ¸ÀÀÀœ°(€€€ô¤ì(€ô¤ì((€¥Ð ‰ÁÉ½©•ÑÌÉ••¥ÁÑÌ¥ÍÍÕ••±Í•Ý¡•É”¥¹Ñ¼„¹•Ü‘É…™ÐÌÝ…É¹¥¹œˆ°…Íå¹Œ€ ¤€ôøì(€€€€¼¼Q¡”™¥Ù”½Ù•ÈµÉ••¥Ù•…‰½Ù”…É”…±É•…‘ä¥ÍÍÕ•ì½¹”µ½É”½¸„¹•Ü(€€€€¼¼‘É…™ÐÁÉ½©•ÑÌÑ¼Í¥à½˜Ñ¡”™½ÕÈ½É‘•É•¸(€€€½¹ÍÐÍ•½¹€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘í±¥¹­]½É­%‘ô½¡…±±…¹Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€€¸¸¹‘É…™Ñ	½‘ä¡l(€€€€€€€€€ìÝ½É­%Ñ•µ%è±¥¹­%Ñ•µ%°ÅÕ…¹Ñ¥Ñäè€œÄœ°ÁÕÉ¡…Í•=É‘•É1¥¹•%èÁ½1¥¹•%ô°(€€€€€€€t¤°(€€€€€€€ÁÉ•™¥àè€@œ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡Í•½¹¹ÍÑ…ÑÕÍ½‘”°Í•½¹¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€•áÁ•Ð¡Í•½¹¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹Ý…É¹¥¹Ì¤¹Ñ½ÅÕ…°¡l(€€€€€•áÁ•Ð¹½‰©•Ñ½¹Ñ…¥¹¥¹œ¡ì(€€€€€€€ÁÕÉ¡…Í•=É‘•É1¥¹•%èÁ½1¥¹•%°(€€€€€€€½É‘•É•‘EÕ…¹Ñ¥Ñäè€œÐ¸ÀÀÀœ°(€€€€€€€É••¥Ù•‘EÕ…¹Ñ¥Ñäè€œØ¸ÀÀÀœ°(€€€€€ô¤°(€€€t¤ì(€ô¤ì)ô¤ì