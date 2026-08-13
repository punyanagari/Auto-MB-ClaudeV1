import { useId, type ReactNode } from 'react';
import { Button } from './button.js';
import { Modal } from './dialog.js';

/* The one shape a "are you sure?" takes in this product.
 *
 * Before this component the answer was twelve shapes. A destructive action
 * either swapped its own trigger for a `Confirm` button in place — which
 * destroys the focused element and drops a keyboard operator on `<body>`,
 * with a destructive control now sitting where their focus used to be — or
 * revealed an inline panel further down the page that nothing announced,
 * nothing focused, and Escape did not close. Two editors moved focus and
 * were otherwise the same.
 *
 * A confirmation is a modal decision: it exists because the product refuses
 * to act until the operator answers, so it takes the keyboard, names itself,
 * and gives the keyboard back where it came from. `ui/dialog.tsx` carries
 * that behaviour; this component fixes the content into a title, a
 * consequence sentence, and exactly two choices.
 *
 * The safe choice is first in the DOM and therefore the one focus lands on.
 * That is deliberate: the dialog opened because something irreversible was
 * asked for, and Enter on an unread dialog must not be the destructive
 * answer. */

interface ConfirmDialogProps {
  /** What is being decided, as a noun phrase: "Discard this draft?" */
  readonly title: string;
  /** What confirming will do — the consequence, in one or two sentences. */
  readonly description: ReactNode;
  /** Anything the decision needs beyond the sentence: a failure from the
   * previous attempt, the record's own numbers, a note field. */
  readonly children?: ReactNode;
  /** The verb, not "OK": "Delete draft", "Finalize", "Cancel challan". */
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** The request is in flight: both choices are held until it answers. */
  readonly pending?: boolean;
  /** `destructive` for anything that deletes, cancels or discards.
   * `default` for a confirmation that only commits — finalising a book. */
  readonly tone?: 'destructive' | 'default';
  /** Passed through to the dialog: restore focus here rather than to
   * whatever was focused when it opened. */
  readonly restoreFocusTo?: HTMLElement | null;
}

export function ConfirmDialog({
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = 'Keep',
  onConfirm,
  onCancel,
  pending = false,
  tone = 'destructive',
  restoreFocusTo,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <Modal
      onClose={pending ? () => undefined : onCancel}
      labelledBy={titleId}
      describedBy={descriptionId}
      {...(restoreFocusTo === undefined ? {} : { restoreFocusTo })}
    >
      <h2 id={titleId} className="mt-0">
        {title}
      </h2>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        {description}
      </p>
      {children}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={pending} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          variant={tone === 'destructive' ? 'destructive' : 'default'}
          disabled={pending}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
