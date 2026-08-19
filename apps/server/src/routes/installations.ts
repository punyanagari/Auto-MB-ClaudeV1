import {
  byItemNumber,
  CancelInstallationRequestSchema,
  InstallationListResponseSchema,
  InstallationRegisterQuerySchema,
  InstallationRegisterResponseSchema,
  KeysetQuerySchema,
  InstallationSchema,
  RecordInstallationBatchRequestSchema,
  RecordInstallationBatchResponseSchema,
  RecordInstallationRequestSchema,
  type Installation,
  type RecordInstallationBatchRequest,
  type RecordInstallationRequest,
  type SerialOrigin,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import {
  cursorRowId,
  keysetPage,
  sqlLimit,
  workScopedCursorRowId,
} from '../pagination.js';
import { assertSourceNotBilled } from './measurement-books/index.js';
import { assertWorkOperable } from '../work-status.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * Milestone 7: quantity-level installation records (legacy spec §5.4,
 * rules R5/R6/R11). Mobile-friendly site entry: item, quantity, date,
 * location picked from the master or created inline (which is why record
 * runs under the evidence role, not the writer role — site staff create
 * the location they are standing at), remarks, and tap-selected serials
 * from the delivered-but-uninstalled pool. Recorded documents cancel with
 * a note and release their serials; they are never edited or deleted.
 */

interface InstallationRow {
  id: string;
  work_id: string;
  work_item_id: string;
  item_number: string;
  quantity: string;
  installed_on: string;
  location_id: string;
  location_name: string;
  remarks: string | null;
  status: Installation['status'];
  cancellation_note: string | null;
  serials: unknown;
  created_at: Date;
  cancelled_at: Date | null;
  pending_variation: boolean;
}

interface SerialLink {
  serialId: string;
  serialNumber: string;
  challanNumber: string | null;
  origin?: SerialOrigin;
}

function toInstallation(row: InstallationRow): Installation {
  const raw = parseJsonbColumn(row.serials);
  const serials: SerialLink[] = Array.isArray(raw)
    ? raw.filter(
        (entry): entry is SerialLink =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as SerialLink).serialId === 'string',
      )
    : [];
  return {
    id: row.id,
    workId: row.work_id,
    workItemId: row.work_item_id,
    itemNumber: row.item_number,
    quantity: row.quantity,
    installedOn: row.installed_on,
    locationId: row.location_id,
    locationName: row.location_name,
    remarks: row.remarks,
    status: row.status,
    cancellationNote: row.cancellation_note,
    serials,
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    // The ITEM's state, carried on the record because the recording
    // screen is where an operator learns they have just gone past the
    // sanction (migration 0077). Read from the column the database
    // derives, never recomputed here.
    pendingVariation: row.pending_variation,
  };
}

/** Shared SELECT: an installation with its attached serials (attachment
 * history included after cancellation; the UI shows released serials as
 * part of the cancelled record's story).
 *
 * The challan join is LEFT since migration 0108: a serial the Delivery
 * Challan missed and the site recorded carries no challan at all, and an
 * inner join would silently drop exactly the serials whose provenance is
 * the interesting one. `challanNumber` is null for those, and `origin`
 * says why rather than leaving a reader to infer it from the null. */
const INSTALLATION_COLUMNS = `
  i.id, i.work_id, i.work_item_id, wi.item_number,
  i.quantity::text as quantity, i.installed_on::text as installed_on,
  i.location_id, i.location_name, i.remarks, i.status, i.cancellation_note,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'serialId', s.id,
      'serialNumber', s.serial_number,
      'challanNumber', dc.challan_number,
      'origin', s.origin
    ) order by s.serial_number)
    from installation_serials att
    join challan_item_serials s on s.id = att.challan_item_serial_id
    left join delivery_challans dc on dc.id = s.delivery_challan_id
    where att.installation_id = i.id
  ), '[]'::jsonb) as serials,
  i.created_at, i.cancelled_at, wi.pending_variation
`;

async function readInstallation(
  tx: TransactionSql,
  id: string,
): Promise<InstallationRow | undefined> {
  const rows = (await tx.unsafe(
    `select ${INSTALLATION_COLUMNS}
     from installations i
     join work_items wi on wi.id = i.work_item_id
     where i.id = $1`,
    [id],
  )) as unknown as InstallationRow[];
  return rows[0];
}

/**
 * The item's variation state as the DATABASE now holds it — read AFTER
 * the write that may have moved it, never predicted before.
 *
 * The audit trail is the only place the shape of a variation stays
 * answerable: the flag on the item says an item is over-installed, this
 * says which recording took it over (or which cancellation brought it
 * back) and by how much. Cancellation is audited with the same three
 * fields as recording, because the cancel path is the one that CLEARS a
 * variation and a cleared variation with no trace is worse than an
 * opened one.
 */
async function readVariationState(
  tx: TransactionSql,
  workItemId: string,
): Promise<{
  pendingVariation: boolean;
  cumulativeInstalled: string;
  sanctionedQuantity: string;
}> {
  const [row] = await tx<
    { pending_variation: boolean; installed: string; sanctioned: string }[]
  >`
    select wi.pending_variation,
           coalesce((
             select sum(i.quantity) from installations i
             where i.work_item_id = wi.id and i.status = 'recorded'
           ), 0)::numeric(18,3)::text as installed,
           coalesce(wi.effective_quantity, wi.awarded_quantity)::text as sanctioned
    from work_items wi
    where wi.id = ${workItemId}
  `;
  if (!row) throw new Error('work item variation read-back returned no row');
  return {
    pendingVariation: row.pending_variation,
    cumulativeInstalled: row.installed,
    sanctionedQuantity: row.sanctioned,
  };
}

export function registerInstallationRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/installations',
      schema: {
        params: IdParamsSchema,
        querystring: KeysetQuerySchema,
        response: { 200: InstallationListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const query = request.query;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        // Newest installation first, so the keyset runs backward on
        // (installed_on, created_at, id) — the trailing id turned
        // descending to match the comparison, which only reorders records
        // sharing both a date and a creation instant.
        // The cursor must name an installation OF THIS WORK — an id from
        // another Work is refused as CURSOR_INVALID, indistinguishable
        // from a nonexistent one; see `cursorRowId` for the oracle this
        // closes.
        const cursor = await cursorRowId(tx, 'installations', query.cursor, workId);
        const rows = (await tx.unsafe(
          `select ${INSTALLATION_COLUMNS}
           from installations i
           join work_items wi on wi.id = i.work_item_id
           where i.work_id = $1
             and ($2::uuid is null
               or (i.installed_on, i.created_at, i.id) < (
                 select c.installed_on, c.created_at, c.id
                 from installations c where c.id = $2::uuid))
           order by i.installed_on desc, i.created_at desc, i.id desc
           limit $3`,
          [workId, cursor, sqlLimit(query.limit)],
        )) as unknown as InstallationRow[];
        const paged = keysetPage(rows, query.limit, (row) => row.id);
        // THE authoritative installed quantity per item: SUM(quantity)
        // over non-cancelled installation records, computed in SQL
        // numeric arithmetic. Milestone 8 stage-wise billing consumes
        // exactly this aggregate — do not derive installed quantities
        // anywhere else.
        const summaries = await tx<
          { work_item_id: string; item_number: string; installed_quantity: string }[]
        >`
          select wi.id as work_item_id, wi.item_number,
                 coalesce((
                   select sum(i.quantity) from installations i
                   where i.work_item_id = wi.id and i.status = 'recorded'
                 ), 0)::text as installed_quantity
          from work_items wi
          where wi.work_id = ${workId} and wi.deleted_at is null
          order by wi.item_number
        `;
        return {
          installations: paged.rows.map(toInstallation),
          nextCursor: paged.nextCursor,
          // Natural order: `item_number` is text and the SQL sorts A1/10
          // before A1/2.
          itemSummaries: byItemNumber(
            summaries.map((summary) => ({
              workItemId: summary.work_item_id,
              itemNumber: summary.item_number,
              installedQuantity: summary.installed_quantity,
            })),
          ),
        };
      });
    },
  );

  // ------------------------------------------------------------------
  // The tenant-wide installation register.
  //
  // An installation always belongs to a Work, so this adds no new kind of
  // record and no new authority: it is the same rows the Work's own
  // Installations tab lists, read across every Work the caller may see.
  // What it buys is the question the per-Work list cannot answer — "what
  // went in this week, anywhere" — which site supervision asks far more
  // often than it asks about one contract. That question is a date range,
  // which is why the register's one filter is a date window.
  // ------------------------------------------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/installations',
      schema: {
        querystring: InstallationRegisterQuerySchema,
        response: { 200: InstallationRegisterResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const query = request.query;
      return tenant(async (tx) => {
        // Work-scope, decided in SQL so the rows an 'assigned'-scoped
        // member may not see never leave the database. This is the same
        // predicate the Delivery Challan register uses, and it is the
        // ONLY thing standing between the two scopes here: there is no
        // per-row `assertWorkAccess` to fall back on in a list.
        const full = await hasFullWorkScope(tx, user.id);
        // Newest first, so the keyset runs backward on
        // (installed_on, created_at, id) — the same ordering, and the
        // same trailing descending id, as the per-Work list above. The
        // cursor is proven against the work-scope predicate too, not only
        // against the tenant: see `workScopedCursorRowId` for the oracle
        // an organisation-wide cursor check leaves behind.
        const cursor = await workScopedCursorRowId(tx, 'installations', query.cursor, {
          userId: user.id,
          full,
        });
        const installedFrom = query.installedFrom ?? null;
        const installedTo = query.installedTo ?? null;
        const rows = await tx<
          {
            id: string;
            work_id: string;
            work_code: string;
            work_title: string;
            work_item_id: string;
            item_number: string;
            quantity: string;
            installed_on: string;
            location_name: string;
            serial_count: string;
            status: Installation['status'];
          }[]
        >`
          select i.id, i.work_id, w.work_code, w.title as work_title,
                 i.work_item_id, wi.item_number,
                 i.quantity::text as quantity,
                 i.installed_on::text as installed_on,
                 i.location_name,
                 serials.serial_count::text as serial_count,
                 i.status
          from installations i
          join work_items wi on wi.id = i.work_item_id
          join works w on w.id = i.work_id
          -- One join over the attachment table for the whole page, in
          -- place of a per-row correlated count: the Delivery Challan
          -- register's line-count shape, for the same reason.
          cross join lateral (
            select count(*) as serial_count
            from installation_serials att
            where att.installation_id = i.id
          ) serials
          where w.deleted_at is null
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = i.work_id and wa.user_id = ${user.id}
            ))
            -- The date window, both bounds inclusive and either omittable.
            and (${installedFrom}::date is null or i.installed_on >= ${installedFrom}::date)
            and (${installedTo}::date is null or i.installed_on <= ${installedTo}::date)
            and (${cursor === null} or
              (i.installed_on, i.created_at, i.id) < (
                select c.installed_on, c.created_at, c.id from installations c
                where c.id = ${cursor}))
          order by i.installed_on desc, i.created_at desc, i.id desc
          limit ${sqlLimit(query.limit)}
        `;
        const paged = keysetPage(rows, query.limit, (row) => row.id);
        return {
          nextCursor: paged.nextCursor,
          installations: paged.rows.map((row) => ({
            id: row.id,
            workId: row.work_id,
            workCode: row.work_code,
            workTitle: row.work_title,
            workItemId: row.work_item_id,
            itemNumber: row.item_number,
            quantity: row.quantity,
            installedOn: row.installed_on,
            locationName: row.location_name,
            serialCount: Number(row.serial_count),
            status: row.status,
          })),
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/installations',
      schema: {
        params: IdParamsSchema,
        body: RecordInstallationRequestSchema,
        response: { 201: InstallationSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      assertOneLocationChoice(body);
      const installation = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        await lockWorkForRecording(tx, workId);
        const location = await resolveLocation(tx, organisationId, user.id, body);
        return recordOneInstallation(
          tx,
          {
            workId,
            organisationId,
            userId: user.id,
            installedOn: body.installedOn,
            location,
            remarks: body.remarks ?? null,
          },
          {
            workItemId: body.workItemId,
            quantity: body.quantity,
            serials: { kind: 'ids', values: body.serialIds ?? [] },
          },
        );
      });
      return reply.status(201).send(installation);
    },
  );

  // ------------------------------------------------------------------
  // One site visit, several items.
  //
  // The single route above records ONE item, and that was the shape of
  // the form rather than the shape of the work: a crew installs six items
  // at one station on one day, and typed the date and the station six
  // times with six chances to disagree with itself. Here the date, the
  // location and the remark are stated once and each filled row becomes
  // its own installation record — the same rows the single route writes,
  // so measurement, PAC coverage, the delivered cap and the variation
  // flag all read them without knowing which route wrote them.
  //
  // ONE TRANSACTION, all or nothing. Half a site visit recorded is worse
  // than none: the operator would have to work out which half, from a
  // screen that had already reset. The Work row is locked once for the
  // whole batch, and the rows are processed in work-item id order so two
  // concurrent batches over overlapping items take the item locks in the
  // same order and queue instead of deadlocking.
  // ------------------------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/installations/batch',
      schema: {
        params: IdParamsSchema,
        body: RecordInstallationBatchRequestSchema,
        response: { 201: RecordInstallationBatchResponseSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body: RecordInstallationBatchRequest = request.body;
      assertOneLocationChoice(body);
      // An item appears once per visit. Summing two rows would be the
      // friendlier guess and the wrong one: two quantities for one item on
      // one day is a mistyped row far more often than it is two crews.
      const items = new Set(body.rows.map((row) => row.workItemId));
      if (items.size !== body.rows.length) {
        throw httpError(
          409,
          'INSTALLATION_ROWS_DUPLICATED',
          'The same Work item appears on more than one row of this site visit.',
        );
      }
      const installations = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        await lockWorkForRecording(tx, workId);
        const location = await resolveLocation(tx, organisationId, user.id, body);
        const context = {
          workId,
          organisationId,
          userId: user.id,
          installedOn: body.installedOn,
          location,
          remarks: body.remarks ?? null,
        };
        // Deterministic lock order across concurrent batches; the answer
        // is put back in the caller's row order below, because a row that
        // was refused has to be findable by the position it was sent in.
        const ordered = [...body.rows].sort((left, right) =>
          left.workItemId.localeCompare(right.workItemId),
        );
        const written = new Map<string, Installation>();
        for (const row of ordered) {
          written.set(
            row.workItemId,
            await recordOneInstallation(tx, context, {
              workItemId: row.workItemId,
              quantity: row.quantity,
              serials: { kind: 'numbers', values: row.serialNumbers ?? [] },
            }),
          );
        }
        return body.rows.map((row) => {
          const installation = written.get(row.workItemId);
          if (!installation) throw new Error('batch row lost between order and answer');
          return installation;
        });
      });
      return reply.status(201).send({ installations });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/installations/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelInstallationRequestSchema,
        response: { 200: InstallationSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        // The row lock serialises cancellation against a concurrent
        // cancel; whichever wins, the loser sees the final status.
        const [existing] = await tx<
          {
            work_id: string;
            work_item_id: string;
            status: string;
            item_number: string;
          }[]
        >`
          select i.work_id, i.work_item_id, i.status, wi.item_number
          from installations i
          join work_items wi on wi.id = i.work_item_id
          where i.id = ${id}
          for update of i
        `;
        if (!existing) {
          throw httpError(
            404,
            'INSTALLATION_NOT_FOUND',
            'No such installation record.',
          );
        }
        await assertWorkAccess(tx, user.id, existing.work_id);
        if (existing.status !== 'recorded') {
          throw httpError(
            409,
            'INSTALLATION_ALREADY_CANCELLED',
            'This installation record is already cancelled.',
          );
        }
        // R8: cancelling this record would drop the installed quantity
        // the completion predicate was measured against, leaving a Work
        // that says 'completed' below 100% executed. Lock order is the
        // recording path's — own row first, then works, then work_items —
        // so cancel and completion serialise; the 0032 installation
        // update guard backstops the refusal in the database.
        const [work] = await tx<{ status: string }[]>`
          select status from works
          where id = ${existing.work_id} and deleted_at is null
          for update
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'cancelling an installation record');
        // R19: an installation billed in a live Measurement Book cannot
        // be cancelled — the MB must be cancelled first (the 0024
        // database guard backstops this against every writer).
        await assertSourceNotBilled(tx, 'installation', id);
        // R18: cancelling may not leave PAC-certified quantity above
        // the remaining installed quantity for the item — the covering
        // certificate(s) must cancel first. The work_items row lock
        // serialises this read against concurrent PAC recording (which
        // locks the same row before certifying), and the 0027 database
        // guard backstops it against every writer.
        await tx`
          select id from work_items where id = ${existing.work_item_id}
          for update
        `;
        const [coverage] = await tx<
          { certified: string; remaining: string; uncovered: boolean }[]
        >`
          select certified.total::text as certified,
                 remaining.total::text as remaining,
                 (certified.total > remaining.total) as uncovered
          from (
            select coalesce(sum(pci.certified_quantity), 0)::numeric(18,3) as total
            from pac_certificate_items pci
            join pac_certificates pc on pc.id = pci.pac_certificate_id
            where pci.work_item_id = ${existing.work_item_id}
              and pc.status = 'recorded'
          ) certified,
          (
            select coalesce(sum(i.quantity), 0)::numeric(18,3) as total
            from installations i
            where i.work_item_id = ${existing.work_item_id}
              and i.status = 'recorded' and i.id <> ${id}
          ) remaining
        `;
        if (coverage?.uncovered === true) {
          const covering = await tx<{ reference: string; certified: string }[]>`
            select pc.reference,
                   sum(pci.certified_quantity)::numeric(18,3)::text as certified
            from pac_certificate_items pci
            join pac_certificates pc on pc.id = pci.pac_certificate_id
            where pci.work_item_id = ${existing.work_item_id}
              and pc.status = 'recorded'
            group by pc.reference
            order by pc.reference
          `;
          const names = covering
            .map((row) => `${row.reference} (${row.certified})`)
            .join('; ');
          throw httpError(
            409,
            'INSTALLATION_COVERED_BY_PAC',
            `Cancelling this installation would leave PAC-certified quantity ${coverage.certified} above the remaining installed quantity ${coverage.remaining} for ${existing.item_number} (R18). Cancel the covering PAC certificate(s) first: ${names}.`,
          );
        }
        // A live defect liability period rests on this record: cancelling
        // it would remove the ground the period stands on while the
        // railway is still holding a Performance Bank Guarantee measured
        // against its expiry. The own-row lock taken above serialises this
        // against a period being started concurrently — the 0099 insert
        // guard takes a share lock on the same installation row — and the
        // 0099 cancel guard backstops the refusal against every writer.
        const [warranty] = await tx<
          { status: string; dlp_expires_on: string; closed_on: string | null }[]
        >`
          select status, dlp_expires_on::text as dlp_expires_on,
                 closed_on::text as closed_on
          from installation_warranties
          where installation_id = ${id} and status <> 'voided'
        `;
        if (warranty) {
          // A DISCHARGED period is a completed legal cycle, and there is
          // deliberately no way back through it: the record it rests on
          // is permanent from that point, exactly as an issued document
          // is. The message says so rather than pointing at a void that
          // the 0099 guard would refuse.
          throw httpError(
            409,
            'INSTALLATION_HAS_WARRANTY_PERIOD',
            warranty.status === 'closed'
              ? `This installation's defect liability period was discharged on ${warranty.closed_on ?? warranty.dlp_expires_on}; the record it rests on is permanent and is not cancelled.`
              : `This installation carries a defect liability period running to ${warranty.dlp_expires_on}. Void the period on the Work's Instruments tab first.`,
          );
        }
        await tx`
          update installations
          set status = 'cancelled', cancellation_note = ${body.note},
              cancelled_by_user_id = ${user.id}, cancelled_at = now()
          where id = ${id}
        `;
        // Release the serials back to the delivered-but-uninstalled pool
        // (R6: cancel releases serials). The attachment rows stay as
        // history with released_at set; the serials' installed_on clears
        // so the per-serial trace agrees the units are out again.
        const released = await tx<{ challan_item_serial_id: string }[]>`
          update installation_serials
          set released_at = now()
          where installation_id = ${id} and released_at is null
          returning challan_item_serial_id
        `;
        if (released.length > 0) {
          await tx`
            update challan_item_serials
            set installed_on = null
            where id = any(${released.map((r) => r.challan_item_serial_id)}::uuid[])
          `;
        }
        const full = await readInstallation(tx, id);
        if (!full) throw new Error('installation read-back returned no row');
        const variation = await readVariationState(tx, existing.work_item_id);
        await audit(
          tx,
          organisationId,
          user.id,
          'installation.cancelled',
          'installations',
          id,
          {
            before: { status: 'recorded' },
            after: { status: 'cancelled' },
            itemNumber: existing.item_number,
            note: body.note,
            releasedSerialCount: released.length,
            ...variation,
          },
        );
        return toInstallation(full);
      });
    },
  );
}

/** Exactly one of the two location choices, for both recording routes. */
function assertOneLocationChoice(body: {
  readonly locationId?: string;
  readonly newLocation?: unknown;
}): void {
  if ((body.locationId === undefined) === (body.newLocation === undefined)) {
    throw httpError(
      400,
      'LOCATION_CHOICE_INVALID',
      'Pick an existing location or name a new one — exactly one of the two.',
    );
  }
}

/**
 * The Work-level gate both recording routes pass, once per request.
 *
 * The works row lock pairs with the one the MB finalize transaction holds,
 * so recording and a final-MB finalize on the same Work serialise: an
 * installation recorded first is caught by the final sweep, and a final MB
 * finalized first makes this recording fail the FINAL_MB_EXISTS check
 * below (the 0027 insert guard backstops it in the database). Lock order
 * works -> work_items matches every other writer taking both, and the
 * batch route relies on it: it takes this ONE Work lock and then the item
 * locks in id order inside `recordOneInstallation`.
 */
async function lockWorkForRecording(tx: TransactionSql, workId: string): Promise<void> {
  const [workRow] = await tx<{ id: string; status: string }[]>`
    select id, status from works where id = ${workId} and deleted_at is null
    for update
  `;
  if (!workRow) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

  // R8: a completed Work accepts no new operational documents. The works
  // lock above serialises this against completion, and the 0031 insert
  // guard backstops it in the database.
  assertWorkOperable(workRow.status, 'recording an installation');

  // A live final Measurement Book closes the Work's payment cycle (spec
  // §5.9): an installation recorded after it could never be billed, so the
  // recording is refused outright.
  const [finalBook] = await tx<{ id: string; mb_number: string | null }[]>`
    select id, mb_number from measurement_books
    where work_id = ${workId} and is_final and status <> 'cancelled'
  `;
  if (finalBook) {
    throw httpError(
      409,
      'FINAL_MB_EXISTS',
      `The final Measurement Book ${finalBook.mb_number ?? finalBook.id} closes this Work's payment cycle; an installation recorded now could never be billed.`,
    );
  }
}

/** What a recording route settles once for the whole request. */
interface RecordingContext {
  readonly workId: string;
  readonly organisationId: string;
  readonly userId: string;
  readonly installedOn: string;
  readonly location: { readonly id: string; readonly name: string };
  readonly remarks: string | null;
}

/**
 * How the serials covering one row were named.
 *
 * `ids` is the tap-select flow: the caller picked rows out of the
 * delivered-but-uninstalled pool it was shown, so every id must already
 * exist. `numbers` is the site flow, where a number NOT in the pool is not
 * an error — it is the nameplate the Delivery Challan missed, and it is
 * recorded as entering here (migration 0108).
 */
type SerialRequest =
  | { readonly kind: 'ids'; readonly values: readonly string[] }
  | { readonly kind: 'numbers'; readonly values: readonly string[] };

interface RecordingRow {
  readonly workItemId: string;
  readonly quantity: string;
  readonly serials: SerialRequest;
}

/** One serial as both resolvers need to judge it. `work_item_id` comes
 * from the challan line for a delivered serial and from the serial itself
 * for one added at installation — the coalesce is migration 0108's shape,
 * and both branches are NULL for neither. */
const SERIAL_COLUMNS = `
  s.id, s.work_id, s.origin, s.serial_number,
  coalesce(dci.work_item_id, s.work_item_id) as work_item_id,
  s.installed_on::text as installed_on,
  dc.status as challan_status, dc.challan_date::text as challan_date,
  exists (
    select 1 from installation_serials att
    where att.challan_item_serial_id = s.id and att.released_at is null
  ) as attached
  from challan_item_serials s
  left join delivery_challan_items dci on dci.id = s.delivery_challan_item_id
  left join delivery_challans dc on dc.id = s.delivery_challan_id
`;

interface SerialRow {
  id: string;
  work_id: string;
  origin: SerialOrigin;
  serial_number: string;
  work_item_id: string | null;
  installed_on: string | null;
  challan_status: string | null;
  challan_date: string | null;
  attached: boolean;
}

/**
 * R6, for one serial, whichever way it was named.
 *
 * The delivery checks are conditioned on the origin rather than on the
 * challan being null, because "no challan" has exactly one legitimate
 * meaning and inferring it from a null would also swallow a corrupted
 * delivery row.
 */
function assertSerialInstallable(
  serial: SerialRow,
  row: { readonly workItemId: string },
  installedOn: string,
): void {
  if (serial.work_item_id !== row.workItemId) {
    throw httpError(
      409,
      'SERIAL_ITEM_MISMATCH',
      `Serial ${serial.serial_number} belongs to a different item.`,
    );
  }
  if (serial.origin === 'delivery') {
    if (serial.challan_status !== 'issued') {
      throw httpError(
        409,
        'SERIAL_NOT_DELIVERED',
        `Serial ${serial.serial_number} is not delivered yet — its challan is not issued.`,
      );
    }
    if (serial.challan_date !== null && installedOn < serial.challan_date) {
      throw httpError(
        409,
        'SERIAL_BEFORE_DELIVERY',
        `Serial ${serial.serial_number} was delivered on ${serial.challan_date}; it cannot be installed before that.`,
      );
    }
  }
  if (serial.installed_on !== null || serial.attached) {
    throw httpError(
      409,
      'SERIAL_ALREADY_INSTALLED',
      `Serial ${serial.serial_number} is already installed.`,
    );
  }
}

/**
 * The tap-select flow: every id must name a serial of THIS Work.
 *
 * The row locks make attachment atomic against a concurrent recording
 * selecting the same physical unit: the loser re-reads a serial that is
 * already installed and gets a conflict, and the partial unique index on
 * live attachments backs the check in the database.
 */
async function resolveSerialsById(
  tx: TransactionSql,
  context: RecordingContext,
  row: RecordingRow,
  ids: readonly string[],
): Promise<{ readonly ids: readonly string[]; readonly added: number }> {
  const serials = (await tx.unsafe(
    `select ${SERIAL_COLUMNS} where s.id = any($1::uuid[]) for update of s`,
    [ids as string[]],
  )) as unknown as SerialRow[];
  const byId = new Map(serials.map((serial) => [serial.id, serial]));
  // First pass — existence within THIS Work. A serial of another Work
  // answers exactly like an unknown id (the assertWorkAccess 404
  // discipline): no state-specific 409 may confirm a serial outside the
  // caller's scope exists, whatever its state.
  for (const id of ids) {
    const serial = byId.get(id);
    if (!serial || serial.work_id !== context.workId) {
      throw httpError(404, 'SERIAL_NOT_FOUND', 'No such serial record.');
    }
  }
  // Second pass — state checks, now that every serial is proven to belong
  // to the target Work.
  for (const id of ids) {
    const serial = byId.get(id);
    if (!serial) throw httpError(404, 'SERIAL_NOT_FOUND', 'No such serial record.');
    assertSerialInstallable(serial, row, context.installedOn);
  }
  return { ids, added: 0 };
}

/**
 * The site flow: numbers, and a number the record has never seen is
 * ACCEPTED.
 *
 * The owner's rule, verbatim: "if missing serial in DC is added in IC then
 * accept it and record it." A Delivery Challan is typed from a despatch
 * note and a nameplate missed there is discovered by the person standing
 * in front of the equipment. Before migration 0108 that serial had nowhere
 * to go — refused as SERIAL_NOT_FOUND, so the unit went in untraceable, or
 * an issued document was edited, which issued documents do not do.
 *
 * Matching is exact, which is the same match `POST /api/challans/:id/serials`
 * makes and the same one the unique index makes. A number differing only in
 * case is therefore a NEW unit here; normalising case would be a decision
 * about every serial in the product, not one this flow may take alone.
 */
async function resolveSerialsByNumber(
  tx: TransactionSql,
  context: RecordingContext,
  row: RecordingRow,
  numbers: readonly string[],
): Promise<{ readonly ids: readonly string[]; readonly added: number }> {
  const existing = (await tx.unsafe(
    `select ${SERIAL_COLUMNS}
     where s.work_id = $1 and s.serial_number = any($2::text[])
     for update of s`,
    [context.workId, numbers as string[]],
  )) as unknown as SerialRow[];
  const byNumber = new Map(existing.map((serial) => [serial.serial_number, serial]));
  for (const serial of existing) {
    assertSerialInstallable(serial, row, context.installedOn);
  }

  const fresh = numbers.filter((number) => !byNumber.has(number));
  if (fresh.length > 0) {
    // The insert is one statement, so a concurrent recording of the same
    // number loses on the unique index rather than on a check both
    // transactions passed. The 0108 CHECK holds the shape: an
    // installation-origin serial carries its item and no challan.
    const created = (await tx<{ id: string; serial_number: string }[]>`
      insert into challan_item_serials (
        organisation_id, work_id, work_item_id, serial_number, origin
      )
      select ${context.organisationId}, ${context.workId}, ${row.workItemId},
             requested.serial_number, 'installation'
      from unnest(${fresh}::text[]) as requested(serial_number)
      returning id, serial_number
    `.catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === '23505') {
        throw httpError(
          409,
          'DUPLICATE_SERIAL',
          'One of these serials was recorded in this Work concurrently; reload the item and retry.',
        );
      }
      throw error;
    })) as { id: string; serial_number: string }[];
    for (const serial of created) {
      byNumber.set(serial.serial_number, {
        id: serial.id,
        work_id: context.workId,
        origin: 'installation',
        serial_number: serial.serial_number,
        work_item_id: row.workItemId,
        installed_on: null,
        challan_status: null,
        challan_date: null,
        attached: false,
      });
    }
  }

  return {
    ids: numbers.map((number) => {
      const serial = byNumber.get(number);
      if (!serial) throw new Error('serial lost between insert and read-back');
      return serial.id;
    }),
    added: fresh.length,
  };
}

/**
 * ONE installation record: R5, R6 and R11 for a single item, written under
 * locks the caller has already taken at the Work level.
 *
 * Both recording routes go through here, which is the point — the rules
 * below were the body of the single route, and a batch route that restated
 * them would be a second reading of the same facts. Two readings of one
 * fact is how they drift.
 */
async function recordOneInstallation(
  tx: TransactionSql,
  context: RecordingContext,
  row: RecordingRow,
): Promise<Installation> {
  // The item row lock serialises every installation recording for this
  // item: both caps below read committed sums under the lock, so
  // concurrent recordings cannot jointly breach them (same discipline as
  // the MB delivered-quantity cap).
  const [item] = await tx<
    {
      id: string;
      item_number: string;
      requires_serials: boolean;
      payment_category: string | null;
      loa_quantity: string;
      letter_date: string;
      today: string;
    }[]
  >`
    select wi.id, wi.item_number, wi.requires_serials,
           wi.payment_category,
           coalesce(wi.effective_quantity, wi.awarded_quantity)::text as loa_quantity,
           w.letter_date::text as letter_date,
           (now() at time zone o.timezone)::date::text as today
    from work_items wi
    join works w on w.id = wi.work_id
    join organisations o on o.id = w.organisation_id
    where wi.id = ${row.workItemId} and wi.work_id = ${context.workId}
      and wi.deleted_at is null and w.deleted_at is null
    for update of wi
  `;
  if (!item) {
    throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
  }

  // An AMC item is never installed (migration 0068): annual maintenance is
  // served over a period and certified, and the 0068 trigger refuses the
  // row against every writer. Said here with a code and a remedy, under
  // the item row lock above, so the operator reads a sentence instead of
  // a 500.
  if (item.payment_category === 'AMC') {
    throw httpError(
      409,
      'ITEM_NOT_INSTALLABLE',
      `${item.item_number} is an annual maintenance item: maintenance is served over a period and certified by the railway, not installed. Record the acceptance certificate for the period served instead.`,
      { workItemId: item.id, itemNumber: item.item_number },
    );
  }

  // R11, friendly form (the 0017 trigger holds it against every writer):
  // not in the future in the organisation's timezone, not before the LOA
  // letter date.
  if (context.installedOn > item.today) {
    throw httpError(
      400,
      'INSTALLATION_DATE_FUTURE',
      `The installation date cannot be in the future (today is ${item.today}).`,
    );
  }
  if (context.installedOn < item.letter_date) {
    throw httpError(
      400,
      'INSTALLATION_DATE_BEFORE_LOA',
      `The installation date cannot precede the LOA letter date ${item.letter_date}.`,
    );
  }

  // R5, first half, as the owner settled it on 2026-08-17: the sanctioned
  // quantity no longer caps INSTALLATION. Work goes in before the
  // variation order that sanctions it arrives, and refusing the record
  // refuses the measurement without stopping the units — so the excess is
  // recorded and the item is flagged as owing a variation instead. There
  // is no check here at all: migration 0077's trigger derives
  // work_items.pending_variation from the committed sum, under the item
  // row lock this transaction already holds, and the flag is READ BACK
  // below rather than predicted here. Two readings of one fact is how they
  // drift.
  //
  // What the lifted cap does NOT lift: the sanctioned quantity still binds
  // BILLING (clampToSanctioned in mb-compute.ts bills min(measured,
  // sanctioned)) and still decides COMPLETION (work-completion.ts measures
  // equality), so an unsanctioned excess can be measured but never
  // invoiced or closed on. Delivery-cap semantics — including the
  // excess-delivery toggle, which never reached this rule — are untouched.

  // R5, second half: supply-type items cannot be installed beyond what
  // issued Delivery Challans delivered. Milestone 7 knows "supply-type"
  // only through the requires_serials flag; the category-based refinement
  // (Supply / Supply+Installation / Spare Supply / supply % > 0) arrives
  // with the Milestone 8 payment categories and extends this predicate —
  // the delivered sum below is already the shape it will reuse.
  if (item.requires_serials) {
    const [deliveredCap] = await tx<{ exceeded: boolean }[]>`
      select (
        coalesce((
          select sum(quantity) from installations
          where work_item_id = ${row.workItemId} and status = 'recorded'
        ), 0) + ${row.quantity}::numeric(18,3)
      ) > coalesce((
        select sum(dci.quantity)
        from delivery_challan_items dci
        join delivery_challans dc on dc.id = dci.delivery_challan_id
        where dci.work_item_id = ${row.workItemId}
          and dc.status = 'issued'
      ), 0) as exceeded
    `;
    if (deliveredCap?.exceeded === true) {
      throw httpError(
        409,
        'INSTALLATION_EXCEEDS_DELIVERY',
        `Cumulative installation for ${item.item_number} would exceed the delivered quantity — create and issue the Delivery Challan first.`,
      );
    }
  }

  // Serial attachment (R6): exactly one serial per unit for serial-flagged
  // items, none otherwise. The rule is unchanged by migration 0108 — what
  // changed is where an accepted serial may come from, not how many are
  // needed.
  const requested = row.serials.values;
  if (new Set(requested).size !== requested.length) {
    throw httpError(
      400,
      'SERIALS_DUPLICATED',
      'The same serial is selected more than once.',
    );
  }
  if (item.requires_serials) {
    const units = Number(row.quantity);
    if (!Number.isInteger(units) || requested.length !== units) {
      throw httpError(
        409,
        'SERIAL_COUNT_MISMATCH',
        `${item.item_number} tracks serials: select exactly one serial per installed unit (${row.quantity} needed, ${String(requested.length)} selected).`,
      );
    }
  } else if (requested.length > 0) {
    throw httpError(
      409,
      'SERIALS_NOT_TRACKED',
      `${item.item_number} does not track serial numbers; record the quantity without serials.`,
    );
  }

  const resolved =
    requested.length === 0
      ? { ids: [] as readonly string[], added: 0 }
      : row.serials.kind === 'ids'
        ? await resolveSerialsById(tx, context, row, requested)
        : await resolveSerialsByNumber(tx, context, row, requested);
  const serialIds = [...resolved.ids];

  const [inserted] = await tx<{ id: string }[]>`
    insert into installations (
      organisation_id, work_id, work_item_id, quantity, installed_on,
      location_id, location_name, remarks, recorded_by_user_id
    )
    values (
      ${context.organisationId}, ${context.workId}, ${row.workItemId},
      ${row.quantity}, ${context.installedOn}, ${context.location.id},
      ${context.location.name}, ${context.remarks}, ${context.userId}
    )
    returning id
  `;
  if (!inserted) throw new Error('installation insert returned no row');

  if (serialIds.length > 0) {
    await tx`
      insert into installation_serials (
        organisation_id, installation_id, work_id, challan_item_serial_id
      )
      select ${context.organisationId}, ${inserted.id}, ${context.workId}, serial_id
      from unnest(${serialIds}::uuid[]) as serial_id
    `;
    // Keep the per-serial trace coherent: attachment IS the serial's
    // installation fact.
    await tx`
      update challan_item_serials
      set installed_on = ${context.installedOn}
      where id = any(${serialIds}::uuid[])
    `;
  }

  const full = await readInstallation(tx, inserted.id);
  if (!full) throw new Error('installation read-back returned no row');
  const variation = await readVariationState(tx, row.workItemId);
  await audit(
    tx,
    context.organisationId,
    context.userId,
    'installation.recorded',
    'installations',
    inserted.id,
    {
      workId: context.workId,
      workItemId: row.workItemId,
      itemNumber: item.item_number,
      quantity: row.quantity,
      installedOn: context.installedOn,
      locationId: context.location.id,
      locationName: context.location.name,
      serialCount: serialIds.length,
      // Migration 0108: how many of those numbers the record had never
      // seen before this recording. A serial that entered here rather than
      // on a challan is the one a traceability question will be asked
      // about, and the trail is where that answer has to survive a
      // cancellation of the record itself.
      serialsAddedAtInstallation: resolved.added,
      ...variation,
    },
  );
  return toInstallation(full);
}

/** Existing active master, or inline creation. On a name+kind collision
 * with an ACTIVE master the existing row is used (the site user typed a
 * location that already exists — that is a pick, not an error); a
 * collision with a retired master is a conflict pointing at reactivation. */
async function resolveLocation(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  body: Pick<RecordInstallationRequest, 'locationId' | 'newLocation'>,
): Promise<{ id: string; name: string }> {
  if (body.locationId !== undefined) {
    const [location] = await tx<{ id: string; name: string; active: boolean }[]>`
      select id, name, active from location_masters where id = ${body.locationId}
    `;
    if (!location) {
      throw httpError(404, 'LOCATION_MASTER_NOT_FOUND', 'No such location.');
    }
    if (!location.active) {
      throw httpError(
        409,
        'LOCATION_MASTER_RETIRED',
        'This location is retired — reactivate it or pick another.',
      );
    }
    return { id: location.id, name: location.name };
  }
  const newLocation = body.newLocation;
  if (newLocation === undefined) {
    throw httpError(
      400,
      'LOCATION_CHOICE_INVALID',
      'Pick an existing location or name a new one — exactly one of the two.',
    );
  }
  const [created] = await tx<{ id: string; name: string }[]>`
    insert into location_masters (organisation_id, name, kind, created_by_user_id)
    values (${organisationId}, ${newLocation.name}, ${newLocation.kind}, ${userId})
    on conflict (organisation_id, lower(name), kind) do nothing
    returning id, name
  `;
  if (created) {
    await audit(
      tx,
      organisationId,
      userId,
      'location_master.created',
      'location_masters',
      created.id,
      { name: newLocation.name, kind: newLocation.kind, inline: true },
    );
    return created;
  }
  const [existing] = await tx<{ id: string; name: string; active: boolean }[]>`
    select id, name, active from location_masters
    where lower(name) = lower(${newLocation.name}) and kind = ${newLocation.kind}
  `;
  if (!existing) throw new Error('location master upsert found no row');
  if (!existing.active) {
    throw httpError(
      409,
      'LOCATION_MASTER_RETIRED',
      'A retired location already carries this name — reactivate it instead.',
    );
  }
  return { id: existing.id, name: existing.name };
}
