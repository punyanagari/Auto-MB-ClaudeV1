import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MB_REMARK_TEMPLATE_VERSION,
  MB_STAGE_ORDER,
  addDecimalStrings,
  computeMbRemark,
  computeStageAmounts,
  renderPercent,
  renderQuantity,
  resolveFinalBillBase,
  type MbRemarkStageInput,
} from '../src/mb-remark.js';

/** The versioned workbook regression fixture — the wording contract. */
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

describe('mb-remark workbook acceptance (character-for-character)', () => {
  it('pins the expected fixture version', () => {
    expect(fixture.fixtureVersion).toBe('mb-remark-workbook-v1');
    expect(MB_REMARK_TEMPLATE_VERSION).toBe('mb-remark-v1');
  });

  it('reproduces every workbook expectedRemark exactly', () => {
    const { item, matrix, measurementBooks } = fixture.case;
    // True cumulatives of PRIOR non-cancelled MBs, per stage. Rows whose
    // deltas are all zero advance nothing (they only add zero).
    let cumSupplied = '0';
    let cumInstalled = '0';
    let cumPac = '0';

    for (const row of measurementBooks) {
      let finalBillDelta = '0';
      if (row.isFinal) {
        // The final MB sweeps its own deltas too, so the delivered/installed
        // totals it bills against include this MB's own supply/installation.
        const base = resolveFinalBillBase({
          paymentCategory: item.paymentCategory,
          description: item.description,
          deliveredQuantity: addDecimalStrings(cumSupplied, row.suppliedDelta),
          installedQuantity: addDecimalStrings(cumInstalled, row.installedDelta),
        });
        expect(base.branch).toBe('delivered');
        expect(renderQuantity(base.baseQuantity)).toBe(
          renderQuantity(row.finalBillBaseQuantity ?? ''),
        );
        finalBillDelta = base.baseQuantity;
      }

      // Deliberately scrambled stage order: the renderer must impose the
      // fixed supply, installation, pac, final_bill order itself.
      const stages: MbRemarkStageInput[] = [
        {
          stage: 'final_bill',
          percent: matrix.finalBillPercent,
          priorCumulativeQuantity: '0',
          deltaQuantity: finalBillDelta,
        },
        {
          stage: 'pac',
          percent: matrix.pacPercent,
          priorCumulativeQuantity: cumPac,
          deltaQuantity: row.pacDelta,
        },
        {
          stage: 'installation',
          percent: matrix.installationPercent,
          priorCumulativeQuantity: cumInstalled,
          deltaQuantity: row.installedDelta,
        },
        {
          stage: 'supply',
          percent: matrix.supplyPercent,
          priorCumulativeQuantity: cumSupplied,
          deltaQuantity: row.suppliedDelta,
        },
      ];

      const remark = computeMbRemark({ unit: item.unit, stages });
      expect(remark, `MB ${String(row.mb)}`).toBe(row.expectedRemark);

      cumSupplied = addDecimalStrings(cumSupplied, row.suppliedDelta);
      cumInstalled = addDecimalStrings(cumInstalled, row.installedDelta);
      cumPac = addDecimalStrings(cumPac, row.pacDelta);
    }
  });
});

describe('renderQuantity / renderPercent', () => {
  it('drops trailing fractional zeros without touching significant digits', () => {
    expect(renderQuantity('5000.000')).toBe('5000');
    expect(renderQuantity('12.50')).toBe('12.5');
    expect(renderQuantity('0.500')).toBe('0.5');
    expect(renderQuantity('5000')).toBe('5000');
    expect(renderQuantity('0.000')).toBe('0');
    expect(renderQuantity('100.001')).toBe('100.001');
    expect(renderPercent('12.50')).toBe('12.5');
    expect(renderPercent('80')).toBe('80');
  });

  it('rejects non-decimal input outright', () => {
    expect(() => renderQuantity('1e3')).toThrow(/plain decimal/);
    expect(() => renderQuantity('')).toThrow(/plain decimal/);
    expect(() => renderQuantity('12,000')).toThrow(/plain decimal/);
  });
});

describe('computeMbRemark beyond the workbook', () => {
  const fullMatrixStage = (
    stage: MbRemarkStageInput['stage'],
    percent: string,
    prior: string,
    delta: string,
  ): MbRemarkStageInput => ({
    stage,
    percent,
    priorCumulativeQuantity: prior,
    deltaQuantity: delta,
  });

  it('renders a PAC stage in both the prepaid and now-to-pay clauses', () => {
    const remark = computeMbRemark({
      unit: 'Set',
      stages: [
        fullMatrixStage('supply', '70', '200', '0'),
        fullMatrixStage('installation', '10', '150', '0'),
        fullMatrixStage('pac', '10', '100', '50'),
        fullMatrixStage('final_bill', '10', '0', '0'),
      ],
    });
    expect(remark).toBe(
      'Prepaid 70% for 200 Set and 10% for 150 Set and 10% for 100 Set. Now to pay 10% for 50 Set.',
    );
  });

  it('renders the final-bill fragment last even when other deltas are present', () => {
    const base = resolveFinalBillBase({
      paymentCategory: null,
      description: 'Supply and Installation of signalling equipment',
      deliveredQuantity: '100',
      installedQuantity: '60',
    });
    expect(base).toEqual({ branch: 'installed', baseQuantity: '60' });
    const remark = computeMbRemark({
      unit: 'Set',
      stages: [
        fullMatrixStage('final_bill', '10', '0', base.baseQuantity),
        fullMatrixStage('installation', '10', '40', '20'),
        fullMatrixStage('supply', '80', '100', '0'),
        fullMatrixStage('pac', '0', '0', '0'),
      ],
    });
    expect(remark).toBe(
      'Prepaid 80% for 100 Set and 10% for 40 Set. Now to pay 10% for 20 Set and 10% for 60 Set.',
    );
  });

  it('renders percentages without trailing zeros (12.50 -> 12.5)', () => {
    const remark = computeMbRemark({
      unit: 'RMT',
      stages: [fullMatrixStage('supply', '12.50', '0', '400.00')],
    });
    expect(remark).toBe('Now to pay 12.5% for 400 RMT.');
  });

  it("first MB with no deltas is exactly 'Now to pay nill.'", () => {
    const remark = computeMbRemark({
      unit: 'mtr',
      stages: [
        fullMatrixStage('supply', '80', '0', '0'),
        fullMatrixStage('installation', '10', '0', '0'),
        fullMatrixStage('pac', '0', '0', '0'),
        fullMatrixStage('final_bill', '10', '0', '0'),
      ],
    });
    expect(remark).toBe('Now to pay nill.');
  });

  it('renders the unit string verbatim', () => {
    expect(
      computeMbRemark({
        unit: 'Set',
        stages: [fullMatrixStage('supply', '80', '0', '3')],
      }),
    ).toBe('Now to pay 80% for 3 Set.');
    expect(
      computeMbRemark({
        unit: 'RMT',
        stages: [fullMatrixStage('supply', '80', '0', '3')],
      }),
    ).toBe('Now to pay 80% for 3 RMT.');
  });

  it('omits a stage with percent 0 from the prepaid clause even with prior quantity', () => {
    const remark = computeMbRemark({
      unit: 'mtr',
      stages: [
        fullMatrixStage('supply', '80', '1000', '0'),
        fullMatrixStage('pac', '0', '500', '0'),
      ],
    });
    expect(remark).toBe('Prepaid 80% for 1000 mtr. Now to pay nill.');
  });

  it('rejects duplicate stage entries', () => {
    expect(() =>
      computeMbRemark({
        unit: 'mtr',
        stages: [
          fullMatrixStage('supply', '80', '0', '1'),
          fullMatrixStage('supply', '80', '0', '2'),
        ],
      }),
    ).toThrow(/Duplicate stage/);
  });

  it('every remark ends with a full stop and first billings never say Prepaid', () => {
    const samples = [
      computeMbRemark({ unit: 'mtr', stages: [] }),
      computeMbRemark({
        unit: 'mtr',
        stages: [fullMatrixStage('supply', '80', '0', '0')],
      }),
      computeMbRemark({
        unit: 'mtr',
        stages: [fullMatrixStage('supply', '80', '0', '5')],
      }),
      computeMbRemark({
        unit: 'mtr',
        stages: MB_STAGE_ORDER.map((stage) => fullMatrixStage(stage, '25', '10', '5')),
      }),
    ];
    for (const remark of samples) {
      expect(remark.endsWith('.')).toBe(true);
    }
    // First-ever billing (all prior cumulatives zero) never opens with Prepaid.
    expect(
      computeMbRemark({
        unit: 'mtr',
        stages: MB_STAGE_ORDER.map((stage) => fullMatrixStage(stage, '25', '0', '5')),
      }),
    ).not.toContain('Prepaid');
  });
});

describe('computeStageAmounts (R13: line-round then sum)', () => {
  it('rounds each stage line to paise before summing — never the sum alone', () => {
    // Each line: 1 × 20.01 × 50 / 100 = 10.005 -> 10.01 line-rounded.
    // Line-rounded sum = 20.02; rounding the raw sum (20.010) would give
    // 20.01 — R13 forbids that.
    const result = computeStageAmounts({
      effectiveRate: '20.01',
      stages: [
        { stage: 'supply', percent: '50', deltaQuantity: '1' },
        { stage: 'installation', percent: '50', deltaQuantity: '1' },
      ],
    });
    expect(result.perStage).toEqual([
      { stage: 'supply', amount: '10.01' },
      { stage: 'installation', amount: '10.01' },
    ]);
    expect(result.total).toBe('20.02');
    expect(result.total).not.toBe('20.01');
  });

  it('computes exact paise for fractional quantities, rates, and percents', () => {
    // 123.456 × 78.90 × 12.5 / 100 = 1217.58474 -> 1217.58
    const result = computeStageAmounts({
      effectiveRate: '78.90',
      stages: [{ stage: 'supply', percent: '12.5', deltaQuantity: '123.456' }],
    });
    expect(result.perStage).toEqual([{ stage: 'supply', amount: '1217.58' }]);
    expect(result.total).toBe('1217.58');
  });

  it('renders zero-delta stages as 0.00 and always two fraction digits', () => {
    const result = computeStageAmounts({
      effectiveRate: '99.99',
      stages: [
        { stage: 'supply', percent: '80', deltaQuantity: '0' },
        { stage: 'final_bill', percent: '10', deltaQuantity: '10' },
      ],
    });
    expect(result.perStage).toEqual([
      { stage: 'supply', amount: '0.00' },
      { stage: 'final_bill', amount: '99.99' },
    ]);
    expect(result.total).toBe('99.99');
  });
});

describe('resolveFinalBillBase', () => {
  const quantities = { deliveredQuantity: '1000', installedQuantity: '640' };

  it('SUPPLY and SPARE_SUPPLY bill 100% of delivered', () => {
    for (const paymentCategory of ['SUPPLY', 'SPARE_SUPPLY']) {
      expect(
        resolveFinalBillBase({
          paymentCategory,
          description: 'Installation of nothing — category wins',
          ...quantities,
        }),
      ).toEqual({ branch: 'delivered', baseQuantity: '1000' });
    }
  });

  it('SUPPLY_AND_INSTALLATION and PURE_INSTALLATION bill installed only', () => {
    for (const paymentCategory of ['SUPPLY_AND_INSTALLATION', 'PURE_INSTALLATION']) {
      expect(
        resolveFinalBillBase({
          paymentCategory,
          description: 'Power cable',
          ...quantities,
        }),
      ).toEqual({ branch: 'installed', baseQuantity: '640' });
    }
  });

  it('uncategorised items branch on the word installation, case-insensitively', () => {
    expect(
      resolveFinalBillBase({
        paymentCategory: null,
        description: 'Power cable',
        ...quantities,
      }),
    ).toEqual({ branch: 'delivered', baseQuantity: '1000' });
    expect(
      resolveFinalBillBase({
        paymentCategory: null,
        description: 'Supply and INSTALLATION of power cable',
        ...quantities,
      }),
    ).toEqual({ branch: 'installed', baseQuantity: '640' });
  });

  it('rejects unknown categories rather than guessing a branch', () => {
    expect(() =>
      resolveFinalBillBase({
        paymentCategory: 'TOTALLY_NEW',
        description: 'Power cable',
        ...quantities,
      }),
    ).toThrow(/Unknown payment category/);
  });
});

describe('addDecimalStrings', () => {
  it('adds exactly across mixed scales', () => {
    expect(addDecimalStrings('1.25', '2.755')).toBe('4.005');
    expect(addDecimalStrings('0', '5000')).toBe('5000');
    expect(addDecimalStrings('0.1', '0.2')).toBe('0.3');
  });
});
