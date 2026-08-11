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
  it('joins a wrapped railway work name and stops before the next labelled field', () => {
    const workDescription =
      'Upgradation of manual announcement system to automatic announcement at stations of non-suburban sections and replacement of Public Address System with IP based Public Address System installed at CCG, MX, DDR, ADH, RMAR, GMN, BVI & NSP stations of Churchgate - Virar section of Mumbai Division on age cum condition basis along with Comprehensive Annual Maintenance Contract (CAMC) after warranty.';
    const review = reviewTenderDocument(
      `Tender No. : WR-MMCT-SnT-STTD-34-2025
Name of Work: Upgradation of manual announcement system to automatic
announcement at stations of non-suburban sections and replacement of Public
Address System with IP based Public Address System installed at CCG, MX, DDR,
ADH, RMAR, GMN, BVI & NSP stations of Churchgate - Virar section of Mumbai
Division on age cum condition basis along with Comprehensive Annual Maintenance
Contract (CAMC) after warranty.
Tender Document Cost: Rs. 0.00`,
      'nit',
    );

    expect(review.identity.workDescription.value).toBe(workDescription);
    expect(review.identity.workDescription.raw).not.toContain('Tender Document Cost');
    expect(review.identity.workDescription.needsReview).toBe(false);
    expect(
      matchTenderIdentity('WR-MMCT-SnT-STTD-34-2025', workDescription, review),
    ).toMatchObject({
      matched: true,
      tenderNumberMatched: true,
      workDescriptionMatched: true,
      reasons: [],
    });
  });

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
    const warranty = review.periods.find((period) => period.kind === 'warranty');
    expect(warranty).toMatchObject({
      durationValue: '36',
      durationUnit: 'month',
      scope: 'item',
    });
    expect(warranty?.itemReferences).toContain('ITM-001');
    expect(warranty?.itemReferences).toContain('ITM-002');
    expect(
      review.periods.find((period) => period.kind === 'maintenance'),
    ).toMatchObject({
      durationValue: '5',
      durationUnit: 'year',
      scope: 'work',
    });
    expect(review.releaseClauses.map((clause) => clause.kind).sort()).toEqual([
      'pbg',
      'security_deposit',
    ]);
    expect(review.itemSpecifications).toHaveLength(1);
    expect(review.itemSpecifications[0]?.itemReferences).toEqual(['ITM-001']);
    expect(review.itemSpecifications[0]?.specification).toContain('TEC/GR/TX/IPM-001');
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

  it('keeps an adjacent duration sentence with its period evidence', () => {
    const review = reviewTenderDocument(
      `Tender No.: T-2
Name of Work: Supply of routers
Warranty applies to Item ITM-001. The period is 36 months.`,
      'tender_specification',
    );

    expect(review.periods[0]).toMatchObject({
      kind: 'warranty',
      durationValue: '36',
      durationUnit: 'month',
      scope: 'item',
      itemReferences: ['ITM-001'],
      needsReview: false,
    });
    expect(review.periods[0]?.rawBlock).toContain('The period is 36 months');
  });

  it('does not borrow an unrelated delivery duration for a warranty', () => {
    const review = reviewTenderDocument(
      `Tender No.: T-3
Name of Work: Supply of routers
Warranty requirements apply. Delivery shall be completed within 36 months.`,
      'tender_specification',
    );

    expect(review.periods[0]).toMatchObject({
      kind: 'warranty',
      durationValue: null,
      durationUnit: null,
      needsReview: true,
    });
    expect(review.periods[0]?.rawBlock).toContain('Warranty requirements apply');
    expect(review.periods[0]?.rawBlock).not.toContain('Delivery shall be completed');
  });

  it('does not borrow a labelled delivery period for a warranty', () => {
    const review = reviewTenderDocument(
      `Tender No.: T-3A
Name of Work: Supply of routers
Warranty requirements apply. The delivery period is 36 months.`,
      'tender_specification',
    );

    expect(review.periods[0]).toMatchObject({
      kind: 'warranty',
      durationValue: null,
      durationUnit: null,
      needsReview: true,
    });
    expect(review.periods[0]?.rawBlock).not.toContain('delivery period');
  });

  it('does not borrow an anaphoric delivery duration for a warranty', () => {
    const review = reviewTenderDocument(
      `Tender No.: T-4
Name of Work: Supply of routers
Warranty requirements apply. It shall be delivered within 36 months.`,
      'tender_specification',
    );

    expect(review.periods[0]).toMatchObject({
      kind: 'warranty',
      durationValue: null,
      needsReview: true,
    });
  });

  it('preserves Item No. while joining an adjacent period sentence', () => {
    const review = reviewTenderDocument(
      `Tender No.: T-5
Name of Work: Supply of routers
Warranty applies to Item No. ITM-001. The period is 36 months.`,
      'tender_specification',
    );

    expect(review.periods[0]).toMatchObject({
      kind: 'warranty',
      durationValue: '36',
      durationUnit: 'month',
      scope: 'item',
      itemReferences: ['ITM-001'],
      needsReview: false,
    });
  });

  it('coalesces an adjacent same-kind period sentence without losing item scope', () => {
    const review = reviewTenderDocument(
      `Tender No.: T-6
Name of Work: Supply of routers
Warranty applies to Item ITM-001. Warranty period is 36 months.`,
      'tender_specification',
    );

    expect(review.periods).toHaveLength(1);
    expect(review.periods[0]).toMatchObject({
      kind: 'warranty',
      durationValue: '36',
      durationUnit: 'month',
      scope: 'item',
      itemReferences: ['ITM-001'],
      needsReview: false,
    });
  });

  it('keeps adjacent same-kind periods separate when their item scopes differ', () => {
    const review = reviewTenderDocument(
      `Tender No.: T-7
Name of Work: Supply of routers
Warranty applies to Item ITM-001. Warranty period for Item ITM-002 is 36 months.`,
      'tender_specification',
    );

    expect(review.periods).toHaveLength(2);
    expect(review.periods[0]).toMatchObject({
      kind: 'warranty',
      durationValue: null,
      scope: 'item',
      itemReferences: ['ITM-001'],
      needsReview: true,
    });
    expect(review.periods[1]).toMatchObject({
      kind: 'warranty',
      durationValue: '36',
      durationUnit: 'month',
      scope: 'item',
      itemReferences: ['ITM-002'],
      needsReview: false,
    });
  });

  it('does not treat instrument-release references as standalone periods', () => {
    const review = reviewTenderDocument(
      `Tender No.: T-8
Name of Work: Supply of routers

The Performance Bank Guarantee shall be released after the Defect Liability Period.

The PBG shall be released after final acceptance and expiry of warranty obligations.

The Security Deposit shall be returned after the Defect Liability Period.

The SD shall be paid back after expiry of warranty obligations.`,
      'tender_specification',
    );

    expect(review.periods).toEqual([]);
    expect(review.releaseClauses.map((clause) => clause.kind).sort()).toEqual([
      'pbg',
      'pbg',
      'security_deposit',
      'security_deposit',
    ]);
  });

  it('does not treat an instrument release deadline as a defect-liability duration', () => {
    const review = reviewTenderDocument(
      `Tender No.: T-9
Name of Work: Supply of routers
The PBG shall be released within 30 days after expiry of the Defect Liability Period.`,
      'tender_specification',
    );

    expect(review.periods).toEqual([]);
    expect(review.releaseClauses).toEqual([
      expect.objectContaining({ kind: 'pbg', needsReview: false }),
    ]);
  });

  it('uses the labelled warranty duration instead of an instrument release deadline', () => {
    const review = reviewTenderDocument(
      `Tender No.: T-9A
Name of Work: Supply of routers
The PBG shall be released within 30 days after expiry of the warranty period of 36 months.`,
      'tender_specification',
    );

    expect(review.periods).toEqual([
      expect.objectContaining({
        kind: 'warranty',
        durationValue: '36',
        durationUnit: 'month',
        needsReview: false,
      }),
    ]);
    expect(review.releaseClauses).toEqual([
      expect.objectContaining({ kind: 'pbg', needsReview: false }),
    ]);
  });

  it.each([
    ['Warranty valid for 36 months from commissioning.', '36'],
    ['Warranty coverage: 24 months from commissioning.', '24'],
    ['18 months warranty from commissioning.', '18'],
  ])('recognises common duration wording: %s', (wording, durationValue) => {
    const review = reviewTenderDocument(
      `Tender No.: T-10
Name of Work: Supply of routers
${wording}`,
      'tender_specification',
    );

    expect(review.periods).toEqual([
      expect.objectContaining({
        kind: 'warranty',
        durationValue,
        durationUnit: 'month',
        needsReview: false,
      }),
    ]);
  });
});
