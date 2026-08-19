import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { DashboardResponse, Work } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * Work-scope enforcement, site-role evidence permissions, and member
 * lifecycle management — the authorization batch from the 2026-08-08
 * external review.
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
const ownerEmail = `scope-owner-${runId}@integration.test`;
const siteEmail = `scope-site-${runId}@integration.test`;
const viewerEmail = `scope-viewer-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;
let siteUserId: string;
let viewerUserId: string;
let workAId: string;
let workBId: string;
let itemAId: string;
let challanAId: string;
let challanBId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let site: CookieJar;
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

async function seedWork(code: string): Promise<{ workId: string; itemId: string }> {
  const workId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${code}, ${`L-${code}`}, '2026-01-10',
      ${`Scope proof work ${code}`}, '100000.00', '90000.00', 'per_schedule',
      ${ownerUserId}
    )
  `;
  const scheduleId = randomUUID();
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  const itemId = randomUUID();
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number,
      description, unit_code, awarded_quantity, effective_rate
    )
    values (
      ${itemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
      'Scope test item', 'Nos', '1000.000', '10.00'
    )
  `;
  return { workId, itemId };
}

async function issueChallanOn(
  workId: string,
  itemId: string,
  prefix: string,
): Promise<string> {
  const created = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/challans`,
    organisationId,
    payload: {
      challanDate: '2026-08-08',
      prefix,
      consignee: { name: 'Scope Store', address: 'Yard 2, Nashik' },
      items: [{ workItemId: itemId, quantity: '5.000' }],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const challanId = created.json<{ challan: { id: string } }>().challan.id;
  const issued = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${challanId}/issue`,
    organisationId,
  });
  expect(issued.statusCode, issued.body).toBe(201);
  return challanId;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-scope-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-scope-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Scope Owner');
  site = await signUp(siteEmail, 'Scope Site');
  viewer = await signUp(viewerEmail, 'Scope Viewer');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Scope Constructions', slug: `scope-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const users = await admin<{ id: string; email: string }[]>`
    select "id", "email" from auth_users
    where "email" like ${`%-${runId}@integration.test`}
  `;
  const byEmail = new Map(users.map((row) => [row.email, row.id]));
  ownerUserId = byEmail.get(ownerEmail) ?? '';
  siteUserId = byEmail.get(siteEmail) ?? '';
  viewerUserId = byEmail.get(viewerEmail) ?? '';
  expect(ownerUserId && siteUserId && viewerUserId).toBeTruthy();

  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
  for (const [email, role] of [
    [siteEmail, 'site'],
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
  // The site member is scoped to assigned Works only.
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId} and user_id = ${siteUserId}
  `;

  const workA = await seedWork(`SCPA${runId.slice(0, 4).toUpperCase()}`);
  const workB = await seedWork(`SCPB${runId.slice(0, 4).toUpperCase()}`);
  workAId = workA.workId;
  itemAId = workA.itemId;
  workBId = workB.workId;
  challanAId = await issueChallanOn(workA.workId, workA.itemId, 'SCPA');
  challanBId = await issueChallanOn(workB.workId, workB.itemId, 'SCPB');

  // Assign the site member to Work A only, through the API.
  const assigned = await authed(owner, {
    method: 'PUT',
    url: `/api/organisations/current/members/${siteUserId}/assignments`,
    organisationId,
    payload: { workIds: [workAId] },
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
}, 60_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId]);
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`
      delete from auth_users where "email" like ${`%-${runId}@integration.test`}
    `;
    await admin.end();
  }
  if (app) await app.close();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('work scope enforcement', () => {
  it('filters the Works list and dashboard to assignments', async () => {
    const list = await authed(site, {
      method: 'GET',
      url: '/api/works',
      organisationId,
    });
    expect(list.statusCode, list.body).toBe(200);
    const works = list.json<{ works: Work[] }>().works;
    expect(works.map((work) => work.id)).toEqual([workAId]);

    const dashboard = await authed(site, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const payload = dashboard.json<DashboardResponse>();
    expect(payload.works.map((work) => work.workId)).toEqual([workAId]);
    expect(payload.totals.works).toBe(1);

    // The owner still sees both.
    const ownerList = await authed(owner, {
      method: 'GET',
      url: '/api/works',
      organisationId,
    });
    expect(ownerList.json<{ works: Work[] }>().works).toHaveLength(2);
  });

  it('answers 404 for guessed ids outside the assignment', async () => {
    const detail = await authed(site, {
      method: 'GET',
      url: `/api/works/${workBId}`,
      organisationId,
    });
    expect(detail.statusCode).toBe(404);

    const balance = await authed(site, {
      method: 'GET',
      url: `/api/works/${workBId}/balance`,
      organisationId,
    });
    expect(balance.statusCode).toBe(404);

    const challan = await authed(site, {
      method: 'GET',
      url: `/api/challans/${challanBId}`,
      organisationId,
    });
    expect(challan.statusCode).toBe(404);

    const receipt = await authed(site, {
      method: 'POST',
      url: `/api/challans/${challanBId}/receipt`,
      organisationId,
      payload: { receivedOn: '2026-08-08', receivedBy: 'Site keeper' },
    });
    expect(receipt.statusCode).toBe(404);

    // The assigned Work stays reachable.
    const assignedDetail = await authed(site, {
      method: 'GET',
      url: `/api/works/${workAId}`,
      organisationId,
    });
    expect(assignedDetail.statusCode, assignedDetail.body).toBe(200);
  });
});

describe('site role evidence permissions', () => {
  it('lets site staff record evidence but not draft documents', async () => {
    const receipt = await authed(site, {
      method: 'POST',
      url: `/api/challans/${challanAId}/receipt`,
      organisationId,
      payload: { receivedOn: '2026-08-08', receivedBy: 'Site keeper' },
    });
    expect(receipt.statusCode, receipt.body).toBe(201);

    // The loose site-measurement register lost its writer (2026-08-19),
    // so what site staff have here is the read. The receipt above is the
    // evidence this role still records.
    const measurement = await authed(site, {
      method: 'GET',
      url: `/api/works/${workAId}/mb-entries`,
      organisationId,
    });
    expect(measurement.statusCode, measurement.body).toBe(200);

    const draft = await authed(site, {
      method: 'POST',
      url: `/api/works/${workAId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        prefix: 'SCP',
        consignee: { name: 'Site Attempt Store', address: 'Yard 2, Nashik 422010' },
        items: [{ workItemId: itemAId, quantity: '1.000' }],
      },
    });
    expect(draft.statusCode).toBe(403);

    const instrument = await authed(site, {
      method: 'POST',
      url: `/api/works/${workAId}/instruments`,
      organisationId,
      payload: {
        kind: 'pbg',
        reference: `BG-SCOPE-${runId}`,
        issuedOn: '2026-01-15',
      },
    });
    expect(instrument.statusCode).toBe(403);
  });

  it('refuses evidence from viewers', async () => {
    const receipt = await authed(viewer, {
      method: 'POST',
      url: `/api/challans/${challanAId}/receipt`,
      organisationId,
      payload: { receivedOn: '2026-08-08', receivedBy: 'Viewer' },
    });
    expect(receipt.statusCode).toBe(403);
    expect(receipt.json<{ code: string }>().code).toBe('ROLE_FORBIDDEN');
  });
});

describe('LOA document scope', () => {
  let confirmedAId: string;
  let confirmedBId: string;
  let unconfirmedId: string;

  beforeAll(async () => {
    confirmedAId = randomUUID();
    confirmedBId = randomUUID();
    unconfirmedId = randomUUID();
    const seed = [
      [confirmedAId, workAId, 'confirmed', 'loa-work-a.pdf'],
      [confirmedBId, workBId, 'confirmed', 'loa-work-b.pdf'],
      [unconfirmedId, null, 'review', 'loa-unconfirmed.pdf'],
    ] as const;
    for (const [id, workId, status, filename] of seed) {
      await admin`
        insert into loa_documents (
          id, organisation_id, object_key, original_filename, sha256,
          media_type, size_bytes, extraction_status, extraction_payload,
          confirmed_work_id, uploaded_by_user_id
        )
        values (
          ${id}, ${organisationId}, ${`${organisationId}/loa/${id}.pdf`},
          ${filename}, ${'c'.repeat(32) + id.replaceAll('-', '')},
          'application/pdf', 1000, ${status},
          ${admin.json({ sourceText: 'SECRET LETTER TEXT' })},
          ${workId}, ${ownerUserId}
        )
      `;
    }
  });

  it('shows writers every document, unconfirmed included', async () => {
    const listed = await authed(owner, {
      method: 'GET',
      url: '/api/loa-documents',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const ids = listed
      .json<{ documents: { id: string }[] }>()
      .documents.map((document) => document.id);
    expect(ids).toContain(confirmedAId);
    expect(ids).toContain(confirmedBId);
    expect(ids).toContain(unconfirmedId);
  });

  it('limits assigned-scope members to their Works, confirmed only', async () => {
    const listed = await authed(site, {
      method: 'GET',
      url: '/api/loa-documents',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const ids = listed
      .json<{ documents: { id: string }[] }>()
      .documents.map((document) => document.id);
    expect(ids).toContain(confirmedAId);
    expect(ids).not.toContain(confirmedBId);
    expect(ids).not.toContain(unconfirmedId);

    // Detail follows the same rule; denials are indistinguishable from
    // absence.
    const allowed = await authed(site, {
      method: 'GET',
      url: `/api/loa-documents/${confirmedAId}`,
      organisationId,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    for (const blockedId of [confirmedBId, unconfirmedId]) {
      const blocked = await authed(site, {
        method: 'GET',
        url: `/api/loa-documents/${blockedId}`,
        organisationId,
      });
      expect(blocked.statusCode).toBe(404);
      expect(blocked.json<{ code: string }>().code).toBe('DOCUMENT_NOT_FOUND');
    }
  });

  it('hides unconfirmed uploads from full-scope readers too', async () => {
    const listed = await authed(viewer, {
      method: 'GET',
      url: '/api/loa-documents',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const ids = listed
      .json<{ documents: { id: string }[] }>()
      .documents.map((document) => document.id);
    expect(ids).toContain(confirmedAId);
    expect(ids).toContain(confirmedBId);
    expect(ids).not.toContain(unconfirmedId);

    const blocked = await authed(viewer, {
      method: 'GET',
      url: `/api/loa-documents/${unconfirmedId}`,
      organisationId,
    });
    expect(blocked.statusCode).toBe(404);
  });
});

describe('assigned-scope LOA confirmation self-assignment', () => {
  // An office member scoped to assigned Works confirms an LOA: the very
  // transaction that creates the Work must also grant the confirmer's
  // assignment, or they 404 on the Work they just created.
  const confirmerEmail = `scope-confirmer-${runId}@integration.test`;
  const allScopeEmail = `scope-fullconf-${runId}@integration.test`;
  let confirmer: CookieJar;
  let allScope: CookieJar;
  let confirmerUserId: string;
  let allScopeUserId: string;
  let confirmedWorkId: string;
  let fullScopeWorkId: string;

  function confirmPayload(code: string) {
    return {
      workCode: code,
      letterNumber: `L-${code}-${runId}`,
      letterDate: '2026-02-01',
      title: `Confirm scope work ${code}`,
      advertisedValue: '50000.00',
      contractValue: '45000.00',
      pricingShape: 'per_schedule',
      schedules: [
        {
          scheduleCode: 'A',
          title: 'Schedule A',
          items: [
            {
              itemNumber: 'A/1',
              description: 'Confirm scope item',
              unitCode: 'Nos',
              awardedQuantity: '10.000',
              effectiveRate: '100.00',
              manualEntry: true,
            },
          ],
        },
      ],
    };
  }

  async function seedReviewDocument(): Promise<string> {
    const id = randomUUID();
    await admin`
      insert into loa_documents (
        id, organisation_id, object_key, original_filename, sha256,
        media_type, size_bytes, extraction_status, extraction_payload,
        uploaded_by_user_id
      )
      values (
        ${id}, ${organisationId}, ${`${organisationId}/loa/${id}.pdf`},
        'confirm-scope.pdf', ${'d'.repeat(32) + id.replaceAll('-', '')},
        'application/pdf', 1000, 'review',
        ${admin.json({ sourceText: 'CONFIRM SCOPE LETTER TEXT' })},
        ${ownerUserId}
      )
    `;
    return id;
  }

  beforeAll(async () => {
    confirmer = await signUp(confirmerEmail, 'Scope Confirmer');
    allScope = await signUp(allScopeEmail, 'Scope Full Confirmer');
    for (const email of [confirmerEmail, allScopeEmail]) {
      const added = await authed(owner, {
        method: 'POST',
        url: '/api/organisations/current/members',
        organisationId,
        payload: { email, role: 'office' },
      });
      expect(added.statusCode, added.body).toBe(201);
    }
    const users = await admin<{ id: string; email: string }[]>`
      select "id", "email" from auth_users
      where "email" in (${confirmerEmail}, ${allScopeEmail})
    `;
    const byEmail = new Map(users.map((row) => [row.email, row.id]));
    confirmerUserId = byEmail.get(confirmerEmail) ?? '';
    allScopeUserId = byEmail.get(allScopeEmail) ?? '';
    expect(confirmerUserId && allScopeUserId).toBeTruthy();
    await admin`
      update organisation_memberships set work_scope = 'assigned'
      where organisation_id = ${organisationId} and user_id = ${confirmerUserId}
    `;
  }, 30_000);

  it('lets the assigned-scope confirmer see the Work they just created', async () => {
    const documentId = await seedReviewDocument();
    const code = `CFA${runId.slice(0, 4).toUpperCase()}`;
    const confirmed = await authed(confirmer, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: confirmPayload(code),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    confirmedWorkId = confirmed.json<{ work: Work }>().work.id;

    // Immediately reachable: detail, list, dashboard, and balance.
    const detail = await authed(confirmer, {
      method: 'GET',
      url: `/api/works/${confirmedWorkId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);

    const list = await authed(confirmer, {
      method: 'GET',
      url: '/api/works',
      organisationId,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ works: Work[] }>().works.map((work) => work.id)).toContain(
      confirmedWorkId,
    );

    const dashboard = await authed(confirmer, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    expect(
      dashboard.json<DashboardResponse>().works.map((work) => work.workId),
    ).toContain(confirmedWorkId);

    const balance = await authed(confirmer, {
      method: 'GET',
      url: `/api/works/${confirmedWorkId}/balance`,
      organisationId,
    });
    expect(balance.statusCode, balance.body).toBe(200);
  });

  it('records exactly one assignment row, matching the owner-managed shape', async () => {
    const rows = await admin<
      { user_id: string; created_by_user_id: string; organisation_id: string }[]
    >`
      select user_id, created_by_user_id, organisation_id
      from work_assignments where work_id = ${confirmedWorkId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(confirmerUserId);
    expect(rows[0]?.created_by_user_id).toBe(confirmerUserId);
    expect(rows[0]?.organisation_id).toBe(organisationId);
  });

  it('audits the self-assignment like owner-managed assignment writes', async () => {
    const events = await admin<
      { action: string; entity_type: string; details: unknown }[]
    >`
      select action, entity_type, details from audit_events
      where organisation_id = ${organisationId}
        and action = 'membership.assignments_set'
        and details->>'memberUserId' = ${confirmerUserId}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]?.entity_type).toBe('work_assignments');
    const details = events[0]?.details as {
      memberUserId: string;
      before: { workIds: string[] };
      after: { workIds: string[] };
    };
    expect(details.before.workIds).toEqual([]);
    expect(details.after.workIds).toEqual([confirmedWorkId]);
  });

  it('creates no assignment row when a full-scope member confirms', async () => {
    const documentId = await seedReviewDocument();
    const code = `CFB${runId.slice(0, 4).toUpperCase()}`;
    const confirmed = await authed(allScope, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: confirmPayload(code),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    fullScopeWorkId = confirmed.json<{ work: Work }>().work.id;

    const [count] = await admin<{ count: string }[]>`
      select count(*)::text as count from work_assignments
      where work_id = ${fullScopeWorkId}
    `;
    expect(count?.count).toBe('0');

    // Full scope still sees it, no assignment needed.
    const detail = await authed(allScope, {
      method: 'GET',
      url: `/api/works/${fullScopeWorkId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
  });

  it('grants only the created Work — other Works stay invisible', async () => {
    const blocked = await authed(confirmer, {
      method: 'GET',
      url: `/api/works/${fullScopeWorkId}`,
      organisationId,
    });
    expect(blocked.statusCode).toBe(404);

    const list = await authed(confirmer, {
      method: 'GET',
      url: '/api/works',
      organisationId,
    });
    const ids = list.json<{ works: Work[] }>().works.map((work) => work.id);
    expect(ids).toContain(confirmedWorkId);
    expect(ids).not.toContain(fullScopeWorkId);
    expect(ids).not.toContain(workBId);
  });

  it('stays single-grant under simultaneous confirms of one document', async () => {
    const documentId = await seedReviewDocument();
    const codeBase = `CFC${runId.slice(0, 4).toUpperCase()}`;
    const [first, second] = await Promise.all([
      authed(confirmer, {
        method: 'POST',
        url: `/api/loa-documents/${documentId}/confirm`,
        organisationId,
        payload: confirmPayload(`${codeBase}1`),
      }),
      authed(confirmer, {
        method: 'POST',
        url: `/api/loa-documents/${documentId}/confirm`,
        organisationId,
        payload: confirmPayload(`${codeBase}2`),
      }),
    ]);
    const responses = [first, second].sort((a, b) => a.statusCode - b.statusCode);
    expect(responses[0]?.statusCode, responses[0]?.body).toBe(201);
    expect(responses[1]?.statusCode, responses[1]?.body).toBe(409);
    expect(responses[1]?.json<{ code: string }>().code).toBe('DOCUMENT_NOT_REVIEWABLE');

    const winnerWorkId = responses[0]?.json<{ work: Work }>().work.id ?? '';
    const rows = await admin<{ user_id: string }[]>`
      select user_id from work_assignments where work_id = ${winnerWorkId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(confirmerUserId);
  });
});

describe('member lifecycle', () => {
  it('updates role, scope, and authorities, audited and owner-only', async () => {
    const denied = await authed(viewer, {
      method: 'PATCH',
      url: `/api/organisations/current/members/${siteUserId}`,
      organisationId,
      payload: { role: 'owner' },
    });
    expect(denied.statusCode).toBe(403);

    const updated = await authed(owner, {
      method: 'PATCH',
      url: `/api/organisations/current/members/${viewerUserId}`,
      organisationId,
      payload: { role: 'office', canIssueDocuments: true },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const member = updated
      .json<{
        members: { userId: string; role: string; canIssueDocuments: boolean }[];
      }>()
      .members.find((candidate) => candidate.userId === viewerUserId);
    expect(member?.role).toBe('office');
    expect(member?.canIssueDocuments).toBe(true);
  });

  it('protects the last active owner', async () => {
    const demote = await authed(owner, {
      method: 'PATCH',
      url: `/api/organisations/current/members/${ownerUserId}`,
      organisationId,
      payload: { role: 'office' },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json<{ code: string }>().code).toBe('LAST_OWNER');

    const disable = await authed(owner, {
      method: 'PATCH',
      url: `/api/organisations/current/members/${ownerUserId}`,
      organisationId,
      payload: { status: 'disabled' },
    });
    expect(disable.statusCode).toBe(409);
  });

  it('cuts off a disabled member immediately', async () => {
    const disabled = await authed(owner, {
      method: 'PATCH',
      url: `/api/organisations/current/members/${viewerUserId}`,
      organisationId,
      payload: { status: 'disabled' },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);

    const attempt = await authed(viewer, {
      method: 'GET',
      url: '/api/works',
      organisationId,
    });
    expect(attempt.statusCode).toBe(403);

    // Re-enable for cleanliness; access returns.
    const enabled = await authed(owner, {
      method: 'PATCH',
      url: `/api/organisations/current/members/${viewerUserId}`,
      organisationId,
      payload: { status: 'active' },
    });
    expect(enabled.statusCode).toBe(200);
    const restored = await authed(viewer, {
      method: 'GET',
      url: '/api/works',
      organisationId,
    });
    expect(restored.statusCode).toBe(200);
  });

  it('manages assignments as a replace-set with existence checks', async () => {
    const listed = await authed(owner, {
      method: 'GET',
      url: `/api/organisations/current/members/${siteUserId}/assignments`,
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ workIds: string[] }>().workIds).toEqual([workAId]);

    const bogus = await authed(owner, {
      method: 'PUT',
      url: `/api/organisations/current/members/${siteUserId}/assignments`,
      organisationId,
      payload: { workIds: [randomUUID()] },
    });
    expect(bogus.statusCode).toBe(404);

    const both = await authed(owner, {
      method: 'PUT',
      url: `/api/organisations/current/members/${siteUserId}/assignments`,
      organisationId,
      payload: { workIds: [workAId, workBId] },
    });
    expect(both.statusCode, both.body).toBe(200);
    expect(both.json<{ workIds: string[] }>().workIds).toHaveLength(2);

    // Work B becomes visible to the site member at once.
    const detail = await authed(site, {
      method: 'GET',
      url: `/api/works/${workBId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
  });
});

describe('last-owner concurrency', () => {
  it('never lets simultaneous demotions strip the final active owner', async () => {
    // Promote the (by now office-role) viewer to a second owner so the
    // organisation has exactly two, then have each owner demote the
    // other at the same time. Without the organisation row lock both
    // requests observed two owners and both proceeded — zero owners
    // (external re-audit). With it, exactly one demotion wins.
    const promoted = await authed(owner, {
      method: 'PATCH',
      url: `/api/organisations/current/members/${viewerUserId}`,
      organisationId,
      payload: { role: 'owner' },
    });
    expect(promoted.statusCode, promoted.body).toBe(200);

    const [first, second] = await Promise.all([
      authed(owner, {
        method: 'PATCH',
        url: `/api/organisations/current/members/${viewerUserId}`,
        organisationId,
        payload: { role: 'office' },
      }),
      authed(viewer, {
        method: 'PATCH',
        url: `/api/organisations/current/members/${ownerUserId}`,
        organisationId,
        payload: { role: 'office' },
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses[0], `${first.body} | ${second.body}`).toBe(200);
    // The loser is refused: LAST_OWNER if it re-checked the count, or
    // OWNER_REQUIRED if it was itself the demoted owner; never a second
    // success.
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    const [owners] = await admin<{ count: string }[]>`
      select count(*)::text as count from organisation_memberships
      where organisation_id = ${organisationId}
        and role = 'owner' and status = 'active'
    `;
    expect(Number(owners?.count ?? '0')).toBe(1);
  });
});
