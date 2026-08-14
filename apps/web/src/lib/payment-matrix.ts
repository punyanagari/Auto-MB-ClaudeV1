import type { PaymentMatrixCategory, PaymentMatrixRow } from '@auto-mb/contracts';
import { WORK_ITEM_PAYMENT_CATEGORIES } from '@auto-mb/contracts';

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

/**
 * The options an item-category select offers, in the order both the
 * Schedules screen and the setup dialog show them.
 *
 * Generated from CATEGORY_LABELS rather than typed out per screen: two
 * hand-written option lists is how one screen comes to call a category
 * something the other does not, on a field whose value decides which
 * matrix row bills the item.
 *
 * The empty value is the item's own uncategorised STATE, not the
 * UNCATEGORISED matrix row, so it keeps its own shorter name — an item
 * is "Uncategorised"; the row it falls back to is "Uncategorised items".
 */
export const ITEM_CATEGORY_OPTIONS: readonly (readonly [string, string])[] = [
  ['', 'Uncategorised'],
  ...WORK_ITEM_PAYMENT_CATEGORIES.map(
    (category) => [category, CATEGORY_LABELS[category]] as const,
  ),
];

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

/**
 * The exact shape the wire accepts, narrowed to a percentage.
 *
 * `DecimalStringSchema` (packages/contracts/src/primitives.ts) is
 * `^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$`: no leading zeros, no surrounding
 * whitespace, no bare `.5`. Anything outside it is a 400 from Fastify's
 * own body validation, BEFORE the route's friendly percentage message
 * ever runs — so a client rule looser than this one buys the operator a
 * schema error naming a field instead of the sentence that says what to
 * type. `05`, ` 50` and `0100` are the three that used to get through.
 *
 * Narrower than the schema in two ways, both deliberate: no minus sign
 * (a negative stage percentage is meaningless and the column's CHECK
 * refuses it) and two fraction digits rather than three (the stored
 * column is numeric(5,2), and the server validates in hundredths).
 *
 * Checked part by part rather than with one composite pattern: the
 * security linter reads a bounded quantifier nested under an alternation
 * as catastrophic-backtracking bait, and the parts are already split
 * here to be converted. `errors.ts` makes the same trade for the same
 * reason.
 */
const DIGITS = /^\d+$/;

/** Percentage in integer hundredths (two-decimal precision), or null
 * when the text is not a plain 0–100 decimal in the wire's own shape.
 * Never floats. */
export function percentHundredths(raw: string): bigint | null {
  const dot = raw.indexOf('.');
  const whole = dot === -1 ? raw : raw.slice(0, dot);
  const fraction = dot === -1 ? '' : raw.slice(dot + 1);
  if (whole.length < 1 || whole.length > 3 || !DIGITS.test(whole)) return null;
  // `05` and `0100` are refused by the wire's own schema, so they are
  // refused here rather than one layer later and less legibly.
  if (whole.length > 1 && whole.startsWith('0')) return null;
  if (dot !== -1) {
    if (fraction.length < 1 || fraction.length > 2 || !DIGITS.test(fraction)) {
      return null;
    }
  }
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

/**
 * Whether the operator has typed anything at all into this row. A row
 * left entirely blank is "not configured", which is a legitimate state —
 * it is not an invalid row and it is never submitted.
 *
 * A SPACE counts. It is a keystroke the operator made, and the row it
 * made is unsaveable: `percentHundredths` refuses whitespace exactly as
 * the wire's own schema does. Trimming here would have called the row
 * untouched, hidden the inline message that says why Save is held, and
 * left the operator looking at a Save button disabled for no visible
 * reason. Touched decides whether the row EXPLAINS itself; `problem`
 * still decides whether it may be submitted, and a whitespace row is
 * still never submitted.
 */
export function draftTouched(draft: RowDraft): boolean {
  return STAGE_FIELDS.some(([field]) => draft[field] !== '');
}

export function samePercent(left: string, right: string): boolean {
  return percentHundredths(left) === percentHundredths(right);
}

/**
 * Whether a submitted draft says exactly what the saved row already
 * says. Used to keep an untouched row OUT of a save.
 *
 * Compared as percentages rather than as text, because the two are not
 * the same string: the column is numeric(5,2), so a row typed as `80`
 * loads back as `80.00`, and comparing text would call every loaded row
 * changed and write an audit event whose before and after are equal.
 */
export function sameRowPercentages(
  draft: RowDraft,
  row: PaymentMatrixRow | undefined,
): boolean {
  if (row === undefined) return false;
  return STAGE_FIELDS.every(([field]) => samePercent(draft[field], row[field]));
}
