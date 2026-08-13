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
          'gst_rates',
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
    // Not in the future…
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

    // …and never before the Work's LOA letter date (2025-06-01 here).
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
        end
        where id = ${organisationId}
      `;
      const [clock] = await admin<{ today: string; utcToday: string }[]>`
        select
          (now() at time zone timezone)::date::text as today,
          (now() at time zone 'UTC')::date::text as "utcToday"
        from organisations
        where id = ${organisationId}
      `;
      expect(clock).toBeDefined();
      expect(clock?.today).not.toBe(clock?.utcToday);

      const response = await authed(viewer, {
        method: 'GET',
        url: `/api/works/${workId}/balance`,
        organisationId,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<WorkBalanceResponse>().today).toBe(clock?.today);
    } finally {
      if (original !== undefined) {
        await admin`
          update organisations
          set timezone = ${original.timezone}
          where id = ${organisationId}
        `;
      }
    }
  });

  it('keeps issued challans immutable through the API', async () => {
    const edit = await authed(owner, {
      method: 'PUT',
      url: `/api/challans/${firstChallanId}`,
      organisationId,
      payload: draftBody([{ workItemId: itemAId, quantity: '1' }]),
    });
    expect(edit.statusCode).toBe(409);
    const remove = await authed(owner, {
      method: 'DELETE',
      url: `/api/challans/${firstChallanId}`,
      organisationId,
    });
    expect(remove.statusCode).toBe(409);
  });

  it('blocks issuing beyond the awarded quantity, exactly', async () => {
    const create = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: draftBody([{ workItemId: itemAId, quantity: '2.5' }]),
    });
    expect(create.statusCode, create.body).toBe(201);
    secondChallanId = create.json<ChallanDetailResponse>().challan.id;

    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${secondChallanId}/issue`,
      organisationId,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'QUANTITY_EXCEEDED' });
    expect(blocked.json<{ message: string }>().message).toContain('A/1');

    // Exactly the remaining quantity is allowed.
    const corrected = await authed(owner, {
      method: 'PUT',
      url: `/api/challans/${secondChallanId}`,
      organisationId,
      payload: draftBody([{ workItemId: itemAId, quantity: '2' }]),
    });
    expect(corrected.statusCode).toBe(200);
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${secondChallanId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json<ChallanDetailResponse>().challan.challanNumber).toBe('DC/2');
  });

  it('requires cancel authority and releases the balance on cancellation', async () => {
    const denied = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${secondChallanId}/cancel`,
      organisationId,
      payload: { note: 'clerk cannot cancel' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${secondChallanId}/cancel`,
      organisationId,
      payload: { note: 'Wrong consignee; re-issuing.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<ChallanDetailResponse>().challan.status).toBe('cancelled');

    const balance = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/balance`,
      organisationId,
    });
    const itemA = balance
      .json<WorkBalanceResponse>()
      .items.find((item) => item.workItemId === itemAId);
    expect(Number(itemA?.remainingQuantity)).toBe(2);

    const again = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${secondChallanId}/cancel`,
      organisationId,
      payload: { note: 'already cancelled' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('lets concurrent issue attempts produce exactly one issued challan', async () => {
    const create = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: draftBody([{ workItemId: itemBId, quantity: '0.5' }]),
    });
    expect(create.statusCode, create.body).toBe(201);
    const raceId = create.json<ChallanDetailResponse>().challan.id;

    const [first, second] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/challans/${raceId}/issue`,
        organisationId,
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/challans/${raceId}/issue`,
        organisationId,
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const [row] = await admin<{ count: string; max_seq: number }[]>`
      select count(*)::text as count, max(sequence_number) as max_seq
      from delivery_challans
      where id = ${raceId} and status = 'issued'
    `;
    expect(row?.count).toBe('1');
    expect(row?.max_seq).toBe(3);
  });

  it('renders the issued challan to a PDF through the render service', async () => {
    const render = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${firstChallanId}/render`,
      organisationId,
    });
    expect(render.statusCode, render.body).toBe(200);
    expect(render.json<ChallanDetailResponse>().challan.renderedAvailable).toBe(true);

    const pdf = await authed(viewer, {
      method: 'GET',
      url: `/api/challans/${firstChallanId}/pdf`,
      organisationId,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    // Re-rendering is idempotent — same input snapshot, fresh object.
    const again = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${firstChallanId}/render`,
      organisationId,
    });
    expect(again.statusCode).toBe(200);
  });

  it('accepts a signed copy for issued challans only, validating magic bytes', async () => {
    const junk = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${firstChallanId}/signed-copy`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('not a pdf'),
    });
    expect(junk.statusCode).toBe(400);

    const uploaded = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${firstChallanId}/signed-copy`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from(`%PDF-1.4 signed ${runId}`),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json<ChallanDetailResponse>().challan.signedCopyAvailable).toBe(
      true,
    );

    const signedPdf = await authed(viewer, {
      method: 'GET',
      url: `/api/challans/${firstChallanId}/pdf?kind=signed`,
      organisationId,
    });
    expect(signedPdf.statusCode).toBe(200);
    expect(signedPdf.rawPayload.toString()).toContain('signed');
  });

  it('writes the full audit timeline', async () => {
    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId}
        and entity_id = ${firstChallanId}
      order by occurred_at
    `;
    expect(events.map((event) => event.action)).toEqual([
      'challan.created',
      'challan.updated',
      'challan.issued',
      'challan.rendered',
      'challan.rendered',
      'challan.signed_copy_uploaded',
    ]);

    const cancelledEvents = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId}
        and entity_id = ${secondChallanId}
        and action = 'challan.cancelled'
    `;
    expect(cancelledEvents).toHaveLength(1);
  });
});

describe('organisation export (Milestone 4)', () => {
  it('gives owners the complete business record and refuses everyone else', async () => {
    const denied = await authed(clerk, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'OWNER_REQUIRED' });

    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const exported = response.json<{
      formatVersion: string;
      organisation: { id: string };
      works: unknown[];
      deliveryChallans: { status: string; issued_snapshot: unknown }[];
      auditEvents: { action: string }[];
    }>();
    expect(exported.formatVersion).toBe('export-v10');
    expect(exported.organisation.id).toBe(organisationId);
    expect(exported.works.length).toBeGreaterThanOrEqual(1);
    const issued = exported.deliveryChallans.find(
      (challan) => challan.status === 'issued',
    );
    expect(issued).toBeDefined();
    expect(issued?.issued_snapshot).toMatchObject({ challanNumber: 'DC/1' });
    expect(exported.auditEvents.map((event) => event.action)).toContain(
      'organisation.exported',
    );
  });
});

describe('warranty/guarantee certificate (Milestone 7)', () => {
  const WARRANTY_TEXT =
    'Clause 1 <terms> & conditions.\nClause 2: goods carry a 24-month "guarantee".';
  const WARRANTY_SHA = createHash('sha256').update(WARRANTY_TEXT, 'utf8').digest('hex');
  let withCertificateId: string;

  async function setWarrantyText(text: string | null) {
    const response = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { warrantyTemplateText: text },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function issueDraft(quantity: string): Promise<ChallanDetailResponse> {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: draftBody([{ workItemId: itemAId, quantity }]),
    });
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json<ChallanDetailResponse>();
    // Drafts never carry certificate facts, even with org text present.
    expect(draft.challan.warrantyTemplateVersion).toBeNull();
    expect(draft.challan.warrantyTextSha256).toBeNull();
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draft.challan.id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    return issued.json<ChallanDetailResponse>();
  }

  it('freezes the template text, version, and content hash at issue time', async () => {
    await setWarrantyText(WARRANTY_TEXT);
    const detail = await issueDraft('1');
    withCertificateId = detail.challan.id;
    expect(detail.challan.warrantyTemplateVersion).toBe('wc-v1');
    expect(detail.challan.warrantyTextSha256).toBe(WARRANTY_SHA);
    const snapshot = detail.issuedSnapshot as {
      templateVersion: string;
      warranty?: { templateVersion: string; textSha256: string; text: string };
    };
    expect(snapshot.templateVersion).toBe('dc-v3');
    expect(snapshot.warranty).toEqual({
      templateVersion: 'wc-v1',
      textSha256: WARRANTY_SHA,
      text: WARRANTY_TEXT,
    });
  });

  it('keeps the challan.issued audit event shape unchanged', async () => {
    const [event] = await admin<{ details: unknown }[]>`
      select details from audit_events
      where organisation_id = ${organisationId}
        and entity_id = ${withCertificateId} and action = 'challan.issued'
    `;
    const details =
      typeof event?.details === 'string'
        ? (JSON.parse(event.details) as Record<string, unknown>)
        : (event?.details as Record<string, unknown>);
    expect(Object.keys(details).sort()).toEqual([
      'challanNumber',
      // Which movement was issued (migration 0056): a work challan and a
      // standalone one are different documents with different numbering,
      // and the trail says which one this was.
      'kind',
      'sequence',
      'totalAmount',
    ]);
  });

  it('renders the certificate as page 2 from the snapshot, immune to org edits', async () => {
    const render = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${withCertificateId}/render`,
      organisationId,
    });
    expect(render.statusCode, render.body).toBe(200);
    const firstHtml = gotenbergBodies.at(-1) ?? '';
    expect(firstHtml).toContain('class="warranty-page"');
    expect(firstHtml).toContain('Warranty / Guarantee Certificate');
    expect(firstHtml).toContain('Clause 1 &lt;terms&gt; &amp; conditions.');
    expect(firstHtml).toContain('Warranty template wc-v1');
    expect(firstHtml).toContain(`SHA-256 ${WARRANTY_SHA}`);

    // A later org-profile edit must NEVER change the issued certificate.
    await setWarrantyText('Replaced template text entirely.');
    const again = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${withCertificateId}/render`,
      organisationId,
    });
    expect(again.statusCode, again.body).toBe(200);
    const secondHtml = gotenbergBodies.at(-1) ?? '';
    expect(secondHtml).toContain('Clause 1 &lt;terms&gt; &amp; conditions.');
    expect(secondHtml).not.toContain('Replaced template text entirely.');

    const [row] = await admin<
      { warranty_template_version: string; warranty_text_sha256: string }[]
    >`
      select warranty_template_version, warranty_text_sha256
      from delivery_challans where id = ${withCertificateId}
    `;
    expect(row).toEqual({
      warranty_template_version: 'wc-v1',
      warranty_text_sha256: WARRANTY_SHA,
    });
  });

  it('issues without a certificate page when the organisation has no text', async () => {
    await setWarrantyText(null);
    const detail = await issueDraft('1');
    expect(detail.challan.warrantyTemplateVersion).toBeNull();
    expect(detail.challan.warrantyTextSha256).toBeNull();
    expect(Object.keys(detail.issuedSnapshot as Record<string, unknown>)).not.toContain(
      'warranty',
    );

    const render = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${detail.challan.id}/render`,
      organisationId,
    });
    expect(render.statusCode, render.body).toBe(200);
    const html = gotenbergBodies.at(-1) ?? '';
    expect(html).not.toContain('class="warranty-page"');
    expect(html).not.toContain('Warranty / Guarantee Certificate');
    expect(html).toContain('Template dc-v3 · Issued at');
  });

  it('freezes the certificate columns at the database layer', async () => {
    // The 0018 immutability guard covers the new columns on issued rows.
    await expect(
      admin`
        update delivery_challans
        set warranty_template_version = 'wc-v0'
        where id = ${withCertificateId}
      `,
    ).rejects.toThrowError(/issued Delivery Challan business data is immutable/);

    // Drafts can never carry certificate facts (status-shape CHECK)…
    await expect(
      admin`
        insert into delivery_challans (
          organisation_id, work_id, challan_date, prefix,
          consignee_snapshot, created_by_user_id,
          warranty_template_version, warranty_text_sha256
        )
        values (
          ${organisationId}, ${workId}, '2026-08-08', 'BADDRAFT',
          '{}'::jsonb, ${ownerUserId}, 'wc-v1', ${WARRANTY_SHA}
        )
      `,
    ).rejects.toThrowError(/delivery_challans_warranty_status_check/);

    // …and the version/hash pair travels together (pair CHECK), checked
    // on an issued-shaped row where the status CHECK would allow them.
    await expect(
      admin`
        insert into delivery_challans (
          organisation_id, work_id, status, challan_date, prefix,
          consignee_snapshot, issued_snapshot, challan_number,
          sequence_number, created_by_user_id, issued_by_user_id,
          issued_at, warranty_template_version
        )
        values (
          ${organisationId}, ${workId}, 'issued', '2026-08-08', 'BADPAIR',
          '{}'::jsonb, '{}'::jsonb, 'BADPAIR/99', 99, ${ownerUserId},
          ${ownerUserId}, now(), 'wc-v1'
        )
      `,
    ).rejects.toThrowError(/delivery_challans_warranty_pair_check/);
  });
});

describe('one-draft rule under concurrency', () => {
  it('lets exactly one of two simultaneous creates draft; the 409 names the winner', async () => {
    // A fresh Work so no earlier draft occupies the slot.
    const raceWorkId = randomUUID();
    const raceScheduleId = randomUUID();
    const raceItemId = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, letter_percentage,
        letter_percentage_direction, created_by_user_id
      )
      values (
        ${raceWorkId}, ${organisationId}, ${`DCR-${runId.toUpperCase()}`},
        ${`dc-race-letter-${runId}`}, '2025-06-01', 'Challan race work',
        1000.00, 900.00, 'per_schedule', null, null, ${ownerUserId}
      )
    `;
    await admin`
      insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
      values (${raceScheduleId}, ${organisationId}, ${raceWorkId}, 'A', 'Schedule A', 1)
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (${raceItemId}, ${organisationId}, ${raceWorkId}, ${raceScheduleId},
              'A/1', 'Race switchboard', 'Nos', 5.000, 100.00)
    `;

    const create = () =>
      authed(owner, {
        method: 'POST',
        url: `/api/works/${raceWorkId}/challans`,
        organisationId,
        payload: draftBody([{ workItemId: raceItemId, quantity: '1' }]),
      });
    const responses = await Promise.all([create(), create()]);
    const winners = responses.filter((response) => response.statusCode === 201);
    const losers = responses.filter((response) => response.statusCode === 409);
    expect(winners.length, responses.map((response) => response.body).join('\n')).toBe(
      1,
    );
    expect(losers.length).toBe(1);
    const winnerId = winners[0]?.json<ChallanDetailResponse>().challan.id;
    // Whether the loser hit the pre-check or the unique-index race path,
    // its 409 names the winning draft.
    expect(losers[0]?.json()).toMatchObject({
      code: 'DRAFT_EXISTS',
      details: { existingRecordId: winnerId },
    });
  });
});

/** A throwaway Work with one item, so a guard can be proven without
 * disturbing the fixture Work's single draft slot or its balances. */
async function freshWork(
  label: string,
  item: { description: string; unit: string; quantity: string; rate: string },
): Promise<{ workId: string; workItemId: string }> {
  const id = randomUUID();
  const scheduleId = randomUUID();
  const workItemId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, letter_percentage,
      letter_percentage_direction, created_by_user_id
    )
    values (
      ${id}, ${organisationId}, ${`DC${label}-${runId.toUpperCase()}`},
      ${`dc-${label}-letter-${runId}`}, '2025-06-01', ${`Challan ${label} work`},
      1000.00, 900.00, 'per_schedule', null, null, ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${id}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate
    )
    values (${workItemId}, ${organisationId}, ${id}, ${scheduleId}, 'A/1',
            ${item.description}, ${item.unit}, ${item.quantity}, ${item.rate})
  `;
  return { workId: id, workItemId };
}

describe('line quantities the database refuses answer 400, not 500', () => {
  let qtyWorkId: string;
  let qtyItemId: string;

  beforeAll(async () => {
    const created = await freshWork('Q', {
      description: 'Quantity guard switchboard',
      unit: 'Nos',
      quantity: '5.000',
      rate: '100.00',
    });
    qtyWorkId = created.workId;
    qtyItemId = created.workItemId;
  }, 30_000);

  it('names the offending line for zero, negative and oversized quantities', async () => {
    for (const quantity of ['0', '0.000', '-2', '1234567890123456']) {
      const response = await authed(owner, {
        method: 'POST',
        url: `/api/works/${qtyWorkId}/challans`,
        organisationId,
        payload: draftBody([{ workItemId: qtyItemId, quantity }]),
      });
      expect(response.statusCode, `${quantity}: ${response.body}`).toBe(400);
      expect(response.json()).toMatchObject({ code: 'QUANTITY_INVALID' });
      // The operator is told WHICH line, not merely that something failed.
      expect(response.json<{ message: string }>().message).toContain('Line 1');
    }
    // Nothing was written on the way to the refusal.
    const [drafts] = await admin<{ total: string }[]>`
      select count(*)::text as total from delivery_challans
      where work_id = ${qtyWorkId}
    `;
    expect(drafts?.total).toBe('0');
  });

  it('still accepts a fractional part-delivery quantity', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${qtyWorkId}/challans`,
      organisationId,
      payload: draftBody([{ workItemId: qtyItemId, quantity: '0.5' }]),
    });
    expect(created.statusCode, created.body).toBe(201);
    const detail = created.json<ChallanDetailResponse>();
    expect(detail.items[0]).toMatchObject({ quantity: '0.500', lineAmount: '50.00' });

    // And the same refusal guards the draft EDIT path, leaving the
    // already-saved line untouched.
    const edited = await authed(owner, {
      method: 'PUT',
      url: `/api/challans/${detail.challan.id}`,
      organisationId,
      payload: draftBody([{ workItemId: qtyItemId, quantity: '0' }]),
    });
    expect(edited.statusCode).toBe(400);
    expect(edited.json()).toMatchObject({ code: 'QUANTITY_INVALID' });
    const reread = await authed(owner, {
      method: 'GET',
      url: `/api/challans/${detail.challan.id}`,
      organisationId,
    });
    expect(reread.json<ChallanDetailResponse>().items[0]?.quantity).toBe('0.500');
  });
});

describe('consignee and cancellation-note text is trimmed before it is stored', () => {
  let textWorkId: string;
  let textItemId: string;

  beforeAll(async () => {
    const created = await freshWork('T', {
      description: 'Consignee guard cable set',
      unit: 'Set',
      quantity: '5.000',
      rate: '100.00',
    });
    textWorkId = created.workId;
    textItemId = created.workItemId;
  }, 30_000);

  it('refuses a consignee that is blank once trimmed', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${textWorkId}/challans`,
      organisationId,
      payload: {
        ...draftBody([{ workItemId: textItemId, quantity: '1' }]),
        prefix: 'DCT',
        consignee: { name: '   ', address: '     ' },
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: 'CONSIGNEE_INVALID' });
  });

  it('keeps a padded but real consignee, stored trimmed and printed trimmed', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${textWorkId}/challans`,
      organisationId,
      payload: {
        ...draftBody([{ workItemId: textItemId, quantity: '1' }]),
        prefix: 'DCT',
        consignee: {
          name: '  Sr. DEE (G) NR  ',
          address: ' Delhi Division, New Delhi ',
          phone: '   ',
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const detail = created.json<ChallanDetailResponse>();
    expect(detail.challan.consignee).toEqual({
      name: 'Sr. DEE (G) NR',
      address: 'Delhi Division, New Delhi',
    });

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${detail.challan.id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);

    // The cancellation note obeys the same rule the CHECK does:
    // length(btrim(note)) >= 3, answered as a 400 rather than a 500.
    const blank = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${detail.challan.id}/cancel`,
      organisationId,
      payload: { note: '   ' },
    });
    expect(blank.statusCode, blank.body).toBe(400);
    expect(blank.json()).toMatchObject({ code: 'CANCELLATION_NOTE_REQUIRED' });

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${detail.challan.id}/cancel`,
      organisationId,
      payload: { note: '  Consignee changed by the railway.  ' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<ChallanDetailResponse>().challan.cancellationNote).toBe(
      'Consignee changed by the railway.',
    );
  });
});

describe('a draft amended after it was saved cannot be issued stale', () => {
  let staleWorkId: string;
  let staleItemId: string;

  beforeAll(async () => {
    const created = await freshWork('S', {
      description: 'Stale draft switchboard',
      unit: 'Nos',
      quantity: '5.000',
      rate: '100.00',
    });
    staleWorkId = created.workId;
    staleItemId = created.workItemId;
    // Amendments direct-apply for an approval-authority holder; the
    // fixture owner is given that authority for this section only.
    await admin`
      update organisation_memberships
      set can_approve_amendments = true
      where organisation_id = ${organisationId} and user_id = ${ownerUserId}
    `;
  }, 30_000);

  afterAll(async () => {
    await admin`
      update organisation_memberships
      set can_approve_amendments = false
      where organisation_id = ${organisationId} and user_id = ${ownerUserId}
    `;
  });

  it('refuses the issue with DRAFT_STALE, naming the item and the fields', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${staleWorkId}/challans`,
      organisationId,
      payload: {
        ...draftBody([{ workItemId: staleItemId, quantity: '2' }]),
        prefix: 'DCS',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draftId = created.json<ChallanDetailResponse>().challan.id;
    expect(created.json<ChallanDetailResponse>().items[0]).toMatchObject({
      rate: '100.00',
      lineAmount: '200.00',
    });

    // The railway amends the rate AFTER the draft was saved. The draft
    // still carries the superseded snapshot, and issue would freeze it
    // into the document handed to the consignee.
    const amended = await authed(owner, {
      method: 'POST',
      url: `/api/works/${staleWorkId}/amendments`,
      organisationId,
      payload: {
        workItemId: staleItemId,
        reason: 'Rate revised by variation 4.',
        changes: { rate: '110.00' },
      },
    });
    expect(amended.statusCode, amended.body).toBe(201);

    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draftId}/issue`,
      organisationId,
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'DRAFT_STALE' });
    const message = blocked.json<{ message: string }>().message;
    expect(message).toContain('A/1');
    expect(message).toContain('rate');

    // Nothing was numbered or issued by the refused attempt.
    const still = await authed(owner, {
      method: 'GET',
      url: `/api/challans/${draftId}`,
      organisationId,
    });
    expect(still.json<ChallanDetailResponse>().challan.status).toBe('draft');
    expect(still.json<ChallanDetailResponse>().challan.challanNumber).toBeNull();
  });

  it('issues at the amended rate once the draft is re-saved', async () => {
    const list = await authed(owner, {
      method: 'GET',
      url: `/api/works/${staleWorkId}/challans`,
      organisationId,
    });
    const draft = list
      .json<{ challans: ChallanDetailResponse['challan'][] }>()
      .challans.find((challan) => challan.status === 'draft');
    if (!draft) throw new Error('stale draft missing');

    // Re-saving the draft is the documented repair: the operator sees
    // the new amounts on screen before they commit to them.
    const resaved = await authed(owner, {
      method: 'PUT',
      url: `/api/challans/${draft.id}`,
      organisationId,
      payload: {
        ...draftBody([{ workItemId: staleItemId, quantity: '2' }]),
        prefix: 'DCS',
      },
    });
    expect(resaved.statusCode, resaved.body).toBe(200);
    expect(resaved.json<ChallanDetailResponse>().items[0]).toMatchObject({
      rate: '110.00',
      lineAmount: '220.00',
    });

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draft.id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const snapshot = issued.json<ChallanDetailResponse>().issuedSnapshot as {
      totalAmount: string;
      items: { rate: string }[];
    };
    expect(snapshot.items[0]?.rate).toBe('110.00');
    expect(snapshot.totalAmount).toBe('220.00');
  });

  it('leaves a draft alone when the amendment touched only the quantity', async () => {
    // The ceiling check already covers quantity; a quantity-only
    // amendment must not strand a draft that is still within it.
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${staleWorkId}/challans`,
      organisationId,
      payload: {
        ...draftBody([{ workItemId: staleItemId, quantity: '1' }]),
        prefix: 'DCS',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draftId = created.json<ChallanDetailResponse>().challan.id;

    const amended = await authed(owner, {
      method: 'POST',
      url: `/api/works/${staleWorkId}/amendments`,
      organisationId,
      payload: {
        workItemId: staleItemId,
        reason: 'Quantity raised by variation 5.',
        changes: { quantity: '6' },
      },
    });
    expect(amended.statusCode, amended.body).toBe(201);

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draftId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
  });
});

/**
 * The 0033 receipt link, end to end through the API: a challan line names
 * the ISSUED purchase-order line it receives against (no more admin SQL —
 * the workaround the lifecycle and purchase-order suites carry). The link
 * is validated (same Work, order actually issued), served back, rewritten
 * freely while the challan is a draft, and over-receipt is a WARNING on
 * the read model — vendors over-ship, and the delivery document must
 * record what actually arrived.
 */
describe('challan lines received against purchase-order lines (0033 receipt link)', () => {
  let linkWorkId: string;
  let linkItemId: string;
  let vendorContactId: string;
  let purchaseOrderId: string;
  let poNumber: string;
  let poLineId: string;
  let draftPoLineId: string;
  let crossWorkPoLineId: string;
  let challanId: string;

  /** Creates a purchase order on the Work with one line ordering
   * `quantity` of `targetItemId`, and issues it. */
  async function issuedPurchaseOrder(
    targetWorkId: string,
    targetItemId: string,
    quantity: string,
  ): Promise<{ id: string; lineId: string; number: string }> {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${targetWorkId}/purchase-orders`,
      organisationId,
      payload: { vendorContactId, poDate: '2025-07-01' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<PurchaseOrderDetailResponse>().purchaseOrder.id;
    const lined = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${id}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            workItemId: targetItemId,
            description: 'Armoured cable drums',
            unitCode: 'Nos',
            quantity,
            rate: '90.00',
          },
        ],
      },
    });
    expect(lined.statusCode, lined.body).toBe(200);
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const detail = issued.json<PurchaseOrderDetailResponse>();
    const lineId = detail.lines[0]?.id;
    const number = detail.purchaseOrder.poNumber;
    if (!lineId || number === null) {
      throw new Error('issued purchase order came back incomplete');
    }
    return { id, lineId, number };
  }

  beforeAll(async () => {
    const linked = await freshWork('P', {
      description: 'Armoured cable drum',
      unit: 'Nos',
      quantity: '10.000',
      rate: '100.00',
    });
    linkWorkId = linked.workId;
    linkItemId = linked.workItemId;

    // The vendor is created THROUGH the contacts API: the isVendor flag
    // is the masters half of this slice, so the seeding that used to be
    // admin SQL is now the product path.
    const vendor = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: `Bharat Cables Pvt Ltd ${runId}`,
        address: 'Plot 12, MIDC, Pune',
        isVendor: true,
      },
    });
    expect(vendor.statusCode, vendor.body).toBe(201);
    expect(vendor.json<Contact>()).toMatchObject({
      isVendor: true,
      isConsignee: false,
    });
    vendorContactId = vendor.json<Contact>().id;

    const order = await issuedPurchaseOrder(linkWorkId, linkItemId, '4');
    purchaseOrderId = order.id;
    poLineId = order.lineId;
    poNumber = order.number;

    // A second Work with its own ISSUED order: its lines must stay
    // invisible to this Work's challans.
    const other = await freshWork('X', {
      description: 'Foreign relay set',
      unit: 'Nos',
      quantity: '10.000',
      rate: '100.00',
    });
    crossWorkPoLineId = (await issuedPurchaseOrder(other.workId, other.workItemId, '4'))
      .lineId;

    // And an open DRAFT order on this Work: it exists, but nothing has
    // been ordered from the vendor yet, so nothing can be received on it.
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${linkWorkId}/purchase-orders`,
      organisationId,
      payload: { vendorContactId, poDate: '2025-07-01' },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftOrderId = draft.json<PurchaseOrderDetailResponse>().purchaseOrder.id;
    const draftLines = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${draftOrderId}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            workItemId: linkItemId,
            description: 'Cable drums, second lot',
            unitCode: 'Nos',
            quantity: '2',
            rate: '90.00',
          },
        ],
      },
    });
    expect(draftLines.statusCode, draftLines.body).toBe(200);
    const draftLineId = draftLines.json<PurchaseOrderDetailResponse>().lines[0]?.id;
    if (!draftLineId) throw new Error('draft purchase order line missing');
    draftPoLineId = draftLineId;
  }, 45_000);

  it('links a draft line to an issued purchase-order line and serves it back', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${linkWorkId}/challans`,
      organisationId,
      payload: {
        ...draftBody([
          { workItemId: linkItemId, quantity: '3', purchaseOrderLineId: poLineId },
        ]),
        prefix: 'DCP',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const detail = created.json<ChallanDetailResponse>();
    challanId = detail.challan.id;
    expect(detail.items[0]?.purchaseOrderLineId).toBe(poLineId);
    // Three of the four ordered: within the order, nothing to warn about.
    expect(detail.warnings).toEqual([]);
  });

  it("refuses another Work's order line (404) and a draft order (409), writing nothing", async () => {
    const rewrite = (purchaseOrderLineId: string) =>
      authed(owner, {
        method: 'PUT',
        url: `/api/challans/${challanId}`,
        organisationId,
        payload: {
          ...draftBody([
            { workItemId: linkItemId, quantity: '3', purchaseOrderLineId },
          ]),
          prefix: 'DCP',
        },
      });

    // Another Work's procurement answers exactly like an unknown id.
    const crossWork = await rewrite(crossWorkPoLineId);
    expect(crossWork.statusCode, crossWork.body).toBe(404);
    expect(crossWork.json()).toMatchObject({ code: 'PO_LINE_NOT_FOUND' });
    expect(crossWork.json<{ message: string }>().message).toContain('Line 1');

    const unknown = await rewrite('00000000-0000-4000-8000-000000000000');
    expect(unknown.statusCode, unknown.body).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'PO_LINE_NOT_FOUND' });

    // A draft order has not been placed on the vendor yet.
    const notIssued = await rewrite(draftPoLineId);
    expect(notIssued.statusCode, notIssued.body).toBe(409);
    expect(notIssued.json()).toMatchObject({ code: 'PO_NOT_ISSUED' });
    expect(notIssued.json<{ message: string }>().message).toContain('draft');

    // Every refusal rolled its rewrite back: the saved link is untouched.
    const reread = await authed(owner, {
      method: 'GET',
      url: `/api/challans/${challanId}`,
      organisationId,
    });
    expect(reread.json<ChallanDetailResponse>().items[0]).toMatchObject({
      quantity: '3.000',
      purchaseOrderLineId: poLineId,
    });
  });

  it('keeps draft rewrites working: the link can be dropped and re-pointed', async () => {
    const dropped = await authed(clerk, {
      method: 'PUT',
      url: `/api/challans/${challanId}`,
      organisationId,
      payload: {
        ...draftBody([{ workItemId: linkItemId, quantity: '3' }]),
        prefix: 'DCP',
      },
    });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect(
      dropped.json<ChallanDetailResponse>().items[0]?.purchaseOrderLineId,
    ).toBeNull();

    const relinked = await authed(clerk, {
      method: 'PUT',
      url: `/api/challans/${challanId}`,
      organisationId,
      payload: {
        ...draftBody([
          { workItemId: linkItemId, quantity: '3', purchaseOrderLineId: poLineId },
        ]),
        prefix: 'DCP',
      },
    });
    expect(relinked.statusCode, relinked.body).toBe(200);
    expect(relinked.json<ChallanDetailResponse>().items[0]?.purchaseOrderLineId).toBe(
      poLineId,
    );
  });

  it('warns — never refuses — when the delivery over-receives the ordered quantity', async () => {
    // The vendor shipped five against the four ordered. The save is
    // accepted; the response carries the over-receipt notice instead.
    const saved = await authed(owner, {
      method: 'PUT',
      url: `/api/challans/${challanId}`,
      organisationId,
      payload: {
        ...draftBody([
          { workItemId: linkItemId, quantity: '5', purchaseOrderLineId: poLineId },
        ]),
        prefix: 'DCP',
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<ChallanDetailResponse>().warnings).toEqual([
      {
        purchaseOrderLineId: poLineId,
        poNumber,
        poLineNumber: 1,
        description: 'Armoured cable drums',
        orderedQuantity: '4.000',
        receivedQuantity: '5.000',
      },
    ]);

    // Issue is equally unrefused, and the notice stays on the read model
    // now that the receipts are real.
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json<ChallanDetailResponse>().warnings).toEqual([
      expect.objectContaining({
        purchaseOrderLineId: poLineId,
        orderedQuantity: '4.000',
        receivedQuantity: '5.000',
      }),
    ]);

    // The receipt feeds the purchase-order balance exactly as the
    // admin-SQL workaround used to: fully received, pending floored at 0.
    const order = await authed(owner, {
      method: 'GET',
      url: `/api/purchase-orders/${purchaseOrderId}`,
      organisationId,
    });
    expect(order.statusCode, order.body).toBe(200);
    expect(order.json<PurchaseOrderDetailResponse>().lines[0]).toMatchObject({
      receivedQuantity: '5.000',
      pendingQuantity: '0.000',
    });
  });

  it("projects receipts issued elsewhere into a new draft's warning", async () => {
    // The five over-received above are already issued; one more on a new
    // draft projects to six of the four ordered.
    const second = await authed(owner, {
      method: 'POST',
      url: `/api/works/${linkWorkId}/challans`,
      organisationId,
      payload: {
        ...draftBody([
          { workItemId: linkItemId, quantity: '1', purchaseOrderLineId: poLineId },
        ]),
        prefix: 'DCP',
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json<ChallanDetailResponse>().warnings).toEqual([
      expect.objectContaining({
        purchaseOrderLineId: poLineId,
        orderedQuantity: '4.000',
        receivedQuantity: '6.000',
      }),
    ]);
  });
});

describe('numbering scope across Works (finding 8)', () => {
  /* The delivery challan counter runs per Work while the number is
   * unique per organisation. A template with no per-Work mark would
   * mint the same number from two Works — and because the counter rolls
   * back with the failed issue, every retry would request the same
   * number again: a wedged series with a finished document in hand.
   * The fix is refusal at save time; these tests prove the refusal and
   * that a {WORK}-scoped series really does keep two Works apart at the
   * same counter value. */

  afterAll(async () => {
    // Restore the default series so no later suite inherits the
    // {WORK}-scoped template this one saves.
    const restored = await authed(owner, {
      method: 'DELETE',
      url: '/api/organisation/number-series/delivery_challan',
      organisationId,
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it('refuses a challan template with no per-Work mark when it is saved', async () => {
    for (const template of ['{SEQ}', 'DC/{YYYY}/{SEQ:3}']) {
      const saved = await authed(owner, {
        method: 'PUT',
        url: '/api/organisation/number-series/delivery_challan',
        organisationId,
        payload: { template },
      });
      expect(saved.statusCode, `${template}: ${saved.body}`).toBe(400);
      expect(saved.json()).toMatchObject({ code: 'NUMBER_TEMPLATE_INVALID' });
      expect(saved.json<{ message: string }>().message).toMatch(
        /\{WORK\} or \{PREFIX\}/,
      );
    }
  });

  it('keeps two Works collision-free at the same counter value under {WORK}', async () => {
    const saved = await authed(owner, {
      method: 'PUT',
      url: '/api/organisation/number-series/delivery_challan',
      organisationId,
      payload: { template: '{WORK}/DC/{SEQ}' },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const numbers: string[] = [];
    for (const label of ['N1', 'N2']) {
      const { workId: scopedWorkId, workItemId } = await freshWork(label, {
        description: `Numbering scope ${label}`,
        unit: 'Nos',
        quantity: '5.000',
        rate: '100.00',
      });
      const draft = await authed(owner, {
        method: 'POST',
        url: `/api/works/${scopedWorkId}/challans`,
        organisationId,
        payload: draftBody([{ workItemId, quantity: '1' }]),
      });
      expect(draft.statusCode, draft.body).toBe(201);
      const issued = await authed(owner, {
        method: 'POST',
        url: `/api/challans/${draft.json<ChallanDetailResponse>().challan.id}/issue`,
        organisationId,
      });
      expect(issued.statusCode, issued.body).toBe(201);
      const number = issued.json<ChallanDetailResponse>().challan.challanNumber;
      expect(number).toBe(`DC${label}-${runId.toUpperCase()}/DC/1`);
      numbers.push(number ?? '');
    }
    // Both Works sit at counter value 1; the Work code is what keeps the
    // organisation-wide numbers distinct.
    expect(new Set(numbers).size).toBe(2);
  });
});
