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
    // document into `processing`. The row is locked for the check-and-set,
    // which is what makes "only one worker extracts this document" true
    // rather than usual.
    //
    // `processing` IS RESUMABLE, and the first version of this handler had
    // that wrong in a way worth recording. It treated any status other
    // than `pending` as somebody else's business and returned `done`, so
    // ANY failure after the flip — a crash, an OOM on a large letter, a
    // deploy restarting the container, a storage read that threw — left
    // the document at `processing` for ever: the retry claimed the job,
    // saw a status it did not recognise as its own, skipped, and reported
    // success. A stranded document behind a perfectly healthy queue.
    //
    // Resuming is safe because every write below is idempotent, which is a
    // property to check rather than assume, so each one is checked:
    //
    //   * the extraction UPDATE is guarded on `extraction_status =
    //     'processing'`, so a rerun that finds the row already advanced
    //     applies zero rows and changes nothing;
    //   * the signature UPDATE is guarded on `signature_status =
    //     'not_checked'`, the one transition 0060's append-once trigger
    //     permits, so a rerun cannot rewrite a stored verdict — it would
    //     be refused if it tried, and it does not try;
    //   * the audit INSERT is the one write that is NOT naturally
    //     idempotent, so it is conditional on the extraction UPDATE having
    //     actually applied (below) rather than on having reached that
    //     line. A resumed job that finds the work already done records
    //     nothing, because nothing happened.
    //
    // The remaining states are genuinely not ours: `review`, `confirmed`
    // and `failed` mean the reading finished, and `discarded` (0055) means
    // the operator withdrew the upload.
    const RESUMABLE = ['pending', 'processing'];
    const claimed = await tenant(async (tx) => {
      const [row] = await tx<DocumentRow[]>`
        select object_key, extraction_status, signature_status
        from loa_documents
        where id = ${documentId}
        for update
      `;
      if (row === undefined) return undefined;
      if (!RESUMABLE.includes(row.extraction_status)) return { row, mine: false };
      await tx`
        update loa_documents
        set extraction_status = 'processing'
        where id = ${documentId}
      `;
      return { row, mine: true, resumed: row.extraction_status === 'processing' };
    });

    if (claimed === undefined) {
      // Discarded, or never committed. Nothing to extract and nothing a
      // retry would find.
      throw new PermanentJobError(`LOA document ${documentId} no longer exists`);
    }
    if (!claimed.mine) {
      log.info({
        jobId: job.id,
        message: 'LOA document already read; nothing to extract',
        extractionStatus: claimed.row.extraction_status,
      });
      return { skipped: true, extractionStatus: claimed.row.extraction_status };
    }
    if (claimed.resumed === true) {
      // Worth saying out loud: a resumed job means a previous attempt died
      // mid-flight, which is an operational fact an operator wants to see
      // even though the outcome is correct.
      log.info({
        jobId: job.id,
        attempts: job.attempts,
        message: 'resuming an extraction a previous attempt left in progress',
      });
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
    const applied = await tenant(async (tx) => {
      // The extraction UPDATE is the gate for everything else in this
      // transaction. It applies only while the document is still
      // `processing`, so it applies zero rows in exactly the two cases
      // that must not be written: the operator DISCARDED the letter while
      // pdftotext was running (0055 moves it to `discarded`), and a
      // resumed job found its own earlier attempt had already finished.
      //
      // Both used to fall through. The signature UPDATE was guarded only
      // on `signature_status = 'not_checked'` — which a discarded document
      // still satisfies, so it collected a verdict for a letter nobody
      // wanted — and the audit INSERT was guarded on nothing at all, so it
      // recorded a reading that never landed. Now the row count decides,
      // and the two writes below happen only if this one did.
      const written = await tx`
        update loa_documents
        set extraction_status = ${extraction.status},
            extraction_payload = ${tx.json(extraction.payload as never)}
        where id = ${documentId}
          and extraction_status = 'processing'
      `;
      if (written.count === 0) return false;

      await tx`
        update loa_documents
        set signature_status = ${signature.status},
            signature_verdict = ${tx.json(signature.verdict)},
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
          ${tx.json({
            extractionStatus: extraction.status,
            signatureStatus: signature.status,
            jobId: job.id,
          })}
        )
      `;
      return true;
    });

    if (!applied) {
      // The letter was discarded, or a previous attempt of this job had
      // already finished it. Neither is a failure and neither is worth a
      // retry: the job is done because there is nothing left to do.
      log.info({
        jobId: job.id,
        message: 'extraction result not written; the document moved on while it ran',
      });
      return { documentId, applied: false };
    }

    return {
      documentId,
      applied: true,
      extractionStatus: extraction.status,
      signatureStatus: signature.status,
    };
  };
}
