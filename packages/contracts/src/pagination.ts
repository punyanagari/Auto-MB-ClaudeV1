import { Type, type TSchema } from '@sinclair/typebox';
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
