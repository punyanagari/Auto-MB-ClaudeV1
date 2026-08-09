import { createHash } from 'node:crypto';

/** Canonical JSON: recursively key-sorted objects, arrays in order,
 * numbers via their ECMAScript shortest round-trip representation. The
 * same source row therefore always yields the same fingerprint across
 * runs and machines. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('non-finite number in payload');
    return String(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
      .join(',')}}`;
  }
  throw new TypeError(`unsupported payload value of type ${typeof value}`);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function fingerprintOf(sourceRow: unknown): string {
  return sha256Hex(canonicalJson(sourceRow));
}
