// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BillPayment, BillSettlementPosition } from '@auto-mb/contracts';
import { WorkBillSettlement } from '../../src/views/WorkBillSettlement.js';
import { ORG_ID, WORK_ID, openForm, stubApi, submitButton } from './helpers.js';

/**
 * The register that keeps money the railway KEPT apart from money that
 * never arrived.
 *
 * Every await below resolves against something that exists only once the
 * position has arrived — a rupee figure, the empty sentence, the refusal.
 * The panel renders its own heading beside nothing during loading, but the
 * discipline is the same one `railway-bill-panel.test.tsx` states: anchor
 * on loaded-only content, never on a static heading, or the assertion
 * after it races the mocked promise (§2.7 of the improvement programme).
 */

const BILL_ID = '3f2c1b70-1d2e-4b8a-9c3d-5e6f70819203';
const PAYMENT_ID = '4a3d2c81-2e3f-4c9b-8d4e-6f7081920314';

function payment(overrides: Partial<BillPayment> = {}): BillPayment {
  return {
    id: PAYMENT_ID,
    billId: BILL_ID,
    receivedOn: '2026-06-01',
    receivedAmount: '470000.00',
    reference: 'UTR-0001',
    remarks: null,
    deductions: [
      {
        id: '5b4e3d92-3f40-4dac-9e5f-708192031425',
        category: 'GST_TDS',
        amount: '10000.00',
        description: null,
      },
      {
        id: '6c5f4ea3-4051-4ebd-8f60-819203142536',
        category: 'SECURITY_DEPOSIT',
        amount: '20000.00',
        description: null,
      },
    ],
    deductionTotal: '30000.00',
    grossAmount: '500000.00',
    voidedAt: null,
    voidReason: null,
    createdAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function position(
  overrides: Partial<BillSettlementPosition> = {},
): BillSettlementPosition {
  return {
    billId: BILL_ID,
    workId: WORK_ID,
    billNumber: 1,
    status: 'submitted',
    preparedAmount: '1000000.00',
    measurementBookId: '7d60518b-5162-4fce-9071-920314253647',
    measurementBookNumber: 'PL270-MB-01',
    measurementClosedAt: '2026-05-11T06:00:00.000Z',
    receivedRailwayBillId: '8e716290-6273-4a0f-8182-031425364758',
    railwayBillNumber: 'CR/BBY/S&T/2026/0009/B1',
    railwayBillDate: '2026-05-11',
    railwayBillAmount: '1000000.00',
    receivedTotal: '470000.00',
    deductionTotal: '30000.00',
    outstandingAmount: '500000.00',
    payments: [payment()],
    ...overrides,
  };
}

function renderPanel(api: ReturnType<typeof stubApi>) {
  return render(
    <WorkBillSettlement
      api={api}
      organisationId={ORG_ID}
      workId={WORK_ID}
      canIssue
      canCancel
    />,
  );
}

describe('outstanding with the railway', () => {
  it('reports received, deducted and outstanding as three separate figures', async () => {
    const api = stubApi({
      listBillSettlement: vi.fn().mockResolvedValue([position()]),
    });
    renderPanel(api);

    // Anchored on the receipt's own reference: it is in the register and
    // nowhere near the loading branch.
    expect(await screen.findByText('UTR-0001')).toBeTruthy();

    // The load-bearing claim of the whole pack, on screen: ₹4,70,000
    // arrived, ₹30,000 was kept, and ₹5,00,000 — not ₹5,30,000 — is what
    // the operator chases. A register that showed one net figure would
    // report this bill as short by its own statutory deductions forever.
    // The claimed figure and the date it was claimed on are now a tile and
    // its hint rather than one run of text, so they are read separately.
    expect(screen.getByText('Railway bill CR/BBY/S&T/2026/0009/B1')).toBeTruthy();
    expect(screen.getByText('₹10,00,000.00')).toBeTruthy();
    expect(screen.getByText('Dated 11 May 2026')).toBeTruthy();
    expect(screen.getByText('₹30,000.00')).toBeTruthy();
    // Twice each, and deliberately so: the position states the total and
    // the receipt row states its own share of it.
    expect(screen.getAllByText('₹4,70,000.00')).toHaveLength(2);
    expect(screen.getAllByText('₹5,00,000.00')).toHaveLength(2);
    // The breakup is named head by head, not summed into one figure.
    expect(
      screen.getByText('GST TDS ₹10,000.00, Retention / SD ₹20,000.00'),
    ).toBeTruthy();
  });

  it('offers no receipt form while the railway has not settled the measurement', async () => {
    const api = stubApi({
      listBillSettlement: vi.fn().mockResolvedValue([
        position({
          measurementBookNumber: 'PL270-MB-02',
          measurementClosedAt: null,
          receivedRailwayBillId: null,
          railwayBillNumber: null,
          railwayBillDate: null,
          railwayBillAmount: null,
          receivedTotal: '0.00',
          deductionTotal: '0.00',
          outstandingAmount: null,
          payments: [],
        }),
      ]),
    });
    renderPanel(api);

    expect(
      await screen.findByText(/no agreed amount to be outstanding against/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New receipt/ })).toBeNull();
  });

  it('sends only the deduction heads that were filled in', async () => {
    const recordBillPayment = vi.fn().mockResolvedValue(payment());
    const api = stubApi({
      listBillSettlement: vi.fn().mockResolvedValue([position({ payments: [] })]),
      recordBillPayment,
    });
    renderPanel(api);

    // The form opens on arrival because the register is empty, so this
    // await lands on a field that exists only after the load.
    const amount = await screen.findByLabelText('Amount credited');
    fireEvent.change(screen.getByLabelText('Received on'), {
      target: { value: '2026-06-01' },
    });
    fireEvent.change(amount, { target: { value: '470000.00' } });
    fireEvent.change(screen.getByLabelText('GST TDS'), {
      target: { value: '10000.00' },
    });
    fireEvent.click(submitButton('Record receipt'));

    await waitFor(() => {
      expect(recordBillPayment).toHaveBeenCalledWith(ORG_ID, BILL_ID, {
        receivedOn: '2026-06-01',
        receivedAmount: '470000.00',
        // A blank money field is a head that does not appear on this
        // advice, not a deduction of zero — so the three untouched heads
        // and the Other row are absent rather than present at nil.
        deductions: [{ category: 'GST_TDS', amount: '10000.00' }],
      });
    });
  });

  it('withdraws a receipt only through a confirmation carrying the reason', async () => {
    const voidBillPayment = vi
      .fn()
      .mockResolvedValue(payment({ voidedAt: '2026-06-02T00:00:00.000Z' }));
    const api = stubApi({
      listBillSettlement: vi.fn().mockResolvedValue([position()]),
      voidBillPayment,
    });
    renderPanel(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const reason = screen.getByLabelText('Why it is being withdrawn');

    // The dialog will not act on an unwritten reason: withdrawing a
    // recorded receipt of money is never self-evident from the record.
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw receipt' }));
    expect(voidBillPayment).not.toHaveBeenCalled();

    fireEvent.change(reason, { target: { value: 'Credited against the wrong bill' } });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw receipt' }));
    await waitFor(() => {
      expect(voidBillPayment).toHaveBeenCalledWith(
        ORG_ID,
        PAYMENT_ID,
        'Credited against the wrong bill',
      );
    });
  });

  it('closes the register in both directions once the bill is paid', async () => {
    // A paid bill takes no further receipts and gives none back, so
    // neither control is offered. Both used to render, and both led to
    // the same 409 — a button whose only outcome is a refusal is worse
    // than no button, because it reads as something the operator did
    // wrong.
    const api = stubApi({
      listBillSettlement: vi.fn().mockResolvedValue([
        position({
          status: 'paid',
          receivedTotal: '940000.00',
          deductionTotal: '60000.00',
          outstandingAmount: '0.00',
        }),
      ]),
    });
    renderPanel(api);

    expect(await screen.findByText('UTR-0001')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New receipt/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('holds the withdrawal until a reason is written, and says why', async () => {
    const voidBillPayment = vi.fn();
    const api = stubApi({
      listBillSettlement: vi.fn().mockResolvedValue([position()]),
      voidBillPayment,
    });
    renderPanel(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const confirm = screen.getByRole('button', { name: 'Withdraw receipt' });
    expect(confirm).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText('Why it is being withdrawn'), {
      target: { value: 'no' },
    });
    // Too short is a visible refusal rather than a dead button: the field
    // states the rule and the control stays held.
    expect(
      screen.getByText(/A reason of at least three characters is required/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Withdraw receipt' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(voidBillPayment).not.toHaveBeenCalled();
  });

  it('says why a withdrawn receipt was withdrawn', async () => {
    // The reason is the whole point of withdrawing rather than deleting,
    // and "(voided)" on its own hid it.
    const api = stubApi({
      listBillSettlement: vi.fn().mockResolvedValue([
        position({
          receivedTotal: '0.00',
          deductionTotal: '0.00',
          outstandingAmount: '1000000.00',
          payments: [
            payment({
              voidedAt: '2026-06-02T00:00:00.000Z',
              voidReason: 'Credited against the wrong bill',
            }),
          ],
        }),
      ]),
    });
    renderPanel(api);
    expect(
      await screen.findByText(/Withdrawn: Credited against the wrong bill/),
    ).toBeTruthy();
  });

  it('opens the form behind a verb that is not the submit button', async () => {
    const api = stubApi({
      listBillSettlement: vi.fn().mockResolvedValue([position()]),
    });
    renderPanel(api);
    // A position that already has a receipt keeps its form closed, so the
    // disclosure has to be opened by name — and the name is deliberately
    // not "Record receipt".
    expect(await screen.findByText('UTR-0001')).toBeTruthy();
    await openForm('New receipt against bill #1');
    expect(screen.getByLabelText('Amount credited')).toBeTruthy();
  });
});
