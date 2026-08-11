import { describe, expect, it } from 'vitest';
import { matchTenderIdentity, reviewTenderDocument } from '../src/index.js';

const TENDER_TEXT = `
NORTH CENTRAL RAILWAY
Tender No.: NCR-SNT-2026-0042
Name of Work: Supply, installation and commissioning of IP-MPLS equipment at Jhansi division

Payment terms — Supply and Installation category:
60% on supply, 25% on successful installation, 10% on issue of PAC and 5% on final acceptance.

Warranty period: 36 months for Item ITM-001 and ITM-002 from commissioning.
Maintenance period: 5 years for the complete work after warranty.

The Performance Bank Guarantee (PBG) shall be released after final acceptance and expiry of the warranty obligations.
The Security Deposit shall be returned after issue of the completion certificate and settlement of dues.

Item ITM-001 technical specification: Router shall conform to TEC GR No. TEC/GR/TX/IPM-001 and support MPLS-TE.
`;

describe('optional tender-document extraction', () => {
  it('extracts identity, category payment stages, periods, release clauses and item specifications', () => {
    const review = reviewTenderDocument(TENDER_TEXT, 'tender_specification');

    expect(review.identity.tenderNumber.value).toBe('NCR-SNT-2026-0042');
    expect(review.identity.workDescription.value).toContain('IP-MPLS equipment');
    expect(review.paymentMatrix).toEqual([
      expect.objectContaining({
        category: 'SUPPLY_AND_INSTALLATION',
        pctSupply: '60',
        pctInstallation: '25',
        pctPac: '10',
        pctFinalBill: '5',
        needsReview: false,
      }),
    ]);
    expect(review.periods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'warranty',
          durationValue: '36',
          durationUnit: 'month',
          scope: 'item',
          itemReferences: expect.arrayContaining(['ITM-001', 'ITM-002']),
        }),
        expect.objectContaining({
          kind: 'maintenance',
          durationValue: '5',
          durationUnit: 'year',
          scope: 'work',
        }),
      ]),
    );
    expect(review.releaseClauses.map((clause) => clause.kind).sort()).toEqual([
      'pbg',
      'security_deposit',
    ]);
    expect(review.itemSpecifications).toEqual([
      expect.objectContaining({
        itemReferences: ['ITM-001'],
        specification: expect.stringContaining('TEC/GR/TX/IPM-001'),
      }),
    ]);
  });

  it('matches punctuation-insensitive tender identity and a strongly overlapping work name', () => {
    const review = reviewTenderDocument(TENDER_TEXT, 'nit');
    const match = matchTenderIdentity(
      'NCR/SNT/2026/0042',
      'Supply installation and commissioning of IP MPLS equipment at Jhansi Division',
      review,
    );
    expect(match).toMatchObject({
      matched: true,
      tenderNumberMatched: true,
      workDescriptionMatched: true,
      reasons: [],
    });
  });

  it('rejects missing or foreign identity instead of guessing a link', () => {
    const foreign = reviewTenderDocument(
      `Tender No.: OTHER-99\nName of Work: Construction of a station building`,
      'contract_agreement',
    );
    const mismatch = matchTenderIdentity(
      'NCR-SNT-2026-0042',
      'Supply and installation of IP-MPLS equipment',
      foreign,
    );
    expect(mismatch.matched).toBe(false);
    expect(mismatch.reasons).toEqual([
      'The tender number does not match the Letter of Acceptance.',
      'The name of work does not match the Letter of Acceptance.',
    ]);

    const unresolved = reviewTenderDocument('General Conditions of Contract', 'nit');
    expect(
      matchTenderIdentity(
        'NCR-SNT-2026-0042',
        'Supply and installation of IP-MPLS equipment',
        unresolved,
      ),
    ).toMatchObject({
      matched: false,
      extractedTenderNumber: null,
      extractedWorkDescription: null,
    });
  });

  it('marks incomplete or non-100 payment terms for human review', () => {
    const review = reviewTenderDocument(
      `Tender No.: T-1\nName of Work: Supply of equipment\nPayment: Supply 70%, installation 20%, PAC 5%.`,
      'tender_specification',
    );
    expect(review.paymentMatrix[0]).toMatchObject({
      pctSupply: '70',
      pctInstallation: '20',
      pctPac: '5',
      pctFinalBill: null,
      needsReview: true,
    });
  });
});
