import { describe, expect, it } from 'vitest';
import { TallyImportError } from '../src/tally-scan.js';
import {
  type RegisterInvoice,
  matchTallyVouchers,
  readTallyVouchers,
} from '../src/tally-vouchers.js';

/**
 * Reading a TallyPrime sales-voucher export and tying it to the
 * historical invoice register (migration 0119).
 *
 * EVERY VOUCHER IN THIS FILE IS INVENTED. The export this reader was
 * built against is a real company's ledger and no party name, GSTIN,
 * document number or figure of it may enter the repository. What is
 * reproduced here is its SHAPE — UTF-16LE with a byte-order mark and no
 * XML declaration, one tag per line, engine flags everywhere, accounting
 * legs under two different tags depending on whether the voucher is in
 * inventory mode, bill allocations a level deeper, Tally's negative-is-a-
 * debit sign convention — with values that belong to nobody.
 *
 * The reader is a pure function of some bytes and the matcher is a pure
 * function of the reader's output and some register rows, so everything
 * below runs without a database, an organisation or a session. What they
 * become on the wire is `tally-invoices.integration.test.ts`.
 */

/** The export's own encoding: UTF-16LE with a BOM and no XML
 * declaration, which is what makes the file unopenable by ordinary means
 * and therefore what every fixture must reproduce. */
function utf16(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

interface Leg {
  readonly ledger: string;
  /** Tally's sign: negative is a debit. Omit entirely to reproduce a leg
   * with no `AMOUNT` element, which the real export carries. */
  readonly amount?: string;
  /** A bill allocation's NAME, a level below the leg. */
  readonly bill?: string;
}

interface VoucherSpec {
  readonly type?: string;
  readonly guid?: string;
  readonly alterId?: string;
  readonly date?: string;
  readonly number?: string;
  readonly reference?: string;
  readonly party?: string;
  readonly gstin?: string;
  readonly narration?: string;
  readonly cancelled?: boolean;
  readonly optional?: boolean;
  readonly legs?: readonly Leg[];
  /** `LEDGERENTRIES.LIST` instead of `ALLLEDGERENTRIES.LIST` — what an
   * inventory-mode sales voucher actually writes. */
  readonly inventoryMode?: boolean;
}

let guidCounter = 0;

function leg(spec: Leg, tag: string): string[] {
  return [
    `      <${tag}>`,
    '       <OLDAUDITENTRYIDS.LIST TYPE="Number">',
    '        <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>',
    '       </OLDAUDITENTRYIDS.LIST>',
    '       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>',
    `       <LEDGERNAME>${spec.ledger}</LEDGERNAME>`,
    ...(spec.amount === undefined ? [] : [`       <AMOUNT>${spec.amount}</AMOUNT>`]),
    ...(spec.bill === undefined
      ? ['       <BILLALLOCATIONS.LIST>       </BILLALLOCATIONS.LIST>']
      : [
          '       <BILLALLOCATIONS.LIST>',
          `        <NAME>${spec.bill}</NAME>`,
          '        <BILLTYPE>New Ref</BILLTYPE>',
          // The sub-allocation's own AMOUNT, which the reader must NOT
          // take as the leg's figure.
          '        <AMOUNT>-1.00</AMOUNT>',
          '       </BILLALLOCATIONS.LIST>',
        ]),
    `      </${tag}>`,
  ];
}

function voucher(spec: VoucherSpec = {}): string {
  guidCounter += 1;
  const guid =
    spec.guid ??
    `00000000-0000-4000-8000-000000000000-${String(guidCounter).padStart(8, '0')}`;
  const tag =
    spec.inventoryMode === true ? 'LEDGERENTRIES.LIST' : 'ALLLEDGERENTRIES.LIST';
  return [
    `     <VOUCHER REMOTEID="${guid}" VCHTYPE="${spec.type ?? 'Sales'}" ACTION="Create">`,
    // The engine noise a real voucher carries, in miniature: a
    // self-closing tag with an attribute whose slash must not disturb the
    // depth count, a nested list, and empty `.LIST` elements closed on
    // their own line.
    '      <LANGUAGENAME.LIST TYPE="String"/>',
    '      <OLDAUDITENTRYIDS.LIST TYPE="Number">',
    '       <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>',
    '      </OLDAUDITENTRYIDS.LIST>',
    `      <DATE>${spec.date ?? '20210715'}</DATE>`,
    `      <GUID>${guid}</GUID>`,
    `      <VOUCHERTYPENAME>${spec.type ?? 'Sales'}</VOUCHERTYPENAME>`,
    `      <ALTERID> ${spec.alterId ?? '9876'}</ALTERID>`,
    ...(spec.number === undefined
      ? []
      : [`      <VOUCHERNUMBER>${spec.number}</VOUCHERNUMBER>`]),
    ...(spec.reference === undefined
      ? []
      : [`      <REFERENCE>${spec.reference}</REFERENCE>`]),
    `      <PARTYLEDGERNAME>${spec.party ?? 'Northern Division Depot'}</PARTYLEDGERNAME>`,
    ...(spec.gstin === undefined
      ? []
      : [`      <PARTYGSTIN>${spec.gstin}</PARTYGSTIN>`]),
    ...(spec.narration === undefined
      ? []
      : [`      <NARRATION>${spec.narration}</NARRATION>`]),
    `      <ISCANCELLED>${spec.cancelled === true ? 'Yes' : 'No'}</ISCANCELLED>`,
    `      <ISOPTIONAL>${spec.optional === true ? 'Yes' : 'No'}</ISOPTIONAL>`,
    '      <ISINVOICE>Yes</ISINVOICE>',
    '      <EWAYBILLDETAILS.LIST>      </EWAYBILLDETAILS.LIST>',
    ...(
      spec.legs ?? [
        { ledger: spec.party ?? 'Northern Division Depot', amount: '-11800.00' },
        { ledger: 'Sales Account', amount: '10000.00' },
        { ledger: 'Output CGST', amount: '900.00' },
        { ledger: 'Output SGST', amount: '900.00' },
      ]
    ).flatMap((entry) => leg(entry, tag)),
    '     </VOUCHER>',
  ].join('\n');
}

function envelope(...vouchers: string[]): Buffer {
  return utf16(
    [
      '<ENVELOPE>',
      ' <HEADER>',
      '  <VERSION>1</VERSION>',
      ' </HEADER>',
      ' <BODY>',
      '  <REQUESTDATA>',
      ...vouchers.map(
        (body) => `   <TALLYMESSAGE xmlns:UDF="TallyUDF">\n${body}\n   </TALLYMESSAGE>`,
      ),
      '  </REQUESTDATA>',
      ' </BODY>',
      '</ENVELOPE>',
      '',
    ].join('\n'),
  );
}

function invoice(spec: Partial<RegisterInvoice> & { id: string }): RegisterInvoice {
  return {
    invoiceNumber: 'P0100001',
    customerName: 'Northern Division Depot',
    customerGstin: null,
    total: '11800.00',
    ...spec,
  };
}

describe('readTallyVouchers', () => {
  it('reads a UTF-16 voucher and takes its value from the party line', () => {
    const read = readTallyVouchers(
      envelope(voucher({ number: 'P0100001', gstin: '09AAACT2727Q1ZW' })),
    );
    expect(read.refusals).toEqual([]);
    expect(read.voucherCount).toBe(1);
    const [only] = read.vouchers;
    expect(only?.guid).toMatch(/^00000000-/);
    expect(only?.alterId).toBe(9876);
    expect(only?.voucherType).toBe('Sales');
    expect(only?.date).toBe('2021-07-15');
    expect(only?.voucherNumber).toBe('P0100001');
    expect(only?.partyGstin).toBe('09AAACT2727Q1ZW');
    // The party leg's magnitude, not the sum of the other three, and not
    // the bill allocation's own figure.
    expect(only?.amount).toBe('11800.00');
    expect(only?.entries).toHaveLength(4);
  });

  it('reads the legs of an inventory-mode voucher, which use a different tag', () => {
    // THE REGRESSION THIS EXISTS FOR. Two thirds of the real sales
    // vouchers are in inventory mode and write their party leg under
    // `LEDGERENTRIES.LIST`; a reader that knew only
    // `ALLLEDGERENTRIES.LIST` found no legs at all on them and valued
    // every one at zero, which made every such invoice look like a total
    // disagreement with Zoho.
    const read = readTallyVouchers(
      envelope(voucher({ number: 'P0100002', inventoryMode: true })),
    );
    expect(read.vouchers[0]?.amount).toBe('11800.00');
    expect(read.vouchers[0]?.entries).toHaveLength(4);
  });

  it('falls back to the larger side of the double entry when no leg names the party', () => {
    const read = readTallyVouchers(
      envelope(
        voucher({
          number: 'P0100003',
          party: 'Southern Division Depot',
          legs: [
            { ledger: 'A Different Ledger', amount: '-2500.00' },
            { ledger: 'Sales Account', amount: '2000.00' },
            { ledger: 'Output IGST', amount: '500.00' },
          ],
        }),
      ),
    );
    expect(read.vouchers[0]?.amount).toBe('2500.00');
  });

  it('treats a leg with no AMOUNT as absent rather than crashing', () => {
    const read = readTallyVouchers(
      envelope(
        voucher({
          number: 'P0100004',
          legs: [
            { ledger: 'Northern Division Depot', amount: '-500.00' },
            { ledger: 'A Head With No Figure' },
          ],
        }),
      ),
    );
    expect(read.vouchers[0]?.entries[1]?.amount).toBeNull();
    expect(read.vouchers[0]?.amount).toBe('500.00');
  });

  it('reads the bill allocation names, which are sometimes the only document number', () => {
    const read = readTallyVouchers(
      envelope(
        voucher({
          legs: [
            {
              ledger: 'Northern Division Depot',
              amount: '-11800.00',
              bill: 'P01/00005',
            },
          ],
        }),
      ),
    );
    expect(read.vouchers[0]?.voucherNumber).toBeNull();
    expect(read.vouchers[0]?.billReferences).toEqual(['P01/00005']);
  });

  it('keeps every voucher type the census names and skips the rest without refusing', () => {
    const read = readTallyVouchers(
      envelope(
        voucher({ type: 'Sales', number: 'S1' }),
        voucher({ type: 'Credit Note', number: 'C1' }),
        voucher({ type: 'Debit Note', number: 'D1' }),
        voucher({ type: 'Payment', number: 'PAY1' }),
        voucher({ type: 'Journal', number: 'J1' }),
      ),
    );
    expect(read.voucherCount).toBe(5);
    expect(read.vouchers.map((entry) => entry.voucherType)).toEqual([
      'Sales',
      'Credit Note',
      'Debit Note',
    ]);
    // A Payment is not malformed; it is a different wave's problem.
    expect(read.refusals).toEqual([]);
  });

  it('reads cancelled and optional flags rather than dropping the voucher', () => {
    // RULING 22: skipped by the route, and named in its report — so the
    // reader has to hand them over rather than filter them out.
    const read = readTallyVouchers(
      envelope(
        voucher({ number: 'X1', cancelled: true }),
        voucher({ number: 'X2', optional: true }),
      ),
    );
    expect(read.vouchers.map((entry) => [entry.cancelled, entry.optional])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it('keeps a cancelled voucher TallyPrime stripped of its party and legs', () => {
    // THE REAL SHAPE, and the regression this exists for. TallyPrime
    // empties a cancelled voucher: all ten real ones carry no party
    // ledger, no voucher number and no accounting legs. Refusing them for
    // want of a party turned "ten cancelled, here they are" into "ten
    // could not be read" — which is the one thing ruling 22 is trying to
    // prevent.
    const read = readTallyVouchers(
      envelope(
        voucher({
          reference: 'REF-9',
          cancelled: true,
          party: '',
          legs: [],
        }),
      ),
    );
    expect(read.refusals).toEqual([]);
    expect(read.vouchers).toHaveLength(1);
    expect(read.vouchers[0]?.cancelled).toBe(true);
    expect(read.vouchers[0]?.partyLedger).toBe('');
    expect(read.vouchers[0]?.reference).toBe('REF-9');
    expect(read.vouchers[0]?.amount).toBe('0.00');
  });

  it('still refuses a LIVE voucher with no party ledger', () => {
    const read = readTallyVouchers(
      envelope(voucher({ number: 'Y1', party: '', legs: [] })),
    );
    expect(read.vouchers).toEqual([]);
    expect(read.refusals[0]?.reason).toMatch(/no party ledger/);
  });

  it('drops an illegal character reference instead of storing a control character', () => {
    const read = readTallyVouchers(
      envelope(voucher({ number: 'P0100006', party: 'North&#4;ern Depot' })),
    );
    expect(read.vouchers[0]?.partyLedger).toBe('Northern Depot');
  });

  it('skips a narration that runs across lines instead of reading it as structure', () => {
    // The masters reader found this the hard way: a value carrying a
    // newline is written across several lines, and any of them that looks
    // tag-shaped was counted as an element opening — leaving the depth
    // one too deep for the rest of the voucher, so every direct field
    // after it was dropped.
    const body = voucher({ number: 'P0100007' }).replace(
      '      <ISINVOICE>Yes</ISINVOICE>',
      [
        '      <NARRATION>first line',
        '<GUID>not-a-guid</GUID>',
        'last</NARRATION>',
      ].join('\n'),
    );
    const read = readTallyVouchers(envelope(body));
    expect(read.vouchers[0]?.guid).toMatch(/^00000000-/);
    expect(read.vouchers[0]?.voucherNumber).toBe('P0100007');
  });

  it('refuses a voucher with no GUID, no date or no party, by line, and keeps the rest', () => {
    const noGuid = voucher({ number: 'A1' }).replace(/^ *<GUID>.*<\/GUID>$/m, '');
    const badDate = voucher({ number: 'A2', date: '20210230' });
    const noParty = voucher({ number: 'A3', party: '' });
    const read = readTallyVouchers(
      envelope(noGuid, badDate, noParty, voucher({ number: 'A4' })),
    );
    expect(read.vouchers.map((entry) => entry.voucherNumber)).toEqual(['A4']);
    expect(read.refusals).toHaveLength(3);
    expect(read.refusals.map((refusal) => refusal.voucherNumber)).toEqual([
      'A1',
      'A2',
      'A3',
    ]);
    expect(read.refusals.every((refusal) => refusal.lineNumber > 0)).toBe(true);
  });

  it('refuses a second voucher carrying a GUID the file already used', () => {
    const read = readTallyVouchers(
      envelope(
        voucher({ guid: 'same-guid', number: 'B1' }),
        voucher({ guid: 'same-guid', number: 'B2' }),
      ),
    );
    expect(read.vouchers).toHaveLength(1);
    expect(read.refusals[0]?.reason).toMatch(/same GUID/);
  });

  it('refuses a file that is not a Tally envelope at all', () => {
    expect(() => readTallyVouchers(utf16('name,amount\nfoo,1\n'))).toThrow(
      TallyImportError,
    );
  });

  it('refuses a truncated export as truncated, with where it stops', () => {
    const whole = envelope(voucher({ number: 'C1' })).toString('utf16le');
    const cut = whole.slice(0, whole.indexOf('<PARTYLEDGERNAME>'));
    let thrown: unknown;
    try {
      readTallyVouchers(utf16(cut));
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(TallyImportError);
    expect((thrown as TallyImportError).code).toBe('TALLY_EXPORT_TRUNCATED');
    expect((thrown as TallyImportError).message).toMatch(/\d+ bytes/);
  });

  it('refuses an export with no closing envelope', () => {
    const whole = envelope(voucher({ number: 'C2' })).toString('utf16le');
    const cut = whole.replace('</ENVELOPE>', '');
    let thrown: unknown;
    try {
      readTallyVouchers(utf16(cut));
    } catch (cause) {
      thrown = cause;
    }
    expect((thrown as TallyImportError).code).toBe('TALLY_EXPORT_TRUNCATED');
  });

  it('refuses a file with no line breaks rather than assembling it into one string', () => {
    const oneLine = envelope(voucher({ number: 'C3' }))
      .toString('utf16le')
      .replaceAll('\n', ' ');
    expect(() => readTallyVouchers(utf16(oneLine))).toThrow(TallyImportError);
  });
});

describe('matchTallyVouchers', () => {
  function read(...specs: VoucherSpec[]) {
    return readTallyVouchers(envelope(...specs.map((spec) => voucher(spec)))).vouchers;
  }

  it('matches on the number, the reference or a bill allocation, ignoring punctuation', () => {
    const vouchers = read(
      { number: 'P01-00001' },
      { reference: 'p01/00002' },
      {
        legs: [
          { ledger: 'Northern Division Depot', amount: '-11800.00', bill: 'P01 00003' },
        ],
      },
    );
    const result = matchTallyVouchers(vouchers, [
      invoice({ id: 'a', invoiceNumber: 'P0100001' }),
      invoice({ id: 'b', invoiceNumber: 'P0100002' }),
      invoice({ id: 'c', invoiceNumber: 'P0100003' }),
    ]);
    expect(result.links.map((link) => link.invoiceId).sort()).toEqual(['a', 'b', 'c']);
    expect(result.links.every((link) => link.method === 'exact_number')).toBe(true);
    expect(result.unmatched).toEqual([]);
  });

  it('leaves a voucher no invoice matches unmatched rather than guessing', () => {
    const result = matchTallyVouchers(read({ number: 'P0199999' }), [
      invoice({ id: 'a', invoiceNumber: 'P0100001' }),
    ]);
    expect(result.links).toEqual([]);
    expect(result.unmatched.map((entry) => entry.voucherNumber)).toEqual(['P0199999']);
  });

  it('matches a renumbered document on the serial, confirmed by the amount', () => {
    // The census found five of these: Tally and Zoho agree on the
    // five-digit serial and disagree on the customer-code segment in the
    // middle. The confirmation is the amount here.
    const result = matchTallyVouchers(read({ number: 'P0100042' }), [
      invoice({ id: 'a', invoiceNumber: 'P0700042', total: '11800.00' }),
    ]);
    expect(result.links).toHaveLength(1);
    expect(result.links[0]?.method).toBe('serial_tolerant');
    expect(result.serialCollisions).toBe(0);
  });

  it('confirms a serial match on the GSTIN when the amounts differ', () => {
    const result = matchTallyVouchers(
      read({ number: 'P0100043', gstin: '09AAACT2727Q1ZW' }),
      [
        invoice({
          id: 'a',
          invoiceNumber: 'P0700043',
          total: '99999.00',
          customerName: 'A Legal Name Nobody Types',
          customerGstin: '09AAACT2727Q1ZW',
        }),
      ],
    );
    expect(result.links[0]?.method).toBe('serial_tolerant');
  });

  it('REFUSES a serial match confirmed by nothing — the false-collision guard', () => {
    // CENSUS § 4.3, and the reason serial-tolerant matching is allowed at
    // all. One real pair shares five digits across two unrelated
    // customers, different amounts, five months apart. Serial alone would
    // have tied them together for good.
    const result = matchTallyVouchers(
      read({
        number: 'P0100044',
        party: 'Northern Division Depot',
        gstin: '09AAACT2727Q1ZW',
      }),
      [
        invoice({
          id: 'a',
          invoiceNumber: 'P0900044',
          total: '250000.00',
          customerName: 'An Entirely Different Customer',
          customerGstin: '27AAACT2727Q1ZW',
        }),
      ],
    );
    expect(result.links).toEqual([]);
    expect(result.serialCollisions).toBe(1);
    expect(result.unmatched).toHaveLength(1);
  });

  it('never treats a bare five-digit number as a serial', () => {
    // A number with no prefix is not distinctive enough to be evidence:
    // matching on it would tie two documents together because both
    // happened to end in the same five digits.
    const result = matchTallyVouchers(read({ number: '00042' }), [
      invoice({ id: 'a', invoiceNumber: 'P0700042', total: '11800.00' }),
    ]);
    expect(result.links).toEqual([]);
  });

  it('does not match a credit note, which reverses an invoice rather than being one', () => {
    const result = matchTallyVouchers(
      read({ type: 'Credit Note', number: 'P0100001' }),
      [invoice({ id: 'a', invoiceNumber: 'P0100001' })],
    );
    expect(result.links).toEqual([]);
    // Nor does it join the pre-Zoho population, which becomes register
    // rows: a credit note is not an invoice raised.
    expect(result.unmatched).toEqual([]);
  });

  it('reconciles over the connected component, not the pair', () => {
    // ONE VOUCHER COVERING TWO BILLS. Per pair the figures disagree
    // wildly; over the component they agree exactly, and a per-pair
    // comparison would have reported two disputes that are not there.
    const vouchers = read({
      number: 'P0100050',
      reference: 'P0100051',
      legs: [{ ledger: 'Northern Division Depot', amount: '-30000.00' }],
    });
    const result = matchTallyVouchers(vouchers, [
      invoice({ id: 'a', invoiceNumber: 'P0100050', total: '10000.00' }),
      invoice({ id: 'b', invoiceNumber: 'P0100051', total: '20000.00' }),
    ]);
    expect(result.links).toHaveLength(2);
    expect(result.componentCount).toBe(1);
    expect(result.disputedComponentCount).toBe(0);
    expect(result.links.every((link) => link.disputed)).toBe(false);
  });

  it('flags every link in a component whose two sides disagree (ruling 21)', () => {
    const vouchers = read({
      number: 'P0100060',
      reference: 'P0100061',
      legs: [{ ledger: 'Northern Division Depot', amount: '-30000.00' }],
    });
    const result = matchTallyVouchers(vouchers, [
      invoice({ id: 'a', invoiceNumber: 'P0100060', total: '10000.00' }),
      invoice({ id: 'b', invoiceNumber: 'P0100061', total: '25000.00' }),
    ]);
    expect(result.disputedComponentCount).toBe(1);
    expect(result.links.every((link) => link.disputed)).toBe(true);
    expect(result.links[0]?.componentTallyTotal).toBe('30000.00');
    expect(result.links[0]?.componentInvoiceTotal).toBe('35000.00');
  });

  it('tolerates a rupee of rounding between the two systems', () => {
    const result = matchTallyVouchers(read({ number: 'P0100070' }), [
      invoice({ id: 'a', invoiceNumber: 'P0100070', total: '11799.40' }),
    ]);
    expect(result.disputedComponentCount).toBe(0);
    const bigger = matchTallyVouchers(read({ number: 'P0100071' }), [
      invoice({ id: 'b', invoiceNumber: 'P0100071', total: '11798.00' }),
    ]);
    expect(bigger.disputedComponentCount).toBe(1);
  });
});
