import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/index.js';
import { createDatabasePool, runMigrations } from '../src/index.js';
import {
  applyGrants,
  ensureApplicationRole,
  verifyApplicationConnection,
} from '../src/bootstrap.js';

/**
 * The production bootstrap must converge a database whose migrations ran
 * while the application role was missing (the audited failure: every
 * role-guarded grant block silently skipped) to the same privilege
 * matrix as a fresh install.
 */

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD ?? 'local-app-change-me';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(here, '..', 'migrations');

const runId = randomBytes(5).toString('hex');
const bootDbName = `auto_mb_boot_${runId}`;

let admin: Sql;
let bootAdmin: Sql;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-boot-admin',
  });
  await admin`select 1 as ready`;
  await admin.unsafe(`create database ${bootDbName}`);
  bootAdmin = createDatabasePool({
    url: adminUrl.replace(/\/[^/]+$/, `/${bootDbName}`),
    max: 1,
    applicationName: 'auto-mb-boot-target',
  });
  // The cluster-shared role keeps its usual password; ensure it exists
  // exactly as bootstrap would.
  await ensureApplicationRole(bootAdmin, appPassword);
  await runMigrations(bootAdmin, migrationsDirectory);
  // Simulate the audited state: migrations recorded, but the role holds
  // no privileges in this database at all.
  const tables = await bootAdmin<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public'
  `;
  for (const { tablename } of tables) {
    await bootAdmin.unsafe(`revoke all on ${tablename} from auto_mb_app`);
  }
  await bootAdmin.unsafe(`revoke all on schema public, app_private from auto_mb_app`);
  // And the post-restore state on a fresh cluster: pg_restore --no-owner
  // leaves the SECURITY DEFINER functions owned by the restoring role,
  // which breaks organisation creation until ownership is repaired.
  for (const fn of [
    'app_private.current_organisation_id()',
    'app_private.current_user_id()',
    'app_private.create_organisation_with_owner(text, text, uuid)',
  ]) {
    await bootAdmin.unsafe(`alter function ${fn} owner to auto_mb_owner`);
  }
}, 60_000);

afterAll(async () => {
  if (bootAdmin) await bootAdmin.end();
  if (admin) {
    await admin.unsafe(`drop database if exists ${bootDbName} with (force)`);
    await admin.end();
  }
});

describe('production bootstrap', () => {
  it('converges a grant-stripped database to the canonical matrix', async () => {
    // Before: the application role cannot even see the schema.
    const [before] = await bootAdmin<{ ok: boolean }[]>`
      select has_table_privilege('auto_mb_app', 'works', 'SELECT') as ok
    `;
    expect(before?.ok).toBe(false);

    await applyGrants(bootAdmin);

    const expectations: [string, string, boolean][] = [
      ['works', 'SELECT', true],
      ['works', 'DELETE', false],
      ['delivery_challans', 'DELETE', true],
      ['mb_entries', 'UPDATE', true],
      ['mb_entries', 'DELETE', false],
      ['audit_events', 'INSERT', true],
      ['audit_events', 'UPDATE', false],
      ['work_assignments', 'DELETE', true],
      ['work_assignments', 'UPDATE', false],
      ['measurement_book_merge_provenance', 'SELECT', true],
      ['measurement_book_merge_provenance', 'INSERT', true],
      ['measurement_book_merge_provenance', 'UPDATE', false],
      ['measurement_book_merge_provenance', 'DELETE', false],
      ['tax_invoice_renders', 'SELECT', true],
      ['tax_invoice_renders', 'INSERT', true],
      ['tax_invoice_renders', 'UPDATE', false],
      ['tax_invoice_renders', 'DELETE', false],
      ['tax_invoice_renders', 'TRUNCATE', false],
      ['auth_users', 'DELETE', true],
    ];
    for (const [table, privilege, expected] of expectations) {
      const [row] = await bootAdmin<{ ok: boolean }[]>`
        select has_table_privilege(
          'auto_mb_app', ${table}, ${privilege}
        ) as ok
      `;
      expect(row?.ok, `${table} ${privilege}`).toBe(expected);
    }

    // The SECURITY DEFINER functions are owned by the BYPASSRLS definer
    // role again — the fresh-cluster restore repair (external re-audit).
    const owners = await bootAdmin<{ proname: string; owner: string }[]>`
      select p.proname, p.proowner::regrole::text as owner
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private'
        and p.proname in (
          'current_organisation_id', 'current_user_id',
          'create_organisation_with_owner'
        )
    `;
    expect(owners).toHaveLength(3);
    for (const row of owners) {
      expect(row.owner, row.proname).toBe('auto_mb_definer');
    }

    // And the application role can actually connect and query.
    const appUrl = adminUrl
      .replace(/\/\/[^@]+@/, `//auto_mb_app:${appPassword}@`)
      .replace(/\/[^/]+$/, `/${bootDbName}`);
    await verifyApplicationConnection(appUrl);
  }, 30_000);
});
