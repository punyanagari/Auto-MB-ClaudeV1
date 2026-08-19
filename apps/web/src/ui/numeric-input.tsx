/**
 * The one number-only text input.
 *
 * Before this, every numeric field in the application was one of two
 * hand-rolled shapes: `<input type="number">`, which brings spinner arrows,
 * a scroll wheel that silently changes a quantity when the page scrolls
 * under the cursor, and a `valueAsNumber` the product never uses because
 * money and quantities travel as exact decimal STRINGS; or `<input
 * type="text" inputMode="decimal">`, which asks the phone for the right
 * keypad and then accepts anything at all from a desk keyboard. Both let a
 * pasted `1,250` or a stray `e` reach a form that submits it, and the
 * refusal arrived from the server after the operator had moved on.
 *
 * So the filtering is here, on the way in. Every keystroke, paste, drag-drop
 * and autofill lands in the browser's `input` event; the value is rewritten
 * in place before React or the caller sees it, which is why a non-numeric
 * character never appears on screen rather than appearing and vanishing.
 * One handler covers all four entry paths, which is the reason it is not a
 * `keydown` filter: `keydown` cannot see a paste.
 *
 * WHAT IT DOES NOT DO — deliberately:
 *
 *  - It does not enforce SCALE. `DecimalString` allows three decimal
 *    places, `RateString` six, money two, and percentages four; a shared
 *    control that guessed would silently truncate a legal six-decimal rate
 *    into a wrong three-decimal one, which is worse than the refusal it
 *    replaced. The contract schemas judge precision, on the server, exactly
 *    as they did before this component existed.
 *  - It does not enforce SIGN. A leading `-` is a numeric character and is
 *    accepted; whether a negative value is legal belongs to the field's own
 *    schema (`SignedMoneyString` exists, and so does
 *    `NonNegativeDecimalString`). A control that refused the minus would
 *    make the signed fields untypable.
 *
 * Server validation is unchanged and remains the authority. This is the
 * first layer, not the only one.
 */
import type React from 'react';

interface NumericInputProps extends Omit<
  React.ComponentProps<'input'>,
  'type' | 'inputMode'
> {
  /** Whole numbers only — counts, days, months, kilometres. Also switches
   * the mobile keypad from the decimal pad to the digits pad. */
  readonly integer?: boolean;
}

/**
 * Keep the digits, an optional single leading minus, and — unless the field
 * is an integer one — the first decimal point. Everything else goes.
 *
 * Exported because the filter is the part worth testing directly: it is a
 * pure string function, and every claim this component makes is a claim
 * about it.
 */
export function sanitiseNumericText(raw: string, integer = false): string {
  const negative = raw.startsWith('-');
  let seenPoint = false;
  let digits = '';
  for (const character of raw) {
    if (character >= '0' && character <= '9') {
      digits += character;
      continue;
    }
    if (character === '.' && !integer && !seenPoint) {
      seenPoint = true;
      digits += character;
    }
  }
  return negative ? `-${digits}` : digits;
}

export function NumericInput({
  integer = false,
  onChange,
  ...props
}: NumericInputProps) {
  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      onChange={(event) => {
        const element = event.currentTarget;
        const cleaned = sanitiseNumericText(element.value, integer);
        if (cleaned !== element.value) {
          // The caret sits after whatever was just typed or pasted;
          // removing characters ahead of it has to move it back by as many,
          // or a rejected keystroke throws the cursor to the end of the
          // field mid-number.
          const caret = element.selectionStart ?? cleaned.length;
          const removed = element.value.length - cleaned.length;
          element.value = cleaned;
          const at = Math.max(0, Math.min(cleaned.length, caret - removed));
          element.setSelectionRange(at, at);
        }
        // Controlled callers read `event.currentTarget.value` and get the
        // cleaned text; uncontrolled ones read the DOM at submit time and
        // get the same. One rewrite serves both.
        onChange?.(event);
      }}
      {...props}
    />
  );
}
