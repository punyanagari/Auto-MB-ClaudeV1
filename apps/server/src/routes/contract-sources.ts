import { createHash } from 'node:crypto';
import {
  ContractSourceContextSchema,
  ContractSourceUploadQuerySchema,
  ContractSourceUploadResponseSchema,
  UuidSchema,
  type ContractSourceContext,
  type ContractSourceDocument,
  type ContractSourceDocumentKind,
  type ContractSourceIdentityMatch,
  type TenderItemSpecificationEvidence,
  type TenderPaymentMatrixEvidence,
  type TenderPeriodEvidence,
  type TenderReleaseClauseEvidence,
} from '@auto-mb/contracts';
import {
  matchTenderIdentity,
  reviewTenderDocument,
  type TenderReviewPayload,
} from '@auto-mb/loa-parser';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireWriterRole } from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { extractPdfText } from '../loa-extract.js';
import type { MalwareScanner } from '../malware-scan.js';
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { assertNotMalware } from '../upload-guards.js';
import { upstreamErrorResponses as errorResponses } from './shared.js';
import type { AppInstance } from '../app-instance.js';

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_PDF_BYTES = 25 * 1024 * 1024;

const IdParamsSchema = Type.Object({ id: UuidSchema }, { additionalProperties: false });

interface StoredLoaPayload {
  readonly review: {
    readonly header: {
      readonly tenderNumber: { readonly value: string | null };
      readonly workDescription: { readonly value: string | null };
    };
  };
}

interface StoredTenderPayload {
  readonly sourceText: string;
  readonly review: TenderReviewPayload;
}

interface ContractSourceRow {
  id: string;
  parent_loa_document_id: string;
  document_kind: ContractSourceDocumentKind;
  original_filename: string;
  sha256: string;
  size_bytes: string | number;
  identity_match: unknown;
  confirmed_work_id: string | null;
  created_at: Date;
  object_key?: string;
  extraction_payload?: unknown;
}

interface ParentLoaRow {
  id: string;
  extraction_status: string;
  extraction_payload: unknown;
  confirmed_work_id: string | null;
}

interface WorkItemIdentityRow {
  id: string;
  item_number: string;
}

function asStoredLoaPayload(value: unknown): StoredLoaPayload | null {
  const parsed = parseJsonbColumn(value);
  if (parsed === null || typeof parsed !== 'object' || !('review' in parsed)) {
    return null;
  }
  const candidate = parsed as Partial<StoredLoaPayload>;
  const header = candidate.review?.header;
  return header !== undefined &&
    typeof header.tenderNumber?.value !== 'undefined' &&
    typeof header.workDescription?.value !== 'undefined'
    ? (candidate as StoredLoaPayload)
    : null;
}

function asStoredTenderPayload(value: unknown): StoredTenderPayload | null {
  const parsed = parseJsonbColumn(value);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('sourceText' in parsed) ||
    !('review' in parsed)
  ) {
    return null;
  }
  const candidate = parsed as { sourceText?: unknown; review?: unknown };
  return typeof candidate.sourceText === 'string' &&
    candidate.review !== null &&
    typeof candidate.review === 'object'
    ? (candidate as StoredTenderPayload)
    : null;
}

function identityMatchOf(value: unknown): ContractSourceIdentityMatch {
  const parsed = parseJsonbColumn(value) as Partial<ContractSourceIdentityMatch> | null;
  if (
    parsed?.matched !== true ||
    parsed.tenderNumberMatched !== true ||
    parsed.workDescriptionMatched !== true ||
    typeof parsed.expectedTenderNumber !== 'string' ||
    typeof parsed.extractedTenderNumber !== 'string' ||
    typeof parsed.expectedWorkDescription !== 'string' ||
    typeof parsed.extractedWorkDescription !== 'string'
  ) {
    throw new Error('stored contract-source identity match is malformed');
  }
  return {
    matched: true,
    tenderNumberMatched: true,
    workDescriptionMatched: true,
    expectedTenderNumber: parsed.expectedTenderNumber,
    extractedTenderNumber: parsed.extractedTenderNumber,
    expectedWorkDescription: parsed.expectedWorkDescription,
    extractedWorkDescription: parsed.extractedWorkDescription,
    reasons: [],
  };
}

function toContractSourceDocument(row: ContractSourceRow): ContractSourceDocument {
  return {
    id: row.id,
    parentLoaDocumentId: row.parent_loa_document_id,
    kind: row.document_kind,
    originalFilename: row.original_filename,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    identityMatch: identityMatchOf(row.identity_match),
    confirmedWorkId: row.confirmed_work_id,
    createdAt: row.created_at.toISOString(),
  };
}

function normalizedItemReference(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function itemReferenceMatches(itemNumber: string, reference: string): boolean {
  const item = normalizedItemReference(itemNumber);
  const ref = normalizedItemReference(reference);
  if (item === '' || ref === '') return false;
  if (item === ref) return true;
  const itemTail = normalizedItemReference(itemNumber.split(/[/:]/).at(-1) ?? '');
  return itemTail !== '' && itemTail === ref;
}

function mappedWorkItemIds(
  references: readonly string[],
  workItems: readonly WorkItemIdentityRow[],
): readonly string[] {
  const result = new Set<string>();
  for (const reference of references) {
    const candidates = workItems.filter((item) =>
      itemReferenceMatches(item.item_number, reference),
    );
    // An ambiguous reference is not silently mapped. The raw item references
    // remain visible for the reviewer to resolve.
    if (candidates.length === 1 && candidates[0] !== undefined) {
      result.add(candidates[0].id);
    }
  }
  return [...result];
}

async function contextForParent(
  tx: TransactionSql,
  parentLoaDocumentId: string,
  confirmedWorkId: string | null,
): Promise<ContractSourceContext> {
  const rows = await tx<ContractSourceRow[]>`
    select id, parent_loa_document_id, document_kind, original_filename,
           sha256, size_bytes, identity_match, confirmed_work_id, created_at,
           extraction_payload
    from loa_documents
    where parent_loa_document_id = ${parentLoaDocumentId}
      and document_kind <> 'loa'
      and match_status = 'matched'
    order by created_at, id
  `;
  const workItems =
    confirmedWorkId === null
      ? []
      : await tx<WorkItemIdentityRow[]>`
          select id, item_number
          from work_items
          where work_id = ${confirmedWorkId} and deleted_at is null
          order by item_number, id
        `;

  const paymentMatrix: TenderPaymentMatrixEvidence[] = [];
  const periods: TenderPeriodEvidence[] = [];
  const releaseClauses: TenderReleaseClauseEvidence[] = [];
  const itemSpecifications: TenderItemSpecificationEvidence[] = [];

  for (const row of rows) {
    const payload = asStoredTenderPayload(row.extraction_payload);
    if (payload === null) continue;
    for (const evidence of payload.review.paymentMatrix) {
      paymentMatrix.push({
        sourceDocumentId: row.id,
        sourceFilename: row.original_filename,
        category: evidence.category,
        pctSupply: evidence.pctSupply,
        pctInstallation: evidence.pctInstallation,
        pctPac: evidence.pctPac,
        pctFinalBill: evidence.pctFinalBill,
        rawBlock: evidence.rawBlock,
        needsReview: evidence.needsReview,
      });
    }
    for (const evidence of payload.review.periods) {
      periods.push({
        sourceDocumentId: row.id,
        sourceFilename: row.original_filename,
        kind: evidence.kind,
        durationValue: evidence.durationValue,
        durationUnit: evidence.durationUnit,
        scope: evidence.scope,
        itemReferences: [...evidence.itemReferences],
        mappedWorkItemIds: [...mappedWorkItemIds(evidence.itemReferences, workItems)],
        rawBlock: evidence.rawBlock,
        needsReview: evidence.needsReview,
      });
    }
    for (const evidence of payload.review.releaseClauses) {
      releaseClauses.push({
        sourceDocumentId: row.id,
        sourceFilename: row.original_filename,
        kind: evidence.kind,
        rawBlock: evidence.rawBlock,
        needsReview: evidence.needsReview,
      });
    }
    for (const evidence of payload.review.itemSpecifications) {
      itemSpecifications.push({
        sourceDocumentId: row.id,
        sourceFilename: row.original_filename,
        itemReferences: [...evidence.itemReferences],
        mappedWorkItemIds: [...mappedWorkItemIds(evidence.itemReferences, workItems)],
        specification: evidence.specification,
        rawBlock: evidence.rawBlock,
        needsReview: evidence.needsReview,
      });
    }
  }

  return {
    documents: rows.map(toContractSourceDocument),
    paymentMatrix,
    periods,
    releaseClauses,
    itemSpecifications,
  };
}

async function parentLoaForWriter(
  tx: TransactionSql,
  userId: string,
  parentId: string,
  lock: boolean,
): Promise<{
  readonly parent: ParentLoaRow;
  readonly tenderNumber: string;
  readonly workDescription: string;
}> {
  await requireWriterRole(tx, userId);
  const rows = lock
    ? await tx<ParentLoaRow[]>`
        select id, extraction_status, extraction_payload, confirmed_work_id
        from loa_documents
        where id = ${parentId} and document_kind = 'loa'
        for update
      `
    : await tx<ParentLoaRow[]>`
        select id, extraction_status, extraction_payload, confirmed_work_id
        from loa_documents
        where id = ${parentId} and document_kind = 'loa'
      `;
  const parent = rows[0];
  if (parent === undefined) {
    throw httpError(404, 'LOA_DOCUMENT_NOT_FOUND', 'No such LOA document.');
  }
  const payload = asStoredLoaPayload(parent.extraction_payload);
  const tenderNumber = payload?.review.header.tenderNumber.value ?? null;
  const workDescription = payload?.review.header.workDescription.value ?? null;
  if (tenderNumber === null || workDescription === null) {
    throw httpError(
      409,
      'LOA_TENDER_IDENTITY_UNRESOLVED',
      'The LOA must have a reviewed tender number and name of work before supporting tender documents can be matched.',
      {
        tenderNumberResolved: tenderNumber !== null,
        workDescriptionResolved: workDescription !== null,
      },
    );
  }
  return { parent, tenderNumber, workDescription };
}

export function registerContractSourceRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
): void {
  app.post(
    '/api/loa-documents/:id/contract-sources',
    {
      bodyLimit: MAX_PDF_BYTES,
      schema: {
        params: IdParamsSchema,
        querystring: ContractSourceUploadQuerySchema,
        response: { 201: ContractSourceUploadResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: parentId } = request.params;
      const { kind, filename } = request.query;
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw httpError(
          400,
          'PDF_REQUIRED',
          'Send the supporting contract document as an application/pdf request body.',
        );
      }
      if (!body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
        throw httpError(400, 'NOT_A_PDF', 'The uploaded file is not a PDF.');
      }

      // Authorisation and expected identity are resolved before malware scan
      // and text extraction, so a forbidden account cannot spend either.
      const expected = await withBoundTenant(database, organisationId, user.id, (tx) =>
        parentLoaForWriter(tx, user.id, parentId, false),
      );
      await assertNotMalware(scanner, body);

      let sourceText: string;
      try {
        sourceText = await extractPdfText(body);
      } catch (error) {
        throw httpError(
          400,
          'CONTRACT_SOURCE_EXTRACTION_FAILED',
          'The supporting PDF has no readable text layer or could not be extracted. Upload a searchable PDF.',
          { reason: error instanceof Error ? error.message : 'extraction failed' },
        );
      }
      const review = reviewTenderDocument(sourceText, kind);
      const identity = matchTenderIdentity(
        expected.tenderNumber,
        expected.workDescription,
        review,
      );
      if (!identity.matched) {
        await withBoundTenant(database, organisationId, user.id, async (tx) => {
          await requireWriterRole(tx, user.id);
          await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, entity_id, details
            )
            values (
              ${organisationId}, ${user.id}, 'contract_source.rejected',
              'loa_documents', ${parentId},
              ${jsonb(tx, {
                kind,
                filename,
                sha256: createHash('sha256').update(body).digest('hex'),
                reasons: identity.reasons,
              })}
            )
          `;
        });
        throw httpError(
          409,
          'CONTRACT_SOURCE_IDENTITY_MISMATCH',
          'The supporting document was rejected because its tender number or name of work does not match the LOA.',
          identity,
        );
      }

      const documentId = crypto.randomUUID();
      const sha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/contractsource/${documentId}.pdf`;
      await storage.put(objectKey, body);

      const result = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const current = await parentLoaForWriter(tx, user.id, parentId, true);
          // Prevent a time-of-check/time-of-use identity switch. LOA extraction
          // payloads are normally immutable, but the comparison keeps this
          // endpoint correct even if a future review-edit path is introduced.
          if (
            current.tenderNumber !== expected.tenderNumber ||
            current.workDescription !== expected.workDescription
          ) {
            throw httpError(
              409,
              'LOA_IDENTITY_CHANGED',
              'The LOA identity changed while the supporting document was processed. Review it and upload again.',
            );
          }
          const [row] = await tx<ContractSourceRow[]>`
            insert into loa_documents (
              id, organisation_id, object_key, original_filename, sha256,
              media_type, size_bytes, extraction_status, extraction_payload,
              confirmed_work_id, uploaded_by_user_id, document_kind,
              parent_loa_document_id, match_status, identity_match
            )
            values (
              ${documentId}, ${organisationId}, ${objectKey}, ${filename},
              ${sha256}, 'application/pdf', ${body.length}, 'review',
              ${jsonb(tx, { sourceText, review })},
              ${current.parent.confirmed_work_id}, ${user.id}, ${kind},
              ${parentId}, 'matched', ${jsonb(tx, identity)}
            )
            returning id, parent_loa_document_id, document_kind,
                      original_filename, sha256, size_bytes, identity_match,
                      confirmed_work_id, created_at, extraction_payload
          `;
          if (row === undefined) {
            throw new Error('contract-source insert returned no row');
          }
          await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, entity_id, details
            )
            values (
              ${organisationId}, ${user.id}, 'contract_source.uploaded',
              'loa_documents', ${documentId},
              ${jsonb(tx, {
                parentLoaDocumentId: parentId,
                kind,
                filename,
                sha256,
                paymentMatrixSuggestions: review.paymentMatrix.length,
                periodSuggestions: review.periods.length,
                releaseClauses: review.releaseClauses.length,
                itemSpecifications: review.itemSpecifications.length,
              })}
            )
          `;
          return {
            document: toContractSourceDocument(row),
            context: await contextForParent(
              tx,
              parentId,
              current.parent.confirmed_work_id,
            ),
          };
        },
      );
      return reply.status(201).send(result);
    },
  );

  app.get(
    '/api/loa-documents/:id/contract-source-context',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: ContractSourceContextSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const { parent } = await parentLoaForWriter(tx, user.id, id, false);
        return contextForParent(tx, id, parent.confirmed_work_id);
      });
    },
  );

  app.get(
    '/api/works/:id/contract-source-context',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: ContractSourceContextSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [parent] = await tx<{ id: string }[]>`
          select id
          from loa_documents
          where confirmed_work_id = ${workId} and document_kind = 'loa'
          order by created_at, id
          limit 1
        `;
        return parent === undefined
          ? {
              documents: [],
              paymentMatrix: [],
              periods: [],
              releaseClauses: [],
              itemSpecifications: [],
            }
          : contextForParent(tx, parent.id, workId);
      });
    },
  );

  app.get(
    '/api/contract-source-documents/:id/file',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: Type.Any(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params;
      const row = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [document] = await tx<ContractSourceRow[]>`
            select id, parent_loa_document_id, document_kind,
                   original_filename, sha256, size_bytes, identity_match,
                   confirmed_work_id, created_at, object_key
            from loa_documents
            where id = ${id} and document_kind <> 'loa'
          `;
          if (document === undefined) {
            throw httpError(404, 'CONTRACT_SOURCE_NOT_FOUND', 'No such document.');
          }
          if (document.confirmed_work_id === null) {
            await requireWriterRole(tx, user.id);
          } else {
            await assertWorkAccess(tx, user.id, document.confirmed_work_id);
          }
          return document;
        },
      );
      if (row.object_key === undefined) throw new Error('object key not selected');
      const bytes = await storage.get(row.object_key);
      void reply.header(
        'content-disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(row.original_filename)}`,
      );
      void reply.type('application/pdf');
      return reply.send(bytes);
    },
  );
}
