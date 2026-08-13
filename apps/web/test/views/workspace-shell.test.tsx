// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type ApiClient } from '../../src/api.js';
import { OperationsDashboard } from '../../src/views/OperationsDashboard.js';
import { OperationsWorkspace } from '../../src/views/OperationsWorkspace.js';
import {
  stubApi,
  ORG_ID,
  WORK_ID,
  membership,
  BALANCE,
  challanWork,
} from './helpers.js';

describe('OperationsDashboard', () => {
  // Second-heaviest here (~340ms alone): a full workspace render plus a view
  // transition. Under the same contention that stretched the challan-guard
  // test 14x it lands around 4.7s — inside a rounding error of the 5s default,
  // so it is budgeted before it starts flaking rather than after.
  it(
    'shows totals, alerts with severity, and routes work opens',
    { timeout: 15_000 },
    async () => {
      const dashboard = vi.fn().mockResolvedValue({
        totals: {
          works: 2,
          contractValue: '5807500.00',
          deliveredValue: '1450000.00',
          billedValue: '300.00',
          openDrafts: 1,
          loaAwaitingReview: 1,
        },
        alerts: [
          {
            kind: 'instrument_expiring',
            severity: 'warning',
            message: 'PBG BG/22 for PL270-CRB expires on 2026-09-15.',
            workId: WORK_ID,
            workCode: 'PL270-CRB',
            dueInDays: 38,
          },
          {
            kind: 'loa_review_pending',
            severity: 'notice',
            message: '1 LOA letter is waiting for review and confirmation.',
            workId: null,
            workCode: null,
            dueInDays: null,
          },
        ],
        works: [
          {
            workId: WORK_ID,
            workCode: 'PL270-CRB',
            title: 'Signalling gear, CR Bhusawal',
            status: 'active',
            contractValue: '4520000.00',
            deliveredValue: '1450000.00',
            billedValue: '300.00',
            issuedChallans: 3,
          },
          {
            workId: '22222222-2222-4222-8222-222222222222',
            workCode: 'VALUE-9',
            title: 'Nine rupee comparison work',
            status: 'active',
            contractValue: '9.00',
            deliveredValue: '0.00',
            billedValue: '0.00',
            issuedChallans: 0,
          },
          {
            workId: '44444444-4444-4444-8444-444444444445',
            workCode: 'VALUE-100',
            title: 'One hundred rupee comparison work',
            status: 'active',
            contractValue: '100.00',
            deliveredValue: '0.00',
            billedValue: '0.00',
            issuedChallans: 0,
          },
        ],
      });
      const onOpenWork = vi.fn();
      const onOpenWorks = vi.fn();
      render(
        <OperationsDashboard
          api={stubApi({ dashboard })}
          organisationId={ORG_ID}
          canModify
          onOpenWork={onOpenWork}
          onOpenWorks={onOpenWorks}
          onUploadLoa={vi.fn()}
          onOpenApprovals={vi.fn()}
        />,
      );

      // Awaited on the alert itself, not the "Dashboard" heading: the
      // dashboard's loading branch renders that heading too, so waiting on
      // it resolves against the loading state and every read below then
      // races the dashboard mock (the §2.7 hazard).
      expect(
        await screen.findByText(/PBG BG\/22 for PL270-CRB expires/),
      ).toBeTruthy();
      expect(screen.getByText('38 days left')).toBeTruthy();
      expect(
        screen.getByRole('progressbar', { name: 'PL270-CRB delivery progress' }),
      ).toBeTruthy();
      // 1450000 / 4520000 = 32%
      expect(screen.getByText('32%')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Open PL270-CRB' }));
      expect(onOpenWork).toHaveBeenCalledWith(WORK_ID);

      const portfolio = screen.getByRole('table', {
        name: 'Work execution and billing progress',
      });
      expect(
        within(portfolio)
          .getAllByRole('rowheader')
          .map((header) => header.textContent),
      ).toEqual([
        expect.stringContaining('PL270-CRB'),
        expect.stringContaining('VALUE-100'),
        expect.stringContaining('VALUE-9'),
      ]);

      fireEvent.click(screen.getByRole('button', { name: 'Review LOAs' }));
      expect(onOpenWorks).toHaveBeenCalledTimes(1);
    },
  );
});

describe('OperationsWorkspace mobile shell', () => {
  const organisation = {
    id: ORG_ID,
    name: 'Sharma Constructions',
    slug: 'sharma',
  };

  function renderWorkspace(overrides: Partial<ApiClient> = {}) {
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

  it('keeps header quick actions separate from mobile Record actions', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Dashboard' });
    const headerTrigger = screen.getByRole('button', {
      name: 'Open quick actions',
    });
    const recordTrigger = screen.getByRole('button', {
      name: 'Open record actions',
    });

    fireEvent.click(recordTrigger);
    expect(screen.getByRole('group', { name: 'Record actions' })).toBeTruthy();
    expect(
      screen.getByText('Choose a Work before recording site evidence.'),
    ).toBeTruthy();
    expect(headerTrigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(headerTrigger);
    expect(screen.queryByRole('group', { name: 'Record actions' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Quick actions' })).toBeTruthy();
    expect(recordTrigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('traps focus in the mobile drawer, closes on Escape, and restores focus', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Dashboard' });
    const opener = screen.getByRole('button', { name: 'Open navigation' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Application navigation' });
    const close = screen.getByRole('button', { name: 'Close menu' });
    const signOut = within(dialog).getByRole('button', { name: 'Sign out' });
    expect(document.activeElement).toBe(close);
    expect(opener.closest('[inert]')).toBeTruthy();

    signOut.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(signOut);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Application navigation' })).toBeNull();
    expect(opener.closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('names the browser tab after the open screen and the tenant', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Dashboard' });
    // Most specific first, so the tab is still legible truncated.
    expect(document.title).toBe('Dashboard · Sharma Constructions · Auto-MB');

    const rail = screen.getByRole('navigation', { name: 'Modules' });
    fireEvent.click(within(rail).getByRole('button', { name: 'Works' }));
    await screen.findByRole('heading', { name: 'Works' });
    expect(document.title).toBe('Works · Sharma Constructions · Auto-MB');
  });

  it('offers a skip link that reaches main without disturbing the address', async () => {
    const { container } = renderWorkspace();
    await screen.findByRole('heading', { name: 'Dashboard' });
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    // The point of a skip link is that it comes before the twenty-odd rail
    // and header controls it exists to skip, so it must be the first thing
    // Tab reaches.
    expect(
      container.querySelector('a[href], button:not([disabled]), input, [tabindex="0"]'),
    ).toBe(skip);

    const before = window.location.hash;
    fireEvent.click(skip);
    expect(document.activeElement).toBe(screen.getByRole('main'));
    // The workspace's address IS the fragment: following the href would
    // replace the route with one nothing parses.
    expect(window.location.hash).toBe(before);
  });

  it('routes Record through Works when no Work is selected', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Dashboard' });
    fireEvent.click(screen.getByRole('button', { name: 'Open record actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Works' }));

    expect(await screen.findByRole('heading', { name: 'Works' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Record actions' })).toBeNull();
  });

  // The heaviest test in this package: one full workspace render, then
  // Dashboard -> Work detail -> Deliveries -> the challan editor, then three
  // navigation-guard round trips, each re-rendering the whole shell. It costs
  // ~1s alone — four times its neighbours — and a fully parallel `pnpm verify`
  // (this package's jsdom suites competing with the server's database suites
  // for one machine) stretched it to 13.8s, blowing vitest's 5s default. The
  // budget is deliberately per-test rather than a raised global timeout: every
  // other test here finishes inside 350ms and should still fail fast.
  it(
    'protects an edited challan from shell navigation',
    { timeout: 30_000 },
    async () => {
      renderWorkspace({
        dashboard: vi.fn().mockResolvedValue({
          totals: {
            works: 1,
            contractValue: '900.00',
            deliveredValue: '0.00',
            billedValue: '0.00',
            openDrafts: 0,
            loaAwaitingReview: 0,
          },
          alerts: [],
          works: [
            {
              workId: WORK_ID,
              workCode: 'DCW-1',
              title: 'Supply of switchboards',
              status: 'active',
              contractValue: '900.00',
              deliveredValue: '0.00',
              billedValue: '0.00',
              issuedChallans: 0,
            },
          ],
        }),
        getWork: vi.fn().mockResolvedValue(challanWork()),
        workBalance: vi.fn().mockResolvedValue(BALANCE),
      });

      fireEvent.click(await screen.findByRole('link', { name: 'DCW-1' }));
      const workTabs = await screen.findByRole('navigation', {
        name: 'Work sections',
      });
      fireEvent.click(
        within(workTabs).getByRole('button', {
          name: (name: string) => name.startsWith('Deliveries'),
        }),
      );
      fireEvent.click(
        await screen.findByRole('button', { name: 'New Delivery Challan' }),
      );
      await screen.findByRole('heading', { name: 'New Delivery Challan' });
      const quantity = screen.getByLabelText('Quantity of A/1 on this challan');
      fireEvent.change(quantity, { target: { value: '1' } });

      fireEvent.click(screen.getByRole('button', { name: 'Home' }));
      expect(
        screen.getByRole('dialog', { name: 'Unsaved draft changes' }),
      ).toBeTruthy();
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Keep editing' }),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(
        screen.queryByRole('dialog', { name: 'Unsaved draft changes' }),
      ).toBeNull();
      expect(
        screen.getByLabelText<HTMLInputElement>('Quantity of A/1 on this challan')
          .value,
      ).toBe('1');

      const recordTrigger = screen.getByRole('button', { name: 'Open record actions' });
      fireEvent.click(recordTrigger);
      fireEvent.click(screen.getByRole('button', { name: 'Open Works' }));
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(document.activeElement).toBe(recordTrigger);
      expect(
        screen.getByLabelText<HTMLInputElement>('Quantity of A/1 on this challan')
          .value,
      ).toBe('1');

      fireEvent.click(recordTrigger);
      fireEvent.click(screen.getByRole('button', { name: 'Open Works' }));
      fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
      expect(await screen.findByRole('heading', { name: 'Works' })).toBeTruthy();
    },
  );
});

describe('OperationsWorkspace hash routing', () => {
  const organisation = {
    id: ORG_ID,
    name: 'Sharma Constructions',
    slug: 'sharma',
  };

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

  it('restores a Work section deep link on mount — a refresh keeps the exact view', async () => {
    renderWorkspaceAt(`#/works/${WORK_ID}/bills`);

    // The Work page opens directly on its Bills section.
    await screen.findByRole('heading', { name: /DCW-1/ });
    const tabs = await screen.findByRole('navigation', { name: 'Work sections' });
    const active = within(tabs)
      .getAllByRole('button')
      .find((candidate) => candidate.getAttribute('aria-current') === 'page');
    expect(active?.textContent).toMatch(/^Bills/);
    expect(window.location.hash).toBe(`#/works/${WORK_ID}/bills`);
  });

  it('falls back to the Dashboard for an unknown fragment', async () => {
    renderWorkspaceAt('#/no-such-screen');

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(window.location.hash).toBe('#/');
  });

  it('keeps the address bar in step with in-app navigation and honours hash changes', async () => {
    renderWorkspaceAt('#/');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(window.location.hash).toBe('#/');

    // In-app navigation writes the hash…
    fireEvent.click(screen.getAllByRole('button', { name: 'Works' })[0] as HTMLElement);
    expect(await screen.findByRole('heading', { name: 'Works' })).toBeTruthy();
    expect(window.location.hash).toBe('#/works');

    // …and an external hash change (Back/Forward, a pasted link, a
    // middle-clicked row) navigates the workspace.
    window.location.hash = '#/settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  });
});
