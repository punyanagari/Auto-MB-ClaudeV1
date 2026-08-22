import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { Button } from './button.js';

/* A letter's item list is the longest thing this product renders. The
 * owner's own LOA carries 24 items across two schedules with five- and
 * six-line descriptions; the largest work in the corpus carries 129. Laid
 * out flat, the review page is several screens of table before the
 * confirm button, and the reader has no way to see the shape of the award
 * — how many schedules, how many items, worth how much — without scrolling
 * through all of it.
 *
 * So a schedule is a section that can be shut: a summary row that answers
 * "what is in here" without opening it, all but the first closed on
 * arrival, and one control that opens or shuts every one. The summary row
 * stays put while its own items scroll past, so the schedule you are
 * reading is always named on screen. */

export interface ScheduleAccordion {
  readonly isExpanded: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  readonly expandAll: () => void;
  readonly collapseAll: () => void;
  readonly allExpanded: boolean;
  readonly noneExpanded: boolean;
}

/** Expansion state for one page's schedules: the first open, the rest
 * shut, until the reader says otherwise.
 *
 * The state carries the id list it was decided for, so a different Work
 * or a different letter starts from the default again instead of
 * inheriting the previous page's open sections — without an effect, which
 * would render the wrong sections once before correcting itself. */
export function useScheduleAccordion(ids: readonly string[]): ScheduleAccordion {
  const signature = ids.join('\u0000');
  const [state, setState] = useState<{
    readonly signature: string;
    readonly expanded: ReadonlySet<string>;
  } | null>(null);
  const first = ids[0];
  const expanded =
    state !== null && state.signature === signature
      ? state.expanded
      : new Set(first === undefined ? [] : [first]);

  const replace = (next: ReadonlySet<string>) => {
    setState({ signature, expanded: next });
  };

  return {
    isExpanded: (id) => expanded.has(id),
    toggle: (id) => {
      const next = new Set(expanded);
      if (!next.delete(id)) next.add(id);
      replace(next);
    },
    expandAll: () => {
      replace(new Set(ids));
    },
    collapseAll: () => {
      replace(new Set());
    },
    allExpanded: ids.length > 0 && ids.every((id) => expanded.has(id)),
    noneExpanded: ids.every((id) => !expanded.has(id)),
  };
}

/** Expand all / collapse all, beside a plain count of what is on the
 * page. Both verbs are always present: a single toggling control would
 * make the reader work out which half of a half-open page it applies to. */
export function ScheduleAccordionControls({
  accordion,
  scheduleCount,
  itemCount,
}: {
  readonly accordion: ScheduleAccordion;
  readonly scheduleCount: number;
  readonly itemCount: number;
}) {
  return (
    <div className="my-3 flex flex-wrap items-center gap-3">
      <p className="text-sm text-muted-foreground">
        {scheduleCount} schedule{scheduleCount === 1 ? '' : 's'} ·{' '}
        <span className="tnum">{itemCount}</span> item
        {itemCount === 1 ? '' : 's'}
      </p>
      <span className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={accordion.allExpanded}
          onClick={accordion.expandAll}
        >
          Expand all
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={accordion.noneExpanded}
          onClick={accordion.collapseAll}
        >
          Collapse all
        </Button>
      </span>
    </div>
  );
}

/** One schedule: a summary row that stays on screen, and its items. */
export function ScheduleSection({
  code,
  heading,
  title,
  itemCount,
  total,
  expanded,
  onToggle,
  headingLevel,
  children,
}: {
  readonly code?: string;
  /** The whole summary label, for a section that is not a schedule.
   * The inspection clause tab splits one Work's items into two of these
   * sections — the ones whose description names an agency and the rest —
   * and "Schedule Matched items" would be a lie about what they are.
   * Style, stickiness and keyboard behaviour are unchanged; only the
   * words differ. */
  readonly heading?: string;
  /** The schedule's own heading, when the source has one. The parsed
   * letter binds items to a schedule id and nothing else, so the review
   * screen has none and the code carries the row alone. */
  readonly title?: string;
  readonly itemCount: number;
  /** Already formatted — the caller owns the exact-decimal arithmetic.
   * Null while a row is half-typed and no honest total exists, which
   * prints an em-dash: the schedule HAS a value and it cannot be stated
   * yet. Omitted entirely on a section that is not about money at all —
   * a category assignment, a certified-quantity form — where a permanent
   * em-dash would be a column of nothing pretending to be a figure. */
  readonly total?: string | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** Which heading this summary row is, in the document that holds it.
   * Level 2 is the default because the pattern was built for a screen
   * whose schedules ARE its top-level sections. Where the schedules sit
   * inside a section that already has a heading — the certified-quantity
   * form under "PAC certificates" — they are that heading's children, and
   * saying so keeps the outline honest for anyone reading the page by its
   * headings. Style is unchanged; only the element differs. */
  readonly headingLevel?: 2 | 3;
  readonly children: React.ReactNode;
}) {
  const panelId = useId();
  const headingId = useId();
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section aria-labelledby={headingId} className="my-4">
      {/* Sticky on the page's own scrollport, offset by the shell header
       * that shares it, and opaque in both themes so the rows scrolling
       * under it cannot be read through it. */}
      <Heading
        id={headingId}
        className="sticky top-[var(--header-h)] z-2 my-0 rounded-lg border border-border bg-table-header text-base"
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 text-muted-foreground motion-safe:transition-transform',
              expanded && 'rotate-90',
            )}
          />
          <span className="font-mono text-sm font-semibold">
            {heading ?? `Schedule ${code ?? ''}`}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-normal text-muted-foreground">
            {title ?? ''}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tnum">
            {itemCount} item{itemCount === 1 ? '' : 's'}
          </span>
          {total !== undefined && (
            <span className="shrink-0 font-mono text-[13px] font-semibold tnum">
              {total ?? '—'}
            </span>
          )}
        </button>
      </Heading>
      {/* Unmounted rather than hidden: a closed schedule's rows must not
       * be reachable by Tab, and on the review screen they hold the
       * editable cells the confirm request is built from — which are read
       * from React state, never from the DOM, so nothing is lost.
       *
       * The panel raises `--sticky-inset` for everything inside it: two
       * things are already parked at the top of this screen — the shell
       * header and the summary row above — so a ledger that owns its own
       * scrollport has to start below both of them. */}
      {expanded && (
        <div
          id={panelId}
          style={
            {
              '--sticky-inset': 'calc(var(--header-h) + var(--schedule-summary-h))',
            } as React.CSSProperties
          }
        >
          {children}
        </div>
      )}
    </section>
  );
}

/** Prose long enough that two lines cannot hold it — the letter item
 * descriptions, which run to five or six lines each and turn a
 * twenty-four row table into a page of paragraphs.
 *
 * The truncation is display only: the string is rendered whole and the
 * browser clamps it, so a copy takes the full text and nothing is ever
 * shortened on its way into a request.
 *
 * The toggle appears only for text that two lines plausibly cannot hold.
 * Measuring the rendered box would be exact, but it is also a layout read
 * on every row of a 129-row table, and it answers differently before and
 * after fonts load; a length rule is deterministic, and the failure it
 * risks — offering "Show more" for a description that was fully visible —
 * costs a reader one click, not the text. */
export function ClampedText({
  text,
  label,
}: {
  readonly text: string;
  /** Names what is being expanded, for readers who arrive on the button
   * without its cell for context. */
  readonly label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  /* The toggle says aria-expanded, so it has to say what it expands: the
   * span below is the thing whose clamp comes off. */
  const textId = useId();
  const clampable = text.length > 90 || text.includes('\n');
  return (
    <>
      <span
        id={textId}
        className={cn(
          'block whitespace-pre-line',
          !expanded && clampable && 'line-clamp-2',
        )}
      >
        {text}
      </span>
      {clampable && (
        <Button
          variant="link"
          size="inline"
          className="mt-1 text-xs"
          aria-expanded={expanded}
          aria-controls={textId}
          aria-label={
            expanded ? `Show less of ${label}` : `Show the full description of ${label}`
          }
          onClick={() => {
            setExpanded((current) => !current);
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </>
  );
}
