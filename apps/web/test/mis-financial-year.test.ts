import { describe, expect, it } from 'vitest';
import { financialYearStart } from '../src/views/Mis.js';

/**
 * The Tally export form's default window.
 *
 * One branch, and it was wrong for a quarter of the year: the first cut
 * defaulted `from` to `${currentYear}-04-01`, so between 1 January and 31
 * March the form opened with a start date AFTER its end date and refused
 * itself with a 400 on first submit, having been touched by nobody.
 *
 * The Indian financial year runs April to March, so January, February and
 * March belong to the year that started the PREVIOUS April.
 */
describe('the financial year a date falls in', () => {
  it('starts in April of the same year from April onwards', () => {
    expect(financialYearStart('2026-04-01')).toBe('2026-04-01');
    expect(financialYearStart('2026-08-19')).toBe('2026-04-01');
    expect(financialYearStart('2026-12-31')).toBe('2026-04-01');
  });

  it('starts in April of the PREVIOUS year for January to March', () => {
    expect(financialYearStart('2027-01-01')).toBe('2026-04-01');
    expect(financialYearStart('2027-02-14')).toBe('2026-04-01');
    expect(financialYearStart('2027-03-31')).toBe('2026-04-01');
  });

  it('never produces a window that starts after today', () => {
    // The property the defect actually broke: whatever the day, the
    // default `from` is on or before it, so the form's own window is
    // valid before anybody touches it.
    for (const day of [
      '2026-01-01',
      '2026-03-31',
      '2026-04-01',
      '2026-06-15',
      '2027-03-31',
    ]) {
      expect(financialYearStart(day) <= day, day).toBe(true);
    }
  });
});
