/** Pure parsing/normalisation rules for v1 source values. Every rule here
 * is deterministic; anything a rule cannot handle becomes a reconciliation
 * exception in the importer, never a guess. */

export interface ParsedChallanNumber {
  /** Series prefix exactly as printed, minus the trailing separator+integer. */
  readonly rawPrefix: string;
  /** Uppercased prefix used for the target `prefix` column (R1 charset). */
  readonly prefix: string;
  /** Trailing integer parsed numerically ('DC-08' and 'DC-8' both -> 8). */
  readonly sequence: number;
}

const TRAILING_INTEGER = /^(.*?)[-/ ]0*(\d+)\s*$/;
const PREFIX_SHAPE = /^[A-Z0-9][A-Z0-9_/-]*$/;

/** Parses 'PL-221-BSL-DC-1', 'PEBPL/23-24/PL-232/01', 'Pl-244-SUR-DC-03'.
 * Returns null when no trailing integer exists (e.g. 'PL-236-BB-DC-15A')
 * or the derived prefix cannot satisfy the target prefix CHECK. */
export function parseChallanNumber(challanNo: string): ParsedChallanNumber | null {
  const match = TRAILING_INTEGER.exec(challanNo.trim());
  if (!match) return null;
  const rawPrefix = match[1] ?? '';
  const prefix = rawPrefix.toUpperCase();
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  if (prefix.length < 1 || prefix.length > 25 || !PREFIX_SHAPE.test(prefix)) {
    return null;
  }
  return { rawPrefix, prefix, sequence };
}

const WORK_CODE_SHAPE = /^[A-Z0-9][A-Z0-9_/-]*$/;

/** R1: the work code's canonical form is uppercase; 'Pl-244' -> 'PL-244'.
 * Returns null when even the uppercased form violates the target CHECK. */
export function normaliseWorkCode(
  fileNo: string,
): { code: string; original: string; changed: boolean } | null {
  const original = fileNo.trim();
  const code = original.toUpperCase();
  if (code.length < 1 || code.length > 20 || !WORK_CODE_SHAPE.test(code)) return null;
  return { code, original, changed: code !== original };
}

/** Unit codes: collapse internal whitespace ('Route Kilo Meter\n(RKM)' ->
 * one line); when the collapsed form exceeds the 20-char target CHECK,
 * fall back to a parenthesised abbreviation if the source printed one.
 * Returns null when no deterministic form fits. */
export function normaliseUnit(
  unit: string,
): { unit: string; original: string; changed: boolean } | null {
  const original = unit;
  const collapsed = unit.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= 20) {
    return { unit: collapsed, original, changed: collapsed !== original };
  }
  const abbreviation = /\(([^()]{1,20})\)/.exec(collapsed)?.[1]?.trim();
  if (abbreviation && abbreviation.length >= 1 && abbreviation.length <= 20) {
    return { unit: abbreviation, original, changed: true };
  }
  return null;
}

/** Splits a v1 serial list ('Sr.No.IVD0035 \nIVD0036,IVD0037') into clean
 * serial tokens: newline/comma separated, noise prefixes ('Sr.No.',
 * 'Sr No:') stripped, trailing punctuation removed, inner ranges kept
 * verbatim ('CGDB-0224-3353 TO CGDB-0224-3452' stays one token — the
 * importer never invents the expansion). */
export function parseSerials(serialNo: string): string[] {
  return serialNo
    .split(/[\n\r,]+/)
    .map((token) => token.trim())
    .map((token) => token.replace(/^Sr\.?\s*No\.?\s*:?\s*/i, ''))
    .map((token) =>
      token
        .replace(/[.,;:]+$/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((token) => token.length > 0);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time);
}

/** v1 primary keys embed the creation instant: 'dc-1783754862133-053vp'.
 * Returns the embedded timestamp as an ISO string, or null. */
export function timestampFromV1Id(id: string): string | null {
  const match = /^[a-z]+-(\d{13})(?:-|$)/.exec(id);
  if (!match) return null;
  const ms = Number(match[1]);
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}
