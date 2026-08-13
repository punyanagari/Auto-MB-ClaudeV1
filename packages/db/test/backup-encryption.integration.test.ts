import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Backup encryption, the recovery secret set, and the off-host copy
 * (pack P6).
 *
 * The reconciled review scored backup/restore 5.5 with "no PITR/off-host/
 * encryption, dump and object archive at different instants, AUTH_SECRET
 * in no recovery set", and recorded that the operations documents claimed
 * encryption the script did not perform. These are the properties the
 * script now has, asserted so the documents cannot drift ahead of it
 * again.
 *
 * Keeps `backup-restore.integration.test.ts`'s conventions: every Bash
 * path is relative to the working directory, and the bytes under test are
 * copies of the exact production scripts.
 */

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const backupScript = path.join(repoRoot, 'scripts', 'backup.sh');
const restoreScript = path.join(repoRoot, 'scripts', 'restore.sh');

const runId = randomBytes(5).toString('hex');

let workDir: string;
let compatible = false;
let skipReason = '';

/** The scripts shell out to `openssl` and `pg_dump`; both have to be on
 * PATH for the proof to mean anything. CI sets RESTORE_PROOF=required, and
 * a required proof that cannot run fails rather than passing quietly. */
async function toolingAvailable(): Promise<{ ok: boolean; reason: string }> {
  for (const tool of ['openssl', 'pg_dump', 'tar']) {
    try {
      await execFileAsync(tool, ['--version']);
    } catch {
      return { ok: false, reason: `${tool} is not installed` };
    }
  }
  return { ok: true, reason: '' };
}

/** Every path handed to Bash stays relative to the working directory, the
 * same convention `backup-restore.integration.test.ts` keeps: Windows Bash
 * implementations disagree on drive syntax, and `openssl` there is a
 * native binary that cannot open an MSYS `/tmp/...` path at all. */
function scriptEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, RESTORE_WORK_DIR: 'scratch', ...extra };
}

beforeAll(async () => {
  const check = await toolingAvailable();
  compatible = check.ok;
  skipReason = check.reason;
  if (!compatible) {
    if (process.env.RESTORE_PROOF === 'required') {
      throw new Error(
        `backup encryption proof is required but cannot run: ${skipReason}`,
      );
    }
    console.warn(`backup encryption proof skipped: ${skipReason}`);
    return;
  }

  workDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-encbackup-'));
  await copyFile(backupScript, path.join(workDir, 'backup.sh'));
  await copyFile(restoreScript, path.join(workDir, 'restore.sh'));
  await mkdir(path.join(workDir, 'scratch'), { recursive: true });
  await mkdir(path.join(workDir, 'objects', 'org', 'loa'), { recursive: true });
  await writeFile(
    path.join(workDir, 'objects', 'org', 'loa', 'proof.pdf'),
    `%PDF-1.4 encrypted ${runId}`,
  );
  await writeFile(
    path.join(workDir, 'secrets.env'),
    `AUTH_SECRET=recovery-secret-${runId}${'0'.repeat(32)}\n`,
  );

  // An RSA keypair standing in for the operator's. The production posture
  // is that only the PUBLIC half ever reaches the host (docs/RUNBOOK.md
  // §4a); the test holds both because it plays both roles.
  await execFileAsync(
    'openssl',
    [
      'genpkey',
      '-algorithm',
      'RSA',
      '-pkeyopt',
      'rsa_keygen_bits:3072',
      '-out',
      'backup-private.pem',
    ],
    { cwd: workDir },
  );
  await execFileAsync(
    'openssl',
    ['pkey', '-in', 'backup-private.pem', '-pubout', '-out', 'backup-public.pem'],
    { cwd: workDir },
  );
}, 120_000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
});

async function runBackup(extra: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync('bash', ['backup.sh'], {
    cwd: workDir,
    env: scriptEnv({
      DATABASE_ADMIN_URL: adminUrl,
      OBJECT_STORAGE_DIR: 'objects',
      ...extra,
    }),
  });
  const directory = /backup written to (.+)$/m.exec(stdout)?.[1];
  if (directory === undefined) throw new Error(`no backup directory in: ${stdout}`);
  return directory.trim();
}

describe('backup encryption', () => {
  it('refuses to write plaintext when encryption is required', async () => {
    if (!compatible) return void console.warn(`skipped: ${skipReason}`);
    await expect(
      execFileAsync('bash', ['backup.sh'], {
        cwd: workDir,
        env: scriptEnv({
          DATABASE_ADMIN_URL: adminUrl,
          OBJECT_STORAGE_DIR: 'objects',
          BACKUP_ROOT: 'refused',
          BACKUP_REQUIRE_ENCRYPTION: '1',
        }),
      }),
    ).rejects.toThrow(/Refusing to write an unencrypted backup/);
  }, 60_000);

  it('refuses to include the recovery secrets in an unencrypted backup', async () => {
    if (!compatible) return void console.warn(`skipped: ${skipReason}`);
    // AUTH_SECRET and the database passwords are never written in the
    // clear, whatever else the operator has configured.
    await expect(
      execFileAsync('bash', ['backup.sh'], {
        cwd: workDir,
        env: scriptEnv({
          DATABASE_ADMIN_URL: adminUrl,
          OBJECT_STORAGE_DIR: 'objects',
          BACKUP_ROOT: 'refused',
          BACKUP_SECRETS_FILE: 'secrets.env',
        }),
      }),
    ).rejects.toThrow(/never written in the clear/);
  }, 60_000);

  it('encrypts every artefact, carries AUTH_SECRET, and restores end to end', async () => {
    if (!compatible) return void console.warn(`skipped: ${skipReason}`);
    const backupDir = await runBackup({
      BACKUP_ROOT: 'backups',
      BACKUP_MARKER_DIR: 'marker',
      BACKUP_ENCRYPTION_PUBLIC_KEY: 'backup-public.pem',
      BACKUP_REQUIRE_ENCRYPTION: '1',
      BACKUP_SECRETS_FILE: 'secrets.env',
    });

    const manifest = await readFile(path.join(workDir, backupDir, 'MANIFEST'), 'utf8');
    expect(manifest).toContain('encryption=rsa-oaep-sha256+aes-256-cbc');
    expect(manifest).toContain('secrets_included=yes');
    expect(manifest).toContain('objects_consistency=enumerated-after-dump');

    // Nothing plaintext reaches BACKUP_ROOT: the dump and the archive are
    // streamed through the cipher rather than written and then encrypted.
    const { readdir } = await import('node:fs/promises');
    const entries = (await readdir(path.join(workDir, backupDir))).sort();
    expect(entries).toEqual([
      'MANIFEST',
      'SHA256SUMS',
      'data-key.enc',
      'database.dump.enc',
      'objects.tar.gz.enc',
      'secrets.env.enc',
    ]);
    const sealed = await readFile(
      path.join(workDir, backupDir, 'database.dump.enc'),
      'utf8',
    );
    // OpenSSL's salted-envelope header, i.e. not a PostgreSQL dump.
    expect(sealed.slice(0, 8)).toBe('Salted__');
    expect(sealed).not.toContain('PGDMP');

    // Without the private key — which never lives on the production host —
    // the backup is inert.
    await expect(
      execFileAsync('bash', ['restore.sh', backupDir], {
        cwd: workDir,
        env: scriptEnv({
          RESTORE_DATABASE_URL: adminUrl,
          RESTORE_OBJECT_STORAGE_DIR: 'restored-denied',
        }),
      }),
    ).rejects.toThrow(/BACKUP_ENCRYPTION_PRIVATE_KEY/);

    const restoreDbName = `auto_mb_enc_${runId}`;
    const { stdout: createOut } = await execFileAsync('psql', [
      adminUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `create database ${restoreDbName}`,
    ]);
    expect(createOut).toBeDefined();
    try {
      const restoreUrl = adminUrl.replace(/\/[^/]+$/, `/${restoreDbName}`);
      await execFileAsync('bash', ['restore.sh', backupDir], {
        cwd: workDir,
        env: scriptEnv({
          RESTORE_DATABASE_URL: restoreUrl,
          RESTORE_OBJECT_STORAGE_DIR: 'restored',
          BACKUP_ENCRYPTION_PRIVATE_KEY: 'backup-private.pem',
          RESTORE_SECRETS_OUT: 'recovered.env',
        }),
      });

      expect(
        await readFile(
          path.join(workDir, 'restored', 'org', 'loa', 'proof.pdf'),
          'utf8',
        ),
      ).toBe(`%PDF-1.4 encrypted ${runId}`);
      // The recovery set is the point: a restored database whose
      // AUTH_SECRET is gone cannot decrypt a single stored TOTP secret.
      expect(await readFile(path.join(workDir, 'recovered.env'), 'utf8')).toContain(
        `AUTH_SECRET=recovery-secret-${runId}`,
      );
    } finally {
      await execFileAsync('psql', [
        adminUrl,
        '-c',
        `drop database if exists ${restoreDbName} with (force)`,
      ]);
    }
  }, 180_000);

  it('withholds the last-success marker when the off-host copy fails', async () => {
    if (!compatible) return void console.warn(`skipped: ${skipReason}`);
    // A backup that exists only on the host it protects has not survived
    // the failure it exists for, so the freshness gauge must not certify
    // one. `false` stands in for an unreachable off-host target.
    await mkdir(path.join(workDir, 'offhost-marker'), { recursive: true });
    await writeFile(path.join(workDir, 'offhost-marker', 'last-success'), '12345\n');
    await expect(
      execFileAsync('bash', ['backup.sh'], {
        cwd: workDir,
        env: scriptEnv({
          DATABASE_ADMIN_URL: adminUrl,
          OBJECT_STORAGE_DIR: 'objects',
          BACKUP_ROOT: 'offhost-backups',
          BACKUP_MARKER_DIR: 'offhost-marker',
          BACKUP_ENCRYPTION_PUBLIC_KEY: 'backup-public.pem',
          BACKUP_OFFHOST_COMMAND: 'false',
        }),
      }),
    ).rejects.toThrow(/off-host copy failed/);
    expect(
      (
        await readFile(path.join(workDir, 'offhost-marker', 'last-success'), 'utf8')
      ).trim(),
    ).toBe('12345');
  }, 120_000);
});
