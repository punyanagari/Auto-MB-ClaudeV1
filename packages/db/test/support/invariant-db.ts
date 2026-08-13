import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../../src/pool.js';
import { runMigrations } from '../../src/migration-runner.js';
import { applyGrants } from '../../src/bootstrap.js';

/**
 * Shared plumbing for the schema-invariant suites added by the DB
 * invariant-guard pack.
 *
 * Every suite here runs against its own throwaway database rather than the
 * shared development one, for two reasons. The obvious one is isolation:
 * these tests attack counters and numbering, and vitest runs files in
 * parallel. The load-bearing one is that a guard is only proved by showing
 * the schema WITHOUT it accepting the write — which means migrating a
 * database to an earlier point in the series and attacking it there.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export const migrationsDirectory = path.resolve(here, '..', '..', 'migrations');

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';

export const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';

/** Generous, because a full migration run against a cold cluster on a
 * developer laptop — with the rest of this package's suites running in
 * parallel against the same cluster — is far slower than vitest's default
 * hook budget. */
export const SETUP_TIMEOUT_MS = 600_000;

export interface TemporaryDatabase {
  readonly name: string;
  readonly pool: Sql;
  /** The same database, reached through the unprivileged application role,
   * so tenancy can be attacked the way the product is exposed to it. */
  readonly appPool: Sql;
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * Each suite passes its OWN prefix. The sweep below drops every database
 * carrying the prefix it is given, which would otherwise pull the rug out
 * from under a sibling suite running in parallel against the same cluster.
 */
export async function createTemporaryDatabase(
  admin: Sql,
  prefix: string,
): Promise<TemporaryDatabase> {
  const name = `${prefix}${randomBytes(6).toString('hex')}`;
  await admin.unsafe(`create database ${name}`);
  return {
    name,
    pool: createDatabasePool({
      url: withDatabase(adminUrl, name),
      max: 4,
      applicationName: 'auto-mb-invariant-owner',
    }),
    appPool: createDatabasePool({
      url: withDatabase(appUrl, name),
      max: 4,
      applicationName: 'auto-mb-invariant-app',
    }),
  };
}

export async function dropTemporaryDatabase(
  admin: Sql,
  database: TemporaryDatabase,
): Promise<void> {
  for (const pool of [database.pool, database.appPool]) {
    try {
      await pool.end({ timeout: 5 });
    } catch {
      // A wedged pool must not stop the drop; `with (force)` terminates
      // whatever it left behind.
    }
  }
  await admin.unsafe(`drop database if exists ${database.name} with (force)`);
}

/** Sweeps databases leaked by a crashed earlier run of THIS suite; the
 * per-suite `afterAll` cannot help when the process itself was killed. */
export async function dropStaleTemporaryDatabases(
  admin: Sql,
  prefix: string,
): Promise<void> {
  const stale = await admin<{ datname: string }[]>`
    select datname from pg_database
    where datname like ${`${prefix}%`}
  `;
  for (const database of stale) {
    await admin.unsafe(`drop database if exists ${database.datname} with (force)`);
  }
}

/** Migrates a throwaway database to the head of the series and applies the
 * canonical privilege matrix, so the application role can be used against
 * it exactly as in production. */
export async function migrateToHead(database: TemporaryDatabase): Promise<void> {
  await runMigrations(database.pool, migrationsDirectory);
  await applyGrants(database.pool);
}

/**
 * Migrates a throwaway database to an EARLIER point in the series by
 * copying only the migrations whose four-digit id is at most `throughId`
 * into a staging directory. Returns a disposer for that directory.
 *
 * No privilege matrix is applied: the matrix is the CURRENT one and names
 * relations a historical schema does not have yet. Staged databases are
 * attacked through the owner connection, which is the writer class these
 * guards exist to bind anyway.
 */
export async function migrateThrough(
  database: TemporaryDatabase,
  throughId: string,
): Promise<() => Promise<void>> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-invariant-'));
  const names = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => name.slice(0, 4) <= throughId);
  for (const name of names) {
    await copyFile(path.join(migrationsDirectory, name), path.join(directory, name));
  }
  await runMigrations(database.pool, directory);
  return async () => {
    await rm(directory, { recursive: true, force: true });
  };
}

export interface RefusedWrite {
  readonly code: string | undefined;
  readonly message: string;
}

/** Awaits a write that must be refused, returning SQLSTATE and message.
 * Copied in spirit from tax-money-backstops.integration.test.ts: a write
 * that is silently ACCEPTED must fail the test loudly, not pass. */
export async function refused(write: Promise<unknown>): Promise<RefusedWrite> {
  const outcome = await write.then(
    (value: unknown) => value,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) {
    throw new Error('the write was accepted, but it should have been refused');
  }
  const failure = outcome as Error & { code?: unknown };
  return {
    code: typeof failure.code === 'string' ? failure.code : undefined,
    message: failure.message,
  };
}

export interface Tenant {
  readonly organisationId: string;
  readonly workId: string;
  readonly buyerId: string;
  /** An active owner of this organisation. `app_private.current_organisation_id()`
   * resolves to NULL unless the bound user has an active membership, so a
   * tenant with no member cannot be bound to at all. */
  readonly userId: string;
}

/** One organisation in state 27 with an active owner, one Work, one client
 * contact and the notified GST rate a direct invoice needs. Every id is
 * fresh, so two tenants never contend. */
export async function seedTenant(pool: Sql): Promise<Tenant> {
  const suffix = randomBytes(5).toString('hex');
  const [organisation] = await pool<{ id: string }[]>`
    insert into organisations (name, slug, state_code)
    values (${`Invariant tenant ${suffix}`}, ${`invariant-${suffix}`}, '27')
    returning id
  `;
  if (!organisation) throw new Error('organisation seed failed');
  const userId = `invariant-user-${suffix}`;
  await pool`
    insert into auth_users (id, name, email, "emailVerified")
    values (${userId}, 'Invariant Owner', ${`${userId}@invariant.test`}, true)
  `;
  await pool`
    insert into organisation_memberships (
      organisation_id, user_id, role, work_scope, status
    )
    values (${organisation.id}, ${userId}, 'owner', 'all', 'active')
  `;
  const [work] = await pool<{ id: string }[]>`
    insert into works (
      organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, letter_percentage,
      letter_percentage_direction, created_by_user_id
    )
    values (
      ${organisation.id}, ${`INV-${suffix.toUpperCase()}`},
      ${`INV-letter-${suffix}`}, '2025-06-01', 'Invariant fixture work',
      1000.00, 900.00, 'per_schedule', null, null, 'invariant-test'
    )
    returning id
  `;
  if (!work) throw new Error('work seed failed');
  const [buyer] = await pool<{ id: string }[]>`
    insert into contacts (
      organisation_id, designation, address, gstin, pincode, state_code,
      is_client, created_by_user_id
    )
    values (
      ${organisation.id}, 'Invariant Buyer', 'Buyer address',
      '27AAAGM0289C1ZL', '400001', '27', true, 'invariant-test'
    )
    returning id
  `;
  if (!buyer) throw new Error('buyer seed failed');
  await pool`
    insert into gst_rates (
      organisation_id, rate, label, effective_from, created_by_user_id
    )
    values (${organisation.id}, '18.00', 'Standard 18%', '2017-07-01',
            'invariant-test')
  `;
  return {
    organisationId: organisation.id,
    workId: work.id,
    buyerId: buyer.id,
    userId,
  };
}
