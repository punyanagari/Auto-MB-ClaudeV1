import {
  MeasurementBookDetailResponseSchema,
  SetMbMeasuredQuantitiesRequestSchema,
  type MbMeasuredAboveSourceDetails,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../../auth.js';
import { assertWorkAccess } from '../../authz.js';
import { httpError } from '../../http.js';
import { audit, errorResponses, IdParamsSchema } from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import { readDetail } from './internal.js';

/**
 * The downward-only measured quantity on a draft Measurement Book's lines
 * (owner ruling, 2026-08-19; migration 0106).
 *
 * WHAT AN OPERATOR IS DOING HERE. A delivery challan says ten were
 * delivered and eight were accepted at site this month; the challan is
 * the evidence and stays as it is, and the book measures eight. The
 * unmeasured two are not lost — they stay outside this book exactly as an
 * over-installed quantity does, and the final Measurement Book's
 * final-bill stage sweeps them up wherever the payment matrix gives that
 * stage a share (`docs/UX.md` § 25).
 *
 * REPLACE-THE-WHOLE-SET, exactly like `PUT .../sources` next door: the
 * body is the draft's complete set of adjustments, an item absent from it
 * measures what its sources deliver, and an adjustment stating nothing
 * (both stages null) is a deletion rather than a row of nulls. That makes
 * the endpoint idempotent and makes "clear all adjustments" an empty
 * array rather than a second route.
 *
 * TWO LAYERS. This route refuses a negative figure, a duplicate line, an
 * item of another Work, a non-draft book, and — naming every offending
 * line at once — anything above what the book's claimed sources measure.
 * Migration 0106's trigger refuses the same three facts against any
 * writer, and `mb-compute.ts` takes `min(adjustment, measured)` afterwards
 * so a source deselected later can never leave an adjustment billing more
 * than the evidence.
 */
export function registerMeasurementBookMeasuredQuantityRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'PUT',
      url: '/api/measurement-books/:id/measured-quantities',
      schema: {
        params: IdParamsSchema,
        body: SetMbMeasuredQuantitiesRequestSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;

      const ids = body.overrides.map((entry) => entry.workItemId);
      if (new Set(ids).size !== ids.length) {
        throw httpError(
          400,
          'MB_MEASURED_DUPLICATED',
          'The same item appears more than once in the measured quantities.',
        );
      }
      // A minus sign is a typo, not an instruction, and it is cheaper to
      // say so before the transaction than to let the CHECK say it.
      const negative = body.overrides.filter(
        (entry) =>
          (entry.measuredSupplied !== null && entry.measuredSupplied.startsWith('-')) ||
          (entry.measuredInstalled !== null && entry.measuredInstalled.startsWith('-')),
      );
      if (negative.length > 0) {
        throw httpError(
          400,
          'MB_MEASURED_NEGATIVE',
          'A measured quantity is reduced to at least zero, never below it.',
        );
      }
      // An entry naming neither stage is a deletion; it never becomes a
      // row, so it never has to be refused.
      const stated = body.overrides.filter(
        (entry) => entry.measuredSupplied !== null || entry.measuredInstalled !== null,
      );

      return tenant(async (tx) => {
        // The MB row lock serialises against finalize, delete, and a
        // concurrent replacement — the same lock the sources endpoint
        // takes, in the same order.
        const [book] = await tx<{ id: string; work_id: string; status: string }[]>`
          select id, work_id, status from measurement_books
          where id = ${id}
          for update
        `;
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.status !== 'draft') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            'Measured quantities are adjusted while the Measurement Book is draft.',
          );
        }

        // Existence within THIS Work, on the assertWorkAccess 404
        // discipline: an item of another Work answers exactly like an
        // unknown id.
        if (stated.length > 0) {
          const known = await tx<{ id: string }[]>`
            select id from work_items
            where work_id = ${book.work_id} and deleted_at is null
              and id = any(${stated.map((entry) => entry.workItemId)}::uuid[])
          `;
          if (known.length !== stated.length) {
            throw httpError(
              404,
              'WORK_ITEM_NOT_FOUND',
              'A measured quantity names an item that is not on this Work.',
            );
          }
        }

        // THE CAP, named line by line rather than one at a time. The two
        // sums are the ones ITEM_INPUTS_SQL's delta CTEs take, over this
        // book's own live claims — restated here so the refusal can carry
        // the offending figures, while migration 0106's trigger holds the
        // same rule against every writer.
        if (stated.length > 0) {
          const offenders = await tx<
            {
              work_item_id: string;
              item_number: string;
              stage: 'supplied' | 'installed';
              entered: string;
              measured: string;
            }[]
          >`
            with requested as (
              select req.work_item_id, req.measured_supplied, req.measured_installed
              from unnest(
                ${stated.map((entry) => entry.workItemId)}::uuid[],
                ${stated.map((entry) => entry.measuredSupplied)}::numeric(18,3)[],
                ${stated.map((entry) => entry.measuredInstalled)}::numeric(18,3)[]
              ) as req(work_item_id, measured_supplied, measured_installed)
            ),
            claimed as (
              select r.work_item_id,
                     coalesce((
                       select sum(dci.quantity)
                       from mb_sources ms
                       join delivery_challans dc
                         on dc.id = ms.source_id and dc.status = 'issued'
                       join delivery_challan_items dci
                         on dci.delivery_challan_id = ms.source_id
                       where ms.measurement_book_id = ${id}
                         and ms.source_type = 'delivery_challan'
                         and ms.released_at is null
                         and dci.work_item_id = r.work_item_id
                     ), 0)::numeric(18,3) as supplied,
                     coalesce((
                       select sum(i.quantity)
                       from mb_sources ms
                       join installations i
                         on i.id = ms.source_id and i.status = 'recorded'
                       where ms.measurement_book_id = ${id}
                         and ms.source_type = 'installation'
                         and ms.released_at is null
                         and i.work_item_id = r.work_item_id
                     ), 0)::numeric(18,3) as installed
              from requested r
            )
            select wi.id as work_item_id, wi.item_number, s.stage,
                   s.entered::text as entered, s.measured::text as measured
            from requested r
            join claimed c on c.work_item_id = r.work_item_id
            join work_items wi on wi.id = r.work_item_id
            cross join lateral (
              values ('supplied', r.measured_supplied, c.supplied),
                     ('installed', r.measured_installed, c.installed)
            ) as s(stage, entered, measured)
            where s.entered is not null and s.entered > s.measured
            order by wi.item_number, s.stage
          `;
          if (offenders.length > 0) {
            const details: MbMeasuredAboveSourceDetails = {
              items: offenders.map((row) => ({
                workItemId: row.work_item_id,
                itemNumber: row.item_number,
                stage: row.stage,
                entered: row.entered,
                measured: row.measured,
              })),
            };
            const named = offenders
              .map(
                (row) =>
                  `${row.item_number} ${row.stage} ${row.entered} against ${row.measured} measured`,
              )
              .join('; ');
            throw httpError(
              409,
              'MB_MEASURED_ABOVE_SOURCE',
              `A measured quantity is reduced, never raised — ${named}.`,
              details,
            );
          }
        }

        await tx`
          delete from mb_measured_overrides where measurement_book_id = ${id}
        `;
        if (stated.length > 0) {
          await tx`
            insert into mb_measured_overrides (
              organisation_id, measurement_book_id, work_id, work_item_id,
              measured_supplied, measured_installed
            )
            select ${organisationId}, ${id}, ${book.work_id}, req.work_item_id,
                   req.measured_supplied, req.measured_installed
            from unnest(
              ${stated.map((entry) => entry.workItemId)}::uuid[],
              ${stated.map((entry) => entry.measuredSupplied)}::numeric(18,3)[],
              ${stated.map((entry) => entry.measuredInstalled)}::numeric(18,3)[]
            ) as req(work_item_id, measured_supplied, measured_installed)
          `;
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.measured_quantities_updated',
          'measurement_books',
          id,
          {
            workId: book.work_id,
            adjustments: stated.map((entry) => ({
              workItemId: entry.workItemId,
              measuredSupplied: entry.measuredSupplied,
              measuredInstalled: entry.measuredInstalled,
            })),
            count: stated.length,
          },
        );
        return readDetail(tx, id);
      });
    },
  );
}
