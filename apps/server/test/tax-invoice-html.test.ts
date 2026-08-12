import { describe, expect, it } from 'vitest';
import { formatInvoiceAmount, renderTaxInvoiceHtml } from '../src/tax-invoice-html.js';
import type { TaxInvoiceIssuedSnapshotV1 } from '../src/tax-invoice-snapshot.js';

const SNAPSHOT: TaxInvoiceIssuedSnapshotV1 = {
  templateVersion: 'ti-v1',
  invoiceNumber: 'P10/26/044',
  invoiceDate: '2026-07-30',
  fyLabel: '2026-27',
  supplier: {
    name: 'A & B <Engineering>',
    tradeName: 'A&B Works',
    gstin: '27ABCDE1234F1Z5',
    address: 'Plot 1 > Industrial Estate',
    stateCode: '27',
    pincode: '400001',
    locality: 'Mumbai',
    phone: '+91 22 12345678',
    msmeNumber: 'UDYAM-MH-26-0224294',
  },
  buyer: {
    designation: 'Senior DSTE & Accounts',
    contactPerson: 'Buyer <Officer>',
    gstin: '27AAAGM0289C1ZL',
    address: 'DRM Office & Annex',
    stateCode: '27',
    pincode: '400008',
    locality: 'Mumbai Central',
  },
  shipTo: {
    designation: 'Signal Depot',
    contactPerson: null,
    gstin: null,
    address: 'Yard Road',
    stateCode: '27',
    pincode: '400009',
    locality: 'Byculla',
  },
  placeOfSupply: '27',
  reverseChargeApplicable: false,
  customerPoReference: 'WR/MMCT/PO-42',
  line: {
    sacCode: '995421',
    description: 'Works contract <installation> & commissioning',
    quantity: '1.00',
    unitLabel: 'set',
    rate: '4226994.01',
    gstRate: '18.00',
    amount: '4226994.01',
    lineValue: '4987852.93',
  },
  totals: {
    taxableValue: '4226994.01',
    cgstAmount: '380429.46',
    sgstAmount: '380429.46',
    igstAmount: '0.00',
    roundOff: '0.07',
    totalAmount: '4987853.00',
  },
  amountInWords:
    'Rupees Forty-Nine Lakh Eighty-Seven Thousand Eight Hundred Fifty-Three Only',
  notes: 'Payment due within 30 days & subject to contract.',
};

const NO_IRP = {
  provider: null,
  irn: null,
  ackNumber: null,
  ackDateText: null,
  signedQr: null,
  legacyEvidenceMissing: false,
} as const;

describe('tax invoice HTML', () => {
  it('formats authoritative decimal text in the Indian grouping', () => {
    expect(formatInvoiceAmount('0')).toBe('0.00');
    expect(formatInvoiceAmount('1234.5')).toBe('1,234.50');
    expect(formatInvoiceAmount('4987853.00')).toBe('49,87,853.00');
    expect(formatInvoiceAmount('-0.07')).toBe('-0.07');
  });

  it('refuses to invent or misstate the reverse-charge legal fact', async () => {
    await expect(
      renderTaxInvoiceHtml({ ...SNAPSHOT, reverseChargeApplicable: null }, NO_IRP),
    ).rejects.toThrow(/forward-charge confirmation/);
    await expect(
      renderTaxInvoiceHtml({ ...SNAPSHOT, reverseChargeApplicable: true }, NO_IRP),
    ).rejects.toThrow(/forward-charge confirmation/);
  });

  it('renders deterministically from frozen facts and escapes every text field', async () => {
    const first = await renderTaxInvoiceHtml(SNAPSHOT, NO_IRP);
    const second = await renderTaxInvoiceHtml(SNAPSHOT, NO_IRP);

    expect(second).toBe(first);
    expect(first).toContain('A &amp; B &lt;Engineering&gt;');
    expect(first).toContain('Works contract &lt;installation&gt; &amp; commissioning');
    expect(first).toContain('Buyer &lt;Officer&gt;');
    expect(first).toContain('Signal Depot');
    expect(first).toContain('GSTIN: Unregistered');
    expect(first).toContain('WR/MMCT/PO-42');
    expect(first).toContain('49,87,853.00');
    expect(first).toContain('CGST');
    expect(first).toContain('SGST');
    expect(first).not.toContain('<th>IGST</th>');
    expect(first).toContain('<th>Rounding</th>');
    expect(first).toContain(SNAPSHOT.amountInWords);
    expect(first).toContain('Payment due within 30 days &amp; subject to contract.');
    expect(first).not.toContain('IRP signed QR code');
  });

  it('prints IGST, omits zero rounding, and embeds a real QR without exposing raw signed data', async () => {
    const signedQr = 'eyJhbGciOiJSUzI1NiJ9.SIGNED-INVOICE-EVIDENCE.abc123';
    const html = await renderTaxInvoiceHtml(
      {
        ...SNAPSHOT,
        shipTo: null,
        totals: {
          ...SNAPSHOT.totals,
          cgstAmount: '0.00',
          sgstAmount: '0.00',
          igstAmount: '761258.92',
          roundOff: '0.00',
        },
      },
      {
        provider: 'whitebooks',
        irn: 'a'.repeat(64),
        ackNumber: '112233445566778',
        ackDateText: '2026-07-30 12:09:00',
        signedQr,
        legacyEvidenceMissing: false,
      },
    );

    expect(html).toContain('<th>IGST</th>');
    expect(html).not.toContain('<th>CGST</th>');
    expect(html).not.toContain('<th>Rounding</th>');
    expect(html).toContain('Ship to (same as bill to)');
    expect(html).toContain('Provider-recorded IRP evidence');
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('alt="IRP signed QR code"');
    expect(html).not.toContain(signedQr);
  });
});
