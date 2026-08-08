import { describe, expect, it } from 'vitest';
import {
  CHALLAN_TEMPLATE_VERSION,
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
});
