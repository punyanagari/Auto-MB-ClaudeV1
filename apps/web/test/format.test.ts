import { describe, expect, it } from 'vitest';
import {
  compareDecimalStrings,
  formatDate,
  formatTimestampDate,
} from '../src/format.js';

describe('compareDecimalStrings', () => {
  it('orders decimal strings numerically without losing precision', () => {
    const values = [
      '9.00',
      '100.00',
      '-2.500',
      '9007199254740993.001',
      '9007199254740993.000',
      '0.000',
    ];

    expect([...values].sort(compareDecimalStrings)).toEqual([
      '-2.500',
      '0.000',
      '9.00',
      '100.00',
      '9007199254740993.000',
      '9007199254740993.001',
    ]);
    expect(compareDecimalStrings('1.0', '1.000')).toBe(0);
  });
});

describe('formatTimestampDate', () => {
  it('renders the runner-local calendar day of the instant, in formatDate style', () => {
    // The suite runs in whatever timezone the machine has, so the
    // expectation is derived from the same instant's local parts rather
    // than hard-coding a day: the point under test is that the helper
    // uses the LOCAL day (no forced UTC), unlike the UTC slice it
    // replaced, which printed yesterday's date to anyone east of UTC
    // until their offset had passed midnight.
    const iso = '2026-08-11T20:30:00.000Z';
    const local = new Date(iso);
    const expected = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(local);
    expect(formatTimestampDate(iso)).toBe(expected);
    expect(formatTimestampDate(iso)).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4}$/);
  });

  it('honours an explicit offset in the timestamp', () => {
    // 01:00 IST on the 12th IS 19:30 UTC on the 11th — both spellings of
    // the instant must land on the same local day.
    expect(formatTimestampDate('2026-08-12T01:00:00+05:30')).toBe(
      formatTimestampDate('2026-08-11T19:30:00.000Z'),
    );
  });

  it('passes unparseable input through, like formatDate', () => {
    expect(formatTimestampDate('not a timestamp')).toBe('not a timestamp');
  });
});

describe('formatDate', () => {
  it('stays pinned to the UTC day for date-only strings', () => {
    // A date-only string names a calendar day, not an instant; it must
    // never shift with the viewer's timezone.
    expect(formatDate('2026-08-08')).toBe('08 Aug 2026');
  });
});
