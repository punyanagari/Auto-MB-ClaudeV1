import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * The smallest thing that can read the spreadsheet an operator actually
 * has and write the template they download: a ZIP container over
 * SpreadsheetML, built on `node:zlib` and nothing else.
 *
 * ## Why this is not a dependency
 *
 * The repository carries no spreadsheet library and no ZIP library — not
 * one, in either direction — so an importer is the first thing that has
 * ever needed either. The two candidates were weighed against
 * `AGENTS.md` § "do not create speculative frameworks" and the
 * proportion of each that this feature would use:
 *
 *   `exceljs`   ~1 MB installed and a transitive tree, for styles,
 *               charts, images, pivot tables, streaming writers and
 *               formula evaluation. An importer reads a rectangle of
 *               text. It would be the largest dependency in the server
 *               and the least used.
 *   `xlsx`      the SheetJS package on the public registry is a stale
 *               fork of a project that moved to its own distribution
 *               after CVE-2023-30533 and CVE-2024-22363; the maintained
 *               builds are not on npm. Pinning a known-vulnerable
 *               version to parse UNTRUSTED uploads is the exact opposite
 *               of what this module's threat model needs.
 *
 * What is left is a ZIP central directory (a 40-year-old format, and one
 * whose reader here refuses everything it does not need) and the subset
 * of SpreadsheetML that carries cell values. That is what is below. It
 * is deliberately incapable of most of the format, which is the point:
 * an attacker's file reaches a value scanner, not a document model.
 *
 * ## The threat model, because these bytes are hostile
 *
 * The upload is user input at a trust boundary, so every known family of
 * attack against a spreadsheet parser is refused structurally rather
 * than detected:
 *
 *   zip bomb          entry count, per-entry declared size and total
 *                     inflated size are all capped BEFORE inflating, and
 *                     the inflate itself is given the same ceiling, so a
 *                     lying header cannot spend memory either.
 *   entity expansion  a DOCTYPE anywhere in a part is refused outright.
 *                     There is no entity resolution here at all — only
 *                     the five predefined entities and numeric character
 *                     references are decoded — so "billion laughs" has
 *                     nothing to expand into.
 *   XXE               the same refusal. Nothing in this module opens a
 *                     file, a URL or a socket.
 *   formula execution nothing is evaluated, ever. A formula cell's `<f>`
 *                     is ignored and its cached `<v>` is read as the
 *                     inert string it is on disk.
 *   path traversal    entry names are matched against fixed literals.
 *                     Nothing is written to disk.
 *
 * ## What it deliberately cannot do
 *
 * Dates. Excel stores a typed date as a serial number under a number
 * format, so reading one back means carrying the format table and the
 * 1900 leap-year bug. Neither register this ships for has a date column,
 * so the ceiling is real but unreached, and a cell that IS date-typed
 * arrives as its serial number and fails the target's own validation
 * with a visible row error rather than silently importing a wrong day.
 *
 * ponytail: no date deserialisation and no styles/number formats. Add
 * the serial-to-date conversion (with the 1900 leap-year correction)
 * when the first importer with a date column needs it.
 */

/* --- limits ---------------------------------------------------------------- */

/** Caps on what a single upload may expand to. Sized for the registers
 * this ships for — an organisation's whole contact book is hundreds of
 * rows, not hundreds of thousands — and every one of them is a refusal
 * rather than a truncation, because a silently shortened import is a
 * half-imported register nobody can see the edge of. */
export const XLSX_LIMITS = {
  /** Parts in the container. A real workbook of one sheet has under ten. */
  maxEntries: 64,
  /** Total inflated bytes across every part read. */
  maxInflatedBytes: 32 * 1024 * 1024,
  /** Data rows, excluding the header. */
  maxRows: 5_000,
  /** Columns read per row; anything further right is ignored, not refused,
   * because operators keep working notes off to the side of a sheet. */
  maxColumns: 64,
  /** Characters kept from one cell. Longer values are refused: every
   * column these importers write into is far shorter than this, so a cell
   * this long is a mistake worth showing rather than trimming. */
  maxCellLength: 4_000,
} as const;

/** The signature every ZIP — and therefore every .xlsx — starts with.
 * `upload-guards.ts` checks it before these bytes reach this module. */
export const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** The OOXML spreadsheet media type, spelled once. */
export const XLSX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A refusal to read the uploaded bytes at all — as distinct from a row
 * that failed its target's rules, which is data. The route turns this
 * into a 400 naming the file, never a 500. */
export class XlsxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxParseError';
  }
}

/* --- the ZIP container ----------------------------------------------------- */

const SIGNATURE_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const SIGNATURE_CENTRAL_FILE_HEADER = 0x02014b50;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/**
 * Reads the archive's central directory and inflates only the parts the
 * caller asks for.
 *
 * The central directory is authoritative, not the local headers: a local
 * header can disagree with it, and readers that trust the wrong one are
 * where ZIP-confusion bugs live. Only the two compression methods a real
 * spreadsheet writer emits are accepted; anything else is refused rather
 * than skipped, so an unreadable part can never look like an absent one.
 */
function readZipParts(bytes: Buffer, wanted: (name: string) => boolean) {
  // The end-of-central-directory record is last, but a trailing comment
  // may follow it, so it is searched for backwards over the maximum
  // comment length. Bounded, so a file of noise fails fast.
  let end = -1;
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (bytes.readUInt32LE(at) === SIGNATURE_END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) {
    throw new XlsxParseError('The file is not a readable .xlsx workbook.');
  }

  const entryCount = bytes.readUInt16LE(end + 10);
  if (entryCount > XLSX_LIMITS.maxEntries) {
    throw new XlsxParseError('The workbook contains too many parts to read.');
  }

  const parts = new Map<string, Buffer>();
  let inflatedTotal = 0;
  let at = bytes.readUInt32LE(end + 16);

  for (let index = 0; index < entryCount; index++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== SIGNATURE_CENTRAL_FILE_HEADER) {
      throw new XlsxParseError('The file is not a readable .xlsx workbook.');
    }
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const declaredSize = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localHeaderAt = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;

    if (!wanted(name)) continue;

    // The declared size is checked BEFORE anything is inflated, and the
    // inflate is then given the same ceiling — so neither an honest
    // large part nor a lying header can spend more than this.
    if (declaredSize > XLSX_LIMITS.maxInflatedBytes) {
      throw new XlsxParseError('The workbook is too large to read.');
    }
    inflatedTotal += declaredSize;
    if (inflatedTotal > XLSX_LIMITS.maxInflatedBytes) {
      throw new XlsxParseError('The workbook is too large to read.');
    }

    if (localHeaderAt + 30 > bytes.length) {
      throw new XlsxParseError('The file is not a readable .xlsx workbook.');
    }
    const dataAt =
      localHeaderAt +
      30 +
      bytes.readUInt16LE(localHeaderAt + 26) +
      bytes.readUInt16LE(localHeaderAt + 28);
    const stored = bytes.subarray(dataAt, dataAt + compressedSize);

    if (method === METHOD_STORED) {
      parts.set(name, stored);
    } else if (method === METHOD_DEFLATED) {
      try {
        parts.set(name, inflateRawSync(stored, { maxOutputLength: declaredSize }));
      } catch {
        throw new XlsxParseError('A part of the workbook could not be read.');
      }
    } else {
      throw new XlsxParseError('The workbook uses a compression this reader cannot read.');
    }
  }
  return parts;
}

/* --- SpreadsheetML --------------------------------------------------------- */

/** Decodes the only entities SpreadsheetML may contain. A part carrying a
 * DOCTYPE never reaches here — `partText` refuses it — so there is no
 * entity table to expand and nothing to resolve. */
function decodeXmlText(value: string): string {
  return value.replace(/&(#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, name: string) => {
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return "'";
    const code = name.startsWith('#x')
      ? Number.parseInt(name.slice(2), 16)
      : Number.parseInt(name.slice(1), 10);
    // Only characters XML itself admits, so a reference cannot smuggle a
    // control character or a lone surrogate into a validated value.
    if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff) return '';
    return String.fromCodePoint(code);
  });
}

/** A part's text, with the one construct that turns an XML reader into a
 * file-fetching, memory-eating oracle refused up front. */
function partText(parts: Map<string, Buffer>, name: string): string | undefined {
  const bytes = parts.get(name);
  if (bytes === undefined) return undefined;
  const text = bytes.toString('utf8');
  if (/<!DOCTYPE/i.test(text)) {
    throw new XlsxParseError('The workbook declares a document type and was not read.');
  }
  return text;
}

/** `<t>` runs concatenated — a shared string split across formatting runs
 * arrives as several `<t>` elements and is one value. */
function textRuns(fragment: string): string {
  let out = '';
  const scanner = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(fragment)) !== null) out += decodeXmlText(match[1] ?? '');
  return out;
}

/** The shared string table, which is where Excel puts nearly every string
 * it writes. A workbook without one is legal and simply has no entries. */
function readSharedStrings(parts: Map<string, Buffer>): string[] {
  const xml = partText(parts, 'xl/sharedStrings.xml');
  if (xml === undefined) return [];
  const strings: string[] = [];
  const scanner = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(xml)) !== null) strings.push(textRuns(match[1] ?? ''));
  return strings;
}

/** The zero-based column a cell reference names. `r="AB7"` is column 27.
 * Read from the reference rather than from position, because a sheet
 * omits empty cells entirely and counting siblings shifts every value in
 * the row one column left. */
function columnOf(reference: string): number {
  let column = 0;
  for (const character of reference) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
  }
  return column - 1;
}

/**
 * Every value in the first worksheet, as a rectangle of trimmed strings.
 *
 * Everything is a string on the way out — a quantity is `'12'`, not `12` —
 * because the target's own validator is the one place that decides what a
 * column means, and handing it a value this module already guessed the
 * type of would be a second, weaker validator upstream of the real one.
 */
export function readXlsxRows(bytes: Buffer): string[][] {
  const parts = readZipParts(
    bytes,
    (name) =>
      name === 'xl/sharedStrings.xml' ||
      name === 'xl/workbook.xml' ||
      name.startsWith('xl/worksheets/'),
  );

  // The first sheet in the workbook's own order, which is the order the
  // tabs appear in — not the first filename, which is arbitrary.
  const workbook = partText(parts, 'xl/workbook.xml');
  const firstSheetName = /<sheet\b[^>]*\/>/.exec(workbook ?? '')?.[0];
  const sheetPart =
    firstSheetName !== undefined && parts.has('xl/worksheets/sheet1.xml')
      ? 'xl/worksheets/sheet1.xml'
      : [...parts.keys()].filter((name) => name.startsWith('xl/worksheets/')).sort()[0];
  const sheet = sheetPart === undefined ? undefined : partText(parts, sheetPart);
  if (sheet === undefined) {
    throw new XlsxParseError('The workbook has no sheet to read.');
  }

  const shared = readSharedStrings(parts);
  const rows: string[][] = [];
  const rowScanner = /<row\b[^>]*\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowScanner.exec(sheet)) !== null) {
    // +1 for the header, which is a row like any other here.
    if (rows.length > XLSX_LIMITS.maxRows) {
      throw new XlsxParseError(
        `The sheet has more than ${String(XLSX_LIMITS.maxRows)} rows; split it and import each part.`,
      );
    }
    const row: string[] = [];
    const cellScanner = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellScanner.exec(rowMatch[2] ?? '')) !== null) {
      const attributes = cellMatch[1] ?? cellMatch[2] ?? '';
      const body = cellMatch[3] ?? '';
      const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
      const column = reference === undefined ? row.length : columnOf(reference);
      if (column < 0 || column >= XLSX_LIMITS.maxColumns) continue;

      const type = /\bt="([a-zA-Z]+)"/.exec(attributes)?.[1] ?? 'n';
      // `<f>` — the formula — is never looked at. `<v>` is its cached
      // result as the writer left it on disk, which is data.
      const cached = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value: string;
      if (type === 's') {
        const index = Number(decodeXmlText(cached ?? ''));
        value = Number.isInteger(index) ? (shared[index] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textRuns(body);
      } else if (type === 'b') {
        value = decodeXmlText(cached ?? '') === '1' ? 'TRUE' : 'FALSE';
      } else if (type === 'e') {
        // An error cell (#REF!, #DIV/0!) has no value. It arrives empty
        // and fails the target's own "this is required" rule, which says
        // something an operator can act on.
        value = '';
      } else {
        value = decodeXmlText(cached ?? '');
      }

      value = value.trim();
      if (value.length > XLSX_LIMITS.maxCellLength) {
        throw new XlsxParseError(
          `A cell in the sheet is longer than ${String(XLSX_LIMITS.maxCellLength)} characters.`,
        );
      }
      while (row.length < column) row.push('');
      row[column] = value;
    }
    rows.push(row);
  }
  return rows;
}

/* --- writing the template -------------------------------------------------- */

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** `0 -> A`, `26 -> AA`. */
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function zipPart(name: string, text: string) {
  const nameBytes = Buffer.from(name, 'utf8');
  const raw = Buffer.from(text, 'utf8');
  return { nameBytes, raw, deflated: deflateRawSync(raw), checksum: crc32(raw) };
}

/** Builds the archive. Every entry is deflated and the central directory
 * is written after the data, which is the layout every reader expects. */
function buildZip(entries: readonly (readonly [string, string])[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, text] of entries) {
    const part = zipPart(name, text);
    const local = Buffer.alloc(30 + part.nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(METHOD_DEFLATED, 8);
    local.writeUInt32LE(part.checksum, 14);
    local.writeUInt32LE(part.deflated.length, 18);
    local.writeUInt32LE(part.raw.length, 22);
    local.writeUInt16LE(part.nameBytes.length, 26);
    part.nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + part.nameBytes.length);
    central.writeUInt32LE(SIGNATURE_CENTRAL_FILE_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(METHOD_DEFLATED, 10);
    central.writeUInt32LE(part.checksum, 16);
    central.writeUInt32LE(part.deflated.length, 20);
    central.writeUInt32LE(part.raw.length, 24);
    central.writeUInt16LE(part.nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    part.nameBytes.copy(central, 46);

    locals.push(local, part.deflated);
    centrals.push(central);
    offset += local.length + part.deflated.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIGNATURE_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * A one-sheet workbook of literal text.
 *
 * Every cell is written as an INLINE STRING, including one that looks
 * like a number. Two reasons, and the second is the security one:
 *
 *   a template's example row is illustrative — `27AAAPZ1234C1ZV` is not a
 *   quantity — and a workbook that types its examples numerically opens
 *   with them right-aligned and reformatted;
 *
 *   and an inline string is never a formula. A value beginning `=`, `+`,
 *   `-` or `@` written into a cell Excel treats as typed becomes a
 *   formula when the file is opened, which is the spreadsheet-injection
 *   hazard every register export has. Nothing this function writes can
 *   become one, whatever the caller passes.
 */
export function writeXlsxWorkbook(
  sheetName: string,
  rows: readonly (readonly string[])[],
): Buffer {
  const sheetRows = rows
    .map((cells, rowIndex) => {
      const reference = rowIndex + 1;
      const written = cells
        .map(
          (value, columnIndex) =>
            `<c r="${columnName(columnIndex)}${String(reference)}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`,
        )
        .join('');
      return `<row r="${String(reference)}">${written}</row>`;
    })
    .join('');

  return buildZip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${escapeXml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<sheetData>${sheetRows}</sheetData>` +
        '</worksheet>',
    ],
  ]);
}
