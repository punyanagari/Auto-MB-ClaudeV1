/**
 * Deterministic Delivery Challan HTML (template_version dc-v1), rendered
 * ONLY from the immutable issued_snapshot — never from live rows, so a
 * re-render years later reproduces the same document. The output goes to
 * Gotenberg for PDF conversion; it must be a complete, self-contained
 * page with no external requests.
 */

export const CHALLAN_TEMPLATE_VERSION = 'dc-v1';

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
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderChallanHtml(snapshot: ChallanSnapshot): string {
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
</style>
</head>
<body>
<header>
  <h1>Delivery Challan ${escapeHtml(snapshot.challanNumber)}</h1>
  <p>${escapeHtml(snapshot.organisationName)} · Dated ${escapeHtml(snapshot.challanDate)}</p>
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
  <p class="label">Template ${escapeHtml(snapshot.templateVersion)} · Issued at ${escapeHtml(snapshot.issuedAt)}</p>
</footer>
</body>
</html>
`;
}
