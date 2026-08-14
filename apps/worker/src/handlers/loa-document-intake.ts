import { jsonb } from '@auto-mb/db';
import type { TrustAnchorStore } from '@auto-mb/documents';
import {
  PdfToTextConfigurationError,
  extractLoaPdfText,
  verifyUploadedPdf,
} from '@auto-mb/documents';
import type { ObjectStorage } from '@auto-mb/documents';
import { reviewLoaLetter } from '@auto-mb/loa-parser';
import { PermanentJobError, type JobHandler } from '../runtime.js';

/**
 * The LOA intake job: read the stored letter, extract its text with
 * Poppler, verify its digital signatures, and write both results back.
 *
 * These two operations used to run inline in `POST /api/loa-documents`,
 * between the malware scan and the insert, and together they were the
 * request path's longest pause — the route's own comment said pdftotext
 * "may take tens of seconds". The upload now stores the bytes, writes the
 * row in `extraction_status = 'pending'`, and enqueues this job.
 *
 * WHY THE TWO TRAVEL TOGETHER. They read the same bytes and describe the
 * same document, and a reviewer looking at a letter wants one answer about
 * it rather than two that arrive minutes apart. Splitting them would mean
 * two storage reads, two jobs to reason about, and a window in which a
 * document has been extracted but not verified — a state nothing in the
 * product knows how to display honestly.
 *
 * The payload carries only the document id (ADR-0011 §3): the bytes and
 * every result stay behind tenant RLS, so a job claimed maliciously yields
 * nothing readable.
 */

interface DocumentRow {
  readonly object_key: string;
  readonly extraction_status: string;
  readonly signature_status: string;
}

export interface LoaIntakeDependencies {
  readonly storage: ObjectStorage;
  readonly trustAnchors: TrustAnchorStore;
}

export function createLoaDocumentIntakeHandler(
  dependencies: LoaIntakeDependencies,
): JobHandler {
  return async ({ job, log, tenant }) => {
    const documentId = job.payloadRef.documentId;
    if (typeof documentId !== 'string' || documentId.length === 0) {
      throw new PermanentJobError('loa_document_intake payload has no documentId');
    }

    // First bound transaction: find out what to work on, and take the
    // document into `processing` so a second worker that somehow holds a
    // concurrent claim finds nothing to do. The row is locked for the
    // check-and-set, which is what makes "only one worker extracts this
    // document" true rather than usual.
    const claimed = await tenant(async (tx) => {
      const [row] = await tx<DocumentRow[]>`
        select object_key, extraction_status, signature_status
        from loa_documents
        where id = ${documentId}
        for update
      `;
      if (row === undefined) return undefined;
      if (row.extraction_status !== 'pending') return { row, mine: false };
      await tx`
        update loa_documents
        set extraction_status = 'processing'
        where id = ${documentId}
      `;
      return { row, mine: true };
    });

    if (claimed === undefined) {
      // Discarded, or never committed. Nothing to extract and nothing a
      // retry would find.
      throw new PermanentJobError(`LOA document ${documentId} no longer exists`);
    }
    if (!claimed.mine) {
      log.info({
        jobId: job.id,
        message: 'LOA document already past pending; nothing to extract',
        extractionStatus: claimed.row.extraction_status,
      });
      return { skipped: true, extractionStatus: claimed.row.extraction_status };
    }

    // Slow work, outside any transaction — the reason this handler takes a
    // `tenant` closure rather than a transaction. A pooled connection held
    // across pdftotext is the hazard the request path already refused to
    // create, and moving the work to the worker does not make it safe.
    const bytes = await dependencies.storage.get(claimed.row.object_key);

    const signature = verifyUploadedPdf(bytes, dependencies.trustAnchors, {
      error: (context, message) => {
        log.error({ ...context, jobId: job.id, message });
      },
    });

    let extraction:
      | { status: 'review'; payload: Record<string, unknown> }
      | { status: 'failed'; payload: Record<string, unknown> };
    try {
      const { layoutText: sourceText, rawText: rawSourceText } =
        await extractLoaPdfText(bytes);
      extraction = {
        status: 'review',
        payload: {
          sourceText,
          rawSourceText,
          review: reviewLoaLetter(sourceText, { rawItemText: rawSourceText }),
        },
      };
    } catch (error) {
      if (error instanceof PdfToTextConfigurationError) {
        // An operator fault, not a per-document one. The synchronous route
        // answered 503 and stored nothing; here there is already a row, so
        // the job goes back to the queue with the document left in
        // `processing` — and the next paragraph is what stops that being a
        // trap. Rethrowing as an ordinary error keeps the retry budget,
        // so a server fixed within the backoff window finishes the job by
        // itself rather than needing every affected letter re-uploaded.
        await tenant(async (tx) => {
          await tx`
            update loa_documents
            set extraction_status = 'pending'
            where id = ${documentId} and extraction_status = 'processing'
          `;
        });
        throw new Error(`pdftotext is misconfigured: ${error.message}`);
      }
      extraction = {
        status: 'failed',
        payload: {
          error: error instanceof Error ? error.message : 'extraction failed',
        },
      };
    }

    // Second bound transaction: the membership is re-proved here, so a
    // user revoked while pdftotext ran cannot have a verdict written on
    // their authority.
    //
    // The signature columns are written only when they are still
    // `not_checked`. Migration 0060's append-once guard permits exactly
    // that one transition, and this is the second legitimate user of it
    // after the backfill it was written for: a retried job must not try to
    // rewrite a verdict it already stored, which the guard would refuse
    // and which would strand the job in a failure loop.
    await tenant(async (tx) => {
      await tx`
        update loa_documents
        set extraction_status = ${extraction.status},
            extraction_payload = ${jsonb(tx, extraction.payload)}
        where id = ${documentId} and extraction_status = 'processing'
      `;
      await tx`
        update loa_documents
        set signature_status = ${signature.status},
            signature_verdict = ${jsonb(tx, signature.verdict)},
            signature_verified_at = ${signature.verifiedAt}
        where id = ${documentId} and signature_status = 'not_checked'
      `;
      await tx`
        insert into audit_events (
          organisation_id, actor_user_id, action, entity_type, entity_id, details
        )
        values (
          ${job.organisationId}, ${job.userId}, 'loa.extracted', 'loa_documents',
          ${documentId},
          ${jsonb(tx, {
            extractionStatus: extraction.status,
            signatureStatus: signature.status,
            jobId: job.id,
          })}
        )
      `;
    });

    return {
      documentId,
      extractionStatus: extraction.status,
      signatureStatus: signature.status,
    };
  };
}
