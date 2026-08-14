import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadLetter, reviewLoaLetter, resolveCanonicalUnitCode } from '../src/index.js';

/**
 * PL281-BB — full item-table regression.
 *
 * This is the letter a product owner reported as unparseable: the review
 * screen showed `unresolved_item_description` plus `unresolved_unit` on most
 * rows, each reading "Printed unit null does not exactly match a canonical
 * unit spelling". The reported cause (a bordered HTML-table-to-PDF whose
 * multi-line cells defeat text-mode reading order) is NOT what this fixture
 * shows: against POPPLER's `pdftotext -layout`/`-raw` views the table reads
 * cleanly, every unit resolves, and the only flag raised is the legitimate
 * banned-items one.
 *
 * The real trigger was the extraction binary. Xpdf ships a same-named
 * `pdftotext` accepting the same flags, and its `-layout` renders this table
 * differently (Advt.Value figures hoisted into schedule-title rows, a
 * three-way-split header, blank lines between wrapped description lines).
 * Fed that text, the reader yields NULL units on 42 of 54 rows — exactly the
 * owner's report. `packages/documents/src/loa-extract.ts` now refuses a non-Poppler
 * binary, and `packages/documents/test/loa-extract.test.ts` pins that guard.
 *
 * This file is the parser-side half of the evidence: it proves the letter's
 * every item reads correctly from the Poppler views, so the guard is
 * defending a genuinely-working parse rather than papering over a parser gap.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(TEST_DIR, '..', 'fixtures');

/**
 * The `-raw` reading-order view of the same PDF as the `PL281-BB.txt`
 * `-layout` fixture, extracted with Poppler 26.02.0. Production supplies
 * both views; without this second fixture the corpus could only exercise
 * the conservative layout-only fallback, never the exact-description path
 * the product actually runs. Not a `corpus.json` entry: the manifest maps
 * one letter to its authoritative `-layout` extraction, and adding a second
 * "letter" for the same PDF would double every corpus-wide count.
 */
const RAW_VIEW_PATH = path.join(FIXTURES_DIR, 'PL281-BB.raw.txt');
const RAW_VIEW_SHA256 =
  '79c6648e9e140a8b784b653f749151523f5b717cc3e31ceacbea35f9c705bd69';

function loadRawView(): string {
  return readFileSync(RAW_VIEW_PATH, 'utf8');
}

/**
 * Every item row as printed in the letter's "Awarded Quantities And Rates"
 * table: [schedule, itemSno, itemCode, qty, unit, unitRate, value].
 *
 * `value` is the `Advt.Value (Rs)` column. This letter's `Bid Rate/Unit Rate`
 * and `Bid Amount (Rs)` columns are empty on every row (the bid is expressed
 * once, letter-level, as `24.50 %Above` in the totals block), so the last
 * numeric on each row — what `ParsedItem.bidAmount` holds — is the
 * advertised value. Transcribed from the PDF, not from parser output.
 */
const EXPECTED_ROWS: ReadonlyArray<
  readonly [string, string, string, string, string, string, string]
> = [
  ['A1', '1', '1', '30', 'Numbers', '34643.64', '1039309.20'],
  ['A1', '2', '2', '240', 'Numbers', '3203.41', '768818.40'],
  ['A1', '3', '3', '600', 'Numbers', '1594.94', '956964.00'],
  ['A1', '4', '4', '48', 'Numbers', '23965.42', '1150340.16'],
  ['A1', '5', '5', '30', 'Numbers', '4916.92', '147507.60'],
  ['A1', '6', '6', '2000', 'Metre', '38.16', '76320.00'],
  ['A1', '7', '7', '20000', 'Metre', '29.04', '580800.00'],
  ['A1', '8', '8', '30', 'Numbers', '308275.07', '9248252.10'],
  ['A1', '9', '9', '30', 'Numbers', '34199.97', '1025999.10'],
  ['A1', '10', '10', '30', 'Numbers', '11382.41', '341472.30'],
  ['A1', '11', '11', '840', 'Numbers', '468.72', '393724.80'],
  ['A1', '12', '12', '20000', 'Metre', '154.66', '3093200.00'],
  ['A1', '13', '13', '200', 'Metre', '770.66', '154132.00'],
  ['A1', '14', '14', '20000', 'Metre', '11.54', '230800.00'],
  ['A1', '15', '15', '8000', 'Metre', '21.03', '168240.00'],
  ['A1', '16', '16', '20000', 'Metre', '12.83', '256600.00'],
  ['A1', '17', '17', '1000', 'Metre', '602.43', '602430.00'],
  ['A1', '18', '18', '30', 'Numbers', '13092.53', '392775.90'],
  ['A1', '19', '19', '30', 'Numbers', '5899.00', '176970.00'],
  ['A1', '20', '20', '20', 'Numbers', '5000.00', '100000.00'],
  ['A1', '21', '21', '500', 'Metre', '879.33', '439665.00'],
  ['A1', '22', '22', '500', 'Metre', '42.05', '21025.00'],
  ['A1', '23', '23', '8', 'Numbers', '5233.43', '41867.44'],
  ['A1', '24', '24', '1', 'Numbers', '2000376.00', '2000376.00'],
  // The corpus's only `RMT` row, and the reason its description ends
  // "Unit - route metre." — the printed unit is the canonical `RMT`, not
  // the prose spelling.
  ['A1', '25', '25', '300', 'RMT', '1146.71', '344013.00'],
  ['A1', '26', '26', '30', 'Numbers', '12963.88', '388916.40'],
  ['A1', '27', '27', '420', 'Numbers', '24000.00', '10080000.00'],
  ['A2', '1', '1', '950', 'Numbers', '27115.30', '25759535.00'],
  ['A2', '2', '2', '7', 'Numbers', '543584.44', '3805091.08'],
  ['A2', '3', '3', '85', 'Numbers', '100450.79', '8538317.15'],
  ['A2', '4', '4', '63', 'Numbers', '15101.16', '951373.08'],
  ['A2', '5', '5', '1305', 'Numbers', '169.48', '221171.40'],
  ['A2', '6', '6', '232', 'Numbers', '15897.76', '3688280.32'],
  ['A2', '7', '7', '225', 'Numbers', '12963.88', '2916873.00'],
  ['A2', '8', '8', '30000', 'Metre', '38.16', '1144800.00'],
  ['A2', '9', '9', '90000', 'Metre', '21.03', '1892700.00'],
  ['A2', '10', '10', '38', 'Numbers', '177000.00', '6726000.00'],
  ['A2', '11', '11', '810', 'Numbers', '210.00', '170100.00'],
  ['A2', '12', '12', '8200', 'Metre', '27.20', '223040.00'],
  ['A2', '13', '13', '23000', 'Metre', '10.88', '250240.00'],
  ['A2', '14', '14', '46500', 'Metre', '24.19', '1124835.00'],
  ['A2', '15', '15', '80000', 'Metre', '12.83', '1026400.00'],
  ['A2', '16', '16', '1', 'Numbers', '245440.00', '245440.00'],
  ['A2', '17', '17', '1', 'Numbers', '80240.00', '80240.00'],
  ['A2', '18', '18', '10', 'Numbers', '36580.00', '365800.00'],
  ['A2', '19', '19', '16', 'Numbers', '306800.00', '4908800.00'],
  ['A2', '20', '20', '60', 'Numbers', '15340.00', '920400.00'],
  ['A2', '21', '21', '10', 'Numbers', '1770.00', '17700.00'],
  ['A2', '22', '22', '2', 'Numbers', '36580.00', '73160.00'],
  ['A2', '23', '23', '6000', 'Metre', '110.33', '661980.00'],
  ['A2', '24', '24', '5000', 'Metre', '55.36', '276800.00'],
  ['B1', '1', '1', '7', 'Year', '1124862.81', '7874039.67'],
  ['B1', '2', '2', '2', 'Year', '3905431.63', '7810863.26'],
  ['B1', '3', '3', '4', 'Year', '652068.00', '2608272.00'],
];

function reviewWithBothViews() {
  return reviewLoaLetter(loadLetter('PL281-BB').text, { rawItemText: loadRawView() });
}

describe('PL281-BB raw-view fixture', () => {
  it('is the verbatim Poppler -raw extraction (SHA-256 pinned like the corpus)', () => {
    const digest = createHash('sha256')
      .update(readFileSync(RAW_VIEW_PATH))
      .digest('hex');
    expect(digest).toBe(RAW_VIEW_SHA256);
  });

  it('is LF-normalised, matching the -layout fixture convention', () => {
    expect(loadRawView()).not.toContain('\r');
  });
});

describe('PL281-BB item table (Poppler views)', () => {
  it('reads all 54 items across schedules A1 (27), A2 (24) and B1 (3)', () => {
    const items = reviewWithBothViews().items;
    expect(items).toHaveLength(54);

    const perSchedule = items.reduce<Record<string, number>>((acc, item) => {
      const id = item.schedule?.id ?? 'UNBOUND';
      acc[id] = (acc[id] ?? 0) + 1;
      return acc;
    }, {});
    expect(perSchedule).toEqual({ A1: 27, A2: 24, B1: 3 });
  });

  it('reads every row: schedule, serial, code, qty, unit, unit rate and advertised value', () => {
    const actual = reviewWithBothViews().items.map(
      (item) =>
        [
          item.schedule?.id ?? 'UNBOUND',
          item.itemSno,
          item.itemCode,
          item.qty,
          item.qtyUnit ?? 'NULL',
          item.unitRate,
          item.bidAmount,
        ] as const,
    );
    expect(actual).toEqual(EXPECTED_ROWS);
  });

  it('extracts a unit for every item -- none is null (the reported defect)', () => {
    const items = reviewWithBothViews().items;
    const nullUnits = items.filter((item) => item.qtyUnit === null);
    expect(nullUnits).toHaveLength(0);
  });

  it('every printed unit resolves to a canonical unit code', () => {
    for (const item of reviewWithBothViews().items) {
      expect(
        resolveCanonicalUnitCode(item.qtyUnit),
        `${item.schedule?.id ?? 'UNBOUND'}#${item.itemSno}: unit ${JSON.stringify(item.qtyUnit)}`,
      ).not.toBeNull();
    }
  });

  it('uses exactly four canonical units: Numbers x32, Metre x18, RMT x1, Year x3', () => {
    const counts = reviewWithBothViews().items.reduce<Record<string, number>>(
      (acc, item) => {
        const unit = item.qtyUnit ?? 'NULL';
        acc[unit] = (acc[unit] ?? 0) + 1;
        return acc;
      },
      {},
    );
    expect(counts).toEqual({ Numbers: 32, Metre: 18, RMT: 1, Year: 3 });
  });

  it('every row reconciles qty x unit rate === advertised value, and no item needs review', () => {
    const items = reviewWithBothViews().items;
    for (const item of items) {
      expect(
        item.reconciliation.ok,
        `${item.schedule?.id ?? 'UNBOUND'}#${item.itemSno}`,
      ).toBe(true);
    }
    expect(items.filter((item) => item.needsReview)).toHaveLength(0);
  });

  it('every row prints the At Par escalation token', () => {
    for (const item of reviewWithBothViews().items) {
      expect(item.parToken).toBe('At Par');
    }
  });
});

describe('PL281-BB descriptions (the -raw exact path)', () => {
  it('resolves an exact, row-owned description for every item', () => {
    const items = reviewWithBothViews().items;
    for (const item of items) {
      expect(
        item.descriptionSource,
        `${item.schedule?.id ?? 'UNBOUND'}#${item.itemSno}`,
      ).toBe('raw-exact');
    }
  });

  it('raises no unresolved_item_description flag', () => {
    const flags = reviewWithBothViews().flags.filter(
      (flag) => flag.code === 'unresolved_item_description',
    );
    expect(flags).toHaveLength(0);
  });

  it("item A1#1's description is its own, not its neighbour's tail", () => {
    // The layout-only fallback assigns adjacent rows overlapping text; the
    // raw view must give this row exactly the sentence the PDF prints.
    const first = reviewWithBothViews().items[0];
    expect(first?.description).toBe(
      'Supply of 19" 42U covered rack as per specifications no.4.1 of chapter 4 of tender document. Inspected by Consignee.',
    );
  });
});

describe('PL281-BB review flags', () => {
  it('raises exactly one flag: the legitimate populated banned-items block', () => {
    const payload = reviewWithBothViews();
    expect(payload.needsReview).toEqual({
      total: 1,
      byCode: { banned_items_block: 1 },
      anyLetterLevel: true,
    });
  });

  it('raises no unresolved_unit flag', () => {
    const flags = reviewWithBothViews().flags.filter(
      (flag) => flag.code === 'unresolved_unit',
    );
    expect(flags).toHaveLength(0);
  });

  it('classifies pricing as the letter-level 24.50 %Above shape, not unparsed', () => {
    // The per-item `Escl.(%)` column reads "At Par" on all 54 rows while the
    // totals block carries the single letter-level percentage. Both are
    // parsed; neither is treated as missing.
    const shape = reviewWithBothViews().pricingShape;
    expect(shape.pricing_shape).toBe('letter_percentage');
    expect(shape.letter_percentage).toBe(24.5);
    expect(shape.letter_percentage_direction).toBe('above');
    expect(shape.advertised_value).toBe(118502769.36);
    expect(shape.contract_value).toBe(147535947.85);
    expect(shape.needsReview).toBe(false);
  });
});
