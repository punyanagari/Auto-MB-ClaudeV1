import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, UuidSchema } from './primitives.js';

/**
 * The organisation-wide audit register (migration 0095).
 *
 * `timeline.ts` beside this file is the per-Work trail and the per-record
 * history, and its own comment says in as many words that it is "NOT
 * organisation-wide audit search". This is that search, and the difference
 * is not merely one of breadth:
 *
 *   * the timeline is filtered to a Work and open to every member assigned
 *     to it, viewers included;
 *   * the register is filtered by ACTOR, entity type, action and date, and
 *     is gated on the `audit` authority (`can_view_audit_trail`) because
 *     "what did this person do" is a different question from "what happened
 *     to this Work".
 *
 * The register additionally requires FULL work scope. `audit_events` carries
 * no `work_id`, and the entity-to-Work mapping the per-Work timeline
 * maintains covers only the entity types a Work has — not a member being
 * added or the organisation profile being edited, which are much of what
 * this register exists to show. An assigned-scope reader would get a
 * cross-Work screen showing a silent slice. They already have a complete
 * view of their own Works on each Work's Timeline tab, so the register
 * refuses instead, and says so.
 */

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * The register's filters.
 *
 * `from`/`to` are date-only and INCLUSIVE, resolved against the
 * organisation's own timezone by the server so a day means the operator's
 * day rather than UTC's. The window is additionally clamped to the
 * organisation's `auditRetentionMonths`: a `from` older than the window is
 * not an error, it simply cannot reach further back than the policy says
 * the register looks.
 *
 * `actorUserId` is a plain string rather than a uuid: better-auth account
 * ids are its own opaque format, and `audit_events.actor_user_id` is a
 * `text` column for that reason.
 */
export const AuditRegisterQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    cursor: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
    actorUserId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    /** One `audit_events.entity_type`, exactly. */
    entityType: Type.Optional(Type.String({ pattern: '^[a-z_]{2,100}$' })),
    entityId: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
    /** One `audit_events.action`, exactly — the register's action filter is
     * a picker over what the trail already contains, not a text search. */
    action: Type.Optional(Type.String({ minLength: 3, maxLength: 100 })),
    from: Type.Optional(DateOnlySchema),
    to: Type.Optional(DateOnlySchema),
  },
  { additionalProperties: false },
);
export type AuditRegisterQuery = Static<typeof AuditRegisterQuerySchema>;

const AuditEventSchema = Type.Object(
  {
    id: UuidSchema,
    occurredAt: Type.String({ format: 'date-time' }),
    actorUserId: Type.Union([Type.String(), Type.Null()]),
    actorName: Type.Union([Type.String(), Type.Null()]),
    action: Type.String(),
    entityType: Type.String(),
    entityId: Type.Union([UuidSchema, Type.Null()]),
    /** The recorded detail payload, verbatim — the same
     * `{ before, after }` shape `audit-diff.ts` writes for an update. */
    details: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type AuditEvent = Static<typeof AuditEventSchema>;

export const AuditRegisterResponseSchema = Type.Object(
  {
    events: Type.Array(AuditEventSchema),
    nextCursor: Type.Union([UuidSchema, Type.Null()]),
    /** The window actually applied, after the retention clamp — so the
     * screen can say "the register looks back to 12 Aug 2018" rather than
     * silently showing less than the dates asked for. */
    windowFrom: DateOnlySchema,
    /** The organisation's configured retention, echoed so the register can
     * name it in the same sentence. */
    retentionMonths: Type.Integer(),
  },
  { additionalProperties: false },
);
export type AuditRegisterResponse = Static<typeof AuditRegisterResponseSchema>;

/**
 * What the register can be filtered BY, derived from the trail itself.
 *
 * The action and entity-type vocabularies are written by ~200 call sites
 * across the route tree and grow every wave; a hand-maintained list on the
 * client would be wrong within one pack. So the filter options are read
 * from the organisation's own events — which also means a filter can never
 * offer a value that would return nothing.
 */
export const AuditFacetsResponseSchema = Type.Object(
  {
    actions: Type.Array(Type.String()),
    entityTypes: Type.Array(Type.String()),
    actors: Type.Array(
      Type.Object(
        {
          userId: Type.String(),
          name: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type AuditFacetsResponse = Static<typeof AuditFacetsResponseSchema>;
