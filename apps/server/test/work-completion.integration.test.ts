import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  DashboardResponse,
  ExtensionRequestDetailResponse,
  IssueChallanDetailResponse,
  MeasurementBookDetailResponse,
  TimelineResponse,
  UnfinishedWorkItem,
  WorkCompletionBlocker,
  WorkCompletionReadiness,
  WorkStatusResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, jsonb, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * R8 work completion, reopen, and short closure (Milestone 6/7 retrofit,
 * migration 0031): the per-payment-category 100%-executed predicate in
 * exact SQL, the adopted clean-state refusals, the completed-Work
 * document freeze at both the API and the database, the works-row lock
 * serialising completion against in-flight writers, and the audit trail
 * on both transitions.
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
const ownerEmail = `wc-owner-${runId}@integration.test`;
const officeEmail = `wc-office-${runId}@integration.test`;
const siteEmail = `wc-site-${runId}@integration.test`;
const viewerEmail = `wc-viewer-${runId}@integration.test`;
const scopedEmail = `wc-scoped-${runId}@integration.test`;
const outsiderEmail = `wc-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let consigneeId: string;
let workId: string;
let scheduleId: string;
let workCode: string;
// The predicate matrix: one item per category branch.
let supplyItemId: string; // SUPPLY, awarded 10
let spareItemId: string; // SPARE_SUPPLY, awarded 4
let installItemId: string; // PURE_INSTALLATION, awarded 3
let bothItemId: string; // SUPPLY_AND_INSTALLATION, awarded 2
let uncatInstallItemId: string; // uncategorised, description mentions Installation
let uncatSupplyItemId: string; // uncategorised, description does not
let deletedItemId: string; // soft-deleted, must be invisible to the predicate
let amendedItemId: string; // effective_quantity overlay 3 over awarded 8
let completionDate: string;
// Issued documents on the fixture Work, the targets the completed-Work
// correction and cancellation refusals need.
let issuedChallanId: string;
let issuedIssueChallanId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
let site: CookieJar;
let viewer: CookieJar;
let scoped: CookieJar;
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

async function complete(
  jar: CookieJar = owner,
  note = 'Every sanctioned quantity is executed and accepted at site.',
  targetWorkId = workId,
  organisation = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/works/${targetWorkId}/complete`,
    organisationId: organisation,
    payload: { note },
  });
}

async function reopen(
  jar: CookieJar = owner,
  note = 'The railway sanctioned additional quantities under variation order 7.',
  targetWorkId = workId,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/works/${targetWorkId}/reopen`,
    organisationId,
    payload: { note },
  });
}

function unfinishedBy(response: { json: <T>() => T }): Map<string, UnfinishedWorkItem> {
  const body = response.json<{ details: { unfinishedItems: UnfinishedWorkItem[] } }>();
  return new Map(body.details.unfinishedItems.map((item) => [item.itemNumber, item]));
}

function blockersOf(response: { json: <T>() => T }): readonly WorkCompletionBlocker[] {
  return response.json<{ details: { blockers: WorkCompletionBlocker[] } }>().details
    .blockers;
}

async function workStatus(targetWorkId = workId): Promise<string> {
  const [row] = await admin<{ status: string }[]>`
    select status from works where id = ${targetWorkId}
  `;
  return row?.status ?? 'missing';
}

/** Inserts a row with triggers disabled — the only way to place a draft
 * document behind a completed Work, which the product itself refuses at
 * every layer. Used to prove the guards on the transitions that need a
 * pre-existing draft. */
async function withTriggersOff(run: () => Promise<void>): Promise<void> {
  await admin.unsafe(`set session_replication_role = 'replica'`);
  try {
    await run();
  } finally {
    await admin.unsafe(`set session_replication_role = 'origin'`);
  }
}

async function recordInstallation(workItemId: string, quantity: string) {
  return authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/installations`,
    organisationId,
    payload: {
      workItemId,
      quantity,
      installedOn: '2026-08-05',
      newLocation: { name: `Site ${runId}`, kind: 'installation_point' },
    },
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-work-completion-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the work-completion integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-wc-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'WC Owner');
  office = await signUp(officeEmail, 'WC Office');
  site = await signUp(siteEmail, 'WC Site');
  viewer = await signUp(viewerEmail, 'WC Viewer');
  scoped = await signUp(scopedEmail, 'WC Scoped');
  outsider = await signUp(outsiderEmail, 'WC Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'WC Constructions', slug: `wc-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'WC Outsiders', slug: `wc-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [officeEmail, 'office'],
    [siteEmail, 'site'],
    [viewerEmail, 'viewer'],
    [scopedEmail, 'office'],
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
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true,
        can_approve_amendments = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
  // The scoped member sees only the Works it is assigned to — and it is
  // assigned to none, so every Work-addressed call must 404.
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId}
      and user_id = (select "id" from auth_users where "email" = ${scopedEmail})
  `;

  workId = randomUUID();
  scheduleId = randomUUID();
  workCode = `WCW${runId.slice(0, 5).toUpperCase()}`;
  supplyItemId = randomUUID();
  spareItemId = randomUUID();
  installItemId = randomUUID();
  bothItemId = randomUUID();
  uncatInstallItemId = randomUUID();
  uncatSupplyItemId = randomUUID();
  deletedItemId = randomUUID();
  amendedItemId = randomUUID();

  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${workCode}, ${`wc-letter-${runId}`},
      '2025-06-01', 'Completion predicate fixture work',
      5000.00, 4500.00, 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, payment_category,
      effective_quantity, deleted_at
    )
    values
      (${supplyItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
       'Signalling cable, 6 core', 'Mtr', 10.000, 100.00, 'SUPPLY', null, null),
      (${spareItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/2',
       'Spare relay set', 'Nos', 4.000, 200.00, 'SPARE_SUPPLY', null, null),
      (${installItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/3',
       'Laying and testing of cable', 'Mtr', 3.000, 50.00,
       'PURE_INSTALLATION', null, null),
      (${bothItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/4',
       'Point machine with erection', 'Nos', 2.000, 900.00,
       'SUPPLY_AND_INSTALLATION', null, null),
      (${uncatInstallItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/5',
       'Erection and Installation of masts', 'Nos', 5.000, 300.00, null, null, null),
      (${uncatSupplyItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/6',
       'Supply of cable drums', 'Nos', 6.000, 400.00, null, null, null),
      (${deletedItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/7',
       'Withdrawn item', 'Nos', 99.000, 10.00, 'SUPPLY', null, now()),
      (${amendedItemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/8',
       'Trough, amended down', 'Mtr', 8.000, 20.00, 'SUPPLY', 3.000, null)
  `;

  const consignee = await authed(owner, {
    method: 'POST',
    url: '/api/masters/contacts',
    organisationId,
    payload: { designation: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
  });
  expect(consignee.statusCode, consignee.body).toBe(201);
  consigneeId = consignee.json<{ id: string }>().id;

  // A completion date inside the dashboard's 30-day window, so the
  // alert-suppression assertion has something to suppress.
  const [dates] = await admin<{ due: string }[]>`
    select (current_date + 10)::text as due
  `;
  completionDate = dates?.due ?? '2026-08-19';
  const setDate = await authed(owner, {
    method: 'PUT',
    url: `/api/works/${workId}/completion-dates`,
    organisationId,
    payload: { completionDate },
  });
  expect(setDate.statusCode, setDate.body).toBe(200);
}, 90_000);

afterAll(async () => {
  if (admin) {
    for (const orgId of [organisationId, outsiderOrganisationId]) {
      if (orgId === undefined) continue;
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        await admin`delete from audit_events where organisation_id = ${orgId}`;
        await admin`delete from installation_serials where organisation_id = ${orgId}`;
        await admin`delete from installations where organisation_id = ${orgId}`;
        await admin`delete from pac_certificate_items where organisation_id = ${orgId}`;
        await admin`delete from pac_certificates where organisation_id = ${orgId}`;
        await admin`delete from mb_sources where organisation_id = ${orgId}`;
        await admin`delete from measurement_book_lines where organisation_id = ${orgId}`;
        await admin`delete from measurement_books where organisation_id = ${orgId}`;
        await admin`delete from measurement_book_counters where organisation_id = ${orgId}`;
        await admin`delete from approval_requests where organisation_id = ${orgId}`;
        await admin`delete from extension_requests where organisation_id = ${orgId}`;
        await admin`delete from extension_request_counters where organisation_id = ${orgId}`;
        await admin`delete from issue_challan_lines where organisation_id = ${orgId}`;
        await admin`delete from issue_challans where organisation_id = ${orgId}`;
        await admin`delete from issue_challan_counters where organisation_id = ${orgId}`;
        await admin`delete from challan_item_serials where organisation_id = ${orgId}`;
        await admin`delete from delivery_challan_items where organisation_id = ${orgId}`;
        await admin`delete from delivery_challans where organisation_id = ${orgId}`;
        await admin`delete from delivery_challan_counters where organisation_id = ${orgId}`;
        await admin`delete from payment_matrices where organisation_id = ${orgId}`;
        await admin`delete from work_items where organisation_id = ${orgId}`;
        await admin`delete from work_schedules where organisation_id = ${orgId}`;
        await admin`delete from work_assignments where organisation_id = ${orgId}`;
        await admin`delete from works where organisation_id = ${orgId}`;
        await admin`delete from location_masters where organisation_id = ${orgId}`;
        await admin`delete from contacts where organisation_id = ${orgId}`;
        await admin`delete from organisation_memberships where organisation_id = ${orgId}`;
        await admin`delete from organisations where id = ${orgId}`;
      } finally {
        await admin.unsafe(`set session_replication_role = 'origin'`);
      }
    }
    await admin`
      delete from auth_users
      where "email" in (${ownerEmail}, ${officeEmail}, ${siteEmail}, ${viewerEmail},
                        ${scopedEmail}, ${outsiderEmail})
    `;
    await admin.end({ timeout: 5 });
  }
  if (app) await app.close();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
}, 60_000);

describe('the R8 completion predicate', () => {
  it('names every unfinished item with the requirement its category implies', async () => {
    const refused = await complete();
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'WORK_NOT_FULLY_EXECUTED' });
    // Every item here is under-executed, so the message carries only the
    // short-closure instruction — no over-delivery sentence at all.
    expect(refused.json<{ message: string }>().message).toContain(
      'amend those quantities down',
    );
    expect(refused.json<{ message: string }>().message).not.toContain('over-delivered');

    const items = unfinishedBy(refused);
    // The soft-deleted item owes nothing and must not appear.
    expect([...items.keys()].sort()).toEqual([
      'A/1',
      'A/2',
      'A/3',
      'A/4',
      'A/5',
      'A/6',
      'A/8',
    ]);
    expect(items.get('A/1')).toMatchObject({
      category: 'SUPPLY',
      requirement: 'delivery',
      direction: 'short',
      requiredQuantity: '10.000',
      deliveredQuantity: '0.000',
      installedQuantity: '0.000',
    });
    expect(items.get('A/2')).toMatchObject({
      category: 'SPARE_SUPPLY',
      requirement: 'delivery',
    });
    expect(items.get('A/3')).toMatchObject({
      category: 'PURE_INSTALLATION',
      requirement: 'installation',
    });
    expect(items.get('A/4')).toMatchObject({
      category: 'SUPPLY_AND_INSTALLATION',
      requirement: 'delivery_and_installation',
    });
    // Uncategorised resolves from the description, case-insensitively.
    expect(items.get('A/5')).toMatchObject({
      category: null,
      requirement: 'installation',
    });
    expect(items.get('A/6')).toMatchObject({
      category: null,
      requirement: 'delivery',
    });
    // The amendment overlay is the baseline the predicate measures.
    expect(items.get('A/8')).toMatchObject({
      requirement: 'delivery',
      requiredQuantity: '3.000',
    });
  });

  it('answers the same worklist to a question as to an attempt', async () => {
    // The Work page reads this before it offers a completion form, so the
    // two must never disagree: an operator told "nothing outstanding" who
    // is then refused has been lied to by the screen.
    const asked = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/completion-readiness`,
      organisationId,
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const readiness = asked.json<WorkCompletionReadiness>();
    expect(readiness.ready).toBe(false);

    const attempted = await complete();
    expect(attempted.statusCode, attempted.body).toBe(409);
    expect(readiness.unfinished).toEqual([...unfinishedBy(attempted).values()]);
    expect(readiness.blockers).toEqual([]);
  });

  it('lets a read-only member ask, without letting them complete', async () => {
    const asked = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/completion-readiness`,
      organisationId,
    });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json<WorkCompletionReadiness>().ready).toBe(false);
  });

  it('denies the question across a tenant boundary', async () => {
    const asked = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${workId}/completion-readiness`,
      organisationId,
    });
    expect([403, 404]).toContain(asked.statusCode);
  });

  it('refuses while a draft delivery challan holds a claim, naming it', async () => {
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-01',
        prefix: `${workCode}-DC`,
        consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
        items: [
          { workItemId: supplyItemId, quantity: '10' },
          { workItemId: spareItemId, quantity: '4' },
          { workItemId: bothItemId, quantity: '2' },
          { workItemId: uncatSupplyItemId, quantity: '6' },
          { workItemId: amendedItemId, quantity: '3' },
        ],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const challanId = draft.json<ChallanDetailResponse>().challan.id;

    const refused = await complete();
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'WORK_NOT_CLEAN' });
    expect(blockersOf(refused)).toEqual([
      {
        kind: 'draft_delivery_challan',
        recordId: challanId,
        label: 'Draft delivery challan dated 2026-08-01',
      },
    ]);

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    issuedChallanId = challanId;
  });

  it('leaves only the installation-owing items short once delivery is complete', async () => {
    const refused = await complete();
    expect(refused.statusCode, refused.body).toBe(409);
    const items = unfinishedBy(refused);
    expect([...items.keys()].sort()).toEqual(['A/3', 'A/4', 'A/5']);
    expect(items.get('A/4')).toMatchObject({
      requirement: 'delivery_and_installation',
      deliveredQuantity: '2.000',
      installedQuantity: '0.000',
    });
  });

  it('holds exact equality at the boundary — 4.999 of 5.000 is unfinished', async () => {
    for (const [itemId, quantity] of [
      [installItemId, '3'],
      [bothItemId, '2'],
      [uncatInstallItemId, '4.999'],
    ] as const) {
      const recorded = await recordInstallation(itemId, quantity);
      expect(recorded.statusCode, recorded.body).toBe(201);
    }

    const refused = await complete();
    expect(refused.statusCode, refused.body).toBe(409);
    const items = unfinishedBy(refused);
    expect([...items.keys()]).toEqual(['A/5']);
    expect(items.get('A/5')).toMatchObject({
      requiredQuantity: '5.000',
      installedQuantity: '4.999',
    });

    const rest = await recordInstallation(uncatInstallItemId, '0.001');
    expect(rest.statusCode, rest.body).toBe(201);
  });

  it('splits the worklist by direction — over-delivery amends UP, not down', async () => {
    // The predicate is exact equality, so with the R4 excess-delivery
    // toggle on, an over-delivered item is as unfinished as a short one.
    // The remedies are opposite: the R7 floor refuses amending below what
    // was delivered, so "amend those quantities down" is impossible for
    // the over-delivered row and the message must not say it.
    const excessWorkId = randomUUID();
    const excessScheduleId = randomUUID();
    const overItemId = randomUUID();
    const shortItemId = randomUUID();
    const excessCode = `WCE1${runId.slice(0, 4).toUpperCase()}`;
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id,
        allow_excess_delivery
      )
      values (
        ${excessWorkId}, ${organisationId}, ${excessCode}, ${`wc-excess-${runId}`},
        '2025-06-01', 'Excess delivery fixture work', 200.00, 180.00,
        'per_schedule', ${ownerUserId}, true
      )
    `;
    await admin`
      insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
      values (${excessScheduleId}, ${organisationId}, ${excessWorkId}, 'A', 'Schedule A', 1)
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values
        (${overItemId}, ${organisationId}, ${excessWorkId}, ${excessScheduleId},
         'E/1', 'Signalling cable, 6 core', 'Mtr', 5.000, 100.00, 'SUPPLY'),
        (${shortItemId}, ${organisationId}, ${excessWorkId}, ${excessScheduleId},
         'E/2', 'Spare relay set', 'Nos', 4.000, 200.00, 'SUPPLY')
    `;

    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${excessWorkId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-04',
        prefix: `${excessCode}-DC`,
        consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
        // 7 against a sanctioned 5: only the excess toggle permits it.
        items: [{ workItemId: overItemId, quantity: '7' }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draft.json<ChallanDetailResponse>().challan.id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);

    const refused = await complete(
      owner,
      'Attempting closure with one over-delivered and one undelivered item.',
      excessWorkId,
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'WORK_NOT_FULLY_EXECUTED' });

    const items = unfinishedBy(refused);
    expect(items.get('E/1')).toMatchObject({
      direction: 'excess',
      requiredQuantity: '5.000',
      deliveredQuantity: '7.000',
    });
    expect(items.get('E/2')).toMatchObject({
      direction: 'short',
      requiredQuantity: '4.000',
      deliveredQuantity: '0.000',
    });

    const message = refused.json<{ message: string }>().message;
    expect(message).toContain('1 item(s) are short: E/2');
    expect(message).toContain('amend those quantities down');
    expect(message).toContain('1 item(s) are over-delivered: E/1');
    expect(message).toContain('amend the sanctioned quantity up to match the delivery');
    // The short instruction must not be attached to the over-delivered
    // item: the two sentences name disjoint item lists.
    expect(message).not.toMatch(/are short:[^.]*E\/1/);
  });
});

describe('clean-state refusals, each named', () => {
  it('refuses while a draft issue challan exists', async () => {
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/issue-challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-02',
        movementType: 'issue',
        issuedToName: 'SSE/Signal/Bhusawal',
        lines: [{ workItemId: supplyItemId, quantity: '1' }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = draft.json<IssueChallanDetailResponse>().issueChallan.id;

    const refused = await complete();
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'WORK_NOT_CLEAN' });
    expect(blockersOf(refused).map((blocker) => blocker.kind)).toEqual([
      'draft_issue_challan',
    ]);

    // Issued rather than deleted: only the DRAFT blocks completion, and
    // the issued challan then stands as the completed Work's issue-challan
    // correction and cancellation target below.
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${draftId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    issuedIssueChallanId = draftId;
  });

  it('refuses while a draft extension request exists', async () => {
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-03-31',
        reason: 'Cable route diversion delayed the work.',
        addressee: 'Sr. DSTE, Bhusawal',
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = draft.json<ExtensionRequestDetailResponse>().extensionRequest.id;

    const refused = await complete();
    expect(refused.statusCode, refused.body).toBe(409);
    expect(blockersOf(refused).map((blocker) => blocker.kind)).toEqual([
      'draft_extension_request',
    ]);

    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/extension-requests/${draftId}`,
      organisationId,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
  });

  it('refuses while a draft Measurement Book holds claims', async () => {
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-06' },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = draft.json<MeasurementBookDetailResponse>().book.id;

    const refused = await complete();
    expect(refused.statusCode, refused.body).toBe(409);
    expect(blockersOf(refused).map((blocker) => blocker.kind)).toEqual([
      'draft_measurement_book',
    ]);

    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${draftId}`,
      organisationId,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
  });

  it('refuses while an approval request is pending', async () => {
    // Proposed by a member WITHOUT the approval authority, so it stays
    // pending instead of applying directly.
    const proposed = await authed(office, {
      method: 'POST',
      url: `/api/works/${workId}/amendments`,
      organisationId,
      payload: {
        workItemId: supplyItemId,
        reason: 'Variation order 12 may raise the cable quantity.',
        changes: { quantity: '12' },
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const approvalId = proposed.json<{ id: string }>().id;

    const refused = await complete();
    expect(refused.statusCode, refused.body).toBe(409);
    expect(blockersOf(refused).map((blocker) => blocker.kind)).toEqual([
      'pending_approval_request',
    ]);

    const rejected = await authed(owner, {
      method: 'POST',
      url: `/api/approvals/${approvalId}/reject`,
      organisationId,
      payload: { note: 'The variation order was withdrawn.' },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
  });
});

describe('completion authority and scope', () => {
  it('refuses viewers and site members, and hides the Work outside its scope', async () => {
    for (const jar of [viewer, site]) {
      const denied = await complete(jar);
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
    }
    // An 'assigned'-scoped membership with no assignment: 404, never 403.
    const scopedDenied = await complete(scoped);
    expect(scopedDenied.statusCode, scopedDenied.body).toBe(404);
    expect(scopedDenied.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });

    // Cross-tenant: the outsider's own organisation header cannot reach it.
    const foreign = await complete(
      outsider,
      'Cross-tenant attempt.',
      workId,
      outsiderOrganisationId,
    );
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(await workStatus()).toBe('active');
  });

  it('requires a note', async () => {
    const missing = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/complete`,
      organisationId,
      payload: {},
    });
    expect(missing.statusCode, missing.body).toBe(400);
    const tooShort = await complete(owner, 'ok');
    expect(tooShort.statusCode, tooShort.body).toBe(400);
  });
});

describe('completion', () => {
  it('alerts on the approaching completion date while the Work is active', async () => {
    const dashboard = await authed(owner, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const alerts = dashboard.json<DashboardResponse>().alerts;
    expect(
      alerts.some(
        (alert) => alert.kind === 'completion_due' && alert.workId === workId,
      ),
    ).toBe(true);
  });

  it('completes a fully executed, clean Work and records the note', async () => {
    const completed = await complete();
    expect(completed.statusCode, completed.body).toBe(200);
    const { work } = completed.json<WorkStatusResponse>();
    expect(work.status).toBe('completed');
    expect(work.completedAt).not.toBeNull();
    expect(work.completedByUserId).toBe(ownerUserId);
    expect(work.completionNote).toBe(
      'Every sanctioned quantity is executed and accepted at site.',
    );

    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<{ work: { status: string } }>().work.status).toBe('completed');
  });

  it('refuses a second completion', async () => {
    const again = await complete();
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ code: 'WORK_ALREADY_COMPLETED' });
  });

  it('stops the dashboard completion alert', async () => {
    const dashboard = await authed(owner, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const alerts = dashboard.json<DashboardResponse>().alerts;
    expect(
      alerts.some(
        (alert) =>
          (alert.kind === 'completion_due' || alert.kind === 'completion_overdue') &&
          alert.workId === workId,
      ),
    ).toBe(false);
  });

  it('writes the audit event with before/after and shows it on the timeline', async () => {
    const timeline = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/timeline?entityTypes=works`,
      organisationId,
    });
    expect(timeline.statusCode, timeline.body).toBe(200);
    const event = timeline
      .json<TimelineResponse>()
      .events.find((candidate) => candidate.action === 'work.completed');
    expect(event).toBeDefined();
    expect(event?.entityType).toBe('works');
    expect(event?.entityId).toBe(workId);
    expect(event?.details).toMatchObject({
      before: { status: 'active' },
      after: { status: 'completed' },
      note: 'Every sanctioned quantity is executed and accepted at site.',
    });
  });
});

describe('a completed Work accepts no new operational document', () => {
  it('refuses every creation route with WORK_COMPLETED', async () => {
    const attempts: { name: string; response: Awaited<ReturnType<typeof authed>> }[] = [
      {
        name: 'delivery challan draft',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/works/${workId}/challans`,
          organisationId,
          payload: {
            challanDate: '2026-08-07',
            prefix: `${workCode}-DC`,
            consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
            items: [{ workItemId: supplyItemId, quantity: '1' }],
          },
        }),
      },
      {
        name: 'issue challan draft',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/works/${workId}/issue-challans`,
          organisationId,
          payload: {
            challanDate: '2026-08-07',
            movementType: 'issue',
            issuedToName: 'SSE/Signal/Bhusawal',
            lines: [{ workItemId: supplyItemId, quantity: '1' }],
          },
        }),
      },
      {
        name: 'installation record',
        response: await recordInstallation(installItemId, '1'),
      },
      {
        name: 'PAC certificate',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/works/${workId}/pac-certificates`,
          organisationId,
          payload: {
            reference: `PAC-${runId}`,
            issueDate: '2026-08-07',
            consigneeMasterId: consigneeId,
            items: [{ workItemId: installItemId, certifiedQuantity: '1.000' }],
          },
        }),
      },
      {
        name: 'Measurement Book',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/works/${workId}/measurement-books`,
          organisationId,
          payload: { mbDate: '2026-08-07' },
        }),
      },
      {
        name: 'extension request',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/works/${workId}/extension-requests`,
          organisationId,
          payload: {
            proposedCompletionDate: '2027-06-30',
            reason: 'Should never be accepted on a completed Work.',
            addressee: 'Sr. DSTE, Bhusawal',
          },
        }),
      },
      {
        name: 'amendment proposal',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/works/${workId}/amendments`,
          organisationId,
          payload: {
            workItemId: supplyItemId,
            reason: 'Should never be accepted on a completed Work.',
            changes: { quantity: '11' },
          },
        }),
      },
      {
        name: 'add-item amendment proposal',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/works/${workId}/amendments/items`,
          organisationId,
          payload: {
            reason: 'Should never be accepted on a completed Work.',
            scheduleId,
            itemNumber: 'A/9',
            description: 'Lightning arrester, station class',
            unitCode: 'Nos',
            quantity: '4',
            rate: '50.00',
          },
        }),
      },
      {
        name: 'item-removal amendment proposal',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/works/${workId}/amendments/removals`,
          organisationId,
          payload: {
            workItemId: supplyItemId,
            reason: 'Should never be accepted on a completed Work.',
          },
        }),
      },
      {
        name: 'delivery challan cancel-replace correction',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/challans/${issuedChallanId}/corrections/cancel-replace`,
          organisationId,
          payload: {
            reason: 'Should never be accepted on a completed Work.',
            replacement: {
              challanDate: '2026-08-07',
              prefix: `${workCode}-DC`,
              consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
              items: [{ workItemId: supplyItemId, quantity: '10.000' }],
            },
          },
        }),
      },
      {
        name: 'issue challan cancel-replace correction',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/issue-challans/${issuedIssueChallanId}/corrections/cancel-replace`,
          organisationId,
          payload: {
            reason: 'Should never be accepted on a completed Work.',
            replacement: {
              challanDate: '2026-08-07',
              movementType: 'issue',
              issuedToName: 'SSE/Signal/Bhusawal',
              lines: [{ workItemId: supplyItemId, quantity: '1.000' }],
            },
          },
        }),
      },
      {
        name: 'delivery challan correction notice',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/challans/${issuedChallanId}/corrections/notice`,
          organisationId,
          payload: {
            reason: 'Should never be accepted on a completed Work.',
            statement: 'The consignee designation was mis-typed.',
          },
        }),
      },
    ];
    for (const attempt of attempts) {
      expect(
        attempt.response.statusCode,
        `${attempt.name}: ${attempt.response.body}`,
      ).toBe(409);
      expect(attempt.response.json(), attempt.name).toMatchObject({
        code: 'WORK_COMPLETED',
      });
    }
  });

  it('refuses issuing a draft that predates the completion', async () => {
    // The clean-state rule means the product itself can never leave a
    // draft behind a completed Work; the guards still have to hold.
    const draftId = randomUUID();
    const lineId = randomUUID();
    await withTriggersOff(async () => {
      await admin`
        insert into delivery_challans (
          id, organisation_id, work_id, challan_date, prefix,
          consignee_snapshot, created_by_user_id
        )
        values (
          ${draftId}, ${organisationId}, ${workId}, '2026-08-07',
          ${`${workCode}-DCX`},
          ${jsonb(admin, { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' })},
          ${ownerUserId}
        )
      `;
      await admin`
        insert into delivery_challan_items (
          id, organisation_id, delivery_challan_id, work_id, work_item_id,
          description_snapshot, unit_snapshot, quantity, rate_snapshot,
          line_amount, position
        )
        values (
          ${lineId}, ${organisationId}, ${draftId}, ${workId}, ${supplyItemId},
          'Signalling cable, 6 core', 'Mtr', 1.000, 100.00, 100.00, 1
        )
      `;
    });

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draftId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(409);
    expect(issued.json()).toMatchObject({ code: 'WORK_COMPLETED' });

    // The database backstop: the same transition attempted in raw SQL.
    await expect(
      admin`
        update delivery_challans
        set status = 'issued', challan_number = ${`${workCode}-DCX/1`},
            sequence_number = 1, issued_by_user_id = ${ownerUserId},
            issued_at = now()
        where id = ${draftId}
      `,
    ).rejects.toThrowError(/this Work is completed/);

    await withTriggersOff(async () => {
      await admin`delete from delivery_challan_items where id = ${lineId}`;
      await admin`delete from delivery_challans where id = ${draftId}`;
    });
  });

  it('backstops every creation path in the database, not only the route', async () => {
    await expect(
      admin`
        insert into delivery_challans (
          organisation_id, work_id, challan_date, prefix, consignee_snapshot,
          created_by_user_id
        )
        values (
          ${organisationId}, ${workId}, '2026-08-07', ${`${workCode}-SQL`},
          ${jsonb(admin, { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' })},
          ${ownerUserId}
        )
      `,
    ).rejects.toThrowError(/this Work is completed/);

    await expect(
      admin`
        insert into issue_challans (
          organisation_id, work_id, movement_type, challan_date, prefix,
          issued_to_name, created_by_user_id
        )
        values (
          ${organisationId}, ${workId}, 'issue', '2026-08-07',
          ${`${workCode}-ICSQL`}, 'SSE/Signal/Bhusawal', ${ownerUserId}
        )
      `,
    ).rejects.toThrowError(/this Work is completed/);

    const [location] = await admin<{ id: string; name: string }[]>`
      select id, name from location_masters where organisation_id = ${organisationId}
      order by created_at limit 1
    `;
    if (!location) throw new Error('the installation fixture left no location master');
    await expect(
      admin`
        insert into installations (
          organisation_id, work_id, work_item_id, quantity, installed_on,
          location_id, location_name, recorded_by_user_id
        )
        values (
          ${organisationId}, ${workId}, ${installItemId}, 1.000, '2026-08-07',
          ${location.id}, ${location.name}, ${ownerUserId}
        )
      `,
    ).rejects.toThrowError(/this Work is completed/);

    await expect(
      admin`
        insert into pac_certificates (
          organisation_id, work_id, reference, issue_date, consignee_master_id,
          consignee_designation, recorded_by_user_id
        )
        values (
          ${organisationId}, ${workId}, ${`PAC-SQL-${runId}`}, '2026-08-07',
          ${consigneeId}, 'Sr. DEE (G) CR', ${ownerUserId}
        )
      `,
    ).rejects.toThrowError(/this Work is completed/);

    await expect(
      admin`
        insert into measurement_books (
          organisation_id, work_id, mb_date, created_by_user_id
        )
        values (${organisationId}, ${workId}, '2026-08-07', ${ownerUserId})
      `,
    ).rejects.toThrowError(/this Work is completed/);

    await expect(
      admin`
        insert into extension_requests (
          organisation_id, work_id, proposed_completion_date, reason, addressee,
          created_by_user_id
        )
        values (
          ${organisationId}, ${workId}, '2027-06-30', 'Raw SQL attempt.',
          'Sr. DSTE, Bhusawal', ${ownerUserId}
        )
      `,
    ).rejects.toThrowError(/this Work is completed/);

    await expect(
      admin`
        insert into approval_requests (
          organisation_id, entity_type, entity_id, work_id, proposed, diff,
          reason, requested_by_user_id
        )
        values (
          ${organisationId}, 'work_item_amendment', ${supplyItemId}, ${workId},
          ${jsonb(admin, { kind: 'change_item' })}, ${jsonb(admin, [])},
          'Raw SQL attempt.', ${ownerUserId}
        )
      `,
    ).rejects.toThrowError(/this Work is completed/);
  });
});

/**
 * The other half of the freeze (migration 0032). 0031 closed every path
 * that ADDS a document to a completed Work; nothing stopped the evidence
 * the 100%-executed predicate was measured against being cancelled out
 * from under it afterwards. The adopted rule is REFUSE, not auto-reopen:
 * the operator says why the closure was wrong (the reopen note R8 already
 * requires and audits), then cancels.
 *
 * A dedicated Work carries one of each cancellable document so the five
 * refusals are proven independently of the main fixture's state.
 */
describe('a completed Work refuses cancelling the evidence it was closed on', () => {
  let cancelWorkId: string;
  let cancelSupplyItemId: string;
  let cancelIssueItemId: string;
  let cancelInstallItemId: string;
  let cancelBilledItemId: string;
  let cancelChallanId: string;
  let cancelIssueChallanId: string;
  let cancelInstallationId: string;
  let cancelPacId: string;
  let cancelBookId: string;

  async function issueChallanFor(
    prefix: string,
    challanDate: string,
    items: { workItemId: string; quantity: string }[],
  ): Promise<string> {
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${cancelWorkId}/challans`,
      organisationId,
      payload: {
        challanDate,
        prefix,
        consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
        items,
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const id = draft.json<ChallanDetailResponse>().challan.id;
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    return id;
  }

  async function cancelAttempts(): Promise<
    { name: string; response: Awaited<ReturnType<typeof authed>> }[]
  > {
    return [
      {
        name: 'delivery challan cancel',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/challans/${cancelChallanId}/cancel`,
          organisationId,
          payload: { note: 'The consignment was never dispatched.' },
        }),
      },
      {
        name: 'issue challan cancel',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/issue-challans/${cancelIssueChallanId}/cancel`,
          organisationId,
          payload: { note: 'Material was returned to store unissued.' },
        }),
      },
      {
        name: 'installation cancel',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/installations/${cancelInstallationId}/cancel`,
          organisationId,
          payload: { note: 'The mast was dismantled for re-siting.' },
        }),
      },
      {
        name: 'PAC certificate cancel',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/pac-certificates/${cancelPacId}/cancel`,
          organisationId,
          payload: { note: 'The certificate was issued against the wrong item.' },
        }),
      },
      {
        name: 'Measurement Book cancel',
        response: await authed(owner, {
          method: 'POST',
          url: `/api/measurement-books/${cancelBookId}/cancel`,
          organisationId,
          payload: { note: 'The measurements need re-taking.' },
        }),
      },
    ];
  }

  it('completes a Work carrying one of every cancellable document', async () => {
    cancelWorkId = randomUUID();
    const cancelScheduleId = randomUUID();
    cancelSupplyItemId = randomUUID();
    cancelIssueItemId = randomUUID();
    cancelInstallItemId = randomUUID();
    cancelBilledItemId = randomUUID();
    const cancelCode = `WCC1${runId.slice(0, 4).toUpperCase()}`;
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${cancelWorkId}, ${organisationId}, ${cancelCode}, ${`wc-cancel-${runId}`},
        '2025-06-01', 'Cancellation guard fixture work', 900.00, 800.00,
        'per_schedule', ${ownerUserId}
      )
    `;
    await admin`
      insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
      values (${cancelScheduleId}, ${organisationId}, ${cancelWorkId}, 'A', 'Schedule A', 1)
    `;
    // Four items so no two documents contend for the same evidence: the
    // billed challan is the only Measurement Book source, so the other
    // four cancels are never blocked by R19 instead of by R8.
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values
        (${cancelSupplyItemId}, ${organisationId}, ${cancelWorkId}, ${cancelScheduleId},
         'C/1', 'Signalling cable, 6 core', 'Mtr', 2.000, 100.00, 'SUPPLY'),
        (${cancelIssueItemId}, ${organisationId}, ${cancelWorkId}, ${cancelScheduleId},
         'C/2', 'Spare relay set', 'Nos', 3.000, 100.00, 'SUPPLY'),
        (${cancelInstallItemId}, ${organisationId}, ${cancelWorkId}, ${cancelScheduleId},
         'C/3', 'Laying and testing of cable', 'Mtr', 1.000, 50.00,
         'PURE_INSTALLATION'),
        (${cancelBilledItemId}, ${organisationId}, ${cancelWorkId}, ${cancelScheduleId},
         'C/4', 'Trough, RCC', 'Mtr', 1.000, 100.00, 'SUPPLY')
    `;

    cancelChallanId = await issueChallanFor(`${cancelCode}-DC`, '2026-08-01', [
      { workItemId: cancelSupplyItemId, quantity: '2' },
    ]);
    await issueChallanFor(`${cancelCode}-DC`, '2026-08-02', [
      { workItemId: cancelIssueItemId, quantity: '3' },
    ]);
    const billedChallanId = await issueChallanFor(`${cancelCode}-DC`, '2026-08-03', [
      { workItemId: cancelBilledItemId, quantity: '1' },
    ]);

    const issueDraft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${cancelWorkId}/issue-challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-03',
        movementType: 'issue',
        issuedToName: 'SSE/Signal/Bhusawal',
        lines: [{ workItemId: cancelIssueItemId, quantity: '1' }],
      },
    });
    expect(issueDraft.statusCode, issueDraft.body).toBe(201);
    cancelIssueChallanId =
      issueDraft.json<IssueChallanDetailResponse>().issueChallan.id;
    const issueIssued = await authed(owner, {
      method: 'POST',
      url: `/api/issue-challans/${cancelIssueChallanId}/issue`,
      organisationId,
    });
    expect(issueIssued.statusCode, issueIssued.body).toBe(201);

    const installed = await authed(owner, {
      method: 'POST',
      url: `/api/works/${cancelWorkId}/installations`,
      organisationId,
      payload: {
        workItemId: cancelInstallItemId,
        quantity: '1',
        installedOn: '2026-08-04',
        newLocation: { name: `Cancel site ${runId}`, kind: 'installation_point' },
      },
    });
    expect(installed.statusCode, installed.body).toBe(201);
    cancelInstallationId = installed.json<{ id: string }>().id;

    const certificate = await authed(owner, {
      method: 'POST',
      url: `/api/works/${cancelWorkId}/pac-certificates`,
      organisationId,
      payload: {
        reference: `PAC-CANCEL-${runId}`,
        issueDate: '2026-08-04',
        consigneeMasterId: consigneeId,
        items: [{ workItemId: cancelInstallItemId, certifiedQuantity: '1.000' }],
      },
    });
    expect(certificate.statusCode, certificate.body).toBe(201);
    cancelPacId = certificate.json<{ id: string }>().id;

    // The Measurement Book prices its lines through the payment matrix,
    // so the SUPPLY row has to exist before the book can be finalised.
    const matrix = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${cancelWorkId}/payment-matrix/SUPPLY`,
      organisationId,
      payload: {
        pctSupply: '80.00',
        pctInstallation: '10.00',
        pctPac: '0.00',
        pctFinalBill: '10.00',
      },
    });
    expect(matrix.statusCode, matrix.body).toBe(200);

    const book = await authed(owner, {
      method: 'POST',
      url: `/api/works/${cancelWorkId}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-05' },
    });
    expect(book.statusCode, book.body).toBe(201);
    cancelBookId = book.json<MeasurementBookDetailResponse>().book.id;
    const sourced = await authed(owner, {
      method: 'PUT',
      url: `/api/measurement-books/${cancelBookId}/sources`,
      organisationId,
      payload: {
        sources: [{ sourceType: 'delivery_challan', sourceId: billedChallanId }],
      },
    });
    expect(sourced.statusCode, sourced.body).toBe(200);
    const finalized = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${cancelBookId}/finalize`,
      organisationId,
    });
    expect(finalized.statusCode, finalized.body).toBe(200);

    const completed = await complete(
      owner,
      'Every sanctioned quantity is executed, measured and accepted.',
      cancelWorkId,
    );
    expect(completed.statusCode, completed.body).toBe(200);
    expect(await workStatus(cancelWorkId)).toBe('completed');
  });

  it('refuses all five cancel routes, each naming the reopen', async () => {
    for (const attempt of await cancelAttempts()) {
      expect(
        attempt.response.statusCode,
        `${attempt.name}: ${attempt.response.body}`,
      ).toBe(409);
      expect(attempt.response.json(), attempt.name).toMatchObject({
        code: 'WORK_COMPLETED',
      });
      expect(
        attempt.response.json<{ message: string }>().message,
        attempt.name,
      ).toContain('reopen it before cancelling');
    }
  });

  it('backstops every cancel in the database, not only the route', async () => {
    await expect(
      admin`
        update delivery_challans
        set status = 'cancelled', cancelled_by_user_id = ${ownerUserId},
            cancelled_at = now(), cancellation_note = 'Raw SQL attempt.'
        where id = ${cancelChallanId}
      `,
    ).rejects.toThrowError(/this Work is completed/);

    await expect(
      admin`
        update issue_challans
        set status = 'cancelled', cancelled_by_user_id = ${ownerUserId},
            cancelled_at = now(), cancellation_note = 'Raw SQL attempt.'
        where id = ${cancelIssueChallanId}
      `,
    ).rejects.toThrowError(/this Work is completed/);

    await expect(
      admin`
        update installations
        set status = 'cancelled', cancelled_by_user_id = ${ownerUserId},
            cancelled_at = now(), cancellation_note = 'Raw SQL attempt.'
        where id = ${cancelInstallationId}
      `,
    ).rejects.toThrowError(/this Work is completed/);

    await expect(
      admin`
        update pac_certificates
        set status = 'cancelled', cancelled_by_user_id = ${ownerUserId},
            cancelled_at = now(), cancellation_note = 'Raw SQL attempt.'
        where id = ${cancelPacId}
      `,
    ).rejects.toThrowError(/this Work is completed/);

    await expect(
      admin`
        update measurement_books
        set status = 'cancelled', cancelled_by_user_id = ${ownerUserId},
            cancelled_at = now(), cancellation_note = 'Raw SQL attempt.'
        where id = ${cancelBookId}
      `,
    ).rejects.toThrowError(/this Work is completed/);

    // Nothing moved: the refusals are the whole behaviour.
    const [live] = await admin<{ challans: string; installations: string }[]>`
      select
        (select count(*)::text from delivery_challans
          where work_id = ${cancelWorkId} and status = 'issued') as challans,
        (select count(*)::text from installations
          where work_id = ${cancelWorkId} and status = 'recorded') as installations
    `;
    expect(live).toMatchObject({ challans: '3', installations: '1' });
  });

  it('restores every cancel path once the Work is reopened', async () => {
    const reopened = await reopen(
      owner,
      'The consignee rejected the material after closure; the record must be corrected.',
      cancelWorkId,
    );
    expect(reopened.statusCode, reopened.body).toBe(200);

    // Ordered so each cancel meets only the R8 question: the Measurement
    // Book releases its sources first, and the PAC certificate clears
    // before the installation it covers (R18).
    const order: { name: string; url: string; note: string }[] = [
      {
        name: 'Measurement Book',
        url: `/api/measurement-books/${cancelBookId}/cancel`,
        note: 'The measurements need re-taking.',
      },
      {
        name: 'issue challan',
        url: `/api/issue-challans/${cancelIssueChallanId}/cancel`,
        note: 'Material was returned to store unissued.',
      },
      {
        name: 'PAC certificate',
        url: `/api/pac-certificates/${cancelPacId}/cancel`,
        note: 'The certificate was issued against the wrong item.',
      },
      {
        name: 'installation',
        url: `/api/installations/${cancelInstallationId}/cancel`,
        note: 'The mast was dismantled for re-siting.',
      },
      {
        name: 'delivery challan',
        url: `/api/challans/${cancelChallanId}/cancel`,
        note: 'The consignment was never dispatched.',
      },
    ];
    for (const step of order) {
      const cancelled = await authed(owner, {
        method: 'POST',
        url: step.url,
        organisationId,
        payload: { note: step.note },
      });
      expect(cancelled.statusCode, `${step.name}: ${cancelled.body}`).toBe(200);
    }

    // And the Work is now genuinely short — the state R8 refused to let
    // the completion columns outlive.
    const refused = await complete(
      owner,
      'Completion must not be available while the record is short again.',
      cancelWorkId,
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'WORK_NOT_FULLY_EXECUTED' });
    const items = unfinishedBy(refused);
    expect(items.get('C/1')).toMatchObject({
      direction: 'short',
      deliveredQuantity: '0.000',
    });
    expect(items.get('C/3')).toMatchObject({
      direction: 'short',
      installedQuantity: '0.000',
    });
  });
});

describe('the works status transition guard', () => {
  it('refuses a completion without a note, a cancellation, and drifting state', async () => {
    await expect(
      admin`
        update works set status = 'active', completed_at = null,
                         completed_by_user_id = null, completion_note = null
        where id = ${workId}
      `,
    ).rejects.toThrowError(/reopening a Work takes a note/);

    await expect(
      admin`update works set status = 'cancelled' where id = ${workId}`,
    ).rejects.toThrowError(/Work cancellation is not implemented/);

    await expect(
      admin`
        update works set completion_note = 'edited behind the transition'
        where id = ${workId}
      `,
    ).rejects.toThrowError(/completion state changes only with the Work status/);
  });
});

describe('reopen', () => {
  it('refuses viewers, site members, and out-of-scope callers', async () => {
    for (const jar of [viewer, site]) {
      const denied = await reopen(jar);
      expect(denied.statusCode, denied.body).toBe(403);
    }
    const scopedDenied = await reopen(scoped);
    expect(scopedDenied.statusCode, scopedDenied.body).toBe(404);
    expect(await workStatus()).toBe('completed');
  });

  it('reopens with a note, clears the completion state, and audits it', async () => {
    const reopened = await reopen();
    expect(reopened.statusCode, reopened.body).toBe(200);
    const { work } = reopened.json<WorkStatusResponse>();
    expect(work.status).toBe('active');
    expect(work.completedAt).toBeNull();
    expect(work.completionNote).toBeNull();

    const [row] = await admin<{ reopen_note: string | null }[]>`
      select reopen_note from works where id = ${workId}
    `;
    expect(row?.reopen_note).toBe(
      'The railway sanctioned additional quantities under variation order 7.',
    );

    const timeline = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/timeline?entityTypes=works`,
      organisationId,
    });
    const event = timeline
      .json<TimelineResponse>()
      .events.find((candidate) => candidate.action === 'work.reopened');
    expect(event?.details).toMatchObject({
      before: { status: 'completed' },
      after: { status: 'active' },
    });
  });

  it('refuses reopening an active Work', async () => {
    const again = await reopen();
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ code: 'WORK_NOT_COMPLETED' });
  });

  it('restores every operational path', async () => {
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        prefix: `${workCode}-DC`,
        consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
        items: [{ workItemId: supplyItemId, quantity: '1' }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const challanId = draft.json<ChallanDetailResponse>().challan.id;
    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/challans/${challanId}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(204);

    const book = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-08' },
    });
    expect(book.statusCode, book.body).toBe(201);
    const bookId = book.json<MeasurementBookDetailResponse>().book.id;
    const bookRemoved = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${bookId}`,
      organisationId,
    });
    expect(bookRemoved.statusCode, bookRemoved.body).toBe(204);

    const extension = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: '2027-06-30',
        reason: 'Reopened for the sanctioned variation.',
        addressee: 'Sr. DSTE, Bhusawal',
      },
    });
    expect(extension.statusCode, extension.body).toBe(201);
    const extensionId =
      extension.json<ExtensionRequestDetailResponse>().extensionRequest.id;
    const extensionRemoved = await authed(owner, {
      method: 'DELETE',
      url: `/api/extension-requests/${extensionId}`,
      organisationId,
    });
    expect(extensionRemoved.statusCode, extensionRemoved.body).toBe(204);

    const certificate = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/pac-certificates`,
      organisationId,
      payload: {
        reference: `PAC-REOPEN-${runId}`,
        issueDate: '2026-08-08',
        consigneeMasterId: consigneeId,
        items: [{ workItemId: installItemId, certifiedQuantity: '1.000' }],
      },
    });
    expect(certificate.statusCode, certificate.body).toBe(201);

    // Every proposal path, filed by a member without the approval
    // authority so each one lands pending and is then withdrawn.
    const proposals: { name: string; response: Awaited<ReturnType<typeof authed>> }[] =
      [
        {
          name: 'amendment proposal',
          response: await authed(office, {
            method: 'POST',
            url: `/api/works/${workId}/amendments`,
            organisationId,
            payload: {
              workItemId: supplyItemId,
              reason: 'Variation order 12, resubmitted after the reopen.',
              changes: { quantity: '12' },
            },
          }),
        },
        {
          name: 'item-removal amendment proposal',
          response: await authed(office, {
            method: 'POST',
            url: `/api/works/${workId}/amendments/removals`,
            organisationId,
            payload: {
              workItemId: spareItemId,
              reason: 'The spare relay set was dropped from the variation.',
            },
          }),
        },
        {
          name: 'delivery challan cancel-replace correction',
          response: await authed(office, {
            method: 'POST',
            url: `/api/challans/${issuedChallanId}/corrections/cancel-replace`,
            organisationId,
            payload: {
              reason: 'The consignee designation was wrong on the issued copy.',
              replacement: {
                challanDate: '2026-08-08',
                prefix: `${workCode}-DC`,
                consignee: { name: 'Sr. DEE (W) CR', address: 'Bhusawal Division' },
                items: [{ workItemId: supplyItemId, quantity: '10.000' }],
              },
            },
          }),
        },
        {
          name: 'issue challan cancel-replace correction',
          response: await authed(office, {
            method: 'POST',
            url: `/api/issue-challans/${issuedIssueChallanId}/corrections/cancel-replace`,
            organisationId,
            payload: {
              reason: 'Issued to the wrong section engineer.',
              replacement: {
                challanDate: '2026-08-08',
                movementType: 'issue',
                issuedToName: 'SSE/Works/Bhusawal',
                lines: [{ workItemId: supplyItemId, quantity: '1.000' }],
              },
            },
          }),
        },
      ];
    for (const proposal of proposals) {
      expect(
        proposal.response.statusCode,
        `${proposal.name}: ${proposal.response.body}`,
      ).toBe(201);
      const rejected = await authed(owner, {
        method: 'POST',
        url: `/api/approvals/${proposal.response.json<{ id: string }>().id}/reject`,
        organisationId,
        payload: { note: 'Cleaning up the fixture.' },
      });
      expect(rejected.statusCode, `${proposal.name}: ${rejected.body}`).toBe(200);
    }
  });

  it('restores the correction-notice path — it now refuses on its own terms', async () => {
    // Path B needs downstream evidence to exist and this challan has
    // none, so the honest proof of restoration is that the route reaches
    // its OWN refusal instead of answering WORK_COMPLETED.
    const notice = await authed(office, {
      method: 'POST',
      url: `/api/challans/${issuedChallanId}/corrections/notice`,
      organisationId,
      payload: {
        reason: 'The consignee designation was mis-typed.',
        statement: 'Read the consignee as Sr. DEE (W) CR.',
      },
    });
    expect(notice.statusCode, notice.body).toBe(409);
    expect(notice.json()).toMatchObject({ code: 'CORRECTION_USE_CANCEL_REPLACE' });
  });
});

describe('the works row lock serialises completion against in-flight writers', () => {
  it('a concurrent completion and delivery-challan draft cannot both win', async () => {
    const raceWorkId = randomUUID();
    const raceScheduleId = randomUUID();
    const raceItemId = randomUUID();
    const raceCode = `WCR1${runId.slice(0, 4).toUpperCase()}`;
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${raceWorkId}, ${organisationId}, ${raceCode}, ${`wc-race1-${runId}`},
        '2025-06-01', 'Race fixture work', 100.00, 90.00, 'per_schedule',
        ${ownerUserId}
      )
    `;
    await admin`
      insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
      values (${raceScheduleId}, ${organisationId}, ${raceWorkId}, 'A', 'Schedule A', 1)
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values (
        ${raceItemId}, ${organisationId}, ${raceWorkId}, ${raceScheduleId}, 'R/1',
        'Signalling cable, 6 core', 'Mtr', 1.000, 10.00, 'SUPPLY'
      )
    `;
    // Fully delivered before the race, so completion is otherwise legal.
    const seeded = await authed(owner, {
      method: 'POST',
      url: `/api/works/${raceWorkId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-07',
        prefix: `${raceCode}-DC`,
        consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
        items: [{ workItemId: raceItemId, quantity: '1' }],
      },
    });
    expect(seeded.statusCode, seeded.body).toBe(201);
    const seededId = seeded.json<ChallanDetailResponse>().challan.id;
    const seededIssued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${seededId}/issue`,
      organisationId,
    });
    expect(seededIssued.statusCode, seededIssued.body).toBe(201);

    const [completed, drafted] = await Promise.all([
      complete(owner, 'Nothing further is owed on this Work.', raceWorkId),
      authed(owner, {
        method: 'POST',
        url: `/api/works/${raceWorkId}/challans`,
        organisationId,
        payload: {
          challanDate: '2026-08-08',
          prefix: `${raceCode}-DC`,
          consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
          items: [{ workItemId: raceItemId, quantity: '1' }],
        },
      }),
    ]);

    // The works row lock orders the two transactions; whichever commits
    // second sees the other. A completed Work with a live draft challan
    // behind it is the state neither ordering may produce.
    if (completed.statusCode === 200) {
      expect(drafted.statusCode, drafted.body).toBe(409);
      expect(drafted.json()).toMatchObject({ code: 'WORK_COMPLETED' });
    } else {
      expect(completed.statusCode, completed.body).toBe(409);
      expect(completed.json()).toMatchObject({ code: 'WORK_NOT_CLEAN' });
      expect(drafted.statusCode, drafted.body).toBe(201);
    }
    if ((await workStatus(raceWorkId)) === 'completed') {
      const [drafts] = await admin<{ count: string }[]>`
        select count(*)::text as count from delivery_challans
        where work_id = ${raceWorkId} and status = 'draft'
      `;
      expect(drafts?.count).toBe('0');
    }
  });

  it('a concurrent completion and delivery-challan ISSUE cannot both win', async () => {
    // The issue paths are where the works lock was newly added, and the
    // draft is the completion's only blocker — so exactly one side wins:
    // either the issue commits first and the completion then finds a
    // clean, fully delivered Work, or the completion commits first and
    // the issue is refused behind it. A completed Work with that draft
    // still sitting there is the state neither ordering may produce.
    const raceWorkId = randomUUID();
    const raceScheduleId = randomUUID();
    const raceItemId = randomUUID();
    const raceCode = `WCR3${runId.slice(0, 4).toUpperCase()}`;
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${raceWorkId}, ${organisationId}, ${raceCode}, ${`wc-race3-${runId}`},
        '2025-06-01', 'Race fixture work 3', 100.00, 90.00, 'per_schedule',
        ${ownerUserId}
      )
    `;
    await admin`
      insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
      values (${raceScheduleId}, ${organisationId}, ${raceWorkId}, 'A', 'Schedule A', 1)
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values (
        ${raceItemId}, ${organisationId}, ${raceWorkId}, ${raceScheduleId}, 'R/1',
        'Signalling cable, 6 core', 'Mtr', 1.000, 10.00, 'SUPPLY'
      )
    `;
    // The draft covers the whole sanctioned quantity: issuing it makes
    // the Work fully executed, and it is also the one clean-state blocker.
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${raceWorkId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-07',
        prefix: `${raceCode}-DC`,
        consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
        items: [{ workItemId: raceItemId, quantity: '1' }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = draft.json<ChallanDetailResponse>().challan.id;

    const [completed, issued] = await Promise.all([
      complete(owner, 'Nothing further is owed on this Work.', raceWorkId),
      authed(owner, {
        method: 'POST',
        url: `/api/challans/${draftId}/issue`,
        organisationId,
      }),
    ]);

    if (issued.statusCode === 201) {
      // The issue won the works lock. The completion either ran entirely
      // before it (refused: the draft was still a blocker) or entirely
      // after it (accepted: clean and fully delivered).
      if (completed.statusCode === 409) {
        expect(completed.json()).toMatchObject({ code: 'WORK_NOT_CLEAN' });
        expect(blockersOf(completed).map((blocker) => blocker.kind)).toEqual([
          'draft_delivery_challan',
        ]);
      } else {
        expect(completed.statusCode, completed.body).toBe(200);
      }
    } else {
      // The completion won: the issue is refused with the shared code.
      expect(completed.statusCode, completed.body).toBe(200);
      expect(issued.statusCode, issued.body).toBe(409);
      expect(issued.json()).toMatchObject({ code: 'WORK_COMPLETED' });
    }

    const [rows] = await admin<{ drafts: string; status: string }[]>`
      select
        (select count(*)::text from delivery_challans
          where work_id = ${raceWorkId} and status = 'draft') as drafts,
        (select status from works where id = ${raceWorkId}) as status
    `;
    if (rows?.status === 'completed') expect(rows.drafts).toBe('0');
  });

  it('a concurrent completion and PAC recording serialise coherently', async () => {
    const raceWorkId = randomUUID();
    const raceScheduleId = randomUUID();
    const raceItemId = randomUUID();
    const raceCode = `WCR2${runId.slice(0, 4).toUpperCase()}`;
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${raceWorkId}, ${organisationId}, ${raceCode}, ${`wc-race2-${runId}`},
        '2025-06-01', 'Race fixture work 2', 100.00, 90.00, 'per_schedule',
        ${ownerUserId}
      )
    `;
    await admin`
      insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
      values (${raceScheduleId}, ${organisationId}, ${raceWorkId}, 'A', 'Schedule A', 1)
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values (
        ${raceItemId}, ${organisationId}, ${raceWorkId}, ${raceScheduleId}, 'R/1',
        'Laying and testing of cable', 'Mtr', 2.000, 10.00, 'PURE_INSTALLATION'
      )
    `;
    const installed = await authed(owner, {
      method: 'POST',
      url: `/api/works/${raceWorkId}/installations`,
      organisationId,
      payload: {
        workItemId: raceItemId,
        quantity: '2',
        installedOn: '2026-08-05',
        newLocation: { name: `Race site ${runId}`, kind: 'installation_point' },
      },
    });
    expect(installed.statusCode, installed.body).toBe(201);

    const [completed, certified] = await Promise.all([
      complete(owner, 'All installation is executed and accepted.', raceWorkId),
      authed(owner, {
        method: 'POST',
        url: `/api/works/${raceWorkId}/pac-certificates`,
        organisationId,
        payload: {
          reference: `PAC-RACE-${runId}`,
          issueDate: '2026-08-06',
          consigneeMasterId: consigneeId,
          items: [{ workItemId: raceItemId, certifiedQuantity: '1.000' }],
        },
      }),
    ]);

    expect(completed.statusCode, completed.body).toBe(200);
    // The PAC either committed before the completion (201) or found the
    // Work already closed (409) — never a certificate recorded against a
    // Work that was already completed when its transaction started.
    expect([201, 409]).toContain(certified.statusCode);
    if (certified.statusCode === 409) {
      expect(certified.json()).toMatchObject({ code: 'WORK_COMPLETED' });
    }
    expect(await workStatus(raceWorkId)).toBe('completed');
  });
});
