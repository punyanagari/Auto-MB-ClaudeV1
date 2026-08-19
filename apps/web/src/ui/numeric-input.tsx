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
 * So the check is here, on the way in. Every keystroke, paste, drag-drop and
 * autofill lands in the browser's `input` event, which is the reason this is
 * not a `keydown` filter: `keydown` cannot see a paste.
 *
 * IT REFUSES, IT DOES NOT REPAIR. An input that is not already a number is
 * rejected whole and the field keeps the value it had. The first version of
 * this control deleted the offending characters and kept the rest, and that
 * is worse than useless on exactly the inputs it was written for: `1.2.3`
 * became `1.23`, `12e5` became `125`, and `12.345,678` became `12.345678`.
 * Each one is a plausible wrong number typed into a quantity field by the
 * control that was supposed to protect it. A refusal is visible — nothing
 * happens, and the operator looks at what they pasted.
 *
 * WHAT IT DOES NOT DO — deliberately:
 *
 *  - It does not enforce SCALE. `DecimalString` allows three decimal
 *    places, `RateString` six, money two, and percentages four; a shared
 *    control that guessed would silently truncate a legal six-decimal rate
 *    into a wrong three-decimal one. The contract schemas judge precision,
 *    on the server, exactly as they did before this component existed.
 *  - It does not enforce SIGN. A leading `-` is a numeric character and is
 *    accepted; whether a negative value is legal belongs to the field's own
 *    schema (`SignedMoneyString` exists, and so does
 *    `NonNegativeDecimalString`). A control that refused the minus would
 *    make the signed fields untypable.
 *  - It does not transliterate NON-ASCII DIGITS. Devanagari `१२` and the
 *    full-width `１２` are refused like any other non-numeric text, so the
 *    field keeps its previous value and the operator sees nothing happen.
 *    Mapping them to ASCII was the alternative and it is a decision about
 *    every numeric string in the product — which scripts, and whether a
 *    serial or a GSTIN typed the same way should follow — not one this
 *    control may take on its own. Recorded here so the gap is a decision
 *    rather than an oversight.
 *
 * Server validation is unchanged and remains the authority. This is the
 * first layer, not the only one.
 */
import type React from 'react';
import { useRef } from 'react';

interface NumericInputProps extends Omit<
  React.ComponentProps<'input'>,
  'type' | 'inputMode'
> {
  /** Whole numbers only — counts, days, months, kilometres. Also switches
   * the mobile keypad from the decimal pad to the digits pad. */
  readonly integer?: boolean;
}

/** Digits and nothing else — including none, which is what a half-typed
 * number looks like on either side of the point. */
const DIGITS = /^\d*$/;

/**
 * A number as it is typed: an optional leading minus, digits, and at most
 * ONE decimal point.
 *
 * Deliberately permissive about a half-typed number — `-`, `.` and `12.`
 * are all states a field passes through on the way to a value — and strict
 * about everything else. Split rather than matched as one pattern: the
 * combined regex is the shape `security/detect-unsafe-regex` flags, and
 * two anchored digit tests either side of a `split` are both obviously
 * linear and easier to read than the alternation that would satisfy it.
 */
function isTypedNumber(text: string): boolean {
  const body = text.startsWith('-') ? text.slice(1) : text;
  const parts = body.split('.');
  // Two points is not a number, however the rest of it reads.
  if (parts.length > 2) return false;
  return parts.every((part) => DIGITS.test(part));
}

/**
 * The accepted text, or `null` when the input is refused whole.
 *
 * Integer mode TRUNCATES at the decimal point rather than deleting it:
 * `2.5` becomes `2`, not `25`. Deleting the point on a months-or-days field
 * multiplies the value by ten and reads as a successful edit, which is the
 * worst outcome a filter can produce. `2.5.3` is not a number at all and is
 * refused rather than truncated, so the two rules cannot be played against
 * each other.
 *
 * Exported because the check is the part worth testing directly: it is a
 * pure string function, and every claim this component makes is a claim
 * about it.
 */
export function sanitiseNumericText(raw: string, integer = false): string | null {
  // Surrounding whitespace comes with almost every paste and carries no
  // meaning. Whitespace INSIDE the number does — `4 500` is a thousands
  // separator — so it is refused with everything else.
  const trimmed = raw.trim();
  if (!isTypedNumber(trimmed)) return null;
  if (!integer) return trimmed;
  const point = trimmed.indexOf('.');
  return point === -1 ? trimmed : trimmed.slice(0, point);
}

export function NumericInput({
  integer = false,
  onChange,
  ...props
}: NumericInputProps) {
  /* What to put back when an edit is refused.
   *
   * A controlled caller already holds it — `props.value` is what React last
   * rendered — but an uncontrolled one holds nothing, and this control
   * serves both. The ref is the uncontrolled half's memory; it is seeded
   * from `defaultValue` on the first render only, which is exactly the
   * value the DOM starts with. */
  const lastAccepted = useRef(String(props.defaultValue ?? ''));

  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      onChange={(event) => {
        const element = event.currentTarget;
        // An IME composes in the field itself: the intermediate text is not
        // the operator's input yet, and rewriting it mid-composition
        // rearranges what they are still typing. Let it settle; the
        // `input` event that ENDS the composition is not composing, and it
        // is checked like any other.
        if ((event.nativeEvent as InputEvent).isComposing === true) {
          onChange?.(event);
          return;
        }
        const previous =
          typeof props.value === 'string' ? props.value : lastAccepted.current;
        const cleaned = sanitiseNumericText(element.value, integer);
        if (cleaned === null) {
          // Refused: the field goes back to what it held, and the caller is
          // never told — as far as the form is concerned nothing was typed.
          setValueAndCaret(element, previous);
          return;
        }
        if (cleaned !== element.value) setValueAndCaret(element, cleaned);
        lastAccepted.current = cleaned;
        // Controlled callers read `event.currentTarget.value` and get the
        // accepted text; uncontrolled ones read the DOM at submit time and
        // get the same. One rewrite serves both.
        onChange?.(event);
      }}
      {...props}
    />
  );
}

/** Put `next` in the field and leave the caret where the operator left it.
 * The caret sits after whatever was just typed or pasted, so dropping
 * characters ahead of it has to move it back by as many — otherwise a
 * refused keystroke throws the cursor to the end of the field mid-number. */
function setValueAndCaret(element: HTMLInputElement, next: string): void {
  const caret = element.selectionStart ?? next.length;
  const removed = element.value.length - next.length;
  element.value = next;
  const at = Math.max(0, Math.min(next.length, caret - removed));
  element.setSelectionRange(at, at);
}
