import { httpError } from './http.js';

/**
 * The one way this server turns HTML into a PDF. Every document render —
 * delivery challans, issue challans, extension letters, correction
 * notices, Measurement Books, tax invoices, credit notes — goes through
 * here, so the hardening is a property of the server rather than of
 * whichever route was written most recently.
 *
 * The tax-invoice path was the hardened one and is now the only one:
 * the response is read through a bounded stream with the declared
 * content-length checked first, capped at 20 MB, aborted after 45
 * seconds, and refused unless it actually begins with the PDF magic
 * bytes. A PDF service that is compromised, misconfigured, or simply
 * answering something else can no longer stream unbounded bytes into
 * this process's memory or have its answer stored as though it were a
 * document.
 *
 * Every failure — connection, timeout, non-2xx, oversize, wrong magic —
 * surfaces as the caller's own 502 RENDER_FAILED, which is what the
 * routes already answered; the message says which document is
 * unaffected, because the render never mutates the document it renders.
 */

const PDF_MAGIC = Buffer.from('%PDF-');

/** 20 MB. A works-contract document that renders larger than this is a
 * runaway template or a service answering something other than our
 * document, not a legitimate PDF. */
export const MAX_RENDERED_PDF_BYTES = 20 * 1024 * 1024;

/** Gotenberg renders these documents in seconds; 45 is generous headroom
 * and still bounded, so a hung PDF service cannot hold a request (and
 * its database connection) open indefinitely. */
const RENDER_TIMEOUT_MS = 45_000;

/** Streams the response body under the size cap and refuses anything
 * that is not a PDF. Exported for the bound/magic tests. */
async function readBoundedPdfResponse(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (
    (Number.isFinite(declaredLength) && declaredLength > MAX_RENDERED_PDF_BYTES) ||
    declaredLength < 0
  ) {
    throw new Error('Gotenberg response exceeds the PDF size limit');
  }
  if (response.body === null) throw new Error('Gotenberg response has no body');

  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_RENDERED_PDF_BYTES) {
      await reader.cancel('PDF size limit exceeded');
      throw new Error('Gotenberg response exceeds the PDF size limit');
    }
    chunks.push(Buffer.from(value));
  }
  const pdf = Buffer.concat(chunks, total);
  if (
    pdf.length < PDF_MAGIC.length ||
    !pdf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)
  ) {
    throw new Error('Gotenberg response is not an accepted PDF');
  }
  return pdf;
}

interface RenderPdfOptions {
  /** The public 502 message, naming the document this render leaves
   * untouched (e.g. "…the issued challan is unaffected — retry later."). */
  readonly failureMessage: string;
  /** Records the underlying cause in the request log. The cause is never
   * returned to the caller — it can carry upstream detail. */
  readonly logError: (error: unknown) => void;
}

export async function renderPdfViaGotenberg(
  gotenbergUrl: string,
  html: string,
  options: RenderPdfOptions,
): Promise<Buffer> {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  const abort = new AbortController();
  const timeout = setTimeout(() => {
    abort.abort();
  }, RENDER_TIMEOUT_MS);
  try {
    const response = await fetch(`${gotenbergUrl}/forms/chromium/convert/html`, {
      method: 'POST',
      body: form,
      signal: abort.signal,
    });
    if (!response.ok) {
      throw new Error(`Gotenberg answered ${String(response.status)}`);
    }
    return await readBoundedPdfResponse(response);
  } catch (error) {
    options.logError(error);
    throw httpError(502, 'RENDER_FAILED', options.failureMessage);
  } finally {
    clearTimeout(timeout);
  }
}
