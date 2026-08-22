import type { DashboardBillingMonth } from '@auto-mb/contracts';
import { formatCompactInr, formatInr } from '../../format.js';
import { barPath, niceCeiling, plotValue } from './chart-geometry.js';

/** The plot area, in the SVG's own user units. The element scales to its
 * column; these are the proportions, not a pixel size. */
const WIDTH = 720;
/* Short on purpose. The row this chart shares with the completion panel
 * has to finish above the fold at 1440px (`docs/UX.md` § 38 R6), and a
 * twelve-point series does not need height to be read — the comparison is
 * between the two bars of a month, which is a horizontal reading. */
const HEIGHT = 180;
const GUTTER_LEFT = 62;
const GUTTER_BOTTOM = 26;
const GUTTER_TOP = 10;
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
}: {
  readonly months: readonly DashboardBillingMonth[];
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

  const plotWidth = WIDTH - GUTTER_LEFT;
  const plotHeight = HEIGHT - GUTTER_BOTTOM - GUTTER_TOP;
  const slot = plotWidth / plotted.length;
  const bar = Math.min(MAX_BAR, (slot - BAR_GAP) / 2 - 4);
  const baseline = GUTTER_TOP + plotHeight * (ceiling / span);
  const scale = (value: number) => (Math.abs(value) / span) * plotHeight;

  /* Three ticks, not seven. The reader is comparing two bars in a month,
     not measuring one against an absolute — the axis is there so the
     magnitudes are not a mystery, and past three lines it starts drawing
     more ink than the data. */
  const ticks = [ceiling, floor === 0 ? ceiling / 2 : 0, floor].filter(
    (value, index, all) => all.indexOf(value) === index,
  );

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        className="block h-auto w-full"
        role="img"
        aria-label="Value billed and payments received, by month, over the last twelve months. The figures are listed in the table below the chart."
      >
        {ticks.map((tick) => {
          const y = baseline - scale(tick) * Math.sign(tick || 1);
          return (
            <g key={String(tick)}>
              <line
                x1={GUTTER_LEFT}
                x2={WIDTH}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={GUTTER_LEFT - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-muted-foreground font-mono text-[11px] tabular-nums"
              >
                {/* The zero line is "₹0", not "₹0.00": an axis tick is a
                    scale marker, and paise on it are two characters of
                    noise on the one value that never has any. */}
                {tick === 0 ? '₹0' : formatCompactInr(String(tick))}
              </text>
            </g>
          );
        })}
        {plotted.map((row, index) => {
          const left = GUTTER_LEFT + index * slot + (slot - (bar * 2 + BAR_GAP)) / 2;
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
              <text
                x={GUTTER_LEFT + index * slot + slot / 2}
                y={HEIGHT - 8}
                textAnchor="middle"
                className="fill-muted-foreground font-mono text-[11px] tabular-nums"
              >
                {monthLabel(row.month)}
              </text>
            </g>
          );
        })}
      </svg>
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
