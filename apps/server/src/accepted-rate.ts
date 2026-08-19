/**
 * The ACCEPTED rate of a Work item — the rate the railway actually pays —
 * derived from the rate printed in the LOA item table.
 *
 * Owner ruling, 13 August 2026 (ruling 1 of
 * `docs/FINDING-2026-08-13-invoice-money-basis.md`): the server computes
 * the accepted rate from the printed rate and the letter's own percentage.
 * It is never typed by a reviewer and never guessed.
 *
 * WHY THIS EXISTS. An LOA's item table prints ADVERTISED rates. The tender
 * result — `14.35% Below`, `24.5% Above` — is printed once per schedule
 * (shape B) or once for the whole letter (shape A), and it is what turns an
 * advertised rate into the agreement rate. The parser has always known
 * this; its own module doc records that summing item rows "reproduces
 * advertised_value, not contract_value, a 29% error on PL275". The product
 * nevertheless stored the printed rate as `work_items.effective_rate`, so
 * every challan value, Measurement Book total, bill and invoice was
 * computed at the wrong rate — high on a below-par letter, low on an
 * above-par one.
 *
 * THE FORMULA IS THE RAILWAY'S OWN, and it reproduces their Agreement Rate
 * column EXACTLY rather than approximately. PL-270 Schedule A is 14.35%
 * below:
 *
 *     item 01   2,490,000.00 x 0.8565 = 2,132,685.00      (bill: 2132685.0)
 *     item 02     103,750.00 x 0.8565 =    88,861.875     (bill: 88861.875)
 *     item 06     341,813.70 x 0.8565 =   292,763.43405   (bill: 292763.43405)
 *
 * That exactness is the reason the percentage is read rather than a factor
 * derived from the schedule's printed totals. Dividing bid by advertised
 * gives 0.85649999..., not 0.8565, and item 01 would come out at
 * 2,132,684.9997 — a rate that no longer matches the document the railway
 * signed, and a reconciliation argument on every bill forever.
 *
 * SCALE. Rates are `numeric(18,6)`. A printed rate carries at most 6
 * fraction digits and a percentage at most 3, so the product needs at most
 * 9 and is rounded half away from zero to the column's 6 — the same
 * rounding `executed-value.ts` and the tax columns use. On the real corpus
 * no rounding occurs at all: printed rates carry 2 digits and percentages
 * 2, so the product lands on 4 or 5 exactly.
 */

/** The three tender outcomes, spelled as the `works` CHECK does. */
type ParDirection = 'below' | 'at_par' | 'above';

/** A letter's (or a schedule's) accepted-rate percentage and its
 * direction, as printed. */
export interface AcceptedRateBasis {
  /** Decimal string, up to three fraction digits — the `numeric(6,3)`
   * column's own scale. */
  readonly percentage: string;
  readonly direction: ParDirection;
}

/** Rate columns are numeric(18,6). */
const RATE_SCALE = 6;
/** Percentages are numeric(6,3), so a factor is carried in
 * hundred-thousandths: 14.35% -> 14350, against a whole of 100000. */
const PERCENT_UNIT = 100_000n;

function parseScaled(value: string, scale: number, label: string): bigint {
  // Fully anchored, one digit run then an optional bounded fraction, no
  // nested quantifier; linear on all inputs.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) {
    throw new Error(`${label} is not a plain decimal: ${JSON.stringify(value)}`);
  }
  const fraction = match[2] ?? '';
  if (fraction.length > scale) {
    throw new Error(
      `${label} carries more than ${String(scale)} fraction digits: ${JSON.stringify(value)}`,
    );
  }
  return (
    BigInt(match[1] ?? '0') * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'))
  );
}

function formatScaled(minor: bigint, scale: number): string {
  const divisor = 10n ** BigInt(scale);
  const whole = (minor / divisor).toString();
  const fraction = (minor % divisor).toString().padStart(scale, '0');
  return `${whole}.${fraction}`;
}

/** Half away from zero, on a positive divisor — BigInt division truncates,
 * which would bias every derived rate downwards. */
function divideRoundHalfUp(numerator: bigint, divisor: bigint): bigint {
  return (numerator * 2n + divisor) / (divisor * 2n);
}

/**
 * The accepted rate for one item, as an exact decimal string at the rate
 * column's scale.
 *
 * `at_par` returns the printed rate unchanged — and returns it through the
 * same formatting path rather than short-circuiting, so an at-par item and
 * a 0%-below item are indistinguishable downstream, as they should be.
 */
export function acceptedRateFrom(
  advertisedRate: string,
  basis: AcceptedRateBasis,
): string {
  const rate = parseScaled(advertisedRate, RATE_SCALE, 'advertised rate');
  const percent = parseScaled(basis.percentage, 3, 'accepted percentage');
  if (basis.direction === 'at_par') {
    if (percent !== 0n) {
      // An at-par letter that also prints a percentage is contradicting
      // itself, and picking either reading would be a guess about money.
      throw new Error(
        `an at-par letter cannot also carry a percentage (${basis.percentage})`,
      );
    }
    return formatScaled(rate, RATE_SCALE);
  }
  const sign = basis.direction === 'above' ? 1n : -1n;
  const factor = PERCENT_UNIT + sign * percent;
  if (factor < 0n) {
    // A rebate deeper than 100% would invert the rate's sign. No real
    // letter does this; refusing beats storing a negative rate.
    throw new Error(`a ${basis.percentage}% rebate would make the rate negative`);
  }
  return formatScaled(divideRoundHalfUp(rate * factor, PERCENT_UNIT), RATE_SCALE);
}

/**
 * THE COMPOUND SHAPE (owner ruling Q5, 2026-08-19, from PL-257/SBC):
 * accepted = the NEGOTIATED per-item bid rate x (1 - the rebate on the
 * total value).
 *
 * NOTHING CALLS THIS IN PRODUCTION YET, and that is deliberate rather
 * than an oversight. The shape needs two figures the extraction cannot
 * supply: PL-257's item table does not decompose at all — the negotiated
 * Bid Rate column defeats the anchor tail, and the parser answers by
 * keeping every raw line and raising `layout_junk` on all thirteen rows
 * (`packages/loa-parser/test/amc-corpus.test.ts` pins exactly that).
 * Wiring a caller before those rows parse would mean feeding it the
 * ADVERTISED rate, which is the one number the ruling says is wrong.
 * The rule is written and proved here against the letter's own printed
 * totals; the caller lands with the SBC-shaped importer work that makes
 * the rows readable.
 *
 * Nothing mis-prices meanwhile: a letter of this shape prints a non-zero
 * `Rebate on Total Value`, which `detectUnexpectedRebate` flags at
 * letter level, so it reaches a human before any rate is confirmed.
 *
 * A THIRD SHAPE, not a variation of the two above, and the difference is
 * which number the percentage is applied TO. Shapes A and B apply a
 * letter- or schedule-level tender result to the ADVERTISED rate,
 * because that is the only rate those letters print per item. PL-257
 * prints two: an advertised rate and a `Bid Rate/Unit Rate` the
 * contractor negotiated down to, item by item — and then takes a further
 * `Rebate on Total Value (%)` off the schedule's total. Its own totals
 * prove which of the two the rebate multiplies: the schedule sums to
 * 1,653,075.04 at the BID rates, and 1,653,075.04 x 0.99 is the letter's
 * Net Bid Value of 1,636,544.29 exactly. Applying the rebate to the
 * advertised rates reproduces neither figure.
 *
 * So the base is the bid rate and the multiplier is the rebate, and
 * this is the same arithmetic `acceptedRateFrom` already does — one
 * rate, one percentage, below par — named so a call site cannot pass the
 * advertised rate to it by accident. Exact decimal throughout, at the
 * rate column's own scale, like everything else here.
 *
 * A letter that prints bid rates and NO rebate passes '0': the accepted
 * rate is then the bid rate, and it travels through the same formatting
 * path so it is indistinguishable from any other 0%-below item.
 */
export function acceptedRateFromBid(bidRate: string, rebatePercent: string): string {
  return acceptedRateFrom(bidRate, { percentage: rebatePercent, direction: 'below' });
}
