import { describe, expect, it } from 'vitest';
import {
  CORRECTION_NOTICE_TEMPLATE_VERSION,
  renderCorrectionNoticeHtml,
  type CorrectionNoticeSnapshot,
} from '../src/correction-notice-html.js';

const SNAPSHOT: CorrectionNoticeSnapshot = {
  templateVersion: CORRECTION_NOTICE_TEMPLATE_VERSION,
  organisationName: 'Sharma & Sons <Electricals>',
  noticeNumber: 'PL270-CRB-CN-01',
  issuedAt: '2026-08-09T10:00:00.000Z',
  work: {
    workCode: 'PL270-CRB',
    title: 'Signalling gear, CR Bhusawal',
    letterNumber: 'L-42/2025',
    letterDate: '2025-06-01',
  },
  challan: {
    challanNumber: 'PL270-CRB-DC/3',
    challanDate: '2026-08-01',
    consignee: {
      name: 'Sr. DEE (G) <CR>',
      address: 'Bhusawal Division',
      phone: '+91 98220 00000',
    },
    lines: [
      {
        position: 1,
        itemNumber: 'A/1',
        description: 'Main switchboard, floor "mounted"',
        unit: 'Nos',
        quantity: '2.000',
      },
    ],
  },
  corrections: [{ field: 'Consignee designation', corrected: 'Sr. DEE (W) & Co' }],
  statement: 'The designation on the issued copy reads (G);\nthe correct one is (W).',
  reason: 'Typo carried over from the LOA <letter>.',
};

describe('renderCorrectionNoticeHtml', () => {
  it('is deterministic for the same snapshot', () => {
    expect(renderCorrectionNoticeHtml(SNAPSHOT)).toBe(
      renderCorrectionNoticeHtml(SNAPSHOT),
    );
  });

  it('renders only from the snapshot and escapes every value', () => {
    const html = renderCorrectionNoticeHtml(SNAPSHOT);
    expect(html).toContain('Sharma &amp; Sons &lt;Electricals&gt;');
    expect(html).toContain('Sr. DEE (G) &lt;CR&gt;');
    expect(html).toContain('Main switchboard, floor &quot;mounted&quot;');
    expect(html).toContain('Sr. DEE (W) &amp; Co');
    expect(html).toContain('Typo carried over from the LOA &lt;letter&gt;.');
    expect(html).not.toContain('<Electricals>');
    expect(html).not.toContain('LOA <letter>');
  });

  it('carries the notice number, the original challan identity, and the template version', () => {
    const html = renderCorrectionNoticeHtml(SNAPSHOT);
    expect(html).toContain('Correction Notice PL270-CRB-CN-01');
    expect(html).toContain('PL270-CRB-DC/3');
    expect(html).toContain('2026-08-01');
    expect(html).toContain(`Template ${CORRECTION_NOTICE_TEMPLATE_VERSION}`);
    // The original stays in force; the notice never reads as a draft.
    expect(html).toContain('remains in force as issued');
    expect(html).not.toMatch(/draft/i);
  });

  it('splits the statement into paragraphs and inlines branding when given', () => {
    const html = renderCorrectionNoticeHtml(SNAPSHOT, {
      logoDataUri: 'data:image/png;base64,AAAA',
      address: 'Plot 4, MIDC, Nashik',
      gstin: '27ABCDE1234F1Z5',
      contactPhone: '+91 98220 00000',
      contactEmail: 'office@example.test',
    });
    expect(html).toContain('<p>The designation on the issued copy reads (G);</p>');
    expect(html).toContain('<p>the correct one is (W).</p>');
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).toContain('GSTIN 27ABCDE1234F1Z5');
  });

  it('omits the corrections table when only a statement is given', () => {
    const html = renderCorrectionNoticeHtml({
      ...SNAPSHOT,
      corrections: [],
    });
    expect(html).not.toContain('Corrected reading');
    expect(html).toContain('Correction statement');
  });
});
