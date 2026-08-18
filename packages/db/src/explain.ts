import type { TransactionSql } from 'postgres';

/**
 * Test-only EXPLAIN plumbing, shared by every suite that asserts on a
 * query PLAN rather than on its result.
 *
 * There were three drifted copies of this before it moved here — two in
 * `apps/server/test` (the P11 scale budgets and aggregate shapes) and one
 * in `packages/db/test` (the P17 RLS plan-shape guards) — each declaring
 * the subset of plan fields it happened to read. A plan-shape assertion is
 * only as good as its field names, and a fourth copy that mistyped one
 * would silently assert nothing, so the field declarations are merged here
 * and there is one parser.
 *
 * It lives in `src` rather than a test directory because the consumers sit
 * in two different workspace packages. It is published on the
 * `@auto-mb/db/explain` subpath rather than the main barrel, so importing
 * `@auto-mb/db` from production code cannot pull it in (see `testing.ts`,
 * which is published the same way for the same reason).
 */

/** The subset of PostgreSQL's `EXPLAIN (FORMAT JSON)` node that this
 * repository's assertions read. Extends `Record<string, unknown>` so a
 * suite can reach a field nobody has needed yet without editing this
 * file first. */
export interface PlanNode extends Record<string, unknown> {
  'Node Type': string;
  'Subplan Name'?: string;
  'Parent Relationship'?: string;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Filter?: string;
  'Index Cond'?: string;
  'Recheck Cond'?: string;
  Plans?: PlanNode[];
}

/** The plan flattened depth-first, so assertions can ask about the whole
 * tree instead of walking it. */
function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

interface ExplainOptions {
  /** Run the statement and report actual rows, loops and timings. Required
   * for anything that reads `Actual Loops` or a duration; omit it when the
   * assertion only needs the SHAPE the planner chose, so the statement is
   * planned and not executed. */
  readonly analyze?: boolean;
  /** Report buffer accesses. Only worth paying for when something actually
   * asserts on `sharedBlocks`. */
  readonly buffers?: boolean;
}

/**
 * Runs EXPLAIN over `sql` and returns its plan, flattened.
 *
 * `sql` and `parameters` are the caller's own statement, never user input:
 * every caller passes a constant exported by the module under test.
 */
export async function explainPlan(
  tx: TransactionSql,
  sql: string,
  parameters: readonly unknown[] = [],
  options: ExplainOptions = {},
): Promise<PlanNode[]> {
  const flags = ['format json'];
  if (options.analyze === true) flags.unshift('analyze');
  if (options.buffers === true) flags.splice(flags.length - 1, 0, 'buffers');
  const rows = (await tx.unsafe(`explain (${flags.join(', ')}) ${sql}`, [
    ...parameters,
  ] as never)) as unknown as { 'QUERY PLAN': unknown }[];
  const raw = rows[0]?.['QUERY PLAN'];
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
    Plan: PlanNode;
  }[];
  const root = parsed[0]?.Plan;
  if (!root) throw new Error('EXPLAIN returned no plan');
  return planNodes(root);
}

/** The highest execution count of any aggregate node: 1 when the plan
 * aggregates once for the whole statement, N when it re-runs per row.
 * Throws rather than returning a default if the plan has no aggregate at
 * all, because that means the assertion is measuring nothing. */
export function aggregateLoops(nodes: readonly PlanNode[]): number {
  const aggregates = nodes.filter((node) => node['Node Type'].includes('Aggregate'));
  if (aggregates.length === 0) throw new Error('plan has no aggregate node');
  return Math.max(...aggregates.map((node) => node['Actual Loops'] ?? 1));
}

/** Total shared buffer accesses across the plan. Requires `buffers`. */
export function sharedBlocks(nodes: readonly PlanNode[]): number {
  return nodes.reduce(
    (total, node) =>
      total + (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0),
    0,
  );
}

/** The InitPlan nodes: uncorrelated subqueries the executor evaluates once
 * per statement and reuses as a parameter. */
export function initPlanNodes(nodes: readonly PlanNode[]): PlanNode[] {
  return nodes.filter((node) => (node['Subplan Name'] ?? '').startsWith('InitPlan'));
}

/** Every scan-level predicate string in the plan, joined. If a function is
 * named in here, the executor calls it against candidate rows. */
export function predicateText(nodes: readonly PlanNode[]): string {
  return nodes
    .flatMap((node) => [node.Filter, node['Index Cond'], node['Recheck Cond']])
    .filter((text): text is string => typeof text === 'string')
    .join(' | ');
}
