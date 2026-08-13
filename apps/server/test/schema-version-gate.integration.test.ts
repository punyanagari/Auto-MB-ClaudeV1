import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * The `/api/ready` schema-version gate (pack P6).
 *
 * A server container started against a database the deploy never migrated
 * used to answer `ready`, which meant the deploy's own readiness gate and
 * the uptime monitor both certified a process serving requests against a
 * schema its code does not expect. The gate compares the applied-migration
 * ledger with the migration directory the image carries and refuses in the
 * BEHIND direction only — a ledger ahead of the image is the documented
 * rollback posture (forward-only migrations, docs/OPERATIONS.md §4).
 *
 * The image names its migration directory with `AUTO_MB_MIGRATIONS_DIR`
 * (deploy/Dockerfile.server); the tests below drive the gate through that
 * same variable rather than a test-only seam.
 */

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(
  here,
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
);

let admin: Sql;
let storageDir: string;
let scratchDir: string;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-schema-gate-test',
  });
  await admin`select 1 as ready`;
  await runMigrations(admin, migrationsDirectory);
  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-schema-gate-'));
  scratchDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-migrations-'));
}, 120_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (admin) await admin.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
  if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
});

/** A directory holding nothing but migration FILE NAMES: the gate compares
 * ids, and never reads a migration body. */
async function migrationDirectoryNamed(
  name: string,
  fileNames: readonly string[],
): Promise<string> {
  const directory = path.join(scratchDir, name);
  await mkdir(directory, { recursive: true });
  for (const fileName of fileNames) {
    await writeFile(
      path.join(directory, fileName),
      '-- id-only fixture; the readiness gate never reads a migration body\n',
    );
  }
  return directory;
}

async function ready(): Promise<{
  status: number;
  body: { status: string; reason?: string };
}> {
  const app: FastifyInstance = await buildApp({
    databaseUrl: appUrl,
    objectStorageDir: storageDir,
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/ready' });
    return {
      status: response.statusCode,
      body: response.json<{ status: string; reason?: string }>(),
    };
  } finally {
    await app.close();
  }
}

describe('readiness schema-version gate', () => {
  it('is ready when the ledger carries every migration the image ships', async () => {
    vi.stubEnv('AUTO_MB_MIGRATIONS_DIR', migrationsDirectory);
    const response = await ready();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.status).toBe('ready');
  }, 30_000);

  it('answers 503 when the image ships a migration the ledger has not applied', async () => {
    // One unapplied id is the whole condition: the image is ahead of the
    // database, so this process must not take traffic.
    const directory = await migrationDirectoryNamed('behind', [
      '0001_core.sql',
      '9999_never_applied.sql',
    ]);
    vi.stubEnv('AUTO_MB_MIGRATIONS_DIR', directory);

    const response = await ready();
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(response.body).toMatchObject({
      status: 'not-ready',
      reason: 'schema-migrations-behind',
    });
  }, 30_000);

  it('stays ready when the ledger is AHEAD of the image (rollback posture)', async () => {
    // A rolled-back image sees a database carrying migrations it never
    // shipped. Forward-only migrations are additive and are deliberately
    // not rolled back with the image, so this must not refuse traffic.
    const directory = await migrationDirectoryNamed('ahead', ['0001_core.sql']);
    vi.stubEnv('AUTO_MB_MIGRATIONS_DIR', directory);

    const response = await ready();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.status).toBe('ready');
  }, 30_000);

  it('answers 503 when the migration directory the image names is missing', async () => {
    vi.stubEnv('AUTO_MB_MIGRATIONS_DIR', path.join(scratchDir, 'does-not-exist'));

    const response = await ready();
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(response.body).toMatchObject({
      status: 'not-ready',
      reason: 'schema-migrations-unreadable',
    });
  }, 30_000);
});
