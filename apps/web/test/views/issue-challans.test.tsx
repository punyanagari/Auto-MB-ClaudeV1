// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SaveIssueChallanRequest } from '@auto-mb/contracts';
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
