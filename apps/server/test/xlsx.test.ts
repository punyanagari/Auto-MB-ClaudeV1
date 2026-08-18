import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildXlsx, columnName } from '../src/xlsx.js';

/**
 * The hand-rolled .xlsx writer.
 *
 * There is no unzip dependency in this repository either, which is the
 * point of the first block below: the ZIP container is unpacked here by
 * reading the central directory the writer wrote, so the test proves the
 * headers agree with each other rather than trusting a library to be
 * forgiving. A reader that cannot find the central directory finds no
 * workbook at all, and that is the failure mode a "did it produce bytes"
 * assertion would miss entirely.
 */

interface Entry {
  readonly name: string;
  readonly text: string;
}

/**
 * Reads the archive the way a ZIP reader does: from the end-of-central-
 * directory record backwards, never by scanning for local headers. Every
 * offset and length the writer stored has to be right for this to work.
 */
function unzip(archive: Buffer): readonly Entry[] {
  const end = archive.lastIndexOf(Buffer.from('504b0506', 'hex'));
  expect(end, 'no end-of-central-directory record').toBeGreaterThan(-1);
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const entries: Entry[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const bodyStart = localOffset + 30 + localNameLength + localExtraLength;
    const body = inflateRawSync(
      archive.subarray(bodyStart, bodyStart + compressedSize),
    );
    expect(body.length, `${name} declared the wrong uncompressed size`).toBe(
      uncompressedSize,
    );
    entries.push({ name, text: body.toString('utf8') });
    cursor += 46 + nameLength;
  }
  return entries;
}

function sheetOf(archive: Buffer): string {
  const sheet = unzip(archive).find(
    (entry) => entry.name === 'xl/worksheets/sheet1.xml',
  );
  if (sheet === undefined) throw new Error('no worksheet part');
  return sheet.text;
}

describe('the workbook container', () => {
  it('holds the five parts a reader opens, in a directory it can walk', () => {
    const archive = buildXlsx('Works', [{ header: 'Code' }], [['W-1']]);
    expect(unzip(archive).map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('produces the same bytes for the same contents', () => {
    // The fixed DOS timestamp is what makes this true, and it is what
    // lets a golden file exist at all. Two exports of an unchanged
    // register that differed byte for byte would also defeat any future
    // caching or integrity check over the file.
    const once = buildXlsx('Works', [{ header: 'Code' }], [['W-1']]);
    const twice = buildXlsx('Works', [{ header: 'Code' }], [['W-1']]);
    expect(once.equals(twice)).toBe(true);
  });

  it('repairs a sheet name Excel would refuse to open', () => {
    const archive = buildXlsx(
      'Delivery challans / receipts and everything else',
      [{ header: 'A' }],
      [],
    );
    const workbook = unzip(archive).find((entry) => entry.name === 'xl/workbook.xml');
    const name = /name="([^"]*)"/.exec(workbook?.text ?? '')?.[1] ?? '';
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toContain('/');
  });
});

describe('cells', () => {
  it('writes a numeric column as a number and everything else as text', () => {
    const sheet = sheetOf(
      buildXlsx(
        'Invoices',
        [{ header: 'Number' }, { header: 'Total', numeric: true }],
        [['INV/1', '184610.50']],
      ),
    );
    // The money cell carries the server's own decimal string verbatim,
    // with no type attribute — that is what makes it a number Excel will
    // sum. Nothing in this process parsed or re-formatted it.
    expect(sheet).toContain('<c r="B2"><v>184610.50</v></c>');
    expect(sheet).toContain('<c r="A2" t="inlineStr">');
  });

  it('falls back to text when a numeric column holds something that is not a number', () => {
    // A register legitimately prints a dash for "not applicable", and a
    // `<v>—</v>` cell makes the whole workbook unreadable rather than
    // that one cell wrong.
    const sheet = sheetOf(
      buildXlsx('Invoices', [{ header: 'Total', numeric: true }], [['—']]),
    );
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).not.toContain('<v>');
  });

  it('escapes XML and drops the control characters XML cannot carry', () => {
    // A NUL reaches a text column through a pasted document more often
    // than anyone would like, and one of them anywhere in the sheet makes
    // the WHOLE workbook unreadable rather than that one cell wrong.
    const nul = String.fromCodePoint(0);
    const sheet = sheetOf(
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
    const sheet = sheetOf(
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

  it('names columns in bijective base-26', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
  });
});
