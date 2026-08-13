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

// skip-reason: the real v1 production backup is not in the repository and
// must not be; this suite runs only where AUTO_MB_V1_BACKUP_PATH points at a
// copy of it. The companion suite below asserts the absence, loudly.
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

      const partronics = report.organisations.find(
        (org) => org.slug === 'partronics-eboards',
      );
      const par = report.organisations.find((org) => org.slug === 'par-electronics');
      expect(partronics && par).toBeTruthy();
      if (!partronics || !par) throw new Error('unreachable');

      // Suffixed challan numbers import (approved change): 607 of the
      // 609 Partronics challans land — only the zero-quantity-lines
      // challan and the second challan of the pending pair (one draft
      // per Work) remain excepted.
      expect(partronics.counts.delivery_challan).toMatchObject({
        source: 609,
        imported: 607,
        excepted: 2,
      });
      const challanExceptionRules = partronics.exceptions
        .filter((exception) => exception.entityType === 'delivery_challan')
        .map((exception) => exception.rule)
        .sort();
      // pending-below-series-head entries are advisory (the challan
      // still imports as an unnumbered draft); the only challans NOT
      // imported are the two counted above.
      expect(challanExceptionRules).toEqual([
        'no-importable-lines',
        'one-draft-per-work',
        'pending-below-series-head',
        'pending-below-series-head',
      ]);
      const suffixed = partronics.challanSeries
        .flatMap((series) => series.suffixedAssignments)
        .map((assignment) => ({
          challanNo: assignment.challanNo,
          assignedSequence: assignment.assignedSequence,
        }))
        .sort((a, b) => a.challanNo.localeCompare(b.challanNo));
      expect(suffixed).toEqual([
        { challanNo: 'PL-236-BB-DC-15A', assignedSequence: 49 },
        { challanNo: 'PL-242-BB-DC-36-T', assignedSequence: 60 },
        { challanNo: 'PL-PL-243-SUR-DC-38A', assignedSequence: 45 },
      ]);

      // Every series line names the exact number the live route will
      // mint (the '/' separator disclosure).
      for (const series of [...partronics.challanSeries, ...par.challanSeries]) {
        expect(series.nextIssueNumber).toMatch(/\/\d+$/);
        expect(
          series.nextIssueNumber?.endsWith(`/${String(series.counterValue + 1)}`),
        ).toBe(true);
      }

      // 'TO' range tokens never import as serials: each of the 14
      // range lines is a named exception carrying its endpoints, and
      // the serial ledger balances exactly — source = imported +
      // unchanged + excepted (finding: tokens on excepted challans and
      // lines previously vanished from the accounting).
      const rangeNotations = partronics.exceptions.filter(
        (exception) => exception.rule === 'serial-range-notation',
      );
      expect(rangeNotations).toHaveLength(14);
      for (const exception of rangeNotations) {
        expect(exception.detail).toMatch(
          /^serial range notation \S+ TO \S+ — expand or correct in v1/,
        );
      }
      for (const org of [partronics, par]) {
        expect(org.serials.sourceTokens).toBe(
          org.serials.imported + org.serials.unchanged + org.serials.excepted,
        );
      }
      expect(partronics.serials).toMatchObject({ sourceTokens: 5448, excepted: 73 });

      // Rate precision (approved change, numeric(18,6)): challan line
      // rates carry over with zero drift in both organisations, and so
      // do Par Electronics' agreement rates. The only remaining rate
      // drift is honest: one Partronics v1 work stores computed
      // agreement rates with EIGHT decimals (13.82141922), which
      // numeric(18,6) must round — 21 items, reported, never hidden.
      expect(partronics.quantization.line_rate?.changed).toBe(0);
      expect(par.quantization.line_rate?.changed).toBe(0);
      expect(par.quantization.effective_rate?.changed).toBe(0);
      expect(partronics.quantization.effective_rate?.changed).toBe(21);
      for (const drift of partronics.quantizationWorst) {
        if (drift.fieldClass === 'effective_rate') {
          expect(drift.sourceId).toContain('item-w-1785581787627-ed9hy');
        }
      }

      // The quantization counter is decimal-level honest now: contract
      // values genuinely rounded to paise report as changed (the old
      // relative threshold said 0/32 while rounding all of them).
      expect(partronics.quantization.contract_value?.changed).toBe(29);
      expect(par.quantization.contract_value?.changed).toBe(2);

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

// skip-reason: the inverse of the suite above — it exists to announce the
// missing backup, so it is inert on any machine that actually has one.
describe.runIf(!backupPresent)('v1 importer real-backup smoke (skipped)', () => {
  it('skips because the production backup is not present on this machine', () => {
    console.log(
      `real v1 backup not found at ${backupPath} — smoke test skipped (expected in CI; ` +
        'set AUTO_MB_V1_BACKUP_PATH to run it locally)',
    );
    expect(backupPresent).toBe(false);
  });
});
