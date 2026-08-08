import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/index.js';
import { createDatabasePool, runMigrations } from '../src/index.js';

const execFileAsync = promisify(execFile);

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const migrationsDirectory = path.resolve(here, '..', 'migrations');

const runId = randomBytes(5).toString('hex');
const restoreDbName = `auto_mb_restore_${runId}`;

let admin: Sql;
let compatible = false;
let skipReason = '';
let workDir: string;
let organisationId: string;

/** pg_dump can only dump servers at or below its own major version; the
 * proof runs wherever the client is new enough and skips (loudly) where it
 * is not — e.g. CI runners whose bundled client trails the service image. */
async function toolingCompatible(sql: Sql): Promise<{ ok: boolean; reason: string }> {
  let clientVersion: string;
  try {
    const { stdout } = await execFileAsync('pg_dump', ['--version']);
    clientVersion = stdout.trim();
  } catch {
    return { ok: false, reason: 'pg_dump is not installed' };
  }
  const clientMajor = Number(/(\d+)/.exec(clientVersion)?.[1] ?? '0');
  const [row] = await sql<{ v: string }[]>`
    select current_setting('server_version') as v
  `;
  const serverMajor = Number(/(\d+)/.exec(row?.v ?? '')?.[1] ?? 'NaN');
  if (
    !Number.isFinite(clientMajor) ||
    !Number.isFinite(serverMajor) ||
    serverMajor === 0
  ) {
    return { ok: false, reason: 'could not determine pg_dump/server versions' };
  }
  if (clientMajor < serverMajor) {
    return {
      ok: false,
      reason: `pg_dump ${String(clientMajor)} cannot dump server ${String(serverMajor)}`,
    };
  }
  return { ok: true, reason: '' };
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-backup-test',
  });
  await admin`select 1 as ready`;
  await runMigrations(admin, migrationsDirectory);
  const check = await toolingCompatible(admin);
  compatible = check.ok;
  skipReason = check.reason;
  if (!compatible) {
    console.warn(`backup/restore proof skipped: ${skipReason}`);
    return;
  }

  workDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-backup-'));
  // Seed one organisation and one stored object so the restore has
  // something recognisable to prove.
  const [row] = await admin<{ id: string }[]>`
    insert into organisations (name, slug)
    values ('Backup Proof Constructions', ${`backup-proof-${runId}`})
    returning id
  `;
  if (!row) throw new Error('seed organisation failed');
  organisationId = row.id;
  const objectDir = path.join(workDir, 'objects', organisationId, 'loa');
  await mkdir(objectDir, { recursive: true });
  await writeFile(path.join(objectDir, 'proof.pdf'), `%PDF-1.4 backup ${runId}`);
}, 60_000);

afterAll(async () => {
  if (admin) {
    if (compatible) {
      await admin.unsafe(`drop database if exists ${restoreDbName} with (force)`);
      if (organisationId) {
        await admin`delete from organisations where id = ${organisationId}`;
      }
    }
    await admin.end();
  }
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('backup and restore', () => {
  it('backs up and restores the database and object store, verified', async () => {
    if (!compatible) {
      console.warn(`skipped: ${skipReason}`);
      return;
    }
    const backupRoot = path.join(workDir, 'backups');
    const { stdout } = await execFileAsync(
      'bash',
      [path.join(repoRoot, 'scripts', 'backup.sh')],
      {
        env: {
          ...process.env,
          DATABASE_ADMIN_URL: adminUrl,
          OBJECT_STORAGE_DIR: path.join(workDir, 'objects'),
          BACKUP_ROOT: backupRoot,
        },
      },
    );
    const backupDir = /backup written to (.+)$/m.exec(stdout)?.[1];
    expect(backupDir, stdout).toBeTruthy();
    if (!backupDir) return;

    await admin.unsafe(`create database ${restoreDbName}`);
    const restoreUrl = adminUrl.replace(/\/[^/]+$/, `/${restoreDbName}`);
    const restoreObjects = path.join(workDir, 'restored-objects');
    await execFileAsync(
      'bash',
      [path.join(repoRoot, 'scripts', 'restore.sh'), backupDir],
      {
        env: {
          ...process.env,
          RESTORE_DATABASE_URL: restoreUrl,
          RESTORE_OBJECT_STORAGE_DIR: restoreObjects,
        },
      },
    );

    const restored = createDatabasePool({
      url: restoreUrl,
      max: 1,
      applicationName: 'auto-mb-restore-check',
    });
    try {
      const [org] = await restored<{ name: string }[]>`
        select name from organisations where id = ${organisationId}
      `;
      expect(org?.name).toBe('Backup Proof Constructions');
      const [tables] = await restored<{ count: string }[]>`
        select count(*)::text as count from information_schema.tables
        where table_schema = 'public'
      `;
      expect(Number(tables?.count)).toBeGreaterThanOrEqual(15);
    } finally {
      await restored.end({ timeout: 5 });
    }

    const restoredObject = await readFile(
      path.join(restoreObjects, organisationId, 'loa', 'proof.pdf'),
      'utf8',
    );
    expect(restoredObject).toBe(`%PDF-1.4 backup ${runId}`);
  }, 120_000);
});
