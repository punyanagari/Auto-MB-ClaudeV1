import { useId } from 'react';
import { Field, Hint } from './form.js';

interface DateFieldProps extends Omit<React.ComponentProps<'input'>, 'type' | 'id'> {
  /** Required: a date control with no label is unusable by anyone who
   * cannot see where it sits on the page. */
  readonly id: string;
  readonly label: React.ReactNode;
  /** Said after the date format, when the date carries a rule of its own
   * ("Invoices dated on or before this keep accepting 18%"). */
  readonly hint?: React.ReactNode;
  readonly fieldClassName?: string;
}

/**
 * A labelled date input that says which way round the digits go.
 *
 * `<input type="date">` renders in the BROWSER's locale, not the
 * document's: the same field reads `DD/MM/YYYY` on an en-IN profile and
 * `MM/DD/YYYY` on the en-US default that ships on most machines here. Every
 * date this product prints — challans, invoices, measurement books — is
 * `DD/MM/YYYY`, so a clerk typing `03/04` into an unlabelled control has no
 * way to know whether the record now says 3 April or 4 March, and the two
 * are both plausible dates that no validation can tell apart.
 *
 * The hint states the form the value is stored and printed in. It does not
 * change the control's behaviour; that is the browser's, and this deliberately
 * does not fight it with a text input and a parser, which would trade one
 * ambiguity for a worse one.
 *
 * Dates stay date-only `YYYY-MM-DD` strings on the wire (AGENTS.md rule 6);
 * this wrapper never converts anything.
 */
export function DateField({
  id,
  label,
  hint,
  fieldClassName,
  'aria-describedby': describedBy,
  ...input
}: DateFieldProps) {
  const generated = useId();
  const hintId = `${id}-format-${generated}`;
  return (
    <Field {...(fieldClassName === undefined ? {} : { className: fieldClassName })}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="date"
        aria-describedby={
          describedBy === undefined ? hintId : `${hintId} ${String(describedBy)}`
        }
        {...input}
      />
      <Hint id={hintId}>DD/MM/YYYY.{hint === undefined ? null : <> {hint}</>}</Hint>
    </Field>
  );
}
