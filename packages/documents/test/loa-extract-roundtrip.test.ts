import { describe, expect, it } from 'vitest';
import { extractLoaPdfText, extractPdfText } from '@auto-mb/documents';

/**
 * PDF → text round trip against the REAL `pdftotext`.
 *
 * `loa-extract.test.ts` proves the binary guard: a non-Poppler `pdftotext`
 * is refused by name. That guard is necessary and not sufficient — it
 * cannot see a Poppler that is genuinely Poppler and genuinely behaves
 * differently. The parser and its six-letter regression corpus are
 * calibrated against one specific layout behaviour, and a Poppler upgrade
 * that changed it would sail past the banner check and quietly corrupt
 * every extraction that follows.
 *
 * So this file runs a synthetic item table through the installed binary and
 * asserts the three layout properties `packages/loa-parser` actually reads:
 *
 *  1. `-layout` keeps an item's description on the SAME output line as its
 *     unit, quantity and rate;
 *  2. a wrapped description continues on the next line, with no blank line
 *     interposed and no columns from the row above repeated;
 *  3. a schedule-total figure stays on the total's own line rather than
 *     being hoisted into the item row above it.
 *
 * All three are exactly what Xpdf's `-layout` gets wrong on this shape —
 * captured verbatim in the pull request that added this file — which is why
 * they are the properties worth pinning. CI installs one exact Poppler
 * version (`.github/workflows/ci.yml`) and the production image installs the
 * same one (`deploy/Dockerfile.server`); this test is what turns a drift
 * between them into a red build instead of null units on a review screen.
 *
 * The fixture is built here rather than committed: a hand-written,
 * uncompressed PDF with Courier text at exact coordinates is the smallest
 * thing that can express "two columns on one visual line", and building it
 * in code keeps the coordinates readable beside the assertions they cause.
 */

/** One text run: x and y in PDF points (origin bottom-left) and its text. */
type TextRun = readonly [x: number, y: number, text: string];

/**
 * Builds a single-page PDF placing each run at its exact coordinates.
 * Uncompressed and with a real cross-reference table, so no assertion here
 * depends on a PDF library's choices — only on `pdftotext`'s.
 */
function buildPdf(runs: readonly TextRun[]): Buffer {
  const content = `BT\n/F1 10 Tf\n${runs
    .map(
      ([x, y, text]) =>
        `1 0 0 1 ${String(x)} ${String(y)} Tm ` +
        `(${text.replace(/([()\\])/g, '\\$1')}) Tj`,
    )
    .join('\n')}\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${String(Buffer.byteLength(content, 'latin1'))} >>\n` +
      `stream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(startxref)}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** An IREPS-shaped item row: header, one item whose description wraps, and
 * a schedule total whose figure sits under the rate column. */
const ITEM_TABLE: readonly TextRun[] = [
  [72, 720, 'S.No   Description'],
  [330, 720, 'Unit'],
  [400, 720, 'Qty'],
  [470, 720, 'Rate'],
  [72, 700, '1      Main switchboard, floor mounted'],
  [330, 700, 'Nos'],
  [400, 700, '2.000'],
  [470, 700, '450.00'],
  [72, 688, '       with copper busbar'],
  [72, 660, 'Schedule A total'],
  [470, 660, '900.00'],
];

/** Poppler ends lines with the platform separator; the parser reads `\n`. */
function lines(text: string): readonly string[] {
  return text.replaceAll('\r\n', '\n').split('\n');
}

describe('pdftotext round trip', () => {
  it('keeps an item description on the same -layout line as its columns', async () => {
    const layout = await extractPdfText(buildPdf(ITEM_TABLE));
    const itemLine = lines(layout).find((line) => line.trimStart().startsWith('1 '));

    expect(itemLine, layout).toBeDefined();
    // The one property the item-table reader is built on: description and
    // figures belong to the same row. Xpdf emits "1 ... Nos 2.000 450.00"
    // with the description moved to its own line below, which is how the
    // reader ends up with null units and mis-owned descriptions.
    expect(itemLine).toContain('Main switchboard, floor mounted');
    expect(itemLine).toContain('Nos');
    expect(itemLine).toContain('2.000');
    expect(itemLine).toContain('450.00');
    // Columns stay in column order, and the numeric columns stay to the
    // right of the description.
    const item = itemLine ?? '';
    expect(item.indexOf('Nos')).toBeGreaterThan(item.indexOf('Main switchboard'));
    expect(item.indexOf('2.000')).toBeGreaterThan(item.indexOf('Nos'));
    expect(item.indexOf('450.00')).toBeGreaterThan(item.indexOf('2.000'));
  });

  it('continues a wrapped description on the very next line', async () => {
    const layout = await extractPdfText(buildPdf(ITEM_TABLE));
    const all = lines(layout);
    const itemIndex = all.findIndex((line) => line.trimStart().startsWith('1 '));

    expect(itemIndex).toBeGreaterThanOrEqual(0);
    // No blank line between a description and its continuation: an
    // interposed blank is what makes a wrapped description read as a
    // separate, unowned row.
    expect(all[itemIndex + 1]).toContain('with copper busbar');
    // And the continuation carries description text only — no repeat of the
    // row's unit or figures.
    const continuation = all[itemIndex + 1] ?? '';
    expect(continuation).not.toContain('Nos');
    expect(continuation).not.toContain('450.00');
  });

  it('leaves a schedule total on its own line, not hoisted into the item row', async () => {
    const layout = await extractPdfText(buildPdf(ITEM_TABLE));
    const all = lines(layout);
    const totalLine = all.find((line) => line.includes('Schedule A total'));
    const itemLine = all.find((line) => line.trimStart().startsWith('1 '));

    expect(totalLine, layout).toBeDefined();
    // The Advt./schedule-value column hoisting into title rows is the
    // documented way a non-Poppler layout corrupts contract values.
    expect(totalLine).toContain('900.00');
    expect(itemLine).not.toContain('900.00');
  });

  it('returns both views, with -raw in reading order', async () => {
    const { layoutText, rawText } = await extractLoaPdfText(buildPdf(ITEM_TABLE));

    expect(layoutText).toContain('Main switchboard, floor mounted');
    // `-raw` is reading order, not visual order: the description is emitted
    // before the columns that sit to its right. The confirm flow relies on
    // this to recover exact, non-overlapping item descriptions.
    const description = rawText.indexOf('Main switchboard, floor mounted');
    const unit = rawText.indexOf('Nos');
    expect(description).toBeGreaterThanOrEqual(0);
    expect(unit).toBeGreaterThan(description);
    // The two views are genuinely different renderings of one document —
    // if they ever come back identical, one of the two invocations is not
    // doing what its flag says.
    expect(rawText).not.toBe(layoutText);
  });

  it('keeps the header columns aligned above the values they label', async () => {
    const layout = await extractPdfText(buildPdf(ITEM_TABLE));
    const all = lines(layout);
    const header = all.find((line) => line.includes('S.No')) ?? '';
    const item = all.find((line) => line.trimStart().startsWith('1 ')) ?? '';

    // -layout's whole promise is that a column header and the values it
    // labels land at comparable character offsets. Three characters of
    // slack absorbs the rounding of points onto character cells; a change
    // of layout ALGORITHM moves them much further than that.
    expect(Math.abs(header.indexOf('Unit') - item.indexOf('Nos'))).toBeLessThanOrEqual(
      3,
    );
    expect(
      Math.abs(header.indexOf('Rate') - item.indexOf('450.00')),
    ).toBeLessThanOrEqual(3);
  });
});
