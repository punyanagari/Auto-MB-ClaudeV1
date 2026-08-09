/**
 * Deterministic Delivery Challan HTML (template_version dc-v3). The legal
 * content — parties, items, quantities, totals — renders ONLY from the
 * immutable issued_snapshot, never from live rows, so a re-render years
 * later reproduces the same record. Branding (organisation logo, address,
 * GSTIN, contact) is presentation, applied from the organisation's
 * current profile at render time. The output goes to Gotenberg for PDF
 * conversion; it must be a complete, self-contained page with no
 * external requests, so the logo is embedded as a data URI.
 *
 * dc-v3 adds the optional warranty/guarantee certificate as page 2
 * (legacy §11): present exactly when the snapshot carries a warranty
 * block, frozen at issue time from the organisation's template text.
 */

export const CHALLAN_TEMPLATE_VERSION = 'dc-v3';

/** Version of the warranty/guarantee certificate page layout. Frozen
 * into the issued snapshot (with the exact template text and its
 * SHA-256) whenever the organisation has template text at issue time. */
export const WARRANTY_TEMPLATE_VERSION = 'wc-v1';

export interface ChallanBranding {
  readonly logoDataUri?: string;
  readonly address?: string | null;
  readonly gstin?: string | null;
  readonly contactPhone?: string | null;
  readonly contactEmail?: string | null;
}

export interface ChallanSnapshotItem {
  readonly position: number;
  readonly itemNumber: string;
  readonly description: string;
  readonly unit: string;
  readonly quantity: string;
  readonly rate: string;
  readonly lineAmount: string;
}

export interface ChallanSnapshot {
  readonly templateVersion: string;
  readonly organisationName: string;
  readonly challanNumber: string;
  readonly challanDate: string;
  readonly issuedAt: string;
  readonly work: {
    readonly workCode: string;
    readonly title: string;
    readonly letterNumber: string;
    readonly letterDate: string;
  };
  readonly consignee: {
    readonly name: string;
    readonly address: string;
    readonly phone?: string;
  };
  readonly items: readonly ChallanSnapshotItem[];
  readonly totalAmount: string;
  /** Present only when the organisation had warranty template text at
   * issue time; the challan then carries the certificate page forever,
   * rendered verbatim from this frozen copy. */
  readonly warranty?: {
    readonly templateVersion: string;
    readonly textSha256: string;
    readonly text: string;
  };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderChallanHtml(
  snapshot: ChallanSnapshot,
  branding: ChallanBranding = {},
): string {
  const brandBlock = `<div class="brand">
    ${branding.logoDataUri !== undefined ? `<img src="${branding.logoDataUri}" alt="" />` : ''}
    <div>
      <div class="org">${escapeHtml(snapshot.organisationName)}</div>
      <div class="org-details">${[
        branding.address ?? null,
        branding.gstin != null ? `GSTIN ${branding.gstin}` : null,
        [branding.contactPhone, branding.contactEmail]
          .filter((value): value is string => value != null)
          .join(' · ') || null,
      ]
        .filter((value): value is string => value !== null)
        .map((value) => escapeHtml(value))
        .join('<br />')}</div>
    </div>
  </div>`;

  // The certificate page renders ONLY from the frozen snapshot copy —
  // line breaks preserved (white-space: pre-wrap) because the text is a
  // legal template that must reproduce faithfully on every re-render.
  const warrantyPage =
    snapshot.warranty !== undefined
      ? `<section class="warranty-page">
  ${brandBlock}
  <div class="doc-title">
    <h1>Warranty / Guarantee Certificate</h1>
    <p>Dated ${escapeHtml(snapshot.challanDate)}</p>
  </div>
  <p class="label">Against Delivery Challan ${escapeHtml(snapshot.challanNumber)} · Work ${escapeHtml(snapshot.work.workCode)}</p>
  <div class="warranty-text">${escapeHtml(snapshot.warranty.text)}</div>
  <section class="sign">
    <div>Received by (Consignee)</div>
    <div>Authorised signatory</div>
  </section>
  <footer>
    <p class="label">Warranty template ${escapeHtml(snapshot.warranty.templateVersion)} · SHA-256 ${escapeHtml(snapshot.warranty.textSha256)}</p>
  </footer>
</section>`
      : '';

  const versionTrail = [
    `Template ${escapeHtml(snapshot.templateVersion)}`,
    ...(snapshot.warranty !== undefined
      ? [`Warranty template ${escapeHtml(snapshot.warranty.templateVersion)}`]
      : []),
    `Issued at ${escapeHtml(snapshot.issuedAt)}`,
  ].join(' · ');

  const rows = snapshot.items
    .map(
      (item) => `<tr>
  <td class="num">${String(item.position)}</td>
  <td>${escapeHtml(item.itemNumber)}</td>
  <td class="desc">${escapeHtml(item.description)}</td>
  <td>${escapeHtml(item.unit)}</td>
  <td class="num">${escapeHtml(item.quantity)}</td>
  <td class="num">${escapeHtml(item.rate)}</td>
  <td class="num">${escapeHtml(item.lineAmount)}</td>
</tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Delivery Challan ${escapeHtml(snapshot.challanNumber)}</title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; color: #17221d; margin: 2rem; font-size: 12px; }
  h1 { font-size: 18px; margin: 0; }
  .meta { display: flex; justify-content: space-between; margin: 1rem 0; gap: 2rem; }
  .meta div { max-width: 48%; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #55635c; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .desc { width: 40%; }
  .total td { font-weight: bold; }
  .sign { margin-top: 3rem; display: flex; justify-content: space-between; }
  .sign div { border-top: 1px solid #17221d; padding-top: 4px; width: 30%; text-align: center; }
  .brand { display: flex; align-items: flex-start; gap: 16px; border-bottom: 2px solid #17221d; padding-bottom: 10px; }
  .brand img { max-height: 56px; max-width: 180px; }
  .brand .org { font-size: 15px; font-weight: bold; }
  .brand .org-details { font-size: 10px; color: #55635c; margin-top: 2px; }
  .doc-title { display: flex; justify-content: space-between; align-items: baseline; margin-top: 10px; }
  .warranty-page { break-before: page; page-break-before: always; }
  .warranty-text { white-space: pre-wrap; margin-top: 1rem; line-height: 1.5; }
</style>
</head>
<body>
<header>
  ${brandBlock}
  <div class="doc-title">
    <h1>Delivery Challan ${escapeHtml(snapshot.challanNumber)}</h1>
    <p>Dated ${escapeHtml(snapshot.challanDate)}</p>
  </div>
</header>
<section class="meta">
  <div>
    <p class="label">Work</p>
    <p>${escapeHtml(snapshot.work.workCode)} — ${escapeHtml(snapshot.work.title)}<br />
    LOA ${escapeHtml(snapshot.work.letterNumber)} dated ${escapeHtml(snapshot.work.letterDate)}</p>
  </div>
  <div>
    <p class="label">Consignee</p>
    <p>${escapeHtml(snapshot.consignee.name)}<br />${escapeHtml(snapshot.consignee.address)}${
      snapshot.consignee.phone !== undefined
        ? `<br />${escapeHtml(snapshot.consignee.phone)}`
        : ''
    }</p>
  </div>
</section>
<table>
  <thead>
    <tr>
      <th>#</th><th>Item</th><th>Description</th><th>Unit</th>
      <th>Quantity</th><th>Rate (Rs.)</th><th>Amount (Rs.)</th>
    </tr>
  </thead>
  <tbody>
${rows}
    <tr class="total"><td colspan="6">Total</td><td class="num">${escapeHtml(snapshot.totalAmount)}</td></tr>
  </tbody>
</table>
<section class="sign">
  <div>Prepared by</div>
  <div>Received by (Consignee)</div>
  <div>Authorised signatory</div>
</section>
<footer>
  <p class="label">${versionTrail}</p>
</footer>
${warrantyPage}
</body>
</html>
`;
}
