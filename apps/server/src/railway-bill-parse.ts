import { parseDdMmYyyy } from '@auto-mb/loa-parser';

/**
 * Reading an IWRCMS On-Account Bill — the one chain document the agency
 * does not author.
 *
 * Every other document in this product is produced here and therefore
 * known exactly. The railway's bill arrives as a signed PDF from IWRCMS,
 * and the only honest way to know what it says is to read its own text
 * layer. So nothing in this module is typed by an operator: the bill
 * number, its date, its amount and the measurement it settles are all
 * EXTRACTED, in the same posture migration 0058 established for variation
 * orders and `loa-extracted-values.ts` established for the letter. A
 * typed bill number is a claim; a bill number found in the uploaded PDF's
 * own text is a fact.
 *
 * Input is always Poppler's `-layout` view (`extractPdfText`), which is
 * what the committed corpus fixtures under
 * `test/fixtures/railway-settlement/` were extracted with. Xpdf's
 * `-layout` splits these header cells differently; the shared
 * Poppler-only gate in `loa-extract.ts` is what keeps that from reaching
 * this module.
 *
 * The traps this module exists to survive are recorded, with evidence,
 * in `test/fixtures/railway-settlement/corpus.json` under `trap_notes`.
 * Each one is named at the code that handles it.
 */

/**
 * A measurement number, taken apart.
 *
 * IWRCMS prints the same measurement in two spellings depending on which
 * document you are holding. The Measurement Book carries
 * `.../OAM/L2/01`; the bill raised FROM that book carries
 * `.../OAM/FL2/01`. The change of ledger token is not an error and not a
 * different measurement — `L2` is the live ledger, `FL2` the finalised
 * one, and the bill is by definition raised against the finalised copy.
 *
 * This is trap 1 in the corpus, and it is why the number is taken APART
 * rather than compared. What production links on is the `sequence` below,
 * against the Measurement Book's own `sequence_number`, having first
 * checked that the bill names this Work's letter. The raw string is never
 * compared to anything, so the differing ledger token cannot break the
 * link — which is the trap handled by construction rather than by a
 * normalisation step.
 *
 * The canonical form that folds `FL2` and `L2` into one string is a
 * comparison between two RAILWAY documents, and this product holds only
 * one of them: the bill. It therefore lives in
 * `apps/server/test/helpers/measurement-number.ts`, where the corpus
 * guard uses it to hold the manifest's own book-to-bill pairing to
 * account. It is deliberately not carried here as production code with no
 * production caller.
 */
export interface MeasurementNumberParts {
  /** The full string exactly as the document printed it. */
  readonly raw: string;
  /** The LOA number the measurement is filed under. */
  readonly contractNumber: string;
  /** The station/unit code — `CSTM` on the PL-270 corpus. */
  readonly stationCode: string;
  /** The contractor's MB number within that station's series. */
  readonly cmbSuffix: string;
  /** `L2` on a Measurement Book, `FL2` on the bill raised from it. */
  readonly ledger: string;
  /** The on-account measurement sequence: 1, 2, 3 … within the Work. */
  readonly sequence: number;
}

/**
 * `<loa>/<station>/<cmb>/OAM/<ledger>/<sequence>`.
 *
 * The ledger group is deliberately `F?L\d+` rather than a two-value
 * alternation: the number after `L` is IWRCMS's ledger generation and
 * has been seen to move, and a bill whose ledger reads `L3`/`FL3` is
 * still the same shape of fact.
 */
const MEASUREMENT_NUMBER =
  /^(?<contract>[A-Za-z0-9]+)\/(?<station>[A-Za-z0-9&.-]+)\/(?<cmb>[A-Za-z0-9]+)\/OAM\/(?<ledger>F?L\d+)\/(?<sequence>\d+)$/;

/** Refusal to read an uploaded bill. Carries a code the route maps to a
 * refusal the operator can act on, rather than a stack trace. */
export class RailwayBillParseError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'RailwayBillParseError';
    this.field = field;
  }
}

/**
 * Splits a measurement number into its parts, or returns null when the
 * string is not one.
 */
export function parseMeasurementNumber(value: string): MeasurementNumberParts | null {
  const match = MEASUREMENT_NUMBER.exec(value.trim());
  if (match?.groups === undefined) return null;
  const { contract, station, cmb, ledger, sequence } = match.groups;
  if (
    contract === undefined ||
    station === undefined ||
    cmb === undefined ||
    ledger === undefined ||
    sequence === undefined
  ) {
    return null;
  }
  const parsed = Number(sequence);
  // A measurement sequence is a counter, and `OAM/L2/00` is not a
  // measurement anyone took.
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return {
    raw: value.trim(),
    contractNumber: contract,
    stationCode: station,
    cmbSuffix: cmb,
    ledger,
    sequence: parsed,
  };
}

/** One `-layout` cell: the text and the column it starts at. */
interface Cell {
  readonly column: number;
  readonly text: string;
}

/**
 * Splits one `-layout` line into cells.
 *
 * Poppler separates columns with runs of two or more spaces and keeps
 * single spaces inside a cell, so `Is Provisional Bill ?` stays one cell
 * while the value beside it becomes another.
 */
function cellsOf(line: string): Cell[] {
  // Scanned rather than matched. The natural pattern for this — a
  // non-space, a lazy middle, and a lookahead for two spaces or the end of
  // the line — backtracks quadratically, and every line reaching this
  // function came out of a PDF somebody uploaded.
  const cells: Cell[] = [];
  let index = 0;
  while (index < line.length) {
    while (index < line.length && isColumnGap(line[index])) index += 1;
    if (index >= line.length) break;
    const start = index;
    let lastInk = index;
    while (index < line.length) {
      if (isColumnGap(line[index])) {
        // One space stays inside a cell; two end it, and so does the line.
        if (index + 1 >= line.length || isColumnGap(line[index + 1])) break;
      } else {
        lastInk = index;
      }
      index += 1;
    }
    cells.push({ column: start, text: line.slice(start, lastInk + 1) });
  }
  return cells;
}

function isColumnGap(character: string | undefined): boolean {
  return character === ' ' || character === '\t';
}

/**
 * Reads the value printed beside a label in the bill's "Basic Details"
 * grid, when label and value share a line.
 *
 * The grid is three label/value column pairs wide, so the value is
 * simply the next cell to the right of the label cell.
 */
function readInlineField(lines: readonly string[], label: string): string | null {
  for (const line of lines) {
    const cells = cellsOf(line);
    const index = cells.findIndex((cell) => cell.text === label);
    if (index === -1) continue;
    const value = cells[index + 1];
    if (value !== undefined) return value.text;
  }
  return null;
}

/**
 * Reads a value that WRAPPED around its own label.
 *
 * Trap 3 in the corpus. `pdftotext -layout` renders a tall grid cell by
 * spreading it over as many lines as it needs and centring the short
 * cells beside it, so a two-line measurement number comes out with the
 * label between its halves:
 *
 * ```
 *                                      00341490147964/CSTM/11393
 *          Measurement No.                                          Measurement Date From   08/05/2026
 *                                      16/OAM/FL2/01
 * ```
 *
 * Reading the label's line gives `Measurement Date From` — the next
 * LABEL, not the value — and reading either fragment alone gives half a
 * measurement number that matches nothing. Collapsing the whitespace of
 * the whole block instead welds the label line's own neighbours into the
 * answer. So the fragments are gathered by COLUMN.
 *
 * The run is bounded by the label column, which is what makes this safe:
 * a line carrying its own label in the label column starts a different
 * field and ends the run. Line 10 above (`Contract ?  No`) has a cell at
 * the label column and is therefore not a continuation, even though its
 * value cell sits in the same column as the fragment on line 11.
 *
 * Fragments are concatenated in document order, top to bottom, because
 * that is the order they were printed in — the label being vertically
 * centred does not reorder them.
 */
function readWrappedField(lines: readonly string[], label: string): string | null {
  for (const [index, line] of lines.entries()) {
    const cells = cellsOf(line);
    const labelCell = cells.find((cell) => cell.text === label);
    if (labelCell === undefined) continue;

    // The value column: the leftmost cell strictly right of the label
    // among this line and the continuation lines around it.
    const continuation = (at: number): Cell[] | null => {
      const candidate = lines[at];
      if (candidate === undefined) return null;
      const candidateCells = cellsOf(candidate);
      if (candidateCells.length === 0) return null;
      // A cell at the label column means a different field's row.
      if (candidateCells.some((cell) => nearlyEqual(cell.column, labelCell.column))) {
        return null;
      }
      return candidateCells;
    };

    const above: Cell[][] = [];
    for (let at = index - 1; ; at -= 1) {
      const found = continuation(at);
      if (found === null) break;
      above.unshift(found);
    }
    const below: Cell[][] = [];
    for (let at = index + 1; ; at += 1) {
      const found = continuation(at);
      if (found === null) break;
      below.push(found);
    }

    const own = cells.filter((cell) => cell.column > labelCell.column);
    const rows = [...above, own, ...below];
    const columns = rows.flat().map((cell) => cell.column);
    if (columns.length === 0) return null;
    const valueColumn = Math.min(...columns);

    const fragments = rows
      .flatMap((row) => row.filter((cell) => nearlyEqual(cell.column, valueColumn)))
      .map((cell) => cell.text);
    if (fragments.length === 0) return null;
    return fragments.join('');
  }
  return null;
}

/**
 * Column positions jitter by a character or two between pages of the same
 * document, so cells are matched to a column with a small tolerance
 * rather than by equality.
 */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 2;
}

/**
 * `DD/MM/YYYY` as printed by IWRCMS, to the date-only `YYYY-MM-DD` this
 * product stores (AGENTS.md rule 6: legal dates never round-trip through
 * a timezone).
 */
function toIsoDate(printed: string, field: string): string {
  // The shared reader, which rejects 31/02 and friends — `new Date` rolls
  // those forward silently and hands back a day nobody printed. Three
  // modules read DD/MM/YYYY off a railway document and this is now the one
  // that knows how.
  const iso = parseDdMmYyyy(printed);
  if (iso === null) {
    throw new RailwayBillParseError(
      field,
      `${field} is not a real DD/MM/YYYY date: ${printed}`,
    );
  }
  return iso;
}

/**
 * A rupee figure as printed, to the fixed two-decimal string this
 * product's `money_amount` domain stores.
 *
 * The bill prints whole rupees on one bill and a trailing `.0` on the
 * next (`24516112` against `8057057.0`), so both shapes have to arrive at
 * the same stored value. The conversion is textual on purpose: parsing
 * to a JavaScript number and formatting it back is the floating-point
 * round trip AGENTS.md rule 5 forbids on authoritative money.
 */
export function toMoneyString(printed: string, field: string): string {
  const cleaned = printed.trim().replaceAll(',', '');
  const dot = cleaned.indexOf('.');
  const whole = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fraction = dot === -1 ? '' : cleaned.slice(dot + 1);
  // A second dot lands in `fraction` and fails the digit test with it, so
  // there is no separate case for it.
  if (
    !isDigits(whole) ||
    fraction.length > 2 ||
    (fraction !== '' && !isDigits(fraction))
  ) {
    throw new RailwayBillParseError(
      field,
      `${field} does not read as a rupee amount: ${printed}`,
    );
  }
  let rupees = whole;
  while (rupees.length > 1 && rupees.startsWith('0')) rupees = rupees.slice(1);
  return `${rupees}.${fraction.padEnd(2, '0')}`;
}

function isDigits(value: string): boolean {
  if (value === '') return false;
  for (const character of value) {
    if (character < '0' || character > '9') return false;
  }
  return true;
}

/** Everything read off one received railway bill. */
interface ParsedRailwayBill {
  /** `CR/BBY/S&T/2026/0009/B1`. */
  readonly billNumber: string;
  /** Date-only `YYYY-MM-DD`. */
  readonly billDate: string;
  /** The agreement the bill is raised under. */
  readonly agreementNumber: string;
  /** The LOA number, which is what links the bill to a Work here. */
  readonly letterNumber: string;
  /** The measurement this bill settles, rejoined and taken apart. */
  readonly measurement: MeasurementNumberParts;
  /** The `Rate is inclusive of GST` declaration, as the bill states it. */
  readonly rateInclusiveOfGst: boolean;
  /** `Bill Amount (Rs.) (Including Tax (GST))`, as `NNNN.NN`. */
  readonly billAmount: string;
}

/**
 * The first page's `Bill No.` header.
 *
 * Trap: IWRCMS prints the label and the number with NO separator —
 * `Bill No.CR/BBY/S&T/2026/0009/B1` — so this is one `-layout` cell and
 * a `Bill No.` label lookup in the grid finds nothing. The label is
 * stripped as a literal prefix rather than split on whitespace.
 */
function readBillNumber(text: string): string {
  const match = /^\s*Bill No\.\s*(\S.*?)\s*$/m.exec(text);
  if (match?.[1] === undefined || match[1] === '') {
    throw new RailwayBillParseError(
      'billNumber',
      'The bill does not print a "Bill No." header.',
    );
  }
  return match[1];
}

/**
 * The `Rate is inclusive of GST` declaration.
 *
 * The LABEL wraps here rather than the value (`Rate is inclusive of` on
 * one line, `GST   Yes` on the next), so this one is read by collapsing
 * whitespace across the two lines. That is safe for this field and only
 * this field: the label is long and distinctive enough that the collapsed
 * text cannot be produced by two unrelated neighbouring cells, which is
 * exactly what makes the same trick unsafe for the measurement number.
 *
 * This declaration is the evidence behind `works.gst_basis` (migration
 * 0062): the award letter is silent on GST and this bill is not.
 */
function readGstInclusive(text: string): boolean {
  const match = /Rate is inclusive of\s+GST\s+(Yes|No)\b/i.exec(
    text.replaceAll(/[^\S\n]*\n[^\S\n]*/g, ' '),
  );
  if (match?.[1] === undefined) {
    throw new RailwayBillParseError(
      'rateInclusiveOfGst',
      'The bill does not state whether its rates are inclusive of GST.',
    );
  }
  return match[1].toLowerCase() === 'yes';
}

/**
 * `Bill Amount (Rs.) (Including Tax (GST))` — the figure this bill adds.
 *
 * Read from its own labelled line rather than from the `Total Amount(Rs.)`
 * row above it, which prints three figures (up to last bill, since last
 * bill, total up to date) and whose middle column is the only one that
 * means this bill.
 *
 * Trap 4 in the corpus: this figure is GST-INCLUSIVE. It equals the tax
 * invoice's GRAND total, never its taxable value. `executed-value.ts`
 * owns the conversion; nothing here divides by anything.
 */
function readBillAmount(lines: readonly string[]): string {
  for (const line of lines) {
    const cells = cellsOf(line);
    const label = cells[0];
    if (label === undefined || !label.text.startsWith('Bill Amount (Rs.)')) continue;
    const figure = cells.at(-1);
    if (figure === undefined || figure === label) continue;
    const amount = toMoneyString(figure.text, 'billAmount');
    // A nil bill settles nothing, and the column refuses it
    // (`bill_amount > 0`). Refused HERE so the operator gets the
    // extraction refusal naming the field rather than a 500 from a
    // constraint — and refused before the bytes are written, rather than
    // after they are in storage with no row pointing at them.
    if (Number(amount) <= 0) {
      throw new RailwayBillParseError(
        'billAmount',
        `The bill's amount is ${amount}; a bill that settles nothing cannot be recorded.`,
      );
    }
    return amount;
  }
  throw new RailwayBillParseError(
    'billAmount',
    'The bill does not print a "Bill Amount (Rs.)" total.',
  );
}

function required(value: string | null, field: string, label: string): string {
  if (value === null || value === '') {
    throw new RailwayBillParseError(field, `The bill does not print "${label}".`);
  }
  return value;
}

/**
 * Reads an IWRCMS On-Account Bill from its Poppler `-layout` text.
 *
 * Throws `RailwayBillParseError` naming the field that could not be read.
 * A partial read is never returned: a bill missing its measurement number
 * cannot be linked to anything, and one missing its amount cannot settle
 * anything, so there is no useful half-answer to hand back.
 */
export function parseReceivedRailwayBill(layoutText: string): ParsedRailwayBill {
  const lines = layoutText.split(/\r?\n/);

  const measurementRaw = required(
    readWrappedField(lines, 'Measurement No.'),
    'measurementNumber',
    'Measurement No.',
  );
  const measurement = parseMeasurementNumber(measurementRaw);
  if (measurement === null) {
    throw new RailwayBillParseError(
      'measurementNumber',
      `The bill's measurement number does not read as one: ${measurementRaw}`,
    );
  }

  return {
    billNumber: readBillNumber(layoutText),
    billDate: toIsoDate(
      required(readInlineField(lines, 'Bill Date'), 'billDate', 'Bill Date'),
      'billDate',
    ),
    agreementNumber: required(
      readInlineField(lines, 'Agreement No.'),
      'agreementNumber',
      'Agreement No.',
    ),
    letterNumber: required(
      readInlineField(lines, 'LOA No.'),
      'letterNumber',
      'LOA No.',
    ),
    measurement,
    rateInclusiveOfGst: readGstInclusive(layoutText),
    billAmount: readBillAmount(lines),
  };
}
