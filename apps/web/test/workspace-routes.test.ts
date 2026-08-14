import { describe, expect, it } from 'vitest';
import {
  challanHash,
  issueChallanHash,
  mastersHash,
  parseWorkspaceHash,
  workHash,
  workspaceHashOf,
  type WorkspaceRoute,
} from '../src/lib/workspace-routes.js';

const WORK_ID = '33333333-3333-4333-8333-333333333333';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const CHALLAN_ID = '44444444-4444-4444-8444-444444444444';

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
  { view: { name: 'delivery-challans' } },
  { view: { name: 'delivery-challan', challanId: CHALLAN_ID } },
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

  it('treats the empty and root fragments as the Dashboard', () => {
    expect(parseWorkspaceHash('')).toEqual({ view: { name: 'dashboard' } });
    expect(parseWorkspaceHash('#')).toEqual({ view: { name: 'dashboard' } });
    expect(parseWorkspaceHash('#/')).toEqual({ view: { name: 'dashboard' } });
  });

  it('rejects unknown, malformed and stale fragments instead of guessing', () => {
    expect(parseWorkspaceHash('#payment-matrix')).toBeNull();
    expect(parseWorkspaceHash('#/nonsense')).toBeNull();
    expect(parseWorkspaceHash('#/works/not-a-uuid')).toBeNull();
    expect(parseWorkspaceHash(`#/works/${WORK_ID}/unknown-tab`)).toBeNull();
    expect(
      parseWorkspaceHash(`#/works/${WORK_ID}/challans/${CHALLAN_ID}/x`),
    ).toBeNull();
    expect(parseWorkspaceHash('#/masters/not-a-tab')).toBeNull();
    expect(parseWorkspaceHash('#/loa/not-a-uuid')).toBeNull();
    expect(parseWorkspaceHash('#/settings/extra')).toBeNull();
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
    expect(mastersHash()).toBe('#/masters');
    expect(mastersHash('contacts')).toBe('#/masters');
    expect(mastersHash('units')).toBe('#/masters/units');
  });
});
