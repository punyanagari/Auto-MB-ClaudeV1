import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyPricingShape,
  classifyShapeKind,
  loadCorpus,
  loadLetter,
  parseDecimalToMinorUnits,
  parseItems,
  type LetterPercentageDirectionValue,
  type ParsedItem,
  type PricingShapeResult,
  type ScheduleTotalEntry,
  type TotalsBlockStructure,
  type WorksPricingColumns,
} from '../src/index.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(TEST_DIR, '..');

/**
 * legacy ticket DC-24 — pricing-shape classifier: Shape A (letter-level
 * percentage) vs Shape B (per-schedule totals), totals reconciliation, the
 * rebate decoy. Input contract: docs/reference/loa-parser-contract.md §1.
 * verify: `pnpm --filter @auto-mb/loa-parser --fail-if-no-match test pricing-shape`
 * (a filename-substring filter on `vitest run`, matching only this file —
 * every DC-24 assertion lives here so that verify line exercises all of
 * them).
 *
 * AMENDMENTS applied per the ticket's 2026-08-05 sweep (load-bearing, not
 * historical color): Shape-A arithmetic is SIGNED BY THE TOKEN
 * (`%Below`/`%At Par` -> subtract, `%Above` -> add) — applying the `%Below`
 * sign to PL281 would be a ~₹5.81-crore error; the rebate decoy reads
 * `0.00` in all SIX corpus letters (PL281 included); the letter-level
 * `%Above` totals-block token is implemented AND TESTED against PL281,
 * while the ITEM-ROW token `Above Par` (never observed — 281/281 real item
 * rows read `At Par`) stays items.ts's defensive-and-untested branch, which
 * this file does not touch (this module never reads an item-row token at
 * all).
 */

// research §0/§1: the four Shape-A letters, each with its printed
// pct/direction/net, and the two Shape-B letters, each with its schedule
// breakdown summing to the printed net.
const SHAPE_A_CASES: {
  readonly id: string;
  readonly advertised: number;
  readonly pct: number;
  readonly direction: LetterPercentageDirectionValue;
  readonly contract: number;
}[] = [
  {
    id: 'PL273-JHS',
    advertised: 3046426.56,
    pct: 0,
    direction: 'at_par',
    contract: 3046426.56,
  },
  {
    id: 'PL280-ADI',
    advertised: 4165603.32,
    pct: 0.5,
    direction: 'below',
    contract: 4144775.3,
  },
  {
    id: 'PL275-BKN',
    advertised: 7994861.18,
    pct: 29,
    direction: 'below',
    contract: 5676351.44,
  },
  // The %Above sign arm — WITHOUT this case, a sign-flip bug (applying the
  // %Below sign to %Above) is invisible to this file (ticket's own
  // 2026-08-05 amendment).
  {
    id: 'PL281-BB',
    advertised: 118502769.36,
    pct: 24.5,
    direction: 'above',
    contract: 147535947.85,
  },
];

const SHAPE_B_CASES: {
  readonly id: string;
  readonly advertised: number;
  readonly contract: number;
  readonly scheduleTotals: readonly number[];
}[] = [
  {
    id: 'PL276-GTL',
    advertised: 63632540.0,
    contract: 46727651.87,
    scheduleTotals: [8100467.39, 4016343.66, 7120536.13, 27490304.69],
  },
  {
    id: 'PL270-CRB',
    advertised: 195574112.38,
    contract: 169228497.35,
    scheduleTotals: [88677087.41, 16650896.17, 45956497.18, 8629251.2, 9314765.39],
  },
];

const ALL_CORPUS_IDS = [
  'PL273-JHS',
  'PL280-ADI',
  'PL275-BKN',
  'PL276-GTL',
  'PL270-CRB',
  'PL281-BB',
];

// Shared building blocks for the synthetic (never-a-fixture-edit) totals
// blocks used by both the criterion-6 (unrecognised/non-reconciling) and
// the R1-ruling (totals-rounding tolerance) describe blocks below.
const SYNTHETIC_HEADER =
  'Awarded Quantities And Rates\n\nSchedule A-Test (Item Directory - Not Applicable)\n';
const SYNTHETIC_REBATE_BLOCK =
  '                                              Rebate on Total Value\n' +
  '                                                                                     0.00\n' +
  '                                              (%)\n';

describe('pricing-shape classifier (DC-24)', () => {
  // ---- criterion 1: classify before compute ------------------------------

  describe('classifies the shape before computing any value', () => {
    it.each(SHAPE_A_CASES.map((c) => c.id))(
      '%s: totals block reads "Total Value <advertised> <pct> %%token <net>" with every Schedule Totals line 0.00 -> letter_percentage',
      (id) => {
        const { text } = loadLetter(id);
        const result = classifyPricingShape(text);
        expect(result.pricing_shape).toBe('letter_percentage');
        expect(result.scheduleTotals.length).toBeGreaterThan(0);
        for (const entry of result.scheduleTotals) {
          expect(entry.total).toBe(0);
        }
      },
    );

    it.each(SHAPE_B_CASES.map((c) => c.id))(
      '%s: totals block reads "Total Value <advertised> <net>" with no percentage token, populated Schedule Totals summing to net -> per_schedule',
      (id) => {
        const { text } = loadLetter(id);
        const result = classifyPricingShape(text);
        expect(result.pricing_shape).toBe('per_schedule');
        expect(result.letter_percentage).toBeNull();
        expect(result.letter_percentage_direction).toBeNull();
        const populated = result.scheduleTotals.filter((e) => e.total !== 0);
        expect(populated.length).toBe(result.scheduleTotals.length);
      },
    );

    // "The classifier is a separate function that runs first and whose
    // output selects the arithmetic": classifyShapeKind is a pure function
    // of TotalsBlockStructure alone -- these hand-built structures carry no
    // text and pass through NO arithmetic function to produce their
    // decision, proving the classification is reachable without computing
    // any contract value first.
    it('classifyShapeKind decides purely from structural signals, independent of any computed value', () => {
      function buildStructure(
        overrides: Partial<TotalsBlockStructure>,
      ): TotalsBlockStructure {
        return {
          found: true,
          advertisedRaw: '100.00',
          netRaw: null,
          percentRaw: null,
          percentTokenDirection: null,
          scheduleTotals: [],
          rebateRaw: '0.00',
          rawBlockText: 'irrelevant',
          ...overrides,
        };
      }

      const shapeALike = buildStructure({
        percentRaw: '29.00',
        percentTokenDirection: 'below',
        netRaw: '71.00',
        scheduleTotals: [{ scheduleId: 'A', totalRaw: '0.00' }],
      });
      expect(classifyShapeKind(shapeALike)).toBe('letter_percentage');

      const shapeBLike = buildStructure({
        percentRaw: null,
        percentTokenDirection: null,
        netRaw: '71.00',
        scheduleTotals: [
          { scheduleId: 'A1', totalRaw: '40.00' },
          { scheduleId: 'A2', totalRaw: '31.00' },
        ],
      });
      expect(classifyShapeKind(shapeBLike)).toBe('per_schedule');

      // Contradiction between the two independent signals (a token present
      // but schedule totals are NOT all zero) -- unrecognised, not a guess.
      const contradiction = buildStructure({
        percentRaw: '10.00',
        percentTokenDirection: 'below',
        netRaw: '90.00',
        scheduleTotals: [{ scheduleId: 'A', totalRaw: '5.00' }],
      });
      expect(classifyShapeKind(contradiction)).toBeNull();

      // `found: false` (no Total Value line at all) is unrecognised
      // regardless of any other field.
      expect(classifyShapeKind(buildStructure({ found: false }))).toBeNull();
    });
  });

  // ---- criterion 2: Shape-A arithmetic, signed by the token, exact -------

  describe('Shape A: contract = round2(advertised * (1 -+ pct/100)), signed by the printed token, exact to the paisa', () => {
    it.each(SHAPE_A_CASES)(
      '$id: advertised=$advertised, pct=$pct $direction -> contract=$contract',
      ({ id, advertised, pct, direction, contract }) => {
        const { text } = loadLetter(id);
        const result = classifyPricingShape(text);
        expect(result.pricing_shape).toBe('letter_percentage');
        expect(result.advertised_value).toBe(advertised);
        expect(result.contract_value).toBe(contract);
        expect(result.letter_percentage).toBe(pct);
        expect(result.letter_percentage_direction).toBe(direction);
        expect(result.needsReview).toBe(false);
      },
    );

    it('PL281 specifically: the %Above sign ADDS -- applying the %Below sign instead would yield 89469590.87, a ~5.81 crore error, not 147535947.85', () => {
      const { text } = loadLetter('PL281-BB');
      const result = classifyPricingShape(text);
      expect(result.letter_percentage_direction).toBe('above');
      expect(result.contract_value).toBe(147535947.85);
      expect(result.contract_value).toBeGreaterThan(result.advertised_value ?? 0);
    });
  });

  // ---- criterion 3: Shape-B arithmetic, contract = sum(schedule_total) ---

  describe('Shape B: contract = sum(schedule_total), each total carried onto its schedule', () => {
    it.each(SHAPE_B_CASES)(
      '$id: advertised=$advertised, schedule totals sum to contract=$contract',
      ({ id, advertised, contract, scheduleTotals }) => {
        const { text } = loadLetter(id);
        const result = classifyPricingShape(text);
        expect(result.pricing_shape).toBe('per_schedule');
        expect(result.advertised_value).toBe(advertised);
        expect(result.contract_value).toBe(contract);
        expect(result.letter_percentage).toBeNull();
        expect(result.letter_percentage_direction).toBeNull();
        expect(result.needsReview).toBe(false);
        expect(result.scheduleTotals.map((e: ScheduleTotalEntry) => e.total)).toEqual(
          scheduleTotals,
        );
      },
    );

    it('PL276: each of the four schedule totals is carried onto its own printed schedule id (A1/A2/B1/B2 -- research §6, not a simple ordinal)', () => {
      const { text } = loadLetter('PL276-GTL');
      const result = classifyPricingShape(text);
      expect(result.scheduleTotals.map((e) => e.scheduleId)).toEqual([
        'A1',
        'A2',
        'B1',
        'B2',
      ]);
    });
  });

  // ---- criterion 4: the rebate decoy --------------------------------------

  describe('the rebate decoy', () => {
    it('Rebate on Total Value (%) reads 0.00 in all six corpus letters', () => {
      for (const id of ALL_CORPUS_IDS) {
        const { text } = loadLetter(id);
        const result = classifyPricingShape(text);
        expect(result.rebateOnTotalValue).toBe(0);
      }
    });

    // Synthetic fixture: an in-memory transform of PL273's real text (the
    // %At Par Shape-A letter) with a non-zero rebate spliced in -- the
    // fixture FILE itself is never touched (corpus-manifest.test.ts's
    // sha256 guard would go red on that).
    it('a non-zero rebate on an %At Par totals block is ignored by the arithmetic AND raises needsReview for the contradiction', () => {
      const original = loadLetter('PL273-JHS').text;
      // Replaces only the rebate figure between its own label and the next
      // "Net Bid Value" label -- every other "0.00" in the document
      // (Schedule Totals, item amounts) is untouched.
      const decoyText = original.replace(
        /(Rebate on Total Value[\s\S]*?)0\.00([\s\S]*?Net Bid Value)/,
        '$15.00$2',
      );
      expect(decoyText).not.toBe(original);

      const straight = classifyPricingShape(original);
      const decoy = classifyPricingShape(decoyText);

      // The rebate figure itself is surfaced...
      expect(decoy.rebateOnTotalValue).toBe(5);
      // ...but NEVER applied: the computed contract is IDENTICAL to the
      // non-decoy letter (if the rebate were wrongly subtracted, this would
      // be ~2894105.23, not 3046426.56).
      expect(decoy.pricing_shape).toBe('letter_percentage');
      expect(decoy.contract_value).toBe(straight.contract_value);
      expect(decoy.contract_value).toBe(3046426.56);
      // ...and the contradiction (non-zero rebate alongside a totals block
      // that declares no discount at all) is flagged, not silently dropped.
      expect(straight.needsReview).toBe(false);
      expect(decoy.needsReview).toBe(true);
    });
  });

  // ---- criterion 5: never sum item rows for contract value ----------------

  describe('never derives contract value by summing item rows', () => {
    function toPaise(decimal: string): bigint {
      const minor = parseDecimalToMinorUnits(decimal, 2);
      if (minor === null) {
        throw new Error(`test setup bug: "${decimal}" is not a valid decimal`);
      }
      return minor;
    }

    function sumBidAmountPaise(items: readonly ParsedItem[]): bigint {
      return items.reduce((acc, item) => acc + toPaise(item.bidAmount), 0n);
    }

    it('PL275: classifier contract_value is 5676351.44 while the item-row sum is 7994861.18 -- the classifier never produces the latter', () => {
      const { text } = loadLetter('PL275-BKN');
      const result = classifyPricingShape(text);
      const itemSumPaise = sumBidAmountPaise(parseItems(text));

      expect(result.contract_value).toBe(5676351.44);
      expect(itemSumPaise).toBe(toPaise('7994861.18'));
      // The item-row sum equals ADVERTISED value (Shape A prints item Bid
      // Amount at advertised rates, research §1) -- never the contract
      // value the classifier reports.
      expect(result.advertised_value).toBe(7994861.18);
      expect(result.contract_value).not.toBe(
        Number.parseFloat((Number(itemSumPaise) / 100).toFixed(2)),
      );
    });

    it("src/pricing-shape.ts imports nothing from items.ts -- source-scan proof, not just a passing runtime assertion (n2; corpus-manifest.test.ts's purity block is the precedent for this pattern)", () => {
      const sourcePath = path.join(PACKAGE_DIR, 'src', 'pricing-shape.ts');
      const source = readFileSync(sourcePath, 'utf8');
      const importRe =
        /(?:import|export)(?:\s+type)?(?:[\s\w{},*]+from)?\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)|import\s*\(\s*["']([^"']+)["']\s*\)/g;
      const specs: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(source)) !== null) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (spec !== undefined) {
          specs.push(spec);
        }
      }
      // Sanity: the scan itself actually found imports (a regex that
      // silently matched nothing would make the assertion below vacuous).
      expect(specs.length).toBeGreaterThan(0);
      for (const spec of specs) {
        expect(spec.endsWith('items.js')).toBe(false);
        expect(spec.endsWith('items.ts')).toBe(false);
        expect(spec).not.toBe('items');
      }
    });
  });

  // ---- criterion 6: unrecognised / non-reconciling totals block ----------

  describe('unrecognised totals block, or arithmetic that fails to reconcile within one paisa', () => {
    it('an unrecognised percentage token (garbled, not Below/Above/At Par) -> pricing_shape: null, both figures retained, needsReview: true', () => {
      const mangled =
        SYNTHETIC_HEADER +
        '                                    Schedule Totals                                            0.00\n' +
        '                                        Total Value 1000000.00 10.00 %Sideways 900000.00\n' +
        SYNTHETIC_REBATE_BLOCK +
        '                                        Net Bid Value                900000.00\n';

      const result = classifyPricingShape(mangled);
      expect(result.pricing_shape).toBeNull();
      expect(result.needsReview).toBe(true);
      expect(result.advertised_value).toBe(1000000);
      expect(result.contract_value).toBe(900000);
      expect(result.rawTotalsBlock).not.toBeNull();
      expect(result.rawTotalsBlock).toContain('Schedule Totals');
    });

    it('a valid token whose formula does not reconcile with the printed net (off by more than one paisa) -> pricing_shape: null, both figures retained (the PRINTED net, not the wrongly-computed one), needsReview: true', () => {
      const mangled =
        SYNTHETIC_HEADER +
        '                                    Schedule Totals                                            0.00\n' +
        '                                        Total Value 1000000.00 10.00 %Below 950000.00\n' +
        SYNTHETIC_REBATE_BLOCK +
        '                                        Net Bid Value                950000.00\n';

      // Independent check: the CORRECT %Below formula would compute
      // 900000.00, not the printed 950000.00 -- a genuine 50000-rupee
      // reconciliation gap, far past the one-paisa tolerance.
      const result = classifyPricingShape(mangled);
      expect(result.pricing_shape).toBeNull();
      expect(result.needsReview).toBe(true);
      expect(result.advertised_value).toBe(1000000);
      // The PRINTED net (950000.00), never the classifier's own computed
      // (and unreconciled) 900000.00 -- "no fallback, no guess".
      expect(result.contract_value).toBe(950000);
    });

    it('no Total Value line at all -> pricing_shape: null, needsReview: true, both figures null', () => {
      const mangled = `${SYNTHETIC_HEADER}Nothing resembling a totals block here.\n`;
      const result = classifyPricingShape(mangled);
      expect(result.pricing_shape).toBeNull();
      expect(result.needsReview).toBe(true);
      expect(result.advertised_value).toBeNull();
      expect(result.contract_value).toBeNull();
    });
  });

  // ---- R1 ruling (legacy ticket DC-24, 2026-08-05 manager ruling): the
  // printed Net Bid Value wins the tolerance boundary -----------------------

  describe('totals-rounding tolerance: the printed Net Bid Value wins whenever the shape reconciles at all (diff <= 0.01), never the recomputed figure', () => {
    it('boundary (1): printed 900000.01 vs computed 900000.00 (diff exactly 0.01) -> shape kept, contract_value = 900000.01 (the PRINTED figure), divergence flag carries both figures + the diff', () => {
      const mangled =
        SYNTHETIC_HEADER +
        '                                    Schedule Totals                                            0.00\n' +
        '                                        Total Value 1000000.00 10.00 %Below 900000.01\n' +
        SYNTHETIC_REBATE_BLOCK +
        '                                        Net Bid Value                900000.01\n';

      const result = classifyPricingShape(mangled);
      // Classification stands -- NOT the criterion-6 null-shape branch.
      expect(result.pricing_shape).toBe('letter_percentage');
      expect(result.letter_percentage).toBe(10);
      expect(result.letter_percentage_direction).toBe('below');
      // contract_value is the PRINTED figure (900000.01), never the
      // classifier's own computed 900000.00.
      expect(result.contract_value).toBe(900000.01);
      expect(result.needsReview).toBe(true);
      expect(result.divergence).not.toBeNull();
      expect(result.divergence?.code).toBe('totals_rounding_divergence');
      expect(result.divergence?.printed).toBe(900000.01);
      expect(result.divergence?.computed).toBe(900000);
      expect(result.divergence?.diff).toBe(0.01);
      expect(result.divergence?.rawTotalsBlock).not.toBeNull();
    });

    it('boundary (2): diff 0.02 (past the one-paisa tolerance) -> the criterion-6 null-shape failure branch, unchanged', () => {
      const mangled =
        SYNTHETIC_HEADER +
        '                                    Schedule Totals                                            0.00\n' +
        '                                        Total Value 1000000.00 10.00 %Below 900000.02\n' +
        SYNTHETIC_REBATE_BLOCK +
        '                                        Net Bid Value                900000.02\n';

      const result = classifyPricingShape(mangled);
      expect(result.pricing_shape).toBeNull();
      expect(result.needsReview).toBe(true);
      expect(result.divergence).toBeNull();
      // Criterion 6's own rule: both printed figures retained verbatim.
      expect(result.advertised_value).toBe(1000000);
      expect(result.contract_value).toBe(900000.02);
    });

    it('boundary (3): all six corpus letters reconcile at diff = 0 -- NO divergence flag on any of them (a universal zero-diff flag would drown the signal)', () => {
      for (const id of ALL_CORPUS_IDS) {
        const { text } = loadLetter(id);
        const result = classifyPricingShape(text);
        expect(result.pricing_shape).not.toBeNull();
        expect(result.divergence).toBeNull();
      }
    });
  });

  // ---- n1: at_par with a nonzero printed percentage is a contradiction ----

  describe('at_par contradiction (n1): a totals block declaring "At Par" together with a NONZERO printed percentage is internally contradictory', () => {
    it('synthetic %At Par totals block with pct=5.00 (otherwise-coherent figures) -> classification stands but needsReview is raised for the contradiction', () => {
      // advertised * (1 - 0.05) = 950000.00 exactly, so the figures
      // reconcile at diff = 0 -- isolating THIS contradiction from R1's
      // divergence flag (divergence stays null; needsReview is driven
      // entirely by the at-par-with-nonzero-pct check).
      const mangled =
        SYNTHETIC_HEADER +
        '                                    Schedule Totals                                            0.00\n' +
        '                                        Total Value 1000000.00 5.00 %At Par 950000.00\n' +
        SYNTHETIC_REBATE_BLOCK +
        '                                        Net Bid Value                950000.00\n';

      const result = classifyPricingShape(mangled);
      expect(result.pricing_shape).toBe('letter_percentage');
      expect(result.letter_percentage_direction).toBe('at_par');
      expect(result.letter_percentage).toBe(5);
      expect(result.contract_value).toBe(950000);
      expect(result.divergence).toBeNull();
      expect(result.needsReview).toBe(true);
    });

    it('control: a genuine %At Par letter (PL273, pct = 0.00) never raises this contradiction', () => {
      const { text } = loadLetter('PL273-JHS');
      const result = classifyPricingShape(text);
      expect(result.letter_percentage_direction).toBe('at_par');
      expect(result.letter_percentage).toBe(0);
      expect(result.needsReview).toBe(false);
    });
  });

  // ---- criterion 7: 1:1 mapping onto DC-14's works columns ---------------

  describe('output maps 1:1 onto DC-14 columns (advertised_value, contract_value, pricing_shape, letter_percentage, letter_percentage_direction)', () => {
    const DC14_COLUMN_KEYS = [
      'advertised_value',
      'contract_value',
      'pricing_shape',
      'letter_percentage',
      'letter_percentage_direction',
    ] as const;

    // Type-level check: if a future edit drops or renames one of the five
    // DC-14 columns on PricingShapeResult, this function fails to COMPILE
    // ("missing property" from tsc). vitest's esbuild transform strips
    // types without checking them, so this assertion's teeth are the
    // `pnpm typecheck` gate (this package's `tsc --noEmit -p
    // tsconfig.json`), run as part of `pnpm gates`.
    function assertAssignableToWorksPricingColumns(
      result: PricingShapeResult,
    ): WorksPricingColumns {
      return result;
    }

    it('PricingShapeResult is assignable to WorksPricingColumns (compile-time) for every corpus letter', () => {
      for (const { text } of loadCorpus()) {
        const result = classifyPricingShape(text);
        const columns = assertAssignableToWorksPricingColumns(result);
        expect(columns).toBe(result);
      }
    });

    it('every DC-14 column key is present (own property) on the result, for every corpus letter -- runtime key-set assertion', () => {
      for (const { text } of loadCorpus()) {
        const result = classifyPricingShape(text);
        for (const key of DC14_COLUMN_KEYS) {
          expect(Object.prototype.hasOwnProperty.call(result, key)).toBe(true);
        }
      }
    });

    it('pricing_shape values are exactly the DB enum literals letter_percentage/per_schedule (never the old A/B shorthand)', () => {
      for (const { text } of loadCorpus()) {
        const result = classifyPricingShape(text);
        expect(result.pricing_shape).not.toBeNull();
        expect(['letter_percentage', 'per_schedule']).toContain(result.pricing_shape);
      }
    });
  });

  // ---- per-schedule accepted percentage (migration 0063) ----------------

  describe('each schedule carries its own accepted-rate percentage', () => {
    /**
     * Under Shape B the tender result is printed once per SCHEDULE, and it
     * is the only thing that turns the item table's advertised rates into
     * the rates the railway pays. Without it the accepted rate cannot be
     * derived at all, so it is read here and checked against the
     * schedule's own totals line before it is published.
     */
    it('reads every schedule of PL270-CRB, whose schedules differ', () => {
      const result = classifyPricingShape(loadLetter('PL270-CRB').text);
      expect(result.pricing_shape).toBe('per_schedule');
      expect(
        result.scheduleTotals.map((s) => [s.scheduleId, s.percentage, s.direction]),
      ).toEqual([
        ['A', 14.35, 'below'],
        ['B', 8.1, 'below'],
        ['C', 14.35, 'below'],
        ['D', 8.1, 'below'],
        ['E', 14.35, 'below'],
      ]);
    });

    it('reads a letter that MIXES directions across its own schedules', () => {
      // PL276-GTL is the case a single per-Work percentage could not hold:
      // two schedules above par and two below, on one letter.
      const result = classifyPricingShape(loadLetter('PL276-GTL').text);
      expect(
        result.scheduleTotals.map((s) => [s.scheduleId, s.percentage, s.direction]),
      ).toEqual([
        ['A1', 7.77, 'above'],
        ['A2', 8.88, 'above'],
        ['B1', 49.49, 'below'],
        ['B2', 28.28, 'below'],
      ]);
    });

    it('carries each schedule its own advertised value, and reconciles it', () => {
      // The self-check: the printed percentage must actually carry the
      // printed advertised value to the schedule's own total. If it did
      // not, the reading would be dropped rather than published.
      for (const id of ['PL270-CRB', 'PL276-GTL']) {
        for (const schedule of classifyPricingShape(loadLetter(id).text)
          .scheduleTotals) {
          expect(
            schedule.advertisedValue,
            `${id}/${String(schedule.scheduleId)}`,
          ).not.toBeNull();
          const sign = schedule.direction === 'above' ? 1 : -1;
          const computed =
            (schedule.advertisedValue ?? 0) *
            (1 + (sign * (schedule.percentage ?? 0)) / 100);
          expect(Math.abs(computed - (schedule.total ?? 0))).toBeLessThanOrEqual(0.01);
        }
      }
    });

    it('publishes nothing per schedule on a LETTER-percentage letter', () => {
      // Their percentage is letter-level and already on the result; a
      // per-schedule figure there would be an invention, and a zero would
      // read as "at par" on a letter that is nothing of the sort.
      for (const id of ['PL273-JHS', 'PL275-BKN', 'PL280-ADI', 'PL281-BB']) {
        const result = classifyPricingShape(loadLetter(id).text);
        expect(result.pricing_shape).toBe('letter_percentage');
        for (const schedule of result.scheduleTotals) {
          expect(
            schedule.percentage,
            `${id}/${String(schedule.scheduleId)}`,
          ).toBeNull();
          expect(schedule.direction).toBeNull();
          expect(schedule.advertisedValue).toBeNull();
        }
      }
    });
  });

  // ---- negative proof: whole corpus parses without throwing --------------

  it('classifies every corpus letter without throwing', () => {
    for (const { text } of loadCorpus()) {
      expect(() => classifyPricingShape(text)).not.toThrow();
    }
  });
});
