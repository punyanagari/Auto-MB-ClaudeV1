import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  XLSX_LIMITS,
  XlsxParseError,
  buildXlsx,
  readXlsxRows,
  writeXlsxWorkbook,
} from '../src/xlsx.js';

/**
 * The reader, attacked as the untrusted input it reads.
 *
 * A unit suite rather than part of `imports.integration.test.ts`, because
 * every case here is a pure function of some bytes and none of them needs
 * a database, an organisation or a session. The route-level half — what a
 * refusal becomes on the wire, and what the staged rows look like
 * afterwards — stays there.
 *
 * ## Why the fixtures are hand-built
 *
 * `writeXlsxWorkbook` and `readXlsxRows` live in the same file, so a suite
 * that only round-trips the writer proves they agree and nothing else. The
 * writer emits inline strings, one sheet, deflated parts and a dense
 * rectangle. Real workbooks — and hostile ones — do none of that. So the
 * builder below writes ZIPs directly: STORED or DEFLATED, with the sizes
 * the header claims rather than the sizes the data has, and with whatever
 * sheet XML a case needs.
 *
 * Every limit in `XLSX_LIMITS` has a case here that trips it. The header
 * of `xlsx.ts` claims a threat model; this is the file that makes the
 * claim checkable.
 */

interface Entry {
  readonly name: string;
  readonly text: string;
  /** Deflated when true, stored when false. Real writers use both. */
  readonly deflate?: boolean;
  /** Overrides the uncompressed size written into both headers, so a
   * lying header can be built on purpose. */
  readonly declaredSize?: number;
  /** Overrides the compression method, for the "reader cannot read
   * this" refusal. */
  readonly method?: number;
}

/** A ZIP, built to order — including invalid ones. */
function zip(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.text, 'utf8');
    const data = entry.deflate === true ? deflateRawSync(raw) : raw;
    const method = entry.method ?? (entry.deflate === true ? 8 : 0);
    const declared = entry.declaredSize ?? raw.length;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const WORKBOOK_XML =
  '<?xml version="1.0"?><workbook xmlns:r="http://x"><sheets>' +
  '<sheet name="One" sheetId="1" r:id="rId1"></sheet></sheets></workbook>';
const WORKBOOK_RELS =
  '<?xml version="1.0"?><Relationships>' +
  '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';

/** The ordinary case every hostile one is a deviation from. */
function workbook(
  sheetXml: string,
  options: {
    readonly shared?: readonly string[];
    readonly deflate?: boolean;
    readonly extra?: readonly Entry[];
    readonly workbookXml?: string;
    readonly relsXml?: string;
  } = {},
): Buffer {
  const entries: Entry[] = [
    { name: 'xl/workbook.xml', text: options.workbookXml ?? WORKBOOK_XML },
    { name: 'xl/_rels/workbook.xml.rels', text: options.relsXml ?? WORKBOOK_RELS },
    {
      name: 'xl/worksheets/sheet1.xml',
      text: `<?xml version="1.0"?><worksheet><sheetData>${sheetXml}</sheetData></worksheet>`,
      ...(options.deflate === true ? { deflate: true } : {}),
    },
  ];
  if (options.shared !== undefined) {
    entries.push({
      name: 'xl/sharedStrings.xml',
      // A value that already looks like markup is its own `<si>` body, so
      // a case can hand in formatting runs or a phonetic block.
      text: `<?xml version="1.0"?><sst>${options.shared
        .map((value) => `<si>${value.startsWith('<') ? value : `<t>${value}</t>`}</si>`)
        .join('')}</sst>`,
      ...(options.deflate === true ? { deflate: true } : {}),
    });
  }
  return zip([...entries, ...(options.extra ?? [])]);
}

describe('reading real workbooks', () => {
  it('reads shared strings, sparse cells and a deflated part', () => {
    const bytes = workbook(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42</v></c></row>',
      { shared: ['Designation', 'Address', 'Acme &amp; Co'], deflate: true },
    );
    const rows = readXlsxRows(bytes);
    // Column C is index 2 although B is absent: the reference decides the
    // column, never the position among siblings.
    expect(rows[0]?.cells).toEqual(['Designation', '', 'Address']);
    expect(rows[1]?.cells).toEqual(['Acme & Co', '', '42']);
    // DEFLATED, which the first version of this suite never exercised —
    // every fixture it had was STORED, so the inflate path and its
    // output ceiling never ran in any test.
    expect(rows).toHaveLength(2);
  });

  it('never evaluates a formula, reading only the value on disk', () => {
    const bytes = workbook(
      '<row r="1"><c r="A1" t="str"><f>CONCATENATE("a","b")</f><v>ab</v></c></row>',
    );
    expect(readXlsxRows(bytes)[0]?.cells).toEqual(['ab']);
  });

  it('drops the phonetic reading rather than appending it to the value', () => {
    const bytes = workbook('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', {
      shared: ['<t>Tokyo</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh>'],
    });
    // The `<si>` above holds the value and its furigana; concatenating
    // both would import "Tokyoトウキョウ".
    expect(readXlsxRows(bytes)[0]?.cells[0]).toBe('Tokyo');
  });
});

describe('the row numbers an error message quotes', () => {
  it('uses the number the sheet states, not the position of the element', () => {
    // Excel omits rows nobody ever populated. Positionally these are
    // rows 1, 2 and 3; in the operator's window they are 1, 2 and 40,
    // and an error against "row 3" sends them to the wrong line.
    const bytes = workbook(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Designation</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>First</t></is></c></row>' +
        '<row r="40"><c r="A40" t="inlineStr"><is><t>After the gap</t></is></c></row>',
    );
    expect(readXlsxRows(bytes).map((row) => row.rowNumber)).toEqual([1, 2, 40]);
  });

  it('falls back to position for a sheet that states no row numbers', () => {
    const bytes = workbook(
      '<row><c r="A1" t="inlineStr"><is><t>One</t></is></c></row>' +
        '<row><c r="A2" t="inlineStr"><is><t>Two</t></is></c></row>',
    );
    expect(readXlsxRows(bytes).map((row) => row.rowNumber)).toEqual([1, 2]);
  });
});

describe('the first tab', () => {
  it('follows the relationship rather than the filename', () => {
    // Sheets reordered: the first TAB is sheet2.xml, because the
    // filenames record creation order. Reading sheet1.xml would import a
    // different sheet than the one the operator is looking at.
    const bytes = zip([
      {
        name: 'xl/workbook.xml',
        text:
          '<?xml version="1.0"?><workbook xmlns:r="http://x"><sheets>' +
          '<sheet name="Second" sheetId="2" r:id="rId2"/>' +
          '<sheet name="First" sheetId="1" r:id="rId1"/>' +
          '</sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        text:
          '<?xml version="1.0"?><Relationships>' +
          '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>' +
          '</Relationships>',
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        text: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>WRONG</t></is></c></row></sheetData></worksheet>',
      },
      {
        name: 'xl/worksheets/sheet2.xml',
        text: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>RIGHT</t></is></c></row></sheetData></worksheet>',
      },
    ]);
    expect(readXlsxRows(bytes)[0]?.cells[0]).toBe('RIGHT');
  });

  it('reads a non-self-closing sheet element and a sheet10 workbook', () => {
    // `sheet10` sorts before `sheet2` lexicographically, which is the
    // other way the guess goes wrong.
    const bytes = zip([
      {
        name: 'xl/workbook.xml',
        text:
          '<?xml version="1.0"?><workbook xmlns:r="http://x"><sheets>' +
          '<sheet name="Tenth" sheetId="10" r:id="rId10"></sheet>' +
          '</sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        text: '<?xml version="1.0"?><Relationships><Relationship Id="rId10" Target="./worksheets/sheet10.xml"/></Relationships>',
      },
      {
        name: 'xl/worksheets/sheet10.xml',
        text: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>TENTH</t></is></c></row></sheetData></worksheet>',
      },
      {
        name: 'xl/worksheets/sheet2.xml',
        text: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SECOND</t></is></c></row></sheetData></worksheet>',
      },
    ]);
    expect(readXlsxRows(bytes)[0]?.cells[0]).toBe('TENTH');
  });
});

describe('a shared-string cell with nothing in it', () => {
  it('is an empty cell, not the first entry of the table', () => {
    // `Number('')` is 0 and `Number.isInteger(0)` is true, so the obvious
    // spelling of the lookup resolves an empty required cell to
    // `shared[0]` — in practice a column header — and imports it as
    // data. Silent, and wrong in the one place it matters.
    const bytes = workbook(
      '<row r="1">' +
        '<c r="A1" t="s"><v>1</v></c>' +
        '<c r="B1" t="s"><v></v></c>' +
        '<c r="C1" t="s"/>' +
        '</row>',
      { shared: ['Designation', 'Real value'] },
    );
    expect(readXlsxRows(bytes)[0]?.cells).toEqual(['Real value', '', '']);
  });
});

describe('the limits, each tripped', () => {
  it('refuses a sheet that opens more rows than the cap, even closing none', () => {
    // THE QUADRATIC CASE. A lazy `<row …>([\\s\\S]*?)<\\/row>` rescans the
    // rest of the part from every start position before failing, which
    // is hundreds of milliseconds at 160 KB and hours at the sizes the
    // inflated-bytes cap allows. And the old row-count guard sat inside
    // the match loop, so on a part with zero matches it never ran at
    // all. Both halves are what this asserts: refused, and quickly.
    const hostile = '<row r="1">'.repeat(XLSX_LIMITS.maxRows + 50);
    const bytes = workbook(hostile);
    const started = Date.now();
    expect(() => readXlsxRows(bytes)).toThrow(XlsxParseError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses an unterminated row without scanning for one that is not there', () => {
    const hostile = `<row r="1">${'<c r="A1">'.repeat(20_000)}`;
    const bytes = workbook(hostile);
    const started = Date.now();
    // Either answer is correct — there is no closed row to read, so the
    // sheet is empty — but it has to be reached in bounded time.
    expect(readXlsxRows(bytes)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses a sheet whose cells expand past the text budget', () => {
    // THE AMPLIFICATION. One shared entry, referenced by every cell of
    // every row: a tiny deflated archive that resolves to hundreds of
    // millions of characters. `maxInflatedBytes` bounds the PART, which
    // is why it does not catch this.
    const entry = 'x'.repeat(XLSX_LIMITS.maxCellLength);
    const columns = 20;
    const rows = Math.ceil(XLSX_LIMITS.maxExpandedChars / (columns * entry.length)) + 5;
    let sheet = '';
    for (let row = 1; row <= rows; row++) {
      let cells = '';
      for (let column = 0; column < columns; column++) {
        cells += `<c r="${String.fromCharCode(65 + column)}${String(row)}" t="s"><v>0</v></c>`;
      }
      sheet += `<row r="${String(row)}">${cells}</row>`;
    }
    const bytes = workbook(sheet, { shared: [entry], deflate: true });
    // The archive really is small; the rectangle it names is not.
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
    expect(() => readXlsxRows(bytes)).toThrow(/more text than this importer will read/);
  });

  it('refuses a cell longer than the cell cap', () => {
    const bytes = workbook(
      `<row r="1"><c r="A1" t="inlineStr"><is><t>${'y'.repeat(XLSX_LIMITS.maxCellLength + 1)}</t></is></c></row>`,
    );
    expect(() => readXlsxRows(bytes)).toThrow(/longer than/);
  });

  it('refuses a container with more parts than the cap', () => {
    const filler = Array.from(
      { length: XLSX_LIMITS.maxEntries + 1 },
      (_unused, index) => ({
        name: `xl/filler${String(index)}.xml`,
        text: '<x/>',
      }),
    );
    expect(() => readXlsxRows(zip(filler))).toThrow(/too many parts/);
  });

  it('refuses a part whose header lies about how big it inflates to', () => {
    // The declared size is what the budget is charged and what the
    // inflate is ceilinged at, so a header claiming a gigabyte is
    // refused before a byte is spent on it.
    const bytes = workbook('<row r="1"><c r="A1"><v>1</v></c></row>', {
      extra: [
        {
          name: 'xl/worksheets/sheet9.xml',
          text: '<x/>',
          deflate: true,
          declaredSize: XLSX_LIMITS.maxInflatedBytes + 1,
        },
      ],
    });
    expect(() => readXlsxRows(bytes)).toThrow(/too large to read/);
  });

  it('refuses a stored part whose two sizes disagree', () => {
    const bytes = workbook('<row r="1"><c r="A1"><v>1</v></c></row>', {
      extra: [{ name: 'xl/worksheets/sheet9.xml', text: '<x/>', declaredSize: 9_999 }],
    });
    expect(() => readXlsxRows(bytes)).toThrow(XlsxParseError);
  });

  it('refuses a compression method it does not implement', () => {
    const bytes = zip([
      { name: 'xl/workbook.xml', text: WORKBOOK_XML },
      { name: 'xl/_rels/workbook.xml.rels', text: WORKBOOK_RELS },
      // 14 is LZMA. Skipping it would make an unreadable part look like
      // an absent one, which is how a reader silently imports nothing.
      { name: 'xl/worksheets/sheet1.xml', text: '<worksheet/>', method: 14 },
    ]);
    expect(() => readXlsxRows(bytes)).toThrow(/compression this reader cannot read/);
  });
});

describe('the container itself', () => {
  it('refuses two entries claiming one name', () => {
    // Excel takes the first, a last-wins reader takes the second, and
    // that disagreement is a primitive for showing one workbook and
    // importing another. Neither answer is taken.
    const bytes = zip([
      { name: 'xl/workbook.xml', text: WORKBOOK_XML },
      { name: 'xl/_rels/workbook.xml.rels', text: WORKBOOK_RELS },
      {
        name: 'xl/worksheets/sheet1.xml',
        text: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SHOWN</t></is></c></row></sheetData></worksheet>',
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        text: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>IMPORTED</t></is></c></row></sheetData></worksheet>',
      },
    ]);
    expect(() => readXlsxRows(bytes)).toThrow(/same part twice/);
  });

  it('refuses a part that declares a document type', () => {
    const bytes = workbook('<row r="1"><c r="A1"><v>1</v></c></row>', {
      workbookXml: `<!DOCTYPE x [<!ENTITY a "boom">]>${WORKBOOK_XML}`,
    });
    expect(() => readXlsxRows(bytes)).toThrow(/declares a document type/);
  });

  it('refuses bytes that are not an archive at all', () => {
    expect(() => readXlsxRows(Buffer.from('%PDF-1.7 not a workbook'))).toThrow(
      XlsxParseError,
    );
  });

  it('drops a character reference that would smuggle a lone surrogate', () => {
    const bytes = workbook(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>a&#xD800;b</t></is></c></row>',
    );
    // An unpaired UTF-16 unit survives every length check and then breaks
    // whatever finally encodes it, so the reference resolves to nothing.
    expect(readXlsxRows(bytes)[0]?.cells[0]).toBe('ab');
  });
});

describe('the template it writes', () => {
  it('declares every column Text so Excel keeps what is typed into it', () => {
    // The damage path the import authority's MFA classification is
    // written around: a General column drops the leading zero from a
    // phone code and renders a sixteen-digit account number as
    // 3.01235E+15, and a payment advice built from that fails at the
    // bank.
    const bytes = writeXlsxWorkbook('Contacts', [
      ['Phone', 'Bank account number'],
      ['022 1234', '3012345678901234'],
    ]);
    const text = bytes.toString('latin1');
    expect(text).toContain('xl/styles.xml');
    const rows = readXlsxRows(bytes);
    expect(rows[1]?.cells).toEqual(['022 1234', '3012345678901234']);
  });

  it('round-trips through the reader', () => {
    const bytes = writeXlsxWorkbook('Contacts', [
      ['Designation', 'Address'],
      ['Acme & Co <Ltd>', 'Bhusawal'],
    ]);
    const rows = readXlsxRows(bytes);
    expect(rows.map((row) => row.rowNumber)).toEqual([1, 2]);
    expect(rows[1]?.cells).toEqual(['Acme & Co <Ltd>', 'Bhusawal']);
  });
});

/* --- the register writer ---------------------------------------------------- */

/**
 * The worksheet part of a workbook this module just produced, as text.
 *
 * `readXlsxRows` above answers what a cell SAYS, and for the register
 * writer that is not enough: the property under test is what a cell IS. A
 * money cell must be a typed number the operator can sum, and a remark cell
 * must be an inline string Excel will never parse as a formula — and both
 * read back through the reader as the same string. So this one assertion
 * family looks at the XML.
 */
function sheetXml(archive: Buffer): string {
  const end = archive.lastIndexOf(Buffer.from('504b0506', 'hex'));
  expect(end, 'no end-of-central-directory record').toBeGreaterThan(-1);
  const count = archive.readUInt16LE(end + 8);
  let cursor = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name === 'xl/worksheets/sheet1.xml') {
      const start =
        localOffset +
        30 +
        archive.readUInt16LE(localOffset + 26) +
        archive.readUInt16LE(localOffset + 28);
      return inflateRawSync(archive.subarray(start, start + compressedSize)).toString(
        'utf8',
      );
    }
    cursor += 46 + nameLength;
  }
  throw new Error('no worksheet part');
}

describe('the register it writes', () => {
  it('writes a numeric column as a number and everything else as text', () => {
    const sheet = sheetXml(
      buildXlsx(
        'Invoices',
        [{ header: 'Number' }, { header: 'Total', numeric: true }],
        [['INV/1', '184610.50']],
      ),
    );
    // The money cell carries the server's own decimal string verbatim,
    // with no type attribute — which is what makes it a number Excel will
    // sum. Nothing in this process parsed or re-formatted it.
    expect(sheet).toContain('<c r="B2"><v>184610.50</v></c>');
    expect(sheet).toContain('<c r="A2" t="inlineStr">');
  });

  it('falls back to text when a numeric column holds something that is not a number', () => {
    // A register legitimately prints a dash for "not applicable", and a
    // `<v>—</v>` cell makes the whole workbook unreadable rather than that
    // one cell wrong.
    const sheet = sheetXml(
      buildXlsx('Invoices', [{ header: 'Total', numeric: true }], [['—']]),
    );
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).not.toContain('<v>');
  });

  it('round-trips its values through the reader', () => {
    const rows = readXlsxRows(
      buildXlsx(
        'Works',
        [{ header: 'Code' }, { header: 'Value', numeric: true }],
        [['Acme & Co <Ltd>', '1250000.00']],
      ),
    );
    expect(rows.map((row) => row.rowNumber)).toEqual([1, 2]);
    expect(rows[1]?.cells).toEqual(['Acme & Co <Ltd>', '1250000.00']);
  });

  it('drops the control characters XML cannot carry', () => {
    // A NUL reaches a text column through a pasted document more often
    // than anyone would like, and one of them anywhere in the sheet makes
    // the WHOLE workbook unreadable rather than that one cell wrong.
    const nul = String.fromCodePoint(0);
    const sheet = sheetXml(
      buildXlsx(
        'Correspondence',
        [{ header: 'Subject' }],
        [[`Rates <revised> & agreed${nul} today`]],
      ),
    );
    expect(sheet).toContain('Rates &lt;revised&gt; &amp; agreed today');
    expect(sheet).not.toContain(nul);
  });

  it('leaves a null cell out rather than writing an empty one', () => {
    const sheet = sheetXml(
      buildXlsx(
        'Works',
        [{ header: 'Code' }, { header: 'Note' }],
        [['W-1', null], ['W-2']],
      ),
    );
    expect(sheet).toContain('<row r="2"><c r="A2" t="inlineStr"');
    expect(sheet).not.toContain('r="B2"');
    // A short row is a normal register row, not a programming error.
    expect(sheet).toContain('<row r="3">');
  });

  it('repairs a sheet name Excel would refuse to open', () => {
    const bytes = buildXlsx(
      'Delivery challans / receipts and everything else',
      [{ header: 'A' }],
      [],
    );
    const name = /name="([^"]*)"/.exec(bytes.toString('latin1'))?.[1] ?? '';
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toContain('/');
  });

  it('produces the same bytes for the same contents', () => {
    // What lets a golden file exist, and what stops two exports of an
    // unchanged register differing. Both writers share `buildZip`, whose
    // entries carry no timestamp at all.
    const once = buildXlsx('Works', [{ header: 'Code' }], [['W-1']]);
    const twice = buildXlsx('Works', [{ header: 'Code' }], [['W-1']]);
    expect(once.equals(twice)).toBe(true);
  });
});
