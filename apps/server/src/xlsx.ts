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
  /**
   * Total EXPANDED characters across every cell of the sheet, and the one
   * limit that is not obvious from the others.
   *
   * `maxInflatedBytes` bounds the parts as they sit in the archive. It
   * does not bound what they expand to, because a SHARED STRING is stored
   * once and referenced by any number of cells: 5,000 rows x 20 columns
   * all pointing at one 4,000-character entry is a ~50 KB upload that
   * resolves to 400 million characters — and then that rectangle is
   * serialised into jsonb, read back, and serialised again, so the peak is
   * several times worse. Every other cap in this list passes it.
   *
   * Sized against the honest worst case rather than the theoretical one.
   * The widest register here has twenty columns, and a contact row is
   * tens of characters per column, not thousands: 5,000 rows of twenty
   * 30-character columns is 3 million. Sixteen million leaves five times
   * that headroom and still refuses the amplified case by two orders of
   * magnitude. The refusal names the sheet, not the trick, because an
   * operator who has genuinely hit it needs to split the file either way.
   */
  maxExpandedChars: 16_000_000,
} as const;

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
    if (
      at + 46 > bytes.length ||
      bytes.readUInt32LE(at) !== SIGNATURE_CENTRAL_FILE_HEADER
    ) {
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
    // DUPLICATE ENTRY NAMES ARE REFUSED, not resolved. A ZIP may carry two
    // entries with one name, and readers disagree about which wins —
    // Excel takes the first, a last-wins reader takes the second. That
    // disagreement is a primitive for showing one workbook and importing
    // another, so neither answer is taken.
    if (parts.has(name)) {
      throw new XlsxParseError('The workbook contains the same part twice.');
    }

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
      // Stored means the two sizes are the same value by definition; a
      // header that says otherwise is describing a part this reader
      // cannot account for, and the budget above was charged the size it
      // claimed rather than the size it is.
      if (compressedSize !== declaredSize) {
        throw new XlsxParseError('A part of the workbook could not be read.');
      }
      parts.set(name, stored);
    } else if (method === METHOD_DEFLATED) {
      try {
        parts.set(name, inflateRawSync(stored, { maxOutputLength: declaredSize }));
      } catch {
        throw new XlsxParseError('A part of the workbook could not be read.');
      }
    } else {
      throw new XlsxParseError(
        'The workbook uses a compression this reader cannot read.',
      );
    }
  }
  return parts;
}

/* --- SpreadsheetML --------------------------------------------------------- */

/** Decodes the only entities SpreadsheetML may contain. A part carrying a
 * DOCTYPE never reaches here — `partText` refuses it — so there is no
 * entity table to expand and nothing to resolve. */
function decodeXmlText(value: string): string {
  return value.replace(
    /&(#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g,
    (whole, name: string) => {
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
      // 0xD800-0xDFFF is the surrogate range: `String.fromCodePoint` will
      // happily produce a lone surrogate from one, which is an unpaired
      // UTF-16 unit that survives every length check and then breaks
      // whatever finally encodes it.
      if (
        !Number.isInteger(code) ||
        code < 0x20 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return '';
      }
      return String.fromCodePoint(code);
    },
  );
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

/**
 * Every `<name ...>...</name>` (and `<name .../>`) in a fragment, found by
 * WALKING the string rather than backtracking through it.
 *
 * This replaced four lazy-quantifier regexes — rows, cells, shared-string
 * items and text runs — and the reason is a measurement rather than a
 * preference. A pattern of the shape `<row\b[^>]*>([\s\S]*?)<\/row>` is
 * O(n^2) on a part full of `<row` with no `</row>`: every start position
 * rescans the remaining text before failing, which is 686 ms at 160 KB and
 * hours at the sizes `maxInflatedBytes` allows. A hostile part is a
 * plausible upload, so the scanner has to be linear on one.
 *
 * `indexOf` from a moving cursor is that: each character is examined a
 * bounded number of times, and an unterminated element ends the walk
 * instead of restarting it.
 */
interface XmlElement {
  readonly attributes: string;
  readonly body: string;
}

/** Whether the character after `<name` ends the element name, so `<row`
 * does not also match `<rowBreaks`. */
function endsName(character: string | undefined): boolean {
  return (
    character === undefined ||
    character === '>' ||
    character === '/' ||
    /\s/.test(character)
  );
}

/** How many times an element OPENS in a fragment. Counted before any body
 * is read, so a refusal for too many rows fires on a part that opens five
 * million of them and closes none — which the old scanner could not do,
 * because its guard sat inside a match loop that never ran. */
function countOpenings(text: string, name: string): number {
  const token = `<${name}`;
  let count = 0;
  for (
    let at = text.indexOf(token);
    at >= 0;
    at = text.indexOf(token, at + token.length)
  ) {
    if (endsName(text[at + token.length])) count += 1;
  }
  return count;
}

function elements(text: string, name: string): XmlElement[] {
  const token = `<${name}`;
  const closing = `</${name}>`;
  const found: XmlElement[] = [];
  let at = text.indexOf(token);

  while (at >= 0) {
    const nameEnd = at + token.length;
    if (!endsName(text[nameEnd])) {
      at = text.indexOf(token, nameEnd);
      continue;
    }
    const tagEnd = text.indexOf('>', nameEnd);
    // An element whose start tag never closes ends the walk. There is
    // nothing after it that can be read, and continuing would be the
    // rescan this function exists to avoid.
    if (tagEnd < 0) break;
    const attributes = text.slice(nameEnd, tagEnd);

    if (attributes.endsWith('/')) {
      found.push({ attributes: attributes.slice(0, -1), body: '' });
      at = text.indexOf(token, tagEnd + 1);
      continue;
    }
    const bodyEnd = text.indexOf(closing, tagEnd + 1);
    if (bodyEnd < 0) break;
    found.push({ attributes, body: text.slice(tagEnd + 1, bodyEnd) });
    at = text.indexOf(token, bodyEnd + closing.length);
  }
  return found;
}

/** The value of one attribute of a start tag. */
function attribute(attributes: string, name: string): string | undefined {
  const at = attributes.indexOf(`${name}="`);
  if (at < 0) return undefined;
  const from = at + name.length + 2;
  const to = attributes.indexOf('"', from);
  return to < 0 ? undefined : attributes.slice(from, to);
}

/** `<t>` runs concatenated — a shared string split across formatting runs
 * arrives as several `<t>` elements and is one value.
 *
 * `<rPh>` is dropped first. It carries the PHONETIC reading of a run
 * (furigana), which Excel stores as `<t>` elements inside the same `<si>`;
 * concatenating them appends a pronunciation guide to the value an
 * operator typed. Rare in this domain and wrong every time it happens.
 */
function textRuns(fragment: string): string {
  let remaining = fragment;
  for (const phonetic of elements(fragment, 'rPh')) {
    remaining = remaining.replace(
      `<rPh${phonetic.attributes}>${phonetic.body}</rPh>`,
      '',
    );
  }
  let out = '';
  for (const run of elements(remaining, 't')) out += decodeXmlText(run.body);
  return out;
}

/** The shared string table, which is where Excel puts nearly every string
 * it writes. A workbook without one is legal and simply has no entries. */
function readSharedStrings(parts: Map<string, Buffer>): string[] {
  const xml = partText(parts, 'xl/sharedStrings.xml');
  if (xml === undefined) return [];
  return elements(xml, 'si').map((item) => textRuns(item.body));
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
 * Which part holds the FIRST TAB of the workbook.
 *
 * Resolved properly rather than guessed, because both guesses are wrong in
 * ordinary files. `xl/worksheets/sheet1.xml` is not the first tab of a
 * workbook whose sheets have been reordered — the filenames record the
 * order the sheets were CREATED. And a lexicographic sort puts `sheet10`
 * before `sheet2`. Either way an operator reorders their tabs and the
 * importer silently reads a different sheet than the one they are looking
 * at.
 *
 * The real answer is two hops: `xl/workbook.xml` lists the sheets in tab
 * order, each naming a relationship id, and `xl/_rels/workbook.xml.rels`
 * maps that id to the part.
 */
function firstSheetPart(parts: Map<string, Buffer>): string | undefined {
  const worksheets = [...parts.keys()].filter((name) =>
    name.startsWith('xl/worksheets/'),
  );
  const workbook = partText(parts, 'xl/workbook.xml');
  const rels = partText(parts, 'xl/_rels/workbook.xml.rels');

  if (workbook !== undefined && rels !== undefined) {
    const sheets = elements(workbook, 'sheets')[0];
    const [first] = elements(sheets?.body ?? workbook, 'sheet');
    const relationshipId =
      first === undefined ? undefined : attribute(first.attributes, 'r:id');
    if (relationshipId !== undefined) {
      for (const relationship of elements(rels, 'Relationship')) {
        if (attribute(relationship.attributes, 'Id') !== relationshipId) continue;
        const target = attribute(relationship.attributes, 'Target');
        if (target === undefined) break;
        // Targets are relative to `xl/`, and may or may not say so.
        const resolved = target.startsWith('/')
          ? target.slice(1)
          : `xl/${target.replace(/^\.\//, '')}`;
        if (parts.has(resolved)) return resolved;
        break;
      }
    }
  }
  // A workbook this reader cannot navigate still has exactly one sheet in
  // the overwhelming majority of real cases, so the fallback reads it
  // rather than refusing outright.
  if (worksheets.length === 1) return worksheets[0];
  return worksheets.includes('xl/worksheets/sheet1.xml')
    ? 'xl/worksheets/sheet1.xml'
    : worksheets.sort()[0];
}

/** One row of the sheet, carrying the number the operator sees in Excel's
 * left margin rather than its position among the rows that happen to be
 * present. */
export interface SheetRow {
  /** The `r` attribute, 1-based, as the sheet states it. */
  readonly rowNumber: number;
  readonly cells: readonly string[];
}

/**
 * Every value in the first worksheet, as rows of trimmed strings.
 *
 * Everything is a string on the way out — a quantity is `'12'`, not `12` —
 * because the target's own validator is the one place that decides what a
 * column means, and handing it a value this module already guessed the
 * type of would be a second, weaker validator upstream of the real one.
 */
export function readXlsxRows(bytes: Buffer): SheetRow[] {
  const parts = readZipParts(
    bytes,
    (name) =>
      name === 'xl/sharedStrings.xml' ||
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name.startsWith('xl/worksheets/'),
  );

  const sheetPart = firstSheetPart(parts);
  const sheet = sheetPart === undefined ? undefined : partText(parts, sheetPart);
  if (sheet === undefined) {
    throw new XlsxParseError('The workbook has no sheet to read.');
  }

  // BEFORE any body is read. A part that opens five million rows is
  // refused on the count, whether or not it ever closes one.
  if (countOpenings(sheet, 'row') > XLSX_LIMITS.maxRows + 1) {
    throw new XlsxParseError(
      `The sheet has more than ${String(XLSX_LIMITS.maxRows)} rows; split it and import each part.`,
    );
  }

  const shared = readSharedStrings(parts);
  const rows: SheetRow[] = [];
  let expanded = 0;
  let position = 0;

  for (const rowElement of elements(sheet, 'row')) {
    position += 1;
    // The `r` attribute, not the position. Excel omits rows nobody ever
    // populated, so a sheet whose data resumes at row 40 after a blank
    // block has thirty-eight fewer `<row>` elements than rows — and every
    // error message after that gap would name a line the operator cannot
    // find. Positional numbering is the fallback for a sheet that states
    // no `r`, which is legal and rare.
    const stated = Number(attribute(rowElement.attributes, 'r') ?? '');
    const rowNumber = Number.isInteger(stated) && stated > 0 ? stated : position;

    const cells: string[] = [];
    for (const cellElement of elements(rowElement.body, 'c')) {
      const reference = attribute(cellElement.attributes, 'r');
      const column = reference === undefined ? cells.length : columnOf(reference);
      if (column < 0 || column >= XLSX_LIMITS.maxColumns) continue;

      const type = attribute(cellElement.attributes, 't') ?? 'n';
      // `<f>` — the formula — is never looked at. `<v>` is its cached
      // result as the writer left it on disk, which is data.
      const cached = elements(cellElement.body, 'v')[0]?.body;
      let value: string;
      if (type === 's') {
        // A shared-string cell with no `<v>`, or an empty one, is an EMPTY
        // CELL — not entry zero. `Number('')` is 0 and
        // `Number.isInteger(0)` is true, so the obvious spelling of this
        // check silently imports the first string in the table (in
        // practice a column header) wherever a required cell was left
        // blank.
        const raw = cached === undefined ? '' : decodeXmlText(cached).trim();
        const index = raw.length === 0 ? Number.NaN : Number(raw);
        value = Number.isInteger(index) && index >= 0 ? (shared[index] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textRuns(cellElement.body);
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
      // Charged AFTER the shared-string lookup, which is the whole point:
      // the archive is small and the rectangle it resolves to is not.
      expanded += value.length;
      if (expanded > XLSX_LIMITS.maxExpandedChars) {
        throw new XlsxParseError(
          'The sheet holds more text than this importer will read; split it and import each part.',
        );
      }
      while (cells.length < column) cells.push('');
      cells[column] = value;
    }
    rows.push({ rowNumber, cells });
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
 *
 * EVERY COLUMN IS DECLARED TEXT, and that is the half that matters after
 * the operator starts typing. Inline strings only govern what THIS file
 * contains; the moment somebody types into a General column, Excel
 * decides what they meant. It drops the leading zero from a `022`
 * telephone code, renders a sixteen-digit bank account in scientific
 * notation and then hands back `3.01235E+15`, and turns `01/04` into a
 * date. Two of those columns are the ones this feature exists to carry
 * accurately — a payment advice built from a mangled account number fails
 * at the bank, which is the damage path the import authority's MFA
 * classification is written around.
 *
 * A `<cols>` span carrying a style whose number format is `49` (`@`, the
 * Text format) makes the whole column text before anything is typed into
 * it, which is what a hand-made template cannot promise.
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
            `<c r="${columnName(columnIndex)}${String(reference)}" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`,
        )
        .join('');
      return `<row r="${String(reference)}">${written}</row>`;
    })
    .join('');

  // The widest row decides how far the Text span reaches. A column an
  // operator adds beyond it is theirs and gets Excel's own default, which
  // is correct — this importer would ignore it anyway.
  const width = Math.max(1, ...rows.map((cells) => cells.length));
  const textColumns = `<cols><col min="1" max="${String(width)}" style="1" width="18" customWidth="1"/></cols>`;

  return buildZip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
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
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    ],
    [
      // The smallest styles part Excel will open: the five collections it
      // requires in the order it requires them, one default format and one
      // that is `numFmtId="49"` — the built-in `@`, Text. `cellXfs` index
      // 1 is what `s="1"` on a cell and `style="1"` on a column both name.
      'xl/styles.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
        '<borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '</cellXfs>' +
        '</styleSheet>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        textColumns +
        `<sheetData>${sheetRows}</sheetData>` +
        '</worksheet>',
    ],
  ]);
}

/* --- writing a register ---------------------------------------------------- */

/**
 * ONE ZIP LAYER, TWO WRITERS, and the difference between them is the point.
 *
 * `writeXlsxWorkbook` above builds an import TEMPLATE: every cell an inline
 * string, every column declared Text, because an operator is about to type a
 * bank account and a telephone code into it and Excel must not reinterpret
 * either. `buildXlsx` below builds a register EXPORT: the operator is going
 * to sum the money column, so a money column has to arrive as a number.
 *
 * One function with a flag is worse than two: the template's Text `<cols>`
 * span would fight the numeric cells, and the two writers have opposite
 * defaults for exactly the reason each exists. They share what is genuinely
 * shared — `buildZip`, `escapeXml`, `columnName` — and nothing else.
 *
 * This module arrived TWICE in one wave, hand-rolled on `node:zlib` by two
 * packs independently (the importer needed a reader, the registers needed a
 * writer). This is the reconciliation, and most of it was deletion: one ZIP
 * writer, one XML escaper and one column-name helper went away.
 */

/** One column of an exported register. */
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
   *
   * A text cell here is an `inlineStr` exactly as the template writer's is,
   * so the spreadsheet-injection hazard is closed the same way: Excel has
   * nothing to parse, because the XML says the value is a string.
   */
  readonly numeric?: boolean;
}

/** A cell value: the register's own string, or null for an empty cell. */
export type XlsxValue = string | null;

/**
 * Whether a value is a plain decimal — no exponent, no thousands separator,
 * no currency symbol — and therefore safe to write into a NUMERIC cell.
 * Anything else becomes text.
 *
 * Written as a scan rather than as a pattern. The obvious regex is linear
 * and perfectly safe, and the security linter flags it anyway on a heuristic
 * about a quantifier beside an optional group. Ten boring lines settle that
 * argument permanently, and bound both halves besides: eighteen integer
 * digits and six decimals reach past the widest column this schema has.
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

/**
 * The C0 controls XML 1.0 cannot carry in any form. Tab, newline and
 * carriage return are legal and survive; a stray 0x00 in a free-text remark
 * would otherwise make the whole workbook unreadable rather than that one
 * cell wrong.
 *
 * Only the register writer needs it: a template's cells are this
 * repository's own header strings, while a register's are whatever an
 * operator once pasted into a remark field.
 */
function withoutControlCharacters(value: string): string {
  let text = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    text += character;
  }
  return text;
}

function cellXml(reference: string, value: XlsxValue, numeric: boolean): string {
  if (value === null || value === '') return '';
  if (numeric && isPlainDecimal(value)) {
    return `<c r="${reference}"><v>${value}</v></c>`;
  }
  const text = escapeXml(withoutControlCharacters(value));
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

/** Sheet names may not exceed 31 characters and may not contain any of
 * `: \ / ? * [ ]`. Excel refuses to open a workbook that breaks either rule,
 * so the name is repaired here rather than trusted. */
function safeSheetName(name: string): string {
  const cleaned = name.replaceAll(/[:\\/?*[\]]/g, ' ').trim();
  const trimmed = cleaned.slice(0, 31).trim();
  return trimmed.length === 0 ? 'Sheet1' : trimmed;
}

/**
 * One register, one sheet, as .xlsx bytes.
 *
 * `rows` is positional against `columns`: a short row leaves its trailing
 * cells empty rather than throwing, because a register whose optional tail
 * columns are absent is a normal register and not a programming error.
 *
 * No styles part and no `<cols>` span, unlike the template above: an
 * exported register is read and summed rather than typed into, so the
 * reader's own widths and formats are the right ones.
 */
export function buildXlsx(
  sheetName: string,
  columns: readonly XlsxColumn[],
  rows: readonly (readonly XlsxValue[])[],
): Buffer {
  const header = columns
    .map((column, index) => cellXml(`${columnName(index)}1`, column.header, false))
    .join('');
  const body = rows
    .map((row, rowIndex) => {
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
      return `<row r="${String(number)}">${cells}</row>`;
    })
    .join('');

  return buildZip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        `<Override PartName="/xl/workbook.xml" ContentType="${XLSX_MEDIA_TYPE}.main+xml"/>` +
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
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${escapeXml(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>` +
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
        `<sheetData><row r="1">${header}</row>${body}</sheetData>` +
        '</worksheet>',
    ],
  ]);
}
