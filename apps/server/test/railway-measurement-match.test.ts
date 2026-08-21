import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MeasurementBookLine } from '@auto-mb/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MbWay } from '../src/mb-coefficient.js';
import { matchRailwayMeasurement } from '../src/railway-measurement-match.js';
import { parseRailwayMeasurement } from '../src/railway-measurement-parse.js';

/**
 * Matching our Measurement Book against the railway's (migration 0111).
 *
 * The measurement sheets are the real ones from the settlement corpus.
 * The BOOK lines are built here, because this product never held these
 * particular Measurement Books — the corpus captured the railway's side
 * of a Work that predates the product. So the book lines below are
 * reconstructed from what the railway's own document says, which is the
 * honest direction: if the reconstruction and the sheet disagree the
 * matcher is what says so, and every quantity here is checkable by hand
 * against `MB-{1,2}.raw.txt`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = path.join(here, 'fixtures', 'railway-settlement');

/** A Measurement Book line with everything the matcher does not read set
 * to a harmless value. Only the item number, the four stage deltas, their
 * priors, their percentages and the remark are compared. */
function bookLine(overrides: Partial<MeasurementBookLine>): MeasurementBookLine {
  return {
    workItemId: '00000000-0000-4000-8000-000000000000',
    itemNumber: 'A/1',
    description: 'Reconstructed line',
    unitCode: 'Nos',
    paymentCategory: null,
    resolvedCategory: 'SUPPLY',
    pctSupply: '0.00',
    pctInstallation: '0.00',
    pctPac: '0.00',
    pctFinalBill: '0.00',
    effectiveRate: '100.00',
    deltaSupplied: '0.000',
    deltaInstalled: '0.000',
    deltaPac: '0.000',
    // The coefficient view of the three stage quantities (0113). The
    // matcher does not read them — it derives both fits from the deltas,
    // the priors and the percentages — so they are present and inert.
    coefficientSupplied: '0',
    coefficientInstalled: '0',
    coefficientPac: '0',
    deltaFinalBill: '0.000',
    priorSupplied: '0.000',
    priorInstalled: '0.000',
    priorPac: '0.000',
    priorFinalBill: '0.000',
    // 0106's measured-quantity adjustment: the CLAIMED figure a draft
    // line was reduced from. Null on a finalized book's lines, and the
    // matcher reads neither — it compares what was measured, not what
    // could have been.
    sourceSupplied: null,
    sourceInstalled: null,
    overrideSupplied: null,
    overrideInstalled: null,
    amountSupply: '0.00',
    amountInstallation: '0.00',
    amountPac: '0.00',
    amountFinalBill: '0.00',
    lineTotal: '0.00',
    remark: 'Now to pay nill.',
    ...overrides,
  };
}

const sheets: Record<string, string> = {};

beforeAll(async () => {
  for (const id of ['MB-1', 'MB-2']) {
    sheets[id] = await readFile(path.join(corpus, `${id}.raw.txt`), 'utf8');
  }
});

/** MB-1 item A/01: 3 Nos claimed at 70% supply, nothing before it. The
 * sheet states Total 2.1 and "Prepaid Nil Now to Pay 70% for 03 Nos". */
const MB1_A01 = bookLine({
  itemNumber: 'A/1',
  pctSupply: '70.00',
  deltaSupplied: '3.000',
  // Our engine OMITS the prepaid clause on an item's first-ever billing;
  // IWRCMS prints "Prepaid Nil". The matcher folds that difference.
  remark: 'Now to pay 70% for 3 Nos.',
});

/** MB-2 item A/01: one more unit at the same 70%, with 3 already billed.
 * The sheet states Total 2.8 — the TRUE CUMULATIVE 4 Nos at 70%, not this
 * measurement's own 1 Nos. */
const MB2_A01 = bookLine({
  itemNumber: 'A/1',
  pctSupply: '70.00',
  priorSupplied: '3.000',
  deltaSupplied: '1.000',
  remark: 'Prepaid 70% for 3 Nos. Now to pay 70% for 1 Nos.',
});

/** MB-2 item A/06: 10 Nos at 64%, all of it already billed, nothing new.
 * The sheet still states its cumulative 6.4 and "Now to Pay Nil". */
const MB2_A06 = bookLine({
  itemNumber: 'A/6',
  pctSupply: '64.00',
  priorSupplied: '10.000',
  remark: 'Prepaid 64% for 10 Nos. Now to pay nill.',
});

/** Every case below is a COEFFICIENT sheet, because every document in the
 * settlement corpus is one. The way argument only breaks a tie on a line
 * that fits both arithmetics; the dedicated block at the end of this file
 * is where it earns its keep. */
function runMatch(
  lines: readonly MeasurementBookLine[],
  items: readonly ReturnType<typeof itemsOf>[number][],
  way: MbWay = 'coefficient',
) {
  return matchRailwayMeasurement(lines, items, way);
}

function itemsOf(sheet: string, ...itemNumbers: readonly string[]) {
  const parsed = parseRailwayMeasurement(sheet);
  return itemNumbers.map((wanted) => {
    const found = parsed.items.find((item) => item.itemNumber === wanted);
    if (found === undefined) throw new Error(`fixture has no item ${wanted}`);
    return found;
  });
}

describe('matchRailwayMeasurement', () => {
  it('matches a first measurement whose railway copy prints "Prepaid Nil"', () => {
    const match = runMatch([MB1_A01], itemsOf(sheets['MB-1'] ?? '', 'A/01'));
    expect(match.status).toBe('matched');
    expect(match.lines).toEqual([
      {
        itemNumber: 'A/1',
        matched: true,
        refusal: null,
        detail: null,
        way: 'coefficient',
      },
    ]);
  });

  it('matches on the TRUE CUMULATIVE quantity, not this measurement own delta', () => {
    // The correction the corpus forced. A matcher that compared the
    // railway's 2.8 against this book's delta of 1 Nos at 70% (0.7) would
    // refuse every measurement after the first, on every Work.
    const match = runMatch([MB2_A01], itemsOf(sheets['MB-2'] ?? '', 'A/01'));
    expect(match.status).toBe('matched');
  });

  it('matches a stage with nothing new, whose cumulative the railway still prints', () => {
    const match = runMatch([MB2_A06], itemsOf(sheets['MB-2'] ?? '', 'A/06'));
    expect(match.status).toBe('matched');
  });

  it('folds the five ways IWRCMS re-typesets a remark it agrees with', () => {
    // Case, zero padding, punctuation, the missing space after "Prepaid"
    // that MB-2 prints on one item and not the next, and our "nill"
    // against their "Nil". Each is observed in the corpus; none of them
    // can turn one claim into a different one.
    const match = runMatch(
      [
        bookLine({
          itemNumber: 'A/8',
          pctSupply: '70.00',
          priorSupplied: '9.000',
          remark: 'Prepaid 70% for 9 Nos. Now to pay nill.',
        }),
      ],
      itemsOf(sheets['MB-2'] ?? '', 'A/08'),
    );
    expect(match.status).toBe('matched');
  });

  it('names a quantity the railway measured differently, and does not go on to the remark', () => {
    const match = runMatch(
      [bookLine({ ...MB1_A01, deltaSupplied: '4.000' })],
      itemsOf(sheets['MB-1'] ?? '', 'A/01'),
    );
    expect(match.status).toBe('mismatched');
    expect(match.lines[0]?.refusal).toBe('quantity');
    expect(match.lines[0]?.detail).toContain('measures 2.8 (coefficient)');
    // The other fit is named too, so an operator can see at a glance that
    // 2.1 is neither this book's coefficient figure nor its physical one.
    expect(match.lines[0]?.detail).toContain('4 (physical)');
    expect(match.lines[0]?.detail).toContain('records 2.1');
  });

  it('names a remark the railway states differently', () => {
    const match = runMatch(
      [bookLine({ ...MB1_A01, remark: 'Now to pay 70% for 3 Metre.' })],
      itemsOf(sheets['MB-1'] ?? '', 'A/01'),
    );
    expect(match.status).toBe('mismatched');
    expect(match.lines[0]?.refusal).toBe('remark');
  });

  it('names a line the railway did not measure at all', () => {
    const match = runMatch(
      [MB1_A01, bookLine({ itemNumber: 'Z/9' })],
      itemsOf(sheets['MB-1'] ?? '', 'A/01'),
    );
    expect(match.status).toBe('mismatched');
    expect(match.lines[1]).toMatchObject({
      itemNumber: 'Z/9',
      refusal: 'missing_from_measurement',
    });
  });

  it('names a line the railway measured and this book does not carry', () => {
    // Dropped silently, this is the dangerous direction: the railway
    // measuring something we never claimed is as much a disagreement as
    // the reverse, and a matcher that only walked the book would report
    // `matched`.
    const match = runMatch([MB1_A01], itemsOf(sheets['MB-1'] ?? '', 'A/01', 'A/03'));
    expect(match.status).toBe('mismatched');
    expect(match.lines).toHaveLength(2);
    expect(match.lines[1]).toMatchObject({
      itemNumber: 'A/03',
      refusal: 'absent_from_measurement_book',
    });
  });

  it('reads A/01 and A/1 as one item, and A/1 and B/1 as two', () => {
    // The railway zero-pads; this product's schedules do not. What is NOT
    // folded is the schedule letter, because two schedules routinely
    // carry the same item number — MB-1 has an A/01 and a C/01 with
    // different quantities.
    expect(runMatch([MB1_A01], itemsOf(sheets['MB-1'] ?? '', 'A/01')).status).toBe(
      'matched',
    );
    expect(
      runMatch(
        [bookLine({ ...MB1_A01, itemNumber: 'B/1' })],
        itemsOf(sheets['MB-1'] ?? '', 'A/01'),
      ).lines.map((line) => line.refusal),
    ).toEqual(['missing_from_measurement', 'absent_from_measurement_book']);
  });
});

/**
 * Way detection (owner ruling, corrections item 24).
 *
 * Every sheet in the settlement corpus is a COEFFICIENT sheet, and that is
 * the evidence these cases rest on: MB-1's A/01 prints 2.1 against three
 * units at 70%, so a matcher that only knew the physical arithmetic would
 * have called the real document a mismatch. The physical direction has no
 * corpus document at all, so it is exercised against the same real sheet
 * read the other way round — a book whose stage is 100% prints the same
 * 2.1 either way — plus a constructed line, which is stated as constructed
 * rather than dressed up as evidence.
 */
describe('matchRailwayMeasurement way detection', () => {
  it('detects the coefficient way on the corpus sheet, whichever way the book claims', () => {
    for (const claimed of ['coefficient', 'physical'] as const) {
      const match = runMatch([MB1_A01], itemsOf(sheets['MB-1'] ?? '', 'A/01'), claimed);
      expect(match.status).toBe('matched');
      // The BOOK's claim does not decide it: 2.1 is three units at 70%
      // and is not three units, so only one fit is possible and the
      // matcher names that one either way round.
      expect(match.lines[0]?.way).toBe('coefficient');
    }
  });

  it('detects the physical way on a book the railway transcribed unweighted', () => {
    // Constructed, and deliberately so — no way-2 document exists in the
    // corpus. The sheet is MB-1's real A/01 (Total 2.1); the book is one
    // that measures 2.1 units at 100%, which is what a way-2 sheet of the
    // same money looks like. The remark is the same sentence either way.
    const match = runMatch(
      [
        bookLine({
          itemNumber: 'A/1',
          pctSupply: '100.00',
          deltaSupplied: '2.100',
          remark: 'Now to pay 100% for 2.1 Nos.',
        }),
      ],
      itemsOf(sheets['MB-1'] ?? '', 'A/01'),
      'physical',
    );
    // The remark differs from the sheet's "70% for 03 Nos", so the line is
    // refused on the REMARK and not on the quantity — which is the point:
    // the quantity fit was found, and the disagreement is elsewhere.
    expect(match.lines[0]?.refusal).toBe('remark');
  });

  it('breaks a tie towards the way the book records, and only a tie', () => {
    // A single 100% stage: the two arithmetics coincide, so the figure
    // cannot say which way it was typed and the book's own statement is
    // the best evidence there is.
    const line = bookLine({
      itemNumber: 'A/1',
      pctSupply: '100.00',
      deltaSupplied: '2.100',
      remark: 'Now to pay 100% for 2.1 Nos.',
    });
    const items = itemsOf(sheets['MB-1'] ?? '', 'A/01');
    // Remark aside, the quantity fits both ways under either claim.
    expect(runMatch([line], items, 'physical').lines[0]?.refusal).toBe('remark');
    expect(runMatch([line], items, 'coefficient').lines[0]?.refusal).toBe('remark');
  });

  it('offers no physical fit when the stages measure different quantities', () => {
    // 3 supplied and 2 installed is one measurement of three units and one
    // of two; the corpus cannot say whether a way-2 sheet would print 3, 2
    // or 5, so no second fit is offered and the refusal names only the
    // coefficient figure. Guessing here is how a matcher starts accepting
    // documents that do not agree.
    const match = runMatch(
      [
        bookLine({
          itemNumber: 'A/1',
          pctSupply: '70.00',
          deltaSupplied: '3.000',
          pctInstallation: '20.00',
          deltaInstalled: '2.000',
          remark: 'Now to pay 70% for 3 Nos and 20% for 2 Nos.',
        }),
      ],
      itemsOf(sheets['MB-1'] ?? '', 'A/01'),
    );
    expect(match.lines[0]?.refusal).toBe('quantity');
    expect(match.lines[0]?.detail).toContain('measures 2.5 (coefficient)');
    expect(match.lines[0]?.detail).not.toContain('physical');
  });
});
