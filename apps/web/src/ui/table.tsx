import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '../lib/cn.js';

/* The corner cells clip the card themselves rather than the table carrying
 * overflow: hidden. Overflow would make the table its own scrollport, and a
 * sticky heading inside a scrollport that never scrolls never moves. The
 * radius is inset by the table's 1px border so the curves sit flush. The
 * last row group is tbody, or tfoot on the tables that carry a total. */
const CORNERS = [
  '[&>thead>tr:first-child>th:first-child]:rounded-tl-[calc(var(--radius-xl)-1px)]',
  '[&>thead>tr:first-child>th:last-child]:rounded-tr-[calc(var(--radius-xl)-1px)]',
  '[&>:last-child>tr:last-child>:first-child]:rounded-bl-[calc(var(--radius-xl)-1px)]',
  '[&>:last-child>tr:last-child>:last-child]:rounded-br-[calc(var(--radius-xl)-1px)]',
].join(' ');

/* The largest work in the corpus carries 129 items, so the headings have to
 * survive the scroll — otherwise Awarded, Delivered, Remaining and This
 * challan are four unlabelled numeric columns by the time you reach row 60.
 * The background is the table-header token — opaque in both themes so
 * scrolled rows cannot read through it — and border-separate keeps the
 * bottom rule on the cell where it travels with the heading.
 *
 * `top: 0` is measured against the ledger's own scrollport (below), not
 * the viewport. That is what stops the heading parking behind the shell
 * header: the scrollport is capped to the space beneath the header, so the
 * top of it is somewhere the header does not reach. */
const HEAD = [
  '[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-1',
  '[&_thead_th]:bg-table-header',
  '[&_thead_th]:border-b [&_thead_th]:border-border',
  /* The mock's `[data-slot="table-head"]`: a 40px row of 11px semibold
   * uppercase muted text, cells padded 2 (8px). */
  '[&_thead_th]:h-10 [&_thead_th]:px-2 [&_thead_th]:py-0 [&_thead_th]:text-left',
  '[&_thead_th]:align-middle [&_thead_th]:whitespace-nowrap',
  '[&_thead_th]:text-[11px] [&_thead_th]:font-semibold [&_thead_th]:tracking-wide',
  '[&_thead_th]:text-muted-foreground [&_thead_th]:uppercase',
].join(' ');

/* The mock's `TableCell`: `p-2 align-middle whitespace-nowrap`. A register
 * row is one line of facts, so nothing wraps by default and the columns
 * stay in step down the page; the prose cells that genuinely need two
 * lines say so with `wrapCell`, which is every one of them in this tree.
 *
 * These defaults compile to descendant selectors (`.tbl td`, 0-1-1), so a
 * bare utility on the cell itself (0-1-0) loses to them — `wrapCell`'s
 * `whitespace-normal` never took effect, and with `overflow-wrap:anywhere`
 * still shrinking the column's min-content the unwrappable text painted
 * straight across its neighbours. Every default a cell may override
 * therefore exempts its opt-out class via zero-specificity `:where()`, and
 * any other per-cell override must carry `!` (as `numericCell` does).
 *
 * Hover is the mock's `[data-slot="table-row"]` — `bg-accent/35`, a faint
 * teal wash rather than the old neutral one. */
const CELLS = [
  '[&_td]:border-b [&_td]:border-border [&_td]:p-2',
  '[&_td]:text-left [&_td:not(:where(.align-top))]:align-middle [&_td]:font-normal',
  '[&_td:not(:where(.whitespace-normal))]:whitespace-nowrap',
  '[&_tbody_th]:border-b [&_tbody_th]:border-border [&_tbody_th]:p-2',
  '[&_tbody_th]:text-left [&_tbody_th:not(:where(.align-top))]:align-middle [&_tbody_th]:font-medium',
  '[&_tfoot_th]:border-b [&_tfoot_th]:border-border [&_tfoot_th]:p-2',
  '[&_tfoot_th]:text-left [&_tfoot_th]:align-middle [&_tfoot_th]:font-medium',
  '[&>:last-child>tr:last-child>td]:border-b-0',
  '[&>:last-child>tr:last-child>th]:border-b-0',
  /* A row holding a wrapped prose cell is several lines tall, and a
   * middle-aligned quantity beside a six-line description floats away
   * from the line it belongs to. Such a row aligns to the top
   * throughout; single-line rows — where a 24px status chip or a 32px
   * button sets the height — keep the mock's centring. */
  '[&_tbody_tr:has(.whitespace-normal)>td]:align-top',
  '[&_tbody_tr:has(.whitespace-normal)>th]:align-top',
  '[&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-accent/35',
].join(' ');

/* The ledger's own scrollport.
 *
 * Two failures are closed by one box. Sideways: a ledger has as many
 * columns as the paper it models, and on any screen narrower than a desk
 * the widest of them do not fit; with nowhere of its own to scroll, the
 * table grows past the card and takes the whole page's width with it, so
 * the operator drags the shell — rail, header and all — sideways to read a
 * quantity. Downwards: a heading that sticks to the *page* sticks at the
 * top of the viewport, which is where the 4.5rem shell header already is,
 * so it is hidden for exactly the rows it exists to label.
 *
 * The two cannot both be solved on the page's scrollport, and that is a
 * browser fact rather than a preference: `overflow-x: auto` makes the
 * wrapper a scroll container whatever the other axis says (`overflow-y:
 * clip` computes to `hidden`, not to `visible`), and a heading inside a
 * scroll container sticks to that container — which never scrolls
 * vertically, so it never moves. Measured in Chromium: the heading of a
 * wrapped table scrolls away with its rows.
 *
 * So the wrapper scrolls in both directions and is capped to the height
 * left below the shell header. A ledger shorter than that is untouched —
 * `max-height` only bites when it must — and one longer than it becomes an
 * instrument that scrolls under its own pinned heading. `--sticky-inset`
 * is the space to reserve above the box: the header alone by default, and
 * the header plus a schedule's summary row inside a schedule section
 * (`ui/schedule-section.tsx`), which sets the variable on its panel. */
const SCROLLPORT = [
  'scrollbar-thin overflow-auto',
  'max-h-[calc(100dvh-var(--sticky-inset)-2rem)]',
  // Paper has no scrollport; a printed ledger runs to as many pages as it
  // needs.
  'print:max-h-none print:overflow-visible',
].join(' ');

/** The registry table: a bordered card with a quiet uppercase heading that
 * survives the scroll, hairline row rules, and hover.
 *
 * `scroll` is on by default — see SCROLLPORT above for what the wrapper
 * buys and why it is not optional for a register. A scroll container is
 * also a thing only a pointer can move unless it is told otherwise, so the
 * wrapper is focusable and announced as a region named by the table's own
 * caption: the keyboard reaches the columns a mouse can drag to.
 * `scroll={false}` is for a table that is deliberately not its own
 * scrollport — a short summary block inside a panel that already scrolls. */
export function DataTable({
  className,
  scroll = true,
  children,
  ...props
}: React.ComponentProps<'table'> & { readonly scroll?: boolean }) {
  const generatedCaptionId = useId();
  const scrollportRef = useRef<HTMLDivElement>(null);
  /* Focusable only while there is something to scroll.
   *
   * A scroll container needs a tab stop, because a keyboard has no other
   * way to move it. A box whose content fits does not: it is an inert stop
   * on the way to the next control, and the product puts up to a dozen
   * registers on one screen. Every register carried one unconditionally,
   * so a Work workspace could cost a dozen keystrokes that did nothing.
   *
   * Measured rather than guessed, because whether a ledger overflows
   * depends on the viewport, the zoom, the font, and how many rows the
   * Work has: a ResizeObserver on the box and on the table inside it
   * re-asks after any of those change. */
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const node = scrollportRef.current;
    if (node === null) return;
    const measure = (): void => {
      setScrollable(
        node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const table = node.firstElementChild;
    if (table !== null) observer.observe(table);
    return () => {
      observer.disconnect();
    };
    // Mount only: the observer watches both boxes, so a viewport change, a
    // font change and a row arriving all re-measure without React
    // re-subscribing on every keystroke of a 129-row editor.
  }, []);
  /* Every DataTable in the product carries an `sr-only` caption naming the
   * register. That caption is the honest name for the scroll region too,
   * so it is borrowed rather than duplicated into a second string that
   * would drift from it. A caption that already carries an id keeps it. */
  let captionId: string | undefined;
  const labelled = Children.map(children, (child) => {
    if (!isValidElement(child) || child.type !== 'caption') return child;
    const element = child as React.ReactElement<{ readonly id?: string }>;
    captionId = element.props.id ?? generatedCaptionId;
    return element.props.id === undefined
      ? cloneElement(element, { id: generatedCaptionId })
      : element;
  });

  const table = (
    <table
      className={cn(
        /* The mock's `.data-surface`: an overflow-clipped `rounded-xl`
         * bordered card over `--card` with one 1px shadow. Here the
         * corner cells do the clipping (see CORNERS above) because the
         * table cannot own `overflow-hidden` and keep a sticky heading. */
        'my-3 w-full border-separate border-spacing-0 rounded-xl border border-border bg-card text-sm',
        'shadow-[0_1px_2px_0_rgb(15_23_42/0.03)]',
        CORNERS,
        HEAD,
        CELLS,
        className,
      )}
      {...props}
    >
      {labelled}
    </table>
  );
  if (!scroll) return table;
  /* Named and reachable, or neither. A tab stop with no accessible name is
   * a stop a screen-reader user cannot identify, so the region semantics
   * and the tab stop are granted together — and `apps/web/test/
   * a11y-invariants.test.ts` fails the build on a DataTable with no
   * caption, so this branch should never be taken in the product. */
  const named = captionId !== undefined;
  return (
    <div
      ref={scrollportRef}
      className={SCROLLPORT}
      tabIndex={named && scrollable ? 0 : undefined}
      {...(named ? { role: 'region', 'aria-labelledby': captionId } : {})}
    >
      {table}
    </div>
  );
}

/** A quantity, rate or money column: right-aligned mono with tabular figures,
 * so digits line up down the column and the eye can compare them. */
export const numericCell =
  'text-right! font-mono text-[13px] whitespace-nowrap tabular-nums';

/** Prose in a table — a description or a reason. Capped so a long line cannot
 * push the numeric columns off the page.
 *
 * This is also the one opt-out of the mock's `whitespace-nowrap` cell: a
 * letter item description runs to five or six lines and a Work title to
 * two, so these cells wrap. The `whitespace-normal` is what CELLS above
 * detects to align the whole row to the top, so it is load-bearing even
 * where a cell would have wrapped anyway. Anything holding prose —
 * including every `ClampedText`, whose `line-clamp-2` needs a second
 * line to clamp — must carry this class. */
export const wrapCell =
  'max-w-[28rem] align-top leading-snug whitespace-normal [overflow-wrap:anywhere]';

/**
 * A cell holding a CONTROL — a select, a picker — in a row that also
 * holds prose.
 *
 * The auto table-layout algorithm hands each column something between
 * its min-content and its max-content width. `globals.css` gives every
 * form control `min-width: 0` and a select `width: 100%`, so a select's
 * min-content contribution is ZERO, while a `wrapCell` description's
 * max-content is the whole sentence. The description therefore takes the
 * budget and the select is squeezed towards nothing — which is what the
 * payment-category columns were doing on live data: the description ran
 * on underneath a select collapsed to a few pixels.
 *
 * `max-width` on the prose cell does not fix it. Auto layout ignores a
 * cell's max-width when distributing columns (only `table-fixed` honours
 * it), which is why `wrapCell`'s own cap has never bounded anything. A
 * MIN-width does count: it raises the column's minimum, so the control
 * keeps a floor the prose cannot take. Stated once here rather than as a
 * width guessed per screen.
 */
export const controlCell = 'min-w-44 align-top';

/* ---------------------------------------------------------------------
 * Register sorting.
 *
 * A register answers one question in the order the office keeps it in —
 * newest first, almost everywhere — and a second question the same rows
 * can answer only in a different order: which contract is the largest,
 * which letter is the oldest. The affordance is the column heading
 * itself, because the heading already names the key being sorted on and
 * a separate sort control would be a second place to look.
 *
 * The cycle is desc then asc, not desc/asc/none: "none" is a state an
 * operator cannot see the point of, and the register's own default order
 * is what is on screen before anything is clicked. That default is
 * `null` here, so a register that has not been sorted renders exactly the
 * order the server sent — which is why adding a sortable heading changes
 * no screen until it is used.
 * ------------------------------------------------------------------- */

export type SortDirection = 'asc' | 'desc';

/** The column being sorted on and which way. `null` is the register's own
 * default order. */
export interface ColumnSort<K extends string = string> {
  readonly key: K;
  readonly direction: SortDirection;
}

/**
 * The sort state a register's headings drive.
 *
 * `toggle` is the whole interaction: clicking a new column sorts it
 * descending (largest value, latest date — the answer the operator is
 * usually after), clicking the sorted column again flips it to ascending,
 * and clicking it a third time returns to descending.
 */
export function useColumnSort<K extends string>(
  initial: ColumnSort<K> | null = null,
): readonly [ColumnSort<K> | null, (key: K) => void] {
  const [sort, setSort] = useState<ColumnSort<K> | null>(initial);
  const toggle = useCallback((key: K) => {
    setSort((current) =>
      current !== null && current.key === key && current.direction === 'desc'
        ? { key, direction: 'asc' }
        : { key, direction: 'desc' },
    );
  }, []);
  return [sort, toggle];
}

/**
 * The `?sort=` a paged register's route wants, for the column state its
 * headings hold.
 *
 * Descending maps to `undefined`, not to `date_desc`. They mean the same
 * thing to the server, but `undefined` is the request the screen has
 * ALREADY made: mapping the first click on a Date heading to an explicit
 * `date_desc` would blank the register and re-read it to receive the rows
 * it is already showing, in the order it is already showing them. Only a
 * genuine reversal costs a round trip.
 *
 * A register with more than one sortable column would need a key here as
 * well; the routes offer their date column and nothing else (see
 * `packages/contracts/src/pagination.ts` for why a money column cannot be
 * a cursor key), so the direction is the whole of it.
 */
export function registerSortParameter(sort: ColumnSort | null): 'date_asc' | undefined {
  return sort !== null && sort.direction === 'asc' ? 'date_asc' : undefined;
}

/**
 * A column heading that sorts its register.
 *
 * `aria-sort` rides the `th` (where the specification puts it, and where a
 * screen reader reads it as it enters the column) while the button inside
 * carries the label and the tab stop. The button is `inline-flex`, so it
 * follows the cell's own text alignment — a `numericCell` heading stays
 * right-aligned without being told twice.
 *
 * The arrow is decorative: the sorted state is announced by `aria-sort`,
 * so an icon repeating it in the accessible name would say it twice.
 */
export function SortHeader<K extends string>({
  sortKey,
  sort,
  onSort,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'th'>, 'onClick'> & {
  readonly sortKey: K;
  readonly sort: ColumnSort<K> | null;
  readonly onSort: (key: K) => void;
}) {
  const active = sort !== null && sort.key === sortKey;
  const Icon = !active
    ? ChevronsUpDown
    : sort.direction === 'asc'
      ? ArrowUp
      : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={
        active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'
      }
      className={className}
      {...props}
    >
      <button
        type="button"
        onClick={() => {
          onSort(sortKey);
        }}
        className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-inherit uppercase focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        {children}
        <Icon
          aria-hidden="true"
          className={cn('size-3 shrink-0', active ? 'text-foreground' : 'opacity-40')}
        />
      </button>
    </th>
  );
}

/**
 * Sorts a register the view already holds in full.
 *
 * One accessor per sortable column, returning the value to compare:
 * a `YYYY-MM-DD` date (which compares correctly as text), a display
 * string, or a number. Money and quantities are decimal strings on the
 * wire; a view that sorts on one converts it here, for COMPARISON only —
 * no total is ever computed from the result, so engineering rule 5 is
 * untouched.
 *
 * Rows with no value for the sorted column sink to the bottom in BOTH
 * directions: a challan with no value yet is not "the smallest", it is
 * unanswered, and burying it under an ascending sort would hide it.
 *
 * `Array.prototype.sort` is stable, so rows that tie keep the order the
 * server sent — which is the register's default order, and the reason a
 * sort on a coarse key like a date does not shuffle within the day.
 */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: ColumnSort<K> | null,
  accessors: Readonly<Record<K, (row: T) => string | number | null | undefined>>,
): readonly T[] {
  if (sort === null) return rows;
  const read = accessors[sort.key];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = read(left);
    const b = read(right);
    const aMissing = a === null || a === undefined || a === '';
    const bMissing = b === null || b === undefined || b === '';
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    const order =
      typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a).localeCompare(String(b));
    return sign * order;
  });
}
