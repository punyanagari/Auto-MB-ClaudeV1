import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A minimal .xlsx writer, built on `node:zlib` and nothing else.
 *
 * ## Why this exists rather than a dependency
 *
 * An .xlsx file is a ZIP container holding five small XML parts. This
 * repository carried no ZIP writer, no spreadsheet library and no XML
 * library when this was written — the whole dependency surface of the
 * server is Fastify, TypeBox, better-auth, nodemailer, pg and qrcode — and
 * `packages/contracts/src/payments.ts` had already recorded the house
 * position out loud: "the product has no spreadsheet writer and does not
 * need one to emit rows".
 *
 * That position held while the only export was a quarterly TDS return,
 * where CSV is what the filing utility wants anyway. It stops holding once
 * every register in the product must hand its operator a workbook, because
 * a CSV is not a workbook: it carries no column widths, no header row that
 * survives a re-save, no sheet name saying which register it is, and — the
 * part that actually matters — it re-opens a text file into whatever
 * decimal and date interpretation the reader's locale imposes. A `₹` total
 * and a `DD/MM/YYYY` date are both routinely mangled that way.
 *
 * So the choice was one dependency or ~130 lines of stdlib. Node 20.15
 * added `zlib.crc32`, which was the only genuinely fiddly part of writing
 * a ZIP by hand; `zlib.deflateRawSync` supplies method 8. What is left is
 * three fixed-layout headers and five string templates. It is boring code
 * that cannot rot, it adds nothing to the supply chain, and it is one file
 * to delete if a dependency ever arrives for a harder reason — READING a
 * workbook, which is a genuinely hard problem and is not attempted here.
 *
 * ## What it deliberately does not do
 *
 * One sheet. No styles part, so no bold header, no column widths, no
 * number formats — the header row is plain text and the reader formats what
 * they want. No shared string table: every text cell is written inline
 * (`t="inlineStr"`), which is larger on the wire and simpler by exactly the
 * table a shared-strings part would be. No formulas, no merged cells, no
 * dates as serial numbers.
 *
 * That last one is a decision, not an omission. Excel stores a date as a
 * number of days since an epoch it gets wrong on purpose (the 1900 leap-year
 * bug), and this product's dates are date-only `YYYY-MM-DD` legal values
 * that `AGENTS.md` rule 6 forbids timezone-round-tripping. A date written as
 * a serial and read back through a locale is exactly the round trip that
 * rule exists to prevent, so dates travel as the text the register already
 * prints. A reader who wants arithmetic on them converts in the sheet.
 *
 * ## Injection
 *
 * `routes/payments.ts`'s CSV writer prefixes a leading `=`, `+`, `-` or `@`
 * with an apostrophe, because a CSV cell beginning with one becomes a
 * FORMULA when Excel parses the text. That defence is not needed here and
 * is deliberately absent: an `inlineStr` cell is typed as a string in the
 * file itself, so Excel has nothing to parse — the value is a string
 * because the XML says so, not because of what it looks like. Adding the
 * apostrophe anyway would corrupt every legitimate value starting with a
 * minus sign, which for a register carrying deductions is most of a column.
 */

/** One column of the sheet. */
export interface XlsxColumn {
  /** The header cell's text. */
  readonly header: string;
  /**
   * Whether the column's values are written as NUMBERS rather than text.
   *
   * Set it for money, quantities and counts — the columns an operator will
   * sum in the sheet. The value written is the server's own decimal string,
   * verbatim, straight into `<v>`; nothing in this process parses or
   * re-formats it, so the file carries exactly the digits the register
   * printed. A value that is not a plain decimal (a dash, an empty cell, a
   * range) falls back to a text cell rather than producing a corrupt one.
   */
  readonly numeric?: boolean;
}

/** A cell value: the register's own string, or null for an empty cell. */
export type XlsxValue = string | null;

/**
 * Whether a value is a plain decimal — no exponent, no thousands
 * separator, no currency symbol — and therefore safe to write into a
 * NUMERIC cell. Anything else becomes text.
 *
 * Written as a scan rather than as a pattern. The obvious regex
 * (`^-?[0-9]+(\.[0-9]+)?$`) is linear and perfectly safe, and the security
 * linter flags it anyway on a heuristic about a quantifier next to an
 * optional group. Ten boring lines settle that argument permanently and
 * bound both halves besides: eighteen integer digits and six decimals
 * reach past the widest column this schema has (`numeric(18,3)`).
 */
function isDigits(text: string): boolean {
  return text.length > 0 && /^[0-9]+$/.test(text);
}

function isPlainDecimal(value: string): boolean {
  const body = value.startsWith('-') ? value.slice(1) : value;
  const parts = body.split('.');
  if (parts.length > 2) return false;
  const [whole, fraction] = parts;
  if (whole === undefined || whole.length > 18 || !isDigits(whole)) return false;
  if (fraction === undefined) return true;
  return fraction.length <= 6 && isDigits(fraction);
}

/** XML text escaping, plus the control characters XML 1.0 cannot carry at
 * all. Tab, newline and carriage return are legal and are kept; the rest of
 * C0 is dropped, because a stray 0x00 in a free-text remark would make the
 * whole workbook unreadable rather than that one cell wrong. */
function xmlText(value: string): string {
  let text = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (character === '&') text += '&amp;';
    else if (character === '<') text += '&lt;';
    else if (character === '>') text += '&gt;';
    else text += character;
  }
  return text;
}

/** `0 -> A`, `25 -> Z`, `26 -> AA`. Spreadsheet column names are bijective
 * base-26, which is why this subtracts one each turn rather than using a
 * plain radix conversion. */
export function columnName(index: number): string {
  let name = '';
  let remaining = index + 1;
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    remaining = Math.floor((remaining - digit) / 26);
  }
  return name;
}

function cellXml(reference: string, value: XlsxValue, numeric: boolean): string {
  if (value === null || value === '') return '';
  if (numeric && isPlainDecimal(value)) {
    return `<c r="${reference}"><v>${value}</v></c>`;
  }
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function sheetXml(
  columns: readonly XlsxColumn[],
  rows: readonly (readonly XlsxValue[])[],
): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetData>',
    `<row r="1">${columns
      .map((column, index) => cellXml(`${columnName(index)}1`, column.header, false))
      .join('')}</row>`,
  ];
  for (const [rowIndex, row] of rows.entries()) {
    const number = rowIndex + 2;
    const cells = columns
      .map((column, index) =>
        cellXml(
          `${columnName(index)}${String(number)}`,
          row[index] ?? null,
          column.numeric === true,
        ),
      )
      .join('');
    parts.push(`<row r="${String(number)}">${cells}</row>`);
  }
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}

/** Sheet names may not exceed 31 characters and may not contain any of
 * `: \ / ? * [ ]`. Excel refuses to open a workbook that breaks either
 * rule, so the name is repaired here rather than trusted. */
function safeSheetName(name: string): string {
  const cleaned = name.replaceAll(/[:\\/?*[\]]/g, ' ').trim();
  const trimmed = cleaned.slice(0, 31).trim();
  return trimmed.length === 0 ? 'Sheet1' : trimmed;
}

interface ZipEntry {
  readonly name: string;
  readonly body: Buffer;
}

/**
 * A fixed DOS timestamp on every entry: 1 January 1980, midnight — the
 * earliest the format can express.
 *
 * The workbook's bytes are therefore a pure function of its contents, which
 * is what lets a test hold a golden file and what stops two exports of the
 * same register from differing. The modification time of a file that was
 * generated on demand and never stored carries no information anyway; the
 * export's own date is in the data.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function localHeader(entry: ZipEntry, compressed: Buffer): Buffer {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(8, 8); // deflate
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc32(entry.body), 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(entry.body.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([header, name]);
}

function centralHeader(entry: ZipEntry, compressed: Buffer, offset: number): Buffer {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0, 8); // flags
  header.writeUInt16LE(8, 10); // deflate
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc32(entry.body), 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(entry.body.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(0, 38); // external attributes
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

/** The ZIP container: local headers and bodies, then the central
 * directory, then the end-of-central-directory record. No Zip64 — the
 * registers this serves are bounded by their own page limits and none of
 * the three 32-bit fields can overflow at those sizes. */
function zip(entries: readonly ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const compressed = deflateRawSync(entry.body);
    const header = localHeader(entry, compressed);
    chunks.push(header, compressed);
    directory.push(centralHeader(entry, compressed, offset));
    offset += header.length + compressed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...chunks, central, end]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

/**
 * One register, one sheet, as .xlsx bytes.
 *
 * `rows` is positional against `columns`: a short row leaves its trailing
 * cells empty rather than throwing, because a register whose optional tail
 * columns are absent is a normal register and not a programming error.
 */
export function buildXlsx(
  sheetName: string,
  columns: readonly XlsxColumn[],
  rows: readonly (readonly XlsxValue[])[],
): Buffer {
  const name = safeSheetName(sheetName);
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlText(name)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  return zip([
    { name: '[Content_Types].xml', body: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', body: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', body: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', body: Buffer.from(WORKBOOK_RELS, 'utf8') },
    {
      name: 'xl/worksheets/sheet1.xml',
      body: Buffer.from(sheetXml(columns, rows), 'utf8'),
    },
  ]);
}

/** The one media type an .xlsx download answers with. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
