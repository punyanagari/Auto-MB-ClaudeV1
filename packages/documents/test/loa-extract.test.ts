import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractLoaPdfText,
  extractPdfText,
  isPopplerVersionBanner,
  PdfToTextConfigurationError,
  resetPdfToTextProbeForTests,
} from '@auto-mb/documents';

/**
 * The LOA extractor's binary guard.
 *
 * Context: the parser and its six-letter regression corpus are calibrated
 * against POPPLER's `pdftotext -layout` output. Xpdf ships a same-named
 * binary accepting the same `-layout`/`-raw` flags, so bare `pdftotext`
 * resolving to Xpdf (Git-for-Windows/MSYS2 puts one at
 * `/mingw64/bin/pdftotext`) silently yields a differently-shaped item table:
 * the reader then produces NULL units and mis-owned descriptions across most
 * item rows. These tests pin the guard that turns that silent corruption of
 * the contract-value truth source into a loud, actionable failure.
 */

// Verbatim `pdftotext -v` banners captured from the two real binaries.
// Poppler prints to stderr and exits 0; Xpdf prints to stdout and exits 99 —
// which is why the probe reads both streams and ignores the exit status.
const POPPLER_BANNER = [
  'pdftotext version 26.02.0',
  'Copyright 2005-2026 The Poppler Developers - http://poppler.freedesktop.org',
  'Copyright 1996-2011, 2022 Glyph & Cog, LLC',
].join('\n');

const XPDF_BANNER = [
  'pdftotext version 4.06 [www.xpdfreader.com]',
  'Copyright 1996-2025 Glyph & Cog, LLC',
].join('\n');

// Any valid PDF body works: the guard runs before the binary ever sees it.
const MINIMAL_PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');

/** Awaits a rejection and returns its Error, failing if the call resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the extraction to reject, but it resolved');
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetPdfToTextProbeForTests();
});

describe('pdftotext banner classification', () => {
  it("accepts Poppler's real banner", () => {
    expect(isPopplerVersionBanner(POPPLER_BANNER)).toBe(true);
  });

  it("rejects Xpdf's real banner", () => {
    expect(isPopplerVersionBanner(XPDF_BANNER)).toBe(false);
  });

  it('does not discriminate on the "Glyph & Cog" line both binaries carry', () => {
    // Guards against a future "simpler" check keying on the shared copyright
    // line, which would accept Xpdf and reopen the defect.
    expect(XPDF_BANNER).toContain('Glyph & Cog');
    expect(POPPLER_BANNER).toContain('Glyph & Cog');
    expect(isPopplerVersionBanner('Copyright 1996-2025 Glyph & Cog, LLC')).toBe(false);
  });

  it('rejects an empty or unrelated banner', () => {
    expect(isPopplerVersionBanner('')).toBe(false);
    expect(isPopplerVersionBanner('v22.11.0')).toBe(false);
  });
});

describe('LOA extraction refuses a non-Poppler pdftotext', () => {
  // `process.execPath` is a real, runnable binary that answers `-v` with a
  // non-Poppler banner ("v22.x", stdout, exit 0). It stands in for Xpdf
  // without depending on Xpdf being installed on the test machine.
  const NON_POPPLER_BINARY = process.execPath;

  it('extractLoaPdfText throws an actionable error naming the override', async () => {
    vi.stubEnv('AUTO_MB_PDFTOTEXT', NON_POPPLER_BINARY);

    await expect(extractLoaPdfText(MINIMAL_PDF)).rejects.toThrow(
      /requires Poppler's pdftotext/,
    );
  });

  it('the error explains the consequence and names AUTO_MB_PDFTOTEXT', async () => {
    vi.stubEnv('AUTO_MB_PDFTOTEXT', NON_POPPLER_BINARY);

    const error = await rejectionOf(extractLoaPdfText(MINIMAL_PDF));

    expect(error.message).toContain('AUTO_MB_PDFTOTEXT');
    expect(error.message).toContain('poppler-utils');
    // The reviewer must learn WHY, not just that a check failed.
    expect(error.message).toMatch(/units and descriptions incorrectly/);
  });

  it('extractPdfText (contract sources) is guarded by the same check', async () => {
    vi.stubEnv('AUTO_MB_PDFTOTEXT', NON_POPPLER_BINARY);

    await expect(extractPdfText(MINIMAL_PDF)).rejects.toThrow(
      /requires Poppler's pdftotext/,
    );
  });

  it('reports a missing binary distinctly from a wrong one', async () => {
    vi.stubEnv(
      'AUTO_MB_PDFTOTEXT',
      path.join(process.cwd(), 'no-such-pdftotext-binary'),
    );

    const error = await rejectionOf(extractLoaPdfText(MINIMAL_PDF));

    expect(error.message).toMatch(/no ".*" binary was found/);
    expect(error.message).toContain('AUTO_MB_PDFTOTEXT');
  });

  it('raises PdfToTextConfigurationError, so routes can report an operator fault', async () => {
    // The routes key on this type to answer 503 "extraction is misconfigured"
    // rather than 400 "upload a searchable PDF". Misclassifying it would send
    // the user chasing a fault in a document that is actually fine.
    vi.stubEnv('AUTO_MB_PDFTOTEXT', NON_POPPLER_BINARY);

    const error = await rejectionOf(extractLoaPdfText(MINIMAL_PDF));

    expect(error).toBeInstanceOf(PdfToTextConfigurationError);
  });

  it('raises PdfToTextConfigurationError for a missing binary too', async () => {
    vi.stubEnv(
      'AUTO_MB_PDFTOTEXT',
      path.join(process.cwd(), 'no-such-pdftotext-binary'),
    );

    const error = await rejectionOf(extractLoaPdfText(MINIMAL_PDF));

    expect(error).toBeInstanceOf(PdfToTextConfigurationError);
  });

  it('does not cache a failed probe, so fixing the environment recovers', async () => {
    vi.stubEnv('AUTO_MB_PDFTOTEXT', NON_POPPLER_BINARY);
    await expect(extractLoaPdfText(MINIMAL_PDF)).rejects.toThrow(
      /requires Poppler's pdftotext/,
    );

    // Same process, no reset: a second attempt must re-probe rather than
    // replay a memoised rejection.
    await expect(extractLoaPdfText(MINIMAL_PDF)).rejects.toThrow(
      /requires Poppler's pdftotext/,
    );
  });
});
