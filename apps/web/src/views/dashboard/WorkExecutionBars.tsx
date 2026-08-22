import type { DashboardWorkExecution } from '@auto-mb/contracts';
import { formatServerPercent } from '../../format.js';
import { navigateOnClick, workHash } from '../../lib/workspace-routes.js';

/** Days at which a completion date stops being a date and starts being a
 * problem. The same thirty the server alerts on. */
const URGENT_DAYS = 30;

/** A percentage string as a bar length, clamped. Presentation geometry;
 * the figure itself is the server's and is printed unchanged beside it. */
function width(percent: string | null): number {
  if (percent === null) return 0;
  const parsed = Number(percent);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}

function dueLabel(dueInDays: number | null): string {
  if (dueInDays === null) return 'No completion date';
  if (dueInDays < 0) return `${String(-dueInDays)} days over`;
  if (dueInDays === 0) return 'Due today';
  return `${String(dueInDays)} days left`;
}

/**
 * Supply and installation against contract value, one row per active
 * Work, nearest completion date first.
 *
 * TWO BARS, NOT A STACK. Supplied and installed are not parts of a whole
 * — a Work can be fully supplied and barely installed, and stacking them
 * would draw a total that means nothing. Paired bars on a common 0–100
 * axis let the eye read the GAP between them, which is the thing worth
 * seeing: material on site that nobody has put up yet.
 *
 * The bars are the chart ramp's first two steps in every row, because
 * colour here carries WHICH MEASURE, not which Work and not how urgent.
 * Urgency is a lamp with a word beside it and a tinted row — the product
 * never says anything in colour alone (`docs/UX.md`), and repainting a
 * bar by rank would break the one thing a legend promises.
 *
 * Rendered as one SVG per row rather than one for the table, so a row is
 * a real link the browser can focus, middle-click and open in a tab.
 */
export function WorkExecutionBars({
  rows,
  onOpenWork,
}: {
  readonly rows: readonly DashboardWorkExecution[];
  readonly onOpenWork: (workId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No active Works. Supply and installation appear here as soon as a Work is
        running.
      </p>
    );
  }

  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
      {rows.map((row) => {
        const urgent = row.dueInDays !== null && row.dueInDays <= URGENT_DAYS;
        const supplied = width(row.suppliedPercent);
        const installed = width(row.installedPercent);
        return (
          <li
            key={row.workId}
            className={`grid grid-cols-1 items-center gap-x-4 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[minmax(9rem,14rem)_1fr_auto] ${
              urgent ? 'bg-destructive/[0.04]' : ''
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              {urgent && (
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full bg-destructive"
                />
              )}
              <a
                href={workHash(row.workId)}
                className="shrink-0 font-mono text-[13px] font-semibold"
                onClick={navigateOnClick(() => {
                  onOpenWork(row.workId);
                })}
              >
                {row.workCode}
              </a>
              <span className="truncate text-xs text-muted-foreground">
                {row.title}
              </span>
            </div>
            {/* Two 6px tracks with a 2px gap between them, drawn in plain
                elements rather than in one stretched SVG. A `viewBox` of
                0–100 scaled to a fluid column stretches its own corner
                radii with it, and a 3-unit round end becomes a long
                lozenge at 640px wide — the mark stops being a bar and
                starts being a squiggle. Percentages map to widths without
                any of that, and nothing here transitions, so
                `prefers-reduced-motion` has nothing to disable. */}
            <div
              className="flex w-full min-w-32 flex-col gap-0.5"
              role="img"
              aria-label={`${row.workCode}: supplied ${formatServerPercent(row.suppliedPercent) ?? 'not measurable'}, installed ${formatServerPercent(row.installedPercent) ?? 'not measurable'} of contract value`}
            >
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${String(supplied)}%`,
                    backgroundColor: 'var(--chart-1)',
                  }}
                />
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${String(installed)}%`,
                    backgroundColor: 'var(--chart-2)',
                  }}
                />
              </div>
            </div>
            <div className="flex items-baseline gap-3 font-mono text-xs tabular-nums">
              <span title="Supplied against contract value">
                {formatServerPercent(row.suppliedPercent) ?? '—'}
              </span>
              <span
                className="text-muted-foreground"
                title="Installed against contract value"
              >
                {formatServerPercent(row.installedPercent) ?? '—'}
              </span>
              <span
                className={urgent ? 'text-destructive' : 'text-muted-foreground'}
                title="Contract completion date"
              >
                {dueLabel(row.dueInDays)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The key for the two bars. Same words as the column titles a reader
 * sees on the right of every row. */
export function WorkExecutionLegend() {
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-4 p-0 text-xs text-muted-foreground">
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-2 rounded-full"
          style={{ backgroundColor: 'var(--chart-1)' }}
        />
        Supplied
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-2 rounded-full"
          style={{ backgroundColor: 'var(--chart-2)' }}
        />
        Installed
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-destructive" />
        Completion within 30 days
      </li>
    </ul>
  );
}
