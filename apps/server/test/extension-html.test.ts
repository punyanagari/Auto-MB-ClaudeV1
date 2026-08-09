import { describe, expect, it } from 'vitest';
import {
  EXTENSION_TEMPLATE_VERSION,
  MANUAL_TEMPLATE_VERSION,
  renderExtensionHtml,
  type ExtensionSnapshot,
} from '../src/extension-html.js';

const SNAPSHOT: ExtensionSnapshot = {
  templateVersion: EXTENSION_TEMPLATE_VERSION,
  organisationName: 'Sharma & Sons <Constructions>',
  requestNumber: 'PL270-Extension-01',
  letterDate: '2026-08-01',
  addressee: 'Sr. DEE (G) NR\nDelhi Division',
  reason: 'Site handover was delayed.\n\nMonsoon damage to the access road.',
  work: {
    workCode: 'PL270-CRB',
    title: 'Supply of "switchboards"',
    letterNumber: 'L-42/2025',
    letterDate: '2025-06-01',
  },
  originalCompletionDate: '2026-12-31',
  currentCompletionDate: '2026-12-31',
  proposedCompletionDate: '2027-03-31',
  finalisedAt: '2026-08-02T00:00:00.000Z',
};

describe('renderExtensionHtml', () => {
  it('renders the finalised letter without any DRAFT marking', () => {
    const html = renderExtensionHtml(SNAPSHOT);
    expect(html).toContain('PL270-Extension-01');
    expect(html).toContain('Finalised at');
    expect(html).not.toContain('class="watermark"');
    expect(html).not.toContain('not a numbered letter');
  });

  it('overlays the DRAFT watermark and withholds the number on previews (§5.5)', () => {
    // The preview snapshot carries no real number — finalisation alone
    // assigns one — and the page must say DRAFT twice over: the diagonal
    // watermark and the footer.
    const preview: ExtensionSnapshot = {
      ...SNAPSHOT,
      requestNumber: 'DRAFT',
      finalisedAt: '',
    };
    const html = renderExtensionHtml(preview, {}, { draftWatermark: true });
    expect(html).toContain('<div class="watermark">DRAFT</div>');
    expect(html).toContain('DRAFT — not a numbered letter');
    expect(html).not.toContain('Finalised at');
    expect(html).not.toContain('Extension-01');
  });

  it('escapes user content in both modes', () => {
    for (const html of [
      renderExtensionHtml(SNAPSHOT),
      renderExtensionHtml(SNAPSHOT, {}, { draftWatermark: true }),
    ]) {
      expect(html).toContain('Sharma &amp; Sons &lt;Constructions&gt;');
      expect(html).toContain('Supply of &quot;switchboards&quot;');
      expect(html).not.toContain('<Constructions>');
    }
  });

  it('keeps the manual template version distinct — manual records are never rendered', () => {
    // The route refuses to render manual back-fills; the version constant
    // exists purely to mark their snapshots as transcriptions.
    expect(MANUAL_TEMPLATE_VERSION).toBe('extension-manual-v1');
    expect(MANUAL_TEMPLATE_VERSION).not.toBe(EXTENSION_TEMPLATE_VERSION);
  });
});
