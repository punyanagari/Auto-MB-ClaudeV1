import { defineConfig } from 'vitest/config';

// Package-local config; passWithNoTests stays unset so this package can
// never go green without executing its integration suites.
//
// The default file parallelism is safe here and relied upon: the
// concurrency suite only touches disposable `auto_mb_migration_test_*`
// databases cloned from template1, and PostgreSQL advisory locks are
// database-scoped, so its lock experiments cannot contend with the tenancy
// suite's migration run against the shared auto_mb database. A new test
// file that writes to auto_mb must either use the tenancy suite's fixture
// organisations or its own disposable database.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.{js,ts}'],
    // Cluster-level roles are created once, race-safely, before any file
    // runs: suites migrating parallel throwaway databases would otherwise
    // race migration 0004's CREATE ROLE (roles are cluster-wide; the
    // migration advisory lock is database-scoped and cannot help).
    globalSetup: ['test/support/global-setup.ts'],
  },
});
