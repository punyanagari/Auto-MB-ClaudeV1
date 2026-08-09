import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  DashboardResponse,
  ExtensionRequestDetailResponse,
  WorkCompletionResponse,
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
const ownerEmail = `ext-owner-${runId}@integration.test`;
const clerkEmail = `ext-clerk-${runId}@integration.test`;
const viewerEmail = `ext-viewer-${runId}@integration.test`;
const intruderEmail = `ext-intruder-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let fakeGotenberg: http.Server;
let organisationId: string;
let intruderOrganisationId: string;
let ownerUserId: string;
let workId: string;
let workCode: string;
let dueSoonWorkId: string;
let overdueWorkId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let clerk: CookieJar;
let viewer: CookieJar;
let intruder: CookieJar;

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

/** ISO date `days` from today (server clock; the fixtures only need
 * relative positions, never exact timezone boundaries). */
function daysFromToday(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function seedWork(code: string): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${id}, ${organisationId}, ${code}, ${`ext-letter-${code}`}, '2025-06-01',
      'Extension fixture work', 1000.00, 900.00, 'per_schedule', ${ownerUserId}
    )
  `;
  return id;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-ext-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the extension integration tests. ' +
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

  fakeGotenberg = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/pdf');
    response.end(Buffer.from(`%PDF-1.4 stub ${runId}`));
  });
  await new Promise<void>((resolve) => {
    fakeGotenberg.listen(0, '127.0.0.1', resolve);
  });
  const gotenbergAddress = fakeGotenberg.address();
  if (gotenbergAddress === null || typeof gotenbergAddress === 'string') {
    throw new Error('stub Gotenberg failed to bind a port');
  }

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ext-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    gotenbergUrl: `http://127.0.0.1:${String(gotenbergAddress.port)}`,
  });

  owner = await signUp(ownerEmail, 'Ext Owner');
  clerk = await signUp(clerkEmail, 'Ext Clerk');
  viewer = await signUp(viewerEmail, 'Ext Viewer');
  intruder = await signUp(intruderEmail, 'Ext Intruder');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Ext Constructions', slug: `ext-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const intruderOrg = await authed(intruder, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Ext Intruders', slug: `ext-intruder-${runId}` },
  });
  expect(intruderOrg.statusCode, intruderOrg.body).toBe(201);
  intruderOrganisationId = intruderOrg.json<{ id: string }>().id;

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

  // The issue authority (finalising assigns a number) stays with the
  // owner only; the clerk drafts without it.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  workCode = `EXTW-${runId.toUpperCase()}`;
  workId = await seedWork(workCode);
  dueSoonWorkId = await seedWork(`EXTD-${runId.toUpperCase()}`);
  overdueWorkId = await seedWork(`EXTO-${runId.toUpperCase()}`);
}, 60_000);

afterAll(async () => {
  if (admin) {
    for (const orgId of [organisationId, intruderOrganisationId]) {
      if (!orgId) continue;
      // The immutability triggers (rightly) block deleting finalised
      // rows; fixture cleanup is exactly the case
      // session_replication_role exists for.
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'extension_requests',
          'extension_request_counters',
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

describe('completion dates', () => {
  it('refuses the one-time set to viewers', async () => {
    const denied = await authed(viewer, {
      method: 'PUT',
      url: `/api/works/${workId}/completion-dates`,
      organisationId,
      payload: { completionDate: '2026-12-31' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
  });

  it('refuses extension drafting before the completion date exists', async () => {
    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-03-31',
        reason: 'Site not handed over in time.',
        addressee: 'Sr. DEE (G) NR',
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'COMPLETION_NOT_SET' });
  });

  it('rejects completion dates before the LOA letter date', async () => {
    const response = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${workId}/completion-dates`,
      organisationId,
      payload: { completionDate: '2025-05-31' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'COMPLETION_DATE_INVALID' });
  });

  it('sets original and current together exactly once, audited', async () => {
    const response = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${workId}/completion-dates`,
      organisationId,
      payload: { completionDate: '2026-12-31' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<WorkCompletionResponse>().completion).toEqual({
      originalCompletionDate: '2026-12-31',
      currentCompletionDate: '2026-12-31',
    });

    const again = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${workId}/completion-dates`,
      organisationId,
      payload: { completionDate: '2027-01-31' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'COMPLETION_ALREADY_SET' });

    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${workId}
        and action = 'work.completion_date_set'
    `;
    expect(events).toHaveLength(1);
  });

  it('blocks direct completion-date updates at the database, for every writer', async () => {
    // No sanctioned extension row moved to responded in this transaction,
    // so even a superuser session cannot move the current date.
    await expect(
      admin`update works set current_completion_date = '2028-01-01' where id = ${workId}`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin`update works set original_completion_date = '2028-01-01' where id = ${workId}`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('extension request lifecycle', () => {
  let firstId: string;
  let secondId: string;
  let thirdId: string;

  it('rejects proposed dates that do not extend the current completion date', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2026-12-31',
        reason: 'Not actually an extension.',
        addressee: 'Sr. DEE (G) NR',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'EXTENSION_DATE_INVALID' });
  });

  it('rejects letter dates outside the product-contract window', async () => {
    const future = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-03-31',
        reason: 'Future-dated letter.',
        addressee: 'Sr. DEE (G) NR',
        letterDate: '2031-01-01',
      },
    });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toMatchObject({ code: 'LETTER_DATE_INVALID' });

    const beforeLoa = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-03-31',
        reason: 'Letter predating the LOA.',
        addressee: 'Sr. DEE (G) NR',
        letterDate: '2025-05-31',
      },
    });
    expect(beforeLoa.statusCode).toBe(400);
    expect(beforeLoa.json()).toMatchObject({ code: 'LETTER_DATE_INVALID' });
  });

  it('drafts an extension request (office role) and refuses viewers', async () => {
    const denied = await authed(viewer, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-03-31',
        reason: 'Viewer attempt.',
        addressee: 'Sr. DEE (G) NR',
      },
    });
    expect(denied.statusCode).toBe(403);

    const response = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-03-31',
        reason: 'Site handover was delayed by the department.',
        addressee: 'Sr. DEE (G) NR, Delhi Division',
        letterDate: '2026-08-01',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<ExtensionRequestDetailResponse>();
    firstId = detail.extensionRequest.id;
    expect(detail.extensionRequest.status).toBe('draft');
    expect(detail.extensionRequest.requestNumber).toBeNull();
    expect(detail.finalisedSnapshot).toBeNull();
  });

  it('enforces one draft per Work, returning the existing draft id', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-04-30',
        reason: 'A second concurrent draft.',
        addressee: 'Sr. DEE (G) NR',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'EXTENSION_DRAFT_EXISTS',
      details: { existingRecordId: firstId },
    });
  });

  it('requires the issue authority to finalise', async () => {
    const response = await authed(clerk, {
      method: 'POST',
      url: `/api/extension-requests/${firstId}/finalise`,
      organisationId,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });
  });

  it('finalises into a numbered immutable snapshot', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${firstId}/finalise`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<ExtensionRequestDetailResponse>();
    expect(detail.extensionRequest.status).toBe('finalised');
    expect(detail.extensionRequest.sequenceNumber).toBe(1);
    expect(detail.extensionRequest.requestNumber).toBe(`${workCode}-Extension-01`);
    const snapshot = detail.finalisedSnapshot as {
      requestNumber: string;
      currentCompletionDate: string;
      proposedCompletionDate: string;
      work: { workCode: string };
    };
    expect(snapshot.requestNumber).toBe(`${workCode}-Extension-01`);
    expect(snapshot.currentCompletionDate).toBe('2026-12-31');
    expect(snapshot.proposedCompletionDate).toBe('2027-03-31');
    expect(snapshot.work.workCode).toBe(workCode);
  });

  it('keeps finalised requests immutable through the API', async () => {
    const edit = await authed(owner, {
      method: 'PUT',
      url: `/api/extension-requests/${firstId}`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-05-31',
        reason: 'Tampering with a finalised letter.',
        addressee: 'Sr. DEE (G) NR',
      },
    });
    expect(edit.statusCode).toBe(409);
    const remove = await authed(owner, {
      method: 'DELETE',
      url: `/api/extension-requests/${firstId}`,
      organisationId,
    });
    expect(remove.statusCode).toBe(409);
  });

  it('keeps finalised business data immutable at the database', async () => {
    await expect(
      admin`
        update extension_requests
        set proposed_completion_date = '2029-01-01'
        where id = ${firstId}
      `,
    ).rejects.toThrowError(/immutable/);
  });

  it('renders the letter PDF from the finalised snapshot', async () => {
    const render = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${firstId}/render`,
      organisationId,
    });
    expect(render.statusCode, render.body).toBe(200);
    expect(
      render.json<ExtensionRequestDetailResponse>().extensionRequest.renderedAvailable,
    ).toBe(true);

    const pdf = await authed(viewer, {
      method: 'GET',
      url: `/api/extension-requests/${firstId}/pdf`,
      organisationId,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses to record an outcome before the response document exists', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${firstId}/respond`,
      organisationId,
      payload: { outcome: 'accepted' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'RESPONSE_DOCUMENT_REQUIRED' });
  });

  it('stores the railway response content-addressed, validating magic bytes', async () => {
    const junk = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${firstId}/response-document`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('not a pdf'),
    });
    expect(junk.statusCode).toBe(400);

    const uploaded = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${firstId}/response-document`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from(`%PDF-1.4 railway response ${runId}`),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(
      uploaded.json<ExtensionRequestDetailResponse>().extensionRequest
        .responseDocumentAvailable,
    ).toBe(true);

    const responsePdf = await authed(viewer, {
      method: 'GET',
      url: `/api/extension-requests/${firstId}/pdf?kind=response`,
      organisationId,
    });
    expect(responsePdf.statusCode).toBe(200);
    expect(responsePdf.rawPayload.toString()).toContain('railway response');
  });

  it('applies a modified grant to the current completion date in one transaction', async () => {
    const badGrant = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${firstId}/respond`,
      organisationId,
      payload: { outcome: 'modified', grantedCompletionDate: '2026-11-30' },
    });
    expect(badGrant.statusCode).toBe(400);
    expect(badGrant.json()).toMatchObject({ code: 'EXTENSION_GRANTED_DATE_INVALID' });

    const response = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${firstId}/respond`,
      organisationId,
      payload: { outcome: 'modified', grantedCompletionDate: '2027-02-28' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const detail = response.json<ExtensionRequestDetailResponse>();
    expect(detail.extensionRequest.status).toBe('responded');
    expect(detail.extensionRequest.responseOutcome).toBe('modified');
    expect(detail.extensionRequest.grantedCompletionDate).toBe('2027-02-28');

    const completion = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/completion`,
      organisationId,
    });
    expect(completion.statusCode).toBe(200);
    expect(completion.json<WorkCompletionResponse>().completion).toEqual({
      originalCompletionDate: '2026-12-31',
      currentCompletionDate: '2027-02-28',
    });
  });

  it('freezes responded requests entirely', async () => {
    const again = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${firstId}/respond`,
      organisationId,
      payload: { outcome: 'accepted' },
    });
    expect(again.statusCode).toBe(409);

    const upload = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${firstId}/response-document`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-1.4 replacement'),
    });
    expect(upload.statusCode).toBe(409);

    await expect(
      admin`
        update extension_requests
        set granted_completion_date = '2029-01-01'
        where id = ${firstId}
      `,
    ).rejects.toThrowError(/immutable/);
  });

  it('requires a letter date before finalising and accepts it via draft edit', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-06-30',
        reason: 'Monsoon damage to the access road.',
        addressee: 'Sr. DEE (G) NR',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    secondId = created.json<ExtensionRequestDetailResponse>().extensionRequest.id;

    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${secondId}/finalise`,
      organisationId,
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json()).toMatchObject({ code: 'LETTER_DATE_REQUIRED' });

    const updated = await authed(clerk, {
      method: 'PUT',
      url: `/api/extension-requests/${secondId}`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-06-30',
        reason: 'Monsoon damage to the access road.',
        addressee: 'Sr. DEE (G) NR',
        letterDate: '2026-08-05',
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(
      updated.json<ExtensionRequestDetailResponse>().extensionRequest.letterDate,
    ).toBe('2026-08-05');
  });

  it('lets concurrent finalise attempts produce exactly one numbered request, gaplessly', async () => {
    const [first, second] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/extension-requests/${secondId}/finalise`,
        organisationId,
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/extension-requests/${secondId}/finalise`,
        organisationId,
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const [row] = await admin<
      { count: string; sequence_number: number; request_number: string }[]
    >`
      select count(*) over ()::text as count, sequence_number, request_number
      from extension_requests
      where id = ${secondId} and status = 'finalised'
    `;
    expect(row?.count).toBe('1');
    expect(row?.sequence_number).toBe(2);
    expect(row?.request_number).toBe(`${workCode}-Extension-02`);
  });

  it('accepted responses grant exactly the proposed date', async () => {
    const uploaded = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${secondId}/response-document`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from(`%PDF-1.4 acceptance ${runId}`),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);

    const wrongGrant = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${secondId}/respond`,
      organisationId,
      payload: { outcome: 'accepted', grantedCompletionDate: '2027-07-31' },
    });
    expect(wrongGrant.statusCode).toBe(400);

    const response = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${secondId}/respond`,
      organisationId,
      payload: { outcome: 'accepted' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response.json<ExtensionRequestDetailResponse>().extensionRequest
        .grantedCompletionDate,
    ).toBe('2027-06-30');

    const completion = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/completion`,
      organisationId,
    });
    expect(
      completion.json<WorkCompletionResponse>().completion.currentCompletionDate,
    ).toBe('2027-06-30');
  });

  it('rejected responses change nothing and grant nothing', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-09-30',
        reason: 'Requesting further time for commissioning.',
        addressee: 'Sr. DEE (G) NR',
        letterDate: '2026-08-06',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    thirdId = created.json<ExtensionRequestDetailResponse>().extensionRequest.id;

    const finalised = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${thirdId}/finalise`,
      organisationId,
    });
    expect(finalised.statusCode, finalised.body).toBe(201);
    expect(
      finalised.json<ExtensionRequestDetailResponse>().extensionRequest.requestNumber,
    ).toBe(`${workCode}-Extension-03`);

    const uploaded = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${thirdId}/response-document`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from(`%PDF-1.4 rejection ${runId}`),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);

    const withGrant = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${thirdId}/respond`,
      organisationId,
      payload: { outcome: 'rejected', grantedCompletionDate: '2027-09-30' },
    });
    expect(withGrant.statusCode).toBe(400);

    const response = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${thirdId}/respond`,
      organisationId,
      payload: { outcome: 'rejected' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response.json<ExtensionRequestDetailResponse>().extensionRequest
        .grantedCompletionDate,
    ).toBeNull();

    const completion = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/completion`,
      organisationId,
    });
    expect(
      completion.json<WorkCompletionResponse>().completion.currentCompletionDate,
    ).toBe('2027-06-30');
  });

  it('deletes drafts and keeps the audit timeline complete', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-12-31',
        reason: 'A draft that will be discarded.',
        addressee: 'Sr. DEE (G) NR',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draftId = created.json<ExtensionRequestDetailResponse>().extensionRequest.id;
    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/extension-requests/${draftId}`,
      organisationId,
    });
    expect(removed.statusCode).toBe(204);

    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${firstId}
      order by occurred_at
    `;
    expect(events.map((event) => event.action)).toEqual([
      'extension.created',
      'extension.finalised',
      'extension.rendered',
      'extension.response_document_uploaded',
      'extension.responded',
    ]);

    const workEvents = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${workId}
        and action = 'work.completion_date_extended'
    `;
    expect(workEvents).toHaveLength(2);
  });
});

describe('dashboard completion alerts', () => {
  it('surfaces works within 30 days of completion and past it, with days left', async () => {
    const dueSoon = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${dueSoonWorkId}/completion-dates`,
      organisationId,
      payload: { completionDate: daysFromToday(10) },
    });
    expect(dueSoon.statusCode, dueSoon.body).toBe(200);
    const overdue = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${overdueWorkId}/completion-dates`,
      organisationId,
      payload: { completionDate: daysFromToday(-30) },
    });
    expect(overdue.statusCode, overdue.body).toBe(200);

    const response = await authed(owner, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const dashboard = response.json<DashboardResponse>();

    const dueAlert = dashboard.alerts.find(
      (alert) => alert.kind === 'completion_due' && alert.workId === dueSoonWorkId,
    );
    expect(dueAlert).toBeDefined();
    expect(dueAlert?.severity).toBe('warning');
    expect(dueAlert?.dueInDays).toBeGreaterThanOrEqual(9);
    expect(dueAlert?.dueInDays).toBeLessThanOrEqual(10);

    const overdueAlert = dashboard.alerts.find(
      (alert) => alert.kind === 'completion_overdue' && alert.workId === overdueWorkId,
    );
    expect(overdueAlert).toBeDefined();
    expect(overdueAlert?.severity).toBe('danger');
    expect(overdueAlert?.dueInDays).toBeLessThan(0);

    // The main fixture work's completion moved to 2027: no alert for it.
    expect(
      dashboard.alerts.some(
        (alert) =>
          alert.workId === workId &&
          (alert.kind === 'completion_due' || alert.kind === 'completion_overdue'),
      ),
    ).toBe(false);
  });
});

describe('export manifest covers the extension document objects', () => {
  it('lists the rendered letter and the railway response with their hashes', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const exported = response.json<{
      objectManifest: { kind: string; objectKey: string; sha256: string | null }[];
    }>();
    const kinds = exported.objectManifest.map((entry) => entry.kind);
    expect(kinds).toContain('extension-rendered-pdf');
    expect(kinds).toContain('extension-response-document');
    for (const kind of ['extension-rendered-pdf', 'extension-response-document']) {
      const entry = exported.objectManifest.find((item) => item.kind === kind);
      expect(entry?.sha256, kind).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('cross-tenant denial', () => {
  let foreignExtensionId: string;

  beforeAll(async () => {
    const [row] = await admin<{ id: string }[]>`
      select id from extension_requests
      where organisation_id = ${organisationId} and status = 'responded'
      limit 1
    `;
    if (!row) throw new Error('expected a responded extension request fixture');
    foreignExtensionId = row.id;
  });

  it('answers 404 for every Work-addressed endpoint from another organisation', async () => {
    for (const [method, url, payload] of [
      ['GET', `/api/works/${workId}/completion`, undefined],
      [
        'PUT',
        `/api/works/${workId}/completion-dates`,
        { completionDate: '2026-12-31' },
      ],
      [
        'POST',
        `/api/works/${workId}/extension-requests`,
        {
          proposedCompletionDate: '2028-01-01',
          reason: 'Cross-tenant probe.',
          addressee: 'Nobody',
        },
      ],
    ] as const) {
      const response = await authed(intruder, {
        method,
        url,
        organisationId: intruderOrganisationId,
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(404);
    }
  });

  it('answers 404 for every extension-addressed endpoint from another organisation', async () => {
    for (const [method, url, payload, contentType] of [
      ['GET', `/api/extension-requests/${foreignExtensionId}`, undefined, undefined],
      [
        'PUT',
        `/api/extension-requests/${foreignExtensionId}`,
        {
          proposedCompletionDate: '2028-01-01',
          reason: 'Cross-tenant probe.',
          addressee: 'Nobody',
        },
        undefined,
      ],
      ['DELETE', `/api/extension-requests/${foreignExtensionId}`, undefined, undefined],
      [
        'POST',
        `/api/extension-requests/${foreignExtensionId}/finalise`,
        undefined,
        undefined,
      ],
      [
        'POST',
        `/api/extension-requests/${foreignExtensionId}/render`,
        undefined,
        undefined,
      ],
      [
        'POST',
        `/api/extension-requests/${foreignExtensionId}/response-document`,
        Buffer.from('%PDF-1.4 probe'),
        'application/pdf',
      ],
      [
        'POST',
        `/api/extension-requests/${foreignExtensionId}/respond`,
        { outcome: 'accepted' },
        undefined,
      ],
      [
        'GET',
        `/api/extension-requests/${foreignExtensionId}/pdf`,
        undefined,
        undefined,
      ],
    ] as const) {
      const response = await authed(intruder, {
        method,
        url,
        organisationId: intruderOrganisationId,
        ...(payload !== undefined ? { payload } : {}),
        ...(contentType !== undefined
          ? { headers: { 'content-type': contentType } }
          : {}),
      });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(404);
    }
  });
});
