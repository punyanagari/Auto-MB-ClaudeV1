// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RequestFailedError, type ApiClient } from '../../src/api.js';
import { Approvals } from '../../src/views/Approvals.js';
import { ChallanDetail } from '../../src/views/ChallanDetail.js';
import { CompletionExtensions } from '../../src/views/CompletionExtensions.js';
import { Timeline } from '../../src/views/Timeline.js';
import {
  openForm,
  submitButton,
  stubApi,
  ORG_ID,
  WORK_ID,
  CHALLAN_ID,
  ITEM_A,
  challanDetail,
} from './helpers.js';

describe('CompletionExtensions', () => {
  const EXTENSION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const COMPLETION_SET = {
    completion: {
      originalCompletionDate: '2026-12-31',
      currentCompletionDate: '2026-12-31',
    },
    extensionRequests: [],
  };
  const DRAFT_EXTENSION = {
    id: EXTENSION_ID,
    workId: WORK_ID,
    status: 'draft' as const,
    source: 'software' as const,
    manualReference: null,
    proposedCompletionDate: '2027-03-31',
    reason: 'Site not handed over in time.',
    addressee: 'Sr. DEE (G) NR',
    letterDate: '2026-08-01',
    sequenceNumber: null,
    requestNumber: null,
    templateVersion: null,
    renderedAvailable: false,
    responseDocumentAvailable: false,
    responseOutcome: null,
    grantedCompletionDate: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    finalisedAt: null,
    respondedAt: null,
  };
  const FINALISED_EXTENSION = {
    ...DRAFT_EXTENSION,
    status: 'finalised' as const,
    sequenceNumber: 1,
    requestNumber: 'DCW-1-Extension-01',
    templateVersion: 'extension-v1',
    responseDocumentAvailable: true,
    finalisedAt: '2026-08-02T00:00:00.000Z',
  };

  function renderCompletion(
    api: ApiClient,
    flags: Partial<{
      canModify: boolean;
      canIssue: boolean;
      canApprove: boolean;
      openComposer: boolean;
    }> = {},
  ) {
    return render(
      <CompletionExtensions
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={flags.canModify ?? true}
        canIssue={flags.canIssue ?? true}
        canApprove={flags.canApprove ?? false}
        openComposer={flags.openComposer ?? false}
      />,
    );
  }

  /* THE ADDRESS'S INTENT, ACTED ON.
   *
   * `?focus=extension` is what the dashboard's completion panel links to,
   * and it exists because this composer sits most of a long Overview
   * below the fold — landing an operator at the top of that page and
   * leaving them to scroll is a suggestion, not an action. The composer
   * opens and the field they have to fill takes focus. Nothing is
   * pre-filled: a proposal equal to the current date is not an extension. */
  it('opens the composer and focuses the proposed date when the address asks', async () => {
    const api = stubApi({
      getWorkCompletion: vi.fn().mockResolvedValue({
        ...COMPLETION_SET,
        // An extension history, so the composer is NOT open by the
        // empty-state rule and only the intent can have opened it.
        extensionRequests: [FINALISED_EXTENSION],
      }),
    });
    renderCompletion(api, { openComposer: true });

    const field = await screen.findByLabelText('Proposed completion date');
    expect(document.activeElement).toBe(field);
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('leaves the composer closed when the address did not ask', async () => {
    const api = stubApi({
      getWorkCompletion: vi.fn().mockResolvedValue({
        ...COMPLETION_SET,
        extensionRequests: [FINALISED_EXTENSION],
      }),
    });
    renderCompletion(api);
    await screen.findByRole('button', { name: /New extension request/ });
    expect(screen.queryByLabelText('Proposed completion date')).toBeNull();
  });

  it('sets the completion date once through the one-time form', async () => {
    const setCompletionDate = vi.fn().mockResolvedValue(COMPLETION_SET);
    const api = stubApi({ setCompletionDate });
    renderCompletion(api);

    fireEvent.change(
      await screen.findByLabelText('Completion date (per the contract)'),
      { target: { value: '2026-12-31' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set completion date' }));

    await waitFor(() => {
      expect(setCompletionDate).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        completionDate: '2026-12-31',
      });
    });
    // Once set, the form disappears and the dates show as facts.
    expect(await screen.findByText('Original completion date')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set completion date' })).toBeNull();
  });

  it('drafts an extension request against the current completion date', async () => {
    const createExtensionRequest = vi.fn().mockResolvedValue({
      extensionRequest: DRAFT_EXTENSION,
      finalisedSnapshot: null,
    });
    const getWorkCompletion = vi
      .fn()
      .mockResolvedValueOnce(COMPLETION_SET)
      .mockResolvedValue({
        ...COMPLETION_SET,
        extensionRequests: [DRAFT_EXTENSION],
      });
    const api = stubApi({ createExtensionRequest, getWorkCompletion });
    renderCompletion(api);

    fireEvent.change(await screen.findByLabelText('Proposed completion date'), {
      target: { value: '2027-03-31' },
    });
    fireEvent.change(screen.getByLabelText('Addressee'), {
      target: { value: 'Sr. DEE (G) NR' },
    });
    fireEvent.change(screen.getByLabelText('Letter date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByLabelText('Grounds for the extension'), {
      target: { value: 'Site not handed over in time.' },
    });
    fireEvent.click(submitButton('Save draft extension request'));

    await waitFor(() => {
      expect(createExtensionRequest).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        proposedCompletionDate: '2027-03-31',
        reason: 'Site not handed over in time.',
        addressee: 'Sr. DEE (G) NR',
        letterDate: '2026-08-01',
      });
    });
    expect(
      await screen.findByRole('button', { name: 'Finalise extension request' }),
    ).toBeTruthy();
  });

  it('switches to the existing draft on an EXTENSION_DRAFT_EXISTS conflict', async () => {
    const createExtensionRequest = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'EXTENSION_DRAFT_EXISTS',
          'This Work already has a draft extension request; finalise or delete it first.',
          { existingRecordId: EXTENSION_ID },
        ),
      );
    // The first load is stale (no draft); the conflict-triggered reload
    // finds the draft another session already opened.
    const getWorkCompletion = vi
      .fn()
      .mockResolvedValueOnce(COMPLETION_SET)
      .mockResolvedValue({
        ...COMPLETION_SET,
        extensionRequests: [DRAFT_EXTENSION],
      });
    const api = stubApi({ createExtensionRequest, getWorkCompletion });
    renderCompletion(api);

    fireEvent.change(await screen.findByLabelText('Proposed completion date'), {
      target: { value: '2027-03-31' },
    });
    fireEvent.change(screen.getByLabelText('Addressee'), {
      target: { value: 'Sr. DEE (G) NR' },
    });
    fireEvent.change(screen.getByLabelText('Letter date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByLabelText('Grounds for the extension'), {
      target: { value: 'Site not handed over in time.' },
    });
    fireEvent.click(submitButton('Save draft extension request'));

    // The conflict message shows AND the view lands on the existing draft.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('already has a draft extension request');
    expect(
      await screen.findByRole('button', { name: 'Finalise extension request' }),
    ).toBeTruthy();
  });

  it('finalises the draft under the issue authority', async () => {
    const finaliseExtensionRequest = vi.fn().mockResolvedValue({
      extensionRequest: FINALISED_EXTENSION,
      finalisedSnapshot: {},
    });
    const getWorkCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        ...COMPLETION_SET,
        extensionRequests: [DRAFT_EXTENSION],
      })
      .mockResolvedValue({
        ...COMPLETION_SET,
        extensionRequests: [FINALISED_EXTENSION],
      });
    const api = stubApi({ finaliseExtensionRequest, getWorkCompletion });
    renderCompletion(api);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Finalise extension request' }),
    );
    await waitFor(() => {
      expect(finaliseExtensionRequest).toHaveBeenCalledWith(ORG_ID, EXTENSION_ID);
    });
    expect(await screen.findByText('DCW-1-Extension-01')).toBeTruthy();
  });

  it('records a modified response with the granted date', async () => {
    const respondExtensionRequest = vi.fn().mockResolvedValue({
      extensionRequest: {
        ...FINALISED_EXTENSION,
        status: 'responded',
        responseOutcome: 'modified',
        grantedCompletionDate: '2027-02-28',
        respondedAt: '2026-08-08T00:00:00.000Z',
      },
      finalisedSnapshot: {},
    });
    const getWorkCompletion = vi.fn().mockResolvedValue({
      ...COMPLETION_SET,
      extensionRequests: [FINALISED_EXTENSION],
    });
    const api = stubApi({ respondExtensionRequest, getWorkCompletion });
    renderCompletion(api);

    await openForm('Record response…');
    fireEvent.change(screen.getByLabelText('Outcome'), {
      target: { value: 'modified' },
    });
    fireEvent.change(screen.getByLabelText('Granted completion date'), {
      target: { value: '2027-02-28' },
    });
    fireEvent.click(submitButton('Record response'));

    await waitFor(() => {
      expect(respondExtensionRequest).toHaveBeenCalledWith(ORG_ID, EXTENSION_ID, {
        outcome: 'modified',
        grantedCompletionDate: '2027-02-28',
      });
    });
  });

  it('hides every completion and extension form from read-only members', async () => {
    const getWorkCompletion = vi.fn().mockResolvedValue({
      ...COMPLETION_SET,
      extensionRequests: [FINALISED_EXTENSION],
    });
    const api = stubApi({ getWorkCompletion });
    renderCompletion(api, { canModify: false, canIssue: false });

    expect(await screen.findByText('DCW-1-Extension-01')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set completion date' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Save draft extension request' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Finalise extension request' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record response' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Record paper letter as final' }),
    ).toBeNull();
  });

  it('opens the DRAFT-watermarked preview for a draft letter', async () => {
    const downloadExtensionDraftPreview = vi
      .fn()
      .mockResolvedValue(new Blob(['%PDF-1.4 preview']));
    const getWorkCompletion = vi.fn().mockResolvedValue({
      ...COMPLETION_SET,
      extensionRequests: [DRAFT_EXTENSION],
    });
    const api = stubApi({ getWorkCompletion, downloadExtensionDraftPreview });
    vi.stubGlobal('open', vi.fn());
    try {
      renderCompletion(api);

      fireEvent.click(
        await screen.findByRole('button', { name: 'Preview draft (DRAFT watermark)' }),
      );
      await waitFor(() => {
        expect(downloadExtensionDraftPreview).toHaveBeenCalledWith(
          ORG_ID,
          EXTENSION_ID,
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('back-fills a paper letter and surfaces the non-blocking warning', async () => {
    const MANUAL_EXTENSION = {
      ...FINALISED_EXTENSION,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source: 'manual' as const,
      manualReference: 'REF/EXT/7',
      requestNumber: 'DCW-1-Extension-02',
      sequenceNumber: 2,
      templateVersion: 'extension-manual-v1',
      responseDocumentAvailable: false,
    };
    const backfillExtensionRequest = vi.fn().mockResolvedValue({
      extensionRequest: MANUAL_EXTENSION,
      finalisedSnapshot: {},
      warnings: ['This letter is dated after the first software-generated letter.'],
    });
    const getWorkCompletion = vi
      .fn()
      .mockResolvedValueOnce(COMPLETION_SET)
      .mockResolvedValue({
        ...COMPLETION_SET,
        extensionRequests: [MANUAL_EXTENSION],
      });
    const api = stubApi({ backfillExtensionRequest, getWorkCompletion });
    renderCompletion(api);

    await openForm('Record paper letter as final…');
    fireEvent.change(screen.getByLabelText('Paper letter reference'), {
      target: { value: 'REF/EXT/7' },
    });
    fireEvent.change(screen.getByLabelText('Paper letter date'), {
      target: { value: '2026-01-15' },
    });
    fireEvent.change(screen.getByLabelText('Completion date the letter asked for'), {
      target: { value: '2027-03-31' },
    });
    fireEvent.change(screen.getByLabelText('Addressee of the letter'), {
      target: { value: 'Sr. DEE (G) NR' },
    });
    fireEvent.change(screen.getByLabelText('Grounds stated in the letter'), {
      target: { value: 'Monsoon damage to the access road.' },
    });
    fireEvent.click(submitButton('Record paper letter as final'));

    await waitFor(() => {
      expect(backfillExtensionRequest).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        reference: 'REF/EXT/7',
        letterDate: '2026-01-15',
        proposedCompletionDate: '2027-03-31',
        reason: 'Monsoon damage to the access road.',
        addressee: 'Sr. DEE (G) NR',
      });
    });
    // The paper record shows with its source and reference, and the
    // warning is surfaced without having blocked the creation.
    expect(await screen.findByText('paper — REF/EXT/7')).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('first software-generated letter');
  });

  it('offers manual back-fill deletion only to amendment approvers', async () => {
    const MANUAL_EXTENSION = {
      ...FINALISED_EXTENSION,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source: 'manual' as const,
      manualReference: 'REF/EXT/7',
      responseDocumentAvailable: false,
    };
    const getWorkCompletion = vi.fn().mockResolvedValue({
      ...COMPLETION_SET,
      extensionRequests: [MANUAL_EXTENSION],
    });

    const withoutAuthority = renderCompletion(stubApi({ getWorkCompletion }), {
      canApprove: false,
    });
    expect(await screen.findByText('paper — REF/EXT/7')).toBeTruthy();
    expect(
      screen.queryByRole('button', {
        name: 'Delete manual back-fill (top of sequence only)',
      }),
    ).toBeNull();
    withoutAuthority.unmount();

    const deleteExtensionRequest = vi.fn().mockResolvedValue(undefined);
    renderCompletion(stubApi({ getWorkCompletion, deleteExtensionRequest }), {
      canApprove: true,
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Delete manual back-fill (top of sequence only)',
      }),
    );
    await waitFor(() => {
      expect(deleteExtensionRequest).toHaveBeenCalledWith(ORG_ID, MANUAL_EXTENSION.id);
    });
  });
});

describe('WorkConsignees panel', () => {
  const LINKED = {
    id: '55555555-5555-4555-8555-555555555555',
    designation: 'SSE (Signal) GZB',
    address: 'Signal Workshop, Ghaziabad',
    contactPerson: null,
    phone: null,
    email: null,
    gstin: null,
    pincode: null,
    stateCode: null,
    isConsignee: true,
    isVendor: false,
    isClient: false,
    active: true,
    createdAt: '2026-08-08T00:00:00.000Z',
  };
  const UNLINKED = {
    ...LINKED,
    id: '44444444-4444-4444-8444-444444444444',
    designation: 'Sr. DEE (G) NR',
    address: 'Delhi Division, New Delhi',
  };

  it('links a consignee contact to the Work', async () => {
    const linkWorkConsignee = vi.fn().mockResolvedValue(UNLINKED);
    const listWorkConsignees = vi
      .fn()
      .mockResolvedValueOnce([LINKED])
      .mockResolvedValue([LINKED, UNLINKED]);
    const api = stubApi({
      listWorkConsignees,
      linkWorkConsignee,
      listContacts: vi.fn().mockResolvedValue([LINKED, UNLINKED]),
    });
    const { WorkConsignees } = await import('../../src/views/WorkConsignees.js');
    render(
      <WorkConsignees api={api} organisationId={ORG_ID} workId={WORK_ID} canModify />,
    );

    expect(await screen.findByText('SSE (Signal) GZB')).toBeTruthy();
    await openForm('New consignee link');
    // Only contacts not yet linked are offered.
    const picker = screen.getByLabelText<HTMLSelectElement>('Link a consignee contact');
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([
      UNLINKED.id,
    ]);
    fireEvent.click(submitButton('Link consignee'));
    await waitFor(() => {
      expect(linkWorkConsignee).toHaveBeenCalledWith(ORG_ID, WORK_ID, UNLINKED.id);
    });
  });

  it('unlinks without deleting the contact and hides mutations from viewers', async () => {
    const unlinkWorkConsignee = vi.fn().mockResolvedValue(undefined);
    const api = stubApi({
      listWorkConsignees: vi.fn().mockResolvedValue([LINKED]),
      listContacts: vi.fn().mockResolvedValue([LINKED]),
      unlinkWorkConsignee,
    });
    const { WorkConsignees } = await import('../../src/views/WorkConsignees.js');
    const view = render(
      <WorkConsignees api={api} organisationId={ORG_ID} workId={WORK_ID} canModify />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    await waitFor(() => {
      expect(unlinkWorkConsignee).toHaveBeenCalledWith(ORG_ID, WORK_ID, LINKED.id);
    });
    view.unmount();

    render(
      <WorkConsignees
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={false}
      />,
    );
    expect(await screen.findAllByText('SSE (Signal) GZB')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unlink' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Link consignee' })).toBeNull();
  });
});

describe('Timeline', () => {
  const EVENT_ISSUED = {
    id: 'e1111111-1111-4111-8111-111111111111',
    occurredAt: '2026-08-08T10:00:00.000Z',
    actorUserId: 'user-a',
    actorName: 'Owner Person',
    action: 'challan.issued',
    entityType: 'delivery_challans',
    entityId: CHALLAN_ID,
    details: { challanNumber: 'DC/1', sequence: 1, totalAmount: '675.75' },
  };
  const EVENT_UPDATED = {
    id: 'e2222222-2222-4222-8222-222222222222',
    occurredAt: '2026-08-08T09:00:00.000Z',
    actorUserId: 'user-a',
    actorName: 'Owner Person',
    action: 'instrument.updated',
    entityType: 'work_instruments',
    entityId: '77777777-7777-4777-8777-777777777777',
    details: { before: { status: 'active' }, after: { status: 'released' } },
  };

  it('renders humanised actions with a structured before → after diff', async () => {
    const workTimeline = vi
      .fn()
      .mockResolvedValue({ events: [EVENT_ISSUED, EVENT_UPDATED], nextCursor: null });
    render(
      <Timeline
        api={stubApi({ workTimeline })}
        organisationId={ORG_ID}
        scope={{ kind: 'work', workId: WORK_ID }}
      />,
    );

    // Humanised action labels, never raw action codes.
    expect(await screen.findByText('Challan issued')).toBeTruthy();
    expect(screen.getByText('Instrument updated')).toBeTruthy();
    expect(screen.queryByText('challan.issued')).toBeNull();
    // Context facts for plain events…
    expect(screen.getByText(/Challan number: DC\/1/)).toBeTruthy();
    // …and a field-by-field old → new diff for update events, not JSON.
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('released')).toBeTruthy();
    expect(screen.queryByText(/[{}"]/)).toBeNull();
    expect(screen.getAllByText(/Owner Person/).length).toBeGreaterThan(0);
  });

  it('pages older events through the keyset cursor', async () => {
    const workTimeline = vi
      .fn()
      .mockResolvedValueOnce({ events: [EVENT_ISSUED], nextCursor: EVENT_ISSUED.id })
      .mockResolvedValueOnce({ events: [EVENT_UPDATED], nextCursor: null });
    render(
      <Timeline
        api={stubApi({ workTimeline })}
        organisationId={ORG_ID}
        scope={{ kind: 'work', workId: WORK_ID }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Show earlier events' }));
    await waitFor(() => {
      expect(workTimeline).toHaveBeenLastCalledWith(ORG_ID, WORK_ID, {
        cursor: EVENT_ISSUED.id,
      });
    });
    expect(await screen.findByText('Instrument updated')).toBeTruthy();
    // Both pages stay on screen; the cursor is exhausted.
    expect(screen.getByText('Challan issued')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show earlier events' })).toBeNull();
  });

  it('filters the Work stream by record type via the query parameter', async () => {
    const workTimeline = vi
      .fn()
      .mockResolvedValue({ events: [EVENT_ISSUED], nextCursor: null });
    render(
      <Timeline
        api={stubApi({ workTimeline })}
        organisationId={ORG_ID}
        scope={{ kind: 'work', workId: WORK_ID }}
      />,
    );

    await screen.findByText('Challan issued');
    fireEvent.change(screen.getByLabelText('Filter timeline by record type'), {
      target: { value: 'delivery_challans' },
    });
    await waitFor(() => {
      expect(workTimeline).toHaveBeenLastCalledWith(ORG_ID, WORK_ID, {
        entityTypes: ['delivery_challans'],
      });
    });
  });

  it('offers filters for every wave-added record type: items, payment matrix, PACs', async () => {
    const workTimeline = vi
      .fn()
      .mockResolvedValue({ events: [EVENT_ISSUED], nextCursor: null });
    render(
      <Timeline
        api={stubApi({ workTimeline })}
        organisationId={ORG_ID}
        scope={{ kind: 'work', workId: WORK_ID }}
      />,
    );
    await screen.findByText('Challan issued');
    const filter = screen.getByLabelText<HTMLSelectElement>(
      'Filter timeline by record type',
    );
    const values = [...filter.options].map((option) => option.value);
    expect(values).toContain('work_items');
    expect(values).toContain('payment_matrices');
    expect(values).toContain('pac_certificates');
    fireEvent.change(filter, { target: { value: 'pac_certificates' } });
    await waitFor(() => {
      expect(workTimeline).toHaveBeenLastCalledWith(ORG_ID, WORK_ID, {
        entityTypes: ['pac_certificates'],
      });
    });
  });

  it('labels railway bill events and offers their filter', async () => {
    const BILL_ID = '88888888-8888-4888-8888-888888888888';
    const workTimeline = vi.fn().mockResolvedValue({
      events: [
        {
          id: 'e3333333-3333-4333-8333-333333333333',
          occurredAt: '2026-08-08T12:00:00.000Z',
          actorUserId: 'user-a',
          actorName: 'Owner Person',
          action: 'received_railway_bill.recorded',
          entityType: 'received_railway_bills',
          entityId: BILL_ID,
          details: { billNumber: 'PA02R262600392', billAmount: '23516112.00' },
        },
        {
          id: 'e4444444-4444-4444-8444-444444444444',
          occurredAt: '2026-08-08T11:00:00.000Z',
          actorUserId: 'user-a',
          actorName: 'Owner Person',
          action: 'received_railway_bill.discarded',
          entityType: 'received_railway_bills',
          entityId: BILL_ID,
          details: { billNumber: 'PA02R262600391', reason: 'wrongly attached' },
        },
        {
          id: 'e5555555-5555-4555-8555-555555555555',
          occurredAt: '2026-08-08T10:00:00.000Z',
          actorUserId: 'user-a',
          actorName: 'Owner Person',
          action: 'measurement_book.closed',
          entityType: 'measurement_books',
          entityId: '99999999-9999-4999-8999-999999999999',
          details: { billNumber: 'PA02R262600392' },
        },
      ],
      nextCursor: null,
    });
    render(
      <Timeline
        api={stubApi({ workTimeline })}
        organisationId={ORG_ID}
        scope={{ kind: 'work', workId: WORK_ID }}
      />,
    );

    expect(await screen.findByText('Railway bill recorded')).toBeTruthy();
    expect(screen.getByText('Railway bill discarded')).toBeTruthy();
    expect(screen.getByText('Measurement closed by railway bill')).toBeTruthy();
    expect(screen.queryByText('received_railway_bill.recorded')).toBeNull();

    const filter = screen.getByLabelText<HTMLSelectElement>(
      'Filter timeline by record type',
    );
    expect([...filter.options].map((option) => option.value)).toContain(
      'received_railway_bills',
    );
    fireEvent.change(filter, { target: { value: 'received_railway_bills' } });
    await waitFor(() => {
      expect(workTimeline).toHaveBeenLastCalledWith(ORG_ID, WORK_ID, {
        entityTypes: ['received_railway_bills'],
      });
    });
  });

  it('shows the same component on the challan detail via the entity history', async () => {
    const entityTimeline = vi
      .fn()
      .mockResolvedValue({ events: [EVENT_ISSUED], nextCursor: null });
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(
        challanDetail({
          status: 'issued',
          challanNumber: 'DC/1',
          sequenceNumber: 1,
          issuedAt: '2026-08-08T10:00:00.000Z',
        }),
      ),
      entityTimeline,
    });
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canSign={false}
        canModify={false}
        canIssue={false}
        canCancel={false}
        canRecordEvidence={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(await screen.findByText('Challan issued')).toBeTruthy();
    expect(entityTimeline).toHaveBeenCalledWith(
      ORG_ID,
      'delivery_challans',
      CHALLAN_ID,
      {},
    );
  });
});

describe('Approvals queue', () => {
  const APPROVAL_ID = '99999999-9999-4999-8999-999999999999';
  const APPROVAL = {
    id: APPROVAL_ID,
    entityType: 'work_item_amendment' as const,
    entityId: ITEM_A,
    workId: WORK_ID,
    workCode: 'DCW-1',
    itemNumber: 'A/1',
    documentNumber: null,
    proposed: {
      kind: 'change_item',
      workItemId: ITEM_A,
      itemNumber: 'A/1',
      changes: { quantity: '8.000' },
    },
    diff: [{ field: 'quantity', before: '5.000', after: '8.000' }],
    reason: 'Railway variation order 12.',
    status: 'pending' as const,
    requestedByUserId: 'user-b',
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    variationOrder: null,
    createdAt: '2026-08-08T00:00:00.000Z',
  };

  /** An omission, which the 2026-08-13 ruling holds cannot be approved
   * until the railway variation order authorising it has been uploaded and
   * verified against the document. */
  const OMISSION = {
    ...APPROVAL,
    id: '88888888-8888-4888-8888-888888888888',
    proposed: {
      kind: 'remove_item' as const,
      workItemId: ITEM_A,
      itemNumber: 'A/1',
    },
    diff: [
      { field: 'item', before: 'A/1', after: null },
      { field: 'quantity', before: '5.000', after: null },
    ],
    reason: 'Not required at site.',
  };

  const CITED_ORDER = {
    id: '77777777-7777-4777-8777-777777777777',
    approvalRequestId: OMISSION.id,
    loaNumber: '00341490031451',
    loaDate: '2021-01-29',
    agreementNumber: 'CR/BSL/S&T/2021/0006',
    variationNumber: '3',
    originalFilename: 'variation-3.pdf',
    sha256: 'a'.repeat(64),
    sizeBytes: 204_800,
    uploadedByUserId: 'user-b',
    createdAt: '2026-08-12T00:00:00.000Z',
    verdict: {
      verified: true,
      failedClaims: [],
      claims: [
        {
          code: 'item_omitted' as const,
          verified: true,
          required: true,
          detail: 'The order proposes a quantity of 0.0 for item A/1.',
          found: '0.0',
          expected: '0',
        },
        {
          code: 'loa_amount' as const,
          verified: false,
          required: false,
          detail:
            'The order prints an LOA amount of 41,301,860 against this Work’s contract value of 39,853,884.12. Advisory only.',
          found: '41,301,860',
          expected: '39853884.12',
        },
      ],
    },
  };

  it('renders the diff and approves with a note', async () => {
    const approveAmendment = vi
      .fn()
      .mockResolvedValue({ ...APPROVAL, status: 'approved' });
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce([APPROVAL])
      .mockResolvedValue([]);
    const api = stubApi({ listApprovals, approveAmendment });
    render(
      <Approvals
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-a"
        canApprove={true}
        onChanged={vi.fn()}
      />,
    );

    expect(await screen.findByText('Railway variation order 12.')).toBeTruthy();
    expect(screen.getByText('5.000')).toBeTruthy();
    expect(screen.getByText('8.000')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Decision note (required to reject)'), {
      target: { value: 'Sanctioned by letter.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and apply' }));
    await waitFor(() => {
      expect(approveAmendment).toHaveBeenCalledWith(
        ORG_ID,
        APPROVAL_ID,
        'Sanctioned by letter.',
      );
    });
  });

  it('keeps Reject disabled until a note is supplied', async () => {
    const rejectAmendment = vi
      .fn()
      .mockResolvedValue({ ...APPROVAL, status: 'rejected' });
    const api = stubApi({
      listApprovals: vi.fn().mockResolvedValue([APPROVAL]),
      rejectAmendment,
    });
    render(
      <Approvals
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-a"
        canApprove={true}
        onChanged={vi.fn()}
      />,
    );

    const reject = await screen.findByRole('button', { name: 'Reject' });
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Decision note (required to reject)'), {
      target: { value: 'Duplicate of variation 9.' },
    });
    expect((reject as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reject);
    await waitFor(() => {
      expect(rejectAmendment).toHaveBeenCalledWith(
        ORG_ID,
        APPROVAL_ID,
        'Duplicate of variation 9.',
      );
    });
  });

  it('offers withdraw to the requester and hides decisions without authority', async () => {
    const withdrawAmendment = vi
      .fn()
      .mockResolvedValue({ ...APPROVAL, status: 'withdrawn' });
    const api = stubApi({
      listApprovals: vi.fn().mockResolvedValue([APPROVAL]),
      withdrawAmendment,
    });
    render(
      <Approvals
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-b"
        canApprove={false}
        onChanged={vi.fn()}
      />,
    );

    await screen.findByText('Railway variation order 12.');
    expect(screen.queryByRole('button', { name: 'Approve and apply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => {
      expect(withdrawAmendment).toHaveBeenCalledWith(ORG_ID, APPROVAL_ID);
    });
  });

  it('shows a calm empty state', async () => {
    render(
      <Approvals
        api={stubApi()}
        organisationId={ORG_ID}
        currentUserId="user-a"
        canApprove={true}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Nothing is waiting for a decision\./)).toBeTruthy();
  });

  it('will not let an omission be approved before its variation order is cited', async () => {
    const attachVariationOrder = vi.fn().mockResolvedValue({
      approval: { ...OMISSION, variationOrder: CITED_ORDER },
      verdict: CITED_ORDER.verdict,
    });
    const api = stubApi({
      listApprovals: vi.fn().mockResolvedValue([OMISSION]),
      attachVariationOrder,
    });
    render(
      <Approvals
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-a"
        canApprove={true}
        onChanged={vi.fn()}
      />,
    );

    const approve = await screen.findByRole('button', { name: 'Approve and apply' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(/cannot be approved until the railway variation order/i),
    ).toBeTruthy();

    // There is no field to type a letter number into: the server reads
    // every fact out of the uploaded order itself.
    expect(screen.queryByLabelText(/letter number/i)).toBeNull();
    const input = screen.getByLabelText('Variation order (PDF)');
    const file = new File(['%PDF-1.4'], 'variation-3.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByRole('button', { name: 'Cite variation order' })).toBeTruthy();
    // Submitted through the form rather than the button: jsdom's own
    // constraint validation does not see the file list this test injects,
    // and would block a click on a form carrying a required file input.
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(attachVariationOrder).toHaveBeenCalledWith(
        ORG_ID,
        OMISSION.id,
        file,
        'variation-3.pdf',
      );
    });
  });

  it('shows the cited order beside the omission, advisory notes included', async () => {
    const api = stubApi({
      listApprovals: vi
        .fn()
        .mockResolvedValue([{ ...OMISSION, variationOrder: CITED_ORDER }]),
    });
    render(
      <Approvals
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-a"
        canApprove={true}
        onChanged={vi.fn()}
      />,
    );

    await screen.findByText('Variation order');
    // Railway references and the letter date, in the product's mono
    // treatment; the date through formatDate, never a raw ISO string.
    expect(screen.getByText('CR/BSL/S&T/2021/0006')).toBeTruthy();
    expect(screen.getByText('00341490031451')).toBeTruthy();
    expect(screen.getByText('29 Jan 2021')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    // The one advisory claim is shown rather than hidden: the approver
    // decides what a differing agreement value means.
    expect(screen.getByText(/Advisory only/)).toBeTruthy();
    // With an order cited, the decision is available again.
    const approve = screen.getByRole('button', { name: 'Approve and apply' });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByLabelText('Variation order (PDF)')).toBeNull();
  });

  it('reports a refused variation order without approving anything', async () => {
    const attachVariationOrder = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'OMISSION_VARIATION_ORDER_UNVERIFIED',
          'The uploaded document does not authorise this omission. item_omitted: The order proposes a quantity of 2.0 for item A/1, not zero.',
        ),
      );
    const approveAmendment = vi.fn();
    const api = stubApi({
      listApprovals: vi.fn().mockResolvedValue([OMISSION]),
      attachVariationOrder,
      approveAmendment,
    });
    render(
      <Approvals
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-a"
        canApprove={true}
        onChanged={vi.fn()}
      />,
    );

    const input = await screen.findByLabelText('Variation order (PDF)');
    fireEvent.change(input, {
      target: {
        files: [new File(['%PDF-1.4'], 'wrong.pdf', { type: 'application/pdf' })],
      },
    });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(await screen.findByText(/not zero/)).toBeTruthy();
    expect(approveAmendment).not.toHaveBeenCalled();
  });
});
