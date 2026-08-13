import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The PL-270 settlement corpus, held to its own manifest.
 *
 * These are real documents from one Work: three Measurement Books, the
 * three IWRCMS railway bills raised from them, and the three tax invoices
 * raised against those bills. The extracted text is committed (person
 * names pseudonymised); the source PDFs are not, and must not be.
 *
 * This test needs no PDFs and no network. It proves two things:
 *
 *  - the committed fixtures are the ones the manifest describes, so a
 *    later edit to a fixture cannot silently invalidate the findings
 *    recorded against it; and
 *  - the settlement arithmetic the closure feature will rely on actually
 *    holds on real data -- the bill total IS the invoice grand total, the
 *    taxable value is that divided by 1.18, and the MB-to-bill link is by
 *    measurement sequence rather than by string equality.
 *
 * Signature verification against these documents lives in
 * `pdf-signature-corpus.test.ts`, which is env-gated because it needs the
 * PDFs. The verdicts it produced are recorded in this manifest so they
 * survive without them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'railway-settlement');

interface Document {
  readonly id: string;
  readonly kind: 'measurement_book' | 'railway_bill' | 'tax_invoice';
  readonly fixture_file: string;
  readonly fixture_sha256: string;
  readonly measurement_number?: string;
  readonly settles_measurement_book?: string;
  readonly settles_bill?: string;
  readonly bill_amount_including_gst?: number;
  readonly taxable_value?: number;
  readonly total_including_tax?: number;
  readonly signature_expectation: { readonly signature_count: number };
}

interface ExecutedValueRule {
  readonly worked_example_pl270: {
    readonly gst_basis: 'inclusive' | 'exclusive';
    readonly gst_rate: number;
    readonly loa_net_bid_value_gst_inclusive: number;
    readonly loa_net_bid_value_gst_exclusive: number;
    readonly executed_percent_on_inclusive_basis: number;
    readonly executed_percent_if_bases_are_MIXED: number;
  };
}

const manifest = JSON.parse(
  await readFile(path.join(FIXTURES, 'corpus.json'), 'utf8'),
) as {
  readonly documents: readonly Document[];
  readonly executed_value_rule: ExecutedValueRule;
};

const byId = new Map(manifest.documents.map((d) => [d.id, d]));

/** '.../OAM/L2/03' and '.../OAM/FL2/03' both yield 3. */
function measurementSequence(measurementNumber: string): number {
  const match = /\/OAM\/F?L\d+\/(\d+)$/.exec(measurementNumber);
  expect(match, `unparseable measurement number: ${measurementNumber}`).not.toBeNull();
  return Number(match?.[1]);
}

describe('PL-270 settlement corpus', () => {
  it('holds nine documents: three MBs, three bills, three invoices', () => {
    expect(manifest.documents).toHaveLength(9);
    const counts = { measurement_book: 0, railway_bill: 0, tax_invoice: 0 };
    for (const document of manifest.documents) counts[document.kind] += 1;
    expect(counts).toEqual({ measurement_book: 3, railway_bill: 3, tax_invoice: 3 });
  });

  it('every fixture on disk is the one the manifest describes', async () => {
    for (const document of manifest.documents) {
      const bytes = await readFile(path.join(FIXTURES, document.fixture_file));
      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(digest, `${document.fixture_file} has changed since it was recorded`).toBe(
        document.fixture_sha256,
      );
    }
  });

  it('links each bill to its measurement book by sequence, not by string', () => {
    for (const bill of manifest.documents.filter((d) => d.kind === 'railway_bill')) {
      const book = byId.get(bill.settles_measurement_book ?? '');
      expect(
        book,
        `${bill.id} names a measurement book that is not in the corpus`,
      ).toBeDefined();

      // The trap this guards: the strings differ (L2 on the book, FL2 on
      // the bill), so equality fails while the documents genuinely pair.
      expect(bill.measurement_number).not.toBe(book?.measurement_number);
      expect(measurementSequence(bill.measurement_number ?? '')).toBe(
        measurementSequence(book?.measurement_number ?? ''),
      );
    }
  });

  it('settles each invoice against its bill at rupee granularity', () => {
    for (const invoice of manifest.documents.filter((d) => d.kind === 'tax_invoice')) {
      const bill = byId.get(invoice.settles_bill ?? '');
      expect(
        bill,
        `${invoice.id} names a bill that is not in the corpus`,
      ).toBeDefined();

      const billTotal = bill?.bill_amount_including_gst ?? 0;
      const invoiceTotal = invoice.total_including_tax ?? 0;

      // Whole rupees agree exactly...
      expect(Math.round(invoiceTotal), `${invoice.id} vs ${String(bill?.id)}`).toBe(
        billTotal,
      );

      // ...but the paise do not always, so an exact-equality closure check
      // would refuse INV-3 (17327888.01 against a bill of 17327888).
      //
      // Compared in integer paise, not in rupees: `17327888.01 - 17327888`
      // is 0.010000001639 in IEEE 754, so a `<= 0.01` tolerance on the
      // float difference fails on the very case it exists to allow. This
      // is why money is carried in minor units everywhere else in the
      // codebase, and the closure check must do the same.
      const paise = (rupees: number): number => Math.round(rupees * 100);
      expect(Math.abs(paise(invoiceTotal) - paise(billTotal))).toBeLessThanOrEqual(1);
    }
  });

  it('derives each invoice taxable value from the GST-inclusive bill total', () => {
    for (const invoice of manifest.documents.filter((d) => d.kind === 'tax_invoice')) {
      const taxable = invoice.taxable_value ?? 0;
      const total = invoice.total_including_tax ?? 0;
      // Works contract at 18% (CGST 9 + SGST 9), rates GST-inclusive.
      expect(Math.abs(taxable * 1.18 - total), invoice.id).toBeLessThanOrEqual(0.02);
    }
  });

  it('computes the same executed value on either GST basis, but not on a mixed one', () => {
    // Owner ruling 2026-08-13: LOA rates are USUALLY GST-inclusive at 18%
    // (works contracts sit in the 18% slab), but some LOAs quote
    // GST-exclusive rates. Rare, and real. So the basis is a per-Work
    // attribute read off its LOA -- never a constant -- and executed value
    // is computed on the recorded basis.
    //
    // Once the basis is known, either side gives the same percentage,
    // because both scale by the same factor. The failure this guards is
    // MIXING them, which is the natural mistake: bills state a
    // GST-inclusive figure while invoices state a taxable one, so reaching
    // for whichever number is nearest silently moves the answer by the
    // whole GST wedge.
    const { worked_example_pl270: example } = manifest.executed_value_rule;
    const rate = 1 + example.gst_rate;
    const bills = manifest.documents.filter((d) => d.kind === 'railway_bill');
    const invoices = manifest.documents.filter((d) => d.kind === 'tax_invoice');

    const billTotals = bills.reduce(
      (sum, b) => sum + (b.bill_amount_including_gst ?? 0),
      0,
    );
    const taxableTotals = invoices.reduce((sum, i) => sum + (i.taxable_value ?? 0), 0);

    // This Work's LOA is an inclusive one, and its two denominators are
    // one GST factor apart. Rounding the exclusive figure to paise leaves
    // a one-paisa drift, so the tolerance is a paisa rather than zero.
    expect(example.gst_basis).toBe('inclusive');
    expect(
      Math.abs(
        example.loa_net_bid_value_gst_exclusive * rate -
          example.loa_net_bid_value_gst_inclusive,
      ),
    ).toBeLessThanOrEqual(0.01);

    const inclusive = (billTotals / example.loa_net_bid_value_gst_inclusive) * 100;
    const exclusive = (taxableTotals / example.loa_net_bid_value_gst_exclusive) * 100;
    const mixed = (taxableTotals / example.loa_net_bid_value_gst_inclusive) * 100;

    // Consistent bases agree...
    expect(Math.abs(inclusive - exclusive)).toBeLessThanOrEqual(0.001);
    expect(inclusive).toBeCloseTo(example.executed_percent_on_inclusive_basis, 3);

    // ...and the mixed basis is out by exactly the GST wedge, which is
    // what makes the mistake recognisable when it shows up in a report.
    expect(mixed).toBeCloseTo(example.executed_percent_if_bases_are_MIXED, 3);
    expect(inclusive / mixed).toBeCloseTo(rate, 4);

    // The dangerous direction, stated as arithmetic: reading an EXCLUSIVE
    // LOA as inclusive compares GST-inclusive bill totals against a
    // contract value that excludes GST, OVERSTATING execution by the GST
    // factor. By the time such a work reports 100% executed it is really
    // at 84.75%, so it can be marked completed with roughly a sixth of the
    // contract still unbilled -- silently, and in the direction that loses
    // money rather than the one that merely annoys.
    const trueExecutionWhenItReportsComplete = 100 / rate;
    expect(trueExecutionWhenItReportsComplete).toBeCloseTo(84.75, 2);
  });

  it('records the signature shape each document actually had', () => {
    for (const document of manifest.documents) {
      const expected =
        document.kind === 'measurement_book'
          ? 1
          : document.kind === 'railway_bill'
            ? 3
            : 0;
      expect(document.signature_expectation.signature_count, document.id).toBe(
        expected,
      );
    }
  });

  it('keeps the pseudonyms: no real signatory name reaches the repository', async () => {
    // The three humans who signed these documents are third parties. If a
    // fixture is ever regenerated from source, this fails rather than
    // quietly publishing their names.
    const names = [
      /dewangan/i,
      /dwivedi/i,
      /avinash/i,
      /bhausaheb/i,
      /tamas/i,
      /nishant/i,
    ];
    for (const document of manifest.documents) {
      const text = await readFile(path.join(FIXTURES, document.fixture_file), 'utf8');
      for (const name of names) {
        expect(name.test(text), `${document.fixture_file} leaks ${String(name)}`).toBe(
          false,
        );
      }
    }
  });
});
