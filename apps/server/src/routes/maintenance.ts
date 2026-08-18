import {
  ApproveMaintenanceRequestSchema,
  CancelMaintenanceLineSchema,
  CreateMaintenanceRequestSchema,
  MaintenanceDetailResponseSchema,
  MaintenanceListQuerySchema,
  MaintenanceListResponseSchema,
  ReceiveMaintenanceReturnSchema,
  RecordMaintenanceDispatchSchema,
  type ErrorCode,
  type MaintenanceDispatch,
  type MaintenanceLine,
  type MaintenancePriority,
  type MaintenanceRequestSummary,
  type MaintenanceReturn,
  type MaintenanceStatus,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { financialYearLabel } from '../financial-year.js';
import { httpError } from '../http.js';
import { keysetPage, sqlLimit, workScopedCursorRowId, type WorkScope } from '../pagination.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import { assertWorkOperable } from '../work-status.js';
import { audit, errorResponses, IdParamsSchema, optionalTrimmed } from './shared.js';

/**
 * Maintenance: the site material request (migration 0088).
 *
 * The design contract draws three screens — `app/maintenance/page.tsx`,
 * `app/maintenance/[id]` and `app/maintenance/new` at `fdfd610` — and
 * this module is the whole of what they read and write.
 *
 * NOT the LOA's annual maintenance schedule, which is a payment category
 * on a contract line (0068) and is certified rather than despatched.
 * Migration 0088's header sets out why the two share a word and nothing
 * else.
 *
 * ## What is authoritative, and what is derived
 *
 * Three numbers per material line are stored: what was asked for, how
 * much is owed back, and how much was written off. Everything the mock
 * stores beside them is computed here — what is on the shelf is
 * `app_private.stock_on_hand` (0087); what is still reserved is the
 * line's outstanding approved quantity; what has gone out is the sum of
 * its dispatch lines; what has come back is the sum of its returns. None
 * of the four is a column anybody can type into.
 *
 * ## A dispatch moves real stock
 *
 * A dispatch line naming a part posts an `issue` movement against it, in
 * the same transaction, naming this challan. A line with no part is a
 * custom material with nothing on a shelf behind it and posts nothing.
 * The defective return posts nothing either: a broken unit on a repair
 * bench is not available material.
 *
 * ## Where the rules live
 *
 * Every refusal below is made twice. The route makes it first, under no
 * lock, so an operator gets a named 409 with a remedy. The 0088 guards
 * make it again inside the write, under the request line's row lock —
 * the arm that holds when a writer reaches the table another way, and
 * the arm that holds under concurrency, which the route cannot.
 *
 * ## Dates are the organisation's, never the caller's
 *
 * A dispatch date and a receipt date may be omitted and are then the
 * organisation's today (0082's `organisation_today`). A browser clock is
 * the wrong authority for a date printed on a challan.
 *
 * ## Permissions
 *
 * Raising a request, receiving a defective unit, writing a line off and
 * closing a request are site and store work: `role: 'writer'`. Approval
 * is the mock's "whole-request admin approval", so it is `role: 'owner'`.
 * The dispatch is the one act that mints a numbered document handed to
 * somebody outside this office, so it carries the `issue` authority.
 *
 * ## Work-scope
 *
 * Every request names a Work, so the register IS work-scoped: a user
 * without `all_works_access` sees only the requests of Works assigned to
 * them, and every read below carries the predicate.
 */

/**
 * The database's own refusals, mapped to named codes.
 *
 * Migration 0088 raises with SQLSTATEs from the 23G block, one per rule,
 * so a guard that fires because the route's own check lost a race
 * surfaces as the same 409 an operator would have got from the route.
 * The 23F entries are the stock ledger's (0087): a maintenance dispatch
 * posts issues through it, so its refusals reach this module too.
 */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23G01': [
    'MAINTENANCE_STATE_INVALID',
    'The request moved to another state while this was being recorded. Reload it and try again.',
  ],
  '23G02': [
    'MAINTENANCE_DISPATCH_EXCEEDS_OUTSTANDING',
    'Another challan took part of this line while this dispatch was being recorded.',
  ],
  '23G03': [
    'MAINTENANCE_RETURN_EXCEEDS_EXPECTED',
    'Another receipt took the balance of this line while this one was being recorded.',
  ],
  '23G04': [
    'MAINTENANCE_NOT_CLOSEABLE',
    'Material or defective units became outstanding again while the request was being closed.',
  ],
  '23G05': [
    'MAINTENANCE_REQUEST_IMMUTABLE',
    'A raised maintenance request cannot be edited. Close it and raise the corrected one.',
  ],
  '23F01': [
    'STOCK_INSUFFICIENT',
    'The shelf ran out while this dispatch was being posted; another issue against the same part committed first.',
  ],
  '23F03': [
    'STOCK_MOVEMENT_INVALID',
    'The stock ledger refused this dispatch; check the part and the date and try again.',
  ],
  '23F04': [
    'STOCK_BACKDATED',
    'Another movement against one of these parts was posted while this dispatch was being recorded, and it is dated later.',
  ],
  // Two clerks claiming one number lose to the unique index rather than
  // to a guard, so the collision arrives as 23505.
  '23505': [
    'MAINTENANCE_NUMBER_CONFLICT',
    'Another record took that number at the same moment. Record this one again.',
  ],
};

function rethrowWriteRefusal(error: unknown): never {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  const refusal = DATABASE_REFUSALS[code];
  if (refusal !== undefined) throw httpError(409, refusal[0], refusal[1]);
  throw error;
}

/** `MR/26-27/00142` — the request as the store quotes it on the phone.
 * Built from the financial year and the serial, both of which are
 * columns, rather than stored a third time. */
function requestNumber(fyLabel: string, sequenceNumber: number): string {
  return `MR/${fyLabel.slice(2, 4)}-${fyLabel.slice(5, 7)}/${String(sequenceNumber).padStart(5, '0')}`;
}

/** `PL-281/MNT/001` — the challan number printed on the paper the site
 * receiver signs. Per Work, like every other challan series here.
 *
 * The mock renders `PL-281/MNT/DC/1234`. The `DC` is dropped: it is the
 * delivery challan's own token in this product, and a maintenance issue
 * borrowing it would read as one in every register that shows both. */
function dispatchChallanNumber(workCode: string, sequenceNumber: number): string {
  return `${workCode}/MNT/${String(sequenceNumber).padStart(3, '0')}`;
}

/**
 * The work-scope predicate, as SQL over a column holding a `work_id`.
 *
 * Written once because it is needed on every read here, and getting it
 * wrong in one of them is an oracle: a request that resolves for a Work
 * the caller may not list tells them the Work exists.
 */
function visibleWork(tx: TransactionSql, scope: WorkScope, column: string) {
  return tx`(
    ${scope.full}
    or exists (
      select 1 from work_assignments wa
      where wa.work_id = ${tx.unsafe(column)} and wa.user_id = ${scope.userId}
    )
  )`;
}

async function scopeOf(tx: TransactionSql, userId: string): Promise<WorkScope> {
  return { userId, full: await hasFullWorkScope(tx, userId) };
}

// --- Row shapes -------------------------------------------------------------

interface RequestRow {
  id: string;
  request_number: string;
  work_id: string;
  work_code: string;
  station: string;
  requester_name: string;
  requester_phone: string | null;
  priority: MaintenancePriority;
  required_by: string | null;
  fault_summary: string;
  operational_impact: string | null;
  delivery_instructions: string | null;
  status: MaintenanceStatus;
  approval_comment: string | null;
  created_at: Date;
}

function toSummary(row: RequestRow): MaintenanceRequestSummary {
  return {
    id: row.id,
    requestNumber: row.request_number,
    workId: row.work_id,
    workCode: row.work_code,
    station: row.station,
    requesterName: row.requester_name,
    priority: row.priority,
    requiredBy: row.required_by,
    faultSummary: row.fault_summary,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

interface LineRow {
  id: string;
  position: number;
  production_item_id: string | null;
  item_code: string | null;
  description: string;
  unit: string;
  purpose: string | null;
  quantity: string;
  cancelled_quantity: string;
  cancellation_reason: string | null;
  expected_return_quantity: string;
  asset_serials: string[];
  dispatched: string;
  received: string;
  outstanding: string;
  return_due: string;
  on_hand: string | null;
}

function toLine(row: LineRow): MaintenanceLine {
  return {
    id: row.id,
    position: Number(row.position),
    itemId: row.production_item_id,
    itemCode: row.item_code,
    description: row.description,
    unit: row.unit,
    purpose: row.purpose,
    quantity: row.quantity,
    outstandingQuantity: row.outstanding,
    dispatchedQuantity: row.dispatched,
    cancelledQuantity: row.cancelled_quantity,
    cancellationReason: row.cancellation_reason,
    expectedReturnQuantity: row.expected_return_quantity,
    receivedReturnQuantity: row.received,
    returnDueQuantity: row.return_due,
    onHand: row.on_hand,
    assetSerials: row.asset_serials,
    resolved: Number(row.outstanding) <= 0 && Number(row.return_due) <= 0,
  };
}

/**
 * Every material line with the four derived quantities, in one statement.
 *
 * The two derivations go through the SAME functions the guards use
 * (`app_private.maintenance_line_outstanding`,
 * `…_return_due`), so the screen's "left to dispatch" is the number the
 * database will actually enforce rather than a second arithmetic that
 * can disagree with it.
 */
async function readLines(
  tx: TransactionSql,
  organisationId: string,
  requestId: string,
): Promise<LineRow[]> {
  return tx<LineRow[]>`
    select l.id, l.position, l.production_item_id, i.item_code,
           l.description, l.unit, l.purpose,
           l.quantity::text as quantity,
           l.cancelled_quantity::text as cancelled_quantity,
           l.cancellation_reason,
           l.expected_return_quantity::text as expected_return_quantity,
           l.asset_serials,
           coalesce(
             (select sum(dl.quantity) from maintenance_dispatch_lines dl
              where dl.organisation_id = l.organisation_id
                and dl.maintenance_request_line_id = l.id), 0
           )::text as dispatched,
           coalesce(
             (select sum(rt.quantity) from maintenance_returns rt
              where rt.organisation_id = l.organisation_id
                and rt.maintenance_request_line_id = l.id), 0
           )::text as received,
           app_private.maintenance_line_outstanding(
             l.organisation_id, l.id)::text as outstanding,
           app_private.maintenance_line_return_due(
             l.organisation_id, l.id)::text as return_due,
           case
             when l.production_item_id is null then null
             else app_private.stock_on_hand(
               l.organisation_id, l.production_item_id)::text
           end as on_hand
    from maintenance_request_lines l
    left join production_items i
      on i.organisation_id = l.organisation_id and i.id = l.production_item_id
    where l.organisation_id = ${organisationId}
      and l.maintenance_request_id = ${requestId}
    order by l.position
  `;
}

/** The request, proven visible to this caller before anything is read or
 * written against it. RLS has already narrowed the table, so an unknown
 * id and another tenant's id answer identically — and so does a Work
 * this caller is not assigned to. */
async function requireRequest(
  tx: TransactionSql,
  scope: WorkScope,
  requestId: string,
  lock: boolean,
): Promise<RequestRow> {
  const rows = await tx<RequestRow[]>`
    select r.id, r.request_number, r.work_id, w.work_code, r.station,
           r.requester_name, r.requester_phone, r.priority, r.required_by::text,
           r.fault_summary, r.operational_impact, r.delivery_instructions,
           r.status, r.approval_comment, r.created_at
    from maintenance_requests r
    join works w on w.organisation_id = r.organisation_id and w.id = r.work_id
    where r.id = ${requestId} and ${visibleWork(tx, scope, 'r.work_id')}
    ${lock ? tx`for no key update of r` : tx``}
  `;
  const row = rows[0];
  if (!row) {
    throw httpError(
      404,
      'MAINTENANCE_REQUEST_NOT_FOUND',
      'No such maintenance request.',
    );
  }
  return row;
}

async function organisationToday(
  tx: TransactionSql,
  organisationId: string,
): Promise<string> {
  const [row] = await tx<{ today: string }[]>`
    select app_private.organisation_today(${organisationId})::text as today
  `;
  if (!row) throw new Error('organisation today returned no row');
  return row.today;
}

async function readDetail(
  tx: TransactionSql,
  scope: WorkScope,
  organisationId: string,
  requestId: string,
) {
  const request = await requireRequest(tx, scope, requestId, false);
  const lineRows = await readLines(tx, organisationId, requestId);
  const lines = lineRows.map(toLine);

  const dispatchRows = await tx<
    {
      id: string;
      challan_number: string;
      dispatch_date: string;
      stock_location: string;
      receiver_name: string;
      transporter: string | null;
      notes: string | null;
      lines: MaintenanceDispatch['lines'];
    }[]
  >`
    select d.id, d.challan_number, d.dispatch_date::text as dispatch_date,
           d.stock_location, d.receiver_name, d.transporter, d.notes,
           coalesce(
             (
               select json_agg(
                        json_build_object(
                          'lineId', dl.maintenance_request_line_id,
                          'description', l.description,
                          'unit', l.unit,
                          'quantity', dl.quantity::text
                        ) order by l.position
                      )
               from maintenance_dispatch_lines dl
               join maintenance_request_lines l
                 on l.organisation_id = dl.organisation_id
                and l.id = dl.maintenance_request_line_id
               where dl.organisation_id = d.organisation_id
                 and dl.maintenance_dispatch_id = d.id
             ),
             '[]'::json
           ) as lines
    from maintenance_dispatches d
    where d.organisation_id = ${organisationId}
      and d.maintenance_request_id = ${requestId}
    order by d.sequence_number desc
  `;

  const returnRows = await tx<
    {
      id: string;
      line_id: string;
      line_description: string;
      quantity: string;
      received_on: string;
      serials: string[];
      condition_note: string;
      repair_disposition: string;
      received_by: string;
      notes: string | null;
    }[]
  >`
    select rt.id, rt.maintenance_request_line_id as line_id,
           l.description as line_description, rt.quantity::text as quantity,
           rt.received_on::text as received_on, rt.serials, rt.condition_note,
           rt.repair_disposition, rt.received_by, rt.notes
    from maintenance_returns rt
    join maintenance_request_lines l
      on l.organisation_id = rt.organisation_id
     and l.id = rt.maintenance_request_line_id
    where rt.organisation_id = ${organisationId}
      and rt.maintenance_request_id = ${requestId}
    order by rt.received_on desc, rt.created_at desc
  `;

  const returns: MaintenanceReturn[] = returnRows.map((row) => ({
    id: row.id,
    lineId: row.line_id,
    lineDescription: row.line_description,
    quantity: row.quantity,
    receivedOn: row.received_on,
    serials: row.serials,
    conditionNote: row.condition_note,
    repairDisposition: row.repair_disposition,
    receivedBy: row.received_by,
    notes: row.notes,
  }));

  return {
    request: {
      ...toSummary(request),
      requesterPhone: request.requester_phone,
      operationalImpact: request.operational_impact,
      deliveryInstructions: request.delivery_instructions,
      approvalComment: request.approval_comment,
    },
    lines,
    dispatches: dispatchRows.map((row) => ({
      id: row.id,
      challanNumber: row.challan_number,
      dispatchDate: row.dispatch_date,
      stockLocation: row.stock_location,
      receiverName: row.receiver_name,
      transporter: row.transporter,
      notes: row.notes,
      lines: row.lines,
    })),
    returns,
    canClose: lines.length > 0 && lines.every((line) => line.resolved),
  };
}

// --- Routes -----------------------------------------------------------------

export function registerMaintenanceRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'GET',
      url: '/api/maintenance',
      schema: {
        querystring: MaintenanceListQuerySchema,
        response: { 200: MaintenanceListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { limit, cursor } = request.query;
      return tenant(async (tx) => {
        const scope = await scopeOf(tx, user.id);
        const proven = await workScopedCursorRowId(
          tx,
          'maintenance_requests',
          cursor,
          scope,
        );
        const rows = await tx<RequestRow[]>`
          select r.id, r.request_number, r.work_id, w.work_code, r.station,
                 r.requester_name, r.requester_phone, r.priority,
                 r.required_by::text, r.fault_summary, r.operational_impact,
                 r.delivery_instructions, r.status, r.approval_comment,
                 r.created_at
          from maintenance_requests r
          join works w on w.organisation_id = r.organisation_id and w.id = r.work_id
          where ${visibleWork(tx, scope, 'r.work_id')}
            and (${proven}::uuid is null or (r.created_at, r.id) < (
              select c.created_at, c.id
              from maintenance_requests c where c.id = ${proven}))
          order by r.created_at desc, r.id desc
          limit ${sqlLimit(limit)}
        `;
        // The stage strip counts the whole visible register, not the
        // page: a stat that described one page would disagree with the
        // list the moment anybody paged.
        const [counts] = await tx<
          {
            awaiting_approval: number;
            approved: number;
            partially_dispatched: number;
            closed: number;
          }[]
        >`
          select
            count(*) filter (where r.status = 'awaiting_approval')::int
              as awaiting_approval,
            count(*) filter (where r.status = 'approved')::int as approved,
            count(*) filter (where r.status = 'partially_dispatched')::int
              as partially_dispatched,
            count(*) filter (where r.status = 'closed')::int as closed
          from maintenance_requests r
          where ${visibleWork(tx, scope, 'r.work_id')}
        `;
        const page = keysetPage(rows, limit, (row) => row.id);
        return {
          requests: page.rows.map(toSummary),
          nextCursor: page.nextCursor,
          counts: {
            awaitingApproval: counts?.awaiting_approval ?? 0,
            approved: counts?.approved ?? 0,
            partiallyDispatched: counts?.partially_dispatched ?? 0,
            closed: counts?.closed ?? 0,
          },
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/maintenance/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: MaintenanceDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) =>
      tenant(async (tx) =>
        readDetail(
          tx,
          await scopeOf(tx, user.id),
          organisationId,
          request.params.id,
        ),
      ),
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/maintenance',
      role: 'writer',
      schema: {
        body: CreateMaintenanceRequestSchema,
        response: {
          201: Type.Object({ id: Type.String(), number: Type.String() }),
          ...errorResponses,
        },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const input = request.body;
      const created = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, input.workId);
        const [work] = await tx<{ work_code: string; status: string }[]>`
          select work_code, status from works where id = ${input.workId}
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'raising a maintenance request');

        // Each line's unit and description are SNAPSHOTS. For a line that
        // names a part they are copied from the master here rather than
        // taken from the caller, so a client cannot record a challan that
        // says a different part than the one whose stock it moves.
        const itemIds = [
          ...new Set(
            input.lines
              .map((line) => line.itemId)
              .filter((id): id is string => id !== undefined),
          ),
        ];
        const items =
          itemIds.length === 0
            ? []
            : await tx<{ id: string; name: string; unit: string }[]>`
                select id, name, unit from production_items
                where id = any(${itemIds}::uuid[]) and active
              `;
        const byId = new Map(items.map((item) => [item.id, item]));
        for (const id of itemIds) {
          if (!byId.has(id)) {
            throw httpError(
              404,
              'STOCK_ITEM_NOT_FOUND',
              'One of the parts on this request is not an active part.',
            );
          }
        }

        const today = await organisationToday(tx, organisationId);
        const fyLabel = financialYearLabel(today);
        // The upsert-returning shape every counter in this schema uses:
        // one statement, no read-then-write window, and the counter row
        // is the lock. A rolled-back request rolls its number back with
        // it, which is what keeps the series gap-free.
        const [counter] = await tx<{ sequence_number: number }[]>`
          insert into maintenance_request_counters
            (organisation_id, fy_label, next_value)
          values (${organisationId}, ${fyLabel}, 2)
          on conflict (organisation_id, fy_label) do update
          set next_value = maintenance_request_counters.next_value + 1,
              updated_at = now()
          returning (next_value - 1) as sequence_number
        `;
        if (!counter) throw new Error('maintenance counter returned no row');
        const sequence = Number(counter.sequence_number);
        const number = requestNumber(fyLabel, sequence);

        const [row] = await tx<{ id: string }[]>`
          insert into maintenance_requests (
            organisation_id, work_id, request_number, financial_year,
            sequence_number, station, requester_name, requester_phone,
            priority, required_by, fault_summary, operational_impact,
            delivery_instructions, created_by_user_id
          )
          values (
            ${organisationId}, ${input.workId}, ${number}, ${fyLabel},
            ${sequence}, ${input.station.trim()}, ${input.requesterName.trim()},
            ${optionalTrimmed(input.requesterPhone) ?? null}, ${input.priority},
            ${input.requiredBy ?? null}, ${input.faultSummary.trim()},
            ${optionalTrimmed(input.operationalImpact) ?? null},
            ${optionalTrimmed(input.deliveryInstructions) ?? null}, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!row) throw new Error('maintenance request insert returned no row');

        let position = 0;
        for (const line of input.lines) {
          position += 1;
          const item = line.itemId === undefined ? undefined : byId.get(line.itemId);
          await tx`
            insert into maintenance_request_lines (
              organisation_id, maintenance_request_id, production_item_id,
              description, unit, quantity, purpose, expected_return_quantity,
              asset_serials, position
            )
            values (
              ${organisationId}, ${row.id}, ${line.itemId ?? null},
              ${item?.name ?? line.description.trim()},
              ${item?.unit ?? line.unit.trim()},
              ${line.quantity}, ${optionalTrimmed(line.purpose) ?? null},
              ${line.expectedReturnQuantity}, ${line.assetSerials ?? []},
              ${position}
            )
          `.catch(rethrowWriteRefusal);
        }

        await audit(
          tx,
          organisationId,
          user.id,
          'maintenance_request.raised',
          'maintenance_requests',
          row.id,
          {
            requestNumber: number,
            workId: input.workId,
            station: input.station.trim(),
            priority: input.priority,
            lines: input.lines.length,
          },
        );
        return { id: row.id, number };
      });
      return reply.status(201).send(created);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/maintenance/:id/approve',
      // The mock's "whole-request admin approval". Raising a request is
      // site work; committing the store's material to it is not.
      role: 'owner',
      schema: {
        params: IdParamsSchema,
        body: ApproveMaintenanceRequestSchema,
        response: { 200: MaintenanceDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const comment = request.body.comment.trim();
      return tenant(async (tx) => {
        const scope = await scopeOf(tx, user.id);
        const existing = await requireRequest(tx, scope, id, true);
        if (existing.status !== 'awaiting_approval') {
          throw httpError(
            409,
            'MAINTENANCE_STATE_INVALID',
            'That request has already been approved.',
          );
        }
        await tx`
          update maintenance_requests
          set status = 'approved', approval_comment = ${comment},
              approved_by_user_id = ${user.id}, approved_at = now()
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'maintenance_request.approved',
          'maintenance_requests',
          id,
          { requestNumber: existing.request_number, comment },
        );
        return readDetail(tx, scope, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/maintenance/:id/dispatches',
      // The one act here that mints a numbered document and hands it to
      // somebody outside this office.
      authority: 'issue',
      schema: {
        params: IdParamsSchema,
        body: RecordMaintenanceDispatchSchema,
        response: { 200: MaintenanceDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const input = request.body;
      return tenant(async (tx) => {
        const scope = await scopeOf(tx, user.id);
        const existing = await requireRequest(tx, scope, id, true);
        if (!['approved', 'partially_dispatched'].includes(existing.status)) {
          throw httpError(
            409,
            'MAINTENANCE_STATE_INVALID',
            existing.status === 'closed'
              ? 'That request is closed.'
              : 'A request must be approved before material leaves the store.',
          );
        }

        const lines = await readLines(tx, organisationId, id);
        const byId = new Map(lines.map((line) => [line.id, line]));
        for (const requested of input.lines) {
          const line = byId.get(requested.lineId);
          if (!line) {
            throw httpError(
              404,
              'MAINTENANCE_LINE_NOT_FOUND',
              'That material line is not on this request.',
            );
          }
          if (Number(requested.quantity) > Number(line.outstanding)) {
            throw httpError(
              409,
              'MAINTENANCE_DISPATCH_EXCEEDS_OUTSTANDING',
              `${line.description} has ${line.outstanding} ${line.unit} left to dispatch.`,
            );
          }
        }

        const dispatchDate =
          input.dispatchDate ?? (await organisationToday(tx, organisationId));
        const [counter] = await tx<{ sequence_number: number }[]>`
          insert into maintenance_dispatch_counters
            (organisation_id, work_id, next_value)
          values (${organisationId}, ${existing.work_id}, 2)
          on conflict (organisation_id, work_id) do update
          set next_value = maintenance_dispatch_counters.next_value + 1,
              updated_at = now()
          returning (next_value - 1) as sequence_number
        `;
        if (!counter) throw new Error('maintenance dispatch counter returned no row');
        const challanNumber = dispatchChallanNumber(
          existing.work_code,
          Number(counter.sequence_number),
        );

        const [dispatch] = await tx<{ id: string }[]>`
          insert into maintenance_dispatches (
            organisation_id, maintenance_request_id, work_id, challan_number,
            sequence_number, dispatch_date, stock_location, receiver_name,
            transporter, notes, created_by_user_id
          )
          values (
            ${organisationId}, ${id}, ${existing.work_id}, ${challanNumber},
            ${Number(counter.sequence_number)}, ${dispatchDate},
            ${input.stockLocation.trim()}, ${input.receiverName.trim()},
            ${optionalTrimmed(input.transporter) ?? null},
            ${optionalTrimmed(input.notes) ?? null}, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!dispatch) throw new Error('maintenance dispatch insert returned no row');

        for (const requested of input.lines) {
          const line = byId.get(requested.lineId);
          if (!line) continue;
          await tx`
            insert into maintenance_dispatch_lines (
              organisation_id, maintenance_dispatch_id,
              maintenance_request_line_id, quantity
            )
            values (
              ${organisationId}, ${dispatch.id}, ${requested.lineId},
              ${requested.quantity}
            )
          `.catch(rethrowWriteRefusal);

          // MATERIAL LEAVING THE STORE IS A STOCK ISSUE. A line naming a
          // part posts one against the ledger, in this transaction,
          // naming this challan; a custom line has nothing on a shelf
          // behind it and posts nothing. The ledger's own guard refuses a
          // balance below zero, which is the real "is there any" check —
          // the screen's `onHand` is a reading, this is the rule.
          if (line.production_item_id !== null) {
            await tx`
              insert into stock_movements (
                organisation_id, production_item_id, movement_type, quantity,
                movement_date, maintenance_dispatch_id, created_by_user_id
              )
              values (
                ${organisationId}, ${line.production_item_id}, 'issue',
                ${`-${requested.quantity}`}, ${dispatchDate}, ${dispatch.id},
                ${user.id}
              )
            `.catch(rethrowWriteRefusal);
          }
        }

        if (existing.status !== 'partially_dispatched') {
          await tx`
            update maintenance_requests set status = 'partially_dispatched'
            where id = ${id}
          `.catch(rethrowWriteRefusal);
        }

        await audit(
          tx,
          organisationId,
          user.id,
          'maintenance_request.dispatched',
          'maintenance_requests',
          id,
          {
            requestNumber: existing.request_number,
            challanNumber,
            receiverName: input.receiverName.trim(),
            lines: input.lines.length,
          },
        );
        return readDetail(tx, scope, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/maintenance/:id/returns',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        body: ReceiveMaintenanceReturnSchema,
        response: { 200: MaintenanceDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const input = request.body;
      return tenant(async (tx) => {
        const scope = await scopeOf(tx, user.id);
        const existing = await requireRequest(tx, scope, id, true);
        if (existing.status === 'awaiting_approval') {
          throw httpError(
            409,
            'MAINTENANCE_STATE_INVALID',
            'Nothing has gone out against this request yet.',
          );
        }
        if (existing.status === 'closed') {
          throw httpError(409, 'MAINTENANCE_STATE_INVALID', 'That request is closed.');
        }
        const lines = await readLines(tx, organisationId, id);
        const line = lines.find((candidate) => candidate.id === input.lineId);
        if (!line) {
          throw httpError(
            404,
            'MAINTENANCE_LINE_NOT_FOUND',
            'That material line is not on this request.',
          );
        }
        if (Number(input.quantity) > Number(line.return_due)) {
          throw httpError(
            409,
            'MAINTENANCE_RETURN_EXCEEDS_EXPECTED',
            `${line.description} owes ${line.return_due} ${line.unit} back.`,
          );
        }
        const receivedOn =
          input.receivedOn ?? (await organisationToday(tx, organisationId));
        // NO STOCK MOVEMENT. A defective unit received for repair is not
        // available material: adding it to the balance would let somebody
        // dispatch it again. Migration 0088's header records the decision.
        await tx`
          insert into maintenance_returns (
            organisation_id, maintenance_request_id, maintenance_request_line_id,
            quantity, received_on, serials, condition_note, repair_disposition,
            received_by, notes, created_by_user_id
          )
          values (
            ${organisationId}, ${id}, ${input.lineId}, ${input.quantity},
            ${receivedOn}, ${input.serials ?? []}, ${input.conditionNote.trim()},
            ${input.repairDisposition.trim()}, ${input.receivedBy.trim()},
            ${optionalTrimmed(input.notes) ?? null}, ${user.id}
          )
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'maintenance_request.defect_received',
          'maintenance_requests',
          id,
          {
            requestNumber: existing.request_number,
            lineId: input.lineId,
            quantity: input.quantity,
            repairDisposition: input.repairDisposition.trim(),
          },
        );
        return readDetail(tx, scope, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/maintenance/:id/lines/:lineId/cancel',
      role: 'writer',
      schema: {
        params: Type.Composite(
          [IdParamsSchema, Type.Object({ lineId: IdParamsSchema.properties.id })],
          { additionalProperties: false },
        ),
        body: CancelMaintenanceLineSchema,
        response: { 200: MaintenanceDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id, lineId } = request.params;
      const reason = request.body.reason.trim();
      return tenant(async (tx) => {
        const scope = await scopeOf(tx, user.id);
        const existing = await requireRequest(tx, scope, id, true);
        if (existing.status === 'closed') {
          throw httpError(409, 'MAINTENANCE_STATE_INVALID', 'That request is closed.');
        }
        const lines = await readLines(tx, organisationId, id);
        const line = lines.find((candidate) => candidate.id === lineId);
        if (!line) {
          throw httpError(
            404,
            'MAINTENANCE_LINE_NOT_FOUND',
            'That material line is not on this request.',
          );
        }
        if (Number(line.cancelled_quantity) > 0) {
          throw httpError(
            409,
            'MAINTENANCE_REQUEST_IMMUTABLE',
            'That line is already written off; the cancellation is on the record.',
          );
        }
        if (Number(request.body.quantity) > Number(line.outstanding)) {
          throw httpError(
            409,
            'MAINTENANCE_DISPATCH_EXCEEDS_OUTSTANDING',
            `${line.description} has only ${line.outstanding} ${line.unit} left to write off; material already on a challan has left the store.`,
          );
        }
        await tx`
          update maintenance_request_lines
          set cancelled_quantity = ${request.body.quantity},
              cancellation_reason = ${reason}
          where id = ${lineId}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'maintenance_request.line_written_off',
          'maintenance_requests',
          id,
          {
            requestNumber: existing.request_number,
            lineId,
            quantity: request.body.quantity,
            reason,
          },
        );
        return readDetail(tx, scope, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/maintenance/:id/close',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        response: { 200: MaintenanceDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const scope = await scopeOf(tx, user.id);
        const existing = await requireRequest(tx, scope, id, true);
        if (existing.status === 'closed') {
          throw httpError(
            409,
            'MAINTENANCE_STATE_INVALID',
            'That request is already closed.',
          );
        }
        if (existing.status === 'awaiting_approval') {
          throw httpError(
            409,
            'MAINTENANCE_NOT_CLOSEABLE',
            'An unapproved request has nothing to close; approve it, or write its lines off first.',
          );
        }
        const lines = await readLines(tx, organisationId, id);
        const blocker = lines.find(
          (line) => Number(line.outstanding) > 0 || Number(line.return_due) > 0,
        );
        if (lines.length === 0 || blocker !== undefined) {
          throw httpError(
            409,
            'MAINTENANCE_NOT_CLOSEABLE',
            blocker === undefined
              ? 'That request has no material lines.'
              : `${blocker.description} still has material to dispatch or cancel, or defective units to receive.`,
          );
        }
        await tx`
          update maintenance_requests
          set status = 'closed', closed_by_user_id = ${user.id}, closed_at = now()
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'maintenance_request.closed',
          'maintenance_requests',
          id,
          { requestNumber: existing.request_number },
        );
        return readDetail(tx, scope, organisationId, id);
      });
    },
  );
}
