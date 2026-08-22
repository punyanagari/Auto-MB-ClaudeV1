import type { DashboardBillingMonth } from '@auto-mb/contracts';
import { formatCompactInr, formatInr } from '../../format.js';
import { navigateOnClick, workspaceHashOf } from '../../lib/workspace-routes.js';
import { barPath, niceCeiling, plotValue } from './chart-geometry.js';

const HISTORICAL_INVOICES_HASH = workspaceHashOf({
  view: { name: 'historical-invoices', workId: null },
});

/**
 * The PLOT's own user units — bars and gridlines, and nothing else.
 *
 * Every label lives outside this box, in CSS pixels. A `viewBox` scaled to
 * its column scales the text in it too, so an 11px tick read as 11px at
 * 720 and as 5px at 320 — the width a phone actually gives this panel. A
 * chart whose axis becomes unreadable at the width most of its readers
 * have is a chart with no axis. The SVG therefore carries no `<text>` at
 * all; the tick column and the month row beside it are ordinary elements
 * at ordinary sizes, positioned by percentage so they still line up.
 *
 * Short on purpose. The row this chart shares with the completion panel
 * has to finish above the fold at 1440px (`docs/UX.md` § 40 R6), and a
 * twelve-point series does not need height to be read — the comparison is
 * between the two bars of a month, which is a horizontal reading.
 */
const WIDTH = 720;
const HEIGHT = 140;
const GUTTER_TOP = 8;
const GUTTER_BOTTOM = 4;
/** Marks stay thin: the mock's whole grammar is hairlines and tabular
 * figures, and a fat bar is the one thing on this screen that would
 * shout. Capped rather than derived, so twelve months on a wide monitor
 * do not become twelve slabs. */
const MAX_BAR = 14;
const BAR_GAP = 2;

/** "2026-08" → "Aug". The year rides the axis separately, on the January
 * of each year, so twelve labels do not repeat a year eleven times. */
function monthLabel(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  return (
    [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ][index] ?? month
  );
}

/**
 * Billed against received, month by month, over the trailing year.
 *
 * TWO SERIES ON ONE AXIS, which is only honest because both are
 * GST-inclusive rupees — see the statement in
 * `apps/server/src/routes/dashboard.ts` for why a Measurement Book bill
 * total is not added to either. There is no second y-scale here and there
 * never will be: two scales on one plot let any two series be drawn as
 * though they cross.
 *
 * Colour is the chart ramp's first two steps (`--chart-1`, `--chart-2`),
 * which `docs/DESIGN.md` records as the palette charts draw from. They
 * are two steps of the product's teal rather than two hues: billed and
 * received are the same money at two points of one pipeline, and the
 * status hues — amber for caution, red for stop — are reserved for the
 * lamps elsewhere on this screen and are not spent on a series here.
 *
 * No animation anywhere in it, so there is nothing for
 * `prefers-reduced-motion` to switch off.
 */
export function BilledReceivedChart({
  months,
  billingSince,
  onOpenHistorical,
}: {
  readonly months: readonly DashboardBillingMonth[];
  /** The first month this application holds any billing evidence for. A
   * cutover looks exactly like a collapse on a trailing-year chart, and
   * only the server can tell them apart. */
  readonly billingSince: string | null;
  readonly onOpenHistorical: () => void;
}) {
  if (months.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No invoices or receipts in the last twelve months.
      </p>
    );
  }

  const plotted = months.map((row) => ({
    ...row,
    billedValue: plotValue(row.billed),
    receivedValue: plotValue(row.received),
  }));
  const highest = Math.max(
    0,
    ...plotted.map((row) => Math.max(row.billedValue, row.receivedValue)),
  );
  const lowest = Math.min(
    0,
    ...plotted.map((row) => Math.min(row.billedValue, row.receivedValue)),
  );
  const ceiling = niceCeiling(highest);
  const floor = lowest < 0 ? -niceCeiling(-lowest) : 0;
  const span = ceiling - floor;

  const plotHeight = HEIGHT - GUTTER_BOTTOM - GUTTER_TOP;
  const slot = WIDTH / plotted.length;
  const bar = Math.min(MAX_BAR, (slot - BAR_GAP) / 2 - 4);
  const baseline = GUTTER_TOP + plotHeight * (ceiling / span);
  const scale = (value: number) => (Math.abs(value) / span) * plotHeight;
  /** A plot y in per-cent of the plot box, for a label positioned over it. */
  const topPercent = (value: number) =>
    ((baseline - scale(value) * Math.sign(value || 1)) / HEIGHT) * 100;

  /* THE CUTOVER LINE, and only when there is a cutover to explain.
   *
   * An organisation that adopted this product part-way through the year
   * has empty months at the head of a trailing twelve, and an empty bar
   * says "we billed nothing" in exactly the same shape whether that is
   * true or whether the evidence is simply somewhere else. Rendered when
   * the first month holding any evidence is later than the first month
   * drawn; silent otherwise, because a qualifier on a full year is noise.
   * The month is the SERVER's — nothing here is hard-coded to a cutover
   * date that will be wrong for the next organisation. */
  const firstMonth = months[0]?.month ?? '';
  const cutover =
    billingSince !== null && billingSince > firstMonth ? billingSince : null;

  /* Three ticks, not seven. The reader is comparing two bars in a month,
     not measuring one against an absolute — the axis is there so the
     magnitudes are not a mystery, and past three lines it starts drawing
     more ink than the data. */
  const ticks = [ceiling, floor === 0 ? ceiling / 2 : 0, floor].filter(
    (value, index, all) => all.indexOf(value) === index,
  );

  return (
    <figure className="m-0">
      {/* Three columns of one grid rather than nested boxes: the tick
          column and the plot share a row, so the column stretches to
          exactly the plot's height and a tick at 25% of the plot is at
          25% of the column. The month row sits under the plot cell only,
          so its percentages are of the same box the bars are drawn in. */}
      <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2">
        <div className="relative" aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={String(tick)}
              className="absolute right-0 -translate-y-1/2 font-mono text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
              style={{ top: `${String(topPercent(tick))}%` }}
            >
              {/* The zero line is "₹0", not "₹0.00": an axis tick is a
                  scale marker, and paise on it are two characters of
                  noise on the one value that never has any. */}
              {tick === 0 ? '₹0' : formatCompactInr(String(tick))}
            </span>
          ))}
        </div>
        <div
          className="relative w-full"
          style={{ aspectRatio: `${String(WIDTH)} / ${String(HEIGHT)}` }}
        >
          <svg
            viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
            className="absolute inset-0 h-full w-full"
            role="img"
            aria-label="Value billed and payments received, by month, over the last twelve months. The figures are listed in the table below the chart."
          >
            {ticks.map((tick) => {
              const y = baseline - scale(tick) * Math.sign(tick || 1);
              return (
                <line
                  key={String(tick)}
                  x1={0}
                  x2={WIDTH}
                  y1={y}
                  y2={y}
                  stroke="var(--border)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {plotted.map((row, index) => {
              const left = index * slot + (slot - (bar * 2 + BAR_GAP)) / 2;
              return (
                <g key={row.month}>
                  <path
                    d={barPath(
                      left,
                      baseline,
                      bar,
                      scale(row.billedValue),
                      4,
                      row.billedValue >= 0,
                    )}
                    fill="var(--chart-1)"
                  >
                    <title>{`${monthLabel(row.month)} ${row.month.slice(0, 4)} billed ${formatInr(row.billed)}`}</title>
                  </path>
                  <path
                    d={barPath(
                      left + bar + BAR_GAP,
                      baseline,
                      bar,
                      scale(row.receivedValue),
                      4,
                      true,
                    )}
                    fill="var(--chart-2)"
                  >
                    <title>{`${monthLabel(row.month)} ${row.month.slice(0, 4)} received ${formatInr(row.received)}`}</title>
                  </path>
                </g>
              );
            })}
          </svg>
        </div>
        <div />
        {/* The month axis. Two lines where the year turns — January, and
            the first month of the series whatever it is, so the reader
            can always date the left edge. Below 640px only every third
            month is labelled: twelve 11px labels do not fit 260px, and
            thinning them keeps the ones that remain legible rather than
            shrinking all twelve into a smear. The FIRST and LAST always
            survive the thinning — the newest month is the bar a reader
            looks at first, and an axis whose right end is unlabelled
            makes them count backwards to date it. */}
        <div className="relative mt-1 h-7">
          {plotted.map((row, index) => {
            const showYear = index === 0 || row.month.endsWith('-01');
            const alwaysShown = index % 3 === 0 || index === plotted.length - 1;
            return (
              <span
                key={row.month}
                className={`absolute top-0 -translate-x-1/2 text-center font-mono text-[11px] leading-tight text-muted-foreground tabular-nums ${
                  alwaysShown ? '' : 'hidden sm:block'
                }`}
                style={{ left: `${String(((index + 0.5) / plotted.length) * 100)}%` }}
              >
                {monthLabel(row.month)}
                {showYear && <span className="block">{row.month.slice(0, 4)}</span>}
              </span>
            );
          })}
        </div>
      </div>
      {cutover !== null && (
        <p className="mt-2 mb-0 text-xs text-muted-foreground">
          {`Billing in this application starts in ${monthLabel(cutover)} ${cutover.slice(0, 4)}; the months before it are empty because the evidence is elsewhere, not because nothing was billed. Earlier history lives in the `}
          <a
            href={HISTORICAL_INVOICES_HASH}
            onClick={navigateOnClick(onOpenHistorical)}
          >
            Historical invoices register
          </a>
          .
        </p>
      )}
      {/* The table view. It is the accessible reading of the plot and the
          relief the palette's lightest step needs: `--chart-2` sits below
          3:1 against the light card, so the figures have to be readable
          somewhere that is not a fill.

          THE WRAPPER IS LOAD-BEARING. `sr-only` is `position: absolute`
          with `width: 1px; overflow: hidden`, and a `<table>` does not
          obey a width narrower than its own min-content — put the class
          on the table itself and it lays out at its full 289px, at its
          static position, and widens the document past the viewport. A
          page that scrolls sideways to reveal an invisible row of figures
          is the defect `globals.css` already records for `sr-only` labels
          inside scrolled registers, reached from a different direction; a
          `<div>` obeys the width, so the table is clipped inside it.
          Measured at 320px by `e2e/responsive.spec.ts`. */}
      <div className="sr-only">
        <table>
          <caption>Value billed and payments received, by month</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Billed</th>
              <th scope="col">Received</th>
            </tr>
          </thead>
          <tbody>
            {months.map((row) => (
              <tr key={row.month}>
                <th scope="row">{`${monthLabel(row.month)} ${row.month.slice(0, 4)}`}</th>
                <td>{formatInr(row.billed)}</td>
                <td>{formatInr(row.received)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** The two-swatch key. Two series always carry a legend — identity never
 * rests on colour alone — and the words beside each swatch are the same
 * words the table's column headings use. */
export function BilledReceivedLegend() {
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-4 p-0 text-xs text-muted-foreground">
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-2 rounded-full"
          style={{ backgroundColor: 'var(--chart-1)' }}
        />
        Billed
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-2 rounded-full"
          style={{ backgroundColor: 'var(--chart-2)' }}
        />
        Received
      </li>
    </ul>
  );
}
