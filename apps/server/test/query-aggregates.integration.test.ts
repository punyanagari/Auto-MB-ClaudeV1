import { randomBytes } from 'node:crypto';
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
import {
  ITEM_INPUTS_SQL,
  loadItemInputs,
} from '../src/routes/measurement-books/internal.js';
import { DASHBOARD_PBG_SQL, DASHBOARD_PROGRESS_SQL } from '../src/routes/dashboard.js';
import {
  seedAggregateFixture,
  type AggregateFixture,
} from './helpers/aggregate-fixture.js';

/**
 * The regression guard for pack P11's two aggregate rewrites (programme
 * §1.3 rows 34 and 36: the Measurement Book loader measured at 33,669
 * index probes / 446 ms, and the dashboard at 881 ms over 412k items).
 *
 * It holds three things, and the first is the one that matters most:
 *
 * 1. EQUIVALENCE. The retired correlated-lateral statements are kept
 *    below, verbatim, and run beside the shipped grouped-aggregate ones
 *    on a seeded fixture. Every column of every row must be identical
 *    character-for-character — these are money and quantity figures, and
 *    a performance change that moves one of them is a defect, not an
 *    optimisation.
 * 2. QUERY BUDGET. The loader is ONE statement, whatever the Work holds.
 * 3. PLAN SHAPE. No node of either plan is executed more than once —
 *    which is precisely what the six laterals did wrong, re-running each
 *    aggregate per work item. Asserted structurally (`Actual Loops` from
 *    EXPLAIN ANALYZE) rather than in milliseconds, so it means the same
 *    thing on CI's PostgreSQL as on a developer's.
 *
 * Proof that the guard bites: run this file against the pre-fix tree
 * (`git stash` the src changes) and the plan-shape assertions fail with
 * loop counts equal to the item count.
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

/** The retired Measurement Book loader: six correlated laterals, one set
 * per work item. Kept as evidence, and as the thing the new statement
 * must agree with exactly. `$1` is the Work, `$2` the Measurement Book. */
const RETIRED_ITEM_INPUTS_SQL = `
  select wi.id as work_item_id, wi.item_number, wi.description, wi.unit_code,
         wi.payment_category,
         coalesce(wi.effective_unit_rate, wi.effective_rate)::text as effective_rate,
         delta_supplied.total::text as delta_supplied,
         delta_installed.total::text as delta_installed,
         delta_pac.total::text as delta_pac,
         prior.supplied::text as prior_supplied,
         prior.installed::text as prior_installed,
         prior.pac::text as prior_pac,
         prior.final_bill::text as prior_final_bill,
         delivered.total::text as cumulative_delivered,
         installed.total::text as cumulative_installed,
         coalesce(wi.effective_quantity, wi.awarded_quantity)::text
           as sanctioned_quantity
  from work_items wi
  cross join lateral (
    select coalesce(sum(dci.quantity), 0)::numeric(18,3) as total
    from mb_sources ms
    join delivery_challans dc on dc.id = ms.source_id and dc.status = 'issued'
    join delivery_challan_items dci on dci.delivery_challan_id = ms.source_id
    where ms.measurement_book_id = $2
      and ms.source_type = 'delivery_challan'
      and dci.work_item_id = wi.id
  ) delta_supplied
  cross join lateral (
    select coalesce(sum(i.quantity), 0)::numeric(18,3) as total
    from mb_sources ms
    join installations i on i.id = ms.source_id and i.status = 'recorded'
    where ms.measurement_book_id = $2
      and ms.source_type = 'installation'
      and i.work_item_id = wi.id
  ) delta_installed
  cross join lateral (
    select coalesce(sum(pci.certified_quantity), 0)::numeric(18,3) as total
    from mb_sources ms
    join pac_certificates pc on pc.id = ms.source_id and pc.status = 'recorded'
    join pac_certificate_items pci on pci.pac_certificate_id = ms.source_id
    where ms.measurement_book_id = $2
      and ms.source_type = 'pac_certificate'
      and pci.work_item_id = wi.id
  ) delta_pac
  cross join lateral (
    select coalesce(sum(l.delta_supplied), 0)::numeric(18,3) as supplied,
           coalesce(sum(l.delta_installed), 0)::numeric(18,3) as installed,
           coalesce(sum(l.delta_pac), 0)::numeric(18,3) as pac,
           coalesce(sum(l.delta_final_bill), 0)::numeric(18,3) as final_bill
    from measurement_book_lines l
    join measurement_books pmb on pmb.id = l.measurement_book_id
    where l.work_item_id = wi.id
      and pmb.status = 'finalized'
      and pmb.id <> $2
  ) prior
  cross join lateral (
    select coalesce(sum(dci.quantity), 0)::numeric(18,3) as total
    from delivery_challan_items dci
    join delivery_challans dc on dc.id = dci.delivery_challan_id
    where dci.work_item_id = wi.id and dc.status = 'issued'
  ) delivered
  cross join lateral (
    select coalesce(sum(i.quantity), 0)::numeric(18,3) as total
    from installations i
    where i.work_item_id = wi.id and i.status = 'recorded'
  ) installed
  where wi.work_id = $1 and wi.deleted_at is null
  order by wi.item_number
`;

/** The retired dashboard progress statement: a correlated lateral per
 * Work over the whole challan-line table. `$1` is the full-scope flag,
 * `$2` the user. */
const RETIRED_DASHBOARD_PROGRESS_SQL = `
  select
    w.id as work_id,
    w.work_code,
    w.title,
    w.status,
    w.contract_value::text as contract_value,
    coalesce(delivered.total, 0)::numeric(18,2)::text as delivered_value,
    coalesce(billed.total, 0)::numeric(18,2)::text as billed_value,
    w.gst_basis,
    w.gst_rate::text as gst_rate,
    coalesce(delivered.challans, 0)::text as issued_challans
  from works w
  left join lateral (
    select
      sum(i.line_amount) as total,
      count(distinct c.id) as challans
    from delivery_challans c
    join delivery_challan_items i on i.delivery_challan_id = c.id
    where c.work_id = w.id and c.status = 'issued'
  ) delivered on true
  left join lateral (
    select sum(b.total_amount) as total
    from bills b
    where b.work_id = w.id
  ) billed on true
  where w.deleted_at is null
    and ($1::boolean or exists (
      select 1 from work_assignments wa
      where wa.work_id = w.id and wa.user_id = $2
    ))
  order by w.created_at desc
`;

/** The retired PBG statement, with its per-Work lateral. */
const RETIRED_DASHBOARD_PBG_SQL = `
  select
    w.id as work_id,
    w.work_code,
    w.pbg_required_amount::text as required_amount,
    (w.letter_date + w.pbg_submission_days)::text as normal_due,
    (w.letter_date + w.pbg_submission_days
      + coalesce(w.pbg_extension_days, 0))::text as extended_due,
    ((w.letter_date + w.pbg_submission_days) - current_date)::text
      as days_to_normal,
    ((w.letter_date + w.pbg_submission_days
      + coalesce(w.pbg_extension_days, 0)) - current_date)::text
      as days_to_extended,
    coalesce(active.count, 0)::text as active_count,
    coalesce(active.total, 0)::numeric(18,2)::text as active_amount,
    (coalesce(active.total, 0) < w.pbg_required_amount) as under_required
  from works w
  left join lateral (
    select count(*) as count, sum(wi.amount) as total
    from work_instruments wi
    where wi.work_id = w.id and wi.kind = 'pbg' and wi.status = 'active'
  ) active on true
  where w.deleted_at is null
    and w.pbg_required_amount is not null
    and ($1::boolean or exists (
      select 1 from work_assignments wa
      where wa.work_id = w.id and wa.user_id = $2
    ))
  order by w.created_at desc
`;

/**
 * The tables both measured statements read. Named rather than swept so the
 * ANALYZE stays proportional to what is being measured.
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

/** Counts the statements a helper issues, without touching production
 * code: postgres.js transactions are callable tagged-template objects, so
 * an apply trap sees every query and a get trap wraps `unsafe`. */
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
const ITEMS = 40;
/** Committed buffer ceilings, measured 2026-08-13 on PostgreSQL 18 with
 * the fixture below: the Measurement Book loader reads 5,820 shared
 * blocks where the retired six-lateral shape read 59,084, and the
 * dashboard reads 470. The ceilings carry roughly 3x headroom for
 * planner and version differences.
 *
 * Note the honest asymmetry: at FIXTURE scale the dashboard's grouped
 * shape reads a few hundred blocks more than the laterals did (470
 * against 303), because one pass over a small table costs more than
 * four index descents into it. Its win is the per-Work re-execution the
 * loop assertion measures, which is what turns into seconds once a
 * tenant has hundreds of Works and hundreds of thousands of challan
 * lines. The ceiling is therefore a ratchet against future growth, not
 * a claim of fewer blocks today. */
const MB_BLOCK_CEILING = 18_000;
const DASHBOARD_BLOCK_CEILING = 1_500;
const CHALLANS = 3;
const SIBLING_WORKS = 3;

let admin: Sql;
let appPool: Sql;
let fixture: AggregateFixture;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'p11-query-admin',
  });
  await runMigrations(admin, migrationsDirectory);
  await ensureClusterRoles(admin, appPassword);
  appPool = createDatabasePool({
    url: appUrl,
    max: 4,
    applicationName: 'p11-query-app',
  });
  fixture = await seedAggregateFixture(admin, {
    items: ITEMS,
    challans: CHALLANS,
    siblingWorks: SIBLING_WORKS,
    label: runId,
  });
  // Statistics the planner can act on; without them a fresh fixture is
  // planned from defaults and the plan shape says nothing.
  await admin.unsafe('analyze');
}, 180_000);

afterAll(async () => {
  await removeOrganisationResidue(admin, [fixture.organisationId]);
  await appPool.end();
  await admin.end();
});

describe('the Measurement Book loader is one grouped statement', () => {
  it('returns exactly what the retired six-lateral statement returned', async () => {
    const { retired, current } = await withTenant(
      appPool,
      { organisationId: fixture.organisationId, userId: fixture.userId },
      async (tx) => ({
        retired: (await tx.unsafe(RETIRED_ITEM_INPUTS_SQL, [
          fixture.workId,
          fixture.bookId,
        ])) as unknown as Record<string, unknown>[],
        current: (await tx.unsafe(ITEM_INPUTS_SQL, [
          fixture.workId,
          fixture.bookId,
        ])) as unknown as Record<string, unknown>[],
      }),
    );
    expect(retired).toHaveLength(ITEMS);
    // Byte-identical, JSON-encoded: same rows, same order, same columns,
    // same decimal text in every money and quantity field.
    expect(JSON.stringify(current)).toBe(JSON.stringify(retired));
    // And the figures are the ones the fixture implies, so the pair
    // agreeing is not two identical mistakes: 3 challans x 3.000 each.
    expect(current[0]).toMatchObject({
      delta_supplied: '9.000',
      delta_installed: '2.000',
      delta_pac: '1.000',
      prior_supplied: '1.000',
      cumulative_delivered: '9.000',
      cumulative_installed: '2.000',
    });
  });

  it('issues one statement, whatever the Work holds', async () => {
    const statements = await withTenant(
      appPool,
      { organisationId: fixture.organisationId, userId: fixture.userId },
      async (tx) => {
        const { counted, statements: seen } = countingTransaction(tx);
        const inputs = await loadItemInputs(counted, fixture.workId, fixture.bookId);
        expect(inputs).toHaveLength(ITEMS);
        return seen;
      },
    );
    expect(statements).toHaveLength(1);
  });

  it('executes every aggregate once, not once per item', async () => {
    // Statistics refreshed immediately before measuring, not only after
    // seeding.
    //
    // Both statements below are always planned from ONE snapshot of the
    // statistics, so they never see different pictures of the tables as
    // each other. What they can see is a picture that has gone stale:
    // this suite shares its database with every other integration file
    // and vitest runs those in parallel, so sibling suites insert and
    // delete Works and Measurement Books throughout this one's lifetime.
    // Planned from `beforeAll`'s snapshot, the retired statement can pick
    // a cheaper plan than it would on the tables as they now are — which
    // moves the measured ratio without anything about either statement
    // changing. Fresh statistics for both plans is the fix.
    //
    // Scoped to the fixture's own tables rather than a database-wide
    // ANALYZE: this runs twice per suite on a database several parallel
    // workers are writing to, and a whole-database pass there is lock
    // churn nobody asked for.
    await analyzeFixtureTables();
    const { current, retired } = await withTenant(
      appPool,
      { organisationId: fixture.organisationId, userId: fixture.userId },
      async (tx) => ({
        current: await explain(tx, ITEM_INPUTS_SQL, [fixture.workId, fixture.bookId]),
        retired: await explain(tx, RETIRED_ITEM_INPUTS_SQL, [
          fixture.workId,
          fixture.bookId,
        ]),
      }),
    );
    // THE structural assertion. Each stage is aggregated once for the
    // whole Work; the retired laterals re-ran every aggregate per work
    // item, so on this fixture their aggregate nodes report 40 loops.
    expect(aggregateLoops(current)).toBe(1);
    expect(aggregateLoops(retired)).toBe(fixture.itemCount);

    // Buffer ceiling. There used to be a relative ratchet here too —
    // `sharedBlocks(current) * K < sharedBlocks(retired)` — and its
    // history is the argument for its absence, so it stays told.
    //
    // The multiplier started at 4x. Pack P17 (migration 0069) moved it
    // to 2x: before 0069 every RLS policy called the SECURITY DEFINER
    // membership helper in bare filter position, so the executor ran it
    // per candidate row. The retired six-lateral shape re-scans per work
    // item, so it paid that per-row cost N times over while the grouped
    // shape paid it once — which flattered the gap the 4x was measuring.
    // 0069 evaluates the helper once per statement in BOTH shapes, the
    // measured ratio fell to a data-dependent ~3x (2026-08-14,
    // PostgreSQL 18.4: current 3,448-4,387 vs retired 13,426-15,782),
    // and 4x "fails on a loaded database" became the recorded reason for
    // 2x.
    //
    // Then 2x failed the same way: 2026-08-18, a loaded CI runner
    // measured 1.89x on a change that does not touch this loader (run
    // 32119786980's verify, PR #130). A threshold that has to chase
    // machine load downward is not measuring the regression it was
    // written to refuse — a grouped statement that quietly became the
    // retired one re-runs its aggregates per item and reads the SAME
    // buffers, and both of those are caught above, structurally, by the
    // loop-count assertions, which do not vary with load at all.
    //
    // What the ratio could catch that structure cannot — the grouped
    // shape staying grouped but becoming absolutely expensive — is the
    // committed ceiling's job, and that stays.
    expect(sharedBlocks(current)).toBeLessThan(MB_BLOCK_CEILING);
  });
});

describe('the dashboard pre-aggregates its evidence', () => {
  it('returns exactly what the retired lateral statements returned', async () => {
    const results = await withTenant(
      appPool,
      { organisationId: fixture.organisationId, userId: fixture.userId },
      async (tx) => ({
        retiredProgress: (await tx.unsafe(RETIRED_DASHBOARD_PROGRESS_SQL, [
          true,
          fixture.userId,
        ])) as unknown as Record<string, unknown>[],
        currentProgress: (await tx.unsafe(DASHBOARD_PROGRESS_SQL, [
          true,
          fixture.userId,
        ])) as unknown as Record<string, unknown>[],
        retiredPbg: (await tx.unsafe(RETIRED_DASHBOARD_PBG_SQL, [
          true,
          fixture.userId,
        ])) as unknown as Record<string, unknown>[],
        currentPbg: (await tx.unsafe(DASHBOARD_PBG_SQL, [
          true,
          fixture.userId,
        ])) as unknown as Record<string, unknown>[],
      }),
    );
    expect(results.retiredProgress).toHaveLength(fixture.workCount);
    expect(JSON.stringify(results.currentProgress)).toBe(
      JSON.stringify(results.retiredProgress),
    );
    expect(results.retiredPbg).toHaveLength(1);
    expect(JSON.stringify(results.currentPbg)).toBe(JSON.stringify(results.retiredPbg));
    // 40 items x 3 challans x 3.000 x 250.500000 = 90,180.00 delivered.
    const measured = results.currentProgress.find(
      (row) => row.work_id === fixture.workId,
    );
    expect(measured).toMatchObject({
      delivered_value: '90180.00',
      billed_value: '125250.00',
      issued_challans: '3',
    });
    expect(results.currentPbg[0]).toMatchObject({
      required_amount: '450000.00',
      active_count: '1',
      active_amount: '400000.00',
      under_required: true,
    });
  });

  it('scans the challan lines once, not once per Work', async () => {
    // Statistics refreshed immediately before measuring, not only after
    // seeding.
    //
    // Both statements below are always planned from ONE snapshot of the
    // statistics, so they never see different pictures of the tables as
    // each other. What they can see is a picture that has gone stale:
    // this suite shares its database with every other integration file
    // and vitest runs those in parallel, so sibling suites insert and
    // delete Works and Measurement Books throughout this one's lifetime.
    // Planned from `beforeAll`'s snapshot, the retired statement can pick
    // a cheaper plan than it would on the tables as they now are — which
    // moves the measured ratio without anything about either statement
    // changing. Fresh statistics for both plans is the fix.
    //
    // Scoped to the fixture's own tables rather than a database-wide
    // ANALYZE: this runs twice per suite on a database several parallel
    // workers are writing to, and a whole-database pass there is lock
    // churn nobody asked for.
    await analyzeFixtureTables();
    const { current, retired } = await withTenant(
      appPool,
      { organisationId: fixture.organisationId, userId: fixture.userId },
      async (tx) => ({
        current: await explain(tx, DASHBOARD_PROGRESS_SQL, [true, fixture.userId]),
        retired: await explain(tx, RETIRED_DASHBOARD_PROGRESS_SQL, [
          true,
          fixture.userId,
        ]),
      }),
    );
    // The delivered and billed sums are grouped once over the visible
    // Works; the retired laterals re-ran both per Work.
    expect(aggregateLoops(current)).toBe(1);
    expect(aggregateLoops(retired)).toBe(fixture.workCount);
    expect(sharedBlocks(current)).toBeLessThan(DASHBOARD_BLOCK_CEILING);
  });

  it('the assigned-scope path answers with the same shape', async () => {
    const rows = await withTenant(
      appPool,
      { organisationId: fixture.organisationId, userId: fixture.userId },
      async (tx) =>
        (await tx.unsafe(DASHBOARD_PROGRESS_SQL, [
          false,
          fixture.userId,
        ])) as unknown as Record<string, unknown>[],
    );
    // No assignment rows exist for this user, so an 'assigned' member
    // sees nothing — the visibility rule is unchanged by the rewrite.
    expect(rows).toHaveLength(0);
  });
});
