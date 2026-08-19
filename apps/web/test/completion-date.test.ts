import { describe, expect, it } from 'vitest';
import { completionDateFrom } from '../src/loa-payload.js';

/**
 * The completion date the LOA review screen proposes: the letter's own
 * date plus the completion period it prints.
 *
 * It is a PREFILL the reviewer can overwrite, but a prefill on a legal
 * deadline still has to be right — liquidated damages are counted from
 * this date, so an off-by-one here is money.
 */
describe('completionDateFrom', () => {
  it('adds whole months as calendar months, not as a day count', () => {
    expect(completionDateFrom('2026-03-15', { value: 12, unit: 'month' })).toBe(
      '2027-03-15',
    );
    expect(completionDateFrom('2026-08-19', { value: 24, unit: 'month' })).toBe(
      '2028-08-19',
    );
    // Across a year boundary, and by a period that is not a whole year.
    expect(completionDateFrom('2026-11-30', { value: 4, unit: 'month' })).toBe(
      '2027-03-30',
    );
    expect(completionDateFrom('2026-01-01', { value: 1, unit: 'month' })).toBe(
      '2026-02-01',
    );
  });

  it('clamps a month-end date to the last day of the target month', () => {
    // 31 January plus one month is the end of February, not the 3rd of
    // March: rolling forward would put the deadline in the month after
    // the one the letter names. 2028 is a leap year, 2027 is not.
    expect(completionDateFrom('2026-01-31', { value: 1, unit: 'month' })).toBe(
      '2026-02-28',
    );
    expect(completionDateFrom('2027-12-31', { value: 2, unit: 'month' })).toBe(
      '2028-02-29',
    );
    expect(completionDateFrom('2026-08-31', { value: 1, unit: 'month' })).toBe(
      '2026-09-30',
    );
  });

  it('proposes nothing it cannot derive exactly', () => {
    // A period in another unit, an unreadable one, a non-whole or
    // non-positive count, an absent field, and a letter date the parser
    // could not read: every one of these is the reviewer's to type.
    expect(completionDateFrom('2026-03-15', { value: 90, unit: 'day' })).toBeNull();
    expect(completionDateFrom('2026-03-15', { value: null, unit: 'month' })).toBeNull();
    expect(completionDateFrom('2026-03-15', { value: 0, unit: 'month' })).toBeNull();
    expect(completionDateFrom('2026-03-15', { value: -6, unit: 'month' })).toBeNull();
    expect(completionDateFrom('2026-03-15', { value: 1.5, unit: 'month' })).toBeNull();
    expect(completionDateFrom('2026-03-15', undefined)).toBeNull();
    expect(completionDateFrom('', { value: 12, unit: 'month' })).toBeNull();
    expect(completionDateFrom('15/03/2026', { value: 12, unit: 'month' })).toBeNull();
  });

  it('never proposes a date before the letter, which the server refuses', () => {
    // The rule the column's CHECK (migration 0011), the confirm route and
    // the one-time set route all hold. A positive month count cannot
    // break it, and this is the assertion that says so.
    for (const months of [1, 3, 12, 18, 24, 36, 60]) {
      const derived = completionDateFrom('2026-02-28', { value: months, unit: 'month' });
      expect(derived, String(months)).not.toBeNull();
      expect(derived! >= '2026-02-28', String(months)).toBe(true);
    }
  });
});
