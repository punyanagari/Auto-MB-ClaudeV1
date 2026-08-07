import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

// Every test here is bounded: if lock handling deadlocks, the test fails at
// this timeout instead of hanging the suite.
const TEST_TIMEOUT_MS = 30_000;

let admin: Sql;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-migration-concurrency-admin',
  });
  await admin`select 1 as ready`;
});

afterAll(async () => {
  await admin?.end();
});

/**
 * Runs `work` against a freshly created, uniquely named database and drops
 * it afterwards, so concurrent-migration experiments can never touch a
 * developer's normal auto_mb database.
 */
async function withTemporaryDatabase(
  work: (pool: Sql) => Promise<void>,
): Promise<void> {
  const databaseName = `auto_mb_migration_test_${randomBytes(6).toString('hex')}`;
  await admin.unsafe(`create database ${databaseName}`);

  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  const pool = createDatabasePool({
    url: url.toString(),
    max: 4,
    applicationName: 'auto-mb-migration-concurrency-test',
  });

  try {
    await work(pool);
  } finally {
    await pool.end();
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

async function appliedLedger(pool: Sql): Promise<{ id: string; file_name: string }[]> {
  return pool<{ id: string; file_name: string }[]>`
    select id, file_name from schema_migrations order by id
  `;
}

describe('concurrent migration execution', () => {
  it(
    'lets two simultaneous runners bootstrap a fresh database exactly once',
    async () => {
      await withTemporaryDatabase(async (pool) => {
        await Promise.all([
          runMigrations(pool, realMigrationsDirectory),
          runMigrations(pool, realMigrationsDirectory),
        ]);

        const [ledgerTables] = await pool<{ count: number }[]>`
          select count(*)::int as count from pg_catalog.pg_tables
          where schemaname = 'public' and tablename = 'schema_migrations'
        `;
        expect(ledgerTables?.count).toBe(1);

        const migrationFiles = (await readdir(realMigrationsDirectory))
          .filter((name) => name.endsWith('.sql'))
          .sort();
        const ledger = await appliedLedger(pool);
        expect(ledger.map((row) => row.file_name)).toEqual(migrationFiles);

        // Applied exactly once each: ledger ids are the primary key, so a
        // double apply would have failed the second runner outright.
        expect(new Set(ledger.map((row) => row.id)).size).toBe(ledger.length);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'applies one new pending migration exactly once under two simultaneous runners',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-migrations-'));
      try {
        await copyMigrationsTo(directory);
        await withTemporaryDatabase(async (pool) => {
          await runMigrations(pool, directory);

          await writeFile(
            path.join(directory, '0999_concurrency_probe.sql'),
            'CREATE TABLE migration_concurrency_probe (id integer PRIMARY KEY);\n',
          );
          await Promise.all([
            runMigrations(pool, directory),
            runMigrations(pool, directory),
          ]);

          const ledger = await appliedLedger(pool);
          expect(ledger.filter((row) => row.id === '0999')).toEqual([
            { id: '0999', file_name: '0999_concurrency_probe.sql' },
          ]);

          const [probe] = await pool<{ count: number }[]>`
            select count(*)::int as count from pg_catalog.pg_tables
            where schemaname = 'public' and tablename = 'migration_concurrency_probe'
          `;
          expect(probe?.count).toBe(1);
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'releases the lock after a failed migration so a corrected run proceeds',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-migrations-'));
      try {
        await copyMigrationsTo(directory);
        const brokenPath = path.join(directory, '0999_concurrency_probe.sql');
        await writeFile(
          brokenPath,
          'CREATE TABLE migration_concurrency_probe (id integer PRIMARY KEY;\n',
        );

        await withTemporaryDatabase(async (pool) => {
          await expect(runMigrations(pool, directory)).rejects.toThrow();

          // The failed migration rolled back: no ledger row, no table.
          const ledgerAfterFailure = await appliedLedger(pool);
          expect(ledgerAfterFailure.some((row) => row.id === '0999')).toBe(false);

          await writeFile(
            brokenPath,
            'CREATE TABLE migration_concurrency_probe (id integer PRIMARY KEY);\n',
          );
          // Hangs here if the failed run leaked its advisory lock.
          await runMigrations(pool, directory);

          const ledger = await appliedLedger(pool);
          expect(ledger.some((row) => row.id === '0999')).toBe(true);
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
