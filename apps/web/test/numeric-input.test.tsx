// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NumericInput, sanitiseNumericText } from '../src/ui/numeric-input.js';

/*
 * The number-only input.
 *
 * The claim under test is narrow and it is the whole point: what reaches
 * the value is a number or the value does not change. The control REFUSES
 * rather than repairs, because the first version repaired and turned
 * `1.2.3` into `1.23` — a plausible wrong quantity produced by the guard
 * that was meant to prevent one.
 */

afterEach(cleanup);

describe('the numeric check', () => {
  it('accepts a number, including the half-typed states on the way to one', () => {
    expect(sanitiseNumericText('1250')).toBe('1250');
    expect(sanitiseNumericText('4500.50')).toBe('4500.50');
    expect(sanitiseNumericText('12.345678')).toBe('12.345678');
    // A field passes through all three of these while a number is typed.
    expect(sanitiseNumericText('')).toBe('');
    expect(sanitiseNumericText('-')).toBe('-');
    expect(sanitiseNumericText('12.')).toBe('12.');
  });

  it('trims the whitespace a paste brings and refuses the whitespace inside', () => {
    expect(sanitiseNumericText('  4500.50\n')).toBe('4500.50');
    // `4 500` is a thousands separator, not a number.
    expect(sanitiseNumericText('4 500')).toBeNull();
  });

  it('REFUSES rather than repairing what is not a number', () => {
    // Each of these was silently repaired by the first version of this
    // control, and each repair is a different plausible wrong number.
    expect(sanitiseNumericText('1.2.3')).toBeNull(); // became 1.23
    expect(sanitiseNumericText('12e5')).toBeNull(); // became 125
    expect(sanitiseNumericText('12.345,678')).toBeNull(); // became 12.345678
    expect(sanitiseNumericText('1,250')).toBeNull(); // became 1250
    expect(sanitiseNumericText('₹4500.50')).toBeNull(); // became 4500.50
    expect(sanitiseNumericText('abc')).toBeNull();
    expect(sanitiseNumericText('12-5')).toBeNull();
    expect(sanitiseNumericText('--5')).toBeNull();
  });

  it('refuses non-ASCII digits rather than transliterating them', () => {
    // A recorded decision, not an oversight: see the file's header. The
    // field keeps its previous value and the operator sees nothing happen.
    expect(sanitiseNumericText('१२')).toBeNull();
    expect(sanitiseNumericText('１２')).toBeNull();
  });

  it('keeps a leading minus; the field schema decides whether it is legal', () => {
    expect(sanitiseNumericText('-12.5')).toBe('-12.5');
  });

  it('TRUNCATES at the decimal point in integer mode, never deletes it', () => {
    // Deleting the point multiplies a months-or-days field by ten and
    // reads as a successful edit. This is the defect this rule exists for.
    expect(sanitiseNumericText('2.5', true)).toBe('2');
    expect(sanitiseNumericText('24.999', true)).toBe('24');
    expect(sanitiseNumericText('0.5', true)).toBe('0');
    expect(sanitiseNumericText('-24.5', true)).toBe('-24');
    expect(sanitiseNumericText('24', true)).toBe('24');
    // …and a thing that is not a number is still refused rather than
    // truncated, so the two rules cannot be played against each other.
    expect(sanitiseNumericText('2.5.3', true)).toBeNull();
  });

  it('does not cap the scale — precision belongs to the contract schema', () => {
    // A six-decimal rate is legal (`RateString`); silently truncating it
    // to three would be a wrong number rather than a refused one.
    expect(sanitiseNumericText('12.345678')).toBe('12.345678');
  });
});

describe('the numeric input', () => {
  it('leaves an uncontrolled field at its previous value when an edit is refused', () => {
    render(<NumericInput aria-label="Quantity" defaultValue="12" />);
    const field = screen.getByLabelText<HTMLInputElement>('Quantity');
    fireEvent.change(field, { target: { value: '1,250' } });
    expect(field.value).toBe('12');
    // …and accepts the next good edit, from the value it kept.
    fireEvent.change(field, { target: { value: '125' } });
    expect(field.value).toBe('125');
  });

  it('never tells a controlled caller about a refused edit', () => {
    const seen: string[] = [];
    render(
      <NumericInput
        aria-label="Rate"
        value="7"
        onChange={(event) => {
          seen.push(event.currentTarget.value);
        }}
      />,
    );
    const field = screen.getByLabelText<HTMLInputElement>('Rate');
    fireEvent.change(field, { target: { value: '1.2.3' } });
    expect(seen).toEqual([]);
    expect(field.value).toBe('7');
    fireEvent.change(field, { target: { value: '7.5' } });
    expect(seen).toEqual(['7.5']);
  });

  it('truncates a pasted decimal on an integer field', () => {
    render(<NumericInput integer aria-label="Months" defaultValue="" />);
    const field = screen.getByLabelText<HTMLInputElement>('Months');
    fireEvent.change(field, { target: { value: '2.5' } });
    expect(field.value).toBe('2');
  });

  it('leaves the field alone while an IME is still composing', () => {
    render(<NumericInput aria-label="Quantity" defaultValue="" />);
    const field = screen.getByLabelText<HTMLInputElement>('Quantity');
    const composing = new Event('input', { bubbles: true }) as InputEvent & {
      isComposing: boolean;
    };
    Object.defineProperty(composing, 'isComposing', { value: true });
    field.value = 'か';
    fireEvent(field, composing);
    // Untouched: the operator is mid-word, and rewriting rearranges what
    // they are still typing. The event that ENDS the composition is
    // checked like any other.
    expect(field.value).toBe('か');
  });

  it('asks the phone for the decimal pad, or the digits pad when integer', () => {
    render(<NumericInput aria-label="Quantity" defaultValue="" />);
    expect(screen.getByLabelText('Quantity')).toHaveProperty('inputMode', 'decimal');
    cleanup();
    render(<NumericInput integer aria-label="Months" defaultValue="" />);
    expect(screen.getByLabelText('Months')).toHaveProperty('inputMode', 'numeric');
  });
});
