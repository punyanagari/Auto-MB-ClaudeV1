import type { DashboardDeadline } from '@auto-mb/contracts';
import { formatDate } from '../../format.js';
import { navigateOnClick, workHash } from '../../lib/workspace-routes.js';

/** The strip's horizon, matching `DEADLINE_HORIZON_DAYS` on the server.
 * Held here as a divisor for the lamp positions only — every date and
 * every day count on the strip is the server's. */
const HORIZON_DAYS = 90;

/** Proximity, in the product's own three lamps. Red is inside a
 * fortnight, amber inside a month, and everything else is a date on the
 * calendar rather than a thing to do this week. */
function tone(dueInDays: number): {
  readonly colour: string;
  readonly word: string;
} {
  if (dueInDays <= 14) return { colour: 'var(--destructive)', word: 'Urgent' };
  if (dueInDays <= 30) return { colour: 'var(--warning)', word: 'Due soon' };
  return { colour: 'var(--chart-5)', word: 'Ahead' };
}

const KIND_WORD: Record<DashboardDeadline['kind'], string> = {
  completion: 'Completion date',
  instrument: 'Instrument expiry',
  defect_liability: 'Defect liability ends',
};

/**
 * Ninety days of dated obligations on one line.
 *
 * DELIBERATELY NOT AN SVG. Every lamp is a link to the Work it belongs
 * to, and a focusable, middle-clickable link inside an `<svg>` is a
 * well-known way to lose keyboard order and accessible names. This is an
 * ordinary list positioned along a rail: the browser's focus order is the
 * document order, which here is soonest-first, and every lamp carries the
 * whole sentence — what expires, on which Work, on what date, in how many
 * days — as text rather than as a colour.
 *
 * The rail is a static element with no transition on it, so there is
 * nothing here for `prefers-reduced-motion` to disable.
 */
export function DeadlineStrip({
  deadlines,
  onOpenWork,
}: {
  readonly deadlines: readonly DashboardDeadline[];
  readonly onOpenWork: (workId: string) => void;
}) {
  if (deadlines.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing falls due in the next 90 days.
      </p>
    );
  }

  return (
    <div>
      <div className="relative mt-6 mb-2 h-10">
        {/* The rail. A hairline, like every other rule in the product. */}
        <div className="absolute inset-x-0 top-4 h-px bg-border" aria-hidden="true" />
        <ul className="m-0 list-none p-0">
          {deadlines.map((deadline) => {
            const { colour, word } = tone(deadline.dueInDays);
            const offset = Math.max(
              0,
              Math.min(100, (deadline.dueInDays / HORIZON_DAYS) * 100),
            );
            return (
              <li
                key={`${deadline.kind}-${deadline.workId}-${deadline.dueOn}-${deadline.label}`}
                className="absolute top-0"
                style={{ left: `${String(offset)}%` }}
              >
                <a
                  href={workHash(deadline.workId)}
                  /* A 32px hit target around an 8px lamp: the mark is
                     small because the strip is dense, and the target is
                     not. */
                  className="-ml-4 flex size-8 items-center justify-center rounded-full"
                  onClick={navigateOnClick(() => {
                    onOpenWork(deadline.workId);
                  })}
                >
                  <span
                    aria-hidden="true"
                    /* The 2px ring in the surface colour is what keeps
                       two lamps legible where their dates nearly
                       coincide and the marks overlap. */
                    className="size-2 rounded-full ring-2 ring-card"
                    style={{ backgroundColor: colour }}
                  />
                  <span className="sr-only">
                    {`${word}: ${KIND_WORD[deadline.kind]} — ${deadline.label} on ${deadline.workCode}, ${formatDate(deadline.dueOn)}, ${String(deadline.dueInDays)} days away.`}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
        <div
          className="absolute inset-x-0 top-6 flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums"
          aria-hidden="true"
        >
          <span>Today</span>
          <span>30 d</span>
          <span>60 d</span>
          <span>90 d</span>
        </div>
      </div>
      {/* The strip is a picture of when; this is the reading of what. It
          is visible rather than screen-reader-only because a lamp's
          position answers "how soon" and nothing else, and an operator
          reading the dashboard should not have to hover twelve dots to
          find out which guarantee is the red one. */}
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0 text-xs">
        {deadlines.slice(0, 6).map((deadline) => (
          <li
            key={`legend-${deadline.kind}-${deadline.workId}-${deadline.dueOn}-${deadline.label}`}
            className="flex items-center gap-1.5"
          >
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: tone(deadline.dueInDays).colour }}
            />
            <span className="font-mono tabular-nums">{deadline.workCode}</span>
            <span className="text-muted-foreground">{deadline.label}</span>
            <span className="font-mono text-muted-foreground tabular-nums">
              {formatDate(deadline.dueOn)}
            </span>
          </li>
        ))}
        {deadlines.length > 6 && (
          <li className="text-muted-foreground">
            {`and ${String(deadlines.length - 6)} more on the strip above`}
          </li>
        )}
      </ul>
    </div>
  );
}
