import type { Sql } from 'postgres';

/**
 * Test-only tenant cleanup and referential-integrity census.
 *
 * Integration suites seed organisations in the shared database and must
 * remove every row they created. Historically each suite kept its own
 * hand-maintained table list and deleted it under
 * `session_replication_role = 'replica'` (required, because the issued-
 * document immutability triggers rightly refuse ordinary deletes). Those
 * lists went stale whenever a migration added a tenant table, and with FK
 * enforcement disabled the stale lists silently stranded orphaned child
 * rows — which later broke `pg_dump`/`pg_restore` of the shared database
 * depending on suite order.
 *
 * `removeOrganisationResidue` replaces the hand lists: it discovers every
 * tenant-owned table from the catalog at runtime, deletes the full closure
 * inside a single transaction (`set local`, so replica mode can never leak
 * back onto a pooled connection), and then runs a foreign-key census that
 * fails loudly if any orphaned reference exists anywhere in the public
 * schema.
 *
 * Published on the `@auto-mb/db/testing` subpath rather than the main
 * barrel, so importing `@auto-mb/db` from production code cannot pull it
 * in.
 */

/** Quotes an identifier that came from the PostgreSQL catalog. */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Every base table in `public` that carries an `organisation_id` column.
 * Discovered from the catalog so that new tenant tables are cleaned up
 * automatically instead of depending on hand-maintained per-suite lists.
 */
async function listTenantTables(sql: Sql): Promise<string[]> {
  const rows = (await sql`
    select c.table_name as name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'organisation_id'
      and t.table_type = 'BASE TABLE'
    order by c.table_name
  `) as unknown as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * Deletes every row owned by the given organisations, plus the
 * organisation rows themselves, atomically and completely.
 *
 * Runs as one transaction with `set local session_replication_role =
 * 'replica'`: the immutability triggers that (rightly) block ordinary
 * deletes of issued documents are bypassed for fixture cleanup only, the
 * setting reverts at commit, and concurrent suites can never observe a
 * half-deleted tenant. Finishes with a whole-database foreign-key census
 * so a cleanup that would strand orphans fails the suite that caused it.
 *
 * Requires the admin/owner pool (the setting needs superuser).
 */
export async function removeOrganisationResidue(
  sql: Sql,
  organisationIds: readonly (string | undefined)[],
): Promise<void> {
  const ids = organisationIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;
  const tables = await listTenantTables(sql);
  await sql.begin(async (tx) => {
    await tx.unsafe(`set local session_replication_role = 'replica'`);
    for (const table of tables) {
      await tx.unsafe(
        `delete from ${quoteIdentifier(table)} where organisation_id = any($1::uuid[])`,
        [ids],
      );
    }
    await tx.unsafe(`delete from organisations where id = any($1::uuid[])`, [ids]);
  });
  await assertNoForeignKeyOrphans(sql);
}

interface ForeignKeyShape {
  readonly constraint_name: string;
  readonly child_table: string;
  readonly parent_table: string;
  readonly child_columns: string[];
  readonly parent_columns: string[];
}

/**
 * Asserts that no row in the public schema references a missing parent,
 * for every foreign-key constraint that exists. This is exactly the
 * invariant `pg_restore` re-checks when it recreates constraints, so a
 * green census means a dump taken now restores cleanly regardless of
 * which suites ran before.
 *
 * The whole census is a single statement (one snapshot), so it cannot be
 * confused by other suites' concurrent — but atomic — cleanups.
 */
export async function assertNoForeignKeyOrphans(sql: Sql): Promise<void> {
  const foreignKeys = (await sql`
    select
      con.conname as constraint_name,
      child.relname as child_table,
      parent.relname as parent_table,
      (
        select array_agg(a.attname order by k.ord)
        from unnest(con.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a
          on a.attrelid = con.conrelid and a.attnum = k.attnum
      ) as child_columns,
      (
        select array_agg(a.attname order by k.ord)
        from unnest(con.confkey) with ordinality as k(attnum, ord)
        join pg_attribute a
          on a.attrelid = con.confrelid and a.attnum = k.attnum
      ) as parent_columns
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_namespace child_ns on child_ns.oid = child.relnamespace
    join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
    where con.contype = 'f'
      and child_ns.nspname = 'public'
      and parent_ns.nspname = 'public'
      and child.relkind in ('r', 'p')
    order by con.conname
  `) as unknown as ForeignKeyShape[];
  if (foreignKeys.length === 0) return;

  const branches = foreignKeys.map((fk) => {
    // MATCH SIMPLE: the constraint only binds rows where every referencing
    // column is non-null, so the census skips partially-null keys too.
    const allSet = fk.child_columns
      .map((column) => `c.${quoteIdentifier(column)} is not null`)
      .join(' and ');
    const joined = fk.child_columns
      .map(
        (column, index) =>
          `c.${quoteIdentifier(column)} = p.${quoteIdentifier(fk.parent_columns[index] ?? '')}`,
      )
      .join(' and ');
    return `select '${fk.constraint_name.replaceAll("'", "''")}'::text as constraint_name,
      '${fk.child_table.replaceAll("'", "''")}'::text as child_table,
      count(*)::bigint as orphans
      from ${quoteIdentifier(fk.child_table)} c
      where ${allSet}
        and not exists (
          select 1 from ${quoteIdentifier(fk.parent_table)} p where ${joined}
        )`;
  });
  const rows = (await sql.unsafe(branches.join('\nunion all\n'))) as unknown as {
    constraint_name: string;
    child_table: string;
    orphans: string | number;
  }[];
  const violations = rows.filter((row) => Number(row.orphans) > 0);
  if (violations.length > 0) {
    const detail = violations
      .map(
        (row) =>
          `${row.child_table} has ${String(row.orphans)} row(s) violating ${row.constraint_name}`,
      )
      .join('; ');
    throw new Error(
      `foreign-key census found orphaned rows (a cleanup deleted parents without their children; ` +
        `a pg_dump taken now would not restore): ${detail}`,
    );
  }
}
