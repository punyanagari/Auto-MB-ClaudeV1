// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PurchaseOrderDetailResponse } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../../src/api.js';
import { WorkDetail } from '../../src/views/WorkDetail.js';
import {
  submitButton,
  stubApi,
  ORG_ID,
  WORK_ID,
  CHALLAN_ID,
  ITEM_A,
  challanDetail,
  challanWork,
  openWorkTab,
  VENDOR_CONTACT_ID,
  PO_ID,
  VENDOR_CONTACT,
  purchaseOrder,
  purchaseOrderDetail,
} from './helpers.js';

describe('WorkDetail retention', () => {
  const SCHEDULE_ID = '77777777-7777-4777-8777-777777777777';
  const WORK_DETAIL = {
    work: {
      id: WORK_ID,
      workCode: 'DCW-1',
      letterNumber: 'L-42/2025',
      letterDate: '2025-06-01',
      title: 'Supply of switchboards',
      advertisedValue: '1000.00',
      contractValue: '900.00',
      pricingShape: 'per_schedule',
      letterPercentage: null,
      letterPercentageDirection: null,
      status: 'active',
      createdAt: '2026-08-08T00:00:00.000Z',
    },
    schedules: [
      {
        id: SCHEDULE_ID,
        scheduleCode: 'A',
        title: 'Schedule A',
        position: 1,
        items: [
          {
            id: ITEM_A,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/1',
            description: 'Main switchboard',
            unitCode: 'Nos',
            awardedQuantity: '5.000',
            effectiveRate: '100.00',
            requiresSerials: false,
          },
        ],
      },
    ],
    installationCounts: { recorded: 0, cancelled: 0 },
    measurementBookCount: 0,
    taxInvoiceCount: 0,
  };

  const ISSUED_CHALLAN = {
    ...challanDetail({
      status: 'issued',
      challanNumber: 'DC/1',
      sequenceNumber: 1,
      issuedAt: '2026-08-08T10:00:00.000Z',
    }).challan,
  };

  const INSTRUMENT = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workId: WORK_ID,
    kind: 'pbg' as const,
    reference: 'BG/22',
    amount: '45000.00',
    issuedOn: '2026-01-10',
    expiresOn: '2026-09-15',
    status: 'active' as const,
    notes: null,
    createdAt: '2026-01-10T00:00:00.000Z',
  };

  const MB_ENTRY = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workItemId: ITEM_A,
    itemNumber: 'A/1',
    deliveryChallanId: CHALLAN_ID,
    measuredQuantity: '2.000',
    measuredOn: '2026-08-01',
    mbBookRef: 'MB-12/34',
    remarks: null,
    billId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  };

  const BILL = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    workId: WORK_ID,
    billNumber: 1,
    status: 'prepared' as const,
    totalAmount: '200.00',
    linesSnapshot: [
      {
        workItemId: ITEM_A,
        itemNumber: 'A/1',
        unitCode: 'Nos',
        quantity: '2.000',
        rate: '100.00',
        amount: '200.00',
      },
    ],
    createdAt: '2026-08-02T00:00:00.000Z',
    submittedAt: null,
    paidAt: null,
  };

  /** What the bills read serves beside the list: the Work's position,
   * summed in SQL numeric. 4.2 Cr measured, 1.2 Cr of it claimed. */
  const BILLING = {
    measured: '42000000.00',
    billed: '12000000.00',
    unbilled: '30000000.00',
  };

  function renderWorkDetail(
    api: ApiClient,
    flags: Partial<{
      canModify: boolean;
      canRecordEvidence: boolean;
      canIssue: boolean;
      canCancel: boolean;
      canApprove: boolean;
      isOwner: boolean;
    }> = {},
  ) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={flags.canModify ?? true}
        canRecordEvidence={flags.canRecordEvidence ?? true}
        canIssue={flags.canIssue ?? true}
        canSign={false}
        canCancel={flags.canCancel ?? true}
        canApprove={flags.canApprove ?? false}
        canManageStatutory={true}
        canManageRetention={true}
        isOwner={flags.isOwner ?? false}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  function retentionApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      getWork: vi.fn().mockResolvedValue(WORK_DETAIL),
      listChallans: vi.fn().mockResolvedValue([ISSUED_CHALLAN]),
      listInstruments: vi.fn().mockResolvedValue([INSTRUMENT]),
      listMbEntries: vi.fn().mockResolvedValue([MB_ENTRY]),
      listBills: vi.fn().mockResolvedValue({ bills: [BILL], summary: BILLING }),
      listWorkSerials: vi.fn().mockResolvedValue([]),
      ...overrides,
    });
  }

  it('keeps the Work open when one supporting register fails', async () => {
    const listBills = vi
      .fn()
      .mockRejectedValueOnce(new Error('Bills unavailable.'))
      .mockResolvedValue({ bills: [BILL], summary: BILLING });
    const api = retentionApi({
      listBills,
    });
    renderWorkDetail(api);

    expect(
      await screen.findByRole('heading', {
        name: /DCW-1.*Supply of switchboards/,
      }),
    ).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Some Work sections could not be loaded: bills.',
    );
    expect(screen.getByText('L-42/2025', { exact: false })).toBeTruthy();

    await openWorkTab('Bills');
    expect(
      await screen.findByText(
        /This section is unavailable because bills could not be loaded/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText('No bills prepared yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark submitted' })).toBeNull();

    await openWorkTab('Measurement');
    expect(await screen.findByText('MB-12/34')).toBeTruthy();
    await openWorkTab('Bills');
    fireEvent.click(screen.getByRole('button', { name: 'Retry supporting sections' }));
    expect(await screen.findByRole('heading', { name: /Bill #1/ })).toBeTruthy();
    expect(listBills).toHaveBeenCalledTimes(2);
    expect(api.getWork).toHaveBeenCalledTimes(1);
    expect(api.listInstruments).toHaveBeenCalledTimes(1);
  });

  it('keeps loaded Challans open when correction notices fail', async () => {
    const api = retentionApi({
      listWorkCorrectionNotices: vi
        .fn()
        .mockRejectedValue(new Error('Correction notices unavailable.')),
    });
    renderWorkDetail(api);

    await openWorkTab('Deliveries');

    expect(await screen.findByRole('link', { name: 'DC/1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Delivery Challan' })).toBeTruthy();
    expect(
      screen.getByText('Correction notices could not be loaded. Try again later.'),
    ).toBeTruthy();
  });

  it('does not turn an unavailable Challan register into an empty, creatable list', async () => {
    const api = retentionApi({
      listChallans: vi.fn().mockRejectedValue(new Error('Challans unavailable.')),
    });
    renderWorkDetail(api);

    expect(
      await screen.findByRole('heading', {
        name: /DCW-1.*Supply of switchboards/,
      }),
    ).toBeTruthy();
    await openWorkTab('Deliveries');

    expect(
      await screen.findByText(/Delivery Challans could not be loaded/),
    ).toBeTruthy();
    expect(screen.queryByText('No Delivery Challans yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New Delivery Challan' })).toBeNull();
    // The site evidence is a tab of its own now, and an unreadable challan
    // register does not close it.
    expect(screen.queryByRole('heading', { name: 'Installations' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Serial trace' })).toBeNull();

    await openWorkTab('Installations');
    expect(await screen.findByText('No installations recorded yet.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Installations' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Serial trace' })).toBeTruthy();
  });

  it('keeps the installation records and the serial trace on their own tab', async () => {
    const api = retentionApi();
    renderWorkDetail(api);

    await openWorkTab('Deliveries');
    expect(await screen.findByRole('link', { name: 'DC/1' })).toBeTruthy();
    // Deliveries is the movement documents alone.
    expect(screen.queryByRole('heading', { name: 'Installations' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Serial trace' })).toBeNull();

    await openWorkTab('Installations');
    expect(await screen.findByText('No installations recorded yet.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Serial trace' })).toBeTruthy();
    // …and the challan register does not follow it there.
    expect(screen.queryByRole('link', { name: 'DC/1' })).toBeNull();
  });

  /* The Installations tab's badge and tiles used to come from the record
     list, which expands every record's serials — so every Work open paid
     for a serial-joined query to print two integers, and the same query
     ran again when the tab was opened. The tally rides on the Work read
     now, and the list belongs to the tab. */
  it('counts the installation records without reading them', async () => {
    const listWorkInstallations = vi
      .fn()
      .mockResolvedValue({ installations: [], itemSummaries: [], nextCursor: null });
    const api = retentionApi({
      getWork: vi.fn().mockResolvedValue({
        ...WORK_DETAIL,
        installationCounts: { recorded: 4, cancelled: 1 },
      }),
      listWorkInstallations,
    });
    renderWorkDetail(api);

    const tabs = await screen.findByRole('navigation', { name: 'Work sections' });
    // 4 recorded + 1 cancelled, on the badge, with no record read behind it.
    expect(
      within(tabs).getByRole('button', {
        name: (name: string) => name.startsWith('Installations'),
      }).textContent,
    ).toContain('5');
    expect(listWorkInstallations).not.toHaveBeenCalled();

    await openWorkTab('Installations');
    await screen.findByText('No installations recorded yet.');
    // Opened once by the tab itself — not twice, and not before.
    expect(listWorkInstallations).toHaveBeenCalledTimes(1);
  });

  it('moves the tally when a record is cancelled, without reloading the page', async () => {
    const INSTALLATION = {
      id: '5f1c9a52-0000-4000-8000-0000000000f1',
      workId: WORK_ID,
      workItemId: ITEM_A,
      itemNumber: 'A/1',
      quantity: '1.000',
      installedOn: '2026-08-05',
      locationId: '5f1c9a52-0000-4000-8000-0000000000f2',
      locationName: 'Nashik Road station',
      remarks: null,
      status: 'recorded',
      cancellationNote: null,
      serials: [],
      createdAt: '2026-08-05T00:00:00.000Z',
      cancelledAt: null,
    };
    const listWorkInstallations = vi
      .fn()
      .mockResolvedValueOnce({
        installations: [INSTALLATION],
        itemSummaries: [],
        nextCursor: null,
      })
      .mockResolvedValue({
        installations: [{ ...INSTALLATION, status: 'cancelled' }],
        itemSummaries: [],
        nextCursor: null,
      });
    const api = retentionApi({
      getWork: vi.fn().mockResolvedValue({
        ...WORK_DETAIL,
        installationCounts: { recorded: 1, cancelled: 0 },
      }),
      listWorkInstallations,
      listLocationMasters: vi.fn().mockResolvedValue([]),
      cancelWorkInstallation: vi
        .fn()
        .mockResolvedValue({ ...INSTALLATION, status: 'cancelled' }),
    });
    renderWorkDetail(api);

    await openWorkTab('Installations');
    fireEvent.change(await screen.findByLabelText(/Cancellation note for A\/1/), {
      target: { value: 'Recorded against the wrong run' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel record' }));

    const tabs = await screen.findByRole('navigation', { name: 'Work sections' });
    await waitFor(() => {
      expect(
        within(tabs).getByRole('button', {
          name: (name: string) => name.startsWith('Installations'),
        }).textContent,
      ).toContain('1');
    });
    // The tile moved with it: nothing recorded, one cancelled.
    await openWorkTab('Overview');
    await waitFor(() => {
      expect(screen.getByText('Cancelled').parentElement?.textContent).toContain('1');
    });
    // …and the Work itself was read once, at open.
    expect(api.getWork).toHaveBeenCalledTimes(1);
  });

  it('counts Measurement Books and tax invoices on their badges without reading them', async () => {
    // The regression this pins: a Work with one formal Measurement Book and
    // no loose evidence entries showed a Measurement badge of 0, because the
    // badge counted only the entries — the books render inside their tab
    // from their own read. Same shape on Bills with tax invoices.
    const listWorkMeasurementBooks = vi.fn().mockResolvedValue({ books: [] });
    const listWorkTaxInvoices = vi.fn().mockResolvedValue([]);
    const api = retentionApi({
      getWork: vi.fn().mockResolvedValue({
        ...WORK_DETAIL,
        measurementBookCount: 2,
        taxInvoiceCount: 3,
      }),
      listWorkMeasurementBooks,
      listWorkTaxInvoices,
    });
    renderWorkDetail(api);

    const tabs = await screen.findByRole('navigation', { name: 'Work sections' });
    // The fixture carries 1 loose entry and 1 bill, so the badges must read
    // 1 + 2 books = 3 and 1 + 3 invoices = 4 — with neither list read.
    expect(
      within(tabs).getByRole('button', {
        name: (name: string) => name.startsWith('Measurement'),
      }).textContent,
    ).toContain('3');
    expect(
      within(tabs).getByRole('button', {
        name: (name: string) => name.startsWith('Bills'),
      }).textContent,
    ).toContain('4');
    expect(listWorkMeasurementBooks).not.toHaveBeenCalled();
    expect(listWorkTaxInvoices).not.toHaveBeenCalled();
  });

  it('keeps stage-wise Measurement Books open when loose entries fail', async () => {
    const api = retentionApi({
      listMbEntries: vi.fn().mockRejectedValue(new Error('Entries unavailable.')),
    });
    renderWorkDetail(api);

    await openWorkTab('Measurement');

    expect(
      await screen.findByText(/Measurement evidence could not be loaded/),
    ).toBeTruthy();
    expect(screen.queryByText('No measurements recorded yet.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Measurement Books' })).toBeTruthy();
  });

  it('offers Generate PDF for an unrendered correction notice on the Work page', async () => {
    const NOTICE_ID = 'bbbb4444-4444-4444-8444-444444444444';
    const notice = {
      id: NOTICE_ID,
      workId: WORK_ID,
      deliveryChallanId: CHALLAN_ID,
      approvalRequestId: '99999999-9999-4999-8999-999999999999',
      noticeNumber: 'DCW-1-CN-01',
      sequenceNumber: 1,
      status: 'issued' as const,
      templateVersion: 'correction-notice-v1',
      renderedAvailable: false,
      cancellationNote: null,
      createdAt: '2026-08-09T00:00:00.000Z',
      cancelledAt: null,
    };
    const renderCorrectionNotice = vi.fn().mockResolvedValue({});
    const listWorkCorrectionNotices = vi
      .fn()
      .mockResolvedValueOnce([notice])
      .mockResolvedValue([{ ...notice, renderedAvailable: true }]);
    const api = retentionApi({ renderCorrectionNotice, listWorkCorrectionNotices });
    renderWorkDetail(api);
    await openWorkTab('Deliveries');

    // A fresh notice is born unrendered: the Work page offers the render
    // action rather than a dead-end "not rendered".
    fireEvent.click(await screen.findByRole('button', { name: 'Generate PDF' }));
    await waitFor(() => {
      expect(renderCorrectionNotice).toHaveBeenCalledWith(ORG_ID, NOTICE_ID);
    });
    expect(await screen.findByRole('button', { name: 'Open PDF' })).toBeTruthy();
  });

  it('shows no render action for correction notices without modify rights', async () => {
    const api = retentionApi({
      listWorkCorrectionNotices: vi.fn().mockResolvedValue([
        {
          id: 'bbbb4444-4444-4444-8444-444444444444',
          workId: WORK_ID,
          deliveryChallanId: CHALLAN_ID,
          approvalRequestId: '99999999-9999-4999-8999-999999999999',
          noticeNumber: 'DCW-1-CN-01',
          sequenceNumber: 1,
          status: 'issued' as const,
          templateVersion: 'correction-notice-v1',
          renderedAvailable: false,
          cancellationNote: null,
          createdAt: '2026-08-09T00:00:00.000Z',
          cancelledAt: null,
        },
      ]),
    });
    renderWorkDetail(api, { canModify: false });
    await openWorkTab('Deliveries');
    expect(await screen.findByText('DCW-1-CN-01')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate PDF' })).toBeNull();
    expect(screen.getByText('not rendered')).toBeTruthy();
  });

  it('shows the measurement register read-only and points at the books', async () => {
    // The manual write path is gone (2026-08-19, owner-sanctioned): the
    // register still lists what was recorded, and the only route to a new
    // measurement is the Measurement Book below it.
    const api = retentionApi();
    renderWorkDetail(api);
    await openWorkTab('Measurement');

    expect(await screen.findByText('A/1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New measurement' })).toBeNull();
    expect(screen.queryByLabelText('Measured quantity')).toBeNull();
    expect(
      screen.getByText(/New measurement is recorded in a Measurement Book/),
    ).toBeTruthy();
  });

  it('draws the billing position from the server summary, never from the list', async () => {
    const api = retentionApi();
    renderWorkDetail(api);
    await openWorkTab('Bills');

    // Compact rupees through the shared `formatCompactInr`, which is
    // what the mock's `formatINR(value, true)` ports to here
    // (Auto-MB-Vercel-du app/works/[code]/page.tsx at fdfe5ef).
    const measured = (await screen.findByText('Measured')).parentElement;
    expect(measured?.textContent).toContain('₹4.2 Cr');
    const billed = screen.getByText('Billed').parentElement;
    expect(billed?.textContent).toContain('₹1.2 Cr');
    const unbilled = screen.getByText('Unbilled').parentElement;
    expect(unbilled?.textContent).toContain('₹3 Cr');

    // The one bill on this Work totals 200.00. If the tiles were summed
    // in the browser from the list, Billed would say that instead — which
    // is the arithmetic AGENTS.md rule 5 forbids.
    expect(billed?.textContent).not.toContain('200.00');
  });

  it('lists bills and moves them forward; the Milestone 5 sweep button is gone', async () => {
    const setBillStatus = vi.fn().mockResolvedValue({
      ...BILL,
      status: 'submitted',
      submittedAt: '2026-08-08T11:00:00.000Z',
    });
    const listBills = vi.fn().mockResolvedValue({ bills: [BILL], summary: BILLING });
    const api = retentionApi({ setBillStatus, listBills });
    renderWorkDetail(api);
    await openWorkTab('Bills');

    expect(await screen.findByRole('heading', { name: /Bill #1/ })).toBeTruthy();
    // Bill preparation now runs from a finalized Measurement Book
    // (ADR-0006 decision 4); the sweep button no longer exists.
    expect(screen.queryByRole('button', { name: 'Prepare bill' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Mark submitted' }));
    await waitFor(() => {
      expect(setBillStatus).toHaveBeenCalledWith(ORG_ID, BILL.id, {
        status: 'submitted',
      });
    });
    expect(await screen.findByText('submitted')).toBeTruthy();
  });

  it('updates an instrument status through the forward-only transition', async () => {
    const updateInstrument = vi
      .fn()
      .mockResolvedValue({ ...INSTRUMENT, status: 'released' });
    const api = retentionApi({ updateInstrument });
    renderWorkDetail(api);
    await openWorkTab('Instruments');

    fireEvent.change(await screen.findByLabelText('New status for BG/22'), {
      target: { value: 'released' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(updateInstrument).toHaveBeenCalledWith(ORG_ID, INSTRUMENT.id, {
        status: 'released',
      });
    });
    expect(await screen.findByText('released')).toBeTruthy();
  });

  it('opens an area from the Overview summary, and the two navigations agree', async () => {
    const api = retentionApi();
    renderWorkDetail(api);

    // The summary is the Overview tab's content, so it is on screen already.
    const tabs = await screen.findByRole('navigation', { name: 'Work sections' });
    const summaryCell = screen
      .getAllByRole('button', {
        name: (name: string) => name.startsWith('Measurement'),
      })
      .find((candidate) => !tabs.contains(candidate));
    expect(summaryCell).toBeTruthy();

    fireEvent.click(summaryCell as HTMLElement);

    // Clicking the card selects the matching tab rather than opening a
    // separate surface — one architecture, not two.
    await screen.findByRole('heading', { name: 'Measurement evidence' });
    const active = within(tabs)
      .getAllByRole('button')
      .find((candidate) => candidate.getAttribute('aria-current') === 'page');
    expect(active?.textContent).toMatch(/^Measurement/);
  });

  it('hides retention forms and billing actions from read-only members', async () => {
    const api = retentionApi();
    renderWorkDetail(api, {
      canModify: false,
      canRecordEvidence: false,
      canIssue: false,
    });
    await openWorkTab('Instruments');

    await screen.findByRole('heading', { name: 'Contract instruments' });
    expect(screen.getByText('BG/22')).toBeTruthy();
    await openWorkTab('Measurement');
    expect(screen.getByText('MB-12/34')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add instrument' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record measurement' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prepare bill' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark submitted' })).toBeNull();
  });
});

describe('WorkDetail R8 completion panel', () => {
  const SCHEDULE_ID = '77777777-7777-4777-8777-777777777777';
  const ACTIVE_WORK = {
    id: WORK_ID,
    workCode: 'DCW-1',
    letterNumber: 'L-42/2025',
    letterDate: '2025-06-01',
    title: 'Supply of switchboards',
    advertisedValue: '1000.00',
    contractValue: '900.00',
    pricingShape: 'per_schedule' as const,
    letterPercentage: null,
    letterPercentageDirection: null,
    pbgRequiredAmount: null,
    pbgSubmissionDays: null,
    pbgExtensionDays: null,
    pbgPenalInterestPercent: null,
    status: 'active' as const,
    completedAt: null,
    completedByUserId: null,
    completionNote: null,
    createdAt: '2026-08-08T00:00:00.000Z',
  };
  const COMPLETED_WORK = {
    ...ACTIVE_WORK,
    status: 'completed' as const,
    completedAt: '2026-08-09T09:00:00.000Z',
    completedByUserId: 'user-a',
    completionNote: 'Everything executed and accepted at site.',
  };
  const DETAIL = {
    schedules: [
      {
        id: SCHEDULE_ID,
        scheduleCode: 'A',
        title: 'Schedule A',
        position: 1,
        items: [
          {
            id: ITEM_A,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/1',
            description: 'Main switchboard',
            unitCode: 'Nos',
            awardedQuantity: '5.000',
            effectiveRate: '100.00',
            requiresSerials: false,
          },
        ],
      },
    ],
    installationCounts: { recorded: 0, cancelled: 0 },
  };

  function renderDetail(api: ApiClient, canModify = true) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={canModify}
        canRecordEvidence
        canIssue
        canSign={false}
        canCancel
        canApprove={false}
        canManageStatutory={true}
        canManageRetention={true}
        isOwner={false}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('renders the unfinished-item worklist from the 409 details', async () => {
    const completeWork = vi.fn().mockRejectedValue(
      new RequestFailedError(
        409,
        'WORK_NOT_FULLY_EXECUTED',
        'A Work completes only at 100% executed value; 2 item(s) are not fully executed.',
        {
          unfinishedItems: [
            {
              workItemId: ITEM_A,
              itemNumber: 'A/1',
              category: 'SUPPLY_AND_INSTALLATION',
              requirement: 'delivery_and_installation',
              direction: 'short',
              requiredQuantity: '5.000',
              deliveredQuantity: '5.000',
              installedQuantity: '2.000',
            },
            {
              workItemId: '55555555-5555-4555-8555-555555555556',
              itemNumber: 'A/2',
              category: null,
              requirement: 'delivery',
              direction: 'excess',
              requiredQuantity: '3.000',
              deliveredQuantity: '4.000',
              installedQuantity: '0.000',
            },
          ],
        },
      ),
    );
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue({ work: ACTIVE_WORK, ...DETAIL }),
      completeWork,
    });
    renderDetail(api);

    await screen.findByRole('heading', { name: 'Completion status' });
    fireEvent.change(screen.getByLabelText('Why this Work is being completed'), {
      target: { value: 'Closing the contract.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Complete Work' }));

    await waitFor(() => {
      expect(completeWork).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        note: 'Closing the contract.',
      });
    });
    // The worklist is the point of the refusal: every unfinished item,
    // with what it owes, what it has, and which way its remedy runs —
    // the over-measured row must not be told to amend down.
    expect(
      await screen.findByText('Items not yet at 100% executed value'),
    ).toBeTruthy();
    expect(screen.getByText('full delivery and installation')).toBeTruthy();
    // NULL is "not selected" since migration 0105, and the Remedy column
    // is gone (2026-08-19): the row states the numbers and the operator
    // reads the direction off them.
    expect(screen.getByText('not selected')).toBeTruthy();
    expect(screen.getAllByText('2.000').length).toBeGreaterThan(0);
    expect(screen.queryByText('Remedy')).toBeNull();
    expect(screen.queryByText('short — amend the quantity down')).toBeNull();
  });

  it('names every clean-state blocker from the 409 details', async () => {
    const completeWork = vi.fn().mockRejectedValue(
      new RequestFailedError(409, 'WORK_NOT_CLEAN', 'Finish or discard these first.', {
        blockers: [
          {
            kind: 'draft_measurement_book',
            recordId: '99999999-9999-4999-8999-999999999999',
            label: 'Draft Measurement Book dated 2026-08-06',
          },
          {
            kind: 'pending_approval_request',
            recordId: '99999999-9999-4999-8999-999999999998',
            label: 'Pending change proposal (work_item_amendment)',
          },
        ],
      }),
    );
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue({ work: ACTIVE_WORK, ...DETAIL }),
      completeWork,
    });
    renderDetail(api);

    await screen.findByRole('heading', { name: 'Completion status' });
    fireEvent.change(screen.getByLabelText('Why this Work is being completed'), {
      target: { value: 'Closing the contract.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Complete Work' }));

    expect(
      await screen.findByText('Draft Measurement Book dated 2026-08-06'),
    ).toBeTruthy();
    expect(
      screen.getByText('Pending change proposal (work_item_amendment)'),
    ).toBeTruthy();
  });

  it('closes the create surfaces on a completed Work and offers the reopen', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue({ work: COMPLETED_WORK, ...DETAIL }),
    });
    renderDetail(api);

    await screen.findByRole('heading', { name: 'Completion status' });
    expect(
      screen.getByText('Completion note: Everything executed and accepted at site.'),
    ).toBeTruthy();
    // Every document-creating surface is closed until the reopen.
    expect(screen.queryByRole('button', { name: 'New Delivery Challan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New Issue Challan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record installation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit amendment' })).toBeNull();
    expect(screen.queryByLabelText('Why this Work is being completed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reopen Work' })).toBeTruthy();
  });

  it('keeps the receipt form open on a completed Work, as the server does', async () => {
    // R8 closes every create/record surface with the Work, and the
    // payment register is the one that must NOT close with it.
    // `routes/retention.ts` says so in as many words and refuses nothing:
    // recording that the railway paid moves no quantity and creates no
    // document, and payment legitimately continues for months after
    // execution finishes. Gated on `workActive`, this form disappeared
    // while the bill's own "Mark paid" stayed — so a completed Work
    // offered an action whose only precondition it had just hidden.
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue({ work: COMPLETED_WORK, ...DETAIL }),
      listBillSettlement: vi.fn().mockResolvedValue([
        {
          billId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
          workId: WORK_ID,
          billNumber: 1,
          status: 'submitted' as const,
          preparedAmount: '1000000.00',
          measurementBookId: null,
          measurementBookNumber: 'MB-01',
          measurementClosedAt: '2026-05-11T06:00:00.000Z',
          receivedRailwayBillId: null,
          railwayBillNumber: 'RB/1',
          railwayBillDate: '2026-05-11',
          railwayBillAmount: '1000000.00',
          receivedTotal: '0.00',
          deductionTotal: '0.00',
          outstandingAmount: '1000000.00',
          payments: [],
        },
      ]),
    });
    renderDetail(api);

    await screen.findByRole('heading', { name: 'Completion status' });
    // The create surfaces this Work DOES close, for contrast.
    expect(screen.queryByRole('button', { name: 'New Delivery Challan' })).toBeNull();

    await openWorkTab('Bills');
    expect(await screen.findByLabelText('Amount credited')).toBeTruthy();
  });

  it('reopens with a note and reopens the create surfaces', async () => {
    const reopenWork = vi.fn().mockResolvedValue({ work: ACTIVE_WORK });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue({ work: COMPLETED_WORK, ...DETAIL }),
      reopenWork,
    });
    renderDetail(api);
    await openWorkTab('Overview');

    await screen.findByRole('heading', { name: 'Completion status' });
    fireEvent.change(screen.getByLabelText('Why this Work is being reopened'), {
      target: { value: 'Variation order 7 sanctioned more quantity.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen Work' }));

    await waitFor(() => {
      expect(reopenWork).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        note: 'Variation order 7 sanctioned more quantity.',
      });
    });
    expect(
      await openWorkTab('Deliveries').then(() =>
        screen.findByRole('button', { name: 'New Delivery Challan' }),
      ),
    ).toBeTruthy();
  });

  it('shows the status without either form to read-only members', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue({ work: COMPLETED_WORK, ...DETAIL }),
    });
    renderDetail(api, false);

    await screen.findByRole('heading', { name: 'Completion status' });
    expect(screen.queryByRole('button', { name: 'Complete Work' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reopen Work' })).toBeNull();
  });
});

describe('WorkDetail amendments', () => {
  const SCHEDULE_ID = '77777777-7777-4777-8777-777777777777';
  const ADDED_ITEM = '88888888-8888-4888-8888-888888888888';
  const AMENDED_WORK_DETAIL = {
    work: {
      id: WORK_ID,
      workCode: 'DCW-1',
      letterNumber: 'L-42/2025',
      letterDate: '2025-06-01',
      title: 'Supply of switchboards',
      advertisedValue: '1000.00',
      contractValue: '900.00',
      pricingShape: 'per_schedule',
      letterPercentage: null,
      letterPercentageDirection: null,
      status: 'active',
      createdAt: '2026-08-08T00:00:00.000Z',
      allowExcessDelivery: false,
    },
    schedules: [
      {
        id: SCHEDULE_ID,
        scheduleCode: 'A',
        title: 'Schedule A',
        position: 1,
        items: [
          {
            id: ITEM_A,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/1',
            description: 'Main switchboard',
            unitCode: 'Nos',
            awardedQuantity: '5.000',
            effectiveRate: '100.00',
            effectiveQuantity: '8.000',
            effectiveUnitRate: '110.00',
            effectiveDescription: null,
            effectiveUnit: null,
            amendmentAdded: false,
          },
          {
            id: ADDED_ITEM,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/3',
            description: 'Lightning arrester',
            unitCode: 'Nos',
            awardedQuantity: '4.000',
            effectiveRate: '50.00',
            // No zero-quantity overlay anywhere: R12 makes a zero
            // effective quantity invalid, so the pre-R7 "quantity 0 means
            // omitted" reading has no live case left to describe.
            effectiveQuantity: null,
            effectiveUnitRate: null,
            effectiveDescription: null,
            effectiveUnit: null,
            amendmentAdded: true,
          },
        ],
      },
    ],
    installationCounts: { recorded: 0, cancelled: 0 },
  };

  function amendedApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      getWork: vi.fn().mockResolvedValue(AMENDED_WORK_DETAIL),
      ...overrides,
    });
  }

  function renderAmended(api: ApiClient, flags: { isOwner?: boolean } = {}) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={true}
        canRecordEvidence={true}
        canIssue={true}
        canSign={false}
        canCancel={true}
        canApprove={false}
        canManageStatutory={true}
        canManageRetention={true}
        isOwner={flags.isOwner ?? false}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('shows original and effective values side by side when they differ', async () => {
    renderAmended(amendedApi());
    await openWorkTab('Schedules & items');

    // Quantity 5.000 → 8.000: the original stays visible, struck through.
    // Other sections (serials, balances) may repeat the bare numbers, so
    // assert the struck-through original exists among the matches.
    expect(screen.getAllByText('5.000').some((node) => node.tagName === 'S')).toBe(
      true,
    );
    expect(screen.getAllByText('8.000').length).toBeGreaterThan(0);
    // Rate 100.00 → 110.00.
    expect(screen.getAllByText('100.00').some((node) => node.tagName === 'S')).toBe(
      true,
    );
    expect(screen.getAllByText('110.00').length).toBeGreaterThan(0);
    // Amendment-added items are flagged; omission is no longer inferred
    // from the numbers at all.
    expect(screen.getByText('added')).toBeTruthy();
    expect(screen.queryByText('omitted')).toBeNull();
    expect(screen.queryByText('omission pending')).toBeNull();
  });

  it('withholds the completion form until the Work can actually close', async () => {
    // The server refuses a completion below 100% executed value and returns
    // the shortfall. Asking first means the operator reads the worklist
    // instead of writing a note that was never going to be accepted.
    renderAmended(
      amendedApi({
        workCompletionReadiness: vi.fn().mockResolvedValue({
          ready: false,
          blockers: [
            {
              kind: 'draft_delivery_challan',
              recordId: '55555555-5555-4555-8555-555555555555',
              label: 'Draft delivery challan dated 2026-08-09',
            },
          ],
          unfinished: [
            {
              workItemId: ITEM_A,
              itemNumber: 'A/1',
              category: 'SUPPLY',
              requirement: 'delivery',
              direction: 'short',
              requiredQuantity: '8.000',
              deliveredQuantity: '5.000',
              installedQuantity: '0.000',
            },
          ],
        }),
      }),
    );
    await openWorkTab('Overview');

    expect(await screen.findByText('This Work cannot be completed yet.')).toBeTruthy();
    expect(screen.getByText('Draft delivery challan dated 2026-08-09')).toBeTruthy();
    expect(screen.getByText('Items not yet at 100% executed value')).toBeTruthy();
    expect(screen.queryByLabelText('Why this Work is being completed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Complete Work' })).toBeNull();
  });

  it('offers the completion form once nothing is outstanding', async () => {
    renderAmended(amendedApi());
    await openWorkTab('Overview');

    expect(
      await screen.findByLabelText('Why this Work is being completed'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete Work' })).toBeTruthy();
    expect(screen.queryByText('This Work cannot be completed yet.')).toBeNull();
  });

  it('still offers completion when the readiness read fails', async () => {
    // The shortfall is an improvement on the refusal, not a precondition
    // for it. If the read fails the page falls back to what it did before
    // it asked, and the server still refuses with the worklist.
    renderAmended(
      amendedApi({
        workCompletionReadiness: vi.fn().mockRejectedValue(new Error('offline')),
      }),
    );
    await openWorkTab('Overview');

    expect(
      await screen.findByLabelText('Why this Work is being completed'),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Completion status' })).toBeTruthy();
  });

  it('renders one row per awarded item, carrying every column', async () => {
    renderAmended(amendedApi());
    await openWorkTab('Schedules & items');

    const table = await screen.findByRole('table', {
      name: /Awarded items in schedule A/,
    });
    // A merge once duplicated the row loop, so every item rendered twice
    // under a colliding React key and the first copy was a column short.
    const rows = within(table).getAllByRole('row');
    const items = AMENDED_WORK_DETAIL.schedules[0]?.items ?? [];
    expect(rows).toHaveLength(1 + items.length);
    expect(
      within(table).getAllByRole('switch', { name: 'Serial tracking for A/1' }),
    ).toHaveLength(1);
    // Seven headers, so seven cells per row: the row header plus six.
    expect(within(rows[0] as HTMLElement).getAllByRole('columnheader')).toHaveLength(7);
    for (const row of rows.slice(1)) {
      expect(within(row).getAllByRole('rowheader')).toHaveLength(1);
      expect(within(row).getAllByRole('cell')).toHaveLength(6);
    }
  });

  const REMOVAL_APPROVAL = {
    id: '31111111-2222-4333-8444-555555555555',
    entityType: 'work_item_amendment' as const,
    entityId: ITEM_A,
    workId: WORK_ID,
    workCode: 'DCW-1',
    itemNumber: 'A/1',
    documentNumber: null,
    proposed: { kind: 'remove_item', workItemId: ITEM_A, itemNumber: 'A/1' },
    diff: [
      { field: 'item', before: 'A/1', after: null },
      { field: 'quantity', before: '8.000', after: null },
    ],
    reason: 'The switchboard was dropped from the sanction.',
    status: 'pending' as const,
    requestedByUserId: 'user-b',
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: '2026-08-08T00:00:00.000Z',
  };

  it('flags an item carrying an undecided omission proposal', async () => {
    renderAmended(
      amendedApi({
        listWorkAmendments: vi.fn().mockResolvedValue([REMOVAL_APPROVAL]),
      }),
    );
    await openWorkTab('Schedules & items');

    expect(screen.getByText('omission pending')).toBeTruthy();
  });

  it('drops the flag once the omission is decided and the item is gone', async () => {
    // Approving an omission soft-deletes the item, so the approved
    // proposal comes back with the item already absent from the detail.
    const withoutItemA = {
      ...AMENDED_WORK_DETAIL,
      schedules: [
        {
          ...AMENDED_WORK_DETAIL.schedules[0],
          items: AMENDED_WORK_DETAIL.schedules[0]?.items.slice(1) ?? [],
        },
      ],
    };
    renderAmended(
      stubApi({
        getWork: vi.fn().mockResolvedValue(withoutItemA),
        listWorkAmendments: vi
          .fn()
          .mockResolvedValue([{ ...REMOVAL_APPROVAL, status: 'approved' as const }]),
      }),
    );
    await openWorkTab('Schedules & items');

    expect(screen.queryByText('omission pending')).toBeNull();
    expect(screen.queryByText('Main switchboard')).toBeNull();
  });

  it('files an omission through the R7 removal path, not a quantity-0 change', async () => {
    const proposeItemRemoval = vi.fn().mockResolvedValue({
      ...REMOVAL_APPROVAL,
      status: 'pending',
    });
    const proposeAmendment = vi.fn();
    renderAmended(amendedApi({ proposeItemRemoval, proposeAmendment }));
    await openWorkTab('Amendments');

    await screen.findByRole('heading', { name: 'Amendments' });
    // Nothing is proposed yet, so the section already leads with its form.
    fireEvent.change(screen.getByLabelText('Amendment'), {
      target: { value: 'omit' },
    });
    fireEvent.change(screen.getByLabelText('Item to amend'), {
      target: { value: ITEM_A },
    });
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'The switchboard was dropped from the sanction.' },
    });
    fireEvent.click(submitButton('Submit amendment'));

    await waitFor(() => {
      expect(proposeItemRemoval).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        workItemId: ITEM_A,
        reason: 'The switchboard was dropped from the sanction.',
      });
    });
    expect(proposeAmendment).not.toHaveBeenCalled();
  });

  it('proposes a quantity change with a reason', async () => {
    const proposeAmendment = vi.fn().mockResolvedValue({
      id: '11111111-2222-4333-8444-555555555555',
      status: 'pending',
    });
    renderAmended(amendedApi({ proposeAmendment }));
    await openWorkTab('Amendments');

    await screen.findByRole('heading', { name: 'Amendments' });
    fireEvent.change(screen.getByLabelText('Item to amend'), {
      target: { value: ITEM_A },
    });
    fireEvent.change(screen.getByLabelText('New quantity (optional)'), {
      target: { value: '9' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Variation order 15.' },
    });
    fireEvent.click(submitButton('Submit amendment'));

    await waitFor(() => {
      expect(proposeAmendment).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        workItemId: ITEM_A,
        reason: 'Variation order 15.',
        changes: { quantity: '9' },
      });
    });
  });

  it('lets an owner flip the excess-delivery escape hatch, and hides it otherwise', async () => {
    const setWorkSettings = vi
      .fn()
      .mockResolvedValue({ id: WORK_ID, allowExcessDelivery: true });
    renderAmended(amendedApi({ setWorkSettings }), { isOwner: true });
    await screen.findByRole('button', { name: /^Overview/ });

    // The toggle lifts the DELIVERY cap and nothing else, so it lives on
    // the Deliveries tab (2026-08-19) rather than in the Work header,
    // where it was the one control amid read-only figures.
    await openWorkTab('Deliveries');
    const toggle = await screen.findByLabelText(
      'Allow issuing beyond sanctioned quantities',
    );
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(setWorkSettings).toHaveBeenCalledWith(ORG_ID, WORK_ID, true);
    });

    cleanup();
    renderAmended(amendedApi());
    await screen.findByRole('button', { name: /^Overview/ });
    await openWorkTab('Deliveries');
    // The second render has to finish loading before the read-only variant
    // of the switch exists to assert on.
    expect(await screen.findByText('Not allowed')).toBeTruthy();
    expect(
      screen.queryByLabelText('Allow issuing beyond sanctioned quantities'),
    ).toBeNull();
  });
});

describe('WorkDetail serial tracking toggle', () => {
  const SCHEDULE_ID = '88888888-8888-4888-8888-888888888888';
  const detailWith = (requiresSerials: boolean) => ({
    work: {
      id: WORK_ID,
      workCode: 'DCW-1',
      letterNumber: 'L-42/2025',
      letterDate: '2025-06-01',
      title: 'Supply of switchboards',
      advertisedValue: '1000.00',
      contractValue: '900.00',
      pricingShape: 'per_schedule',
      letterPercentage: null,
      letterPercentageDirection: null,
      status: 'active',
      createdAt: '2026-08-08T00:00:00.000Z',
    },
    schedules: [
      {
        id: SCHEDULE_ID,
        scheduleCode: 'A',
        title: 'Schedule A',
        position: 1,
        items: [
          {
            id: ITEM_A,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/1',
            description: 'Main switchboard',
            unitCode: 'Nos',
            awardedQuantity: '5.000',
            effectiveRate: '100.00',
            requiresSerials,
          },
        ],
      },
    ],
    installationCounts: { recorded: 0, cancelled: 0 },
  });

  function renderDetail(api: ApiClient, canModify: boolean) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={canModify}
        canRecordEvidence={canModify}
        canIssue={canModify}
        canSign={false}
        canCancel={canModify}
        canApprove={false}
        canManageStatutory={true}
        canManageRetention={true}
        isOwner={false}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('turns serial tracking on for an item', async () => {
    const updateWorkItemSerials = vi.fn().mockResolvedValue({
      workItemId: ITEM_A,
      itemNumber: 'A/1',
      requiresSerials: true,
    });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(detailWith(false)),
      updateWorkItemSerials,
    });
    renderDetail(api, true);
    await openWorkTab('Schedules & items');

    const toggle = await screen.findByRole('switch', {
      name: 'Serial tracking for A/1',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(updateWorkItemSerials).toHaveBeenCalledWith(ORG_ID, ITEM_A, true);
    });
    expect(
      (
        await screen.findByRole('switch', { name: 'Serial tracking for A/1' })
      ).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('surfaces the completeness conflict when turning on is refused', async () => {
    const updateWorkItemSerials = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'SERIALS_INCOMPLETE_FOR_FLAG',
          'Serial tracking cannot be required for A/1: DC/1 has 1 of 3.000 serials. Record the missing serials first.',
        ),
      );
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(detailWith(false)),
      updateWorkItemSerials,
    });
    renderDetail(api, true);
    await openWorkTab('Schedules & items');

    fireEvent.click(
      await screen.findByRole('switch', { name: 'Serial tracking for A/1' }),
    );
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Serial tracking cannot be required for A/1: DC/1 has 1 of 3.000 serials. Record the missing serials first.',
    );
  });

  it('shows read-only members the flag without a control', async () => {
    const api = stubApi({ getWork: vi.fn().mockResolvedValue(detailWith(true)) });
    renderDetail(api, false);
    await openWorkTab('Schedules & items');

    await screen.findByRole('heading', { name: /DCW-1/ });
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Required')).toBeTruthy();
  });
});

describe('WorkSchedules tax facts', () => {
  const SCHEDULE_ID = '88888888-8888-4888-8888-888888888888';
  const detailWithTax = (
    facts: Partial<{
      hsnCode: string | null;
      gstRate: string | null;
      isService: boolean;
    }>,
  ) => ({
    work: {
      id: WORK_ID,
      workCode: 'DCW-1',
      letterNumber: 'L-42/2025',
      letterDate: '2025-06-01',
      title: 'Supply of switchboards',
      advertisedValue: '1000.00',
      contractValue: '900.00',
      pricingShape: 'per_schedule',
      letterPercentage: null,
      letterPercentageDirection: null,
      status: 'active',
      createdAt: '2026-08-08T00:00:00.000Z',
    },
    schedules: [
      {
        id: SCHEDULE_ID,
        scheduleCode: 'A',
        title: 'Schedule A',
        position: 1,
        items: [
          {
            id: ITEM_A,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/1',
            description: 'Main switchboard',
            unitCode: 'Nos',
            awardedQuantity: '5.000',
            effectiveRate: '100.00',
            requiresSerials: false,
            hsnCode: null,
            gstRate: null,
            isService: false,
            ...facts,
          },
        ],
      },
    ],
    installationCounts: { recorded: 0, cancelled: 0 },
  });

  function renderDetail(api: ApiClient, canModify: boolean) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={canModify}
        canRecordEvidence={canModify}
        canIssue={canModify}
        canSign={false}
        canCancel={canModify}
        canApprove={false}
        canManageStatutory={true}
        canManageRetention={true}
        isOwner={false}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('records HSN, rate, and the service flag through the inline editor', async () => {
    const setWorkItemTaxFacts = vi.fn().mockResolvedValue({
      id: ITEM_A,
      itemNumber: 'A/1',
      hsnCode: '850710',
      gstRate: '18',
      isService: true,
    });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(detailWithTax({})),
      setWorkItemTaxFacts,
    });
    renderDetail(api, true);
    await openWorkTab('Schedules & items');

    fireEvent.click(await screen.findByRole('button', { name: 'Tax facts for A/1' }));
    fireEvent.change(screen.getByLabelText('HSN or SAC code for A/1'), {
      target: { value: '850710' },
    });
    fireEvent.change(screen.getByLabelText('GST rate percentage for A/1'), {
      target: { value: '18' },
    });
    fireEvent.click(screen.getByLabelText('Service'));
    fireEvent.click(screen.getByRole('button', { name: 'Save tax facts for A/1' }));

    await waitFor(() => {
      expect(setWorkItemTaxFacts).toHaveBeenCalledWith(ORG_ID, ITEM_A, {
        hsnCode: '850710',
        gstRate: '18',
        isService: true,
      });
    });
    // The editor closes onto the quiet summary of what the server kept.
    expect(await screen.findByText('850710 · 18% · service')).toBeTruthy();
    expect(screen.queryByLabelText('HSN or SAC code for A/1')).toBeNull();
  });

  it('clears a fact by blanking its box — an explicit null, not an omission', async () => {
    const setWorkItemTaxFacts = vi.fn().mockResolvedValue({
      id: ITEM_A,
      itemNumber: 'A/1',
      hsnCode: null,
      gstRate: '18',
      isService: false,
    });
    const api = stubApi({
      getWork: vi
        .fn()
        .mockResolvedValue(detailWithTax({ hsnCode: '850710', gstRate: '18' })),
      setWorkItemTaxFacts,
    });
    renderDetail(api, true);
    await openWorkTab('Schedules & items');

    // The editor opens prefilled with the stored facts.
    fireEvent.click(await screen.findByRole('button', { name: 'Tax facts for A/1' }));
    const hsn = screen.getByLabelText<HTMLInputElement>('HSN or SAC code for A/1');
    expect(hsn.value).toBe('850710');
    fireEvent.change(hsn, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tax facts for A/1' }));

    await waitFor(() => {
      expect(setWorkItemTaxFacts).toHaveBeenCalledWith(ORG_ID, ITEM_A, {
        hsnCode: null,
        gstRate: '18',
        isService: false,
      });
    });
  });

  it('shows read-only members the summary without an editor', async () => {
    const api = stubApi({
      getWork: vi
        .fn()
        .mockResolvedValue(
          detailWithTax({ hsnCode: '998719', gstRate: '18', isService: true }),
        ),
    });
    renderDetail(api, false);
    await openWorkTab('Schedules & items');

    expect(await screen.findByText('998719 · 18% · service')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tax facts for A/1' })).toBeNull();
  });
});

describe('WorkDetail PBG requirement', () => {
  const PBG_SCHEDULE_ID = '88888888-8888-4888-8888-888888888888';
  const workDetailWith = (pbg: {
    pbgRequiredAmount: string | null;
    pbgSubmissionDays: number | null;
    pbgExtensionDays: number | null;
    pbgPenalInterestPercent: string | null;
  }) => ({
    work: {
      id: WORK_ID,
      workCode: 'PBG-W-1',
      letterNumber: 'L-99/2026',
      letterDate: '2026-02-09',
      title: 'Supply of signalling gear',
      advertisedValue: '1000.00',
      contractValue: '900.00',
      pricingShape: 'per_schedule',
      letterPercentage: null,
      letterPercentageDirection: null,
      status: 'active',
      createdAt: '2026-08-08T00:00:00.000Z',
      ...pbg,
    },
    schedules: [
      {
        id: PBG_SCHEDULE_ID,
        scheduleCode: 'A',
        title: 'Schedule A',
        position: 1,
        items: [],
      },
    ],
    installationCounts: { recorded: 0, cancelled: 0 },
  });

  function renderDetail(detail: unknown) {
    render(
      <WorkDetail
        api={stubApi({ getWork: vi.fn().mockResolvedValue(detail) })}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={false}
        canRecordEvidence={false}
        canIssue={false}
        canSign={false}
        canCancel={false}
        canApprove={false}
        canManageStatutory={false}
        canManageRetention={true}
        isOwner={false}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('shows the letter’s PBG requirement beside the instruments', async () => {
    renderDetail(
      workDetailWith({
        pbgRequiredAmount: '45000.00',
        pbgSubmissionDays: 21,
        pbgExtensionDays: 60,
        pbgPenalInterestPercent: '12.000',
      }),
    );
    await openWorkTab('Instruments');

    await screen.findByText('PBG required by the letter');
    expect(screen.getByText(/45,000/)).toBeTruthy();
    expect(
      screen.getByText(/21 days from the letter date \(\+60 days extension\)/),
    ).toBeTruthy();
    expect(screen.getByText('12.000% p.a.')).toBeTruthy();
    expect(
      screen.queryByText(
        'The letter records no Performance Bank Guarantee requirement.',
      ),
    ).toBeNull();
  });

  it('says so when the letter records no PBG requirement', async () => {
    renderDetail(
      workDetailWith({
        pbgRequiredAmount: null,
        pbgSubmissionDays: null,
        pbgExtensionDays: null,
        pbgPenalInterestPercent: null,
      }),
    );
    await openWorkTab('Instruments');

    await screen.findByText(
      'The letter records no Performance Bank Guarantee requirement.',
    );
    expect(screen.queryByText('PBG required by the letter')).toBeNull();
  });
});

describe('WorkDetail procurement tab', () => {
  function renderProcurementWork(api: ApiClient) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        canRecordEvidence
        canIssue
        canSign={false}
        canCancel
        canApprove={false}
        canManageStatutory={true}
        canManageRetention={true}
        isOwner={false}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('lists the purchase orders with vendor, status, and total, and counts them in the strip', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkPurchaseOrders: vi.fn().mockResolvedValue([purchaseOrder()]),
    });
    renderProcurementWork(api);
    await openWorkTab('Procurement');

    expect(await screen.findByText('DCW-1-PO-01')).toBeTruthy();
    expect(screen.getByText('Sharma Electricals')).toBeTruthy();
    expect(screen.getByText('issued')).toBeTruthy();
    expect(screen.getByText('₹400.00')).toBeTruthy();

    // The tab strip carries the same count the list shows.
    const tabs = screen.getByRole('navigation', { name: 'Work sections' });
    const procurementTab = within(tabs).getByRole('button', {
      name: (name: string) => name.startsWith('Procurement'),
    });
    expect(procurementTab.textContent).toContain('1');
  });

  it('drafts a purchase order, saves its lines, and issues it', async () => {
    const draftOrder = purchaseOrder({
      status: 'draft',
      poNumber: null,
      sequenceNumber: null,
      totalAmount: null,
      issuedAt: null,
    });
    const draftDetail: PurchaseOrderDetailResponse = {
      purchaseOrder: draftOrder,
      lines: [],
      vendorSnapshot: null,
      previewTotal: '0.00',
    };
    const savedDetail: PurchaseOrderDetailResponse = {
      ...purchaseOrderDetail(),
      purchaseOrder: draftOrder,
    };
    const createWorkPurchaseOrder = vi.fn().mockResolvedValue(draftDetail);
    const savePurchaseOrderLines = vi.fn().mockResolvedValue(savedDetail);
    const issuePurchaseOrder = vi.fn().mockResolvedValue(purchaseOrderDetail());
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listContacts: vi.fn().mockResolvedValue([VENDOR_CONTACT]),
      createWorkPurchaseOrder,
      savePurchaseOrderLines,
      issuePurchaseOrder,
    });
    renderProcurementWork(api);
    await openWorkTab('Procurement');

    // No orders yet, so the create form starts open (Disclosure startOpen).
    fireEvent.change(await screen.findByLabelText('Vendor'), {
      target: { value: VENDOR_CONTACT_ID },
    });
    fireEvent.change(screen.getByLabelText('PO date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.click(submitButton('Create purchase order'));
    await waitFor(() => {
      expect(createWorkPurchaseOrder).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        vendorContactId: VENDOR_CONTACT_ID,
        poDate: '2026-08-01',
      });
    });

    // The draft editor opened with one empty line; picking the Work item
    // prefills its description and unit, both still editable. The select's
    // value is prefixed because one control carries both receipt channels
    // (migration 0109): `w:` an awarded item, `p:` a stock part.
    fireEvent.change(await screen.findByLabelText('Line 1 item'), {
      target: { value: `w:${ITEM_A}` },
    });
    expect(screen.getByLabelText<HTMLInputElement>('Line 1 description').value).toBe(
      'Main switchboard',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Line 1 unit').value).toBe('Nos');
    fireEvent.change(screen.getByLabelText('Line 1 quantity'), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 rate'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save lines' }));
    await waitFor(() => {
      expect(savePurchaseOrderLines).toHaveBeenCalledWith(ORG_ID, PO_ID, {
        lines: [
          {
            workItemId: ITEM_A,
            description: 'Main switchboard',
            unitCode: 'Nos',
            quantity: '4',
            rate: '100',
          },
        ],
      });
    });
    // The draft total is the server's figure, never client arithmetic.
    expect(await screen.findByText('₹400.00')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Issue purchase order' }));
    await waitFor(() => {
      expect(issuePurchaseOrder).toHaveBeenCalledWith(ORG_ID, PO_ID);
    });
    // Issued: the number reaches the heading and the editor gives way to
    // the read-only lines with their ordered/received/pending balances.
    expect(await screen.findByText(/Purchase order DCW-1-PO-01/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save lines' })).toBeNull();
    expect(screen.getAllByText('4.000').length).toBeGreaterThan(1);
  });
});
