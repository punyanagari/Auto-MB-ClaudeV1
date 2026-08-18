/**
 * Deterministic Correction Notice HTML (template_version
 * correction-notice-v1). A correction notice is the lawful adjustment
 * document for an issued Delivery Challan whose cancellation is blocked by
 * downstream evidence: it carries a gapless number, restates the original
 * challan's identity, and lists the sanctioned corrections — the original
 * document is never touched. The legal content renders ONLY from the
 * immutable snapshot taken when the approval applied, never from live
 * rows. Branding (logo, address, GSTIN, contact) is presentation from the
 * organisation's current profile. Output goes to Gotenberg, so the page is
 * complete and self-contained with no external requests.
 */

import { BASE_PDF_CSS, escapeHtml, type ChallanBranding } from './challan-html.js';

export const CORRECTION_NOTICE_TEMPLATE_VERSION = 'correction-notice-v1';

type CorrectionNoticeBranding = ChallanBranding;

interface CorrectionNoticeSnapshotLine {
  readonly position: number;
  readonly itemNumber: string;
  readonly description: string;
  readonly unit: string;
  readonly quantity: string;
}

export interface CorrectionNoticeSnapshot {
  readonly templateVersion: string;
  readonly organisationName: string;
  readonly noticeNumber: string;
  readonly issuedAt: string;
  readonly work: {
    readonly workCode: string;
    readonly title: string;
    readonly letterNumber: string;
    readonly letterDate: string;
  };
  readonly challan: {
    readonly challanNumber: string;
    readonly challanDate: string;
    readonly consignee: {
      readonly name: string;
      readonly address: string;
      readonly phone?: string;
    };
    readonly lines: readonly CorrectionNoticeSnapshotLine[];
  };
  readonly corrections: readonly {
    readonly field: string;
    readonly corrected: string;
  }[];
  readonly statement: string | null;
  readonly reason: string;
}

export function renderCorrectionNoticeHtml(
  snapshot: CorrectionNoticeSnapshot,
  branding: CorrectionNoticeBranding = {},
): string {
  const correctionRows = snapshot.corrections
    .map(
      (entry) => `<tr>
  <th scope="row">${escapeHtml(entry.field)}</th>
  <td>${escapeHtml(entry.corrected)}</td>
</tr>`,
    )
    .join('\n');

  const lineRows = snapshot.challan.lines
    .map(
      (line) => `<tr>
  <td class="num">${String(line.position)}</td>
  <td>${escapeHtml(line.itemNumber)}</td>
  <td class="desc">${escapeHtml(line.description)}</td>
  <td>${escapeHtml(line.unit)}</td>
  <td class="num">${escapeHtml(line.quantity)}</td>
</tr>`,
    )
    .join('\n');

  const statementParagraphs =
    snapshot.statement === null
      ? ''
      : snapshot.statement
          .split(/\n+/)
          .map((paragraph) => paragraph.trim())
          .filter((paragraph) => paragraph.length > 0)
          .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
          .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Correction Notice ${escapeHtml(snapshot.noticeNumber)}</title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; color: #17221d; margin: 2rem; font-size: 12px; }
  h1 { font-size: 16px; margin: 1.2rem 0 0.4rem; }
  h2 { font-size: 12px; margin: 1.2rem 0 0.3rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #55635c; }
${BASE_PDF_CSS}
  table { width: 100%; border-collapse: collapse; margin: 0.6rem 0 1rem; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .desc { width: 45%; }
  .preserve { font-size: 10px; color: #55635c; margin-top: 0.2rem; }
  .body-copy p { margin: 0.5rem 0; }
  .sign { margin-top: 3rem; display: flex; justify-content: flex-end; }
  .sign div { border-top: 1px solid #17221d; padding-top: 4px; width: 30%; text-align: center; }
</style>
</head>
<body>
<header>
  <div class="brand">
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
  </div>
  <div class="doc-title">
    <h1>Correction Notice ${escapeHtml(snapshot.noticeNumber)}</h1>
    <p>Against Delivery Challan ${escapeHtml(snapshot.challan.challanNumber)}</p>
  </div>
</header>
<section>
  <p class="label">Work</p>
  <p>${escapeHtml(snapshot.work.workCode)} — ${escapeHtml(snapshot.work.title)}<br />
  LOA ${escapeHtml(snapshot.work.letterNumber)} dated ${escapeHtml(snapshot.work.letterDate)}</p>
  <p class="label">Original document</p>
  <p>Delivery Challan ${escapeHtml(snapshot.challan.challanNumber)} dated ${escapeHtml(snapshot.challan.challanDate)}<br />
  Consignee: ${escapeHtml(snapshot.challan.consignee.name)}, ${escapeHtml(snapshot.challan.consignee.address)}${
    snapshot.challan.consignee.phone !== undefined
      ? ` · ${escapeHtml(snapshot.challan.consignee.phone)}`
      : ''
  }</p>
  <p class="preserve">The original challan remains in force as issued; this
  notice records the sanctioned corrections against it.</p>
</section>
<h2>Original lines</h2>
<table>
  <thead>
    <tr><th>#</th><th>Item</th><th>Description</th><th>Unit</th><th>Quantity</th></tr>
  </thead>
  <tbody>
${lineRows}
  </tbody>
</table>
${
  snapshot.corrections.length > 0
    ? `<h2>Corrections</h2>
<table>
  <thead>
    <tr><th>Field</th><th>Corrected reading</th></tr>
  </thead>
  <tbody>
${correctionRows}
  </tbody>
</table>`
    : ''
}
${
  statementParagraphs.length > 0
    ? `<section class="body-copy">
  <h2>Correction statement</h2>
${statementParagraphs}
</section>`
    : ''
}
<section class="body-copy">
  <h2>Reason</h2>
  <p>${escapeHtml(snapshot.reason)}</p>
</section>
<section class="sign">
  <div>Authorised signatory</div>
</section>
<footer>
  <p class="label">Template ${escapeHtml(snapshot.templateVersion)} · Issued at ${escapeHtml(snapshot.issuedAt)}</p>
</footer>
</body>
</html>
`;
}
