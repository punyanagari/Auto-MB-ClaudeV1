import {
  ApiErrorSchema,
  EntityTimelineQuerySchema,
  TIMELINE_ENTITY_TYPES,
  TimelineQuerySchema,
  TimelineResponseSchema,
  type TimelineEntityType,
  type TimelineEvent,
  type TimelineResponse,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess } from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
} as const;

const EntityParamsSchema = Type.Object(
  {
    entityType: Type.String({ pattern: '^[a-z_]{2,100}$' }),
    entityId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

const DEFAULT_PAGE_SIZE = 50;

interface EventRow {
  id: string;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: unknown;
}

function toEvent(row: EventRow): TimelineEvent {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: parseJsonbColumn(row.details),
  };
}

/** Resolves the keyset cursor (an event id from a previous page) to its
 * full-precision position. occurred_at travels as text because a JS Date
 * only keeps milliseconds — a microsecond-truncated cursor could skip or
 * repeat events that share a millisecond. */
async function resolveCursor(
  tx: TransactionSql,
  cursor: string | undefined,
): Promise<{ occurredAt: string; id: string } | null> {
  if (cursor === undefined) return null;
  const [row] = await tx<{ occurred_at: string; id: string }[]>`
    select occurred_at::text as occurred_at, id
    from audit_events where id = ${cursor}
  `;
  if (!row) {
    throw httpError(
      400,
      'CURSOR_INVALID',
      'The pagination cursor does not name a known event.',
    );
  }
  return { occurredAt: row.occurred_at, id: row.id };
}

function parseEntityTypes(raw: string | undefined): readonly TimelineEntityType[] {
  if (raw === undefined) return TIMELINE_ENTITY_TYPES;
  const requested = raw.split(',');
  for (const entityType of requested) {
    if (!(TIMELINE_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      throw httpError(
        400,
        'ENTITY_TYPE_INVALID',
        `Unknown entity type filter: ${entityType}.`,
      );
    }
  }
  return requested as TimelineEntityType[];
}

function paginate(rows: EventRow[], limit: number): TimelineResponse {
  const page = rows.slice(0, limit);
  const events = page.map(toEvent);
  const last = page[page.length - 1];
  return {
    events,
    nextCursor: rows.length > limit && last !== undefined ? last.id : null,
  };
}

/**
 * Milestone 6: the per-Work audit trail and single-record history. Reads
 * only — every event was written by the mutation that caused it. Access
 * follows work scope exactly like the Works list (migration 0009 model):
 * any active member whose scope covers the Work may read, viewers
 * included; denials are 404 so guessed ids confirm nothing. This is NOT
 * organisation-wide audit search (Milestone 9) — no free-text or
 * actor-wide queries.
 */
export function registerTimelineRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  app.get(
    '/api/works/:id/timeline',
    {
      schema: {
        params: IdParamsSchema,
        querystring: TimelineQuerySchema,
        response: { 200: TimelineResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params;
      const query = request.query;
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      const entityTypes = parseEntityTypes(query.entityTypes);

      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const cursor = await resolveCursor(tx, query.cursor);

        // One pass over the timeline index (organisation_id,
        // occurred_at DESC, id): RLS pins the organisation, the ORDER BY
        // matches the index, and the entity predicate maps each child
        // table back to the Work. serials.recorded events carry the
        // challan id as entity_id (the serials were recorded against that
        // challan), so challan_item_serials accepts either id shape.
        const rows = await tx<EventRow[]>`
          select ae.id, ae.occurred_at, ae.actor_user_id,
                 u."name" as actor_name, ae.action, ae.entity_type,
                 ae.entity_id, ae.details
          from audit_events ae
          left join auth_users u on u."id" = ae.actor_user_id
          where ae.entity_type = any(${entityTypes as string[]}::text[])
            and (
              (ae.entity_type = 'works' and ae.entity_id = ${workId})
              or (ae.entity_type = 'delivery_challans' and ae.entity_id in (
                select id from delivery_challans where work_id = ${workId}))
              or (ae.entity_type = 'issue_challans' and ae.entity_id in (
                select id from issue_challans where work_id = ${workId}))
              or (ae.entity_type = 'challan_receipts' and ae.entity_id in (
                select id from challan_receipts where work_id = ${workId}))
              or (ae.entity_type = 'challan_item_serials' and (
                ae.entity_id in (
                  select id from challan_item_serials where work_id = ${workId})
                or ae.entity_id in (
                  select id from delivery_challans where work_id = ${workId})))
              or (ae.entity_type = 'work_instruments' and ae.entity_id in (
                select id from work_instruments where work_id = ${workId}))
              or (ae.entity_type = 'mb_entries' and ae.entity_id in (
                select id from mb_entries where work_id = ${workId}))
              or (ae.entity_type = 'bills' and ae.entity_id in (
                select id from bills where work_id = ${workId}))
              or (ae.entity_type = 'installations' and ae.entity_id in (
                select id from installations where work_id = ${workId}))
              or (ae.entity_type = 'approval_requests' and ae.entity_id in (
                select id from approval_requests where work_id = ${workId}))
              or (ae.entity_type = 'correction_notices' and ae.entity_id in (
                select id from correction_notices where work_id = ${workId}))
              or (ae.entity_type = 'work_items' and ae.entity_id in (
                select id from work_items where work_id = ${workId}))
              or (ae.entity_type = 'payment_matrices' and ae.entity_id in (
                select id from payment_matrices where work_id = ${workId}))
              or (ae.entity_type = 'pac_certificates' and ae.entity_id in (
                select id from pac_certificates where work_id = ${workId}))
              or (ae.entity_type = 'measurement_books' and ae.entity_id in (
                select id from measurement_books where work_id = ${workId}))
            )
            and (${cursor === null} or (ae.occurred_at, ae.id) <
              (${cursor?.occurredAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
          order by ae.occurred_at desc, ae.id desc
          limit ${limit + 1}
        `;
        return paginate(rows, limit);
      });
    },
  );

  app.get(
    '/api/audit/entity/:entityType/:entityId',
    {
      schema: {
        params: EntityParamsSchema,
        querystring: EntityTimelineQuerySchema,
        response: { 200: TimelineResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { entityType, entityId } = request.params;
      const query = request.query;
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;

      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        // Unknown types answer like unknown records — a probe learns
        // nothing about which entity types carry history.
        if (!(TIMELINE_ENTITY_TYPES as readonly string[]).includes(entityType)) {
          throw httpError(404, 'ENTITY_NOT_FOUND', 'No such record.');
        }
        const workId = await resolveWorkId(
          tx,
          entityType as TimelineEntityType,
          entityId,
        );
        if (workId === null) {
          throw httpError(404, 'ENTITY_NOT_FOUND', 'No such record.');
        }
        await assertWorkAccess(tx, user.id, workId);
        const cursor = await resolveCursor(tx, query.cursor);

        const rows = await tx<EventRow[]>`
          select ae.id, ae.occurred_at, ae.actor_user_id,
                 u."name" as actor_name, ae.action, ae.entity_type,
                 ae.entity_id, ae.details
          from audit_events ae
          left join auth_users u on u."id" = ae.actor_user_id
          where ae.entity_type = ${entityType} and ae.entity_id = ${entityId}
            and (${cursor === null} or (ae.occurred_at, ae.id) <
              (${cursor?.occurredAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
          order by ae.occurred_at desc, ae.id desc
          limit ${limit + 1}
        `;
        return paginate(rows, limit);
      });
    },
  );
}

/** Maps a timeline entity back to its Work so scope enforcement can run.
 * Every table here carries work_id (works maps to itself); the entity
 * type is whitelist-checked before this runs, so the identifier
 * interpolation is over a closed set. */
async function resolveWorkId(
  tx: TransactionSql,
  entityType: TimelineEntityType,
  entityId: string,
): Promise<string | null> {
  if (entityType === 'works') {
    const [row] = await tx<{ id: string }[]>`
      select id from works where id = ${entityId} and deleted_at is null
    `;
    return row?.id ?? null;
  }
  const [row] = await tx<{ work_id: string }[]>`
    select work_id from ${tx.unsafe(entityType)} where id = ${entityId}
  `;
  return row?.work_id ?? null;
}
