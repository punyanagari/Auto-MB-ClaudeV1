// @vitest-environment jsdom
/**
 * Departure protection over the LOA review screen.
 *
 * The finding this guards: the shell's unsaved-work confirmation covered
 * the two short challan editors and nothing else, while the longest form
 * in the product — a letter with a hundred correctable rows — could be
 * left by any navigation without a word. Every test here drives the real
 * shell rather than the view in isolation, because the bug was in the
 * wiring between them: `ReviewLoa` reported nothing, and the callbacks it
 * was given set the view directly instead of going through the
 * confirmation.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api.js';
import { OperationsWorkspace } from '../../src/views/OperationsWorkspace.js';
import {
  stubApi,
  membership,
  DOC_ID,
  ORG_ID,
  WORK_ID,
  REVIEW_DOCUMENT,
} from './helpers.js';

const organisation = {
  id: ORG_ID,
  name: 'Sharma Constructions',
  slug: 'sharma',
};

function renderReview(overrides: Partial<ApiClient> = {}) {
  window.history.replaceState(null, '', `#/loa/${DOC_ID}`);
  const api = stubApi({
    getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
    dashboard: vi.fn().mockResolvedValue({
      totals: {
        works: 0,
        contractValue: '0.00',
        deliveredValue: '0.00',
        billedValue: '0.00',
        openDrafts: 0,
        loaAwaitingReview: 0,
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
      completions: [],
      monthlyBilling: [],
      execution: [],
      deadlines: [],
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

/** The one field the fixture letter leaves open, plus the work code the
 * reviewer always supplies. Typing into either is real review work. */
async function correctTheLetter() {
  fireEvent.change(await screen.findByLabelText('Work code (your reference)'), {
    target: { value: 'PL270-CRB' },
  });
}

describe('ReviewLoa arrival announcements', () => {
  it('announces what the extraction produced, in a region that was already there', async () => {
    /* The document read is held open so the loading state can be caught.
       That is the whole point of the assertion: a live region only
       announces a CHANGE to text it already had, so the region has to be on
       screen while the reviewer is still waiting. This screen used to
       render "Loading document…" as a status and then REMOVE it along with
       the entire card — a sighted reviewer watched the letter appear and a
       screen-reader user was told nothing at all. */
    let deliver = (): void => undefined;
    const held = new Promise((resolve) => {
      deliver = () => {
        resolve(REVIEW_DOCUMENT);
      };
    });
    const { container } = renderReview({
      getLoaDocument: vi.fn().mockReturnValue(held),
    });

    await screen.findByText('Loading the document…');
    const waiting = [...container.querySelectorAll('.sr-only [role="status"]')];
    expect(waiting.length).toBe(2);
    expect(waiting[0]?.textContent).toBe('');

    deliver();
    /* Awaited on the announcement itself, and deliberately not on the
       heading: the loading branch renders "Review LOA" too, so
       `findByRole('heading', { name: /^Review / })` resolves against the
       state this test is trying to leave. That is the hazard §2.7 recorded
       after P9 — awaiting an element that exists in the LOADING state — and
       it caught this test once, passing alone and failing under the
       parallel run. */
    const announced = await screen.findByText(
      /^Extraction ready for .+: \d+ items? across \d+ schedules?, \d+ flagged for review\.$/,
    );
    // The same node, not a replacement: an inserted region announces
    // nothing. Identity, because `toEqual` on two DOM elements compares own
    // enumerable properties and any two elements pass it.
    expect(announced).toBe(waiting[0]);
  });
});

describe('ReviewLoa departure protection', () => {
  it('lets an untouched letter be left without a question', async () => {
    renderReview();
    /* The heading name is the LOADED one, filename and all: the loading
       branch renders a level-1 "Review LOA" heading too, so a /^Review /
       matcher resolves against the loading state — and this test, which
       types nothing before leaving, would then pass vacuously against a
       letter that never arrived. Same §2.7 hazard the announcements test
       above documents; the other cases in this file are additionally
       anchored by `correctTheLetter`, which waits on a loaded-only field. */
    await screen.findByRole('heading', { name: 'Review loa-letter.pdf', level: 1 });

    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }));

    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    expect(screen.queryByText('Unsaved draft changes')).toBeNull();
  });

  it('asks before a corrected letter is abandoned by navigation', async () => {
    renderReview();
    await screen.findByRole('heading', { name: 'Review loa-letter.pdf', level: 1 });
    await correctTheLetter();

    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }));

    await screen.findByRole('heading', { name: 'Unsaved draft changes' });
    // Declining leaves the reviewer exactly where they were, with the
    // correction still in the field.
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(
      screen.getByLabelText<HTMLInputElement>('Work code (your reference)').value,
    ).toBe('PL270-CRB');
  });

  it('leaves once the reviewer accepts the loss', async () => {
    renderReview();
    await screen.findByRole('heading', { name: 'Review loa-letter.pdf', level: 1 });
    await correctTheLetter();

    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }));
    await screen.findByRole('heading', { name: 'Unsaved draft changes' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));

    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
  });

  it('asks before the screen’s own Back to Works discards corrections', async () => {
    renderReview();
    await screen.findByRole('heading', { name: 'Review loa-letter.pdf', level: 1 });
    await correctTheLetter();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Works' }));

    await screen.findByRole('heading', { name: 'Unsaved draft changes' });
  });

  it('does not ask twice when the letter has just become a Work', async () => {
    const { api } = renderReview({
      confirmLoa: vi.fn().mockResolvedValue({
        work: { id: WORK_ID, workCode: 'PL270-CRB', status: 'active' },
        schedules: [],
      }),
      getWork: vi.fn().mockResolvedValue({
        work: {
          id: WORK_ID,
          workCode: 'PL270-CRB',
          letterNumber: 'L-42/2025',
          letterDate: '2025-06-01',
          title: 'Supply and installation of switchboards',
          advertisedValue: '1000.00',
          contractValue: '900.00',
          pricingShape: 'per_schedule',
          letterPercentage: null,
          letterPercentageDirection: null,
          status: 'active',
          createdAt: '2026-08-08T00:00:00.000Z',
        },
        schedules: [],
      }),
    });
    await screen.findByRole('heading', { name: 'Review loa-letter.pdf', level: 1 });
    await correctTheLetter();
    fireEvent.change(screen.getByLabelText(/^Unit for row 1/), {
      target: { value: 'Nos' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    await waitFor(() => {
      expect(api.confirmLoa).toHaveBeenCalled();
    });
    // The corrections were saved by the confirmation itself, so a second
    // question about losing them would be nonsense.
    expect(screen.queryByText('Unsaved draft changes')).toBeNull();
  });

  it('does not ask after the letter has been deliberately withdrawn', async () => {
    renderReview({
      discardLoaDocument: vi.fn().mockResolvedValue({
        document: { ...REVIEW_DOCUMENT, extractionStatus: 'discarded' },
        discardedSupportingDocumentIds: [],
      }),
    });
    await screen.findByRole('heading', { name: 'Review loa-letter.pdf', level: 1 });
    await correctTheLetter();

    fireEvent.click(screen.getByRole('button', { name: 'Discard this letter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discard' }));

    await screen.findByRole('heading', { name: 'Works', level: 1 });
    expect(screen.queryByText('Unsaved draft changes')).toBeNull();
  });
});
