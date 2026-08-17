import { describe, expect, it } from 'vitest';
import {
  challanHash,
  challansHash,
  issueChallanHash,
  mastersHash,
  parseWorkspaceHash,
  workHash,
  workspaceHashOf,
  WORK_TAB_NAMES,
  type WorkspaceRoute,
} from '../src/lib/workspace-routes.js';
import { WORK_TABS } from '../src/views/WorkDetail.js';

const WORK_ID = '33333333-3333-4333-8333-333333333333';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const CHALLAN_ID = '44444444-4444-4444-8444-444444444444';
const INVOICE_ID = '55555555-5555-4555-8555-555555555555';

/** One route per WorkspaceView kind — the union's exhaustiveness proof
 * for the serializer. A new view name that is not added here fails the
 * round-trip below the moment it exists. */
const EVERY_VIEW_KIND: readonly WorkspaceRoute[] = [
  { view: { name: 'dashboard' } },
  { view: { name: 'works' } },
  { view: { name: 'upload' } },
  { view: { name: 'review', documentId: DOC_ID } },
  { view: { name: 'work', workId: WORK_ID } },
  { view: { name: 'work', workId: WORK_ID }, workTab: 'bills' },
  { view: { name: 'work', workId: WORK_ID }, workTab: 'installations' },
  { view: { name: 'challan-new', workId: WORK_ID, workCode: '' } },
  {
    view: {
      name: 'challan-edit',
      workId: WORK_ID,
      workCode: '',
      challanId: CHALLAN_ID,
    },
  },
  { view: { name: 'challan', workId: WORK_ID, workCode: '', challanId: CHALLAN_ID } },
  { view: { name: 'masters' } },
  { view: { name: 'masters' }, mastersTab: 'gst-rates' },
  { view: { name: 'issue-challan-new', workId: WORK_ID } },
  { view: { name: 'issue-challan-edit', workId: WORK_ID, challanId: CHALLAN_ID } },
  { view: { name: 'issue-challan', workId: WORK_ID, challanId: CHALLAN_ID } },
  { view: { name: 'challans', tab: 'delivery', workId: null } },
  { view: { name: 'challans', tab: 'installation', workId: null } },
  { view: { name: 'challans', tab: 'delivery', workId: WORK_ID } },
  { view: { name: 'challans', tab: 'installation', workId: WORK_ID } },
  { view: { name: 'delivery-challan', challanId: CHALLAN_ID } },
  { view: { name: 'invoices' } },
  { view: { name: 'invoice', invoiceId: INVOICE_ID } },
  { view: { name: 'quotations' } },
  { view: { name: 'approvals' } },
  { view: { name: 'serials' } },
  { view: { name: 'installations' } },
  { view: { name: 'members' } },
  { view: { name: 'settings' } },
];

describe('workspace hash routes', () => {
  it('round-trips every view kind through its hash', () => {
    for (const route of EVERY_VIEW_KIND) {
      const hash = workspaceHashOf(route);
      const parsed = parseWorkspaceHash(hash);
      expect(parsed, hash).not.toBeNull();
      if (parsed === null) continue;
      expect(parsed.view, hash).toEqual(route.view);
      expect(parsed.workTab ?? 'overview', hash).toBe(route.workTab ?? 'overview');
      expect(parsed.mastersTab ?? 'contacts', hash).toBe(
        route.mastersTab ?? 'contacts',
      );
      // The canonical form is a fixed point: serializing the parse gives
      // the same hash back.
      expect(workspaceHashOf(parsed)).toBe(hash);
    }
  });

  /* The parser deliberately does not import the Work page — a route
     module that pulled in a view would drag the whole workspace into the
     bundle that decides where to go. So the tab vocabulary is written
     twice, and this is what stops the two copies drifting: a tab added to
     the page and not to the parser is simply unreachable by URL, which
     nothing else in the suite would notice. */
  it('parses exactly the tabs the Work page renders', () => {
    expect([...WORK_TAB_NAMES].sort()).toEqual([...WORK_TABS].sort());
  });

  it('treats the empty and root fragments as the Dashboard', () => {
    expect(parseWorkspaceHash('')).toEqual({ view: { name: 'dashboard' } });
    expect(parseWorkspaceHash('#')).toEqual({ view: { name: 'dashboard' } });
    expect(parseWorkspaceHash('#/')).toEqual({ view: { name: 'dashboard' } });
  });

  it('rejects unknown, malformed and stale fragments instead of guessing', () => {
    expect(parseWorkspaceHash('#payment-matrix')).toBeNull();
    expect(parseWorkspaceHash('#/nonsense')).toBeNull();
    expect(parseWorkspaceHash('#/works/not-a-uuid')).toBeNull();
    // …but a Work fragment with a section this build does not know keeps
    // the Work and degrades to its Overview. The id is the durable half of
    // the address; a renamed section is no reason to lose it.
    expect(parseWorkspaceHash(`#/works/${WORK_ID}/unknown-tab`)).toEqual({
      view: { name: 'work', workId: WORK_ID },
    });
    expect(
      parseWorkspaceHash(`#/works/${WORK_ID}/challans/${CHALLAN_ID}/x`),
    ).toBeNull();
    expect(parseWorkspaceHash('#/masters/not-a-tab')).toBeNull();
    expect(parseWorkspaceHash('#/loa/not-a-uuid')).toBeNull();
    expect(parseWorkspaceHash('#/settings/extra')).toBeNull();
  });

  /* The two registers that merged into the Challans module kept their
     old addresses, because links to them are already out there — in
     bookmarks, in a colleague's message, in this repository's own
     history. They land on the tab they name rather than on the
     Dashboard, and the workspace normalises the fragment afterwards,
     which is the mock's redirect (`app/delivery-challans/page.tsx`,
     `app/issue-challans/page.tsx` at a8e1fde) in a hash router. */
  it('redirects the retired register addresses into the merged module', () => {
    expect(parseWorkspaceHash('#/delivery-challans')).toEqual({
      view: { name: 'challans', tab: 'delivery', workId: null },
    });
    expect(parseWorkspaceHash('#/issue-challans')).toEqual({
      view: { name: 'challans', tab: 'installation', workId: null },
    });
    // Only the REGISTER moved. A link to a record still opens it.
    expect(parseWorkspaceHash(`#/delivery-challans/${CHALLAN_ID}`)).toEqual({
      view: { name: 'delivery-challan', challanId: CHALLAN_ID },
    });
  });

  it('refuses a challan register tab or Work it does not know', () => {
    expect(parseWorkspaceHash('#/challans/nonsense')).toBeNull();
    expect(parseWorkspaceHash('#/challans/delivery/not-a-uuid')).toBeNull();
    expect(parseWorkspaceHash(`#/challans/delivery/${WORK_ID}/extra`)).toBeNull();
    expect(parseWorkspaceHash('#/issue-challans/extra')).toBeNull();
  });

  it('builds the link helpers views render as hrefs', () => {
    expect(workHash(WORK_ID)).toBe(`#/works/${WORK_ID}`);
    expect(workHash(WORK_ID, 'schedules')).toBe(`#/works/${WORK_ID}/schedules`);
    // The register's row link: a record opens on its Work's own tab.
    expect(workHash(WORK_ID, 'installations')).toBe(`#/works/${WORK_ID}/installations`);
    expect(challanHash(WORK_ID, CHALLAN_ID)).toBe(
      `#/works/${WORK_ID}/challans/${CHALLAN_ID}`,
    );
    expect(issueChallanHash(WORK_ID, CHALLAN_ID)).toBe(
      `#/works/${WORK_ID}/issue-challans/${CHALLAN_ID}`,
    );
    // The tab rail and the Work chip's clear control.
    expect(challansHash('delivery')).toBe('#/challans');
    expect(challansHash('installation')).toBe('#/challans/installation');
    expect(challansHash('delivery', WORK_ID)).toBe(`#/challans/delivery/${WORK_ID}`);
    expect(mastersHash()).toBe('#/masters');
    expect(mastersHash('contacts')).toBe('#/masters');
    expect(mastersHash('units')).toBe('#/masters/units');
  });
});
