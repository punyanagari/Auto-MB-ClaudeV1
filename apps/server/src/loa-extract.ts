import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Environment override for the `pdftotext` binary. Set this when the
 * PATH-resolved `pdftotext` is not Poppler's — the common case is a
 * developer machine where another PDF toolchain (Xpdf, shipped inside
 * Git-for-Windows/MSYS2 as `/mingw64/bin/pdftotext`) shadows the installed
 * Poppler build.
 */
const PDFTOTEXT_PATH_ENV = 'AUTO_MB_PDFTOTEXT';

/**
 * Why this guard exists.
 *
 * The whole LOA parser — `packages/loa-parser`, its six-letter regression
 * corpus, and every column offset the item-table reader relies on — is
 * calibrated against POPPLER's `pdftotext -layout` output specifically.
 * Poppler is what CI installs (`.github/workflows/ci.yml`), what the server
 * image installs (`deploy/Dockerfile.server`), and what the corpus fixtures
 * were extracted with.
 *
 * Xpdf ships a binary with the same name and the same `-layout` / `-raw`
 * flags, so an argument-vector invocation of bare `pdftotext` succeeds
 * against it and returns text that LOOKS plausible. It is not the same
 * text: Xpdf's `-layout` renders this bordered IREPS item table with a
 * differently-split header row, blank lines interleaved between wrapped
 * description lines, and — worst — the `Advt.Value` column's figures
 * hoisted up into the schedule-title rows. The parser then reads a
 * majority of item rows with a NULL unit column and mis-owned
 * descriptions, and the review screen fills with `unresolved_unit` /
 * `unresolved_item_description` flags whose printed unit is `null`. That
 * is a silently-wrong extraction of the values every downstream quantity,
 * rate, and contract total is derived from.
 *
 * Failing loudly at extraction time is the only honest option: the letter
 * is unparseable by this product with a non-Poppler binary, and a review
 * screen full of null units invites a human to "correct" 42 fields by hand
 * against a table the machine never actually read.
 *
 * Detection reads the `-v` banner from BOTH streams and ignores the exit
 * status, because the two implementations disagree on both: Poppler writes
 * the banner to stderr and exits 0; Xpdf writes it to stdout and exits 99.
 */
const POPPLER_BANNER_RE = /poppler/i;

/**
 * A misconfigured or missing `pdftotext` binary — an operator problem, not a
 * problem with the uploaded document.
 *
 * Distinct from a generic extraction failure so callers do not report it as
 * "this PDF has no text layer": telling someone to upload a searchable PDF
 * when the server is running the wrong binary sends them chasing a fault
 * that is not theirs, which would defeat the point of failing loudly.
 */
export class PdfToTextConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfToTextConfigurationError';
  }
}

/**
 * Classifies a `pdftotext -v` banner as Poppler's or not.
 *
 * Both implementations carry a `Glyph & Cog` copyright line, so that string
 * cannot discriminate; only Poppler's banner names the Poppler project:
 *
 *   Poppler: `Copyright 2005-2026 The Poppler Developers - http://poppler.freedesktop.org`
 *   Xpdf:    `pdftotext version 4.06 [www.xpdfreader.com]`
 *
 * Exported for direct testing against both real banners.
 */
export function isPopplerVersionBanner(banner: string): boolean {
  return POPPLER_BANNER_RE.test(banner);
}

function pdftotextCommand(): string {
  const override = process.env[PDFTOTEXT_PATH_ENV];
  return override !== undefined && override.length > 0 ? override : 'pdftotext';
}

/** Reads the `-v` banner, tolerating a non-zero exit and either stream. */
async function readPdfToTextBanner(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['-v'], {
      timeout: 10_000,
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    if (failure.code === 'ENOENT') {
      throw new PdfToTextConfigurationError(
        `LOA text extraction requires Poppler's pdftotext, but no "${command}" ` +
          `binary was found. Install poppler-utils, or set ${PDFTOTEXT_PATH_ENV} ` +
          `to the full path of Poppler's pdftotext.`,
      );
    }
    // A non-zero exit is expected from Xpdf's `-v`; the banner still needs
    // classifying, so only a truly empty result is fatal here.
    const banner = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
    if (banner.trim().length === 0) {
      throw new PdfToTextConfigurationError(
        `LOA text extraction could not identify the "${command}" binary: ` +
          `running it with -v produced no version banner. ` +
          `Set ${PDFTOTEXT_PATH_ENV} to the full path of Poppler's pdftotext.`,
      );
    }
    return banner;
  }
}

let popplerCheck: Promise<void> | null = null;

/**
 * Verifies once per process that the configured `pdftotext` is Poppler's.
 * The result is cached because the binary cannot change under a running
 * server; a failed check is NOT cached, so fixing the environment and
 * retrying works without a restart in development.
 */
async function assertPopplerPdfToText(): Promise<void> {
  popplerCheck ??= (async () => {
    const command = pdftotextCommand();
    const banner = await readPdfToTextBanner(command);
    if (!isPopplerVersionBanner(banner)) {
      const firstLine = banner.trim().split('\n')[0]?.trim() ?? '(no banner)';
      throw new PdfToTextConfigurationError(
        `LOA text extraction requires Poppler's pdftotext, but "${command}" ` +
          `reports: ${firstLine}. The LOA parser and its regression corpus are ` +
          `calibrated against Poppler's -layout output; another implementation ` +
          `(Xpdf ships a same-named binary) produces a differently-shaped table ` +
          `that extracts item units and descriptions incorrectly. ` +
          `Install poppler-utils, or set ${PDFTOTEXT_PATH_ENV} to the full path ` +
          `of Poppler's pdftotext.`,
      );
    }
  })();
  try {
    await popplerCheck;
  } catch (error) {
    popplerCheck = null;
    throw error;
  }
}

/** Test-only: drops the cached probe so a test can vary the environment. */
export function resetPdfToTextProbeForTests(): void {
  popplerCheck = null;
}

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
  const { stdout } = await execFileAsync(pdftotextCommand(), [mode, file, '-'], {
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
  await assertPopplerPdfToText();
  return withTemporaryPdf(pdf, (file) => runPdfToText(file, '-layout'));
}

/**
 * Extracts both complementary LOA views from one temporary PDF. The commands
 * run concurrently: `-layout` remains authoritative for numeric fields while
 * `-raw` supplies exact, non-overlapping item descriptions after a strict
 * whole-letter tuple gate.
 */
export async function extractLoaPdfText(pdf: Buffer): Promise<LoaPdfTextViews> {
  await assertPopplerPdfToText();
  return withTemporaryPdf(pdf, async (file) => {
    const [layoutText, rawText] = await Promise.all([
      runPdfToText(file, '-layout'),
      runPdfToText(file, '-raw'),
    ]);
    return { layoutText, rawText };
  });
}
