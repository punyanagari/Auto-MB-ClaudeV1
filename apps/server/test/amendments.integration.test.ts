import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ApprovalListResponse,
  ApprovalRequest,
  ChallanDetailResponse,
  WorkBalanceResponse,
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
const ownerEmail = `amd-owner-${runId}@integration.test`;
const clerkEmail = `amd-clerk-${runId}@integration.test`;
const viewerEmail = `amd-viewer-${runId}@integration.test`;
const outsiderEmail = `amd-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let organisationBId: string;
let ownerUserId: string;
let clerkUserId: string;
let workId: string;
let work2Id: string;
let scheduleId: string;
let itemAId: string;
let itemBId: string;
let itemCId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let clerk: CookieJar;
let viewer: CookieJar;
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

function draftBody(prefix: string, items: { workItemId: string; quantity: string }[]) {
  return {
    challanDate: '2026-08-08',
    prefix,
    consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division, New Delhi' },
    items,
  };
}

/** Drafts and issues a challan in one step, returning the issue response. */
async function issueChallan(
  jar: CookieJar,
  targetWorkId: string,
  prefix: string,
  items: { workItemId: string; quantity: string }[],
) {
  const created = await authed(jar, {
    method: 'POST',
    url: `/api/works/${targetWorkId}/challans`,
    organisationId,
    payload: draftBody(prefix, items),
  });
  expect(created.statusCode, created.body).toBe(201);
  const challanId = created.json<ChallanDetailResponse>().challan.id;
  const issued = await authed(jar, {
    method: 'POST',
    url: `/api/challans/${challanId}/issue`,
    organisationId,
  });
  return { challanId, issued };
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-amendments-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the amendments integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-amd-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Amendment Owner');
  clerk = await signUp(clerkEmail, 'Amendment Clerk');
  viewer = await signUp(viewerEmail, 'Amendment Viewer');
  outsider = await signUp(outsiderEmail, 'Outside Owner');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Amendment Constructions', slug: `amd-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const createdB = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Other Constructions', slug: `amd-org-b-${runId}` },
  });
  expect(createdB.statusCode, createdB.body).toBe(201);
  organisationBId = createdB.json<{ id: string }>().id;

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
  const [clerkUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${clerkEmail}
  `;
  if (!clerkUser) throw new Error('clerk user missing');
  clerkUserId = clerkUser.id;

  // Issue authority for delivery tests; the amendment-approval authority is
  // granted through the member-management API in the first test below.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
  // The outsider holds every authority in their OWN organisation, so the
  // cross-tenant denials below prove tenancy, not missing authority.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_approve_amendments = true
    where organisation_id = ${organisationBId}
  `;

  workId = randomUUID();
  work2Id = randomUUID();
  scheduleId = randomUUID();
  const schedule2Id = randomUUID();
  itemAId = randomUUID();
  itemBId = randomUUID();
  itemCId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values
      (${workId}, ${organisationId}, ${`AMD-${runId.toUpperCase()}`},
       ${`amd-letter-${runId}`}, '2025-06-01', 'Amendment fixture work',
       1000.00, 900.00, 'per_schedule', ${ownerUserId}),
      (${work2Id}, ${organisationId}, ${`AMD2-${runId.toUpperCase()}`},
       ${`amd-letter-2-${runId}`}, '2025-06-01', 'Amendment race work',
       500.00, 450.00, 'per_schedule', ${ownerUserId})
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values
      (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1),
      (${schedule2Id}, ${organisationId}, ${work2Id}, 'C', 'Schedule C', 1)
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
       'Cable set', 'Set', 2.000, 250.50),
      (${itemCId}, ${organisationId}, ${work2Id}, ${schedule2Id}, 'C/1',
       'Earthing kit', 'Nos', 2.000, 10.00)
  `;
}, 60_000);

afterAll(async () => {
  if (admin) {
    for (const orgId of [organisationId, organisationBId]) {
      if (!orgId) continue;
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'installations',
          'location_masters',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'approval_requests',
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
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('amendment approvals', () => {
  let changeRequestId: string;

  it('grants the approval authority through member management', async () => {
    const denied = await authed(clerk, {
      method: 'PATCH',
      url: `/api/organisations/current/members/${ownerUserId}`,
      organisationId,
      payload: { canApproveAmendments: true },
    });
    expect(denied.statusCode).toBe(403);

    const updated = await authed(owner, {
      method: 'PATCH',
      url: `/api/organisations/current/members/${ownerUserId}`,
      organisationId,
      payload: { canApproveAmendments: true },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const members = updated.json<{
      members: { userId: string; canApproveAmendments: boolean }[];
    }>().members;
    expect(
      members.find((member) => member.userId === ownerUserId)?.canApproveAmendments,
    ).toBe(true);
    expect(
      members.find((member) => member.userId === clerkUserId)?.canApproveAmendments,
    ).toBe(false);
  });

  it('lets a clerk propose a change: pending, with a structured diff', async () => {
    const response = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: itemAId,
        reason: 'Railway variation order 12 raised the quantity.',
        changes: { quantity: '8', rate: '110.00' },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const approval = response.json<ApprovalRequest>();
    changeRequestId = approval.id;
    expect(approval.status).toBe('pending');
    expect(approval.entityId).toBe(itemAId);
    expect(approval.itemNumber).toBe('A/1');
    expect(approval.requestedByUserId).toBe(clerkUserId);
    expect(approval.decidedByUserId).toBeNull();
    expect(approval.diff).toEqual([
      { field: 'quantity', before: '5.000', after: '8.000' },
      { field: 'rate', before: '100.00', after: '110.00' },
    ]);

    // Nothing applied yet: the ceiling is untouched.
    const balance = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/balance`,
      organisationId,
    });
    const itemA = balance
      .json<WorkBalanceResponse>()
      .items.find((item) => item.workItemId === itemAId);
    expect(itemA?.effectiveQuantity).toBeNull();
    expect(Number(itemA?.remainingQuantity)).toBe(5);
  });

  it('refuses proposals from read-only members', async () => {
    const response = await authed(viewer, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: itemAId,
        reason: 'Viewer should not reach this.',
        changes: { quantity: '9' },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
  });

  it('rejects an empty change set', async () => {
    const response = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: { workItemId: itemBId, reason: 'No changes here.', changes: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'AMENDMENT_EMPTY' });
  });

  it('allows one pending request per item: the second is a 409', async () => {
    const response = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: itemAId,
        reason: 'Second attempt on the same item.',
        changes: { quantity: '9' },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PENDING_EXISTS' });
  });

  it('serialises simultaneous proposals for one item', async () => {
    const propose = () =>
      authed(clerk, {
        method: 'POST',
        url: `/api/works/${workId}/amendments`,
        organisationId,
        payload: {
          workItemId: itemBId,
          reason: 'Concurrent proposal race.',
          changes: { quantity: '1.5' },
        },
      });
    const [first, second] = await Promise.all([propose(), propose()]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const survivor = [first, second].find((response) => response.statusCode === 201);
    const survivorId = survivor?.json<ApprovalRequest>().id;
    expect(survivorId).toBeDefined();
    // Clean up so later itemB scenarios start from no pending request.
    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${survivorId ?? ''}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
  });

  it('requires the approval authority to approve, then applies atomically', async () => {
    const denied = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${changeRequestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });

    const approved = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${changeRequestId}/approve`,
      organisationId,
      payload: { note: 'Sanctioned by Sr. DEE letter.' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const approval = approved.json<ApprovalRequest>();
    expect(approval.status).toBe('approved');
    expect(approval.decidedByUserId).toBe(ownerUserId);
    expect(approval.decidedAt).not.toBeNull();

    // The Work detail shows original and effective side by side.
    const detail = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}`,
      organisationId,
    });
    const items = detail.json<WorkDetailResponse>().schedules[0]?.items ?? [];
    const itemA = items.find((item) => item.id === itemAId);
    expect(itemA?.awardedQuantity).toBe('5.000');
    expect(itemA?.effectiveQuantity).toBe('8.000');
    expect(itemA?.effectiveRate).toBe('100.00');
    expect(itemA?.effectiveUnitRate).toBe('110.00');
    expect(itemA?.amendmentAdded).toBe(false);

    // The balance-aware picker uses the amended ceiling and rate.
    const balance = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/balance`,
      organisationId,
    });
    const balanceA = balance
      .json<WorkBalanceResponse>()
      .items.find((item) => item.workItemId === itemAId);
    expect(balanceA?.effectiveQuantity).toBe('8.000');
    expect(balanceA?.remainingQuantity).toBe('8.000');
    expect(balanceA?.effectiveRate).toBe('110.00');

    const again = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${changeRequestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
  });

  it('issues against the RAISED ceiling at the amended rate', async () => {
    const { issued } = await issueChallan(owner, workId, 'W1', [
      { workItemId: itemAId, quantity: '6' },
    ]);
    expect(issued.statusCode, issued.body).toBe(201);
    const line = issued.json<ChallanDetailResponse>().items[0];
    expect(line?.rate).toBe('110.00');
    expect(line?.lineAmount).toBe('660.00');

    // 6 delivered + 3 > 8: the amended ceiling still binds.
    const over = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: draftBody('W1', [{ workItemId: itemAId, quantity: '3' }]),
    });
    expect(over.statusCode, over.body).toBe(201);
    const overId = over.json<ChallanDetailResponse>().challan.id;
    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${overId}/issue`,
      organisationId,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'QUANTITY_EXCEEDED' });

    // Exactly the remaining 2 passes.
    const corrected = await authed(owner, {
      method: 'PUT',
      url: `/api/challans/${overId}`,
      organisationId,
      payload: draftBody('W1', [{ workItemId: itemAId, quantity: '2' }]),
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    const issuedExact = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${overId}/issue`,
      organisationId,
    });
    expect(issuedExact.statusCode, issuedExact.body).toBe(201);
  });

  it('rejects a floor violation at apply time and keeps the request pending', async () => {
    // Delivered on A/1 is now 8; lowering to 6 must fail AT APPLY.
    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: itemAId,
        reason: 'Attempt to lower below delivered.',
        changes: { quantity: '6' },
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const floorRequestId = proposed.json<ApprovalRequest>().id;

    const approve = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${floorRequestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toMatchObject({ code: 'AMENDMENT_FLOOR_VIOLATION' });
    expect(approve.json<{ message: string }>().message).toContain('8.000');

    // The failed apply rolled back atomically: the request is STILL pending
    // and the item unchanged.
    const queue = await authed(viewer, {
      method: 'GET',
      url: '/api/approvals?status=pending',
      organisationId,
    });
    expect(
      queue.json<ApprovalListResponse>().approvals.map((approval) => approval.id),
    ).toContain(floorRequestId);

    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${floorRequestId}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json<ApprovalRequest>().status).toBe('withdrawn');
  });

  it('catches a delivery that landed between propose and approve', async () => {
    // Propose lowering A/2 to 1 while nothing is delivered…
    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: itemBId,
        reason: 'Lower the cable sets to one.',
        changes: { quantity: '1' },
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const requestId = proposed.json<ApprovalRequest>().id;

    // …then 1.5 sets are delivered before anyone decides…
    const { issued } = await issueChallan(owner, workId, 'W1', [
      { workItemId: itemBId, quantity: '1.5' },
    ]);
    expect(issued.statusCode, issued.body).toBe(201);

    // …so the approval revalidates against LIVE state and refuses.
    const approve = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${requestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toMatchObject({ code: 'AMENDMENT_FLOOR_VIOLATION' });

    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${requestId}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode).toBe(200);
  });

  it('keeps the ceiling correct when approve and issue race', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${work2Id}/challans`,
      organisationId,
      payload: draftBody('W2', [{ workItemId: itemCId, quantity: '2' }]),
    });
    expect(created.statusCode, created.body).toBe(201);
    const challanId = created.json<ChallanDetailResponse>().challan.id;

    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${work2Id}/amendments`,
      organisationId,
      payload: {
        workItemId: itemCId,
        reason: 'Halve the earthing kits.',
        changes: { quantity: '1' },
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const requestId = proposed.json<ApprovalRequest>().id;

    const [issueResult, approveResult] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/challans/${challanId}/issue`,
        organisationId,
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/approvals/${requestId}/approve`,
        organisationId,
        payload: {},
      }),
    ]);
    // Whichever transaction wins, the other must observe it: exactly one
    // succeeds (issue → floor blocks the approval; approval → the lowered
    // ceiling blocks the issue).
    const successes = [
      issueResult.statusCode === 201,
      approveResult.statusCode === 200,
    ].filter(Boolean);
    expect(
      successes,
      `issue=${String(issueResult.statusCode)} approve=${String(approveResult.statusCode)}`,
    ).toHaveLength(1);

    const [state] = await admin<{ delivered: string; ceiling: string }[]>`
      select coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0)::text
               as delivered,
             (select coalesce(wi.effective_quantity, wi.awarded_quantity)::text
              from work_items wi where wi.id = ${itemCId}) as ceiling
      from delivery_challan_items dci
      join delivery_challans dc on dc.id = dci.delivery_challan_id
      where dci.work_item_id = ${itemCId}
    `;
    expect(Number(state?.delivered)).toBeLessThanOrEqual(Number(state?.ceiling));
  });

  it('direct-applies a proposal from an approval-authority holder', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: itemBId,
        reason: 'Owner adjusts the cable-set rate.',
        changes: { rate: '260.00' },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const approval = response.json<ApprovalRequest>();
    expect(approval.status).toBe('approved');
    expect(approval.requestedByUserId).toBe(ownerUserId);
    expect(approval.decidedByUserId).toBe(ownerUserId);
    expect(approval.decidedAt).not.toBeNull();

    // The identical audit trail exists: proposed AND approved. Both
    // events are written in the same deciding transaction, so their
    // occurred_at timestamps tie — compare as a sorted set, not by time.
    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${approval.id}
    `;
    expect(events.map((event) => event.action).sort()).toEqual([
      'amendment.approved',
      'amendment.proposed',
    ]);
  });

  it('rejecting requires a note; a rejected item can be re-proposed', async () => {
    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments/items`,
      organisationId,
      payload: {
        reason: 'Variation adds a lightning arrester item.',
        scheduleId,
        itemNumber: 'A/3',
        description: 'Lightning arrester, station class',
        unitCode: 'Nos',
        quantity: '4',
        rate: '50.00',
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const addRequest = proposed.json<ApprovalRequest>();
    expect(addRequest.entityId).toBeNull();
    expect(addRequest.itemNumber).toBe('A/3');

    const noNote = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${addRequest.id}/reject`,
      organisationId,
      payload: {},
    });
    expect(noNote.statusCode).toBe(400);

    const rejected = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${addRequest.id}/reject`,
      organisationId,
      payload: { note: 'Duplicate of variation 9.' },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json<ApprovalRequest>().status).toBe('rejected');
    expect(rejected.json<ApprovalRequest>().decisionNote).toBe(
      'Duplicate of variation 9.',
    );
  });

  it('adds a new item once approved, marked and traceable to its approval', async () => {
    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments/items`,
      organisationId,
      payload: {
        reason: 'Variation adds a lightning arrester item (resubmitted).',
        scheduleId,
        itemNumber: 'A/3',
        description: 'Lightning arrester, station class',
        unitCode: 'Nos',
        quantity: '4',
        rate: '50.00',
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const requestId = proposed.json<ApprovalRequest>().id;

    const approved = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${requestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const approval = approved.json<ApprovalRequest>();
    expect(approval.status).toBe('approved');
    expect(approval.entityId).not.toBeNull();

    const detail = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}`,
      organisationId,
    });
    const items = detail.json<WorkDetailResponse>().schedules[0]?.items ?? [];
    const added = items.find((item) => item.itemNumber === 'A/3');
    expect(added).toBeDefined();
    expect(added?.amendmentAdded).toBe(true);
    expect(added?.awardedQuantity).toBe('4.000');
    expect(added?.effectiveRate).toBe('50.00');

    const [row] = await admin<{ source_approval_id: string | null }[]>`
      select source_approval_id from work_items where id = ${added?.id ?? null}
    `;
    expect(row?.source_approval_id).toBe(requestId);

    // A duplicate item number cannot be proposed again.
    const duplicate = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments/items`,
      organisationId,
      payload: {
        reason: 'Accidentally proposing the same number.',
        scheduleId,
        itemNumber: 'A/3',
        description: 'Lightning arrester, station class',
        unitCode: 'Nos',
        quantity: '1',
        rate: '50.00',
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'DUPLICATE_ENTRY' });
  });

  it('omits an item: the effective ceiling drops to zero', async () => {
    const detail = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}`,
      organisationId,
    });
    const added = (detail.json<WorkDetailResponse>().schedules[0]?.items ?? []).find(
      (item) => item.itemNumber === 'A/3',
    );
    expect(added).toBeDefined();
    const addedId = added?.id ?? '';

    // Owner direct-applies the omission (nothing delivered: floor holds).
    const omitted = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: addedId,
        reason: 'Arrester omitted by variation 13.',
        changes: { quantity: '0' },
      },
    });
    expect(omitted.statusCode, omitted.body).toBe(201);
    expect(omitted.json<ApprovalRequest>().status).toBe('approved');

    const balance = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/balance`,
      organisationId,
    });
    const balanceAdded = balance
      .json<WorkBalanceResponse>()
      .items.find((item) => item.workItemId === addedId);
    expect(balanceAdded?.effectiveQuantity).toBe('0.000');
    expect(balanceAdded?.remainingQuantity).toBe('0.000');

    // Issue against the LOWERED (zero) ceiling fails.
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: draftBody('W1', [{ workItemId: addedId, quantity: '0.5' }]),
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = draft.json<ChallanDetailResponse>().challan.id;
    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draftId}/issue`,
      organisationId,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'QUANTITY_EXCEEDED' });
    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/challans/${draftId}`,
      organisationId,
    });
    expect(removed.statusCode).toBe(204);
  });

  it('lets only the requester withdraw a pending request', async () => {
    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: itemBId,
        reason: 'Tentative unit change.',
        changes: { unit: 'Pair' },
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const requestId = proposed.json<ApprovalRequest>().id;

    const notRequester = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${requestId}/withdraw`,
      organisationId,
    });
    expect(notRequester.statusCode).toBe(403);
    expect(notRequester.json()).toMatchObject({ code: 'NOT_REQUESTER' });

    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${requestId}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json<ApprovalRequest>().status).toBe('withdrawn');

    const again = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${requestId}/withdraw`,
      organisationId,
    });
    expect(again.statusCode).toBe(409);
  });

  it('freezes decided requests and the awarded baseline at the database', async () => {
    await expect(
      admin`
        update approval_requests set reason = 'tampered'
        where id = ${changeRequestId}
      `,
    ).rejects.toThrow(/immutable/);
    await expect(
      admin`
        update work_items set awarded_quantity = 999 where id = ${itemAId}
      `,
    ).rejects.toThrow(/immutable/);
  });

  it('turns the excess-delivery escape hatch on and off, owner-only and audited', async () => {
    const denied = await authed(clerk, {
      method: 'PATCH',
      url: `/api/works/${workId}`,
      organisationId,
      payload: { allowExcessDelivery: true },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'OWNER_REQUIRED' });

    const enabled = await authed(owner, {
      method: 'PATCH',
      url: `/api/works/${workId}`,
      organisationId,
      payload: { allowExcessDelivery: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toEqual({ id: workId, allowExcessDelivery: true });

    const detail = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}`,
      organisationId,
    });
    expect(detail.json<WorkDetailResponse>().work.allowExcessDelivery).toBe(true);

    // A/1: delivered 8 of ceiling 8 — excess now goes through.
    const { issued } = await issueChallan(owner, workId, 'W1', [
      { workItemId: itemAId, quantity: '5' },
    ]);
    expect(issued.statusCode, issued.body).toBe(201);

    const events = await admin<{ details: unknown }[]>`
      select details from audit_events
      where organisation_id = ${organisationId}
        and action = 'work.excess_delivery_set' and entity_id = ${workId}
    `;
    expect(events).toHaveLength(1);

    const disabled = await authed(owner, {
      method: 'PATCH',
      url: `/api/works/${workId}`,
      organisationId,
      payload: { allowExcessDelivery: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ id: workId, allowExcessDelivery: false });
  });

  it('serves the approvals queue and the per-Work amendment history', async () => {
    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: itemAId,
        reason: 'Queue visibility fixture.',
        changes: { description: 'Main switchboard, outdoor type' },
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const requestId = proposed.json<ApprovalRequest>().id;

    const queue = await authed(viewer, {
      method: 'GET',
      url: '/api/approvals?status=pending',
      organisationId,
    });
    expect(queue.statusCode).toBe(200);
    const pending = queue.json<ApprovalListResponse>().approvals;
    expect(pending.map((approval) => approval.id)).toContain(requestId);
    expect(pending.every((approval) => approval.status === 'pending')).toBe(true);

    const history = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/amendments`,
      organisationId,
    });
    expect(history.statusCode).toBe(200);
    const statuses = history
      .json<ApprovalListResponse>()
      .approvals.map((approval) => approval.status);
    expect(statuses).toContain('approved');
    expect(statuses).toContain('rejected');
    expect(statuses).toContain('withdrawn');
    expect(statuses).toContain('pending');
  });

  it('denies every amendment surface across the tenant boundary', async () => {
    const propose = await authed(outsider, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId: organisationBId,
      payload: {
        workItemId: itemAId,
        reason: 'Cross-tenant probe.',
        changes: { quantity: '1' },
      },
    });
    expect(propose.statusCode).toBe(404);

    const proposeAdd = await authed(outsider, {
      method: 'POST',
      url: `/api/works/${workId}/amendments/items`,
      organisationId: organisationBId,
      payload: {
        reason: 'Cross-tenant probe.',
        scheduleId,
        itemNumber: 'X/1',
        description: 'Should never exist',
        unitCode: 'Nos',
        quantity: '1',
        rate: '1.00',
      },
    });
    expect(proposeAdd.statusCode).toBe(404);

    const history = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${workId}/amendments`,
      organisationId: organisationBId,
    });
    expect(history.statusCode).toBe(404);

    const queue = await authed(outsider, {
      method: 'GET',
      url: '/api/approvals',
      organisationId: organisationBId,
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json<ApprovalListResponse>().approvals).toEqual([]);

    // The outsider holds the approve authority in THEIR organisation, so
    // these 404s prove tenancy, not a missing grant.
    const [anyRequest] = await admin<{ id: string }[]>`
      select id from approval_requests
      where organisation_id = ${organisationId} and status = 'pending'
      limit 1
    `;
    expect(anyRequest).toBeDefined();
    for (const action of ['approve', 'reject', 'withdraw']) {
      const response = await authed(outsider, {
        method: 'POST',
        url: `/api/approvals/${anyRequest?.id ?? ''}/${action}`,
        organisationId: organisationBId,
        payload: action === 'reject' ? { note: 'cross-tenant' } : {},
      });
      expect(response.statusCode, `${action}: ${response.body}`).toBe(404);
    }

    const patch = await authed(outsider, {
      method: 'PATCH',
      url: `/api/works/${workId}`,
      organisationId: organisationBId,
      payload: { allowExcessDelivery: true },
    });
    expect(patch.statusCode).toBe(404);
  });

  it('records the full audit trail', async () => {
    const events = await admin<{ action: string }[]>`
      select distinct action from audit_events
      where organisation_id = ${organisationId}
        and entity_type = 'approval_requests'
    `;
    const actions = events.map((event) => event.action).sort();
    expect(actions).toEqual([
      'amendment.approved',
      'amendment.proposed',
      'amendment.rejected',
      'amendment.withdrawn',
    ]);
  });
});

describe('the amendment floor includes installed quantities (R7)', () => {
  let itemDId: string;

  it('refuses to lower a quantity below the recorded installations of a non-serial item', async () => {
    // A fresh non-serial item with NOTHING delivered: the delivered floor
    // is 0, so only the installed floor can protect it.
    itemDId = randomUUID();
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${itemDId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/9',
        'Trenching metres', 'Mtr', 10.000, 50.00
      )
    `;
    const installed = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/installations`,
      organisationId,
      payload: {
        workItemId: itemDId,
        quantity: '8.000',
        installedOn: '2026-08-01',
        newLocation: { name: 'Amendment floor yard', kind: 'other' },
      },
    });
    expect(installed.statusCode, installed.body).toBe(201);

    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: itemDId,
        reason: 'Attempt to lower below installed.',
        changes: { quantity: '5' },
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const requestId = proposed.json<ApprovalRequest>().id;

    const approve = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${requestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toMatchObject({ code: 'AMENDMENT_FLOOR_VIOLATION' });
    // The refusal names BOTH sums: delivered 0, installed 8.
    const message = approve.json<{ message: string }>().message;
    expect(message).toContain('already-installed 8.000');
    expect(message).toContain('already-delivered 0');

    // The failed apply rolled back atomically: still pending, unchanged.
    const queue = await authed(viewer, {
      method: 'GET',
      url: '/api/approvals?status=pending',
      organisationId,
    });
    expect(
      queue.json<ApprovalListResponse>().approvals.map((approval) => approval.id),
    ).toContain(requestId);
    const [item] = await admin<{ effective_quantity: string | null }[]>`
      select effective_quantity::text as effective_quantity
      from work_items where id = ${itemDId}
    `;
    expect(item?.effective_quantity).toBeNull();

    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${requestId}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode).toBe(200);
  });

  it('lowers to exactly the installed quantity', async () => {
    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: itemDId,
        reason: 'Reduce to the installed total.',
        changes: { quantity: '8' },
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const requestId = proposed.json<ApprovalRequest>().id;

    const approve = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${requestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(approve.statusCode, approve.body).toBe(200);
    const [item] = await admin<{ effective_quantity: string | null }[]>`
      select effective_quantity::text as effective_quantity
      from work_items where id = ${itemDId}
    `;
    expect(item?.effective_quantity).toBe('8.000');
  });
});
