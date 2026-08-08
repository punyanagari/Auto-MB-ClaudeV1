/** Canonical JSON for structural comparison: objects serialise with
 * sorted keys so a value that round-tripped through jsonb (which reorders
 * keys) still compares equal to the freshly-built request value. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface AuditDiff {
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
    if (stableStringify(previous) !== stableStringify(next)) {
      changedBefore[key] = previous;
      changedAfter[key] = next;
    }
  }
  return { before: changedBefore, after: changedAfter };
}
