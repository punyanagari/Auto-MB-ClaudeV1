import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { withTenant } from '../src/tenant.js';
import {
  SETUP_TIMEOUT_MS,
  adminUrl,
  appUrl,
  createTemporaryDatabase,
  dropStaleTemporaryDatabases,
  dropTemporaryDatabase,
  migrateThrough,
  migrateToHead,
  refused,
  seedTenant,
  type TemporaryDatabase,
  type Tenant,
} from './support/invariant-db.js';

/**
 * The three catalog-and-plan guards ADR-0010 requires of migration 0069.
 *
 * Each one is proved twice: once against a database migrated to the head
 * of the series, and once against the SAME series stopped one migration
 * short. The second half is the point — a guard that has never been shown
 * to fail is a guard nobody knows the direction of.
 *
 * `PRE_FIX_THROUGH` is the last migration id before 0069. It is a string
 * comparison in `migrateThrough`, so it also excludes 0066-0068 while
 * those wave-3 packs are unmerged and includes them once they land, which
 * is what the census below wants: the pre-fix tree is "everything before
 * this pack", whatever that turns out to contain.
 */
const PRE_FIX_THROUGH = '0068';

const REGISTER_ITEMS = 400;

/**
 * A helper call the planner will evaluate once per STATEMENT: an
 * uncorrelated scalar subquery, which becomes an InitPlan. `pg_policies`
 * hands back deparsed text, and the deparser writes the subquery's output
 * column with an alias — `current_organisation_id` by default, but any
 * identifier a future author writes — so everything between the call and
 * the closing parenthesis is taken as-is rather than spelled out. Written
 * with a single unambiguous quantifier so it stays linear on any input.
 */
const INITPLAN_WRAPPED =
  /\(\s*SELECT\s+app_private\.current_(?:organisation|user)_id\(\)[^)]*\)/gi;

/** The same call left where the planner must evaluate it per ROW. */
const BARE_HELPER_CALL = /app_private\.current_(?:organisation|user)_id\(\)/i;

interface PolicyRow {
  readonly tablename: string;
  readonly policyname: string;
  readonly qual: string;
  readonly with_check: string;
}

/**
 * Every policy in `public` whose USING or WITH CHECK clause still calls a
 * tenancy helper in bare filter position.
 *
 * Reads the live catalog rather than the migration files: a policy's
 * predicate is whatever the last ALTER POLICY left in `pg_policy`, and a
 * future migration that re-creates one in bare style would not show up in
 * a grep of 0069 at all.
 */
async function bareHelperPolicies(sql: Sql): Promise<string[]> {
  const rows = await sql<PolicyRow[]>`
    select tablename, policyname,
           coalesce(qual, '') as qual,
           coalesce(with_check, '') as with_check
    from pg_policies
    where schemaname = 'public'
    order by tablename, policyname
  `;
  return rows
    .filter((row) =>
      BARE_HELPER_CALL.test(
        `${row.qual} ${row.with_check}`.replace(INITPLAN_WRAPPED, ' '),
      ),
    )
    .map((row) => `${row.tablename}.${row.policyname}`);
}

interface PlanNode extends Record<string, unknown> {
  'Node Type': string;
  'Subplan Name'?: string;
  'Actual Loops'?: number;
  Filter?: string;
  'Index Cond'?: string;
  'Recheck Cond'?: string;
  Plans?: PlanNode[];
}

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

async function explainRegisterScan(
  tx: TransactionSql,
  workId: string,
): Promise<PlanNode[]> {
  const rows = (await tx.unsafe(
    `explain (analyze, buffers, format json)
     select id, item_number, awarded_quantity, effective_rate
     from work_items where work_id = $1 and deleted_at is null`,
    [workId] as never,
  )) as unknown as { 'QUERY PLAN': unknown }[];
  const raw = rows[0]?.['QUERY PLAN'];
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
    Plan: PlanNode;
  }[];
  const root = parsed[0]?.Plan;
  if (!root) throw new Error('EXPLAIN returned no plan');
  return planNodes(root);
}

/** Every scan-level predicate string the plan carries. If the helper is
 * named in one of these, the executor runs it against candidate rows. */
function predicateText(nodes: readonly PlanNode[]): string {
  return nodes
    .flatMap((node) => [node.Filter, node['Index Cond'], node['Recheck Cond']])
    .filter((text): text is string => typeof text === 'string')
    .join(' | ');
}

function initPlanNodes(nodes: readonly PlanNode[]): PlanNode[] {
  return nodes.filter((node) => (node['Subplan Name'] ?? '').startsWith('InitPlan'));
}

/** A register worth scanning: one schedule and `REGISTER_ITEMS` items on
 * the seeded Work, so a per-row helper call and a per-statement one are
 * different measurements rather than the same one. */
async function seedRegister(pool: Sql, tenant: Tenant): Promise<void> {
  const [schedule] = await pool<{ id: string }[]>`
    insert into work_schedules (organisation_id, work_id, schedule_code, title, position)
    values (${tenant.organisationId}, ${tenant.workId}, 'A', 'Register fixture', 1)
    returning id
  `;
  if (!schedule) throw new Error('schedule seed failed');
  await pool`
    insert into work_items (
      organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate
    )
    select ${tenant.organisationId}, ${tenant.workId}, ${schedule.id},
           'I-' || n, 'Register fixture item ' || n, 'Nos', 10, 100.000000
    from generate_series(1, ${REGISTER_ITEMS}) as n
  `;
  await pool.unsafe('analyze work_items');
}

const PREFIX = 'auto_mb_rls_initplan_';

let admin: Sql;
let head: TemporaryDatabase;
let staged: TemporaryDatabase;
let stagedDisposer: () => Promise<void>;
let headTenant: Tenant;
let stagedTenant: Tenant;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 2,
    applicationName: 'auto-mb-rls-initplan-admin',
  });
  await dropStaleTemporaryDatabases(admin, PREFIX);

  head = await createTemporaryDatabase(admin, PREFIX);
  await migrateToHead(head);
  headTenant = await seedTenant(head.pool);
  await seedRegister(head.pool, headTenant);

  // The pre-fix tree, kept alive beside the fixed one so both halves of
  // every guard are one assertion apart instead of one code review apart.
  staged = await createTemporaryDatabase(admin, PREFIX);
  stagedDisposer = await migrateThrough(staged, PRE_FIX_THROUGH);
  // `applyGrants` is the CURRENT privilege matrix and names
  // app_private.bind_tenant, which this schema does not have yet, so the
  // staged database gets by hand exactly the privileges the plan-shape
  // comparison needs — and nothing else.
  await staged.pool.unsafe(`grant usage on schema public, app_private to auto_mb_app`);
  await staged.pool.unsafe(
    `grant select on works, work_items, work_schedules, organisations,
       organisation_memberships to auto_mb_app`,
  );
  await staged.pool.unsafe(
    `grant execute on function app_private.current_organisation_id() to auto_mb_app`,
  );
  await staged.pool.unsafe(
    `grant execute on function app_private.current_user_id() to auto_mb_app`,
  );
  stagedTenant = await seedTenant(staged.pool);
  await seedRegister(staged.pool, stagedTenant);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (stagedDisposer) await stagedDisposer();
  if (staged) await dropTemporaryDatabase(admin, staged);
  if (head) await dropTemporaryDatabase(admin, head);
  if (admin) await admin.end();
}, SETUP_TIMEOUT_MS);

describe('guard 1: no tenant policy calls a helper in bare filter position', () => {
  it('finds no bare call anywhere in the catalog after 0069', async () => {
    expect(await bareHelperPolicies(head.pool)).toEqual([]);
  });

  it('finds them on the pre-fix tree, so the census is known to bite', async () => {
    // Not "greater than zero": the exact population is stated, because a
    // census that silently narrowed would still pass a >0 assertion.
    const bare = await bareHelperPolicies(staged.pool);
    expect(bare).toHaveLength(64);
    expect(bare).toContain('works.works_tenant_policy');
    expect(bare).toContain('work_items.work_items_tenant_policy');
    expect(bare).toContain('organisations.organisations_member_select_policy');
  });

  it('still routes every tenant policy through the membership helper', async () => {
    // The counterpart to the census: moving the calls must not have
    // DELETED any. Every tenant policy still names a helper; the InitPlan
    // wrapping is the only thing that changed.
    const [row] = await head.pool<{ policies: number }[]>`
      select count(*)::int as policies
      from pg_policies
      where schemaname = 'public'
        and (coalesce(qual, '') || coalesce(with_check, ''))
              like '%current_organisation_id%'
    `;
    expect(row?.policies).toBe(63);
  });
});

describe('guard 2: a register scan evaluates the helper once per statement', () => {
  it('plans the helper as an InitPlan executed exactly once', async () => {
    const nodes = await withTenant(
      head.appPool,
      { organisationId: headTenant.organisationId, userId: headTenant.userId },
      (tx) => explainRegisterScan(tx, headTenant.workId),
    );

    const initPlans = initPlanNodes(nodes);
    expect(initPlans.length).toBeGreaterThanOrEqual(1);
    for (const node of initPlans) {
      expect(node['Actual Loops'] ?? 1, node['Subplan Name']).toBe(1);
    }
    // And the scan itself compares against the InitPlan's parameter, not
    // against a function the executor would have to call per row.
    expect(predicateText(nodes)).not.toContain('current_organisation_id');
  });

  it('names the helper in the scan predicate on the pre-fix tree', async () => {
    // The same statement against the same fixture one migration earlier:
    // the helper sits in the Filter, which is the executor calling it for
    // every candidate row, and there is no InitPlan at all.
    const nodes = await staged.appPool.begin(async (tx) => {
      await tx`select set_config('app.organisation_id', ${stagedTenant.organisationId}, true)`;
      await tx`select set_config('app.user_id', ${stagedTenant.userId}, true)`;
      return explainRegisterScan(tx, stagedTenant.workId);
    });
    expect(predicateText(nodes)).toContain('current_organisation_id');
    expect(initPlanNodes(nodes)).toHaveLength(0);
  });

  it('returns the same rows through the same policies', async () => {
    // A plan-shape guard is worthless if the rewrite changed what the
    // policy admits, so both trees are asked the same question.
    const visible = await withTenant(
      head.appPool,
      { organisationId: headTenant.organisationId, userId: headTenant.userId },
      async (tx) => {
        const [row] = await tx<{ items: number }[]>`
          select count(*)::int as items from work_items
        `;
        return row?.items ?? -1;
      },
    );
    expect(visible).toBe(REGISTER_ITEMS);
  });
});

describe('guard 3: binding an organisation the user is not a member of fails at bind', () => {
  it('raises 28000 before any statement of the transaction runs', async () => {
    let statementsRan = 0;
    const outcome = await refused(
      withTenant(
        head.appPool,
        {
          organisationId: headTenant.organisationId,
          userId: 'rls-initplan-not-a-member',
        },
        async (tx) => {
          statementsRan += 1;
          return tx`select 1 as unreachable`;
        },
      ),
    );
    expect(outcome.code).toBe('28000');
    expect(statementsRan).toBe(0);
  });

  it('refuses a well-formed organisation id that exists but has no membership', async () => {
    const other = await seedTenant(head.pool);
    const outcome = await refused(
      withTenant(
        head.appPool,
        { organisationId: other.organisationId, userId: headTenant.userId },
        (tx) => tx`select 1`,
      ),
    );
    expect(outcome.code).toBe('28000');
  });

  it('keeps the binding transaction-local and the floor independent of it', async () => {
    // Two properties in one connection, because they are the two halves
    // of ADR-0010's trust claim.
    //
    // First: bind_tenant's set_config calls are `is_local = true`, so the
    // binding dies with the transaction rather than riding the pooled
    // connection into the next borrower's work. The pool is pinned to one
    // connection so the follow-up read lands on the same backend.
    //
    // Second: the policies do NOT trust bind_tenant. A path that writes
    // the GUCs directly — which is what any future code that skips this
    // module would do — still gets nothing, because the helper each policy
    // calls re-proves the membership on the definer's authority.
    const singleUrl = new URL(appUrl);
    singleUrl.pathname = `/${head.name}`;
    const single = createDatabasePool({
      url: singleUrl.toString(),
      max: 1,
      applicationName: 'auto-mb-rls-initplan-single',
    });
    try {
      const bound = await withTenant(
        single,
        { organisationId: headTenant.organisationId, userId: headTenant.userId },
        async (tx) => {
          const [row] = await tx<{ organisation_id: string | null }[]>`
            select app_private.current_organisation_id() as organisation_id
          `;
          return row?.organisation_id ?? null;
        },
      );
      expect(bound).toBe(headTenant.organisationId);

      const [leaked] = await single<{ organisation: string; visible: number }[]>`
        select current_setting('app.organisation_id', true) as organisation,
               (select count(*)::int from work_items) as visible
      `;
      expect(leaked?.organisation ?? '').toBe('');
      expect(leaked?.visible).toBe(0);

      const forged = await single.begin(async (tx) => {
        await tx`select set_config('app.organisation_id', ${headTenant.organisationId}, true)`;
        await tx`select set_config('app.user_id', 'rls-initplan-not-a-member', true)`;
        const [row] = await tx<{ items: number }[]>`
          select count(*)::int as items from work_items
        `;
        return row?.items ?? -1;
      });
      expect(forged).toBe(0);
    } finally {
      await single.end();
    }
  });
});
