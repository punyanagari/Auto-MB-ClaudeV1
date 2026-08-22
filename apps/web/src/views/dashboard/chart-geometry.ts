/**
 * The three pieces of geometry the dashboard's two SVG charts share.
 *
 * PIXELS ONLY. Nothing here decides a figure — every number that reaches
 * a reader is an exact decimal string the server computed and the screen
 * formats. These functions turn one of those strings into a bar length,
 * which is a drawing decision and may safely be a float: a rounding error
 * of a thousandth of a pixel is not a rounding error in money.
 */

/** A bar's rounded data-end with a square baseline, as an SVG path.
 *
 * `d3`-free and dependency-free: the shape is four lines and two arcs and
 * writing it out is smaller than any library that would draw it. The
 * radius is capped at half the length so a very short bar degrades to a
 * lozenge rather than inverting its own corners.
 *
 * `up` is the growth direction. A column grows upward from the baseline
 * and rounds at the top; a bar in a month whose credit notes exceed its
 * invoices grows downward and rounds at the bottom, so the rounded end is
 * always the DATA end and the square one is always the baseline.
 */
export function barPath(
  x: number,
  baseline: number,
  width: number,
  length: number,
  radius: number,
  up: boolean,
): string {
  const r = Math.max(0, Math.min(radius, width / 2, length));
  const tip = up ? baseline - length : baseline + length;
  const sweep = up ? 1 : 0;
  const inset = up ? r : -r;
  return [
    `M ${String(x)} ${String(baseline)}`,
    `L ${String(x)} ${String(tip + inset)}`,
    `A ${String(r)} ${String(r)} 0 0 ${String(sweep)} ${String(x + r)} ${String(tip)}`,
    `L ${String(x + width - r)} ${String(tip)}`,
    `A ${String(r)} ${String(r)} 0 0 ${String(sweep)} ${String(x + width)} ${String(tip + inset)}`,
    `L ${String(x + width)} ${String(baseline)}`,
    'Z',
  ].join(' ');
}

/**
 * A y-axis ceiling an operator can read: the smallest 1, 2 or 5 times a
 * power of ten at or above the largest value.
 *
 * Round ticks are not decoration. The axis carries every value the chart
 * does not directly label, and "₹1.5 Cr" is a number somebody can hold
 * against a bar while "₹1.43 Cr" is one they have to decode.
 */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/** A decimal string as a drawing number. Non-finite input draws nothing
 * rather than throwing: a chart is not the place a malformed figure
 * should take the screen down, and the table view beneath it still
 * prints whatever arrived. */
export function plotValue(decimal: string): number {
  const parsed = Number(decimal);
  return Number.isFinite(parsed) ? parsed : 0;
}
