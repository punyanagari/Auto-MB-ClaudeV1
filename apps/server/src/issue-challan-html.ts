/**
 * Deterministic Issue Challan HTML (template_version ic-v1). The legal
 * content — movement type, issued-to party, lines, quantities — renders
 * ONLY from the immutable issued_snapshot, never from live rows, so a
 * re-render years later reproduces the same record. Branding
 * (organisation logo, address, GSTIN, contact) is presentation, applied
 * from the organisation's current profile at render time. The output
 * goes to Gotenberg for PDF conversion; it must be a complete,
 * self-contained page with no external requests, so the logo is embedded
 * as a data URI. Loan and return movements carry an explicit annotation:
 * the paper must say the material is not an ordinary outward issue.
 */

import { BASE_PDF_CSS, escapeHtml, type ChallanBranding } from './challan-html.js';

export const ISSUE_CHALLAN_TEMPLATE_VERSION = 'ic-v1';

type IssueChallanBranding = ChallanBranding;

interface IssueChallanSnapshotLine {
  readonly position: number;
  /** Null for manual lines outside the LOA. */
  readonly itemNumber: string | null;
  readonly description: string;
  readonly unit: string;
  readonly quantity: string;
}

export interface IssueChallanSnapshot {
  readonly templateVersion: string;
  readonly organisationName: string;
  readonly challanNumber: string;
  readonly challanDate: string;
  readonly issuedAt: string;
  readonly movementType: 'issue' | 'loan' | 'return';
  readonly work: {
    readonly workCode: string;
    readonly title: string;
    readonly letterNumber: string;
    readonly letterDate: string;
  };
  readonly issuedTo: {
    readonly name: string;
    readonly role: string | null;
    readonly location: string | null;
  };
  readonly remarks: string | null;
  readonly lines: readonly IssueChallanSnapshotLine[];
}

const MOVEMENT_ANNOTATIONS: Record<
  IssueChallanSnapshot['movementType'],
  string | null
> = {
  issue: null,
  loan: 'LOAN — material issued on loan and returnable',
  return: 'RETURN — material returned to origin',
};

export function renderIssueChallanHtml(
  snapshot: IssueChallanSnapshot,
  branding: IssueChallanBranding = {},
): string {
  const rows = snapshot.lines
    .map(
      (line) => `<tr>
  <td class="num">${String(line.position)}</td>
  <td>${line.itemNumber !== null ? escapeHtml(line.itemNumber) : '—'}</td>
  <td class="desc">${escapeHtml(line.description)}</td>
  <td>${escapeHtml(line.unit)}</td>
  <td class="num">${escapeHtml(line.quantity)}</td>
</tr>`,
    )
    .join('\n');

  const annotation = MOVEMENT_ANNOTATIONS[snapshot.movementType];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Issue Challan ${escapeHtml(snapshot.challanNumber)}</title>
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
  .desc { width: 50%; }
  .sign { margin-top: 3rem; display: flex; justify-content: space-between; }
  .sign div { border-top: 1px solid #17221d; padding-top: 4px; width: 30%; text-align: center; }
${BASE_PDF_CSS}
  .movement { border: 1.5px solid #17221d; display: inline-block; padding: 3px 8px; margin-top: 6px; font-weight: bold; letter-spacing: 0.04em; }
  .remarks { margin-top: 1rem; }
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
    <h1>Issue Challan ${escapeHtml(snapshot.challanNumber)}</h1>
    <p>Dated ${escapeHtml(snapshot.challanDate)}</p>
  </div>
  ${annotation !== null ? `<p class="movement">${escapeHtml(annotation)}</p>` : ''}
</header>
<section class="meta">
  <div>
    <p class="label">Work</p>
    <p>${escapeHtml(snapshot.work.workCode)} — ${escapeHtml(snapshot.work.title)}<br />
    LOA ${escapeHtml(snapshot.work.letterNumber)} dated ${escapeHtml(snapshot.work.letterDate)}</p>
  </div>
  <div>
    <p class="label">Issued to</p>
    <p>${escapeHtml(snapshot.issuedTo.name)}${
      snapshot.issuedTo.role !== null
        ? `<br />${escapeHtml(snapshot.issuedTo.role)}`
        : ''
    }${
      snapshot.issuedTo.location !== null
        ? `<br />${escapeHtml(snapshot.issuedTo.location)}`
        : ''
    }</p>
  </div>
</section>
<table>
  <thead>
    <tr>
      <th>#</th><th>Item</th><th>Description</th><th>Unit</th><th>Quantity</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
${
  snapshot.remarks !== null
    ? `<section class="remarks">
  <p class="label">Remarks</p>
  <p>${escapeHtml(snapshot.remarks)}</p>
</section>`
    : ''
}
<section class="sign">
  <div>Prepared by</div>
  <div>Received by</div>
  <div>Authorised signatory</div>
</section>
<footer>
  <p class="label">Template ${escapeHtml(snapshot.templateVersion)} · Issued at ${escapeHtml(snapshot.issuedAt)}</p>
</footer>
</body>
</html>
`;
}
