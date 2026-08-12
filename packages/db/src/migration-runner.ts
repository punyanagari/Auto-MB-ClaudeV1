import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ReservedSql, Sql } from 'postgres';

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const FORBIDDEN_TRANSACTION_CONTROL = /^\s*(begin|commit|rollback)\b.*;?\s*$/im;

function stripDollarQuotedBodies(input: string): string {
  let output = '';
  let index = 0;

  while (index < input.length) {
    if (input[index] !== '$') {
      output += input[index];
      index += 1;
      continue;
    }

    const remainder = input.slice(index);
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored with a single non-nested quantifier; linear on all inputs
    const tag = remainder.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
    if (!tag) {
      output += input[index];
      index += 1;
      continue;
    }

    const end = input.indexOf(tag, index + tag.length);
    if (end === -1)
      throw new Error(`unterminated dollar-quoted body beginning at byte ${index}`);

    output += ' '.repeat(end + tag.length - index);
    index = end + tag.length;
  }

  return output;
}

function transactionControlSurface(input: string): string {
  return stripDollarQuotedBodies(input)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '');
}

export interface MigrationFile {
  readonly id: string;
  readonly fileName: string;
  readonly absolutePath: string;
  readonly sha256: string;
  readonly sql: string;
}

export async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
  const migrations: MigrationFile[] = [];

  for (const fileName of names) {
    const absolutePath = path.join(directory, fileName);
    const sql = await readFile(absolutePath, 'utf8');
    if (FORBIDDEN_TRANSACTION_CONTROL.test(transactionControlSurface(sql))) {
      throw new Error(`${fileName}: top-level transaction control is forbidden`);
    }
    migrations.push({
      id: fileName.slice(0, 4),
      fileName,
      absolutePath,
      sha256: createHash('sha256').update(sql).digest('hex'),
      sql,
    });
  }

  if (migrations.length === 0) throw new Error(`No migrations found in ${directory}`);

  const ids = new Set<string>();
  for (const migration of migrations) {
    if (ids.has(migration.id)) {
      throw new Error(`duplicate migration id: ${migration.id}`);
    }
    ids.add(migration.id);
  }

  return migrations;
}

// Advisory-lock key serialising competing migrators (two int32 halves for
// pg_try_advisory_lock(int, int)). Owned by Auto-MB; documented here and
// used nowhere else. 0x4155544f = "AUTO", 0x4d420001 = "MB" + slot 1
// (migrations).
export const MIGRATION_LOCK_CLASS = 0x4155544f;
export const MIGRATION_LOCK_ID = 0x4d420001;

const LOCK_RETRY_INTERVAL_MS = 250;
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

export interface RunMigrationsOptions {
  /** How long to wait for a competing migrator before failing with a clear
   * error instead of blocking a deploy indefinitely. */
  readonly lockTimeoutMs?: number;
}

async function acquireMigrationLock(
  reserved: ReservedSql,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${MIGRATION_LOCK_CLASS}, ${MIGRATION_LOCK_ID}) as locked
    `;
    if (row?.locked) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `another migration run holds the Auto-MB migration lock; gave up after ${String(timeoutMs)}ms`,
      );
    }
    await sleep(LOCK_RETRY_INTERVAL_MS);
  }
}

export async function runMigrations(
  sql: Sql,
  directory: string,
  options: RunMigrationsOptions = {},
): Promise<void> {
  const migrations = await readMigrations(directory);

  // One reserved physical connection carries the whole run: the advisory
  // lock is session-scoped, so ledger reads and migration execution must
  // ride the connection that holds it. postgres.js 3.4.9's reserved handle
  // exposes queries and unsafe() but not begin() (its internal Sql(handler)
  // omits it despite the ReservedSql type), so per-migration atomicity is
  // driven with explicit BEGIN/COMMIT on this dedicated connection.
  const reserved = await sql.reserve();
  try {
    await acquireMigrationLock(
      reserved,
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    );
    try {
      // Checked before creating so repeat runs stay silent; `if not exists`
      // emits a NOTICE that postgres.js prints as an alarming object dump.
      // Safe against concurrent creators because it runs under the lock.
      const [ledger] = await reserved`
        select 1 as present from pg_catalog.pg_tables
        where schemaname = 'public' and tablename = 'schema_migrations'
      `;
      if (!ledger) {
        await reserved`
          create table schema_migrations (
            id text primary key,
            file_name text not null unique,
            sha256 text not null,
            applied_at timestamptz not null default now()
          )
        `;
      }

      const applied = await reserved<
        { id: string; file_name: string; sha256: string }[]
      >`
        select id, file_name, sha256 from schema_migrations order by id
      `;

      // Every applied ledger row must still have its file on disk under its
      // recorded name. The per-migration hash check below catches edits to an
      // applied file, but a lookup keyed by id alone would silently accept a
      // renamed file (same id, same hash) and never notice a deleted one, so
      // both are refused here before anything new is applied.
      const migrationsById = new Map(
        migrations.map((migration) => [migration.id, migration]),
      );
      for (const row of applied) {
        const migration = migrationsById.get(row.id);
        if (migration === undefined) {
          throw new Error(
            `${row.file_name}: applied migration ${row.id} has no file on disk`,
          );
        }
        if (migration.fileName !== row.file_name) {
          throw new Error(
            `${migration.fileName}: applied migration file name changed (the ledger records ${row.file_name})`,
          );
        }
      }

      const appliedById = new Map(applied.map((row) => [row.id, row.sha256]));

      for (const migration of migrations) {
        const recordedHash = appliedById.get(migration.id);
        if (recordedHash !== undefined) {
          if (recordedHash !== migration.sha256) {
            throw new Error(`${migration.fileName}: applied migration hash changed`);
          }
          continue;
        }

        await reserved.unsafe('begin');
        try {
          await reserved.unsafe(migration.sql);
          await reserved`
            insert into schema_migrations (id, file_name, sha256)
            values (${migration.id}, ${migration.fileName}, ${migration.sha256})
          `;
          await reserved.unsafe('commit');
        } catch (error) {
          try {
            await reserved.unsafe('rollback');
          } catch {
            // A broken connection aborts the transaction and releases the
            // session lock by itself; surface the original failure.
          }
          throw error;
        }
        console.log(`applied ${migration.fileName}`);
      }
    } finally {
      try {
        await reserved`select pg_advisory_unlock(${MIGRATION_LOCK_CLASS}, ${MIGRATION_LOCK_ID})`;
      } catch {
        // Unlock is best-effort: if the connection died, the session lock
        // is already gone with it.
      }
    }
  } finally {
    reserved.release();
  }
}
