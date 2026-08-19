import type { Sql } from '@auto-mb/db';
import { createDatabasePool, withUserContext } from '@auto-mb/db';
import pg from 'pg';
import { assertProductionSecret, createAuth } from './auth.js';

/**
 * Optional deployment step: provision ONE fully-privileged account so the
 * owner has something to sign in with on a database that has no users yet.
 *
 * ## Safety posture
 *
 * The gate is the environment and nothing else: the step runs when
 * `TEST_USER_EMAIL` and `TEST_USER_PASSWORD` are both set, and prints one
 * skip line and does nothing when either is absent. There is deliberately
 * NO `NODE_ENV=production` refusal, because the owner's stated intent is
 * to use this on the pilot — a production refusal would only be routed
 * around. What that costs is stated plainly rather than hidden: putting
 * these two variables in `deploy/.env.production` creates a STANDING
 * account in production that holds every authority the membership table
 * can grant, and it is created afresh on any database where it is missing.
 * Removing the variables later does not remove the account
 * (docs/RUNBOOK.md, "Test user").
 *
 * The password is read from the environment, handed to Better Auth, and
 * never logged, never written to the audit trail, and never echoed back.
 *
 * ## Idempotence
 *
 * Re-runs converge and never overwrite. An existing user keeps its
 * password — this step will not reset a credential the owner may have
 * changed — and only the membership and its grants are (re-)raised.
 *
 * ## Two-factor authentication
 *
 * The account is left UN-ENROLLED. It holds the owner role, so with
 * `MFA_ENFORCE=true` the finding-36 wall (src/mfa-policy.ts) refuses every
 * tenant-scoped request until TOTP enrolment is completed; the identity
 * and `/api/auth/two-factor/*` endpoints stay reachable, so the owner
 * enrols interactively at first sign-in. Enrolling here would mean this
 * process minting and storing a TOTP secret nobody asked for.
 */

export const TEST_USER_EMAIL_ENV = 'TEST_USER_EMAIL';
export const TEST_USER_PASSWORD_ENV = 'TEST_USER_PASSWORD';
export const TEST_USER_ORG_ENV = 'TEST_USER_ORG';

/** The organisation the account owns when `TEST_USER_ORG` is not set. */
export const DEFAULT_TEST_USER_ORGANISATION = 'Test Organisation';

export interface SeedTestUserOptions {
  /**
   * The owner connection string — the same `DATABASE_ADMIN_URL` the rest
   * of the bootstrap runs on. It is used here for the same reason: this
   * step calls `app_private.create_organisation_with_owner`, whose EXECUTE
   * is granted to the application role alone, and it writes grant columns
   * the product's own routes deliberately withhold from a founder. Both
   * are administrator acts, and the bootstrap connection is already the
   * administrator's.
   */
  readonly adminUrl: string;
  /** Defaults to `process.env`; injected by the test. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to `console.log`; injected by the test. */
  readonly log?: (line: string) => void;
}

/** The organisation slug for a name, within the 0001 CHECK
 * (`^[a-z0-9][a-z0-9-]{1,62}$`). */
function slugFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    throw new Error(
      `${TEST_USER_ORG_ENV} does not yield a usable organisation slug: ${name}`,
    );
  }
  return slug;
}

/**
 * Creates the account through the application's OWN Better Auth instance,
 * by calling the very endpoint the sign-up page calls. Nothing about the
 * credential — the hash function, its parameters, the `auth_accounts` row
 * shape — is restated here, so it cannot drift from what the running
 * server will verify against.
 */
async function createUser(
  adminUrl: string,
  env: NodeJS.ProcessEnv,
  email: string,
  password: string,
): Promise<void> {
  const authPool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    // Better Auth resolves a request against its configured base URL, so
    // the request below is built from the same value the server runs with.
    const baseUrl = env.WEB_ORIGIN ?? 'http://127.0.0.1:3000';
    const auth = createAuth({
      pool: authPool,
      secret: assertProductionSecret(env.AUTH_SECRET),
      baseUrl,
      trustedOrigins: [baseUrl],
    });
    const response = await auth.handler(
      new Request(new URL('/api/auth/sign-up/email', baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: new URL(baseUrl).origin,
        },
        // `name` is required by the endpoint and is display text only.
        body: JSON.stringify({ email, password, name: email }),
      }),
    );
    if (!response.ok) {
      // The body can carry the submitted credentials back; only the status
      // and Better Auth's symbolic code are safe to surface.
      const code = await response
        .json()
        .then((body: unknown) =>
          typeof body === 'object' && body !== null && 'code' in body
            ? String(body.code)
            : 'no code',
        )
        .catch(() => 'unreadable body');
      throw new Error(
        `test user sign-up refused with HTTP ${String(response.status)} (${code})`,
      );
    }
  } finally {
    await authPool.end();
  }
}

/** Every `can_%` boolean the membership table carries, read from the
 * catalog rather than listed here — so the fourteenth authority is granted
 * by the migration that adds it, with no second edit in this file. The
 * same catalog-derived posture the per-column export census uses. */
async function grantColumns(sql: Sql): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organisation_memberships'
      and column_name like 'can\\_%'
      and data_type = 'boolean'
    order by column_name
  `;
  if (rows.length === 0) {
    throw new Error('organisation_memberships carries no can_% grant columns');
  }
  return rows.map((row) => row.column_name);
}

export async function seedTestUser(options: SeedTestUserOptions): Promise<void> {
  const env = options.env ?? process.env;
  const log =
    options.log ??
    ((line: string) => {
      console.log(line);
    });

  const email = env[TEST_USER_EMAIL_ENV]?.trim() ?? '';
  const password = env[TEST_USER_PASSWORD_ENV] ?? '';
  if (email === '' || password === '') {
    log(
      `test user: skipped (${TEST_USER_EMAIL_ENV} and ${TEST_USER_PASSWORD_ENV} ` +
        'are not both set)',
    );
    return;
  }
  const organisationName =
    env[TEST_USER_ORG_ENV]?.trim() || DEFAULT_TEST_USER_ORGANISATION;

  const admin = createDatabasePool({
    url: options.adminUrl,
    max: 1,
    applicationName: 'auto-mb-test-user-seed',
  });
  try {
    const [existing] = await admin<{ id: string }[]>`
      select "id" from auth_users where lower("email") = lower(${email})
    `;
    if (existing === undefined) {
      await createUser(options.adminUrl, env, email, password);
      log(`test user: created ${email}`);
    } else {
      log(`test user: ${email} already exists; its password is left unchanged`);
    }
    const [user] = await admin<{ id: string }[]>`
      select "id" from auth_users where lower("email") = lower(${email})
    `;
    if (user === undefined) throw new Error('test user was not created');

    const grants = await grantColumns(admin);
    const organisationId = await withUserContext(admin, user.id, async (tx) => {
      const [found] = await tx<{ id: string }[]>`
        select id from organisations where name = ${organisationName}
      `;
      let id = found?.id;
      if (id === undefined) {
        // The definer bootstrap, so the organisation, its founder
        // membership and its audit row are written exactly as a real
        // sign-up writes them.
        const [created] = await tx<{ id: string }[]>`
          select app_private.create_organisation_with_owner(
            ${organisationName}, ${slugFor(organisationName)}
          ) as id
        `;
        if (created === undefined)
          throw new Error('organisation bootstrap returned no row');
        id = created.id;
        // The notified GST history and the payroll schedules, in the same
        // transaction and by the same call the create-organisation route
        // makes (src/routes/identity.ts) — an organisation without them
        // refuses every invoice rate check and every payroll run.
        await tx`select set_config('app.organisation_id', ${id}, true)`;
        await tx`select * from app_private.seed_default_statutory_rows(${id})`;
      } else {
        // An organisation that exists but was never this user's.
        await tx`
          insert into organisation_memberships (
            organisation_id, user_id, role, work_scope, status
          )
          values (${id}, ${user.id}, 'owner', 'all', 'active')
          on conflict (organisation_id, user_id) do nothing
        `;
      }
      const raised = {
        role: 'owner',
        work_scope: 'all',
        status: 'active',
        ...Object.fromEntries(grants.map((column) => [column, true])),
      };
      await tx`
        update organisation_memberships set ${tx(raised)}
        where organisation_id = ${id} and user_id = ${user.id}
      `;
      return id;
    });

    log(
      `test user: owner of "${organisationName}" (${organisationId}) with all ` +
        `${String(grants.length)} membership authorities granted`,
    );
    log(
      'test user: NOT enrolled in two-factor authentication. While ' +
        'MFA_ENFORCE=true this account can sign in and reach the identity ' +
        'endpoints, and must complete TOTP enrolment before any ' +
        'organisation data is served.',
    );
  } finally {
    await admin.end();
  }
}
