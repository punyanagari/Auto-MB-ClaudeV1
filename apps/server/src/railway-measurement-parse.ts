import {
  cellsOf,
  isDigits,
  parseMeasurementNumber,
  type MeasurementNumberParts,
} from './railway-bill-parse.js';

/**
 * Reading the railway's own Measurement Book (migration 0111).
 *
 * IWRCMS produces two documents from one measurement: the measurement
 * sheet the railway's engineers certify, and the On-Account Bill raised
 * from it. `railway-bill-parse.ts` reads the second. This reads the
 * first, in the same posture — nothing is typed by an operator, because a
 * quantity somebody typed is a claim and a quantity found in the
 * railway's own document is a fact.
 *
 * ## This is read from real documents, not from a guess
 *
 * The settlement corpus already carries three of these sheets, extracted
 * with the same Poppler `-layout` view everything else in this product
 * reads (`test/fixtures/railway-settlement/MB-{1,2,3}.raw.txt`). Every
 * rule below is a rule those files forced; the traps are named at the
 * code that handles each.
 *
 * ## The shape of one item
 *
 * The sheet is not a column table. It is a run of blocks, each opening
 * with an item heading and closing with two lines that carry everything
 * comparable:
 *
 * ```
 * SCHEDULE A
 * Group : Not Applicable
 * Item No. : 01      Supply of True colour MLDB (Outdoor Video display …
 *  … the measurement grid: Number, coefficient, length, contents …
 *                                             Total         2.1
 * Reason for Reduction : Prepaid Nil Now to Pay 70% for 03 Nos   Now to pay  100.0%
 * ```
 *
 *   `Total`   the measured quantity — the TRUE CUMULATIVE quantity
 *             weighted by the stage percentage, so 3 Nos at 70% reads 2.1
 *             and reads 2.8 once a fourth unit has been claimed.
 *             `railway-measurement-match.ts` derives the same figure from
 *             the Measurement Book and carries the corpus evidence for
 *             both halves of that formula.
 *   `Reason for Reduction`  the contractual remark, the same sentence
 *             `mb-remark.ts` generates, re-typeset by IWRCMS. The
 *             trailing `Now to pay 100.0%` on that line is a SEPARATE
 *             grid column and not part of the remark, which is why the
 *             line is split into `-layout` cells rather than regexed.
 *
 * ## Item numbers repeat, so the schedule is part of the key
 *
 * `SCHEDULE A` and `SCHEDULE C` both carry an `Item No. : 01` in MB-1.
 * Keyed on the item number alone, one would overwrite the other and the
 * match would silently compare the wrong pair. The schedule heading is
 * tracked and the key is built as `A/01`, which is the shape this
 * product's own `work_items.item_number` uses.
 *
 * ## When it cannot be read at all
 *
 * It throws, and the caller records the document as `unreadable` rather
 * than refusing it. That is migration 0111's designed fallback: a scanned
 * measurement is a real thing an agency holds, and its exit is the
 * recorded line-by-line confirmation. The failure mode of this parser is
 * therefore MORE WORK for an operator, never a wrong match — which is why
 * it refuses a half-read sheet instead of returning the items it managed.
 */

/** Refusal to read an uploaded measurement. The caller turns this into an
 * `unreadable` row, not an error page. */
export class RailwayMeasurementParseError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'RailwayMeasurementParseError';
    this.field = field;
  }
}

/** One item block of the railway's measurement sheet, as printed. */
export interface ParsedMeasurementItem {
  /** `A/01` — the schedule heading and the item heading, joined the way
   * this product's own item numbers are. The match normalises the zero
   * padding; this keeps what the document printed. */
  readonly itemNumber: string;
  /** The `Total` figure, as a plain decimal string. Never parsed to a
   * JavaScript number here — the comparison is textual, over exact
   * decimals. */
  readonly quantity: string;
  /** The `Reason for Reduction` text, without the trailing percentage
   * column and with its internal whitespace collapsed. */
  readonly remark: string;
}

/** Everything read off one railway measurement sheet. */
export interface ParsedRailwayMeasurement {
  /** The measurement this sheet records, taken apart. Its `contractNumber`
   * is the LOA number, which is what ties the sheet to a Work here — the
   * sheet prints no separate `LOA No.` field, unlike the bill. */
  readonly measurement: MeasurementNumberParts;
  readonly items: readonly ParsedMeasurementItem[];
}

/**
 * The sheet's own measurement number.
 *
 * TRAP 2 of the settlement corpus is why this is anchored on this exact
 * label. A Measurement Book also BACK-REFERENCES the previous bill's
 * number, on lines that read
 * `Qty B/F MB no.00341490147964/CSTM/1139316/OAM/FL2/01 (Item no : 01)` —
 * so "the FL2 token in this document" is not this document's own
 * measurement, and a looser search finds the wrong one on every sheet
 * after the first. `On Account Measurement No.` names only the sheet's
 * own, and it repeats identically on each page header.
 */
const MEASUREMENT_HEADING = /On Account Measurement No\.\s+(\S+)/;

/** `SCHEDULE A`, on its own line and at the left margin. */
const SCHEDULE_HEADING = /^SCHEDULE\s+(\S+)\s*$/;

/** `Item No. : 01`, with the capitalised label. Deliberately NOT
 * case-insensitive: the back-reference lines above spell it `Item no :`
 * inside a parenthesis, and matching those would open an item block in
 * the middle of the previous one. */
const ITEM_HEADING = /^Item No\. :\s+(\S+)/;

/**
 * Whether the cell to the right of a bare `Total` cell is a quantity.
 *
 * Scanned rather than matched, for the reason `cellsOf` in
 * `railway-bill-parse.ts` gives: the natural pattern for this carries a
 * nested quantifier, and every string reaching this function came out of
 * a PDF somebody uploaded. `isDigits` is that module's own scanner,
 * shared rather than re-derived.
 */
function isQuantityCell(text: string): boolean {
  const dot = text.indexOf('.');
  if (dot === -1) return isDigits(text);
  return isDigits(text.slice(0, dot)) && isDigits(text.slice(dot + 1));
}

const REASON_LABEL = 'Reason for Reduction :';

/**
 * A `Reason for Reduction` long enough to wrap, put back together.
 *
 * TRAP 5, and it is the one that silently shortens a claim rather than
 * failing to read it. The remark cell is the widest on the sheet and a
 * compound one overflows: MB-3 item A/07 prints
 *
 * ```
 * Reason for Reduction : Prepaid 70% for 13 Nos and 20% for 02 Nos Now to   Now to pay   100.0%
 * Pay 70% for 05 Nos
 * ```
 *
 * Read a line at a time, that item's remark ends at "Now to" — which is
 * not a truncation the reader can see, because "Prepaid 70% for 13 Nos
 * and 20% for 02 Nos" is a perfectly well-formed claim. It is simply a
 * different one from what the railway wrote, and every consumer
 * downstream would believe it: the 0111 matcher would refuse a document
 * that agrees, and migration 0114's proposal would offer 13 units where
 * the sheet says 18.
 *
 * THE RULE IS THE COLUMN, and it is narrow on purpose. A continuation is
 * a non-blank line at column 0 immediately after the reason line, and
 * nothing else on this sheet starts at column 0 — every other line of an
 * item block is indented, and the three headings that are not
 * (`SCHEDULE`, `Item No. :`, `Group :`) are excluded by name. Across the
 * three committed corpus sheets this welds exactly two lines, both of
 * them the tail of a compound remark, and leaves 300-odd others alone.
 */
const REASON_CONTINUATION_STOP =
  /^(?:SCHEDULE\s|Item No\. :|Group :|Total\b|Reason for Reduction :)/;

function weldWrappedReasons(lines: readonly string[]): readonly string[] {
  const welded: string[] = [];
  for (const line of lines) {
    const previous = welded.at(-1);
    if (
      previous !== undefined &&
      previous.startsWith(REASON_LABEL) &&
      line.trim() !== '' &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !REASON_CONTINUATION_STOP.test(line)
    ) {
      // SPLICED INTO THE REMARK CELL, not appended to the line. The
      // reason line carries a `Now to pay 100.0%` column of its own to
      // the right of the remark, and the reader takes the remark as the
      // FIRST `-layout` cell — so a continuation stuck on the end of the
      // line would land in that other column and be read as part of it.
      // The insertion point is the first two-space gap after the label,
      // which is where the remark cell ends.
      const gap = previous.slice(REASON_LABEL.length).search(/ {2,}/);
      const at = gap === -1 ? previous.length : REASON_LABEL.length + gap;
      welded[welded.length - 1] =
        `${previous.slice(0, at)} ${line.trim()}${previous.slice(at)}`;
      continue;
    }
    welded.push(line);
  }
  return welded;
}

interface OpenItem {
  readonly itemNumber: string;
  quantity: string | null;
  remark: string | null;
}

function closed(item: OpenItem): ParsedMeasurementItem {
  if (item.quantity === null || item.remark === null) {
    throw new RailwayMeasurementParseError(
      'items',
      `Item ${item.itemNumber} prints no ${item.quantity === null ? 'measured total' : 'reason for reduction'}.`,
    );
  }
  return {
    itemNumber: item.itemNumber,
    quantity: item.quantity,
    remark: item.remark,
  };
}

/**
 * Reads a railway measurement sheet from its Poppler `-layout` text.
 *
 * Throws `RailwayMeasurementParseError` naming what could not be read.
 */
export function parseRailwayMeasurement(rawText: string): ParsedRailwayMeasurement {
  // FORM FEEDS BECOME NEWLINES FIRST, and this is not tidying. Poppler
  // emits `\f` at a page break with no newline of its own, so a heading
  // that happens to fall at the top of a page arrives as `\fReason for
  // Reduction : …` — one cell whose text does not start with the label
  // it plainly starts with. In MB-1 of the settlement corpus exactly one
  // item is affected (A/19, page 3), which is the shape of bug that
  // passes every hand-written fixture and fails on the second real
  // document.
  //
  // A NEWLINE and not an empty string, which is strictly the safer of the
  // two. Deleting the byte welds the last line of one page onto the first
  // line of the next whenever the break lands mid-line, and the welded
  // result is a line whose column positions are the sum of two pages'
  // — so `cellsOf` reads cells that were never side by side. Replacing
  // it starts a fresh line instead, which is what the page break meant.
  // The only cost is one blank line where the `\f` already followed a
  // newline, and blank lines are skipped everywhere below.
  const layoutText = rawText.replaceAll('\f', '\n');
  const heading = MEASUREMENT_HEADING.exec(layoutText);
  if (heading?.[1] === undefined) {
    throw new RailwayMeasurementParseError(
      'measurementNumber',
      'The document does not print an "On Account Measurement No." heading.',
    );
  }
  const measurement = parseMeasurementNumber(heading[1]);
  if (measurement === null) {
    throw new RailwayMeasurementParseError(
      'measurementNumber',
      `The measurement number does not read as one: ${heading[1]}`,
    );
  }

  const items: ParsedMeasurementItem[] = [];
  let schedule: string | null = null;
  let open: OpenItem | null = null;

  for (const line of weldWrappedReasons(layoutText.split(/\r?\n/))) {
    const scheduleHeading = SCHEDULE_HEADING.exec(line);
    if (scheduleHeading?.[1] !== undefined) {
      if (open !== null) items.push(closed(open));
      open = null;
      schedule = scheduleHeading[1];
      continue;
    }

    const itemHeading = ITEM_HEADING.exec(line);
    if (itemHeading?.[1] !== undefined) {
      if (open !== null) items.push(closed(open));
      if (schedule === null) {
        throw new RailwayMeasurementParseError(
          'items',
          `Item ${itemHeading[1]} appears before any SCHEDULE heading, so there is nothing to file it under.`,
        );
      }
      open = {
        itemNumber: `${schedule}/${itemHeading[1]}`,
        quantity: null,
        remark: null,
      };
      continue;
    }

    if (open === null) continue;

    // The two closing lines, read as `-layout` CELLS rather than by
    // pattern over the whole line. Both share their line with other grid
    // columns — `Total 2.1` sits at the right of the measurement grid,
    // and the reason line carries a `Now to pay 100.0%` column of its
    // own — so the cell boundary is what separates the value from its
    // neighbours. A regex over the raw line would have to guess where.
    const cells = cellsOf(line);
    if (cells.length === 2 && cells[0]?.text === 'Total') {
      const total = cells[1]?.text ?? '';
      // Last one wins: an item's grid can print intermediate sums above
      // the line that closes it, and the closing `Total` is the last.
      if (isQuantityCell(total)) open.quantity = total;
    }
    const first = cells[0];
    if (first !== undefined && first.text.startsWith(REASON_LABEL)) {
      open.remark = first.text
        .slice(REASON_LABEL.length)
        .replaceAll(/\s+/g, ' ')
        .trim();
      items.push(closed(open));
      open = null;
    }
  }
  if (open !== null) items.push(closed(open));

  if (items.length === 0) {
    throw new RailwayMeasurementParseError(
      'items',
      'The document prints no measured items.',
    );
  }
  return { measurement, items };
}
