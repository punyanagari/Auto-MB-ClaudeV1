import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createDatabasePool } from './pool.js';
import { runMigrations } from './migration-runner.js';

/**
 * Idempotent production bootstrap (external review, ops batch): creates
 * or updates the application role, runs migrations, then deterministically
 * reapplies the full privilege matrix — so a database whose migrations ran
 * before the role existed (where the migrations' role-guarded grant blocks
 * were skipped) converges to the same state as a fresh one. Finally proves
 * a query through the application role.
 *
 * The matrix below is the CANONICAL final state, mirroring migrations
 * 0001–0009 after all revokes. Adding a table? Update the matrix AND the
 * tenancy suite's table lists.
 */

/** table → privileges the application role holds. */
const TABLE_PRIVILEGES: Record<string, string> = {
  // Business tables that must never lose rows keep no DELETE (0003).
  organisations: 'SELECT, INSERT, UPDATE',
  works: 'SELECT, INSERT, UPDATE',
  work_items: 'SELECT, INSERT, UPDATE',
  loa_documents: 'SELECT, INSERT, UPDATE',
  delivery_challan_counters: 'SELECT, INSERT, UPDATE',
  // Drafts and structural rows remain deletable.
  organisation_memberships: 'SELECT, INSERT, UPDATE, DELETE',
  work_schedules: 'SELECT, INSERT, UPDATE, DELETE',
  delivery_challans: 'SELECT, INSERT, UPDATE, DELETE',
  delivery_challan_items: 'SELECT, INSERT, UPDATE, DELETE',
  challan_item_serials: 'SELECT, INSERT, UPDATE, DELETE',
  work_assignments: 'SELECT, INSERT, DELETE',
  // Retention financial records: no DELETE (0006).
  challan_receipts: 'SELECT, INSERT, UPDATE',
  work_instruments: 'SELECT, INSERT, UPDATE',
  bills: 'SELECT, INSERT, UPDATE',
  bill_counters: 'SELECT, INSERT, UPDATE',
  mb_entries: 'SELECT, INSERT, UPDATE',
  // Append-only trails (0002, 0005).
  audit_events: 'SELECT, INSERT',
  identity_audit_events: 'SELECT, INSERT',
  // Better Auth owns these shapes (0004).
  auth_users: 'SELECT, INSERT, UPDATE, DELETE',
  auth_sessions: 'SELECT, INSERT, UPDATE, DELETE',
  auth_accounts: 'SELECT, INSERT, UPDATE, DELETE',
  auth_verifications: 'SELECT, INSERT, UPDATE, DELETE',
  auth_two_factors: 'SELECT, INSERT, UPDATE, DELETE',
};

const FUNCTION_GRANTS = [
  'app_private.current_organisation_id()',
  'app_private.current_user_id()',
  'app_private.create_organisation_with_owner(text, text, uuid)',
];

export async function ensureApplicationRole(
  admin: Sql,
  password: string,
): Promise<void> {
  const escaped = password.replaceAll("'", "''");
  await admin.unsafe(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
        ALTER ROLE auto_mb_app LOGIN PASSWORD '${escaped}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      ELSE
        CREATE ROLE auto_mb_app LOGIN PASSWORD '${escaped}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF;
    END
    $$;
  `);
}

export async function applyGrants(admin: Sql): Promise<void> {
  await admin.unsafe(`GRANT USAGE ON SCHEMA public, app_private TO auto_mb_app`);
  for (const fn of FUNCTION_GRANTS) {
    await admin.unsafe(`GRANT EXECUTE ON FUNCTION ${fn} TO auto_mb_app`);
  }
  for (const [table, privileges] of Object.entries(TABLE_PRIVILEGES)) {
    // Revoke-then-grant makes the final state deterministic even on a
    // database that once carried wider privileges.
    await admin.unsafe(`REVOKE ALL ON ${table} FROM auto_mb_app`);
    await admin.unsafe(`GRANT ${privileges} ON ${table} TO auto_mb_app`);
  }
}

export async function verifyApplicationConnection(appUrl: string): Promise<void> {
  const app = createDatabasePool({
    url: appUrl,
    max: 1,
    applicationName: 'auto-mb-bootstrap-proof',
  });
  try {
    // Privilege proof: without a bound tenant, forced RLS yields zero
    // rows — but a missing grant or wrong password throws instead.
    await app`select count(*)::int as visible from organisations`;
  } finally {
    await app.end({ timeout: 5 });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');
  if (!appPassword) throw new Error('AUTO_MB_APP_DB_PASSWORD is required');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDirectory = path.resolve(here, '..', 'migrations');
  const admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-bootstrap',
  });
  try {
    await ensureApplicationRole(admin, appPassword);
    console.log('application role ensured');
    await runMigrations(admin, migrationsDirectory);
    await applyGrants(admin);
    console.log('privilege matrix applied');
    const appUrl = process.env.DATABASE_URL;
    if (appUrl) {
      await verifyApplicationConnection(appUrl);
      console.log('application connection verified');
    }
  } finally {
    await admin.end();
  }
  console.log('bootstrap complete');
}
