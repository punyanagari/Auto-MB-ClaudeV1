/**
 * Deterministic CREDIT NOTE HTML (template_version cn-v1), mirroring the
 * tax invoice renderer: every textual and monetary fact comes from the
 * immutable issue-time snapshot (which embeds the superseded invoice's
 * own frozen snapshot verbatim). The only later facts accepted are
 * append-only IRP evidence. The Section 34 reason and the reference to
 * the original invoice print on the face. No external requests; PDF via
 * Gotenberg.
 */

import QRCode from 'qrcode';
import { escapeHtml } from './challan-html.js';
import { formatInvoiceAmount } from './tax-invoice-html.js';
import type { TaxInvoiceIrpRenderEvidence } from './tax-invoice-html.js';
import type { CreditNoteIssuedSnapshotV1 } from './credit-note-snapshot.js';
import type { TaxInvoiceIssuedSnapshotV1 } from './tax-invoice-snapshot.js';

export const CREDIT_NOTE_PDF_TEMPLATE_VERSION = 'cn-v1';

function addressLines(party: {
  readonly address: string;
  readonly locality: string | null;
  readonly pincode: string;
  readonly stateCode: string;
}): string[] {
  return [
    party.address,
    [party.locality, party.pincode].filter(Boolean).join(' - '),
    `State code: ${party.stateCode}`,
  ].filter((line) => line !== '');
}

function partyBlock(label: string, party: TaxInvoiceIssuedSnapshotV1['buyer']): string {
  return `<section class="party">
  <h2>${escapeHtml(label)}</h2>
  <strong>${escapeHtml(party.designation)}</strong>
  ${party.contactPerson === null ? '' : `<div>Attention: ${escapeHtml(party.contactPerson)}</div>`}
  ${addressLines(party)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join('\n  ')}
  <div>GSTIN: ${party.gstin === null ? 'Unregistered' : escapeHtml(party.gstin)}</div>
</section>`;
}

function money(value: string): string {
  return `&#8377;&nbsp;${escapeHtml(formatInvoiceAmount(value))}`;
}

async function qrDataUri(signedQr: string | null): Promise<string | null> {
  if (signedQr === null) return null;
  const svg = await QRCode.toString(signedQr, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

export async function renderCreditNoteHtml(
  snapshot: CreditNoteIssuedSnapshotV1,
  evidence: TaxInvoiceIrpRenderEvidence,
): Promise<string> {
  const invoice = snapshot.invoice;
  if (invoice.reverseChargeApplicable !== false) {
    throw new Error(
      'Credit note rendering requires explicit forward-charge confirmation on the superseded invoice snapshot.',
    );
  }
  const qr = await qrDataUri(evidence.signedQr);
  const shipTo = invoice.shipTo ?? invoice.buyer;
  const hasIrpEvidence = evidence.irn !== null;
  const evidenceLabel =
    evidence.provider === 'whitebooks' && !evidence.legacyEvidenceMissing
      ? 'Provider-recorded IRP evidence'
      : 'Manual or legacy IRP evidence — unverified';
  const roundOffRow =
    invoice.totals.roundOff === '0' ||
    invoice.totals.roundOff === '0.0' ||
    invoice.totals.roundOff === '0.00'
      ? ''
      : `<tr><th>Rounding</th><td>${money(invoice.totals.roundOff)}</td></tr>`;
  const taxRows =
    invoice.totals.igstAmount === '0' ||
    invoice.totals.igstAmount === '0.0' ||
    invoice.totals.igstAmount === '0.00'
      ? `<tr><th>CGST</th><td>${money(invoice.totals.cgstAmount)}</td></tr>
         <tr><th>SGST</th><td>${money(invoice.totals.sgstAmount)}</td></tr>`
      : `<tr><th>IGST</th><td>${money(invoice.totals.igstAmount)}</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Credit Note ${escapeHtml(snapshot.noteNumber)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #17221d; font-family: Helvetica, Arial, sans-serif; font-size: 10.5px; line-height: 1.35; }
  h1, h2, p { margin: 0; }
  .masthead { display: grid; grid-template-columns: 1fr auto; gap: 14px; border: 1.5px solid #17221d; padding: 10px; }
  .supplier-name { font-size: 16px; font-weight: 700; }
  .trade-name { font-size: 11px; font-weight: 600; }
  .document-title { text-align: right; }
  .document-title h1 { font-size: 20px; letter-spacing: .08em; }
  .meta, .parties { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #6b746f; border-top: 0; }
  .meta > div, .party { padding: 8px; min-width: 0; }
  .meta > div + div, .party + .party { border-left: 1px solid #6b746f; }
  .label, h2 { color: #52615a; font-size: 9px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
  .party h2 { margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  .line-table { margin-top: 10px; }
  th, td { border: 1px solid #6b746f; padding: 5px; vertical-align: top; }
  thead th { background: #f0f3f1; font-size: 9px; letter-spacing: .03em; text-transform: uppercase; }
  .number { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .description { width: 41%; }
  .summary-wrap { display: grid; grid-template-columns: 1fr 245px; gap: 12px; margin-top: 10px; align-items: start; }
  .summary th { text-align: left; width: 58%; }
  .summary td { text-align: right; font-variant-numeric: tabular-nums; }
  .summary .grand th, .summary .grand td { font-size: 12px; border-top: 1.5px solid #17221d; }
  .words, .reason, .irp { border: 1px solid #6b746f; padding: 8px; margin-top: 10px; overflow-wrap: anywhere; }
  .reason { white-space: pre-wrap; }
  .irp { display: grid; grid-template-columns: 1fr 128px; gap: 10px; }
  .irp img { width: 128px; height: 128px; }
  .evidence-label { display: inline-block; border: 1px solid #6b746f; padding: 2px 5px; margin-bottom: 5px; font-size: 8.5px; text-transform: uppercase; }
  .warning { color: #8a3d00; font-weight: 700; }
  .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 80px; margin-top: 36px; }
  .signature { border-top: 1px solid #17221d; padding-top: 4px; text-align: center; }
  footer { margin-top: 18px; color: #52615a; font-size: 8.5px; text-align: center; }
</style>
</head>
<body>
<header class="masthead">
  <div>
    <div class="supplier-name">${escapeHtml(invoice.supplier.name)}</div>
    ${invoice.supplier.tradeName === null ? '' : `<div class="trade-name">${escapeHtml(invoice.supplier.tradeName)}</div>`}
    ${addressLines(invoice.supplier)
      .map((line) => `<div>${escapeHtml(line)}</div>`)
      .join('\n    ')}
    <div>GSTIN: ${escapeHtml(invoice.supplier.gstin)}</div>
    ${invoice.supplier.phone === null ? '' : `<div>Phone: ${escapeHtml(invoice.supplier.phone)}</div>`}
  </div>
  <div class="document-title">
    <h1>CREDIT NOTE</h1>
    <div><span class="label">Credit note no.</span><br /><strong>${escapeHtml(snapshot.noteNumber)}</strong></div>
    <div><span class="label">Credit note date</span><br />${escapeHtml(snapshot.noteDate)}</div>
  </div>
</header>
<section class="meta">
  <div><span class="label">Against tax invoice</span><br /><strong>${escapeHtml(invoice.invoiceNumber)}</strong> dated ${escapeHtml(invoice.invoiceDate)}</div>
  <div><span class="label">Financial year</span><br />${escapeHtml(snapshot.fyLabel)}</div>
  <div><span class="label">Place of supply</span><br />State code ${escapeHtml(invoice.placeOfSupply)}</div>
  <div><span class="label">Reverse charge</span><br />No</div>
</section>
<section class="parties">
  ${partyBlock('Bill to', invoice.buyer)}
  ${partyBlock(invoice.shipTo === null ? 'Ship to (same as bill to)' : 'Ship to', shipTo)}
</section>
<table class="line-table">
  <thead><tr><th>#</th><th class="description">Description of service</th><th>SAC</th><th class="number">Qty</th><th>Unit</th><th class="number">Rate</th><th class="number">GST rate</th><th class="number">Taxable value</th></tr></thead>
  <tbody><tr><td>1</td><td>${escapeHtml(invoice.line.description)}</td><td>${escapeHtml(invoice.line.sacCode)}</td><td class="number">${escapeHtml(invoice.line.quantity)}</td><td>${escapeHtml(invoice.line.unitLabel)}</td><td class="number">${money(invoice.line.rate)}</td><td class="number">${escapeHtml(invoice.line.gstRate)}%</td><td class="number">${money(invoice.line.amount)}</td></tr></tbody>
</table>
<section class="summary-wrap">
  <div>
    <div class="words"><span class="label">Amount in words</span><br /><strong>${escapeHtml(invoice.amountInWords)}</strong></div>
    <div class="reason"><span class="label">Reason for credit note (Section 34, CGST Act)</span><br />${escapeHtml(snapshot.reason)}</div>
  </div>
  <table class="summary">
    <tbody>
      <tr><th>Taxable value</th><td>${money(invoice.totals.taxableValue)}</td></tr>
      ${taxRows}
      ${roundOffRow}
      <tr class="grand"><th>Total credited</th><td>${money(invoice.totals.totalAmount)}</td></tr>
    </tbody>
  </table>
</section>
${
  hasIrpEvidence
    ? `<section class="irp">
  <div>
    <div class="evidence-label">${escapeHtml(evidenceLabel)}</div>
    <div><span class="label">IRN</span><br />${escapeHtml(evidence.irn ?? '')}</div>
    <div><span class="label">Acknowledgement no.</span><br />${evidence.ackNumber === null ? 'Unavailable' : escapeHtml(evidence.ackNumber)}</div>
    <div><span class="label">Acknowledgement date</span><br />${evidence.ackDateText === null ? 'Unavailable' : escapeHtml(evidence.ackDateText)}</div>
    ${evidence.legacyEvidenceMissing ? '<p class="warning">Some migrated provider evidence is unavailable. No value has been reconstructed.</p>' : ''}
  </div>
  ${qr === null ? '<div class="warning">Signed QR unavailable</div>' : `<img src="${qr}" alt="IRP signed QR code" />`}
</section>`
    : ''
}
<section class="signatures">
  <div class="signature">Receiver / customer</div>
  <div class="signature">For ${escapeHtml(invoice.supplier.name)}<br /><br />Authorised signatory</div>
</section>
<footer>Template ${escapeHtml(CREDIT_NOTE_PDF_TEMPLATE_VERSION)} · Generated from the immutable issued credit-note snapshot. This credit note supersedes tax invoice ${escapeHtml(invoice.invoiceNumber)} in full.</footer>
</body>
</html>
`;
}
