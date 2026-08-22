import { describe, expect, it } from 'vitest';
import { CsvParseError } from '../src/csv.js';
import {
  ZohoInvoiceImportError,
  matchContact,
  proposeWorkLink,
  readZohoInvoiceCsv,
} from '../src/zoho-invoices.js';

/**
 * Reading the Zoho Books invoice export (migration 0115).
 *
 * EVERY FIXTURE HERE IS SYNTHETIC. The file this reader was written
 * against is a real customer's five-year billing history, and no row of
 * it may enter this repository — so the shapes it taught us are
 * reproduced with invented values: the invoice-level columns repeated on
 * every line of a multi-line invoice, an address block with newlines in
 * it, an `Invoice Status` of `Draft` on an invoice that carries an IRN, a
 * unit price at three decimal places, and a private order with no
 * reference text at all.
 */

/** The columns this reader looks at, in the export's own spelling. The
 * real file carries 193; a fixture only has to carry the ones under
 * test, because an absent column is absent rather than empty. */
const HEADER = [
  'Invoice Date',
  'Invoice ID',
  'Invoice Number',
  'Invoice Status',
  'Customer ID',
  'Customer Name',
  'Place of Supply',
  'PurchaseOrder',
  'SubTotal',
  'Total',
  'Balance',
  'e-Invoice Reference Number',
  'e-Invoice Ack Number',
  'e-Invoice Ack Date',
  'Item Name',
  'Item Desc',
  'Quantity',
  'Usage unit',
  'Item Price',
  'Item Total',
  'GST Identification Number (GSTIN)',
  'HSN/SAC',
  'Round Off',
  'Supply Type',
  'CGST Rate %',
  'SGST Rate %',
  'CGST',
  'SGST',
];

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** A CSV from rows keyed by column name; anything unnamed is empty. */
function csv(rows: readonly Readonly<Record<string, string>>[]): string {
  const body = rows.map((row) =>
    HEADER.map((column) => quote(row[column] ?? '')).join(','),
  );
  return [HEADER.join(','), ...body].join('\r\n');
}

const RAILWAY_LINE = {
  'Invoice Date': '2023-04-07',
  'Invoice ID': '1001',
  'Invoice Number': 'PEB/23-24/001',
  // The lie this reader exists to see through.
  'Invoice Status': 'Draft',
  'Customer ID': 'C-1',
  'Customer Name': 'Central Railway',
  'Place of Supply': 'Maharashtra',
  PurchaseOrder: 'Against LOA/CR/2023/0099 for PL-4711',
  SubTotal: '10000.00',
  Total: '11800.00',
  Balance: '11800.00',
  'e-Invoice Reference Number': 'a'.repeat(64),
  'e-Invoice Ack Number': '112300001',
  'e-Invoice Ack Date': '2023-04-07 15:22:00',
  'Item Name': 'Signal lamp PL-4711',
  'Item Desc': 'LED signal lamp, 110V',
  Quantity: '10.00',
  'Usage unit': 'Nos',
  'Item Price': '1000.000',
  'Item Total': '10000.00',
  'GST Identification Number (GSTIN)': '27AAACR1234A1ZP',
  'HSN/SAC': '85308000',
  'Round Off': '0.00',
  'Supply Type': 'Taxable',
  'CGST Rate %': '9',
  'SGST Rate %': '9',
  CGST: '900.00',
  SGST: '900.00',
};

describe('readZohoInvoiceCsv', () => {
  it('reads one invoice from one row', () => {
    const [invoice] = readZohoInvoiceCsv(csv([RAILWAY_LINE]));
    expect(invoice?.zohoInvoiceId).toBe('1001');
    expect(invoice?.invoiceNumber).toBe('PEB/23-24/001');
    expect(invoice?.invoiceDate).toBe('2023-04-07');
    expect(invoice?.subTotal).toBe('10000.00');
    expect(invoice?.total).toBe('11800.00');
    expect(invoice?.lines).toHaveLength(1);
  });

  it('derives issued-ness from the IRN and keeps the status as evidence', () => {
    // The export says Draft. It carries an IRN, so the government
    // registered it, so it was issued — and the disagreement stays
    // readable rather than being resolved away.
    const [issued] = readZohoInvoiceCsv(csv([RAILWAY_LINE]));
    expect(issued?.zohoStatus).toBe('Draft');
    expect(issued?.issued).toBe(true);

    const [notIssued] = readZohoInvoiceCsv(
      csv([
        {
          ...RAILWAY_LINE,
          'e-Invoice Reference Number': '',
          'e-Invoice Ack Number': '',
          'e-Invoice Ack Date': '',
          'Invoice Status': 'Overdue',
        },
      ]),
    );
    expect(notIssued?.zohoStatus).toBe('Overdue');
    expect(notIssued?.issued).toBe(false);
  });

  it('takes the date part of an acknowledgement timestamp', () => {
    const [invoice] = readZohoInvoiceCsv(csv([RAILWAY_LINE]));
    expect(invoice?.ackDate).toBe('2023-04-07');
  });

  it('groups the rows of a multi-line invoice under one record', () => {
    const invoices = readZohoInvoiceCsv(
      csv([
        RAILWAY_LINE,
        { ...RAILWAY_LINE, 'Item Name': 'Mounting bracket', 'Item Total': '500.00' },
        { ...RAILWAY_LINE, 'Item Name': 'Cable gland', 'Item Total': '250.00' },
        { ...RAILWAY_LINE, 'Invoice ID': '1002', 'Invoice Number': 'PEB/23-24/002' },
      ]),
    );
    expect(invoices).toHaveLength(2);
    expect(invoices[0]?.lines.map((line) => line.position)).toEqual([1, 2, 3]);
    expect(invoices[0]?.lines[1]?.itemName).toBe('Mounting bracket');
    expect(invoices[1]?.lines).toHaveLength(1);
  });

  it('survives a newline inside a quoted field', () => {
    // The failure a line-splitting reader has here is silent: the record
    // becomes three, and every field of the next invoice is one column
    // out of place.
    const invoices = readZohoInvoiceCsv(
      csv([
        { ...RAILWAY_LINE, 'Item Desc': 'Supplied to:\nDivisional Office\nPune' },
        { ...RAILWAY_LINE, 'Invoice ID': '1002', 'Invoice Number': 'PEB/23-24/002' },
      ]),
    );
    expect(invoices).toHaveLength(2);
    expect(invoices[0]?.lines[0]?.itemDescription).toContain('Divisional Office');
    expect(invoices[1]?.invoiceNumber).toBe('PEB/23-24/002');
  });

  it('reads a unit price at rate scale rather than rounding it to paise', () => {
    // `Item Price` is a RATE. Reading it at money scale would drop the
    // third digit of 1234.567 in silence, which is the failure the
    // repository's domains exist to make impossible.
    const [invoice] = readZohoInvoiceCsv(
      csv([{ ...RAILWAY_LINE, 'Item Price': '1234.567' }]),
    );
    expect(invoice?.lines[0]?.itemPrice).toBe('1234.567000');
  });

  it('keeps a private order with no reference text', () => {
    const [invoice] = readZohoInvoiceCsv(
      csv([
        {
          ...RAILWAY_LINE,
          'Invoice ID': '2001',
          'Customer Name': 'Nashik Electricals',
          PurchaseOrder: '',
          'Item Name': 'Control panel',
          'Item Desc': 'Custom build',
        },
      ]),
    );
    expect(invoice?.referenceText).toBeNull();
  });

  it('carries the whole raw row, keyed by the file’s own headers', () => {
    const [invoice] = readZohoInvoiceCsv(csv([RAILWAY_LINE]));
    expect(invoice?.rawRow['Invoice Number']).toBe('PEB/23-24/001');
    expect(invoice?.rawRow['CGST Rate %']).toBe('9');
    // Empty cells are absent rather than empty strings, so the payload is
    // the file's content and not its shape.
    expect(Object.keys(invoice?.rawRow ?? {})).not.toContain('Adjustment');
  });

  it('ignores a wholly blank trailing row', () => {
    expect(readZohoInvoiceCsv(`${csv([RAILWAY_LINE])}\r\n`)).toHaveLength(1);
  });

  it('refuses a file that is not the invoice export', () => {
    expect(() => readZohoInvoiceCsv('name,address\nA,B')).toThrow(CsvParseError);
  });

  it('refuses a figure that is not a number, naming the row and column', () => {
    try {
      readZohoInvoiceCsv(csv([{ ...RAILWAY_LINE, Total: 'eleven thousand' }]));
      expect.unreachable('a non-numeric total must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ZohoInvoiceImportError);
      expect((error as ZohoInvoiceImportError).rowNumber).toBe(2);
      expect((error as ZohoInvoiceImportError).column).toBe('Total');
    }
  });

  it('refuses a date this reader would have to guess at', () => {
    // 07/04/2023 is two different days in two locales, three months
    // apart, and a register of invoice dates cannot be wrong quietly.
    expect(() =>
      readZohoInvoiceCsv(csv([{ ...RAILWAY_LINE, 'Invoice Date': '07/04/2023' }])),
    ).toThrow(ZohoInvoiceImportError);
  });

  it('refuses money carrying more precision than it can store', () => {
    expect(() =>
      readZohoInvoiceCsv(csv([{ ...RAILWAY_LINE, Total: '11800.005' }])),
    ).toThrow(ZohoInvoiceImportError);
  });

  it('strips thousands separators a re-saved spreadsheet acquires', () => {
    const [invoice] = readZohoInvoiceCsv(
      csv([{ ...RAILWAY_LINE, Total: '1,18,000.00' }]),
    );
    expect(invoice?.total).toBe('118000.00');
  });

  it('refuses a date that is well-formed and not a day of any month', () => {
    // `2023-02-30` satisfies YYYY-MM-DD and is not a date. Refused HERE,
    // in the preview, where the refusal names the row — rather than by
    // PostgreSQL mid-commit as a 22008 with nothing naming anything.
    for (const spelling of ['2023-02-30', '2023-13-01', '2023-00-10']) {
      try {
        readZohoInvoiceCsv(csv([{ ...RAILWAY_LINE, 'Invoice Date': spelling }]));
        expect.unreachable(`${spelling} is not a date and must be refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(ZohoInvoiceImportError);
        expect((error as ZohoInvoiceImportError).rowNumber).toBe(2);
        expect((error as ZohoInvoiceImportError).column).toBe('Invoice Date');
      }
    }
    // The leap day of a leap year is a date, and is not refused.
    const [leap] = readZohoInvoiceCsv(
      csv([{ ...RAILWAY_LINE, 'Invoice Date': '2024-02-29' }]),
    );
    expect(leap?.invoiceDate).toBe('2024-02-29');
  });

  it('drops leading zeros, because the API pattern refuses them', () => {
    // The regression: `0000123.00` parsed cleanly, was stored, and then
    // failed response validation as a 500 with nothing naming the cell.
    const [invoice] = readZohoInvoiceCsv(
      csv([{ ...RAILWAY_LINE, Total: '0000123.00', SubTotal: '000.50' }]),
    );
    expect(invoice?.total).toBe('123.00');
    expect(invoice?.subTotal).toBe('0.50');
  });

  it('refuses a figure wider than the column that has to hold it', () => {
    try {
      readZohoInvoiceCsv(csv([{ ...RAILWAY_LINE, Total: '1234567890123456.00' }]));
      expect.unreachable('a sixteen-digit total must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ZohoInvoiceImportError);
      expect((error as ZohoInvoiceImportError).column).toBe('Total');
    }
    // The rate column is numeric(18,6), so its ceiling is twelve digits.
    expect(() =>
      readZohoInvoiceCsv(csv([{ ...RAILWAY_LINE, 'Item Price': '1234567890123.0' }])),
    ).toThrow(ZohoInvoiceImportError);
  });

  it('refuses a space inside a number rather than closing it up', () => {
    // `1 200` is 1200 or 12.00 depending on what went wrong, and the two
    // readings differ by a factor of ten. Trailing and leading whitespace
    // is still trimmed: that is formatting, not ambiguity.
    expect(() =>
      readZohoInvoiceCsv(csv([{ ...RAILWAY_LINE, Total: '11 800.00' }])),
    ).toThrow(ZohoInvoiceImportError);
    const [padded] = readZohoInvoiceCsv(
      csv([{ ...RAILWAY_LINE, Total: '  11800.00  ' }]),
    );
    expect(padded?.total).toBe('11800.00');
  });

  it('refuses a tax rate that is not a percentage', () => {
    // The way this happens is a mis-mapped column: an AMOUNT read as a
    // rate. Stored unchecked it becomes a rate of ninety thousand percent
    // and nothing ever says so.
    try {
      readZohoInvoiceCsv(csv([{ ...RAILWAY_LINE, 'CGST Rate %': '900.00' }]));
      expect.unreachable('a rate above 100 must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ZohoInvoiceImportError);
      expect((error as ZohoInvoiceImportError).column).toBe('CGST Rate %');
    }
    // The boundary itself is a legitimate rate, and so is nil-rated
    // supply.
    const [ok] = readZohoInvoiceCsv(
      csv([{ ...RAILWAY_LINE, 'CGST Rate %': '100', 'SGST Rate %': '0' }]),
    );
    expect(ok?.lines[0]?.cgstRate).toBe('100.00');
    expect(ok?.lines[0]?.sgstRate).toBe('0.00');
  });

  it('names the CSV row a bad line actually sits on', () => {
    // Zoho does not write an invoice's lines contiguously. Row 2 opens
    // invoice 1001, row 3 belongs to 1002, and row 4 is 1001's second
    // line — so a refusal on that line must say 4, which the old
    // first-row-plus-position arithmetic reported as 3.
    try {
      readZohoInvoiceCsv(
        csv([
          RAILWAY_LINE,
          { ...RAILWAY_LINE, 'Invoice ID': '1002', 'Invoice Number': 'PEB/23-24/002' },
          { ...RAILWAY_LINE, 'Item Total': 'four hundred' },
        ]),
      );
      expect.unreachable('a non-numeric line total must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ZohoInvoiceImportError);
      expect((error as ZohoInvoiceImportError).rowNumber).toBe(4);
      expect((error as ZohoInvoiceImportError).column).toBe('Item Total');
    }
  });
});

describe('proposeWorkLink', () => {
  const works = [
    { id: 'w-1', workCode: 'PL-4711', letterNumber: 'LOA/CR/2023/0099' },
    { id: 'w-2', workCode: 'PL-5000', letterNumber: 'LOA/CR/2024/0150' },
  ];
  const read = (row: Readonly<Record<string, string>>) =>
    readZohoInvoiceCsv(csv([row]))[0] as ReturnType<typeof readZohoInvoiceCsv>[number];

  it('matches a v1 work code out of the invoice text', () => {
    const proposal = proposeWorkLink(
      read({ ...RAILWAY_LINE, PurchaseOrder: 'Order for PL-4711' }),
      works,
    );
    expect(proposal?.workId).toBe('w-1');
    expect(proposal?.method).toBe('pl_code');
    expect(proposal?.evidence).toBe('PL-4711');
  });

  it('falls back to the LOA letter number in the reference field', () => {
    const proposal = proposeWorkLink(
      read({
        ...RAILWAY_LINE,
        PurchaseOrder: 'ref loa-cr-2024-0150',
        'Item Name': 'x',
      }),
      works,
    );
    expect(proposal?.workId).toBe('w-2');
    expect(proposal?.method).toBe('loa_match');
  });

  it('proposes nothing when the text names two different Works', () => {
    // A coin flip between two contracts is worse than five seconds of an
    // operator's time, so ambiguity is reported as unlinked.
    expect(
      proposeWorkLink(
        read({
          ...RAILWAY_LINE,
          PurchaseOrder: 'PL-4711 and PL-5000',
          'Item Name': '',
        }),
        works,
      ),
    ).toBeNull();
  });

  it('treats two mentions of one Work as one match', () => {
    const proposal = proposeWorkLink(
      read({ ...RAILWAY_LINE, PurchaseOrder: 'PL-4711', 'Item Name': 'For PL-4711' }),
      works,
    );
    expect(proposal?.workId).toBe('w-1');
  });

  it('proposes nothing for a private order', () => {
    expect(
      proposeWorkLink(
        read({
          ...RAILWAY_LINE,
          PurchaseOrder: '',
          'Item Name': 'Control panel',
          'Item Desc': 'Custom build',
        }),
        works,
      ),
    ).toBeNull();
  });

  it('does not read a work code across two fields', () => {
    // The haystack is the reference text and every line's name and
    // description joined with newlines. A separator of `\s` matched that
    // newline, so a reference ending in `PL` beside a description opening
    // `4711` was read as `PL-4711` and would have filed the invoice
    // against a contract neither field named.
    expect(
      proposeWorkLink(
        read({
          ...RAILWAY_LINE,
          PurchaseOrder: 'Supply order PL',
          'Item Name': '4711 signal lamps',
          'Item Desc': '',
        }),
        works,
      ),
    ).toBeNull();
    // A space INSIDE one field is still a match: `PL 4711` is how a
    // typist writes it.
    expect(
      proposeWorkLink(
        read({ ...RAILWAY_LINE, PurchaseOrder: 'Order PL 4711', 'Item Name': '' }),
        works,
      )?.workId,
    ).toBe('w-1');
  });

  it('does not match a code the organisation has no Work for', () => {
    expect(
      proposeWorkLink(
        read({ ...RAILWAY_LINE, PurchaseOrder: 'PL-9999', 'Item Name': '' }),
        works,
      ),
    ).toBeNull();
  });
});

describe('matchContact', () => {
  const read = (row: Readonly<Record<string, string>>) =>
    readZohoInvoiceCsv(csv([row]))[0] as ReturnType<typeof readZohoInvoiceCsv>[number];

  it('matches on GSTIN before name', () => {
    const match = matchContact(read(RAILWAY_LINE), [
      { id: 'c-1', name: 'Something Else Entirely', gstin: '27AAACR1234A1ZP' },
      { id: 'c-2', name: 'Central Railway', gstin: null },
    ]);
    expect(match).toEqual({ contactId: 'c-1', method: 'gstin' });
  });

  it('falls back to an exact name, case and spacing aside', () => {
    const match = matchContact(read(RAILWAY_LINE), [
      { id: 'c-2', name: '  central   railway ', gstin: null },
    ]);
    expect(match).toEqual({ contactId: 'c-2', method: 'name' });
  });

  it('refuses to guess between two contacts sharing a GSTIN', () => {
    expect(
      matchContact(read(RAILWAY_LINE), [
        { id: 'c-1', name: 'A', gstin: '27AAACR1234A1ZP' },
        { id: 'c-2', name: 'B', gstin: '27AAACR1234A1ZP' },
      ]),
    ).toBeNull();
  });

  it('leaves an unknown customer unmatched rather than approximating', () => {
    expect(
      matchContact(read(RAILWAY_LINE), [
        { id: 'c-9', name: 'Central Railways Ltd', gstin: '27ZZZZZ9999Z1ZP' },
      ]),
    ).toBeNull();
  });
});
