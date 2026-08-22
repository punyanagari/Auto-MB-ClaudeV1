import type {
  CombinedPendingRow,
  CombinedPendingTotals,
  DivisionAnalysisResponse,
  MappedItemAnalysisResponse,
  WorkAnalysisResponse,
} from '@auto-mb/contracts';
import { BASE_PDF_CSS, escapeHtml, type ChallanBranding } from './challan-html.js';
import type { XlsxColumn, XlsxValue } from './xlsx.js';

/**
 * One works-analysis report as a DOCUMENT — headings, tables, totals and
 * footnotes — from which both the PDF and the workbook are produced.
 *
 * The alternative was a PDF template and a workbook descriptor per report:
 * six things to keep in step, and the first column somebody added to one
 * would silently be missing from the other. A reader who exports the same
 * report twice must get the same figures under the same headings, and the
 * cheapest way to guarantee that is to have one thing to get right.
 *
 * The screen deliberately does NOT render from this model. It reads the
 * JSON response directly, because a table an operator sorts, filters and
 * hides columns on is not the same artefact as a page that goes to a
 * printer — and forcing them through one shape would make both worse. What
 * they share is the server's figures, which is the part that must not drift.
 */
export interface AnalysisTable {
  readonly heading: string;
  /** One sentence under the heading, where the table needs a caveat that
   * belongs beside it rather than in the document's footnotes. */
  readonly note?: string;
  readonly columns: readonly XlsxColumn[];
  readonly rows: readonly (readonly XlsxValue[])[];
  /** The section total. Positional against `columns`, with nulls in the
   * cells a total is meaningless for. */
  readonly total?: readonly XlsxValue[];
  readonly emptyMessage: string;
}

export interface AnalysisDocument {
  readonly title: string;
  readonly subtitle: string;
  /** Label/value pairs printed above the tables — the report's own
   * identity, so a page found on a desk says what it is about. */
  readonly facts: readonly (readonly [string, string])[];
  readonly tables: readonly AnalysisTable[];
  /** The column notes. Every exclusion this report makes is named here,
   * on the document, not only in the contract — a reader holding a printed
   * page has no other way to learn that historical invoices are not in it. */
  readonly notes: readonly string[];
}

export const WORKS_ANALYSIS_TEMPLATE_VERSION = 'works-analysis-v1';

/**
 * The footnotes every works-analysis document carries, because every one of
 * them changes what a figure MEANS and a reader cannot infer any of them
 * from the numbers.
 */
const SHARED_NOTES = [
  'Locked opening billing baselines are included in the delivered, installed and billed positions. A Work imported with its history carries that history here.',
  'Historical and imported invoices are excluded from every payment figure. That register is display-only history and carries disputed entries; it is not the bill ledger.',
  'Every figure on this page was computed by the server from the ledgers named beside it. Nothing here was added up by a browser or a spreadsheet.',
];

const QUANTITY = { numeric: true } as const;

/* --- report A: one Work ---------------------------------------------- */

export function toWorkDocument(analysis: WorkAnalysisResponse): AnalysisDocument {
  const { work, totals } = analysis;
  return {
    title: 'Work analysis',
    subtitle: `${work.workCode} — ${work.title}`,
    facts: [
      ['Work code', work.workCode],
      ['Status', work.status],
      ['Contract value', work.contractValue],
      [
        'Railway division',
        analysis.divisionCode ??
          (analysis.divisionSource === 'ambiguous'
            ? `Not settled — this Work's documents name ${analysis.divisionCandidates.join(', ')}`
            : 'No division on record'),
      ],
      [
        'Excess delivery',
        work.allowExcessDelivery
          ? 'Permitted — delivery may exceed the sanctioned quantity'
          : 'Not permitted',
      ],
      [
        'Opening baseline',
        analysis.baselineLocked
          ? 'Locked, and included in the positions below'
          : 'None recorded',
      ],
    ],
    tables: [
      {
        heading: 'Quantity position',
        columns: [
          { header: 'Item' },
          { header: 'Description' },
          { header: 'Unit' },
          { header: 'Rate', ...QUANTITY },
          { header: 'Sanctioned', ...QUANTITY },
          { header: 'Supplied', ...QUANTITY },
          { header: 'Installed', ...QUANTITY },
          { header: 'Pending to supply', ...QUANTITY },
          { header: 'Pending to install', ...QUANTITY },
          { header: 'Supplied, not installed', ...QUANTITY },
          { header: 'Installed above sanction', ...QUANTITY },
        ],
        rows: analysis.items.map((item) => [
          item.itemNumber,
          item.description,
          item.unitCode,
          item.rate,
          item.sanctionedQuantity,
          item.deliveredQuantity,
          item.installedQuantity,
          item.pendingSupplyQuantity,
          item.pendingInstallQuantity,
          item.suppliedNotInstalledQuantity,
          item.installedAboveSanctionedQuantity,
        ]),
        // No quantity total: the column holds several units, and a sum
        // across units is a number that is wrong in a way no heading
        // repairs. The value tables below are where the totals live.
        emptyMessage: 'This Work has no schedule items.',
      },
      {
        heading: 'Value position',
        note: 'Quantity times the accepted rate. Billed is what finalized Measurement Books and the locked opening baseline have already claimed; unbilled executed is the payment-matrix entitlement of what is supplied, installed and PAC-certified, less that.',
        columns: [
          { header: 'Item' },
          { header: 'Description' },
          { header: 'Sanctioned', ...QUANTITY },
          { header: 'Supplied', ...QUANTITY },
          { header: 'Installed', ...QUANTITY },
          { header: 'Pending to supply', ...QUANTITY },
          { header: 'Pending to install', ...QUANTITY },
          { header: 'Supplied, not installed', ...QUANTITY },
          { header: 'Billed', ...QUANTITY },
          { header: 'Unbilled executed', ...QUANTITY },
        ],
        rows: analysis.items.map((item) => [
          item.itemNumber,
          item.description,
          item.sanctionedValue,
          item.deliveredValue,
          item.installedValue,
          item.pendingSupplyValue,
          item.pendingInstallValue,
          item.suppliedNotInstalledValue,
          item.billedValue,
          // An item whose payment category resolves through no matrix row
          // has no percentage to bill at. A dash, never a zero: "nothing
          // owed" and "the matrix is incomplete" are different answers.
          item.unbilledExecutedValue ?? '—',
        ]),
        total: [
          'Total',
          null,
          totals.sanctionedValue,
          totals.deliveredValue,
          totals.installedValue,
          totals.pendingSupplyValue,
          totals.pendingInstallValue,
          totals.suppliedNotInstalledValue,
          totals.billedValue,
          totals.unbilledExecutedValue,
        ],
        emptyMessage: 'This Work has no schedule items.',
      },
      {
        heading: 'Inspection position',
        note: 'Items carrying an inspection clause. Pending to inspect is the clause quantity less what has been offered on calls that were not cancelled.',
        columns: [
          { header: 'Item' },
          { header: 'Description' },
          { header: 'Agency' },
          { header: 'Clause quantity', ...QUANTITY },
          { header: 'Called', ...QUANTITY },
          { header: 'Passed', ...QUANTITY },
          { header: 'Pending to inspect', ...QUANTITY },
          { header: 'Pending value', ...QUANTITY },
        ],
        rows: analysis.items
          .filter((item) => item.inspectionAgency !== null)
          .map((item) => [
            item.itemNumber,
            item.description,
            item.inspectionAgency,
            item.inspectionQuantity ?? '—',
            item.inspectionCalledQuantity,
            item.inspectionPassedQuantity,
            item.pendingInspectionQuantity ?? '—',
            item.pendingInspectionValue ?? '—',
          ]),
        emptyMessage: 'No item on this Work carries an inspection clause.',
      },
      {
        heading: 'Inspection by agency',
        columns: [
          { header: 'Agency' },
          { header: 'Items', ...QUANTITY },
          { header: 'Clause quantity', ...QUANTITY },
          { header: 'Called', ...QUANTITY },
          { header: 'Passed', ...QUANTITY },
          { header: 'Pending to inspect', ...QUANTITY },
          { header: 'Pending value', ...QUANTITY },
        ],
        rows: analysis.inspection.map((group) => [
          group.agency ?? 'No clause',
          String(group.itemCount),
          group.clauseQuantity,
          group.calledQuantity,
          group.passedQuantity,
          group.pendingQuantity,
          group.pendingValue,
        ]),
        total: [
          'Total',
          String(totals.itemCount),
          null,
          null,
          null,
          null,
          totals.pendingInspectionValue,
        ],
        emptyMessage: 'No item on this Work carries an inspection clause.',
      },
      {
        heading: 'Payment position',
        note: "Per bill, never per item: a receipt settles a bill, and a bill closes a Measurement Book covering many items. The reference is the railway's own figure, and a deduction counts as settled because money the railway kept is not money it still owes.",
        columns: [
          { header: 'Bill' },
          { header: 'Status' },
          { header: 'Prepared', ...QUANTITY },
          { header: "Railway's figure", ...QUANTITY },
          { header: 'Received', ...QUANTITY },
          { header: 'Deducted', ...QUANTITY },
          { header: 'Outstanding', ...QUANTITY },
        ],
        rows: analysis.bills.map((bill) => [
          bill.billNumber,
          bill.status,
          bill.preparedAmount,
          // Null while the measurement is not closed. The dash is the
          // honest reading: nothing is outstanding on this bill YET.
          bill.railwayBillAmount ?? '—',
          bill.receivedTotal,
          bill.deductionTotal,
          bill.outstandingAmount ?? '—',
        ]),
        total: [
          'Total',
          `${String(analysis.payment.billCount)} bills`,
          null,
          analysis.payment.railwayTotal,
          analysis.payment.receivedTotal,
          analysis.payment.deductionTotal,
          analysis.payment.outstandingTotal,
        ],
        emptyMessage: 'No bill has been raised on this Work.',
      },
    ],
    notes: [
      ...(totals.itemsWithoutMatrixRow > 0
        ? [
            `${String(totals.itemsWithoutMatrixRow)} item(s) resolve through no payment-matrix row, so their executed value is unknown rather than zero and is shown as a dash. Set their payment category to fill them in.`,
          ]
        : []),
      ...(analysis.payment.indeterminateBills > 0
        ? [
            `${String(analysis.payment.indeterminateBills)} bill(s) have no closed measurement yet, so the railway has stated no figure against them. They are counted but their amounts are absent from the totals.`,
          ]
        : []),
      'Pending to supply is the sanctioned quantity less what has been delivered on issued challans. The excess-delivery toggle lifts the delivery cap only; it does not change this figure.',
      'Pending to install is the sanctioned quantity less what has been installed. Installation carries no database ceiling, so any overrun is reported in its own column rather than hidden by the subtraction.',
      ...SHARED_NOTES,
    ],
  };
}

/* --- reports B and C: combined pending -------------------------------- */

const PENDING_COLUMNS: readonly XlsxColumn[] = [
  { header: 'Item' },
  { header: 'Group' },
  { header: 'Unit' },
  { header: 'Rate' },
  { header: 'Works', ...QUANTITY },
  { header: 'Lines', ...QUANTITY },
  { header: 'Sanctioned', ...QUANTITY },
  { header: 'Supplied', ...QUANTITY },
  { header: 'Installed', ...QUANTITY },
  { header: 'Pending to supply', ...QUANTITY },
  { header: 'Pending supply value', ...QUANTITY },
  { header: 'Pending to install', ...QUANTITY },
  { header: 'Pending install value', ...QUANTITY },
];

/** The rate column. Equal bounds print as one figure; a spread prints as a
 * range, because the lines under this row genuinely carry different
 * accepted rates and a single number would invent one. */
function rateText(row: CombinedPendingRow): string {
  return row.rateLow === row.rateHigh
    ? row.rateLow
    : `${row.rateLow} – ${row.rateHigh}`;
}

function pendingRowCells(row: CombinedPendingRow): XlsxValue[] {
  return [
    row.label,
    row.groupName ?? (row.canonicalItemId === null ? 'Not mapped' : '—'),
    row.unitCode,
    rateText(row),
    String(row.workCount),
    String(row.lineCount),
    row.sanctionedQuantity,
    row.deliveredQuantity,
    row.installedQuantity,
    row.pendingSupplyQuantity,
    row.pendingSupplyValue,
    row.pendingInstallQuantity,
    row.pendingInstallValue,
  ];
}

function pendingTotalCells(label: string, totals: CombinedPendingTotals): XlsxValue[] {
  return [
    label,
    null,
    null,
    null,
    null,
    String(totals.rowCount),
    null,
    null,
    null,
    null,
    totals.pendingSupplyValue,
    null,
    totals.pendingInstallValue,
  ];
}

const GROUPING_NOTES = [
  'Lines combine where an item-master mapping exists: a schedule line counts against a master item when its description equals that item’s name or one of its aliases, compared lowercased and trimmed. Nothing is merged on resemblance.',
  'A master item quantified in two units produces two rows, never one. Quantities are never added across units.',
  'Where the lines under a row carry different accepted rates the rate prints as a range. The value columns are summed at each line’s own rate, so a spread never makes a total wrong.',
  'Only active Works are counted. A cancelled Work is not something to order against, and a completed one has nothing outstanding by definition.',
];

export function toDivisionDocument(
  analysis: DivisionAnalysisResponse,
): AnalysisDocument {
  const tables: AnalysisTable[] = analysis.divisions.map((division) => ({
    heading:
      division.divisionCode === null
        ? 'No division on record'
        : `Division ${division.divisionCode}`,
    note:
      division.divisionCode === null
        ? 'Works whose documents name no railway division, or name more than one. A Work naming two is listed here rather than filed under a division chosen by tie-break.'
        : `${String(division.works.length)} Work(s): ${division.works.map((work) => work.workCode).join(', ')}`,
    columns: PENDING_COLUMNS,
    rows: division.rows.map(pendingRowCells),
    total: pendingTotalCells('Division total', division.totals),
    emptyMessage: 'Nothing is pending across this division’s Works.',
  }));
  return {
    title: 'Division analysis',
    subtitle: 'Pending quantities combined across the Works of each railway division',
    facts: [
      ['Divisions', String(analysis.divisions.length)],
      ['Pending to supply', analysis.totals.pendingSupplyValue],
      ['Pending to install', analysis.totals.pendingInstallValue],
    ],
    tables:
      tables.length > 0
        ? tables
        : [
            {
              heading: 'No division on record',
              columns: PENDING_COLUMNS,
              rows: [],
              emptyMessage: 'No active Work carries a pending quantity.',
            },
          ],
    notes: [
      'A Work’s division is DERIVED. This schema records no client contact on a Work, so the evidence is the Work’s own consignees — the railway offices it is executed for, chosen on the Work’s Consignees screen — and the division code recorded on each of those contacts.',
      'One distinct code across that evidence is the Work’s division. Several is reported as unsettled and grouped under "No division on record", because a tie-break would put a whole pending position under a heading somebody would then order against.',
      ...GROUPING_NOTES,
      ...SHARED_NOTES,
    ],
  };
}

export function toMappedItemDocument(
  analysis: MappedItemAnalysisResponse,
): AnalysisDocument {
  const mapped = analysis.rows.filter((row) => row.canonicalItemId !== null);
  const unmapped = analysis.rows.filter((row) => row.canonicalItemId === null);
  return {
    title: 'Item analysis',
    subtitle: 'Pending quantities combined per item master, across every active Work',
    facts: [
      ['Master items with a pending position', String(mapped.length)],
      ['Unmapped lines', String(analysis.unmappedLineCount)],
      ['Pending to supply', analysis.totals.pendingSupplyValue],
      ['Pending to install', analysis.totals.pendingInstallValue],
    ],
    tables: [
      {
        heading: 'Mapped items',
        columns: PENDING_COLUMNS,
        rows: mapped.map(pendingRowCells),
        total: pendingTotalCells('Mapped total', analysis.totals),
        emptyMessage:
          'No schedule line maps to an item master yet. The item master screen is where a master item and its alternative wordings are recorded.',
      },
      {
        heading: 'Not mapped to an item master',
        note: 'One row per distinct description. These do not combine with anything, because nothing has yet said that they name the same product.',
        columns: PENDING_COLUMNS,
        rows: unmapped.map(pendingRowCells),
        emptyMessage: 'Every live schedule line maps to an item master.',
      },
    ],
    notes: [...GROUPING_NOTES, ...SHARED_NOTES],
  };
}

/* --- the workbook ----------------------------------------------------- */

/**
 * The document as one sheet.
 *
 * Section headings and totals travel as ROWS rather than as separate sheets:
 * an operator filters and pivots a works-analysis workbook, and a figure
 * that lives on a different sheet from the rows it totals is one they cannot
 * reach in the same formula. The widest table sets the sheet's column count;
 * narrower sections leave their trailing cells empty, which `buildXlsx`
 * already handles positionally.
 */
export function worksAnalysisSheet(document: AnalysisDocument): {
  columns: readonly XlsxColumn[];
  rows: readonly (readonly XlsxValue[])[];
} {
  const width = Math.max(1, ...document.tables.map((table) => table.columns.length), 2);
  const rows: XlsxValue[][] = [];
  const blank = (): XlsxValue[] => Array.from({ length: width }, () => null);
  const line = (cells: readonly XlsxValue[]): XlsxValue[] => {
    const row = blank();
    cells.forEach((cell, index) => {
      row[index] = cell ?? null;
    });
    return row;
  };

  rows.push(line([document.title, document.subtitle]));
  for (const [label, value] of document.facts) rows.push(line([label, value]));

  for (const table of document.tables) {
    rows.push(blank());
    rows.push(line([table.heading]));
    if (table.note !== undefined) rows.push(line([table.note]));
    rows.push(line(table.columns.map((column) => column.header)));
    if (table.rows.length === 0) {
      rows.push(line([table.emptyMessage]));
    } else {
      for (const row of table.rows) rows.push(line(row));
    }
    if (table.total !== undefined) rows.push(line(table.total));
  }

  rows.push(blank());
  rows.push(line(['Notes']));
  for (const note of document.notes) rows.push(line([note]));

  // Every cell is TEXT in this sheet's declared columns. The numeric
  // columns differ per section, and one column declaration cannot be right
  // for a sheet whose sections have different shapes — declaring column 5
  // numeric would type a division's name as a number in the section above
  // it. The values are still the server's own decimal strings, and Excel
  // reads them as numbers the moment they are used in a formula.
  const columns: XlsxColumn[] = Array.from({ length: width }, (_unused, index) => ({
    header: index === 0 ? document.title : '',
  }));
  return { columns, rows };
}

/* --- the PDF ---------------------------------------------------------- */

function tableHtml(table: AnalysisTable): string {
  const head = table.columns
    .map(
      (column) =>
        `<th${column.numeric === true ? ' class="num"' : ''}>${escapeHtml(column.header)}</th>`,
    )
    .join('');
  const body =
    table.rows.length === 0
      ? `<tr><td colspan="${String(table.columns.length)}" class="empty">${escapeHtml(table.emptyMessage)}</td></tr>`
      : table.rows
          .map(
            (row) =>
              `<tr>${table.columns
                .map(
                  (column, index) =>
                    `<td${column.numeric === true ? ' class="num"' : ''}>${escapeHtml(row[index] ?? '')}</td>`,
                )
                .join('')}</tr>`,
          )
          .join('\n');
  const foot =
    table.total === undefined
      ? ''
      : `<tfoot><tr>${table.columns
          .map(
            (column, index) =>
              `<td${column.numeric === true ? ' class="num"' : ''}>${escapeHtml(table.total?.[index] ?? '')}</td>`,
          )
          .join('')}</tr></tfoot>`;
  return `<h2>${escapeHtml(table.heading)}</h2>
${table.note === undefined ? '' : `<p class="note">${escapeHtml(table.note)}</p>`}
<table>
  <thead><tr>${head}</tr></thead>
  <tbody>
${body}
  </tbody>
  ${foot}
</table>`;
}

/**
 * The report as a self-contained page for Gotenberg.
 *
 * Landscape, because a works-analysis table is eleven columns wide and a
 * portrait page turns that into a wrapped mess an operator cannot read
 * across. `@page` is the only way to say so — Gotenberg's Chromium honours
 * it, and the alternative is a per-route flag on the shared renderer that
 * exists for one document.
 */
export function renderWorksAnalysisHtml(
  document: AnalysisDocument,
  branding: ChallanBranding = {},
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(document.title)} — ${escapeHtml(document.subtitle)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: Helvetica, Arial, sans-serif; color: #17221d; margin: 0; font-size: 10px; }
  h1 { font-size: 16px; margin: 1rem 0 0.2rem; }
  h2 { font-size: 11px; margin: 1.1rem 0 0.3rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: #55635c; }
${BASE_PDF_CSS}
  table { width: 100%; border-collapse: collapse; margin: 0.3rem 0 0.8rem; }
  th, td { border: 1px solid #999; padding: 3px 5px; text-align: left; vertical-align: top; }
  th { font-size: 9px; text-transform: uppercase; background: #f1f3f2; }
  tfoot td { font-weight: bold; background: #f1f3f2; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .empty { color: #55635c; font-style: italic; }
  .note { font-size: 9px; color: #55635c; margin: 0 0 0.2rem; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 0.4rem 0 0.8rem; }
  .facts div { min-width: 120px; }
  .notes { margin-top: 1rem; font-size: 9px; color: #55635c; }
  .notes li { margin-bottom: 3px; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
</style>
</head>
<body>
<header>
  <div class="brand">
    ${branding.logoDataUri !== undefined ? `<img src="${branding.logoDataUri}" alt="" />` : ''}
    <div>
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
    <h1>${escapeHtml(document.title)}</h1>
    <p>${escapeHtml(document.subtitle)}</p>
  </div>
</header>
<section class="facts">
${document.facts
  .map(
    ([label, value]) =>
      `  <div><p class="label">${escapeHtml(label)}</p><p>${escapeHtml(value)}</p></div>`,
  )
  .join('\n')}
</section>
${document.tables.map((table) => tableHtml(table)).join('\n')}
<section class="notes">
  <h2>Notes</h2>
  <ul>
${document.notes.map((note) => `    <li>${escapeHtml(note)}</li>`).join('\n')}
  </ul>
</section>
<footer>
  <p class="label">Template ${escapeHtml(WORKS_ANALYSIS_TEMPLATE_VERSION)}</p>
</footer>
</body>
</html>
`;
}
