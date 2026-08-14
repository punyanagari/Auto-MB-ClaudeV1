import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import {
  explainPlan,
  initPlanNodes,
  predicateText,
  type PlanNode,
} from '../src/explain.js';
import { TenantBindRefusedError, withTenant } from '../src/tenant.js';
import {
  SETUP_TIMEOUT_MS,
  adminUrl,
  bindTenantGucsDirectly,
  createTemporaryDatabase,
  dropStaleTemporaryDatabases,
  dropTemporaryDatabase,
  migrateThrough,
  migrateToHead,
  seedTenant,
  type TemporaryDatabase,
  type Tenant,
} from './support/invariant-db.js';

/**
 * The catalog and plan guards ADR-0010 requires of migration 0069.
 *
 * Every one is proved in both directions: against a database migrated to
 * the head of the series, and against the SAME series stopped one
 * migration short. The second half is the point — a guard that has never
 * been shown to fail is a guard nobody knows the direction of.
 *
 * The bind-refusal CONTRACT (which SQLSTATE, which error type, that no
 * statement of the callback runs) lives in `tenancy.integration.test.ts`
 * beside the rest of the membership floor. What is unique to this file,
 * and therefore what it asserts, is the pre/post-fix PAIRING: the binding
 * this tree refuses was accepted in silence one migration earlier.
 *
 * `PRE_FIX_THROUGH` is the last migration id before 0069. It is a string
 * comparison in `migrateThrough`, so it also excludes 0066-0068 while
 * those wave-3 packs are unmerged and includes them once they land — which
 * is what the census wants: the pre-fix tree is "everything before this
 * pack", whatever that turns out to contain. Nothing below hard-codes how
 * many policies that is; both populations are derived from the catalog, so
 * a sibling pack adding tenant tables moves the numbers without touching
 * this file.
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

/** Every policy in `public` whose USING or WITH CHECK clause names a
 * tenancy helper at all, in either position. */
async function helperPolicyRows(sql: Sql): Promise<PolicyRow[]> {
  const rows = await sql<PolicyRow[]>`
    select tablename, policyname,
           coalesce(qual, '') as qual,
           coalesce(with_check, '') as with_check
    from pg_policies
    where schemaname = 'public'
    order by tablename, policyname
  `;
  return rows.filter((row) => BARE_HELPER_CALL.test(`${row.qual} ${row.with_check}`));
}

async function helperPolicies(sql: Sql): Promise<string[]> {
  return (await helperPolicyRows(sql)).map(
    (row) => `${row.tablename}.${row.policyname}`,
  );
}

/**
 * Every policy that still calls a tenancy helper in BARE filter position.
 *
 * Reads the live catalog rather than the migration files: a policy's
 * predicate is whatever the last ALTER POLICY left in `pg_policy`, and a
 * future migration that re-creates one in bare style would not show up in
 * a grep of 0069 at all.
 */
async function bareHelperPolicies(sql: Sql): Promise<string[]> {
  const rows = await helperPolicyRows(sql);
  return rows
    .filter((row) =>
      BARE_HELPER_CALL.test(
        `${row.qual} ${row.with_check}`.replace(INITPLAN_WRAPPED, ' '),
      ),
    )
    .map((row) => `${row.tablename}.${row.policyname}`);
}

/** The register statement both trees are asked to plan. */
const REGISTER_SCAN_SQL = `
  select id, item_number, awarded_quantity, effective_rate
  from work_items where work_id = $1 and deleted_at is null
`;

/**
 * `analyze` is opt-in because only the head assertion reads `Actual
 * Loops`; the pre-fix assertion consumes plan SHAPE alone, and planning a
 * statement is cheaper and far less load-sensitive than running it.
 * Neither side asserts on buffers, so BUFFERS is never requested.
 */
async function explainRegisterScan(
  tx: TransactionSql,
  workId: string,
  options: { readonly analyze?: boolean } = {},
): Promise<PlanNode[]> {
  return explainPlan(tx, REGISTER_SCAN_SQL, [workId], options);
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
  // staged database gets by hand exactly the privileges the comparison
  // needs — and nothing else.
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
    // Derived, not counted: before 0069 every policy that names a helper
    // names it in bare position, so the bare population is the whole
    // helper population MINUS the few authored in the target shape
    // already. Stating it that way keeps the guard honest against a
    // census that silently narrowed — a broken matcher would push
    // policies out of `bare` and into the difference below — while
    // letting a sibling pack add tenant tables without editing a literal.
    //
    // The difference is a real and expected population, not a fudge.
    // ADR-0010 asks new policies to be written wrapped from the start, so
    // a pack landing between the ADR and 0069 arrives already in the
    // target shape and has nothing for 0069 to rewrite. Pack P14's
    // received railway bill (migration 0066) is the first, and naming it
    // is the point: if this list grows without a pack saying so, a policy
    // has changed shape and nobody decided that.
    const bare = await bareHelperPolicies(staged.pool);
    const named = await helperPolicies(staged.pool);
    const alreadyWrapped = named.filter((policy) => !bare.includes(policy));
    expect(alreadyWrapped).toEqual([
      'received_railway_bills.received_railway_bills_tenant_policy',
    ]);
    expect(bare).toEqual(named.filter((policy) => !alreadyWrapped.includes(policy)));
    expect(bare.length).toBeGreaterThan(0);
    expect(bare).toContain('works.works_tenant_policy');
    expect(bare).toContain('work_items.work_items_tenant_policy');
    expect(bare).toContain('organisations.organisations_member_select_policy');
  });

  it('still routes every one of those policies through a helper', async () => {
    // The counterpart to the census: moving the calls must not have
    // DELETED any. Compared as sets against the pre-fix tree, so this
    // measures the rewrite rather than a number somebody typed.
    //
    // Containment rather than equality, because a migration after 0069 may
    // legitimately ADD a tenant table — 0071's `work_supersessions` is the
    // first — and a new policy is held to InitPlan form by the census
    // above, not by this comparison. What this assertion owns is that the
    // rewrite dropped nothing.
    const rewritten = await helperPolicies(head.pool);
    const before = await helperPolicies(staged.pool);
    expect(before.filter((policy) => !rewritten.includes(policy))).toEqual([]);
  });
});

describe('guard 2: a register scan evaluates the helper once per statement', () => {
  it('plans the helper as an InitPlan executed exactly once', async () => {
    const nodes = await withTenant(
      head.appPool,
      { organisationId: headTenant.organisationId, userId: headTenant.userId },
      (tx) => explainRegisterScan(tx, headTenant.workId, { analyze: true }),
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
    // the helper sits in the scan predicate, which is the executor calling
    // it for every candidate row, and there is no InitPlan at all. Plan
    // shape only, so this one is planned and not run.
    const nodes = await bindTenantGucsDirectly(
      staged.appPool,
      stagedTenant.organisationId,
      stagedTenant.userId,
      (tx) => explainRegisterScan(tx, stagedTenant.workId),
    );
    expect(predicateText(nodes)).toContain('current_organisation_id');
    expect(initPlanNodes(nodes)).toHaveLength(0);
  });

  it('returns the same rows through the same policies', async () => {
    // A plan-shape guard is worthless if the rewrite changed what the
    // policy admits, so the register is also read for real.
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

describe('guard 3: the binding this tree refuses was silently accepted before it', () => {
  it('refuses a non-member binding on the fixed tree', async () => {
    // The contract itself — which SQLSTATE, which error type, and that no
    // statement of the callback runs — is asserted in
    // tenancy.integration.test.ts beside the rest of the membership floor.
    // What is proved here is that this tree refuses at all, so it can be
    // set against the pre-fix behaviour below.
    const outcome = await withTenant(
      head.appPool,
      {
        organisationId: headTenant.organisationId,
        userId: 'rls-initplan-not-a-member',
      },
      (tx) => tx`select 1 as unreachable`,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(TenantBindRefusedError);
  });

  it('accepted the same binding in silence one migration earlier', async () => {
    // The failure mode 0069 exists to remove: the bind succeeds, every
    // policy denies, and the caller reads an empty database with no error
    // anywhere. `withTenant` cannot express this any more, which is the
    // improvement; the raw GUC bind still can, which is how the pre-fix
    // behaviour stays visible and comparable.
    const visible = await bindTenantGucsDirectly(
      staged.appPool,
      stagedTenant.organisationId,
      'rls-initplan-not-a-member',
      async (tx) => {
        const [row] = await tx<{ items: number }[]>`
          select count(*)::int as items from work_items
        `;
        return row?.items ?? -1;
      },
    );
    expect(visible).toBe(0);
  });
});
