import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/index.js';
import { createDatabasePool, runMigrations } from '../src/index.js';

const execFileAsync = promisify(execFile);

/**
 * Options for every temporary-directory removal in this file.
 *
 * The suite shells out to `bash`, `pg_dump` and `tar` inside these
 * directories. On Windows a child process that has just exited can still
 * hold an open handle for a few milliseconds — and Windows refuses to
 * unlink an open file — so a bare `rm(dir, { recursive: true })` fails with
 * EBUSY/EPERM often enough to have been the suite's standing flake. Node's
 * own retry loop is the fix: `rm` re-attempts on exactly those codes.
 */
const RM_TEMP = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

/** What `promisify(execFile)` rejects with: an Error carrying the child's
 * exit status and both captured streams. */
type ExecFailure = Error & {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
};

/** Runs a command expected to FAIL and returns the rejection, so the test
 * can assert on the actual failure rather than on "something threw". */
async function failureOf(promise: Promise<unknown>): Promise<ExecFailure> {
  try {
    await promise;
  } catch (error) {
    return error as ExecFailure;
  }
  throw new Error('expected the command to fail, but it succeeded');
}

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const migrationsDirectory = path.resolve(here, '..', 'migrations');
const backupScript = path.join(repoRoot, 'scripts', 'backup.sh');
const restoreScript = path.join(repoRoot, 'scripts', 'restore.sh');

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
    // CI sets RESTORE_PROOF=required: a green run must MEAN the restore
    // executed — incompatible tooling fails the gate instead of silently
    // skipping the proof (external review, ops batch).
    if (process.env.RESTORE_PROOF === 'required') {
      throw new Error(`restore proof is required but cannot run: ${skipReason}`);
    }
    console.warn(`backup/restore proof skipped: ${skipReason}`);
    return;
  }

  workDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-backup-'));
  // Keep every Bash path relative to its working directory. Windows Bash
  // implementations disagree on drive syntax (/c, /mnt/c, C:/), while the
  // copied bytes remain the exact production scripts under test.
  await copyFile(backupScript, path.join(workDir, 'backup.sh'));
  await copyFile(restoreScript, path.join(workDir, 'restore.sh'));
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
  if (workDir) await rm(workDir, RM_TEMP);
});

describe('backup and restore', () => {
  it('backs up and restores the database and object store, verified', async () => {
    if (!compatible) {
      console.warn(`skipped: ${skipReason}`);
      return;
    }
    const backupRoot = path.join(workDir, 'backups');
    const beforeBackup = Math.floor(Date.now() / 1000);
    const { stdout } = await execFileAsync('bash', ['backup.sh'], {
      cwd: workDir,
      env: {
        ...process.env,
        DATABASE_ADMIN_URL: adminUrl,
        OBJECT_STORAGE_DIR: 'objects',
        BACKUP_ROOT: 'backups',
      },
    });
    const backupDir = /backup written to (.+)$/m.exec(stdout)?.[1];
    expect(backupDir, stdout).toBeTruthy();
    if (!backupDir) return;

    // The last-success marker certifies dump + archive + verified manifest;
    // it must hold the epoch of exactly this run.
    const marker = (
      await readFile(path.join(backupRoot, 'last-success'), 'utf8')
    ).trim();
    expect(marker).toMatch(/^\d+$/);
    const markerEpoch = Number(marker);
    expect(markerEpoch).toBeGreaterThanOrEqual(beforeBackup);
    expect(markerEpoch).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    await admin.unsafe(`create database ${restoreDbName}`);
    const restoreUrl = adminUrl.replace(/\/[^/]+$/, `/${restoreDbName}`);
    const restoreObjects = path.join(workDir, 'restored-objects');
    await execFileAsync('bash', ['restore.sh', backupDir], {
      cwd: workDir,
      env: {
        ...process.env,
        RESTORE_DATABASE_URL: restoreUrl,
        RESTORE_OBJECT_STORAGE_DIR: 'restored-objects',
      },
    });

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

describe('backup last-success marker', () => {
  it('does not update the marker when the dump step fails', async () => {
    // Self-contained (no live database, no pg_dump/server version match):
    // the dump step fails either way, which is exactly the point — a failed
    // run must leave the previous marker untouched.
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-marker-'));
    try {
      const objectsDir = path.join(scratch, 'objects');
      await mkdir(objectsDir, { recursive: true });
      await writeFile(path.join(objectsDir, 'object.txt'), 'content');
      const backupRoot = path.join(scratch, 'backups');
      await mkdir(backupRoot, { recursive: true });
      const markerPath = path.join(backupRoot, 'last-success');
      await writeFile(markerPath, '12345\n');
      await copyFile(backupScript, path.join(scratch, 'backup.sh'));
      const failure = await failureOf(
        execFileAsync('bash', ['backup.sh'], {
          cwd: scratch,
          env: {
            ...process.env,
            // Discard port: the connection is refused, so pg_dump fails
            // after the object-directory check but before any artefact
            // is produced. The password is the repo-wide secretlint
            // placeholder, not a credential.
            DATABASE_ADMIN_URL:
              'postgres://nobody:local-app-change-me@127.0.0.1:9/absent',
            OBJECT_STORAGE_DIR: 'objects',
            BACKUP_ROOT: 'backups',
          },
        }),
      );
      // Name the failure the test means: `set -euo pipefail` must carry
      // PG_DUMP's non-zero status out of the script. A bare "it threw"
      // would pass just as happily on a typo in the script's own path,
      // which is the opposite of what this test claims to prove.
      expect(failure.code, failure.stderr).not.toBe(0);
      expect(failure.stderr).toMatch(/pg_dump: error:/);
      expect(failure.stderr).toMatch(/connection|could not connect/i);
      // pg_dump creates its output file before it can know the connection
      // will be refused, so a truncated `database.dump` is expected. What
      // must NOT exist is the object archive or the manifest: without
      // SHA256SUMS the directory can never pass restore.sh's own check, so
      // no later operator can mistake this wreckage for a backup.
      const stamped = (await readdir(backupRoot)).filter(
        (entry) => entry !== 'last-success',
      );
      for (const directory of stamped) {
        const produced = await readdir(path.join(backupRoot, directory));
        expect(produced).not.toContain('objects.tar.gz');
        expect(produced).not.toContain('SHA256SUMS');
      }
      expect((await readFile(markerPath, 'utf8')).trim()).toBe('12345');
    } finally {
      await rm(scratch, RM_TEMP);
    }
  }, 30_000);

  it('writes the marker into BACKUP_MARKER_DIR when redirected (production topology)', async () => {
    if (!compatible) {
      console.warn(`skipped: ${skipReason}`);
      return;
    }
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-marker-dir-'));
    try {
      const objectsDir = path.join(scratch, 'objects');
      await mkdir(objectsDir, { recursive: true });
      await writeFile(path.join(objectsDir, 'object.txt'), 'content');
      const backupRoot = path.join(scratch, 'backups');
      const markerDir = path.join(scratch, 'backup-status');
      await copyFile(backupScript, path.join(scratch, 'backup.sh'));
      await execFileAsync('bash', ['backup.sh'], {
        cwd: scratch,
        env: {
          ...process.env,
          DATABASE_ADMIN_URL: adminUrl,
          OBJECT_STORAGE_DIR: 'objects',
          BACKUP_ROOT: 'backups',
          BACKUP_MARKER_DIR: 'backup-status',
        },
      });
      const marker = await readFile(path.join(markerDir, 'last-success'), 'utf8');
      expect(marker.trim()).toMatch(/^\d+$/);
      // Redirection means exactly that: nothing lands at the default path.
      // The specific failure matters — ENOENT proves the file is absent,
      // where a bare toThrow() would also accept a permission error or a
      // mistyped path and call that a pass.
      await expect(
        readFile(path.join(backupRoot, 'last-success'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(scratch, RM_TEMP);
    }
  }, 120_000);
});
