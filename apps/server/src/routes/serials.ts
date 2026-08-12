import {
  SerialSearchQuerySchema,
  SerialSearchResponseSchema,
  UpdateWorkItemSerialsRequestSchema,
  WorkItemSerialsResponseSchema,
  type SerialSearchMatch,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { httpError } from '../http.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/** Result cap for the tenant-wide lookup; one extra row is fetched to
 * detect truncation without a second count query. */
const SEARCH_LIMIT = 50;

/** LIKE/ILIKE treat %, _ and the escape character specially; the user's
 * text is a literal substring, so all three are escaped (backslash is
 * PostgreSQL's default escape character). */
function escapeLikePattern(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function registerSerialRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  // --- requires_serials flag management -----------------------------------
  tenantRoute(
    {
      method: 'PATCH',
      url: '/api/work-items/:id/requires-serials',
      schema: {
        params: IdParamsSchema,
        body: UpdateWorkItemSerialsRequestSchema,
        response: { 200: WorkItemSerialsResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workItemId } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        // The item row lock serialises the toggle against a concurrent
        // issue: the issue transaction locks the same rows before its
        // completeness check, so whichever commits first is visible to
        // the other's validation.
        const [item] = await tx<
          {
            id: string;
            work_id: string;
            item_number: string;
            requires_serials: boolean;
          }[]
        >`
          select id, work_id, item_number, requires_serials
          from work_items
          where id = ${workItemId} and deleted_at is null
          for update
        `;
        if (!item) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }
        await assertWorkAccess(tx, user.id, item.work_id);

        if (!body.requiresSerials && item.requires_serials) {
          // R7, last sentence: serial tracking is ONE-WAY once physical
          // units exist. Switching it off would orphan every captured
          // serial and silently drop R6's traceability guarantee, so the
          // toggle is refused while any serial is recorded against the
          // item. (Enabling remains legitimate at any time; the 0030
          // trigger holds this same direction against direct SQL.)
          const [recorded] = await tx<{ total: string }[]>`
            select count(*)::text as total
            from challan_item_serials s
            join delivery_challan_items dci on dci.id = s.delivery_challan_item_id
            where dci.work_item_id = ${workItemId}
          `;
          if (Number(recorded?.total ?? '0') > 0) {
            throw httpError(
              409,
              'SERIALS_EXIST_FOR_FLAG',
              `Serial tracking cannot be switched off for ${item.item_number}: ${recorded?.total ?? '0'} serial(s) are already recorded against it.`,
            );
          }
        }

        if (body.requiresSerials && !item.requires_serials) {
          // Turning ON must not create an instantly-broken invariant:
          // every already-issued line of this item has to be serial-
          // complete, otherwise the flag would claim a guarantee the
          // record does not hold.
          const incomplete = await tx<
            { challan_number: string | null; quantity: string; recorded: string }[]
          >`
            select dc.challan_number, dci.quantity::text as quantity,
                   (
                     select count(*) from challan_item_serials s
                     where s.delivery_challan_item_id = dci.id
                   )::text as recorded
            from delivery_challan_items dci
            join delivery_challans dc on dc.id = dci.delivery_challan_id
            where dci.work_item_id = ${workItemId}
              and dc.status = 'issued'
              and (
                select count(*) from challan_item_serials s
                where s.delivery_challan_item_id = dci.id
              ) <> dci.quantity
            order by dc.challan_number
          `;
          if (incomplete.length > 0) {
            const detail = incomplete
              .map(
                (line) =>
                  `${line.challan_number ?? 'challan'} has ${line.recorded} of ${line.quantity} serials`,
              )
              .join('; ');
            throw httpError(
              409,
              'SERIALS_INCOMPLETE_FOR_FLAG',
              `Serial tracking cannot be required for ${item.item_number}: ${detail}. Record the missing serials first.`,
            );
          }
        }

        const [updated] = await tx<{ requires_serials: boolean }[]>`
          update work_items
          set requires_serials = ${body.requiresSerials}
          where id = ${workItemId}
          returning requires_serials
        `;
        if (!updated) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'work_item.requires_serials_changed',
          'work_items',
          workItemId,
          {
            workId: item.work_id,
            itemNumber: item.item_number,
            requiresSerials: body.requiresSerials,
          },
        );
        return {
          workItemId,
          itemNumber: item.item_number,
          requiresSerials: updated.requires_serials,
        };
      });
    },
  );

  // --- Tenant-wide serial lookup ------------------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/serials/search',
      schema: {
        querystring: SerialSearchQuerySchema,
        response: { 200: SerialSearchResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { q } = request.query;
      const pattern = `%${escapeLikePattern(q)}%`;
      return tenant(async (tx) => {
        // 'assigned'-scoped memberships search only their Works (same
        // filter shape as the Works listing).
        const full = await hasFullWorkScope(tx, user.id);
        const rows = await tx<
          {
            id: string;
            serial_number: string;
            installed_on: string | null;
            work_id: string;
            work_code: string;
            work_title: string;
            description_snapshot: string;
            challan_id: string;
            challan_number: string | null;
            challan_date: string;
            challan_status: SerialSearchMatch['challanStatus'];
            receipt_recorded: boolean;
            installation_id: string | null;
            installation_location: string | null;
          }[]
        >`
          select s.id, s.serial_number, s.installed_on::text as installed_on,
                 w.id as work_id, w.work_code, w.title as work_title,
                 dci.description_snapshot,
                 dc.id as challan_id, dc.challan_number,
                 dc.challan_date::text as challan_date,
                 dc.status as challan_status,
                 exists (
                   select 1 from challan_receipts r
                   where r.delivery_challan_id = dc.id
                 ) as receipt_recorded,
                 inst.id as installation_id,
                 inst.location_name as installation_location
          from challan_item_serials s
          join works w on w.id = s.work_id
          join delivery_challans dc on dc.id = s.delivery_challan_id
          join delivery_challan_items dci on dci.id = s.delivery_challan_item_id
          -- Milestone 7: surface the live quantity-level installation
          -- record (id + snapshot location) in the tenant-wide trace.
          left join installation_serials att
            on att.challan_item_serial_id = s.id and att.released_at is null
          left join installations inst on inst.id = att.installation_id
          where s.serial_number ilike ${pattern}
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = s.work_id and wa.user_id = ${user.id}
            ))
          order by s.serial_number, s.id
          limit ${SEARCH_LIMIT + 1}
        `;
        const truncated = rows.length > SEARCH_LIMIT;
        return {
          matches: rows.slice(0, SEARCH_LIMIT).map((row): SerialSearchMatch => ({
            id: row.id,
            serialNumber: row.serial_number,
            workId: row.work_id,
            workCode: row.work_code,
            workTitle: row.work_title,
            itemDescription: row.description_snapshot,
            challanId: row.challan_id,
            challanNumber: row.challan_number,
            challanDate: row.challan_date,
            challanStatus: row.challan_status,
            receiptRecorded: row.receipt_recorded,
            installedOn: row.installed_on,
            installationId: row.installation_id,
            installationLocation: row.installation_location,
          })),
          truncated,
        };
      });
    },
  );

  // --- Draft-serial corrections -------------------------------------------
  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/serials/:id',
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        // The challan row lock serialises deletion against a concurrent
        // issue: after the wait the re-read status is current, so a
        // just-issued challan rejects the deletion instead of losing a
        // serial the issue transaction already counted.
        const [serial] = await tx<
          {
            id: string;
            work_id: string;
            serial_number: string;
            delivery_challan_id: string;
            challan_status: string;
          }[]
        >`
          select s.id, s.work_id, s.serial_number, s.delivery_challan_id,
                 dc.status as challan_status
          from challan_item_serials s
          join delivery_challans dc on dc.id = s.delivery_challan_id
          where s.id = ${id}
          for update of s, dc
        `;
        if (!serial) {
          throw httpError(404, 'SERIAL_NOT_FOUND', 'No such serial record.');
        }
        await assertWorkAccess(tx, user.id, serial.work_id);
        if (serial.challan_status !== 'draft') {
          throw httpError(
            409,
            'SERIAL_LOCKED',
            'Serials can only be deleted while their challan is a draft; recorded delivery evidence stays.',
          );
        }
        await tx`delete from challan_item_serials where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'serial.deleted',
          'challan_item_serials',
          id,
          {
            workId: serial.work_id,
            deliveryChallanId: serial.delivery_challan_id,
            serialNumber: serial.serial_number,
          },
        );
      });
      return reply.status(204).send(null);
    },
  );
}
