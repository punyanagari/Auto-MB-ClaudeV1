// @vitest-environment jsdom
/**
 * The first ten minutes of a brand-new organisation, asserted as one
 * invariant: **no screen a first-run operator can reach may be a dead
 * end.** Every empty state either offers an action the reader's role can
 * actually take, or names who can take it — never a bare statement of
 * absence, and never an instruction aimed at a button the reader has not
 * got.
 *
 * The reconciled review scored onboarding 3.5 with "zero first-run guidance
 * exists"; these are the cases that measured it. They are written against
 * the empty states rather than a scripted click-through so that a later
 * pack cannot quietly reintroduce "No contacts yet." and keep the suite
 * green.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardResponse, OrganisationProfile } from '@auto-mb/contracts';
import { Masters, type MastersTab } from '../../src/views/Masters.js';
import { OperationsDashboard } from '../../src/views/OperationsDashboard.js';
import { ReviewLoa } from '../../src/views/ReviewLoa.js';
import { Works } from '../../src/views/Works.js';
import { stubApi, ORG_ID, DOC_ID, REVIEW_DOCUMENT } from './helpers.js';

/** A dashboard for an organisation that has done nothing yet. */
const EMPTY_DASHBOARD: DashboardResponse = {
  totals: {
    works: 0,
    contractValue: '0.00',
    deliveredValue: '0.00',
    billedValue: '0.00',
    executedPercent: null,
    openDrafts: 0,
    loaAwaitingReview: 0,
    irpReportingDue: 0,
    irpReportingOverdue: 0,
  },
  signals: {
    activeWorks: 0,
    activeContractValue: '0.00',
    activeBilledValue: '0.00',
    activeExecutedPercent: null,
    receivableOutstanding: '0.00',
    receivableIndeterminate: 0,
    activeContractTaxableValue: '0.00',
    activeBilledTaxableValue: '0.00',
    completionsOverdue: 0,
    completionsDue: 0,
    instrumentsExpired: 0,
    instrumentsExpiring: 0,
    unsignedDocuments: 0,
    assignedScopeOnly: false,
    billingSince: null,
  },
  alerts: [],
  works: [],
  completions: [],
  monthlyBilling: [],
  execution: [],
  deadlines: [],
};

/** A freshly created organisation: name and slug only. */
const BARE_PROFILE: OrganisationProfile = {
  id: ORG_ID,
  name: 'Sharma Constructions',
  slug: 'sharma',
  address: null,
  gstin: null,
  contactPhone: null,
  contactEmail: null,
  hasLogo: false,
  stateCode: null,
  pincode: null,
  locality: null,
  tradeName: null,
  msmeNumber: null,
  invoiceNumberPrefix: null,
  invoiceNotes: null,
  warrantyTemplateText: null,
};

function renderDashboard(
  options: {
    readonly canModify?: boolean;
    readonly dashboard?: DashboardResponse;
    readonly onUploadLoa?: () => void;
  } = {},
) {
  const api = stubApi({
    dashboard: vi.fn().mockResolvedValue(options.dashboard ?? EMPTY_DASHBOARD),
    organisationProfile: vi.fn().mockResolvedValue(BARE_PROFILE),
  });
  render(
    <OperationsDashboard
      api={api}
      organisationId={ORG_ID}
      canModify={options.canModify ?? true}
      onOpenWork={vi.fn()}
      onRequestExtension={vi.fn()}
      onOpenHistoricalInvoices={vi.fn()}
      onOpenWorks={vi.fn()}
      onUploadLoa={options.onUploadLoa ?? vi.fn()}
    />,
  );
  return api;
}

describe('first run — dashboard', () => {
  it('tells a new organisation what to do first, and links each unmet step to the screen that fixes it', async () => {
    renderDashboard();

    // The spine of the product, first: a Work comes from its letter.
    // Awaited rather than queried, because the checklist reads three
    // endpoints before it can say anything.
    expect(
      (
        await screen.findByRole('link', { name: 'Upload a Letter of Acceptance' })
      ).getAttribute('href'),
    ).toBe('#/works/upload');
    // And the masters each document will ask for, each pointing at its
    // own tab rather than at "Masters" in general.
    expect(
      screen
        .getByRole('link', { name: 'Open Masters → Signatories' })
        .getAttribute('href'),
    ).toBe('#/masters/signatories');
    expect(
      screen
        .getByRole('link', { name: 'Open Masters → Contacts' })
        .getAttribute('href'),
    ).toBe('#/masters/contacts');
    expect(
      screen
        .getByRole('link', { name: 'Open organisation settings' })
        .getAttribute('href'),
    ).toBe('#/settings');

    // The GST step names the facts that are missing, not just "incomplete".
    expect(
      screen.getByText(/Missing: GST state code, GSTIN, address, PIN code, locality/),
    ).toBeTruthy();
  });

  it('routes the checklist CTA through the upload callback', async () => {
    const onUploadLoa = vi.fn();
    renderDashboard({ onUploadLoa });
    (await screen.findByRole('button', { name: /Upload the first LOA/ })).click();
    expect(onUploadLoa).toHaveBeenCalledTimes(1);
  });

  it('says a letter is already waiting rather than asking for another one', async () => {
    renderDashboard({
      dashboard: {
        ...EMPTY_DASHBOARD,
        totals: { ...EMPTY_DASHBOARD.totals, loaAwaitingReview: 1 },
      },
    });
    expect(
      (
        await screen.findByRole('link', { name: 'Review the uploaded letter' })
      ).getAttribute('href'),
    ).toBe('#/works');
    expect(
      screen.getAllByText(/1 uploaded letter is waiting for review/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole('link', { name: 'Upload a Letter of Acceptance' }),
    ).toBeNull();
  });

  it('never tells a read-only member to do something their role cannot do', async () => {
    renderDashboard({ canModify: false });
    const heading = await screen.findByRole('heading', {
      name: 'Nothing is set up yet',
    });
    expect(
      within(heading.parentElement as HTMLElement).getByText(
        /An owner or office member uploads the first Letter of Acceptance/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Upload/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'First steps' })).toBeNull();
  });

  it('keeps the checklist out of the way once the organisation has a Work', async () => {
    renderDashboard({
      dashboard: {
        ...EMPTY_DASHBOARD,
        totals: { ...EMPTY_DASHBOARD.totals, works: 1 },
        works: [
          {
            workId: '33333333-3333-4333-8333-333333333333',
            workCode: 'PL270-CRB',
            title: 'Supply of switchboards',
            status: 'active',
            contractValue: '900.00',
            deliveredValue: '0.00',
            billedValue: '0.00',
            gstBasis: 'inclusive',
            gstRate: '18.00',
            executedPercent: '0.0000',
            issuedChallans: 0,
          },
        ],
      },
    });
    // The dashboard no longer lists Works (`docs/UX.md` § 40), so the
    // anchor is the first panel it always draws instead.
    await screen.findByRole('heading', { name: 'Completion dates' });
    expect(screen.queryByRole('heading', { name: 'First steps' })).toBeNull();
  });

  it('still offers the upload when the checklist itself fails to load', async () => {
    const api = stubApi({
      dashboard: vi.fn().mockResolvedValue(EMPTY_DASHBOARD),
      organisationProfile: vi.fn().mockRejectedValue(new Error('offline')),
    });
    render(
      <OperationsDashboard
        api={api}
        organisationId={ORG_ID}
        canModify
        onOpenWork={vi.fn()}
        onRequestExtension={vi.fn()}
        onOpenHistoricalInvoices={vi.fn()}
        onOpenWorks={vi.fn()}
        onUploadLoa={vi.fn()}
      />,
    );
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /Upload the first LOA/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry the checklist' })).toBeTruthy();
  });
});

describe('first run — Masters', () => {
  /** Every tab, its opener label, and a phrase from the purpose it must
   * state. A tab added without an empty state fails this list, not a
   * reviewer's memory. */
  const TABS: readonly {
    readonly tab: MastersTab;
    readonly opener: string;
    readonly purpose: RegExp;
  }[] = [
    { tab: 'contacts', opener: 'New contact', purpose: /needs a consignee/ },
    { tab: 'locations', opener: 'New location', purpose: /where it happened/ },
    { tab: 'units', opener: 'New unit', purpose: /fills itself/ },
    { tab: 'signatories', opener: 'New signatory', purpose: /signature block/ },
    {
      tab: 'gst-rates',
      opener: 'New notified rate',
      purpose: /refuses any rate this list does not cover/,
    },
  ];

  it.each(TABS)(
    'the empty $tab tab says what the list is for and has its create form already open',
    async ({ tab, opener, purpose }) => {
      render(
        <Masters
          api={stubApi()}
          organisationId={ORG_ID}
          canModify
          isOwner
          tab={tab}
          onTabChange={vi.fn()}
        />,
      );
      const emptyState = await screen.findByText(purpose);
      // The disclosure that holds the create form opens by itself while
      // there is nothing to read (`MasterForm startOpen`), and the empty
      // state points at it by name.
      expect(screen.getByRole('button', { name: opener, expanded: true })).toBeTruthy();
      expect(emptyState.textContent).toContain(`"${opener}" form below is open`);
    },
  );

  it.each(TABS)(
    'the empty $tab tab names who fills it when the reader may not',
    async ({ tab, purpose }) => {
      render(
        <Masters
          api={stubApi()}
          organisationId={ORG_ID}
          canModify={false}
          tab={tab}
          onTabChange={vi.fn()}
        />,
      );
      expect(await screen.findByText(purpose)).toBeTruthy();
      expect(screen.getByText(/An owner|Only an owner/)).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: /^New /, expanded: true }),
      ).toBeNull();
    },
  );

  it('states the date order on the notified-rate dates', async () => {
    render(
      <Masters
        api={stubApi()}
        organisationId={ORG_ID}
        canModify
        isOwner
        tab="gst-rates"
        onTabChange={vi.fn()}
      />,
    );
    const from = await screen.findByLabelText<HTMLInputElement>('In force from');
    expect(from.type).toBe('date');
    // The browser renders a native date control in its OWN locale; the
    // hint says which way round this product reads and prints it.
    const describedBy = from.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(
      document.getElementById((describedBy ?? '').split(' ')[0] ?? '')?.textContent,
    ).toContain('DD/MM/YYYY');
  });
});

describe('first run — Works register', () => {
  it('offers the upload when the reader may upload', async () => {
    const onUpload = vi.fn();
    render(
      <Works
        api={stubApi()}
        organisationId={ORG_ID}
        canModify
        onUpload={onUpload}
        onReview={vi.fn()}
        onOpenWork={vi.fn()}
      />,
    );
    await screen.findByText(/A Work is created from its Letter of Acceptance/);
    screen.getByRole('button', { name: 'Upload a Letter of Acceptance' }).click();
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it('names who uploads instead of instructing a read-only member to', async () => {
    render(
      <Works
        api={stubApi()}
        organisationId={ORG_ID}
        canModify={false}
        onUpload={vi.fn()}
        onReview={vi.fn()}
        onOpenWork={vi.fn()}
      />,
    );
    await screen.findByText(
      /An owner or office member uploads the Letter of Acceptance/,
    );
    expect(screen.queryByRole('button', { name: /Upload/ })).toBeNull();
  });
});

describe('first run — the one field the operator invents', () => {
  it('bounds and explains the work code the reviewer has to choose', async () => {
    render(
      <ReviewLoa
        api={stubApi({
          getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
        })}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );
    const input = await screen.findByLabelText<HTMLInputElement>(
      'Work code (your reference)',
    );
    // The pattern has always bounded it at 20; the control now says so
    // before the submit refuses.
    expect(input.maxLength).toBe(20);
    expect(input.getAttribute('aria-describedby')).toContain('work-code-hint');
    expect(document.getElementById('work-code-hint')?.textContent).toMatch(
      /Up to 20 characters/,
    );
  });
});
