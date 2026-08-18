import { isDeepStrictEqual } from 'node:util';

interface AuditDiff {
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
}

/**
 * Builds the `{ before, after }` payload for an UPDATE-shaped audit event,
 * keeping only the fields whose value actually changed. Both sides must be
 * the full candidate field set (old values and the values as they stand
 * after the update); unchanged fields are dropped so the trail records the
 * delta, not a row dump. Callers pass business fields only — never
 * secrets, password hashes, or tokens.
 *
 * Comparison is `isDeepStrictEqual`, which is key-order-insensitive: a
 * value that round-tripped through jsonb (which reorders keys) still
 * compares equal to the freshly-built request value. It also compares
 * Dates and Buffers by value rather than by whatever JSON happens to make
 * of them, so a serialisation quirk can never read as a field change.
 */
export function auditDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditDiff {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const previous = before[key] ?? null;
    const next = after[key] ?? null;
    if (!isDeepStrictEqual(previous, next)) {
      changedBefore[key] = previous;
      changedAfter[key] = next;
    }
  }
  return { before: changedBefore, after: changedAfter };
}
