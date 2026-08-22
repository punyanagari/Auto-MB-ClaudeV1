/**
 * The two ways a Measurement Book is filed on Indian Railways, and the
 * arithmetic of the first one (migration 0113; owner ruling, live-testing
 * corrections item 24).
 *
 * ## The two ways
 *
 * WAY 1 — "coefficient", this organisation's own practice and the way
 * every document in the committed settlement corpus is written. The
 * recorded quantity is the PHYSICAL quantity multiplied by the payment
 * stage's percentage, and the sheet then pays that figure at 100%: a
 * stage reading "70% for 3 Nos" is recorded as 2.1 and paid in full.
 * `test/fixtures/railway-settlement/BILL-1.raw.txt` item A/01 prints
 * exactly that — `Qty Upto Date 2.1` against an agreement quantity of 6 —
 * and BILL-3 carries the compound case the brief names, `Prepaid 64% for
 * 10, now 64% for 05` summing to 6.4 + 3.2 = 9.6 of an agreement 18.
 *
 * WAY 2 — the physical quantity is recorded and the stage percentage is
 * applied when the bill is computed. This product's engine
 * (`mb-compute.ts`) is way 2 automated: quantities stay physical
 * throughout and `payment-matrix.ts` decides the money.
 *
 * ## Why this module changes no money
 *
 * The way is a RAILWAY-INTERFACE CONVENTION, not a different contract. The
 * internal snapshot stays physical quantities plus percentages either way,
 * every amount is still `computeStageAmounts`, and the Measurement Book's
 * total is byte-identical whichever way it prints. What changes is the
 * quantity column of the draft preview and of the PDF, plus a "Payable"
 * column that reads 100% on a coefficient sheet — which is exactly what
 * IWRCMS itself prints beside its `Reason for Reduction` text.
 *
 * ## The rounding, and the ceiling on it
 *
 * The railway rounds the SCALED QUANTITY to two decimals and multiplies
 * that by the rate. Our engine multiplies the physical quantity by the
 * rate and the percentage and rounds once, at the paise. On every line of
 * the settlement corpus the two agree to the paise, and
 * `test/mb-coefficient.test.ts` proves it against the corpus figures
 * rather than asserting it.
 *
 * They are not equal in general, and the divergence is stated here rather
 * than discovered later: a physical quantity with three or more decimals
 * at a percentage that does not terminate loses information in the
 * quantity rounding — 3.333 at 64% is exactly 2.13312, prints as 2.13, and
 * 2.13 x rate is not 3.333 x rate x 0.64. THE PRINTED QUANTITY IS
 * PRESENTATION AND THE SNAPSHOT IS THE MONEY: nothing here is ever summed
 * into an amount, so a divergence changes what a column reads and never
 * what is paid. The test carries that case too, as a documented
 * difference rather than a regression.
 */

import {
  multiplyDecimalStrings,
  renderQuantity,
  roundDecimalString,
} from './mb-remark.js';

/**
 * How a Measurement Book is transcribed for the railway. Persisted per
 * book (migration 0113) so that the railway-measurement matcher knows
 * which arithmetic the railway's own copy was typed from, rather than
 * guessing it a year later.
 */
export const MB_WAYS = ['coefficient', 'physical'] as const;
export type MbWay = (typeof MB_WAYS)[number];

/** The railway prints its scaled quantities to at most two decimals; the
 * corpus carries 2.1, 0.64, 6.4, 9.6 and 25.2 and nothing longer. */
export const COEFFICIENT_QUANTITY_SCALE = 2;

/**
 * One stage's coefficient quantity: `round2(quantity x percent / 100)`,
 * rendered without trailing fractional zeros the way every other quantity
 * in this product is (`2.10` prints as `2.1`, which is what the railway
 * prints too).
 *
 * Exact decimal strings throughout — the division by 100 is a
 * multiplication by the decimal string `0.01`, so no integer division and
 * no float enters (AGENTS.md rule 5, which binds here even though the
 * result is a quantity: it is multiplied by a rate two lines later on the
 * railway's own sheet).
 */
export function coefficientQuantity(quantity: string, percent: string): string {
  const scaled = multiplyDecimalStrings(
    multiplyDecimalStrings(quantity, percent),
    '0.01',
  );
  return renderQuantity(roundDecimalString(scaled, COEFFICIENT_QUANTITY_SCALE));
}

/** The three stage quantities a Measurement Book line prints, as a
 * coefficient sheet would print them. The final-bill stage is not among
 * them for the same reason the physical rendering omits it: the document
 * has no column for it. */
export interface CoefficientLineQuantities {
  readonly supplied: string;
  readonly installed: string;
  readonly pac: string;
}

/** The coefficient view of one computed or snapshotted line. Computed for
 * EVERY line regardless of the book's way, so the screen picks a column
 * rather than doing decimal arithmetic in the browser. */
export function coefficientLineQuantities(line: {
  readonly deltaSupplied: string;
  readonly deltaInstalled: string;
  readonly deltaPac: string;
  readonly pctSupply: string;
  readonly pctInstallation: string;
  readonly pctPac: string;
}): CoefficientLineQuantities {
  return {
    supplied: coefficientQuantity(line.deltaSupplied, line.pctSupply),
    installed: coefficientQuantity(line.deltaInstalled, line.pctInstallation),
    pac: coefficientQuantity(line.deltaPac, line.pctPac),
  };
}
