import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
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

// Unique per run so this suite can never collide with the db package's
// fixture organisations or an earlier crashed run.
const runId = randomBytes(5).toString('hex');
const ownerEmail = `owner-${runId}@integration.test`;
const memberEmail = `member-${runId}@integration.test`;
const strangerEmail = `stranger-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let organisationId: string;

interface CookieJar {
  cookie: string;
}

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
  const cookie = extractCookies(response.headers['set-cookie']);
  expect(cookie).toContain('better-auth');
  return { cookie };
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
    applicationName: 'auto-mb-identity-admin',
  });

  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the identity integration tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }

  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
  });
});

afterAll(async () => {
  if (admin) {
    // The catalog-driven cleanup rather than a hand list. The list this
    // replaced named four tables and went stale the moment migration
    // 0089 seeded a fifth at organisation creation — which is the exact
    // failure `removeOrganisationResidue` was written to end, and its own
    // doc comment says so.
    await removeOrganisationResidue(admin, [organisationId]);
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    // Cascades sessions, accounts, and two-factor rows.
    await admin`delete from auth_users where "email" like ${`%-${runId}@integration.test`}`;
  }
  await app?.close();
  await admin?.end();
});

describe('identity and organisation flow', () => {
  let owner: CookieJar;
  let member: CookieJar;
  let stranger: CookieJar;

  it('signs users up with email and password and serves their session', async () => {
    owner = await signUp(ownerEmail, 'Owner User');
    member = await signUp(memberEmail, 'Member User');
    stranger = await signUp(strangerEmail, 'Stranger User');

    const response = await authed(owner, { method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      user: { email: string };
      memberships: unknown[];
    }>();
    expect(body.user.email).toBe(ownerEmail);
    expect(body.memberships).toEqual([]);
  });

  it('rejects unauthenticated access to identity endpoints', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/organisations' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('creates an organisation with the caller as active owner', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/organisations',
      payload: { name: 'Integration Constructions', slug: `int-org-${runId}` },
    });
    expect(response.statusCode, response.body).toBe(201);
    organisationId = response.json<{ id: string }>().id;

    const list = await authed(owner, { method: 'GET', url: '/api/organisations' });
    expect(list.json<{ organisations: { id: string }[] }>().organisations).toEqual([
      {
        id: organisationId,
        name: 'Integration Constructions',
        slug: `int-org-${runId}`,
      },
    ]);

    const me = await authed(owner, { method: 'GET', url: '/api/me' });
    expect(
      me.json<{ memberships: { role: string; status: string }[] }>().memberships,
    ).toEqual([expect.objectContaining({ role: 'owner', status: 'active' })]);
  });

  it('rejects a duplicate slug with 409', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/organisations',
      payload: { name: 'Другая фирма', slug: `int-org-${runId}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'SLUG_TAKEN' });
  });

  it('denies non-members through the endpoint, even with a valid organisation id', async () => {
    const response = await authed(stranger, {
      method: 'GET',
      url: '/api/organisations/current/members',
      organisationId,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'NOT_A_MEMBER' });
  });

  it('rejects a missing or malformed organisation header with 400', async () => {
    const missing = await authed(owner, {
      method: 'GET',
      url: '/api/organisations/current/members',
    });
    expect(missing.statusCode).toBe(400);

    const malformed = await authed(owner, {
      method: 'GET',
      url: '/api/organisations/current/members',
      organisationId: 'not-a-uuid',
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('lets the owner add a member, who then gains scoped access', async () => {
    const add = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email: memberEmail, role: 'viewer' },
    });
    expect(add.statusCode, add.body).toBe(201);
    expect(add.json<{ members: unknown[] }>().members).toHaveLength(2);

    const memberList = await authed(member, {
      method: 'GET',
      url: '/api/organisations/current/members',
      organisationId,
    });
    expect(memberList.statusCode).toBe(200);

    const organisations = await authed(member, {
      method: 'GET',
      url: '/api/organisations',
    });
    expect(
      organisations.json<{ organisations: { id: string }[] }>().organisations,
    ).toEqual([expect.objectContaining({ id: organisationId })]);
  });

  it('refuses member management to non-owners', async () => {
    const response = await authed(member, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email: strangerEmail, role: 'viewer' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'OWNER_REQUIRED' });
  });

  it('records audit events for organisation and membership changes', async () => {
    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId}
      order by occurred_at
    `;
    // Sorted: organisation.created and the GST-rate default seeding share
    // one transaction, so their occurred_at values tie.
    expect(events.map((event) => event.action).sort()).toEqual([
      'gst_rate.defaults_seeded',
      'membership.added',
      'organisation.created',
      // The payroll schedules (0089), seeded in the same transaction and
      // audited beside the GST rates for the same reason: an
      // organisation that arrived without them would refuse its first
      // payroll run by name.
      'payroll_schedule.defaults_seeded',
    ]);
  });

  it('seeds the notified GST rate history when the organisation is created', async () => {
    const rates = await admin<
      { rate: string; effective_from: string; effective_to: string | null }[]
    >`
      select rate::text as rate, effective_from::text as effective_from,
             effective_to::text as effective_to
      from gst_rates where organisation_id = ${organisationId}
      order by rate, effective_from
    `;
    expect(rates).toHaveLength(9);
    expect(rates).toEqual(
      expect.arrayContaining([
        { rate: '18.00', effective_from: '2017-07-01', effective_to: null },
        { rate: '12.00', effective_from: '2017-07-01', effective_to: '2025-09-21' },
        { rate: '40.00', effective_from: '2025-09-22', effective_to: null },
      ]),
    );
  });

  it('revokes access after sign-out', async () => {
    const signOut = await authed(stranger, {
      method: 'POST',
      url: '/api/auth/sign-out',
      payload: {},
    });
    expect(signOut.statusCode).toBe(200);

    const afterSignOut = await authed(stranger, { method: 'GET', url: '/api/me' });
    expect(afterSignOut.statusCode).toBe(401);
  });

  it('records user-scoped identity audit events for sign-up, sign-out and sign-in', async () => {
    // The stranger signed up earlier and signed out above; sign back in so
    // all three auditable actions exist for one user.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: strangerEmail, password },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);

    const [strangerUser] = await admin<{ id: string }[]>`
      select "id" from auth_users where "email" = ${strangerEmail}
    `;
    expect(strangerUser).toBeDefined();
    const events = await admin<{ action: string; request_id: string | null }[]>`
      select action, request_id from identity_audit_events
      where user_id = ${strangerUser?.id ?? ''}
      order by occurred_at, action
    `;
    expect(events.map((event) => event.action)).toEqual([
      'sign_up',
      'sign_out',
      'sign_in',
    ]);
    for (const event of events) {
      expect(event.request_id).toBeTruthy();
    }
  });
});
