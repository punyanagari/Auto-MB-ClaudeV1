import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LoaPdfTextViews {
  /** Layout-authoritative view used for headers, schedules, and numbers. */
  readonly layoutText: string;
  /** Reading-order view used only for exact item-description ownership. */
  readonly rawText: string;
}

async function withTemporaryPdf<T>(
  pdf: Buffer,
  extract: (file: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-loa-'));
  try {
    const file = path.join(dir, 'source.pdf');
    await writeFile(file, pdf);
    return await extract(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runPdfToText(file: string, mode: '-layout' | '-raw'): Promise<string> {
  const { stdout } = await execFileAsync('pdftotext', [mode, file, '-'], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  // PostgreSQL jsonb cannot store NULs; a legitimate PDF text layer does
  // not need them.
  return stdout.replaceAll('\u0000', '');
}

/**
 * Extracts the layout-preserving Poppler view used by tender/contract-source
 * parsing. The temporary seekable file is private and always removed.
 */
export async function extractPdfText(pdf: Buffer): Promise<string> {
  return withTemporaryPdf(pdf, (file) => runPdfToText(file, '-layout'));
}

/**
 * Extracts both complementary LOA views from one temporary PDF. The commands
 * run concurrently: `-layout` remains authoritative for numeric fields while
 * `-raw` supplies exact, non-overlapping item descriptions after a strict
 * whole-letter tuple gate.
 */
export async function extractLoaPdfText(pdf: Buffer): Promise<LoaPdfTextViews> {
  return withTemporaryPdf(pdf, async (file) => {
    const [layoutText, rawText] = await Promise.all([
      runPdfToText(file, '-layout'),
      runPdfToText(file, '-raw'),
    ]);
    return { layoutText, rawText };
  });
}
