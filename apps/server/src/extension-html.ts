/**
 * Deterministic extension-request letter HTML (template_version
 * extension-v1). The legal content — the parties, the dates, the reason —
 * renders ONLY from the immutable finalised_snapshot, never from live
 * rows, so a re-render years later reproduces the same letter. Branding
 * (organisation logo, address, GSTIN, contact) is presentation, applied
 * from the organisation's current profile at render time. The output goes
 * to Gotenberg for PDF conversion; it must be a complete, self-contained
 * page with no external requests, so the logo is embedded as a data URI.
 */

import {
  BASE_PDF_CSS,
  escapeHtml,
  WATERMARK_CSS,
  type ChallanBranding,
} from './challan-html.js';

export const EXTENSION_TEMPLATE_VERSION = 'extension-v1';

/** Manual back-fill records (paper letters transcribed into the register,
 * migration 0029) carry this template version. They are never rendered —
 * the paper letter is the record — the version only marks the snapshot as
 * a transcription. */
export const MANUAL_TEMPLATE_VERSION = 'extension-manual-v1';

type ExtensionBranding = ChallanBranding;

export interface ExtensionSnapshot {
  readonly templateVersion: string;
  readonly organisationName: string;
  readonly requestNumber: string;
  /** Present only on manual back-fill snapshots: the paper letter's own
   * reference, preserved verbatim. */
  readonly manualReference?: string;
  readonly letterDate: string;
  readonly addressee: string;
  readonly reason: string;
  readonly work: {
    readonly workCode: string;
    readonly title: string;
    readonly letterNumber: string;
    readonly letterDate: string;
  };
  readonly originalCompletionDate: string;
  readonly currentCompletionDate: string;
  readonly proposedCompletionDate: string;
  readonly finalisedAt: string;
}

interface ExtensionRenderOptions {
  /** Overlay the diagonal DRAFT watermark (legacy §5.5: the draft PDF is
   * watermarked DRAFT; only finalisation assigns a number). The preview
   * is streamed, never stored — drafts carry no render state (0011). */
  readonly draftWatermark?: boolean;
}

export function renderExtensionHtml(
  snapshot: ExtensionSnapshot,
  branding: ExtensionBranding = {},
  options: ExtensionRenderOptions = {},
): string {
  const reasonParagraphs = snapshot.reason
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Extension Request ${escapeHtml(snapshot.requestNumber)}</title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; color: #17221d; margin: 2rem; font-size: 12px; }
  h1 { font-size: 16px; margin: 1.2rem 0 0.4rem; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #55635c; }
${BASE_PDF_CSS}
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; width: 40%; }
  .sign { margin-top: 3rem; display: flex; justify-content: flex-end; }
  .sign div { border-top: 1px solid #17221d; padding-top: 4px; width: 30%; text-align: center; }
  .addressee { white-space: pre-line; margin: 1rem 0; }
  .body-copy p { margin: 0.5rem 0; }
${WATERMARK_CSS}
</style>
</head>
<body>
${options.draftWatermark === true ? '<div class="watermark">DRAFT</div>' : ''}
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
    <h1>Extension Request ${escapeHtml(snapshot.requestNumber)}</h1>
    <p>Dated ${escapeHtml(snapshot.letterDate)}</p>
  </div>
</header>
<section>
  <p class="label">To</p>
  <p class="addressee">${escapeHtml(snapshot.addressee)}</p>
  <p class="label">Subject</p>
  <p>Request for extension of the completion date of ${escapeHtml(snapshot.work.workCode)} — ${escapeHtml(snapshot.work.title)}
  (LOA ${escapeHtml(snapshot.work.letterNumber)} dated ${escapeHtml(snapshot.work.letterDate)}).</p>
</section>
<table>
  <caption class="label">Completion dates</caption>
  <tbody>
    <tr><th scope="row">Original completion date</th><td>${escapeHtml(snapshot.originalCompletionDate)}</td></tr>
    <tr><th scope="row">Current completion date</th><td>${escapeHtml(snapshot.currentCompletionDate)}</td></tr>
    <tr><th scope="row">Proposed completion date</th><td>${escapeHtml(snapshot.proposedCompletionDate)}</td></tr>
  </tbody>
</table>
<section class="body-copy">
  <p class="label">Grounds for the request</p>
${reasonParagraphs}
  <p>We request that the completion date of the above Work be extended to
  ${escapeHtml(snapshot.proposedCompletionDate)}.</p>
</section>
<section class="sign">
  <div>Authorised signatory</div>
</section>
<footer>
  <p class="label">${
    options.draftWatermark === true
      ? `Template ${escapeHtml(snapshot.templateVersion)} · DRAFT — not a numbered letter`
      : `Template ${escapeHtml(snapshot.templateVersion)} · Finalised at ${escapeHtml(snapshot.finalisedAt)}`
  }</p>
</footer>
</body>
</html>
`;
}
