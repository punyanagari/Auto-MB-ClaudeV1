import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  convertAmountToBasis,
  executedPercent,
  portfolioExecutedPercent,
  toTaxableBasis,
  type WorkGstBasis,
} from '../src/executed-value.js';

/**
 * Executed value on a Work's RECORDED GST basis (migration 0062).
 *
 * The arithmetic is not invented here. It was worked against the real
 * PL-270 documents — three Measurement Books, the three railway bills
 * raised from them and the three tax invoices raised against those bills
 * — and recorded in `fixtures/railway-settlement/corpus.json` under
 * `executed_value_rule`, which `railway-settlement-corpus.test.ts` holds
 * to the documents themselves. This file drives the PRODUCTION module
 * with those same figures, so the module and the corpus cannot drift
 * apart: if someone changes the conversion, the recorded percentages stop
 * coming out.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await readFile(
    path.join(here, 'fixtures', 'railway-settlement', 'corpus.json'),
    'utf8',
  ),
) as {
  readonly executed_value_rule: {
    readonly worked_example_pl270: {
      readonly gst_basis: 'inclusive' | 'exclusive';
      readonly gst_rate: number;
      readonly loa_net_bid_value_gst_inclusive: number;
      readonly loa_net_bid_value_gst_exclusive: number;
      readonly sum_of_bill_totals_gst_inclusive: number;
      readonly sum_of_invoice_taxable_values: number;
      readonly executed_percent_on_inclusive_basis: number;
      readonly executed_percent_on_exclusive_basis: number;
      readonly executed_percent_if_bases_are_MIXED: number;
    };
  };
};

const pl270 = manifest.executed_value_rule.worked_example_pl270;

/** The fixture states money as JSON numbers; the module takes exact
 * decimal strings, which is what the columns hold. */
const money = (value: number): string => value.toFixed(2);

const RATE = pl270.gst_rate * 100; // 0.18 -> 18 percent
const rate = RATE.toFixed(2);

/** PL-270 as it is: an inclusive letter. */
const inclusiveWork: WorkGstBasis = { basis: 'inclusive', ratePercent: rate };
/** The same money, on the letter that quotes rates the other way — the
 * rare case the whole attribute exists for. */
const exclusiveWork: WorkGstBasis = { basis: 'exclusive', ratePercent: rate };

const contractInclusive = money(pl270.loa_net_bid_value_gst_inclusive);
const contractExclusive = money(pl270.loa_net_bid_value_gst_exclusive);
const billTotals = money(pl270.sum_of_bill_totals_gst_inclusive);
const invoiceTaxable = money(pl270.sum_of_invoice_taxable_values);

/** Percentages are reported to four places; the corpus records four. */
const percent = (value: string | null): number => Number(value);

describe('executed value on a recorded GST basis', () => {
  it('the corpus this test is driven by is the inclusive case', () => {
    // Guards the direction of every expectation below: if the recorded
    // example ever became an exclusive letter, the assertions that name
    // `inclusiveWork` would be testing the wrong thing quietly.
    expect(pl270.gst_basis).toBe('inclusive');
    expect(rate).toBe('18.00');
  });

  describe('conversion between bases', () => {
    it('strips and re-adds GST, back to within a paisa', () => {
      // Not to zero, and it cannot be: 169,228,497.35 / 1.18 does not land
      // on a whole paisa. The corpus records the same drift on the real
      // documents, which is why the closure checks compare in paise with a
      // one-paisa tolerance rather than demanding equality.
      const stripped = convertAmountToBasis(
        contractInclusive,
        'inclusive',
        'exclusive',
        rate,
      );
      expect(stripped).toBe(contractExclusive);

      const restored = convertAmountToBasis(stripped, 'exclusive', 'inclusive', rate);
      const paise = (value: string): number => Math.round(Number(value) * 100);
      expect(Math.abs(paise(restored) - paise(contractInclusive))).toBeLessThanOrEqual(
        1,
      );
    });

    it('is exactly identity when the bases already agree', () => {
      // The ordinary path for every ordinary Work: no rounding is applied
      // at all, so an inclusive Work's figures survive untouched.
      expect(convertAmountToBasis(billTotals, 'inclusive', 'inclusive', rate)).toBe(
        billTotals,
      );
      expect(convertAmountToBasis(billTotals, 'exclusive', 'exclusive', rate)).toBe(
        billTotals,
      );
    });

    it('rounds half away from zero rather than truncating', () => {
      // BigInt division truncates, which would bias every conversion
      // downward by up to a paisa — invisible per line and systematic in
      // aggregate. 1.00 exclusive at 18% is 1.18 exactly; 0.53 is 0.6254,
      // which must round UP to 0.63, not down to 0.62.
      expect(convertAmountToBasis('1.00', 'exclusive', 'inclusive', rate)).toBe('1.18');
      expect(convertAmountToBasis('0.53', 'exclusive', 'inclusive', rate)).toBe('0.63');
      expect(convertAmountToBasis('0.00', 'inclusive', 'exclusive', rate)).toBe('0.00');
    });

    it('refuses a figure that is not exact money', () => {
      // A float that reached this far would corrupt an authoritative
      // amount silently; it fails loudly instead.
      expect(() =>
        convertAmountToBasis('1.005', 'inclusive', 'exclusive', rate),
      ).toThrow(/exact money figure/);
      expect(() => convertAmountToBasis('1e5', 'inclusive', 'exclusive', rate)).toThrow(
        /exact money figure/,
      );
    });
  });

  describe('the same Work, on either consistent basis', () => {
    it('reads 29.4874% from GST-inclusive bill totals on an inclusive letter', () => {
      const answer = executedPercent(
        billTotals,
        'inclusive',
        contractInclusive,
        inclusiveWork,
      );
      expect(percent(answer)).toBeCloseTo(pl270.executed_percent_on_inclusive_basis, 3);
    });

    it('reads the SAME 29.4874% from taxable values on an exclusive letter', () => {
      // Both sides scale by the same factor, so the percentage does not
      // move. This is the property that makes "record the basis" a
      // complete answer: neither basis is privileged, only consistency is.
      const answer = executedPercent(
        invoiceTaxable,
        'exclusive',
        contractExclusive,
        exclusiveWork,
      );
      expect(percent(answer)).toBeCloseTo(pl270.executed_percent_on_exclusive_basis, 3);
      expect(percent(answer)).toBeCloseTo(pl270.executed_percent_on_inclusive_basis, 3);
    });

    it('converts a taxable figure onto an inclusive letter and lands on the same answer', () => {
      // The mixed-basis case handled CORRECTLY: an invoice's taxable value
      // measured against an inclusive contract value, with the numerator's
      // own basis declared. This is what the module exists to make easy.
      const answer = executedPercent(
        invoiceTaxable,
        'exclusive',
        contractInclusive,
        inclusiveWork,
      );
      expect(percent(answer)).toBeCloseTo(pl270.executed_percent_on_inclusive_basis, 3);
    });
  });

  describe('the mixed-basis regression', () => {
    it('reproduces 24.9893% when a taxable figure is misdeclared as inclusive', () => {
      // The natural mistake, since bills state a GST-inclusive figure and
      // invoices state a taxable one: take whichever number is to hand and
      // divide. The answer is out by exactly the GST wedge.
      const wrong = executedPercent(
        invoiceTaxable,
        'inclusive', // <- the lie
        contractInclusive,
        inclusiveWork,
      );
      expect(percent(wrong)).toBeCloseTo(pl270.executed_percent_if_bases_are_MIXED, 3);

      const right = executedPercent(
        invoiceTaxable,
        'exclusive',
        contractInclusive,
        inclusiveWork,
      );
      // 29.4874 / 24.9893 = 1.18 — the wedge, which is what makes the
      // mistake recognisable in a report rather than merely wrong.
      expect(percent(right) / percent(wrong)).toBeCloseTo(1 + pl270.gst_rate, 4);
    });

    it('overstates execution when an EXCLUSIVE letter is recorded as inclusive', () => {
      // The dangerous direction, and the reason the attribute is per-Work.
      // Take a Work whose letter is exclusive, and record it wrongly as
      // inclusive: its GST-inclusive bill totals are then compared against
      // a contract value that excludes GST.
      const truth = executedPercent(
        billTotals,
        'inclusive',
        contractExclusive,
        exclusiveWork,
      );
      const misrecorded = executedPercent(
        billTotals,
        'inclusive',
        contractExclusive,
        // the same Work, mis-recorded
        { basis: 'inclusive', ratePercent: rate },
      );
      expect(percent(misrecorded)).toBeGreaterThan(percent(truth));
      expect(percent(misrecorded) / percent(truth)).toBeCloseTo(1 + pl270.gst_rate, 4);
    });

    it('reads 100% while the Work is really at 84.75% executed', () => {
      // Stated as the harm rather than as a ratio: a Work mis-recorded
      // this way can be marked completed with roughly a sixth of its
      // contract still unbilled. Completion is the irreversible act, so
      // this is the number the ruling is about.
      const factor = 1 + pl270.gst_rate;
      // A bill total that exactly exhausts a GST-EXCLUSIVE contract value
      // is the contract value plus its GST.
      const fullyBilled = convertAmountToBasis(
        contractExclusive,
        'exclusive',
        'inclusive',
        rate,
      );
      const correct = executedPercent(
        fullyBilled,
        'inclusive',
        contractExclusive,
        exclusiveWork,
      );
      expect(percent(correct)).toBeCloseTo(100, 3);

      // Now the same Work with the basis mis-recorded, at the point where
      // it claims to be finished: the money that WOULD read 100% is only
      // 84.75% of what the contract actually owes.
      const readsComplete = contractExclusive; // 100% on the wrong reading
      const reallyExecuted = (Number(readsComplete) / Number(fullyBilled)) * 100;
      expect(reallyExecuted).toBeCloseTo(100 / factor, 2);
      expect(reallyExecuted).toBeCloseTo(84.75, 2);
    });
  });

  describe('a contract value of zero', () => {
    it('is no answer rather than 0% or 100%', () => {
      // A Work with no contract value must not be able to report itself
      // fully executed, and must not report 0% either — there is nothing
      // to be a percentage of.
      expect(executedPercent('1000.00', 'inclusive', '0.00', inclusiveWork)).toBeNull();
      expect(portfolioExecutedPercent([])).toBeNull();
    });
  });

  describe('across Works of different bases', () => {
    const portfolio = [
      {
        contractValue: contractInclusive,
        numerator: billTotals,
        numeratorBasis: 'inclusive' as const,
        gst: inclusiveWork,
      },
      {
        contractValue: contractExclusive,
        numerator: invoiceTaxable,
        numeratorBasis: 'exclusive' as const,
        gst: exclusiveWork,
      },
    ];

    it('restates every term as taxable before summing', () => {
      // Both Works are at the same 29.4874%, one quoted inclusive and one
      // exclusive. A portfolio percentage that mixes bases would land
      // somewhere between 29.4874 and the wedge-shifted figure; a correct
      // one lands on 29.4874 exactly, whatever the mix.
      const answer = portfolioExecutedPercent(portfolio);
      expect(percent(answer)).toBeCloseTo(pl270.executed_percent_on_inclusive_basis, 3);
    });

    it('agrees with naive addition ONLY while every Work sits at the same percentage', () => {
      // Worth stating, because it is why this defect hides. When two Works
      // execute at the same rate, the GST factor scales numerator and
      // denominator alike and the mixing cancels exactly — naive rupee
      // addition gets the right answer, and a test built on a uniform
      // portfolio would prove nothing.
      const naive =
        ((Number(billTotals) + Number(invoiceTaxable)) /
          (Number(contractInclusive) + Number(contractExclusive))) *
        100;
      expect(naive).toBeCloseTo(pl270.executed_percent_on_inclusive_basis, 3);
    });

    it('diverges from naive addition as soon as the Works differ', () => {
      // The real portfolio, where it does not cancel: one inclusive Work
      // fully billed, one exclusive Work not started, equal in size once
      // both are stated as taxable value. The true answer is 50%.
      const mixed = [
        {
          contractValue: '11800.00',
          numerator: '11800.00',
          numeratorBasis: 'inclusive' as const,
          gst: inclusiveWork,
        },
        {
          contractValue: '10000.00',
          numerator: '0.00',
          numeratorBasis: 'exclusive' as const,
          gst: exclusiveWork,
        },
      ];
      expect(percent(portfolioExecutedPercent(mixed))).toBeCloseTo(50, 3);

      // Adding the printed rupees instead — an inclusive 11,800 against an
      // exclusive 10,000 — reads 54.13%, overstating the portfolio by four
      // points because the billed Work's figure carries GST that its
      // idle neighbour's contract value does not.
      const naive = (11800 / (11800 + 10000)) * 100;
      expect(naive).toBeCloseTo(54.128, 3);
      expect(naive).toBeGreaterThan(50);
    });

    it('skips a Work with no contract value instead of poisoning the ratio', () => {
      const withEmpty = [
        ...portfolio,
        {
          contractValue: '0.00',
          numerator: '5000.00',
          numeratorBasis: 'inclusive' as const,
          gst: inclusiveWork,
        },
      ];
      expect(portfolioExecutedPercent(withEmpty)).toBe(
        portfolioExecutedPercent(portfolio),
      );
    });

    it('states cross-Work sums on the taxable basis', () => {
      expect(toTaxableBasis(contractInclusive, 'inclusive', inclusiveWork)).toBe(
        contractExclusive,
      );
      expect(toTaxableBasis(contractExclusive, 'exclusive', exclusiveWork)).toBe(
        contractExclusive,
      );
    });
  });

  describe('a rate other than 18%', () => {
    it('carries two fraction digits of rate exactly', () => {
      // The column is numeric(5,2) and the master notifies rates like
      // 12.00 and 5.00; nothing here assumes 18.
      const at5: WorkGstBasis = { basis: 'inclusive', ratePercent: '5.00' };
      expect(convertAmountToBasis('105.00', 'inclusive', 'exclusive', '5.00')).toBe(
        '100.00',
      );
      expect(percent(executedPercent('105.00', 'inclusive', '105.00', at5))).toBe(100);
      expect(toTaxableBasis('105.00', 'inclusive', at5)).toBe('100.00');
    });

    it('is a no-op at a rate of zero', () => {
      const nil: WorkGstBasis = { basis: 'inclusive', ratePercent: '0.00' };
      expect(toTaxableBasis('100.00', 'inclusive', nil)).toBe('100.00');
    });
  });
});
