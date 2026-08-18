// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MaintenanceDetailResponse, MaintenanceLine } from '@auto-mb/contracts';
import type { ApiClient } from '../../src/api.js';
import { MaintenanceJobCard } from '../../src/views/MaintenanceJobCard.js';
import { ORG_ID, WORK_ID, stubApi } from './helpers.js';

/*
 * The maintenance job card.
 *
 * The shared loading / empty / failure patterns are covered once for
 * every view by `state-coverage.test.tsx`. What is here is the two
 * surfaces the mock does not draw at all — the approval card and the
 * write-off panel (`docs/UX.md` § 14 rows 14o and 14d) — plus the one
 * thing this screen must never do, which is stamp a challan with the
 * browser's idea of today.
 */

const REQUEST_ID = 'b41c7d29-5e83-4f16-9a27-3d5c8b1e6f40';
const LINE_ID = 'c52d8e3a-6f94-4027-8b38-4e6d9c2f7a51';

function line(overrides: Partial<MaintenanceLine> = {}): MaintenanceLine {
  return {
    id: LINE_ID,
    position: 1,
    itemId: '9f2c1d84-6b3a-4e57-8c10-2a5d7e9f4b31',
    itemCode: 'EL-SMPS-2410',
    description: '24 V 10 A SMPS',
    unit: 'Nos',
    purpose: 'Replacement',
    quantity: '4.000',
    outstandingQuantity: '3.000',
    dispatchedQuantity: '1.000',
    cancelledQuantity: '0.000',
    cancellationReason: null,
    expectedReturnQuantity: '4.000',
    receivedReturnQuantity: '0.000',
    returnDueQuantity: '1.000',
    onHand: '30.000',
    assetSerials: [],
    resolved: false,
    ...overrides,
  };
}

function detail(
  overrides: Partial<MaintenanceDetailResponse> = {},
): MaintenanceDetailResponse {
  return {
    request: {
      id: REQUEST_ID,
      requestNumber: 'MR/26-27/00142',
      workId: WORK_ID,
      workCode: 'PL-281',
      station: 'Churchgate',
      requesterName: 'Amit Patil',
      requesterPhone: null,
      priority: 'critical',
      requiredBy: null,
      faultSummary: 'Replace failed platform display power supplies',
      operationalImpact: null,
      deliveryInstructions: null,
      status: 'partially_dispatched',
      approvalComment: 'Approved against available maintenance stock',
      createdAt: '2026-08-15T08:30:00.000Z',
    },
    lines: [line()],
    dispatches: [],
    returns: [],
    canClose: false,
    ...overrides,
  };
}

function renderCard(api: Partial<ApiClient>) {
  return render(
    <MaintenanceJobCard
      api={stubApi(api)}
      organisationId={ORG_ID}
      requestId={REQUEST_ID}
      canModify
      canApprove
      canIssue
      onBack={() => undefined}
    />,
  );
}

describe('the approval card', () => {
  it('sends the comment somebody actually typed', async () => {
    const approveMaintenanceRequest = vi.fn().mockResolvedValue(detail());
    renderCard({
      getMaintenanceRequest: vi.fn().mockResolvedValue(
        detail({
          request: {
            ...detail().request,
            status: 'awaiting_approval',
            approvalComment: null,
          },
        }),
      ),
      approveMaintenanceRequest,
    });

    const comment = await screen.findByLabelText('Approval comment');
    fireEvent.change(comment, {
      target: { value: 'Two boards are dark; issue today' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Approve request/ }));

    await waitFor(() => {
      expect(approveMaintenanceRequest).toHaveBeenCalledWith(ORG_ID, REQUEST_ID, {
        comment: 'Two boards are dark; issue today',
      });
    });
  });

  it('shows no approval card once the request is approved', async () => {
    renderCard({ getMaintenanceRequest: vi.fn().mockResolvedValue(detail()) });
    await screen.findByRole('heading', {
      name: 'Replace failed platform display power supplies',
    });
    expect(screen.queryByRole('heading', { name: 'Admin approval' })).toBeNull();
  });
});

describe('the write-off panel', () => {
  it('sends the reason and NO quantity — the balance is the server’s to know', async () => {
    const cancelMaintenanceLine = vi.fn().mockResolvedValue(detail());
    renderCard({
      getMaintenanceRequest: vi.fn().mockResolvedValue(detail()),
      cancelMaintenanceLine,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Write off' }));
    fireEvent.change(screen.getByLabelText(/not being sent/), {
      target: { value: 'Site sourced the balance locally' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Write off the balance' }));

    await waitFor(() => {
      expect(cancelMaintenanceLine).toHaveBeenCalledWith(ORG_ID, REQUEST_ID, LINE_ID, {
        reason: 'Site sourced the balance locally',
      });
    });
  });

  it('offers no write-off on a line that is already settled', async () => {
    renderCard({
      getMaintenanceRequest: vi.fn().mockResolvedValue(
        detail({
          lines: [
            line({
              outstandingQuantity: '0.000',
              dispatchedQuantity: '4.000',
              returnDueQuantity: '0.000',
              resolved: true,
            }),
          ],
        }),
      ),
    });
    await screen.findByText('Settled');
    expect(screen.queryByRole('button', { name: 'Write off' })).toBeNull();
  });
});

describe('dates on an immutable record', () => {
  it('omits the dispatch date the operator never touched', async () => {
    const recordMaintenanceDispatch = vi.fn().mockResolvedValue(detail());
    renderCard({
      getMaintenanceRequest: vi.fn().mockResolvedValue(detail()),
      recordMaintenanceDispatch,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch' }));
    fireEvent.change(screen.getByLabelText(/Quantity of 24 V 10 A SMPS/), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('Stock location'), {
      target: { value: 'Central store' },
    });
    fireEvent.change(screen.getByLabelText('Site receiver'), {
      target: { value: 'Site supervisor' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create dispatch & challan/ }));

    await waitFor(() => {
      expect(recordMaintenanceDispatch).toHaveBeenCalled();
    });
    const [, , body] = recordMaintenanceDispatch.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    // The browser clock is not the authority on a date printed on a
    // challan: with the field untouched the server dates it by the
    // ORGANISATION's today.
    expect(body).not.toHaveProperty('dispatchDate');
    expect(body.lines).toEqual([{ lineId: LINE_ID, quantity: '2' }]);
  });

  it('sends the dispatch date the operator did set', async () => {
    const recordMaintenanceDispatch = vi.fn().mockResolvedValue(detail());
    renderCard({
      getMaintenanceRequest: vi.fn().mockResolvedValue(detail()),
      recordMaintenanceDispatch,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch' }));
    fireEvent.change(screen.getByLabelText(/Quantity of 24 V 10 A SMPS/), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('Stock location'), {
      target: { value: 'Central store' },
    });
    fireEvent.change(screen.getByLabelText('Site receiver'), {
      target: { value: 'Site supervisor' },
    });
    fireEvent.change(screen.getByLabelText('Dispatch date'), {
      target: { value: '2026-08-16' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create dispatch & challan/ }));

    await waitFor(() => {
      expect(recordMaintenanceDispatch).toHaveBeenCalled();
    });
    const [, , body] = recordMaintenanceDispatch.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(body.dispatchDate).toBe('2026-08-16');
  });

  it('keeps the quantities an operator typed when the dispatch is refused', async () => {
    const recordMaintenanceDispatch = vi
      .fn()
      .mockRejectedValue(new Error('the shelf ran out'));
    renderCard({
      getMaintenanceRequest: vi.fn().mockResolvedValue(detail()),
      recordMaintenanceDispatch,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch' }));
    const quantity = screen.getByLabelText(/Quantity of 24 V 10 A SMPS/);
    fireEvent.change(quantity, { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Stock location'), {
      target: { value: 'Central store' },
    });
    fireEvent.change(screen.getByLabelText('Site receiver'), {
      target: { value: 'Site supervisor' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create dispatch & challan/ }));

    await waitFor(() => {
      expect(recordMaintenanceDispatch).toHaveBeenCalled();
    });
    // A refusal on one line used to blank every input on the form, so the
    // operator retyped the ones that were right.
    await waitFor(() => {
      expect((quantity as HTMLInputElement).value).toBe('2');
    });
  });
});
