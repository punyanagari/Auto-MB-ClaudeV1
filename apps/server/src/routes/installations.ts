import {
  CancelInstallationRequestSchema,
  InstallationListResponseSchema,
  InstallationRegisterResponseSchema,
  KeysetQuerySchema,
  InstallationSchema,
  RecordInstallationRequestSchema,
  type Installation,
  type RecordInstallationRequest,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { cursorRowId, keysetPage, sqlLimit } from '../pagination.js';
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
}

interface SerialLink {
  serialId: string;
  serialNumber: string;
  challanNumber: string | null;
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
  };
}

/** Shared SELECT: an installation with its attached serials (attachment
 * history included after cancellation; the UI shows released serials as
 * part of the cancelled record's story). */
const INSTALLATION_COLUMNS = `
  i.id, i.work_id, i.work_item_id, wi.item_number,
  i.quantity::text as quantity, i.installed_on::text as installed_on,
  i.location_id, i.location_name, i.remarks, i.status, i.cancellation_note,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'serialId', s.id,
      'serialNumber', s.serial_number,
      'challanNumber', dc.challan_number
    ) order by s.serial_number)
    from installation_serials att
    join challan_item_serials s on s.id = att.challan_item_serial_id
    join delivery_challans dc on dc.id = s.delivery_challan_id
    where att.installation_id = i.id
  ), '[]'::jsonb) as serials,
  i.created_at, i.cancelled_at
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
        const cursor = await cursorRowId(tx, 'installations', query.cursor);
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
          itemSummaries: summaries.map((summary) => ({
            workItemId: summary.work_item_id,
            itemNumber: summary.item_number,
            installedQuantity: summary.installed_quantity,
          })),
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
  // often than it asks about one contract.
  // ------------------------------------------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/installations',
      schema: {
        querystring: KeysetQuerySchema,
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
        // same trailing descending id, as the per-Work list above.
        const cursor = await cursorRowId(tx, 'installations', query.cursor);
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
                 (
                   select count(*) from installation_serials att
                   where att.installation_id = i.id
                 )::text as serial_count,
                 i.status
          from installations i
          join work_items wi on wi.id = i.work_item_id
          join works w on w.id = i.work_id
          where w.deleted_at is null
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = i.work_id and wa.user_id = ${user.id}
            ))
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
      if ((body.locationId === undefined) === (body.newLocation === undefined)) {
        throw httpError(
          400,
          'LOCATION_CHOICE_INVALID',
          'Pick an existing location or name a new one — exactly one of the two.',
        );
      }
      const installation = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);

        // The works row lock pairs with the one the MB finalize
        // transaction holds, so recording and a final-MB finalize on
        // the same Work serialise: an installation recorded first is
        // caught by the final sweep, and a final MB finalized first
        // makes this recording fail the FINAL_MB_EXISTS check below
        // (the 0027 insert guard backstops it in the database). Lock
        // order works -> work_items matches every other writer taking
        // both.
        const [workRow] = await tx<{ id: string; status: string }[]>`
            select id, status from works where id = ${workId} and deleted_at is null
            for update
          `;
        if (!workRow) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        // R8: a completed Work accepts no new operational documents.
        // The works lock above serialises this against completion, and
        // the 0031 insert guard backstops it in the database.
        assertWorkOperable(workRow.status, 'recording an installation');

        // A live final Measurement Book closes the Work's payment
        // cycle (spec §5.9): an installation recorded after it could
        // never be billed, so the recording is refused outright.
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

        // The item row lock serialises every installation recording for
        // this item: both caps below read committed sums under the lock,
        // so concurrent recordings cannot jointly breach them (same
        // discipline as the MB delivered-quantity cap).
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
            where wi.id = ${body.workItemId} and wi.work_id = ${workId}
              and wi.deleted_at is null and w.deleted_at is null
            for update of wi
          `;
        if (!item) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }

        // An AMC item is never installed (migration 0068): annual
        // maintenance is served over a period and certified, and the
        // 0068 trigger refuses the row against every writer. Said here
        // with a code and a remedy, under the item row lock above, so
        // the operator reads a sentence instead of a 500.
        if (item.payment_category === 'AMC') {
          throw httpError(
            409,
            'ITEM_NOT_INSTALLABLE',
            `${item.item_number} is an annual maintenance item: maintenance is served over a period and certified by the railway, not installed. Record the acceptance certificate for the period served instead.`,
            { workItemId: item.id, itemNumber: item.item_number },
          );
        }

        // R11, friendly form (the 0017 trigger holds it against every
        // writer): not in the future in the organisation's timezone,
        // not before the LOA letter date.
        if (body.installedOn > item.today) {
          throw httpError(
            400,
            'INSTALLATION_DATE_FUTURE',
            `The installation date cannot be in the future (today is ${item.today}).`,
          );
        }
        if (body.installedOn < item.letter_date) {
          throw httpError(
            400,
            'INSTALLATION_DATE_BEFORE_LOA',
            `The installation date cannot precede the LOA letter date ${item.letter_date}.`,
          );
        }

        // Resolve the location: an existing active master, or inline
        // creation (legacy §5.4). Either way the master's name is
        // snapshotted onto the record below.
        const location = await resolveLocation(tx, organisationId, user.id, body);

        // R5, first half: per item, total installed never exceeds the
        // LOA quantity (effective when amended, else awarded). The
        // excess-delivery toggle deliberately does NOT apply here.
        const [loaCap] = await tx<{ exceeded: boolean }[]>`
            select (
              coalesce((
                select sum(quantity) from installations
                where work_item_id = ${body.workItemId} and status = 'recorded'
              ), 0) + ${body.quantity}::numeric(18,3)
            ) > ${item.loa_quantity}::numeric(18,3) as exceeded
          `;
        if (loaCap?.exceeded === true) {
          throw httpError(
            409,
            'INSTALLATION_EXCEEDS_LOA',
            `Cumulative installation for ${item.item_number} would exceed the sanctioned LOA quantity ${item.loa_quantity}. If the railway sanctioned more, amend the item quantity first.`,
          );
        }

        // R5, second half: supply-type items cannot be installed beyond
        // what issued Delivery Challans delivered. Milestone 7 knows
        // "supply-type" only through the requires_serials flag; the
        // category-based refinement (Supply / Supply+Installation /
        // Spare Supply / supply % > 0) arrives with the Milestone 8
        // payment categories and extends this predicate — the delivered
        // sum below is already the shape it will reuse.
        if (item.requires_serials) {
          const [deliveredCap] = await tx<{ exceeded: boolean }[]>`
              select (
                coalesce((
                  select sum(quantity) from installations
                  where work_item_id = ${body.workItemId} and status = 'recorded'
                ), 0) + ${body.quantity}::numeric(18,3)
              ) > coalesce((
                select sum(dci.quantity)
                from delivery_challan_items dci
                join delivery_challans dc on dc.id = dci.delivery_challan_id
                where dci.work_item_id = ${body.workItemId}
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

        // Serial attachment (R6): exactly one serial per unit for
        // serial-flagged items, none otherwise.
        const serialIds = [...new Set(body.serialIds ?? [])];
        if ((body.serialIds ?? []).length !== serialIds.length) {
          throw httpError(
            400,
            'SERIALS_DUPLICATED',
            'The same serial is selected more than once.',
          );
        }
        if (item.requires_serials) {
          const units = Number(body.quantity);
          if (!Number.isInteger(units) || serialIds.length !== units) {
            throw httpError(
              409,
              'SERIAL_COUNT_MISMATCH',
              `${item.item_number} tracks serials: select exactly one serial per installed unit (${body.quantity} needed, ${String(serialIds.length)} selected).`,
            );
          }
        } else if (serialIds.length > 0) {
          throw httpError(
            409,
            'SERIALS_NOT_TRACKED',
            `${item.item_number} does not track serial numbers; record the quantity without serials.`,
          );
        }

        // Validate and lock the selected serials. The row locks make
        // attachment atomic against a concurrent recording selecting
        // the same physical unit: the loser re-reads a serial that is
        // already installed and gets a conflict, and the partial unique
        // index on live attachments backs the check in the database.
        if (serialIds.length > 0) {
          const serials = await tx<
            {
              id: string;
              work_id: string;
              work_item_id: string;
              installed_on: string | null;
              serial_number: string;
              challan_status: string;
              challan_date: string;
              attached: boolean;
            }[]
          >`
              select s.id, s.work_id, dci.work_item_id,
                     s.installed_on::text as installed_on,
                     s.serial_number, dc.status as challan_status,
                     dc.challan_date::text as challan_date,
                     exists (
                       select 1 from installation_serials att
                       where att.challan_item_serial_id = s.id
                         and att.released_at is null
                     ) as attached
              from challan_item_serials s
              join delivery_challan_items dci on dci.id = s.delivery_challan_item_id
              join delivery_challans dc on dc.id = s.delivery_challan_id
              where s.id = any(${serialIds}::uuid[])
              for update of s
            `;
          const byId = new Map(serials.map((serial) => [serial.id, serial]));
          // First pass — existence within THIS Work. A serial of another
          // Work answers exactly like an unknown id (the assertWorkAccess
          // 404 discipline): no state-specific 409 may confirm a serial
          // outside the caller's scope exists, whatever its state.
          for (const serialId of serialIds) {
            const serial = byId.get(serialId);
            if (!serial || serial.work_id !== workId) {
              throw httpError(404, 'SERIAL_NOT_FOUND', 'No such serial record.');
            }
          }
          // Second pass — state checks, now that every serial is proven
          // to belong to the target Work.
          for (const serialId of serialIds) {
            const serial = byId.get(serialId);
            if (!serial) {
              throw httpError(404, 'SERIAL_NOT_FOUND', 'No such serial record.');
            }
            if (serial.work_item_id !== body.workItemId) {
              throw httpError(
                409,
                'SERIAL_ITEM_MISMATCH',
                `Serial ${serial.serial_number} belongs to a different item.`,
              );
            }
            if (serial.challan_status !== 'issued') {
              throw httpError(
                409,
                'SERIAL_NOT_DELIVERED',
                `Serial ${serial.serial_number} is not delivered yet — its challan is not issued.`,
              );
            }
            if (serial.installed_on !== null || serial.attached) {
              throw httpError(
                409,
                'SERIAL_ALREADY_INSTALLED',
                `Serial ${serial.serial_number} is already installed.`,
              );
            }
            if (body.installedOn < serial.challan_date) {
              throw httpError(
                409,
                'SERIAL_BEFORE_DELIVERY',
                `Serial ${serial.serial_number} was delivered on ${serial.challan_date}; it cannot be installed before that.`,
              );
            }
          }
        }

        const [row] = await tx<{ id: string }[]>`
            insert into installations (
              organisation_id, work_id, work_item_id, quantity, installed_on,
              location_id, location_name, remarks, recorded_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.workItemId}, ${body.quantity},
              ${body.installedOn}, ${location.id}, ${location.name},
              ${body.remarks ?? null}, ${user.id}
            )
            returning id
          `;
        if (!row) throw new Error('installation insert returned no row');

        if (serialIds.length > 0) {
          await tx`
              insert into installation_serials (
                organisation_id, installation_id, work_id, challan_item_serial_id
              )
              select ${organisationId}, ${row.id}, ${workId}, serial_id
              from unnest(${serialIds}::uuid[]) as serial_id
            `;
          // Keep the per-serial trace coherent: attachment IS the
          // serial's installation fact.
          await tx`
              update challan_item_serials
              set installed_on = ${body.installedOn}
              where id = any(${serialIds}::uuid[])
            `;
        }

        const full = await readInstallation(tx, row.id);
        if (!full) throw new Error('installation read-back returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'installation.recorded',
          'installations',
          row.id,
          {
            workId,
            workItemId: body.workItemId,
            itemNumber: item.item_number,
            quantity: body.quantity,
            installedOn: body.installedOn,
            locationId: location.id,
            locationName: location.name,
            serialCount: serialIds.length,
          },
        );
        return toInstallation(full);
      });
      return reply.status(201).send(installation);
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
          },
        );
        return toInstallation(full);
      });
    },
  );
}

/** Existing active master, or inline creation. On a name+kind collision
 * with an ACTIVE master the existing row is used (the site user typed a
 * location that already exists — that is a pick, not an error); a
 * collision with a retired master is a conflict pointing at reactivation. */
async function resolveLocation(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  body: RecordInstallationRequest,
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
