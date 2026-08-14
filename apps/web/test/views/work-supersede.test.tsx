// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SupersedeEligibilityResponse } from '@auto-mb/contracts';
import type { ApiClient } from '../../src/api.js';
import { WorkAmendments } from '../../src/views/WorkAmendments.js';
import { WorkDetail } from '../../src/views/WorkDetail.js';
import { challanWork, openForm, stubApi, ORG_ID, DOC_ID, WORK_ID } from './helpers.js';

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
      reloadSupersede={vi.fn<() => Promise<void>>().mockResolvedValue(undefined)}
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
        { register: 'delivery_challans', label: 'delivery challans' },
        { register: 'tax_invoices', label: 'tax invoices' },
      ],
    });

    await openForm('Supersede this Work');
    expect(screen.getByText('delivery challans')).toBeTruthy();
    expect(screen.getByText('tax invoices')).toBeTruthy();
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

describe('the Work page', () => {
  const noop = (): void => undefined;

  function renderWork(api: ApiClient, canModify: boolean) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={canModify}
        canRecordEvidence
        canIssue
        canCancel
        canApprove
        canManageStatutory
        isOwner
        onNewChallan={noop}
        onOpenChallan={noop}
        onNewIssueChallan={noop}
        onOpenIssueChallan={noop}
        onBack={noop}
      />,
    );
  }

  it('says what this Work replaced, and why, without offering a dead link', async () => {
    const api = stubApi({
      getWork: vi.fn<ApiClient['getWork']>().mockResolvedValue(challanWork()),
      getWorkSupersession: vi.fn<ApiClient['getWorkSupersession']>().mockResolvedValue({
        id: '55555555-5555-4555-8555-555555555555',
        supersededWorkId: '66666666-6666-4666-8666-666666666666',
        supersededWorkCode: 'PL-270',
        supersededLetterNumber: 'LOA/PL-270/2026',
        successorWorkId: WORK_ID,
        loaDocumentId: DOC_ID,
        approvalRequestId: '77777777-7777-4777-8777-777777777777',
        reason: 'Confirmed at the advertised rates; the letter is 14.35% below.',
        supersededAt: '2026-08-14T04:00:00.000Z',
        supersededByUserId: 'user-1',
        successorBoundAt: '2026-08-14T05:00:00.000Z',
      }),
    });
    renderWork(api, true);

    const panel = await screen.findByRole('region', {
      name: 'Supersedes an earlier Work',
    });
    expect(panel.textContent).toContain('PL-270');
    expect(panel.textContent).toContain('LOA/PL-270/2026');
    expect(panel.textContent).toContain('14.35% below');
    // The withdrawn Work is not openable, so nothing pretends it is.
    expect(within(panel).queryByRole('link')).toBeNull();
  });

  it('does not spend the seventeen-register census on a member who cannot act', async () => {
    const api = stubApi({
      getWork: vi.fn<ApiClient['getWork']>().mockResolvedValue(challanWork()),
    });
    renderWork(api, false);

    await screen.findByRole('heading', { name: /Supply of switchboards/ });
    expect(api.getSupersedeEligibility).not.toHaveBeenCalled();
    // The provenance read is not gated: reading where a Work came from is
    // part of reading the Work.
    expect(api.getWorkSupersession).toHaveBeenCalled();
  });
});
