/**
 * Deterministic outward-letter HTML (template correspondence-v1).
 *
 * The legal content renders only from `correspondence_letters` columns
 * that migration 0086's update guard freezes at insert, so this is a pure
 * function of immutable data and the same letter comes back years later.
 * That is what lets the module store no rendered PDF: there is nothing a
 * re-render could disagree with.
 *
 * Branding (logo, address, GSTIN, contact) is presentation and is applied
 * from the organisation's CURRENT profile at render time — the same split
 * `extension-html.ts` makes. The output goes to Gotenberg, so it must be a
 * complete self-contained page with no external requests, which is why the
 * logo travels as a data URI.
 */

import {
  BASE_PDF_CSS,
  escapeHtml,
  WATERMARK_CSS,
  type ChallanBranding,
} from './challan-html.js';

const CORRESPONDENCE_TEMPLATE_VERSION = 'correspondence-v1';

type CorrespondenceBranding = ChallanBranding;

export interface OutwardLetterSnapshot {
  readonly organisationName: string;
  readonly letterNumber: string;
  readonly letterDate: string;
  readonly counterpartyName: string;
  readonly subject: string;
  readonly body: string;
  /** The Work this letter concerns, or null for general correspondence. */
  readonly work: {
    readonly workCode: string;
    readonly title: string;
  } | null;
  /** The number of the letter this one answers, where it answers one. */
  readonly inReplyTo: string | null;
  /** Set once the letter has been cancelled, so a reprint cannot be
   * mistaken for the live document. */
  readonly cancelledReason: string | null;
}

export function renderOutwardLetterHtml(
  snapshot: OutwardLetterSnapshot,
  branding: CorrespondenceBranding = {},
): string {
  const bodyParagraphs = snapshot.body
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('\n');

  const orgDetails = [
    branding.address ?? null,
    branding.gstin != null ? `GSTIN ${branding.gstin}` : null,
    [branding.contactPhone, branding.contactEmail]
      .filter((value): value is string => value != null)
      .join(' · ') || null,
  ]
    .filter((value): value is string => value !== null)
    .map((value) => escapeHtml(value))
    .join('<br />');

  const referenceLines = [
    snapshot.work !== null
      ? `Work ${escapeHtml(snapshot.work.workCode)} — ${escapeHtml(snapshot.work.title)}`
      : null,
    snapshot.inReplyTo !== null
      ? `In reply to ${escapeHtml(snapshot.inReplyTo)}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .map((line) => `<p class="reference">${line}</p>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Letter ${escapeHtml(snapshot.letterNumber)}</title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; color: #17221d; margin: 2rem; font-size: 12px; }
  h1 { font-size: 16px; margin: 1.2rem 0 0.4rem; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #55635c; }
${BASE_PDF_CSS}
  .addressee { white-space: pre-line; margin: 0.4rem 0 1rem; }
  .reference { margin: 0.2rem 0; }
  .body-copy p { margin: 0.6rem 0; }
  .sign { margin-top: 3rem; display: flex; justify-content: flex-end; }
  .sign div { border-top: 1px solid #17221d; padding-top: 4px; width: 30%; text-align: center; }
${WATERMARK_CSS}
</style>
</head>
<body>
${snapshot.cancelledReason !== null ? '<div class="watermark">CANCELLED</div>' : ''}
<header>
  <div class="brand">
    ${branding.logoDataUri !== undefined ? `<img src="${branding.logoDataUri}" alt="" />` : ''}
    <div>
      <div class="org">${escapeHtml(snapshot.organisationName)}</div>
      <div class="org-details">${orgDetails}</div>
    </div>
  </div>
  <div class="doc-title">
    <h1>${escapeHtml(snapshot.letterNumber)}</h1>
    <p>Dated ${escapeHtml(snapshot.letterDate)}</p>
  </div>
</header>
<section>
  <p class="label">To</p>
  <p class="addressee">${escapeHtml(snapshot.counterpartyName)}</p>
${referenceLines}
  <p class="label">Subject</p>
  <p>${escapeHtml(snapshot.subject)}</p>
</section>
<section class="body-copy">
${bodyParagraphs}
</section>
<section class="sign">
  <div>Authorised signatory</div>
</section>
<footer>
  <p class="label">${
    snapshot.cancelledReason !== null
      ? `Template ${CORRESPONDENCE_TEMPLATE_VERSION} · CANCELLED — ${escapeHtml(snapshot.cancelledReason)}`
      : `Template ${CORRESPONDENCE_TEMPLATE_VERSION}`
  }</p>
</footer>
</body>
</html>
`;
}
