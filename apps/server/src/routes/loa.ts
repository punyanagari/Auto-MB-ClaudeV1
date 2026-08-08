import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  ConfirmWorkRequestSchema,
  LoaDocumentDetailSchema,
  LoaDocumentListResponseSchema,
  UploadLoaQuerySchema,
  WorkDetailResponseSchema,
  WorkListResponseSchema,
  type ConfirmWorkItem,
  type ConfirmWorkRequest,
  type LoaDocument,
  type LoaDocumentDetail,
  type UploadLoaQuery,
  type Work,
  type WorkSchedule,
} from '@auto-mb/contracts';
import { reviewLoaLetter, type LoaReviewPayload } from '@auto-mb/loa-parser';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope, requireWriterRole } from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { extractPdfText } from '../loa-extract.js';
import type { MalwareScanner } from '../malware-scan.js';
import { assertNotMalware } from '../upload-guards.js';
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

/** What loa_documents.extraction_payload holds for a parsed document:
 * the raw extracted text plus the parser's review payload, both verbatim.
 * A failed extraction stores { error } instead. */
interface ExtractionPayload {
  readonly sourceText: string;
  readonly review: LoaReviewPayload;
}

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  502: ApiErrorSchema,
} as const;

// Params are validated with a pattern rather than the uuid format so the
// check does not depend on the ajv instance's format registry.
const DocumentParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_PDF_BYTES = 25 * 1024 * 1024;

interface LoaDocumentRow {
  id: string;
  original_filename: string;
  sha256: string;
  size_bytes: string | number;
  extraction_status: LoaDocument['extractionStatus'];
  confirmed_work_id: string | null;
  created_at: Date;
  extraction_payload?: unknown;
}

function toDocument(row: LoaDocumentRow): LoaDocument {
  return {
    id: row.id,
    originalFilename: row.original_filename,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    extractionStatus: row.extraction_status,
    confirmedWorkId: row.confirmed_work_id,
    createdAt: row.created_at.toISOString(),
  };
}

function toDocumentDetail(row: LoaDocumentRow): LoaDocumentDetail {
  return {
    ...toDocument(row),
    extractionPayload: parseJsonbColumn(row.extraction_payload),
  };
}

interface WorkRow {
  id: string;
  work_code: string;
  letter_number: string;
  letter_date: string;
  title: string;
  advertised_value: string;
  contract_value: string;
  pricing_shape: Work['pricingShape'];
  letter_percentage: string | null;
  letter_percentage_direction: Work['letterPercentageDirection'];
  status: Work['status'];
  created_at: Date;
}

function toWork(row: WorkRow): Work {
  return {
    id: row.id,
    workCode: row.work_code,
    letterNumber: row.letter_number,
    letterDate: row.letter_date,
    title: row.title,
    advertisedValue: row.advertised_value,
    contractValue: row.contract_value,
    pricingShape: row.pricing_shape,
    letterPercentage: row.letter_percentage,
    letterPercentageDirection: row.letter_percentage_direction,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

/** Links a confirmed item back to the parsed row it came from, so the
 * work_items.source_evidence column carries the parser's verbatim source
 * block for that item — corrections never overwrite evidence. */
function sourceEvidenceFor(
  payload: ExtractionPayload | null,
  item: ConfirmWorkItem,
): Record<string, unknown> {
  if (!payload || !item.sourceRef) return {};
  const ref = item.sourceRef;
  const parsed = payload.review.items.find(
    (candidate) =>
      (candidate.schedule?.id ?? 'UNBOUND') === ref.scheduleId &&
      candidate.itemSno === ref.itemSno,
  );
  if (!parsed) return { sourceRef: ref, resolved: false };
  return {
    sourceRef: ref,
    resolved: true,
    qty: parsed.qty,
    qtyUnit: parsed.qtyUnit,
    unitRate: parsed.unitRate,
    bidAmount: parsed.bidAmount,
    reconciliation: parsed.reconciliation,
    needsReview: parsed.needsReview,
    raw: parsed.raw,
  };
}

function assertPricingShapeCoherent(body: ConfirmWorkRequest): void {
  const withPercentage = body.pricingShape === 'letter_percentage';
  const hasPercentage =
    body.letterPercentage !== undefined && body.letterPercentageDirection !== undefined;
  const hasNeither =
    body.letterPercentage === undefined && body.letterPercentageDirection === undefined;
  if ((withPercentage && !hasPercentage) || (!withPercentage && !hasNeither)) {
    throw httpError(
      400,
      'PRICING_SHAPE_INVALID',
      'letter_percentage requires a percentage and direction; per_schedule forbids them.',
    );
  }
}

export function registerLoaRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
): void {
  app.post(
    '/api/loa-documents',
    {
      bodyLimit: MAX_PDF_BYTES,
      schema: {
        querystring: UploadLoaQuerySchema,
        response: { 201: LoaDocumentDetailSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { filename } = request.query as UploadLoaQuery;

      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw httpError(
          400,
          'PDF_REQUIRED',
          'Send the LOA as an application/pdf request body.',
        );
      }
      // Magic bytes, not just the declared content type (docs/SECURITY.md).
      if (!body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
        throw httpError(400, 'NOT_A_PDF', 'The uploaded file is not a PDF.');
      }
      await assertNotMalware(scanner, body);

      const sha256 = createHash('sha256').update(body).digest('hex');
      const documentId = crypto.randomUUID();
      const objectKey = `${organisationId}/loa/${documentId}.pdf`;

      const row = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);

          // Store before the row exists: a failure here leaves at worst an
          // orphan object under a UUID key, never a database row without
          // its document.
          await storage.put(objectKey, body);

          let status: LoaDocument['extractionStatus'];
          let payload: ExtractionPayload | { error: string };
          try {
            const sourceText = await extractPdfText(body);
            payload = { sourceText, review: reviewLoaLetter(sourceText) };
            status = 'review';
          } catch (error) {
            payload = {
              error: error instanceof Error ? error.message : 'extraction failed',
            };
            status = 'failed';
          }

          const [inserted] = await tx<LoaDocumentRow[]>`
            insert into loa_documents (
              id, organisation_id, object_key, original_filename, sha256,
              media_type, size_bytes, extraction_status, extraction_payload,
              uploaded_by_user_id
            )
            values (
              ${documentId}, ${organisationId}, ${objectKey}, ${filename},
              ${sha256}, 'application/pdf', ${body.length}, ${status},
              ${jsonb(tx, payload)}, ${user.id}
            )
            returning id, original_filename, sha256, size_bytes,
                      extraction_status, confirmed_work_id, created_at,
                      extraction_payload
          `;
          if (!inserted) throw new Error('loa_documents insert returned no row');

          await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, entity_id, details
            )
            values (
              ${organisationId}, ${user.id}, 'loa.uploaded', 'loa_documents',
              ${documentId},
              ${jsonb(tx, { filename, sha256, sizeBytes: body.length, extractionStatus: status })}
            )
          `;
          return inserted;
        },
      );
      return reply.status(201).send(toDocumentDetail(row));
    },
  );

  app.get(
    '/api/loa-documents',
    {
      schema: {
        response: { 200: LoaDocumentListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        (tx) => tx<LoaDocumentRow[]>`
          select id, original_filename, sha256, size_bytes,
                 extraction_status, confirmed_work_id, created_at
          from loa_documents
          order by created_at desc, id
        `,
      );
      return { documents: rows.map(toDocument) };
    },
  );

  app.get(
    '/api/loa-documents/:id',
    {
      schema: {
        params: DocumentParamsSchema,
        response: { 200: LoaDocumentDetailSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const row = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [found] = await tx<LoaDocumentRow[]>`
            select id, original_filename, sha256, size_bytes,
                   extraction_status, confirmed_work_id, created_at,
                   extraction_payload
            from loa_documents
            where id = ${id}
          `;
          if (!found) {
            throw httpError(404, 'DOCUMENT_NOT_FOUND', 'No such LOA document.');
          }
          return found;
        },
      );
      return toDocumentDetail(row);
    },
  );

  app.post(
    '/api/loa-documents/:id/confirm',
    {
      schema: {
        params: DocumentParamsSchema,
        body: ConfirmWorkRequestSchema,
        response: { 201: WorkDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: documentId } = request.params as { id: string };
      const body = request.body as ConfirmWorkRequest;
      assertPricingShapeCoherent(body);

      const result = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);

          const [document] = await tx<
            { id: string; extraction_status: string; extraction_payload: unknown }[]
          >`
            select id, extraction_status, extraction_payload
            from loa_documents
            where id = ${documentId}
            for update
          `;
          if (!document) {
            throw httpError(404, 'DOCUMENT_NOT_FOUND', 'No such LOA document.');
          }
          if (document.extraction_status !== 'review') {
            throw httpError(
              409,
              'DOCUMENT_NOT_REVIEWABLE',
              `Only documents in review can be confirmed (status: ${document.extraction_status}).`,
            );
          }
          const parsedPayload = parseJsonbColumn(document.extraction_payload);
          const payload =
            parsedPayload !== null &&
            typeof parsedPayload === 'object' &&
            'review' in parsedPayload
              ? (parsedPayload as unknown as ExtractionPayload)
              : null;

          const [work] = await tx<WorkRow[]>`
            insert into works (
              organisation_id, work_code, letter_number, letter_date, title,
              advertised_value, contract_value, pricing_shape,
              letter_percentage, letter_percentage_direction,
              created_by_user_id
            )
            values (
              ${organisationId}, ${body.workCode}, ${body.letterNumber},
              ${body.letterDate}, ${body.title}, ${body.advertisedValue},
              ${body.contractValue}, ${body.pricingShape},
              ${body.letterPercentage ?? null},
              ${body.letterPercentageDirection ?? null}, ${user.id}
            )
            returning id, work_code, letter_number, letter_date::text as letter_date,
                      title, advertised_value, contract_value, pricing_shape,
                      letter_percentage, letter_percentage_direction, status,
                      created_at
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'WORK_EXISTS',
                'A Work with this work code or letter number already exists.',
              );
            }
            throw error;
          });
          if (!work) throw new Error('works insert returned no row');

          const schedules: WorkSchedule[] = [];
          for (const [index, schedule] of body.schedules.entries()) {
            const [scheduleRow] = await tx<{ id: string }[]>`
              insert into work_schedules (
                organisation_id, work_id, schedule_code, title, position
              )
              values (
                ${organisationId}, ${work.id}, ${schedule.scheduleCode},
                ${schedule.title}, ${index + 1}
              )
              returning id
            `;
            if (!scheduleRow) throw new Error('work_schedules insert returned no row');

            const items = [];
            for (const item of schedule.items) {
              const evidence = sourceEvidenceFor(payload, item);
              const [itemRow] = await tx<{ id: string }[]>`
                insert into work_items (
                  organisation_id, work_id, schedule_id, item_number,
                  description, unit_code, awarded_quantity, effective_rate,
                  source_evidence
                )
                values (
                  ${organisationId}, ${work.id}, ${scheduleRow.id},
                  ${item.itemNumber}, ${item.description}, ${item.unitCode},
                  ${item.awardedQuantity}, ${item.effectiveRate},
                  ${jsonb(tx, evidence)}
                )
                returning id
              `;
              if (!itemRow) throw new Error('work_items insert returned no row');
              items.push({
                id: itemRow.id,
                scheduleId: scheduleRow.id,
                itemNumber: item.itemNumber,
                description: item.description,
                unitCode: item.unitCode,
                awardedQuantity: item.awardedQuantity,
                effectiveRate: item.effectiveRate,
              });
            }
            schedules.push({
              id: scheduleRow.id,
              scheduleCode: schedule.scheduleCode,
              title: schedule.title,
              position: index + 1,
              items,
            });
          }

          await tx`
            update loa_documents
            set confirmed_work_id = ${work.id}, extraction_status = 'confirmed'
            where id = ${documentId}
          `;

          await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, entity_id, details
            )
            values (
              ${organisationId}, ${user.id}, 'work.created', 'works', ${work.id},
              ${jsonb(tx, {
                loaDocumentId: documentId,
                workCode: body.workCode,
                scheduleCount: body.schedules.length,
                itemCount: body.schedules.reduce(
                  (total, schedule) => total + schedule.items.length,
                  0,
                ),
              })}
            )
          `;

          return { work: toWork(work), schedules };
        },
      ).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === '23505') {
          throw httpError(
            409,
            'DUPLICATE_ENTRY',
            'A schedule code, position, or item number repeats within this Work.',
          );
        }
        throw error;
      });
      return reply.status(201).send(result);
    },
  );

  app.get(
    '/api/works',
    {
      schema: { response: { 200: WorkListResponseSchema, ...errorResponses } },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          // 'assigned'-scoped memberships list only their Works.
          const full = await hasFullWorkScope(tx, user.id);
          return tx<WorkRow[]>`
            select id, work_code, letter_number, letter_date::text as letter_date,
                   title, advertised_value, contract_value, pricing_shape,
                   letter_percentage, letter_percentage_direction, status,
                   created_at
            from works w
            where deleted_at is null
              and (${full} or exists (
                select 1 from work_assignments wa
                where wa.work_id = w.id and wa.user_id = ${user.id}
              ))
            order by created_at desc, id
          `;
        },
      );
      return { works: rows.map(toWork) };
    },
  );

  app.get(
    '/api/works/:id',
    {
      schema: {
        params: DocumentParamsSchema,
        response: { 200: WorkDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await assertWorkAccess(tx, user.id, id);
        const [work] = await tx<WorkRow[]>`
          select id, work_code, letter_number, letter_date::text as letter_date,
                 title, advertised_value, contract_value, pricing_shape,
                 letter_percentage, letter_percentage_direction, status,
                 created_at
          from works
          where id = ${id} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        const scheduleRows = await tx<
          { id: string; schedule_code: string; title: string; position: number }[]
        >`
          select id, schedule_code, title, position
          from work_schedules
          where work_id = ${id}
          order by position
        `;
        const itemRows = await tx<
          {
            id: string;
            schedule_id: string;
            item_number: string;
            description: string;
            unit_code: string;
            awarded_quantity: string;
            effective_rate: string;
          }[]
        >`
          select id, schedule_id, item_number, description, unit_code,
                 awarded_quantity, effective_rate
          from work_items
          where work_id = ${id} and deleted_at is null
          order by item_number
        `;

        const schedules: WorkSchedule[] = scheduleRows.map((schedule) => ({
          id: schedule.id,
          scheduleCode: schedule.schedule_code,
          title: schedule.title,
          position: schedule.position,
          items: itemRows
            .filter((item) => item.schedule_id === schedule.id)
            .map((item) => ({
              id: item.id,
              scheduleId: item.schedule_id,
              itemNumber: item.item_number,
              description: item.description,
              unitCode: item.unit_code,
              awardedQuantity: item.awarded_quantity,
              effectiveRate: item.effective_rate,
            })),
        }));
        return { work: toWork(work), schedules };
      });
    },
  );
}
