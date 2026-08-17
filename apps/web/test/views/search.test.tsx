// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SearchResponse } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../../src/api.js';
import { OperationsWorkspace } from '../../src/views/OperationsWorkspace.js';
import { stubApi, ORG_ID, WORK_ID, membership, challanWork } from './helpers.js';

/**
 * The header control has always been labelled "Search Works and records"
 * and always navigated to the Works register, and the `/` hint beside it
 * was rendered with no key handler anywhere in the client. These tests
 * hold both promises.
 */

const organisation = { id: ORG_ID, name: 'Sharma Constructions', slug: 'sharma' };

const CHALLAN_ID = '11111111-2222-4333-8444-555555555555';

function searchResponse(): SearchResponse {
  return {
    query: 'PL270',
    returned: 2,
    groups: [
      {
        kind: 'work',
        truncated: false,
        results: [
          {
            kind: 'work',
            id: WORK_ID,
            label: 'PL270-CRB',
            detail: 'Signalling gear, CR Bhusawal',
            status: 'active',
            date: null,
            workId: WORK_ID,
            workCode: 'PL270-CRB',
          },
        ],
      },
      {
        kind: 'delivery-challan',
        truncated: true,
        results: [
          {
            kind: 'delivery-challan',
            id: CHALLAN_ID,
            label: 'PL270/DC/004',
            detail: 'Sr. DEE (G) NR',
            status: 'issued',
            date: '2026-08-08',
            workId: WORK_ID,
            workCode: 'PL270-CRB',
          },
        ],
      },
    ],
  };
}

function renderWorkspaceAt(hash: string, overrides: Partial<ApiClient> = {}) {
  window.history.replaceState(null, '', hash);
  const api = stubApi({
    dashboard: vi.fn().mockResolvedValue({
      totals: {
        works: 0,
        contractValue: '0.00',
        deliveredValue: '0.00',
        billedValue: '0.00',
        openDrafts: 0,
        loaAwaitingReview: 0,
      },
      alerts: [],
      works: [],
    }),
    getWork: vi.fn().mockResolvedValue(challanWork()),
    ...overrides,
  });
  const result = render(
    <OperationsWorkspace
      api={api}
      me={{
        user: { id: 'user-a', email: 'owner@example.test' },
        memberships: [membership({})],
        twoFactorEnabled: true,
        mfaRequired: true,
        mfaEnforced: false,
      }}
      organisation={organisation}
      organisations={[organisation]}
      onSwitchOrganisation={vi.fn()}
      onOrganisationCreated={vi.fn()}
      onSignOut={vi.fn()}
    />,
  );
  return { api, ...result };
}

describe('the global / shortcut', () => {
  it('focuses the header search box from anywhere in the workspace', async () => {
    renderWorkspaceAt('#/');
    await screen.findByRole('heading', { name: 'Dashboard' });
    const input = screen.getByRole('searchbox', { name: 'Search Works and records' });
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(window, { key: '/' });

    expect(document.activeElement).toBe(input);
  });

  it('does not steal the key from someone typing', async () => {
    renderWorkspaceAt('#/');
    await screen.findByRole('heading', { name: 'Dashboard' });
    const input = screen.getByRole('searchbox', { name: 'Search Works and records' });

    // A slash typed into a text field belongs to the field — a date, a
    // work code, a note. The guard is by element, so it covers every form
    // in the product without this handler knowing about any of them.
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    fireEvent.keyDown(textarea, { key: '/', bubbles: true });
    expect(document.activeElement).toBe(textarea);
    expect(document.activeElement).not.toBe(input);

    // And a contenteditable region, which is not a form control at all.
    // The event is fired on a child, because that is where the caret
    // usually sits — the guard has to walk up to the editable ancestor.
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editable.appendChild(child);
    document.body.appendChild(editable);
    fireEvent.keyDown(child, { key: '/', bubbles: true });
    expect(document.activeElement).not.toBe(input);

    textarea.remove();
    editable.remove();
  });

  it('leaves modifier chords to the browser', async () => {
    renderWorkspaceAt('#/');
    await screen.findByRole('heading', { name: 'Dashboard' });
    const input = screen.getByRole('searchbox', { name: 'Search Works and records' });

    fireEvent.keyDown(window, { key: '/', ctrlKey: true });
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: '/', metaKey: true });
    expect(document.activeElement).not.toBe(input);
  });
});

describe('record search', () => {
  it('searches records from the header, not the Works register', async () => {
    const search = vi.fn().mockResolvedValue(searchResponse());
    renderWorkspaceAt('#/', { search });
    await screen.findByRole('heading', { name: 'Dashboard' });

    const input = screen.getByRole('searchbox', { name: 'Search Works and records' });
    fireEvent.change(input, { target: { value: 'PL270' } });
    fireEvent.submit(input);

    // The old control went to the Works register. This one asks the
    // server for records and shows them.
    //
    // Awaited on a RESULT, not on the heading: the Search view renders its
    // <h1> while the query is still in flight, so
    // `findByRole('heading', { name: 'Search' })` resolves against the
    // loading state and the assertion below then races the mock. That is
    // the class §2.7 of the improvement programme recorded after P9, and
    // it caught this file too — passing locally every time, and failing in
    // CI once another test file changed the scheduling.
    expect(await screen.findByRole('region', { name: 'Works' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Global search' })).toBeTruthy();
    expect(search).toHaveBeenCalledWith(ORG_ID, 'PL270');
    // The query is part of the route, so the result set is linkable and
    // Back returns to it.
    expect(window.location.hash).toBe('#/search/PL270');
  });

  it('groups results by register and links each row into its record', async () => {
    renderWorkspaceAt('#/search/PL270', {
      search: vi.fn().mockResolvedValue(searchResponse()),
    });

    const works = await screen.findByRole('region', { name: 'Works' });
    const workLink = within(works).getByRole('link', { name: 'PL270-CRB' });
    expect(workLink.getAttribute('href')).toBe(`#/works/${WORK_ID}`);

    const challans = screen.getByRole('region', { name: 'Delivery Challans' });
    const challanLink = within(challans).getByRole('link', { name: 'PL270/DC/004' });
    // Real hrefs from workspace-routes, so a middle click opens the
    // record in its own tab exactly as the link promises.
    expect(challanLink.getAttribute('href')).toBe(
      `#/works/${WORK_ID}/challans/${CHALLAN_ID}`,
    );
    // A capped register says so rather than implying it showed everything.
    expect(within(challans).getByText(/refine the search/)).toBeTruthy();

    // A plain left click stays in-app rather than reloading the shell.
    fireEvent.click(workLink);
    expect(window.location.hash).toBe(`#/works/${WORK_ID}`);
  });

  /* The serials merge (docs/UX.md § `#/serials` merges into Global
     Search). Two halves, and the second is the one that matters: the
     entry point moved, the answer did not. */
  it('lands the retired #/serials fragment on Global search', async () => {
    renderWorkspaceAt('#/serials', {
      search: vi.fn().mockResolvedValue(searchResponse()),
    });

    // Anchored on the scope control rather than on the heading: Search
    // renders its <h1> while a query is in flight, so awaiting the
    // heading resolves against the loading state (§2.7, and the
    // loading-anchor census holds this file to it).
    expect(await screen.findByLabelText('Search inside')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Global search' })).toBeTruthy();
    // No module of its own is left to reach.
    expect(screen.queryByRole('heading', { name: 'Serial Lookup' })).toBeNull();
  });

  it('opens a serial’s whole traceability chain from the results', async () => {
    const searchSerials = vi.fn().mockResolvedValue({
      truncated: false,
      matches: [
        {
          id: '99999999-9999-4999-8999-999999999999',
          serialNumber: 'SB-2026-014',
          workId: WORK_ID,
          workCode: 'PL270-CRB',
          workTitle: 'Signalling gear, CR Bhusawal',
          itemDescription: 'Main switchboard',
          challanId: CHALLAN_ID,
          challanNumber: 'PL270/DC/004',
          challanDate: '2026-08-08',
          challanStatus: 'issued' as const,
          receiptRecorded: true,
          installedOn: '2026-08-12',
          installationLocation: 'Borivali',
        },
      ],
    });
    renderWorkspaceAt('#/search/SB-2026-014', {
      search: vi
        .fn()
        .mockResolvedValue({ query: 'SB-2026-014', returned: 0, groups: [] }),
      searchSerials,
    });

    const chain = await screen.findByRole('region', {
      name: /Serial numbers matching the search/,
    });
    expect(searchSerials).toHaveBeenCalledWith(ORG_ID, 'SB-2026-014');
    // Every link of the chain the standalone lookup carried: the Work,
    // the Delivery Challan and its state, receipt, and where and when
    // the unit went in.
    expect(within(chain).getByText('SB-2026-014')).toBeTruthy();
    expect(
      within(chain).getByRole('link', { name: 'PL270-CRB' }).getAttribute('href'),
    ).toBe(`#/works/${WORK_ID}`);
    expect(
      within(chain).getByRole('link', { name: 'PL270/DC/004' }).getAttribute('href'),
    ).toBe(`#/works/${WORK_ID}/challans/${CHALLAN_ID}`);
    expect(within(chain).getByText('received')).toBeTruthy();
    expect(within(chain).getByText(/installed 2026-08-12 at Borivali/)).toBeTruthy();
  });

  it('shows an error and a retry when the search fails, never an empty result', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(
        new RequestFailedError(
          503,
          'SEARCH_UNAVAILABLE',
          'The search service is down.',
        ),
      )
      .mockResolvedValue(searchResponse());
    renderWorkspaceAt('#/search/PL270', { search });

    // Finding 27's rule: a failed read and an empty register are
    // different facts, and "nothing matched" would be a lie here.
    expect(await screen.findByText('The search service is down.')).toBeTruthy();
    expect(screen.queryByText(/Nothing in the registers matches/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Works' })).toBeTruthy();
  });

  it('says plainly when nothing matched', async () => {
    renderWorkspaceAt('#/search/ZZZZ', {
      search: vi.fn().mockResolvedValue({ query: 'ZZZZ', groups: [], returned: 0 }),
    });
    expect(
      await screen.findByText(/Nothing in the registers matches “ZZZZ”/),
    ).toBeTruthy();
  });
});
