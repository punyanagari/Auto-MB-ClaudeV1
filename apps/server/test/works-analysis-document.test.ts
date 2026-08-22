import { describe, expect, it } from 'vitest';
import type {
  DivisionAnalysisResponse,
  MappedItemAnalysisResponse,
  WorkAnalysisResponse,
} from '@auto-mb/contracts';
import {
  renderWorksAnalysisHtml,
  selectColumns,
  toDivisionDocument,
  toMappedItemDocument,
  toWorkDocument,
  worksAnalysisSheet,
} from '../src/works-analysis-document.js';

/**
 * The document half of the works-analysis reports, without Gotenberg.
 *
 * `works-analysis.integration.test.ts` proves the FIGURES against a
 * hand-computed fixture and proves the PDF route reaches the renderer. What
 * it cannot prove locally is the shaping between the two, because a PDF
 * needs a service this suite does not run — so the shaping is asserted
 * here, on the same model both outputs are built from.
 *
 * Three things are worth a test and the rest is not:
 *
 *   1. the sheet flattener is index arithmetic over sections of DIFFERENT
 *      widths, and the failure it can have is silent — a row one cell to
 *      the left of its heading reads as plausible data;
 *   2. the exclusions must travel with both documents, because a printed
 *      page is the only place a reader can learn them;
 *   3. the HTML must escape, since a schedule description is operator text
 *      that reaches an HTML template.
 */

const WORK: WorkAnalysisResponse = {
  work: {
    id: '11111111-1111-4111-8111-111111111111',
    workCode: 'WA/1',
    title: 'Signalling at Alpha',
    status: 'active',
    contractValue: '100000.00',
    allowExcessDelivery: false,
  },
  divisionCode: '100',
  divisionSource: 'consignee',
  divisionCandidates: ['100'],
  baselineLocked: false,
  items: [
    {
      workItemId: '22222222-2222-4222-8222-222222222222',
      itemNumber: 'A/1',
      // Angle brackets and an ampersand, because a description is
      // operator text and this one reaches an HTML template.
      description: 'Rack <42U> & cover',
      unitCode: 'nos',
      rate: '1000.000000',
      sanctionedQuantity: '10.000',
      sanctionedValue: '10000.00',
      deliveredQuantity: '4.000',
      deliveredValue: '4000.00',
      installedQuantity: '3.000',
      installedValue: '3000.00',
      pendingSupplyQuantity: '6.000',
      pendingSupplyValue: '6000.00',
      pendingInstallQuantity: '7.000',
      pendingInstallValue: '7000.00',
      suppliedNotInstalledQuantity: '1.000',
      suppliedNotInstalledValue: '1000.00',
      installedAboveSanctionedQuantity: '0.000',
      baselineSuppliedQuantity: '0.000',
      baselineInstalledQuantity: '0.000',
      inspectionAgency: 'RITES',
      gatesDispatch: true,
      inspectionLotSize: '10.000',
      inspectionCalledQuantity: '7.000',
      inspectionCertifiedQuantity: '4.000',
      pendingInspectionQuantity: '6.000',
      pendingInspectionValue: '6000.00',
      billedValue: '0.00',
      executedValue: null,
      unbilledExecutedValue: null,
    },
  ],
  totals: {
    itemCount: 1,
    sanctionedValue: '10000.00',
    deliveredValue: '4000.00',
    installedValue: '3000.00',
    pendingSupplyValue: '6000.00',
    pendingInstallValue: '7000.00',
    suppliedNotInstalledValue: '1000.00',
    pendingInspectionValue: '6000.00',
    billedValue: '0.00',
    unbilledExecutedValue: '0.00',
    itemsWithoutMatrixRow: 1,
  },
  inspection: [
    {
      agency: 'RITES',
      itemCount: 1,
      lotSizeTotal: '10.000',
      calledQuantity: '7.000',
      certifiedQuantity: '4.000',
      pendingQuantity: '6.000',
      pendingValue: '6000.00',
    },
  ],
  bills: [
    {
      billId: '33333333-3333-4333-8333-333333333333',
      billNumber: 'WA/1/B/1',
      status: 'submitted',
      preparedAmount: '5000.00',
      railwayBillAmount: null,
      receivedTotal: '0.00',
      deductionTotal: '0.00',
      outstandingAmount: null,
    },
  ],
  payment: {
    billCount: 1,
    railwayTotal: '0.00',
    receivedTotal: '0.00',
    deductionTotal: '0.00',
    settledTotal: '0.00',
    outstandingTotal: '0.00',
    indeterminateBills: 1,
  },
};

const DIVISION: DivisionAnalysisResponse = {
  divisions: [
    {
      divisionCode: '100',
      divisionSource: 'consignee',
      works: [
        {
          id: WORK.work.id,
          workCode: 'WA/1',
          title: 'Signalling at Alpha',
          divisionSource: 'consignee',
          divisionCandidates: ['100'],
        },
      ],
      rows: [
        {
          canonicalItemId: '44444444-4444-4444-8444-444444444444',
          label: '42U Rack',
          groupName: 'Racks',
          unitCode: 'nos',
          rateLow: '1000.000000',
          rateHigh: '1200.000000',
          workCount: 2,
          lineCount: 3,
          sanctionedQuantity: '23.000',
          deliveredQuantity: '9.000',
          installedQuantity: '3.000',
          pendingSupplyQuantity: '14.000',
          pendingSupplyValue: '14800.00',
          pendingInstallQuantity: '20.000',
          pendingInstallValue: '21000.00',
        },
      ],
      totals: {
        rowCount: 1,
        mappedRowCount: 1,
        lineCount: 3,
        pendingSupplyValue: '14800.00',
        pendingInstallValue: '21000.00',
      },
    },
  ],
  totals: {
    rowCount: 1,
    mappedRowCount: 1,
    lineCount: 3,
    pendingSupplyValue: '14800.00',
    pendingInstallValue: '21000.00',
  },
};

const MAPPED: MappedItemAnalysisResponse = {
  rows: [
    ...DIVISION.divisions[0]!.rows,
    {
      canonicalItemId: null,
      label: 'Cable',
      groupName: null,
      unitCode: 'm',
      rateLow: '50.000000',
      rateHigh: '55.000000',
      workCount: 2,
      lineCount: 2,
      sanctionedQuantity: '150.000',
      deliveredQuantity: '0.000',
      installedQuantity: '0.000',
      pendingSupplyQuantity: '150.000',
      pendingSupplyValue: '7750.00',
      pendingInstallQuantity: '150.000',
      pendingInstallValue: '7750.00',
    },
  ],
  // Each table's own total, so a reader can add the rows above it up.
  mappedTotals: DIVISION.totals,
  unmappedTotals: {
    rowCount: 1,
    mappedRowCount: 0,
    lineCount: 2,
    pendingSupplyValue: '7750.00',
    pendingInstallValue: '7750.00',
  },
  totals: {
    rowCount: 2,
    mappedRowCount: 1,
    lineCount: 5,
    pendingSupplyValue: '22550.00',
    pendingInstallValue: '28750.00',
  },
  unmappedLineCount: 2,
};

describe('the works-analysis sheet', () => {
  it('keeps every section positional against its own headings', () => {
    const document = toWorkDocument(WORK);
    const { columns, rows } = worksAnalysisSheet(document);

    // The sheet is as wide as its widest section; the narrower ones leave
    // their trailing cells empty rather than shifting left.
    const widest = Math.max(...document.tables.map((table) => table.columns.length));
    expect(columns).toHaveLength(widest);
    for (const row of rows) expect(row).toHaveLength(widest);

    // Each heading is followed by that section's own header row, and the
    // data row under it lines up cell for cell. This is the failure the
    // test exists for: a row one column to the left reads as plausible.
    for (const table of document.tables) {
      const at = rows.findIndex((row) => row[0] === table.heading);
      expect(at, `${table.heading} is missing from the sheet`).toBeGreaterThan(-1);
      const headerAt = at + (table.note === undefined ? 1 : 2);
      expect(rows[headerAt]?.slice(0, table.columns.length)).toEqual(
        table.columns.map((column) => column.header),
      );
      if (table.rows.length > 0) {
        expect(rows[headerAt + 1]?.slice(0, table.columns.length)).toEqual(
          table.rows[0]?.map((cell) => cell ?? null),
        );
      }
    }
  });

  it('prints a section total under the rows it totals', () => {
    const { rows } = worksAnalysisSheet(toWorkDocument(WORK));
    const flat = rows.map((row) => row.join('|'));
    const totalAt = flat.findIndex((line) => line.startsWith('Total|'));
    const itemAt = flat.findIndex((line) => line.startsWith('A/1|'));
    expect(itemAt).toBeGreaterThan(-1);
    expect(totalAt).toBeGreaterThan(itemAt);
    expect(flat[totalAt]).toContain('6000.00');
  });

  it('puts the scope sentence first, above the tables it qualifies', () => {
    // UX.md § 38 promises the scope is stated where a reader meets it, not
    // buried under the footnotes of a page they may never scroll to. A
    // narrowed report read as the organisation's whole position is the
    // failure this ordering prevents.
    const scoped = {
      ...toDivisionDocument(DIVISION),
      scope: 'This report covers only the Works you are assigned to.',
    };
    const rows = worksAnalysisSheet(scoped).rows.map((row) => row.join('|'));
    const scopeAt = rows.findIndex((line) => line.includes('only the Works you are'));
    const firstHeading = rows.findIndex((line) => line.startsWith('Division 100'));
    expect(scopeAt).toBeGreaterThan(-1);
    expect(scopeAt).toBeLessThan(firstHeading);

    const html = renderWorksAnalysisHtml(scoped);
    expect(html.indexOf('only the Works you are')).toBeLessThan(
      html.indexOf('Division 100'),
    );
  });

  it('states that the final-bill stage is not in the executed figure', () => {
    // `computeStageAmounts` earns the final-bill stage only on the FINAL
    // Measurement Book, which is a manual act. Excluding it is the only
    // honest reading, and a reader comparing this page to a contract total
    // needs to be told rather than left to find the gap.
    const flat = worksAnalysisSheet(toWorkDocument(WORK))
      .rows.map((row) => row.join(' '))
      .join('\n');
    expect(flat).toContain('final-bill stage');
    expect(renderWorksAnalysisHtml(toWorkDocument(WORK))).toContain('final-bill stage');
  });

  it('carries every exclusion into the workbook', () => {
    for (const document of [
      toWorkDocument(WORK),
      toDivisionDocument(DIVISION),
      toMappedItemDocument(MAPPED),
    ]) {
      const flat = worksAnalysisSheet(document)
        .rows.map((row) => row.join(' '))
        .join('\n');
      expect(flat).toContain('Historical and imported invoices are excluded');
      expect(flat).toContain('Locked opening billing baselines are included');
    }
  });

  it('says a figure is unknown with a dash rather than a zero', () => {
    // A/1 resolves through no payment-matrix row and its bill has no
    // railway figure yet. Neither may print as 0.00.
    const flat = worksAnalysisSheet(toWorkDocument(WORK))
      .rows.map((row) => row.join('|'))
      .join('\n');
    // Trailing pipes are the padding to the widest section, so the
    // assertions are on the CELL, not on the end of the line.
    expect(flat).toMatch(/^A\/1\|Rack <42U> & cover\|10000\.00\|.*\|0\.00\|—\|*$/m);
    expect(flat).toMatch(/^WA\/1\/B\/1\|submitted\|5000\.00\|—\|/m);
  });
});

describe('the operator’s chosen columns', () => {
  it('drops a heading from the headings, the rows and the total together', () => {
    const full = toWorkDocument(WORK);
    const value = (document: typeof full) =>
      document.tables.find((table) => table.heading === 'Value position');
    const before = value(full);
    const billedAt = before?.columns.findIndex((column) => column.header === 'Billed');
    expect(billedAt).toBeGreaterThan(-1);

    const kept = new Set(
      (before?.columns ?? [])
        .map((column) => column.header)
        .filter((header) => header !== 'Billed'),
    );
    const after = value(selectColumns(full, 'work', kept));

    // Positional, and that is the whole risk: a heading removed without
    // its cells slides every figure one column left, which reads as
    // plausible data rather than as a fault.
    expect(after?.columns.map((column) => column.header)).not.toContain('Billed');
    expect(after?.columns).toHaveLength((before?.columns.length ?? 0) - 1);
    expect(after?.rows[0]).toHaveLength((before?.rows[0]?.length ?? 0) - 1);
    expect(after?.total).toHaveLength((before?.total?.length ?? 0) - 1);
    for (const [index, column] of (after?.columns ?? []).entries()) {
      const source = before?.columns.findIndex((one) => one.header === column.header);
      expect(after?.rows[0]?.[index]).toBe(before?.rows[0]?.[source ?? -1]);
      expect(after?.total?.[index]).toBe(before?.total?.[source ?? -1]);
    }
  });

  it('never drops an identity column, whatever the caller asks for', () => {
    // The chip vocabulary is the only thing that can be dropped, so an
    // empty set is a report of nothing but the columns that say what each
    // row IS — not a blank page.
    const stripped = selectColumns(toWorkDocument(WORK), 'work', new Set());
    const quantity = stripped.tables.find(
      (table) => table.heading === 'Quantity position',
    );
    expect(quantity?.columns.map((column) => column.header)).toEqual([
      'Item',
      'Description',
    ]);
    // The Work report's chips cover its quantity and value tables only, so
    // its payment table comes through untouched.
    const payment = stripped.tables.find(
      (table) => table.heading === 'Payment position',
    );
    expect(payment?.columns.map((column) => column.header)).toContain('Outstanding');
  });
});

describe('the works-analysis PDF', () => {
  it('escapes a description that carries markup', () => {
    const html = renderWorksAnalysisHtml(toWorkDocument(WORK));
    expect(html).toContain('Rack &lt;42U&gt; &amp; cover');
    expect(html).not.toContain('Rack <42U>');
  });

  it('is a complete self-contained page with no external request', () => {
    const html = renderWorksAnalysisHtml(toWorkDocument(WORK));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // Gotenberg renders a page that fetches nothing: no stylesheet link,
    // no script, and no remote image.
    expect(html).not.toMatch(/<link[^>]+href="http/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src="http/i);
  });

  it('draws a section with no rows as a stated empty row, not as a missing table', () => {
    const empty: MappedItemAnalysisResponse = {
      ...MAPPED,
      rows: [],
      unmappedLineCount: 0,
    };
    const html = renderWorksAnalysisHtml(toMappedItemDocument(empty));
    expect(html).toContain('Every live schedule line maps to an item master.');
    expect(html).toContain('No schedule line maps to an item master yet');
  });

  it('prints a rate spread as a range and an agreed rate as one figure', () => {
    const html = renderWorksAnalysisHtml(toDivisionDocument(DIVISION));
    expect(html).toContain('1000.000000 – 1200.000000');

    const agreed = renderWorksAnalysisHtml(
      toMappedItemDocument({
        ...MAPPED,
        rows: [{ ...MAPPED.rows[0]!, rateHigh: MAPPED.rows[0]!.rateLow }],
      }),
    );
    expect(agreed).not.toContain('–');
    expect(agreed).toContain('1000.000000');
  });

  it('names the ambiguous division rather than filing it under a code', () => {
    const html = renderWorksAnalysisHtml(
      toDivisionDocument({
        ...DIVISION,
        divisions: [
          {
            ...DIVISION.divisions[0]!,
            divisionCode: null,
            divisionSource: 'ambiguous',
          },
        ],
      }),
    );
    expect(html).toContain('No division on record');
    expect(html).toContain('name more than one');
  });
});
