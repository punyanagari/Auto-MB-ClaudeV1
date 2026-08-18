import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { SearchResponse, SearchResultKind } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * Tenant-wide record search (`GET /api/search`) — the endpoint behind the
 * header control that had always been labelled "Search Works and records"
 * while only ever navigating to the Works register.
 *
 * The two boundaries this proves are the reason the endpoint is
 * high-risk. A search reads seven registers at once, so a tenancy or
 * work-scope hole here does not leak one record — it leaks the shape of
 * another organisation's whole business, and a document number is enough
 * to act on. Both denials are therefore tested against a live
 * neighbouring organisation and a live assigned-scope member, not
 * asserted from the SQL.
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
const ownerEmail = `search-owner-${runId}@integration.test`;
const scopedEmail = `search-scoped-${runId}@integration.test`;
const outsiderEmail = `search-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

/** A token unique to this run, embedded in every seeded record so one
 * query matches across organisations and Works — which is exactly what
 * makes the denials meaningful rather than accidental. */
const token = `ZQ${runId.slice(0, 6).toUpperCase()}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let scopedUserId: string;
let outsiderUserId: string;
let assignedWorkId: string;
let unassignedWorkId: string;
let outsiderWorkId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
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

async function search(jar: CookieJar, query: string, org: string) {
  return authed(jar, {
    method: 'GET',
    url: `/api/search?q=${encodeURIComponent(query)}`,
    organisationId: org,
  });
}

/** Every result id in a response, flattened across its groups. */
function idsOf(response: SearchResponse): string[] {
  return response.groups.flatMap((group) => group.results.map((row) => row.id));
}

function groupOf(response: SearchResponse, kind: SearchResultKind) {
  return response.groups.find((group) => group.kind === kind);
}

async function seedWork(
  org: string,
  userId: string,
  code: string,
  title: string,
): Promise<{ workId: string; itemId: string }> {
  const workId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${org}, ${code}, ${`L-${code}`}, '2026-01-10', ${title},
      '100000.00', '90000.00', 'per_schedule', ${userId}
    )
  `;
  const scheduleId = randomUUID();
  await admin`
    insert into work_schedules (
      id, organisation_id, work_id, schedule_code, title, position
    )
    values (${scheduleId}, ${org}, ${workId}, 'A', 'Schedule A', 1)
  `;
  const itemId = randomUUID();
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number,
      description, unit_code, awarded_quantity, effective_rate
    )
    values (
      ${itemId}, ${org}, ${workId}, ${scheduleId}, 'A/1',
      'Search fixture item', 'Nos', '1000.000', '10.00'
    )
  `;
  return { workId, itemId };
}

/** A draft delivery challan, so drafts are proven searchable by the party
 * they name before they have a number. */
async function draftChallan(
  jar: CookieJar,
  org: string,
  workId: string,
  itemId: string,
  consigneeName: string,
): Promise<string> {
  const created = await authed(jar, {
    method: 'POST',
    url: `/api/works/${workId}/challans`,
    organisationId: org,
    payload: {
      challanDate: '2026-08-08',
      prefix: 'SRCH',
      consignee: { name: consigneeName, address: 'Yard 2, Nashik' },
      items: [{ workItemId: itemId, quantity: '5.000' }],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<{ challan: { id: string } }>().challan.id;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-search-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-search-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Search Owner');
  scoped = await signUp(scopedEmail, 'Search Scoped');
  outsider = await signUp(outsiderEmail, 'Search Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Search Constructions', slug: `search-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const outsiderOrg = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Neighbour Works', slug: `search-out-${runId}` },
  });
  expect(outsiderOrg.statusCode, outsiderOrg.body).toBe(201);
  outsiderOrganisationId = outsiderOrg.json<{ id: string }>().id;

  const users = await admin<{ id: string; email: string }[]>`
    select "id", "email" from auth_users
    where "email" like ${`%-${runId}@integration.test`}
  `;
  const byEmail = new Map(users.map((row) => [row.email, row.id]));
  ownerUserId = byEmail.get(ownerEmail) ?? '';
  scopedUserId = byEmail.get(scopedEmail) ?? '';
  outsiderUserId = byEmail.get(outsiderEmail) ?? '';
  expect(ownerUserId && scopedUserId && outsiderUserId).toBeTruthy();

  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
  const addedScoped = await authed(owner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId,
    payload: { email: scopedEmail, role: 'office' },
  });
  expect(addedScoped.statusCode, addedScoped.body).toBe(201);
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId} and user_id = ${scopedUserId}
  `;

  // Three Works whose codes and titles all carry the run token, in two
  // organisations, so one query would sweep all three if either boundary
  // were missing.
  const assigned = await seedWork(
    organisationId,
    ownerUserId,
    `${token}-ASSIGNED`,
    `Signalling upgrade ${token} assigned`,
  );
  const unassigned = await seedWork(
    organisationId,
    ownerUserId,
    `${token}-UNASSIGNED`,
    `Signalling upgrade ${token} unassigned`,
  );
  const outsiderWork = await seedWork(
    outsiderOrganisationId,
    outsiderUserId,
    `${token}-OUTSIDER`,
    `Signalling upgrade ${token} outsider`,
  );
  assignedWorkId = assigned.workId;
  unassignedWorkId = unassigned.workId;
  outsiderWorkId = outsiderWork.workId;

  await draftChallan(
    owner,
    organisationId,
    assignedWorkId,
    assigned.itemId,
    `${token} Depot Store`,
  );
  await draftChallan(
    owner,
    organisationId,
    unassignedWorkId,
    unassigned.itemId,
    `${token} Depot Store`,
  );
  await draftChallan(
    outsider,
    outsiderOrganisationId,
    outsiderWorkId,
    outsiderWork.itemId,
    `${token} Depot Store`,
  );

  const assignments = await authed(owner, {
    method: 'PUT',
    url: `/api/organisations/current/members/${scopedUserId}/assignments`,
    organisationId,
    payload: { workIds: [assignedWorkId] },
  });
  expect(assignments.statusCode, assignments.body).toBe(200);
}, 90_000);

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
    await admin`
      delete from auth_users where "email" like ${`%-${runId}@integration.test`}
    `;
    await admin.end();
  }
  if (app) await app.close();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('tenant-wide record search', () => {
  it('spans the registers, not just Works', async () => {
    const response = await search(owner, token, organisationId);
    expect(response.statusCode, response.body).toBe(200);
    const found = response.json<SearchResponse>();

    // The label promised records. Works AND documents come back, grouped
    // by register rather than mixed into one list.
    expect(found.groups.map((group) => group.kind)).toEqual(
      expect.arrayContaining(['work', 'delivery-challan']),
    );
    expect(found.query).toBe(token);
    expect(found.returned).toBe(idsOf(found).length);

    const works = groupOf(found, 'work');
    expect(works?.results.map((row) => row.id).sort()).toEqual(
      [assignedWorkId, unassignedWorkId].sort(),
    );
    // A Work result leads with its code and carries the title beside it.
    const assignedRow = works?.results.find((row) => row.id === assignedWorkId);
    expect(assignedRow?.label).toBe(`${token}-ASSIGNED`);
    expect(assignedRow?.detail).toContain('Signalling upgrade');
    expect(assignedRow?.workId).toBe(assignedWorkId);
  });

  it('finds a draft document by the party it names, and labels it as a draft', async () => {
    const found = (
      await search(owner, `${token} Depot`, organisationId)
    ).json<SearchResponse>();
    const challans = groupOf(found, 'delivery-challan');
    expect(challans?.results).toHaveLength(2);
    for (const row of challans?.results ?? []) {
      // A draft has no number yet. The row must not render an empty cell,
      // and must not look like an issued document either.
      expect(row.label).toBe('Delivery Challan (draft)');
      expect(row.status).toBe('draft');
      expect(row.detail).toContain(token);
      expect(row.workCode).toContain(token);
    }
  });

  it('never returns another organisation’s rows, on either side', async () => {
    // The same token matches a Work and a challan in the neighbouring
    // organisation. Neither member may see across.
    const ours = (await search(owner, token, organisationId)).json<SearchResponse>();
    expect(idsOf(ours)).not.toContain(outsiderWorkId);
    expect(idsOf(ours).length).toBeGreaterThan(0);

    const theirs = (
      await search(outsider, token, outsiderOrganisationId)
    ).json<SearchResponse>();
    expect(idsOf(theirs)).toContain(outsiderWorkId);
    expect(idsOf(theirs)).not.toContain(assignedWorkId);
    expect(idsOf(theirs)).not.toContain(unassignedWorkId);
  });

  it('refuses a member searching an organisation they do not belong to', async () => {
    // Naming someone else's organisation in the header is the obvious
    // attack on a cross-register endpoint. The membership floor answers
    // before any register is read.
    const response = await search(outsider, token, organisationId);
    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('NOT_A_MEMBER');
  });

  it('shows an assigned-scope member only their own Works and documents', async () => {
    const found = (await search(scoped, token, organisationId)).json<SearchResponse>();

    // A leak here would disclose the existence of a Work this member was
    // deliberately not assigned to — and its document numbers with it.
    expect(idsOf(found)).not.toContain(unassignedWorkId);
    expect(groupOf(found, 'work')?.results.map((row) => row.id)).toEqual([
      assignedWorkId,
    ]);
    const challans = groupOf(found, 'delivery-challan');
    expect(challans?.results).toHaveLength(1);
    expect(challans?.results[0]?.workId).toBe(assignedWorkId);
  });

  it('treats the query as literal text, not a pattern', async () => {
    // Without escaping, a bare `%` would return every row in the
    // organisation — a wildcard the caller never asked for.
    const response = await search(owner, '%%', organisationId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<SearchResponse>().groups).toEqual([]);
  });

  it('refuses a one-character query rather than scanning every register', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/search?q=Z',
      organisationId,
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers a query that matches nothing with empty groups, not an error', async () => {
    const found = (
      await search(owner, 'no-such-record-anywhere', organisationId)
    ).json<SearchResponse>();
    expect(found.groups).toEqual([]);
    expect(found.returned).toBe(0);
  });
});
