import { describe, expect, it } from 'vitest';
import { paiseText, toPaise } from '../src/money.js';
import { sumDecimals } from '../src/gsp/eway-payload.js';

/**
 * The shared money lexeme parser. These figures are authoritative — a
 * wrong answer here is a wrong rupee on a statutory document or a
 * dashboard tile — so the exactness is pinned rather than assumed.
 */
describe('toPaise / paiseText', () => {
  it('round-trips exact money text through integer paise', () => {
    for (const [text, paise] of [
      ['0.00', 0n],
      ['0.01', 1n],
      ['12.34', 1234n],
      ['-12.34', -1234n],
      ['169228497.35', 16922849735n],
      // Beyond Number.MAX_SAFE_INTEGER in paise: the whole reason for BigInt.
      ['999999999999999.99', 99999999999999999n],
    ] as const) {
      expect(toPaise(text), text).toBe(paise);
      expect(paiseText(paise), text).toBe(text);
    }
  });

  it('pads a short or absent fraction to two digits', () => {
    expect(toPaise('12')).toBe(1200n);
    expect(toPaise('12.5')).toBe(1250n);
    expect(toPaise('-12.5')).toBe(-1250n);
    expect(paiseText(1200n)).toBe('12.00');
    expect(paiseText(-5n)).toBe('-0.05');
  });

  it('trims surrounding whitespace, which PostgreSQL text never carries but callers may', () => {
    expect(toPaise('  12.34  ')).toBe(1234n);
  });

  it('refuses anything that is not an exact money lexeme', () => {
    for (const bad of [
      '1.005',
      '1e5',
      '+5',
      '',
      '   ',
      '1,234.00',
      'NaN',
      '.5',
      '5.',
    ]) {
      expect(() => toPaise(bad), bad).toThrow(/not an exact money figure/);
    }
  });
});

/**
 * The e-way payload keeps its OWN parser because it is laxer: a frozen
 * snapshot's decimal grammar permits any number of fraction digits, so
 * trailing zeroes past the paisa are data, not a fault. If someone folds
 * it into the shared parser, this fails.
 */
describe('the e-way builder stays laxer than the shared parser', () => {
  it('accepts trailing-zero over-scale that the shared parser rejects', () => {
    expect(sumDecimals(['100.000', '0.500'])).toBe('100.50');
    expect(() => toPaise('100.000')).toThrow(/not an exact money figure/);
  });

  it('still refuses genuine sub-paisa precision', () => {
    expect(() => sumDecimals(['100.005'])).toThrow(/sub-paisa precision/);
  });
});
