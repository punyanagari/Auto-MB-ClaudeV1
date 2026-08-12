import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { TimelineResponse } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, jsonb, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Milestone 6: before/after capture on UPDATE-shaped audit events, and
 * the per-Work / per-entity timeline read API — scope-filtered, keyset
 * paginated, cross-tenant denied.
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
const ownerEmail = `tl-owner-${runId}@integration.test`;
const siteEmail = `tl-site-${runId}@integration.test`;
const viewerEmail = `tl-viewer-${runId}@integration.test`;
const outsiderEmail = `tl-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let otherOrganisationId: string;
let ownerUserId: string;
let siteUserId: string;
let viewerUserId: string;
let workAId: string;
let workBId: string;
let itemA1Id: string;
let itemA2Id: string;
let challanId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let site: CookieJar;
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

/** jsonb travels as text through the admin pool; tests want the object. */
function asDetails(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return parsed as Record<string, unknown>;
}

async function latestEvent(
  action: string,
): Promise<{ details: Record<string, unknown> }> {
  const [row] = await admin<{ details: unknown }[]>`
    select details from audit_events
    where organisation_id = ${organisationId} and action = ${action}
    order by occurred_at desc, id desc
    limit 1
  `;
  if (!row) throw new Error(`no ${action} audit event recorded`);
  return { details: asDetails(row.details) };
}

async function seedWork(code: string): Promise<{ workId: string; itemIds: string[] }> {
  const workId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${code}, ${`L-${code}`}, '2026-01-10',
      ${`Timeline proof work ${code}`}, '100000.00', '90000.00',
      'per_schedule', ${ownerUserId}
    )
  `;
  const scheduleId = randomUUID();
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  const itemIds = [randomUUID(), randomUUID()];
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number,
      description, unit_code, awarded_quantity, effective_rate
    )
    values
      (${itemIds[0] ?? ''}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
       'Axle counter unit', 'Nos', '100.000', '10.00'),
      (${itemIds[1] ?? ''}, ${organisationId}, ${workId}, ${scheduleId}, 'A/2',
       'Signal cable drum', 'Nos', '50.000', '20.00')
  `;
  // The LOA-confirm flow writes work.created; a directly-seeded fixture
  // records the same event so the timeline covers the whole life cycle.
  await admin`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${ownerUserId}, 'work.created', 'works', ${workId},
      ${jsonb(admin, { workCode: code, scheduleCount: 1, itemCount: 2 })}
    )
  `;
  return { workId, itemIds };
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-timeline-admin',
  });
  await admin`select 1 as ready`;
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-timeline-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Timeline Owner');
  site = await signUp(siteEmail, 'Timeline Site');
  viewer = await signUp(viewerEmail, 'Timeline Viewer');
  outsider = await signUp(outsiderEmail, 'Timeline Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Timeline Constructions', slug: `timeline-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const otherCreated = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Outsider Constructions', slug: `tl-other-${runId}` },
  });
  expect(otherCreated.statusCode, otherCreated.body).toBe(201);
  otherOrganisationId = otherCreated.json<{ id: string }>().id;

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
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId} and user_id = ${siteUserId}
  `;

  const workA = await seedWork(`TLA${runId.slice(0, 4).toUpperCase()}`);
  const workB = await seedWork(`TLB${runId.slice(0, 4).toUpperCase()}`);
  workAId = workA.workId;
  workBId = workB.workId;
  itemA1Id = workA.itemIds[0] ?? '';
  itemA2Id = workA.itemIds[1] ?? '';

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
    for (const org of [organisationId, otherOrganisationId]) {
      if (!org) continue;
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'work_assignments',
          'mb_sources',
          'measurement_book_lines',
          'measurement_book_counters',
          'mb_entries',
          'bills',
          'measurement_books',
          'bill_counters',
          'payment_matrices',
          'challan_item_serials',
          'challan_receipts',
          'work_instruments',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'loa_documents',
          'work_items',
          'work_schedules',
          'works',
          'gst_rates',
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
    await admin`
      delete from auth_users where "email" like ${`%-${runId}@integration.test`}
    `;
    await admin.end();
  }
  if (app) await app.close();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('before/after capture on update-shaped writers', () => {
  it('captures the challan draft update delta, not just key names', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workAId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-01',
        prefix: 'TL',
        consignee: { name: 'Sr. DSTE Store', address: 'Bhusawal Yard' },
        items: [{ workItemId: itemA1Id, quantity: '3.000' }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    challanId = created.json<{ challan: { id: string } }>().challan.id;

    const updated = await authed(owner, {
      method: 'PUT',
      url: `/api/challans/${challanId}`,
      organisationId,
      payload: {
        challanDate: '2026-08-02',
        prefix: 'TL',
        consignee: { name: 'Sr. DSTE Store', address: 'Bhusawal Yard' },
        items: [
          { workItemId: itemA1Id, quantity: '3.000' },
          { workItemId: itemA2Id, quantity: '2.000' },
        ],
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const { details } = await latestEvent('challan.updated');
    expect(details.before).toMatchObject({
      challanDate: '2026-08-01',
      items: [{ workItemId: itemA1Id, quantity: '3.000' }],
    });
    expect(details.after).toMatchObject({
      challanDate: '2026-08-02',
      items: [
        { workItemId: itemA1Id, quantity: '3.000' },
        { workItemId: itemA2Id, quantity: '2.000' },
      ],
    });
    // Unchanged fields stay out of the delta.
    expect(details.before).not.toHaveProperty('prefix');
    expect(details.before).not.toHaveProperty('consignee');
    expect(details).not.toHaveProperty('changed');
  });

  it('captures a membership authority change with old and new values', async () => {
    const updated = await authed(owner, {
      method: 'PATCH',
      url: `/api/organisations/current/members/${viewerUserId}`,
      organisationId,
      payload: { canIssueDocuments: true },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const { details } = await latestEvent('membership.updated');
    expect(details.memberUserId).toBe(viewerUserId);
    expect(details.before).toEqual({ canIssueDocuments: false });
    expect(details.after).toEqual({ canIssueDocuments: true });
  });

  it('captures an organisation profile update delta', async () => {
    const updated = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { address: 'Plot 4, MIDC, Nashik', gstin: '27ABCDE1234F1Z5' },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const { details } = await latestEvent('organisation.profile_updated');
    expect(details.before).toEqual({ address: null, gstin: null });
    expect(details.after).toEqual({
      address: 'Plot 4, MIDC, Nashik',
      gstin: '27ABCDE1234F1Z5',
    });
    // The unchanged name never enters the payload.
    expect(details.before).not.toHaveProperty('name');
  });

  it('captures assignment replace-sets as before/after Work sets', async () => {
    const updated = await authed(owner, {
      method: 'PUT',
      url: `/api/organisations/current/members/${siteUserId}/assignments`,
      organisationId,
      payload: { workIds: [workAId, workBId] },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const { details } = await latestEvent('membership.assignments_set');
    expect(details.memberUserId).toBe(siteUserId);
    expect(details.before).toEqual({ workIds: [workAId] });
    expect(details.after).toEqual({ workIds: [workAId, workBId].sort() });

    // Restore the single-Work assignment for the scope tests below.
    const restored = await authed(owner, {
      method: 'PUT',
      url: `/api/organisations/current/members/${siteUserId}/assignments`,
      organisationId,
      payload: { workIds: [workAId] },
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it('captures instrument status transitions with the previous value', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workAId}/instruments`,
      organisationId,
      payload: {
        kind: 'pbg',
        reference: `BG-TL-${runId}`,
        // A 'pbg' instrument must record the amount it secures.
        amount: '50000.00',
        issuedOn: '2026-02-01',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const instrumentId = created.json<{ id: string }>().id;

    const updated = await authed(owner, {
      method: 'PUT',
      url: `/api/instruments/${instrumentId}`,
      organisationId,
      payload: { status: 'released' },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const { details } = await latestEvent('instrument.updated');
    expect(details.before).toEqual({ status: 'active' });
    expect(details.after).toEqual({ status: 'released' });
  });
});

describe('per-Work timeline read API', () => {
  let allActions: string[];

  it('returns the full recorded flow newest first', async () => {
    // Finish the challan lifecycle: issue → receipt → serials →
    // measurement → bill → submit; a cancel attempt against recorded
    // evidence is refused and therefore never enters the trail.
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);

    const receipt = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/receipt`,
      organisationId,
      payload: { receivedOn: '2026-08-03', receivedBy: 'SSE/Signal/Bhusawal' },
    });
    expect(receipt.statusCode, receipt.body).toBe(201);

    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/challans/${challanId}`,
      organisationId,
    });
    const lineId = detail.json<{ items: { id: string }[] }>().items[0]?.id ?? '';
    const serials = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/serials`,
      organisationId,
      payload: { challanItemId: lineId, serialNumbers: [`SN-${runId}-1`] },
    });
    expect(serials.statusCode, serials.body).toBe(201);

    const measured = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workAId}/mb-entries`,
      organisationId,
      payload: {
        workItemId: itemA1Id,
        deliveryChallanId: challanId,
        measuredQuantity: '1.000',
        measuredOn: '2026-08-04',
      },
    });
    expect(measured.statusCode, measured.body).toBe(201);

    // Stage-wise billing (Milestone 8 phase 2): matrix row seeded
    // directly (no audit event), then draft MB → claim the issued
    // challan → finalize → prepare the bill FROM the finalized MB.
    await admin`
      insert into payment_matrices (
        organisation_id, work_id, category, pct_supply, pct_installation,
        pct_pac, pct_final_bill, created_by_user_id
      )
      values (${organisationId}, ${workAId}, 'UNCATEGORISED', 80.00, 10.00,
              0.00, 10.00, ${ownerUserId})
    `;
    const mbCreated = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workAId}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-05' },
    });
    expect(mbCreated.statusCode, mbCreated.body).toBe(201);
    const mbId = mbCreated.json<{ book: { id: string } }>().book.id;
    const sourcesSet = await authed(owner, {
      method: 'PUT',
      url: `/api/measurement-books/${mbId}/sources`,
      organisationId,
      payload: {
        sources: [{ sourceType: 'delivery_challan', sourceId: challanId }],
      },
    });
    expect(sourcesSet.statusCode, sourcesSet.body).toBe(200);
    const finalized = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mbId}/finalize`,
      organisationId,
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const bill = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mbId}/bill`,
      organisationId,
    });
    expect(bill.statusCode, bill.body).toBe(201);
    const billId = bill.json<{ id: string }>().id;
    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/bills/${billId}/status`,
      organisationId,
      payload: { status: 'submitted' },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);

    const cancelAttempt = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/cancel`,
      organisationId,
      payload: { note: 'Attempted after evidence exists.' },
    });
    expect(cancelAttempt.statusCode).toBe(409);

    const response = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workAId}/timeline`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const timeline = response.json<TimelineResponse>();
    allActions = timeline.events.map((event) => event.action);
    // Newest first: the flow reads backwards, and the refused cancel
    // left no trace.
    expect(allActions).toEqual([
      'bill.submitted',
      'bill.prepared',
      'measurement_book.finalized',
      'measurement_book.sources_updated',
      'measurement_book.created',
      'mb.recorded',
      'serials.recorded',
      'challan.received',
      'challan.issued',
      'instrument.updated',
      'instrument.created',
      'challan.updated',
      'challan.created',
      'work.created',
    ]);
    expect(timeline.nextCursor).toBeNull();

    // Events carry the actor and the update deltas for rendering.
    const updateEvent = timeline.events.find(
      (event) => event.action === 'challan.updated',
    );
    expect(updateEvent?.actorName).toBe('Timeline Owner');
    expect(updateEvent?.details).toMatchObject({
      before: { challanDate: '2026-08-01' },
      after: { challanDate: '2026-08-02' },
    });
  });

  it('filters by entity type via the query parameter', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workAId}/timeline?entityTypes=delivery_challans,bills`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const actions = response.json<TimelineResponse>().events.map((e) => e.action);
    expect(actions).toEqual([
      'bill.submitted',
      'bill.prepared',
      'challan.issued',
      'challan.updated',
      'challan.created',
    ]);

    const unknown = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workAId}/timeline?entityTypes=organisations`,
      organisationId,
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: 'ENTITY_TYPE_INVALID' });
  });

  it('pages stably through the keyset cursor, even as new events land', async () => {
    const firstPage = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workAId}/timeline?limit=4`,
      organisationId,
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    const first = firstPage.json<TimelineResponse>();
    expect(first.events).toHaveLength(4);
    expect(first.nextCursor).toBe(first.events[3]?.id);

    // A new event arriving mid-pagination must not shift older pages.
    await admin`
      insert into audit_events (
        organisation_id, actor_user_id, action, entity_type, entity_id, details
      )
      values (
        ${organisationId}, ${ownerUserId}, 'challan.rendered',
        'delivery_challans', ${challanId}, ${jsonb(admin, { sha256: 'x'.repeat(64) })}
      )
    `;

    const collected = first.events.map((event) => event.id);
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await authed(owner, {
        method: 'GET',
        url: `/api/works/${workAId}/timeline?limit=4&cursor=${cursor}`,
        organisationId,
      });
      expect(page.statusCode, page.body).toBe(200);
      const body = page.json<TimelineResponse>();
      collected.push(...body.events.map((event) => event.id));
      cursor = body.nextCursor;
    }
    // No duplicates, no gaps: the pages reassemble the pre-insert trail
    // exactly, and the mid-pagination insert never leaked into an older
    // page.
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).toHaveLength(allActions.length);

    const fresh = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workAId}/timeline`,
      organisationId,
    });
    const freshEvents = fresh.json<TimelineResponse>().events;
    expect(freshEvents).toHaveLength(allActions.length + 1);
    expect(freshEvents[0]?.action).toBe('challan.rendered');

    const badCursor = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workAId}/timeline?cursor=${randomUUID()}`,
      organisationId,
    });
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json()).toMatchObject({ code: 'CURSOR_INVALID' });
  });

  it('lets viewers read, and scope-filters assigned members', async () => {
    const viewerRead = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workAId}/timeline`,
      organisationId,
    });
    expect(viewerRead.statusCode, viewerRead.body).toBe(200);
    expect(viewerRead.json<TimelineResponse>().events.length).toBeGreaterThan(0);

    const assignedRead = await authed(site, {
      method: 'GET',
      url: `/api/works/${workAId}/timeline`,
      organisationId,
    });
    expect(assignedRead.statusCode, assignedRead.body).toBe(200);

    // Work B sits outside the assignment: the denial is 404, exactly
    // like the Works list scoping (migration 0009 model).
    const outOfScope = await authed(site, {
      method: 'GET',
      url: `/api/works/${workBId}/timeline`,
      organisationId,
    });
    expect(outOfScope.statusCode).toBe(404);
    expect(outOfScope.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });
  });

  it('denies cross-tenant access in both directions', async () => {
    // Foreign organisation header: the membership floor rejects binding.
    const wrongTenant = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${workAId}/timeline`,
      organisationId,
    });
    expect(wrongTenant.statusCode).toBe(403);
    expect(wrongTenant.json()).toMatchObject({ code: 'NOT_A_MEMBER' });

    // Own organisation header, foreign Work id: RLS makes it absent.
    const guessed = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${workAId}/timeline`,
      organisationId: otherOrganisationId,
    });
    expect(guessed.statusCode).toBe(404);
    expect(guessed.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });
  });
});

describe('single-entity history API', () => {
  it("returns one record's history, newest first", async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/audit/entity/delivery_challans/${challanId}`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const actions = response.json<TimelineResponse>().events.map((e) => e.action);
    expect(actions).toEqual([
      'challan.rendered',
      'challan.issued',
      'challan.updated',
      'challan.created',
    ]);
  });

  it('scope-filters and denies cross-tenant probes as 404', async () => {
    const viewerRead = await authed(viewer, {
      method: 'GET',
      url: `/api/audit/entity/delivery_challans/${challanId}`,
      organisationId,
    });
    expect(viewerRead.statusCode, viewerRead.body).toBe(200);

    const crossTenant = await authed(outsider, {
      method: 'GET',
      url: `/api/audit/entity/delivery_challans/${challanId}`,
      organisationId: otherOrganisationId,
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toMatchObject({ code: 'ENTITY_NOT_FOUND' });

    const unknownType = await authed(owner, {
      method: 'GET',
      url: `/api/audit/entity/organisation_memberships/${randomUUID()}`,
      organisationId,
    });
    expect(unknownType.statusCode).toBe(404);
    expect(unknownType.json()).toMatchObject({ code: 'ENTITY_NOT_FOUND' });
  });

  it('hides out-of-scope entities from assigned members', async () => {
    // A challan on the unassigned Work B: drafting one takes writer
    // rights, so seed it directly.
    const foreignChallanId = randomUUID();
    await admin`
      insert into delivery_challans (
        id, organisation_id, work_id, challan_date, prefix,
        consignee_snapshot, created_by_user_id
      )
      values (
        ${foreignChallanId}, ${organisationId}, ${workBId}, '2026-08-01',
        'TLB', ${jsonb(admin, { name: 'Store B', address: 'Yard B' })},
        ${ownerUserId}
      )
    `;
    const blocked = await authed(site, {
      method: 'GET',
      url: `/api/audit/entity/delivery_challans/${foreignChallanId}`,
      organisationId,
    });
    expect(blocked.statusCode).toBe(404);
    expect(blocked.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });

    const allowed = await authed(site, {
      method: 'GET',
      url: `/api/audit/entity/delivery_challans/${challanId}`,
      organisationId,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });
});
