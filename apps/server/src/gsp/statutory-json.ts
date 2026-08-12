/**
 * JSON numbers are decimal lexemes on the wire, but JavaScript numbers are
 * binary floating point.  A PostgreSQL numeric(18,2) value can exceed the
 * integer-safe range even though its textual value is exact.  Statutory
 * payloads therefore carry branded numeric lexemes until this serializer
 * writes the final bytes; no Number() round-trip is allowed on money, rates,
 * PINs, state codes, HSN/SAC codes, or identifiers represented as numbers.
 */

const EXACT_JSON_NUMBER = Symbol('exact-json-number');

export interface ExactJsonNumber {
  readonly [EXACT_JSON_NUMBER]: true;
  readonly value: string;
}

// Anchored decimal grammar; every repetition consumes one digit.
// eslint-disable-next-line security/detect-unsafe-regex
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export function exactJsonNumber(value: string): ExactJsonNumber {
  if (!JSON_NUMBER.test(value)) {
    throw new Error(`Invalid exact JSON number: ${value}`);
  }
  return { [EXACT_JSON_NUMBER]: true, value };
}

export function exactJsonInteger(digits: string): ExactJsonNumber {
  if (!/^[0-9]+$/.test(digits)) {
    throw new Error(`Invalid exact JSON integer: ${digits}`);
  }
  const normalised = digits.replace(/^0+(?=[0-9])/, '');
  return exactJsonNumber(normalised);
}

function isExactJsonNumber(value: unknown): value is ExactJsonNumber {
  return (
    value !== null &&
    typeof value === 'object' &&
    EXACT_JSON_NUMBER in value &&
    (value as Partial<ExactJsonNumber>)[EXACT_JSON_NUMBER] === true &&
    typeof (value as Partial<ExactJsonNumber>).value === 'string'
  );
}

/** Deterministic, cycle-rejecting JSON with exact numeric lexemes. */
export function stringifyStatutoryJson(value: unknown): string {
  const active = new Set<object>();

  const write = (current: unknown, arrayPosition = false): string | undefined => {
    if (current === null) return 'null';
    if (isExactJsonNumber(current)) return current.value;
    if (typeof current === 'string') return JSON.stringify(current);
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isSafeInteger(current)) {
        throw new Error('Statutory JSON accepts only safe literal integers');
      }
      return String(current);
    }
    if (typeof current === 'undefined') return arrayPosition ? 'null' : undefined;
    if (typeof current !== 'object') {
      throw new Error(`Unsupported statutory JSON value: ${typeof current}`);
    }
    if (active.has(current)) throw new Error('Statutory JSON cannot contain cycles');
    active.add(current);
    try {
      if (Array.isArray(current)) {
        return `[${current.map((entry) => write(entry, true) ?? 'null').join(',')}]`;
      }
      const entries: string[] = [];
      for (const [key, entry] of Object.entries(current)) {
        const serialised = write(entry);
        if (serialised !== undefined) {
          entries.push(`${JSON.stringify(key)}:${serialised}`);
        }
      }
      return `{${entries.join(',')}}`;
    } finally {
      active.delete(current);
    }
  };

  const serialised = write(value);
  if (serialised === undefined) {
    throw new Error('A statutory JSON document cannot be undefined');
  }
  return serialised;
}

/** A display/debug copy: exact numbers remain strings so a browser cannot
 * parse and re-stringify them through binary floating point. */
export function statutoryJsonDisplay(value: unknown): unknown {
  if (value === null) return null;
  if (isExactJsonNumber(value)) return value.value;
  if (Array.isArray(value)) return value.map((entry) => statutoryJsonDisplay(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, statutoryJsonDisplay(entry)]),
    );
  }
  return value;
}
