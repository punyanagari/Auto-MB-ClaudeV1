import { createDatabasePool } from '../../src/pool.js';
import { ensureClusterRoles } from '../../src/roles.js';

/**
 * Vitest global setup: converge the two cluster-level roles ONCE, before
 * any test file runs.
 *
 * Roles are cluster-wide but this package's suites migrate their own
 * throwaway databases in parallel, and the migration advisory lock is
 * database-scoped — it cannot serialise two suites both reaching
 * migration 0004's `CREATE ROLE auto_mb_definer` on different databases.
 * Two suites racing that unguarded CREATE is exactly the
 * `duplicate key value violates unique constraint "pg_authid_rolname_index"`
 * flake CI produced. Creating both roles here, with the race-safe
 * helpers, means every later probe — 0004's included — finds them
 * already present.
 *
 * `auto_mb_app` matters for the same reason: the migrations'
 * role-guarded grant blocks and `applyGrants` need it to exist, and
 * without this setup the suites would depend on whichever sibling
 * package happened to create it first.
 */
export default async function setup(): Promise<void> {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
  const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD ?? 'local-app-change-me';
  const admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-db-test-global-setup',
  });
  try {
    await ensureClusterRoles(admin, appPassword);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
