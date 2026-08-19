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
import { RequestFailedError, type ApiClient } from '../../src/api.js';
import { WorkDetail } from '../../src/views/WorkDetail.js';
import {
  submitButton,
  stubApi,
  ORG_ID,
  WORK_ID,
  ITEM_A,
  challanWork,
  openWorkTab,
  CLIENT_CONTACT_ID,
  TAX_INVOICE_ID,
  BILLABLE_MB_ID,
  CLIENT_CONTACT,
  billableBook,
  taxInvoice,
  SUBMITTED_INVOICE,
  ewayBill,
  NO_BILLING,
} from './helpers.js';

describe('WorkDetail tax invoices', () => {
  function renderInvoiceWork(api: ApiClient) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        canRecordEvidence
        canIssue
        canSign
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

  it('lists invoices with their Measurement Book, status and total', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([SUBMITTED_INVOICE]),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    expect(await screen.findByText('TI/2026-27/001')).toBeTruthy();
    expect(screen.getByText('DCW-1-MB-01')).toBeTruthy();
    expect(screen.getByText('₹49,87,852.93')).toBeTruthy();
  });

  it('signals the frozen IRP reporting window: amber while open, red once closed', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([
        taxInvoice({
          ...SUBMITTED_INVOICE,
          irpReportingDeadline: '2099-01-30',
          irpReportingOverdue: false,
        }),
        taxInvoice({
          ...SUBMITTED_INVOICE,
          id: 'eeee8888-8888-4888-8888-eeeeeeeeee88',
          invoiceNumber: 'TI/2026-27/002',
          irpReportingDeadline: '2026-03-17',
          irpReportingOverdue: true,
        }),
      ]),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    expect(await screen.findByText('IRP Due 30 Jan 2099')).toBeTruthy();
    expect(screen.getByText('IRP Overdue')).toBeTruthy();
  });

  it('does not present a failed tax-invoice register as empty or creatable', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockRejectedValue(new Error('Unavailable.')),
      listContacts: vi.fn().mockResolvedValue([CLIENT_CONTACT]),
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [billableBook()] }),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    expect(await screen.findByText(/Tax invoices could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/No tax invoice has been raised/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Draft a tax invoice' })).toBeNull();
  });

  /**
   * Finding 27's residue. The invoice LIST was fixed; the picker loads
   * beneath it were still swallowed, so an unreachable Measurement Book
   * list withdrew the whole drafting workflow and looked exactly like a
   * Work with nothing billable.
   */
  it('reports an unreadable Measurement Book list instead of silently hiding drafting', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([SUBMITTED_INVOICE]),
      listContacts: vi.fn().mockResolvedValue([CLIENT_CONTACT]),
      listWorkMeasurementBooks: vi
        .fn()
        .mockRejectedValueOnce(
          new RequestFailedError(
            503,
            'UNAVAILABLE',
            'Measurement Books are unavailable.',
          ),
        )
        .mockResolvedValue({ books: [billableBook()] }),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    expect(await screen.findByText(/Measurement Books are unavailable/)).toBeTruthy();
    // The invoices that DID load are unaffected — the failure is scoped
    // to the action it actually removed.
    expect(screen.getByText('TI/2026-27/001')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByText(/Measurement Books are unavailable/)).toBeNull();
    });
    expect(api.listWorkMeasurementBooks).toHaveBeenCalledTimes(2);
  });

  it('names a refused picker as a permission answer, with no retry to offer', async () => {
    // A 403 is not an outage. Retrying it in a loop produces audit noise
    // and implies the operator did something wrong.
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([SUBMITTED_INVOICE]),
      listContacts: vi.fn().mockResolvedValue([CLIENT_CONTACT]),
      listWorkMeasurementBooks: vi
        .fn()
        .mockRejectedValue(new RequestFailedError(403, 'FORBIDDEN', 'Refused.')),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    expect(
      await screen.findByText(/Measurement Books are not available to you/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offers only finalized, unbilled, non-record Measurement Books to bill', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listContacts: vi.fn().mockResolvedValue([CLIENT_CONTACT]),
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({
        books: [
          billableBook(),
          // A record MB is merged before billing, a draft is not
          // finalized, and the final MB below IS billable.
          billableBook({ id: 'eeee4444-4444-4444-8444-eeeeeeeeee44', kind: 'record' }),
          billableBook({
            id: 'eeee5555-5555-4555-8555-eeeeeeeeee55',
            status: 'draft',
            mbNumber: null,
          }),
          billableBook({
            id: 'eeee6666-6666-4666-8666-eeeeeeeeee66',
            kind: 'final',
            isFinal: true,
            mbNumber: 'DCW-1-MB-02',
          }),
        ],
      }),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    const picker = await screen.findByLabelText('Measurement Book to bill');
    const offered = within(picker)
      .getAllByRole('option')
      .map((option) => option.textContent ?? '');
    // The placeholder plus exactly the two billable books.
    expect(offered.length).toBe(3);
    expect(offered.some((label) => label.includes('DCW-1-MB-01'))).toBe(true);
    expect(offered.some((label) => label.includes('DCW-1-MB-02'))).toBe(true);
  });

  it('does not offer a Measurement Book that a live invoice already bills', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listContacts: vi.fn().mockResolvedValue([CLIENT_CONTACT]),
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [billableBook()] }),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([SUBMITTED_INVOICE]),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    await screen.findByText('TI/2026-27/001');
    // Its only billable MB is taken, so there is nothing to draft against.
    expect(screen.queryByLabelText('Measurement Book to bill')).toBeNull();
  });

  it('drafts an invoice from the picked Measurement Book', async () => {
    const createWorkTaxInvoice = vi.fn().mockResolvedValue({
      invoice: taxInvoice(),
      buyerSnapshot: null,
      signedQr: null,
      lines: [],
    });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listContacts: vi.fn().mockResolvedValue([CLIENT_CONTACT]),
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [billableBook()] }),
      createWorkTaxInvoice,
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: taxInvoice(),
        buyerSnapshot: null,
        signedQr: null,
        lines: [],
      }),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    fireEvent.change(await screen.findByLabelText('Measurement Book to bill'), {
      target: { value: BILLABLE_MB_ID },
    });
    fireEvent.change(screen.getByLabelText('Invoice date'), {
      target: { value: '2026-07-30' },
    });
    fireEvent.change(screen.getByLabelText('SAC code'), {
      target: { value: '998734' },
    });
    fireEvent.change(screen.getByLabelText('Service description'), {
      target: { value: 'Provision of passenger amenity services.' },
    });
    fireEvent.change(screen.getByLabelText('GST rate (%)'), {
      target: { value: '18' },
    });
    fireEvent.change(screen.getByLabelText('Place of supply'), {
      target: { value: '27' },
    });
    fireEvent.change(screen.getByLabelText('Tax payable on reverse charge'), {
      target: { value: 'false' },
    });
    fireEvent.change(screen.getByLabelText('Buyer'), {
      target: { value: CLIENT_CONTACT_ID },
    });
    fireEvent.click(submitButton('Create draft'));

    await waitFor(() => {
      expect(createWorkTaxInvoice).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        measurementBookId: BILLABLE_MB_ID,
        invoiceDate: '2026-07-30',
        sacCode: '998734',
        serviceDescription: 'Provision of passenger amenity services.',
        gstRate: '18',
        placeOfSupply: '27',
        reverseChargeApplicable: false,
        buyerContactId: CLIENT_CONTACT_ID,
      });
    });
  });

  it('drafts an ITEMISED invoice, sending lines instead of a header SAC', async () => {
    const createWorkTaxInvoice = vi.fn().mockResolvedValue({
      invoice: taxInvoice(),
      buyerSnapshot: null,
      signedQr: null,
      lines: [],
    });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listContacts: vi.fn().mockResolvedValue([CLIENT_CONTACT]),
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [billableBook()] }),
      createWorkTaxInvoice,
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: taxInvoice(),
        buyerSnapshot: null,
        signedQr: null,
        lines: [],
      }),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    fireEvent.change(await screen.findByLabelText('Measurement Book to bill'), {
      target: { value: BILLABLE_MB_ID },
    });
    fireEvent.change(screen.getByLabelText('Invoice date'), {
      target: { value: '2026-07-30' },
    });
    // The shape switch replaces the header SAC/description/rate fields
    // with the line editor.
    fireEvent.change(screen.getByLabelText('Invoice lines'), {
      target: { value: 'itemised' },
    });
    expect(screen.queryByLabelText('SAC code')).toBeNull();
    expect(screen.queryByLabelText('Service description')).toBeNull();

    fireEvent.change(screen.getByLabelText('HSN code'), {
      target: { value: '85444999' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Signalling cable, 4 core' },
    });
    fireEvent.change(screen.getByLabelText('Quantity'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('Unit rate'), {
      target: { value: '85.50' },
    });
    fireEvent.change(screen.getByLabelText('GST rate (%)'), {
      target: { value: '18' },
    });
    fireEvent.change(screen.getByLabelText('Place of supply'), {
      target: { value: '27' },
    });
    fireEvent.change(screen.getByLabelText('Tax payable on reverse charge'), {
      target: { value: 'false' },
    });
    fireEvent.change(screen.getByLabelText('Buyer'), {
      target: { value: CLIENT_CONTACT_ID },
    });
    fireEvent.click(submitButton('Create draft'));

    await waitFor(() => {
      expect(createWorkTaxInvoice).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        measurementBookId: BILLABLE_MB_ID,
        invoiceDate: '2026-07-30',
        placeOfSupply: '27',
        reverseChargeApplicable: false,
        buyerContactId: CLIENT_CONTACT_ID,
        lineShape: 'itemised',
        lines: [
          {
            isService: false,
            hsnSacCode: '85444999',
            description: 'Signalling cable, 4 core',
            quantity: '100',
            unitRate: '85.50',
            gstRate: '18',
            unitLabel: 'm',
          },
        ],
      });
    });
  });

  it('shows an itemised invoice as a line table, not one description', async () => {
    const itemised = taxInvoice({
      status: 'submitted',
      invoiceNumber: 'TI/2026-27/002',
      lineShape: 'itemised',
      sacCode: null,
      serviceDescription: null,
      gstRate: null,
      reverseChargeApplicable: false,
      taxableValue: '8550.00',
      cgstAmount: '769.50',
      sgstAmount: '769.50',
      igstAmount: '0.00',
      totalAmount: '10089.00',
    });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([itemised]),
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: itemised,
        buyerSnapshot: null,
        shipToSnapshot: null,
        issuedSnapshot: null,
        signedQr: null,
        lines: [
          {
            id: 'aaaa1111-1111-4111-8111-aaaaaaaaaa11',
            position: 1,
            isService: false,
            hsnSacCode: '85444999',
            description: 'Signalling cable, 4 core',
            quantity: '100.000',
            unitLabel: 'm',
            unitRate: '85.50',
            gstRate: '18.00',
            taxableValue: '8550.00',
            cgstAmount: '769.50',
            sgstAmount: '769.50',
            igstAmount: '0.00',
          },
        ],
      }),
      listInvoiceEwayBills: vi.fn().mockResolvedValue([]),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    fireEvent.click(await screen.findByRole('button', { name: 'TI/2026-27/002' }));
    expect(await screen.findByText('Itemised HSN/SAC lines')).toBeTruthy();
    expect(screen.getByText('85444999 · goods')).toBeTruthy();
    expect(screen.getByText('Signalling cable, 4 core')).toBeTruthy();
    // The header SAC and GST rate rows are absent: an itemised invoice
    // has neither, and printing an empty one would invite a reader to
    // wonder what it means.
    expect(screen.queryByText('SAC')).toBeNull();
  });

  it('shows the frozen CGST/SGST split and hides the IGST row within the state', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([SUBMITTED_INVOICE]),
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: SUBMITTED_INVOICE,
        buyerSnapshot: { designation: 'Central Railway Mumbai Division' },
        signedQr: null,
        lines: [],
      }),
      listInvoiceEwayBills: vi.fn().mockResolvedValue([]),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    fireEvent.click(await screen.findByRole('button', { name: 'TI/2026-27/001' }));

    expect(await screen.findByText('Taxable value')).toBeTruthy();
    expect(screen.getByText('CGST')).toBeTruthy();
    expect(screen.getByText('SGST')).toBeTruthy();
    // An intra-state invoice carries no IGST, and a zero row would only
    // invite the reader to wonder what it means.
    expect(screen.queryByText('IGST')).toBeNull();
    expect(screen.getAllByText('₹3,80,429.46').length).toBe(2);
  });

  it('generates and exposes the stored tax-invoice PDF controls', async () => {
    const renderTaxInvoice = vi.fn().mockResolvedValue({
      invoice: taxInvoice({ ...SUBMITTED_INVOICE, renderedAvailable: true }),
      buyerSnapshot: null,
      shipToSnapshot: null,
      issuedSnapshot: null,
      signedQr: null,
      lines: [],
    });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([SUBMITTED_INVOICE]),
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: SUBMITTED_INVOICE,
        buyerSnapshot: null,
        shipToSnapshot: null,
        issuedSnapshot: null,
        signedQr: null,
        lines: [],
      }),
      listInvoiceEwayBills: vi.fn().mockResolvedValue([]),
      renderTaxInvoice,
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');
    fireEvent.click(await screen.findByRole('button', { name: 'TI/2026-27/001' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Generate PDF' }));
    await waitFor(() => {
      expect(renderTaxInvoice).toHaveBeenCalledWith(ORG_ID, TAX_INVOICE_ID);
    });

    cleanup();
    const renderedInvoice = taxInvoice({
      ...SUBMITTED_INVOICE,
      renderedAvailable: true,
    });
    const renderedApi = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([renderedInvoice]),
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: renderedInvoice,
        buyerSnapshot: null,
        shipToSnapshot: null,
        issuedSnapshot: null,
        signedQr: null,
        lines: [],
      }),
      listInvoiceEwayBills: vi.fn().mockResolvedValue([]),
    });
    renderInvoiceWork(renderedApi);
    await openWorkTab('Bills');
    fireEvent.click(await screen.findByRole('button', { name: 'TI/2026-27/001' }));
    expect(await screen.findByRole('button', { name: 'Regenerate PDF' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open PDF' })).toBeTruthy();
  });

  it('shows IGST alone across states', async () => {
    const interState = taxInvoice({
      ...SUBMITTED_INVOICE,
      placeOfSupply: '07',
      cgstAmount: '0.00',
      sgstAmount: '0.00',
      igstAmount: '760858.92',
    });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([interState]),
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: interState,
        buyerSnapshot: null,
        signedQr: null,
        lines: [],
      }),
      listInvoiceEwayBills: vi.fn().mockResolvedValue([]),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    fireEvent.click(await screen.findByRole('button', { name: 'TI/2026-27/001' }));

    expect(await screen.findByText('IGST')).toBeTruthy();
    expect(screen.queryByText('CGST')).toBeNull();
    expect(screen.queryByText('SGST')).toBeNull();
  });

  it('records what the IRP answered rather than minting an IRN', async () => {
    const recordTaxInvoiceIrpResponse = vi.fn().mockResolvedValue({
      invoice: SUBMITTED_INVOICE,
      buyerSnapshot: null,
      signedQr: 'signed',
      lines: [],
    });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([SUBMITTED_INVOICE]),
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: SUBMITTED_INVOICE,
        buyerSnapshot: null,
        signedQr: null,
        lines: [],
      }),
      listInvoiceEwayBills: vi.fn().mockResolvedValue([]),
      recordTaxInvoiceIrpResponse,
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    fireEvent.click(await screen.findByRole('button', { name: 'TI/2026-27/001' }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Manual compatibility import (unverified)',
      }),
    );

    const irn = 'fda60c09ad1134252b55949c1430a26a94587374c693ea42665d27d092dbb337';
    fireEvent.change(screen.getByLabelText('IRN'), { target: { value: irn } });
    fireEvent.change(screen.getByLabelText('Acknowledgement number'), {
      target: { value: '122633844006458' },
    });
    fireEvent.change(screen.getByLabelText('Acknowledgement date'), {
      target: { value: '2026-07-30T12:09' },
    });
    fireEvent.change(screen.getByLabelText('Portal acknowledgement text (exact)'), {
      target: { value: '30/07/2026 12:09:00' },
    });
    fireEvent.change(screen.getByLabelText('Signed QR'), {
      target: { value: 'eyJhbGciOi' },
    });
    fireEvent.click(submitButton('Record response'));

    await waitFor(() => {
      expect(recordTaxInvoiceIrpResponse).toHaveBeenCalledWith(
        ORG_ID,
        TAX_INVOICE_ID,
        expect.objectContaining({
          irn,
          ackNumber: '122633844006458',
          signedQr: 'eyJhbGciOi',
        }),
      );
    });
  });

  it('refuses a service-only invoice by line content and still offers lookup recovery', async () => {
    const unknownBill = ewayBill();
    const generateEwayBill = vi.fn().mockResolvedValue({ ewayBill: unknownBill });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([SUBMITTED_INVOICE]),
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: SUBMITTED_INVOICE,
        buyerSnapshot: null,
        signedQr: null,
        lines: [],
      }),
      listInvoiceEwayBills: vi.fn().mockResolvedValue([unknownBill]),
      generateEwayBill,
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    fireEvent.click(await screen.findByRole('button', { name: 'TI/2026-27/001' }));
    // ADR-0013: the refusal is now about the LINES rather than about the
    // document kind. This fixture invoice is the cumulative SAC service
    // one, which is exactly the document the 2026-08-10 disposition was
    // about, so the panel refuses it and offers no drafting action —
    // while the historical record's lookup recovery stays reachable.
    expect(
      await screen.findByText(/Every line of this invoice is a service/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Raise an e-way bill' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate at Whitebooks' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
    await waitFor(() => {
      expect(generateEwayBill).toHaveBeenCalledWith(
        ORG_ID,
        'eeee7777-7777-4777-8777-eeeeeeeeee77',
      );
    });
  });

  it('uses the EWB cancellation reason-code meanings, not the IRP mapping', async () => {
    const generatedBill = ewayBill({
      status: 'generated',
      providerState: 'generated',
      ewbNumber: '123456789012',
      ewbDate: '2026-07-30T07:00:00.000Z',
      validUntil: '2026-07-31T23:59:59.000Z',
      ewbDateText: '30/07/2026 12:30:00',
      validUntilText: '31/07/2026 23:59:59',
      generatedAt: '2026-07-30T07:00:00.000Z',
    });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([SUBMITTED_INVOICE]),
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: SUBMITTED_INVOICE,
        buyerSnapshot: null,
        signedQr: null,
        lines: [],
      }),
      listInvoiceEwayBills: vi.fn().mockResolvedValue([generatedBill]),
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    fireEvent.click(await screen.findByRole('button', { name: 'TI/2026-27/001' }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Cancel EWB 123456789012 at Whitebooks',
      }),
    );
    const reason = screen.getByLabelText<HTMLSelectElement>('Reason');
    expect(
      within(reason)
        .getByRole('option', { name: 'Order cancelled' })
        .getAttribute('value'),
    ).toBe('2');
    expect(
      within(reason)
        .getByRole('option', { name: 'Data entry mistake' })
        .getAttribute('value'),
    ).toBe('3');
  });

  it('requires a note to cancel, and says the Measurement Book is released', async () => {
    const cancelTaxInvoice = vi.fn().mockResolvedValue({
      invoice: SUBMITTED_INVOICE,
      buyerSnapshot: null,
      signedQr: null,
      lines: [],
    });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([SUBMITTED_INVOICE]),
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: SUBMITTED_INVOICE,
        buyerSnapshot: null,
        signedQr: null,
        lines: [],
      }),
      listInvoiceEwayBills: vi.fn().mockResolvedValue([]),
      cancelTaxInvoice,
    });
    renderInvoiceWork(api);
    await openWorkTab('Bills');

    fireEvent.click(await screen.findByRole('button', { name: 'TI/2026-27/001' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel this invoice' }));

    fireEvent.change(screen.getByLabelText('Why it is being cancelled'), {
      target: { value: 'Wrong place of supply.' },
    });
    fireEvent.click(submitButton('Cancel invoice'));

    await waitFor(() => {
      expect(cancelTaxInvoice).toHaveBeenCalledWith(ORG_ID, TAX_INVOICE_ID, {
        note: 'Wrong place of supply.',
      });
    });
  });
});

describe('WorkDetail billing readiness panel', () => {
  function renderBillsTab(api: ApiClient) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        canRecordEvidence
        canIssue
        canSign
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

  const MATRIX_ROW = {
    id: 'dddd1111-1111-4111-8111-dddddddddd11',
    workId: WORK_ID,
    category: 'UNCATEGORISED',
    pctSupply: '70.00',
    pctInstallation: '20.00',
    pctPac: '5.00',
    pctFinalBill: '5.00',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };

  const COMPLETE_CLIENT = { ...CLIENT_CONTACT, locality: 'Mumbai' };

  it('reports every prerequisite ready when matrix, client and profile are complete', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      getPaymentMatrix: vi.fn().mockResolvedValue([MATRIX_ROW]),
      listContacts: vi.fn().mockResolvedValue([COMPLETE_CLIENT]),
    });
    renderBillsTab(api);
    await openWorkTab('Bills');

    expect(
      await screen.findByText('Every invoice prerequisite is in place.'),
    ).toBeTruthy();
    // Ready items carry no fix links.
    expect(
      screen.queryByRole('link', { name: 'Open organisation settings' }),
    ).toBeNull();
  });

  it('links each unmet prerequisite to the screen that fixes it', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      // No matrix rows, no contacts at all.
      getPaymentMatrix: vi.fn().mockResolvedValue([]),
      listContacts: vi.fn().mockResolvedValue([]),
      organisationProfile: vi.fn().mockResolvedValue({
        id: ORG_ID,
        name: 'Sharma Constructions',
        slug: 'sharma',
        address: null,
        gstin: null,
        contactPhone: null,
        contactEmail: null,
        hasLogo: false,
        stateCode: null,
        pincode: null,
        locality: null,
        warrantyTemplateText: null,
      }),
    });
    renderBillsTab(api);
    await openWorkTab('Bills');

    expect(
      await screen.findByText(/4 of 4 prerequisites still need attention/),
    ).toBeTruthy();
    const matrixLink = screen.getByRole('link', { name: 'Open the payment matrix' });
    expect(matrixLink.getAttribute('href')).toBe(`#/works/${WORK_ID}/schedules`);
    const contactsLink = screen.getByRole('link', { name: 'Open Masters → Contacts' });
    expect(contactsLink.getAttribute('href')).toBe('#/masters/contacts');
    const settingsLink = screen.getByRole('link', {
      name: 'Open organisation settings',
    });
    expect(settingsLink.getAttribute('href')).toBe('#/settings');
  });

  it('shows a retryable failure without pretending readiness is known', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      // Refused twice, then available. The Work page reads the matrix on
      // mount as well — it is what its payment-setup prompt answers from
      // — so the readiness panel's own read is the second call, and the
      // retry below is the third.
      getPaymentMatrix: vi
        .fn()
        .mockRejectedValueOnce(new Error('Matrix unavailable.'))
        .mockRejectedValueOnce(new Error('Matrix unavailable.'))
        .mockResolvedValue([MATRIX_ROW]),
      listContacts: vi.fn().mockResolvedValue([COMPLETE_CLIENT]),
    });
    renderBillsTab(api);
    await openWorkTab('Bills');

    expect(
      await screen.findByText(/billing prerequisites could not be checked/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry readiness check' }));
    expect(
      await screen.findByText('Every invoice prerequisite is in place.'),
    ).toBeTruthy();
  });
});

describe('WorkBills line rendering', () => {
  // Regression for the empty "Lines of bill N" table: bills prepared
  // from a finalized Measurement Book snapshot MB lines (stage deltas,
  // effective rate, line total), which the old renderer silently
  // filtered out because it only recognised the Milestone 5 sweep
  // shape. Both generations must render rows.
  const MB_SHAPE_BILL = {
    id: 'cccc2222-2222-4ccc-8ccc-cccccccccc22',
    workId: WORK_ID,
    billNumber: 2,
    status: 'prepared' as const,
    totalAmount: '4226994.01',
    mbId: BILLABLE_MB_ID,
    linesSnapshot: [
      {
        workItemId: ITEM_A,
        itemNumber: 'A/1',
        description: 'Main switchboard',
        unitCode: 'Nos',
        paymentCategory: null,
        resolvedCategory: 'UNCATEGORISED',
        pctSupply: '70.00',
        pctInstallation: '20.00',
        pctPac: '5.00',
        pctFinalBill: '5.00',
        effectiveRate: '100.00',
        deltaSupplied: '2.000',
        deltaInstalled: '1.000',
        deltaPac: '0.000',
        deltaFinalBill: '0.000',
        priorSupplied: '0.000',
        priorInstalled: '0.000',
        priorPac: '0.000',
        priorFinalBill: '0.000',
        amountSupply: '140.00',
        amountInstallation: '20.00',
        amountPac: '0.00',
        amountFinalBill: '0.00',
        lineTotal: '160.00',
        remark: 'Supplied 2, installed 1',
      },
    ],
    createdAt: '2026-08-02T00:00:00.000Z',
    submittedAt: null,
    paidAt: null,
  };

  it('renders the MB-snapshot line rows, not just headers and total', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listBills: vi
        .fn()
        .mockResolvedValue({ bills: [MB_SHAPE_BILL], summary: NO_BILLING }),
    });
    render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        canRecordEvidence
        canIssue
        canSign
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
    await openWorkTab('Bills');

    expect(await screen.findByRole('heading', { name: /Bill #2/ })).toBeTruthy();
    // The line row itself: item number, deltas and the line amount.
    const row = (await screen.findByRole('rowheader', { name: 'A/1' })).closest('tr');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('2.000');
    expect(row?.textContent).toContain('1.000');
    expect(row?.textContent).toContain('₹160.00');
    // And the bill total still stands apart from the lines.
    expect(screen.getByText('₹42,26,994.01')).toBeTruthy();
  });
});

describe('Tax invoice draft gating and wayfinding', () => {
  function renderBills(api: ApiClient) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        canRecordEvidence
        canIssue
        canSign
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

  it('shows a disabled draft action with the way to Contacts when no client exists', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [billableBook()] }),
      listContacts: vi.fn().mockResolvedValue([]),
    });
    renderBills(api);
    await openWorkTab('Bills');

    const action = await screen.findByRole('button', { name: 'Draft a tax invoice' });
    expect(action.hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByText(/needs a client contact to name as the buyer/),
    ).toBeTruthy();
    const link = screen.getByRole('link', {
      name: 'Add one under Masters → Contacts',
    });
    expect(link.getAttribute('href')).toBe('#/masters/contacts');
  });

  it('turns a submit refusal that names the organisation profile into a link there', async () => {
    const draft = taxInvoice();
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(challanWork()),
      listWorkTaxInvoices: vi.fn().mockResolvedValue([draft]),
      getTaxInvoice: vi.fn().mockResolvedValue({
        invoice: draft,
        buyerSnapshot: null,
        signedQr: null,
        lines: [],
      }),
      submitTaxInvoice: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(
            400,
            'ORG_STATE_REQUIRED',
            'The organisation profile has no GST state code, so the CGST+SGST/IGST split is undecidable — set it and retry.',
          ),
        ),
    });
    renderBills(api);
    await openWorkTab('Bills');

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit invoice' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no GST state code');
    const link = within(alert).getByRole('link', {
      name: 'Open organisation settings',
    });
    expect(link.getAttribute('href')).toBe('#/settings');
  });
});
