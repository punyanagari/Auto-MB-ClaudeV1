/**
 * A CSV reader, because the Zoho Books invoice export is a CSV and a CSV
 * cannot be read by splitting on newlines.
 *
 * The real export (638 invoices, 809 line rows, 193 columns) carries
 * embedded newlines inside quoted fields — an address block, a terms and
 * conditions paragraph, an e-invoice payload — so `text.split('\n')`
 * produces rows that are fragments of other rows, silently, with no error
 * anywhere. Every field of every row after the first such fragment is then
 * one column out of place. That is not a hypothetical: it is what the
 * first read of this file did, and it is why this parser exists rather
 * than a regex.
 *
 * RFC 4180, with the two relaxations every real-world writer needs:
 * a record separator may be LF, CRLF or a bare CR, and a UTF-8 byte-order
 * mark at the start of the file is consumed rather than becoming part of
 * the first header. Inside a quoted field a doubled quote is one quote and
 * everything else — commas, newlines, quotes that are not doubled at the
 * close — is content.
 *
 * NOTHING IS COERCED. Every field comes back as the string the file
 * spelled, and deciding what `"1,200.00"` or `"07/04/2023"` means is the
 * caller's job. A parser that guesses a type is a second, weaker validator
 * sitting in front of the real one (the argument migration 0094 makes at
 * length about `spreadsheet_import_rows.cells`).
 */

/** A refusal an operator can act on, distinct from a defect in this
 * reader. The import route turns it into a 400. */
export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/**
 * How many records this reader will produce before it refuses.
 *
 * The real export is 809 rows and the ceiling is two orders of magnitude
 * above it, so it bounds a hostile file rather than a growing register.
 * It is stated as a row count as well as the route's byte cap because the
 * two bound different things: a megabyte of one-character rows is a
 * million records out of a body the byte cap allows.
 */
export const MAX_CSV_ROWS = 100_000;

/** Fields per record, bounded for the same reason. The export carries 193
 * columns; a file claiming thousands is not a register. */
export const MAX_CSV_FIELDS_PER_ROW = 1_000;

/**
 * Reads a whole CSV document into records of raw fields.
 *
 * Trailing empty records are dropped — every writer ends the file with a
 * record separator, and a final `['']` is that separator, not a row.
 */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const endField = (): void => {
    if (row.length >= MAX_CSV_FIELDS_PER_ROW) {
      throw new CsvParseError(
        `That file has a row with more than ${String(MAX_CSV_FIELDS_PER_ROW)} columns, which is not a register this can read.`,
      );
    }
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    if (rows.length >= MAX_CSV_ROWS) {
      throw new CsvParseError(
        `That file has more than ${String(MAX_CSV_ROWS)} rows; split it and upload the parts.`,
      );
    }
    rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const character = source[index] ?? '';
    if (quoted) {
      if (character === '"') {
        // A doubled quote is one quote of content; a single one closes the
        // field. Reading the NEXT character is what tells them apart, and
        // at end of input there is no next character, so the field closes.
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }

    if (character === '"') {
      // Only at the start of a field is a quote an opening quote. A quote
      // in the middle of an unquoted field (`12" pipe`) is content, which
      // is what a strict reader would refuse and what every real export
      // eventually contains.
      if (field.length === 0) {
        quoted = true;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }

    if (character === ',') {
      endField();
      index += 1;
      continue;
    }

    if (character === '\r') {
      endRow();
      index += source[index + 1] === '\n' ? 2 : 1;
      continue;
    }

    if (character === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += character;
    index += 1;
  }

  // An unterminated quote means the rest of the file was swallowed as one
  // field. Reporting it is the difference between "your file is truncated"
  // and a register that silently imported one row.
  if (quoted) {
    throw new CsvParseError(
      'That file has a quoted value that is never closed, so the rest of it cannot be read; re-export it.',
    );
  }

  if (field.length > 0 || row.length > 0) endRow();

  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last === undefined) break;
    if (last.length === 1 && last[0] === '') rows.pop();
    else break;
  }

  return rows;
}
