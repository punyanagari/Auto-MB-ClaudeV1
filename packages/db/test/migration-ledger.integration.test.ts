import { randomBytes } from 'node:crypto';
import {
  appendFile,
  copyFile,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';

const here = path.dirname(fileURLToPath(import.meta.url));
const realMigrationsDirectory = path.resolve(here, '..', 'migrations');

const TEST_TIMEOUT_MS = 60_000;

let admin: Sql;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-migration-ledger-admin',
  });
  await admin`select 1 as ready`;
});

afterAll(async () => {
  try {
    // Sweep temp databases leaked by crashed earlier runs; the per-test
    // finally cannot help when the process itself was killed.
    const stale = await admin<{ datname: string }[]>`
      select datname from pg_database
      where datname like 'auto_mb_ledger_test_%'
    `;
    for (const database of stale) {
      await admin.unsafe(`drop database if exists ${database.datname} with (force)`);
    }
  } finally {
    await admin?.end();
  }
});

/**
 * Runs `work` against a freshly created, uniquely named database and drops
 * it afterwards, so ledger-tampering experiments can never touch a
 * developer's normal auto_mb database.
 */
async function withTemporaryDatabase(
  work: (pool: Sql) => Promise<void>,
): Promise<void> {
  const databaseName = `auto_mb_ledger_test_${randomBytes(6).toString('hex')}`;
  await admin.unsafe(`create database ${databaseName}`);

  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  const pool = createDatabasePool({
    url: url.toString(),
    max: 2,
    applicationName: 'auto-mb-migration-ledger-test',
  });

  try {
    await work(pool);
  } finally {
    try {
      await pool.end({ timeout: 5 });
    } catch {
      // A wedged pool must not stop the drop below; `with (force)`
      // terminates whatever the pool left behind.
    }
    await admin.unsafe(`drop database if exists ${databaseName} with (force)`);
  }
}

/** Copies the real migration files into a writable temporary directory. */
async function copyMigrationsTo(directory: string): Promise<void> {
  for (const name of await readdir(realMigrationsDirectory)) {
    await copyFile(
      path.join(realMigrationsDirectory, name),
      path.join(directory, name),
    );
  }
}

async function appliedIds(pool: Sql): Promise<string[]> {
  const rows = await pool<{ id: string }[]>`
    select id from schema_migrations order by id
  `;
  return rows.map((row) => row.id);
}

// The runner's ledger checks: an applied migration's file may not be edited
// (hash), renamed (file name), or removed (missing file). Each test applies
// the real migrations to a disposable database, corrupts the copied
// directory in exactly one way, and expects the rerun to refuse.
describe('migration ledger integrity', () => {
  it(
    'refuses a rerun when an applied migration file was edited',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ledger-'));
      try {
        await copyMigrationsTo(directory);
        await withTemporaryDatabase(async (pool) => {
          await runMigrations(pool, directory);

          await appendFile(
            path.join(directory, '0001_core.sql'),
            '\n-- tampered after apply\n',
          );

          await expect(runMigrations(pool, directory)).rejects.toThrow(
            '0001_core.sql: applied migration hash changed',
          );
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a rerun when an applied migration file was renamed',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ledger-'));
      try {
        await copyMigrationsTo(directory);
        await withTemporaryDatabase(async (pool) => {
          await runMigrations(pool, directory);

          // Same id, same bytes, different name: the hash check alone would
          // wave this through.
          await rename(
            path.join(directory, '0001_core.sql'),
            path.join(directory, '0001_core_reworded.sql'),
          );

          await expect(runMigrations(pool, directory)).rejects.toThrow(
            '0001_core_reworded.sql: applied migration file name changed ' +
              '(the ledger records 0001_core.sql)',
          );
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a rerun when an applied migration file was removed, before applying anything new',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ledger-'));
      try {
        await copyMigrationsTo(directory);
        await withTemporaryDatabase(async (pool) => {
          await runMigrations(pool, directory);

          await rm(path.join(directory, '0001_core.sql'));
          // A pending migration alongside the hole proves the ledger check
          // runs before application, not after.
          await writeFile(
            path.join(directory, '0999_ledger_probe.sql'),
            'CREATE TABLE migration_ledger_probe (id integer PRIMARY KEY);\n',
          );

          await expect(runMigrations(pool, directory)).rejects.toThrow(
            '0001_core.sql: applied migration 0001 has no file on disk',
          );

          const ids = await appliedIds(pool);
          expect(ids).not.toContain('0999');
          const [probe] = await pool<{ count: number }[]>`
            select count(*)::int as count from pg_catalog.pg_tables
            where schemaname = 'public' and tablename = 'migration_ledger_probe'
          `;
          expect(probe?.count).toBe(0);
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
