import { describe, expect, it } from 'vitest';
import {
  ISSUE_CHALLAN_TEMPLATE_VERSION,
  renderIssueChallanHtml,
  type IssueChallanSnapshot,
} from '../src/issue-challan-html.js';

const SNAPSHOT: IssueChallanSnapshot = {
  templateVersion: ISSUE_CHALLAN_TEMPLATE_VERSION,
  organisationName: 'Sharma & Sons <Constructions>',
  challanNumber: 'PL270-CRB-IC/1',
  challanDate: '2026-08-08',
  issuedAt: '2026-08-08T10:00:00.000Z',
  movementType: 'issue',
  work: {
    workCode: 'PL270-CRB',
    title: 'Supply of "switchboards"',
    letterNumber: 'L-42/2025',
    letterDate: '2025-06-01',
  },
  issuedTo: {
    name: 'SSE/Signal <Delhi>',
    role: 'Site engineer',
    location: 'Relay room, NDLS',
  },
  remarks: 'Handle with care & return the crates',
  lines: [
    {
      position: 1,
      itemNumber: 'A/1',
      description: 'Switchboard <indoor> & fittings',
      unit: 'Nos',
      quantity: '50.000',
    },
    {
      position: 2,
      itemNumber: null,
      description: 'Cable ties (site consumables)',
      unit: 'Pkt',
      quantity: '12.000',
    },
  ],
};

describe('issue challan HTML template', () => {
  it('escapes every interpolated value', () => {
    const html = renderIssueChallanHtml(SNAPSHOT);
    expect(html).not.toContain('<indoor>');
    expect(html).toContain('&lt;indoor&gt; &amp; fittings');
    expect(html).toContain('Sharma &amp; Sons &lt;Constructions&gt;');
    expect(html).toContain('SSE/Signal &lt;Delhi&gt;');
    expect(html).toContain('Handle with care &amp; return the crates');
  });

  it('is deterministic for identical snapshots and renders manual lines without an item number', () => {
    const first = renderIssueChallanHtml(SNAPSHOT);
    const second = renderIssueChallanHtml({ ...SNAPSHOT });
    expect(first).toBe(second);
    expect(first).toContain('Issue Challan PL270-CRB-IC/1');
    expect(first).toContain('Cable ties (site consumables)');
    expect(first).toContain('<td>—</td>');
    expect(first).toContain(ISSUE_CHALLAN_TEMPLATE_VERSION);
    // A movement document carries no rates or amounts.
    expect(first).not.toContain('Rate');
    expect(first).not.toContain('Amount');
  });

  it('annotates loan and return movements but not plain issues', () => {
    const plain = renderIssueChallanHtml(SNAPSHOT);
    expect(plain).not.toContain('class="movement"');

    const loan = renderIssueChallanHtml({ ...SNAPSHOT, movementType: 'loan' });
    expect(loan).toContain('LOAN — material issued on loan and returnable');

    const returned = renderIssueChallanHtml({ ...SNAPSHOT, movementType: 'return' });
    expect(returned).toContain('RETURN — material returned to origin');
  });

  it('omits the remarks block when the snapshot has none', () => {
    const html = renderIssueChallanHtml({ ...SNAPSHOT, remarks: null });
    expect(html).not.toContain('Remarks');
  });
});
