import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Extracts layout-preserving text from a PDF via `pdftotext -layout`
 * (poppler-utils) — the exact extraction the LOA parser's regression
 * corpus was produced with, so the parser sees production text in the same
 * shape as its fixtures (docs/reference/loa-parser-contract.md §0).
 * poppler is a system dependency like Gotenberg (docs/DEPENDENCIES.md).
 *
 * The buffer is written to a private temporary file because pdftotext
 * wants a seekable input; the directory is removed in all outcomes. NUL
 * bytes are stripped from the output — PostgreSQL jsonb cannot store them
 * and no text layer legitimately contains them.
 */
export async function extractPdfText(pdf: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-loa-'));
  try {
    const file = path.join(dir, 'source.pdf');
    await writeFile(file, pdf);
    const { stdout } = await execFileAsync('pdftotext', ['-layout', file, '-'], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.replaceAll('\u0000', '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
