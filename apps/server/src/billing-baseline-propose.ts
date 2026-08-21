/**
 * Proposing a Work's opening billing position from the railway's own last
 * measurement sheet (migration 0114; owner ruling, corrections item 23).
 *
 * ## What it reads, and why that document
 *
 * The sheet's `Reason for Reduction` line is the same contractual remark
 * `mb-remark.ts` generates, re-typeset by IWRCMS, and it states the whole
 * history of an item in one sentence: what was paid before this
 * measurement and what this one adds, each at its own stage percentage.
 * "Prepaid 70% for 13 Nos and 20% for 02 Nos Now to Pay 70% for 05 Nos"
 * says the item has been billed 18 units at 70% and 2 at 20% by the time
 * the sheet was written — which is precisely the per-stage cumulative a
 * baseline line needs.
 *
 * `railway-measurement-parse.ts` already reads those lines, and reads them
 * out of three real documents in the committed corpus rather than out of
 * a guess. Everything here works on its output.
 *
 * ## What it deliberately does NOT read
 *
 * The BILL's own item table, which prints the cumulative money per item
 * and would be the better source for the amount. Migration 0114's header
 * carries the evidence for that decision; the short version is that its
 * numeric cells wrap across three lines into misaligned columns, adjacent
 * columns collide into single layout cells, and a parser built against it
 * read 82 of BILL-3's 129 item blocks. A silently wrong money proposal
 * under a confirmation button is the worst thing this module could
 * produce, so the amount is DERIVED instead — through the same
 * `computeStageAmounts` every Measurement Book line is priced with, at
 * the item's own accepted rate — and the bill's own total is put on
 * screen beside the proposed sum for the operator to check it against.
 *
 * ## And it proposes NOTHING rather than something plausible
 *
 * Two cases return null, and both are cases where a wrong answer would be
 * indistinguishable from a right one on screen: a percentage in the
 * remark that matches no stage of the item's payment matrix, and one that
 * matches more than one. There is no third source of evidence to break
 * either tie, and the fallback — an operator typing the line — is a
 * recorded act with an author, which a guess is not.
 */

import type { PaymentMatrixPercentages } from './payment-matrix.js';
import { addDecimalStrings, computeStageAmounts, renderQuantity } from './mb-remark.js';

/** One `<percent>% for <quantity>` claim, as the remark states it. */
export interface RemarkClaim {
  readonly percent: string;
  readonly quantity: string;
}

/**
 * Every claim in one remark, with the claims at a single percentage
 * summed.
 *
 * PREPAID AND NOW-TO-PAY ARE DELIBERATELY NOT SEPARATED. A baseline
 * states one cumulative per stage, and the sheet's two clauses are the
 * two halves of exactly that: what was billed before this measurement,
 * and what this one adds. Reading them apart and adding them back would
 * be the same arithmetic with a place to get it wrong.
 *
 * Zero-padded quantities are the railway's house style ("for 02 Nos") and
 * are normalised by the exact-decimal reader, not by `Number`.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- two digit runs each with an optional bounded fraction group and no nested quantifier; linear on all inputs (same shape as amount-in-words.ts)
const CLAIM = /(\d+(?:\.\d+)?)\s*%\s*for\s+(\d+(?:\.\d+)?)/g;

export function parseRemarkClaims(remark: string): readonly RemarkClaim[] {
  const byPercent = new Map<string, string>();
  for (const match of remark.matchAll(CLAIM)) {
    const percent = renderQuantity(match[1] ?? '0');
    const quantity = renderQuantity(match[2] ?? '0');
    byPercent.set(percent, addDecimalStrings(byPercent.get(percent) ?? '0', quantity));
  }
  return [...byPercent].map(([percent, quantity]) => ({ percent, quantity }));
}

/** The four stage quantities a baseline line carries, and what they come
 * to in rupees at the item's accepted rate. */
export interface ProposedBaselineLine {
  readonly priorSupplied: string;
  readonly priorInstalled: string;
  readonly priorPac: string;
  readonly priorFinalBill: string;
  readonly amount: string;
}

const STAGES = [
  ['supply', 'pctSupply', 'priorSupplied'],
  ['installation', 'pctInstallation', 'priorInstalled'],
  ['pac', 'pctPac', 'priorPac'],
  ['final_bill', 'pctFinalBill', 'priorFinalBill'],
] as const;

/**
 * Turns one railway remark into a proposed opening line for one item, or
 * null where the remark cannot be attributed to stages without guessing.
 *
 * The attribution is by PERCENTAGE, which is the only key the two
 * documents share: the sheet names a percentage and a quantity, the
 * Work's payment matrix names a percentage per stage. A percentage
 * matching exactly one stage is that stage's; anything else returns null
 * for the whole line, because a line with two stages attributed and one
 * abandoned is worse than a line an operator was asked to type.
 */
export function proposeBaselineLine(input: {
  readonly remark: string;
  readonly percentages: PaymentMatrixPercentages;
  readonly effectiveRate: string;
}): ProposedBaselineLine | null {
  const claims = parseRemarkClaims(input.remark);
  const quantities: Record<string, string> = {
    priorSupplied: '0',
    priorInstalled: '0',
    priorPac: '0',
    priorFinalBill: '0',
  };
  for (const claim of claims) {
    const matching = STAGES.filter(
      ([, percentKey]) =>
        renderQuantity(input.percentages[percentKey]) === claim.percent,
    );
    if (matching.length !== 1) return null;
    const [entry] = matching;
    if (entry === undefined) return null;
    quantities[entry[2]] = addDecimalStrings(
      quantities[entry[2]] ?? '0',
      claim.quantity,
    );
  }
  const amounts = computeStageAmounts({
    effectiveRate: input.effectiveRate,
    stages: STAGES.map(([stage, percentKey, quantityKey]) => ({
      stage,
      percent: input.percentages[percentKey],
      deltaQuantity: quantities[quantityKey] ?? '0',
    })),
  });
  return {
    priorSupplied: quantities['priorSupplied'] ?? '0',
    priorInstalled: quantities['priorInstalled'] ?? '0',
    priorPac: quantities['priorPac'] ?? '0',
    priorFinalBill: quantities['priorFinalBill'] ?? '0',
    amount: amounts.total,
  };
}
