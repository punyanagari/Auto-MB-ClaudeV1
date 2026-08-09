import { describe, expect, it } from 'vitest';
import { amountInWords } from '../src/amount-in-words.js';

describe('amountInWords (Indian system, exact decimal-string input)', () => {
  it('renders the workbook-style flagship example', () => {
    expect(amountInWords('12345678.90')).toBe(
      'Rupees One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight and Paise Ninety Only',
    );
  });

  it('renders the zero edge', () => {
    expect(amountInWords('0.00')).toBe('Rupees Zero Only');
    expect(amountInWords('0')).toBe('Rupees Zero Only');
  });

  it('omits the paise clause when paise are zero', () => {
    expect(amountInWords('4000.00')).toBe('Rupees Four Thousand Only');
    expect(amountInWords('98.00')).toBe('Rupees Ninety-Eight Only');
  });

  it('renders paise with a single fraction digit as tens of paise', () => {
    // numeric text may drop the trailing zero: '.9' means 90 paise.
    expect(amountInWords('1.9')).toBe('Rupees One and Paise Ninety Only');
    expect(amountInWords('1.09')).toBe('Rupees One and Paise Nine Only');
    expect(amountInWords('0.05')).toBe('Rupees Zero and Paise Five Only');
  });

  it('walks the grouping boundaries', () => {
    expect(amountInWords('999.00')).toBe('Rupees Nine Hundred Ninety-Nine Only');
    expect(amountInWords('1000.00')).toBe('Rupees One Thousand Only');
    expect(amountInWords('99999.00')).toBe(
      'Rupees Ninety-Nine Thousand Nine Hundred Ninety-Nine Only',
    );
    expect(amountInWords('100000.00')).toBe('Rupees One Lakh Only');
    expect(amountInWords('9999999.00')).toBe(
      'Rupees Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred Ninety-Nine Only',
    );
    expect(amountInWords('10000000.00')).toBe('Rupees One Crore Only');
  });

  it('recurses beyond ninety-nine crore', () => {
    expect(amountInWords('1234567890.00')).toBe(
      'Rupees One Hundred Twenty-Three Crore Forty-Five Lakh Sixty-Seven Thousand Eight Hundred Ninety Only',
    );
  });

  it('stays exact across the full numeric(18,2) width (no floats)', () => {
    expect(amountInWords('9999999999999999.99')).toBe(
      'Rupees Ninety-Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred ' +
        'Ninety-Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred ' +
        'Ninety-Nine and Paise Ninety-Nine Only',
    );
  });

  it('rejects anything that is not a plain non-negative 2dp decimal', () => {
    for (const bad of ['-1.00', '1.234', '1,000.00', 'NaN', '', '1e3', '.50']) {
      expect(() => amountInWords(bad)).toThrowError(/numeric\(18,2\)/);
    }
  });
});
