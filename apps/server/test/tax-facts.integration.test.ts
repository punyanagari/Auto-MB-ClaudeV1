import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { OrganisationProfile } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  createDatabasePool,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * The tax facts migration 0033 added, and the two writers that record
 * them: PATCH /api/work-items/:id/tax-facts (HSN/SAC, GST rate, service
 * flag) and the organisation profile's `stateCode`.
 *
 * Neither is a document, so there is no numbering and no issue here; what
 * has to hold instead is that the item writer takes the same gates as
 * every other Work-scoped writer (writer role, work scope, tenant, and
 * R8's completed-Work refusal), that concurrent edits serialise under the
 * row lock so the audit chain stays truthful, and that the organisation's
 * state code can never be edited into contradicting its own GSTIN — that
 * pair decides CGST+SGST against IGST on every invoice raised afterwards.
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
const ownerEmail = `tax-owner-${runId}@integration.test`;
const officeEmail = `tax-office-${runId}@integration.test`;
const viewerEmail = `tax-viewer-${runId}@integration.test`;
const assignedEmail = `tax-assigned-${runId}@integration.test`;
const outsiderEmail = `tax-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

/** Both registered in state 07 (Delhi) and state 27 (Maharashtra): the
 * standard 15-character shape, differing only in the state prefix. */
const GSTIN_07 = '07ABCDE1234F1Z5';
const GSTIN_27 = '27ABCDE1234F1Z5';
const GSTIN_19 = '19ABCDE1234F1Z5';

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let workId: string;
let itemAId: string;
let itemBId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
let viewer: CookieJar;
let assigned: CookieJar;
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

interface TaxFactsResponse {
  id: string;
  itemNumber: string;
  hsnCode: string | null;
  gstRate: string | null;
  isService: boolean;
}

async function patchTaxFacts(
  jar: CookieJar,
  itemId: string,
  payload: Record<string, unknown>,
  organisation = organisationId,
) {
  return authed(jar, {
    method: 'PATCH',
    url: `/api/work-items/${itemId}/tax-facts`,
    organisationId: organisation,
    payload,
  });
}

async function patchProfile(jar: CookieJar, payload: Record<string, unknown>) {
  return authed(jar, {
    method: 'PATCH',
    url: '/api/organisation/profile',
    organisationId,
    payload,
  });
}

async function readProfile(): Promise<OrganisationProfile> {
  const response = await authed(owner, {
    method: 'GET',
    url: '/api/organisation/profile',
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<OrganisationProfile>();
}

async function storedItem(itemId: string) {
  const [row] = await admin<
    { hsn_code: string | null; gst_rate: string | null; is_service: boolean }[]
  >`
    select hsn_code, gst_rate::text as gst_rate, is_service
    from work_items where id = ${itemId}
  `;
  return row;
}

interface AuditRow extends Record<string, unknown> {
  action: string;
  details: {
    itemNumber?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  };
}

async function taxAudits(itemId: string): Promise<AuditRow[]> {
  return admin<AuditRow[]>`
    select action, details from audit_events
    where organisation_id = ${organisationId}
      and entity_type = 'work_items' and entity_id = ${itemId}
      and action = 'work_item.tax_facts_changed'
    order by occurred_at, id
  `;
}

/** The Work's status is moved directly here: completing it through the
 * API demands a fully executed, fully clean Work, which is a different
 * slice's fixture. The 0031 transition trigger still holds — the notes
 * and timestamps below are what it requires of every writer. */
async function setWorkStatus(status: 'completed' | 'active'): Promise<void> {
  if (status === 'completed') {
    await admin`
      update works set status = 'completed', completed_at = now(),
        completed_by_user_id = ${ownerUserId},
        completion_note = 'tax fixture completion',
        reopened_at = null, reopened_by_user_id = null, reopen_note = null
      where id = ${workId}
    `;
    return;
  }
  await admin`
    update works set status = 'active', completed_at = null,
      completed_by_user_id = null, completion_note = null,
      reopened_at = now(), reopened_by_user_id = ${ownerUserId},
      reopen_note = 'tax fixture reopen'
    where id = ${workId}
  `;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    // Three: one for the competing transaction the lock test holds open,
    // and room to read alongside it.
    max: 3,
    applicationName: 'auto-mb-tax-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the tax-facts integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-tax-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'TAX Owner');
  office = await signUp(officeEmail, 'TAX Office');
  viewer = await signUp(viewerEmail, 'TAX Viewer');
  assigned = await signUp(assignedEmail, 'TAX Assigned');
  outsider = await signUp(outsiderEmail, 'TAX Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'TAX Constructions', slug: `tax-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'TAX Outsiders', slug: `tax-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [officeEmail, 'office'],
    [viewerEmail, 'viewer'],
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

  // An assigned-scope member holding no assignment to the fixture Work:
  // every Work-addressed route must answer 404, never 403.
  const [assignedUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${assignedEmail}
  `;
  if (!assignedUser) throw new Error('assigned user missing');
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId} and user_id = ${assignedUser.id}
  `;

  workId = randomUUID();
  const scheduleId = randomUUID();
  itemAId = randomUUID();
  itemBId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`TAXW-${runId.toUpperCase()}`},
      ${`tax-letter-${runId}`}, '2025-06-01', 'Tax facts fixture work',
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
      unit_code, awarded_quantity, effective_rate
    )
    values
      (${itemAId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
       'Main switchboard', 'Nos', 10.000, 250.00),
      (${itemBId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/2',
       'Erection and commissioning', 'Job', 1.000, 4000.00)
  `;
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
  }
  await app?.close();
  await admin?.end();
  if (storageDir !== undefined) {
    await rm(storageDir, { recursive: true, force: true });
  }
});

describe('work item tax facts', () => {
  it('records HSN, GST rate and the service flag, with a before/after audit', async () => {
    const response = await patchTaxFacts(office, itemAId, {
      hsnCode: '85371000',
      gstRate: '18',
      isService: false,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<TaxFactsResponse>()).toMatchObject({
      id: itemAId,
      itemNumber: 'A/1',
      hsnCode: '85371000',
      // numeric(5,2) verbatim: the exact stored decimal, never a float.
      gstRate: '18.00',
      isService: false,
    });
    expect(await storedItem(itemAId)).toMatchObject({
      hsn_code: '85371000',
      gst_rate: '18.00',
      is_service: false,
    });

    const events = await taxAudits(itemAId);
    expect(events).toHaveLength(1);
    expect(events[0]?.details.itemNumber).toBe('A/1');
    expect(events[0]?.details.before).toMatchObject({ hsnCode: null, gstRate: null });
    expect(events[0]?.details.after).toMatchObject({
      hsnCode: '85371000',
      gstRate: '18.00',
    });
  });

  it('leaves absent fields alone and clears with an explicit null', async () => {
    const flagged = await patchTaxFacts(office, itemAId, { isService: true });
    expect(flagged.statusCode, flagged.body).toBe(200);
    expect(flagged.json<TaxFactsResponse>()).toMatchObject({
      hsnCode: '85371000',
      gstRate: '18.00',
      isService: true,
    });

    const cleared = await patchTaxFacts(office, itemAId, { hsnCode: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<TaxFactsResponse>()).toMatchObject({
      hsnCode: null,
      gstRate: '18.00',
      isService: true,
    });
    expect(await storedItem(itemAId)).toMatchObject({
      hsn_code: null,
      gst_rate: '18.00',
    });

    // Restore the item to a fully-populated, goods-shaped state.
    const restored = await patchTaxFacts(office, itemAId, {
      hsnCode: '85371000',
      isService: false,
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it('accepts a SAC on a service item and a nil rate', async () => {
    const response = await patchTaxFacts(owner, itemBId, {
      hsnCode: '995461',
      gstRate: '0',
      isService: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<TaxFactsResponse>()).toMatchObject({
      hsnCode: '995461',
      // Exempt and nil-rated supply are real: zero is a value, not a gap.
      gstRate: '0.00',
      isService: true,
    });
  });

  it('refuses at the boundary exactly what the columns refuse', async () => {
    const rejected = [
      { hsnCode: '123' },
      { hsnCode: '123456789' },
      { hsnCode: '85AB1000' },
      { hsnCode: '8537.10' },
      { gstRate: '101' },
      { gstRate: '18.005' },
      { gstRate: '-5' },
      { gstRate: 'eighteen' },
      { isService: 'sometimes' },
    ];
    for (const payload of rejected) {
      const response = await patchTaxFacts(office, itemAId, payload);
      expect(response.statusCode, `${JSON.stringify(payload)}: ${response.body}`).toBe(
        400,
      );
    }
    // Untouched by any of them.
    expect(await storedItem(itemAId)).toMatchObject({
      hsn_code: '85371000',
      gst_rate: '18.00',
    });

    // The same bounds are the columns' own CHECKs, so raw SQL is refused
    // too — the route's 400 is the friendly face of a real constraint.
    await expect(
      admin`update work_items set hsn_code = '123' where id = ${itemAId}`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin`update work_items set gst_rate = 101 where id = ${itemAId}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('reads an empty field as "there is none", like every nullable field here', async () => {
    // A form that submits a cleared input sends '', which the framework
    // coerces to null on a nullable field — the same reading `address`
    // and `gstin` have always had on the organisation profile. Worth
    // pinning: for a tax fact it is the difference between clearing a
    // wrong HSN and storing an empty one the IRP would reject.
    const cleared = await patchTaxFacts(office, itemAId, { gstRate: '' });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<TaxFactsResponse>().gstRate).toBeNull();

    const restored = await patchTaxFacts(office, itemAId, { gstRate: '18' });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json<TaxFactsResponse>().gstRate).toBe('18.00');
  });

  it('gates on the writer role, the work scope, the tenant, and a session', async () => {
    const deniedRole = await patchTaxFacts(viewer, itemAId, { gstRate: '5' });
    expect(deniedRole.statusCode).toBe(403);
    expect(deniedRole.json<{ code: string }>().code).toBe('ROLE_FORBIDDEN');

    // Out-of-scope and cross-tenant both answer 404: a guessed id must
    // not confirm that the item exists.
    const outOfScope = await patchTaxFacts(assigned, itemAId, { gstRate: '5' });
    expect(outOfScope.statusCode).toBe(404);

    const crossTenant = await patchTaxFacts(
      outsider,
      itemAId,
      { gstRate: '5' },
      outsiderOrganisationId,
    );
    expect(crossTenant.statusCode).toBe(404);

    const unknownItem = await patchTaxFacts(owner, randomUUID(), { gstRate: '5' });
    expect(unknownItem.statusCode).toBe(404);

    const anonymous = await app.inject({
      method: 'PATCH',
      url: `/api/work-items/${itemAId}/tax-facts`,
      headers: { 'x-organisation-id': organisationId },
      payload: { gstRate: '5' },
    });
    expect(anonymous.statusCode).toBe(401);

    expect(await storedItem(itemAId)).toMatchObject({ gst_rate: '18.00' });
  });

  it('refuses on a completed Work and accepts again once it is reopened', async () => {
    await setWorkStatus('completed');
    try {
      const refused = await patchTaxFacts(office, itemAId, { gstRate: '12' });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json<{ code: string }>().code).toBe('WORK_COMPLETED');
      expect(await storedItem(itemAId)).toMatchObject({ gst_rate: '18.00' });
    } finally {
      await setWorkStatus('active');
    }

    const accepted = await patchTaxFacts(office, itemAId, { gstRate: '12' });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json<TaxFactsResponse>().gstRate).toBe('12.00');
  });

  it('waits on the row lock and re-reads, so the audit chain cannot go stale', async () => {
    // Deterministic contention: a competing transaction holds the item
    // row while the route runs. Without the lock the route would read
    // the pre-competitor value, overwrite it, and record a `before` that
    // never existed — an audit trail that lies about what was replaced.
    const before = (await taxAudits(itemBId)).length;
    let lockTaken!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const releasing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const competitor = admin.begin(async (tx) => {
      await tx`update work_items set gst_rate = 7 where id = ${itemBId}`;
      lockTaken();
      await releasing;
    });
    await held;

    let settled = false;
    const patch = patchTaxFacts(office, itemBId, { gstRate: '9' }).then((response) => {
      settled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Still waiting: the row belongs to the competitor until it commits.
    expect(settled).toBe(false);

    release();
    await competitor;
    const response = await patch;
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<TaxFactsResponse>().gstRate).toBe('9.00');
    expect(await storedItem(itemBId)).toMatchObject({ gst_rate: '9.00' });

    // The `before` is the competitor's committed 7.00 — the value the
    // route actually replaced — not the 0.00 it would have read had it
    // taken its snapshot before waiting.
    const events = (await taxAudits(itemBId)).slice(before);
    expect(events).toHaveLength(1);
    expect(events[0]?.details.before).toMatchObject({ gstRate: '7.00' });
    expect(events[0]?.details.after).toMatchObject({ gstRate: '9.00' });
  });

  it('keeps simultaneous edits to one row clean — one row, one winner', async () => {
    const before = (await taxAudits(itemBId)).length;
    const [first, second] = await Promise.all([
      patchTaxFacts(owner, itemBId, { gstRate: '5' }),
      patchTaxFacts(office, itemBId, { gstRate: '12' }),
    ]);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);

    const stored = await storedItem(itemBId);
    expect(['5.00', '12.00']).toContain(stored?.gst_rate);
    const events = (await taxAudits(itemBId)).slice(before);
    expect(events).toHaveLength(2);
    // Whichever committed last is what the row holds and what the last
    // audit event recorded: no lost update, no disagreeing pair.
    expect(events[1]?.details.after).toMatchObject({ gstRate: stored?.gst_rate ?? '' });
  });
});

describe('organisation GST state code', () => {
  it('stores a two-digit state code and serves it on the profile', async () => {
    const response = await patchProfile(owner, { stateCode: '07' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<OrganisationProfile>().stateCode).toBe('07');
    expect((await readProfile()).stateCode).toBe('07');

    const [event] = await admin<
      {
        details: { before?: Record<string, unknown>; after?: Record<string, unknown> };
      }[]
    >`
      select details from audit_events
      where organisation_id = ${organisationId}
        and action = 'organisation.profile_updated'
      order by occurred_at desc, id desc
      limit 1
    `;
    expect(event?.details.before).toMatchObject({ stateCode: null });
    expect(event?.details.after).toMatchObject({ stateCode: '07' });
  });

  it('refuses a state code that contradicts the stored GSTIN', async () => {
    const registered = await patchProfile(owner, { gstin: GSTIN_07 });
    expect(registered.statusCode, registered.body).toBe(200);

    const response = await patchProfile(owner, { stateCode: '27' });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('STATE_CODE_GSTIN_MISMATCH');
    // Nothing moved: the refusal is before the update.
    const profile = await readProfile();
    expect(profile.stateCode).toBe('07');
    expect(profile.gstin).toBe(GSTIN_07);
  });

  it('refuses a GSTIN that contradicts the stored state code', async () => {
    const response = await patchProfile(owner, { gstin: GSTIN_27 });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('STATE_CODE_GSTIN_MISMATCH');
    const profile = await readProfile();
    expect(profile.gstin).toBe(GSTIN_07);
    expect(profile.stateCode).toBe('07');
  });

  it('accepts a matching pair moved together, and refuses a contradicting one', async () => {
    const contradicting = await patchProfile(owner, {
      gstin: GSTIN_27,
      stateCode: '07',
    });
    expect(contradicting.statusCode).toBe(400);
    expect(contradicting.json<{ code: string }>().code).toBe(
      'STATE_CODE_GSTIN_MISMATCH',
    );

    const moved = await patchProfile(owner, { gstin: GSTIN_27, stateCode: '27' });
    expect(moved.statusCode, moved.body).toBe(200);
    const profile = moved.json<OrganisationProfile>();
    expect(profile.gstin).toBe(GSTIN_27);
    expect(profile.stateCode).toBe('27');
  });

  it('clears the state code, which frees the GSTIN of it', async () => {
    const cleared = await patchProfile(owner, { stateCode: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<OrganisationProfile>().stateCode).toBeNull();

    // With no state code stored there is nothing to contradict — an
    // unregistered-then-registered organisation can still move.
    const moved = await patchProfile(owner, { gstin: GSTIN_19 });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<OrganisationProfile>().gstin).toBe(GSTIN_19);

    const restored = await patchProfile(owner, { gstin: GSTIN_07, stateCode: '07' });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it('refuses anything that is not two digits, at the boundary and at the column', async () => {
    for (const stateCode of ['AB', '7', '007', '1a', '0 7', 7]) {
      const response = await patchProfile(owner, { stateCode });
      expect(response.statusCode, `${String(stateCode)}: ${response.body}`).toBe(400);
    }
    expect((await readProfile()).stateCode).toBe('07');

    // An empty field is a cleared field, as on every other nullable
    // profile value — not a state code of ''.
    const cleared = await patchProfile(owner, { stateCode: '' });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<OrganisationProfile>().stateCode).toBeNull();
    const restored = await patchProfile(owner, { stateCode: '07' });
    expect(restored.statusCode, restored.body).toBe(200);

    await expect(
      admin`update organisations set state_code = '7' where id = ${organisationId}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('is owner-only, and closed to non-members', async () => {
    const deniedRole = await patchProfile(office, { stateCode: '07' });
    expect(deniedRole.statusCode).toBe(403);
    expect(deniedRole.json<{ code: string }>().code).toBe('OWNER_REQUIRED');

    // A member of another tenant holds no membership here, so the
    // database's own binding floor refuses before any row is touched.
    const crossTenant = await authed(outsider, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { stateCode: '27' },
    });
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json<{ code: string }>().code).toBe('NOT_A_MEMBER');

    // And the outsider's own organisation is untouched by any of it.
    const theirs = await authed(outsider, {
      method: 'GET',
      url: '/api/organisation/profile',
      organisationId: outsiderOrganisationId,
    });
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(theirs.json<OrganisationProfile>().stateCode).toBeNull();

    const anonymous = await app.inject({
      method: 'PATCH',
      url: '/api/organisation/profile',
      headers: { 'x-organisation-id': organisationId },
      payload: { stateCode: '27' },
    });
    expect(anonymous.statusCode).toBe(401);

    expect((await readProfile()).stateCode).toBe('07');
  });
});
