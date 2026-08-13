/**
 * Which review-screen values the letter already decided, and which ones the
 * parser left for a human (owner ruling, 2026-08-13: "the details extracted
 * from LOA like date, above/below % etc should not be user editable as it's
 * the truth source").
 *
 * THE SERVER IS THE CONTROL, NOT THIS MODULE. `POST
 * /api/loa-documents/:id/confirm` derives the same locked-versus-fillable
 * split from the STORED parse and refuses a modified locked value by name
 * (`LOA_EXTRACTED_VALUE_MODIFIED`); `apps/server/src/loa-extracted-values.ts`
 * carries the authoritative statement of the rule. What follows is the
 * screen's reading of the same payload, so a locked value is presented as
 * the settled fact it is instead of as an input that will be rejected on
 * submit. If the two ever disagree, the screen is wrong and the server
 * refuses — the failure direction is a refusal a reviewer can see, never
 * data accepted that should not have been.
 *
 * The rule, unchanged: a value is LOCKED if and only if the parse produced
 * it and did not declare it unverifiable. Everything else is a hole the
 * reviewer may fill.
 */
import type {
  ExtractionPayloadView,
  ParsedItemView,
  ReviewFlagView,
} from './loa-payload.js';
import { normaliseDecimal, parseDecimalMinorUnits } from './loa-payload.js';

/** The locked letter-level values. `true` means "the letter decided this". */
export interface LetterLocks {
  readonly letterNumber: boolean;
  readonly letterDate: boolean;
  readonly title: boolean;
  readonly advertisedValue: boolean;
  readonly contractValue: boolean;
  readonly pricingShape: boolean;
  readonly letterPercentage: boolean;
  readonly letterPercentageDirection: boolean;
  /** The whole performance-guarantee requirement: whether the letter
   * demands one, for how much, and within how many days. */
  readonly pbgClause: boolean;
  readonly pbgExtensionDays: boolean;
  readonly pbgPenalInterest: boolean;
}

export interface ItemLocks {
  readonly description: boolean;
  readonly unitCode: boolean;
  readonly awardedQuantity: boolean;
  readonly effectiveRate: boolean;
}

/** The item-scoped flag codes that unlock a field, mirroring the server's
 * `ITEM_FLAG_UNLOCKS`. `prose_corrigendum` is deliberately absent: it is a
 * broad keyword scan marking a letter worth reading, not a field worth
 * editing. */
const ITEM_FLAG_UNLOCKS: Readonly<Record<string, readonly (keyof ItemLocks)[]>> = {
  unresolved_unit: ['unitCode'],
  prose_unit_correction: ['unitCode'],
  prose_qty_decomposition: ['awardedQuantity', 'unitCode'],
  layout_junk: ['description'],
};

/** A stable per-row identifier: the same `<scheduleId>#<itemSno>` the
 * parser stamps on every item-scoped flag. */
export function itemTargetId(scheduleId: string, itemSno: string): string {
  return `${scheduleId}#${itemSno}`;
}

export function letterLocksOf(payload: ExtractionPayloadView): LetterLocks {
  const { header, pricingShape } = payload.review;
  const totalsUsable = !pricingShape.needsReview;
  const guarantee = header.performanceGuarantee;
  const clauseUsable =
    guarantee !== undefined &&
    !guarantee.needsReview &&
    guarantee.amountFigures !== null &&
    guarantee.submissionDays !== null;
  return {
    letterNumber:
      header.letterNumber.value !== null && !header.letterNumber.needsReview,
    // A date the parser could not reduce to YYYY-MM-DD cannot be submitted
    // at all, so it is a hole rather than a lock.
    letterDate:
      header.letterDate.value !== null &&
      !header.letterDate.needsReview &&
      /^\d{4}-\d{2}-\d{2}$/.test(header.letterDate.value),
    title: header.workDescription.value !== null && !header.workDescription.needsReview,
    advertisedValue: totalsUsable && pricingShape.advertised_value !== null,
    contractValue: totalsUsable && pricingShape.contract_value !== null,
    pricingShape: totalsUsable && pricingShape.pricing_shape !== null,
    letterPercentage: totalsUsable && pricingShape.letter_percentage !== null,
    letterPercentageDirection:
      totalsUsable && pricingShape.letter_percentage_direction !== null,
    pbgClause: clauseUsable,
    pbgExtensionDays: clauseUsable && guarantee.extensionDays !== null,
    pbgPenalInterest: clauseUsable && guarantee.penalInterestPercent !== null,
  };
}

/** Every flag the parser raised against one row, for display beside the
 * field it left open. */
export function itemFlagsOf(
  payload: ExtractionPayloadView,
  targetId: string,
): readonly ReviewFlagView[] {
  return payload.review.flags.filter((flag) => flag.targetId === targetId);
}

export function itemLocksOf(
  payload: ExtractionPayloadView,
  item: ParsedItemView,
): ItemLocks {
  const targetId = itemTargetId(item.schedule?.id ?? 'UNBOUND', item.itemSno);
  const unlocked = new Set<keyof ItemLocks>();
  for (const flag of payload.review.flags) {
    // Letter-scoped: the PDF's reading order confirmed no row's description
    // boundary, so every description stays correctable.
    if (flag.code === 'unresolved_item_description') {
      unlocked.add('description');
      continue;
    }
    if (flag.targetId !== targetId) continue;
    for (const field of ITEM_FLAG_UNLOCKS[flag.code] ?? []) unlocked.add(field);
  }
  const reconciled = item.reconciliation?.ok === true;
  // Exact integer minor units, never float — the same discipline the rest
  // of the review screen's arithmetic keeps.
  const quantity = parseDecimalMinorUnits(normaliseDecimal(item.qty, 3), 3);
  return {
    description:
      !unlocked.has('description') &&
      item.descriptionSource === 'raw-exact' &&
      item.description.trim().length >= 3,
    // The unit is locked exactly when the printed spelling resolved to a
    // canonical unit — which is the same test that raises `unresolved_unit`,
    // so the flag alone decides it without the web carrying the unit list.
    unitCode: !unlocked.has('unitCode') && item.qtyUnit !== null,
    // A quantity of zero cannot be submitted (the column is strictly
    // positive), so it is a hole however cleanly it was read.
    awardedQuantity:
      !unlocked.has('awardedQuantity') &&
      reconciled &&
      quantity !== null &&
      quantity > 0n,
    effectiveRate:
      !unlocked.has('effectiveRate') &&
      reconciled &&
      normaliseDecimal(item.unitRate, 6).length > 0,
  };
}
