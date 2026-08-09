import { describe, expect, it } from 'vitest';
import { canonicalRateText } from '../src/rate-text.js';

describe('canonicalRateText', () => {
  it('trims numeric(18,6) column text to the real precision, never below 2dp', () => {
    expect(canonicalRateText('100.000000')).toBe('100.00');
    expect(canonicalRateText('0.851700')).toBe('0.8517');
    expect(canonicalRateText('2.505000')).toBe('2.505');
    expect(canonicalRateText('3.175636')).toBe('3.175636');
    expect(canonicalRateText('0.100000')).toBe('0.10');
  });

  it('keeps the conventional money look for coarse and integer inputs', () => {
    expect(canonicalRateText('150')).toBe('150.00');
    expect(canonicalRateText('1.5')).toBe('1.50');
    expect(canonicalRateText('180.00')).toBe('180.00');
    expect(canonicalRateText('0')).toBe('0.00');
  });

  it('passes non-decimal text through untouched', () => {
    expect(canonicalRateText('not-a-number')).toBe('not-a-number');
    expect(canonicalRateText('')).toBe('');
  });
});
