import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/index.js';
import {
  createDatabasePool,
  ensureApplicationRole,
  runMigrations,
} from '../src/index.js';
import {
  TABLE_PRIVILEGES,
  UNGRANTED_BY_DESIGN,
  applyGrants,
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
    'app_private.bind_tenant(uuid, text)',
    'app_private.enqueue_job(text, jsonb)',
    'app_private.claim_next_job(text, integer)',
    'app_private.complete_job(uuid, uuid, jsonb)',
    'app_private.fail_job(uuid, uuid, text, timestamptz, text)',
    'app_private.release_job(uuid, uuid, text)',
  ]) {
    await bootAdmin.unsafe(`alter function ${fn} owner to auto_mb_owner`);
  }
}, 60_000);

// Dropping a whole database and draining two pools can exceed the 10s
// default hook budget when every suite runs in parallel on one cluster;
// same explicit budget as the setup hook above.
afterAll(async () => {
  if (bootAdmin) await bootAdmin.end();
  if (admin) {
    await admin.unsafe(`drop database if exists ${bootDbName} with (force)`);
    await admin.end();
  }
}, 60_000);

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
      // The GST rate master (0048): retire-by-end-dating, so no DELETE.
      ['gst_rates', 'SELECT', true],
      ['gst_rates', 'INSERT', true],
      ['gst_rates', 'UPDATE', true],
      ['gst_rates', 'DELETE', false],
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
          'create_organisation_with_owner', 'bind_tenant',
          'enqueue_job', 'claim_next_job', 'complete_job', 'fail_job', 'release_job'
        )
    `;
    expect(owners).toHaveLength(9);
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

/**
 * Audit finding 10's acceptance condition. The matrix being complete today
 * was established by reading every CREATE TABLE by hand; that proves the
 * present state and nothing about the next migration. This test derives
 * the required set from the catalog of the freshly migrated database, so a
 * table that lands without a matrix entry — and therefore without any
 * grant, failing at runtime with a bare permission-denied — fails here
 * instead of shipping.
 */
describe('privilege matrix drift', () => {
  /**
   * Every table the migrations create carries an entry in the matrix, or
   * an entry in the ungranted-by-design set with its reason. The migration
   * ledger used to be the single exception; it is now declared
   * `SELECT`-only, because the `/api/ready` schema-version gate reads it to
   * refuse traffic when the image is ahead of the database. Writing it is
   * still administrator-only, which the read-only proof below enforces.
   *
   * The ungranted set is no longer empty: `worker_jobs` (0072) is reached
   * only through SECURITY DEFINER functions and holds no application
   * privilege at all (ADR-0011). It is read from `bootstrap.ts` rather
   * than restated here, so the decision lives in one place — the same
   * discipline that keeps TABLE_PRIVILEGES from being shadowed by a second
   * hand-kept list.
   */
  const ungrantedByDesign = new Set(Object.keys(UNGRANTED_BY_DESIGN));

  it('declares every table the migrations create', async () => {
    const rows = await bootAdmin<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;
    const tables = rows.map((row) => row.table_name);
    // A vacuous pass on an unmigrated database would defeat the point.
    expect(tables.length).toBeGreaterThan(50);

    const missing = tables.filter(
      (table) =>
        !ungrantedByDesign.has(table) &&
        !Object.prototype.hasOwnProperty.call(TABLE_PRIVILEGES, table),
    );
    expect(
      missing,
      `tables present in the database but absent from the bootstrap ` +
        `privilege matrix: ${missing.join(', ')}. Declare each in ` +
        'TABLE_PRIVILEGES (packages/db/src/bootstrap.ts), or record it in ' +
        'UNGRANTED_BY_DESIGN with the reason it holds no application grant.',
    ).toEqual([]);
  });

  it('names no relation the database does not have', async () => {
    // The other drift direction: a table renamed or dropped by a migration
    // leaves a matrix entry that makes `applyGrants` throw on a fresh
    // install. Views count — consignee_masters (0028) is a compatibility
    // view and legitimately carries its own narrow ACL.
    const rows = await bootAdmin<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_type in ('BASE TABLE', 'VIEW')
    `;
    const present = new Set(rows.map((row) => row.table_name));
    const stale = Object.keys(TABLE_PRIVILEGES).filter((table) => !present.has(table));
    expect(
      stale,
      `privilege matrix entries with no matching relation: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('grants read-only access on the migration ledger', async () => {
    // The readiness gate needs to READ the applied ids; nothing in the
    // application may ever write them, so a future widening of this entry
    // fails here rather than shipping a forgeable migration history.
    const expected: Record<string, boolean> = {
      SELECT: true,
      INSERT: false,
      UPDATE: false,
      DELETE: false,
    };
    for (const [privilege, allowed] of Object.entries(expected)) {
      const [row] = await bootAdmin<{ ok: boolean }[]>`
        select has_table_privilege(
          'auto_mb_app', 'schema_migrations', ${privilege}
        ) as ok
      `;
      expect(row?.ok, `schema_migrations ${privilege}`).toBe(allowed);
    }
  });
});
