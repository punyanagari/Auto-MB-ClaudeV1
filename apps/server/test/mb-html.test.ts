import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MB_TEMPLATE_VERSION,
  renderMeasurementBookHtml,
  type MeasurementBookSnapshot,
} from '../src/mb-html.js';
import { MB_REMARK_TEMPLATE_VERSION } from '../src/mb-remark.js';

interface WorkbookFixture {
  readonly case: {
    readonly measurementBooks: ReadonlyArray<{
      readonly mb: number;
      readonly expectedRemark: string;
    }>;
  };
}
const workbook = JSON.parse(
  readFileSync(
    new URL('./fixtures/mb-remark-workbook.v1.json', import.meta.url),
    'utf8',
  ),
) as WorkbookFixture;
const workbookRemark = workbook.case.measurementBooks[2]?.expectedRemark ?? '';

const SNAPSHOT: MeasurementBookSnapshot = {
  templateVersion: MB_TEMPLATE_VERSION,
  organisationName: 'Sharma & Sons <Constructions>',
  status: 'finalized',
  mbNumber: 'PL270-CRB-MB-03',
  mbDate: '2026-08-08',
  isFinal: false,
  // The physical rendering is the one this fixture was written against;
  // the coefficient sheet gets its own case below.
  way: 'physical',
  work: {
    workCode: 'PL270-CRB',
    title: 'Supply of "switchboards"',
    letterNumber: 'L-42/2025',
    letterDate: '2025-06-01',
  },
  lines: [
    {
      itemNumber: 'A/1',
      description: 'Power cable <armoured> & lugs',
      unitCode: 'mtr',
      deltaSupplied: '1000.000',
      deltaInstalled: '2000.000',
      deltaPac: '0.000',
      lineTotal: '1000.00',
      remark: workbookRemark,
    },
  ],
  totalAmount: '1000.00',
  remarkTemplateVersion: MB_REMARK_TEMPLATE_VERSION,
};

describe('measurement book HTML template (mb-v2)', () => {
  it('is deterministic and carries the template version trail', () => {
    const first = renderMeasurementBookHtml(SNAPSHOT);
    const second = renderMeasurementBookHtml({ ...SNAPSHOT });
    expect(first).toBe(second);
    expect(first).toContain('Measurement Book PL270-CRB-MB-03');
    expect(first).toContain(
      `Template ${MB_TEMPLATE_VERSION} · Remarks ${MB_REMARK_TEMPLATE_VERSION}`,
    );
  });

  it('escapes every interpolated value', () => {
    const html = renderMeasurementBookHtml(SNAPSHOT);
    expect(html).not.toContain('<armoured>');
    expect(html).toContain('&lt;armoured&gt; &amp; lugs');
    expect(html).toContain('Sharma &amp; Sons &lt;Constructions&gt;');
    expect(html).toContain('&quot;switchboards&quot;');
  });

  it('renders the workbook remark verbatim in the remark column', () => {
    expect(workbookRemark).toContain('Prepaid');
    const html = renderMeasurementBookHtml(SNAPSHOT);
    expect(html).toContain(`<td class="remark">${workbookRemark}</td>`);
  });

  it('renders quantities without trailing zeros and amounts at 2dp', () => {
    const html = renderMeasurementBookHtml(SNAPSHOT);
    expect(html).toContain('>1000<'); // deltaSupplied 1000.000 -> 1000
    expect(html).toContain('>2000<');
    expect(html).toContain('>0<'); // deltaPac 0.000 -> 0
    expect(html).toContain('>1000.00<'); // lineTotal keeps 2dp
    expect(html).toContain('Total payable this MB');
  });

  it('renders the total in Indian-system words', () => {
    const html = renderMeasurementBookHtml(SNAPSHOT);
    expect(html).toContain('Amount in words');
    expect(html).toContain('Rupees One Thousand Only');
  });

  it('watermarks DRAFT only while the MB is draft, titling it DRAFT', () => {
    const draft = renderMeasurementBookHtml({
      ...SNAPSHOT,
      status: 'draft',
      mbNumber: null,
    });
    expect(draft).toContain('class="watermark"');
    expect(draft).toContain('Measurement Book DRAFT');

    const finalized = renderMeasurementBookHtml(SNAPSHOT);
    expect(finalized).not.toContain('class="watermark"');

    const cancelled = renderMeasurementBookHtml({ ...SNAPSHOT, status: 'cancelled' });
    expect(cancelled).not.toContain('class="watermark"');
  });

  it('shows the FINAL BILL banner only on the final MB', () => {
    const finalMb = renderMeasurementBookHtml({ ...SNAPSHOT, isFinal: true });
    expect(finalMb).toContain('class="final-banner"');
    expect(finalMb).toContain('FINAL BILL');

    const ordinary = renderMeasurementBookHtml(SNAPSHOT);
    expect(ordinary).not.toContain('FINAL BILL');
  });

  it('applies branding as presentation without touching the legal content', () => {
    const branded = renderMeasurementBookHtml(SNAPSHOT, {
      logoDataUri: 'data:image/png;base64,AAAA',
      address: 'Plot 4 <MIDC>',
      gstin: '27ABCDE1234F1Z5',
      contactPhone: '+91 98220 00000',
      contactEmail: 'office@sharma.example',
    });
    expect(branded).toContain('data:image/png;base64,AAAA');
    expect(branded).toContain('Plot 4 &lt;MIDC&gt;');
    expect(branded).toContain('GSTIN 27ABCDE1234F1Z5');
    expect(branded).toContain(`<td class="remark">${workbookRemark}</td>`);
  });

  /**
   * The coefficient sheet (migration 0113). The caller has already applied
   * the scaling — see `toSnapshot` for why the template cannot — so what
   * is asserted here is the part the template owns: the PAYABLE column,
   * and that the money is untouched by the way.
   */
  it('prints a payable column reading 100% on a coefficient sheet, and none on a physical one', () => {
    const coefficient = renderMeasurementBookHtml({
      ...SNAPSHOT,
      way: 'coefficient',
      lines: [
        {
          ...(SNAPSHOT.lines[0] ?? {
            itemNumber: 'A/1',
            description: '',
            unitCode: 'mtr',
            deltaSupplied: '0',
            deltaInstalled: '0',
            deltaPac: '0',
            lineTotal: '0.00',
            remark: '',
          }),
          // 1000 mtr at 80%, already scaled by the caller.
          deltaSupplied: '800.000',
        },
      ],
    });
    expect(coefficient).toContain('<th>Payable</th>');
    expect(coefficient).toContain('<td class="num">100%</td>');
    expect(coefficient).toContain('<td class="num">800</td>');
    // The total spans one more column now that the row is one column
    // wider, and the amount beside it has not moved.
    expect(coefficient).toContain('<td colspan="7">Total payable this MB</td>');
    expect(coefficient).toContain('<td class="num">1000.00</td>');

    const physical = renderMeasurementBookHtml(SNAPSHOT);
    expect(physical).not.toContain('<th>Payable</th>');
    // Not a bare '100%' search: the stylesheet and the remark grammar both
    // legitimately carry that string.
    expect(physical).not.toContain('<td class="num">100%</td>');
    expect(physical).toContain('<td colspan="6">Total payable this MB</td>');
    expect(physical).toContain('<td class="num">1000.00</td>');
  });
});
