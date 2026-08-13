import {
  MeasurementBookDetailResponseSchema,
  SetMbSourcesRequestSchema,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../../auth.js';
import { assertWorkAccess } from '../../authz.js';
import { httpError } from '../../http.js';
import { audit, errorResponses, IdParamsSchema } from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import {
  assertSourcesUnclaimed,
  nameSourceConflict,
  readDetail,
  validateSources,
} from './internal.js';

/** Claiming the delivery and installation evidence a draft measures.
 * A claimed source cannot be cancelled (R19) and cannot be claimed twice;
 * the partial unique index decides races and the conflict names the
 * holding Measurement Book. */
export function registerMeasurementBookSourceRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'PUT',
      url: '/api/measurement-books/:id/sources',
      schema: {
        params: IdParamsSchema,
        body: SetMbSourcesRequestSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const keys = body.sources.map((s) => `${s.sourceType}:${s.sourceId}`);
      if (new Set(keys).size !== keys.length) {
        throw httpError(
          400,
          'MB_SOURCES_DUPLICATED',
          'The same source appears more than once in the selection.',
        );
      }
      return tenant(async (tx) => {
        // The MB row lock serialises selection edits against finalize,
        // delete, and concurrent selection replacements.
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
            'Sources are selected while the Measurement Book is draft.',
          );
        }
        // lock=true: row-locking the selected sources serialises the
        // selection against the source cancel routes' FOR UPDATE locks
        // (same single-type lock order finalize uses), closing the
        // write-skew where a source is cancelled and claimed at once.
        await validateSources(tx, book.work_id, body.sources, true);
        await assertSourcesUnclaimed(tx, id, body.sources);
        await tx`
          delete from mb_sources where measurement_book_id = ${id}
        `;
        if (body.sources.length > 0) {
          const types = body.sources.map((s) => s.sourceType);
          const ids = body.sources.map((s) => s.sourceId);
          await tx`
            insert into mb_sources (
              organisation_id, measurement_book_id, work_id, source_type, source_id
            )
            select ${organisationId}, ${id}, ${book.work_id}, req.source_type,
                   req.source_id
            from unnest(${types as string[]}::text[], ${ids}::uuid[])
              as req(source_type, source_id)
          `.catch((error: unknown) => {
            // The partial unique index decided a claim race against
            // another live MB; the route-level catch names the holder.
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'MB_SOURCE_ALREADY_BILLED',
                'A source in this selection was just claimed by another live Measurement Book.',
              );
            }
            throw error;
          });
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.sources_updated',
          'measurement_books',
          id,
          {
            workId: book.work_id,
            sources: body.sources.map((s) => ({
              sourceType: s.sourceType,
              sourceId: s.sourceId,
            })),
            count: body.sources.length,
          },
        );
        return readDetail(tx, id);
      }).catch(async (error: unknown) => {
        throw await nameSourceConflict(
          error,
          database,
          organisationId,
          user.id,
          id,
          body.sources,
        );
      });
    },
  );
}
