import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyMeasuredOverride,
  clampToSanctioned,
  computeFinalBillDelta,
  computeMeasurementBook,
  lineHasQuantity,
  subtractDecimalStrings,
  type MbItemInput,
} from '../src/mb-compute.js';
import { addDecimalStrings } from '../src/mb-remark.js';
import type { PaymentMatrixRowData } from '../src/payment-matrix.js';

/** The workbook fixture drives the pure engine end to end: the same
 * scenario the integration suite replays through the API. */
interface WorkbookFixture {
  readonly fixtureVersion: string;
  readonly case: {
    readonly item: {
      readonly description: string;
      readonly unit: string;
      readonly paymentCategory: string | null;
    };
    readonly matrix: {
      readonly supplyPercent: string;
      readonly installationPercent: string;
      readonly pacPercent: string;
      readonly finalBillPercent: string;
    };
    readonly measurementBooks: ReadonlyArray<{
      readonly mb: number;
      readonly suppliedDelta: string;
      readonly installedDelta: string;
      readonly pacDelta: string;
      readonly isFinal: boolean;
      readonly finalBillBaseQuantity?: string;
      readonly expectedRemark: string;
    }>;
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/mb-remark-workbook.v1.json', import.meta.url),
    'utf8',
  ),
) as WorkbookFixture;

const ITEM_ID = '00000000-0000-4000-8000-000000000001';

const workbookMatrix: PaymentMatrixRowData[] = [
  {
    category: 'UNCATEGORISED',
    pctSupply: '80.00',
    pctInstallation: '10.00',
    pctPac: '0.00',
    pctFinalBill: '10.00',
  },
];

function itemInput(overrides: Partial<MbItemInput>): MbItemInput {
  return {
    workItemId: ITEM_ID,
    itemNumber: '1',
    description: fixture.case.item.description,
    unitCode: fixture.case.item.unit,
    // The workbook's item bills through the Work's residual row. It was
    // NULL here until migration 0105 gave that state its own meaning
    // ("not selected"), which resolves through nothing; the row this
    // fixture has always billed against is the UNCATEGORISED one.
    paymentCategory: 'UNCATEGORISED',
    effectiveRate: '100.00',
    deltaSupplied: '0',
    deltaInstalled: '0',
    deltaPac: '0',
    priorSupplied: '0',
    priorInstalled: '0',
    priorPac: '0',
    priorFinalBill: '0',
    cumulativeDelivered: '0',
    cumulativeInstalled: '0',
    cumulativeAmcCertified: '0',
    // Far above anything the workbook scenario measures, so the cases
    // written before the clamp existed keep asking what they asked: the
    // clamp only speaks when an item is over-installed, and the cases
    // that mean to exercise it set this deliberately.
    sanctionedQuantity: '99999999',
    // Nothing adjusted and no maintenance cadence: the workbook scenario
    // is a supply item on a Work with neither, so every case written
    // before migrations 0106/0107 keeps asking exactly what it asked.
    measuredSupplied: null,
    measuredInstalled: null,
    amcBillingPeriods: null,
    amcCycleNoun: null,
    ...overrides,
  };
}

describe('subtractDecimalStrings', () => {
  it('subtracts exactly at mixed scales', () => {
    expect(subtractDecimalStrings('6000', '5000.500')).toBe('999.500');
    expect(subtractDecimalStrings('1.5', '2')).toBe('-0.5');
    expect(subtractDecimalStrings('-1.5', '-2.25')).toBe('0.75');
  });
});

describe('computeFinalBillDelta', () => {
  it('uses the delivered base for supply-branch items and floors at zero', () => {
    expect(
      computeFinalBillDelta(
        itemInput({
          cumulativeDelivered: '6000',
          cumulativeInstalled: '5000',
          priorFinalBill: '0',
        }),
      ),
    ).toBe('6000');
    expect(
      computeFinalBillDelta(
        itemInput({
          cumulativeDelivered: '6000',
          cumulativeInstalled: '5000',
          priorFinalBill: '7000',
        }),
      ),
    ).toBe('0');
  });

  it('uses the installed base for installation-branch items', () => {
    expect(
      computeFinalBillDelta(
        itemInput({
          paymentCategory: 'SUPPLY_AND_INSTALLATION',
          cumulativeDelivered: '6000',
          cumulativeInstalled: '5000',
        }),
      ),
    ).toBe('5000');
  });
});

describe('computeMeasurementBook over the workbook scenario', () => {
  it('reproduces every workbook remark, amount, and cumulative through the full 8-MB run', () => {
    const { matrix, measurementBooks } = fixture.case;
    expect(matrix.supplyPercent).toBe('80');

    let cumSupplied = '0';
    let cumInstalled = '0';
    let cumPac = '0';
    let cumFinalBill = '0';
    let cumDelivered = '0';
    let cumInstalledActual = '0';

    for (const mb of measurementBooks) {
      cumDelivered = addDecimalStrings(cumDelivered, mb.suppliedDelta);
      cumInstalledActual = addDecimalStrings(cumInstalledActual, mb.installedDelta);

      const computation = computeMeasurementBook({
        matrix: workbookMatrix,
        isFinal: mb.isFinal,
        items: [
          itemInput({
            deltaSupplied: mb.suppliedDelta,
            deltaInstalled: mb.installedDelta,
            deltaPac: mb.pacDelta,
            priorSupplied: cumSupplied,
            priorInstalled: cumInstalled,
            priorPac: cumPac,
            priorFinalBill: cumFinalBill,
            cumulativeDelivered: cumDelivered,
            cumulativeInstalled: cumInstalledActual,
          }),
        ],
      });

      const hasDelta =
        mb.suppliedDelta !== '0' ||
        mb.installedDelta !== '0' ||
        mb.pacDelta !== '0' ||
        mb.isFinal;
      if (!hasDelta) {
        // A workbook row with no delta produces no line at all: the MB
        // engine bills deltas (the workbook's nill rows exist because
        // the item was carried on a book that billed OTHER items).
        expect(computation.lines).toHaveLength(0);
        continue;
      }
      const [line] = computation.lines;
      expect(line, `MB ${String(mb.mb)}`).toBeDefined();
      if (!line) continue;
      expect(line.remark, `MB ${String(mb.mb)} remark`).toBe(mb.expectedRemark);
      if (mb.isFinal && mb.finalBillBaseQuantity !== undefined) {
        expect(line.deltaFinalBill).toBe(
          subtractDecimalStrings(mb.finalBillBaseQuantity, cumFinalBill),
        );
      }

      cumSupplied = addDecimalStrings(cumSupplied, line.deltaSupplied);
      cumInstalled = addDecimalStrings(cumInstalled, line.deltaInstalled);
      cumPac = addDecimalStrings(cumPac, line.deltaPac);
      cumFinalBill = addDecimalStrings(cumFinalBill, line.deltaFinalBill);
    }

    // Full-run cross-check: everything supplied and installed got billed.
    expect(cumSupplied).toBe('6000');
    expect(cumInstalled).toBe('6000');
    expect(cumFinalBill).toBe('6000');
  });

  it('prices stages line-rounded-then-summed (R13) and totals across items', () => {
    const computation = computeMeasurementBook({
      matrix: workbookMatrix,
      isFinal: false,
      items: [
        itemInput({
          itemNumber: '1',
          effectiveRate: '0.01',
          deltaSupplied: '1',
          deltaInstalled: '1',
        }),
        itemInput({
          workItemId: '00000000-0000-4000-8000-000000000002',
          itemNumber: '2',
          effectiveRate: '100.00',
          deltaSupplied: '3',
        }),
      ],
    });
    const [first, second] = computation.lines;
    // 1 × 0.01 × 80% = 0.008 -> 0.01; 1 × 0.01 × 10% = 0.001 -> 0.00.
    expect(first?.amountSupply).toBe('0.01');
    expect(first?.amountInstallation).toBe('0.00');
    expect(first?.lineTotal).toBe('0.01');
    expect(second?.amountSupply).toBe('240.00');
    expect(second?.lineTotal).toBe('240.00');
    expect(computation.totalAmount).toBe('240.01');
  });

  it('collects EVERY unresolved item instead of failing on the first', () => {
    const computation = computeMeasurementBook({
      matrix: workbookMatrix,
      isFinal: false,
      items: [
        itemInput({
          itemNumber: '1',
          paymentCategory: 'SUPPLY',
          deltaSupplied: '1',
        }),
        itemInput({
          workItemId: '00000000-0000-4000-8000-000000000002',
          itemNumber: '2',
          paymentCategory: 'PURE_INSTALLATION',
          deltaInstalled: '2',
        }),
        itemInput({
          workItemId: '00000000-0000-4000-8000-000000000003',
          itemNumber: '3',
          deltaSupplied: '4',
        }),
      ],
    });
    // The residual-category item resolves; the two other categorised
    // items do not fall back to it (resolution never substitutes rows).
    expect(computation.lines).toHaveLength(1);
    expect(computation.lines[0]?.itemNumber).toBe('3');
    expect(computation.unresolved).toEqual([
      { workItemId: ITEM_ID, itemNumber: '1', missingCategory: 'SUPPLY' },
      {
        workItemId: '00000000-0000-4000-8000-000000000002',
        itemNumber: '2',
        missingCategory: 'PURE_INSTALLATION',
      },
    ]);
  });

  it('skips items with no delta and never bills the final stage on a non-final MB', () => {
    const computation = computeMeasurementBook({
      matrix: workbookMatrix,
      isFinal: false,
      items: [
        itemInput({
          deltaSupplied: '0',
          cumulativeDelivered: '5000',
          priorSupplied: '5000',
        }),
      ],
    });
    expect(computation.lines).toHaveLength(0);
    expect(computation.totalAmount).toBe('0.00');
  });
});

describe('clampToSanctioned (migration 0077, owner ruling 2026-08-17)', () => {
  it('bills the measurement when the sanction has room for it', () => {
    expect(
      clampToSanctioned({
        priorQuantity: '4.000',
        deltaQuantity: '3.000',
        sanctionedQuantity: '10.000',
      }),
    ).toBe('3.000');
  });

  it('bills only the room left when the measurement straddles the sanction', () => {
    // The straddle: one 12-unit record against a sanctioned 10 with
    // nothing billed yet. Ten is billable, two are not, and there is no
    // way to express that by refusing a whole record.
    expect(
      clampToSanctioned({
        priorQuantity: '0',
        deltaQuantity: '12.000',
        sanctionedQuantity: '10.000',
      }),
    ).toBe('10.000');
  });

  it('bills nothing once the sanction is already billed out', () => {
    // Zero at the scale the subtraction produced; every consumer casts to
    // numeric(18,3) and `isPositiveDecimal` reads it as nothing either
    // way, so the scale is cosmetic and asserted rather than normalised.
    expect(
      clampToSanctioned({
        priorQuantity: '10.000',
        deltaQuantity: '2.000',
        sanctionedQuantity: '10.000',
      }),
    ).toBe('0.000');
  });

  it('never returns a negative delta, whatever history it is handed', () => {
    // A prior above the sanction is reachable by amending a quantity down
    // after billing; the answer is "nothing more", never a clawback.
    expect(
      clampToSanctioned({
        priorQuantity: '12.000',
        deltaQuantity: '1.000',
        sanctionedQuantity: '10.000',
      }),
    ).toBe('0');
  });

  it('clamps at exact decimal scale, without a float in the middle', () => {
    expect(
      clampToSanctioned({
        priorQuantity: '0.001',
        deltaQuantity: '0.999',
        sanctionedQuantity: '0.5',
      }),
    ).toBe('0.499');
  });
});

describe('computeMeasurementBook under an unprocessed variation', () => {
  it('clamps the installation and certification stages, not the supply stage', () => {
    // Sanctioned 10; site installed and the railway certified 12; the
    // consignee also accepted 12 delivered under the Work's
    // excess-delivery permission. Only the two stages measured on
    // physical work clamp — over-delivery is an owner's deliberate
    // acceptance and has always billed.
    const computation = computeMeasurementBook({
      matrix: [
        {
          category: 'UNCATEGORISED',
          pctSupply: '40.00',
          pctInstallation: '30.00',
          pctPac: '20.00',
          pctFinalBill: '10.00',
        },
      ],
      isFinal: false,
      items: [
        itemInput({
          effectiveRate: '100.00',
          sanctionedQuantity: '10.000',
          deltaSupplied: '12.000',
          deltaInstalled: '12.000',
          deltaPac: '12.000',
        }),
      ],
    });
    const [line] = computation.lines;
    expect(line?.deltaSupplied).toBe('12.000');
    expect(line?.deltaInstalled).toBe('10.000');
    expect(line?.deltaPac).toBe('10.000');
    // 12 x 100 x 40% + 10 x 100 x 30% + 10 x 100 x 20%.
    expect(line?.lineTotal).toBe('980.00');
  });

  it('clamps the final-bill base on the installed branch and leaves it on the delivered one', () => {
    const installed = computeFinalBillDelta(
      itemInput({
        paymentCategory: 'PURE_INSTALLATION',
        sanctionedQuantity: '10.000',
        cumulativeInstalled: '15.000',
      }),
    );
    expect(installed).toBe('10.000');

    const delivered = computeFinalBillDelta(
      itemInput({
        paymentCategory: 'SUPPLY',
        sanctionedQuantity: '10.000',
        cumulativeDelivered: '15.000',
      }),
    );
    expect(delivered).toBe('15.000');
  });

  it('drops an item whose whole measurement is above the sanction', () => {
    // Ten of ten already billed and two more installed: this book has
    // nothing to say about the item, and says nothing rather than
    // refusing the book.
    const computation = computeMeasurementBook({
      matrix: [
        {
          category: 'UNCATEGORISED',
          pctSupply: '0.00',
          pctInstallation: '100.00',
          pctPac: '0.00',
          pctFinalBill: '0.00',
        },
      ],
      isFinal: false,
      items: [
        itemInput({
          sanctionedQuantity: '10.000',
          priorInstalled: '10.000',
          deltaInstalled: '2.000',
        }),
      ],
    });
    expect(computation.lines).toEqual([]);
    expect(computation.totalAmount).toBe('0.00');
  });
});

/**
 * The downward-only measured quantity (owner ruling of 2026-08-19;
 * migration 0106). The cap is enforced twice — this is the half that
 * decides what a book bills, and the half the draft preview, the draft
 * PDF and the finalize snapshot all read.
 */
describe('applyMeasuredOverride (migration 0106, owner ruling 2026-08-19)', () => {
  it('leaves the measurement alone when nothing was adjusted', () => {
    expect(applyMeasuredOverride('10.000', null)).toBe('10.000');
    expect(applyMeasuredOverride('0.000', null)).toBe('0.000');
  });

  it('reduces to the entered figure', () => {
    expect(applyMeasuredOverride('10.000', '8')).toBe('8');
    expect(applyMeasuredOverride('10.000', '0')).toBe('0');
  });

  it('takes the CAP BOUNDARY as the measurement, never as a raise', () => {
    // Equal is legal and changes nothing.
    expect(applyMeasuredOverride('10.000', '10.000')).toBe('10.000');
    // One thousandth above is still not a raise; the smaller of the two
    // wins, which is what makes a stale adjustment — one written before
    // its source was deselected — incapable of billing evidence that has
    // since gone.
    expect(applyMeasuredOverride('10.000', '10.001')).toBe('10.000');
    expect(applyMeasuredOverride('10.000', '999')).toBe('10.000');
    // And when the sources have gone entirely, so has the room.
    expect(applyMeasuredOverride('0.000', '8')).toBe('0.000');
  });

  it('compares across scales without a float in the middle', () => {
    expect(applyMeasuredOverride('10', '9.9995')).toBe('9.9995');
    expect(applyMeasuredOverride('9.9995', '10')).toBe('9.9995');
  });
});

describe('computeMeasurementBook with an adjusted measured quantity', () => {
  const matrixRow: PaymentMatrixRowData = {
    category: 'UNCATEGORISED',
    pctSupply: '80.00',
    pctInstallation: '10.00',
    pctPac: '0.00',
    pctFinalBill: '10.00',
  };

  it('prices the adjusted quantity and reports the claimed one beside it', () => {
    const computation = computeMeasurementBook({
      matrix: [matrixRow],
      isFinal: false,
      items: [
        itemInput({
          effectiveRate: '100.00',
          deltaSupplied: '10.000',
          measuredSupplied: '8',
        }),
      ],
    });
    const [line] = computation.lines;
    expect(line?.deltaSupplied).toBe('8');
    expect(line?.sourceSupplied).toBe('10.000');
    // 8 x 100 x 80% — the reduced quantity priced exactly as an
    // unreduced one would be.
    expect(line?.amountSupply).toBe('640.00');
    expect(computation.totalAmount).toBe('640.00');
  });

  it('never lets an adjustment raise a quantity above the claimed sources', () => {
    const computation = computeMeasurementBook({
      matrix: [matrixRow],
      isFinal: false,
      items: [
        itemInput({
          effectiveRate: '100.00',
          deltaSupplied: '10.000',
          measuredSupplied: '25',
        }),
      ],
    });
    expect(computation.lines[0]?.deltaSupplied).toBe('10.000');
    expect(computation.totalAmount).toBe('800.00');
  });

  it('adjusts installation UNDER the sanction clamp, never around it', () => {
    // Installed 40 against a sanction of 30 with 25 already billed: the
    // clamp leaves room for 5. An adjustment to 3 bills 3; an adjustment
    // to 20 still bills only the 5 the sanction allows.
    const over = {
      effectiveRate: '100.00',
      deltaInstalled: '40.000',
      priorInstalled: '25',
      sanctionedQuantity: '30',
    };
    const reduced = computeMeasurementBook({
      matrix: [matrixRow],
      isFinal: false,
      items: [itemInput({ ...over, measuredInstalled: '3' })],
    });
    expect(reduced.lines[0]?.deltaInstalled).toBe('3');
    const raised = computeMeasurementBook({
      matrix: [matrixRow],
      isFinal: false,
      items: [itemInput({ ...over, measuredInstalled: '20' })],
    });
    expect(raised.lines[0]?.deltaInstalled).toBe('5');
  });

  it('keeps an adjusted-to-nothing line on the preview, so its own field is still there', () => {
    // The hasDelta trap: without the adjusted flag, typing 0 removes the
    // line and takes the input that would undo it with it.
    const computation = computeMeasurementBook({
      matrix: [matrixRow],
      isFinal: false,
      items: [
        itemInput({
          effectiveRate: '100.00',
          deltaSupplied: '10.000',
          measuredSupplied: '0',
        }),
      ],
    });
    expect(computation.lines).toHaveLength(1);
    expect(computation.lines[0]?.deltaSupplied).toBe('0');
    expect(computation.lines[0]?.sourceSupplied).toBe('10.000');
    expect(computation.totalAmount).toBe('0.00');
    // And it is the line finalize refuses to number, because it measures
    // nothing — that guard asks the quantities, not the line count.
    expect(computation.lines.some(lineHasQuantity)).toBe(false);
  });

  it('still drops an unadjusted item that measures nothing', () => {
    const computation = computeMeasurementBook({
      matrix: [matrixRow],
      isFinal: false,
      items: [itemInput({ deltaSupplied: '0', deltaInstalled: '0', deltaPac: '0' })],
    });
    expect(computation.lines).toEqual([]);
  });

  it('narrates the adjusted quantity in the remark, not the one it replaced', () => {
    const computation = computeMeasurementBook({
      matrix: [matrixRow],
      isFinal: false,
      items: [
        itemInput({
          unitCode: 'mtr',
          deltaSupplied: '10.000',
          measuredSupplied: '8',
        }),
      ],
    });
    expect(computation.lines[0]?.remark).toBe('Now to pay 80% for 8 mtr.');
  });
});

describe('computeMeasurementBook on an AMC billing cadence', () => {
  const amcRow: PaymentMatrixRowData = {
    category: 'AMC',
    pctSupply: '0.00',
    pctInstallation: '0.00',
    pctPac: '95.00',
    pctFinalBill: '5.00',
  };

  it("renders the schedule's period language in the remark", () => {
    const computation = computeMeasurementBook({
      matrix: [amcRow],
      isFinal: false,
      items: [
        itemInput({
          paymentCategory: 'AMC',
          unitCode: 'Nos',
          sanctionedQuantity: '96',
          deltaPac: '12',
          priorPac: '24',
          amcBillingPeriods: 8,
          amcCycleNoun: 'quarter',
        }),
      ],
    });
    expect(computation.lines[0]?.remark).toBe(
      'Prepaid 95% for 2 quarters. Now to pay 95% for 1 quarter.',
    );
  });

  it('leaves a non-AMC item on the same schedule reading in its own unit', () => {
    const computation = computeMeasurementBook({
      matrix: [matrixRowForSupply],
      isFinal: false,
      items: [
        itemInput({
          unitCode: 'mtr',
          sanctionedQuantity: '96',
          deltaSupplied: '12',
          amcBillingPeriods: 8,
          amcCycleNoun: 'quarter',
        }),
      ],
    });
    expect(computation.lines[0]?.remark).toBe('Now to pay 80% for 12 mtr.');
  });

  it('leaves an AMC item on a schedule with no cadence reading in its own unit', () => {
    const computation = computeMeasurementBook({
      matrix: [amcRow],
      isFinal: false,
      items: [
        itemInput({
          paymentCategory: 'AMC',
          unitCode: 'Nos',
          sanctionedQuantity: '96',
          deltaPac: '12',
        }),
      ],
    });
    expect(computation.lines[0]?.remark).toBe('Now to pay 95% for 12 Nos.');
  });
});

const matrixRowForSupply: PaymentMatrixRowData = {
  category: 'UNCATEGORISED',
  pctSupply: '80.00',
  pctInstallation: '10.00',
  pctPac: '0.00',
  pctFinalBill: '10.00',
};
