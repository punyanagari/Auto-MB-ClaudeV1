import { describe, expect, it } from 'vitest';
import { isPositiveDecimal } from '../src/routes/challans.js';

/**
 * Every writer that refuses a non-positive quantity — delivery challan
 * lines, issue challan lines, correction replacements and amendment
 * additions — decides "greater than zero" through this one predicate.
 *
 * The property under test is that it reads the DIGITS. The predicate it
 * replaced at three of those sites, `Number(value) === 0`, converts to a
 * JavaScript double first, which is binary floating point and therefore
 * not authoritative arithmetic (AGENTS.md engineering rule 5). Today the
 * two agree on everything DecimalStringSchema admits, because that schema
 * caps fraction digits at three. That cap is the only reason, it lives in
 * another package, and RateStringSchema already allows six — so the
 * agreement is a coincidence of configuration rather than a property of
 * the check. The cases below are the ones on which the two disagree, and
 * they fail against any re-implementation that converts to a number.
 */
describe('isPositiveDecimal', () => {
  it('accepts every positive value, including ones a double underflows to zero', () => {
    const underflows = `0.${'0'.repeat(400)}1`;
    // Precondition: the double conversion really does lose this value.
    expect(Number(underflows)).toBe(0);
    expect(isPositiveDecimal(underflows)).toBe(true);
    for (const value of ['1', '0.001', '0.5', '10.000', '1234567890123456']) {
      expect(isPositiveDecimal(value), value).toBe(true);
    }
  });

  it('refuses zero in every spelling', () => {
    for (const value of ['0', '0.0', '0.000', `0.${'0'.repeat(400)}`]) {
      expect(isPositiveDecimal(value), value).toBe(false);
    }
  });

  it('refuses every negative value, including negative zero', () => {
    for (const value of ['-0', '-0.000', '-1', '-0.001', `-0.${'0'.repeat(400)}1`]) {
      expect(isPositiveDecimal(value), value).toBe(false);
    }
  });
});
