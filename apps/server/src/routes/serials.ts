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
          // The item is reached through the challan line for a delivered
          // serial and through the serial itself for one recorded at
          // installation (migration 0108). Counting only the first would
          // let tracking be switched off underneath the serials the site
          // captured — which is precisely the traceability R7 protects.
          const [recorded] = await tx<{ total: string }[]>`
            select count(*)::text as total
            from challan_item_serials s
            left join delivery_challan_items dci on dci.id = s.delivery_challan_item_id
            where coalesce(dci.work_item_id, s.work_item_id) = ${workItemId}
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
            origin: 'delivery' | 'installation';
            installed_on: string | null;
            work_id: string;
            work_code: string;
            work_title: string;
            description_snapshot: string;
            challan_id: string | null;
            challan_number: string | null;
            challan_date: string | null;
            challan_status: SerialSearchMatch['challanStatus'];
            receipt_recorded: boolean;
            installation_id: string | null;
            installation_location: string | null;
          }[]
        >`
          select s.id, s.serial_number, s.origin,
                 s.installed_on::text as installed_on,
                 w.id as work_id, w.work_code, w.title as work_title,
                 -- The description comes off the challan line for a
                 -- delivered serial (a snapshot, deliberately frozen at
                 -- despatch) and off the Work item for one recorded at
                 -- installation, which never had a line to snapshot.
                 coalesce(dci.description_snapshot, wi.effective_description,
                          wi.description) as description_snapshot,
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
          -- LEFT since migration 0108: a serial the Delivery Challan
          -- missed and the site recorded has no challan and no line, and
          -- an inner join would answer "no such serial" for exactly the
          -- unit whose provenance somebody is asking about.
          left join delivery_challans dc on dc.id = s.delivery_challan_id
          left join delivery_challan_items dci on dci.id = s.delivery_challan_item_id
          left join work_items wi on wi.id = s.work_item_id
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
        /* THE PRODUCTION HALF (migration 0084).
         *
         * A serial an operator types into search is a number off a
         * nameplate, and they do not know — and should not have to know
         * — whether the unit has reached a Delivery Challan yet. Before
         * this, a unit the factory had built and not yet despatched
         * matched nothing at all, which is the worst possible answer:
         * indistinguishable from "no such unit".
         *
         * Organisation-scoped by RLS, and work-scoped the same way the
         * delivery half is, with the one difference the schema forces —
         * a job card with no Work belongs to nobody in particular and
         * has organisation-wide reach, exactly as the production
         * register reads it.
         */
        const productionRows = await tx<
          {
            id: string;
            serial_number: string;
            work_id: string | null;
            work_code: string | null;
            work_title: string | null;
            item_description: string;
            job_card_id: string;
            job_card_number: string;
            components_captured: number;
            genealogy_complete: boolean;
            released_on: string | null;
          }[]
        >`
          select s.id, s.serial_number,
                 j.work_id, w.work_code, w.title as work_title,
                 item.name as item_description,
                 j.id as job_card_id,
                 'PP-' || substr(j.fy_label, 3, 2) || '-' ||
                   lpad(j.sequence_number::text, 3, '0') as job_card_number,
                 (select count(*)::int from production_component_serials c
                   where c.organisation_id = s.organisation_id
                     and c.finished_serial_id = s.id) as components_captured,
                 not app_private.production_unit_incomplete(
                   s.organisation_id, s.id
                 ) as genealogy_complete,
                 d.dispatched_on::text as released_on
          from production_serials s
          join production_job_cards j
            on j.organisation_id = s.organisation_id and j.id = s.job_card_id
          join production_items item
            on item.organisation_id = s.organisation_id and item.id = s.item_id
          left join works w on w.organisation_id = j.organisation_id and w.id = j.work_id
          left join production_dispatch_serials ds
            on ds.organisation_id = s.organisation_id and ds.production_serial_id = s.id
          left join production_dispatches d
            on d.organisation_id = ds.organisation_id and d.id = ds.production_dispatch_id
          where s.serial_number ilike ${pattern}
            and (${full} or j.work_id is null or exists (
              select 1 from work_assignments wa
              where wa.work_id = j.work_id and wa.user_id = ${user.id}
            ))
          order by s.serial_number, s.id
          limit ${SEARCH_LIMIT + 1}
        `;

        const deliveryMatches = rows
          .slice(0, SEARCH_LIMIT)
          .map((row): SerialSearchMatch => ({
            id: row.id,
            serialNumber: row.serial_number,
            // The origin the row carries, not the table it came out of:
            // both live in `challan_item_serials`, and a trace that called
            // an installation-added serial "delivered" would state the one
            // thing about it that is untrue.
            source: row.origin,
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
          }));
        const productionMatches = productionRows
          .slice(0, SEARCH_LIMIT)
          .map((row): SerialSearchMatch => ({
            id: row.id,
            serialNumber: row.serial_number,
            source: 'production',
            workId: row.work_id,
            workCode: row.work_code,
            workTitle: row.work_title,
            itemDescription: row.item_description,
            // A unit that has not been despatched has no challan, and
            // saying so with nulls beats inventing one.
            challanId: null,
            challanNumber: null,
            challanDate: null,
            challanStatus: null,
            receiptRecorded: false,
            installedOn: null,
            jobCardId: row.job_card_id,
            jobCardNumber: row.job_card_number,
            componentsCaptured: row.components_captured,
            genealogyComplete: row.genealogy_complete,
            releasedOn: row.released_on,
          }));
        const truncated =
          rows.length > SEARCH_LIMIT || productionRows.length > SEARCH_LIMIT;
        return {
          matches: [...deliveryMatches, ...productionMatches].sort((left, right) =>
            left.serialNumber.localeCompare(right.serialNumber),
          ),
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
