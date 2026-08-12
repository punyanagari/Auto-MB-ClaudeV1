import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { IssueChallanDetailResponse } from '@auto-mb/contracts';
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
const ownerEmail = `ic-owner-${runId}@integration.test`;
const clerkEmail = `ic-clerk-${runId}@integration.test`;
const viewerEmail = `ic-viewer-${runId}@integration.test`;
const strangerEmail = `ic-stranger-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let fakeGotenberg: http.Server;
let lastGotenbergBody = '';
let organisationId: string;
let strangerOrganisationId: string;
let ownerUserId: string;
let workId: string;
let workCode: string;
let itemAId: string;
let itemBId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let clerk: CookieJar;
let viewer: CookieJar;
let stranger: CookieJar;

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

function draftBody(
  lines: (
    | { workItemId: string; quantity: string }
    | { description: string; unit: string; quantity: string }
  )[],
  overrides: Record<string, unknown> = {},
) {
  return {
    challanDate: '2026-01-15',
    movementType: 'issue',
    issuedToName: 'SSE/Signal/Delhi',
    issuedToRole: 'Site engineer',
    location: 'Relay room, NDLS',
    lines,
    ...overrides,
  };
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-ic-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the Issue Challan integration tests. ' +
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

  // A stub PDF service that records the HTML it was asked to convert, so
  // the tests can prove the render came from the immutable snapshot.
  fakeGotenberg = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      lastGotenbergBody = Buffer.concat(chunks).toString('utf8');
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ic-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    gotenbergUrl: `http://127.0.0.1:${String(gotenbergAddress.port)}`,
  });

  owner = await signUp(ownerEmail, 'IC Owner');
  clerk = await signUp(clerkEmail, 'IC Clerk');
  viewer = await signUp(viewerEmail, 'IC Viewer');
  stranger = await signUp(strangerEmail, 'IC Stranger');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'IC Constructions', slug: `ic-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const strangerOrg = await authed(stranger, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'IC Strangers', slug: `ic-stranger-org-${runId}` },
  });
  expect(strangerOrg.statusCode, strangerOrg.body).toBe(201);
  strangerOrganisationId = strangerOrg.json<{ id: string }>().id;

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
  workCode = `ICW-${runId.toUpperCase()}`;
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
      ${workId}, ${organisationId}, ${workCode},
      ${`ic-letter-${runId}`}, '2025-06-01', 'Issue Challan fixture work',
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
    for (const org of [organisationId, strangerOrganisationId]) {
      if (!org) continue;
      // The immutability triggers (rightly) block deleting issued rows;
      // fixture cleanup is exactly the case session_replication_role
      // exists for.
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'issue_challan_lines',
          'issue_challan_counters',
          'issue_challans',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'work_assignments',
          'work_items',
          'work_schedules',
          'loa_documents',
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

describe('Issue Challan lifecycle', () => {
  let firstChallanId: string;
  let cancelTargetId: string;

  it('drafts an IC with a Work-item line and a manual line outside the LOA', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/issue-challans`,
      organisationId,
      payload: draftBody([
        { workItemId: itemAId, quantity: '3' },
        { description: 'Cable ties (site consumables)', unit: 'Pkt', quantity: '12' },
      ]),
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<IssueChallanDetailResponse>();
    firstChallanId = detail.issueChallan.id;
    expect(detail.issueChallan.status).toBe('draft');
    expect(detail.issueChallan.movementType).toBe('issue');
    expect(detail.issueChallan.challanNumber).toBeNull();
    expect(detail.issueChallan.prefix).toBe(`${workCode}-IC`);
    expect(detail.issueChallan.issuedToName).toBe('SSE/Signal/Delhi');
    expect(detail.issueChallan.issuedToRole).toBe('Site engineer');
    expect(detail.issueChallan.location).toBe('Relay room, NDLS');
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[0]).toMatchObject({
      workItemId: itemAId,
      itemNumber: 'A/1',
      description: 'Main switchboard',
      unit: 'Nos',
      quantity: '3.000',
      position: 1,
    });
    expect(detail.lines[1]).toMatchObject({
      workItemId: null,
      itemNumber: null,
      description: 'Cable ties (site consumables)',
      unit: 'Pkt',
      quantity: '12.000',
      position: 2,
    });
  });

  it('enforces one draft per Work and answers with the existing draft id', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/issue-challans`,
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
    const future = await authed(owner, {
      method: 'PUT',
      url: `/api/issue-challans/${firstChallanId}`,
      organisationId,
      payload: draftBody([{ workItemId: itemAId, quantity: '1' }], {
        challanDate: '2031-01-01',
      }),
    });
    expect(future.statusCode, future.body).toBe(400);
    expect(future.json()).toMatchObject({ code: 'CHALLAN_DATE_INVALID' });

    const beforeLetter = await authed(owner, {
      method: 'PUT',
      url: `/api/issue-challans/${firstChallanId}`,
      organisationId,
      payload: draftBody([{ workItemId: itemAId, quantity: '1' }], {
        challanDate: '2025-05-31',
      }),
    });
    expect(beforeLetter.statusCode, beforeLetter.body).toBe(400);
    expect(beforeLetter.json()).toMatchObject({ code: 'CHALLAN_DATE_INVALID' });
  });

  it('refuses draft edits to read-only roles and accepts them from office', async () => {
    const denied = await authed(viewer, {
      method: 'PUT',
      url: `/api/issue-challans/${firstChallanId}`,
      organisationId,
      payload: draftBody([{ workItemId: itemAId, quantity: '3' }]),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });

    // The office clerk reworks the draft into a loan movement whose
    // quantity EXCEEDS the awarded quantity (5.000): allowed by design.
    const updated = await authed(clerk, {
      method: 'PUT',
      url: `/api/issue-challans/${firstChallanId}`,
      organisationId,
      payload: draftBody(
        [
          { workItemId: itemAId, quantity: '50' },
          { description: 'Test jigs on loan', unit: 'Set', quantity: '2' },
        ],
        { movementType: 'loan', remarks: 'Returnable after commissioning' },
      ),
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const detail = updated.json<IssueChallanDetailResponse>();
    expect(detail.issueChallan.movementType).toBe('loan');
    expect(detail.issueChallan.remarks).toBe('Returnable after commissioning');
    expect(detail.lines[0]).toMatchObject({ quantity: '50.000' });
  });

  it('requires explicit issue authority', async () => {
    const response = await authed(clerk, {
      method: 'POST',
      url: `/api/issue-challans/${firstChallanId}/issue`,
      organisationId,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });
  });

  it('issues with a serialised number even though quantities exceed the awarded quantity', async () => {
    // Explicit proof of the design difference from Delivery Challans:
    // line 1 carries 50.000 against an awarded quantity of 5.000 and no
    // QUANTITY_EXCEEDED conflict is raised.
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${firstChallanId}/issue`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<IssueChallanDetailResponse>();
    expect(detail.issueChallan.status).toBe('issued');
    expect(detail.issueChallan.challanNumber).toBe(`${workCode}-IC/1`);
    expect(detail.issueChallan.sequenceNumber).toBe(1);
    expect(detail.issueChallan.issuedAt).not.toBeNull();
    const snapshot = detail.issuedSnapshot as {
      challanNumber: string;
      movementType: string;
      issuedTo: { name: string; role: string | null; location: string | null };
      lines: { itemNumber: string | null; description: string; quantity: string }[];
    };
    expect(snapshot.challanNumber).toBe(`${workCode}-IC/1`);
    expect(snapshot.movementType).toBe('loan');
    expect(snapshot.issuedTo).toEqual({
      name: 'SSE/Signal/Delhi',
      role: 'Site engineer',
      location: 'Relay room, NDLS',
    });
    expect(snapshot.lines.map((line) => line.itemNumber)).toEqual(['A/1', null]);
    expect(snapshot.lines[0]?.quantity).toBe('50.000');
  });

  it('keeps issued Issue Challans immutable through the API', async () => {
    const edit = await authed(owner, {
      method: 'PUT',
      url: `/api/issue-challans/${firstChallanId}`,
      organisationId,
      payload: draftBody([{ workItemId: itemAId, quantity: '1' }]),
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json()).toMatchObject({ code: 'ISSUE_CHALLAN_STATUS_CONFLICT' });
    const remove = await authed(owner, {
      method: 'DELETE',
      url: `/api/issue-challans/${firstChallanId}`,
      organisationId,
    });
    expect(remove.statusCode).toBe(409);
  });

  it('keeps issued business data immutable at the database as well', async () => {
    await expect(
      admin`
        update issue_challans set issued_to_name = 'Tampered'
        where id = ${firstChallanId}
      `,
    ).rejects.toThrow(/issued Issue Challan business data is immutable/);
    await expect(
      admin`delete from issue_challans where id = ${firstChallanId}`,
    ).rejects.toThrow(/only draft Issue Challans may be deleted/);
    await expect(
      admin`
        insert into issue_challan_lines (
          organisation_id, issue_challan_id, work_id, description_snapshot,
          unit_snapshot, quantity, position
        )
        values (${organisationId}, ${firstChallanId}, ${workId},
                'Smuggled line', 'Nos', 1, 99)
      `,
    ).rejects.toThrow(/mutable only while the challan is draft/);
  });

  it('requires cancel authority and a mandatory note', async () => {
    const create = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/issue-challans`,
      organisationId,
      payload: draftBody([{ workItemId: itemBId, quantity: '1' }]),
    });
    expect(create.statusCode, create.body).toBe(201);
    cancelTargetId = create.json<IssueChallanDetailResponse>().issueChallan.id;
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${cancelTargetId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json<IssueChallanDetailResponse>().issueChallan.challanNumber).toBe(
      `${workCode}-IC/2`,
    );

    const denied = await authed(clerk, {
      method: 'POST',
      url: `/api/issue-challans/${cancelTargetId}/cancel`,
      organisationId,
      payload: { note: 'clerk cannot cancel' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });

    // The note is mandatory: an empty body fails the contract.
    const noteless = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${cancelTargetId}/cancel`,
      organisationId,
      payload: {},
    });
    expect(noteless.statusCode).toBe(400);

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${cancelTargetId}/cancel`,
      organisationId,
      payload: { note: 'Issued against the wrong site.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const detail = cancelled.json<IssueChallanDetailResponse>();
    expect(detail.issueChallan.status).toBe('cancelled');
    // The number is retained forever.
    expect(detail.issueChallan.challanNumber).toBe(`${workCode}-IC/2`);
    expect(detail.issueChallan.cancellationNote).toBe('Issued against the wrong site.');

    const again = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${cancelTargetId}/cancel`,
      organisationId,
      payload: { note: 'already cancelled' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('lets concurrent issue attempts produce exactly one issued challan, gaplessly', async () => {
    const create = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/issue-challans`,
      organisationId,
      payload: draftBody([
        { description: 'Race fixture line', unit: 'Nos', quantity: '1' },
      ]),
    });
    expect(create.statusCode, create.body).toBe(201);
    const raceId = create.json<IssueChallanDetailResponse>().issueChallan.id;

    const [first, second] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/issue-challans/${raceId}/issue`,
        organisationId,
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/issue-challans/${raceId}/issue`,
        organisationId,
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const [row] = await admin<{ count: string; max_seq: number }[]>`
      select count(*)::text as count, max(sequence_number) as max_seq
      from issue_challans
      where id = ${raceId} and status = 'issued'
    `;
    expect(row?.count).toBe('1');
    expect(row?.max_seq).toBe(3);

    // Gapless per Work: the sequence numbers are exactly 1..3 with the
    // cancelled challan keeping its number.
    const sequences = await admin<{ sequence_number: number }[]>`
      select sequence_number from issue_challans
      where work_id = ${workId} and sequence_number is not null
      order by sequence_number
    `;
    expect(sequences.map((entry) => entry.sequence_number)).toEqual([1, 2, 3]);
  });

  it('renders the issued challan from the snapshot with the loan annotation', async () => {
    const render = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${firstChallanId}/render`,
      organisationId,
    });
    expect(render.statusCode, render.body).toBe(200);
    expect(
      render.json<IssueChallanDetailResponse>().issueChallan.renderedAvailable,
    ).toBe(true);

    // The HTML handed to the PDF service came from the immutable issued
    // snapshot: number, movement annotation, and the manual line.
    expect(lastGotenbergBody).toContain(`Issue Challan ${workCode}-IC/1`);
    expect(lastGotenbergBody).toContain(
      'LOAN — material issued on loan and returnable',
    );
    expect(lastGotenbergBody).toContain('Test jigs on loan');
    expect(lastGotenbergBody).not.toContain('Rate');

    const pdf = await authed(viewer, {
      method: 'GET',
      url: `/api/issue-challans/${firstChallanId}/pdf`,
      organisationId,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    // Re-rendering is idempotent — same input snapshot, fresh object.
    const again = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${firstChallanId}/render`,
      organisationId,
    });
    expect(again.statusCode).toBe(200);
  });

  it('accepts a signed copy for issued challans only, validating magic bytes', async () => {
    const junk = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${firstChallanId}/signed-copy`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('not a pdf'),
    });
    expect(junk.statusCode).toBe(400);

    const uploaded = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${firstChallanId}/signed-copy`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from(`%PDF-1.4 signed ${runId}`),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(
      uploaded.json<IssueChallanDetailResponse>().issueChallan.signedCopyAvailable,
    ).toBe(true);

    // Content-addressed evidence: the hash is recorded alongside the key.
    const [row] = await admin<
      { signed_copy_sha256: string | null; signed_copy_object_key: string | null }[]
    >`
      select signed_copy_sha256, signed_copy_object_key
      from issue_challans where id = ${firstChallanId}
    `;
    expect(row?.signed_copy_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.signed_copy_object_key).toContain(`${organisationId}/icsigned/`);

    const signedPdf = await authed(viewer, {
      method: 'GET',
      url: `/api/issue-challans/${firstChallanId}/pdf?kind=signed`,
      organisationId,
    });
    expect(signedPdf.statusCode).toBe(200);
    expect(signedPdf.rawPayload.toString()).toContain('signed');
  });

  it('deletes drafts outright — they never had a number', async () => {
    const create = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/issue-challans`,
      organisationId,
      payload: draftBody([{ workItemId: itemAId, quantity: '1' }]),
    });
    expect(create.statusCode, create.body).toBe(201);
    const draftId = create.json<IssueChallanDetailResponse>().issueChallan.id;
    const removed = await authed(clerk, {
      method: 'DELETE',
      url: `/api/issue-challans/${draftId}`,
      organisationId,
    });
    expect(removed.statusCode).toBe(204);
    const gone = await authed(clerk, {
      method: 'GET',
      url: `/api/issue-challans/${draftId}`,
      organisationId,
    });
    expect(gone.statusCode).toBe(404);
  });

  it('writes the full audit timeline', async () => {
    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId}
        and entity_id = ${firstChallanId}
      order by occurred_at
    `;
    expect(events.map((event) => event.action)).toEqual([
      'issue_challan.created',
      'issue_challan.updated',
      'issue_challan.issued',
      'issue_challan.rendered',
      'issue_challan.rendered',
      'issue_challan.signed_copy_uploaded',
    ]);

    const cancelledEvents = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId}
        and entity_id = ${cancelTargetId}
        and action = 'issue_challan.cancelled'
    `;
    expect(cancelledEvents).toHaveLength(1);
  });

  it('denies every endpoint across tenants', async () => {
    const pdfPayload = Buffer.from(`%PDF-1.4 evil ${runId}`);
    const attempts: (Omit<InjectOptions, 'url'> & {
      url: string;
      expectForeign: number;
    })[] = [
      {
        method: 'GET',
        url: `/api/works/${workId}/issue-challans`,
        // The foreign Work id resolves to nothing under RLS: an empty
        // list, never another tenant's documents (DC list behaviour).
        expectForeign: 200,
      },
      {
        method: 'POST',
        url: `/api/works/${workId}/issue-challans`,
        payload: draftBody([{ description: 'Evil line', unit: 'Nos', quantity: '1' }]),
        expectForeign: 404,
      },
      {
        method: 'GET',
        url: `/api/issue-challans/${firstChallanId}`,
        expectForeign: 404,
      },
      {
        method: 'PUT',
        url: `/api/issue-challans/${firstChallanId}`,
        payload: draftBody([{ description: 'Evil line', unit: 'Nos', quantity: '1' }]),
        expectForeign: 404,
      },
      {
        method: 'DELETE',
        url: `/api/issue-challans/${firstChallanId}`,
        expectForeign: 404,
      },
      {
        method: 'POST',
        url: `/api/issue-challans/${firstChallanId}/issue`,
        expectForeign: 404,
      },
      {
        method: 'POST',
        url: `/api/issue-challans/${firstChallanId}/cancel`,
        payload: { note: 'cross-tenant cancel attempt' },
        expectForeign: 404,
      },
      {
        method: 'POST',
        url: `/api/issue-challans/${firstChallanId}/render`,
        expectForeign: 404,
      },
      {
        method: 'POST',
        url: `/api/issue-challans/${firstChallanId}/signed-copy`,
        headers: { 'content-type': 'application/pdf' },
        payload: pdfPayload,
        expectForeign: 404,
      },
      {
        method: 'GET',
        url: `/api/issue-challans/${firstChallanId}/pdf`,
        expectForeign: 404,
      },
    ];

    for (const { expectForeign, ...attempt } of attempts) {
      const label = `${String(attempt.method)} ${attempt.url}`;

      // With the victim organisation's id the membership floor refuses
      // outright: the stranger holds no membership there.
      const asVictimOrg = await authed(stranger, {
        ...attempt,
        organisationId,
      });
      expect(asVictimOrg.statusCode, `${label} (victim org): ${asVictimOrg.body}`).toBe(
        403,
      );
      expect(asVictimOrg.json()).toMatchObject({ code: 'NOT_A_MEMBER' });

      // Within their own organisation RLS hides the foreign rows.
      const asOwnOrg = await authed(stranger, {
        ...attempt,
        organisationId: strangerOrganisationId,
      });
      expect(asOwnOrg.statusCode, `${label} (own org): ${asOwnOrg.body}`).toBe(
        expectForeign,
      );
      if (expectForeign === 200) {
        expect(asOwnOrg.json()).toEqual({ issueChallans: [] });
      }
    }

    // Nothing above changed the victim challan.
    const [untouched] = await admin<{ status: string }[]>`
      select status from issue_challans where id = ${firstChallanId}
    `;
    expect(untouched?.status).toBe('issued');
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
        ${raceWorkId}, ${organisationId}, ${`ICR-${runId.toUpperCase()}`},
        ${`ic-race-letter-${runId}`}, '2025-06-01', 'Issue Challan race work',
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
        url: `/api/works/${raceWorkId}/issue-challans`,
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
    const winnerId = winners[0]?.json<IssueChallanDetailResponse>().issueChallan.id;
    // Whether the loser hit the pre-check or the unique-index race path,
    // its 409 names the winning draft.
    expect(losers[0]?.json()).toMatchObject({
      code: 'DRAFT_EXISTS',
      details: { existingRecordId: winnerId },
    });
  });
});

describe('export manifest covers the issue-challan document objects', () => {
  it('lists the rendered PDF and the signed copy with their hashes', async () => {
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
    expect(kinds).toContain('issue-challan-rendered-pdf');
    expect(kinds).toContain('issue-challan-signed-copy');
    for (const kind of ['issue-challan-rendered-pdf', 'issue-challan-signed-copy']) {
      const entry = exported.objectManifest.find((item) => item.kind === kind);
      expect(entry?.sha256, kind).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Milestone 6/7 retrofit — the Issue Challan invariant exit suite.
//
// Already pinned above and NOT repeated here: one open draft per Work with
// the uniform 409 (`existingRecordId`), including under a simultaneous
// double-create; the number appearing only at issue and never on a draft;
// cancellation taking a mandatory note and keeping its number forever;
// manual lines and over-LOA quantities issuing by design; issued business
// data frozen through the API and at the database; the signed copy
// content-addressed with a sha256 and served back; explicit issue and
// cancel authorities; gapless per-Work numbering under a concurrent
// double-issue; and full cross-tenant denial of every endpoint.
//
// What was NOT pinned, and is pinned here: the IC counter being wholly
// independent of the Delivery Challan counter on the same Work, a
// cancelled number never being re-minted, the `return` movement type,
// the immutability of a cancelled challan's rendered evidence, and the
// revalidation of authority AND Work scope inside the issue and cancel
// transactions.
// ---------------------------------------------------------------------------

describe('Issue Challan invariant exit suite', () => {
  let exitWorkId: string;
  let exitWorkCode: string;
  let exitItemId: string;
  let scoped: CookieJar;
  const scopedEmail = `ic-scoped-${runId}@integration.test`;

  const draftOn = async (
    jar: CookieJar,
    lines: Parameters<typeof draftBody>[0],
    overrides: Record<string, unknown> = {},
  ) => {
    const response = await authed(jar, {
      method: 'POST',
      url: `/api/works/${exitWorkId}/issue-challans`,
      organisationId,
      payload: draftBody(lines, overrides),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<IssueChallanDetailResponse>().issueChallan.id;
  };

  const issue = async (id: string) =>
    authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${id}/issue`,
      organisationId,
    });

  beforeAll(async () => {
    exitWorkId = randomUUID();
    exitWorkCode = `ICX-${runId.toUpperCase()}`;
    const scheduleId = randomUUID();
    exitItemId = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${exitWorkId}, ${organisationId}, ${exitWorkCode},
        ${`ic-exit-letter-${runId}`}, '2025-06-01', 'IC exit-suite work',
        1000.00, 900.00, 'per_schedule', ${ownerUserId}
      )
    `;
    await admin`
      insert into work_schedules (
        id, organisation_id, work_id, schedule_code, title, position
      )
      values (${scheduleId}, ${organisationId}, ${exitWorkId}, 'A', 'Schedule A', 1)
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${exitItemId}, ${organisationId}, ${exitWorkId}, ${scheduleId}, 'A/1',
        'Exit-suite switchboard', 'Nos', 5.000, 100.00
      )
    `;

    // An office member with BOTH document authorities but an
    // assigned-only Work scope and no assignment to this Work: every
    // refusal below is scope, never a missing grant.
    scoped = await signUp(scopedEmail, 'IC Scoped');
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email: scopedEmail, role: 'office' },
    });
    expect(added.statusCode, added.body).toBe(201);
    await admin`
      update organisation_memberships
      set work_scope = 'assigned', can_issue_documents = true,
          can_cancel_documents = true
      where organisation_id = ${organisationId}
        and user_id = (select "id" from auth_users where "email" = ${scopedEmail})
    `;
  });

  it('numbers the IC series independently of the Delivery Challan series', async () => {
    // Same Work, both document types. The legacy product keeps two
    // per-Work counters; nothing about issuing a DC may move the IC
    // sequence or the other way round.
    const icOneId = await draftOn(owner, [{ workItemId: exitItemId, quantity: '2' }]);
    const icOne = await issue(icOneId);
    expect(icOne.statusCode, icOne.body).toBe(201);
    expect(icOne.json<IssueChallanDetailResponse>().issueChallan.challanNumber).toBe(
      `${exitWorkCode}-IC/1`,
    );

    const dcDraft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${exitWorkId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-01-15',
        prefix: `${exitWorkCode}-DC`,
        consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division' },
        items: [{ workItemId: exitItemId, quantity: '2' }],
      },
    });
    expect(dcDraft.statusCode, dcDraft.body).toBe(201);
    const dcId = dcDraft.json<{ challan: { id: string } }>().challan.id;
    const dcIssued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${dcId}/issue`,
      organisationId,
    });
    expect(dcIssued.statusCode, dcIssued.body).toBe(201);

    // The DC took ITS series' first number, not the IC's second.
    const [dcRow] = await admin<{ challan_number: string; sequence_number: number }[]>`
      select challan_number, sequence_number from delivery_challans
      where id = ${dcId}
    `;
    expect(dcRow?.sequence_number).toBe(1);
    expect(dcRow?.challan_number).toBe(`${exitWorkCode}-DC/1`);

    // …and the next IC still takes 2, unmoved by the DC.
    const icTwoId = await draftOn(owner, [
      { description: 'Site consumables', unit: 'Pkt', quantity: '4' },
    ]);
    const icTwo = await issue(icTwoId);
    expect(icTwo.statusCode, icTwo.body).toBe(201);
    expect(icTwo.json<IssueChallanDetailResponse>().issueChallan.challanNumber).toBe(
      `${exitWorkCode}-IC/2`,
    );

    // Two counter rows, each at its own value.
    const [icCounter] = await admin<{ next_value: number }[]>`
      select next_value from issue_challan_counters where work_id = ${exitWorkId}
    `;
    const [dcCounter] = await admin<{ next_value: number }[]>`
      select next_value from delivery_challan_counters where work_id = ${exitWorkId}
    `;
    expect(icCounter?.next_value).toBe(2);
    expect(dcCounter?.next_value).toBe(1);
  });

  it('never re-mints a cancelled Issue Challan number', async () => {
    const [before] = await admin<{ id: string; challan_number: string }[]>`
      select id, challan_number from issue_challans
      where work_id = ${exitWorkId} and sequence_number = 2
    `;
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${before?.id ?? ''}/cancel`,
      organisationId,
      payload: { note: 'Material returned to store before dispatch.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const nextId = await draftOn(owner, [
      { description: 'Replacement consumables', unit: 'Pkt', quantity: '4' },
    ]);
    const next = await issue(nextId);
    expect(next.statusCode, next.body).toBe(201);
    // 3, never the released 2.
    expect(next.json<IssueChallanDetailResponse>().issueChallan.challanNumber).toBe(
      `${exitWorkCode}-IC/3`,
    );

    const numbers = await admin<{ challan_number: string; status: string }[]>`
      select challan_number, status from issue_challans
      where work_id = ${exitWorkId} and challan_number is not null
      order by sequence_number
    `;
    expect(numbers.map((row) => row.challan_number)).toEqual([
      `${exitWorkCode}-IC/1`,
      `${exitWorkCode}-IC/2`,
      `${exitWorkCode}-IC/3`,
    ]);
    expect(numbers[1]?.status).toBe('cancelled');
  });

  it('accepts the return movement type end to end', async () => {
    const returnId = await draftOn(
      owner,
      [{ description: 'Unused ballast returned to store', unit: 'Cum', quantity: '2' }],
      { movementType: 'return' },
    );
    const issued = await issue(returnId);
    expect(issued.statusCode, issued.body).toBe(201);
    const detail = issued.json<IssueChallanDetailResponse>();
    expect(detail.issueChallan.movementType).toBe('return');
    const snapshot = detail.issuedSnapshot as { movementType: string };
    expect(snapshot.movementType).toBe('return');
  });

  it('freezes a cancelled challan whole, rendered evidence included', async () => {
    const [cancelledRow] = await admin<{ id: string }[]>`
      select id from issue_challans
      where work_id = ${exitWorkId} and status = 'cancelled'
      limit 1
    `;
    const id = cancelledRow?.id ?? '';
    for (const column of ['rendered_sha256', 'rendered_object_key'] as const) {
      await expect(
        admin.unsafe(`update issue_challans set ${column} = $1 where id = $2`, [
          'f'.repeat(64),
          id,
        ]),
        column,
      ).rejects.toThrow(/cancelled Issue Challans are immutable/);
    }
  });

  it('renders content-addressed evidence: the same snapshot yields the same hash', async () => {
    const [issuedRow] = await admin<{ id: string }[]>`
      select id from issue_challans
      where work_id = ${exitWorkId} and status = 'issued' and sequence_number = 1
    `;
    const id = issuedRow?.id ?? '';
    const first = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${id}/render`,
      organisationId,
    });
    expect(first.statusCode, first.body).toBe(200);
    const [afterFirst] = await admin<{ rendered_sha256: string | null }[]>`
      select rendered_sha256 from issue_challans where id = ${id}
    `;
    expect(afterFirst?.rendered_sha256).toMatch(/^[0-9a-f]{64}$/);

    // The issued snapshot is frozen, so a re-render is byte-identical:
    // the recorded hash cannot drift while the document stands.
    const second = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${id}/render`,
      organisationId,
    });
    expect(second.statusCode, second.body).toBe(200);
    const [afterSecond] = await admin<{ rendered_sha256: string | null }[]>`
      select rendered_sha256 from issue_challans where id = ${id}
    `;
    expect(afterSecond?.rendered_sha256).toBe(afterFirst?.rendered_sha256);
  });

  it('revalidates the issue authority INSIDE the issuing transaction', async () => {
    const draftId = await draftOn(owner, [
      { description: 'Authority revalidation line', unit: 'Nos', quantity: '1' },
    ]);
    // The authority is withdrawn AFTER the draft exists: if it were only
    // checked at draft time the issue would still succeed.
    await admin`
      update organisation_memberships set can_issue_documents = false
      where organisation_id = ${organisationId} and user_id = ${ownerUserId}
    `;
    const refused = await issue(draftId);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await admin`
      update organisation_memberships set can_issue_documents = true
      where organisation_id = ${organisationId} and user_id = ${ownerUserId}
    `;
    const issued = await issue(draftId);
    expect(issued.statusCode, issued.body).toBe(201);

    // …and the same for cancel, on the challan just issued.
    await admin`
      update organisation_memberships set can_cancel_documents = false
      where organisation_id = ${organisationId} and user_id = ${ownerUserId}
    `;
    const cancelRefused = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${draftId}/cancel`,
      organisationId,
      payload: { note: 'Authority revalidation probe.' },
    });
    expect(cancelRefused.statusCode).toBe(403);
    await admin`
      update organisation_memberships set can_cancel_documents = true
      where organisation_id = ${organisationId} and user_id = ${ownerUserId}
    `;
  });

  it('revalidates Work scope at issue and at cancel for an assigned-scope member', async () => {
    const draftId = await draftOn(owner, [
      { description: 'Scope probe line', unit: 'Nos', quantity: '1' },
    ]);
    // The scoped member holds BOTH authorities but no assignment to this
    // Work: every surface answers 404, never a state-specific 409 that
    // would confirm the record exists.
    const probes: (Omit<InjectOptions, 'url'> & { url: string })[] = [
      { method: 'GET', url: `/api/works/${exitWorkId}/issue-challans` },
      { method: 'GET', url: `/api/issue-challans/${draftId}` },
      { method: 'POST', url: `/api/issue-challans/${draftId}/issue` },
      {
        method: 'POST',
        url: `/api/issue-challans/${draftId}/cancel`,
        payload: { note: 'Scope probe cancel.' },
      },
    ];
    for (const probe of probes) {
      const response = await authed(scoped, { ...probe, organisationId });
      expect(
        response.statusCode,
        `${String(probe.method)} ${probe.url}: ${response.body}`,
      ).toBe(404);
    }

    // The draft is untouched and the owner can still issue it.
    const issued = await issue(draftId);
    expect(issued.statusCode, issued.body).toBe(201);
  });

  it('names a non-positive line quantity with a 400 rather than letting the column CHECK answer', async () => {
    // Work-item and manual lines share the one predicate
    // (isPositiveDecimal); the column reads
    // `numeric(18,3) NOT NULL CHECK (quantity > 0)`, and a CHECK
    // violation carries no HTTP status, so the operator would read
    // 'The request could not be completed.'
    for (const quantity of ['0', '0.000', '-2', '-0']) {
      const workItemLine = await authed(owner, {
        method: 'POST',
        url: `/api/works/${exitWorkId}/issue-challans`,
        organisationId,
        payload: draftBody([{ workItemId: exitItemId, quantity }]),
      });
      expect(workItemLine.statusCode, `${quantity}: ${workItemLine.body}`).toBe(400);
      expect(workItemLine.json()).toMatchObject({ code: 'QUANTITY_INVALID' });

      const manualLine = await authed(owner, {
        method: 'POST',
        url: `/api/works/${exitWorkId}/issue-challans`,
        organisationId,
        payload: draftBody([
          { description: 'Cable ties (site consumables)', unit: 'Pkt', quantity },
        ]),
      });
      expect(manualLine.statusCode, `${quantity}: ${manualLine.body}`).toBe(400);
      expect(manualLine.json()).toMatchObject({ code: 'QUANTITY_INVALID' });
    }
  });
});
