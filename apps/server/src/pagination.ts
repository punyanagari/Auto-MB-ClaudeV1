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
 */
export async function cursorRowId(
  tx: TransactionSql,
  table: string,
  cursor: string | undefined,
): Promise<string | null> {
  if (cursor === undefined) return null;
  const [row] = await tx<{ id: string }[]>`
    select id from ${tx.unsafe(table)} where id = ${cursor}
  `;
  if (!row) {
    throw httpError(
      400,
      'CURSOR_INVALID',
      'The pagination cursor does not name a row in this register.',
    );
  }
  return row.id;
}
