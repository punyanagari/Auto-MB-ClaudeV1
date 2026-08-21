import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  parseRemarkClaims,
  proposeBaselineLine,
} from '../src/billing-baseline-propose.js';
import { parseRailwayMeasurement } from '../src/railway-measurement-parse.js';

/**
 * Proposing a Work's opening billing position from the railway's own last
 * measurement sheet (migration 0114).
 *
 * The remarks are read out of MB-3 of the committed settlement corpus, not
 * written here. That is the point of the exercise: the compound case the
 * owner's ruling names by hand — "Prepaid 70% for 13 Nos and 20% for 02
 * Nos Now to Pay 70% for 05 Nos" — is a real line of a real document, and
 * it is also the line that WRAPS, which is what makes it worth pinning.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = path.join(here, 'fixtures', 'railway-settlement');

/** The workbook Work's matrix, and the one every case below resolves
 * through: 70% on supply, 20% on installation, 10% at the final bill. */
const MATRIX = {
  pctSupply: '70.00',
  pctInstallation: '20.00',
  pctPac: '0.00',
  pctFinalBill: '10.00',
} as const;

let sheet = '';
beforeAll(async () => {
  sheet = await readFile(path.join(corpus, 'MB-3.raw.txt'), 'utf8');
});

function remarkOf(itemNumber: string): string {
  const found = parseRailwayMeasurement(sheet).items.find(
    (item) => item.itemNumber === itemNumber,
  );
  if (found === undefined) throw new Error(`fixture has no item ${itemNumber}`);
  return found.remark;
}

describe('parseRemarkClaims', () => {
  it('sums the prepaid and now-to-pay halves of one stage', () => {
    // A baseline states ONE cumulative per stage, and the sheet's two
    // clauses are the two halves of exactly that.
    expect(
      parseRemarkClaims('Prepaid 64% for 10 Nos Now to Pay 64% for 05 Nos'),
    ).toEqual([{ percent: '64', quantity: '15' }]);
  });

  it('keeps two stages of one item apart, and unpads the railway zeros', () => {
    expect(
      parseRemarkClaims('Prepaid 70% for 13 Nos and 20% for 02 Nos Now to Pay Nil'),
    ).toEqual([
      { percent: '70', quantity: '13' },
      { percent: '20', quantity: '2' },
    ]);
  });

  it('reads nothing out of a remark that claims nothing', () => {
    expect(parseRemarkClaims('Prepaid Nil Now to Pay Nil')).toEqual([]);
  });
});

describe('proposeBaselineLine against MB-3', () => {
  it('proposes the compound line the ruling names, including its wrapped tail', () => {
    // MB-3 item A/07. Its remark WRAPS in the PDF — the reader welds the
    // continuation back on (`weldWrappedReasons`), and without that this
    // proposal would silently offer 13 units where the sheet says 18.
    const remark = remarkOf('A/07');
    expect(remark).toBe(
      'Prepaid 70% for 13 Nos and 20% for 02 Nos Now to Pay 70% for 05 Nos',
    );
    expect(
      proposeBaselineLine({
        remark,
        percentages: MATRIX,
        effectiveRate: '307269.375',
      }),
    ).toEqual({
      // 13 + 5 at the 70% supply stage, 2 at the 20% installation stage.
      priorSupplied: '18',
      priorInstalled: '2',
      priorPac: '0',
      priorFinalBill: '0',
      // 18 x 307269.375 x 0.70 = 3871594.125 -> 3871594.13
      //  2 x 307269.375 x 0.20 =  122907.75
      //
      // AND THE RAILWAY AGREES. BILL-3's own item 07 row prints a `Total
      // Up to Date Amount` of 3994502.0 against this same measurement —
      // the derived figure, rounded up to whole rupees in IWRCMS's
      // "including special condition" column, which is what that column
      // does on every paying row of the corpus. The proposal is derived
      // rather than extracted (migration 0114 § "WHAT IS DELIBERATELY NOT
      // MODELLED" says why), and this is the check that the derivation
      // lands where the bill does.
      amount: '3994501.88',
    });
  });

  it('proposes a single-stage line straight off the sheet', () => {
    // MB-3 item A/06: "Prepaid 64% for 10 Nos Now to Pay 64% for 05 Nos".
    // 64% is this item's own supply percentage on its own Work, so the
    // matrix here says 64 rather than 70.
    expect(
      proposeBaselineLine({
        remark: remarkOf('A/06'),
        percentages: { ...MATRIX, pctSupply: '64.00' },
        effectiveRate: '292763.43405',
      }),
    ).toMatchObject({ priorSupplied: '15', priorInstalled: '0' });
  });

  it('proposes an empty position for an item nothing has been billed on', () => {
    // A real state, and not the same as "no proposal": the sheet says
    // this item has been paid nothing, which is a figure worth confirming.
    expect(
      proposeBaselineLine({
        remark: 'Prepaid Nil Now to Pay Nil',
        percentages: MATRIX,
        effectiveRate: '100.00',
      }),
    ).toEqual({
      priorSupplied: '0',
      priorInstalled: '0',
      priorPac: '0',
      priorFinalBill: '0',
      amount: '0.00',
    });
  });

  it('proposes NOTHING where a percentage matches no stage of the matrix', () => {
    // The remark says 64% and this item's matrix has no 64% stage. There
    // is no third document to break the tie, and a guess under a confirm
    // button is the failure this whole module is shaped to avoid.
    expect(
      proposeBaselineLine({
        remark: 'Prepaid Nil Now to Pay 64% for 05 Nos',
        percentages: MATRIX,
        effectiveRate: '100.00',
      }),
    ).toBeNull();
  });

  it('proposes NOTHING where a percentage matches two stages', () => {
    // 50/50 supply and installation: "50% for 4 Nos" could be either, and
    // attributing it to the first one that matched would be arithmetic
    // dressed up as evidence.
    expect(
      proposeBaselineLine({
        remark: 'Now to Pay 50% for 04 Nos',
        percentages: {
          pctSupply: '50.00',
          pctInstallation: '50.00',
          pctPac: '0.00',
          pctFinalBill: '0.00',
        },
        effectiveRate: '100.00',
      }),
    ).toBeNull();
  });
});
