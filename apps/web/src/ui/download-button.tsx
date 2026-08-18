import { useState } from 'react';
import { Download } from 'lucide-react';
import { errorMessage } from '../lib/load-failure.js';
import { downloadFile } from '../lib/download.js';
import { Button } from './button.js';

/**
 * "Export this register as .xlsx", as one control.
 *
 * SELF-CONTAINED on purpose. Every register in this product already
 * carries a pending flag and an error line of its own, and threading a
 * seventh state through six screens to say the same thing six times is how
 * a shared capability stops being shared. The button owns its own pending
 * state and renders its own refusal beside itself, so adding an export to
 * a register is one line in that register's header.
 *
 * The refusal matters and is why this does not swallow the failure: a
 * work-scoped register narrows for an assigned-scope member, but an
 * organisation-wide one refuses them outright, and a button that silently
 * did nothing would look like a broken control rather than a wall. The
 * server's own sentence is what appears.
 *
 * `note` is the other honesty this control owes. A register export is the
 * WHOLE register under the caller's scope — the screen's filters do NOT
 * travel — so a register that is currently filtered says so beside its own
 * button rather than handing back a file the operator will assume matches
 * what they were looking at. `docs/UX.md` § 19 records the posture and
 * `apps/server/src/routes/mis.ts` states it over the statements.
 *
 * `role="alert"` and the inline placement follow `docs/UX.md` § Shared
 * states: a failed action states itself and stays until it is fixed, where
 * a success would toast.
 */
export function DownloadButton({
  label,
  filename,
  fetchBlob,
  note,
  className,
}: {
  /** The control's text. Registers say "Export .xlsx"; a differently
   * shaped export (the Tally envelope) says what it is. */
  readonly label: string;
  /** What the saved file is called on the operator's machine. */
  readonly filename: string;
  readonly fetchBlob: () => Promise<Blob>;
  /** A standing caveat about what the file will contain, shown under the
   * control. Registers pass it while a filter is active. */
  readonly note?: string;
  readonly className?: string;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <span className={className}>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setFailure(null);
          downloadFile(fetchBlob, filename)
            .catch((cause: unknown) => {
              setFailure(errorMessage(cause, 'The export could not be produced.'));
            })
            .finally(() => {
              setPending(false);
            });
        }}
      >
        <Download aria-hidden="true" className="size-4" />
        {label}
      </Button>
      {note !== undefined && failure === null && (
        <p className="m-0 mt-1 text-xs text-muted-foreground">{note}</p>
      )}
      {failure !== null && (
        <p role="alert" className="m-0 mt-1 text-sm font-medium text-destructive">
          {failure}
        </p>
      )}
    </span>
  );
}
