import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalMeasurementNumber,
  parseMeasurementNumber,
  parseReceivedRailwayBill,
  RailwayBillParseError,
  sameMeasurement,
  toMoneyString,
} from '../src/railway-bill-parse.js';

/**
 * The railway-bill reader, held to the real documents.
 *
 * These are not invented inputs. `fixtures/railway-settlement/BILL-*.raw.txt`
 * is what Poppler produced from the three IWRCMS bills of the PL-270
 * settlement corpus, committed verbatim (person names pseudonymised), and
 * `corpus.json` records — independently of this parser — what each one
 * says. So the assertions below compare the parser's answer with the
 * manifest's, and a parser that drifts fails against evidence rather than
 * against an expectation somebody typed beside it.
 *
 * Every case in `corpus.json`'s `trap_notes` has a test here by name.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'railway-settlement');

interface ManifestDocument {
  readonly id: string;
  readonly kind: string;
  readonly fixture_file: string;
  readonly bill_number?: string;
  readonly bill_date?: string;
  readonly measurement_number?: string;
  readonly settles_measurement_book?: string;
  readonly back_references_bill_measurement?: string;
  readonly rate_inclusive_of_gst?: boolean;
  readonly bill_amount_including_gst?: number;
}

const manifest = JSON.parse(
  await readFile(path.join(FIXTURES, 'corpus.json'), 'utf8'),
) as { readonly documents: readonly ManifestDocument[] };

const byId = new Map(manifest.documents.map((document) => [document.id, document]));
const bills = manifest.documents.filter((document) => document.kind === 'railway_bill');

async function fixtureText(document: ManifestDocument): Promise<string> {
  return readFile(path.join(FIXTURES, document.fixture_file), 'utf8');
}

describe('reading a received railway bill', () => {
  it('reads every field of all three real bills as the manifest records them', async () => {
    expect(bills).toHaveLength(3);
    for (const bill of bills) {
      const parsed = parseReceivedRailwayBill(await fixtureText(bill));
      expect(parsed.billNumber, bill.id).toBe(bill.bill_number);
      expect(parsed.billDate, bill.id).toBe(bill.bill_date);
      expect(parsed.measurement.raw, bill.id).toBe(bill.measurement_number);
      expect(parsed.rateInclusiveOfGst, bill.id).toBe(bill.rate_inclusive_of_gst);
      expect(parsed.letterNumber, bill.id).toBe('00341490147964');
      expect(parsed.agreementNumber, bill.id).toBe('CR/BBY/S&T/2026/0009');
      // The manifest carries the amount as a JSON number; the parser
      // carries it as the fixed-scale string the money_amount domain
      // stores, because rupees never go through a float here.
      expect(Number(parsed.billAmount), bill.id).toBe(bill.bill_amount_including_gst);
    }
  });

  it('rejoins the measurement number that wraps around its own label', async () => {
    // Trap 3. In `-layout` output the number arrives in two pieces on the
    // lines that bracket the label — `.../CSTM/11393` above, `16/OAM/FL2/01`
    // below — and the label's own line carries the NEXT label instead.
    // Either half alone matches nothing.
    const text = await fixtureText(byId.get('BILL-1') as ManifestDocument);
    expect(text).toContain('00341490147964/CSTM/11393\n');
    expect(text).toContain('16/OAM/FL2/01');
    expect(text).not.toContain('00341490147964/CSTM/1139316/OAM/FL2/01');

    const parsed = parseReceivedRailwayBill(text);
    expect(parsed.measurement.raw).toBe('00341490147964/CSTM/1139316/OAM/FL2/01');
  });

  it('does not sweep the neighbouring field into the rejoined number', async () => {
    // The line above the first fragment carries `No` in the SAME column,
    // as the value of `Contract ?`. A column-band read that did not stop
    // at a line owning its own label would weld it on.
    const parsed = parseReceivedRailwayBill(
      await fixtureText(byId.get('BILL-2') as ManifestDocument),
    );
    expect(parsed.measurement.raw).toBe('00341490147964/CSTM/1139316/OAM/FL2/02');
    expect(parsed.measurement.raw.startsWith('No')).toBe(false);
  });

  it('reads the bill number printed with no space after its label', async () => {
    const text = await fixtureText(byId.get('BILL-3') as ManifestDocument);
    // IWRCMS prints `Bill No.CR/BBY/...` — one token, no separator, so a
    // whitespace split finds a label and no value.
    expect(text).toContain('Bill No.CR/BBY/S&T/2026/0009/B3');
    expect(parseReceivedRailwayBill(text).billNumber).toBe('CR/BBY/S&T/2026/0009/B3');
  });

  it('reads the GST declaration whose LABEL wraps instead of its value', async () => {
    const text = await fixtureText(byId.get('BILL-1') as ManifestDocument);
    expect(text).toContain('Rate is inclusive of\n');
    expect(parseReceivedRailwayBill(text).rateInclusiveOfGst).toBe(true);
  });

  it('reads the amount from its own line, not from the three-figure total row', async () => {
    // `Total Amount(Rs.)` prints up-to-last-bill, since-last-bill and
    // total-up-to-date. On BILL-2 the first of those is BILL-1's total, so
    // a reader that took the first figure would report 24516112 for a bill
    // worth 8057057.
    const text = await fixtureText(byId.get('BILL-2') as ManifestDocument);
    expect(text).toMatch(/Total Amount\(Rs\.\)\s+24516112\s+8057057\.0\s+32573169/);
    expect(parseReceivedRailwayBill(text).billAmount).toBe('8057057.00');
  });

  it('normalises whole rupees and a trailing .0 to the same stored scale', () => {
    // BILL-1 prints `24516112`, BILL-2 prints `8057057.0`, and the column
    // that stores them is numeric(18,2).
    expect(toMoneyString('24516112', 'billAmount')).toBe('24516112.00');
    expect(toMoneyString('8057057.0', 'billAmount')).toBe('8057057.00');
    expect(toMoneyString('17327888.01', 'billAmount')).toBe('17327888.01');
    expect(toMoneyString('1,20,000', 'billAmount')).toBe('120000.00');
    expect(() => toMoneyString('24,51,61,12.345', 'billAmount')).toThrow(
      RailwayBillParseError,
    );
  });

  it('names the field it could not read rather than failing generically', () => {
    let thrown: unknown;
    try {
      parseReceivedRailwayBill('Bill No.X/1\nnothing else at all\n');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RailwayBillParseError);
    expect((thrown as RailwayBillParseError).field).toBe('measurementNumber');
  });

  it('refuses a date the printed calendar does not have', () => {
    const text = [
      '                                                     Bill No.X/1',
      '         Agreement No.               A/1                                  Bill Date        31/02/2026',
      '                                     00341490147964/CSTM/11393',
      '         Measurement No.',
      '                                     16/OAM/FL2/01',
      '         LOA No.                     00341490147964',
      '         Rate is inclusive of',
      '         GST                         Yes',
      'Bill Amount (Rs.) (Including Tax (GST))                          1.0',
    ].join('\n');
    expect(() => parseReceivedRailwayBill(text)).toThrow(/not a real date/);
  });
});

describe('the L2 to FL2 normalisation', () => {
  it('makes a book and the bill raised from it name the same measurement', () => {
    // Trap 1, and the expensive one: the strings differ, the measurement
    // does not, and equality on the raw string silently links nothing.
    for (const bill of bills) {
      const book = byId.get(bill.settles_measurement_book ?? '');
      const billNumber = parseMeasurementNumber(bill.measurement_number ?? '');
      const bookNumber = parseMeasurementNumber(book?.measurement_number ?? '');
      expect(billNumber, bill.id).not.toBeNull();
      expect(bookNumber, bill.id).not.toBeNull();
      if (billNumber === null || bookNumber === null) continue;

      expect(billNumber.raw).not.toBe(bookNumber.raw);
      expect(billNumber.ledger).toBe('FL2');
      expect(bookNumber.ledger).toBe('L2');
      expect(sameMeasurement(billNumber, bookNumber), bill.id).toBe(true);
      expect(canonicalMeasurementNumber(billNumber)).toBe(
        canonicalMeasurementNumber(bookNumber),
      );
    }
  });

  it("does not confuse a book's back-reference with its own measurement", async () => {
    // Trap 2. A Measurement Book quotes the PREVIOUS bill's FL2 number on
    // every carried-forward line — MB-2 carries FL2/01 dozens of times and
    // is itself L2/02. Anything that reached for "the FL2 token in this
    // document" would link MB-2 to the wrong bill, and every later book to
    // the bill before its own.
    const book = byId.get('MB-2') as ManifestDocument;
    const text = await fixtureText(book);
    const fl2 = [...text.matchAll(/\S*\/OAM\/FL2\/\d+/g)].map((match) => match[0]);
    expect(fl2.length).toBeGreaterThan(20);
    // Every one of them is the PREVIOUS bill, and every one of them also
    // arrives welded to the words before it — the book prints
    // `Qty B/F MB no.00341490147964/...` with no space, so even the token
    // a scanner would find is not a measurement number.
    expect(new Set(fl2)).toEqual(
      new Set(['no.00341490147964/CSTM/1139316/OAM/FL2/01']),
    );
    expect(
      parseMeasurementNumber('no.00341490147964/CSTM/1139316/OAM/FL2/01'),
    ).toBeNull();

    const own = parseMeasurementNumber(book.measurement_number ?? '');
    const backReference = parseMeasurementNumber(
      book.back_references_bill_measurement ?? '',
    );
    expect(own?.sequence).toBe(2);
    expect(backReference?.sequence).toBe(1);
    // Normalising is what makes them comparable; it must not make them
    // EQUAL, which would be the normalisation eating the distinction.
    expect(
      own !== null && backReference !== null && sameMeasurement(own, backReference),
    ).toBe(false);
  });

  it('refuses strings that are not measurement numbers', () => {
    // Both halves of the wrapped number, each on its own: neither is a
    // measurement number, which is why the rejoin has to happen before
    // the grammar is applied rather than after.
    expect(parseMeasurementNumber('00341490147964/CSTM/11393')).toBeNull();
    expect(parseMeasurementNumber('16/OAM/FL2/01')).toBeNull();
    expect(parseMeasurementNumber('a/b/c/OAM/L2/0')).toBeNull();
    expect(parseMeasurementNumber('a/b/c/OAM/X2/1')).toBeNull();
  });

  it('accepts a ledger generation other than 2', () => {
    const third = parseMeasurementNumber('L/S/9/OAM/FL3/07');
    expect(third?.sequence).toBe(7);
    expect(canonicalMeasurementNumber(third as NonNullable<typeof third>)).toBe(
      'L/S/9/OAM/L3/7',
    );
  });
});
