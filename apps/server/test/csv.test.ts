import { describe, expect, it } from 'vitest';
import { CsvParseError, MAX_CSV_FIELDS_PER_ROW, parseCsv } from '../src/csv.js';

/**
 * The reader that exists because line-splitting a CSV is wrong.
 *
 * The failure it was written against is the quiet one: a quoted field
 * containing a newline turns one record into two, every field after it is
 * one column out of place, and nothing errors. Everything below is that
 * case and the neighbours it travels with.
 */
describe('parseCsv', () => {
  it('reads a plain record', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps an embedded newline inside a quoted field', () => {
    // THE CASE THE WHOLE FILE EXISTS FOR. A split on '\n' returns four
    // rows here, two of them fragments, and reports nothing.
    const rows = parseCsv('id,address\n1,"12 Old Road\nPune\n411001"\n2,x');
    expect(rows).toEqual([
      ['id', 'address'],
      ['1', '12 Old Road\nPune\n411001'],
      ['2', 'x'],
    ]);
  });

  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('a,b\n"Sharma, Rakesh",2')).toEqual([
      ['a', 'b'],
      ['Sharma, Rakesh', '2'],
    ]);
  });

  it('reads a doubled quote as one quote of content', () => {
    expect(parseCsv('a\n"He said ""yes"""')).toEqual([['a'], ['He said "yes"']]);
  });

  it('treats a quote in the middle of an unquoted field as content', () => {
    // `12" pipe` is a real item description. A strict reader refuses it;
    // this one keeps it, which is the deliberate relaxation.
    expect(parseCsv('a,b\n12" pipe,2')).toEqual([
      ['a', 'b'],
      ['12" pipe', '2'],
    ]);
  });

  it('accepts CRLF, bare CR and LF as the same record separator', () => {
    expect(parseCsv('a,b\r\n1,2\r3,4\n5,6')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ]);
  });

  it('consumes a byte-order mark rather than gluing it to the first header', () => {
    const [header] = parseCsv('﻿Invoice ID,Total\n1,2');
    expect(header?.[0]).toBe('Invoice ID');
  });

  it('keeps empty fields, including a trailing one', () => {
    expect(parseCsv('a,b,c\n1,,')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ]);
  });

  it('drops the trailing record separator rather than reading it as a row', () => {
    expect(parseCsv('a,b\n1,2\n')).toHaveLength(2);
  });

  it('refuses a quoted value that is never closed', () => {
    // Without this the rest of the file is swallowed as one field and the
    // import reports one row and success.
    expect(() => parseCsv('a,b\n1,"unterminated')).toThrow(CsvParseError);
  });

  it('refuses a row with more columns than a register has', () => {
    const wide = Array.from({ length: MAX_CSV_FIELDS_PER_ROW + 1 }, () => 'x').join(
      ',',
    );
    expect(() => parseCsv(wide)).toThrow(CsvParseError);
  });
});
