import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCorpus, reviewLoaLetter } from '@auto-mb/loa-parser';
import { convertAmountToBasis } from '../src/executed-value.js';

/**
 * What an MB-backed tax invoice WOULD bill, against what the railway
 * actually settled.
 *
 * This is a CHARACTERISATION test for a confirmed defect that is
 * deliberately NOT fixed here — see
 * `docs/FINDING-2026-08-13-invoice-money-basis.md`. It asserts the gap
 * rather than the desired behaviour, because changing an invoice amount
 * needs an owner ruling and this file must not pre-empt one.
 *
 * It exists so the finding cannot rot. Every figure below is read from a
 * real document or produced by running the real parser; nothing is
 * hand-copied into an assertion. WHEN THE DEFECTS ARE FIXED, THIS FILE
 * MUST FAIL, and the fix should replace each "gap" assertion with the
 * settled behaviour in the same commit.
 *
 * Two independent defects sit on one money path:
 *
 *   A. `resolveTaxableValue` (tax-invoices/submit.ts) takes the
 *      Measurement Book total VERBATIM as the invoice's TAXABLE value and
 *      then adds GST — but on an ordinary LOA the rates behind that total
 *      are already GST-inclusive.
 *
 *   B. `work_items.effective_rate` holds the letter's ADVERTISED rate.
 *      The tender's accepted-rate percentage is never applied to any rate
 *      anywhere in the product.
 *
 * Both overstate on a below-par letter, and they multiply.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(here, 'fixtures', 'railway-settlement');

interface Document {
  readonly id: string;
  readonly kind: 'measurement_book' | 'railway_bill' | 'tax_invoice';
  readonly settles_bill?: string;
  readonly bill_amount_including_gst?: number;
  readonly taxable_value?: number;
  readonly total_including_tax?: number;
}

const manifest = JSON.parse(
  await readFile(path.join(CORPUS, 'corpus.json'), 'utf8'),
) as {
  readonly documents: readonly Document[];
  readonly executed_value_rule: {
    readonly worked_example_pl270: { readonly gst_rate: number };
  };
};

const GST_RATE = manifest.executed_value_rule.worked_example_pl270.gst_rate; // 0.18
const RATE_PERCENT = (GST_RATE * 100).toFixed(2); // '18.00'

const invoices = manifest.documents.filter((d) => d.kind === 'tax_invoice');
const byId = new Map(manifest.documents.map((d) => [d.id, d]));

const money = (value: number): string => value.toFixed(2);
const paise = (value: string | number): number => Math.round(Number(value) * 100);

describe('what an MB-backed invoice would bill, against the real settlement', () => {
  describe('defect A: the MB total is billed as if it excluded GST', () => {
    it('the railway bill states a GST-INCLUSIVE amount and adds no tax to it', async () => {
      // The bill's own header and footer, quoted from the document. This
      // is the fact the whole finding rests on, so it is asserted against
      // the fixture rather than trusted from a summary.
      const bill = await readFile(path.join(CORPUS, 'BILL-1.raw.txt'), 'utf8');
      expect(bill).toMatch(/Rate is inclusive of\s*\n\s*GST\s+Yes/);
      expect(bill).toMatch(/Bill Amount \(Rs\.\) \(Including Tax \(GST\)\)\s+24516112/);
      // The schedule total and the "including tax" line are the SAME
      // figure: no tax is added anywhere on the bill.
      expect(bill).toMatch(/Total Amount\(Rs\.\)\s+0\.0\s+24516112\s+24516112/);
    });

    it('the real invoice makes the bill its GRAND total, never its taxable value', () => {
      for (const invoice of invoices) {
        const bill = byId.get(invoice.settles_bill ?? '');
        const billTotal = bill?.bill_amount_including_gst ?? 0;

        // The bill IS the grand total (to the rupee).
        expect(Math.round(invoice.total_including_tax ?? 0), invoice.id).toBe(
          billTotal,
        );

        // ...and the taxable value is that divided by 1.18. Computed with
        // the production primitive, so this test also pins the conversion
        // the eventual fix will use.
        const derived = convertAmountToBasis(
          money(billTotal),
          'inclusive',
          'exclusive',
          RATE_PERCENT,
        );
        expect(
          Math.abs(paise(derived) - paise(invoice.taxable_value ?? 0)),
          `${invoice.id}: taxable should be the bill less GST`,
        ).toBeLessThanOrEqual(1);
      }
    });

    it('GAP: billing the MB total as taxable overstates every invoice by exactly the GST factor', () => {
      for (const invoice of invoices) {
        const bill = byId.get(invoice.settles_bill ?? '');
        // On a GST-inclusive Work the MB total IS the bill amount: both
        // are qty x the same contract rate.
        const mbTotal = bill?.bill_amount_including_gst ?? 0;

        // What submit.ts does today: taxable := MB total, then add GST.
        const wouldCharge = convertAmountToBasis(
          money(mbTotal),
          'exclusive', // <- the assumption, stated as the lie it is
          'inclusive',
          RATE_PERCENT,
        );

        const correct = invoice.total_including_tax ?? 0;
        expect(Number(wouldCharge)).toBeGreaterThan(correct);
        expect(Number(wouldCharge) / correct, invoice.id).toBeCloseTo(1 + GST_RATE, 4);
      }
    });
  });

  describe('defect B: item rates are the ADVERTISED rates, not the accepted ones', () => {
    // Runs the real parser over every real letter. If a future change
    // makes the confirmed rate the accepted one, these flip — which is
    // exactly the signal wanted.
    const letters = loadCorpus();

    it('covers all six corpus letters, both pricing shapes', () => {
      expect(letters).toHaveLength(6);
      const shapes = new Set(
        letters.map(
          (letter) => reviewLoaLetter(letter.text).pricingShape.pricing_shape,
        ),
      );
      expect(shapes).toEqual(new Set(['letter_percentage', 'per_schedule']));
    });

    it.each(loadCorpus().map((letter) => letter.manifest.id))(
      'GAP: %s sums its item rates to the ADVERTISED value, not the contract value',
      (id) => {
        const letter = letters.find((entry) => entry.manifest.id === id);
        if (letter === undefined) throw new Error(`no corpus letter ${id}`);
        const review = reviewLoaLetter(letter.text);

        // sum(qty x printed unit rate), in exact paise.
        let total = 0n;
        // Fully anchored, one digit run then an optional fraction, no
        // nested quantifier; linear on all inputs. Same shape as
        // mb-compute.ts's DECIMAL_RE.
        /* eslint-disable security/detect-unsafe-regex */
        const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
        /* eslint-enable security/detect-unsafe-regex */
        for (const item of review.items) {
          const qty = DECIMAL.exec(item.qty.replace(/,/g, ''));
          const rate = DECIMAL.exec(item.unitRate.replace(/,/g, ''));
          expect(qty, `${id}: unparseable qty ${item.qty}`).not.toBeNull();
          expect(rate, `${id}: unparseable rate ${item.unitRate}`).not.toBeNull();
          const qtyMilli =
            BigInt(qty?.[1] ?? '0') * 1000n +
            BigInt((qty?.[2] ?? '').padEnd(3, '0').slice(0, 3));
          const ratePaise =
            BigInt(rate?.[1] ?? '0') * 100n +
            BigInt((rate?.[2] ?? '').padEnd(2, '0').slice(0, 2));
          total += (qtyMilli * ratePaise) / 1000n;
        }

        const { advertised_value: advertised, contract_value: contract } =
          review.pricingShape;
        expect(advertised, `${id} has no advertised value`).not.toBeNull();
        expect(contract, `${id} has no contract value`).not.toBeNull();

        // The rates the product would store sum to the ADVERTISED value...
        expect(
          Math.abs(Number(total) - paise(advertised ?? 0)),
          `${id}: item rates should sum to the advertised value`,
        ).toBeLessThanOrEqual(100);

        // ...and to the contract value only when the letter is at par, so
        // the two figures coincide. PL273-JHS is the only such letter.
        const matchesContract = Math.abs(Number(total) - paise(contract ?? 0)) <= 100;
        expect(matchesContract, `${id}: advertised vs contract`).toBe(
          id === 'PL273-JHS',
        );
      },
    );

    it('GAP: the gap runs BOTH ways — 29% short on one letter, 24.5% over on another', () => {
      // The direction follows the letter, which is why "always divide" is
      // as wrong as "never divide". Below par, Auto-MB overstates; above
      // par it understates, and the contractor loses the difference.
      const ratioOf = (id: string): number => {
        const letter = letters.find((entry) => entry.manifest.id === id);
        if (letter === undefined) throw new Error(`no corpus letter ${id}`);
        const shape = reviewLoaLetter(letter.text).pricingShape;
        return (shape.contract_value ?? 0) / (shape.advertised_value ?? 1);
      };
      expect(ratioOf('PL275-BKN')).toBeCloseTo(0.71, 2); // 29% below
      expect(ratioOf('PL281-BB')).toBeCloseTo(1.245, 3); // 24.5% ABOVE
      expect(ratioOf('PL273-JHS')).toBeCloseTo(1, 6); // at par: no gap
    });
  });

  describe('both defects together, on PL-270 Bill 1', () => {
    it('GAP: would invoice 37.8% above what the railway settled', () => {
      const bill = byId.get('BILL-1');
      const invoice = byId.get('INV-1');
      const settled = invoice?.total_including_tax ?? 0;
      expect(settled).toBe(24516112);

      // Schedule A of PL-270 is 14.35% below par, so the stored
      // (advertised) rate is the agreement rate divided by 0.8565 —
      // defect B inflates the MB total before defect A ever sees it.
      const scheduleFactor = 1 - 0.1435;
      const mbTotal = (bill?.bill_amount_including_gst ?? 0) / scheduleFactor;

      // Then the MB total is billed as taxable and GST is added on top.
      const wouldCharge = Number(
        convertAmountToBasis(money(mbTotal), 'exclusive', 'inclusive', RATE_PERCENT),
      );

      expect(wouldCharge / settled).toBeCloseTo((1 + GST_RATE) / scheduleFactor, 4);
      expect(wouldCharge / settled).toBeCloseTo(1.3777, 3);
      // In rupees, on one bill of one Work.
      expect(wouldCharge - settled).toBeGreaterThan(9_000_000);
    });
  });
});
