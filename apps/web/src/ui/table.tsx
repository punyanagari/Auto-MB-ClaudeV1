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
 * The background is opaque so scrolled rows cannot read through it, and
 * border-separate keeps the bottom rule on the cell where it travels with
 * the heading. The literal near-white predates the Signal retarget, which
 * moved the palette around it. */
const HEAD = [
  '[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-1',
  '[&_thead_th]:bg-[oklch(0.986_0.002_250)]',
  '[&_thead_th]:border-b [&_thead_th]:border-border',
  '[&_thead_th]:px-4 [&_thead_th]:py-3 [&_thead_th]:text-left',
  '[&_thead_th]:text-[11px] [&_thead_th]:font-semibold [&_thead_th]:tracking-[0.025em]',
  '[&_thead_th]:text-muted-foreground [&_thead_th]:uppercase',
].join(' ');

const CELLS = [
  '[&_td]:border-b [&_td]:border-border [&_td]:px-4 [&_td]:py-3',
  '[&_td]:text-left [&_td]:align-top [&_td]:font-normal',
  '[&_tbody_th]:border-b [&_tbody_th]:border-border [&_tbody_th]:px-4 [&_tbody_th]:py-3',
  '[&_tbody_th]:text-left [&_tbody_th]:align-top [&_tbody_th]:font-medium',
  '[&_tfoot_th]:border-b [&_tfoot_th]:border-border [&_tfoot_th]:px-4 [&_tfoot_th]:py-3',
  '[&_tfoot_th]:text-left [&_tfoot_th]:align-top [&_tfoot_th]:font-medium',
  '[&>:last-child>tr:last-child>td]:border-b-0',
  '[&>:last-child>tr:last-child>th]:border-b-0',
  '[&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-muted/40',
].join(' ');

/** The registry table: a bordered card with a quiet uppercase heading that
 * survives the scroll, hairline row rules, and hover.
 *
 * `scroll` is for the tables whose columns cannot be made to fit — the two
 * editable grids, where every cell holds a control with a floor on its width.
 * Without it they simply grow past the card and take the page's width with
 * them. The pair is `overflow-x: auto` with `overflow-y: clip` rather than
 * the usual `auto`: `clip` does not make the wrapper a scroll container, so
 * the nearest scrollport for the heading is still the page and it goes on
 * sticking. Plain `overflow-x: auto` would coerce the other axis to `auto`,
 * and a sticky heading inside a scrollport that never scrolls never moves. */
export function DataTable({
  className,
  scroll = false,
  ...props
}: React.ComponentProps<'table'> & { readonly scroll?: boolean }) {
  const table = (
    <table
      className={cn(
        'my-3 w-full border-separate border-spacing-0 rounded-xl border border-border bg-card text-sm',
        CORNERS,
        HEAD,
        CELLS,
        className,
      )}
      {...props}
    />
  );
  return scroll ? (
    <div className="overflow-x-auto overflow-y-clip">{table}</div>
  ) : (
    table
  );
}

/** A quantity, rate or money column: right-aligned mono with tabular figures,
 * so digits line up down the column and the eye can compare them. */
export const numericCell =
  'text-right! font-mono text-[13px] whitespace-nowrap tabular-nums';

/** Prose in a table — a description or a reason. Capped so a long line cannot
 * push the numeric columns off the page. */
export const wrapCell = 'max-w-[28rem] leading-snug [overflow-wrap:anywhere]';
