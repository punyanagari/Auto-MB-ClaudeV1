import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ApprovalRequest,
  ChallanDetailResponse,
  CorrectionEligibilityResponse,
  CorrectionNoticeDetailResponse,
  CorrectionNoticeListResponse,
  IssueChallanDetailResponse,
  TimelineResponse,
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
const ownerEmail = `cor-owner-${runId}@integration.test`;
const clerkEmail = `cor-clerk-${runId}@integration.test`;
const viewerEmail = `cor-viewer-${runId}@integration.test`;
const outsiderEmail = `cor-outsider-${runId}@integration.test`;
const approverEmail = `cor-approver-${runId}@integration.test`;
const assignedEmail = `cor-assigned-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let fakeGotenberg: http.Server;
let storageDir: string;
let organisationId: string;
let organisationBId: string;
let ownerUserId: string;
let work1Id: string;
let work2Id: string;
let work3Id: string;
let work1Code: string;
let work2Code: string;
let work3Code: string;
let item1AId: string;
let item2AId: string;
let item3AId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let clerk: CookieJar;
let viewer: CookieJar;
let outsider: CookieJar;
let approverOnly: CookieJar;
let assigned: CookieJar;

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

function consignee(name = 'Sr. DEE (G) NR') {
  return { name, address: 'Delhi Division, New Delhi' };
}

/** Drafts and issues a Delivery Challan in one step. */
async function issueChallan(
  targetWorkId: string,
  prefix: string,
  items: { workItemId: string; quantity: string }[],
): Promise<{ challanId: string; challanNumber: string }> {
  const created = await authed(clerk, {
    method: 'POST',
    url: `/api/works/${targetWorkId}/challans`,
    organisationId,
    payload: {
      challanDate: '2026-08-08',
      prefix,
      consignee: consignee(),
      items,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const challanId = created.json<ChallanDetailResponse>().challan.id;
  const issued = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${challanId}/issue`,
    organisationId,
  });
  expect(issued.statusCode, issued.body).toBe(201);
  const challanNumber = issued.json<ChallanDetailResponse>().challan.challanNumber;
  if (challanNumber === null) throw new Error('issued challan without number');
  return { challanId, challanNumber };
}

async function recordReceipt(challanId: string): Promise<void> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${challanId}/receipt`,
    organisationId,
    payload: { receivedOn: '2026-08-08', receivedBy: 'SSE/Signal/Delhi' },
  });
  expect(response.statusCode, response.body).toBe(201);
}

async function eligibility(
  jar: CookieJar,
  challanId: string,
): Promise<{ statusCode: number; body: CorrectionEligibilityResponse }> {
  const response = await authed(jar, {
    method: 'GET',
    url: `/api/challans/${challanId}/correction-eligibility`,
    organisationId,
  });
  return {
    statusCode: response.statusCode,
    body: response.json<CorrectionEligibilityResponse>(),
  };
}

async function auditActions(entityType: string, entityId: string): Promise<string[]> {
  const rows = await admin<{ action: string }[]>`
    select action from audit_events
    where organisation_id = ${organisationId}
      and entity_type = ${entityType} and entity_id = ${entityId}
    order by occurred_at, id
  `;
  return rows.map((row) => row.action);
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-corrections-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the corrections integration tests. ' +
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

  // Stub PDF service (fakeGotenberg pattern): the render path runs its full
  // HTTP round-trip without a real Gotenberg container.
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-cor-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    gotenbergUrl: `http://127.0.0.1:${String(gotenbergAddress.port)}`,
  });

  owner = await signUp(ownerEmail, 'Correction Owner');
  clerk = await signUp(clerkEmail, 'Correction Clerk');
  viewer = await signUp(viewerEmail, 'Correction Viewer');
  outsider = await signUp(outsiderEmail, 'Outside Owner');
  approverOnly = await signUp(approverEmail, 'Approver Without Authorities');
  assigned = await signUp(assignedEmail, 'Assigned Scope Member');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Correction Constructions', slug: `cor-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const createdB = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Other Constructions', slug: `cor-org-b-${runId}` },
  });
  expect(createdB.statusCode, createdB.body).toBe(201);
  organisationBId = createdB.json<{ id: string }>().id;

  for (const [email, role] of [
    [clerkEmail, 'office'],
    [viewerEmail, 'viewer'],
    [approverEmail, 'office'],
    [assignedEmail, 'office'],
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

  // The owner holds every explicit authority; the clerk is a plain writer.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true,
        can_approve_amendments = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
  // The approver-only member decides amendments but holds NEITHER document
  // authority: correction applies must refuse them at apply time.
  const [approverUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${approverEmail}
  `;
  if (!approverUser) throw new Error('approver user missing');
  await admin`
    update organisation_memberships
    set can_approve_amendments = true
    where organisation_id = ${organisationId} and user_id = ${approverUser.id}
  `;
  // The outsider holds every authority in their OWN organisation, so the
  // cross-tenant denials prove tenancy, not missing authority.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true,
        can_approve_amendments = true
    where organisation_id = ${organisationBId}
  `;

  work1Id = randomUUID();
  work2Id = randomUUID();
  work3Id = randomUUID();
  work1Code = `COR1-${runId.toUpperCase()}`;
  work2Code = `COR2-${runId.toUpperCase()}`;
  work3Code = `COR3-${runId.toUpperCase()}`;
  const schedule1Id = randomUUID();
  const schedule2Id = randomUUID();
  const schedule3Id = randomUUID();
  item1AId = randomUUID();
  item2AId = randomUUID();
  item3AId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values
      (${work1Id}, ${organisationId}, ${work1Code}, ${`cor-letter-1-${runId}`},
       '2025-06-01', 'Correction fixture work 1', 1000.00, 900.00,
       'per_schedule', ${ownerUserId}),
      (${work2Id}, ${organisationId}, ${work2Code}, ${`cor-letter-2-${runId}`},
       '2025-06-01', 'Correction fixture work 2', 1000.00, 900.00,
       'per_schedule', ${ownerUserId}),
      (${work3Id}, ${organisationId}, ${work3Code}, ${`cor-letter-3-${runId}`},
       '2025-06-01', 'Correction fixture work 3', 1000.00, 900.00,
       'per_schedule', ${ownerUserId})
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values
      (${schedule1Id}, ${organisationId}, ${work1Id}, 'A', 'Schedule A', 1),
      (${schedule2Id}, ${organisationId}, ${work2Id}, 'B', 'Schedule B', 1),
      (${schedule3Id}, ${organisationId}, ${work3Id}, 'C', 'Schedule C', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate
    )
    values
      (${item1AId}, ${organisationId}, ${work1Id}, ${schedule1Id}, 'A/1',
       'Main switchboard', 'Nos', 10.000, 100.00),
      (${item2AId}, ${organisationId}, ${work2Id}, ${schedule2Id}, 'B/1',
       'Cable set', 'Set', 20.000, 250.50),
      (${item3AId}, ${organisationId}, ${work3Id}, ${schedule3Id}, 'C/1',
       'Earthing kit', 'Nos', 30.000, 10.00)
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
          'correction_notice_counters',
          'correction_notices',
          'challan_receipts',
          'challan_item_serials',
          'delivery_challan_items',
          'delivery_challan_counters',
          'issue_challan_lines',
          'issue_challan_counters',
          'issue_challans',
          'delivery_challans',
          'approval_requests',
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
  await new Promise<void>((resolve) => {
    fakeGotenberg.close(() => {
      resolve();
    });
  });
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('Path A — cancel and replace for an issued Delivery Challan', () => {
  let dc1Id: string;
  let dc1Number: string;
  let requestId: string;
  let replacementId: string;

  it('reports cancel-and-replace as the lawful path for an evidence-free issued challan', async () => {
    ({ challanId: dc1Id, challanNumber: dc1Number } = await issueChallan(
      work1Id,
      `${work1Code}-DC`,
      [{ workItemId: item1AId, quantity: '2.000' }],
    ));
    const { statusCode, body } = await eligibility(clerk, dc1Id);
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      challanId: dc1Id,
      status: 'issued',
      evidence: { receipts: 0, serials: 0, measurements: 0 },
      path: 'cancel_replace',
      pendingRequestId: null,
    });
  });

  it('refuses a proposal from a member without the writer role', async () => {
    const denied = await authed(viewer, {
      method: 'POST',
      url: `/api/challans/${dc1Id}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Viewer should not file corrections.',
        replacement: {
          challanDate: '2026-08-08',
          prefix: `${work1Code}-DC`,
          consignee: consignee(),
          items: [{ workItemId: item1AId, quantity: '2.000' }],
        },
      },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('files a pending request carrying the corrected content and its diff', async () => {
    const response = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${dc1Id}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Wrong consignee and quantity on the issued copy.',
        replacement: {
          challanDate: '2026-08-08',
          prefix: `${work1Code}-DC`,
          consignee: consignee('Sr. DEE (W) NR'),
          items: [{ workItemId: item1AId, quantity: '3' }],
        },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const approval = response.json<ApprovalRequest>();
    requestId = approval.id;
    expect(approval.status).toBe('pending');
    expect(approval.entityType).toBe('challan_cancel_replace');
    expect(approval.entityId).toBe(dc1Id);
    expect(approval.documentNumber).toBe(dc1Number);
    expect(approval.itemNumber).toBeNull();
    // The diff shows the consignee change and the normalised quantities.
    expect(approval.diff).toEqual(
      expect.arrayContaining([
        {
          field: 'consignee',
          before: 'Sr. DEE (G) NR, Delhi Division, New Delhi',
          after: 'Sr. DEE (W) NR, Delhi Division, New Delhi',
        },
        { field: 'items', before: 'A/1 ×2.000', after: 'A/1 ×3.000' },
      ]),
    );
    const { body } = await eligibility(clerk, dc1Id);
    expect(body.pendingRequestId).toBe(requestId);
  });

  it('enforces one pending correction per challan', async () => {
    const duplicate = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${dc1Id}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Second attempt must conflict.',
        replacement: {
          challanDate: '2026-08-08',
          prefix: `${work1Code}-DC`,
          consignee: consignee('Sr. DEE (X) NR'),
          items: [{ workItemId: item1AId, quantity: '4.000' }],
        },
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ code: string }>().code).toBe('PENDING_EXISTS');
  });

  it('proves at the database that both correction types share the one-pending slot', async () => {
    // The API keeps the paths disjoint by evidence state, so the
    // cross-type collision is proven directly against the 0019 index.
    await expect(
      admin`
        insert into approval_requests (
          organisation_id, entity_type, entity_id, work_id, proposed, diff,
          reason, requested_by_user_id
        )
        values (
          ${organisationId}, 'challan_correction_notice', ${dc1Id}, ${work1Id},
          '{}'::jsonb, '[]'::jsonb, 'cross-type conflict probe', ${ownerUserId}
        )
      `,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('requires the approval authority to decide', async () => {
    const denied = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${requestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');
  });

  it('rejects with a mandatory note and audits it', async () => {
    const rejected = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${requestId}/reject`,
      organisationId,
      payload: { note: 'Consignee change needs the railway letter first.' },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json<ApprovalRequest>().status).toBe('rejected');
    expect(await auditActions('approval_requests', requestId)).toEqual([
      'correction.proposed',
      'correction.rejected',
    ]);
    // The challan is untouched.
    const detail = await authed(clerk, {
      method: 'GET',
      url: `/api/challans/${dc1Id}`,
      organisationId,
    });
    expect(detail.json<ChallanDetailResponse>().challan.status).toBe('issued');
  });

  it('releases the claim back to pending when the one-draft rule blocks the apply', async () => {
    const refiled = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${dc1Id}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Wrong consignee and quantity on the issued copy.',
        replacement: {
          challanDate: '2026-08-08',
          prefix: `${work1Code}-DC`,
          consignee: consignee('Sr. DEE (W) NR'),
          items: [{ workItemId: item1AId, quantity: '3.000' }],
        },
      },
    });
    expect(refiled.statusCode, refiled.body).toBe(201);
    requestId = refiled.json<ApprovalRequest>().id;

    // A competing ordinary draft occupies the one-draft-per-work slot.
    const draft = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${work1Id}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        prefix: `${work1Code}-DC`,
        consignee: consignee(),
        items: [{ workItemId: item1AId, quantity: '1.000' }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = draft.json<ChallanDetailResponse>().challan.id;

    const conflicted = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${requestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(conflicted.statusCode).toBe(409);
    // The apply-time 409 names the occupying draft so the operator can
    // open it directly.
    expect(conflicted.json()).toMatchObject({
      code: 'DRAFT_EXISTS',
      details: { existingRecordId: draftId },
    });

    // The claim was released: the request is still pending, the challan
    // still issued.
    const after = await authed(clerk, {
      method: 'GET',
      url: `/api/approvals?status=pending`,
      organisationId,
    });
    const pending = after.json<{ approvals: ApprovalRequest[] }>().approvals;
    expect(pending.map((row) => row.id)).toContain(requestId);

    const removed = await authed(clerk, {
      method: 'DELETE',
      url: `/api/challans/${draftId}`,
      organisationId,
    });
    expect(removed.statusCode).toBe(204);
  });

  it('applies on approval: cancels the original and drafts the replacement with provenance', async () => {
    const approved = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${requestId}/approve`,
      organisationId,
      payload: { note: 'Corrected per site confirmation.' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<ApprovalRequest>().status).toBe('approved');

    // Original: cancelled, note references the approval, number retained.
    const [original] = await admin<
      { status: string; cancellation_note: string | null; challan_number: string }[]
    >`
      select status, cancellation_note, challan_number
      from delivery_challans where id = ${dc1Id}
    `;
    expect(original?.status).toBe('cancelled');
    expect(original?.challan_number).toBe(dc1Number);
    // The note carries the approval reference AND the requester's human
    // reason (R17): the cancelled document explains itself.
    expect(original?.cancellation_note).toContain(requestId);
    expect(original?.cancellation_note).toContain(
      'Wrong consignee and quantity on the issued copy.',
    );

    // Replacement: a DRAFT carrying provenance and the corrected content.
    const [replacement] = await admin<
      {
        id: string;
        status: string;
        replaces_challan_id: string | null;
        consignee_snapshot: { name?: string };
      }[]
    >`
      select id, status, replaces_challan_id, consignee_snapshot
      from delivery_challans
      where work_id = ${work1Id} and status = 'draft'
    `;
    expect(replacement?.replaces_challan_id).toBe(dc1Id);
    expect(replacement?.consignee_snapshot.name).toBe('Sr. DEE (W) NR');
    if (!replacement) throw new Error('replacement draft missing');
    replacementId = replacement.id;
    const [line] = await admin<{ quantity: string }[]>`
      select quantity::text as quantity from delivery_challan_items
      where delivery_challan_id = ${replacementId}
    `;
    expect(line?.quantity).toBe('3.000');

    expect(await auditActions('delivery_challans', dc1Id)).toContain(
      'challan.cancelled',
    );
    expect(await auditActions('delivery_challans', replacementId)).toContain(
      'challan.replacement_drafted',
    );
    expect(await auditActions('approval_requests', requestId)).toContain(
      'correction.approved',
    );
  });

  it('issues the replacement through the normal path with the next gapless number', async () => {
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${replacementId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const challan = issued.json<ChallanDetailResponse>().challan;
    expect(challan.sequenceNumber).toBe(2);
    expect(challan.challanNumber).toBe(`${work1Code}-DC/2`);
  });

  it('lets only the requester withdraw a pending correction', async () => {
    const filed = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${replacementId}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Filed to prove withdrawal.',
        replacement: {
          challanDate: '2026-08-08',
          prefix: `${work1Code}-DC`,
          consignee: consignee(),
          items: [{ workItemId: item1AId, quantity: '4.000' }],
        },
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const withdrawTarget = filed.json<ApprovalRequest>().id;

    const denied = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${withdrawTarget}/withdraw`,
      organisationId,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('NOT_REQUESTER');

    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${withdrawTarget}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json<ApprovalRequest>().status).toBe('withdrawn');
    expect(await auditActions('approval_requests', withdrawTarget)).toContain(
      'correction.withdrawn',
    );
  });

  it('direct-applies a proposal from an approval-authority holder', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${replacementId}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Self-approval by the authority holder.',
        replacement: {
          challanDate: '2026-08-08',
          prefix: `${work1Code}-DC`,
          consignee: consignee(),
          items: [{ workItemId: item1AId, quantity: '5.000' }],
        },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const approval = response.json<ApprovalRequest>();
    expect(approval.status).toBe('approved');
    expect(approval.requestedByUserId).toBe(approval.decidedByUserId);

    const [cancelled] = await admin<{ status: string }[]>`
      select status from delivery_challans where id = ${replacementId}
    `;
    expect(cancelled?.status).toBe('cancelled');
    // Clear the resulting draft so later tests see a clean Work.
    const [draft] = await admin<{ id: string }[]>`
      select id from delivery_challans
      where work_id = ${work1Id} and status = 'draft'
    `;
    if (!draft) throw new Error('self-approval left no replacement draft');
    const removed = await authed(clerk, {
      method: 'DELETE',
      url: `/api/challans/${draft.id}`,
      organisationId,
    });
    expect(removed.statusCode).toBe(204);
  });
});

describe('Path A — cancel and replace for an issued Issue Challan', () => {
  let icId: string;
  let icNumber: string;

  it('cancels the issued Issue Challan and drafts a replacement preserving manual lines', async () => {
    const created = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${work1Id}/issue-challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        movementType: 'issue',
        issuedToName: 'SSE/Signal/Delhi',
        lines: [
          { workItemId: item1AId, quantity: '4.000' },
          {
            description: 'Cable ties (site consumables)',
            unit: 'Pkt',
            quantity: '10.000',
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    icId = created.json<IssueChallanDetailResponse>().issueChallan.id;
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${icId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    icNumber =
      issued.json<IssueChallanDetailResponse>().issueChallan.challanNumber ?? '';

    const filed = await authed(clerk, {
      method: 'POST',
      url: `/api/issue-challans/${icId}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Issued to the wrong engineer.',
        replacement: {
          challanDate: '2026-08-08',
          movementType: 'issue',
          issuedToName: 'SSE/Works/Delhi',
          lines: [
            { workItemId: item1AId, quantity: '4.000' },
            {
              description: 'Cable ties (site consumables)',
              unit: 'Pkt',
              quantity: '12.000',
            },
          ],
        },
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const approval = filed.json<ApprovalRequest>();
    expect(approval.entityType).toBe('issue_challan_cancel_replace');
    expect(approval.documentNumber).toBe(icNumber);

    const approved = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${approval.id}/approve`,
      organisationId,
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const [original] = await admin<
      { status: string; cancellation_note: string | null }[]
    >`
      select status, cancellation_note from issue_challans where id = ${icId}
    `;
    expect(original?.status).toBe('cancelled');
    expect(original?.cancellation_note).toContain(approval.id);
    expect(original?.cancellation_note).toContain('Issued to the wrong engineer.');

    const [replacement] = await admin<
      { id: string; replaces_issue_challan_id: string | null; issued_to_name: string }[]
    >`
      select id, replaces_issue_challan_id, issued_to_name
      from issue_challans where work_id = ${work1Id} and status = 'draft'
    `;
    expect(replacement?.replaces_issue_challan_id).toBe(icId);
    expect(replacement?.issued_to_name).toBe('SSE/Works/Delhi');
    if (!replacement) throw new Error('IC replacement draft missing');
    const manualLines = await admin<
      { description_snapshot: string; quantity: string }[]
    >`
      select description_snapshot, quantity::text as quantity
      from issue_challan_lines
      where issue_challan_id = ${replacement.id} and work_item_id is null
    `;
    expect(manualLines).toEqual([
      { description_snapshot: 'Cable ties (site consumables)', quantity: '12.000' },
    ]);

    // The replacement re-issues under the untouched numbering series.
    const reissued = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${replacement.id}/issue`,
      organisationId,
    });
    expect(reissued.statusCode, reissued.body).toBe(201);
    expect(
      reissued.json<IssueChallanDetailResponse>().issueChallan.sequenceNumber,
    ).toBe(2);
  });
});

describe('Path B — numbered correction notice', () => {
  let dc21Id: string;
  let dc21Number: string;
  let dc22Id: string;
  let noticeId: string;
  let noticeRequestId: string;

  it('blocks cancel-and-replace once evidence exists and reports the notice path', async () => {
    ({ challanId: dc21Id, challanNumber: dc21Number } = await issueChallan(
      work2Id,
      `${work2Code}-DC`,
      [{ workItemId: item2AId, quantity: '2.000' }],
    ));
    await recordReceipt(dc21Id);

    const refused = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${dc21Id}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Must be refused: evidence exists.',
        replacement: {
          challanDate: '2026-08-08',
          prefix: `${work2Code}-DC`,
          consignee: consignee(),
          items: [{ workItemId: item2AId, quantity: '3.000' }],
        },
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('CHALLAN_HAS_EVIDENCE');

    const { body } = await eligibility(clerk, dc21Id);
    expect(body.path).toBe('correction_notice');
    expect(body.evidence.receipts).toBe(1);
  });

  it('refuses a notice for an evidence-free challan (Path A applies there)', async () => {
    ({ challanId: dc22Id } = await issueChallan(work2Id, `${work2Code}-DC`, [
      { workItemId: item2AId, quantity: '1.000' },
    ]));
    const refused = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${dc22Id}/corrections/notice`,
      organisationId,
      payload: { reason: 'No evidence here.', statement: 'Wrong quantity noted.' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('CORRECTION_USE_CANCEL_REPLACE');
  });

  it('requires at least one correction or a statement', async () => {
    const empty = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${dc21Id}/corrections/notice`,
      organisationId,
      payload: { reason: 'Nothing corrected.' },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json<{ code: string }>().code).toBe('CORRECTION_EMPTY');
  });

  it('issues the notice on approval with a gapless number, never touching the original', async () => {
    const before = await admin<{ issued_snapshot: unknown; updated_at: Date }[]>`
      select issued_snapshot, updated_at from delivery_challans where id = ${dc21Id}
    `;
    const filed = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${dc21Id}/corrections/notice`,
      organisationId,
      payload: {
        reason: 'Consignee designation misprinted.',
        corrections: [{ field: 'Consignee designation', corrected: 'Sr. DEE (W) NR' }],
        statement: 'The issued copy reads (G); the correct designation is (W).',
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const approval = filed.json<ApprovalRequest>();
    noticeRequestId = approval.id;
    expect(approval.status).toBe('pending');
    expect(approval.entityType).toBe('challan_correction_notice');
    expect(approval.documentNumber).toBe(dc21Number);

    const approved = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${noticeRequestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const listed = await authed(clerk, {
      method: 'GET',
      url: `/api/challans/${dc21Id}/correction-notices`,
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const notices = listed.json<CorrectionNoticeListResponse>().notices;
    expect(notices).toHaveLength(1);
    const notice = notices[0];
    if (!notice) throw new Error('notice missing');
    noticeId = notice.id;
    expect(notice.noticeNumber).toBe(`${work2Code}-CN-01`);
    expect(notice.sequenceNumber).toBe(1);
    expect(notice.status).toBe('issued');
    expect(notice.templateVersion).toBe('correction-notice-v1');
    expect(notice.approvalRequestId).toBe(noticeRequestId);

    // The original challan is byte-for-byte untouched.
    const after = await admin<{ issued_snapshot: unknown; status: string }[]>`
      select issued_snapshot, status from delivery_challans where id = ${dc21Id}
    `;
    expect(after[0]?.status).toBe('issued');
    expect(after[0]?.issued_snapshot).toEqual(before[0]?.issued_snapshot);

    // The snapshot restates the original identity plus the corrections.
    const detail = await authed(clerk, {
      method: 'GET',
      url: `/api/correction-notices/${noticeId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const snapshot = detail.json<CorrectionNoticeDetailResponse>().snapshot as {
      challan: { challanNumber: string; lines: { quantity: string }[] };
      corrections: { field: string; corrected: string }[];
      statement: string;
      reason: string;
    };
    expect(snapshot.challan.challanNumber).toBe(dc21Number);
    expect(snapshot.challan.lines[0]?.quantity).toBe('2.000');
    expect(snapshot.corrections).toEqual([
      { field: 'Consignee designation', corrected: 'Sr. DEE (W) NR' },
    ]);
    expect(snapshot.reason).toBe('Consignee designation misprinted.');

    expect(await auditActions('correction_notices', noticeId)).toContain(
      'correction_notice.issued',
    );
  });

  it('lists the notice on the Work as well', async () => {
    const listed = await authed(clerk, {
      method: 'GET',
      url: `/api/works/${work2Id}/correction-notices`,
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(
      listed.json<CorrectionNoticeListResponse>().notices.map((n) => n.noticeNumber),
    ).toContain(`${work2Code}-CN-01`);
  });

  it('renders the notice PDF through the pipeline and streams it back', async () => {
    const rendered = await authed(clerk, {
      method: 'POST',
      url: `/api/correction-notices/${noticeId}/render`,
      organisationId,
    });
    expect(rendered.statusCode, rendered.body).toBe(200);
    expect(
      rendered.json<CorrectionNoticeDetailResponse>().notice.renderedAvailable,
    ).toBe(true);

    const expectedSha = createHash('sha256')
      .update(Buffer.from(`%PDF-1.4 stub ${runId}`))
      .digest('hex');
    const [row] = await admin<
      { rendered_sha256: string | null; rendered_object_key: string | null }[]
    >`
      select rendered_sha256, rendered_object_key
      from correction_notices where id = ${noticeId}
    `;
    expect(row?.rendered_sha256).toBe(expectedSha);
    expect(row?.rendered_object_key).toBe(`${organisationId}/cn/${noticeId}.pdf`);

    const pdf = await authed(viewer, {
      method: 'GET',
      url: `/api/correction-notices/${noticeId}/pdf`,
      organisationId,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body).toContain(`%PDF-1.4 stub ${runId}`);

    expect(await auditActions('correction_notices', noticeId)).toContain(
      'correction_notice.rendered',
    );
  });

  it('freezes issued notice business data at the database', async () => {
    await expect(
      admin`
        update correction_notices
        set snapshot = '{"tampered":true}'::jsonb
        where id = ${noticeId}
      `,
    ).rejects.toThrowError(/immutable/);
    await expect(
      admin`
        update correction_notices
        set notice_number = 'TAMPERED-CN-99'
        where id = ${noticeId}
      `,
    ).rejects.toThrowError(/immutable/);
  });

  it('flips a filed cancel-and-replace to a conflict when evidence lands before approval', async () => {
    // dc22 is issued and evidence-free; the clerk files Path A.
    const filed = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${dc22Id}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Quantity wrong on the issued copy.',
        replacement: {
          challanDate: '2026-08-08',
          prefix: `${work2Code}-DC`,
          consignee: consignee(),
          items: [{ workItemId: item2AId, quantity: '2.000' }],
        },
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const raceRequestId = filed.json<ApprovalRequest>().id;

    // Evidence arrives between filing and approval.
    await recordReceipt(dc22Id);

    const conflicted = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${raceRequestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json<{ code: string }>().code).toBe('CHALLAN_HAS_EVIDENCE');

    // Nothing broke: the request is still pending, the challan untouched.
    const pending = await authed(clerk, {
      method: 'GET',
      url: `/api/approvals?status=pending`,
      organisationId,
    });
    expect(
      pending.json<{ approvals: ApprovalRequest[] }>().approvals.map((row) => row.id),
    ).toContain(raceRequestId);
    const [challan] = await admin<{ status: string }[]>`
      select status from delivery_challans where id = ${dc22Id}
    `;
    expect(challan?.status).toBe('issued');

    // The queue stays truthful: the requester withdraws and takes Path B.
    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${raceRequestId}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode).toBe(200);
  });

  it('cancels a notice with a mandatory note under the cancel authority', async () => {
    const noAuthority = await authed(clerk, {
      method: 'POST',
      url: `/api/correction-notices/${noticeId}/cancel`,
      organisationId,
      payload: { note: 'Clerk lacks the cancel authority.' },
    });
    expect(noAuthority.statusCode).toBe(403);

    const missingNote = await authed(owner, {
      method: 'POST',
      url: `/api/correction-notices/${noticeId}/cancel`,
      organisationId,
      payload: {},
    });
    expect(missingNote.statusCode).toBe(400);

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/correction-notices/${noticeId}/cancel`,
      organisationId,
      payload: { note: 'Superseded by a fresh notice.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const notice = cancelled.json<CorrectionNoticeDetailResponse>().notice;
    expect(notice.status).toBe('cancelled');
    expect(notice.cancellationNote).toBe('Superseded by a fresh notice.');
    expect(await auditActions('correction_notices', noticeId)).toContain(
      'correction_notice.cancelled',
    );

    // A cancelled notice cannot be re-rendered, and its row is frozen.
    const rerender = await authed(clerk, {
      method: 'POST',
      url: `/api/correction-notices/${noticeId}/render`,
      organisationId,
    });
    expect(rerender.statusCode).toBe(409);
    await expect(
      admin`
        update correction_notices set cancellation_note = 'rewritten'
        where id = ${noticeId}
      `,
    ).rejects.toThrowError(/immutable/);
  });
});

describe('concurrency', () => {
  let dc31Id: string;
  let dc32Id: string;
  let dc33Id: string;

  it('lets exactly one of two simultaneous approvals of a request win', async () => {
    ({ challanId: dc31Id } = await issueChallan(work3Id, `${work3Code}-DC`, [
      { workItemId: item3AId, quantity: '1.000' },
    ]));
    ({ challanId: dc32Id } = await issueChallan(work3Id, `${work3Code}-DC`, [
      { workItemId: item3AId, quantity: '2.000' },
    ]));
    ({ challanId: dc33Id } = await issueChallan(work3Id, `${work3Code}-DC`, [
      { workItemId: item3AId, quantity: '3.000' },
    ]));

    const filed = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${dc31Id}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Concurrent decision fixture.',
        replacement: {
          challanDate: '2026-08-08',
          prefix: `${work3Code}-DC`,
          consignee: consignee(),
          items: [{ workItemId: item3AId, quantity: '1.500' }],
        },
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const requestId = filed.json<ApprovalRequest>().id;

    const [first, second] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/approvals/${requestId}/approve`,
        organisationId,
        payload: {},
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/approvals/${requestId}/approve`,
        organisationId,
        payload: {},
      }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const conflict = first.statusCode === 409 ? first : second;
    expect(conflict.json<{ code: string }>().code).toBe('APPROVAL_NOT_PENDING');

    // Exactly one apply happened: one cancelled original, one draft.
    const [cancelledCount] = await admin<{ count: number }[]>`
      select count(*)::int as count from delivery_challans
      where id = ${dc31Id} and status = 'cancelled'
    `;
    expect(cancelledCount?.count).toBe(1);
    const drafts = await admin<{ id: string }[]>`
      select id from delivery_challans
      where work_id = ${work3Id} and status = 'draft'
    `;
    expect(drafts).toHaveLength(1);
  });

  it('numbers simultaneous notice approvals gaplessly under the counter lock', async () => {
    await recordReceipt(dc32Id);
    await recordReceipt(dc33Id);

    const requestIds: string[] = [];
    for (const challanId of [dc32Id, dc33Id]) {
      const filed = await authed(clerk, {
        method: 'POST',
        url: `/api/challans/${challanId}/corrections/notice`,
        organisationId,
        payload: {
          reason: 'Concurrent numbering fixture.',
          statement: 'The recorded unit is Nos, not Set.',
        },
      });
      expect(filed.statusCode, filed.body).toBe(201);
      requestIds.push(filed.json<ApprovalRequest>().id);
    }

    const decisions = await Promise.all(
      requestIds.map((id) =>
        authed(owner, {
          method: 'POST',
          url: `/api/approvals/${id}/approve`,
          organisationId,
          payload: {},
        }),
      ),
    );
    for (const decision of decisions) {
      expect(decision.statusCode, decision.body).toBe(200);
    }

    const notices = await admin<{ notice_number: string; sequence_number: number }[]>`
      select notice_number, sequence_number from correction_notices
      where work_id = ${work3Id}
      order by sequence_number
    `;
    expect(notices).toEqual([
      { notice_number: `${work3Code}-CN-01`, sequence_number: 1 },
      { notice_number: `${work3Code}-CN-02`, sequence_number: 2 },
    ]);
  });
});

describe('cross-tenant denial', () => {
  let foreignChallanId: string;
  let foreignNoticeId: string;
  let foreignPendingId: string;

  beforeAll(async () => {
    // Organisation A state the outsider (org B) will probe.
    const [notice] = await admin<{ id: string; delivery_challan_id: string }[]>`
      select id, delivery_challan_id from correction_notices
      where organisation_id = ${organisationId}
      limit 1
    `;
    if (!notice) throw new Error('no notice to probe');
    foreignNoticeId = notice.id;
    foreignChallanId = notice.delivery_challan_id;
    const filed = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${foreignChallanId}/corrections/notice`,
      organisationId,
      payload: { reason: 'Pending row for tenancy probes.', statement: 'Probe row.' },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    foreignPendingId = filed.json<ApprovalRequest>().id;
  });

  it('hides eligibility, proposals, notices, and decisions from another organisation', async () => {
    const probes = await Promise.all([
      authed(outsider, {
        method: 'GET',
        url: `/api/challans/${foreignChallanId}/correction-eligibility`,
        organisationId: organisationBId,
      }),
      authed(outsider, {
        method: 'POST',
        url: `/api/challans/${foreignChallanId}/corrections/cancel-replace`,
        organisationId: organisationBId,
        payload: {
          reason: 'Cross-tenant probe.',
          replacement: {
            challanDate: '2026-08-08',
            prefix: 'EVIL',
            consignee: consignee(),
            items: [{ workItemId: item2AId, quantity: '1.000' }],
          },
        },
      }),
      authed(outsider, {
        method: 'POST',
        url: `/api/challans/${foreignChallanId}/corrections/notice`,
        organisationId: organisationBId,
        payload: { reason: 'Cross-tenant probe.', statement: 'Probe.' },
      }),
      authed(outsider, {
        method: 'GET',
        url: `/api/correction-notices/${foreignNoticeId}`,
        organisationId: organisationBId,
      }),
      authed(outsider, {
        method: 'GET',
        url: `/api/correction-notices/${foreignNoticeId}/pdf`,
        organisationId: organisationBId,
      }),
      authed(outsider, {
        method: 'POST',
        url: `/api/correction-notices/${foreignNoticeId}/cancel`,
        organisationId: organisationBId,
        payload: { note: 'Cross-tenant cancel probe.' },
      }),
      authed(outsider, {
        method: 'GET',
        url: `/api/works/${work2Id}/correction-notices`,
        organisationId: organisationBId,
      }),
      authed(outsider, {
        method: 'POST',
        url: `/api/approvals/${foreignPendingId}/approve`,
        organisationId: organisationBId,
        payload: {},
      }),
    ]);
    for (const probe of probes) {
      expect(probe.statusCode, probe.body).toBe(404);
    }
    // The probed rows are untouched.
    const [row] = await admin<{ status: string }[]>`
      select status from approval_requests where id = ${foreignPendingId}
    `;
    expect(row?.status).toBe('pending');
  });
});

describe('export and timeline', () => {
  it('exports correction notices and approval requests with the object manifest', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const payload = response.json<{
      correctionNotices: { id: string; snapshot: unknown }[];
      approvalRequests: { id: string; entity_type: string }[];
      objectManifest: { kind: string; objectKey: string; sha256: string | null }[];
      issueChallans: { id: string; replaces_issue_challan_id: string | null }[];
      issueChallanLines: { issue_challan_id: string }[];
      extensionRequests: unknown[];
    }>();
    expect(payload.correctionNotices.length).toBeGreaterThanOrEqual(3);
    expect(
      payload.approvalRequests.some(
        (row) => row.entity_type === 'challan_cancel_replace',
      ),
    ).toBe(true);
    expect(
      payload.objectManifest.some(
        (entry) => entry.kind === 'correction-notice-rendered-pdf',
      ),
    ).toBe(true);
    // Issue Challans — their register, lines, and the replacement
    // provenance the corrections track added — are part of the record.
    expect(payload.issueChallans.length).toBeGreaterThanOrEqual(2);
    expect(
      payload.issueChallans.some((row) => row.replaces_issue_challan_id !== null),
    ).toBe(true);
    expect(payload.issueChallanLines.length).toBeGreaterThan(0);
    expect(Array.isArray(payload.extensionRequests)).toBe(true);
  });

  it('surfaces the correction trail in the Work timeline and entity history', async () => {
    const timeline = await authed(clerk, {
      method: 'GET',
      url: `/api/works/${work2Id}/timeline?entityTypes=approval_requests,correction_notices`,
      organisationId,
    });
    expect(timeline.statusCode, timeline.body).toBe(200);
    const actions = timeline
      .json<TimelineResponse>()
      .events.map((event) => event.action);
    expect(actions).toContain('correction.proposed');
    expect(actions).toContain('correction.approved');
    expect(actions).toContain('correction_notice.issued');

    // Replacement provenance is visible on the replacement document's own
    // history.
    const [replacement] = await admin<{ id: string }[]>`
      select id from delivery_challans
      where organisation_id = ${organisationId}
        and work_id = ${work1Id} and replaces_challan_id is not null
      order by created_at
      limit 1
    `;
    if (!replacement) throw new Error('no replacement to inspect');
    const history = await authed(clerk, {
      method: 'GET',
      url: `/api/audit/entity/delivery_challans/${replacement.id}`,
      organisationId,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(
      history.json<TimelineResponse>().events.map((event) => event.action),
    ).toContain('challan.replacement_drafted');
  });

  it('freezes replacement provenance once the document leaves draft', async () => {
    // A replacement that reached issued: clearing its provenance must fail
    // on the dedicated guard (cancelled rows are already frozen whole).
    const [issuedDcReplacement] = await admin<{ id: string }[]>`
      select id from delivery_challans
      where organisation_id = ${organisationId}
        and replaces_challan_id is not null and status = 'issued'
      limit 1
    `;
    const [issuedIcReplacement] = await admin<{ id: string }[]>`
      select id from issue_challans
      where organisation_id = ${organisationId}
        and replaces_issue_challan_id is not null and status = 'issued'
      limit 1
    `;
    if (issuedDcReplacement) {
      await expect(
        admin`
          update delivery_challans set replaces_challan_id = null
          where id = ${issuedDcReplacement.id}
        `,
      ).rejects.toThrowError(/provenance is immutable/);
    }
    if (!issuedIcReplacement) throw new Error('no issued IC replacement to probe');
    await expect(
      admin`
        update issue_challans set replaces_issue_challan_id = null
        where id = ${issuedIcReplacement.id}
      `,
    ).rejects.toThrowError(/provenance is immutable/);
  });

  it('surfaces Issue Challan correction events in the Work timeline and entity history', async () => {
    const timeline = await authed(clerk, {
      method: 'GET',
      url: `/api/works/${work1Id}/timeline?entityTypes=issue_challans`,
      organisationId,
    });
    expect(timeline.statusCode, timeline.body).toBe(200);
    const actions = timeline
      .json<TimelineResponse>()
      .events.map((event) => event.action);
    expect(actions).toContain('issue_challan.cancelled');
    expect(actions).toContain('issue_challan.replacement_drafted');

    // The entity-history API accepts issue_challans and serves the
    // per-document cancellation trail.
    const [cancelledIc] = await admin<{ id: string }[]>`
      select id from issue_challans
      where organisation_id = ${organisationId} and status = 'cancelled'
      limit 1
    `;
    if (!cancelledIc) throw new Error('no cancelled Issue Challan to inspect');
    const history = await authed(clerk, {
      method: 'GET',
      url: `/api/audit/entity/issue_challans/${cancelledIc.id}`,
      organisationId,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(
      history.json<TimelineResponse>().events.map((event) => event.action),
    ).toContain('issue_challan.cancelled');
  });
});

describe('Issue Challan manual-line quantity normalisation', () => {
  it('treats a replacement identical up to decimal formatting as no change', async () => {
    // The issued IC replacement carries the manual line at 12.000; a
    // "replacement" restating everything with '12' (and '4' for the
    // work-item line) is materially identical and must NOT cancel a
    // lawful document.
    const [issuedIc] = await admin<
      { id: string; issued_to_name: string; challan_date: string }[]
    >`
      select id, issued_to_name, challan_date::text as challan_date
      from issue_challans
      where organisation_id = ${organisationId}
        and status = 'issued' and replaces_issue_challan_id is not null
      limit 1
    `;
    if (!issuedIc) throw new Error('no issued IC replacement to correct');

    const filed = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${issuedIc.id}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Restating the same content differently formatted.',
        replacement: {
          challanDate: issuedIc.challan_date,
          movementType: 'issue',
          issuedToName: issuedIc.issued_to_name,
          lines: [
            { workItemId: item1AId, quantity: '4' },
            {
              description: 'Cable ties (site consumables)',
              unit: 'Pkt',
              quantity: '12',
            },
          ],
        },
      },
    });
    expect(filed.statusCode).toBe(400);
    expect(filed.json<{ code: string }>().code).toBe('CORRECTION_EMPTY');

    // The document is untouched — no cancel, no draft.
    const [after] = await admin<{ status: string }[]>`
      select status from issue_challans where id = ${issuedIc.id}
    `;
    expect(after?.status).toBe('issued');
  });
});

describe('correction applies revalidate the document authorities of the decider', () => {
  let dcId: string;
  let cancelReplaceRequestId: string;

  it('refuses a cancel-and-replace apply from an approver without the cancel authority, releasing the claim', async () => {
    ({ challanId: dcId } = await issueChallan(work1Id, `${work1Code}-DC`, [
      { workItemId: item1AId, quantity: '6.000' },
    ]));
    const filed = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${dcId}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Authority fixture: quantity wrong.',
        replacement: {
          challanDate: '2026-08-08',
          prefix: `${work1Code}-DC`,
          consignee: consignee(),
          items: [{ workItemId: item1AId, quantity: '7.000' }],
        },
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    cancelReplaceRequestId = filed.json<ApprovalRequest>().id;

    const denied = await authed(approverOnly, {
      method: 'POST',
      url: `/api/approvals/${cancelReplaceRequestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    expect(denied.json<{ message: string }>().message).toContain('cancel');

    // The claim was released: still pending, the challan untouched.
    const pending = await authed(clerk, {
      method: 'GET',
      url: '/api/approvals?status=pending',
      organisationId,
    });
    expect(
      pending.json<{ approvals: ApprovalRequest[] }>().approvals.map((row) => row.id),
    ).toContain(cancelReplaceRequestId);
    const [challan] = await admin<{ status: string }[]>`
      select status from delivery_challans where id = ${dcId}
    `;
    expect(challan?.status).toBe('issued');

    // The full-authority owner decides the same request without friction.
    const approved = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${cancelReplaceRequestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    // Clear the resulting draft so later suites see a clean Work.
    const [draft] = await admin<{ id: string }[]>`
      select id from delivery_challans
      where work_id = ${work1Id} and status = 'draft'
    `;
    if (!draft) throw new Error('authority fixture left no replacement draft');
    const removed = await authed(clerk, {
      method: 'DELETE',
      url: `/api/challans/${draft.id}`,
      organisationId,
    });
    expect(removed.statusCode).toBe(204);
  });

  it('refuses a correction-notice apply from an approver without the issue authority', async () => {
    // dc22 carries a receipt, so Path B applies; no pending request rides
    // on it after the race test withdrew.
    const [withEvidence] = await admin<{ id: string }[]>`
      select dc.id from delivery_challans dc
      where dc.organisation_id = ${organisationId}
        and dc.work_id = ${work2Id} and dc.status = 'issued'
        and exists (
          select 1 from challan_receipts cr where cr.delivery_challan_id = dc.id
        )
        and not exists (
          select 1 from approval_requests ar
          where ar.entity_id = dc.id and ar.status = 'pending'
        )
      limit 1
    `;
    if (!withEvidence) throw new Error('no evidence-bearing challan available');
    const filed = await authed(clerk, {
      method: 'POST',
      url: `/api/challans/${withEvidence.id}/corrections/notice`,
      organisationId,
      payload: {
        reason: 'Authority fixture: unit misprinted.',
        statement: 'The recorded unit is Nos, not Set.',
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const noticeRequestId = filed.json<ApprovalRequest>().id;

    const denied = await authed(approverOnly, {
      method: 'POST',
      url: `/api/approvals/${noticeRequestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    expect(denied.json<{ message: string }>().message).toContain('issue');

    // Released back to pending; no notice was minted.
    const pending = await authed(clerk, {
      method: 'GET',
      url: '/api/approvals?status=pending',
      organisationId,
    });
    expect(
      pending.json<{ approvals: ApprovalRequest[] }>().approvals.map((row) => row.id),
    ).toContain(noticeRequestId);
    const [minted] = await admin<{ count: number }[]>`
      select count(*)::int as count from correction_notices
      where approval_request_id = ${noticeRequestId}
    `;
    expect(minted?.count).toBe(0);

    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${noticeRequestId}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode).toBe(200);
  });

  it('still requires plain amendment approvals to carry no document authority', async () => {
    // Control: the approver-only member CAN decide an ordinary item
    // amendment — the new gates bind the correction paths only.
    const proposed = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${work3Id}/amendments`,
      organisationId,
      payload: {
        workItemId: item3AId,
        reason: 'Rate correction control fixture.',
        changes: { rate: '11.00' },
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const requestId = proposed.json<ApprovalRequest>().id;
    const approved = await authed(approverOnly, {
      method: 'POST',
      url: `/api/approvals/${requestId}/approve`,
      organisationId,
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
  });
});

describe('assigned-scope denial (work_scope = assigned)', () => {
  let assignedUserId: string;
  let work2IssueChallanId: string;
  let work2NoticeId: string;
  let work2ChallanId: string;

  beforeAll(async () => {
    const [assignedUser] = await admin<{ id: string }[]>`
      select "id" from auth_users where "email" = ${assignedEmail}
    `;
    if (!assignedUser) throw new Error('assigned user missing');
    assignedUserId = assignedUser.id;
    // Office member with EVERY document authority, narrowed to work 1:
    // the 404s below prove the assignment scope, not a missing authority.
    await admin`
      update organisation_memberships
      set work_scope = 'assigned', can_issue_documents = true,
          can_cancel_documents = true, can_approve_amendments = true
      where organisation_id = ${organisationId} and user_id = ${assignedUserId}
    `;
    await admin`
      insert into work_assignments (
        organisation_id, work_id, user_id, created_by_user_id
      )
      values (${organisationId}, ${work1Id}, ${assignedUserId}, ${ownerUserId})
    `;

    // Work-2 fixtures to probe: an issued Issue Challan and an existing
    // correction notice.
    const icDraft = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${work2Id}/issue-challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        movementType: 'issue',
        issuedToName: 'SSE/Signal/Delhi',
        lines: [{ workItemId: item2AId, quantity: '1.000' }],
      },
    });
    expect(icDraft.statusCode, icDraft.body).toBe(201);
    work2IssueChallanId = icDraft.json<IssueChallanDetailResponse>().issueChallan.id;
    const icIssued = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${work2IssueChallanId}/issue`,
      organisationId,
    });
    expect(icIssued.statusCode, icIssued.body).toBe(201);

    const [notice] = await admin<{ id: string; delivery_challan_id: string }[]>`
      select id, delivery_challan_id from correction_notices
      where organisation_id = ${organisationId} and work_id = ${work2Id}
      limit 1
    `;
    if (!notice) throw new Error('no work-2 notice to probe');
    work2NoticeId = notice.id;
    work2ChallanId = notice.delivery_challan_id;
  });

  it('answers 404 on every correction surface addressed with an unassigned Work', async () => {
    const probes = await Promise.all([
      authed(assigned, {
        method: 'GET',
        url: `/api/challans/${work2ChallanId}/correction-eligibility`,
        organisationId,
      }),
      authed(assigned, {
        method: 'POST',
        url: `/api/challans/${work2ChallanId}/corrections/cancel-replace`,
        organisationId,
        payload: {
          reason: 'Assigned-scope probe.',
          replacement: {
            challanDate: '2026-08-08',
            prefix: `${work2Code}-DC`,
            consignee: consignee(),
            items: [{ workItemId: item2AId, quantity: '1.000' }],
          },
        },
      }),
      authed(assigned, {
        method: 'POST',
        url: `/api/challans/${work2ChallanId}/corrections/notice`,
        organisationId,
        payload: { reason: 'Assigned-scope probe.', statement: 'Probe.' },
      }),
      authed(assigned, {
        method: 'POST',
        url: `/api/issue-challans/${work2IssueChallanId}/corrections/cancel-replace`,
        organisationId,
        payload: {
          reason: 'Assigned-scope probe.',
          replacement: {
            challanDate: '2026-08-08',
            movementType: 'issue',
            issuedToName: 'SSE/Works/Delhi',
            lines: [{ workItemId: item2AId, quantity: '1.000' }],
          },
        },
      }),
      authed(assigned, {
        method: 'GET',
        url: `/api/works/${work2Id}/correction-notices`,
        organisationId,
      }),
      authed(assigned, {
        method: 'GET',
        url: `/api/challans/${work2ChallanId}/correction-notices`,
        organisationId,
      }),
      authed(assigned, {
        method: 'GET',
        url: `/api/correction-notices/${work2NoticeId}`,
        organisationId,
      }),
      authed(assigned, {
        method: 'POST',
        url: `/api/correction-notices/${work2NoticeId}/render`,
        organisationId,
      }),
      authed(assigned, {
        method: 'GET',
        url: `/api/correction-notices/${work2NoticeId}/pdf`,
        organisationId,
      }),
      authed(assigned, {
        method: 'POST',
        url: `/api/correction-notices/${work2NoticeId}/cancel`,
        organisationId,
        payload: { note: 'Assigned-scope cancel probe.' },
      }),
      authed(assigned, {
        method: 'GET',
        url: `/api/works/${work2Id}/amendments`,
        organisationId,
      }),
    ]);
    for (const probe of probes) {
      expect(probe.statusCode, probe.body).toBe(404);
    }
  });

  it('answers 404 on decisions over an unassigned Work and hides them from the queue', async () => {
    // A pending correction request on an unassigned Work (filed by the
    // clerk, full scope).
    const filed = await authed(clerk, {
      method: 'POST',
      url: `/api/issue-challans/${work2IssueChallanId}/corrections/cancel-replace`,
      organisationId,
      payload: {
        reason: 'Queue-visibility fixture.',
        replacement: {
          challanDate: '2026-08-08',
          movementType: 'issue',
          issuedToName: 'SSE/Works/Delhi',
          lines: [{ workItemId: item2AId, quantity: '1.000' }],
        },
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const foreignRequestId = filed.json<ApprovalRequest>().id;

    for (const action of ['approve', 'reject'] as const) {
      const denied = await authed(assigned, {
        method: 'POST',
        url: `/api/approvals/${foreignRequestId}/${action}`,
        organisationId,
        payload: action === 'reject' ? { note: 'Assigned-scope probe.' } : {},
      });
      expect(denied.statusCode, denied.body).toBe(404);
    }

    const queue = await authed(assigned, {
      method: 'GET',
      url: '/api/approvals',
      organisationId,
    });
    expect(queue.statusCode, queue.body).toBe(200);
    const visible = queue.json<{ approvals: ApprovalRequest[] }>().approvals;
    expect(visible.map((row) => row.id)).not.toContain(foreignRequestId);
    for (const approval of visible) {
      expect(approval.workId).toBe(work1Id);
    }

    const withdrawn = await authed(clerk, {
      method: 'POST',
      url: `/api/approvals/${foreignRequestId}/withdraw`,
      organisationId,
    });
    expect(withdrawn.statusCode).toBe(200);
  });

  it('serves the assigned Work normally (positive control)', async () => {
    const [work1Challan] = await admin<{ id: string }[]>`
      select id from delivery_challans
      where organisation_id = ${organisationId} and work_id = ${work1Id}
      limit 1
    `;
    if (!work1Challan) throw new Error('no work-1 challan for the control');
    const eligible = await authed(assigned, {
      method: 'GET',
      url: `/api/challans/${work1Challan.id}/correction-eligibility`,
      organisationId,
    });
    expect(eligible.statusCode, eligible.body).toBe(200);
    const notices = await authed(assigned, {
      method: 'GET',
      url: `/api/works/${work1Id}/correction-notices`,
      organisationId,
    });
    expect(notices.statusCode, notices.body).toBe(200);
  });
});

describe('Wave 2 schema hardening (0023)', () => {
  it('refuses a NULL cancellation note on challans at the database', async () => {
    // Pre-0023 the cancelled branch evaluated to NULL for a NULL note and
    // the CHECK passed; the explicit NOT NULL conjunct now holds. A fresh
    // evidence-free challan keeps the 0008 evidence guard out of the way.
    const { challanId } = await issueChallan(work1Id, `${work1Code}-DC`, [
      { workItemId: item1AId, quantity: '1.000' },
    ]);
    await expect(
      admin`
        update delivery_challans
        set status = 'cancelled', cancelled_at = now(),
            cancelled_by_user_id = ${ownerUserId}, cancellation_note = null
        where id = ${challanId}
      `,
    ).rejects.toMatchObject({ code: '23514' });

    const [issuedIc] = await admin<{ id: string }[]>`
      select id from issue_challans
      where organisation_id = ${organisationId} and status = 'issued'
      limit 1
    `;
    if (!issuedIc) throw new Error('no issued Issue Challan to probe');
    await expect(
      admin`
        update issue_challans
        set status = 'cancelled', cancelled_at = now(),
            cancelled_by_user_id = ${ownerUserId}, cancellation_note = null
        where id = ${issuedIc.id}
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('never deletes a correction notice, even for the table owner', async () => {
    await expect(
      admin`
        delete from correction_notices where organisation_id = ${organisationId}
      `,
    ).rejects.toThrow(/never delete/);
  });

  it('forces correction requests to name their target document', async () => {
    await expect(
      admin`
        insert into approval_requests (
          organisation_id, entity_type, entity_id, work_id, proposed, diff,
          reason, requested_by_user_id
        )
        values (
          ${organisationId}, 'challan_cancel_replace', null, ${work1Id},
          '{}'::jsonb, '[]'::jsonb, 'entity binding probe', ${ownerUserId}
        )
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
