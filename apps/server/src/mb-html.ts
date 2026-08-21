/**
 * Deterministic Measurement Book document HTML (template_version mb-v2;
 * spec §5.9 "MB document (PDF)" and §11 document conventions). The
 * legal content — the MB identity, the work identity, the per-item
 * stage deltas, amounts, remarks, the total, and the amount in words —
 * renders ONLY from the self-contained snapshot argument: finalized MBs
 * pass their immutable stored lines, drafts pass the live preview, and
 * a re-render years later reproduces the same document. Branding
 * (organisation logo, address, GSTIN, contact) is presentation, applied
 * from the organisation's current profile at render time (the challan
 * brand pattern). The output goes to Gotenberg for PDF conversion, so
 * it must be a complete, self-contained page with no external requests.
 *
 * Conventions: a diagonal DRAFT watermark while the MB is draft (§11:
 * "Draft prints watermarked DRAFT"); a FINAL BILL banner on the final
 * MB; quantities via the remark library's renderQuantity; amounts kept
 * verbatim at their snapshotted 2 fraction digits.
 */

import { amountInWords } from './amount-in-words.js';
import {
  BASE_PDF_CSS,
  escapeHtml,
  WATERMARK_CSS,
  type ChallanBranding,
} from './challan-html.js';
import type { MbWay } from './mb-coefficient.js';
import { renderQuantity } from './mb-remark.js';

/**
 * mb-v2, and the bump is the coefficient rendering (migration 0113).
 *
 * The version identifies the TEMPLATE a stored PDF was produced under, and
 * this template now prints a column the v1 one did not. A finalized book
 * rendered under v1 keeps its bytes and its version; nothing is
 * re-rendered.
 */
export const MB_TEMPLATE_VERSION = 'mb-v2';

export type MeasurementBookBranding = ChallanBranding;

interface MeasurementBookSnapshotLine {
  /** Schedule/serial identity of the item ('A/1', 'S/2'). */
  readonly itemNumber: string;
  readonly description: string;
  readonly unitCode: string;
  /** Stage delta quantities as exact decimal strings — PHYSICAL on a
   * `physical` sheet, already scaled by the stage percentage on a
   * `coefficient` one (migration 0113). The caller applies the way, for
   * the reason `toSnapshot` gives: the scaling needs percentages this
   * snapshot deliberately does not carry. */
  readonly deltaSupplied: string;
  readonly deltaInstalled: string;
  readonly deltaPac: string;
  /** The line total (line-rounded stage amounts summed, R13), 2dp. */
  readonly lineTotal: string;
  /** The contractual remark, reproduced character-for-character. */
  readonly remark: string;
}

export interface MeasurementBookSnapshot {
  readonly templateVersion: string;
  readonly organisationName: string;
  readonly status: 'draft' | 'finalized' | 'cancelled';
  /** null while draft — the document then titles itself DRAFT. */
  readonly mbNumber: string | null;
  readonly mbDate: string;
  /** The final MB closes the payment cycle: FINAL BILL banner. */
  readonly isFinal: boolean;
  /**
   * How this sheet is filed (migration 0113).
   *
   * On a `coefficient` sheet the stage quantities above are already
   * multiplied by their stage percentages and a PAYABLE column reads
   * 100%, which is exactly what IWRCMS prints beside its own `Reason for
   * Reduction` text on every document of the settlement corpus. On a
   * `physical` sheet the quantities are physical, the percentages live in
   * the remark as they always have, and no payable column is printed.
   *
   * The amounts and the total are identical either way; this changes what
   * the quantity column MEANS, never what is owed.
   */
  readonly way: MbWay;
  readonly work: {
    readonly workCode: string;
    readonly title: string;
    readonly letterNumber: string;
    readonly letterDate: string;
  };
  readonly lines: readonly MeasurementBookSnapshotLine[];
  /** Total payable this MB, 2dp; rendered in words below the table. */
  readonly totalAmount: string;
  /** The remark wording version the line remarks were rendered with. */
  readonly remarkTemplateVersion: string;
}

export function renderMeasurementBookHtml(
  snapshot: MeasurementBookSnapshot,
  branding: MeasurementBookBranding = {},
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

  const title = snapshot.mbNumber ?? 'DRAFT';
  const watermark =
    snapshot.status === 'draft' ? '<div class="watermark">DRAFT</div>' : '';
  const finalBanner = snapshot.isFinal ? '<p class="final-banner">FINAL BILL</p>' : '';

  // The coefficient sheet's PAYABLE column: a literal 100% against every
  // line, because the quantity beside it has already absorbed the stage
  // percentage. Not computed per line — on a coefficient sheet it is 100%
  // by construction, and a column that could read anything else would be
  // saying the scaling had not been done.
  const payableHeader = snapshot.way === 'coefficient' ? '<th>Payable</th>' : '';
  const payableCell =
    snapshot.way === 'coefficient' ? '\n  <td class="num">100%</td>' : '';
  const totalSpan = snapshot.way === 'coefficient' ? 7 : 6;

  const rows = snapshot.lines
    .map(
      (line) => `<tr>
  <td>${escapeHtml(line.itemNumber)}</td>
  <td class="desc">${escapeHtml(line.description)}</td>
  <td>${escapeHtml(line.unitCode)}</td>
  <td class="num">${escapeHtml(renderQuantity(line.deltaSupplied))}</td>
  <td class="num">${escapeHtml(renderQuantity(line.deltaInstalled))}</td>
  <td class="num">${escapeHtml(renderQuantity(line.deltaPac))}</td>${payableCell}
  <td class="num">${escapeHtml(line.lineTotal)}</td>
  <td class="remark">${escapeHtml(line.remark)}</td>
</tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Measurement Book ${escapeHtml(title)}</title>
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
  .desc { width: 24%; }
  .remark { width: 26%; }
  .total td { font-weight: bold; }
  .in-words { margin-top: 0.75rem; }
  .sign { margin-top: 3rem; display: flex; justify-content: space-between; }
  .sign div { border-top: 1px solid #17221d; padding-top: 4px; width: 30%; text-align: center; }
${BASE_PDF_CSS}
  .final-banner { border: 2px solid #17221d; display: inline-block; padding: 4px 12px; font-weight: bold; letter-spacing: 0.15em; margin: 0.75rem 0 0; }
${WATERMARK_CSS}
</style>
</head>
<body>
${watermark}
<header>
  ${brandBlock}
  <div class="doc-title">
    <h1>Measurement Book ${escapeHtml(title)}</h1>
    <p>Dated ${escapeHtml(snapshot.mbDate)}</p>
  </div>
  ${finalBanner}
</header>
<section class="meta">
  <div>
    <p class="label">Work</p>
    <p>${escapeHtml(snapshot.work.workCode)} — ${escapeHtml(snapshot.work.title)}<br />
    LOA ${escapeHtml(snapshot.work.letterNumber)} dated ${escapeHtml(snapshot.work.letterDate)}</p>
  </div>
</section>
<table>
  <thead>
    <tr>
      <th>Schedule/Sr</th><th>Description</th><th>Unit</th>
      <th>Supplied Δ</th><th>Installed Δ</th><th>PAC Δ</th>${payableHeader}
      <th>Amount (Rs.)</th><th>Remark</th>
    </tr>
  </thead>
  <tbody>
${rows}
    <tr class="total"><td colspan="${String(totalSpan)}">Total payable this MB</td><td class="num">${escapeHtml(snapshot.totalAmount)}</td><td></td></tr>
  </tbody>
</table>
<p class="in-words"><span class="label">Amount in words</span><br />${escapeHtml(amountInWords(snapshot.totalAmount))}</p>
<section class="sign">
  <div>Prepared by</div>
  <div>Checked by</div>
  <div>Authorised signatory</div>
</section>
<footer>
  <p class="label">Template ${escapeHtml(snapshot.templateVersion)} · Remarks ${escapeHtml(snapshot.remarkTemplateVersion)}</p>
</footer>
</body>
</html>
`;
}
