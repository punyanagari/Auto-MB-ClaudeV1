import type { DashboardSignals } from '@auto-mb/contracts';
import { workspaceHashOf } from '../../lib/workspace-routes.js';

const SIGNING_HASH = workspaceHashOf({ view: { name: 'signing' } });

/** Scrolls a panel already on this screen into view. Instant, never
 * smooth: an instant jump has no animation for `prefers-reduced-motion`
 * to disable, which is the cheapest way to honour it. */
function reveal(target: HTMLElement | null): void {
  target?.scrollIntoView({ block: 'start', behavior: 'auto' });
  target?.focus?.();
}

interface Lamp {
  readonly key: string;
  readonly tone: 'danger' | 'warning';
  readonly text: string;
  /** Where the answer lives. Two of the three are panels further down
   * this same screen; the third is a register of its own. */
  readonly go: (() => void) | { readonly hash: string };
}

/**
 * One line of red and amber lamps, and nothing else.
 *
 * This replaced a seven-row alert list (owner decision 2026-08-22,
 * `docs/UX.md` § 39). The list said more, and what it said was already
 * said better one click away — the receivables register carries every
 * bill's settlement position, the invoice register carries the IRP
 * window, the challan register carries open drafts. What no register
 * carried was a single line an operator could read in a second and know
 * whether anything was on fire.
 *
 * NEVER COLOUR ALONE. Each lamp is a dot, a count and a sentence, and
 * the sentence is what carries the meaning; the colour only decides
 * which one is read first.
 */
export function AttentionStrip({
  signals,
  completionsRef,
  deadlinesRef,
}: {
  readonly signals: DashboardSignals;
  readonly completionsRef: React.RefObject<HTMLElement | null>;
  readonly deadlinesRef: React.RefObject<HTMLElement | null>;
}) {
  const lamps: Lamp[] = [];
  /* THE PAST AND THE FUTURE GET DIFFERENT SENTENCES.
   *
   * One lamp counted a Work eleven days past its completion date beside
   * one reaching it in nine, and reported both with the milder reading —
   * "reaches its completion date within 30 days" — which is false of the
   * first and is the one an operator most needs to see. Same for a
   * guarantee: "expires within 60 days" said of one that expired last
   * month is a countdown that has already run out. */
  if (signals.completionsOverdue > 0) {
    lamps.push({
      key: 'completions-overdue',
      tone: 'danger',
      text:
        signals.completionsOverdue === 1
          ? '1 Work is at or past its completion date'
          : `${String(signals.completionsOverdue)} Works are at or past their completion dates`,
      go: () => {
        reveal(completionsRef.current);
      },
    });
  }
  if (signals.completionsDue > 0) {
    lamps.push({
      key: 'completions-due',
      tone: 'danger',
      text:
        signals.completionsDue === 1
          ? '1 Work reaches its completion date within 30 days'
          : `${String(signals.completionsDue)} Works reach their completion dates within 30 days`,
      go: () => {
        reveal(completionsRef.current);
      },
    });
  }
  if (signals.instrumentsExpired > 0) {
    lamps.push({
      key: 'instruments-expired',
      tone: 'danger',
      text:
        signals.instrumentsExpired === 1
          ? '1 guarantee or certificate has already expired'
          : `${String(signals.instrumentsExpired)} guarantees or certificates have already expired`,
      // The ninety-day strip is forward-only and cannot draw a lapsed
      // instrument at all, so its panel carries a named list of them
      // beneath the rail and this is what sends a reader to it.
      go: () => {
        reveal(deadlinesRef.current);
      },
    });
  }
  if (signals.instrumentsExpiring > 0) {
    lamps.push({
      key: 'instruments',
      tone: 'warning',
      text:
        signals.instrumentsExpiring === 1
          ? '1 guarantee or certificate expires within 60 days'
          : `${String(signals.instrumentsExpiring)} guarantees or certificates expire within 60 days`,
      go: () => {
        reveal(deadlinesRef.current);
      },
    });
  }
  if (signals.unsignedDocuments > 0) {
    lamps.push({
      key: 'signing',
      tone: 'warning',
      text:
        signals.unsignedDocuments === 1
          ? '1 issued document is waiting to be signed'
          : `${String(signals.unsignedDocuments)} issued documents are waiting to be signed`,
      go: { hash: SIGNING_HASH },
    });
  }

  if (lamps.length === 0) {
    return (
      <p className="m-0 text-sm text-muted-foreground" role="status">
        Nothing needs attention: no completion date, guarantee or signature falls due
        soon.
      </p>
    );
  }

  return (
    <ul
      aria-label="Needs attention"
      className="m-0 flex list-none flex-wrap items-center gap-x-6 gap-y-2 p-0 text-sm"
    >
      {lamps.map((lamp) => {
        const dot = (
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${
              lamp.tone === 'danger' ? 'bg-destructive' : 'bg-warning'
            }`}
          />
        );
        return (
          <li key={lamp.key} className="flex items-center gap-2">
            {typeof lamp.go === 'function' ? (
              <button
                type="button"
                className="flex items-center gap-2 text-left underline-offset-4 hover:underline"
                onClick={lamp.go}
              >
                {dot}
                {lamp.text}
              </button>
            ) : (
              <a
                href={lamp.go.hash}
                className="flex items-center gap-2 text-left no-underline hover:underline"
              >
                {dot}
                {lamp.text}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
