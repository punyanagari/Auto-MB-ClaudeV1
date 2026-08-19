import { describe, expect, it } from 'vitest';
import { byItemNumber, compareItemNumbers } from '../src/item-order.js';

/**
 * The order a schedule's item numbers are read in — the one rule the
 * server's stored line order and the browser's rendered list both obey.
 */
describe('compareItemNumbers', () => {
  it('reads runs of digits as numbers, at every position', () => {
    const sorted = ['A1/10', 'A1/2', 'A1/1', 'A10/1', 'A2/1', 'A1/11'].sort(
      compareItemNumbers,
    );
    expect(sorted).toEqual(['A1/1', 'A1/2', 'A1/10', 'A1/11', 'A2/1', 'A10/1']);
  });

  it('is a TOTAL order: collation ties break on the raw string', () => {
    // `A/1` and `A/01` are EQUAL under numeric collation, and both can
    // exist on one Work because item numbers are operator-editable text.
    // Without the tiebreak the comparator returns 0 and their relative
    // order is left to whichever sort implementation ran — and the
    // server's and the browser's are not the same one.
    expect(compareItemNumbers('A/1', 'A/01')).not.toBe(0);
    expect(compareItemNumbers('A/1', 'A/01')).toBe(-compareItemNumbers('A/01', 'A/1'));
    expect(compareItemNumbers('A/1', 'A/1')).toBe(0);
    // The tie still sorts stably and identically from either input order.
    const forward = ['A/1', 'A/01'].sort(compareItemNumbers);
    const backward = ['A/01', 'A/1'].sort(compareItemNumbers);
    expect(forward).toEqual(backward);
  });

  it('does not move with the runtime locale', () => {
    // Pinned to 'en'. If this ever reads the ambient locale, the same two
    // item numbers sort one way on the server and another in a browser.
    const sorted = ['b/2', 'A/10', 'a/2', 'B/1'].sort(compareItemNumbers);
    expect(sorted.join(' ')).toBe(
      ['a/2', 'A/10', 'B/1', 'b/2'].sort(compareItemNumbers).join(' '),
    );
    expect(sorted).toHaveLength(4);
  });

  it('byItemNumber copies rather than sorting the caller in place', () => {
    const items = [{ itemNumber: 'A1/10' }, { itemNumber: 'A1/2' }] as const;
    expect(byItemNumber(items).map((item) => item.itemNumber)).toEqual([
      'A1/2',
      'A1/10',
    ]);
    expect(items[0].itemNumber).toBe('A1/10');
  });
});
