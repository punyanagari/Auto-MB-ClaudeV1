import type { Sql } from 'postgres';

/**
 * Cluster-level role bootstrap, safe under concurrent callers.
 *
 * Roles live in the cluster-wide catalog (`pg_authid`), while everything
 * that creates them runs in parallel: vitest executes test files
 * concurrently, `pnpm verify` runs packages side by side against one
 * PostgreSQL service, and the per-database migration advisory lock cannot
 * serialise two migrators working on different databases. Any
 * check-then-create sequence therefore races: both sessions pass the
 * `pg_roles` probe, one CREATE wins, and the loser dies with
 * `duplicate_object` — or, when the timing is tighter, with a
 * `unique_violation` on `pg_authid_rolname_index` (observed in CI on
 * 2026-08-14, packages/db verify job).
 *
 * The functions here attempt the CREATE first and treat both failure
 * shapes as "another session created the role", so every caller converges
 * without an error regardless of interleaving. They are the ONLY places
 * this package creates roles outside the migration series; test suites
 * must call these rather than hand-rolling a `DO $$ ... IF NOT EXISTS`
 * block, which is exactly the racy shape this module replaces.
 *
 * Migration 0004 also creates `auto_mb_definer` behind an IF NOT EXISTS
 * probe, and an applied migration's bytes can never change (the runner
 * refuses a hash mismatch). That copy stays safe only because every
 * migration-running path — the production bootstrap and the test setups —
 * ensures the role here first, so 0004 always finds it present and its
 * unguarded CREATE never executes concurrently.
 */

/**
 * Creates or converges the LOGIN application role. When the role already
 * exists — including when a concurrent session creates it mid-flight —
 * the ALTER deterministically reapplies the password and attribute set,
 * so a database whose role predates this call ends in the same state as
 * a fresh one.
 */
export async function ensureApplicationRole(
  admin: Sql,
  password: string,
): Promise<void> {
  const escaped = password.replaceAll("'", "''");
  await admin.unsafe(`
    DO $$
    BEGIN
      BEGIN
        CREATE ROLE auto_mb_app LOGIN PASSWORD '${escaped}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      EXCEPTION
        WHEN duplicate_object OR unique_violation THEN
          ALTER ROLE auto_mb_app LOGIN PASSWORD '${escaped}'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END;
    END
    $$;
  `);
}

/**
 * The NOLOGIN BYPASSRLS function-owner role (migration 0004). Created
 * here as well so a fresh cluster can receive a restore whose dump
 * references it — roles are cluster-level and never travel in a
 * database dump.
 */
export async function ensureDefinerRole(admin: Sql): Promise<void> {
  await admin.unsafe(`
    DO $$
    BEGIN
      BEGIN
        CREATE ROLE auto_mb_definer NOLOGIN BYPASSRLS;
      EXCEPTION
        WHEN duplicate_object OR unique_violation THEN
          NULL; -- another session created it; nothing to converge
      END;
    END
    $$;
  `);
}

/**
 * Both cluster roles in one call — the shape test setups need before
 * running migrations against a shared cluster: `auto_mb_app` so the
 * migrations' role-guarded grant blocks apply, `auto_mb_definer` so
 * migration 0004's unguarded CREATE finds it already present instead of
 * racing a sibling suite for it.
 */
export async function ensureClusterRoles(
  admin: Sql,
  appPassword: string,
): Promise<void> {
  await ensureApplicationRole(admin, appPassword);
  await ensureDefinerRole(admin);
}
