import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  Installation,
  InstallationListResponse,
  InstallationRegisterResponse,
  LocationMaster,
  Serial,
  SerialSearchResponse,
  TimelineResponse,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  createDatabasePool,
  ensureClusterRoles,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Quantity-level installation records (Milestone 7, legacy §5.4 and rules
 * R5/R6/R11): caps in exact SQL arithmetic under row locks, atomic serial
 * attachment, snapshot-on-use locations with inline creation, cancel-with-
 * note releasing serials, and the audit/timeline/export surfaces.
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
const ownerEmail = `inst-owner-${runId}@integration.test`;
const siteEmail = `inst-site-${runId}@integration.test`;
const viewerEmail = `inst-viewer-${runId}@integration.test`;
const outsiderEmail = `inst-outsider-${runId}@integration.test`;
const assignedEmail = `inst-assigned-${runId}@integration.test`;
/** The tenant-wide register's own assigned-scope member. It has one so
 * that suite can narrow a membership without narrowing one another suite
 * in this file already depends on: a describe that mutates shared
 * fixture state makes every later describe depend on the order they
 * happen to run in. */
const registerScopedEmail = `inst-register-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let workId: string;
let itemAId: string; // plain quantity item, awarded 10.000
let itemBId: string; // plain quantity item, awarded 2.000 (cap fixture)
let itemCId: string; // requires_serials, awarded 5.000, delivered 3.000
let issuedChallanId: string;
let stationLocationId: string;
let serialByNumber: Map<string, Serial>;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let site: CookieJar;
let viewer: CookieJar;
let outsider: CookieJar;
let assigned: CookieJar;
let registerScoped: CookieJar;

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

async function refreshSerials(): Promise<void> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/works/${workId}/serials`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  const { serials } = response.json<{ serials: Serial[] }>();
  serialByNumber = new Map(serials.map((serial) => [serial.serialNumber, serial]));
}

function serialId(serialNumber: string): string {
  const serial = serialByNumber.get(serialNumber);
  if (!serial) throw new Error(`serial ${serialNumber} missing from fixture`);
  return serial.id;
}

async function record(
  jar: CookieJar,
  payload: Record<string, unknown>,
  organisation = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/works/${workId}/installations`,
    organisationId: organisation,
    payload,
  });
}

async function listInstallations(): Promise<InstallationListResponse> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/works/${workId}/installations`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<InstallationListResponse>();
}

function summaryOf(
  list: InstallationListResponse,
  workItemId: string,
): string | undefined {
  return list.itemSummaries.find((summary) => summary.workItemId === workItemId)
    ?.installedQuantity;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-installations-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the installation integration tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }

  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-inst-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'INST Owner');
  site = await signUp(siteEmail, 'INST Site');
  viewer = await signUp(viewerEmail, 'INST Viewer');
  outsider = await signUp(outsiderEmail, 'INST Outsider');
  assigned = await signUp(assignedEmail, 'INST Assigned');
  registerScoped = await signUp(registerScopedEmail, 'INST Register Scoped');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'INST Constructions', slug: `inst-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'INST Outsiders', slug: `inst-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [siteEmail, 'site'],
    [viewerEmail, 'viewer'],
    [assignedEmail, 'office'],
    [registerScopedEmail, 'office'],
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
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  workId = randomUUID();
  const scheduleId = randomUUID();
  itemAId = randomUUID();
  itemBId = randomUUID();
  itemCId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`INSTW-${runId.toUpperCase()}`},
      ${`inst-letter-${runId}`}, '2025-06-01', 'Installation fixture work',
      2000.00, 1800.00, 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, requires_serials
    )
    values
      (${itemAId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
       'Cable set', 'Set', 10.000, 250.00, false),
      (${itemBId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/2',
       'Junction box', 'Nos', 2.000, 120.00, false),
      (${itemCId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/3',
       'Main switchboard', 'Nos', 5.000, 100.00, true)
  `;

  // One issued challan delivering C: 3 (serials mandatory before issue)
  // and A: 5 (serials voluntary, recorded post-issue for the
  // wrong-item-serial case).
  const draft = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/challans`,
    organisationId,
    payload: {
      challanDate: '2026-08-01',
      prefix: 'DC',
      consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
      items: [
        { workItemId: itemCId, quantity: '3' },
        { workItemId: itemAId, quantity: '5' },
      ],
    },
  });
  expect(draft.statusCode, draft.body).toBe(201);
  const draftDetail = draft.json<ChallanDetailResponse>();
  issuedChallanId = draftDetail.challan.id;
  const lineC = draftDetail.items.find((item) => item.workItemId === itemCId);
  const lineA = draftDetail.items.find((item) => item.workItemId === itemAId);
  if (!lineC || !lineA) throw new Error('challan lines missing');

  const serialsRecorded = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${issuedChallanId}/serials`,
    organisationId,
    payload: {
      challanItemId: lineC.id,
      serialNumbers: ['SN-C1', 'SN-C2', 'SN-C3'],
    },
  });
  expect(serialsRecorded.statusCode, serialsRecorded.body).toBe(201);

  const issued = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${issuedChallanId}/issue`,
    organisationId,
  });
  expect(issued.statusCode, issued.body).toBe(201);

  const voluntary = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${issuedChallanId}/serials`,
    organisationId,
    payload: { challanItemId: lineA.id, serialNumbers: ['SN-A1'] },
  });
  expect(voluntary.statusCode, voluntary.body).toBe(201);

  // A second, never-issued draft with an (undelivered) serial for C.
  const secondDraft = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/challans`,
    organisationId,
    payload: {
      challanDate: '2026-08-02',
      prefix: 'DC',
      consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
      items: [{ workItemId: itemCId, quantity: '2' }],
    },
  });
  expect(secondDraft.statusCode, secondDraft.body).toBe(201);
  const secondDetail = secondDraft.json<ChallanDetailResponse>();
  const draftLineC = secondDetail.items.find((item) => item.workItemId === itemCId);
  if (!draftLineC) throw new Error('draft challan line missing');
  const draftSerial = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${secondDetail.challan.id}/serials`,
    organisationId,
    payload: { challanItemId: draftLineC.id, serialNumbers: ['SN-C9'] },
  });
  expect(draftSerial.statusCode, draftSerial.body).toBe(201);

  const location = await authed(owner, {
    method: 'POST',
    url: '/api/masters/locations',
    organisationId,
    payload: { name: 'Nashik Road station', kind: 'station' },
  });
  expect(location.statusCode, location.body).toBe(201);
  stationLocationId = location.json<LocationMaster>().id;

  await refreshSerials();
}, 60_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`delete from auth_users where "email" like ${`%-${runId}@integration.test`}`;
    await assertNoForeignKeyOrphans(admin);
  }
  await app?.close();
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('recording installations by quantity', () => {
  it('lets site staff record a quantity against an existing location, viewers denied', async () => {
    const denied = await record(viewer, {
      workItemId: itemAId,
      quantity: '1.000',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
    });
    expect(denied.statusCode).toBe(403);

    const recorded = await record(site, {
      workItemId: itemAId,
      quantity: '2.500',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
      remarks: 'First stretch done',
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const installation = recorded.json<Installation>();
    expect(installation.status).toBe('recorded');
    expect(installation.itemNumber).toBe('A/1');
    expect(installation.quantity).toBe('2.500');
    expect(installation.locationId).toBe(stationLocationId);
    expect(installation.locationName).toBe('Nashik Road station');
    expect(installation.serials).toEqual([]);

    const list = await listInstallations();
    expect(summaryOf(list, itemAId)).toBe('2.500');
    expect(summaryOf(list, itemBId)).toBe('0');
  });

  it('requires exactly one of an existing location or a new one', async () => {
    const neither = await record(site, {
      workItemId: itemAId,
      quantity: '1.000',
      installedOn: '2026-08-05',
    });
    expect(neither.statusCode).toBe(400);
    expect(neither.json<{ code: string }>().code).toBe('LOCATION_CHOICE_INVALID');

    const both = await record(site, {
      workItemId: itemAId,
      quantity: '1.000',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
      newLocation: { name: 'Somewhere', kind: 'other' },
    });
    expect(both.statusCode).toBe(400);
    expect(both.json<{ code: string }>().code).toBe('LOCATION_CHOICE_INVALID');
  });

  it('inline-creates a location, snapshots its name, and reuses an existing active master', async () => {
    const recorded = await record(site, {
      workItemId: itemAId,
      quantity: '1.000',
      installedOn: '2026-08-05',
      newLocation: { name: 'Bhusawal yard', kind: 'installation_point' },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const installation = recorded.json<Installation>();
    expect(installation.locationName).toBe('Bhusawal yard');
    const inlineLocationId = installation.locationId;

    const listed = await authed(owner, {
      method: 'GET',
      url: '/api/masters/locations',
      organisationId,
    });
    expect(listed.statusCode).toBe(200);
    const { locations } = listed.json<{ locations: LocationMaster[] }>();
    expect(
      locations.some(
        (candidate) =>
          candidate.id === inlineLocationId && candidate.name === 'Bhusawal yard',
      ),
    ).toBe(true);

    // A case-insensitive duplicate is a pick, not an error.
    const reused = await record(site, {
      workItemId: itemAId,
      quantity: '0.500',
      installedOn: '2026-08-06',
      newLocation: { name: 'bhusawal YARD', kind: 'installation_point' },
    });
    expect(reused.statusCode, reused.body).toBe(201);
    expect(reused.json<Installation>().locationId).toBe(inlineLocationId);

    // Editing the master afterwards never rewrites the snapshot.
    const renamed = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/locations/${inlineLocationId}`,
      organisationId,
      payload: { name: 'Renamed yard', kind: 'installation_point' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const list = await listInstallations();
    const kept = list.installations.find(
      (candidate) => candidate.id === installation.id,
    );
    expect(kept?.locationName).toBe('Bhusawal yard');

    // A retired master can no longer be picked, by id or by name.
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/locations/${inlineLocationId}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);
    const pickRetired = await record(site, {
      workItemId: itemAId,
      quantity: '1.000',
      installedOn: '2026-08-06',
      locationId: inlineLocationId,
    });
    expect(pickRetired.statusCode).toBe(409);
    expect(pickRetired.json<{ code: string }>().code).toBe('LOCATION_MASTER_RETIRED');
    const nameRetired = await record(site, {
      workItemId: itemAId,
      quantity: '1.000',
      installedOn: '2026-08-06',
      newLocation: { name: 'renamed YARD', kind: 'installation_point' },
    });
    expect(nameRetired.statusCode).toBe(409);
    expect(nameRetired.json<{ code: string }>().code).toBe('LOCATION_MASTER_RETIRED');
  });

  it('holds the R11 date window in the API and in the database', async () => {
    const future = await record(site, {
      workItemId: itemAId,
      quantity: '1.000',
      installedOn: '2027-01-01',
      locationId: stationLocationId,
    });
    expect(future.statusCode).toBe(400);
    expect(future.json<{ code: string }>().code).toBe('INSTALLATION_DATE_FUTURE');

    const early = await record(site, {
      workItemId: itemAId,
      quantity: '1.000',
      installedOn: '2025-05-31',
      locationId: stationLocationId,
    });
    expect(early.statusCode).toBe(400);
    expect(early.json<{ code: string }>().code).toBe('INSTALLATION_DATE_BEFORE_LOA');

    // The 0017 trigger holds the invariant against every writer.
    await expect(
      admin`
        insert into installations (
          organisation_id, work_id, work_item_id, quantity, installed_on,
          location_id, location_name, recorded_by_user_id
        )
        values (
          ${organisationId}, ${workId}, ${itemAId}, '1.000', '2027-01-01',
          ${stationLocationId}, 'Nashik Road station', ${ownerUserId}
        )
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('installation past the sanctioned quantity (R5, owner decision 2026-08-17)', () => {
  /** The item's derived variation flag, read straight from the row. */
  async function pendingVariation(workItemId: string): Promise<boolean> {
    const [item] = await admin<{ pending_variation: boolean }[]>`
      select pending_variation from work_items where id = ${workItemId}
    `;
    if (!item) throw new Error('work item read returned no row');
    return item.pending_variation;
  }

  it('records the excess and flags the item as owing a variation', async () => {
    // Item B is sanctioned 2.000.
    const first = await record(site, {
      workItemId: itemBId,
      quantity: '1.500',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(await pendingVariation(itemBId)).toBe(false);

    // The gang installs a unit the contract has not sanctioned yet. It is
    // recorded — refusing the record would not stop the unit going in —
    // and the item is marked as owing the variation order.
    const over = await record(site, {
      workItemId: itemBId,
      quantity: '1.000',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
    });
    expect(over.statusCode, over.body).toBe(201);
    expect(await pendingVariation(itemBId)).toBe(true);

    const list = await listInstallations();
    expect(summaryOf(list, itemBId)).toBe('2.500');

    // The Work read carries the flag, which is where the Variation tab
    // will find it.
    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const items = detail
      .json<WorkDetailResponse>()
      .schedules.flatMap((schedule) => schedule.items);
    expect(items.find((item) => item.id === itemBId)?.pendingVariation).toBe(true);
    expect(items.find((item) => item.id === itemAId)?.pendingVariation).toBe(false);
  });

  it('clears the flag when the amendment overlay sanctions the excess', async () => {
    // The variation order arrives: the Milestone 6 overlay raises the
    // sanctioned quantity to 3.000, which covers the 2.500 installed.
    await admin`
      update work_items set effective_quantity = 3.000 where id = ${itemBId}
    `;
    expect(await pendingVariation(itemBId)).toBe(false);

    const allowed = await record(site, {
      workItemId: itemBId,
      quantity: '0.500',
      installedOn: '2026-08-06',
      locationId: stationLocationId,
    });
    expect(allowed.statusCode, allowed.body).toBe(201);
    expect(await pendingVariation(itemBId)).toBe(false);

    // …and going over the NEW sanctioned quantity raises it again.
    const over = await record(site, {
      workItemId: itemBId,
      quantity: '0.750',
      installedOn: '2026-08-06',
      locationId: stationLocationId,
    });
    expect(over.statusCode, over.body).toBe(201);
    expect(await pendingVariation(itemBId)).toBe(true);
  });

  it('flags the item exactly once under simultaneous recordings', async () => {
    // Installed 3.750 of effective 3.000, so the flag already stands.
    // Two concurrent recordings both commit — nothing caps them — and the
    // work-item row lock the 0077 trigger takes is what keeps the derived
    // flag from being computed off a stale sum by either of them.
    const [first, second] = await Promise.all([
      record(site, {
        workItemId: itemBId,
        quantity: '0.500',
        installedOn: '2026-08-07',
        locationId: stationLocationId,
      }),
      record(owner, {
        workItemId: itemBId,
        quantity: '0.500',
        installedOn: '2026-08-07',
        locationId: stationLocationId,
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses, `${first.body} | ${second.body}`).toEqual([201, 201]);
    const list = await listInstallations();
    expect(summaryOf(list, itemBId)).toBe('4.750');
    expect(await pendingVariation(itemBId)).toBe(true);
  });

  // The race that raises the flag FROM NOTHING — two recordings that each
  // fit alone and together do not — is proved at the database, where the
  // proof can park one writer on the row lock and watch it wake:
  // packages/db/test/quantity-ceilings.integration.test.ts.

  it('leaves a non-serial item installable beyond what was delivered, as before 0077', async () => {
    // A DECISION, pinned so it is a decision rather than a gap. The
    // delivered floor (R5's second half) has only ever applied to
    // serial-tracked items — Milestone 7 reads "supply-type" through
    // requires_serials, and the recording route says so in its own
    // comment. 0077 did not touch it, and it must not be widened here on
    // the way past: a PURE_INSTALLATION item is never delivered at all,
    // so a blanket delivered cap would make the whole category
    // un-installable. The real refinement is the payment-category one
    // that comment names, which is its own change with its own fixtures.
    //
    // Item A is delivered 5 and not serial-tracked, so installing past
    // the delivery is accepted; what stops it running away is the
    // variation flag, not a refusal.
    const beyondDelivered = await record(site, {
      workItemId: itemAId,
      quantity: '4.000',
      installedOn: '2026-08-08',
      locationId: stationLocationId,
    });
    expect(beyondDelivered.statusCode, beyondDelivered.body).toBe(201);
    const list = await listInstallations();
    // 4.000 from the earlier blocks plus this 4.000, against 5 delivered.
    expect(summaryOf(list, itemAId)).toBe('8.000');
    const [delivered] = await admin<{ total: string }[]>`
      select coalesce(sum(dci.quantity), 0)::text as total
      from delivery_challan_items dci
      join delivery_challans dc on dc.id = dci.delivery_challan_id
      where dci.work_item_id = ${itemAId} and dc.status = 'issued'
    `;
    expect(delivered?.total).toBe('5.000');
    // Sanctioned 10, installed 8.000 — inside the sanction, so no
    // variation either. The two rules are independent.
    expect(await pendingVariation(itemAId)).toBe(false);

    // The serial-tracked half of R5 is untouched and still refuses with
    // INSTALLATION_EXCEEDS_DELIVERY — proved on item C by "caps
    // serialised items at the delivered quantity" further down this file.
  });
});

describe('serial attachment (R6)', () => {
  it('demands exactly one serial per unit for serial-flagged items', async () => {
    const short = await record(site, {
      workItemId: itemCId,
      quantity: '2',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
      serialIds: [serialId('SN-C1')],
    });
    expect(short.statusCode).toBe(409);
    expect(short.json<{ code: string }>().code).toBe('SERIAL_COUNT_MISMATCH');

    const fractional = await record(site, {
      workItemId: itemCId,
      quantity: '1.5',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
      serialIds: [serialId('SN-C1')],
    });
    expect(fractional.statusCode).toBe(409);
    expect(fractional.json<{ code: string }>().code).toBe('SERIAL_COUNT_MISMATCH');

    const none = await record(site, {
      workItemId: itemCId,
      quantity: '1',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
    });
    expect(none.statusCode).toBe(409);
    expect(none.json<{ code: string }>().code).toBe('SERIAL_COUNT_MISMATCH');
  });

  it('refuses serials on unflagged items and serials of another item', async () => {
    const untracked = await record(site, {
      workItemId: itemAId,
      quantity: '1.000',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
      serialIds: [serialId('SN-A1')],
    });
    expect(untracked.statusCode).toBe(409);
    expect(untracked.json<{ code: string }>().code).toBe('SERIALS_NOT_TRACKED');

    const wrongItem = await record(site, {
      workItemId: itemCId,
      quantity: '1',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
      serialIds: [serialId('SN-A1')],
    });
    expect(wrongItem.statusCode).toBe(409);
    expect(wrongItem.json<{ code: string }>().code).toBe('SERIAL_ITEM_MISMATCH');
  });

  it('refuses undelivered serials and installation before the delivery date', async () => {
    const undelivered = await record(site, {
      workItemId: itemCId,
      quantity: '1',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
      serialIds: [serialId('SN-C9')],
    });
    expect(undelivered.statusCode).toBe(409);
    expect(undelivered.json<{ code: string }>().code).toBe('SERIAL_NOT_DELIVERED');

    const tooEarly = await record(site, {
      workItemId: itemCId,
      quantity: '1',
      installedOn: '2026-07-01',
      locationId: stationLocationId,
      serialIds: [serialId('SN-C1')],
    });
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json<{ code: string }>().code).toBe('SERIAL_BEFORE_DELIVERY');
  });

  it('attaches atomically, stamps the per-serial trace, and blocks re-installation', async () => {
    const recorded = await record(site, {
      workItemId: itemCId,
      quantity: '2',
      installedOn: '2026-08-05',
      locationId: stationLocationId,
      serialIds: [serialId('SN-C1'), serialId('SN-C2')],
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const installation = recorded.json<Installation>();
    expect(installation.serials.map((serial) => serial.serialNumber).sort()).toEqual([
      'SN-C1',
      'SN-C2',
    ]);

    await refreshSerials();
    const c1 = serialByNumber.get('SN-C1');
    expect(c1?.installedOn).toBe('2026-08-05');
    expect(c1?.installationId).toBe(installation.id);
    expect(c1?.installationLocation).toBe('Nashik Road station');

    const again = await record(site, {
      workItemId: itemCId,
      quantity: '1',
      installedOn: '2026-08-06',
      locationId: stationLocationId,
      serialIds: [serialId('SN-C1')],
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('SERIAL_ALREADY_INSTALLED');

    // The legacy per-serial surface stays coherent: an attached serial is
    // managed through its installation record.
    const perSerial = await authed(site, {
      method: 'PUT',
      url: `/api/serials/${serialId('SN-C1')}/installation`,
      organisationId,
      payload: { installedOn: '2026-08-07' },
    });
    expect(perSerial.statusCode).toBe(409);
    expect(perSerial.json<{ code: string }>().code).toBe(
      'SERIAL_ATTACHED_TO_INSTALLATION',
    );
  });

  it('caps serialised items at the delivered quantity (Milestone 8 refines the supply-type predicate)', async () => {
    const over = await record(site, {
      workItemId: itemCId,
      quantity: '2',
      installedOn: '2026-08-06',
      locationId: stationLocationId,
      serialIds: [serialId('SN-C3'), serialId('SN-C9')],
    });
    expect(over.statusCode).toBe(409);
    expect(over.json<{ code: string }>().code).toBe('INSTALLATION_EXCEEDS_DELIVERY');
  });

  it('makes double-attachment of one serial impossible under concurrency', async () => {
    const payload = {
      workItemId: itemCId,
      quantity: '1',
      installedOn: '2026-08-06',
      locationId: stationLocationId,
      serialIds: [serialId('SN-C3')],
    };
    const [first, second] = await Promise.all([
      record(site, payload),
      record(owner, payload),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses, `${first.body} | ${second.body}`).toEqual([201, 409]);

    const [attachments] = await admin<{ count: string }[]>`
      select count(*)::text as count from installation_serials
      where challan_item_serial_id = ${serialId('SN-C3')} and released_at is null
    `;
    expect(attachments?.count).toBe('1');
    const list = await listInstallations();
    expect(summaryOf(list, itemCId)).toBe('3.000');
  });
});

describe('cancellation with a mandatory note', () => {
  let cancelTargetId: string;

  it('cancels a record, releases its serials back to the pool, and audits before/after', async () => {
    const list = await listInstallations();
    const target = list.installations.find(
      (candidate) =>
        candidate.status === 'recorded' &&
        candidate.serials.some((serial) => serial.serialNumber === 'SN-C3'),
    );
    if (!target) throw new Error('cancel target missing');
    cancelTargetId = target.id;

    const deniedViewer = await authed(viewer, {
      method: 'POST',
      url: `/api/installations/${cancelTargetId}/cancel`,
      organisationId,
      payload: { note: 'Viewer cannot do this' },
    });
    expect(deniedViewer.statusCode).toBe(403);

    const missingNote = await authed(site, {
      method: 'POST',
      url: `/api/installations/${cancelTargetId}/cancel`,
      organisationId,
      payload: {},
    });
    expect(missingNote.statusCode).toBe(400);

    const cancelled = await authed(site, {
      method: 'POST',
      url: `/api/installations/${cancelTargetId}/cancel`,
      organisationId,
      payload: { note: 'Recorded against the wrong span' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const installation = cancelled.json<Installation>();
    expect(installation.status).toBe('cancelled');
    expect(installation.cancellationNote).toBe('Recorded against the wrong span');
    // The attachment history stays on the cancelled record.
    expect(installation.serials.map((serial) => serial.serialNumber)).toEqual([
      'SN-C3',
    ]);

    await refreshSerials();
    const released = serialByNumber.get('SN-C3');
    expect(released?.installedOn).toBeNull();
    expect(released?.installationId).toBeNull();

    const after = await listInstallations();
    expect(summaryOf(after, itemCId)).toBe('2.000');

    const again = await authed(site, {
      method: 'POST',
      url: `/api/installations/${cancelTargetId}/cancel`,
      organisationId,
      payload: { note: 'Second attempt' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('INSTALLATION_ALREADY_CANCELLED');
  });

  it('freezes installation records against edits and deletes in the database', async () => {
    const list = await listInstallations();
    const recorded = list.installations.find(
      (candidate) => candidate.status === 'recorded',
    );
    if (!recorded) throw new Error('recorded installation missing');

    await expect(
      admin`update installations set quantity = 999 where id = ${recorded.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      admin`delete from installations where id = ${recorded.id}`,
    ).rejects.toThrow(/never deleted/);
    await expect(
      admin`
        update installations set status = 'recorded', cancellation_note = null,
          cancelled_by_user_id = null, cancelled_at = null
        where id = ${cancelTargetId}
      `,
    ).rejects.toThrow(/immutable/);
    // A released attachment can never be re-attached.
    await expect(
      admin`
        update installation_serials set released_at = null
        where installation_id = ${cancelTargetId}
      `,
    ).rejects.toThrow(/re-attached/);
  });

  it('refuses a cancellation without a note at the database (0023 NULL-proof CHECK)', async () => {
    const list = await listInstallations();
    const recorded = list.installations.find(
      (candidate) => candidate.status === 'recorded',
    );
    if (!recorded) throw new Error('recorded installation missing');
    // With the pre-0023 CHECK this passed: length(btrim(NULL)) is NULL and
    // NULL OR FALSE satisfies a CHECK. Now the NOT NULL conjunct holds.
    await expect(
      admin`
        update installations
        set status = 'cancelled', cancelled_at = now(),
            cancelled_by_user_id = ${ownerUserId}, cancellation_note = null
        where id = ${recorded.id}
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('trace, timeline, export, and tenancy', () => {
  it('serves the installed quantity on the Work detail and the serial lookup trace', async () => {
    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const { schedules } = detail.json<WorkDetailResponse>();
    const items = schedules.flatMap((schedule) => schedule.items);
    expect(items.find((item) => item.id === itemBId)?.installedQuantity).toBe('4.750');
    expect(items.find((item) => item.id === itemCId)?.installedQuantity).toBe('2.000');

    const search = await authed(owner, {
      method: 'GET',
      url: '/api/serials/search?q=SN-C1',
      organisationId,
    });
    expect(search.statusCode, search.body).toBe(200);
    const { matches } = search.json<SerialSearchResponse>();
    const match = matches.find((candidate) => candidate.serialNumber === 'SN-C1');
    expect(match?.installedOn).toBe('2026-08-05');
    expect(typeof match?.installationId).toBe('string');
    expect(match?.installationLocation).toBe('Nashik Road station');
  });

  it('surfaces installation.recorded and installation.cancelled on the Work timeline', async () => {
    const timeline = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/timeline?entityTypes=installations`,
      organisationId,
    });
    expect(timeline.statusCode, timeline.body).toBe(200);
    const { events } = timeline.json<TimelineResponse>();
    const actions = events.map((event) => event.action);
    expect(actions).toContain('installation.recorded');
    expect(actions).toContain('installation.cancelled');
    const cancelledEvent = events.find(
      (event) => event.action === 'installation.cancelled',
    );
    expect(cancelledEvent?.details).toMatchObject({
      before: { status: 'recorded' },
      after: { status: 'cancelled' },
      note: 'Recorded against the wrong span',
    });
  });

  it('includes installations and their serial attachments in the owner export', async () => {
    const exported = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const payload = exported.json<{
      installations: { id: string; status: string }[];
      installationSerials: { installation_id: string }[];
    }>();
    expect(payload.installations.length).toBeGreaterThan(0);
    expect(payload.installationSerials.length).toBeGreaterThan(0);
  });

  it('denies every installation surface across tenants with 404s', async () => {
    const list = await listInstallations();
    const anyInstallation = list.installations[0];
    if (!anyInstallation) throw new Error('installation fixture missing');

    const foreignList = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${workId}/installations`,
      organisationId: outsiderOrganisationId,
    });
    expect(foreignList.statusCode).toBe(404);

    const foreignRecord = await record(
      outsider,
      {
        workItemId: itemAId,
        quantity: '1.000',
        installedOn: '2026-08-05',
        newLocation: { name: 'Foreign yard', kind: 'other' },
      },
      outsiderOrganisationId,
    );
    expect(foreignRecord.statusCode).toBe(404);

    const foreignCancel = await authed(outsider, {
      method: 'POST',
      url: `/api/installations/${anyInstallation.id}/cancel`,
      organisationId: outsiderOrganisationId,
      payload: { note: 'Cross-tenant attempt' },
    });
    expect(foreignCancel.statusCode).toBe(404);
  });
});

describe('serials of another Work and the assigned scope', () => {
  let workBId: string;
  let itemB1Id: string;
  let workBInstallationId: string;
  let serialB1Id: string; // installed on work B
  let serialB2Id: string; // delivered on work B, uninstalled

  beforeAll(async () => {
    // A second Work in the SAME organisation: RLS admits its rows, so only
    // the Work-scope checks separate them.
    workBId = randomUUID();
    const scheduleBId = randomUUID();
    itemB1Id = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${workBId}, ${organisationId}, ${`INSTB-${runId.toUpperCase()}`},
        ${`inst-letter-b-${runId}`}, '2025-06-01', 'Installation fixture work B',
        500.00, 450.00, 'per_schedule', ${ownerUserId}
      )
    `;
    await admin`
      insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
      values (${scheduleBId}, ${organisationId}, ${workBId}, 'B', 'Schedule B', 1)
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, requires_serials
      )
      values (
        ${itemB1Id}, ${organisationId}, ${workBId}, ${scheduleBId}, 'B/1',
        'Point machine', 'Nos', 5.000, 300.00, true
      )
    `;
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workBId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-01',
        prefix: 'DCB',
        consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
        items: [{ workItemId: itemB1Id, quantity: '2' }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftDetail = draft.json<ChallanDetailResponse>();
    const lineB = draftDetail.items.find((item) => item.workItemId === itemB1Id);
    if (!lineB) throw new Error('work B challan line missing');
    const serialsRecorded = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draftDetail.challan.id}/serials`,
      organisationId,
      payload: { challanItemId: lineB.id, serialNumbers: ['SN-B1', 'SN-B2'] },
    });
    expect(serialsRecorded.statusCode, serialsRecorded.body).toBe(201);
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draftDetail.challan.id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);

    const serials = await admin<{ id: string; serial_number: string }[]>`
      select id, serial_number from challan_item_serials
      where organisation_id = ${organisationId} and work_id = ${workBId}
    `;
    const b1 = serials.find((serial) => serial.serial_number === 'SN-B1');
    const b2 = serials.find((serial) => serial.serial_number === 'SN-B2');
    if (!b1 || !b2) throw new Error('work B serials missing');
    serialB1Id = b1.id;
    serialB2Id = b2.id;

    const recorded = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workBId}/installations`,
      organisationId,
      payload: {
        workItemId: itemB1Id,
        quantity: '1',
        installedOn: '2026-08-05',
        locationId: stationLocationId,
        serialIds: [serialB1Id],
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    workBInstallationId = recorded.json<Installation>().id;
  });

  it('answers 404 — not a state-specific 409 — for serial ids of another Work', async () => {
    // SN-B2 is delivered-but-uninstalled on work B: naming it on a work-A
    // recording must NOT confirm it exists (previously a 409
    // SERIAL_ITEM_MISMATCH echoing the serial number).
    const uninstalled = await record(site, {
      workItemId: itemCId,
      quantity: '1',
      installedOn: '2026-08-06',
      locationId: stationLocationId,
      serialIds: [serialB2Id],
    });
    expect(uninstalled.statusCode, uninstalled.body).toBe(404);
    expect(uninstalled.json<{ code: string }>().code).toBe('SERIAL_NOT_FOUND');

    // SN-B1 is INSTALLED on work B: the answer is identical, so no serial
    // state leaks across Works.
    const installed = await record(site, {
      workItemId: itemCId,
      quantity: '1',
      installedOn: '2026-08-06',
      locationId: stationLocationId,
      serialIds: [serialB1Id],
    });
    expect(installed.statusCode, installed.body).toBe(404);
    expect(installed.json<{ code: string }>().code).toBe('SERIAL_NOT_FOUND');
  });

  it('rejects a cross-item serial attachment at the database (item lineage)', async () => {
    // A recorded installation of item C and a delivered serial of item A:
    // the composite FKs alone would admit the attachment (same Work), but
    // the 0023 guard proves the serial resolves to the installation's own
    // work item.
    const [installationC] = await admin<{ id: string }[]>`
      select i.id from installations i
      where i.organisation_id = ${organisationId}
        and i.work_id = ${workId} and i.work_item_id = ${itemCId}
        and i.status = 'recorded'
      limit 1
    `;
    if (!installationC) throw new Error('recorded item-C installation missing');
    await expect(
      admin`
        insert into installation_serials (
          organisation_id, installation_id, work_id, challan_item_serial_id
        )
        values (
          ${organisationId}, ${installationC.id}, ${workId}, ${serialId('SN-A1')}
        )
      `,
    ).rejects.toThrow(/work item/);
  });

  it('denies every installation surface for an assigned-scope member outside their Works', async () => {
    // Office member with assigned scope, covering work A only.
    const [assignedUser] = await admin<{ id: string }[]>`
      select "id" from auth_users where "email" = ${assignedEmail}
    `;
    if (!assignedUser) throw new Error('assigned user missing');
    await admin`
      update organisation_memberships
      set work_scope = 'assigned'
      where organisation_id = ${organisationId} and user_id = ${assignedUser.id}
    `;
    await admin`
      insert into work_assignments (
        organisation_id, work_id, user_id, created_by_user_id
      )
      values (${organisationId}, ${workId}, ${assignedUser.id}, ${ownerUserId})
    `;

    const foreignList = await authed(assigned, {
      method: 'GET',
      url: `/api/works/${workBId}/installations`,
      organisationId,
    });
    expect(foreignList.statusCode, foreignList.body).toBe(404);

    const foreignRecord = await authed(assigned, {
      method: 'POST',
      url: `/api/works/${workBId}/installations`,
      organisationId,
      payload: {
        workItemId: itemB1Id,
        quantity: '1.000',
        installedOn: '2026-08-06',
        locationId: stationLocationId,
      },
    });
    expect(foreignRecord.statusCode, foreignRecord.body).toBe(404);

    const foreignCancel = await authed(assigned, {
      method: 'POST',
      url: `/api/installations/${workBInstallationId}/cancel`,
      organisationId,
      payload: { note: 'Assigned-scope attempt' },
    });
    expect(foreignCancel.statusCode, foreignCancel.body).toBe(404);

    // Positive control: the assigned Work answers normally.
    const assignedList = await authed(assigned, {
      method: 'GET',
      url: `/api/works/${workId}/installations`,
      organisationId,
    });
    expect(assignedList.statusCode, assignedList.body).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Milestone 6/7 retrofit — the installation invariant exit suite.
//
// Already pinned above and NOT repeated here: the LOA cap in exact SQL
// arithmetic and under the amendment overlay, the cap under simultaneous
// recordings, the serialised installed-≤-delivered cap, the R11 date
// window in the API and in the database, one-serial-per-unit, serial
// existence/lineage/delivery-date/re-installation refusals, the atomic
// double-attachment race, cancel-with-note releasing serials, and the
// record freeze against direct SQL.
//
// What was NOT pinned, and is pinned here: the excess-delivery toggle
// lifting the DELIVERY ceiling and having nothing whatever to say about
// installation — before migration 0077 that meant installation stayed
// capped while delivery ran over, and since 0077 it means installation
// runs over without the toggle's permission and flags a variation
// instead. The toggle is orthogonal in both regimes, which is the point.
// Also pinned: the deliberate absence of an in-place quantity-edit
// endpoint (Milestone 7's settled cancel-and-re-record).
// ---------------------------------------------------------------------------

describe('the excess-delivery toggle is orthogonal to installation (R5)', () => {
  let excessWorkId: string;
  let excessItemId: string;

  beforeAll(async () => {
    excessWorkId = randomUUID();
    const scheduleId = randomUUID();
    excessItemId = randomUUID();
    // The toggle is ON from the start — this Work is allowed to over-deliver.
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id,
        allow_excess_delivery
      )
      values (
        ${excessWorkId}, ${organisationId}, ${`INSTX-${runId.toUpperCase()}`},
        ${`inst-excess-letter-${runId}`}, '2025-06-01', 'Excess delivery work',
        1000.00, 900.00, 'per_schedule', ${ownerUserId}, true
      )
    `;
    await admin`
      insert into work_schedules (
        id, organisation_id, work_id, schedule_code, title, position
      )
      values (${scheduleId}, ${organisationId}, ${excessWorkId}, 'A', 'Schedule A', 1)
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, requires_serials
      )
      values (
        ${excessItemId}, ${organisationId}, ${excessWorkId}, ${scheduleId},
        'A/1', 'Over-delivered ballast', 'Cum', 4.000, 300.00, false
      )
    `;
  });

  it('delivers 6 against an awarded 4 — the toggle lifts the DELIVERY ceiling', async () => {
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${excessWorkId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-01',
        prefix: 'DCX',
        consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
        items: [{ workItemId: excessItemId, quantity: '6' }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const challanId = draft.json<ChallanDetailResponse>().challan.id;
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
  });

  it('installs past the sanctioned quantity without the toggle being consulted', async () => {
    // 4 installed is exactly the sanctioned quantity, and owes nothing.
    const atCap = await authed(owner, {
      method: 'POST',
      url: `/api/works/${excessWorkId}/installations`,
      organisationId,
      payload: {
        workItemId: excessItemId,
        quantity: '4.000',
        installedOn: '2026-08-02',
        newLocation: { name: 'Excess ballast yard', kind: 'other' },
      },
    });
    expect(atCap.statusCode, atCap.body).toBe(201);
    const [before] = await admin<{ pending_variation: boolean }[]>`
      select pending_variation from work_items where id = ${excessItemId}
    `;
    expect(before?.pending_variation).toBe(false);

    // The fifth unit goes in. Since migration 0077 it is recorded, and the
    // item is flagged as owing a variation order.
    const overCap = await authed(owner, {
      method: 'POST',
      url: `/api/works/${excessWorkId}/installations`,
      organisationId,
      payload: {
        workItemId: excessItemId,
        quantity: '1.000',
        installedOn: '2026-08-02',
        newLocation: { name: 'Excess ballast yard', kind: 'other' },
      },
    });
    expect(overCap.statusCode, overCap.body).toBe(201);
    const [after] = await admin<{ pending_variation: boolean }[]>`
      select pending_variation from work_items where id = ${excessItemId}
    `;
    expect(after?.pending_variation).toBe(true);

    const [work] = await admin<{ allow_excess_delivery: boolean }[]>`
      select allow_excess_delivery from works where id = ${excessWorkId}
    `;
    expect(work?.allow_excess_delivery).toBe(true);
    const [totals] = await admin<{ delivered: string; installed: string }[]>`
      select
        (select coalesce(sum(dci.quantity), 0)::text
         from delivery_challan_items dci
         join delivery_challans dc on dc.id = dci.delivery_challan_id
         where dci.work_item_id = ${excessItemId} and dc.status = 'issued')
          as delivered,
        (select coalesce(sum(i.quantity), 0)::text from installations i
         where i.work_item_id = ${excessItemId} and i.status = 'recorded')
          as installed
    `;
    expect(totals?.delivered).toBe('6.000');
    expect(totals?.installed).toBe('5.000');
  });

  it('clears the variation when the amendment sanctions what was built', async () => {
    // The lawful path R5 still names: the railway's variation order lands
    // as an approved amendment, and the flag goes out with it. The
    // installation was never held up waiting for it.
    await admin`
      update organisation_memberships set can_approve_amendments = true
      where organisation_id = ${organisationId} and user_id = ${ownerUserId}
    `;
    const amended = await authed(owner, {
      method: 'POST',
      url: `/api/works/${excessWorkId}/amendments`,
      organisationId,
      payload: {
        workItemId: excessItemId,
        reason: 'Railway sanctioned the extra ballast.',
        changes: { quantity: '5' },
      },
    });
    expect(amended.statusCode, amended.body).toBe(201);

    const [item] = await admin<{ pending_variation: boolean }[]>`
      select pending_variation from work_items where id = ${excessItemId}
    `;
    expect(item?.pending_variation).toBe(false);

    // …and going past the newly sanctioned five raises it again.
    const accepted = await authed(owner, {
      method: 'POST',
      url: `/api/works/${excessWorkId}/installations`,
      organisationId,
      payload: {
        workItemId: excessItemId,
        quantity: '1.000',
        installedOn: '2026-08-02',
        newLocation: { name: 'Excess ballast yard', kind: 'other' },
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const [again] = await admin<{ pending_variation: boolean }[]>`
      select pending_variation from work_items where id = ${excessItemId}
    `;
    expect(again?.pending_variation).toBe(true);
  });
});

describe('installation quantity edits are cancel-and-re-record only', () => {
  it('exposes no in-place edit endpoint for a recorded installation', async () => {
    const list = await listInstallations();
    const recorded = list.installations.find(
      (installation) => installation.status === 'recorded',
    );
    expect(recorded).toBeDefined();
    const id = recorded?.id ?? '';

    // Milestone 7's settled narrowing (ROADMAP): there is deliberately no
    // approval-gated in-place installation edit, so the obvious verbs on
    // the record itself do not exist. A 404/405 here is the contract — if
    // one of these ever starts answering 200, the narrowing was undone
    // without updating the roadmap.
    for (const method of ['PUT', 'PATCH'] as const) {
      const response = await authed(owner, {
        method,
        url: `/api/installations/${id}`,
        organisationId,
        payload: { quantity: '1.000' },
      });
      expect([404, 405], `${method}: ${String(response.statusCode)}`).toContain(
        response.statusCode,
      );
    }

    // The supported path stays open: cancel with a note, then re-record.
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/installations/${id}/cancel`,
      organisationId,
      payload: { note: 'Quantity corrected — re-recorded below.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<Installation>().status).toBe('cancelled');
  });
});

/**
 * The tenant-wide register (`GET /api/installations`).
 *
 * It reads across Works, so the only thing separating an
 * 'assigned'-scoped member from another Work's records is the SQL
 * predicate in the route — there is no per-record `assertWorkAccess` to
 * fall back on in a list. That is what the scope test below is for, and
 * why it uses a Work the member is deliberately NOT assigned to.
 */
describe('the tenant-wide installation register', () => {
  let workCId: string;
  let itemC1Id: string;
  let recordedCId: string;
  let cancelledCId: string;

  async function readRegister(
    jar: CookieJar,
    query = '',
  ): Promise<InstallationRegisterResponse> {
    const response = await authed(jar, {
      method: 'GET',
      url: `/api/installations${query}`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<InstallationRegisterResponse>();
  }

  beforeAll(async () => {
    // A third Work, kept to itself: its rows are the fixture for the
    // register's fields and for the scope denial, and nothing else in this
    // file measures its quantities.
    workCId = randomUUID();
    const scheduleCId = randomUUID();
    itemC1Id = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${workCId}, ${organisationId}, ${`INSTC-${runId.toUpperCase()}`},
        ${`inst-letter-c-${runId}`}, '2025-06-01', 'Register fixture work C',
        900.00, 800.00, 'per_schedule', ${ownerUserId}
      )
    `;
    await admin`
      insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
      values (${scheduleCId}, ${organisationId}, ${workCId}, 'C', 'Schedule C', 1)
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, requires_serials
      )
      values (
        ${itemC1Id}, ${organisationId}, ${workCId}, ${scheduleCId}, 'C/1',
        'Cable trough', 'Nos', 10.000, 75.00, false
      )
    `;

    for (const [installedOn, quantity] of [
      ['2026-08-10', '3.000'],
      ['2026-08-11', '1.500'],
    ] as const) {
      const recorded = await authed(owner, {
        method: 'POST',
        url: `/api/works/${workCId}/installations`,
        organisationId,
        payload: {
          workItemId: itemC1Id,
          quantity,
          installedOn,
          locationId: stationLocationId,
        },
      });
      expect(recorded.statusCode, recorded.body).toBe(201);
      const installation = recorded.json<Installation>();
      if (installedOn === '2026-08-10') recordedCId = installation.id;
      else cancelledCId = installation.id;
    }

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/installations/${cancelledCId}/cancel`,
      organisationId,
      payload: { note: 'Recorded against the wrong trough run' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    // This suite's OWN assigned-scope member, narrowed here rather than by
    // reaching into the membership another describe set up: the scope is
    // proved on this suite's terms, and no later suite inherits a
    // membership this one changed.
    const [scopedUser] = await admin<{ id: string }[]>`
      select "id" from auth_users where "email" = ${registerScopedEmail}
    `;
    if (!scopedUser) throw new Error('register-scoped user missing');
    await admin`
      update organisation_memberships set work_scope = 'assigned'
      where organisation_id = ${organisationId} and user_id = ${scopedUser.id}
    `;
    await admin`
      insert into work_assignments (organisation_id, work_id, user_id, created_by_user_id)
      values (${organisationId}, ${workId}, ${scopedUser.id}, ${ownerUserId})
      on conflict do nothing
    `;
  }, 60_000);

  it('lists records across Works, newest first, with the Work they belong to', async () => {
    const register = await readRegister(owner);

    const row = register.installations.find(
      (installation) => installation.id === recordedCId,
    );
    expect(row).toMatchObject({
      workId: workCId,
      workCode: `INSTC-${runId.toUpperCase()}`,
      workTitle: 'Register fixture work C',
      workItemId: itemC1Id,
      itemNumber: 'C/1',
      quantity: '3.000',
      installedOn: '2026-08-10',
      locationName: 'Nashik Road station',
      serialCount: 0,
      status: 'recorded',
    });

    // Rows from more than one Work, which is the whole point of the
    // register — and the per-Work list is a strict subset of it.
    const workIds = new Set(
      register.installations.map((installation) => installation.workId),
    );
    expect(workIds.size).toBeGreaterThan(1);
    expect(workIds.has(workId)).toBe(true);

    const dates = register.installations.map(
      (installation) => installation.installedOn,
    );
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('keeps a cancelled record listed, and counts the serials of a serial-tracked one', async () => {
    const register = await readRegister(owner);

    expect(
      register.installations.find((installation) => installation.id === cancelledCId)
        ?.status,
    ).toBe('cancelled');

    // Work B's record attached one serial; the register reports the count
    // rather than the numbers, which belong to the record's own screen.
    const serialTracked = register.installations.find(
      (installation) => installation.itemNumber === 'B/1',
    );
    expect(serialTracked?.serialCount).toBe(1);
  });

  it('shows an assigned-scope member only their own Works', async () => {
    const mine = await readRegister(registerScoped);

    expect(mine.installations.length).toBeGreaterThan(0);
    // Every row is the one Work they are assigned to — no row of Work B or
    // Work C leaves the database.
    expect([
      ...new Set(mine.installations.map((installation) => installation.workId)),
    ]).toEqual([workId]);

    // And the owner, who sees everything, sees strictly more.
    const everything = await readRegister(owner);
    expect(everything.installations.length).toBeGreaterThan(mine.installations.length);
    expect(
      everything.installations.some((installation) => installation.workId === workCId),
    ).toBe(true);
  });

  it('walks the register one row at a time through its cursor', async () => {
    const whole = await readRegister(owner);
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step <= whole.installations.length; step += 1) {
      const page: InstallationRegisterResponse = await readRegister(
        owner,
        cursor === null ? '?limit=1' : `?limit=1&cursor=${cursor}`,
      );
      if (page.installations.length === 0) break;
      expect(page.installations).toHaveLength(1);
      walked.push(page.installations[0]?.id ?? '');
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(walked).toEqual(whole.installations.map((installation) => installation.id));
  });

  /**
   * The cursor is part of the scope boundary, not part of the plumbing.
   *
   * Validating it organisation-wide would answer 200 for a forbidden row's
   * id and 400 for a nonexistent one, and the keyset comparison would then
   * run against that row's (installed_on, created_at, id) — so a caller
   * paging with chosen cursors could recover the date and the creation
   * instant of a record no row of which is ever returned. The two refusals
   * must be the same refusal.
   */
  it('refuses an out-of-scope cursor exactly as it refuses a nonexistent one', async () => {
    // A real installation, of a Work the scoped member is not assigned to.
    const forbidden = await authed(registerScoped, {
      method: 'GET',
      url: `/api/installations?limit=1&cursor=${recordedCId}`,
      organisationId,
    });
    expect(forbidden.statusCode, forbidden.body).toBe(400);
    expect(forbidden.json<{ code: string }>().code).toBe('CURSOR_INVALID');

    // A uuid naming nothing at all, answered identically — which is what
    // makes the existence of the record above undisclosed.
    const absent = await authed(registerScoped, {
      method: 'GET',
      url: `/api/installations?limit=1&cursor=${randomUUID()}`,
      organisationId,
    });
    expect(absent.statusCode, absent.body).toBe(400);
    expect(absent.json<{ code: string }>().code).toBe(
      forbidden.json<{ code: string }>().code,
    );
    expect(absent.json<{ message: string }>().message).toBe(
      forbidden.json<{ message: string }>().message,
    );

    // Positive control on the SAME id: the owner sees every Work, so the
    // cursor is a position rather than a refusal. Without this the test
    // would pass against a register that had simply stopped paging.
    const allowed = await authed(owner, {
      method: 'GET',
      url: `/api/installations?limit=1&cursor=${recordedCId}`,
      organisationId,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);

    // And a cursor of the member's OWN Work still pages for them.
    const mine = await readRegister(registerScoped, '?limit=1');
    const first = mine.installations[0];
    if (!first) throw new Error('assigned-scope register unexpectedly empty');
    const onward = await authed(registerScoped, {
      method: 'GET',
      url: `/api/installations?limit=1&cursor=${first.id}`,
      organisationId,
    });
    expect(onward.statusCode, onward.body).toBe(200);
  });

  it('narrows to an inclusive installed-on window', async () => {
    const sameDay = await readRegister(
      owner,
      '?installedFrom=2026-08-10&installedTo=2026-08-10',
    );
    expect(sameDay.installations.length).toBeGreaterThan(0);
    expect(
      sameDay.installations.every(
        (installation) => installation.installedOn === '2026-08-10',
      ),
    ).toBe(true);
    expect(
      sameDay.installations.some((installation) => installation.id === recordedCId),
    ).toBe(true);
    // Both bounds inclusive, and the 11th is outside this one.
    expect(
      sameDay.installations.some((installation) => installation.id === cancelledCId),
    ).toBe(false);

    // An open-ended lower bound still excludes what precedes it.
    const from = await readRegister(owner, '?installedFrom=2026-08-11');
    expect(
      from.installations.every(
        (installation) => installation.installedOn >= '2026-08-11',
      ),
    ).toBe(true);

    // A window with nothing in it is an empty register, not an error.
    const empty = await readRegister(owner, '?installedFrom=2030-01-01');
    expect(empty.installations).toEqual([]);
  });

  it('answers a member of another organisation with 403, not with rows', async () => {
    const denied = await authed(outsider, {
      method: 'GET',
      url: '/api/installations',
      organisationId,
    });
    expect(denied.statusCode, denied.body).toBe(403);

    // Their own organisation has no Works at all, so the register is empty
    // rather than absent.
    const own = await authed(outsider, {
      method: 'GET',
      url: '/api/installations',
      organisationId: outsiderOrganisationId,
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json<InstallationRegisterResponse>().installations).toEqual([]);
  });
});
