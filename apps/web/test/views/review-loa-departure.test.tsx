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

/** The one field the fixture letter leaves open, plus the work code the
 * reviewer always supplies. Typing into either is real review work. */
async function correctTheLetter() {
  fireEvent.change(await screen.findByLabelText('Work code (your reference)'), {
    target: { value: 'PL270-CRB' },
  });
}

describe('ReviewLoa departure protection', () => {
  it('lets an untouched letter be left without a question', async () => {
    renderReview();
    await screen.findByRole('heading', { name: /^Review /, level: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));

    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    expect(screen.queryByText('Unsaved draft changes')).toBeNull();
  });

  it('asks before a corrected letter is abandoned by navigation', async () => {
    renderReview();
    await screen.findByRole('heading', { name: /^Review /, level: 1 });
    await correctTheLetter();

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));

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
    await screen.findByRole('heading', { name: /^Review /, level: 1 });
    await correctTheLetter();

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    await screen.findByRole('heading', { name: 'Unsaved draft changes' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));

    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
  });

  it('asks before the screen’s own Back to Works discards corrections', async () => {
    renderReview();
    await screen.findByRole('heading', { name: /^Review /, level: 1 });
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
    await screen.findByRole('heading', { name: /^Review /, level: 1 });
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
    await screen.findByRole('heading', { name: /^Review /, level: 1 });
    await correctTheLetter();

    fireEvent.click(screen.getByRole('button', { name: 'Discard this letter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discard' }));

    await screen.findByRole('heading', { name: 'Works', level: 1 });
    expect(screen.queryByText('Unsaved draft changes')).toBeNull();
  });
});
