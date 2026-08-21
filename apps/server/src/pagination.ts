import type { RegisterSort } from '@auto-mb/contracts';
import type { TransactionSql } from '@auto-mb/db';
import { httpError } from './http.js';

/**
 * The server half of the keyset contract declared in
 * `@auto-mb/contracts`'s `pagination.ts`. Two functions, because
 * everything else about a page is the register's own SQL.
 *
 * A paginated list reads `limit + 1` rows and asks {@link keysetPage} to
 * split them: the extra row is how the route knows there is a next page
 * without a second `count(*)` over a table it just seeked into. When
 * `limit` is omitted the route asks for `LIMIT NULL`, which PostgreSQL
 * reads as no limit at all, so the pre-pagination behaviour survives byte
 * for byte.
 *
 * ## The cursor is an id, and its sort key never leaves the database
 *
 * A cursor names the last row of the previous page BY ID, and each route's
 * predicate compares against that row's sort key read back in the same
 * statement:
 *
 *     and (cursorId is null or (a, b, id) > (
 *       select c.a, c.b, c.id from <table> c where c.id = <cursorId>))
 *
 * rather than sending the sort key back as a value. That is not style. The
 * obvious shape — read `created_at::text` out, send it back as
 * `$n::timestamptz` — was built first and measured losing microseconds:
 * a cursor read as `21:50:41.527771+05:30` reached the server as
 * `21:50:41.527+05:30`, because the driver re-encodes a parameter it
 * types as `timestamptz` through a JavaScript Date. Reproduced both
 * inside a route and in an isolated statement; NOT reproduced on every
 * query built that way, which is the point — the loss depends on how the
 * driver resolved that particular parameter's type, so it is a hazard
 * that lies in wait rather than a bug that shows up once.
 *
 * The consequences are asymmetric and both wrong. An ASCENDING register
 * repeats: the truncated cursor sorts before the row it names, so that
 * row comes back again — forever, which is how this was found. A
 * DESCENDING one skips: every row sharing the cursor's millisecond but
 * preceding it is cut away. The second is worse, because nothing about
 * the answer looks wrong.
 *
 * Comparing against a subselect removes the failure mode rather than
 * betting on the driver: the sort key is read and compared entirely
 * inside PostgreSQL, at the precision it stores. It costs one primary-key
 * lookup per page.
 */

/** `LIMIT` value for an over-fetch of one row, or SQL NULL (no limit)
 * when the caller asked for no page. Passed straight into a tagged
 * template: `limit ${sqlLimit(query.limit)}`. */
export function sqlLimit(limit: number | undefined): number | null {
  return limit === undefined ? null : limit + 1;
}

/**
 * The ORDER BY tail and the keyset direction for a register the caller
 * may read either way round (`?sort=date_asc`).
 *
 * The two travel together on purpose. Turning only the ORDER BY round
 * leaves the predicate seeking in the old direction, which does not fail:
 * it silently returns the wrong rows at every page boundary. So the one
 * call answers both, and each register's SQL spends the `ascending` flag
 * on choosing between a `>` and a `<` comparison of the same tuple.
 *
 * `columns` is route source text — a literal array written beside the
 * query — and the only thing the caller decides is which of two fixed
 * suffixes is appended to it. Nothing from the request reaches the
 * statement: `sort` has already been narrowed to one of two literals by
 * the querystring schema, and is compared here rather than interpolated.
 */
export function registerOrder(
  sort: RegisterSort | undefined,
  columns: readonly string[],
): { readonly ascending: boolean; readonly orderBy: string } {
  const ascending = sort === 'date_asc';
  const suffix = ascending ? 'asc' : 'desc';
  return {
    ascending,
    orderBy: columns.map((column) => `${column} ${suffix}`).join(', '),
  };
}

/** Splits an over-fetched result set into the page and the cursor for the
 * next one. `nextCursor` is null when the over-fetch found nothing beyond
 * the page — and always null for an unpaginated request, which received
 * the whole register. */
export function keysetPage<Row>(
  rows: readonly Row[],
  limit: number | undefined,
  idOf: (row: Row) => string,
): { readonly rows: readonly Row[]; readonly nextCursor: string | null } {
  if (limit === undefined) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > limit && last !== undefined ? idOf(last) : null,
  };
}

/**
 * Proves a cursor names a row of the register before it is used as a
 * position in it.
 *
 * Without this the cursor subselect would return no rows, the comparison
 * would be NULL, and a stale or forged cursor would answer an empty page —
 * which reads exactly like "you have reached the end". A cursor the
 * register does not carry is a bad request and says so.
 *
 * `table` is a fixed identifier from this repository's own route code,
 * never request input; the cursor value itself is always parameterised.
 * Tenancy needs no extra predicate: the lookup runs inside the caller's
 * organisation-scoped transaction, so RLS has already narrowed the table.
 *
 * ## A per-Work list must pass its Work
 *
 * RLS proves the cursor belongs to the caller's ORGANISATION, and on a
 * per-Work list that is a weaker question than the one that matters:
 * whether the cursor names a row of THIS register. `assertWorkAccess` has
 * already gated the Work in the path, but a caller can hold access to one
 * Work and pass a row id from another as the cursor. Validated
 * organisation-wide, that cursor answers 200 where a nonexistent id
 * answers 400 — existence disclosed — and the route's keyset predicate
 * then compares against the foreign row's sort key, so a caller who pages
 * with deliberately chosen cursors can binary-search a record they may not
 * list down to its date and creation instant. No row of it ever leaves the
 * database, and its position is recovered anyway.
 *
 * So a per-Work register passes `workId` and the cursor is proven against
 * the SAME predicate its rows are: it must carry this Work's `work_id`. A
 * cursor that fails it is refused exactly as a nonexistent one is — same
 * status, same code, same sentence — which is what makes the two
 * indistinguishable. (A register narrowed by work-scope rather than by one
 * Work proves its cursor with {@link workScopedCursorRowId} instead.)
 */
export async function cursorRowId(
  tx: TransactionSql,
  table: string,
  cursor: string | undefined,
  workId?: string,
): Promise<string | null> {
  if (cursor === undefined) return null;
  const [row] = await tx<{ id: string }[]>`
    select id from ${tx.unsafe(table)} where id = ${cursor}
      and (${workId === undefined} or work_id = ${workId ?? null})
  `;
  if (!row) throw cursorInvalid();
  return row.id;
}

/** The work-scope a cross-Work register filters its rows by, restated for
 * its cursor. */
export interface WorkScope {
  readonly userId: string;
  /** True for a membership that sees every Work of the organisation. */
  readonly full: boolean;
}

/**
 * {@link cursorRowId} for a register whose rows are narrowed by work-scope
 * rather than by tenancy alone.
 *
 * RLS proves the cursor belongs to the caller's ORGANISATION. On a
 * cross-Work register that is not the same question as whether the caller
 * may see the row: an 'assigned'-scoped member reaches only the Works they
 * are assigned to, and the organisation contains records of every other
 * Work as well. Validating such a cursor organisation-wide leaves an
 * oracle. The register would answer 200 for a forbidden row's id and 400
 * for a nonexistent one — existence disclosed — and worse, the keyset
 * predicate then compares against that row's sort key, so a caller who
 * pages with deliberately chosen cursors can binary-search a record they
 * may not read down to its date and creation instant. No row of it ever
 * leaves the database, and its position is recovered anyway.
 *
 * So the cursor is proven against the SAME predicate the register's rows
 * are: it must name a row of a Work the caller may see. A cursor that
 * fails it is refused exactly as a nonexistent one is — same status, same
 * code, same sentence — which is what makes the two indistinguishable.
 * The register's own sort-key subselect then reads a row already proven
 * in scope, so it needs no predicate of its own.
 *
 * `table` is a fixed identifier from this repository's own route code and
 * must carry a `work_id` column; every value is parameterised.
 */
export async function workScopedCursorRowId(
  tx: TransactionSql,
  table: string,
  cursor: string | undefined,
  scope: WorkScope,
): Promise<string | null> {
  if (cursor === undefined) return null;
  const [row] = await tx<{ id: string }[]>`
    select r.id from ${tx.unsafe(table)} r
    where r.id = ${cursor}
      and (${scope.full} or exists (
        select 1 from work_assignments wa
        where wa.work_id = r.work_id and wa.user_id = ${scope.userId}
      ))
  `;
  if (!row) throw cursorInvalid();
  return row.id;
}

function cursorInvalid(): Error {
  return httpError(
    400,
    'CURSOR_INVALID',
    'The pagination cursor does not name a row in this register.',
  );
}
