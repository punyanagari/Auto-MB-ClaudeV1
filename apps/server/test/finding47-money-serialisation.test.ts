import { describe, expect, it } from 'vitest';
import {
  exactJsonInteger,
  exactJsonNumber,
  statutoryJsonDisplay,
  stringifyStatutoryJson,
} from '../src/gsp/statutory-json.js';

/**
 * Finding 47, money-and-legal subset, item (d): maximum money
 * serialisation boundaries for `gsp/statutory-json.ts`.
 *
 * A PostgreSQL numeric(18,2) money value can exceed JavaScript's
 * integer-safe range while its textual form stays exact. The audit asked
 * for the boundary proofs that stop a regression from silently
 * reintroducing a Number() round-trip: the largest representable values
 * must reach the wire byte-for-byte, and unsafe bare integers must be
 * refused rather than rounded.
 */

/** numeric(18,2): eighteen significant digits, two of them fractional. */
const MAX_NUMERIC_18_2 = '9999999999999999.99';
const MIN_NUMERIC_18_2 = '-9999999999999999.99';

describe('finding 47(d) — largest representable money values are byte-exact', () => {
  it('serialises the numeric(18,2) maximum verbatim', () => {
    expect(stringifyStatutoryJson(exactJsonNumber(MAX_NUMERIC_18_2))).toBe(
      MAX_NUMERIC_18_2,
    );
    expect(stringifyStatutoryJson(exactJsonNumber(MIN_NUMERIC_18_2))).toBe(
      MIN_NUMERIC_18_2,
    );
  });

  it('keeps a value a float64 cannot hold, where Number() would corrupt it', () => {
    // 2^53 = 9007199254740992: the first integer at which float64 loses
    // exactness. One rupee-paise value just past it is the discriminating
    // case — a Number() round-trip demonstrably changes the digits.
    const pastSafe = '9007199254740993.11';
    expect(String(Number(pastSafe))).not.toBe(pastSafe);
    expect(stringifyStatutoryJson(exactJsonNumber(pastSafe))).toBe(pastSafe);

    // Embedded in a payload shape, the lexeme still lands verbatim.
    expect(
      stringifyStatutoryJson({ ValDtls: { TotInvVal: exactJsonNumber(pastSafe) } }),
    ).toBe(`{"ValDtls":{"TotInvVal":${pastSafe}}}`);
  });

  it('keeps exactness for maximum-precision rates and identifiers', () => {
    // numeric(18,6) rate boundary and a 6-digit PIN with a leading zero
    // (an exact integer lexeme must not gain or lose digits).
    const rate = '999999999999.999999';
    expect(stringifyStatutoryJson(exactJsonNumber(rate))).toBe(rate);
    expect(stringifyStatutoryJson(exactJsonInteger('011002'))).toBe('11002');
    expect(stringifyStatutoryJson(exactJsonInteger('110002'))).toBe('110002');
  });

  it('rejects lexemes that are not exact JSON numbers', () => {
    for (const bad of [
      '9,999.99',
      '01.20',
      '1.',
      '.5',
      '1e10',
      '+1',
      'NaN',
      'Infinity',
      '',
      '1..2',
    ]) {
      expect(() => exactJsonNumber(bad), bad).toThrow(/Invalid exact JSON number/);
    }
    expect(() => exactJsonInteger('12a4')).toThrow(/Invalid exact JSON integer/);
    expect(() => exactJsonInteger('-1')).toThrow(/Invalid exact JSON integer/);
  });
});

describe('finding 47(d) — unsafe bare integers are refused, not rounded', () => {
  it('accepts safe literal integers up to Number.MAX_SAFE_INTEGER', () => {
    expect(stringifyStatutoryJson(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(stringifyStatutoryJson(-Number.MAX_SAFE_INTEGER)).toBe('-9007199254740991');
    expect(stringifyStatutoryJson(0)).toBe('0');
  });

  it('refuses the first unsafe integer instead of emitting a rounded digit string', () => {
    expect(() => stringifyStatutoryJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /safe literal integers/,
    );
    expect(() => stringifyStatutoryJson(-(Number.MAX_SAFE_INTEGER + 1))).toThrow(
      /safe literal integers/,
    );
  });

  it('refuses every non-integer number: floats never carry money', () => {
    for (const bad of [0.1, 295.6, Number.NaN, Infinity, -Infinity]) {
      expect(() => stringifyStatutoryJson(bad), String(bad)).toThrow(
        /safe literal integers/,
      );
    }
  });
});

describe('finding 47(d) — the display copy cannot re-round through the browser', () => {
  it('renders exact numbers as strings, including past-unsafe money', () => {
    const pastSafe = '9007199254740993.11';
    expect(
      statutoryJsonDisplay({
        total: exactJsonNumber(pastSafe),
        nested: [exactJsonNumber(MAX_NUMERIC_18_2)],
      }),
    ).toEqual({ total: pastSafe, nested: [MAX_NUMERIC_18_2] });
  });
});
