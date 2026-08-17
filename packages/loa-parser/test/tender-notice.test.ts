import { describe, expect, it } from 'vitest';
import { reviewTenderNotice } from '../src/tender-notice.js';

/** A notice in the shape Poppler's `-layout` view produces: labelled
 * lines, the name of work wrapped across two, Indian rupee grouping. */
const NOTICE = [
  'WESTERN RAILWAY',
  'NOTICE INVITING E-TENDER',
  '',
  'Tender No.: WR-MMCT-S&T-34/2026',
  'Inviting Authority: Western Railway, Mumbai Central Division',
  'Name of Work: Supply and commissioning of IP passenger information',
  'systems at twelve stations.',
  'Closing Date & Time: 18-09-2026 15:00 hrs',
  'Estimated Cost: Rs. 8,40,00,000/-',
  'EMD: Rs 16.80 Lakh',
  'Eligibility Criteria: Similar railway S&T works of 35% value in the last',
  'three financial years.',
  '',
  'Payment terms: as per the tender document.',
].join('\n');

describe('reviewTenderNotice', () => {
  it('reads the six first-page fields off a notice', () => {
    const review = reviewTenderNotice(NOTICE);

    expect(review.tenderNumber.value).toBe('WR-MMCT-S&T-34/2026');
    expect(review.authority.value).toBe('Western Railway, Mumbai Central Division');
    expect(review.title.value).toBe(
      'Supply and commissioning of IP passenger information systems at twelve stations.',
    );
    expect(review.bidClosesAtLocal.value).toBe('2026-09-18T15:00');
    expect(review.estimatedValue.value).toBe('84000000.00');
    expect(review.emdAmount.value).toBe('1680000.00');
    expect(review.eligibility.value).toBe(
      'Similar railway S&T works of 35% value in the last three financial years.',
    );

    expect(review.needsReview.total).toBe(0);
    expect(review.needsReview.identityUnresolved).toBe(false);
  });

  it('keeps every field independent and flags the ones it cannot find', () => {
    const review = reviewTenderNotice(
      ['Tender No: RDSO/2026/EL/041', 'EMD: ₹ 9.60 Lakh'].join('\n'),
    );

    expect(review.tenderNumber.value).toBe('RDSO/2026/EL/041');
    expect(review.emdAmount.value).toBe('960000.00');
    expect(review.authority).toEqual({ value: null, raw: null, needsReview: true });
    expect(review.estimatedValue.value).toBeNull();
    expect(review.needsReview.identityUnresolved).toBe(true);
  });

  it('flags a closing date that states no time rather than inventing midnight', () => {
    const review = reviewTenderNotice('Last date for submission: 02/03/2027');
    expect(review.bidClosesAtLocal.value).toBe('2027-03-02T00:00');
    expect(review.bidClosesAtLocal.needsReview).toBe(true);
  });

  it('refuses a closing date the calendar does not have', () => {
    const review = reviewTenderNotice('Due date: 31-02-2027 15:00');
    expect(review.bidClosesAtLocal.value).toBeNull();
    expect(review.bidClosesAtLocal.needsReview).toBe(true);
  });

  it('reads a 12-hour closing time', () => {
    const review = reviewTenderNotice('Bid submission end date: 18-09-2026 3:00 PM');
    expect(review.bidClosesAtLocal.value).toBe('2026-09-18T15:00');
    expect(review.bidClosesAtLocal.needsReview).toBe(false);
  });

  it('scales crore and lakh exactly, without a binary float', () => {
    const review = reviewTenderNotice(
      ['Estimated cost: ₹ 8.47 Cr', 'Earnest Money Deposit: INR 16.94 Lakh'].join('\n'),
    );
    expect(review.estimatedValue.value).toBe('84700000.00');
    expect(review.emdAmount.value).toBe('1694000.00');
  });

  it('never lets the amount-in-words parenthetical multiply the figure', () => {
    // The corpus shape. Reading "Crore" out of the words and applying it
    // to a figure that already carries it turns eight crore into eight
    // lakh crore, silently, on the number an agency deposits.
    const review = reviewTenderNotice(
      [
        'Estimated Cost: Rs. 8,40,00,000/- (Rupees Eight Crore Forty Lakh only)',
        'EMD: Rs. 2,00,000/- (Rupees Two Lakh only)',
      ].join('\n'),
    );

    expect(review.estimatedValue.value).toBe('84000000.00');
    expect(review.emdAmount.value).toBe('200000.00');
    // Both are flagged: the notice states the amount twice and this
    // reader only reads one of the two statements.
    expect(review.estimatedValue.needsReview).toBe(true);
    expect(review.emdAmount.needsReview).toBe(true);
  });

  it('applies a scale word that really does qualify the figure', () => {
    const review = reviewTenderNotice('Estimated cost: Rs 8.40 Cr');
    expect(review.estimatedValue.value).toBe('84000000.00');
    expect(review.estimatedValue.needsReview).toBe(false);
  });

  it('refuses a figure too wide for the money column instead of storing a misread', () => {
    const review = reviewTenderNotice('Tender value: Rs 9,99,99,99,99,99,99,999 Cr');
    expect(review.estimatedValue.value).toBeNull();
    expect(review.estimatedValue.needsReview).toBe(true);
  });

  it('proposes and never commits — the module exports no writer', async () => {
    const module: Record<string, unknown> = await import('../src/tender-notice.js');
    expect(Object.keys(module)).toEqual(['reviewTenderNotice']);
  });
});
