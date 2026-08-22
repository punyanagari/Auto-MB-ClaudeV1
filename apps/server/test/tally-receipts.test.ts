import { describe, expect, it } from 'vitest';
import { type TallyLedgerFacts, readTallyReceipts } from '../src/tally-receipts.js';

/**
 * Reading TallyPrime's railway receipts into payments with per-head
 * deduction attribution (migration 0120).
 *
 * EVERY VOUCHER AND EVERY LEDGER IN THIS FILE IS INVENTED. The export this
 * reader was built against is a real company's ledger and no party name,
 * ledger name or figure of it may enter the repository. What is reproduced
 * here is its SHAPE — UTF-16LE with a byte-order mark and no XML
 * declaration, one tag per line, engine flags everywhere, Tally's
 * negative-is-a-debit convention, a head line with no `AMOUNT` element at
 * all — with values that belong to nobody.
 *
 * What is proved, in the order the module's risks run:
 *
 *   1. THE ARITHMETIC. `gross = net + Σ heads` on a conforming receipt,
 *      with round-off folded into the net in BOTH directions (ruling 16) —
 *      the fold is what keeps 125 real receipts from being refused over a
 *      paisa;
 *   2. THE HEAD MAPPING, from the ledger census's group ancestry rather
 *      than from ledger names, plus the one head the owner ruled on by
 *      name — `Contracual Deduction` → liquidated damages (question 14,
 *      closed 23 Aug 2026);
 *   3. RULING 10: a head named with no amount imports as 0.00, FLAGGED;
 *   4. WHAT IS SKIPPED rather than refused — bank-party receipts and
 *      plain collections, both wave T4's;
 *   5. WHAT IS REFUSED BY NAME — rulings 19 and 20, a credited head, and
 *      anything that does not reconcile;
 *   6. RULING 17's first route: the work code the security-deposit head
 *      carries, and the ambiguity that proposes nothing.
 *
 * The reader is a pure function of some bytes and a census, so everything
 * below runs without a database, an organisation or a session. What it
 * becomes on the wire is `tally-receipts.integration.test.ts`.
 */

/** The export's own encoding: UTF-16LE with a BOM and no XML declaration. */
function utf16(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

interface Leg {
  readonly ledger: string;
  /** Tally's sign: negative is a debit. Omit entirely to reproduce a leg
   * with no `AMOUNT` element, which the real export carries on 88 lines. */
  readonly amount?: string;
  readonly bill?: string;
}

interface VoucherSpec {
  readonly type?: string;
  readonly guid?: string;
  readonly date?: string;
  readonly number?: string;
  readonly party?: string;
  readonly narration?: string;
  readonly cancelled?: boolean;
  readonly optional?: boolean;
  readonly legs?: readonly Leg[];
}

let guidCounter = 0;

function leg(spec: Leg): string[] {
  return [
    '      <ALLLEDGERENTRIES.LIST>',
    '       <OLDAUDITENTRYIDS.LIST TYPE="Number">',
    '        <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>',
    '       </OLDAUDITENTRYIDS.LIST>',
    `       <LEDGERNAME>${spec.ledger}</LEDGERNAME>`,
    ...(spec.amount === undefined ? [] : [`       <AMOUNT>${spec.amount}</AMOUNT>`]),
    ...(spec.bill === undefined
      ? ['       <BILLALLOCATIONS.LIST>       </BILLALLOCATIONS.LIST>']
      : [
          '       <BILLALLOCATIONS.LIST>',
          `        <NAME>${spec.bill}</NAME>`,
          '        <BILLTYPE>Agst Ref</BILLTYPE>',
          // The sub-allocation's own AMOUNT, which the reader must NOT
          // take as the leg's figure.
          '        <AMOUNT>-1.00</AMOUNT>',
          '       </BILLALLOCATIONS.LIST>',
        ]),
    '      </ALLLEDGERENTRIES.LIST>',
  ];
}

function voucher(spec: VoucherSpec = {}): string {
  guidCounter += 1;
  const guid =
    spec.guid ??
    `00000000-0000-4000-8000-000000000000-${String(guidCounter).padStart(8, '0')}`;
  return [
    `     <VOUCHER REMOTEID="${guid}" VCHTYPE="${spec.type ?? 'Receipt'}" ACTION="Create">`,
    '      <LANGUAGENAME.LIST TYPE="String"/>',
    `      <DATE>${spec.date ?? '20240512'}</DATE>`,
    `      <GUID>${guid}</GUID>`,
    `      <VOUCHERTYPENAME>${spec.type ?? 'Receipt'}</VOUCHERTYPENAME>`,
    '      <ALTERID> 4210</ALTERID>',
    `      <VOUCHERNUMBER>${spec.number ?? '118'}</VOUCHERNUMBER>`,
    `      <PARTYLEDGERNAME>${spec.party ?? 'Northern Division'}</PARTYLEDGERNAME>`,
    ...(spec.narration === undefined
      ? []
      : [`      <NARRATION>${spec.narration}</NARRATION>`]),
    `      <ISCANCELLED>${spec.cancelled === true ? 'Yes' : 'No'}</ISCANCELLED>`,
    `      <ISOPTIONAL>${spec.optional === true ? 'Yes' : 'No'}</ISOPTIONAL>`,
    '      <BANKALLOCATIONS.LIST>      </BANKALLOCATIONS.LIST>',
    ...(spec.legs ?? conformingLegs()).flatMap((entry) => leg(entry)),
    '     </VOUCHER>',
  ].join('\n');
}

/** The census's § 3 shape, in miniature: gross credited to the customer,
 * net debited to the bank, every deduction to its own head. */
function conformingLegs(): readonly Leg[] {
  return [
    { ledger: 'Northern Division', amount: '1000000.00' },
    { ledger: 'State Bank Current A/c', amount: '-880000.00' },
    { ledger: 'SD Northern PL-203', amount: '-50000.00' },
    { ledger: 'TDS on Railway Bills AY 24-25', amount: '-20000.00' },
    { ledger: 'CGST TDS 1%', amount: '-10000.00' },
    { ledger: 'SGST TDS 1%', amount: '-10000.00' },
    { ledger: 'Bill Copy', amount: '-1000.00' },
    { ledger: 'Contracual Deduction', amount: '-29000.00' },
  ];
}

function envelope(...vouchers: string[]): Buffer {
  return utf16(
    [
      '<ENVELOPE>',
      ' <BODY>',
      '  <IMPORTDATA>',
      '   <REQUESTDATA>',
      ...vouchers,
      '   </REQUESTDATA>',
      '  </IMPORTDATA>',
      ' </BODY>',
      '</ENVELOPE>',
      '',
    ].join('\n'),
  );
}

/** The ledger census (0118) this wave reads, with the group ancestry that
 * decides which leg is which. */
function ledger(
  name: string,
  groupPath: readonly string[],
  extra: Partial<TallyLedgerFacts> = {},
): [string, TallyLedgerFacts] {
  return [
    name,
    {
      name,
      groupPath,
      classification: 'other',
      plCode: null,
      proposedContactId: null,
      proposedContactMethod: null,
      ...extra,
    },
  ];
}

const CENSUS = new Map<string, TallyLedgerFacts>([
  ledger(
    'Northern Division',
    ['Railway Authority', 'Sundry Debtors', 'Current Assets'],
    {
      classification: 'customer',
      proposedContactId: '11111111-1111-4111-8111-111111111111',
      proposedContactMethod: 'gstin',
    },
  ),
  ledger(
    'Southern Division',
    ['Railway Authority', 'Sundry Debtors', 'Current Assets'],
    {
      classification: 'customer',
    },
  ),
  ledger('State Bank Current A/c', ['Bank Accounts', 'Current Assets']),
  ledger('Overdraft A/c', ['Bank OD A/c', 'Loans (Liability)']),
  ledger('SD Northern PL-203', ['Railway Security Deposits', 'Current Assets'], {
    plCode: 'PL-203',
    classification: 'instrument',
  }),
  ledger('SD Southern PL-77', ['Railway Security Deposits', 'Current Assets'], {
    plCode: 'PL-77',
    classification: 'instrument',
  }),
  ledger('TDS on Railway Bills AY 24-25', ['Tds on Railway Bills', 'Current Assets']),
  ledger('TDS suffered AY 23-24', ['TDS & SAT AY 23-24', 'Current Assets']),
  ledger('CGST TDS 1%', ['GST- TDS', 'Duties & Taxes', 'Current Liabilities']),
  ledger('SGST TDS 1%', ['GST- TDS', 'Duties & Taxes', 'Current Liabilities']),
  ledger('Bill Copy', ['Contractual Deductions', 'Indirect Expenses']),
  ledger('Contracual Deduction', ['Contractual Deductions', 'Indirect Expenses']),
  ledger('Round Off', ['Indirect Expenses']),
  // The real export files every surcharge ledger under an assessment-year
  // group; see the finding-9 case below.
  ledger('Surcharge on IT', ['TDS & SAT AY 23-24', 'Income Tax Provisions']),
]);

describe('readTallyReceipts', () => {
  it('reads the census shape: gross = net + heads, with every head mapped', () => {
    const read = readTallyReceipts(envelope(voucher()), CENSUS);

    expect(read.receipts).toHaveLength(1);
    expect(read.refused).toHaveLength(0);
    expect(read.skipped).toHaveLength(0);
    const receipt = read.receipts[0];
    expect(receipt?.counterpartyLedger).toBe('Northern Division');
    expect(receipt?.gross).toBe('1000000.00');
    expect(receipt?.net).toBe('880000.00');
    expect(receipt?.deductionTotal).toBe('120000.00');
    // The contact comes from the census's own proposal (ruling 8), not
    // from a second matcher.
    expect(receipt?.contactId).toBe('11111111-1111-4111-8111-111111111111');
    expect(receipt?.contactMatchMethod).toBe('gstin');
    expect(
      receipt?.deductions.map((line) => [line.head, line.amount, line.tallyLedgerName]),
    ).toStrictEqual([
      ['security_deposit', '50000.00', 'SD Northern PL-203'],
      ['income_tax_tds', '20000.00', 'TDS on Railway Bills AY 24-25'],
      ['gst_tds', '10000.00', 'CGST TDS 1%'],
      ['gst_tds', '10000.00', 'SGST TDS 1%'],
      // RULING 15: a real railway deduction with no 0114 head, in the
      // bucket, WITH the ledger name that says which.
      ['other', '1000.00', 'Bill Copy'],
      // THE RULING OF 23 AUGUST 2026, question 14.
      ['liquidated_damages', '29000.00', 'Contracual Deduction'],
    ]);
  });

  it('maps the assessment-year TDS groups to income tax, by ancestry', () => {
    const read = readTallyReceipts(
      envelope(
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '1000.00' },
            { ledger: 'State Bank Current A/c', amount: '-900.00' },
            { ledger: 'TDS suffered AY 23-24', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.receipts[0]?.deductions[0]?.head).toBe('income_tax_tds');
  });

  it('folds round-off into the net in both directions (ruling 16)', () => {
    const debited = readTallyReceipts(
      envelope(
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '1000.37' },
            { ledger: 'State Bank Current A/c', amount: '-900.00' },
            { ledger: 'Round Off', amount: '-0.37' },
            { ledger: 'CGST TDS 1%', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(debited.refused).toHaveLength(0);
    expect(debited.receipts[0]?.net).toBe('900.37');
    expect(debited.receipts[0]?.roundOff).toBe('0.37');
    expect(debited.receipts[0]?.deductionTotal).toBe('100.00');

    // A CREDITED round-off, which is what 13 real receipts carry and what
    // an earlier reading of the census mistook for a second party line.
    const credited = readTallyReceipts(
      envelope(
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '999.63' },
            { ledger: 'Round Off', amount: '0.37' },
            { ledger: 'State Bank Current A/c', amount: '-900.00' },
            { ledger: 'CGST TDS 1%', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(credited.refused).toHaveLength(0);
    expect(credited.receipts[0]?.net).toBe('899.63');
    expect(credited.receipts[0]?.roundOff).toBe('-0.37');
    expect(credited.receipts[0]?.roundOffLineCount).toBe(1);
  });

  it('imports a head with no AMOUNT as 0.00 and flags it (ruling 10)', () => {
    const read = readTallyReceipts(
      envelope(
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '1000.00' },
            { ledger: 'State Bank Current A/c', amount: '-900.00' },
            { ledger: 'CGST TDS 1%', amount: '-100.00' },
            // Named on the voucher with no figure at all.
            { ledger: 'Bill Copy' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.refused).toHaveLength(0);
    const missing = read.receipts[0]?.deductions.find(
      (line) => line.tallyLedgerName === 'Bill Copy',
    );
    expect(missing?.amount).toBe('0.00');
    expect(missing?.amountMissing).toBe(true);
    // And it changes no figure: the arithmetic still closes.
    expect(read.receipts[0]?.deductionTotal).toBe('100.00');
  });

  it('books a censused head with no 0114 counterpart to the other bucket', () => {
    // RULING 15's bucket is for a ledger the census HOLDS and 0114 has no
    // head for. A ledger the census does not hold at all is a different
    // thing entirely and refuses the voucher — see the finding-4 case.
    const read = readTallyReceipts(
      envelope(
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '1000.00' },
            { ledger: 'State Bank Current A/c', amount: '-900.00' },
            { ledger: 'Bill Copy', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.receipts[0]?.deductions[0]?.head).toBe('other');
    expect(read.receipts[0]?.deductions[0]?.tallyLedgerName).toBe('Bill Copy');
  });

  it('leaves bank-party receipts and plain collections to wave T4', () => {
    const read = readTallyReceipts(
      envelope(
        // A loan drawdown, an EMD refund, an FDR maturity: the party is a
        // bank and no customer is credited.
        voucher({
          party: 'Overdraft A/c',
          legs: [
            { ledger: 'Unsecured Loan', amount: '500000.00' },
            { ledger: 'Overdraft A/c', amount: '-500000.00' },
          ],
        }),
        // A plain collection: no deduction at all.
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '1000.00' },
            { ledger: 'State Bank Current A/c', amount: '-1000.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.receipts).toHaveLength(0);
    expect(read.refused).toHaveLength(0);
    expect(read.skipped.map((skip) => skip.reason)).toStrictEqual([
      'bank_party',
      'no_deduction',
    ]);
  });

  it('refuses a receipt crediting two customers (ruling 20)', () => {
    const read = readTallyReceipts(
      envelope(
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '600.00' },
            { ledger: 'Southern Division', amount: '400.00' },
            { ledger: 'State Bank Current A/c', amount: '-900.00' },
            { ledger: 'CGST TDS 1%', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.receipts).toHaveLength(0);
    expect(read.refused[0]?.reason).toMatch(/more than one customer ledger/);
  });

  it('refuses a customer ledger used as a deduction head (ruling 19)', () => {
    const read = readTallyReceipts(
      envelope(
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '1000.00' },
            { ledger: 'State Bank Current A/c', amount: '-900.00' },
            { ledger: 'Southern Division', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.receipts).toHaveLength(0);
    expect(read.refused[0]?.reason).toMatch(/as if it were a deduction head/);
  });

  it('refuses a deduction head on the credit side', () => {
    const read = readTallyReceipts(
      envelope(
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '1000.00' },
            { ledger: 'SD Southern PL-77', amount: '100.00' },
            { ledger: 'State Bank Current A/c', amount: '-1000.00' },
            { ledger: 'CGST TDS 1%', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.receipts).toHaveLength(0);
    expect(read.refused[0]?.reason).toMatch(/which is not a customer/);
  });

  it('refuses a receipt that does not reconcile, by name', () => {
    const read = readTallyReceipts(
      envelope(
        voucher({
          number: '4242',
          legs: [
            { ledger: 'Northern Division', amount: '1000.00' },
            { ledger: 'State Bank Current A/c', amount: '-800.00' },
            { ledger: 'CGST TDS 1%', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.receipts).toHaveLength(0);
    expect(read.refused[0]?.voucher.voucherNumber).toBe('4242');
    expect(read.refused[0]?.reason).toMatch(/does not reconcile/);
  });

  it('reads the work code off the security-deposit head, and refuses to guess between two', () => {
    const one = readTallyReceipts(envelope(voucher()), CENSUS);
    expect(one.receipts[0]?.securityDepositPlCode).toBe('PL-203');

    const two = readTallyReceipts(
      envelope(
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '1000.00' },
            { ledger: 'State Bank Current A/c', amount: '-800.00' },
            { ledger: 'SD Northern PL-203', amount: '-100.00' },
            { ledger: 'SD Southern PL-77', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    // Two codes on one receipt propose NOTHING — ruling 6's discipline.
    expect(two.receipts[0]?.securityDepositPlCode).toBeNull();
  });

  it('keeps the bill allocations and skips every other voucher type', () => {
    const read = readTallyReceipts(
      envelope(
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '1000.00', bill: 'PS/2024/0918' },
            { ledger: 'State Bank Current A/c', amount: '-900.00' },
            { ledger: 'CGST TDS 1%', amount: '-100.00' },
          ],
        }),
        voucher({ type: 'Payment' }),
        voucher({ type: 'Journal' }),
      ),
      CENSUS,
    );
    expect(read.receipts[0]?.billReferences).toStrictEqual(['PS/2024/0918']);
    // A Payment voucher is not malformed; it is another wave's problem,
    // and it is neither refused nor counted as a receipt.
    expect(read.voucherCount).toBe(3);
    expect(read.receiptCount).toBe(1);
    expect(read.refusals).toHaveLength(0);
  });

  /* --- the coordinator's review of #180 ---------------------------------- */

  it('refuses a voucher naming one deduction ledger twice (finding 2)', () => {
    // The line key is (voucher, ledger name) — the census's own, and
    // migration 0120's unique index. Two legs naming one ledger are
    // therefore ONE row: the second collides, the heads sum short of the
    // stated total, and the deferred constraint refuses the whole
    // transaction at COMMIT with nothing naming the voucher. Refused
    // here, by name, before a byte is written.
    const read = readTallyReceipts(
      envelope(
        voucher({
          number: '7001',
          legs: [
            { ledger: 'Northern Division', amount: '1000.00' },
            { ledger: 'State Bank Current A/c', amount: '-800.00' },
            { ledger: 'CGST TDS 1%', amount: '-100.00' },
            { ledger: 'CGST TDS 1%', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.receipts).toHaveLength(0);
    expect(read.refused[0]?.kind).toBe('duplicate_head_ledger');
    expect(read.refused[0]?.voucher.voucherNumber).toBe('7001');
    expect(read.refused[0]?.reason).toMatch(/CGST TDS 1%/);
  });

  it('refuses a debit leg naming a ledger the census does not hold (finding 4)', () => {
    // THE MULTI-BANK CASE, which is what makes this a defect rather than
    // tidiness: a second bank account absent from the census is not a
    // bank to this reader, so it became an `other` deduction — the
    // receipt still balanced, and the register quietly said the railway
    // had withheld money it actually paid.
    const read = readTallyReceipts(
      envelope(
        voucher({
          number: '7002',
          legs: [
            { ledger: 'Northern Division', amount: '1000.00' },
            { ledger: 'State Bank Current A/c', amount: '-500.00' },
            { ledger: 'Second Bank Not In The Census', amount: '-400.00' },
            { ledger: 'CGST TDS 1%', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.receipts).toHaveLength(0);
    expect(read.refused[0]?.kind).toBe('uncensused_ledger');
    expect(read.refused[0]?.reason).toMatch(/Second Bank Not In The Census/);
  });

  it('refuses a receipt that credits nothing (finding 5)', () => {
    // `gross_amount > 0` is a CHECK on the header. A degenerate
    // correction voucher — everything zero — reconciles perfectly and is
    // not a payment of anything, and meeting that CHECK mid-commit would
    // name a constraint rather than a voucher.
    const read = readTallyReceipts(
      envelope(
        voucher({
          number: '7003',
          // `-0.00` is a debit of nothing — Tally's sign convention with
          // a zero magnitude, which is what a correction voucher writes.
          legs: [
            { ledger: 'Northern Division', amount: '0.00' },
            { ledger: 'State Bank Current A/c', amount: '-0.00' },
            { ledger: 'CGST TDS 1%', amount: '-0.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.receipts).toHaveLength(0);
    expect(read.refused[0]?.kind).toBe('zero_gross');
  });

  it('maps the income-tax surcharge by its own group (finding 9)', () => {
    // The real export files all three surcharge ledgers UNDER a
    // `TDS & SAT AY <year>` group, so the assessment-year prefix already
    // reaches them and no head of their own is needed. The census's
    // § 4.4 wording implied a separate head and is corrected; this is the
    // assertion that keeps the reading honest.
    const read = readTallyReceipts(
      envelope(
        voucher({
          legs: [
            { ledger: 'Northern Division', amount: '1000.00' },
            { ledger: 'State Bank Current A/c', amount: '-900.00' },
            { ledger: 'Surcharge on IT', amount: '-100.00' },
          ],
        }),
      ),
      CENSUS,
    );
    expect(read.receipts[0]?.deductions[0]?.head).toBe('income_tax_tds');
  });

  it('counts cancelled and optional receipts rather than importing them (ruling 22)', () => {
    const read = readTallyReceipts(
      envelope(voucher({ cancelled: true }), voucher({ optional: true }), voucher()),
      CENSUS,
    );
    expect(read.cancelled).toHaveLength(1);
    expect(read.optional).toHaveLength(1);
    expect(read.receipts).toHaveLength(1);
  });
});
