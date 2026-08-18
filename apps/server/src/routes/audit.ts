import {
  AuditFacetsResponseSchema,
  AuditRegisterQuerySchema,
  AuditRegisterResponseSchema,
  type AuditEvent,
  type AuditFacetsResponse,
  type AuditRegisterResponse,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { hasFullWorkScope } from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { XLSX_MEDIA_TYPE, buildXlsx } from '../xlsx.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import { audit, errorResponses } from './shared.js';

/**
 * The organisation-wide audit register (migration 0095).
 *
 * READS ONLY. Every row was written by the mutation that caused it, and
 * `audit_events` has been append-only for the application role since
 * migration 0002 — this module could not edit or delete one if it wanted
 * to, which is the property that makes the register worth reading.
 *
 * ## Two walls, both on every read
 *
 * The `audit` authority (`can_view_audit_trail`), declared on the route so
 * the registrar checks it inside every bound transaction; and full work
 * scope, checked in the handler. Migration 0095 records why the second is a
 * refusal rather than a narrowing: `audit_events` carries no `work_id`, the
 * entity-to-Work mapping `routes/timeline.ts` maintains covers only the
 * entity types a Work has, and an assigned-scope reader would therefore get
 * a cross-Work oversight screen quietly missing every organisation-level
 * fact — a member added, a rate changed, the profile edited — with nothing
 * on it saying so. The per-Work Timeline tab serves that member completely.
 *
 * ## The retention window
 *
 * `organisations.audit_retention_months` is a VIEWING window, not a purge
 * (0095 § 2 argues it at length: Rule 3(1) of the Companies (Accounts)
 * Rules requires the trail to be KEPT, and 0002 revoked DELETE from the
 * application role on purpose). It is applied here, in the register's own
 * WHERE clause, and the resolved floor travels back in the response so the
 * screen can say how far back it looked instead of silently showing less
 * than the dates asked for.
 */

/**
 * How many rows any one workbook carries.
 *
 * Not a page size — an export is a whole file — but a bound, because a
 * request that streams an unbounded register into memory is a request that
 * can take the process down. Twenty thousand rows is comfortably more than
 * any register this product holds for a single agency and comfortably less
 * than a problem; a trail longer than that is narrowed with the register's
 * own filters, which the export honours.
 *
 * ponytail: one flat cap, no streaming writer. An .xlsx is a ZIP central
 * directory that has to be written after its entries, so streaming one
 * means buffering the sheet anyway; if a customer ever needs a
 * hundred-thousand-row export, the answer is the async job queue (0072),
 * not a cleverer writer.
 */
export const EXPORT_ROW_CAP = 20_000;

/** How many events a page carries when the caller asks for no limit. */
const DEFAULT_PAGE_SIZE = 100;

/** How many distinct values each filter picker offers. A vocabulary
 * longer than this is not a picker any more, and the register's own free
 * filters (actor, dates) are the way through a trail that wide. */
const FACET_LIMIT = 200;

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

function toEvent(row: EventRow): AuditEvent {
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

interface ResolvedWindow {
  /** The oldest day the register may reach, `YYYY-MM-DD`. */
  readonly from: string;
  /** The newest day it may reach, or null for "up to now". */
  readonly to: string | null;
  readonly retentionMonths: number;
  /** The window's two boundary INSTANTS, resolved once against the
   * organisation's timezone. The predicate compares against these scalars
   * rather than re-deriving them per row; see `registerPredicate`. */
  readonly fromAt: Date;
  readonly toAt: Date | null;
}

/**
 * Resolves the date window against the organisation's timezone and its
 * retention policy, in one statement.
 *
 * Both halves stay in PostgreSQL for the same reason the rest of this
 * product's date handling does (`AGENTS.md` rule 6): "today" is the
 * organisation's own day, taken from `organisations.timezone` exactly as
 * the dashboard's IRP window takes it, and a date-only value that made a
 * round trip through a JavaScript `Date` on the way would be a day out for
 * half of every day.
 *
 * `greatest` does the clamp: a `from` inside the window is honoured, a
 * `from` older than it — or absent — falls back to the retention floor.
 *
 * The two boundary INSTANTS come back from the same statement. They used to
 * be re-derived inside the register's WHERE clause as a correlated
 * subselect against `organisations` — once per candidate row, which made the
 * predicate non-sargable and cost the register the very index
 * `audit_events_timeline_idx` exists to give it. Resolved here they are
 * plain scalars, so the range is a seek.
 */
async function resolveWindow(
  tx: TransactionSql,
  from: string | undefined,
  to: string | undefined,
): Promise<ResolvedWindow> {
  if (from !== undefined && to !== undefined && from > to) {
    throw httpError(
      400,
      'EXPORT_WINDOW_INVALID',
      'The register window starts after it ends.',
    );
  }
  const [row] = await tx<
    {
      window_from: string;
      retention_months: number;
      from_at: Date;
      to_at: Date | null;
    }[]
  >`
    with resolved as (
      select
        greatest(
          ${from ?? null}::date,
          ((now() at time zone o.timezone)::date
            - make_interval(months => o.audit_retention_months))::date
        ) as window_from,
        o.audit_retention_months as retention_months,
        o.timezone as timezone
      from organisations o
      where o.id = app_private.current_organisation_id()
    )
    select
      window_from::text as window_from,
      retention_months,
      (window_from::timestamp at time zone timezone) as from_at,
      case
        when ${to ?? null}::date is null then null
        -- Inclusive: the day AFTER the requested one, at its own local
        -- midnight, compared with a strict less-than below.
        else ((${to ?? null}::date + 1)::timestamp at time zone timezone)
      end as to_at
    from resolved
  `;
  if (!row) {
    // Unreachable through the tenant binding, which proves membership of
    // an existing organisation before a handler runs. Stated rather than
    // asserted with `!`, so a future caller that reaches this module
    // another way fails loudly instead of reading `undefined.from`.
    throw httpError(404, 'NOT_FOUND', 'Organisation not found.');
  }
  return {
    from: row.window_from,
    to: to ?? null,
    retentionMonths: Number(row.retention_months),
    fromAt: row.from_at,
    toAt: row.to_at,
  };
}

/**
 * The register's WHERE clause, shared verbatim by the paged read and the
 * workbook export so the two can never disagree about which events the
 * register contains.
 *
 * The window arrives as two resolved INSTANTS — `resolveWindow` turned the
 * organisation's own days into them once — so this compares `occurred_at`
 * against scalars and seeks inside `audit_events_timeline_idx` rather than
 * running a correlated subselect per row.
 */
function registerPredicate(
  tx: TransactionSql,
  window: ResolvedWindow,
  filters: {
    readonly actorUserId?: string;
    readonly entityType?: string;
    readonly entityId?: string;
    readonly action?: string;
  },
) {
  return tx`
    ae.occurred_at >= ${window.fromAt}
    and (${window.toAt === null} or ae.occurred_at < ${window.toAt})
    and (${filters.actorUserId === undefined}
      or ae.actor_user_id = ${filters.actorUserId ?? null})
    and (${filters.entityType === undefined}
      or ae.entity_type = ${filters.entityType ?? null})
    and (${filters.entityId === undefined}
      or ae.entity_id = ${filters.entityId ?? null}::uuid)
    and (${filters.action === undefined} or ae.action = ${filters.action ?? null})
  `;
}

/** Proves the cursor names an event this register contains. Unlike the
 * per-Work timeline's equivalent, no existence oracle is possible here —
 * the caller may already read every event in the organisation — so the
 * check is only that the id resolves, and the refusal is the plain one. */
async function resolveCursor(
  tx: TransactionSql,
  cursor: string | undefined,
): Promise<string | null> {
  if (cursor === undefined) return null;
  const [row] = await tx<{ id: string }[]>`
    select id from audit_events where id = ${cursor}
  `;
  if (!row) {
    throw httpError(
      400,
      'CURSOR_INVALID',
      'The pagination cursor does not name a known event.',
    );
  }
  return row.id;
}

/** Refuses a caller whose scope does not cover every Work. */
async function requireFullScope(tx: TransactionSql, userId: string): Promise<void> {
  if (await hasFullWorkScope(tx, userId)) return;
  throw httpError(
    403,
    'WORK_SCOPE_FORBIDDEN',
    'The audit register covers every Work in the organisation, and your membership is limited to the Works you are assigned to. Read a Work’s own history on its Timeline tab.',
  );
}

/** One cell of the workbook's detail column: the recorded payload as
 * compact text rather than raw JSON, matching what the register's own
 * detail pane prints. */
function detailText(details: unknown): string {
  if (details === null || typeof details !== 'object') return '';
  const entries = Object.entries(details as Record<string, unknown>);
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) =>
      typeof value === 'object' && value !== null
        ? `${key}: ${JSON.stringify(value)}`
        : `${key}: ${String(value)}`,
    )
    .join('; ');
}

const AUDIT_COLUMNS = [
  { header: 'Occurred at (UTC)' },
  { header: 'Actor' },
  { header: 'Actor account' },
  { header: 'Action' },
  { header: 'Record type' },
  { header: 'Record id' },
  { header: 'Detail' },
] as const;

export function registerAuditRoutes(app: AppInstance, auth: Auth, database: Sql): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'GET',
      url: '/api/audit-events',
      authority: 'audit',
      schema: {
        querystring: AuditRegisterQuerySchema,
        response: { 200: AuditRegisterResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }): Promise<AuditRegisterResponse> => {
      const query = request.query;
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      return tenant(async (tx) => {
        await requireFullScope(tx, user.id);
        const window = await resolveWindow(tx, query.from, query.to);
        const cursor = await resolveCursor(tx, query.cursor);
        const rows = await tx<EventRow[]>`
          select ae.id, ae.occurred_at, ae.actor_user_id,
                 u."name" as actor_name, ae.action, ae.entity_type,
                 ae.entity_id, ae.details
          from audit_events ae
          left join auth_users u on u."id" = ae.actor_user_id
          where ${registerPredicate(tx, window, query)}
            and (${cursor === null} or (ae.occurred_at, ae.id) < (
              select c.occurred_at, c.id from audit_events c
              where c.id = ${cursor}))
          order by ae.occurred_at desc, ae.id desc
          limit ${limit + 1}
        `;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          events: page.map(toEvent),
          nextCursor: rows.length > limit && last !== undefined ? last.id : null,
          windowFrom: window.from,
          retentionMonths: window.retentionMonths,
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/audit-events/facets',
      authority: 'audit',
      schema: {
        response: { 200: AuditFacetsResponseSchema, ...errorResponses },
      },
    },
    async ({ user, tenant }): Promise<AuditFacetsResponse> => {
      return tenant(async (tx) => {
        await requireFullScope(tx, user.id);
        // Three small DISTINCT reads rather than one query with three
        // GROUP BYs: they answer independent questions, they are each an
        // index-only pass over a column RLS has already narrowed, and the
        // screen loads them once per session.
        const actions = await tx<{ action: string }[]>`
          select distinct action from audit_events
          order by action asc limit ${FACET_LIMIT}
        `;
        const entityTypes = await tx<{ entity_type: string }[]>`
          select distinct entity_type from audit_events
          order by entity_type asc limit ${FACET_LIMIT}
        `;
        const actors = await tx<{ user_id: string; name: string | null }[]>`
          select distinct ae.actor_user_id as user_id, u."name" as name
          from audit_events ae
          left join auth_users u on u."id" = ae.actor_user_id
          where ae.actor_user_id is not null
          order by u."name" asc nulls last, ae.actor_user_id asc
          limit ${FACET_LIMIT}
        `;
        return {
          actions: actions.map((row) => row.action),
          entityTypes: entityTypes.map((row) => row.entity_type),
          actors: actors.map((row) => ({ userId: row.user_id, name: row.name })),
        };
      });
    },
  );

  /**
   * The register as a workbook.
   *
   * Capped at `EXPORT_ROW_CAP` rows rather than paged: an export is one
   * file an operator opens, and a workbook that silently held the first
   * page of a trail would be worse than one that says it is truncated. So
   * it does not silently hold it — the cap is over-fetched by one, a final
   * row in the sheet says the file was cut, and two response headers carry
   * the same fact for a machine. The FILENAME carries the applied window,
   * so a workbook on a desktop still says which days it covers.
   *
   * `limit` and `cursor` are accepted by the shared query schema and
   * deliberately IGNORED here: an export is the whole filtered register,
   * not one page of it, and the cap above is the only bound that applies.
   *
   * The export itself is audited — reading every colleague's actions in
   * one download is an act worth recording.
   */
  tenantRoute(
    {
      method: 'GET',
      url: '/api/audit-events.xlsx',
      authority: 'audit',
      schema: { querystring: AuditRegisterQuerySchema },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const query = request.query;
      const result = await tenant(async (tx) => {
        await requireFullScope(tx, user.id);
        const window = await resolveWindow(tx, query.from, query.to);
        const fetched = await tx<EventRow[]>`
          select ae.id, ae.occurred_at, ae.actor_user_id,
                 u."name" as actor_name, ae.action, ae.entity_type,
                 ae.entity_id, ae.details
          from audit_events ae
          left join auth_users u on u."id" = ae.actor_user_id
          where ${registerPredicate(tx, window, query)}
          order by ae.occurred_at desc, ae.id desc
          limit ${EXPORT_ROW_CAP + 1}
        `;
        const capped = fetched.length > EXPORT_ROW_CAP;
        const rows = fetched.slice(0, EXPORT_ROW_CAP);
        await audit(
          tx,
          organisationId,
          user.id,
          'audit_trail.exported',
          'organisations',
          organisationId,
          {
            rows: rows.length,
            capped,
            windowFrom: window.from,
            windowTo: window.to,
          },
        );
        const cells: (string | null)[][] = rows.map((row) => [
          row.occurred_at.toISOString(),
          row.actor_name,
          row.actor_user_id,
          row.action,
          row.entity_type,
          row.entity_id,
          detailText(parseJsonbColumn(row.details)),
        ]);
        if (capped) {
          cells.push([
            `… truncated at ${String(EXPORT_ROW_CAP)} rows. Narrow the window or the filters and export again.`,
            null,
            null,
            null,
            null,
            null,
            null,
          ]);
        }
        return {
          capped,
          window,
          bytes: buildXlsx('Audit trail', AUDIT_COLUMNS, cells),
        };
      });
      void reply.type(XLSX_MEDIA_TYPE);
      // The window in the NAME, so a file sitting on a desktop a month
      // later still says which days it covers — the same reason the Tally
      // export carries its own.
      void reply.header(
        'content-disposition',
        `attachment; filename="audit-trail-${result.window.from}-to-${result.window.to ?? 'now'}.xlsx"`,
      );
      void reply.header('x-auto-mb-export-window-from', result.window.from);
      void reply.header('x-auto-mb-export-window-to', result.window.to ?? 'now');
      void reply.header('x-auto-mb-export-rows-cap', String(EXPORT_ROW_CAP));
      void reply.header('x-auto-mb-export-truncated', String(result.capped));
      return reply.send(result.bytes);
    },
  );
}
