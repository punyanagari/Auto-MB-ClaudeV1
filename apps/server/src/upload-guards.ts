import { httpError } from './http.js';
import type { MalwareScanner } from './malware-scan.js';

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
    throw httpError(
      502,
      'SCAN_UNAVAILABLE',
      'The malware scanner is unavailable; the upload was not accepted.',
    );
  }
  if (result.verdict === 'infected') {
    throw httpError(
      400,
      'MALWARE_DETECTED',
      `The uploaded file was rejected by the malware scanner (${result.signature}).`,
    );
  }
}
