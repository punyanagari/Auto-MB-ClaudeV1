/**
 * Deterministic TAX INVOICE HTML (template_version ti-v1).
 *
 * Every textual and monetary fact comes from the immutable submit-time
 * snapshot. The only later facts accepted are append-only IRP evidence and
 * a render-version logo frozen by digest, embedded as a data URI. The page
 * makes no external requests and is converted to PDF by Gotenberg.
 */

import QRCode from 'qrcode';
import { escapeHtml } from './challan-html.js';
import {
  snapshotLines,
  type TaxInvoiceIssuedSnapshot,
} from './tax-invoice-snapshot.js';

export const TAX_INVOICE_PDF_TEMPLATE_VERSION = 'ti-v1';

export interface TaxInvoiceIrpRenderEvidence {
  readonly provider: 'manual' | 'whitebooks' | null;
  readonly irn: string | null;
  readonly ackNumber: string | null;
  readonly ackDateText: string | null;
  readonly signedQr: string | null;
  readonly legacyEvidenceMissing: boolean;
}

interface TaxInvoiceRenderBranding {
  readonly logoDataUri?: string;
}

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

/** Indian digit grouping without parsing authoritative money as a Number. */
export function formatInvoiceAmount(value: string): string {
  // Fully anchored: one optional sign, one digit run, and one bounded
  // fraction. No overlapping alternatives or nested repetition.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(-?)([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(value);
  if (match === null)
    throw new Error(`Invalid invoice amount: ${JSON.stringify(value)}`);
  const sign = match[1] ?? '';
  const digits = (match[2] ?? '0').replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const lastThree = digits.slice(-3);
  const leading = digits.slice(0, -3);
  const leadingGroups: string[] = [];
  for (let end = leading.length; end > 0; end -= 2) {
    leadingGroups.unshift(leading.slice(Math.max(0, end - 2), end));
  }
  const groupedLeading = leadingGroups.join(',');
  return `${sign}${groupedLeading === '' ? '' : `${groupedLeading},`}${lastThree}.${fraction}`;
}

function partyBlock(label: string, party: TaxInvoiceIssuedSnapshot['buyer']): string {
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

export async function renderTaxInvoiceHtml(
  snapshot: TaxInvoiceIssuedSnapshot,
  evidence: TaxInvoiceIrpRenderEvidence,
  branding: TaxInvoiceRenderBranding = {},
): Promise<string> {
  if (snapshot.reverseChargeApplicable !== false) {
    throw new Error(
      'Tax invoice rendering requires explicit forward-charge confirmation.',
    );
  }
  const qr = await qrDataUri(evidence.signedQr);
  const shipTo = snapshot.shipTo ?? snapshot.buyer;
  const hasIrpEvidence = evidence.irn !== null;
  const evidenceLabel =
    evidence.provider === 'whitebooks' && !evidence.legacyEvidenceMissing
      ? 'Provider-recorded IRP evidence'
      : 'Manual or legacy IRP evidence — unverified';
  const roundOffRow =
    snapshot.totals.roundOff === '0' ||
    snapshot.totals.roundOff === '0.0' ||
    snapshot.totals.roundOff === '0.00'
      ? ''
      : `<tr><th>Rounding</th><td>${money(snapshot.totals.roundOff)}</td></tr>`;
  // One row per frozen line. A v1 (cumulative) snapshot normalises to
  // exactly one, so its row — and therefore its stored PDF's bytes — is
  // character for character what it has always been; only the two column
  // HEADINGS below widen for an itemised document, which has none.
  const lineRows = snapshotLines(snapshot)
    .map(
      (line) =>
        `<tr><td>${String(line.position)}</td><td>${escapeHtml(line.description)}</td><td>${escapeHtml(line.hsnSacCode)}</td><td class="number">${escapeHtml(line.quantity)}</td><td>${escapeHtml(line.unitLabel)}</td><td class="number">${money(line.rate)}</td><td class="number">${escapeHtml(line.gstRate)}%</td><td class="number">${money(line.amount)}</td></tr>`,
    )
    .join('');
  const itemised = snapshot.templateVersion === 'ti-v2';
  const descriptionHeading = itemised ? 'Description' : 'Description of service';
  const codeHeading = itemised ? 'HSN / SAC' : 'SAC';
  const taxRows =
    snapshot.totals.igstAmount === '0' ||
    snapshot.totals.igstAmount === '0.0' ||
    snapshot.totals.igstAmount === '0.00'
      ? `<tr><th>CGST</th><td>${money(snapshot.totals.cgstAmount)}</td></tr>
         <tr><th>SGST</th><td>${money(snapshot.totals.sgstAmount)}</td></tr>`
      : `<tr><th>IGST</th><td>${money(snapshot.totals.igstAmount)}</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Tax Invoice ${escapeHtml(snapshot.invoiceNumber)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #17221d; font-family: Helvetica, Arial, sans-serif; font-size: 10.5px; line-height: 1.35; }
  h1, h2, p { margin: 0; }
  .masthead { display: grid; grid-template-columns: 1fr auto; gap: 14px; border: 1.5px solid #17221d; padding: 10px; }
  .brand { display: flex; gap: 12px; align-items: flex-start; }
  .brand img { max-width: 150px; max-height: 58px; object-fit: contain; }
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
  .words, .notes, .irp { border: 1px solid #6b746f; padding: 8px; margin-top: 10px; overflow-wrap: anywhere; }
  .notes { white-space: pre-wrap; }
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
  <div class="brand">
    ${branding.logoDataUri === undefined ? '' : `<img src="${escapeHtml(branding.logoDataUri)}" alt="" />`}
    <div>
      <div class="supplier-name">${escapeHtml(snapshot.supplier.name)}</div>
      ${snapshot.supplier.tradeName === null ? '' : `<div class="trade-name">${escapeHtml(snapshot.supplier.tradeName)}</div>`}
      ${addressLines(snapshot.supplier)
        .map((line) => `<div>${escapeHtml(line)}</div>`)
        .join('\n      ')}
      <div>GSTIN: ${escapeHtml(snapshot.supplier.gstin)}</div>
      ${snapshot.supplier.phone === null ? '' : `<div>Phone: ${escapeHtml(snapshot.supplier.phone)}</div>`}
      ${snapshot.supplier.msmeNumber === null ? '' : `<div>MSME: ${escapeHtml(snapshot.supplier.msmeNumber)}</div>`}
    </div>
  </div>
  <div class="document-title">
    <h1>TAX INVOICE</h1>
    <div><span class="label">Invoice no.</span><br /><strong>${escapeHtml(snapshot.invoiceNumber)}</strong></div>
    <div><span class="label">Invoice date</span><br />${escapeHtml(snapshot.invoiceDate)}</div>
  </div>
</header>
<section class="meta">
  <div><span class="label">Financial year</span><br />${snapshot.fyLabel === null ? '—' : escapeHtml(snapshot.fyLabel)}</div>
  <div><span class="label">Place of supply</span><br />State code ${escapeHtml(snapshot.placeOfSupply)}</div>
  <div><span class="label">Customer PO / reference</span><br />${snapshot.customerPoReference === null ? '—' : escapeHtml(snapshot.customerPoReference)}</div>
  <div><span class="label">Reverse charge</span><br />No</div>
</section>
<section class="parties">
  ${partyBlock('Bill to', snapshot.buyer)}
  ${partyBlock(snapshot.shipTo === null ? 'Ship to (same as bill to)' : 'Ship to', shipTo)}
</section>
<table class="line-table">
  <thead><tr><th>#</th><th class="description">${descriptionHeading}</th><th>${codeHeading}</th><th class="number">Qty</th><th>Unit</th><th class="number">Rate</th><th class="number">GST rate</th><th class="number">Taxable value</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
<section class="summary-wrap">
  <div>
    <div class="words"><span class="label">Amount in words</span><br /><strong>${escapeHtml(snapshot.amountInWords)}</strong></div>
    ${snapshot.notes === null ? '' : `<div class="notes"><span class="label">Notes</span><br />${escapeHtml(snapshot.notes)}</div>`}
  </div>
  <table class="summary">
    <tbody>
      <tr><th>Taxable value</th><td>${money(snapshot.totals.taxableValue)}</td></tr>
      ${taxRows}
      ${roundOffRow}
      <tr class="grand"><th>Total</th><td>${money(snapshot.totals.totalAmount)}</td></tr>
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
  <div class="signature">For ${escapeHtml(snapshot.supplier.name)}<br /><br />Authorised signatory</div>
</section>
<footer>Template ${escapeHtml(TAX_INVOICE_PDF_TEMPLATE_VERSION)} · Generated from the immutable issued invoice snapshot.</footer>
</body>
</html>
`;
}
