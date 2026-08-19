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
import { IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

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

/**
 * Proves the keyset cursor (an event id from a previous page) names an
 * event OF THE TRAIL BEING PAGED, and answers with nothing more than its
 * id. Two rules meet here, both because a cursor is caller input:
 *
 * 1. The cursor must satisfy the same predicate as the page it restarts.
 *    The first shape of this check proved only that the id existed in
 *    `audit_events` — which RLS narrows to the organisation, never to the
 *    Work — so a member whose scope excludes a Work could still use the
 *    cursor as an existence oracle for that Work's event ids: a leaked id
 *    answered 200, a made-up one 400. `audit_events` carries no work_id,
 *    so the cursor row is proven against the same entity-to-Work mapping
 *    (or the same entity pair) the page's own WHERE clause uses, and the
 *    refusal is the identical 400 CURSOR_INVALID either way — a cursor
 *    outside the trail is indistinguishable from one that never existed.
 *
 * 2. The cursor's position never leaves PostgreSQL. It used to carry
 *    `occurred_at::text` back out and send it in as `::timestamptz`,
 *    precisely to keep the microseconds a JavaScript Date would lose —
 *    and pack P12 measured that this defence does not always hold: the
 *    driver re-encodes a parameter it types as `timestamptz` through a
 *    Date anyway, and a cursor read as `.527771` reached the server as
 *    `.527`. On a DESCENDING trail a truncated cursor sorts earlier than
 *    the event it names, so every event sharing that millisecond and
 *    preceding it drops out of the next page, and a short trail looks
 *    like a quiet day. The position is therefore read inside the
 *    comparison itself (`src/pagination.ts` states the rule), so the
 *    timestamp never leaves PostgreSQL and cannot be rounded on the way
 *    back.
 */
function cursorInvalid(): Error {
  return httpError(
    400,
    'CURSOR_INVALID',
    'The pagination cursor does not name a known event.',
  );
}

async function resolveWorkCursor(
  tx: TransactionSql,
  workId: string,
  cursor: string | undefined,
): Promise<string | null> {
  if (cursor === undefined) return null;
  const [row] = await tx<{ id: string }[]>`
    select ae.id from audit_events ae
    where ae.id = ${cursor} and ${workEventPredicate(tx, workId)}
  `;
  if (!row) throw cursorInvalid();
  return row.id;
}

async function resolveEntityCursor(
  tx: TransactionSql,
  entityType: string,
  entityId: string,
  cursor: string | undefined,
): Promise<string | null> {
  if (cursor === undefined) return null;
  const [row] = await tx<{ id: string }[]>`
    select ae.id from audit_events ae
    where ae.id = ${cursor}
      and ae.entity_type = ${entityType} and ae.entity_id = ${entityId}
  `;
  if (!row) throw cursorInvalid();
  return row.id;
}

/**
 * Maps each event to the Work it belongs to, over `audit_events` aliased
 * as `ae`. This is the membership half of the per-Work timeline's WHERE
 * clause, shared verbatim between the page query and the cursor proof so
 * the two can never disagree about which events the trail contains.
 * serials.recorded events carry the challan id as entity_id (the serials
 * were recorded against that challan), so challan_item_serials accepts
 * either id shape. work_retention_terms events carry the WORK id, because
 * that register is one row per Work and its row DELETES when the terms are
 * cleared — joining its live primary key would take the clearing event and
 * every prior save off the trail at the moment they matter most.
 */
function workEventPredicate(tx: TransactionSql, workId: string) {
  return tx`(
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
    or (ae.entity_type = 'bill_payments' and ae.entity_id in (
      select p.id from bill_payments p
      join bills b on b.organisation_id = p.organisation_id
                   and b.id = p.bill_id
      where b.work_id = ${workId}))
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
    or (ae.entity_type = 'received_railway_bills' and ae.entity_id in (
      select id from received_railway_bills where work_id = ${workId}))
    or (ae.entity_type = 'inspection_calls' and ae.entity_id in (
      select id from inspection_calls where work_id = ${workId}))
    or (ae.entity_type = 'correspondence_letters' and ae.entity_id in (
      select id from correspondence_letters where work_id = ${workId}))
    or (ae.entity_type = 'production_job_cards' and ae.entity_id in (
      select id from production_job_cards where work_id = ${workId}))
    or (ae.entity_type = 'signing_requests' and ae.entity_id in (
      select id from signing_requests where work_id = ${workId}))
    or (ae.entity_type = 'maintenance_requests' and ae.entity_id in (
      select id from maintenance_requests where work_id = ${workId}))
    or (ae.entity_type = 'work_retention_terms' and ae.entity_id = ${workId})
    or (ae.entity_type = 'retention_releases' and ae.entity_id in (
      select id from retention_releases where work_id = ${workId}))
    or (ae.entity_type = 'ld_assessments' and ae.entity_id in (
      select id from ld_assessments where work_id = ${workId}))
    or (ae.entity_type = 'installation_warranties' and ae.entity_id in (
      select id from installation_warranties where work_id = ${workId}))
    -- The warranty term is audited against the WORK's own id, not
    -- against the term row: an operator reading the trail asks what
    -- happened to this Work, and the term has no life of its own to
    -- open (migration 0099).
    or (ae.entity_type = 'work_warranty_terms' and ae.entity_id = ${workId})
  )`;
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
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/timeline',
      schema: {
        params: IdParamsSchema,
        querystring: TimelineQuerySchema,
        response: { 200: TimelineResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const query = request.query;
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      const entityTypes = parseEntityTypes(query.entityTypes);

      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const cursor = await resolveWorkCursor(tx, workId, query.cursor);

        // One pass over the timeline index (organisation_id,
        // occurred_at DESC, id): RLS pins the organisation, the ORDER BY
        // matches the index, and the shared predicate maps each child
        // table back to the Work.
        const rows = await tx<EventRow[]>`
          select ae.id, ae.occurred_at, ae.actor_user_id,
                 u."name" as actor_name, ae.action, ae.entity_type,
                 ae.entity_id, ae.details
          from audit_events ae
          left join auth_users u on u."id" = ae.actor_user_id
          where ae.entity_type = any(${entityTypes as string[]}::text[])
            and ${workEventPredicate(tx, workId)}
            and (${cursor === null} or (ae.occurred_at, ae.id) < (
              select c.occurred_at, c.id from audit_events c where c.id = ${cursor}))
          order by ae.occurred_at desc, ae.id desc
          limit ${limit + 1}
        `;
        return paginate(rows, limit);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/audit/entity/:entityType/:entityId',
      schema: {
        params: EntityParamsSchema,
        querystring: EntityTimelineQuerySchema,
        response: { 200: TimelineResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { entityType, entityId } = request.params;
      const query = request.query;
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;

      return tenant(async (tx) => {
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
        const cursor = await resolveEntityCursor(
          tx,
          entityType,
          entityId,
          query.cursor,
        );

        const rows = await tx<EventRow[]>`
          select ae.id, ae.occurred_at, ae.actor_user_id,
                 u."name" as actor_name, ae.action, ae.entity_type,
                 ae.entity_id, ae.details
          from audit_events ae
          left join auth_users u on u."id" = ae.actor_user_id
          where ae.entity_type = ${entityType} and ae.entity_id = ${entityId}
            and (${cursor === null} or (ae.occurred_at, ae.id) < (
              select c.occurred_at, c.id from audit_events c where c.id = ${cursor}))
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
