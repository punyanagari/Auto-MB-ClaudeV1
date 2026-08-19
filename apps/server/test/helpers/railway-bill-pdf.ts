/**
 * A received railway bill as a real PDF, for the routes that read one.
 *
 * The parser's regression bar is the committed corpus text
 * (`railway-bill-parse.test.ts` reads `fixtures/railway-settlement/BILL-*.raw.txt`
 * verbatim, which is what Poppler actually produced from the real
 * documents). What the ROUTE needs is different: bytes that survive
 * `consumeUpload`'s magic-byte gate, the malware scan, `pdftotext -layout`
 * and `verifyUploadedPdf`. This builds those.
 *
 * The text is laid out in Courier so that one character of the source
 * block occupies one character cell on the page. `pdftotext -layout` then
 * reproduces the column positions the parser reads by column — including
 * the measurement number wrapping around its own label, which is the trap
 * the route has to survive end to end and not only in a unit test.
 */

const FONT_SIZE = 6;
/** Courier advances 0.6 em per glyph at every size. */
const CHARACTER_WIDTH = FONT_SIZE * 0.6;
const LINE_HEIGHT = FONT_SIZE * 1.6;
const MARGIN = 12;

function escapePdfText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

/**
 * Renders lines of `-layout`-shaped text into a single-page PDF whose own
 * `-layout` extraction gives them back.
 *
 * The page is sized to the content rather than to A4: a bill line runs to
 * about 180 characters, and squeezing that onto A4 would make Poppler
 * merge the columns the parser reads.
 */
export function textLayoutPdf(lines: readonly string[]): Buffer {
  const widest = lines.reduce((longest, line) => Math.max(longest, line.length), 1);
  const pageWidth = Math.ceil(MARGIN * 2 + widest * CHARACTER_WIDTH) + 8;
  const pageHeight = Math.ceil(MARGIN * 2 + (lines.length + 1) * LINE_HEIGHT);

  const content = lines
    .map((line, index) => {
      if (line.trim() === '') return '';
      const y = pageHeight - MARGIN - (index + 1) * LINE_HEIGHT;
      // Each line is placed absolutely and printed whole, leading spaces
      // included: in a fixed-pitch font those spaces ARE the columns.
      return `BT /F1 ${String(FONT_SIZE)} Tf ${String(MARGIN)} ${String(y)} Td (${escapePdfText(line)}) Tj ET`;
    })
    .filter((operator) => operator !== '')
    .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(pageWidth)} ${String(pageHeight)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];

  let body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export interface RailwayBillTextOptions {
  readonly billNumber?: string;
  readonly billDate?: string;
  readonly agreementNumber?: string;
  readonly letterNumber?: string;
  /** Split across the label line exactly as IWRCMS prints it. */
  readonly measurementHead?: string;
  readonly measurementTail?: string;
  readonly rateInclusiveOfGst?: boolean;
  readonly billAmount?: string;
}

/** One `-layout` line built from `[column, text]` cells, left to right. */
function row(...cells: readonly (readonly [number, string])[]): string {
  let line = '';
  for (const [column, text] of cells) {
    if (line.length > column) {
      throw new Error(
        `cell "${text}" overlaps the one before it at column ${String(column)}`,
      );
    }
    line = line.padEnd(column, ' ') + text;
  }
  return line;
}

/**
 * The bill's "Basic Details" block and its total, in the real document's
 * geometry: labels at columns 9, 74 and 127, values at 37, 103 and 162,
 * and the measurement number split across the two lines that bracket its
 * own label.
 *
 * Everything the parser reads is here and nothing else is, which is the
 * point — a fixture that reproduced all fourteen pages would prove the
 * same thing more slowly.
 */
export function railwayBillText(options: RailwayBillTextOptions = {}): string[] {
  const {
    billNumber = 'CR/BBY/S&T/2026/0009/B1',
    billDate = '11/05/2026',
    agreementNumber = 'CR/BBY/S&T/2026/0009',
    letterNumber = '00341490147964',
    measurementHead = '00341490147964/CSTM/11393',
    measurementTail = '16/OAM/FL2/01',
    rateInclusiveOfGst = true,
    billAmount = '24516112',
  } = options;

  return [
    // The header prints the label and the number with NO separator.
    row([77, `Bill No.${billNumber}`]),
    '',
    row([9, 'On-Account Bill Basic Details:']),
    row(
      [9, 'Agreement No.'],
      [37, agreementNumber],
      [74, 'Agreement Date'],
      [103, '30/04/2026'],
      [127, 'Bill Date'],
      [162, billDate],
    ),
    row([9, 'LOA No.'], [37, letterNumber], [74, 'LOA Date'], [103, '01/01/2026']),
    row([9, 'Is it a Composite'], [76, 'Is Measurement to be done']),
    row([9, 'Contract ?'], [37, 'No'], [76, 'by Contractor ?'], [105, 'Yes']),
    // The value's first half, printed ABOVE its own label. Note the cell
    // at column 37 on the line before it, which is a DIFFERENT field's
    // value and must not be swept into the measurement number.
    row([37, measurementHead]),
    row([9, 'Measurement No.'], [76, 'Measurement Date From'], [105, '08/05/2026']),
    // ...and its second half, printed BELOW.
    row([37, measurementTail]),
    row([9, 'Bill Preparation'], [127, 'Date of Commencement of']),
    row([9, 'Department'], [37, 'S&T'], [76, 'Tender Accepting Authority']),
    // The LABEL wraps here, rather than the value.
    row([9, 'Rate is inclusive of']),
    row([9, 'GST'], [37, rateInclusiveOfGst ? 'Yes' : 'No']),
    '',
    row([0, 'Total Amount(Rs.)'], [55, '0.0'], [73, billAmount]),
    row([0, 'Bill Amount (Rs.) (Including Tax (GST))'], [73, billAmount]),
  ];
}

/** One item block of a railway measurement sheet, as the route reads it. */
export interface RailwayMeasurementItemOptions {
  readonly schedule: string;
  readonly itemNumber: string;
  /** The `Total` figure: the TRUE CUMULATIVE quantity weighted by the
   * stage percentage, which is what IWRCMS prints. */
  readonly quantity: string;
  readonly remark: string;
}

export interface RailwayMeasurementTextOptions {
  readonly measurementNumber?: string;
  readonly items?: readonly RailwayMeasurementItemOptions[];
}

/**
 * The railway's own Measurement Book, in the geometry of the real thing.
 *
 * The parser's regression bar is the committed corpus
 * (`railway-measurement-parse.test.ts` reads `MB-{1,2,3}.raw.txt`
 * verbatim). What the ROUTE needs is bytes that survive `consumeUpload`,
 * the scan and `pdftotext -layout`, carrying a measurement this test can
 * choose — so this reproduces the block shape those files established
 * and nothing else: the measurement heading, a schedule heading, and per
 * item a heading, a `Total` row at the right of the grid, and a `Reason
 * for Reduction` line with its own trailing percentage column.
 */
export function railwayMeasurementText(
  options: RailwayMeasurementTextOptions = {},
): string[] {
  const { measurementNumber = '00341490147964/CSTM/1139316/OAM/L2/01', items = [] } =
    options;

  const lines = [
    row([10, `On Account Measurement No. ${measurementNumber}`]),
    '',
    row([3, 'Particulars'], [22, 'Unit'], [31, 'Numbers'], [47, 'Coeff.']),
  ];
  let schedule: string | null = null;
  for (const item of items) {
    if (item.schedule !== schedule) {
      schedule = item.schedule;
      lines.push('', `SCHEDULE ${schedule}`);
    }
    lines.push(
      row([0, 'Group : Not Applicable']),
      row([0, `Item No. : ${item.itemNumber}      Supply of something measured`]),
      // The grid line the coefficient and the contents live on. Present
      // because a real sheet has one and the parser must not mistake its
      // `= 2.1` for the total below it.
      row(
        [0, 'Supply of'],
        [22, 'Number'],
        [31, '1.0 x 1.0 x 1.0'],
        [88, `= ${item.quantity}`],
        [102, 'Yes'],
      ),
      row([88, 'Total'], [100, item.quantity]),
      row(
        [0, `Reason for Reduction : ${item.remark}`],
        [90, 'Now to pay'],
        [110, '100.0%'],
      ),
      '',
    );
  }
  return lines;
}
