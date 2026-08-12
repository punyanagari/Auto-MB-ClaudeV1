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
          'pac_certificate_items',
          'pac_certificates',
          'installations',
          'work_consignees',
          'contacts',
          'location_masters',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'approval_requests',
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

  it('refuses a non-positive quantity on a new item with a named 400', async () => {
    // Same predicate as the challan writers (isPositiveDecimal): an added
    // item with nothing to execute is not an amendment, and
    // work_items.awarded_quantity carries the column CHECK that would
    // otherwise answer as an unnamed 500.
    for (const quantity of ['0', '0.000', '-4', '-0']) {
      const proposed = await authed(clerk, {
        method: 'POST',
        url: `/api/works/${workId}/amendments/items`,
        organisationId,
        payload: {
          reason: 'Quantity guard fixture.',
          scheduleId,
          itemNumber: 'A/9',
          description: 'Lightning arrester, station class',
          unitCode: 'Nos',
          quantity,
          rate: '50.00',
        },
      });
      expect(proposed.statusCode, `${quantity}: ${proposed.body}`).toBe(400);
      expect(proposed.json()).toMatchObject({ code: 'AMENDMENT_INVALID' });
    }
    // The refusal is the quantity alone: the identical proposal with a
    // positive quantity is accepted, and the item number stays free until
    // then.
    const accepted = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments/items`,
      organisationId,
      payload: {
        reason: 'Quantity guard fixture.',
        scheduleId,
        itemNumber: 'A/9',
        description: 'Lightning arrester, station class',
        unitCode: 'Nos',
        quantity: '0.001',
        rate: '50.00',
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${accepted.json<ApprovalRequest>().id}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
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

    const proposeRemoval = await authed(outsider, {
      method: 'POST',
      url: `/api/works/${workId}/amendments/removals`,
      organisationId: organisationBId,
      payload: { workItemId: itemAId, reason: 'Cross-tenant omission probe.' },
    });
    expect(proposeRemoval.statusCode).toBe(404);

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

// ---------------------------------------------------------------------------
// Milestone 6/7 retrofit — R7 completed.
//
// Already pinned above: the delivered floor, the installed floor,
// live-state revalidation at apply, the one-pending-per-item 409,
// requester-only withdrawal, rejection's mandatory note, direct apply by
// an approvals holder, and the decided-request/awarded-baseline freezes.
// Everything below is what was NOT pinned: the PAC certified floor, item
// omission end to end, the atomic decision claim under a real race, and
// the audit-shape equivalence of the one-party and two-party flows.
// ---------------------------------------------------------------------------

describe('the amendment floor includes certified quantities (R7 + R18)', () => {
  let consigneeId: string;

  beforeAll(async () => {
    const consignee = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: { designation: 'Sr. DEE (G) NR', address: 'Delhi Division' },
    });
    expect(consignee.statusCode, consignee.body).toBe(201);
    consigneeId = consignee.json<{ id: string }>().id;
  });

  it('names delivered, installed AND certified when a reduction is refused', async () => {
    const itemEId = randomUUID();
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${itemEId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/10',
        'Point machines', 'Nos', 10.000, 500.00
      )
    `;
    const installed = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/installations`,
      organisationId,
      payload: {
        workItemId: itemEId,
        quantity: '6.000',
        installedOn: '2026-08-01',
        newLocation: { name: 'Certified floor yard', kind: 'other' },
      },
    });
    expect(installed.statusCode, installed.body).toBe(201);

    // R18 caps certification at the installed total, so certified can
    // never exceed installed through the product. The floor still names
    // it: a reduction has to clear all three aggregates, and the operator
    // is told all three at once rather than discovering them one by one.
    const certificate = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/pac-certificates`,
      organisationId,
      payload: {
        reference: `PAC-FLOOR-${runId}`,
        issueDate: '2026-08-02',
        consigneeMasterId: consigneeId,
        items: [{ workItemId: itemEId, certifiedQuantity: '4.000' }],
      },
    });
    expect(certificate.statusCode, certificate.body).toBe(201);

    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: itemEId,
        reason: 'Attempt to lower below the certified total.',
        changes: { quantity: '3' },
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
    const message = approve.json<{ message: string }>().message;
    expect(message).toContain('already-delivered 0');
    expect(message).toContain('already-installed 6.000');
    expect(message).toContain('already-certified 4.000');

    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${requestId}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
  });

  it('holds the certified floor on its own at the database (migration 0030)', async () => {
    // The product cannot produce certified > installed (R18 forbids it),
    // so the certified TERM of the floor is proved directly: an item with
    // no installation at all, certified 7 by a certificate written
    // straight to the table, cannot have its ceiling pushed below 7 by
    // ANY writer — route, importer, or psql.
    const itemFId = randomUUID();
    const certificateId = randomUUID();
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${itemFId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/11',
        'Relay racks', 'Nos', 10.000, 900.00
      )
    `;
    await admin`
      insert into pac_certificates (
        id, organisation_id, work_id, reference, issue_date,
        consignee_master_id, consignee_designation, recorded_by_user_id
      )
      values (
        ${certificateId}, ${organisationId}, ${workId},
        ${`PAC-DIRECT-${runId}`}, '2026-08-02', ${consigneeId},
        'Sr. DEE (G) NR', ${ownerUserId}
      )
    `;
    await admin`
      insert into pac_certificate_items (
        organisation_id, pac_certificate_id, work_id, work_item_id,
        certified_quantity
      )
      values (
        ${organisationId}, ${certificateId}, ${workId}, ${itemFId}, 7.000
      )
    `;

    await expect(
      admin`update work_items set effective_quantity = 5.000 where id = ${itemFId}`,
    ).rejects.toThrow(/already-certified 7\.000/);

    // Exactly the certified quantity is legal, and so is raising it.
    await admin`update work_items set effective_quantity = 7.000 where id = ${itemFId}`;
    await admin`update work_items set effective_quantity = 12.000 where id = ${itemFId}`;
    const [row] = await admin<{ effective_quantity: string }[]>`
      select effective_quantity::text as effective_quantity
      from work_items where id = ${itemFId}
    `;
    expect(row?.effective_quantity).toBe('12.000');
  });
});

describe('R7 item omission: soft-delete, evidence-gated, number reserved', () => {
  let spareItemId: string;
  let evidencedItemId: string;

  beforeAll(async () => {
    spareItemId = randomUUID();
    evidencedItemId = randomUUID();
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values
        (${spareItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/20',
         'Spare fuse carriers', 'Nos', 4.000, 25.00),
        (${evidencedItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/21',
         'Cable trays', 'Mtr', 30.000, 12.00)
    `;
  });

  it('refuses an omission proposal from a read-only member', async () => {
    const response = await authed(viewer, {
      method: 'POST',
      url: `/api/works/${workId}/amendments/removals`,
      organisationId,
      payload: { workItemId: spareItemId, reason: 'Viewer omission probe.' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('omits an evidence-free item through the approval engine, with before/after', async () => {
    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments/removals`,
      organisationId,
      payload: {
        workItemId: spareItemId,
        reason: 'Variation 12 drops the spare fuse carriers.',
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const request = proposed.json<ApprovalRequest>();
    expect(request.status).toBe('pending');
    expect(request.entityId).toBe(spareItemId);
    expect(request.itemNumber).toBe('A/20');
    expect(request.diff).toEqual([
      { field: 'item', before: 'A/20', after: null },
      { field: 'description', before: 'Spare fuse carriers', after: null },
      { field: 'quantity', before: '4.000', after: null },
    ]);

    // A second request on the same item collides with the pending one,
    // and the 409 names it in the uniform conflict shape.
    const second = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: spareItemId,
        reason: 'Competing change on an item pending omission.',
        changes: { quantity: '3' },
      },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      code: 'PENDING_EXISTS',
      details: { existingRecordId: request.id },
    });

    const approved = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${request.id}/approve`,
      organisationId,
      payload: { note: 'Sanctioned by variation 12.' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<ApprovalRequest>().status).toBe('approved');
    expect(approved.json<ApprovalRequest>().decidedByUserId).toBe(ownerUserId);

    // Soft-delete, never erasure: the row survives with deleted_at set.
    const [row] = await admin<{ deleted_at: Date | null; item_number: string }[]>`
      select deleted_at, item_number from work_items where id = ${spareItemId}
    `;
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.item_number).toBe('A/20');

    // …and it leaves every live surface.
    const detail = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}`,
      organisationId,
    });
    const items = detail.json<WorkDetailResponse>().schedules[0]?.items ?? [];
    expect(items.map((item) => item.itemNumber)).not.toContain('A/20');

    const balance = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/balance`,
      organisationId,
    });
    expect(
      balance.json<WorkBalanceResponse>().items.map((item) => item.itemNumber),
    ).not.toContain('A/20');

    // A challan may no longer be drafted against it.
    const drafted = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: draftBody('OMIT', [{ workItemId: spareItemId, quantity: '1' }]),
    });
    expect(drafted.statusCode).toBe(404);
  });

  it('keeps the retired item number reserved forever', async () => {
    const reused = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments/items`,
      organisationId,
      payload: {
        reason: 'Try to reuse the retired number.',
        scheduleId,
        itemNumber: 'A/20',
        description: 'Different item, same number',
        unitCode: 'Nos',
        quantity: '1',
        rate: '10.00',
      },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: 'DUPLICATE_ENTRY' });
    expect(reused.json<{ message: string }>().message).toContain('stays reserved');

    // The uniqueness constraint itself counts soft-deleted rows — the
    // reservation does not depend on the route noticing.
    await expect(
      admin`
        insert into work_items (
          organisation_id, work_id, schedule_id, item_number, description,
          unit_code, awarded_quantity, effective_rate
        )
        values (
          ${organisationId}, ${workId}, ${scheduleId}, 'A/20', 'Collision',
          'Nos', 1.000, 1.00
        )
      `,
    ).rejects.toThrow(/duplicate key|unique/i);

    // Erasure is impossible for the application role: the privilege
    // matrix grants it no DELETE on work_items at all, so no handler —
    // present or future — can turn an omission into a deletion.
    const grants = await admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where grantee = 'auto_mb_app' and table_name = 'work_items'
    `;
    expect(grants.map((grant) => grant.privilege_type).sort()).toEqual([
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });

  it('refuses to omit an item that carries evidence, naming the evidence', async () => {
    const installed = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/installations`,
      organisationId,
      payload: {
        workItemId: evidencedItemId,
        quantity: '5.000',
        installedOn: '2026-08-01',
        newLocation: { name: 'Omission evidence yard', kind: 'other' },
      },
    });
    expect(installed.statusCode, installed.body).toBe(201);

    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments/removals`,
      organisationId,
      payload: { workItemId: evidencedItemId, reason: 'Drop the cable trays.' },
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
    expect(approve.json()).toMatchObject({ code: 'AMENDMENT_ITEM_HAS_EVIDENCE' });
    expect(approve.json<{ message: string }>().message).toContain(
      'installations (5.000)',
    );

    // The claim was released: still pending, still undecided, item live.
    const [row] = await admin<{ status: string; decided_by_user_id: string | null }[]>`
      select status, decided_by_user_id from approval_requests
      where id = ${requestId}
    `;
    expect(row?.status).toBe('pending');
    expect(row?.decided_by_user_id).toBeNull();
    const [item] = await admin<{ deleted_at: Date | null }[]>`
      select deleted_at from work_items where id = ${evidencedItemId}
    `;
    expect(item?.deleted_at).toBeNull();

    // The same refusal holds against direct SQL (migration 0030).
    await expect(
      admin`update work_items set deleted_at = now() where id = ${evidencedItemId}`,
    ).rejects.toThrow(/carries evidence and cannot be omitted/);

    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${requestId}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
  });

  it('pins the complete evidence chain of one amendment lifecycle', async () => {
    const chainItemId = randomUUID();
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${chainItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/22',
        'Evidence chain item', 'Nos', 6.000, 40.00
      )
    `;
    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: chainItemId,
        reason: 'Sanctioned uplift under variation 14.',
        changes: { quantity: '9', rate: '44.000000' },
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const request = proposed.json<ApprovalRequest>();

    // Who proposed it, why, and exactly what changes — before deciding.
    expect(request.requestedByUserId).toBe(clerkUserId);
    expect(request.reason).toBe('Sanctioned uplift under variation 14.');
    expect(request.decidedByUserId).toBeNull();
    expect(request.diff).toEqual([
      { field: 'quantity', before: '6.000', after: '9.000' },
      { field: 'rate', before: '40.00', after: '44.00' },
    ]);

    const approved = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${request.id}/approve`,
      organisationId,
      payload: { note: 'Variation 14 letter on file.' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const decided = approved.json<ApprovalRequest>();

    // Who applied it, when, with what note — and the proposal snapshot
    // and diff are exactly what was filed.
    expect(decided.decidedByUserId).toBe(ownerUserId);
    expect(decided.decidedAt).not.toBeNull();
    expect(decided.decisionNote).toBe('Variation 14 letter on file.');
    expect(decided.proposed).toEqual(request.proposed);
    expect(decided.diff).toEqual(request.diff);
    expect(decided.reason).toBe(request.reason);
    expect(decided.requestedByUserId).toBe(clerkUserId);

    // The original LOA baseline is untouched; only the overlay moved.
    const [row] = await admin<
      {
        awarded_quantity: string;
        effective_rate: string;
        effective_quantity: string;
        effective_unit_rate: string;
      }[]
    >`
      select awarded_quantity::text as awarded_quantity,
             effective_rate::text as effective_rate,
             effective_quantity::text as effective_quantity,
             effective_unit_rate::text as effective_unit_rate
      from work_items where id = ${chainItemId}
    `;
    expect(row?.awarded_quantity).toBe('6.000');
    expect(row?.effective_rate).toBe('40.000000');
    expect(row?.effective_quantity).toBe('9.000');
    expect(row?.effective_unit_rate).toBe('44.000000');

    // Both audit events carry the actor and the structured diff.
    const events = await admin<
      { action: string; actor_user_id: string; details: unknown }[]
    >`
      select action, actor_user_id, details from audit_events
      where organisation_id = ${organisationId} and entity_id = ${request.id}
      order by action
    `;
    expect(events.map((event) => event.action)).toEqual([
      'amendment.approved',
      'amendment.proposed',
    ]);
    expect(events[0]?.actor_user_id).toBe(ownerUserId);
    expect(events[1]?.actor_user_id).toBe(clerkUserId);
    for (const event of events) {
      const details = event.details as { diff?: unknown };
      expect(details.diff).toEqual(request.diff);
    }
  });
});

describe('approval concurrency (§5.6): the claim is atomic', () => {
  let raceItemId: string;

  beforeAll(async () => {
    raceItemId = randomUUID();
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${raceItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/30',
        'Decision race item', 'Nos', 6.000, 20.00
      )
    `;
    // A second approvals holder, so a genuine two-decider race exists.
    await admin`
      update organisation_memberships set can_approve_amendments = true
      where organisation_id = ${organisationId} and user_id = ${clerkUserId}
    `;
  });

  afterAll(async () => {
    await admin`
      update organisation_memberships set can_approve_amendments = false
      where organisation_id = ${organisationId} and user_id = ${clerkUserId}
    `;
  });

  it('lets exactly one of two SIMULTANEOUS decisions win', async () => {
    // Both HTTP actors now hold the approval authority, so a proposal
    // filed through either would direct-apply and there would be nothing
    // to race. The pending request is therefore filed straight into the
    // table — the race under test is the DECISION, not the filing.
    const [request] = await admin<{ id: string }[]>`
      insert into approval_requests (
        organisation_id, entity_type, entity_id, work_id, proposed, diff,
        reason, requested_by_user_id
      )
      values (
        ${organisationId}, 'work_item_amendment', ${raceItemId}, ${workId},
        ${JSON.stringify({
          kind: 'change_item',
          workItemId: raceItemId,
          itemNumber: 'A/30',
          changes: { quantity: '9.000' },
        })}::jsonb,
        ${JSON.stringify([
          { field: 'quantity', before: '6.000', after: '9.000' },
        ])}::jsonb,
        'Race the deciders.', ${clerkUserId}
      )
      returning id
    `;
    expect(request).toBeDefined();
    const requestId = request?.id ?? '';

    const decide = (jar: CookieJar) =>
      authed(jar, {
        method: 'POST',
        url: `/api/approvals/${requestId}/approve`,
        organisationId,
        payload: {},
      });
    const [first, second] = await Promise.all([decide(owner), decide(clerk)]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses, `${first.body} | ${second.body}`).toEqual([200, 409]);
    const loser = [first, second].find((response) => response.statusCode === 409);
    expect(loser?.json()).toMatchObject({ code: 'APPROVAL_NOT_PENDING' });

    // Applied exactly once: one decider, one ceiling move, one audit row.
    const [row] = await admin<{ status: string; decided_by_user_id: string | null }[]>`
      select status, decided_by_user_id from approval_requests
      where id = ${requestId}
    `;
    expect(row?.status).toBe('approved');
    expect(row?.decided_by_user_id).not.toBeNull();
    const [item] = await admin<{ effective_quantity: string | null }[]>`
      select effective_quantity::text as effective_quantity
      from work_items where id = ${raceItemId}
    `;
    expect(item?.effective_quantity).toBe('9.000');
    const approvals = await admin<{ count: string }[]>`
      select count(*)::text as count from audit_events
      where organisation_id = ${organisationId} and entity_id = ${requestId}
        and action = 'amendment.approved'
    `;
    expect(approvals[0]?.count).toBe('1');
  });

  it('lets an approve and a reject race to exactly one outcome', async () => {
    const [request] = await admin<{ id: string }[]>`
      insert into approval_requests (
        organisation_id, entity_type, entity_id, work_id, proposed, diff,
        reason, requested_by_user_id
      )
      values (
        ${organisationId}, 'work_item_amendment', ${raceItemId}, ${workId},
        ${JSON.stringify({
          kind: 'change_item',
          workItemId: raceItemId,
          itemNumber: 'A/30',
          changes: { quantity: '11.000' },
        })}::jsonb,
        ${JSON.stringify([
          { field: 'quantity', before: '9.000', after: '11.000' },
        ])}::jsonb,
        'Race an approve against a reject.', ${clerkUserId}
      )
      returning id
    `;
    const requestId = request?.id ?? '';

    const [approve, reject] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/approvals/${requestId}/approve`,
        organisationId,
        payload: {},
      }),
      authed(clerk, {
        method: 'POST',
        url: `/api/approvals/${requestId}/reject`,
        organisationId,
        payload: { note: 'Not sanctioned after all.' },
      }),
    ]);
    const successes = [approve.statusCode === 200, reject.statusCode === 200].filter(
      Boolean,
    );
    expect(
      successes,
      `approve=${String(approve.statusCode)} reject=${String(reject.statusCode)}`,
    ).toHaveLength(1);

    const [row] = await admin<{ status: string }[]>`
      select status from approval_requests where id = ${requestId}
    `;
    expect(['approved', 'rejected']).toContain(row?.status);
    // Whichever decision won, the ceiling agrees with the record.
    const [item] = await admin<{ effective_quantity: string | null }[]>`
      select effective_quantity::text as effective_quantity
      from work_items where id = ${raceItemId}
    `;
    expect(item?.effective_quantity).toBe(
      row?.status === 'approved' ? '11.000' : '9.000',
    );
  });

  it('records the same audit structure for a direct apply as for two parties', async () => {
    await admin`
      update organisation_memberships set can_approve_amendments = false
      where organisation_id = ${organisationId} and user_id = ${clerkUserId}
    `;
    const twoPartyItemId = randomUUID();
    const onePartyItemId = randomUUID();
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values
        (${twoPartyItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/31',
         'Two-party audit item', 'Nos', 3.000, 15.00),
        (${onePartyItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/32',
         'One-party audit item', 'Nos', 3.000, 15.00)
    `;
    const filed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: twoPartyItemId,
        reason: 'Two-party audit-shape probe.',
        changes: { quantity: '5' },
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const twoPartyId = filed.json<ApprovalRequest>().id;
    const decided = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${twoPartyId}/approve`,
      organisationId,
      payload: {},
    });
    expect(decided.statusCode, decided.body).toBe(200);

    // One-party: the owner holds the authority, so the same proposal
    // applies immediately with the self-approval auto-recorded.
    const direct = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: onePartyItemId,
        reason: 'One-party audit-shape probe.',
        changes: { quantity: '5' },
      },
    });
    expect(direct.statusCode, direct.body).toBe(201);
    const onePartyId = direct.json<ApprovalRequest>().id;
    expect(direct.json<ApprovalRequest>().status).toBe('approved');

    const shapeOf = async (approvalId: string) => {
      const rows = await admin<
        { action: string; entity_type: string; details: unknown }[]
      >`
        select action, entity_type, details from audit_events
        where organisation_id = ${organisationId} and entity_id = ${approvalId}
        order by action
      `;
      return rows.map((row) => ({
        action: row.action,
        entityType: row.entity_type,
        detailKeys: Object.keys(row.details as Record<string, unknown>).sort(),
      }));
    };
    const twoPartyShape = await shapeOf(twoPartyId);
    expect(twoPartyShape).toEqual([
      {
        action: 'amendment.approved',
        entityType: 'approval_requests',
        detailKeys: ['diff', 'entityId', 'kind', 'workId'],
      },
      {
        action: 'amendment.proposed',
        entityType: 'approval_requests',
        detailKeys: ['diff', 'itemNumber', 'reason', 'workId', 'workItemId'],
      },
    ]);
    expect(await shapeOf(onePartyId)).toEqual(twoPartyShape);

    // …and the decision columns are populated identically, differing only
    // in WHO decided (the requester themself in the direct-apply case).
    const decisionOf = async (approvalId: string) => {
      const [row] = await admin<
        {
          status: string;
          requested_by_user_id: string;
          decided_by_user_id: string | null;
        }[]
      >`
        select status, requested_by_user_id, decided_by_user_id
        from approval_requests where id = ${approvalId}
      `;
      return row;
    };
    const two = await decisionOf(twoPartyId);
    const one = await decisionOf(onePartyId);
    expect(two?.status).toBe('approved');
    expect(one?.status).toBe('approved');
    expect(two?.requested_by_user_id).toBe(clerkUserId);
    expect(two?.decided_by_user_id).toBe(ownerUserId);
    expect(one?.requested_by_user_id).toBe(ownerUserId);
    expect(one?.decided_by_user_id).toBe(ownerUserId);
  });

  it('refuses a rejection without a note at the database as well', async () => {
    const [request] = await admin<{ id: string }[]>`
      insert into approval_requests (
        organisation_id, entity_type, entity_id, work_id, proposed, diff,
        reason, requested_by_user_id
      )
      values (
        ${organisationId}, 'work_item_amendment', null, ${workId},
        ${JSON.stringify({
          kind: 'add_item',
          scheduleId,
          itemNumber: 'A/99',
          description: 'Note-less rejection probe',
          unitCode: 'Nos',
          quantity: '1.000',
          rate: '1.00',
        })}::jsonb,
        ${JSON.stringify([{ field: 'item', before: null, after: 'A/99' }])}::jsonb,
        'Rejection note probe.', ${clerkUserId}
      )
      returning id
    `;
    await expect(
      admin`
        update approval_requests
        set status = 'rejected', decided_by_user_id = ${ownerUserId},
            decided_at = now()
        where id = ${request?.id ?? ''}
      `,
    ).rejects.toThrow();
  });
});
