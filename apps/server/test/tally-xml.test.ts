import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTallyXml, type TallyExport } from '../src/tally-xml.js';

/**
 * The Tally import envelope, against a golden file.
 *
 * Golden rather than structural, and the reason is the same one
 * `mb-remark.test.ts` states for its own fixture: this output is consumed
 * by a program nobody here controls, so what matters is the exact bytes.
 * Tally's importer is unforgiving about tag names, nesting and the sign
 * convention, and a change that looked harmless in a structural assertion
 * — a renamed ledger, a dropped `ISDEEMEDPOSITIVE`, a date with hyphens —
 * is a file the accountant's desktop rejects with a message that names no
 * cause. So the whole envelope is pinned, and changing it means editing a
 * fixture on purpose.
 *
 * The blocks below the golden then state the three rules the golden alone
 * would not explain: the double-entry balance, the sign convention, and
 * the tax-arm exclusivity.
 */

const GOLDEN_PATH = new URL('./fixtures/tally-vouchers.v1.xml', import.meta.url);

/**
 * The sample, loaded from a versioned fixture rather than written inline
 * — the `mb-remark.test.ts` pattern, and for the same reason: the input
 * and the golden output are one artefact, and a fixture version pinned
 * beside them makes "regenerate the golden" a deliberate act with a
 * number attached to it. What is in the sample and why is in the
 * fixture's own `$comment`.
 */
const SAMPLE = JSON.parse(
  readFileSync(new URL('./fixtures/tally-vouchers.v1.json', import.meta.url), 'utf8'),
) as TallyExport & { readonly fixtureVersion: string };

/** Every AMOUNT in one voucher, as exact paise, so the balance can be
 * checked without floating point. The XML holds decimal strings; this
 * reads them as integers of paise the way `src/money.ts` does. */
function paise(amount: string): bigint {
  const negative = amount.startsWith('-');
  const digits = negative ? amount.slice(1) : amount;
  const [whole = '0', fraction = ''] = digits.split('.');
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -value : value;
}

function vouchers(xml: string): readonly string[] {
  return xml.split('<VOUCHER ').slice(1);
}

function amountsIn(voucher: string): readonly string[] {
  return [...voucher.matchAll(/<AMOUNT>([^<]*)<\/AMOUNT>/g)].map(
    (match) => match[1] ?? '',
  );
}

describe('the Tally import envelope', () => {
  it('is generated from the fixture version it pins', () => {
    expect(SAMPLE.fixtureVersion).toBe('tally-vouchers-v2');
  });

  it('matches the golden file byte for byte', () => {
    // Regenerate deliberately, never to make a red test green:
    //   node -e "..." > test/fixtures/tally-vouchers.v1.xml
    // and say in the pull request which of Tally's rules changed.
    expect(buildTallyXml(SAMPLE)).toBe(readFileSync(GOLDEN_PATH, 'utf8'));
  });

  it('carries the header Tally reads before anything else', () => {
    const xml = buildTallyXml(SAMPLE);
    expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(xml).toContain('<REPORTNAME>Vouchers</REPORTNAME>');
  });

  it('writes dates as YYYYMMDD, which is the only format Tally accepts', () => {
    expect(buildTallyXml(SAMPLE)).toContain('<DATE>20260514</DATE>');
    expect(buildTallyXml(SAMPLE)).not.toContain('2026-05-14');
  });

  it('escapes the ampersand a party name can carry', () => {
    const xml = buildTallyXml(SAMPLE);
    expect(xml).toContain('North Western Railway &amp; Co');
    expect(xml).not.toMatch(/Railway & Co/);
  });
});

describe('double entry', () => {
  it('balances every voucher to zero', () => {
    // The property Tally refuses a voucher for. It holds because the
    // frozen columns hold — taxable + cgst + sgst + igst = total is a
    // database invariant (0052) — so this is also a standing check that
    // the legs were assembled from those columns and not from anything
    // recomputed.
    for (const voucher of vouchers(buildTallyXml(SAMPLE))) {
      const total = amountsIn(voucher).reduce((sum, amount) => sum + paise(amount), 0n);
      expect(total, voucher.slice(0, 80)).toBe(0n);
    }
  });

  it('debits the party on a sale and credits it on a credit note', () => {
    const xml = buildTallyXml(SAMPLE);
    const [sale, , creditNote] = vouchers(xml);
    // Tally's sign convention, which is the single most common way a
    // hand-written import fails: a DEBIT is negative in the XML.
    expect(sale).toContain('<AMOUNT>-1475000.00</AMOUNT>');
    expect(creditNote).toContain('<AMOUNT>1475000.00</AMOUNT>');
  });

  it('debits the bank on a receipt and credits the party the sale debited', () => {
    const xml = buildTallyXml(SAMPLE);
    const receipt = vouchers(xml).at(-1) ?? '';
    expect(receipt).toContain('<LEDGERNAME>Bank</LEDGERNAME>');
    expect(receipt).toContain('<AMOUNT>-250000.50</AMOUNT>');
    // The property that makes the file reconcile, and the one the first
    // cut of this got wrong: the party credited by a receipt must be the
    // party debited by a sale. A receipt posted to a ledger no sale
    // touches leaves that account open in the accountant's books forever.
    const [sale] = vouchers(xml);
    const partyOf = (voucher: string): string =>
      /<PARTYLEDGERNAME>([^<]*)<\/PARTYLEDGERNAME>/.exec(voucher)?.[1] ?? '';
    expect(partyOf(receipt)).toBe(partyOf(sale ?? ''));
    expect(receipt).toContain(
      '<LEDGERNAME>North Western Railway &amp; Co</LEDGERNAME>',
    );
  });
});

describe('the tax legs', () => {
  it('writes CGST and SGST for an intra-state sale and no IGST at all', () => {
    const [sale] = vouchers(buildTallyXml(SAMPLE));
    expect(sale).toContain('<LEDGERNAME>Output CGST</LEDGERNAME>');
    expect(sale).toContain('<LEDGERNAME>Output SGST</LEDGERNAME>');
    expect(sale).not.toContain('Output IGST');
  });

  it('writes IGST alone for an inter-state sale', () => {
    const [, sale] = vouchers(buildTallyXml(SAMPLE));
    expect(sale).toContain('<LEDGERNAME>Output IGST</LEDGERNAME>');
    expect(sale).not.toContain('Output CGST');
  });

  it('names the buyer the invoice named, not a placeholder, when a GSTIN is absent', () => {
    // An unregistered buyer has no GSTIN and still has a name, and the
    // name is what the accountant's ledger is keyed by. The GSTIN only
    // decides whether the narration quotes one.
    const [, sale] = vouchers(buildTallyXml(SAMPLE));
    expect(sale).toContain('<PARTYLEDGERNAME>South Central Railway</PARTYLEDGERNAME>');
    expect(sale).not.toContain('GSTIN ');
  });
});
