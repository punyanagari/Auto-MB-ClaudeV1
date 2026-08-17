import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  Contact,
  LocationMaster,
  OrganisationProfile,
  Signatory,
  UnitMaster,
} from '@auto-mb/contracts';
import { CANONICAL_UNIT_NAMES } from '@auto-mb/loa-parser';
import type { Sql } from '@auto-mb/db';
import {
  createDatabasePool,
  ensureClusterRoles,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
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

  await ensureClusterRoles(admin, appPassword);
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
    await removeOrganisationResidue(admin, [organisationId, foreignOrganisationId]);
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

describe('contacts master (unified role flags; plain creates are consignees)', () => {
  let contactId: string;
  let secondId: string;

  it('lets office create, viewer read, and blocks viewer writes', async () => {
    const created = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'Sr. DEE (G) NR',
        address: 'Delhi Division, New Delhi',
        contactPerson: 'S K Verma',
        phone: '011-23385678',
        pincode: '110001',
        stateCode: '07',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const contact = created.json<Contact>();
    contactId = contact.id;
    expect(contact).toMatchObject({
      designation: 'Sr. DEE (G) NR',
      address: 'Delhi Division, New Delhi',
      contactPerson: 'S K Verma',
      email: null,
      gstin: null,
      pincode: '110001',
      stateCode: '07',
      isConsignee: true,
      // No role asked for: a plain create is a consignee-only contact,
      // exactly as every create was before the procurement wave.
      isVendor: false,
      isClient: false,
      active: true,
    });

    const listed = await authed(viewer, {
      method: 'GET',
      url: '/api/masters/contacts?role=consignee',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ contacts: Contact[] }>().contacts.map((c) => c.id)).toContain(
      contactId,
    );

    const denied = await authed(viewer, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: { designation: 'Viewer Attempt' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
  });

  it('uppercases and validates GSTINs, accepting deductor GSTINs ending in D', async () => {
    // Standard GSTIN, entered lowercase: stored uppercase (§9).
    const standard = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'Controller of Stores CR',
        address: 'Mumbai CST',
        gstin: '27aabcs1429b1zb',
      },
    });
    expect(standard.statusCode, standard.body).toBe(201);
    expect(standard.json<Contact>().gstin).toBe('27AABCS1429B1ZB');

    // Railway units are TDS deductors — GSTINs ending in 'D' must be
    // accepted (spec §2/§5.7).
    const deductor = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'Sr. DEE (TRD) CR',
        address: 'Central Railway HQ',
        gstin: '27AAAGM0289C1DD',
      },
    });
    expect(deductor.statusCode, deductor.body).toBe(201);

    /* The PAN (migration 0080), and the distinction that matters for a
       partial edit: omitting the field must PRESERVE it, and only an
       explicit null clears it. Folding both to null would make every
       edit that touches an address quietly blank the PAN, and a vendor
       with no PAN on record is deducted at 20% under section 206AA — so
       the bug would be an over-deduction, not a cosmetic loss. */
    const withPan = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'PAN Bearing Vendor',
        address: 'Vendor Lane',
        isVendor: true,
        pan: 'abcde1234f',
      },
    });
    expect(withPan.statusCode, withPan.body).toBe(201);
    // Stored uppercase, like the GSTIN, whatever case was typed.
    expect(withPan.json<Contact>().pan).toBe('ABCDE1234F');
    const panContactId = withPan.json<Contact>().id;

    const untouched = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/contacts/${panContactId}`,
      organisationId,
      payload: {
        designation: 'PAN Bearing Vendor',
        address: 'A corrected address, with no mention of the PAN',
      },
    });
    expect(untouched.statusCode, untouched.body).toBe(200);
    expect(untouched.json<Contact>().pan).toBe('ABCDE1234F');

    const cleared = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/contacts/${panContactId}`,
      organisationId,
      payload: {
        designation: 'PAN Bearing Vendor',
        address: 'A corrected address, with no mention of the PAN',
        pan: null,
      },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<Contact>().pan).toBeNull();
    expect(deductor.json<Contact>().gstin).toBe('27AAAGM0289C1DD');

    // Neither standard nor deductor-shaped: refused with the explanation.
    const invalid = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'Sr. DEE (W) CR',
        address: 'Somewhere Else',
        gstin: 'AAAAAAAAAAAAAAA',
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'GSTIN_INVALID' });
  });

  it('stores only real email addresses, trimming what was pasted', async () => {
    // A single real address — plus tag, hyphens, a long government
    // sub-domain — carrying the stray spaces of a paste: accepted, and
    // stored trimmed.
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'SSE (P.Way) TKD',
        address: 'Tughlakabad Depot',
        email: '  accounts+gst@stores.nr.indianrailways.gov.in  ',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const contact = created.json<Contact>();
    expect(contact.email).toBe('accounts+gst@stores.nr.indianrailways.gov.in');

    // The field stays optional: leaving it out is still legitimate.
    const without = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: { designation: 'SSE (P.Way) NDLS', address: 'New Delhi Depot' },
    });
    expect(without.statusCode, without.body).toBe(201);
    expect(without.json<Contact>().email).toBeNull();

    // What offices actually park in an optional field: a note, a dash, a
    // phone number, an unfinished address with a reminder beside it, two
    // addresses in one box, a domain with no dot. None is an address.
    for (const email of [
      'n/a',
      '---',
      '011-23385678',
      'office@ — ask Ramesh',
      'stores@nr.gov.in / accounts@nr.gov.in',
      'stores@nr.gov.in/accounts@nr.gov.in',
      'ramesh@railnet',
    ]) {
      const refused = await authed(owner, {
        method: 'POST',
        url: '/api/masters/contacts',
        organisationId,
        payload: {
          designation: 'SSE (Works) GZB',
          address: 'Works Depot, Ghaziabad',
          email,
        },
      });
      expect(refused.statusCode, `${email}: ${refused.body}`).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'EMAIL_INVALID' });
    }

    // The update path is guarded too — and a good address still saves.
    const badUpdate = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/contacts/${contact.id}`,
      organisationId,
      payload: {
        designation: contact.designation,
        address: contact.address ?? undefined,
        email: 'ask at the depot',
      },
    });
    expect(badUpdate.statusCode).toBe(400);
    expect(badUpdate.json()).toMatchObject({ code: 'EMAIL_INVALID' });

    const goodUpdate = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/contacts/${contact.id}`,
      organisationId,
      payload: {
        designation: contact.designation,
        address: contact.address ?? undefined,
        email: 'sse.pway.tkd@nr.railnet.gov.in',
      },
    });
    expect(goodUpdate.statusCode, goodUpdate.body).toBe(200);
    expect(goodUpdate.json<Contact>().email).toBe('sse.pway.tkd@nr.railnet.gov.in');
  });

  it('refuses bill-paying and awarding authorities as consignees (R16)', async () => {
    for (const designation of [
      'Sr. DFM Delhi Division',
      'Sr.DFM NR',
      'DFM Ambala',
      'ADFM (G) NR',
      'Sr. DSTE (Co-ord) CR',
      'Sr.DSTE NR',
    ]) {
      const refused = await authed(owner, {
        method: 'POST',
        url: '/api/masters/contacts',
        organisationId,
        payload: { designation, address: 'Division Office' },
      });
      expect(refused.statusCode, designation).toBe(400);
      expect(refused.json(), designation).toMatchObject({
        code: 'CONSIGNEE_AUTHORITY_FORBIDDEN',
      });
      expect(refused.json<{ message: string }>().message).toContain('R16');
    }

    // Legitimate consignee designations sail through — including DSTE
    // posts without the Sr. prefix and names merely containing the
    // letters (SDFM is not DFM).
    for (const designation of ['Sr. DEE (G) NR-2', 'DSTE (East) CR', 'SDFM Works']) {
      const accepted = await authed(owner, {
        method: 'POST',
        url: '/api/masters/contacts',
        organisationId,
        payload: { designation, address: 'Division Office' },
      });
      expect(accepted.statusCode, `${designation}: ${accepted.body}`).toBe(201);
    }

    // A rename cannot smuggle an authority in either.
    const renamed = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/contacts/${contactId}`,
      organisationId,
      payload: { designation: 'Sr. DFM NR', address: 'Delhi Division, New Delhi' },
    });
    expect(renamed.statusCode).toBe(400);
    expect(renamed.json()).toMatchObject({ code: 'CONSIGNEE_AUTHORITY_FORBIDDEN' });
  });

  it('rejects case-insensitive designation+address duplicates with 409', async () => {
    const duplicate = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'sr. dee (g) nr',
        address: 'DELHI DIVISION, NEW DELHI',
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'CONTACT_EXISTS' });

    // The same designation at a DIFFERENT address is a different contact.
    const elsewhere = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'Sr. DEE (G) NR',
        address: 'Ambala Division, Ambala Cantt',
      },
    });
    expect(elsewhere.statusCode, elsewhere.body).toBe(201);
    secondId = elsewhere.json<Contact>().id;
  });

  it('updates a contact and guards the duplicate pair on update too', async () => {
    const updated = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/contacts/${contactId}`,
      organisationId,
      payload: {
        designation: 'Sr. DEE (G) NR',
        address: 'Delhi Division, New Delhi',
        phone: '011-23380000',
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<Contact>()).toMatchObject({
      phone: '011-23380000',
      contactPerson: null,
      pincode: null,
    });

    const collide = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/contacts/${secondId}`,
      organisationId,
      payload: {
        designation: 'Sr. DEE (G) NR',
        address: 'Delhi Division, New Delhi',
      },
    });
    expect(collide.statusCode).toBe(409);
    expect(collide.json()).toMatchObject({ code: 'CONTACT_EXISTS' });
  });

  it('retires (always allowed), hides retired rows by default, and reactivates', async () => {
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${secondId}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);
    expect(retired.json<Contact>().active).toBe(false);

    const defaultList = await authed(owner, {
      method: 'GET',
      url: '/api/masters/contacts',
      organisationId,
    });
    expect(
      defaultList.json<{ contacts: Contact[] }>().contacts.map((c) => c.id),
    ).not.toContain(secondId);

    const fullList = await authed(owner, {
      method: 'GET',
      url: '/api/masters/contacts?includeRetired=true',
      organisationId,
    });
    const retiredRow = fullList
      .json<{ contacts: Contact[] }>()
      .contacts.find((c) => c.id === secondId);
    expect(retiredRow?.active).toBe(false);

    const reactivated = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${secondId}/reactivate`,
      organisationId,
    });
    expect(reactivated.statusCode, reactivated.body).toBe(200);
    expect(reactivated.json<Contact>().active).toBe(true);
  });

  it('blocks reactivating into a duplicate of a live contact (active-scoped uniqueness)', async () => {
    // Retire the Ambala entry, create a fresh active twin (allowed — the
    // 0028 uniqueness is scoped to active rows), then try to reactivate
    // the retired one: 409, never a resurrected duplicate.
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${secondId}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);

    const twin = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'Sr. DEE (G) NR',
        address: 'Ambala Division, Ambala Cantt',
      },
    });
    expect(twin.statusCode, twin.body).toBe(201);

    const conflicted = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${secondId}/reactivate`,
      organisationId,
    });
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json()).toMatchObject({ code: 'CONTACT_EXISTS' });
  });

  it('has no hard-delete path: even the application role cannot DELETE', async () => {
    // The route surface offers no DELETE; the grant matrix backs it up.
    const response = await authed(owner, {
      method: 'DELETE',
      url: `/api/masters/contacts/${secondId}`,
      organisationId,
    });
    expect(response.statusCode).toBe(404);

    const [privilege] = await admin<{ granted: boolean }[]>`
      select has_table_privilege('auto_mb_app', 'contacts', 'DELETE') as granted
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
      'contact.created',
      'contact.retired',
      'contact.reactivated',
      'contact.retired',
    ]);

    // The successful edit above targeted the first contact; its audit row
    // exists (the 409'd edit of the second one rightly left none).
    const edits = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${contactId}
        and action = 'contact.updated'
    `;
    expect(edits).toHaveLength(1);
  });

  it('serves consignee-role contacts through the 0028 compatibility view', async () => {
    // The PAC route and the v1 importer still read/write the old name;
    // the view must answer with the same rows the contacts API serves.
    const viaView = await admin<{ id: string; is_consignee: boolean }[]>`
      select id, is_consignee from consignee_masters
      where organisation_id = ${organisationId} and id = ${contactId}
    `;
    expect(viaView).toHaveLength(1);
    expect(viaView[0]?.is_consignee).toBe(true);
  });
});

describe('work consignees (R16: a work may have many consignees)', () => {
  let linkedId: string;
  let unlinkedId: string;
  let retiredId: string;

  beforeAll(async () => {
    const make = async (designation: string) => {
      const created = await authed(owner, {
        method: 'POST',
        url: '/api/masters/contacts',
        organisationId,
        payload: { designation, address: 'Association fixtures' },
      });
      expect(created.statusCode, created.body).toBe(201);
      return created.json<Contact>().id;
    };
    linkedId = await make('SSE (Works) GZB');
    unlinkedId = await make('SSE (Works) MRT');
    retiredId = await make('SSE (Works) Retiring');
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${retiredId}/retire`,
      organisationId,
    });
    expect(retired.statusCode).toBe(200);
  });

  it('links consignees to a Work (owner/office), listing them for members', async () => {
    const denied = await authed(viewer, {
      method: 'POST',
      url: `/api/works/${workId}/consignees`,
      organisationId,
      payload: { contactId: linkedId },
    });
    expect(denied.statusCode).toBe(403);

    const linked = await authed(clerk, {
      method: 'POST',
      url: `/api/works/${workId}/consignees`,
      organisationId,
      payload: { contactId: linkedId },
    });
    expect(linked.statusCode, linked.body).toBe(201);
    expect(linked.json<Contact>().id).toBe(linkedId);

    const listed = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/consignees`,
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const ids = listed.json<{ consignees: Contact[] }>().consignees.map((c) => c.id);
    expect(ids).toEqual([linkedId]);
  });

  it('rejects duplicate links, retired contacts, and unknown contacts', async () => {
    const duplicate = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/consignees`,
      organisationId,
      payload: { contactId: linkedId },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'WORK_CONSIGNEE_EXISTS' });

    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/consignees`,
      organisationId,
      payload: { contactId: retiredId },
    });
    expect(retired.statusCode).toBe(409);
    expect(retired.json()).toMatchObject({ code: 'CONTACT_RETIRED' });

    const unknown = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/consignees`,
      organisationId,
      payload: { contactId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('unlinks without touching the contact, and audits both directions', async () => {
    const linked = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/consignees`,
      organisationId,
      payload: { contactId: unlinkedId },
    });
    expect(linked.statusCode, linked.body).toBe(201);

    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/works/${workId}/consignees/${unlinkedId}`,
      organisationId,
    });
    expect(removed.statusCode).toBe(204);

    const again = await authed(owner, {
      method: 'DELETE',
      url: `/api/works/${workId}/consignees/${unlinkedId}`,
      organisationId,
    });
    expect(again.statusCode).toBe(404);

    // The contact row is untouched — unlinking removes a preference only.
    const list = await authed(owner, {
      method: 'GET',
      url: '/api/masters/contacts',
      organisationId,
    });
    expect(list.json<{ contacts: Contact[] }>().contacts.map((c) => c.id)).toContain(
      unlinkedId,
    );

    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${workId}
        and action in ('work.consignee_linked', 'work.consignee_unlinked')
      order by occurred_at
    `;
    expect(events.map((event) => event.action)).toEqual([
      'work.consignee_linked',
      'work.consignee_linked',
      'work.consignee_unlinked',
    ]);
  });

  it('holds the consignee-role rule at the database for every writer', async () => {
    // A non-consignee contact (dormant vendor shape, inserted directly)
    // cannot join a Work even through a superuser session: the 0028
    // trigger proves R16 below the API.
    const [vendor] = await admin<{ id: string }[]>`
      insert into contacts (
        organisation_id, designation, is_consignee, is_vendor,
        created_by_user_id
      )
      values (${organisationId}, 'Cable Vendor Pvt Ltd', false, true, ${ownerUserId})
      returning id
    `;
    if (!vendor) throw new Error('vendor contact insert returned no row');
    await expect(
      admin`
        insert into work_consignees (
          organisation_id, work_id, contact_id, created_by_user_id
        )
        values (${organisationId}, ${workId}, ${vendor.id}, ${ownerUserId})
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });
});

/**
 * The procurement wave wakes the vendor/client role flags (legacy §9,
 * §5.8): the contacts API now creates and edits them — what every suite
 * previously had to do with admin SQL. A create naming a role is NOT a
 * consignee (the roles feed disjoint pickers), the R16 authority refusal
 * follows the consignee role only, and an update treats omitted flags as
 * "unchanged" so the profile edit form cannot strip a role it never knew
 * about.
 */
describe('contact role flags: vendors and clients through the API', () => {
  let vendorId: string;
  let clientId: string;

  it('creates a vendor contact that joins no railway picker', async () => {
    const created = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'Bharat Cables Pvt Ltd',
        contactPerson: 'R. Nair',
        address: 'Plot 12, MIDC, Pune',
        gstin: '27aabcb1429b1zb',
        stateCode: '27',
        isVendor: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const contact = created.json<Contact>();
    vendorId = contact.id;
    expect(contact).toMatchObject({
      isVendor: true,
      isClient: false,
      isConsignee: false,
      gstin: '27AABCB1429B1ZB',
      active: true,
    });

    // The create audit names the roles the contact was born with.
    const [event] = await admin<{ details: { roles?: string[] } }[]>`
      select details from audit_events
      where organisation_id = ${organisationId} and entity_id = ${vendorId}
        and action = 'contact.created'
    `;
    expect(event?.details.roles).toEqual(['vendor']);
  });

  it('creates a client contact the same way', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'Sunrise Infra Projects LLP',
        address: '4th Floor, Baner Road, Pune',
        isClient: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const contact = created.json<Contact>();
    clientId = contact.id;
    expect(contact).toMatchObject({
      isClient: true,
      isVendor: false,
      isConsignee: false,
    });
  });

  it('keeps the R16 authority refusal for consignees without extending it to vendors', async () => {
    // A vendor may carry whatever name its letterhead does — even one
    // that would be refused as a consignee designation.
    const vendor = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'DFM Industrial Supplies',
        address: 'Transport Nagar, Kanpur',
        isVendor: true,
      },
    });
    expect(vendor.statusCode, vendor.body).toBe(201);
    const dfmVendorId = vendor.json<Contact>().id;

    // The same designation as a plain (consignee) create stays refused.
    const consignee = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'DFM Industrial Supplies',
        address: 'Somewhere Else Entirely',
      },
    });
    expect(consignee.statusCode).toBe(400);
    expect(consignee.json()).toMatchObject({ code: 'CONSIGNEE_AUTHORITY_FORBIDDEN' });

    // A rename of the vendor is judged as a vendor, not a consignee —
    // and the omitted role flags survive the update untouched.
    const renamed = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/contacts/${dfmVendorId}`,
      organisationId,
      payload: {
        designation: 'Sr. DFM Enterprises',
        address: 'Transport Nagar, Kanpur',
      },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json<Contact>()).toMatchObject({
      designation: 'Sr. DFM Enterprises',
      isVendor: true,
      isConsignee: false,
    });
  });

  it('keeps stored role flags on update unless explicitly changed', async () => {
    // The web profile form sends no role fields: nothing is stripped.
    const untouched = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/contacts/${clientId}`,
      organisationId,
      payload: {
        designation: 'Sunrise Infra Projects LLP',
        address: '4th Floor, Baner Road, Pune',
        phone: '020-25501234',
      },
    });
    expect(untouched.statusCode, untouched.body).toBe(200);
    expect(untouched.json<Contact>()).toMatchObject({
      isClient: true,
      isVendor: false,
      isConsignee: false,
      phone: '020-25501234',
    });

    // Explicit flags change the membership — both directions.
    const flipped = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/contacts/${clientId}`,
      organisationId,
      payload: {
        designation: 'Sunrise Infra Projects LLP',
        address: '4th Floor, Baner Road, Pune',
        isVendor: true,
        isClient: false,
      },
    });
    expect(flipped.statusCode, flipped.body).toBe(200);
    expect(flipped.json<Contact>()).toMatchObject({
      isVendor: true,
      isClient: false,
      isConsignee: false,
    });

    const restored = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/contacts/${clientId}`,
      organisationId,
      payload: {
        designation: 'Sunrise Infra Projects LLP',
        address: '4th Floor, Baner Road, Pune',
        isVendor: false,
        isClient: true,
      },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json<Contact>()).toMatchObject({
      isVendor: false,
      isClient: true,
    });
  });

  it('filters the picker lists by role', async () => {
    const vendors = await authed(viewer, {
      method: 'GET',
      url: '/api/masters/contacts?role=vendor',
      organisationId,
    });
    expect(vendors.statusCode, vendors.body).toBe(200);
    const vendorList = vendors.json<{ contacts: Contact[] }>().contacts;
    expect(vendorList.map((c) => c.id)).toContain(vendorId);
    expect(vendorList.map((c) => c.id)).not.toContain(clientId);
    expect(vendorList.every((c) => c.isVendor)).toBe(true);

    const clients = await authed(viewer, {
      method: 'GET',
      url: '/api/masters/contacts?role=client',
      organisationId,
    });
    const clientList = clients.json<{ contacts: Contact[] }>().contacts;
    expect(clientList.map((c) => c.id)).toContain(clientId);
    expect(clientList.map((c) => c.id)).not.toContain(vendorId);
    expect(clientList.every((c) => c.isClient)).toBe(true);

    // Railway document flows stay railway-only (§9): neither the vendor
    // nor the client appears in the consignee picker.
    const consignees = await authed(viewer, {
      method: 'GET',
      url: '/api/masters/contacts?role=consignee',
      organisationId,
    });
    const consigneeIds = consignees
      .json<{ contacts: Contact[] }>()
      .contacts.map((c) => c.id);
    expect(consigneeIds).not.toContain(vendorId);
    expect(consigneeIds).not.toContain(clientId);
  });

  it('refuses vendor-role contacts as Work consignees through the API (R16)', async () => {
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/consignees`,
      organisationId,
      payload: { contactId: vendorId },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'CONTACT_NOT_CONSIGNEE' });
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

describe('organisation profile: the contractor own GSTIN and email', () => {
  // Branding is read live at every render, so both fields are printed on
  // every Delivery Challan, Issue Challan, MB, extension letter, and
  // correction notice. They are proved exactly as a contact's are.

  it('validates and uppercases the GSTIN like a contact does', async () => {
    // Correctly typed but lowercase: accepted, stored uppercase. The
    // contacts endpoint has always accepted either case; this one used to
    // bounce it at the schema with a generic 400.
    const lower = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { gstin: '27aabcs1429b1zb' },
    });
    expect(lower.statusCode, lower.body).toBe(200);
    expect(lower.json<OrganisationProfile>().gstin).toBe('27AABCS1429B1ZB');

    // A deductor-shaped registration is accepted too — refusing it here
    // could only ever be a false refusal.
    const deductor = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { gstin: '27AAAGM0289C1DD' },
    });
    expect(deductor.statusCode, deductor.body).toBe(200);
    expect(deductor.json<OrganisationProfile>().gstin).toBe('27AAAGM0289C1DD');

    // An unrelated field edit leaves the stored GSTIN alone (omitted is
    // "leave as it was", not "revalidate" and not "clear").
    const unrelated = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { contactPhone: '011-23385678' },
    });
    expect(unrelated.statusCode, unrelated.body).toBe(200);
    expect(unrelated.json<OrganisationProfile>().gstin).toBe('27AAAGM0289C1DD');

    // 15 uppercase alphanumerics is no longer enough: neither a filler
    // string nor a transposed GSTIN is a GSTIN.
    for (const gstin of ['AAAAAAAAAAAAAAA', '27AABCS1429BZ1B']) {
      const refused = await authed(owner, {
        method: 'PATCH',
        url: '/api/organisation/profile',
        organisationId,
        payload: { gstin },
      });
      expect(refused.statusCode, `${gstin}: ${refused.body}`).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'GSTIN_INVALID' });
    }

    // The refusal wrote nothing; the good value still stands.
    const read = await authed(viewer, {
      method: 'GET',
      url: '/api/organisation/profile',
      organisationId,
    });
    expect(read.json<OrganisationProfile>().gstin).toBe('27AAAGM0289C1DD');

    // Clearing an unregistered organisation's GSTIN stays possible.
    const cleared = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { gstin: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<OrganisationProfile>().gstin).toBeNull();
  });

  it('refuses a letterhead email that is not an email address', async () => {
    const saved = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { contactEmail: '  accounts+gst@sharma-electricals.co.in  ' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<OrganisationProfile>().contactEmail).toBe(
      'accounts+gst@sharma-electricals.co.in',
    );

    for (const contactEmail of ['n/a', '---', '011-23385678', 'office@ — ask Ramesh']) {
      const refused = await authed(owner, {
        method: 'PATCH',
        url: '/api/organisation/profile',
        organisationId,
        payload: { contactEmail },
      });
      expect(refused.statusCode, `${contactEmail}: ${refused.body}`).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'EMAIL_INVALID' });
    }

    // Nothing junk reached the letterhead.
    const read = await authed(viewer, {
      method: 'GET',
      url: '/api/organisation/profile',
      organisationId,
    });
    expect(read.json<OrganisationProfile>().contactEmail).toBe(
      'accounts+gst@sharma-electricals.co.in',
    );

    const cleared = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { contactEmail: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<OrganisationProfile>().contactEmail).toBeNull();
  });
});

describe('snapshot-on-use: masters never rewrite documents', () => {
  it('keeps an issued challan intact after its source contact is edited and retired', async () => {
    // The contact a UI picker would choose from…
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'SSE (Signal) GZB',
        address: 'Signal Workshop, Ghaziabad',
        phone: '0120-2700000',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const master = created.json<Contact>();

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

    // Mutate and retire the contact afterwards.
    const renamed = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/contacts/${master.id}`,
      organisationId,
      payload: {
        designation: 'SSE (Signal) MRT',
        address: 'Signal Workshop, Meerut',
      },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${master.id}/retire`,
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
  let victimContactId: string;
  let victimUnitId: string;

  beforeAll(async () => {
    const contacts = await authed(owner, {
      method: 'GET',
      url: '/api/masters/contacts?includeRetired=true',
      organisationId,
    });
    const firstContact = contacts.json<{ contacts: Contact[] }>().contacts[0];
    if (!firstContact) throw new Error('expected a seeded contact');
    victimContactId = firstContact.id;

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
    const contacts = await authed(foreignOwner, {
      method: 'GET',
      url: '/api/masters/contacts?includeRetired=true',
      organisationId: foreignOrganisationId,
    });
    expect(contacts.statusCode).toBe(200);
    expect(contacts.json<{ contacts: Contact[] }>().contacts).toHaveLength(0);

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
      url: `/api/masters/contacts/${victimContactId}`,
      organisationId: foreignOrganisationId,
      payload: { designation: 'Hijacked Designation' },
    });
    expect(update.statusCode).toBe(404);

    const retire = await authed(foreignOwner, {
      method: 'POST',
      url: `/api/masters/contacts/${victimContactId}/retire`,
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

  it("answers 404 for another organisation's Work on the association routes", async () => {
    const list = await authed(foreignOwner, {
      method: 'GET',
      url: `/api/works/${workId}/consignees`,
      organisationId: foreignOrganisationId,
    });
    expect(list.statusCode).toBe(404);

    const link = await authed(foreignOwner, {
      method: 'POST',
      url: `/api/works/${workId}/consignees`,
      organisationId: foreignOrganisationId,
      payload: { contactId: victimContactId },
    });
    expect(link.statusCode).toBe(404);

    const unlink = await authed(foreignOwner, {
      method: 'DELETE',
      url: `/api/works/${workId}/consignees/${victimContactId}`,
      organisationId: foreignOrganisationId,
    });
    expect(unlink.statusCode).toBe(404);
  });

  it('refuses a non-member binding the victim organisation header outright', async () => {
    const response = await authed(foreignOwner, {
      method: 'GET',
      url: '/api/masters/contacts',
      organisationId,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'NOT_A_MEMBER' });
  });
});

describe('GST rate master (finding 19)', () => {
  interface GstRateRow {
    id: string;
    rate: string;
    label: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }

  it('seeds the notified history at organisation creation, readable by every member', async () => {
    const list = await authed(viewer, {
      method: 'GET',
      url: '/api/masters/gst-rates',
      organisationId,
    });
    expect(list.statusCode, list.body).toBe(200);
    const rates = list.json<{ gstRates: GstRateRow[] }>().gstRates;
    expect(rates.length).toBeGreaterThanOrEqual(9);
    expect(rates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rate: '18.00',
          effectiveFrom: '2017-07-01',
          effectiveTo: null,
        }),
        // GST 2.0 (22 Sep 2025): 12% and 28% end-dated, 40% introduced.
        expect.objectContaining({ rate: '12.00', effectiveTo: '2025-09-21' }),
        expect.objectContaining({ rate: '28.00', effectiveTo: '2025-09-21' }),
        expect.objectContaining({
          rate: '40.00',
          effectiveFrom: '2025-09-22',
          effectiveTo: null,
        }),
      ]),
    );
  });

  it('keeps mutations owner-only', async () => {
    for (const jar of [clerk, viewer]) {
      const created = await authed(jar, {
        method: 'POST',
        url: '/api/masters/gst-rates',
        organisationId,
        payload: { rate: '6', label: 'Role probe', effectiveFrom: '2019-04-01' },
      });
      expect(created.statusCode).toBe(403);
      expect(created.json()).toMatchObject({ code: 'OWNER_REQUIRED' });
    }
    const [seeded] = await admin<{ id: string }[]>`
      select id from gst_rates
      where organisation_id = ${organisationId} and effective_to is null
      limit 1
    `;
    expect(seeded).toBeDefined();
    const ended = await authed(clerk, {
      method: 'POST',
      url: `/api/masters/gst-rates/${seeded?.id ?? ''}/end-date`,
      organisationId,
      payload: { effectiveTo: '2026-01-01' },
    });
    expect(ended.statusCode).toBe(403);
    expect(ended.json()).toMatchObject({ code: 'OWNER_REQUIRED' });
  });

  it('creates a rate with a window, refusing duplicates, inverted windows, and blank labels', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/masters/gst-rates',
      organisationId,
      payload: {
        rate: '6',
        label: 'Composition-era 6% (test rate)',
        effectiveFrom: '2019-04-01',
        effectiveTo: '2020-03-31',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<GstRateRow>()).toMatchObject({
      rate: '6.00',
      effectiveFrom: '2019-04-01',
      effectiveTo: '2020-03-31',
    });

    const duplicate = await authed(owner, {
      method: 'POST',
      url: '/api/masters/gst-rates',
      organisationId,
      payload: {
        rate: '6.00',
        label: 'Same rate, same start',
        effectiveFrom: '2019-04-01',
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'GST_RATE_EXISTS' });

    const inverted = await authed(owner, {
      method: 'POST',
      url: '/api/masters/gst-rates',
      organisationId,
      payload: {
        rate: '6',
        label: 'Window covers nothing',
        effectiveFrom: '2021-04-01',
        effectiveTo: '2021-03-31',
      },
    });
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json()).toMatchObject({ code: 'GST_RATE_WINDOW_INVALID' });

    const blank = await authed(owner, {
      method: 'POST',
      url: '/api/masters/gst-rates',
      organisationId,
      payload: { rate: '6', label: '  ', effectiveFrom: '2021-04-01' },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ code: 'GST_RATE_LABEL_INVALID' });
  });

  it('retires a rate by end-dating exactly once — no destructive edit or delete exists', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/masters/gst-rates',
      organisationId,
      payload: {
        rate: '9.5',
        label: 'End-dating semantics probe',
        effectiveFrom: '2019-04-01',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const rateId = created.json<GstRateRow>().id;

    const early = await authed(owner, {
      method: 'POST',
      url: `/api/masters/gst-rates/${rateId}/end-date`,
      organisationId,
      payload: { effectiveTo: '2019-03-31' },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json()).toMatchObject({ code: 'GST_RATE_WINDOW_INVALID' });

    const ended = await authed(owner, {
      method: 'POST',
      url: `/api/masters/gst-rates/${rateId}/end-date`,
      organisationId,
      payload: { effectiveTo: '2026-01-31' },
    });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json<GstRateRow>().effectiveTo).toBe('2026-01-31');

    // History is never rewritten: a second end-date is a conflict, and
    // there is no update or delete route at all.
    const again = await authed(owner, {
      method: 'POST',
      url: `/api/masters/gst-rates/${rateId}/end-date`,
      organisationId,
      payload: { effectiveTo: '2026-06-30' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'GST_RATE_ALREADY_ENDED' });

    const unknown = await authed(owner, {
      method: 'POST',
      url: `/api/masters/gst-rates/${randomUUID()}/end-date`,
      organisationId,
      payload: { effectiveTo: '2026-01-31' },
    });
    expect(unknown.statusCode).toBe(404);

    // Both mutations left their audit trail.
    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_type = 'gst_rates'
    `;
    const actions = events.map((event) => event.action);
    expect(actions).toContain('gst_rate.created');
    expect(actions).toContain('gst_rate.end_dated');
  });

  it("answers 404 for another tenant's rate, exactly like an unknown id", async () => {
    const [foreignRate] = await admin<{ id: string }[]>`
      select id from gst_rates
      where organisation_id = ${foreignOrganisationId} and effective_to is null
      limit 1
    `;
    expect(foreignRate).toBeDefined();
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/masters/gst-rates/${foreignRate?.id ?? ''}/end-date`,
      organisationId,
      payload: { effectiveTo: '2026-01-31' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'GST_RATE_NOT_FOUND' });
  });
});

describe('contact bank beneficiary details (migration 0078)', () => {
  const VALID = {
    bankAccountHolder: 'Metro Industrial Supplies',
    bankName: 'State Bank of India',
    bankAccountNumber: '20199473820',
    bankIfsc: 'sbin0000300',
    bankBranch: 'Andheri East',
    bankAccountType: 'Current',
  };

  it('stores a beneficiary, uppercasing the IFSC and returning it in full', async () => {
    const created = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: { designation: `Bank Vendor ${runId}`, isVendor: true, ...VALID },
    });
    expect(created.statusCode, created.body).toBe(201);
    // Returned in full, unlike the organisation's own accounts: this is
    // an edit form's record, and a masked number could not be
    // round-tripped through a full-replace update without wiping it.
    expect(created.json<Contact>()).toMatchObject({
      bankAccountHolder: 'Metro Industrial Supplies',
      bankName: 'State Bank of India',
      bankAccountNumber: '20199473820',
      bankIfsc: 'SBIN0000300',
      bankBranch: 'Andheri East',
      bankAccountType: 'Current',
    });
  });

  it('strips the spaces and hyphens a passbook prints', async () => {
    const created = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: `Spaced Account ${runId}`,
        isVendor: true,
        ...VALID,
        bankAccountNumber: '5010 2981-2476',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<Contact>().bankAccountNumber).toBe('501029812476');
  });

  it('refuses an IFSC that is not one, and says what the shape is', async () => {
    const response = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      // Eleven characters with a letter where the reserved zero belongs:
      // it passes the contract schema's length, so this proves the
      // handler's structural check rather than the schema.
      payload: { designation: `Bad IFSC ${runId}`, ...VALID, bankIfsc: 'SBINX000300' },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: 'IFSC_INVALID' });
  });

  it('refuses an account number that is a note rather than a number', async () => {
    for (const bankAccountNumber of ['n/a', '------', 'ASK RAMESH']) {
      const response = await authed(clerk, {
        method: 'POST',
        url: '/api/masters/contacts',
        organisationId,
        payload: { designation: `Junk ${runId}`, ...VALID, bankAccountNumber },
      });
      expect(response.statusCode, `${bankAccountNumber}: ${response.body}`).toBe(400);
    }
  });

  it('refuses a partial beneficiary: the four payable fields travel together', async () => {
    const response = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: `Partial ${runId}`,
        bankAccountNumber: '20199473820',
        bankIfsc: 'SBIN0000300',
        // No holder and no bank name: not a beneficiary anyone can pay.
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: 'BANK_DETAILS_INCOMPLETE' });
  });

  it('holds the completeness rule at the database too, for a writer that skips the route', async () => {
    await expect(
      admin`
        insert into contacts (
          organisation_id, designation, is_consignee, created_by_user_id,
          bank_account_number, bank_ifsc
        )
        values (
          ${organisationId}, ${`Direct SQL ${runId}`}, true, ${ownerUserId},
          '20199473820', 'SBIN0000300'
        )
      `,
    ).rejects.toThrow(/contacts_bank_details_shape_check/);
  });

  it('clears a beneficiary when the update omits it, and never audits the number', async () => {
    const created = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: { designation: `Clearing ${runId}`, isVendor: true, ...VALID },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<Contact>().id;

    const cleared = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/contacts/${id}`,
      organisationId,
      payload: { designation: `Clearing ${runId}` },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<Contact>()).toMatchObject({
      bankAccountHolder: null,
      bankName: null,
      bankAccountNumber: null,
      bankIfsc: null,
    });

    // The trail records that a contact changed, never what its account
    // number was — a trail carrying one would be a second place it could
    // leak from.
    const events = await admin<{ details: unknown }[]>`
      select details from audit_events
      where organisation_id = ${organisationId} and entity_id = ${id}
    `;
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(JSON.stringify(event.details)).not.toContain('20199473820');
    }
  });
});

describe('canonical items (migration 0078)', () => {
  let canonicalId: string;

  it('counts the schedule lines an item covers, by name and by alias', async () => {
    const before = await authed(viewer, {
      method: 'GET',
      url: '/api/masters/canonical-items',
      organisationId,
    });
    expect(before.statusCode, before.body).toBe(200);
    const unmappedBefore = before.json<{ unmappedLineCount: number }>()
      .unmappedLineCount;
    // The fixture Work carries one line described 'Point machine'.
    expect(unmappedBefore).toBeGreaterThanOrEqual(1);

    const created = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/canonical-items',
      organisationId,
      payload: {
        name: 'Electric point machine',
        groupName: 'Signalling',
        make: 'Siemens',
        defaultUnit: 'Nos',
        // Cased and padded on the way in, and one repeat: aliases are
        // match keys, so they normalise rather than store as typed.
        aliases: ['  POINT Machine  ', 'point machine'],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const item = created.json<{
      id: string;
      aliases: string[];
      mappedLineCount: number;
    }>();
    canonicalId = item.id;
    expect(item.aliases).toEqual(['point machine']);
    // Derived, so the count is right the moment the alias exists —
    // nothing had to be assigned to anything.
    expect(item.mappedLineCount).toBe(1);

    const after = await authed(viewer, {
      method: 'GET',
      url: '/api/masters/canonical-items',
      organisationId,
    });
    const listed = after.json<{
      items: { id: string; mappedLineCount: number }[];
      unmappedLineCount: number;
    }>();
    expect(listed.items.find((row) => row.id === canonicalId)?.mappedLineCount).toBe(1);
    expect(listed.unmappedLineCount).toBe(unmappedBefore - 1);
  });

  it('recomputes the count when an edit removes the alias that mapped a line', async () => {
    const updated = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/canonical-items/${canonicalId}`,
      organisationId,
      payload: {
        name: 'Electric point machine',
        groupName: 'Signalling',
        defaultUnit: 'Nos',
        aliases: ['thickweb switch'],
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<{ mappedLineCount: number }>().mappedLineCount).toBe(0);

    const restored = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/canonical-items/${canonicalId}`,
      organisationId,
      payload: {
        name: 'Electric point machine',
        groupName: 'Signalling',
        defaultUnit: 'Nos',
        aliases: ['point machine'],
      },
    });
    expect(restored.json<{ mappedLineCount: number }>().mappedLineCount).toBe(1);
  });

  it('refuses a second item claiming the same wording, case-insensitively', async () => {
    const response = await authed(clerk, {
      method: 'POST',
      url: '/api/masters/canonical-items',
      organisationId,
      payload: {
        name: '  electric POINT machine ',
        groupName: 'Signalling',
        defaultUnit: 'Nos',
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'CANONICAL_ITEM_EXISTS' });
  });

  it('returns a retired item’s lines to the unmapped queue, and blocks viewer writes', async () => {
    const denied = await authed(viewer, {
      method: 'POST',
      url: '/api/masters/canonical-items',
      organisationId,
      payload: { name: `Viewer item ${runId}`, groupName: 'Xx', defaultUnit: 'Nos' },
    });
    expect(denied.statusCode).toBe(403);

    const retired = await authed(clerk, {
      method: 'POST',
      url: `/api/masters/canonical-items/${canonicalId}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);
    expect(retired.json<{ active: boolean }>().active).toBe(false);

    // A retired item is no longer the organisation's answer for those
    // lines, so the warning has to count them again.
    const listed = await authed(viewer, {
      method: 'GET',
      url: '/api/masters/canonical-items?includeRetired=true',
      organisationId,
    });
    const payload = listed.json<{
      items: { id: string; active: boolean }[];
      unmappedLineCount: number;
    }>();
    expect(payload.items.find((row) => row.id === canonicalId)?.active).toBe(false);
    expect(payload.unmappedLineCount).toBeGreaterThanOrEqual(1);

    const back = await authed(clerk, {
      method: 'POST',
      url: `/api/masters/canonical-items/${canonicalId}/reactivate`,
      organisationId,
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json<{ mappedLineCount: number }>().mappedLineCount).toBe(1);
  });

  it("counts only the bound tenant's schedule lines, never another's", async () => {
    // The foreign organisation has no Works, so an identically worded
    // item there maps nothing: the count is computed inside the tenant
    // binding and cannot reach across it.
    const foreign = await authed(foreignOwner, {
      method: 'POST',
      url: '/api/masters/canonical-items',
      organisationId: foreignOrganisationId,
      payload: {
        name: 'Electric point machine',
        groupName: 'Signalling',
        defaultUnit: 'Nos',
        aliases: ['point machine'],
      },
    });
    expect(foreign.statusCode, foreign.body).toBe(201);
    expect(foreign.json<{ mappedLineCount: number }>().mappedLineCount).toBe(0);
    const foreignId = foreign.json<{ id: string }>().id;

    // Neither tenant reaches the other's row: an id from across the
    // boundary answers exactly as an unknown one does.
    const reached = await authed(clerk, {
      method: 'PUT',
      url: `/api/masters/canonical-items/${foreignId}`,
      organisationId,
      payload: { name: 'Stolen', groupName: 'Xx', defaultUnit: 'Nos' },
    });
    expect(reached.statusCode).toBe(404);
    expect(reached.json()).toMatchObject({ code: 'CANONICAL_ITEM_NOT_FOUND' });

    const listedHere = await authed(owner, {
      method: 'GET',
      url: '/api/masters/canonical-items?includeRetired=true',
      organisationId,
    });
    expect(
      listedHere.json<{ items: { id: string }[] }>().items.map((row) => row.id),
    ).not.toContain(foreignId);
  });

  it('has no hard-delete path: even the application role cannot DELETE', async () => {
    const appPool = createDatabasePool({
      url: appUrl,
      max: 1,
      applicationName: 'auto-mb-masters-canonical-delete',
    });
    try {
      await expect(appPool`delete from canonical_items`).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await appPool.end();
    }
  });
});

describe("the organisation's own bank accounts (migration 0078)", () => {
  let accountId: string;

  it('adds an account for the owner and answers only its last four digits', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/organisation/bank-accounts',
      organisationId,
      payload: {
        accountHolder: 'Masters Constructions',
        bankName: 'HDFC Bank',
        accountNumber: '50100298124761',
        ifsc: 'hdfc0001245',
        branch: 'Andheri East',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const account = created.json<Record<string, unknown>>();
    accountId = account['id'] as string;
    expect(account).toMatchObject({
      accountHolder: 'Masters Constructions',
      bankName: 'HDFC Bank',
      accountNumberLast4: '4761',
      ifsc: 'HDFC0001245',
      branch: 'Andheri East',
      active: true,
    });
    expect(created.body).not.toContain('50100298124761');

    // Stored in full, though: an invoice that prints bank details needs
    // the real number and reads the column server-side.
    const [stored] = await admin<{ account_number: string }[]>`
      select account_number from organisation_bank_accounts where id = ${accountId}
    `;
    expect(stored?.account_number).toBe('50100298124761');
  });

  it('lets any member read the list and refuses a non-owner write', async () => {
    const listed = await authed(viewer, {
      method: 'GET',
      url: '/api/organisation/bank-accounts',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(
      listed.json<{ accounts: { id: string }[] }>().accounts.map((row) => row.id),
    ).toContain(accountId);
    expect(listed.body).not.toContain('50100298124761');

    // Office writes master data everywhere else in this file; the
    // company's own identity is owner-only, like the profile it sits in.
    const denied = await authed(clerk, {
      method: 'POST',
      url: '/api/organisation/bank-accounts',
      organisationId,
      payload: {
        accountHolder: 'Clerk Attempt',
        bankName: 'HDFC Bank',
        accountNumber: '50100298124762',
        ifsc: 'HDFC0001245',
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'OWNER_REQUIRED' });
  });

  it('proves the same IFSC and account shapes the contacts master proves', async () => {
    for (const [field, fields] of [
      ['ifsc', { ifsc: 'HDFCX001245', accountNumber: '50100298124763' }],
      ['accountNumber', { ifsc: 'HDFC0001245', accountNumber: 'n/a' }],
    ] as const) {
      const response = await authed(owner, {
        method: 'POST',
        url: '/api/organisation/bank-accounts',
        organisationId,
        payload: {
          accountHolder: 'Masters Constructions',
          bankName: 'HDFC Bank',
          ...fields,
        },
      });
      expect(response.statusCode, `${field}: ${response.body}`).toBe(400);
    }
  });

  it('refuses the same live account twice, and lets a retired one come back', async () => {
    const duplicate = await authed(owner, {
      method: 'POST',
      url: '/api/organisation/bank-accounts',
      organisationId,
      payload: {
        accountHolder: 'Masters Constructions',
        bankName: 'HDFC Bank',
        accountNumber: '50100298124761',
        ifsc: 'HDFC0001245',
      },
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'BANK_ACCOUNT_EXISTS' });

    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/organisation/bank-accounts/${accountId}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);
    expect(retired.json<{ active: boolean }>().active).toBe(false);

    // The live-account index is partial, so the account may be added
    // again once the wrong row is out of the way.
    const readded = await authed(owner, {
      method: 'POST',
      url: '/api/organisation/bank-accounts',
      organisationId,
      payload: {
        accountHolder: 'Masters Constructions',
        bankName: 'HDFC Bank',
        accountNumber: '50100298124761',
        ifsc: 'HDFC0001245',
      },
    });
    expect(readded.statusCode, readded.body).toBe(201);

    // And reactivating the retired row now collides with the live one
    // rather than producing two accounts carrying one number.
    const collides = await authed(owner, {
      method: 'POST',
      url: `/api/organisation/bank-accounts/${accountId}/reactivate`,
      organisationId,
    });
    expect(collides.statusCode, collides.body).toBe(409);
    expect(collides.json()).toMatchObject({ code: 'BANK_ACCOUNT_EXISTS' });
  });

  it("answers 404 for another tenant's account and never lists it", async () => {
    const foreign = await authed(foreignOwner, {
      method: 'POST',
      url: '/api/organisation/bank-accounts',
      organisationId: foreignOrganisationId,
      payload: {
        accountHolder: 'Foreign Constructions',
        bankName: 'ICICI Bank',
        accountNumber: '034201009876',
        ifsc: 'ICIC0000342',
      },
    });
    expect(foreign.statusCode, foreign.body).toBe(201);
    const foreignId = foreign.json<{ id: string }>().id;

    const reached = await authed(owner, {
      method: 'POST',
      url: `/api/organisation/bank-accounts/${foreignId}/retire`,
      organisationId,
    });
    expect(reached.statusCode).toBe(404);
    expect(reached.json()).toMatchObject({ code: 'BANK_ACCOUNT_NOT_FOUND' });

    const listed = await authed(owner, {
      method: 'GET',
      url: '/api/organisation/bank-accounts?includeRetired=true',
      organisationId,
    });
    expect(
      listed.json<{ accounts: { id: string }[] }>().accounts.map((row) => row.id),
    ).not.toContain(foreignId);
  });

  it('audits the addition without recording the account number', async () => {
    const events = await admin<{ action: string; details: unknown }[]>`
      select action, details from audit_events
      where organisation_id = ${organisationId}
        and entity_type = 'organisation_bank_accounts'
    `;
    expect(events.map((event) => event.action)).toContain(
      'organisation.bank_account_added',
    );
    for (const event of events) {
      expect(JSON.stringify(event.details)).not.toContain('50100298124761');
    }
  });
});
