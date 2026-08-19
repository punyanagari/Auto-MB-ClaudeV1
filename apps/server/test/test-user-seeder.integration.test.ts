import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';
import { seedTestUser } from '../src/seed-test-user.js';

/**
 * The optional test-user deployment step (src/seed-test-user.ts). Three
 * properties matter and none of them is observable without a database:
 * the env gate is a real no-op, the account it creates can actually SIGN
 * IN (which is the whole point of routing creation through Better Auth
 * rather than writing a hash by hand), and a re-run converges without
 * touching the credential.
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

// Unique per run: this suite writes into the shared database beside every
// other integration suite.
const runId = randomBytes(5).toString('hex');
const email = `seeded-${runId}@integration.test`;
const organisationName = `Seeded Organisation ${runId}`;
const password = `seeded-password-${runId}`;

/** The environment the step reads. Injected rather than set on
 * `process.env`, so the absent-variable case is a real absence and the
 * suite cannot leak either value into a sibling test file. */
const seedEnv: NodeJS.ProcessEnv = {
  TEST_USER_EMAIL: email,
  TEST_USER_PASSWORD: password,
  TEST_USER_ORG: organisationName,
};

let admin: Sql;
let app: FastifyInstance;
let organisationId: string | undefined;
const lines: string[] = [];
const log = (line: string): void => void lines.push(line);

interface MembershipRow {
  readonly role: string;
  readonly work_scope: string;
  readonly status: string;
  readonly grants: Record<string, unknown>;
}

/** The membership row as the product reads it, plus the whole row as JSON
 * so every `can_%` column can be asserted without naming one. */
async function membership(): Promise<MembershipRow | undefined> {
  const [row] = await admin<MembershipRow[]>`
    select m.role, m.work_scope, m.status, to_jsonb(m) as grants
    from organisation_memberships m
    join auth_users u on u."id" = m.user_id
    where lower(u."email") = lower(${email})
  `;
  return row;
}

/** Every `can_%` boolean the table carries, from the catalog — the same
 * question the step itself asks, so this asserts completeness rather than
 * a list that would go stale beside it. */
async function grantColumnNames(): Promise<string[]> {
  const rows = await admin<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organisation_memberships'
      and column_name like 'can\\_%'
      and data_type = 'boolean'
    order by column_name
  `;
  return rows.map((row) => row.column_name);
}

async function credentialHash(): Promise<string | undefined> {
  const [row] = await admin<{ password: string | null }[]>`
    select a."password"
    from auth_accounts a
    join auth_users u on u."id" = a."userId"
    where lower(u."email") = lower(${email})
  `;
  return row?.password ?? undefined;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-test-user-seed-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the test-user seeder integration tests. ' +
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
    await removeOrganisationResidue(admin, [organisationId]);
    await admin`
      delete from identity_audit_events
      where user_id in (select "id" from auth_users where lower("email") = lower(${email}))
    `;
    await admin`delete from auth_users where lower("email") = lower(${email})`;
  }
  await app?.close();
  await admin?.end();
});

describe('optional test-user seeding', () => {
  it('does nothing at all when the environment does not ask for it', async () => {
    lines.length = 0;
    // Only the organisation name set: the gate is BOTH credentials, so
    // this is still the skip path.
    await seedTestUser({ adminUrl, env: { TEST_USER_ORG: organisationName }, log });
    expect(lines).toEqual([
      'test user: skipped (TEST_USER_EMAIL and TEST_USER_PASSWORD are not both set)',
    ]);
    const [existing] = await admin<{ id: string }[]>`
      select id from organisations where name = ${organisationName}
    `;
    expect(existing).toBeUndefined();
    expect(await membership()).toBeUndefined();
  });

  it('creates an owner holding every membership authority', async () => {
    lines.length = 0;
    await seedTestUser({ adminUrl, env: seedEnv, log });
    expect(lines[0]).toBe(`test user: created ${email}`);

    const [organisation] = await admin<{ id: string }[]>`
      select id from organisations where name = ${organisationName}
    `;
    expect(organisation).toBeDefined();
    organisationId = organisation?.id;

    const row = await membership();
    expect(row).toBeDefined();
    expect(row?.role).toBe('owner');
    expect(row?.work_scope).toBe('all');
    expect(row?.status).toBe('active');

    const columns = await grantColumnNames();
    expect(columns.length).toBeGreaterThan(0);
    // Every one, including the two `create_organisation_with_owner`
    // deliberately withholds from a founder.
    expect(columns.filter((column) => row?.grants[column] !== true)).toEqual([]);

    // The organisation is a real one: the statutory rows the create
    // route seeds are present, so an invoice rate check and a payroll run
    // would not refuse it.
    const [seeded] = await admin<{ gst: number; payroll: number }[]>`
      select
        (select count(*)::int from gst_rates where organisation_id = ${organisation?.id ?? null}) as gst,
        (select count(*)::int from payroll_statutory_rates where organisation_id = ${organisation?.id ?? null}) as payroll
    `;
    expect(seeded?.gst).toBeGreaterThan(0);
    expect(seeded?.payroll).toBeGreaterThan(0);
  });

  it('creates a credential the running server accepts, and leaves it un-enrolled', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password },
    });
    expect(response.statusCode, response.body).toBe(200);

    const [user] = await admin<{ enabled: boolean | null }[]>`
      select "twoFactorEnabled" as enabled from auth_users
      where lower("email") = lower(${email})
    `;
    // Left for the owner to do interactively; the MFA wall stands until
    // they do.
    expect(user?.enabled ?? false).toBe(false);
  });

  it('converges on a re-run without touching the existing password', async () => {
    const before = await credentialHash();
    expect(before).toBeDefined();

    lines.length = 0;
    await seedTestUser({
      adminUrl,
      env: { ...seedEnv, TEST_USER_PASSWORD: `rotated-${password}` },
      log,
    });
    expect(lines[0]).toBe(
      `test user: ${email} already exists; its password is left unchanged`,
    );
    expect(await credentialHash()).toBe(before);

    // And no second organisation, and the grants still all true.
    const organisations = await admin<{ id: string }[]>`
      select id from organisations where name = ${organisationName}
    `;
    expect(organisations).toHaveLength(1);
    const row = await membership();
    const columns = await grantColumnNames();
    expect(columns.filter((column) => row?.grants[column] !== true)).toEqual([]);

    // The original password is still the one that works.
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password },
    });
    expect(response.statusCode, response.body).toBe(200);
  });
});
