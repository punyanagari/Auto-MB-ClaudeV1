/**
 * Deterministic E-WAY BILL SUMMARY HTML (template_version ewb-v1).
 *
 * A CONVENIENCE PRINT, and the page says so on its face: the statutory
 * original is the document on the NIC portal, and this is a readable copy
 * of facts this module already holds — NIC's own answer (the twelve-digit
 * number, its date and its validity window), the parties and lines of the
 * source document, and the carriage the bill declares. Nothing on it is
 * computed for the first time here.
 *
 * The page makes no external requests and is converted to PDF by
 * Gotenberg, the same way every other document in this product is.
 * Deliberately plainer than the tax invoice's template: no logo, no QR,
 * no signature block, because a summary that looked like a certificate
 * would invite somebody to hand it over as one.
 */

import { escapeHtml } from './challan-html.js';
import { formatInvoiceAmount } from './tax-invoice-html.js';
import type { EwayBillSourceFacts, EwaySourceParty } from './gsp/eway-source.js';

export const EWAY_BILL_PDF_TEMPLATE_VERSION = 'ewb-v1';

/** What NIC answered, verbatim. The portal's own text is printed beside
 * nothing else: a derived instant would be this product's reading of the
 * portal's words rather than the words themselves. */
export interface EwayBillRenderEvidence {
  readonly ewbNumber: string;
  readonly ewbDateText: string | null;
  readonly validUntilText: string | null;
  readonly provider: 'manual' | 'whitebooks' | null;
  readonly status: 'draft' | 'generated' | 'cancelled';
  readonly providerCancelledAtText: string | null;
  readonly cancellationNote: string | null;
  readonly legacyEvidenceMissing: boolean;
}

interface EwayBillRenderCarriage {
  readonly transportMode: string;
  readonly transporterId: string | null;
  readonly transporterName: string | null;
  readonly vehicleNumber: string | null;
  readonly transportDocNumber: string | null;
  readonly transportDocDate: string | null;
  readonly distanceKm: number;
  readonly fromPincode: string;
  readonly toPincode: string;
}

const MOVEMENT_REASON_LABEL: Record<EwayBillSourceFacts['movementReason'], string> = {
  supply: 'Supply',
  job_work: 'Job work',
  for_own_use: 'For own use',
  others: 'Others',
};

function partyBlock(title: string, party: EwaySourceParty): string {
  const lines = [
    party.address,
    party.pincode === null ? '' : `PIN ${party.pincode}`,
    party.stateCode === null ? '' : `State code ${party.stateCode}`,
  ].filter((line) => line.trim() !== '');
  return `<section class="party">
      <h2>${escapeHtml(title)}</h2>
      <p class="name">${escapeHtml(party.name)}</p>
      <p class="gstin">GSTIN: ${escapeHtml(party.gstin ?? 'Unregistered (URP)')}</p>
      ${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n      ')}
    </section>`;
}

function field(label: string, value: string | null): string {
  return `<div class="field"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(
    value === null || value.trim() === '' ? '—' : value,
  )}</dd></div>`;
}

export function renderEwayBillHtml(
  source: EwayBillSourceFacts,
  evidence: EwayBillRenderEvidence,
  carriage: EwayBillRenderCarriage,
): string {
  const rows = source.lines
    .map(
      (line) => `<tr>
          <td class="num">${String(line.position)}</td>
          <td>${escapeHtml(line.description)}</td>
          <td class="num">${escapeHtml(line.hsnSacCode)}</td>
          <td class="num">${escapeHtml(line.quantity)}</td>
          <td>${escapeHtml(line.unitLabel ?? '')}</td>
          <td class="num">${escapeHtml(formatInvoiceAmount(line.taxableValue))}</td>
        </tr>`,
    )
    .join('\n        ');

  const cancelled = evidence.status === 'cancelled';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>E-way bill ${escapeHtml(evidence.ewbNumber)}</title>
    <style>
      @page { size: A4; margin: 14mm; }
      body { font-family: "IBM Plex Sans", Arial, sans-serif; font-size: 11px; color: #16181d; }
      h1 { font-size: 17px; margin: 0 0 2px; }
      h2 { font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: .04em; color: #545b68; }
      .banner { border: 1px solid #c8ccd4; padding: 8px 10px; margin-bottom: 12px; }
      .banner p { margin: 2px 0; }
      .num, .mono { font-family: "IBM Plex Mono", "Courier New", monospace; font-variant-numeric: tabular-nums; }
      td.num, th.num { text-align: right; }
      .parties { display: flex; gap: 16px; margin-bottom: 12px; }
      .party { flex: 1; border: 1px solid #e2e5ea; padding: 8px 10px; }
      .party p { margin: 1px 0; }
      .party .name { font-weight: 600; }
      dl.facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 16px; margin: 0 0 12px; }
      .field dt { font-size: 10px; color: #545b68; margin: 0; }
      .field dd { margin: 0; font-family: "IBM Plex Mono", "Courier New", monospace; font-variant-numeric: tabular-nums; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid #e2e5ea; padding: 4px 6px; text-align: left; vertical-align: top; }
      th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #545b68; }
      .cancelled { border-color: #a3231f; }
      footer { margin-top: 14px; font-size: 10px; color: #545b68; border-top: 1px solid #e2e5ea; padding-top: 6px; }
    </style>
  </head>
  <body>
    <div class="banner${cancelled ? ' cancelled' : ''}">
      <h1>E-way bill ${escapeHtml(evidence.ewbNumber)}</h1>
      <p><strong>This is not the statutory document.</strong> The e-way bill
      of record is the one held on the NIC e-way bill portal. This page is a
      summary of the facts recorded against it here, printed for reference
      and for carrying alongside the goods with the source document.</p>
      ${cancelled ? '<p><strong>This e-way bill has been cancelled.</strong></p>' : ''}
      ${
        evidence.legacyEvidenceMissing
          ? '<p><strong>Portal evidence incomplete.</strong> This record predates verified provider evidence; check the NIC portal before relying on the validity window below.</p>'
          : ''
      }
    </div>

    <dl class="facts">
      ${field('E-way bill number', evidence.ewbNumber)}
      ${field('Generated (portal text)', evidence.ewbDateText)}
      ${field('Valid until (portal text)', evidence.validUntilText)}
      ${field(
        source.kind === 'tax_invoice' ? 'Tax invoice' : 'Delivery challan',
        source.documentNumber,
      )}
      ${field('Document date', source.documentDate)}
      ${field('Reason for movement', MOVEMENT_REASON_LABEL[source.movementReason])}
      ${field('Transport mode', carriage.transportMode)}
      ${field('Vehicle', carriage.vehicleNumber)}
      ${field(
        'Transport document',
        carriage.transportDocNumber === null
          ? null
          : `${carriage.transportDocNumber} (${carriage.transportDocDate ?? ''})`,
      )}
      ${field('Transporter', carriage.transporterName ?? carriage.transporterId)}
      ${field('Distance', `${String(carriage.distanceKm)} km`)}
      ${field('From / to PIN', `${carriage.fromPincode} - ${carriage.toPincode}`)}
      ${field('Evidence', evidence.provider === 'manual' ? 'Recorded manually (unverified)' : 'Provider-verified')}
      ${cancelled ? field('Cancelled at portal', evidence.providerCancelledAtText) : ''}
      ${cancelled ? field('Cancellation note', evidence.cancellationNote) : ''}
    </dl>

    <div class="parties">
      ${partyBlock('Consignor', source.supplier)}
      ${partyBlock('Consignee', source.consignee)}
    </div>

    <table>
      <thead>
        <tr>
          <th class="num">#</th>
          <th>Description</th>
          <th class="num">HSN/SAC</th>
          <th class="num">Quantity</th>
          <th>Unit</th>
          <th class="num">Taxable value</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <footer>
      Template ${escapeHtml(EWAY_BILL_PDF_TEMPLATE_VERSION)}. Verify this
      e-way bill at ewaybillgst.gov.in using the number above.
    </footer>
  </body>
</html>`;
}
