import { describe, expect, it } from 'vitest';
import {
  CHALLAN_TEMPLATE_VERSION,
  WARRANTY_TEMPLATE_VERSION,
  escapeHtml,
  renderChallanHtml,
  type ChallanSnapshot,
} from '../src/challan-html.js';

const SNAPSHOT: ChallanSnapshot = {
  templateVersion: CHALLAN_TEMPLATE_VERSION,
  organisationName: 'Sharma & Sons <Constructions>',
  challanNumber: 'DC/1',
  challanDate: '2026-08-08',
  issuedAt: '2026-08-08T10:00:00.000Z',
  work: {
    workCode: 'PL270-CRB',
    title: 'Supply of "switchboards"',
    letterNumber: 'L-42/2025',
    letterDate: '2025-06-01',
  },
  consignee: {
    name: 'Sr. DEE (G)',
    address: 'Delhi Division <HQ>',
    phone: '011-1234',
  },
  items: [
    {
      position: 1,
      itemNumber: 'A/1',
      description: 'Switchboard <indoor> & fittings',
      unit: 'Nos',
      quantity: '3.000',
      rate: '100.00',
      lineAmount: '300.00',
    },
  ],
  totalAmount: '300.00',
};

describe('challan HTML template', () => {
  it('escapes every interpolated value', () => {
    const html = renderChallanHtml(SNAPSHOT);
    expect(html).not.toContain('<indoor>');
    expect(html).toContain('&lt;indoor&gt; &amp; fittings');
    expect(html).toContain('Sharma &amp; Sons &lt;Constructions&gt;');
    expect(html).toContain('&quot;switchboards&quot;');
  });

  it('is deterministic for identical snapshots and carries the totals row', () => {
    const first = renderChallanHtml(SNAPSHOT);
    const second = renderChallanHtml({ ...SNAPSHOT });
    expect(first).toBe(second);
    expect(first).toContain('Delivery Challan DC/1');
    expect(first).toContain('>300.00<');
    expect(first).toContain(CHALLAN_TEMPLATE_VERSION);
  });

  it('escapeHtml covers the five significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  describe('warranty certificate page (Milestone 7)', () => {
    const WARRANTY_SNAPSHOT: ChallanSnapshot = {
      ...SNAPSHOT,
      warranty: {
        templateVersion: WARRANTY_TEMPLATE_VERSION,
        textSha256: 'ab'.repeat(32),
        text: 'Clause 1 <terms> & conditions.\nClause 2: 24-month "guarantee".',
      },
    };

    it('renders page 2 only when the snapshot carries a warranty block', () => {
      const withWarranty = renderChallanHtml(WARRANTY_SNAPSHOT);
      expect(withWarranty).toContain('class="warranty-page"');
      expect(withWarranty).toContain('Warranty / Guarantee Certificate');
      // The page break lives in the stylesheet keyed to the page class.
      expect(withWarranty).toContain('page-break-before: always');

      const withoutWarranty = renderChallanHtml(SNAPSHOT);
      expect(withoutWarranty).not.toContain('class="warranty-page"');
      expect(withoutWarranty).not.toContain('Warranty / Guarantee Certificate');
    });

    it('escapes the template text and preserves its line breaks', () => {
      const html = renderChallanHtml(WARRANTY_SNAPSHOT);
      expect(html).not.toContain('<terms>');
      expect(html).toContain(
        'Clause 1 &lt;terms&gt; &amp; conditions.\nClause 2: 24-month &quot;guarantee&quot;.',
      );
      // pre-wrap makes the raw newline render as a real line break.
      expect(html).toContain('white-space: pre-wrap');
    });

    it('shows both template versions in the version trail, deterministically', () => {
      const first = renderChallanHtml(WARRANTY_SNAPSHOT);
      const second = renderChallanHtml({ ...WARRANTY_SNAPSHOT });
      expect(first).toBe(second);
      expect(first).toContain(
        `Template ${CHALLAN_TEMPLATE_VERSION} · Warranty template ${WARRANTY_TEMPLATE_VERSION} · Issued at`,
      );
      expect(first).toContain(`SHA-256 ${'ab'.repeat(32)}`);

      const withoutWarranty = renderChallanHtml(SNAPSHOT);
      expect(withoutWarranty).toContain(
        `Template ${CHALLAN_TEMPLATE_VERSION} · Issued at`,
      );
      expect(withoutWarranty).not.toContain('Warranty template');
    });
  });
});

describe('a standalone Delivery Challan prints without a Work (migration 0056)', () => {
  const STANDALONE: ChallanSnapshot = {
    templateVersion: CHALLAN_TEMPLATE_VERSION,
    organisationName: 'Sharma & Sons',
    challanNumber: 'DC/2026-27/001',
    challanDate: '2026-08-09',
    issuedAt: '2026-08-09T10:00:00.000Z',
    consignee: { name: 'Modern Rail Systems', address: 'Plot 4, Nashik' },
    items: [
      {
        position: 1,
        // A manual line names no schedule item; the column prints an em
        // dash rather than a blank cell the reader has to interpret.
        itemNumber: '',
        description: 'Relay casing',
        unit: 'Nos',
        quantity: '10.000',
        rate: '125.00',
        lineAmount: '1250.00',
      },
    ],
    totalAmount: '1250.00',
  };

  it('prints the movement block instead of claiming a contract', () => {
    const html = renderChallanHtml(STANDALONE);
    expect(html).toContain('Delivery Challan DC/2026-27/001');
    expect(html).toContain('Standalone delivery \u2014 no works contract');
    expect(html).not.toContain('<p class="label">Work</p>');
    expect(html).not.toContain('LOA ');
    expect(html).toContain('&mdash;');
    expect(html).toContain('>1250.00<');
  });

  it('leaves the warranty certificate reference line Work-free', () => {
    const html = renderChallanHtml({
      ...STANDALONE,
      warranty: {
        templateVersion: WARRANTY_TEMPLATE_VERSION,
        textSha256: 'a'.repeat(64),
        text: 'Twelve months from despatch.',
      },
    });
    expect(html).toContain('Against Delivery Challan DC/2026-27/001</p>');
    expect(html).toContain('class="warranty-page"');
  });

  it('renders a work challan exactly as it did before', () => {
    // The template gained an optional branch, not a new shape: every
    // challan issued before 0056 carries a Work and a non-empty item
    // number, so its rendering is untouched.
    const html = renderChallanHtml(SNAPSHOT);
    expect(html).toContain('<p class="label">Work</p>');
    expect(html).toContain('LOA L-42/2025 dated 2025-06-01');
    expect(html).not.toContain('&mdash;');
  });
});
