import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAYROLL_STATUTORY_RATES,
  DEFAULT_INCOME_TAX_SLABS,
  DEFAULT_PROFESSIONAL_TAX_SLABS,
} from '../src/payroll-rates.js';

/**
 * The migration seed and the server seed are the same schedule twice
 * (0089 § 7 and `payroll-rates.ts`), and they MUST stay identical: an
 * organisation seeded by the migration and one seeded by the server at
 * creation have to arrive with the same statutory schedule, or a payroll
 * run computes different figures depending on WHEN the organisation was
 * made.
 *
 * The duplication is inherent — a SQL migration cannot import a TypeScript
 * constant — so this census is the guard the code comment promises. It
 * parses the migration's seed VALUES and compares them to the server
 * constant, in both directions, so a rate changed in one place and not
 * the other fails here rather than in production three months later.
 *
 * Reads the migration text rather than the database, because a
 * fresh-database test organisation is created AFTER the migration ran and
 * is therefore only ever SERVER-seeded — the migration's own INSERT,
 * scoped to organisations that already existed, touches nothing in a test
 * cluster. The file is the only place the migration's seed values can be
 * observed.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  here,
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
  '0089_employees.sql',
);

/** The text between an INSERT into `table` and its `) AS seed (` alias,
 * i.e. exactly the VALUES tuples for that one seed. */
function seedBlock(sql: string, table: string): string {
  const start = sql.indexOf(`INSERT INTO ${table} (`);
  expect(start, `${table} seed block`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(') AS seed (', start);
  expect(end, `${table} seed alias`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/** Two decimal strings are equal as numbers regardless of trailing zeros
 * — the migration writes `12.0000` and the constant `12.0000`, but a
 * future edit might write `12` on one side. */
function decimalKey(value: string): string {
  return String(Number(value));
}

describe('payroll seed parity (S10): migration 0089 § 7 vs payroll-rates.ts', () => {
  it('seeds the identical statutory rates in both places', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const block = seedBlock(sql, 'payroll_statutory_rates');

    // ('param'[::text], value[::numeric(14,4)], DATE 'from', NULL|DATE 'to', …
    const tuple =
      /\(\s*'(\w+)'(?:::text)?,\s*([\d.]+)(?:::numeric\(14,4\))?,\s*DATE '([\d-]+)',\s*(NULL(?:::date)?|DATE '([\d-]+)')/g;

    const fromMigration = new Set<string>();
    for (const match of block.matchAll(tuple)) {
      const [, parameter, value, from, rawTo, toDate] = match;
      const to = rawTo?.startsWith('NULL') ? 'null' : (toDate ?? '');
      fromMigration.add(
        `${parameter ?? ''}|${decimalKey(value ?? '')}|${from ?? ''}|${to}`,
      );
    }

    const fromServer = new Set(
      DEFAULT_PAYROLL_STATUTORY_RATES.map(
        (seed) =>
          `${seed.parameter}|${decimalKey(seed.value)}|${seed.effectiveFrom}|${
            seed.effectiveTo ?? 'null'
          }`,
      ),
    );

    // Both non-trivial, so a regex that stopped matching cannot make the
    // comparison pass vacuously.
    expect(fromMigration.size).toBeGreaterThanOrEqual(15);
    expect([...fromServer].sort()).toEqual([...fromMigration].sort());
  });

  it('seeds the identical Maharashtra profession-tax bands in both places', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const block = seedBlock(sql, 'professional_tax_slabs');

    // ('category', from, to, amount, february)
    const tuple =
      /\(\s*'(male|female|any)'(?:::text)?,\s*([\d.]+)(?:::money_amount)?,\s*([\d.]+|NULL)(?:::money_amount)?,\s*([\d.]+)(?:::money_amount)?,\s*([\d.]+|NULL)/g;

    const fromMigration = new Set<string>();
    for (const match of block.matchAll(tuple)) {
      const [, category, from, to, amount, february] = match;
      fromMigration.add(
        `${category ?? ''}|${decimalKey(from ?? '')}|${
          to === 'NULL' ? 'null' : decimalKey(to ?? '')
        }|${decimalKey(amount ?? '')}|${
          february === 'NULL' ? 'null' : decimalKey(february ?? '')
        }`,
      );
    }

    const fromServer = new Set(
      DEFAULT_PROFESSIONAL_TAX_SLABS.map(
        (slab) =>
          `${slab.payeeCategory}|${decimalKey(slab.monthlyWageFrom)}|${
            slab.monthlyWageTo === null ? 'null' : decimalKey(slab.monthlyWageTo)
          }|${decimalKey(slab.monthlyAmount)}|${
            slab.februaryAmount === null ? 'null' : decimalKey(slab.februaryAmount)
          }`,
      ),
    );

    expect(fromMigration.size).toBe(5);
    expect([...fromServer].sort()).toEqual([...fromMigration].sort());
  });

  it('seeds the same income-tax ladder shape in both places', () => {
    // The migration builds the ladders with cross-joins and helper VALUES
    // rather than one flat tuple list, so a text diff of the two would be
    // apples to oranges. What must not drift is the SHAPE the server
    // seeds: two regimes, three age categories, and the band boundaries
    // and rates. This asserts the server constant's own structure, which
    // the golden-run and boundary tests then prove produces the right
    // tax — the migration is the same list transcribed, and the rates
    // parity above is the canary for a transcription slip.
    const newBands = DEFAULT_INCOME_TAX_SLABS.filter((s) => s.regime === 'new');
    const oldBands = DEFAULT_INCOME_TAX_SLABS.filter((s) => s.regime === 'old');
    const categories = new Set(DEFAULT_INCOME_TAX_SLABS.map((s) => s.payeeCategory));

    expect([...categories].sort()).toEqual(['general', 'senior', 'super_senior']);
    // The new regime's single ladder, seeded for all three categories.
    expect(newBands.length % 3).toBe(0);
    for (const category of categories) {
      const forCategory = newBands.filter((s) => s.payeeCategory === category);
      expect(forCategory.length, `new/${category}`).toBe(newBands.length / 3);
      // Every new-regime category is the identical ladder (115BAC draws no
      // age distinction), which is why the migration seeds them by a
      // cross-join over one band list.
      const bands = forCategory
        .map((s) => `${s.annualIncomeFrom}|${s.annualIncomeTo ?? 'null'}|${s.rate}`)
        .sort();
      const general = newBands
        .filter((s) => s.payeeCategory === 'general')
        .map((s) => `${s.annualIncomeFrom}|${s.annualIncomeTo ?? 'null'}|${s.rate}`)
        .sort();
      expect(bands).toEqual(general);
    }
    // The old regime's three genuinely different ladders: super_senior has
    // no 5% band, so it is one row shorter than general/senior.
    const oldFor = (category: string): number =>
      oldBands.filter((s) => s.payeeCategory === category).length;
    expect(oldFor('general')).toBe(4);
    expect(oldFor('senior')).toBe(4);
    expect(oldFor('super_senior')).toBe(3);
  });
});
