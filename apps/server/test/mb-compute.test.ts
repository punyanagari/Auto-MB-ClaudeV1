import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computeFinalBillDelta,
  computeMeasurementBook,
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
    paymentCategory: null,
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
    // The uncategorised item resolves; the two categorised items do not
    // fall back to UNCATEGORISED (resolution never substitutes rows).
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
