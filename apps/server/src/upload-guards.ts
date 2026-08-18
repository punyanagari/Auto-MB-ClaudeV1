import { createHash, randomUUID } from 'node:crypto';
import type { ObjectStorage } from '@auto-mb/documents';
import { httpError } from './http.js';
import type { MalwareScanner } from './malware-scan.js';
import { recordUploadScanFailure } from './metrics.js';

/**
 * Everything a raw-body upload route must do to the bytes before it does
 * anything else with them: prove a body arrived, prove the body is the
 * format the route accepts (by its magic bytes, never by the client's
 * declared content type), and — after the route has authorised the caller
 * — prove it is not malware.
 *
 * The format half used to be eight verbatim copies of the same two `if`
 * blocks, one per upload route. A copied guard is a guard that a ninth
 * upload route can be written without, so it lives here as one function
 * and `test/upload-inventory.integration.test.ts` enumerates every upload
 * route the app registers and proves each one goes through it.
 */

/** The ceiling every PDF upload shares. The largest real variation order
 * seen is 7.9 MB (a photographed one, which is refused for other reasons);
 * the machine-readable originals are well under 1 MB. Routes pass this as
 * their Fastify `bodyLimit`, which is also what marks them as uploads for
 * the throttle derived in app.ts. */
export const MAX_PDF_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The ceiling on an imported workbook (0094).
 *
 * A third of the PDF cap, and lower on purpose. A spreadsheet is
 * COMPRESSED text: the 5,000-row sheets this feature is sized for are
 * tens of kilobytes, and the largest real register anyone has produced is
 * under a megabyte. Eight is generous for the honest case and small
 * enough that the decompression the parser has to do on hostile bytes is
 * bounded well below `XLSX_LIMITS.maxInflatedBytes` before it starts.
 */
export const MAX_XLSX_UPLOAD_BYTES = 8 * 1024 * 1024;

const PDF_MAGIC = Buffer.from('%PDF-');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
/** Every .xlsx is a ZIP, and every ZIP begins with a local file header.
 * This proves the container and nothing beyond it — that the container
 * holds a workbook rather than a photograph of one is `xlsx.ts`'s
 * question, and it answers by refusing to find the parts. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

interface ConsumedUpload<MediaType extends string> {
  /** The request body, proven non-empty and proven to carry the format's
   * signature. */
  readonly bytes: Buffer;
  /** The media type the SIGNATURE says it is — not the one the client
   * claimed in its Content-Type header. */
  readonly mediaType: MediaType;
}

interface PdfUploadSpec {
  readonly format: 'pdf';
  /** Names the document in the "send a body" refusal, e.g. `'the LOA'`
   * yields "Send the LOA as an application/pdf request body." */
  readonly description: string;
}

interface ImageUploadSpec {
  readonly format: 'image';
  readonly description: string;
}

interface XlsxUploadSpec {
  readonly format: 'xlsx';
  readonly description: string;
}

export function consumeUpload(
  body: unknown,
  spec: PdfUploadSpec,
): ConsumedUpload<'application/pdf'>;
export function consumeUpload(
  body: unknown,
  spec: ImageUploadSpec,
): ConsumedUpload<'image/png' | 'image/jpeg'>;
export function consumeUpload(
  body: unknown,
  spec: XlsxUploadSpec,
): ConsumedUpload<'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'>;
/**
 * Validates a raw request body and hands back the bytes with the media
 * type its signature proves. Every refusal is a 400 with the code the
 * route answered before this helper existed, so clients keying on
 * `PDF_REQUIRED` / `NOT_A_PDF` / `INVALID_IMAGE` are unaffected.
 */
export function consumeUpload(
  body: unknown,
  spec: PdfUploadSpec | ImageUploadSpec | XlsxUploadSpec,
): ConsumedUpload<string> {
  if (spec.format === 'xlsx') {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw httpError(
        400,
        'IMPORT_SHEET_UNREADABLE',
        `Send ${spec.description} as an .xlsx request body.`,
      );
    }
    if (!body.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
      // The commonest real cause is an .xls — the pre-2007 binary format,
      // which is not a ZIP and which this reader does not open — so the
      // refusal says what to do rather than only what went wrong.
      throw httpError(
        400,
        'IMPORT_SHEET_UNREADABLE',
        'That file is not an .xlsx workbook; open it in Excel and use Save As to write a .xlsx.',
      );
    }
    return {
      bytes: body,
      mediaType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  if (spec.format === 'pdf') {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw httpError(
        400,
        'PDF_REQUIRED',
        `Send ${spec.description} as an application/pdf request body.`,
      );
    }
    // Magic bytes, not just the declared content type (docs/SECURITY.md).
    if (!body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      throw httpError(400, 'NOT_A_PDF', 'The uploaded file is not a PDF.');
    }
    return { bytes: body, mediaType: 'application/pdf' };
  }

  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw httpError(
      400,
      'INVALID_IMAGE',
      `Send ${spec.description} as an image/png or image/jpeg request body.`,
    );
  }
  if (body.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { bytes: body, mediaType: 'image/png' };
  }
  if (body.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return { bytes: body, mediaType: 'image/jpeg' };
  }
  throw httpError(400, 'INVALID_IMAGE', 'The logo must be a PNG or JPEG image.');
}

/**
 * Scans uploaded bytes before they are stored or processed. Fail-closed
 * when a scanner is configured: an unreachable scanner rejects the upload
 * rather than waving it through.
 */
export async function assertNotMalware(
  scanner: MalwareScanner,
  bytes: Buffer,
): Promise<void> {
  if (!scanner.enabled) return;
  let result;
  try {
    result = await scanner.scan(bytes);
  } catch {
    // Finding 37: both refusal shapes are operational signals, and they
    // mean different things — a spiking scanner outage is an availability
    // incident, spiking detections are a security one.
    recordUploadScanFailure('scanner_unavailable');
    throw httpError(
      502,
      'SCAN_UNAVAILABLE',
      'The malware scanner is unavailable; the upload was not accepted.',
    );
  }
  if (result.verdict === 'infected') {
    recordUploadScanFailure('malware_detected');
    throw httpError(
      400,
      'MALWARE_DETECTED',
      `The uploaded file was rejected by the malware scanner (${result.signature}).`,
    );
  }
}

/** The environment variable that points the server at clamd. Named here so
 * the boot assertion and its test cannot drift from the read in main.ts. */
export const MALWARE_SCANNER_HOST_ENV = 'CLAMAV_HOST';

/** The named boot refusal for a production process that would register
 * upload routes with no malware scanner behind them. Carrying its own name
 * lets operators and tests recognise the exact hazard rather than a
 * generic startup failure. */
export class MalwareScanningUnconfiguredInProductionError extends Error {
  constructor() {
    super(
      `${MALWARE_SCANNER_HOST_ENV} must be set outside development and test. ` +
        'Upload scanning is configuration-gated: with the variable unset the ' +
        'server registers every upload route with a no-op scanner, so ' +
        'assertNotMalware returns immediately and unscanned attachments are ' +
        'stored and served back to the organisation. Scanning therefore only ' +
        'fails closed once it is switched on, and a production boot refuses ' +
        `to start one environment variable away from no scanning at all. Set ` +
        `${MALWARE_SCANNER_HOST_ENV} (or run with NODE_ENV=development/test).`,
    );
    this.name = 'MalwareScanningUnconfiguredInProductionError';
  }
}

/**
 * Boot assertion mirroring assertProductionSecret (auth.ts) and
 * assertProductionMfaEnforcement (mfa-policy.ts): anything that is not an
 * explicit development or test run counts as production, and a production
 * process must not bring up the upload surface with scanning unconfigured.
 * Called from buildApp at the point the upload routes are registered, so
 * it covers every production entry point rather than one `main.ts` line.
 */
export function assertProductionMalwareScanning(
  clamav: { readonly host: string; readonly port: number } | undefined,
): void {
  const isNonProduction =
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  if (!isNonProduction && clamav === undefined) {
    throw new MalwareScanningUnconfiguredInProductionError();
  }
}

/**
 * Writes accepted PDF bytes under a server-generated, tenant-prefixed key.
 *
 * Deliberately OUTSIDE the caller's transaction, exactly as `routes/loa.ts`
 * does it: a failure after this point leaves an orphan object under a uuid
 * nothing points at, which is inert, where the opposite ordering leaves a
 * row promising bytes that are not there.
 *
 * The returned `id` is the same uuid the key carries, so a caller that
 * wants its row and its object to share an identity can use it and one
 * that does not can ignore it. `area` is one lowercase word because
 * `assertSafeObjectKey` accepts `[a-z]+` for that segment and nothing else.
 */
export async function storePdfUpload(
  storage: ObjectStorage,
  organisationId: string,
  area: string,
  bytes: Buffer,
): Promise<{ id: string; objectKey: string; sha256: string }> {
  const id = randomUUID();
  const objectKey = `${organisationId}/${area}/${id}.pdf`;
  await storage.put(objectKey, bytes);
  return {
    id,
    objectKey,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
