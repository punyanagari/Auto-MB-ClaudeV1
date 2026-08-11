import { describe, expect, it } from 'vitest';
import { compareDecimalStrings } from '../src/format.js';

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
