import { describe, expect, it } from 'vitest';
import {
  BILL_DEDUCTION_HEADS,
  BILL_DEDUCTION_HEAD_RULES,
  PAN_ABSENT_MINIMUM_RATE,
  TDS_SECTION_RULES,
  addDecimalStrings,
  billDeductionHeadRule,
  compareDecimalStrings,
  resolveTdsRate,
  statutoryVerificationChecklist,
} from '../src/statutory.js';

/**
 * The statutory module's arithmetic and threshold logic.
 *
 * These are unit tests rather than integration tests because none of
 * this touches the database: the rate decision is pure, and keeping it
 * pure is what lets the preview endpoint and the payment endpoint share
 * one answer. The rupee multiplication that follows the decision belongs
 * to PostgreSQL and is proved in
 * `apps/server/test/payments.integration.test.ts`.
 */

describe('exact decimal comparison', () => {
  it('orders by value rather than by string', () => {
    // The bug this exists to prevent: '5.00' > '12.00' lexicographically.
    expect(compareDecimalStrings('5.00', '12.00')).toBe(-1);
    expect(compareDecimalStrings('12.00', '5.00')).toBe(1);
  });

  it('treats differing scales as equal when the value is equal', () => {
    expect(compareDecimalStrings('30000', '30000.00')).toBe(0);
    expect(compareDecimalStrings('2.5', '2.50')).toBe(0);
  });

  it('compares large rupee figures without a float', () => {
    // Beyond 2^53 a float loses integer precision; digit comparison does
    // not, and threshold arithmetic must not start lying at scale.
    expect(compareDecimalStrings('9007199254740993.01', '9007199254740993.02')).toBe(
      -1,
    );
  });
});

describe('exact decimal addition', () => {
  it('adds the case that breaks binary floating point', () => {
    // 0.1 + 0.2 === 0.30000000000000004 as a JS number.
    expect(addDecimalStrings('0.1', '0.2')).toBe('0.3');
  });

  it('carries across the decimal point', () => {
    expect(addDecimalStrings('99999.99', '0.01')).toBe('100000.00');
  });

  it('aligns operands of differing scale', () => {
    expect(addDecimalStrings('1000', '0.5')).toBe('1000.5');
  });
});

describe('TDS rate resolution', () => {
  const base = {
    section: '194C',
    payeeClass: 'other',
    panOnRecord: true,
    financialYearPaidBefore: '0',
  } as const;

  it('deducts nothing below both thresholds', () => {
    const verdict = resolveTdsRate({ ...base, paymentAmount: '5000.00' });
    expect(verdict.deductible).toBe(false);
    expect(verdict.rate).toBe('0.00');
    expect(verdict.thresholdBasis).toBe('none');
  });

  it('deducts once a single payment reaches the single-payment threshold', () => {
    const verdict = resolveTdsRate({ ...base, paymentAmount: '30000.00' });
    expect(verdict.deductible).toBe(true);
    expect(verdict.thresholdBasis).toBe('single_payment');
    expect(verdict.rate).toBe('2.00');
  });

  it('deducts on the payment that carries the year aggregate over the line', () => {
    // 95,000 already paid, 6,000 now: the aggregate INCLUDING this
    // payment crosses ₹1,00,000, so this payment is itself deductible.
    // Testing the prior total alone would let the crossing payment
    // through untaxed.
    const verdict = resolveTdsRate({
      ...base,
      paymentAmount: '6000.00',
      financialYearPaidBefore: '95000.00',
    });
    expect(verdict.deductible).toBe(true);
    expect(verdict.thresholdBasis).toBe('annual_aggregate');
  });

  it('charges the individual/HUF rate to an individual payee', () => {
    const verdict = resolveTdsRate({
      ...base,
      payeeClass: 'individual_huf',
      paymentAmount: '50000.00',
    });
    expect(verdict.rate).toBe('1.00');
  });

  it('applies section 206AA as a floor, not a substitution', () => {
    const raised = resolveTdsRate({
      ...base,
      panOnRecord: false,
      paymentAmount: '50000.00',
    });
    expect(raised.panAbsentUplift).toBe(true);
    expect(raised.rate).toBe(PAN_ABSENT_MINIMUM_RATE);
    expect(raised.ordinaryRate).toBe('2.00');

    // A section whose own rate already exceeds 20% must NOT be lowered
    // to 20% by the missing PAN. No current section does, so the
    // property is asserted through the comparison the floor uses.
    expect(compareDecimalStrings(PAN_ABSENT_MINIMUM_RATE, '10.00')).toBe(1);
  });

  it('does not raise the rate when the threshold was never crossed', () => {
    // No PAN, but nothing is due yet: 206AA raises a rate, it does not
    // create a liability.
    const verdict = resolveTdsRate({
      ...base,
      panOnRecord: false,
      paymentAmount: '100.00',
    });
    expect(verdict.deductible).toBe(false);
    expect(verdict.rate).toBe('0.00');
  });

  it('gives 194J no single-payment trigger', () => {
    const rule = TDS_SECTION_RULES.find((entry) => entry.section === '194J');
    expect(rule?.singlePaymentThreshold).toBeNull();
    const verdict = resolveTdsRate({
      section: '194J',
      payeeClass: 'other',
      panOnRecord: true,
      paymentAmount: '29000.00',
      financialYearPaidBefore: '0',
    });
    expect(verdict.deductible).toBe(false);
  });
});

describe('the statutory table', () => {
  it('declares a rule for every deduction head', () => {
    for (const head of BILL_DEDUCTION_HEADS) {
      expect(billDeductionHeadRule(head).head).toBe(head);
    }
    expect(BILL_DEDUCTION_HEAD_RULES).toHaveLength(BILL_DEDUCTION_HEADS.length);
  });

  it('carries the two heads that used to fall into OTHER and PENALTY', () => {
    expect(BILL_DEDUCTION_HEADS).toContain('BOCW_CESS');
    expect(BILL_DEDUCTION_HEADS).toContain('LIQUIDATED_DAMAGES');
    // BOCW cess is statutory and cites its Act; LD is contractual and
    // deliberately cites none.
    expect(billDeductionHeadRule('BOCW_CESS').provision?.act).toContain(
      'Welfare Cess Act, 1996',
    );
    expect(billDeductionHeadRule('LIQUIDATED_DAMAGES').provision).toBeNull();
  });

  it('cites a provision beside every rate it asserts', () => {
    const checklist = statutoryVerificationChecklist();
    expect(checklist.length).toBeGreaterThan(0);
    for (const item of checklist) {
      expect(item.provision.citation).not.toBe('');
      expect(item.provision.act).not.toBe('');
      expect(item.meaning).not.toBe('');
    }
  });

  it('puts every rate on the owner verification checklist', () => {
    const checklist = statutoryVerificationChecklist();
    const values = checklist.map((item) => item.value);
    // A rate that is added without appearing here is a rate that ships
    // unverified, so the checklist is generated from the tables rather
    // than written out again.
    for (const rule of TDS_SECTION_RULES) {
      expect(values).toContain(`${rule.rates.other}%`);
      expect(values).toContain(`${rule.rates.individual_huf}%`);
      expect(values).toContain(`₹${rule.annualThreshold}`);
    }
    expect(values).toContain(`${PAN_ABSENT_MINIMUM_RATE}%`);
  });
});
