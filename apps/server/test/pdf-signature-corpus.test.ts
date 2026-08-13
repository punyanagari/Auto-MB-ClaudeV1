import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTrustAnchors, verifyPdfSignatures } from '../src/pdf-signature.js';

/**
 * Evidence run against the REAL Indian Railways corpus.
 *
 * The documents are customer correspondence — signed variation orders
 * naming railway officers, their offices and their personal certificates —
 * so they are not in this repository and never will be: AGENTS.md rule 12
 * and docs/SECURITY.md §5 both forbid it, and a fixture derived from them
 * would embed a real person's certificate to no test's benefit. What CI
 * proves deterministically is in `pdf-signature.test.ts`, which builds its
 * own PKI and its own signed documents and covers every verdict this
 * corpus produced.
 *
 * This file exists so the same corpus can be re-run on demand — after a
 * verifier change, or when a new sample arrives — without anyone having to
 * reconstruct the harness. It is SKIPPED, loudly and by name, unless
 * `AUTO_MB_SIGNED_PDF_CORPUS` points at a directory of PDFs;
 * `AUTO_MB_PDF_TRUST_ANCHORS` supplies the anchors, and without them every
 * chain correctly reports as not checked.
 *
 *   AUTO_MB_SIGNED_PDF_CORPUS=/path/to/pdfs \
 *   AUTO_MB_PDF_TRUST_ANCHORS=/path/to/anchors \
 *   pnpm --filter @auto-mb/server exec vitest run test/pdf-signature-corpus.test.ts
 *
 * The results of the run made when this feature was built are recorded in
 * the pull request, so the evidence outlives the machine it ran on.
 */

const corpus = process.env.AUTO_MB_SIGNED_PDF_CORPUS;

describe.skipIf(corpus === undefined || corpus === '')(
  'real signed-PDF corpus (set AUTO_MB_SIGNED_PDF_CORPUS to run)',
  () => {
    it('produces a complete, self-consistent verdict for every document', async () => {
      const directory = corpus ?? '';
      const anchors = await loadTrustAnchors(process.env.AUTO_MB_PDF_TRUST_ANCHORS);
      const files = (await readdir(directory)).filter((name) =>
        name.toLowerCase().endsWith('.pdf'),
      );
      expect(files.length, 'the corpus directory holds no PDFs').toBeGreaterThan(0);

      for (const file of files) {
        const bytes = await readFile(path.join(directory, file));
        const report = verifyPdfSignatures(bytes, { trustAnchors: anchors });

        // Every document gets a verdict; none throws, whatever it holds.
        expect(report.fileLength).toBe(bytes.length);
        expect(report.signatureCount).toBe(
          report.signatures.length + report.unreadableSignatures.length,
        );

        // The invariant that matters most: nothing reaches the green state
        // without a trusted chain, intact integrity, and full coverage.
        if (report.status === 'signed_and_intact') {
          expect(report.unsignedTrailingBytes).toBe(0);
          for (const signature of report.signatures) {
            expect(signature.integrity).toBe('intact');
            expect(signature.chain.status).toBe('trusted');
          }
        }

        // And its converse: a document with any signature is never
        // reported as unsigned.
        if (report.signatureCount > 0) expect(report.status).not.toBe('unsigned');

        for (const signature of report.signatures) {
          // Revocation is never claimed to have been checked.
          expect(signature.revocation.status).toBe('not_checked');
          // A signature that verified names a real certificate subject.
          if (signature.integrity === 'intact') {
            expect(signature.signer.subject).not.toBeNull();
            expect(signature.digestAlgorithm).not.toBeNull();
          }
          // Coverage arithmetic agrees with the file.
          expect(
            signature.coverage.coversWholeDocument,
            `${file} signature ${String(signature.index)}`,
          ).toBe(signature.coverage.unsignedBytesAfter === 0);
        }
      }
    });
  },
);
