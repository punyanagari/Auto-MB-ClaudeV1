import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  parseRailwayMeasurement,
  RailwayMeasurementParseError,
} from '../src/railway-measurement-parse.js';

/**
 * Reading the railway's own Measurement Book (migration 0111).
 *
 * The bar is the committed settlement corpus, not a hand-written sample:
 * `MB-{1,2,3}.raw.txt` are three real IWRCMS measurement sheets from one
 * Work, extracted with the Poppler `-layout` view production reads. A
 * parser proved only against text somebody wrote to make it pass proves
 * that the author agrees with themselves.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = path.join(here, 'fixtures', 'railway-settlement');

const sheets: Record<string, string> = {};

beforeAll(async () => {
  for (const id of ['MB-1', 'MB-2', 'MB-3']) {
    sheets[id] = await readFile(path.join(corpus, `${id}.raw.txt`), 'utf8');
  }
});

describe('parseRailwayMeasurement, against the settlement corpus', () => {
  it('reads every item of all three real measurement sheets', () => {
    const counts = Object.fromEntries(
      Object.entries(sheets).map(([id, text]) => [
        id,
        parseRailwayMeasurement(text).items.length,
      ]),
    );
    // The corpus is a real Work billing up: each measurement carries more
    // items than the one before it. Pinned rather than merely non-zero,
    // so a parser that silently starts dropping blocks fails here.
    expect(counts).toEqual({ 'MB-1': 24, 'MB-2': 44, 'MB-3': 57 });
  });

  it('takes the sheet own measurement number and not the bill it back-references', () => {
    // Trap 2 of the corpus: MB-2 and MB-3 carry `Qty B/F MB
    // no. .../OAM/FL2/01 (Item no : 01)` lines that name the PREVIOUS
    // bill. A looser search for the measurement number finds those.
    expect(parseRailwayMeasurement(sheets['MB-2'] ?? '').measurement.raw).toBe(
      '00341490147964/CSTM/1139316/OAM/L2/02',
    );
    expect(parseRailwayMeasurement(sheets['MB-3'] ?? '').measurement.sequence).toBe(3);
    // And the LOA number the route files the sheet under is the first
    // segment of that same string, so the two cannot disagree.
    expect(
      parseRailwayMeasurement(sheets['MB-1'] ?? '').measurement.contractNumber,
    ).toBe('00341490147964');
  });

  it('qualifies an item number by its schedule, because item numbers repeat', () => {
    // MB-1 carries `Item No. : 01` under SCHEDULE A and again under
    // SCHEDULE C, with different quantities. Keyed on the item number
    // alone one silently overwrites the other.
    const items = parseRailwayMeasurement(sheets['MB-1'] ?? '').items;
    const first = items.find((item) => item.itemNumber === 'A/01');
    const second = items.find((item) => item.itemNumber === 'C/01');
    expect(first?.quantity).toBe('2.1');
    expect(second?.quantity).toBe('0.7');
  });

  it('reads the total and the reason for reduction off their shared lines', () => {
    const items = parseRailwayMeasurement(sheets['MB-1'] ?? '').items;
    expect(items[0]).toEqual({
      itemNumber: 'A/01',
      quantity: '2.1',
      // The trailing `Now to pay 100.0%` on that line is a separate grid
      // column and must not end up inside the remark.
      remark: 'Prepaid Nil Now to Pay 70% for 03 Nos',
    });
  });

  it('survives a heading that lands under a page-break form feed', () => {
    // MB-1 item A/19: Poppler writes `\f` with no newline of its own, so
    // the reason line arrives as `\fReason for Reduction : …`. Exactly
    // one item in this document is affected, which is the shape of bug
    // that passes every hand-written fixture.
    const items = parseRailwayMeasurement(sheets['MB-1'] ?? '').items;
    const wrapped = items.find((item) => item.itemNumber === 'A/19');
    expect(wrapped).toEqual({
      itemNumber: 'A/19',
      quantity: '92.4',
      remark: 'Prepaid Nil Now to Pay 70% for 132 Nos.',
    });
  });

  it('reads a prepaid clause, and a nothing-to-pay measurement', () => {
    const items = parseRailwayMeasurement(sheets['MB-2'] ?? '').items;
    expect(items.find((item) => item.itemNumber === 'A/01')?.remark).toBe(
      'Prepaid 70% for 03 Nos Now to Pay 70% for 01 Nos',
    );
    // A stage that has nothing new this measurement still prints its
    // cumulative total.
    expect(items.find((item) => item.itemNumber === 'A/06')).toEqual({
      itemNumber: 'A/06',
      quantity: '6.4',
      remark: 'Prepaid 64% for 10 Nos Now to Pay Nil',
    });
  });

  it('refuses a document with no measurement heading', () => {
    expect(() => parseRailwayMeasurement('a scan with no text layer at all')).toThrow(
      RailwayMeasurementParseError,
    );
  });

  it('refuses a half-read sheet rather than returning the items it managed', () => {
    // An item whose reason line is missing is not "one item short"; it is
    // a document this reader did not understand, and the caller's
    // fallback — a recorded line-by-line confirmation — is the honest
    // answer to that. Returning a partial table would silently compare a
    // subset and call it a match.
    const truncated = (sheets['MB-1'] ?? '').split('Reason for Reduction')[0] ?? '';
    expect(() => parseRailwayMeasurement(truncated)).toThrow(
      /prints no reason for reduction/,
    );
  });

  it('refuses an item that appears before any schedule heading', () => {
    expect(() =>
      parseRailwayMeasurement(
        [
          'On Account Measurement No. 00341490147964/CSTM/1139316/OAM/L2/01',
          'Item No. : 01      Something measured under no schedule',
          '                              Total         2.1',
          'Reason for Reduction : Prepaid Nil Now to Pay 70% for 03 Nos       Now to pay   100.0%',
        ].join('\n'),
      ),
    ).toThrow(/before any SCHEDULE heading/);
  });
});
