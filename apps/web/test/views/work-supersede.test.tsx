// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SupersedeEligibilityResponse } from '@auto-mb/contracts';
import type { ApiClient } from '../../src/api.js';
import { WorkAmendments } from '../../src/views/WorkAmendments.js';
import { openForm, stubApi, ORG_ID, DOC_ID, WORK_ID } from './helpers.js';

/*
 * The supersede panel (pack P19): the operator-facing half of the exit for
 * a Work confirmed from a letter that was read wrongly.
 *
 * What is worth holding here is that the screen never offers the action it
 * cannot complete. Eligibility is the server's answer, re-checked at
 * proposal and again at approval, so the panel's job is to render that
 * answer honestly: name what stands in the way, say when the request is
 * already waiting, and offer the form only when there is nothing left to
 * refuse.
 *
 * `WorkAmendments` is rendered directly rather than through `WorkDetail`.
 * The eligibility read is `WorkDetail`'s and is already covered by the
 * state-coverage suite; what is under test here is the panel, and nothing
 * in it loads on mount — so there is no loading state for an assertion to
 * race (the class of bug recorded in the wave-2 process notes).
 */

const ELIGIBLE: SupersedeEligibilityResponse = {
  workId: WORK_ID,
  eligible: true,
  blockers: [],
  loaDocumentId: DOC_ID,
  pendingRequestId: null,
};

function renderPanel(
  api: ApiClient,
  supersede: SupersedeEligibilityResponse | null,
  canCreateDocuments = true,
) {
  return render(
    <WorkAmendments
      api={api}
      organisationId={ORG_ID}
      workId={WORK_ID}
      amendments={[]}
      setAmendments={vi.fn()}
      setDetail={vi.fn()}
      schedules={[]}
      workItems={[]}
      canCreateDocuments={canCreateDocuments}
      supersede={supersede}
      pending={false}
      act={async (run) => {
        await run();
      }}
    />,
  );
}

describe('the supersede panel', () => {
  it('files the request with its reason when nothing stands in the way', async () => {
    const api = stubApi({
      proposeWorkSupersede: vi.fn<ApiClient['proposeWorkSupersede']>(),
      getWork: vi.fn<ApiClient['getWork']>(),
      listWorkAmendments: vi
        .fn<ApiClient['listWorkAmendments']>()
        .mockResolvedValue([]),
    });
    renderPanel(api, ELIGIBLE);

    await openForm('Supersede this Work');
    fireEvent.change(screen.getByLabelText('Reason for superseding'), {
      target: {
        value: 'Confirmed at the advertised rates; the letter is 14.35% below.',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request supersede' }));

    await waitFor(() => {
      expect(api.proposeWorkSupersede).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        reason: 'Confirmed at the advertised rates; the letter is 14.35% below.',
      });
    });
  });

  it('names every register that holds a document, and offers no form', async () => {
    renderPanel(stubApi(), {
      ...ELIGIBLE,
      eligible: false,
      blockers: [
        { register: 'delivery_challans', label: 'delivery challans', count: 2 },
        { register: 'tax_invoices', label: 'tax invoices', count: 1 },
      ],
    });

    await openForm('Supersede this Work');
    expect(screen.getByRole('rowheader', { name: 'delivery challans' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'tax invoices' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request supersede' })).toBeNull();
  });

  it('says a request is already waiting rather than offering a second', async () => {
    renderPanel(stubApi(), {
      ...ELIGIBLE,
      pendingRequestId: '44444444-4444-4444-8444-444444444444',
    });

    await openForm('Supersede this Work');
    expect(screen.getByText(/already awaiting a decision/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request supersede' })).toBeNull();
  });

  it('explains a Work with no letter instead of offering a remedy it cannot run', async () => {
    renderPanel(stubApi(), { ...ELIGIBLE, eligible: false, loaDocumentId: null });

    await openForm('Supersede this Work');
    expect(screen.getByText(/no letter to read again/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request supersede' })).toBeNull();
  });

  it('is absent for a read-only member, and when eligibility could not be read', () => {
    const readOnly = renderPanel(stubApi(), ELIGIBLE, false);
    expect(screen.queryByRole('button', { name: /Supersede this Work/ })).toBeNull();
    readOnly.unmount();

    renderPanel(stubApi(), null);
    expect(screen.queryByRole('button', { name: /Supersede this Work/ })).toBeNull();
  });
});
