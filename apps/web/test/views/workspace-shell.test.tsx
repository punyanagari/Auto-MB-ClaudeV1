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
            settlement: null,
          },
          {
            kind: 'loa_review_pending',
            severity: 'notice',
            message: '1 LOA letter is waiting for review and confirmation.',
            workId: null,
            workCode: null,
            dueInDays: null,
            settlement: null,
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
      expect(await screen.findByText(/PBG BG\/22 for PL270-CRB expires/)).toBeTruthy();
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

  function renderWorkspace(
    overrides: Partial<ApiClient> = {},
    membershipOverrides: Parameters<typeof membership>[0] = {},
  ) {
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
          memberships: [membership(membershipOverrides)],
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

  /* The bottom bar's cells are named by the label under their icon, so the
     query is scoped to the bar: "Record" and "More" are ordinary words that
     a register or a menu is free to use too. */
  const barCell = (name: string) =>
    within(screen.getByRole('navigation', { name: 'Mobile navigation' })).getByRole(
      'button',
      { name },
    );
  /** The Record cell's sheet, which is a dialog named by its own heading. */
  const recordSheet = () =>
    screen.queryByRole('dialog', { name: 'Record field activity' });

  /* The topbar's "Quick action" menu is gone (owner decision, 2026-08-18):
     Upload LOA lives in the sidebar footer and its other two destinations
     were rail entries, so the menu was a third way to reach places already
     one click away. Pinned as an absence so it does not drift back. */
  it('offers mobile Record actions with no competing header menu', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.queryByRole('button', { name: 'Open quick actions' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Quick actions' })).toBeNull();

    fireEvent.click(barCell('Record'));
    expect(recordSheet()).toBeTruthy();
    expect(
      screen.getByText('Choose a Work before recording site evidence.'),
    ).toBeTruthy();
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
    fireEvent.click(within(rail).getByRole('link', { name: 'Works' }));
    await screen.findByRole('heading', { name: 'Works' });
    expect(document.title).toBe('Works · Sharma Constructions · Auto-MB');
  });

  it('groups the rail the way the mock does', async () => {
    renderWorkspace();
    const rail = await screen.findByRole('navigation', { name: 'Modules' });
    // The mock's four groups, with the first one unlabelled. Every entry the
    // mock draws that this build has no route for is omitted rather than
    // rendered dead, and Quotations — which the mock draws and this build
    // has — keeps its place.
    expect(
      within(rail)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Dashboard',
      'Works',
      'Tenders',
      'Payments',
      // Appended to the mock's own main list, where its `app-sidebar`
      // at fdfd610 puts it.
      'Receivables',
      'Challans',
      'Invoices',
      'Quotations',
      // The mock HAS this screen (`app/tenders/company-documents`) but
      // reaches it only from a toolbar button on its Tenders dashboard;
      // it carries a rail entry of its own here, under Documents where
      // the mock groups document registers.
      'Company documents',
      // Production takes the first place the mock's Operations group
      // gives it (migration 0084); Inventory, Purchase orders and
      // Maintenance are still omitted rather than drawn as dead entries.
      'Production',
      'Installations',
      // The mock's own rail carries Inspection in its main list
      // (`components/app-sidebar.tsx` at fdfe5ef); it sits under
      // Operations here, beside the other shop-floor registers.
      'Inspection',
      'Global search',
      'Approvals',
      'Masters',
      'Members',
      'Settings',
    ]);
    // Serial Lookup is not a module: `#/serials` merged into Global search
    // and the chain is one scope inside it (docs/UX.md).
    expect(within(rail).queryByRole('link', { name: 'Serial Lookup' })).toBeNull();
    for (const heading of ['Documents', 'Operations', 'Administration']) {
      expect(within(rail).getByText(heading)).toBeTruthy();
    }
    // Bills is a Work section, not a module (docs/UX.md).
    expect(within(rail).queryByRole('link', { name: 'Bills' })).toBeNull();
  });

  it('gives every rail destination the fragment it opens', async () => {
    // The point of the anchors: the address a middle-click opens is the
    // one a plain click produces, so a destination can be copied out of
    // the rail and pasted back in. A `<button>` could promise neither.
    renderWorkspace();
    const rail = await screen.findByRole('navigation', { name: 'Modules' });
    expect(
      within(rail)
        .getAllByRole('link')
        .map((item) => [item.textContent, item.getAttribute('href')]),
    ).toEqual([
      ['Dashboard', '#/'],
      ['Works', '#/works'],
      ['Tenders', '#/tenders'],
      ['Payments', '#/payments'],
      ['Receivables', '#/receivables'],
      ['Challans', '#/challans'],
      ['Invoices', '#/invoices'],
      ['Quotations', '#/quotations'],
      ['Company documents', '#/company-documents'],
      ['Production', '#/production'],
      ['Installations', '#/installations'],
      ['Inspection', '#/inspection'],
      ['Global search', '#/search'],
      ['Approvals', '#/approvals'],
      ['Masters', '#/masters'],
      ['Members', '#/members'],
      ['Settings', '#/settings'],
    ]);
  });

  it('leaves a modified click to the browser so the rail opens in a new tab', async () => {
    renderWorkspace();
    const rail = await screen.findByRole('navigation', { name: 'Modules' });
    const invoices = within(rail).getByRole('link', { name: 'Invoices' });
    const before = window.location.hash;

    // A ctrl-click is the browser's business: nothing is prevented, the
    // workspace stays where it is, and the href does the rest.
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    invoices.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(window.location.hash).toBe(before);
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
  });

  it('collapses the rail to icons and remembers the choice', async () => {
    localStorage.removeItem('auto-mb.sidebar-collapsed');
    const first = renderWorkspace();
    const rail = await screen.findByRole('navigation', { name: 'Modules' });
    const toggle = screen.getByRole('button', { name: 'Toggle sidebar' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Collapsed is a visual state, not a reachability one: every destination
    // still answers to its name.
    expect(within(rail).getByRole('link', { name: 'Works' })).toBeTruthy();
    expect(localStorage.getItem('auto-mb.sidebar-collapsed')).toBe('true');

    first.unmount();
    renderWorkspace();
    expect(
      (await screen.findByRole('button', { name: 'Toggle sidebar' })).getAttribute(
        'aria-expanded',
      ),
    ).toBe('false');
    localStorage.removeItem('auto-mb.sidebar-collapsed');
  });

  it('signs out from the topbar account menu and closes it on Escape', async () => {
    const onSignOut = vi.fn();
    render(
      <OperationsWorkspace
        api={stubApi({
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
        })}
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
        onSignOut={onSignOut}
      />,
    );

    const trigger = await screen.findByRole('button', { name: 'Account menu' });
    fireEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'Account' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Account' })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const menu = screen.getByRole('group', { name: 'Account' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
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
    fireEvent.click(barCell('Record'));
    fireEvent.click(screen.getByRole('button', { name: 'Open Works' }));

    expect(await screen.findByRole('heading', { name: 'Works' })).toBeTruthy();
    expect(recordSheet()).toBeNull();
  });

  it('reaches the installation register from the Operations rail', async () => {
    renderWorkspace();
    // The rail is shell chrome, so it needs no arrival await on the
    // Dashboard's own fetch.
    const rail = await screen.findByRole('navigation', { name: 'Modules' });
    fireEvent.click(within(rail).getByRole('link', { name: 'Installations' }));

    // Anchored on the loaded register rather than on its heading, which the
    // loading branch renders too (`loading-anchor-census`).
    expect(await screen.findByText(/No installations recorded yet/)).toBeTruthy();
    expect(window.location.hash).toBe('#/installations');
    expect(document.title).toBe('Installations · Sharma Constructions · Auto-MB');
  });

  it('reaches the invoice register from the Documents rail', async () => {
    renderWorkspace();
    const rail = await screen.findByRole('navigation', { name: 'Modules' });
    fireEvent.click(within(rail).getByRole('link', { name: 'Invoices' }));

    // Anchored on the loaded register rather than on its heading, which the
    // loading branch renders too (`loading-anchor-census`).
    expect(await screen.findByText(/No tax invoice has been raised yet/)).toBeTruthy();
    expect(window.location.hash).toBe('#/invoices');
    expect(document.title).toBe('Invoices · Sharma Constructions · Auto-MB');
  });

  it(
    'splits the mobile Record sheet between a challan and an installation',
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
      await screen.findByRole('navigation', { name: 'Work sections' });

      // One "Delivery evidence" button used to serve both records. They are
      // two tabs now, and a site user tapping Record means one of them.
      fireEvent.click(barCell('Record'));
      expect(screen.getByRole('button', { name: 'Delivery challan' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Installation' }));

      const workTabs = await screen.findByRole('navigation', {
        name: 'Work sections',
      });
      expect(
        within(workTabs)
          .getByRole('button', {
            name: (name: string) => name.startsWith('Installations'),
          })
          .getAttribute('aria-current'),
      ).toBe('page');
      expect(window.location.hash).toBe(`#/works/${WORK_ID}/installations`);
    },
  );

  it(
    'offers a site membership only the records it may actually make',
    { timeout: 30_000 },
    async () => {
      // A site membership records evidence but does not modify Works, so
      // drafting a Delivery Challan is not one of its actions. Offering the
      // button anyway opened the Deliveries tab with nothing on it to do,
      // which is exactly the dead end this sheet exists to prevent.
      renderWorkspace(
        {
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
        },
        { role: 'site', canIssueDocuments: false, canCancelDocuments: false },
      );

      fireEvent.click(await screen.findByRole('link', { name: 'DCW-1' }));
      await screen.findByRole('navigation', { name: 'Work sections' });
      fireEvent.click(barCell('Record'));

      expect(screen.queryByRole('button', { name: 'Delivery challan' })).toBeNull();
      // The two it can make are still one tap each.
      expect(screen.getByRole('button', { name: 'Installation' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Measurements' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Installation' }));
      expect(window.location.hash).toBe(`#/works/${WORK_ID}/installations`);
    },
  );

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

      // The bar cell is an anchor now, and the guard still catches it:
      // `navigateOnClick` prevents the default and routes the plain click
      // through `navigate`, which is where the departure prompt lives.
      fireEvent.click(screen.getByRole('link', { name: 'Home' }));
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

      const recordTrigger = barCell('Record');
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
    fireEvent.click(screen.getAllByRole('link', { name: 'Works' })[0] as HTMLElement);
    expect(await screen.findByRole('heading', { name: 'Works' })).toBeTruthy();
    expect(window.location.hash).toBe('#/works');

    // …and an external hash change (Back/Forward, a pasted link, a
    // middle-clicked row) navigates the workspace.
    window.location.hash = '#/settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  });
});
