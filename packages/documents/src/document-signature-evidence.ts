/**
 * The seam every inbound-PDF upload path uses to record a signature
 * verdict as evidence.
 *
 * One function so that the LOA route, the contract-source route, and the
 * Measurement-Book-copy / tax-invoice / bill-copy / agreement uploads the
 * owner named next all record the SAME facts in the SAME words. A route
 * that hand-rolled its own call would be free to store a different shape,
 * or to drop the verdict on a failure, and the whole point of this feature
 * is that the answer is uniform across document types.
 *
 * To add a consumer:
 *
 *   1. Give the table `signature_status text NOT NULL DEFAULT 'not_checked'`,
 *      `signature_verdict jsonb`, and `signature_verified_at timestamptz`,
 *      with the same shape CHECK and append-once trigger as migration 0060.
 *   2. Call `verifyUploadedPdf(bytes, anchors, request.log)` BEFORE opening
 *      the writing transaction — it is pure CPU and must not hold a pooled
 *      connection.
 *   3. Insert its three columns in the same statement that inserts the
 *      document row, so a document and the verdict about it can never
 *      exist apart.
 *   4. Include the columns in the organisation export.
 *
 * Nothing here refuses an upload. Turning a bad verdict into a refusal is a
 * policy decision that belongs to the owner and differs per document type,
 * so this records and reports; see docs/SECURITY.md for the proposed
 * policy.
 */

import type { PdfSignatureReport } from '@auto-mb/contracts';
import { verifyPdfSignatures, type TrustAnchorStore } from './pdf-signature.js';

export interface StoredSignatureEvidence {
  readonly status: PdfSignatureReport['status'] | 'not_checked';
  readonly verdict: PdfSignatureReport;
  readonly verifiedAt: Date;
}

/**
 * Verifies an uploaded PDF and shapes the result for storage.
 *
 * `verifyPdfSignatures` is documented not to throw for a bad document —
 * an unreadable signature is a verdict, not an exception. A throw here is
 * therefore a fault in the verifier or the platform, and the honest
 * response to it is the same as the honest response to any other thing
 * that could not be checked: record `signature_unverifiable` with the
 * reason, and log the fault for an operator. The alternative — letting the
 * exception refuse the upload — would take a working LOA intake offline
 * because of a parser bug in an unrelated feature, and the alternative
 * after that — recording `unsigned` — would be a lie.
 */
export function verifyUploadedPdf(
  bytes: Buffer,
  anchors: TrustAnchorStore,
  // The minimum of a Fastify logger this function needs, so a caller can
  // pass `request.log` without this file depending on Fastify's types.
  logger: { error(context: Record<string, unknown>, message: string): void },
): StoredSignatureEvidence {
  const verifiedAt = new Date();
  try {
    const verdict = verifyPdfSignatures(bytes, {
      trustAnchors: anchors,
      now: verifiedAt,
    });
    return { status: verdict.status, verdict, verifiedAt };
  } catch (error) {
    logger.error(
      { err: error },
      'PDF signature verification failed unexpectedly; the upload was recorded as unverifiable',
    );
    return {
      status: 'signature_unverifiable',
      verifiedAt,
      verdict: {
        status: 'signature_unverifiable',
        signatureCount: 0,
        signatures: [],
        unreadableSignatures: [
          {
            offset: 0,
            reason:
              'the signature verifier failed unexpectedly on this document; nothing about its signatures is known',
          },
        ],
        fileLength: bytes.length,
        unsignedTrailingBytes: 0,
        trustAnchors: {
          configured: anchors.anchors.length > 0,
          count: anchors.anchors.length,
          source: anchors.configuredPath,
        },
        verifiedAt: verifiedAt.toISOString(),
        verifierVersion: 'error',
      },
    };
  }
}
