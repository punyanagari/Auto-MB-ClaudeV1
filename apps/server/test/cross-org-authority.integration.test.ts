import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import {
  createDatabasePool,
  removeOrganisationResidue,
  runMigrations,
  withTenant,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import { membershipOf } from '../src/authz.js';

/**
 * Authority must be resolved in the organisation the request is bound to.
 *
 * The SELECT policy on organisation_memberships deliberately carries an
 * `OR user_id = current_user_id()` branch so the unbound organisation
 * picker (`/api/me`, `/api/organisations`) can list a user's own
 * memberships. That branch stays active under a bound tenant too, so any
 * membership read that filters on user_id alone can resolve a row from a
 * *different* organisation. Because a member's own row in an unrelated
 * organisation may carry owner role and the issue/cancel authorities,
 * such a read grants authority the caller does not hold here.
 *
 * These tests pin the fix: every bound-tenant membership read also
 * filters on app_private.current_organisation_id(). The escalation
 * organisation is created with an all-zero-prefixed id so it sorts first
 * and would win an unordered `LIMIT 1`-shaped read deterministically,
 * rather than depending on random UUID ordering.
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
const victimOwnerEmail = `xorg-owner-${runId}@integration.test`;
const attackerEmail = `xorg-attacker-${runId}@integration.test`;
const password = `integration-password-${runId}`;

// Sorts before any gen_random_uuid() value, so an organisation-blind read
// resolves this membership rather than the victim organisation's.
const escalationOrganisationId = '00000000-0000-4000-8000-000000000001';

let admin: Sql;
let appPool: Sql;
let app: FastifyInstance;
let storageDir: string;
let victimOrganisationId: string;
let attackerUserId: string;
let victimOwnerUserId: string;

interface CookieJar {
  cookie: string;
}
let victimOwner: CookieJar;
let attacker: CookieJar;

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
    applicationName: 'auto-mb-xorg-admin',
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

  // A pool on the unprivileged application role, so the resolver test
  // below runs under the same RLS the product runs under.
  appPool = createDatabasePool({
    url: appUrl,
    max: 2,
    applicationName: 'auto-mb-xorg-app',
  });

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-xorg-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  victimOwner = await signUp(victimOwnerEmail, 'Victim Owner');
  attacker = await signUp(attackerEmail, 'Attacker');

  const created = await authed(victimOwner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Victim Constructions', slug: `xorg-victim-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  victimOrganisationId = created.json<{ id: string }>().id;

  const users = await admin<{ id: string; email: string }[]>`
    select "id", "email" from auth_users
    where "email" like ${`%-${runId}@integration.test`}
  `;
  const byEmail = new Map(users.map((row) => [row.email, row.id]));
  victimOwnerUserId = byEmail.get(victimOwnerEmail) ?? '';
  attackerUserId = byEmail.get(attackerEmail) ?? '';
  expect(victimOwnerUserId && attackerUserId).toBeTruthy();

  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${victimOrganisationId}
      and user_id = ${victimOwnerUserId}
  `;

  // The escalation organisation the attacker owns outright. Any
  // authenticated user may create one through POST /api/organisations;
  // the fixed all-zero id here only removes ordering luck from the proof.
  //
  // Insertion order matters: this membership is written BEFORE the
  // attacker's viewer membership in the victim organisation, so an
  // organisation-blind `where user_id = ...` read resolves the owner row
  // first under both plausible plans — heap order (this row is earlier)
  // and the (user_id, organisation_id) index (this id sorts first). Both
  // orderings must yield a refusal for the fix to be proven.
  await admin`
    insert into organisations (id, name, slug)
    values (
      ${escalationOrganisationId}, 'Attacker Holdings', ${`xorg-attacker-${runId}`}
    )
  `;
  await admin`
    insert into organisation_memberships (
      id, organisation_id, user_id, role, work_scope,
      can_issue_documents, can_cancel_documents, can_approve_amendments, status
    )
    values (
      ${randomUUID()}, ${escalationOrganisationId}, ${attackerUserId},
      'owner', 'all', true, true, true, 'active'
    )
  `;

  // The attacker is only a viewer in the victim organisation: no write
  // role, no issue or cancel authority, no approval authority.
  const added = await authed(victimOwner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId: victimOrganisationId,
    payload: { email: attackerEmail, role: 'viewer' },
  });
  expect(added.statusCode, added.body).toBe(201);
}, 60_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [
      victimOrganisationId,
      escalationOrganisationId,
    ]);
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
  if (appPool) await appPool.end();
  if (app) await app.close();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('authority never leaks across organisations', () => {
  it('refuses owner-only member management in an organisation where the caller is a viewer', async () => {
    const response = await authed(attacker, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId: victimOrganisationId,
      payload: { email: `xorg-invitee-${runId}@integration.test`, role: 'owner' },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('OWNER_REQUIRED');
  });

  it('refuses owner-only organisation profile edits to a viewer', async () => {
    const response = await authed(attacker, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId: victimOrganisationId,
      payload: { legalName: 'Renamed By Attacker' },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('OWNER_REQUIRED');
  });

  it('refuses the owner-only organisation export to a viewer', async () => {
    const response = await authed(attacker, {
      method: 'GET',
      url: '/api/export',
      organisationId: victimOrganisationId,
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('OWNER_REQUIRED');
  });

  it('refuses LOA upload to a viewer holding a writer role elsewhere', async () => {
    // requireWriterRole is the shared authz.ts resolver: a viewer here
    // must not borrow the owner role they hold in another organisation.
    const response = await authed(attacker, {
      method: 'POST',
      url: '/api/loa-documents?filename=escalation-attempt.pdf',
      organisationId: victimOrganisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-1.4 not a real document'),
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('ROLE_FORBIDDEN');
  });

  it('lists only the bound organisation members, never the caller rows elsewhere', async () => {
    const response = await authed(attacker, {
      method: 'GET',
      url: '/api/organisations/current/members',
      organisationId: victimOrganisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const members = response.json<{
      members: { organisationId: string; userId: string; role: string }[];
    }>().members;
    expect(
      members.every((member) => member.organisationId === victimOrganisationId),
      `members leaked another organisation: ${response.body}`,
    ).toBe(true);
    const attackerRow = members.find((member) => member.userId === attackerUserId);
    expect(attackerRow?.role).toBe('viewer');
  });

  it('still resolves the caller own authority correctly in their own organisation', async () => {
    // The guard must not overcorrect: bound to the escalation
    // organisation, the attacker genuinely is its owner.
    const response = await authed(attacker, {
      method: 'GET',
      url: '/api/organisations/current/members',
      organisationId: escalationOrganisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const members = response.json<{
      members: { organisationId: string; role: string }[];
    }>().members;
    expect(members).toHaveLength(1);
    expect(members[0]?.organisationId).toBe(escalationOrganisationId);
    expect(members[0]?.role).toBe('owner');
  });

  it('resolves the membership of the bound organisation, not an arbitrary one', async () => {
    // The decisive regression guard. An organisation-blind read filters
    // on user_id alone, so it returns the same first row no matter which
    // organisation is bound — which row depends on the heap and is not
    // stable. Resolving the SAME user against BOTH organisations makes
    // that failure deterministic: an unscoped resolver must answer
    // identically twice, so one of these two assertions is guaranteed to
    // fail, whichever row the planner happens to return first.
    const asViewer = await withTenant(
      appPool,
      { organisationId: victimOrganisationId, userId: attackerUserId },
      (tx) => membershipOf(tx, attackerUserId),
    );
    expect(asViewer?.role, 'bound to the victim organisation').toBe('viewer');
    expect(asViewer?.can_issue_documents).toBe(false);
    expect(asViewer?.can_cancel_documents).toBe(false);

    const asOwner = await withTenant(
      appPool,
      { organisationId: escalationOrganisationId, userId: attackerUserId },
      (tx) => membershipOf(tx, attackerUserId),
    );
    expect(asOwner?.role, 'bound to the attacker own organisation').toBe('owner');
    expect(asOwner?.can_issue_documents).toBe(true);
  });

  it('keeps the unbound organisation picker listing every membership', async () => {
    // /api/me runs unbound on purpose: the OR self-branch in the policy
    // is what makes the picker work, and the fix must not break it.
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: attacker.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const memberships = response.json<{
      memberships: { organisationId: string }[];
    }>().memberships;
    expect(memberships.map((membership) => membership.organisationId).sort()).toEqual(
      [victimOrganisationId, escalationOrganisationId].sort(),
    );
  });
});
