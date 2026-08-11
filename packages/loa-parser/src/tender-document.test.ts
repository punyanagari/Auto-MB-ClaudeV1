import { describe, expect, it } from 'vitest';
import { matchTenderIdentity, reviewTenderDocument } from './tender-document.js';

const TENDER_TEXT = `
NIT No.: CR-EL-2026-017
Name of Work: Design, supply, installation and commissioning of station equipment

Payment terms for supply and installation items:
80% on successful supply, 10% on successful installation, 5% on issue of PAC and 5% on final acceptance.

Warranty period for Item ITM-001: 24 months from commissioning.
Maintenance period: 5 years from completion.

The Performance Bank Guarantee shall be released after the Defect Liability Period.
The Security Deposit shall be refunded after issue of the completion certificate.

Technical specification for Item ITM-001: The equipment shall conform to RDSO specification RDSO/SPN/TC/65/2025.
`;

describe('tender document review', () => {
  it('extracts identity, payment terms, periods, release clauses and item specifications', () => {
    const review = reviewTenderDocument(TENDER_TEXT, 'tender_specification');

    expect(review.identity.tenderNumber.value).toBe('CR-EL-2026-017');
    expect(review.identity.workDescription.value).toBe(
      'Design, supply, installation and commissioning of station equipment',
    );
    expect(review.paymentMatrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pctSupply: '80',
          pctInstallation: '10',
          pctPac: '5',
          pctFinalBill: '5',
          needsReview: false,
        }),
      ]),
    );
    expect(review.periods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'warranty', durationValue: '24' }),
        expect.objectContaining({ kind: 'maintenance', durationValue: '5' }),
      ]),
    );
    expect(review.releaseClauses.map((clause) => clause.kind)).toEqual(
      expect.arrayContaining(['pbg', 'security_deposit']),
    );
    expect(review.itemSpecifications[0]?.itemReferences).toContain('ITM-001');
  });

  it('requires both tender number and name of work to match', () => {
    const review = reviewTenderDocument(TENDER_TEXT, 'tender_specification');
    expect(
      matchTenderIdentity(
        'CR/EL/2026/017',
        'Design supply installation and commissioning of station equipment',
        review,
      ).matched,
    ).toBe(true);
    const mismatch = matchTenderIdentity(
      'CR/EL/2026/999',
      'Unrelated bridge work',
      review,
    );
    expect(mismatch.matched).toBe(false);
    expect(mismatch.reasons).toHaveLength(2);
  });
});
