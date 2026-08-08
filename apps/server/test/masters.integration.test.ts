import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  ConsigneeMaster,
  LocationMaster,
  OrganisationProfile,
  Signatory,
  UnitMaster,
} from '@auto-mb/contracts';
import { CANONICAL_UNIT_NAMES } from '@auto-mb/loa-parser';
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
const ownerEmail = `mst-owner-${runId}@integration.test`;
const clerkEmail = `mst-clerk-${runId}@integration.test`;
const viewerEmail = `mst-viewer-${runId}@integration.test`;
const foreignEmail = `mst-foreign-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let foreignOrganisationId: string;
let ownerUserId: string;
let workId: string;
let itemId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let clerk: CookieJar;
let viewer: CookieJar;
let foreignOwner: CookieJar;

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

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-masters-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the masters integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-masters-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Masters Owner');
  clerk = await signUp(clerkEmail, 'Masters Clerk');
  viewer = await signUp(viewerEmail, 'Masters Viewer');
  foreignOwner = await signUp(foreignEmail, 'Foreign Owner');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Masters Constructions', slug: `mst-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const createdForeign = await authed(foreignOwner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Foreign Constructions', slug: `mst-foreign-${runId}` },
  });
  expect(createdForeign.statusCode, createdForeign.body).toBe(201);
  foreignOrganisationId = createdForeign.json<{ id: string }>().id;

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
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  // Fixture Work for the snapshot-on-use proof.
  workId = randomUUID();
  const scheduleId = randomUUID();
  itemId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`MSTW-${runId.toUpperCase()}`},
      ${`mst-letter-${runId}`}, '2025-06-01', 'Masters fixture work',
      1000.00, 900.00, 'per_schedule', ${ownerUserId}
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
    values (${itemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
            'Point machine', 'Nos', 5.000, 100.00)
  `;
}, 60_000);

afterAll(async () => {
  if (admin) {
    for (const org of [organisationId, foreignOrganisationId]) {
      if (!org) continue;
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'consignee_masters',
          'location_masters',
          'unit_masters',
          'organisation_signatories',
          'work_items',
          'work_schedules',
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
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('consignee masters', () => {
  let consigneeId: string;
  let secondId: string;

  it('lets office create, viewer read, and blocks viewer writes', async () => {
    const created = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/consignees',
      organisationId,
      payload: {
        designation: 'Sr. DEE (G) NR',
        address: 'Delhi Division, New Delhi',
        contactPerson: 'S K Verma',
        phone: '011-23385678',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const consignee = created.json<ConsigneeMaster>();
    consigneeId = consignee.id;
    expect(consignee).toMatchObject({
      designation: 'Sr. DEE (G) NR',
      address: 'Delhi Division, New Delhi',
      contactPerson: 'S K Verma',
      email: null,
      active: true,
    });

    const listed = await authed(viewer, {
      method: 'GET',
      url: '/api/masters/consignees',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(
      listed.json<{ consignees: ConsigneeMaster[] }>().consignees.map((c) => c.id),
    ).toContain(consigneeId);

    const denied = await authed(viewer, {
      method: 'POST',
      url: '/api/masters/consignees',
      organisationId,
      payload: { designation: 'Viewer Attempt' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
  });

  it('rejects case-insensitive designation+address duplicates with 409', async () => {
    const duplicate = await authed(owner, {
      method: 'POST',
      url: '/api/masters/consignees',
      organisationId,
      payload: {
        designation: 'sr. dee (g) nr',
        address: 'DELHI DIVISION, NEW DELHI',
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'CONSIGNEE_MASTER_EXISTS' });

    // The same designation at a DIFFERENT address is a different consignee.
    const elsewhere = await authed(owner, {
      method: 'POST',
      url: '/api/masters/consignees',
      organisationId,
      payload: {
        designation: 'Sr. DEE (G) NR',
        address: 'Ambala Division, Ambala Cantt',
      },
    });
    expect(elsewhere.statusCode, elsewhere.body).toBe(201);
    secondId = elsewhere.json<ConsigneeMaster>().id;
  });

  it('updates a master and guards the duplicate pair on update too', async () => {
    const updated = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/consignees/${consigneeId}`,
      organisationId,
      payload: {
        designation: 'Sr. DEE (G) NR',
        address: 'Delhi Division, New Delhi',
        phone: '011-23380000',
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<ConsigneeMaster>()).toMatchObject({
      phone: '011-23380000',
      contactPerson: null,
    });

    const collide = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/consignees/${secondId}`,
      organisationId,
      payload: {
        designation: 'Sr. DEE (G) NR',
        address: 'Delhi Division, New Delhi',
      },
    });
    expect(collide.statusCode).toBe(409);
    expect(collide.json()).toMatchObject({ code: 'CONSIGNEE_MASTER_EXISTS' });
  });

  it('retires (always allowed), hides retired rows by default, and reactivates', async () => {
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/consignees/${secondId}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);
    expect(retired.json<ConsigneeMaster>().active).toBe(false);

    const defaultList = await authed(owner, {
      method: 'GET',
      url: '/api/masters/consignees',
      organisationId,
    });
    expect(
      defaultList.json<{ consignees: ConsigneeMaster[] }>().consignees.map((c) => c.id),
    ).not.toContain(secondId);

    const fullList = await authed(owner, {
      method: 'GET',
      url: '/api/masters/consignees?includeRetired=true',
      organisationId,
    });
    const retiredRow = fullList
      .json<{ consignees: ConsigneeMaster[] }>()
      .consignees.find((c) => c.id === secondId);
    expect(retiredRow?.active).toBe(false);

    const reactivated = await authed(owner, {
      method: 'POST',
      url: `/api/masters/consignees/${secondId}/reactivate`,
      organisationId,
    });
    expect(reactivated.statusCode, reactivated.body).toBe(200);
    expect(reactivated.json<ConsigneeMaster>().active).toBe(true);
  });

  it('has no hard-delete path: even the application role cannot DELETE', async () => {
    // The route surface offers no DELETE; the grant matrix backs it up.
    const response = await authed(owner, {
      method: 'DELETE',
      url: `/api/masters/consignees/${secondId}`,
      organisationId,
    });
    expect(response.statusCode).toBe(404);

    const [privilege] = await admin<{ granted: boolean }[]>`
      select has_table_privilege('auto_mb_app', 'consignee_masters', 'DELETE') as granted
    `;
    expect(privilege?.granted).toBe(false);
  });

  it('audits create, update, retire, and reactivate', async () => {
    const lifecycle = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${secondId}
      order by occurred_at
    `;
    expect(lifecycle.map((event) => event.action)).toEqual([
      'consignee_master.created',
      'consignee_master.retired',
      'consignee_master.reactivated',
    ]);

    // The successful edit above targeted the first master; its audit row
    // exists (the 409'd edit of the second one rightly left none).
    const edits = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${consigneeId}
        and action = 'consignee_master.updated'
    `;
    expect(edits).toHaveLength(1);
  });
});

describe('unit masters and lazy default seeding', () => {
  it('seeds the parser canon exactly once under concurrent first reads', async () => {
    const [first, second] = await Promise.all([
      authed(owner, { method: 'GET', url: '/api/masters/units', organisationId }),
      authed(clerk, { method: 'GET', url: '/api/masters/units', organisationId }),
    ]);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);

    const [count] = await admin<{ count: string }[]>`
      select count(*)::text as count from unit_masters
      where organisation_id = ${organisationId}
    `;
    expect(count?.count).toBe(String(CANONICAL_UNIT_NAMES.length));

    // A later read re-runs the idempotent seed and changes nothing.
    const again = await authed(viewer, {
      method: 'GET',
      url: '/api/masters/units',
      organisationId,
    });
    expect(again.statusCode).toBe(200);
    const names = again.json<{ units: UnitMaster[] }>().units.map((unit) => unit.name);
    expect(new Set(names)).toEqual(new Set(CANONICAL_UNIT_NAMES));
  });

  it('keeps a retired default retired across re-seeds', async () => {
    const list = await authed(owner, {
      method: 'GET',
      url: '/api/masters/units',
      organisationId,
    });
    const lumpsum = list
      .json<{ units: UnitMaster[] }>()
      .units.find((unit) => unit.name === 'Lumpsum');
    expect(lumpsum).toBeDefined();
    if (!lumpsum) throw new Error('Lumpsum unit missing');

    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/units/${lumpsum.id}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);

    // The list read seeds again — the retired row must NOT resurrect.
    const reread = await authed(owner, {
      method: 'GET',
      url: '/api/masters/units',
      organisationId,
    });
    expect(
      reread.json<{ units: UnitMaster[] }>().units.map((unit) => unit.name),
    ).not.toContain('Lumpsum');
    const [count] = await admin<{ count: string }[]>`
      select count(*)::text as count from unit_masters
      where organisation_id = ${organisationId}
    `;
    expect(count?.count).toBe(String(CANONICAL_UNIT_NAMES.length));
  });

  it('accepts custom units, guards duplicates, and lets office rename', async () => {
    const created = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/units',
      organisationId,
      payload: { name: 'Quintal' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const unitId = created.json<UnitMaster>().id;

    const duplicate = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/units',
      organisationId,
      payload: { name: 'quintal' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'UNIT_MASTER_EXISTS' });

    const renamed = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/units/${unitId}`,
      organisationId,
      payload: { name: 'Quintal (100 kg)' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json<UnitMaster>().name).toBe('Quintal (100 kg)');
  });
});

describe('location masters', () => {
  it('creates locations unique per (name, kind), not per name alone', async () => {
    const station = await authed(owner, {
      method: 'POST',
      url: '/api/masters/locations',
      organisationId,
      payload: { name: 'Ghaziabad Jn', kind: 'station' },
    });
    expect(station.statusCode, station.body).toBe(201);

    const duplicate = await authed(owner, {
      method: 'POST',
      url: '/api/masters/locations',
      organisationId,
      payload: { name: 'GHAZIABAD JN', kind: 'station' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'LOCATION_MASTER_EXISTS' });

    const store = await authed(owner, {
      method: 'POST',
      url: '/api/masters/locations',
      organisationId,
      payload: { name: 'Ghaziabad Jn', kind: 'store' },
    });
    expect(store.statusCode, store.body).toBe(201);
  });

  it('rejects unknown kinds at the schema boundary', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/masters/locations',
      organisationId,
      payload: { name: 'Somewhere', kind: 'warehouse' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('retires and reactivates a location', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/masters/locations',
      organisationId,
      payload: { name: 'Temporary Depot', kind: 'other' },
    });
    const locationId = created.json<LocationMaster>().id;

    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/locations/${locationId}/retire`,
      organisationId,
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json<LocationMaster>().active).toBe(false);

    const reactivated = await authed(owner, {
      method: 'POST',
      url: `/api/masters/locations/${locationId}/reactivate`,
      organisationId,
    });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json<LocationMaster>().active).toBe(true);
  });
});

describe('organisation signatories', () => {
  it('runs the full lifecycle with duplicate guard', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/masters/signatories',
      organisationId,
      payload: { name: 'R Sharma', designation: 'Managing Partner' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const signatoryId = created.json<Signatory>().id;

    const duplicate = await authed(owner, {
      method: 'POST',
      url: '/api/masters/signatories',
      organisationId,
      payload: { name: 'r sharma', designation: 'managing partner' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'SIGNATORY_EXISTS' });

    const updated = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/signatories/${signatoryId}`,
      organisationId,
      payload: { name: 'R Sharma', designation: 'Partner' },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/signatories/${signatoryId}/retire`,
      organisationId,
    });
    expect(retired.statusCode).toBe(200);

    const list = await authed(viewer, {
      method: 'GET',
      url: '/api/masters/signatories',
      organisationId,
    });
    expect(
      list.json<{ signatories: Signatory[] }>().signatories.map((s) => s.id),
    ).not.toContain(signatoryId);

    const denied = await authed(viewer, {
      method: 'POST',
      url: '/api/masters/signatories',
      organisationId,
      payload: { name: 'Viewer Person', designation: 'Nobody' },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('organisation profile: warranty template', () => {
  it('stores, returns, and clears the template; owner-only writes', async () => {
    const template = 'We warrant the supplied goods for 24 months from commissioning.';
    const saved = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { warrantyTemplateText: template },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<OrganisationProfile>().warrantyTemplateText).toBe(template);

    const read = await authed(viewer, {
      method: 'GET',
      url: '/api/organisation/profile',
      organisationId,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<OrganisationProfile>().warrantyTemplateText).toBe(template);

    const denied = await authed(clerk, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { warrantyTemplateText: 'clerk cannot write this' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'OWNER_REQUIRED' });

    const cleared = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { warrantyTemplateText: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<OrganisationProfile>().warrantyTemplateText).toBeNull();
  });
});

describe('snapshot-on-use: masters never rewrite documents', () => {
  it('keeps an issued challan intact after its source master is edited and retired', async () => {
    // The master a UI picker would choose from…
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/masters/consignees',
      organisationId,
      payload: {
        designation: 'SSE (Signal) GZB',
        address: 'Signal Workshop, Ghaziabad',
        phone: '0120-2700000',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const master = created.json<ConsigneeMaster>();

    // …prefills the challan's free-text consignee snapshot (there is no FK
    // and the challan API shape is unchanged).
    const drafted = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        prefix: 'MST',
        consignee: {
          name: master.designation,
          address: master.address ?? '',
          phone: master.phone ?? undefined,
        },
        items: [{ workItemId: itemId, quantity: '2' }],
      },
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    const challanId = drafted.json<ChallanDetailResponse>().challan.id;

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);

    // Mutate and retire the master afterwards.
    const renamed = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/consignees/${master.id}`,
      organisationId,
      payload: {
        designation: 'SSE (Signal) MRT',
        address: 'Signal Workshop, Meerut',
      },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/consignees/${master.id}/retire`,
      organisationId,
    });
    expect(retired.statusCode).toBe(200);

    // The challan snapshot (and the immutable issued snapshot) still carry
    // the values as chosen at drafting time.
    const detail = await authed(viewer, {
      method: 'GET',
      url: `/api/challans/${challanId}`,
      organisationId,
    });
    expect(detail.statusCode).toBe(200);
    const payload = detail.json<ChallanDetailResponse>();
    expect(payload.challan.consignee).toEqual({
      name: 'SSE (Signal) GZB',
      address: 'Signal Workshop, Ghaziabad',
      phone: '0120-2700000',
    });
    expect(payload.issuedSnapshot).toMatchObject({
      consignee: {
        name: 'SSE (Signal) GZB',
        address: 'Signal Workshop, Ghaziabad',
      },
    });
  });
});

describe('cross-tenant denial', () => {
  let victimConsigneeId: string;
  let victimUnitId: string;

  beforeAll(async () => {
    const consignees = await authed(owner, {
      method: 'GET',
      url: '/api/masters/consignees?includeRetired=true',
      organisationId,
    });
    const firstConsignee = consignees.json<{ consignees: ConsigneeMaster[] }>()
      .consignees[0];
    if (!firstConsignee) throw new Error('expected a seeded consignee');
    victimConsigneeId = firstConsignee.id;

    const units = await authed(owner, {
      method: 'GET',
      url: '/api/masters/units',
      organisationId,
    });
    const firstUnit = units.json<{ units: UnitMaster[] }>().units[0];
    if (!firstUnit) throw new Error('expected a seeded unit');
    victimUnitId = firstUnit.id;
  });

  it('scopes lists to the caller organisation', async () => {
    const consignees = await authed(foreignOwner, {
      method: 'GET',
      url: '/api/masters/consignees?includeRetired=true',
      organisationId: foreignOrganisationId,
    });
    expect(consignees.statusCode).toBe(200);
    expect(
      consignees.json<{ consignees: ConsigneeMaster[] }>().consignees,
    ).toHaveLength(0);

    const signatories = await authed(foreignOwner, {
      method: 'GET',
      url: '/api/masters/signatories?includeRetired=true',
      organisationId: foreignOrganisationId,
    });
    expect(signatories.json<{ signatories: Signatory[] }>().signatories).toHaveLength(
      0,
    );

    // Unit seeding is per organisation: the foreign org gets its OWN
    // canon, never a window into another tenant's rows.
    const units = await authed(foreignOwner, {
      method: 'GET',
      url: '/api/masters/units',
      organisationId: foreignOrganisationId,
    });
    const names = units.json<{ units: UnitMaster[] }>().units.map((unit) => unit.name);
    expect(new Set(names)).toEqual(new Set(CANONICAL_UNIT_NAMES));
    const [foreignCount] = await admin<{ count: string }[]>`
      select count(*)::text as count from unit_masters
      where organisation_id = ${foreignOrganisationId}
    `;
    expect(foreignCount?.count).toBe(String(CANONICAL_UNIT_NAMES.length));
  });

  it("answers 404 for another organisation's master ids on every mutation", async () => {
    const update = await authed(foreignOwner, {
      method: 'PUT',
      url: `/api/masters/consignees/${victimConsigneeId}`,
      organisationId: foreignOrganisationId,
      payload: { designation: 'Hijacked Designation' },
    });
    expect(update.statusCode).toBe(404);

    const retire = await authed(foreignOwner, {
      method: 'POST',
      url: `/api/masters/consignees/${victimConsigneeId}/retire`,
      organisationId: foreignOrganisationId,
    });
    expect(retire.statusCode).toBe(404);

    const reactivate = await authed(foreignOwner, {
      method: 'POST',
      url: `/api/masters/units/${victimUnitId}/reactivate`,
      organisationId: foreignOrganisationId,
    });
    expect(reactivate.statusCode).toBe(404);

    const rename = await authed(foreignOwner, {
      method: 'PUT',
      url: `/api/masters/units/${victimUnitId}`,
      organisationId: foreignOrganisationId,
      payload: { name: 'Hijacked Unit' },
    });
    expect(rename.statusCode).toBe(404);
  });

  it('refuses a non-member binding the victim organisation header outright', async () => {
    const response = await authed(foreignOwner, {
      method: 'GET',
      url: '/api/masters/consignees',
      organisationId,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'NOT_A_MEMBER' });
  });
});
