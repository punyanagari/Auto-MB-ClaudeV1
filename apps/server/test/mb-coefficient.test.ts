import { describe, expect, it } from 'vitest';
import {
  coefficientLineQuantities,
  coefficientQuantity,
} from '../src/mb-coefficient.js';
import {
  addDecimalStrings,
  computeStageAmounts,
  multiplyDecimalStrings,
  roundDecimalString,
} from '../src/mb-remark.js';

/**
 * The coefficient rendering, proved against the railway's own arithmetic
 * (migration 0113; owner ruling, corrections item 24).
 *
 * Every figure in the first two blocks is READ OFF the committed
 * settlement corpus — `test/fixtures/railway-settlement/BILL-{1,3}.raw.txt`
 * — rather than invented, and each case names the line it came from so a
 * reviewer can check it against the document by hand. That matters more
 * here than anywhere else in this module: the whole claim being tested is
 * that our arithmetic and IWRCMS's land on the same paise, and a test
 * built from our own outputs would be asserting that we agree with
 * ourselves.
 */

/** One item row of an IWRCMS On-Account Bill, as printed. */
interface CorpusRow {
  readonly source: string;
  /** The physical quantity the remark states, and the stage percentage it
   * states it at. A compound row states more than one pair. */
  readonly stages: ReadonlyArray<{
    readonly quantity: string;
    readonly percent: string;
  }>;
  /** The `Agreement Rate(Rs.)` column. */
  readonly rate: string;
  /** The quantity column this row prints for those stages. */
  readonly printedQuantity: string;
  /** The `Amount Since last Bill(Rs.)` column — the exact product, before
   * the railway's own rounding-up into its "including special condition"
   * column. */
  readonly printedAmount: string;
}

/**
 * The five rows below carry every shape the corpus has: a whole-number
 * percentage on a whole-number quantity, a percentage that puts the
 * product on two decimals, and the compound "70% for 13 Nos and 20% for 02
 * Nos" prepaid line the ruling names by hand.
 */
const CORPUS: readonly CorpusRow[] = [
  {
    // BILL-1, Schedule A item 01: "Prepaid Nil Now to Pay 70% for 03 Nos",
    // Qty Upto Date 2.1, Amount Since last Bill 4478638.5.
    source: 'BILL-1 A/01',
    stages: [{ quantity: '3', percent: '70' }],
    rate: '2132685.0',
    printedQuantity: '2.1',
    printedAmount: '4478638.50',
  },
  {
    // BILL-1, Schedule A item 03: "64% for 01 Nos", 0.64, 2151226.51.
    source: 'BILL-1 A/03',
    stages: [{ quantity: '1', percent: '64' }],
    rate: '3361291.425',
    printedQuantity: '0.64',
    printedAmount: '2151226.51',
  },
  {
    // BILL-1, Schedule A item 07: "70% for 13 Nos", 9.1, 2796151.31.
    source: 'BILL-1 A/07',
    stages: [{ quantity: '13', percent: '70' }],
    rate: '307269.375',
    printedQuantity: '9.1',
    printedAmount: '2796151.31',
  },
  {
    // BILL-3, Schedule A item 06: "Prepaid 64% for 10 Nos Now to Pay 64%
    // for 05 Nos" — the delta half. Qty since last 3.2, Amount Since last
    // Bill 936842.99. Its cumulative column reads 9.6 of an agreement 18,
    // which is the ruling's own worked example.
    source: 'BILL-3 A/06 (this bill only)',
    stages: [{ quantity: '5', percent: '64' }],
    rate: '292763.43405',
    printedQuantity: '3.2',
    printedAmount: '936842.99',
  },
  {
    // BILL-3, Schedule A item 07, the PREPAID half: "Prepaid 70% for 13
    // Nos and 20% for 02 Nos" prints a cumulative of 9.5 — 9.1 plus 0.4,
    // two stages of one item summed AFTER each is scaled. The amount
    // column beside it is this bill's own delta, so the prepaid figure is
    // checked on the quantity alone; the delta row below carries the
    // money.
    source: 'BILL-3 A/07 prepaid',
    stages: [
      { quantity: '13', percent: '70' },
      { quantity: '2', percent: '20' },
    ],
    rate: '307269.375',
    printedQuantity: '9.5',
    printedAmount: '',
  },
  {
    // BILL-3, Schedule A item 07, the delta: "Now to Pay 70% for 05 Nos",
    // Qty since last 3.5, Amount Since last Bill 1075442.81.
    source: 'BILL-3 A/07 (this bill only)',
    stages: [{ quantity: '5', percent: '70' }],
    rate: '307269.375',
    printedQuantity: '3.5',
    printedAmount: '1075442.81',
  },
];

/** The RAILWAY's arithmetic, spelled out: scale the quantity, round it to
 * two decimals, then multiply by the rate and round to paise. */
function railwayAmount(row: CorpusRow): string {
  let total = '0.00';
  for (const stage of row.stages) {
    total = addDecimalStrings(
      total,
      roundDecimalString(
        multiplyDecimalStrings(
          coefficientQuantity(stage.quantity, stage.percent),
          row.rate,
        ),
        2,
      ),
    );
  }
  return total;
}

/** OUR arithmetic: the physical quantity times the rate times the
 * percentage, rounded once at the paise (`computeStageAmounts`, which is
 * what a Measurement Book line is actually priced with). */
function engineAmount(row: CorpusRow): string {
  return computeStageAmounts({
    effectiveRate: row.rate,
    stages: row.stages.map((stage, index) => ({
      stage: `stage-${String(index)}`,
      percent: stage.percent,
      deltaQuantity: stage.quantity,
    })),
  }).total;
}

describe('coefficientQuantity against the settlement corpus', () => {
  it.each(CORPUS)('prints $source exactly as the railway does', (row) => {
    const printed = row.stages
      .map((stage) => coefficientQuantity(stage.quantity, stage.percent))
      .reduce(addDecimalStrings, '0');
    // `reduce` accumulates at the wider of the two scales, so 9.1 + 0.4
    // arrives as '9.5' and 2.1 + nothing as '2.1'; nothing is trimmed.
    expect(printed).toBe(row.printedQuantity);
  });

  it.each(CORPUS.filter((row) => row.printedAmount !== ''))(
    'reaches the railway paise on $source, both ways round',
    (row) => {
      expect(railwayAmount(row)).toBe(row.printedAmount);
      // AND THE MONEY IS THE SAME EITHER WAY. This is the claim that makes
      // the coefficient sheet a rendering rather than a second pricing
      // rule: the amount the engine snapshots is the amount the railway's
      // own multiplication produces.
      expect(engineAmount(row)).toBe(row.printedAmount);
    },
  );
});

describe('where the two arithmetics part company', () => {
  it('loses information in the quantity rounding, and changes no rupee', () => {
    // Not in the corpus and stated as constructed: a fractional physical
    // quantity at a percentage whose product runs past two decimals.
    // 3.333 at 64% is exactly 2.13312; the railway would print 2.13 and
    // multiply THAT.
    const row: CorpusRow = {
      source: 'constructed',
      stages: [{ quantity: '3.333', percent: '64' }],
      rate: '100.00',
      printedQuantity: '2.13',
      printedAmount: '',
    };
    expect(coefficientQuantity('3.333', '64')).toBe('2.13');
    expect(railwayAmount(row)).toBe('213.00');
    expect(engineAmount(row)).toBe('213.31');
    // The divergence is a printing difference and nothing else: the
    // Measurement Book bills the engine's figure whichever way it prints,
    // because the coefficient quantity is never summed into an amount
    // anywhere in this product.
  });
});

describe('coefficientLineQuantities', () => {
  it('scales each stage by its own percentage', () => {
    expect(
      coefficientLineQuantities({
        deltaSupplied: '13.000',
        deltaInstalled: '2.000',
        deltaPac: '0.000',
        pctSupply: '70.00',
        pctInstallation: '20.00',
        pctPac: '10.00',
      }),
    ).toEqual({ supplied: '9.1', installed: '0.4', pac: '0' });
  });

  it('renders without trailing fractional zeros, as the railway prints', () => {
    expect(coefficientQuantity('3.000', '70.00')).toBe('2.1');
    expect(coefficientQuantity('10.000', '100.00')).toBe('10');
    expect(coefficientQuantity('0.000', '70.00')).toBe('0');
  });
});
