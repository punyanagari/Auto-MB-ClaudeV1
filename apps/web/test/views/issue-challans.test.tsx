// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IssueChallan, SaveIssueChallanRequest } from '@auto-mb/contracts';
import { type ApiClient } from '../../src/api.js';
import { IssueChallanDetail } from '../../src/views/IssueChallanDetail.js';
import { IssueChallanEditor } from '../../src/views/IssueChallanEditor.js';
import { openForm, stubApi, ORG_ID, WORK_ID, ITEM_A } from './helpers.js';

describe('IssueChallanDetail on a completed Work', () => {
  const IC_ID = 'aaaa4444-4444-4444-8444-444444444444';
  const issuedIc = () => ({
    issueChallan: {
      id: IC_ID,
      workId: WORK_ID,
      status: 'issued' as const,
      movementType: 'issue' as const,
      challanDate: '2026-01-15',
      challanNumber: 'DCW-1-IC/1',
      sequenceNumber: 1,
      prefix: 'DCW-1-IC',
      issuedToName: 'SSE/Signal/Delhi',
      issuedToRole: null,
      location: null,
      remarks: null,
      templateVersion: 'issue-challan-v1',
      renderedAvailable: true,
      signedCopyAvailable: false,
      cancellationNote: null,
      createdAt: '2026-01-15T00:00:00.000Z',
      issuedAt: '2026-01-15T10:00:00.000Z',
      cancelledAt: null,
    },
    lines: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        workItemId: ITEM_A,
        itemNumber: 'A/1',
        description: 'Main switchboard',
        unit: 'Nos',
        quantity: '2.000',
        position: 1,
      },
    ],
    issuedSnapshot: null,
  });

  function renderIc(workActive: boolean) {
    const api = stubApi({
      getIssueChallan: vi.fn().mockResolvedValue(issuedIc()),
    });
    render(
      <IssueChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={IC_ID}
        canModify
        canIssue={false}
        canCancel
        workActive={workActive}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    return api;
  }

  it('keeps the record and its PDF but closes both mutating forms', async () => {
    const api = renderIc(false);

    await screen.findByRole('heading', { name: 'Issue Challan DCW-1-IC/1' });
    expect(screen.getByText('Main switchboard')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open PDF' })).toBeTruthy();
    expect(screen.queryByLabelText('Cancellation note')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Request cancel & replace…' }),
    ).toBeNull();
    expect(screen.getAllByText(/Reopen the Work from its page/).length).toBe(2);
    expect(api.cancelIssueChallan).not.toHaveBeenCalled();
  });

  it('leaves both forms open while the Work is active', async () => {
    renderIc(true);

    await openForm('Cancel challan…');
    expect(screen.getByLabelText('Cancellation note')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Request cancel & replace…' }),
    ).toBeTruthy();
    expect(screen.queryByText(/Reopen the Work from its page/)).toBeNull();
  });
});

describe('IssueChallanEditor awarded-item quantities', () => {
  const ITEM_B = '55555555-5555-4555-8555-555555555556';
  const TWO_ITEM_BALANCE = {
    allowExcessDelivery: false,
    today: '2026-08-11',
    items: [
      {
        workItemId: ITEM_A,
        itemNumber: 'A/1',
        description: 'Main switchboard',
        unitCode: 'Nos',
        awardedQuantity: '5.000',
        deliveredQuantity: '0.000',
        remainingQuantity: '5.000',
        effectiveRate: '100.00',
      },
      {
        workItemId: ITEM_B,
        itemNumber: 'A/2',
        description: 'Cable gland kit',
        unitCode: 'Nos',
        awardedQuantity: '10.000',
        deliveredQuantity: '0.000',
        remainingQuantity: '10.000',
        effectiveRate: '25.00',
      },
    ],
  };

  function renderEditor(api: ApiClient) {
    render(
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
  }

  it('binds a zero typed against an awarded item to that box and sends focus there', async () => {
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(TWO_ITEM_BALANCE),
      createIssueChallan: vi.fn(),
    });
    renderEditor(api);

    await screen.findByText('Cable gland kit');
    fireEvent.change(screen.getByLabelText('Issued to (name)'), {
      target: { value: 'SSE/Signal/Delhi' },
    });
    fireEvent.change(screen.getByLabelText('Quantity of A/2 on this Issue Challan'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(api.createIssueChallan).not.toHaveBeenCalled();
    const box = screen.getByLabelText('Quantity of A/2 on this Issue Challan');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    const message = screen.getByText(/Enter a quantity greater than zero/);
    expect(box.getAttribute('aria-describedby')).toBe(message.id);
    expect(document.activeElement).toBe(box);
    // The summary names the offending item rather than the whole form.
    expect((await screen.findByRole('alert')).textContent).toContain('Item A/2');
  });

  it('rejects text in an awarded box but keeps an empty box off the challan', async () => {
    const createIssueChallan = vi.fn().mockResolvedValue({
      issueChallan: { id: 'aaaa4444-4444-4444-8444-444444444444' },
      lines: [],
      issuedSnapshot: null,
    });
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(TWO_ITEM_BALANCE),
      createIssueChallan,
    });
    renderEditor(api);

    await screen.findByText('Cable gland kit');
    fireEvent.change(screen.getByLabelText('Issued to (name)'), {
      target: { value: 'SSE/Signal/Delhi' },
    });
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this Issue Challan'), {
      target: { value: 'abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(createIssueChallan).not.toHaveBeenCalled();

    // The legitimate case the check must not swallow: A/1 corrected, A/2
    // left empty because that item is simply not on this challan.
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this Issue Challan'), {
      target: { value: '2.500' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(createIssueChallan).toHaveBeenCalled();
    });
    const [, , body] = createIssueChallan.mock.calls[0] as [
      string,
      string,
      SaveIssueChallanRequest,
    ];
    expect(body.lines).toEqual([{ workItemId: ITEM_A, quantity: '2.500' }]);
    expect(screen.queryByText(/Enter a quantity greater than zero/)).toBeNull();
  });
});

describe('IssueChallanEditor carries the previous Issue Challan forward', () => {
  const IC_ID = 'aaaa5555-5555-4555-8555-555555555555';
  const BALANCE = {
    allowExcessDelivery: false,
    today: '2026-08-11',
    items: [
      {
        workItemId: ITEM_A,
        itemNumber: 'A/1',
        description: 'Main switchboard',
        unitCode: 'Nos',
        awardedQuantity: '5.000',
        deliveredQuantity: '0.000',
        remainingQuantity: '5.000',
        effectiveRate: '100.00',
      },
    ],
  };

  /** An Issue Challan of this Work as the list endpoint returns it. */
  function previousIssueChallan(overrides: Partial<IssueChallan> = {}): IssueChallan {
    return {
      id: IC_ID,
      workId: WORK_ID,
      status: 'issued',
      movementType: 'loan',
      challanDate: '2026-07-02',
      challanNumber: 'DCW-1-IC/1',
      sequenceNumber: 1,
      prefix: 'DCW-1-IC',
      issuedToName: 'SSE/Signal/Delhi',
      issuedToRole: 'Store keeper',
      location: 'Ghaziabad depot',
      remarks: 'Against indent 44',
      templateVersion: 'issue-challan-v1',
      renderedAvailable: true,
      signedCopyAvailable: false,
      cancellationNote: null,
      createdAt: '2026-07-02T00:00:00.000Z',
      issuedAt: '2026-07-02T10:00:00.000Z',
      cancelledAt: null,
      ...overrides,
    };
  }

  function renderNewDraft(api: ApiClient) {
    render(
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
  }

  it('opens a second challan on the first one’s movement, recipient, and location', async () => {
    const createIssueChallan = vi.fn().mockResolvedValue({
      issueChallan: { id: IC_ID },
      lines: [],
      issuedSnapshot: null,
    });
    const listIssueChallans = vi.fn().mockResolvedValue([previousIssueChallan()]);
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      listIssueChallans,
      createIssueChallan,
    });
    renderNewDraft(api);

    await screen.findByText('Main switchboard');
    expect(listIssueChallans).toHaveBeenCalledWith(ORG_ID, WORK_ID);
    expect(screen.getByLabelText<HTMLSelectElement>('Movement').value).toBe('loan');
    expect(screen.getByLabelText<HTMLInputElement>('Issued to (name)').value).toBe(
      'SSE/Signal/Delhi',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Role (optional)').value).toBe(
      'Store keeper',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Location (optional)').value).toBe(
      'Ghaziabad depot',
    );
    // The date is this organisation's today, the remarks belong to the
    // movement that carried them, and last time's quantities are no
    // proposal for this time's.
    expect(screen.getByLabelText<HTMLInputElement>('Challan date').value).toBe(
      BALANCE.today,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Remarks (optional)').value).toBe(
      '',
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Quantity of A/1 on this Issue Challan')
        .value,
    ).toBe('');

    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this Issue Challan'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(createIssueChallan).toHaveBeenCalled();
    });
    const [, , body] = createIssueChallan.mock.calls[0] as [
      string,
      string,
      SaveIssueChallanRequest,
    ];
    expect(body.movementType).toBe('loan');
    expect(body.issuedToName).toBe('SSE/Signal/Delhi');
    expect(body.issuedToRole).toBe('Store keeper');
    expect(body.location).toBe('Ghaziabad depot');
    expect(body.challanDate).toBe(BALANCE.today);
    expect(body.lines).toEqual([{ workItemId: ITEM_A, quantity: '1' }]);
  });

  it('falls back to the plain defaults when every Issue Challan was cancelled', async () => {
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      listIssueChallans: vi.fn().mockResolvedValue([
        previousIssueChallan({
          status: 'cancelled',
          cancellationNote: 'Wrong storekeeper',
          cancelledAt: '2026-07-03T10:00:00.000Z',
        }),
      ]),
    });
    renderNewDraft(api);

    await screen.findByText('Main switchboard');
    expect(screen.getByLabelText<HTMLSelectElement>('Movement').value).toBe('issue');
    expect(screen.getByLabelText<HTMLInputElement>('Issued to (name)').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('Location (optional)').value).toBe(
      '',
    );
  });

  it('never reseeds an existing draft from the history', async () => {
    const listIssueChallans = vi.fn().mockResolvedValue([previousIssueChallan()]);
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      listIssueChallans,
      getIssueChallan: vi.fn().mockResolvedValue({
        issueChallan: previousIssueChallan({
          status: 'draft',
          challanDate: '2026-08-09',
          challanNumber: null,
          sequenceNumber: null,
          movementType: 'return',
          issuedToName: 'SSE/TRD/Delhi',
          issuedToRole: null,
          location: null,
          issuedAt: null,
        }),
        lines: [],
        issuedSnapshot: null,
      }),
    });
    render(
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={IC_ID}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByText('Main switchboard');
    // The draft is already whatever the operator saved, down to the boxes
    // they deliberately left empty; the history is not even asked for.
    expect(listIssueChallans).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLSelectElement>('Movement').value).toBe('return');
    expect(screen.getByLabelText<HTMLInputElement>('Issued to (name)').value).toBe(
      'SSE/TRD/Delhi',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Role (optional)').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('Location (optional)').value).toBe(
      '',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Challan date').value).toBe(
      '2026-08-09',
    );
  });
});
