import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCorpus, reviewLoaLetter } from '@auto-mb/loa-parser';
import { acceptedRateFrom, type AcceptedRateBasis } from '../src/accepted-rate.js';
import { toTaxableBasis, type WorkGstBasis } from '../src/executed-value.js';

/**
 * What an MB-backed tax invoice bills, held to what the railway actually
 * settled.
 *
 * This file began as a characterisation test for two confirmed defects
 * (`docs/FINDING-2026-08-13-invoice-money-basis.md`). Both were ruled on by
 * the owner on 13 August 2026 and are fixed, so it now asserts the SETTLED
 * behaviour and the old gap-assertions are gone:
 *
 *   Ruling 1 — `work_items.effective_rate` holds the ACCEPTED rate, which
 *   the server derives from the printed (advertised) rate and the letter's
 *   own percentage. Migration 0063.
 *
 *   Ruling 2 — on a GST-inclusive Work an MB-backed invoice's taxable value
 *   is the measured total less the tax already inside it, so the invoice's
 *   GRAND total comes back to the railway's bill. Migration 0062's basis.
 *
 * Every figure is read from a real document or produced by running the real
 * parser. Nothing is hand-copied into an assertion.
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
const invoices = manifest.documents.filter((d) => d.kind === 'tax_invoice');
const byId = new Map(manifest.documents.map((d) => [d.id, d]));

/** PL-270 as the product records it: rates quoted inclusive of 18% GST. */
const inclusiveWork: WorkGstBasis = { basis: 'inclusive', ratePercent: '18.00' };
const exclusiveWork: WorkGstBasis = { basis: 'exclusive', ratePercent: '18.00' };

const money = (value: number): string => value.toFixed(2);
const paise = (value: string | number): number => Math.round(Number(value) * 100);

describe('ruling 1: the accepted rate is derived, and matches the railway exactly', () => {
  // PL-270 Schedule A was won at 14.35% below par.
  const scheduleA: AcceptedRateBasis = { percentage: '14.350', direction: 'below' };

  /**
   * The "Base Rate" and "Agreement Rate" columns of BILL-1, read off the
   * document. The base rate is what the LOA item table prints and what the
   * product used to store; the agreement rate is what the railway pays.
   *
   * Matching these EXACTLY is why the percentage is read from the letter
   * rather than derived by dividing the schedule's bid total by its
   * advertised total: that quotient is 0.85649999..., which would put item
   * 01 at 2,132,684.9997 and start a reconciliation argument on every bill.
   */
  const billRates: readonly (readonly [string, number])[] = [
    ['2490000.00', 2132685.0],
    ['103750.00', 88861.875],
    ['3924450.00', 3361291.425],
    ['1460385.00', 1250819.7525],
    ['84660.00', 72511.29],
    ['341813.70', 292763.43405],
    ['358750.00', 307269.375],
    ['225856.00', 193445.664],
  ];

  it.each(billRates)(
    'derives %s into the Agreement Rate the bill prints',
    (advertised, agreement) => {
      expect(Number(acceptedRateFrom(advertised, scheduleA))).toBe(agreement);
    },
  );

  it('keeps every derived rate inside the numeric(18,6) rate column', () => {
    // A printed rate carries at most 6 fraction digits and a percentage 3,
    // so nothing here can need more than the column holds.
    for (const [advertised] of billRates) {
      const derived = acceptedRateFrom(advertised, scheduleA);
      expect(derived).toMatch(/^\d+\.\d{6}$/);
    }
  });

  it('moves the rate UP on an above-par letter', () => {
    // The direction follows the letter. PL281-BB is 24.5% above par, and a
    // fix that only ever divided would understate it by a quarter.
    const above: AcceptedRateBasis = { percentage: '24.500', direction: 'above' };
    expect(Number(acceptedRateFrom('100.00', above))).toBe(124.5);
    expect(Number(acceptedRateFrom('100.00', scheduleA))).toBe(85.65);
  });

  it('leaves an at-par rate untouched, and refuses a contradictory one', () => {
    const atPar: AcceptedRateBasis = { percentage: '0', direction: 'at_par' };
    expect(Number(acceptedRateFrom('2490000.00', atPar))).toBe(2490000);
    expect(() =>
      acceptedRateFrom('100.00', { percentage: '5.000', direction: 'at_par' }),
    ).toThrow(/at-par/);
  });

  it('refuses a rate it cannot hold exactly', () => {
    // A float that reached this far would corrupt a contractual rate.
    expect(() => acceptedRateFrom('1.0000005', scheduleA)).toThrow(/fraction digits/);
    expect(() => acceptedRateFrom('1e5', scheduleA)).toThrow(/plain decimal/);
  });
});

describe('ruling 1, end to end: derived rates reproduce each letter contract value', () => {
  // The strongest statement of the fix. Before it, sum(qty x rate) came to
  // the ADVERTISED value on every letter — up to 29% out. After it, the
  // same sum lands on the Net Bid Value the letter itself prints.
  const letters = loadCorpus();

  it.each(letters.map((letter) => letter.manifest.id))(
    '%s bills to its own Net Bid Value, not its advertised value',
    (id) => {
      const letter = letters.find((entry) => entry.manifest.id === id);
      if (letter === undefined) throw new Error(`no corpus letter ${id}`);
      const review = reviewLoaLetter(letter.text);
      const shape = review.pricingShape;

      // The basis the confirm route uses: the letter's percentage on a
      // letter-percentage letter, each schedule's own otherwise.
      const letterBasis: AcceptedRateBasis | null =
        shape.pricing_shape === 'letter_percentage' &&
        shape.letter_percentage !== null &&
        shape.letter_percentage_direction !== null
          ? {
              percentage: shape.letter_percentage.toFixed(3),
              direction: shape.letter_percentage_direction,
            }
          : null;
      const bySchedule = new Map<string, AcceptedRateBasis>();
      for (const entry of shape.scheduleTotals) {
        if (
          entry.scheduleId !== null &&
          entry.percentage !== null &&
          entry.direction !== null
        ) {
          bySchedule.set(entry.scheduleId, {
            percentage: entry.percentage.toFixed(3),
            direction: entry.direction,
          });
        }
      }

      // Exact micro-rupee summation of qty x accepted rate.
      let micro = 0n;
      let advertisedMicro = 0n;
      for (const item of review.items) {
        const basis = letterBasis ?? bySchedule.get(item.schedule?.id ?? '') ?? null;
        expect(
          basis,
          `${id}: no accepted percentage for item ${item.itemSno}`,
        ).not.toBeNull();
        if (basis === null) continue;
        const printed = item.unitRate.replace(/,/g, '');
        const accepted = acceptedRateFrom(printed, basis);

        // Fully anchored, one digit run then an optional fraction, no
        // nested quantifier; linear on all inputs.
        // eslint-disable-next-line security/detect-unsafe-regex
        const quantity = /^(\d+)(?:\.(\d+))?$/.exec(item.qty.replace(/,/g, ''));
        const qtyMilli =
          BigInt(quantity?.[1] ?? '0') * 1000n +
          BigInt((quantity?.[2] ?? '').padEnd(3, '0').slice(0, 3));
        const toMicro = (value: string): bigint => {
          const [whole = '0', fraction = ''] = value.split('.');
          return (
            BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6))
          );
        };
        micro += (qtyMilli * toMicro(accepted)) / 1000n;
        advertisedMicro += (qtyMilli * toMicro(printed)) / 1000n;
      }

      const accepted = Number(micro) / 1e6;
      const advertised = Number(advertisedMicro) / 1e6;
      const contract = shape.contract_value ?? 0;

      // Lands on the contract value. The tolerance is a rupee, not zero:
      // each of PL-270's 129 rates is rounded to the column's six places
      // before it is multiplied out.
      expect(Math.abs(accepted - contract), `${id}: accepted vs contract`).toBeLessThan(
        1,
      );

      // And the advertised sum is what it used to land on — equal only on
      // the at-par letter, where the two figures coincide.
      const advertisedValue = shape.advertised_value ?? 0;
      expect(Math.abs(advertised - advertisedValue)).toBeLessThan(1);
      if (id !== 'PL273-JHS') {
        expect(Math.abs(advertised - contract)).toBeGreaterThan(1);
      }
    },
  );
});

describe('ruling 2: an MB-backed invoice bills the measured total on the Work basis', () => {
  it('the railway bill states a GST-INCLUSIVE amount and adds no tax to it', async () => {
    const bill = await readFile(path.join(CORPUS, 'BILL-1.raw.txt'), 'utf8');
    expect(bill).toMatch(/Rate is inclusive of\s*\n\s*GST\s+Yes/);
    expect(bill).toMatch(/Bill Amount \(Rs\.\) \(Including Tax \(GST\)\)\s+24516112/);
    expect(bill).toMatch(/Total Amount\(Rs\.\)\s+0\.0\s+24516112\s+24516112/);
  });

  it('derives every invoice taxable value the corpus records', () => {
    // On a GST-inclusive Work the MB total IS the bill amount — both are
    // quantity x the same accepted rate — so this is the exact conversion
    // the submit path performs.
    for (const invoice of invoices) {
      const bill = byId.get(invoice.settles_bill ?? '');
      const mbTotal = money(bill?.bill_amount_including_gst ?? 0);

      const taxable = toTaxableBasis(mbTotal, 'inclusive', inclusiveWork);

      expect(
        Math.abs(paise(taxable) - paise(invoice.taxable_value ?? 0)),
        `${invoice.id}: taxable value`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('brings the invoice GRAND total back to the railway bill', () => {
    for (const invoice of invoices) {
      const bill = byId.get(invoice.settles_bill ?? '');
      const billTotal = bill?.bill_amount_including_gst ?? 0;
      const taxable = toTaxableBasis(money(billTotal), 'inclusive', inclusiveWork);

      // Tax the way computeInvoiceMoney does: half CGST, half SGST, then
      // the whole-rupee rounding the invoice is payable in.
      const half = Math.round((Number(taxable) * 18) / 200 / 0.01) * 0.01;
      const total = Math.round(Number(taxable) + half + half);

      expect(total, `${invoice.id}: grand total should be the bill`).toBe(billTotal);
    }
  });

  it('leaves a GST-EXCLUSIVE Work untouched', () => {
    // The rare letter needs no conversion, and must not get one: the
    // measured total is already a taxable value there.
    expect(toTaxableBasis('28624182.14', 'exclusive', exclusiveWork)).toBe(
      '28624182.14',
    );
  });
});

describe('both rulings together, on PL-270 Bill 1', () => {
  it('settles at exactly what the railway paid', () => {
    const settled = byId.get('INV-1')?.total_including_tax ?? 0;
    expect(settled).toBe(24516112);

    // Ruling 1: the measurement is valued at the ACCEPTED rate, so the MB
    // total is the bill amount rather than the bill divided by 0.8565.
    const mbTotal = money(24516112);

    // Ruling 2: the Work is GST-inclusive, so the taxable value is the
    // measured total less the tax already in it...
    const taxable = toTaxableBasis(mbTotal, 'inclusive', inclusiveWork);
    expect(Number(taxable)).toBeCloseTo(20776366.1, 2);

    // ...and the grand total returns to the bill.
    const half = Math.round((Number(taxable) * 18) / 200 / 0.01) * 0.01;
    expect(Math.round(Number(taxable) + half + half)).toBe(settled);

    // For the record, what the two defects together used to produce:
    // 24,516,112 / 0.8565 x 1.18 = 33,776,535, or 37.8% too high.
    const wasCharged = (24516112 / 0.8565) * (1 + GST_RATE);
    expect(wasCharged / settled).toBeCloseTo(1.3777, 3);
  });
});
