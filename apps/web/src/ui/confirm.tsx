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
  /** The decision needs something from `children` that is not there yet —
   * a required reason, typically. Holding the confirm button is the
   * honest form of that: a button that is pressable and then does nothing
   * is the failure this component exists to remove, and the field itself
   * says what is missing. The SAFE choice stays available throughout. */
  readonly confirmDisabled?: boolean;
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
  confirmDisabled = false,
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
      {/* The mock's dialog anatomy (`components/ui/dialog` at
          a8e1fde): a `gap-2` header of a 16px medium title over a muted
          description, then the footer below — bled to the surface's own
          edges and ruled off, so the decision reads as the base of the
          panel rather than as more content. */}
      <div className="flex flex-col gap-2">
        <h2 id={titleId} className="m-0 text-base leading-none font-medium">
          {title}
        </h2>
        <p id={descriptionId} className="m-0 text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
      <div className="-mx-4 -mb-4 mt-4 flex flex-col-reverse gap-2 rounded-b-xl border-t border-border bg-muted/50 p-4 sm:flex-row sm:flex-wrap sm:justify-end">
        <Button variant="outline" disabled={pending} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          variant={tone === 'destructive' ? 'destructive' : 'default'}
          disabled={pending || confirmDisabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
