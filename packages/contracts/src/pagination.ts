import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { UuidSchema } from './primitives.js';

/**
 * Keyset pagination, as the six largest registers answer it.
 *
 * The reconciled review measured about fifty list endpoints that read a
 * whole table and serialised it: a Work with a few thousand delivered
 * serial numbers answered `GET /api/works/:id/serials` with a few thousand
 * fully-joined rows and no cap anywhere in the path. The audit trail had
 * already solved this once — `timeline.ts` has carried `limit` + `cursor`
 * with a `nextCursor` in the response since Milestone 6 — so this module
 * is that shape lifted out of one route and made shareable, not a second
 * design.
 *
 * Keyset, not offset. Offset pages over a register that is being written
 * to skip and repeat rows, which on a challan register means a clerk
 * paging through issued documents can miss one; the cursor names the last
 * row of the previous page, so a row inserted meanwhile changes nothing
 * about what the next page contains. It also does not degrade: `OFFSET
 * 20000` reads twenty thousand rows to discard them, a keyset predicate
 * seeks.
 *
 * ## The compatibility rule this module encodes
 *
 * Omitting `limit` returns EVERYTHING, exactly as the route answered
 * before it was paginated, with `nextCursor: null`. That is deliberate and
 * is the whole reason these routes could be paginated in one pack: the web
 * client renders these registers in full and has no paging control on any
 * of them, so a default page size would have silently truncated six
 * screens. Pagination here is a capability a caller opts into by sending
 * `limit`, and the client can adopt it one screen at a time.
 *
 * This is the same posture the timeline took, read the other way round:
 * the timeline defaults to a page because its caller was written against a
 * page from the start.
 */

/** The largest page a caller may ask for. Higher than the timeline's 100
 * because these are registers a clerk scrolls rather than an event feed,
 * and low enough that one page is a bounded serialisation. */
const MAX_PAGE_SIZE = 200;

// Cursors are validated with a pattern rather than the uuid format, for
// the reason `timeline.ts` states: the check must not depend on which
// formats the serving ajv instance happens to have registered.
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** The two query parameters every paginated list accepts. Both optional:
 * see the compatibility rule above. */
export const KeysetQuerySchema = Type.Object(
  {
    /** Rows per page. Omitted means no page at all — the whole list. */
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
    /** The id of the last row of the previous page. */
    cursor: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
  },
  { additionalProperties: false },
);

/** The response property a paginated list carries beside its rows: the id
 * to send as the next `cursor`, or null when the register is exhausted —
 * which is also what an unpaginated request always gets back. */
export const NextCursorSchema = Type.Union([UuidSchema, Type.Null()]);

/**
 * Adds `limit`/`cursor` to a list route's existing querystring schema.
 *
 * Registers that already filter (`?status=`, `?includeRetired=`) keep
 * their own properties; this only ever adds the two pagination ones, so a
 * route's filter contract is unchanged by being paginated.
 */
export function withKeysetQuery<T extends TSchema>(schema: T) {
  return Type.Composite([schema, KeysetQuerySchema], {
    additionalProperties: false,
  });
}

/**
 * Which way round a register reads its date column.
 *
 * The registers a clerk scrolls are kept newest first, and that stays the
 * default: `sort` is OPTIONAL, and omitting it is byte-for-byte the
 * request the route answered before this existed. Sending `date_asc`
 * turns the ORDER BY and the keyset predicate round TOGETHER — the one
 * invariant a paginated sort has to hold, because a predicate that
 * disagrees with its ordering loses or repeats rows at the page boundary
 * rather than failing outright.
 *
 * Only the date column is offered. The registers' money columns are
 * either derived per page (the Delivery Challan register sums its lines
 * in a lateral join) or nullable while a document is a draft, and a
 * leading keyset key that is NULL makes the whole row comparison NULL —
 * which silently drops every draft after the first page. Sorting a
 * register by value is therefore a client-side sort of a register the
 * view holds in full, never a cursor key. See `apps/web/src/ui/table.tsx`.
 */
export const REGISTER_SORTS = ['date_desc', 'date_asc'] as const;
export const RegisterSortSchema = Type.Union(
  REGISTER_SORTS.map((sort) => Type.Literal(sort)),
);
export type RegisterSort = Static<typeof RegisterSortSchema>;

/**
 * A cursor into a SORTABLE register: the row id, plus the sort it was
 * minted under.
 *
 * A bare id cannot say which order it was a position in, and the two
 * orders give it opposite meanings — under `date_desc` it means "the rows
 * after this one going backwards", under `date_asc` "the rows after this
 * one going forwards". Replaying a cursor from one walk under the other
 * sort is therefore not an error the server can see: it answers 200 with
 * the far side of the row, which to a client mid-walk is the register
 * silently skipping everything between. So the sort travels WITH the
 * cursor and a crossed pairing is refused as CURSOR_INVALID.
 *
 * The tag is a suffix on the ascending cursor only, so a descending
 * cursor — the default order, and every cursor any of these registers has
 * ever minted — is unchanged. `~` is outside the UUID alphabet, so the id
 * and its tag cannot be confused for one another.
 */
export const ASCENDING_CURSOR_TAG = '~a';
const SORTED_CURSOR_PATTERN = `${UUID_PATTERN.slice(0, -1)}(${ASCENDING_CURSOR_TAG})?$`;

/** The cursor a sortable register hands back. Same shape as its input. */
export const SortedNextCursorSchema = Type.Union([
  Type.String({ pattern: SORTED_CURSOR_PATTERN }),
  Type.Null(),
]);

/**
 * The querystring of a register that both pages AND sorts: its own
 * filters, `limit`, the sort-tagged `cursor`, and `sort`.
 *
 * Stated in one object rather than by composing {@link withKeysetQuery}
 * with a second wrapper, because the cursor property has to be DECLARED
 * with the wider pattern rather than intersected with the plain-uuid one —
 * an intersection would require both, and a tagged cursor satisfies only
 * the wider.
 */
export function withSortedKeysetQuery<T extends TSchema>(schema: T) {
  return Type.Composite(
    [
      schema,
      Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
        cursor: Type.Optional(Type.String({ pattern: SORTED_CURSOR_PATTERN })),
        sort: Type.Optional(RegisterSortSchema),
      }),
    ],
    { additionalProperties: false },
  );
}
