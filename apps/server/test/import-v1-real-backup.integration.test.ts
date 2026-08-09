import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { runV1Import } from '../src/import/importer.js';
import { parseMappingConfig } from '../src/import/mapping.js';
import { readV1Backup } from '../src/import/v1-backup.js';
import { renderRunReport } from '../src/import/report.js';
import { sha256Hex } from '../src/import/canonical.js';

/**
 * Smoke test against THE REAL v1 production backup, in dry-run mode only:
 * the whole pipeline runs in one transaction and rolls back, so the shared
 * test database is left untouched. The backup contains customer production
 * data and is NEVER committed; when the file is absent (CI), the suite
 * skips with a message.
 */
const backupPath =
  process.env.AUTO_MB_V1_BACKUP_PATH ??
  '/tmp/claude-0/-home-user-Auto-MB-ClaudeV1/462e856a-6199-5061-8052-a46f06a92a5e/scratchpad/v1-backup.sqlite';
const backupPresent = existsSync(backupPath);

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';

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
const mappingPath = path.resolve(
  here,
  '..',
  '..',
  '..',
  'scripts',
  'import-v1.mapping.json',
);

describe.skipIf(!backupPresent)(
  'v1 importer dry-run against the real production backup',
  () => {
    let admin: Sql;

    beforeAll(async () => {
      admin = createDatabasePool({
        url: adminUrl,
        max: 1,
        applicationName: 'auto-mb-import-real-smoke',
      });
      await admin`select 1 as ready`;
      await runMigrations(admin, migrationsDirectory);
      return async () => {
        await admin.end({ timeout: 5 });
      };
    }, 60_000);

    it('completes, reports 34 works / 650 challans / 2 organisations, and lists exceptions without throwing', async () => {
      const mapping = parseMappingConfig(JSON.parse(readFileSync(mappingPath, 'utf8')));
      const backup = readV1Backup(backupPath);
      expect(backup.works).toHaveLength(34);
      expect(backup.challans).toHaveLength(650);

      const report = await runV1Import(admin, {
        backup,
        mapping,
        mode: 'dry-run',
        inputDigest: sha256Hex('real-backup-smoke'),
      });

      // Print the full reconciliation report for the integrator's log.
      console.log(renderRunReport(report));

      expect(report.mode).toBe('dry-run');
      expect(report.organisations).toHaveLength(2);
      const totalSourceWorks = report.organisations.reduce(
        (sum, org) => sum + (org.counts.work?.source ?? 0),
        0,
      );
      const totalSourceChallans = report.organisations.reduce(
        (sum, org) => sum + (org.counts.delivery_challan?.source ?? 0),
        0,
      );
      expect(totalSourceWorks).toBe(34);
      expect(totalSourceChallans).toBe(650);

      // The production data is imperfect; the report says so honestly
      // instead of throwing — every exception names its source row.
      const exceptions = report.organisations.flatMap((org) => org.exceptions);
      expect(exceptions.length).toBeGreaterThan(0);
      for (const exception of exceptions) {
        expect(exception.sourceId.length).toBeGreaterThan(0);
        expect(exception.rule.length).toBeGreaterThan(0);
      }

      // Dry-run left nothing behind: the mapped production slugs must not
      // exist in the shared test database.
      const [organisations] = await admin<{ count: string }[]>`
        select count(*)::text as count from organisations
        where slug in ('partronics-eboards', 'par-electronics')
      `;
      expect(organisations?.count).toBe('0');
    }, 300_000);
  },
);

describe.runIf(!backupPresent)('v1 importer real-backup smoke (skipped)', () => {
  it('skips because the production backup is not present on this machine', () => {
    console.log(
      `real v1 backup not found at ${backupPath} — smoke test skipped (expected in CI; ` +
        'set AUTO_MB_V1_BACKUP_PATH to run it locally)',
    );
    expect(backupPresent).toBe(false);
  });
});
