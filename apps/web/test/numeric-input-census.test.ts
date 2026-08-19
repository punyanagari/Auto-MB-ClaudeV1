import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The census that keeps `NumericInput` the ONLY number-only input.
 *
 * A shared control that half the fields use is a convention, not a rule,
 * and the fields that opt out are exactly the ones nobody notices: the
 * sweep that introduced the primitive converted 73 of them, and the
 * seventy-fourth is the one a later change adds by copying the input two
 * lines above it. So the source is counted here rather than reviewed by
 * eye. A new `type="number"`, or a new hand-rolled `inputMode="decimal"`
 * input, fails this file.
 *
 * Checked against the SOURCE and not against a render, for the reason
 * `a11y-invariants.test.ts` gives about its own scans: the browser gate
 * only reaches the screens it opens, and this claim is about every screen.
 */

const WEB_SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

/** Every `<input …/>` element in a source file, as text. Inputs are void
 * elements and always self-close here, so the scan ends at the first `/>`
 * that is not inside a brace, a string or a template literal — an
 * `aria-label={`Line ${n} rate`}` would otherwise end the element early. */
function inputElements(text: string): readonly string[] {
  const elements: string[] = [];
  let index = text.indexOf('<input');
  while (index !== -1) {
    let cursor = index + '<input'.length;
    let depth = 0;
    let quote: string | null = null;
    let ticks = 0;
    while (cursor < text.length) {
      const character = text[cursor];
      if (quote !== null) {
        if (character === '\\') cursor += 1;
        else if (character === quote) quote = null;
      } else if (ticks > 0) {
        if (character === '\\') cursor += 1;
        else if (character === '`') ticks -= 1;
        else if (character === '{') depth += 1;
        else if (character === '}') depth -= 1;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '`') ticks += 1;
      else if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      else if (character === '/' && text[cursor + 1] === '>' && depth === 0) {
        elements.push(text.slice(index, cursor + 2));
        break;
      }
      cursor += 1;
    }
    index = text.indexOf('<input', cursor);
  }
  return elements;
}

const FILES = sourceFiles(WEB_SRC).filter(
  (file) => !file.endsWith(join('ui', 'numeric-input.tsx')),
);

function name(file: string): string {
  return relative(WEB_SRC, file).replaceAll('\\', '/');
}

describe('the number-only census', () => {
  it('leaves no `type="number"` anywhere in the application', () => {
    const offenders = FILES.filter((file) =>
      inputElements(readFileSync(file, 'utf8')).some((element) =>
        element.includes('type="number"'),
      ),
    ).map(name);
    expect(
      offenders,
      'A number-only field is <NumericInput>, which filters the value on the way in. `type="number"` brings spinner arrows and a scroll wheel that edits a quantity when the page scrolls under the cursor, and a `valueAsNumber` this product never uses.',
    ).toEqual([]);
  });

  it('leaves no hand-rolled decimal input outside the primitive', () => {
    /* `inputMode="numeric"` on a plain input stays legitimate and is
     * deliberately NOT counted: a GST state code, a pincode, an HSN code
     * and a two-factor code are digit STRINGS, where a leading zero and a
     * fixed length carry meaning and a numeric filter would be wrong.
     * `inputMode="decimal"` is the opposite — the decimal keypad is asked
     * for by quantities, rates, percentages and money, and every one of
     * those is a number. */
    const offenders = FILES.filter((file) =>
      inputElements(readFileSync(file, 'utf8')).some((element) =>
        element.includes('inputMode="decimal"'),
      ),
    ).map(name);
    expect(
      offenders,
      'Use <NumericInput> rather than a bare input carrying inputMode="decimal".',
    ).toEqual([]);
  });
});
