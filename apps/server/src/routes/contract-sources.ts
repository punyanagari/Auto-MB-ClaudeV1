import { createHash } from 'node:crypto';
import {
  ContractSourceContextSchema,
  ContractSourceUploadQuerySchema,
  ContractSourceUploadResponseSchema,
  DiscardLoaDocumentRequestSchema,
  UuidSchema,
  type ContractSourceContext,
  type ContractSourceDocument,
  type ContractSourceDocumentKind,
  type ContractSourceIdentityMatch,
  type PdfSignatureReport,
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
import { extractPdfText, PdfToTextConfigurationError } from '../loa-extract.js';
import type { MalwareScanner } from '../malware-scan.js';
import type { ObjectStorage } from '../storage.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
} from '../upload-guards.js';
import { verifyUploadedPdf } from '../document-signature-evidence.js';
import type { TrustAnchorStore } from '../pdf-signature.js';
import { audit, upstreamErrorResponses as errorResponses } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

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
  signature_status: ContractSourceDocument['signatureStatus'];
  signature_verdict?: unknown;
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
    signatureStatus: row.signature_status,
    signatureVerdict:
      (parseJsonbColumn(row.signature_verdict) as PdfSignatureReport | null) ?? null,
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
           extraction_payload, signature_status, signature_verdict
    from loa_documents
    where parent_loa_document_id = ${parentLoaDocumentId}
      and document_kind <> 'loa'
      and match_status = 'matched'
      and extraction_status <> 'discarded'
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
    throw httpError(404, 'DOCUMENT_NOT_FOUND', 'No such LOA document.');
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

/** A discarded LOA has no intake package left to attach evidence to
 * (migration 0055 refuses the insert as well). Reading the context of one
 * stays allowed — the audit trail of what was attached before it was
 * withdrawn is not secret — so this is asserted only on the upload path. */
function assertParentNotDiscarded(parent: ParentLoaRow): void {
  if (parent.extraction_status === 'discarded') {
    throw httpError(
      409,
      'DOCUMENT_DISCARDED',
      'That LOA document was discarded, so supporting tender documents can no longer be attached to it. Upload the letter again first.',
    );
  }
}

export function registerContractSourceRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
  pdfTrustAnchors: TrustAnchorStore,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'POST',
      url: '/api/loa-documents/:id/contract-sources',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParamsSchema,
        querystring: ContractSourceUploadQuerySchema,
        response: { 201: ContractSourceUploadResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: parentId } = request.params;
      const { kind, filename } = request.query;
      const { bytes: body } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the supporting contract document',
      });

      // Authorisation and expected identity are resolved before malware scan
      // and text extraction, so a forbidden account cannot spend either.
      const expected = await tenant((tx) =>
        parentLoaForWriter(tx, user.id, parentId, false),
      );
      assertParentNotDiscarded(expected.parent);
      await assertNotMalware(scanner, body);

      let sourceText: string;
      try {
        sourceText = await extractPdfText(body);
      } catch (error) {
        // A misconfigured text-extraction binary is an operator fault, not a
        // fault in the uploaded document: reporting it as "upload a
        // searchable PDF" would send the user chasing the wrong problem.
        if (error instanceof PdfToTextConfigurationError) {
          throw httpError(
            503,
            'PDF_TEXT_EXTRACTION_UNAVAILABLE',
            'PDF text extraction is not correctly configured on the server. No document was rejected; contact your administrator.',
            { reason: error.message },
          );
        }
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
        await tenant(async (tx) => {
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

      // Same shared verifier and the same non-blocking posture as the LOA
      // path: the verdict is recorded, never used to refuse.
      const signature = verifyUploadedPdf(body, pdfTrustAnchors, request.log);

      const documentId = crypto.randomUUID();
      const sha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/contractsource/${documentId}.pdf`;
      await storage.put(objectKey, body);

      const result = await tenant(async (tx) => {
        const current = await parentLoaForWriter(tx, user.id, parentId, true);
        // Re-checked under the row lock: the letter could have been
        // discarded while the scan and extraction ran.
        assertParentNotDiscarded(current.parent);
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
              parent_loa_document_id, match_status, identity_match,
              signature_status, signature_verdict, signature_verified_at
            )
            values (
              ${documentId}, ${organisationId}, ${objectKey}, ${filename},
              ${sha256}, 'application/pdf', ${body.length}, 'review',
              ${jsonb(tx, { sourceText, review })},
              ${current.parent.confirmed_work_id}, ${user.id}, ${kind},
              ${parentId}, 'matched', ${jsonb(tx, identity)},
              ${signature.status}, ${jsonb(tx, signature.verdict)},
              ${signature.verifiedAt}
            )
            returning id, parent_loa_document_id, document_kind,
                      original_filename, sha256, size_bytes, identity_match,
                      confirmed_work_id, created_at, extraction_payload,
                      signature_status, signature_verdict
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
      });
      return reply.status(201).send(result);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/loa-documents/:id/contract-source-context',
      schema: {
        params: IdParamsSchema,
        response: { 200: ContractSourceContextSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const { parent } = await parentLoaForWriter(tx, user.id, id, false);
        return contextForParent(tx, id, parent.confirmed_work_id);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/contract-source-context',
      schema: {
        params: IdParamsSchema,
        response: { 200: ContractSourceContextSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
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

  tenantRoute(
    {
      method: 'POST',
      url: '/api/contract-source-documents/:id/discard',
      schema: {
        params: IdParamsSchema,
        body: DiscardLoaDocumentRequestSchema,
        response: { 200: ContractSourceContextSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { reason } = request.body;
      return tenant(async (tx) => {
        // Attaching the wrong NIT was, until now, permanent: the upload
        // route was the only writer and the 0040 guard freezes a
        // supporting document's identity and bytes forever. The exit is
        // the same soft discard the letter itself has (migration 0055) —
        // the row and its object stay for retention, the evidence leaves
        // the package, and the parser suggestions it contributed stop
        // being offered to the reviewer.
        const [existing] = await tx<
          {
            parent_loa_document_id: string;
            document_kind: string;
            original_filename: string;
            extraction_status: string;
            confirmed_work_id: string | null;
          }[]
        >`
          select parent_loa_document_id, document_kind, original_filename,
                 extraction_status, confirmed_work_id
          from loa_documents
          where id = ${id} and document_kind <> 'loa'
          for update
        `;
        if (existing === undefined) {
          throw httpError(404, 'CONTRACT_SOURCE_NOT_FOUND', 'No such document.');
        }
        if (existing.extraction_status === 'discarded') {
          throw httpError(
            409,
            'CONTRACT_SOURCE_ALREADY_DISCARDED',
            'This supporting document has already been discarded.',
          );
        }
        // The same rule the letter has, for the same reason: once the
        // package has been confirmed into a Work, this document is part
        // of the evidence the Work's terms were read from.
        if (existing.confirmed_work_id !== null) {
          throw httpError(
            409,
            'CONTRACT_SOURCE_CONFIRMED',
            `${existing.original_filename} belongs to an LOA that has already been confirmed into a Work, and is part of that Work's tender evidence, so it cannot be discarded. Nothing was changed.`,
            { confirmedWorkId: existing.confirmed_work_id },
          );
        }
        await tx`
          update loa_documents
          set extraction_status = 'discarded', discarded_at = now(),
              discarded_by_user_id = ${user.id},
              discard_reason = ${reason ?? null}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'contract_source.discarded',
          'loa_documents',
          id,
          {
            parentLoaDocumentId: existing.parent_loa_document_id,
            kind: existing.document_kind,
            filename: existing.original_filename,
            reason: reason ?? null,
          },
        );
        return contextForParent(
          tx,
          existing.parent_loa_document_id,
          existing.confirmed_work_id,
        );
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/contract-source-documents/:id/file',
      schema: {
        params: IdParamsSchema,
        response: { 200: Type.Any(), ...errorResponses },
      },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const row = await tenant(async (tx) => {
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
      });
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
