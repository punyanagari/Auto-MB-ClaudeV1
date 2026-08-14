import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlanNode, Sql, TransactionSql } from '@auto-mb/db';
import {
  aggregateLoops,
  createDatabasePool,
  ensureClusterRoles,
  explainPlan,
  removeOrganisationResidue,
  runMigrations,
  sharedBlocks,
  withTenant,
} from '@auto-mb/db';
import { writeLines as writeChallanLines } from '../src/routes/challans.js';
import { writeLines as writeIssueChallanLines } from '../src/routes/issue-challans.js';
import {
  ITEM_INPUTS_SQL,
  loadItemInputs,
} from '../src/routes/measurement-books/internal.js';
import { DASHBOARD_PROGRESS_SQL } from '../src/routes/dashboard.js';
import {
  seedAggregateFixture,
  type AggregateFixture,
} from './helpers/aggregate-fixture.js';

/**
 * Scale budgets with committed thresholds (pack P11).
 *
 * The question this file answers is not "is it fast on this machine" —
 * that answer is worthless on a different one — but "does the cost still
 * grow the way it should". So the budgets are structural wherever they
 * can be:
 *
 * - a statement count that does NOT change when the document gets five
 *   times longer (the per-row write loops this pack removed made it
 *   grow one-for-one);
 * - aggregate loop counts of exactly one at a scale where the retired
 *   shapes would report one per row;
 * - shared-buffer ceilings, committed as numbers, with the measurement
 *   date and machine recorded beside them.
 *
 * Only one budget is a wall-clock number, and it carries an order of
 * magnitude of headroom over the measurement, because CI runs
 * ubuntu-24.04 with a PostgreSQL service container and this was measured
 * on Windows against a local cluster.
 */

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';
const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD ?? 'local-app-change-me';

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

/**
 * Measured 2026-08-13 on Windows against a local PostgreSQL 18 cluster,
 * with the fixture below (120 items x 4 challans x 13 Works):
 *
 * | statement               | shared blocks | wall clock |
 * | ----------------------- | ------------: | ---------: |
 * | Measurement Book loader |        12,737 |      86 ms |
 * | dashboard progress      |           906 |          - |
 *
 * The block ceilings carry ~3x headroom and the clock ~20x, because CI
 * runs a different operating system, PostgreSQL version and disk.
 */
const MB_BLOCK_CEILING = 40_000;
const DASHBOARD_BLOCK_CEILING = 4_000;
const MB_WALL_CLOCK_CEILING_MS = 2_000;

const ITEMS = 120;
const CHALLANS = 4;
const SIBLING_WORKS = 12;

/**
 * The tables the measured statements read.
 *
 * Re-analyzed immediately before each measurement, for the reason
 * `query-aggregates.integration.test.ts` states at length: this suite
 * shares its database with every other integration file, vitest runs them
 * in parallel, and a plan chosen from `beforeAll`'s statistics is a plan
 * chosen for tables that have since moved. Scoped rather than
 * database-wide, because a whole-database pass on a database several
 * workers are writing to is lock churn nobody asked for.
 */
const FIXTURE_TABLES = [
  'works',
  'work_items',
  'work_schedules',
  'delivery_challans',
  'delivery_challan_items',
  'installations',
  'pac_certificates',
  'measurement_books',
  'measurement_book_lines',
  'mb_sources',
  'bills',
] as const;

async function analyzeFixtureTables(): Promise<void> {
  await admin.unsafe(`analyze ${FIXTURE_TABLES.join(', ')}`);
}

/** The EXPLAIN kit lives in `@auto-mb/db` (`src/explain.ts`). This file,
 * `scale-budget.integration.test.ts` and the RLS plan-shape guards in
 * `packages/db/test` each carried a copy of it declaring only the plan
 * fields that copy happened to read, and a plan assertion is only as good
 * as its field names. `explainPlan` takes ANALYZE and BUFFERS as options;
 * both are on here, because these budgets read `Actual Loops` and buffer
 * counts.
 *
 * `aggregateLoops` is the highest loop count over the plan's AGGREGATE
 * nodes — how many times PostgreSQL had to compute a sum. Join nodes may
 * legitimately loop (a nested loop over 40 items is linear work); an
 * aggregate that loops is the per-row shape pack P11 removed. */
async function explain(
  tx: TransactionSql,
  sql: string,
  parameters: readonly unknown[],
): Promise<PlanNode[]> {
  return explainPlan(tx, sql, parameters, { analyze: true, buffers: true });
}

/** Counts the statements a helper issues. postgres.js transactions are
 * callable tagged-template objects, so an apply trap sees every query
 * and a get trap wraps `unsafe`; production code is untouched. */
function countingTransaction(tx: TransactionSql): {
  readonly counted: TransactionSql;
  readonly statements: string[];
} {
  const statements: string[] = [];
  const counted = new Proxy(tx, {
    apply(target, thisArg, args: unknown[]) {
      const strings = args[0] as readonly string[];
      statements.push(strings.join('?').replace(/\s+/g, ' ').trim().slice(0, 80));
      const callable = target as unknown as (...parameters: unknown[]) => unknown;
      return callable.apply(thisArg, args);
    },
    get(target, property, receiver) {
      if (property === 'unsafe') {
        return (query: string, ...rest: unknown[]) => {
          statements.push(query.replace(/\s+/g, ' ').trim().slice(0, 80));
          return (
            target as unknown as {
              unsafe: (query: string, ...rest: unknown[]) => unknown;
            }
          ).unsafe(query, ...rest);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value === 'function') {
        return (value as (...parameters: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });
  return { counted, statements };
}

const runId = randomBytes(4).toString('hex');

let admin: Sql;
let appPool: Sql;
let fixture: AggregateFixture;
let deliveryChallanId: string;
let issueChallanId: string;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'p11-scale-admin',
  });
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);
  appPool = createDatabasePool({
    url: appUrl,
    max: 4,
    applicationName: 'p11-scale-app',
  });
  fixture = await seedAggregateFixture(admin, {
    items: ITEMS,
    challans: CHALLANS,
    siblingWorks: SIBLING_WORKS,
    label: runId,
  });

  // Two empty drafts for the write-budget tests to fill.
  deliveryChallanId = randomUUID();
  await admin`
    insert into delivery_challans (
      id, organisation_id, work_id, challan_date, prefix, status,
      created_by_user_id
    )
    values (
      ${deliveryChallanId}, ${fixture.organisationId}, ${fixture.workId},
      '2026-03-02', 'DC', 'draft', ${fixture.userId}
    )
  `;
  issueChallanId = randomUUID();
  await admin`
    insert into issue_challans (
      id, organisation_id, work_id, movement_type, status, challan_date,
      prefix, issued_to_name, created_by_user_id
    )
    values (
      ${issueChallanId}, ${fixture.organisationId}, ${fixture.workId},
      'issue', 'draft', '2026-03-02', 'IC', 'Site engineer',
      ${fixture.userId}
    )
  `;
  await admin.unsafe('analyze');
}, 300_000);

afterAll(async () => {
  await removeOrganisationResidue(admin, [fixture.organisationId]);
  await appPool.end();
  await admin.end();
});

describe('read budgets hold their shape at scale', () => {
  it('loads 120 items of Measurement Book input in one statement inside its budget', async () => {
    const { statements, elapsedMs, rows } = await withTenant(
      appPool,
      { organisationId: fixture.organisationId, userId: fixture.userId },
      async (tx) => {
        const { counted, statements: seen } = countingTransaction(tx);
        const startedAt = performance.now();
        const loaded = await loadItemInputs(counted, fixture.workId, fixture.bookId);
        return {
          statements: seen,
          elapsedMs: performance.now() - startedAt,
          rows: loaded.length,
        };
      },
    );
    expect(rows).toBe(ITEMS);
    expect(statements).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(MB_WALL_CLOCK_CEILING_MS);
  });

  it('keeps the Measurement Book aggregates at one execution and inside the buffer ceiling', async () => {
    await analyzeFixtureTables();
    const nodes = await withTenant(
      appPool,
      { organisationId: fixture.organisationId, userId: fixture.userId },
      (tx) => explain(tx, ITEM_INPUTS_SQL, [fixture.workId, fixture.bookId]),
    );
    expect(aggregateLoops(nodes)).toBe(1);
    expect(sharedBlocks(nodes)).toBeLessThan(MB_BLOCK_CEILING);
  });

  it('keeps the dashboard aggregates at one execution across every Work', async () => {
    await analyzeFixtureTables();
    const nodes = await withTenant(
      appPool,
      { organisationId: fixture.organisationId, userId: fixture.userId },
      (tx) => explain(tx, DASHBOARD_PROGRESS_SQL, [true, fixture.userId]),
    );
    expect(aggregateLoops(nodes)).toBe(1);
    expect(sharedBlocks(nodes)).toBeLessThan(DASHBOARD_BLOCK_CEILING);
  });
});

describe('write budgets do not grow with the document', () => {
  /** A document of `count` Work-item lines. */
  const challanItems = (count: number) =>
    fixture.itemIds.slice(0, count).map((workItemId) => ({
      workItemId,
      quantity: '1.000',
    }));

  it('writes a delivery challan in the same number of statements at 5 lines and at 60', async () => {
    const counts = await withTenant(
      appPool,
      { organisationId: fixture.organisationId, userId: fixture.userId },
      async (tx) => {
        const short = countingTransaction(tx);
        await writeChallanLines(
          short.counted,
          fixture.organisationId,
          deliveryChallanId,
          fixture.workId,
          { items: challanItems(5) },
        );
        const long = countingTransaction(tx);
        await writeChallanLines(
          long.counted,
          fixture.organisationId,
          deliveryChallanId,
          fixture.workId,
          { items: challanItems(60) },
        );
        return { short: short.statements.length, long: long.statements.length };
      },
    );
    // Two deletes, one row-lock read over the referenced items, and one
    // insert — whatever the document holds. Before P11 the long document
    // cost 55 more round-trips than the short one; the property this
    // test holds is the SECOND assertion, that the two counts are equal.
    //
    // The count moved from 3 to 4 with migration 0068, which added the
    // `FOR UPDATE` read that serialises a draft save against a
    // concurrent payment-category change. It is one statement over the
    // whole line set, not one per line, so it raises the constant
    // without touching the invariant.
    expect(counts.short).toBe(4);
    expect(counts.long).toBe(counts.short);
  });

  it('writes an issue challan in the same number of statements at 5 lines and at 60', async () => {
    const counts = await withTenant(
      appPool,
      { organisationId: fixture.organisationId, userId: fixture.userId },
      async (tx) => {
        const short = countingTransaction(tx);
        await writeIssueChallanLines(
          short.counted,
          fixture.organisationId,
          issueChallanId,
          fixture.workId,
          { lines: challanItems(5) } as never,
        );
        const long = countingTransaction(tx);
        await writeIssueChallanLines(
          long.counted,
          fixture.organisationId,
          issueChallanId,
          fixture.workId,
          { lines: challanItems(60) } as never,
        );
        return { short: short.statements.length, long: long.statements.length };
      },
    );
    expect(counts.short).toBe(2);
    expect(counts.long).toBe(counts.short);
  });
});
