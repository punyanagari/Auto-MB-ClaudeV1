// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NumericInput, sanitiseNumericText } from '../src/ui/numeric-input.js';

/*
 * The number-only input, and the census that keeps it the only one.
 *
 * Two different claims are made here. The first is about the filter: a
 * non-numeric character cannot reach the value, whichever way it arrives.
 * The second is about REACH — a shared control that half the fields use is
 * a convention, not a rule, and the fields that opted out are exactly the
 * ones nobody would notice. So the source is counted: a new
 * `type="number"`, or a new hand-rolled `inputMode="decimal"` input, fails
 * this file rather than quietly reintroducing the shape the primitive
 * replaced.
 */

afterEach(cleanup);

describe('the numeric filter', () => {
  it('keeps digits and drops everything else', () => {
    expect(sanitiseNumericText('1,250')).toBe('1250');
    expect(sanitiseNumericText('12e5')).toBe('125');
    expect(sanitiseNumericText('₹ 4 500.50')).toBe('4500.50');
    expect(sanitiseNumericText('abc')).toBe('');
  });

  it('keeps the first decimal point and drops the rest', () => {
    expect(sanitiseNumericText('1.2.3')).toBe('1.23');
    expect(sanitiseNumericText('..5')).toBe('.5');
  });

  it('keeps a leading minus and drops one written anywhere else', () => {
    // Whether a negative value is legal is the field's schema to say; the
    // control only refuses characters that are not part of a number.
    expect(sanitiseNumericText('-12.5')).toBe('-12.5');
    expect(sanitiseNumericText('12-5')).toBe('125');
  });

  it('refuses the decimal point outright in the integer variant', () => {
    expect(sanitiseNumericText('1.5', true)).toBe('15');
    expect(sanitiseNumericText('-24', true)).toBe('-24');
  });

  it('does not cap the scale — precision belongs to the contract schema', () => {
    // A six-decimal rate is legal (`RateString`); silently truncating it
    // to three would be a wrong number rather than a refused one.
    expect(sanitiseNumericText('12.345678')).toBe('12.345678');
  });
});

describe('the numeric input', () => {
  it('never lets a typed non-numeric character reach an uncontrolled value', () => {
    render(<NumericInput aria-label="Quantity" defaultValue="" />);
    const field = screen.getByLabelText<HTMLInputElement>('Quantity');
    fireEvent.change(field, { target: { value: '1a2' } });
    expect(field.value).toBe('12');
  });

  it('hands a controlled caller the cleaned value, not the raw one', () => {
    const seen: string[] = [];
    render(
      <NumericInput
        aria-label="Rate"
        value=""
        onChange={(event) => {
          seen.push(event.currentTarget.value);
        }}
      />,
    );
    // A paste arrives as one input event, exactly like a keystroke.
    fireEvent.change(screen.getByLabelText('Rate'), { target: { value: '1,250.75' } });
    expect(seen).toEqual(['1250.75']);
  });

  it('asks the phone for the decimal pad, or the digits pad when integer', () => {
    render(<NumericInput aria-label="Quantity" defaultValue="" />);
    expect(screen.getByLabelText('Quantity')).toHaveProperty('inputMode', 'decimal');
    cleanup();
    render(<NumericInput integer aria-label="Months" defaultValue="" />);
    expect(screen.getByLabelText('Months')).toHaveProperty('inputMode', 'numeric');
  });
});
