import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  MeasurementBookDetailResponseSchema,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../../auth.js';
import { assertWorkAccess, requireWriterRole } from '../../authz.js';
import { httpError } from '../../http.js';
import { MB_TEMPLATE_VERSION, renderMeasurementBookHtml } from '../../mb-html.js';
import { MB_REMARK_TEMPLATE_VERSION } from '../../mb-remark.js';
import type { ObjectStorage } from '../../storage.js';
import { audit, errorResponses, IdParamsSchema } from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import {
  brandingWithLogo,
  computeForBook,
  convertToPdf,
  readBook,
  readBranding,
  readDetail,
  readStoredLines,
  readWorkIdentity,
  toLine,
  toSnapshot,
} from './internal.js';

/** The Measurement Book document: the persisted render of a finalized
 * book, the DRAFT-watermarked live preview that persists nothing, and
 * the stream of retained bytes. */
export function registerMeasurementBookRenderRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/render',
      schema: {
        params: IdParamsSchema,
        response: {
          200: MeasurementBookDetailResponseSchema,
          ...errorResponses,
          502: ApiErrorSchema,
        },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;

      const { snapshot, branding } = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        const book = await readBook(tx, id);
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.status !== 'finalized') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            `Only finalized Measurement Books render to a persisted PDF (current status: ${book.status}); drafts stream a live preview instead.`,
          );
        }
        const work = await readWorkIdentity(tx, book.work_id);
        const lines = await readStoredLines(tx, id);
        const organisation = await readBranding(tx);
        return {
          snapshot: toSnapshot(
            book,
            organisation?.name ?? '',
            work,
            lines,
            book.total_amount ?? '0.00',
            book.remark_template_version ?? MB_REMARK_TEMPLATE_VERSION,
          ),
          branding: organisation,
        };
      });

      const html = renderMeasurementBookHtml(
        snapshot,
        await brandingWithLogo(storage, branding, (error) => {
          request.log.warn({ err: error }, 'measurement book render: logo unavailable');
        }),
      );
      const pdf = await convertToPdf(gotenbergUrl, html, (error) => {
        request.log.error({ err: error }, 'measurement book render failed');
      });
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/mb/${id}.pdf`;
      await storage.put(objectKey, pdf);

      return tenant(async (tx) => {
        const updated = await tx`
          update measurement_books
          set rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256},
              template_version = ${MB_TEMPLATE_VERSION}
          where id = ${id} and status = 'finalized'
        `;
        if (updated.count === 0) {
          // The MB stopped being finalized while Gotenberg rendered; the
          // stored PDF is an orphan, not evidence — no audit entry.
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            'The Measurement Book is no longer finalized; the render was discarded.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.rendered',
          'measurement_books',
          id,
          {
            sha256,
            templateVersion: MB_TEMPLATE_VERSION,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  // GET .../pdf streams the PERSISTED render of a finalized (or
  // cancelled-after-finalized) MB — 404 RENDER_MISSING until rendered.
  // GET .../pdf?preview=1 streams a live DRAFT preview: computed from
  // live state, watermarked DRAFT, converted, and streamed WITHOUT
  // persisting — drafts change constantly, so no stored artifact and no
  // render columns are ever touched. Same authz as the MB read routes.

  tenantRoute(
    {
      method: 'GET',
      url: '/api/measurement-books/:id/pdf',
      schema: {
        params: IdParamsSchema,
        querystring: Type.Object(
          { preview: Type.Optional(Type.Literal('1')) },
          { additionalProperties: false },
        ),
      },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const { preview } = request.query;

      if (preview === '1') {
        const { snapshot, branding } = await tenant(async (tx) => {
          const book = await readBook(tx, id);
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
              `The live preview is for draft Measurement Books (current status: ${book.status}); use the persisted render instead.`,
            );
          }
          const work = await readWorkIdentity(tx, book.work_id);
          const computation = await computeForBook(tx, book);
          const organisation = await readBranding(tx);
          return {
            snapshot: toSnapshot(
              book,
              organisation?.name ?? '',
              work,
              computation.lines.map(toLine),
              computation.totalAmount,
              MB_REMARK_TEMPLATE_VERSION,
            ),
            branding: organisation,
          };
        });
        const html = renderMeasurementBookHtml(
          snapshot,
          await brandingWithLogo(storage, branding, (error) => {
            request.log.warn(
              { err: error },
              'measurement book preview: logo unavailable',
            );
          }),
        );
        const pdf = await convertToPdf(gotenbergUrl, html, (error) => {
          request.log.error({ err: error }, 'measurement book preview failed');
        });
        void reply.type('application/pdf');
        void reply.header(
          'content-disposition',
          `inline; filename="measurement-book-${id}-draft-preview.pdf"`,
        );
        return reply.send(pdf);
      }

      const key = await tenant(async (tx) => {
        const book = await readBook(tx, id);
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.rendered_object_key === null) {
          throw httpError(
            404,
            'RENDER_MISSING',
            book.status === 'draft'
              ? 'Draft Measurement Books have no persisted PDF; use the live preview.'
              : 'This Measurement Book has not been rendered yet.',
          );
        }
        return book.rendered_object_key;
      });
      const bytes = await storage.get(key);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="measurement-book-${id}.pdf"`,
      );
      return reply.send(bytes);
    },
  );
}
