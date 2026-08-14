import type { PaymentMatrixCategory, PaymentMatrixRow } from '@auto-mb/contracts';

/**
 * The payment matrix as a FORM: the four stage percentages of one
 * category, the rules they must satisfy, and the names the operator sees.
 *
 * Extracted from `views/PaymentMatrix.tsx` when the post-creation payment
 * setup dialog needed the same editor. Two screens validating the same
 * rule from two copies is how one of them comes to accept a row the
 * server refuses, so the rule lives here once and both read it: 0–100 per
 * stage with at most two decimals, an exact sum of 100, and the AMC row's
 * two locked stages. All of it in integer hundredths — never floats.
 */

export const CATEGORY_LABELS: Record<PaymentMatrixCategory, string> = {
  SUPPLY: 'Supply',
  SUPPLY_AND_INSTALLATION: 'Supply + installation',
  PURE_INSTALLATION: 'Purely installation',
  SPARE_SUPPLY: 'Spare supply',
  AMC: 'Annual maintenance (AMC)',
  UNCATEGORISED: 'Uncategorised items',
};

export const STAGE_FIELDS = [
  ['pctSupply', 'Supply %'],
  ['pctInstallation', 'Installation %'],
  ['pctPac', 'PAC %'],
  ['pctFinalBill', 'Final bill %'],
] as const;

export type StageField = (typeof STAGE_FIELDS)[number][0];

/** The two stages an AMC row may never bill on (migration 0068), because
 * an AMC item takes no Delivery Challan line and no installation record
 * and so can never move a quantity through either. */
export const LOCKED_AMC_STAGES: ReadonlySet<StageField> = new Set([
  'pctSupply',
  'pctInstallation',
]);

export type RowDraft = Record<StageField, string>;

/** Percentage in integer hundredths (two-decimal precision), or null
 * when the text is not a plain 0–100 decimal. Never floats. */
export function percentHundredths(raw: string): bigint | null {
  const text = raw.trim();
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  if (!/^\d{1,3}$/.test(whole)) return null;
  if (dot !== -1 && !/^\d{1,2}$/.test(fraction)) return null;
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  return value > 10000n ? null : value;
}

/**
 * The draft as it will actually be SUBMITTED.
 *
 * For an AMC row the two locked stages are 0 whatever the draft holds
 * (migration 0068), so validation, the sum-to-100 check and the request
 * body all read the same four numbers. Deriving the payload separately
 * from the thing that was validated is how a form comes to refuse a row
 * it would have accepted, or send one it showed as invalid.
 */
export function submittedDraft(category: string, draft: RowDraft): RowDraft {
  if (category !== 'AMC') return draft;
  return { ...draft, pctSupply: '0', pctInstallation: '0' };
}

/** Inline validation message for a draft, or null when it is saveable. */
export function draftProblem(draft: RowDraft): string | null {
  let total = 0n;
  for (const [field, label] of STAGE_FIELDS) {
    const value = percentHundredths(draft[field]);
    if (value === null) {
      return `${label} must be a number between 0 and 100 with at most two decimals.`;
    }
    total += value;
  }
  if (total !== 10000n) {
    return 'The four stages must sum to exactly 100.';
  }
  return null;
}

export function draftFrom(row: PaymentMatrixRow | undefined): RowDraft {
  return {
    pctSupply: row?.pctSupply ?? '',
    pctInstallation: row?.pctInstallation ?? '',
    pctPac: row?.pctPac ?? '',
    pctFinalBill: row?.pctFinalBill ?? '',
  };
}

/** Whether the operator has typed anything at all into this row. A row
 * left entirely blank is "not configured", which is a legitimate state —
 * it is not an invalid row and it is never submitted. */
export function draftTouched(draft: RowDraft): boolean {
  return STAGE_FIELDS.some(([field]) => draft[field].trim() !== '');
}

export function samePercent(left: string, right: string): boolean {
  return percentHundredths(left) === percentHundredths(right);
}
