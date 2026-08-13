/**
 * Executed value, computed against a Work's RECORDED GST basis.
 *
 * Owner ruling, 13 August 2026: LOA rates are USUALLY GST-inclusive at 18%
 * — works contracts sit in the 18% slab — but SOME LOAs quote
 * GST-exclusive rates. Rare, and real. So the basis is a per-Work
 * attribute captured from its LOA (`works.gst_basis` / `works.gst_rate`,
 * migration 0062), and every comparison of money against a contract value
 * is made through this module. There is no 1.18 anywhere else.
 *
 * WHAT GOES WRONG WITHOUT IT, and in which direction. Executed value
 * drives work completion, and a Work may be marked completed only at 100%
 * executed value. Reading a GST-EXCLUSIVE letter as inclusive compares
 * GST-inclusive money against a contract value that excludes GST and
 * OVERSTATES execution by the GST factor: the Work reads 100% executed at
 * 100/1.18 = 84.75% of its real value, so it can be closed with roughly a
 * sixth of the contract still unbilled — silently. The opposite mistake
 * merely holds a finished Work open, which is visible and annoying rather
 * than silent and expensive.
 *
 * THE RULE IS "COMPARE LIKE WITH LIKE", not "divide by 1.18". Once the
 * basis is known, executed value is the SAME percentage whether computed
 * GST-inclusive (bill totals against the Net Bid Value) or GST-exclusive
 * (invoice taxable values against Net Bid Value / 1.18), because both
 * sides scale by the same factor. What must never happen is MIXING them —
 * and that is the natural mistake, because bills state a GST-inclusive
 * figure while tax invoices state a taxable one, so reaching for whichever
 * number is nearest moves the answer by the whole GST wedge. On the PL-270
 * corpus: 29.4874% on either consistent basis, 24.9893% mixed
 * (apps/server/test/fixtures/railway-settlement/corpus.json).
 *
 * That is why every entry point here takes the basis of its numerator as
 * an argument rather than assuming one. A caller holding a figure whose
 * basis it cannot name is holding a figure it cannot compare, and the type
 * makes it say so.
 *
 * ARITHMETIC. Everything is exact integer paise via BigInt — money never
 * touches a JavaScript float here, in line with the rest of the codebase
 * (dashboard's sumDecimal, tax-invoice-snapshot's scaledPaise). Division
 * rounds half away from zero, the convention Indian tax rounding uses and
 * the one PostgreSQL's `round(numeric)` applies.
 */

/** Which side of GST a money figure is stated on. Mirrors the
 * `works.gst_basis` CHECK and `GstBasisSchema`. */
export type GstBasis = 'inclusive' | 'exclusive';

/** A Work's recorded basis, as read from `works`. `ratePercent` is the
 * numeric(5,2) column as a decimal string ('18.00'). */
export interface WorkGstBasis {
  readonly basis: GstBasis;
  readonly ratePercent: string;
}

/** Money is rupees with two fraction digits, everywhere in this schema. */
const MONEY_SCALE = 2;
/** Percentages are reported to four places: the corpus records executed
 * value as 29.4874%, and the whole point of the mixed-basis case is that
 * it is recognisable (29.4874 / 24.9893 = 1.18), which needs the
 * fraction digits to survive. */
const PERCENT_SCALE = 4;

/** Rates are numeric(5,2) percent, so a factor is carried in hundredths
 * of a percent: 18.00% -> 1800, and the multiplier is
 * (10000 + 1800) / 10000. */
const RATE_UNIT = 10_000n;

function parsePaise(value: string, label: string): bigint {
  // Fully anchored, one digit run then an optional fraction bounded to two
  // digits, no nested quantifier; linear on all inputs. Same shape as
  // tax-invoice-snapshot.ts's scaledPaise.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) {
    throw new Error(`${label} is not an exact money figure: ${JSON.stringify(value)}`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const fraction = BigInt((match[3] ?? '').padEnd(MONEY_SCALE, '0'));
  return sign * (whole * 100n + fraction);
}

function formatMinor(minor: bigint, scale: number): string {
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const divisor = 10n ** BigInt(scale);
  const whole = (magnitude / divisor).toString();
  const fraction = (magnitude % divisor).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Exact division rounding half AWAY FROM ZERO, on a strictly positive
 * divisor. `5n / 2n` is 2n in BigInt (truncation), which would bias every
 * conversion downwards; this is the rounding the money columns already
 * assume. */
function divideRoundHalfUp(numerator: bigint, divisor: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (magnitude * 2n + divisor) / (divisor * 2n);
  return negative ? -rounded : rounded;
}

function rateFactor(ratePercent: string): bigint {
  // Same shape as parsePaise's, without the sign: a rate is never negative.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(ratePercent.trim());
  if (match === null) {
    throw new Error(
      `GST rate is not an exact percentage: ${JSON.stringify(ratePercent)}`,
    );
  }
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0'));
  // 18.00% -> 1800 hundredths of a percent -> a factor of 11800/10000.
  return RATE_UNIT + whole * 100n + fraction;
}

/**
 * Restates a money figure from one GST basis to the other, exactly.
 *
 * Converting is LOSSY at paise granularity and cannot be otherwise: an
 * inclusive figure divided by 1.18 rarely lands on a whole paisa. The
 * corpus records the same drift on real documents — PL-270's Net Bid
 * Value is 169,228,497.35 inclusive and 143,413,980.81 exclusive, which
 * multiply back to within one paisa, not to zero. Callers that need an
 * exact tie compare in paise with a one-paisa tolerance, exactly as
 * railway-settlement-corpus.test.ts does; callers that need a percentage
 * are unaffected, because a paisa on a rupee crore is far below the
 * reported precision.
 */
export function convertAmountToBasis(
  amount: string,
  from: GstBasis,
  to: GstBasis,
  ratePercent: string,
): string {
  const paise = parsePaise(amount, 'amount');
  if (from === to) return formatMinor(paise, MONEY_SCALE);
  const factor = rateFactor(ratePercent);
  const converted =
    from === 'inclusive'
      ? // strip the tax that is already in the figure
        divideRoundHalfUp(paise * RATE_UNIT, factor)
      : // add the tax the figure does not carry
        divideRoundHalfUp(paise * factor, RATE_UNIT);
  return formatMinor(converted, MONEY_SCALE);
}

/**
 * Restates a figure onto the basis the Work's own contract value is
 * quoted on — the only basis a numerator may be divided by
 * `contract_value` on.
 */
export function toContractBasis(
  amount: string,
  amountBasis: GstBasis,
  work: WorkGstBasis,
): string {
  return convertAmountToBasis(amount, amountBasis, work.basis, work.ratePercent);
}

/**
 * Restates a figure onto the GST-EXCLUSIVE (taxable) basis.
 *
 * This is the canonical basis for anything that AGGREGATES ACROSS WORKS.
 * Summing one Work's GST-inclusive contract value with another's
 * GST-exclusive one produces a rupee figure that is on no basis at all,
 * and a portfolio percentage computed from two such sums is wrong by a
 * fraction of the GST wedge that varies with the mix. Taxable value is
 * the side every Work can be stated on without inventing anything, so
 * that is where cross-Work totals are computed.
 */
export function toTaxableBasis(
  amount: string,
  amountBasis: GstBasis,
  work: WorkGstBasis,
): string {
  return convertAmountToBasis(amount, amountBasis, 'exclusive', work.ratePercent);
}

/**
 * Executed value as a percentage of the contract, on a single basis.
 *
 * `numeratorBasis` is the basis the money figure is stated on, which the
 * caller must know: a delivered or billed total derived from the LOA's own
 * rates carries the Work's basis, while a figure lifted from a tax
 * invoice's taxable value is GST-exclusive whatever the letter says.
 *
 * Returns null when the contract value is zero — a percentage of nothing
 * is not 0% and not 100%, and pretending otherwise would let a Work with
 * no contract value report as fully executed.
 */
export function executedPercent(
  numerator: string,
  numeratorBasis: GstBasis,
  contractValue: string,
  work: WorkGstBasis,
): string | null {
  const denominator = parsePaise(contractValue, 'contractValue');
  if (denominator === 0n) return null;
  const comparable = parsePaise(
    toContractBasis(numerator, numeratorBasis, work),
    'numerator',
  );
  const scaled = comparable * 100n * 10n ** BigInt(PERCENT_SCALE);
  return formatMinor(divideRoundHalfUp(scaled, denominator), PERCENT_SCALE);
}

/**
 * The same percentage over MANY Works, each carrying its own basis.
 *
 * Every term is restated as taxable value before it joins either sum, so
 * a portfolio holding both kinds of letter aggregates coherently. A Work
 * whose contract value is zero contributes to neither side rather than
 * poisoning the ratio.
 */
export function portfolioExecutedPercent(
  works: readonly {
    readonly contractValue: string;
    readonly numerator: string;
    readonly numeratorBasis: GstBasis;
    readonly gst: WorkGstBasis;
  }[],
): string | null {
  let numeratorPaise = 0n;
  let denominatorPaise = 0n;
  for (const work of works) {
    const contract = parsePaise(
      toTaxableBasis(work.contractValue, work.gst.basis, work.gst),
      'contractValue',
    );
    if (contract === 0n) continue;
    denominatorPaise += contract;
    numeratorPaise += parsePaise(
      toTaxableBasis(work.numerator, work.numeratorBasis, work.gst),
      'numerator',
    );
  }
  if (denominatorPaise === 0n) return null;
  const scaled = numeratorPaise * 100n * 10n ** BigInt(PERCENT_SCALE);
  return formatMinor(divideRoundHalfUp(scaled, denominatorPaise), PERCENT_SCALE);
}
