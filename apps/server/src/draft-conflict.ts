/**
 * One-open-draft 409s, in one shape everywhere: the error's `details`
 * carry `{ existingRecordId }` — the id of the draft that already
 * occupies the slot — so clients can open the existing draft instead of
 * parsing the message (DraftConflictDetails in @auto-mb/contracts is the
 * canonical shape; future one-draft rules such as the Measurement Book
 * draft must reuse it via these helpers).
 */

import type { DraftConflictDetails, ErrorCode } from '@auto-mb/contracts';
import { httpError } from './http.js';

/** A 409 whose details name the existing draft. */
export function draftConflictError(
  code: ErrorCode,
  message: string,
  existingRecordId: string,
): Error {
  const details: DraftConflictDetails = { existingRecordId };
  return httpError(409, code, message, details);
}

/** True for a one-draft 409 that could not yet name the existing draft —
 * the unique-index race path raises inside an aborted transaction, before
 * the winning draft is readable. */
function isUnnamedDraftConflict(error: unknown, code: ErrorCode): boolean {
  return (
    error instanceof Error &&
    'statusCode' in error &&
    error.statusCode === 409 &&
    'code' in error &&
    error.code === code &&
    !('details' in error && error.details !== undefined)
  );
}

/**
 * Route-level completion of the unique-index race path: when `error` is a
 * one-draft 409 without details (thrown from inside the rolled-back
 * transaction), look the winning draft up with a fresh read and rebuild
 * the error with `{ existingRecordId }`. Any other error — and a lookup
 * that finds nothing (the winner was already issued or deleted) — passes
 * through unchanged.
 */
export async function nameDraftConflict(
  error: unknown,
  code: ErrorCode,
  lookup: () => Promise<string | null>,
): Promise<unknown> {
  if (!isUnnamedDraftConflict(error, code)) return error;
  const existingRecordId = await lookup().catch(() => null);
  if (existingRecordId === null) return error;
  return draftConflictError(code, (error as Error).message, existingRecordId);
}
