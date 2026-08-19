// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReceivedRailwayBill } from '@auto-mb/contracts';
import { RailwayBillPanel } from '../../src/views/RailwayBillPanel.js';
import { billableBook, ORG_ID, stubApi, WORK_ID } from './helpers.js';

/**
 * The railway-bill panel.
 *
 * Every await here resolves against something that exists ONLY once the
 * bills have arrived — the bill number, the empty sentence, the refusal.
 * The panel renders its own heading in the loading state too, so awaiting
 * "Railway bill" would resolve against the skeleton and leave the next
 * line racing the mock. That is the failure `masters-settings.test.tsx`
 * shipped and CI caught during wave 2, and it passes locally every time.
 */

function bill(overrides: Partial<ReceivedRailwayBill> = {}): ReceivedRailwayBill {
  return {
    id: 'bill-1',
    workId: WORK_ID,
    measurementBookId: billableBook().id,
    measurementBookNumber: 'DCW-1-MB-01',
    billNumber: 'CR/BBY/S&T/2026/0009/B1',
    billDate: '2026-05-11',
    billAmount: '24516112.00',
    rateInclusiveOfGst: true,
    measurementNumber: '00341490147964/CSTM/1139316/OAM/FL2/01',
    measurementSequence: 1,
    agreementNumber: 'CR/BBY/S&T/2026/0009',
    letterNumber: '00341490147964',
    originalFilename: 'bill.pdf',
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    signatureStatus: 'signed_and_intact',
    signatureVerdict: null,
    settleable: true,
    settlementRefusal: null,
    settlementRefusalDetail: null,
    discardedAt: null,
    createdAt: '2026-05-11T10:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(api: ReturnType<typeof stubApi>, closed = false) {
  return render(
    <RailwayBillPanel
      api={api}
      organisationId={ORG_ID}
      workId={WORK_ID}
      book={billableBook(closed ? { closedAt: '2026-05-14T08:00:00.000Z' } : {})}
      canIssue
      canCancel
      onClosed={async () => {
        await Promise.resolve();
      }}
    />,
  );
}

describe('the railway bill panel', () => {
  it('offers the upload, and sends only the file', async () => {
    const uploadReceivedRailwayBill = vi
      .fn<ReturnType<typeof stubApi>['uploadReceivedRailwayBill']>()
      .mockResolvedValue(bill());
    const api = stubApi({
      listReceivedRailwayBills: vi.fn().mockResolvedValue([]),
      uploadReceivedRailwayBill,
    });
    renderPanel(api);

    const input = await screen.findByLabelText('On-Account Bill PDF');
    // There is no field to type a bill number, date or amount into: the
    // server reads every fact out of the uploaded bill itself.
    expect(screen.queryByLabelText(/bill number/i)).toBeNull();
    const file = new File(['%PDF-1.7'], 'B1.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    // Submitted through the form rather than the button: jsdom's own
    // constraint validation does not see the file list this test injects,
    // and would block a click on a form carrying a required file input.
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(uploadReceivedRailwayBill).toHaveBeenCalledWith(
        ORG_ID,
        billableBook().id,
        file,
        'B1.pdf',
      );
    });
    // Four arguments and no fifth: there is no bill number, date or amount
    // for a caller to assert, because the server reads them off the page.
    expect(uploadReceivedRailwayBill.mock.calls[0]).toHaveLength(4);
  });

  it('shows a recorded bill and lets a settleable one close the measurement', async () => {
    const closeMeasurementBook = vi
      .fn<ReturnType<typeof stubApi>['closeMeasurementBook']>()
      .mockResolvedValue({
        book: billableBook(),
        sources: [],
        lines: [],
        warnings: [],
        previewTotal: null,
        unbillableVariationExposure: '0.00',
        measurementAdjustedAway: '0.00',
      });
    const api = stubApi({
      listReceivedRailwayBills: vi.fn().mockResolvedValue([bill()]),
      closeMeasurementBook,
    });
    renderPanel(api);

    expect(await screen.findByText('CR/BBY/S&T/2026/0009/B1')).toBeTruthy();
    expect(screen.getByText('11 May 2026')).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Close measurement' });
    expect(close.hasAttribute('disabled')).toBe(false);
    fireEvent.click(close);
    await waitFor(() => {
      expect(closeMeasurementBook).toHaveBeenCalledWith(ORG_ID, billableBook().id);
    });
  });

  it('will not offer closure on a bill the gate refuses, and says why', async () => {
    const api = stubApi({
      listReceivedRailwayBills: vi.fn().mockResolvedValue([
        bill({
          signatureStatus: 'signed_but_untrusted_chain',
          settleable: false,
          settlementRefusal: 'document_status',
          settlementRefusalDetail:
            "The bill's signature verdict is signed_but_untrusted_chain.",
        }),
      ]),
    });
    renderPanel(api);

    expect(
      await screen.findByText(/signature verdict is signed_but_untrusted_chain/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Close measurement' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('reports a closed measurement rather than offering to close it again', async () => {
    const api = stubApi({
      listReceivedRailwayBills: vi.fn().mockResolvedValue([bill()]),
    });
    renderPanel(api, true);

    expect(
      await screen.findByText(/The railway settled this measurement on/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close measurement' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard this bill' })).toBeNull();
  });

  it('surfaces a refusal from the server instead of swallowing it', async () => {
    const api = stubApi({
      listReceivedRailwayBills: vi.fn().mockResolvedValue([]),
      uploadReceivedRailwayBill: vi
        .fn()
        .mockRejectedValue(new Error('The bill has no readable text layer.')),
    });
    renderPanel(api);

    const input = await screen.findByLabelText('On-Account Bill PDF');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'scan.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'no readable text layer',
    );
  });
});
