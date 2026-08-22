import type { DashboardCompletion } from '@auto-mb/contracts';
import { formatDate, formatServerPercent } from '../../format.js';
import { navigateOnClick, workHash } from '../../lib/workspace-routes.js';
import { Button } from '../../ui/button.js';

/** Inside thirty days a completion date is a red lamp; the thirty behind
 * it are amber. The server alerts at the same thirty. */
const URGENT_DAYS = 30;

function daysLabel(dueInDays: number): string {
  if (dueInDays < 0) return `${String(-dueInDays)} days over`;
  if (dueInDays === 0) return 'Due today';
  return `${String(dueInDays)} days left`;
}

/**
 * Every active Work reaching its completion date inside sixty days, and
 * the one act that answers it.
 *
 * WHY THIS IS A PANEL AND NOT A ROW OF THE ALERT LIST. A completion date
 * is the only deadline on this screen whose remedy is a document this
 * product writes: the DOC extension letter. Everything else on the
 * dashboard says "go and look"; this says "here is the Work, here is how
 * far it has been billed, and here is the letter".
 *
 * The action opens the extension composer where it lives — on the Work's
 * own Overview, beneath the two date tiles that state the completion date
 * being extended FROM. It carries no proposed date and no grounds: the
 * proposal is a date the operator negotiates and the grounds are the
 * whole substance of the letter, and pre-filling either would be this
 * screen guessing at a contract argument it cannot see.
 */
export function CompletionPanel({
  completions,
  onOpenWork,
  onRequestExtension,
}: {
  readonly completions: readonly DashboardCompletion[];
  readonly onOpenWork: (workId: string) => void;
  /** Opens the Work at its extension composer — the same destination as
   * `onOpenWork`, carrying the address's `?focus=extension` intent. */
  readonly onRequestExtension: (workId: string) => void;
}) {
  if (completions.length === 0) {
    return (
      <p className="px-5 py-6 text-sm text-muted-foreground">
        No active Work reaches its completion date in the next 60 days.
      </p>
    );
  }

  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
      {completions.map((row) => {
        const urgent = row.dueInDays <= URGENT_DAYS;
        return (
          <li key={row.workId} className="flex flex-col gap-2 px-5 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${
                  urgent ? 'bg-destructive' : 'bg-warning'
                }`}
              />
              <a
                href={workHash(row.workId)}
                className="font-mono text-[13px] font-semibold"
                onClick={navigateOnClick(() => {
                  onOpenWork(row.workId);
                })}
              >
                {row.workCode}
              </a>
              <span
                className={`font-mono text-xs tabular-nums ${
                  urgent ? 'text-destructive' : 'text-warning-foreground'
                }`}
              >
                {daysLabel(row.dueInDays)}
              </span>
            </div>
            <p className="m-0 truncate text-xs text-muted-foreground">{row.title}</p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {`${formatDate(row.dueOn)} · ${formatServerPercent(row.executedPercent) ?? '—'} executed`}
              </span>
              {/* Navigates to the composer's own address — the Work's
                  Overview carrying `?focus=extension` — so the operator
                  lands on the proposed-date field rather than at the top
                  of a long page. The work code above is the plain link
                  for opening the Work in a tab. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onRequestExtension(row.workId);
                }}
              >
                Request extension
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
