import { useId, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './button.js';

/** An action and the form it opens, in that order.
 *
 * Every create-and-record form on a detail page used to stand permanently
 * open beneath the records it adds to. On the Work's Instruments tab that
 * meant four expanded forms interleaved with four tables, and a reader had
 * no way to tell which parts of the page were the Work's record and which
 * were controls waiting for them. The form is now behind the verb that
 * names it: the page reads as what is true, and asks a question only when
 * the operator asks first.
 *
 * `startOpen` is for the empty state. A section with nothing in it yet has
 * no record to read, so its form is the only thing worth showing and it
 * opens on arrival — the disclosure hides a form from someone reading, not
 * from someone with nothing to read.
 *
 * LABELLING RULE: the opener and the form's submit button must never carry
 * the same words. The opener names what will exist ("New quotation", "New
 * instrument") or states that it opens a panel ("Cancel challan…"); the
 * submit keeps the committing verb ("Create quotation", "Cancel challan").
 * When both said the same thing, an already-open panel made the header look
 * inert — the operator pressed what they read as the action and the form
 * merely collapsed. */
export function Disclosure({
  label,
  children,
  startOpen = false,
  variant = 'outline',
  className,
  disabled,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly startOpen?: boolean;
  readonly variant?: 'default' | 'outline';
  readonly className?: string;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const panelId = useId();
  return (
    <div className={cn('my-3 flex flex-col items-start gap-3', className)}>
      <Button
        variant={variant}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {label}
        <span aria-hidden="true" className="text-xs">
          {open ? '▲' : '▼'}
        </span>
      </Button>
      {/* Unmounted rather than hidden: these panels hold uncontrolled form
       * fields, and a closed form that keeps half-typed values would offer
       * them back on the next open as though they had been saved. */}
      {open && (
        <div id={panelId} className="w-full">
          {children}
        </div>
      )}
    </div>
  );
}
