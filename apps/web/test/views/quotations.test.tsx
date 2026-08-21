// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type ApiClient } from '../../src/api.js';
import { Quotations } from '../../src/views/Quotations.js';
import { submitButton, stubApi, ORG_ID } from './helpers.js';

describe('Quotations workspace', () => {
  const BQ_DRAFT_ID = '99999999-1111-4111-8111-999999999991';
  const BQ_ISSUED_ID = '99999999-2222-4222-8222-999999999992';
  const CLIENT_ID = '99999999-3333-4333-8333-999999999993';
  const LINE_ID = '99999999-4444-4444-8444-999999999994';

  const BQ_DRAFT = {
    id: BQ_DRAFT_ID,
    customerContactId: null,
    addressedTo: 'Sr DEE (G) Pune',
    subject: 'Supply of LED fittings',
    status: 'draft' as const,
    bqNumber: null,
    sequenceNumber: null,
    bqDate: '2026-08-01',
    validUntil: null,
    notes: null,
    totalAmount: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    issuedAt: null,
  };

  const BQ_ISSUED = {
    ...BQ_DRAFT,
    id: BQ_ISSUED_ID,
    addressedTo: 'M/s Sunrise Infra',
    subject: 'Cable supply offer',
    status: 'issued' as const,
    bqNumber: 'BQ-07',
    sequenceNumber: 7,
    validUntil: '2026-09-30',
    totalAmount: '10000.00',
    issuedAt: '2026-08-02T00:00:00.000Z',
  };

  const LINE = {
    id: LINE_ID,
    lineNumber: 1,
    description: 'Power cable 4 sq mm',
    hsnCode: '854449',
    unitCode: 'mtr',
    quantity: '100.000',
    rate: '100.00',
    gstRate: '18.00',
    lineAmount: '10000.00',
  };

  const CLIENT = {
    id: CLIENT_ID,
    designation: 'M/s Sunrise Infra',
    contactPerson: null,
    address: null,
    phone: null,
    email: null,
    gstin: null,
    pincode: null,
    stateCode: null,
    isConsignee: false,
    isVendor: false,
    isClient: true,
    active: true,
    createdAt: '2026-07-01T00:00:00.000Z',
  };

  const DRAFT_DETAIL = {
    budgetaryQuotation: BQ_DRAFT,
    lines: [],
    customerSnapshot: null,
    previewTotal: '0.00',
  };

  const ISSUED_DETAIL = {
    budgetaryQuotation: BQ_ISSUED,
    lines: [LINE],
    customerSnapshot: null,
    previewTotal: '10000.00',
  };

  function bqApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      listBudgetaryQuotations: vi.fn().mockResolvedValue([BQ_ISSUED, BQ_DRAFT]),
      getBudgetaryQuotation: vi.fn().mockResolvedValue(DRAFT_DETAIL),
      listContacts: vi.fn().mockResolvedValue([CLIENT]),
      ...overrides,
    });
  }

  function renderQuotations(
    api: ApiClient,
    options: Partial<{
      canModify: boolean;
      canIssue: boolean;
      canCancel: boolean;
    }> = {},
  ) {
    return render(
      <Quotations
        api={api}
        organisationId={ORG_ID}
        canModify={options.canModify ?? true}
        canIssue={options.canIssue ?? true}
        canCancel={options.canCancel ?? true}
      />,
    );
  }

  it('lists quotations with status filter chips, totals, and status chips', async () => {
    renderQuotations(bqApi());

    await screen.findByRole('button', { name: 'BQ-07' });
    expect(screen.getByRole('button', { name: 'Draft' })).toBeTruthy();
    expect(screen.getByText('₹10,000.00')).toBeTruthy();
    expect(screen.getByText('issued')).toBeTruthy();
    expect(screen.getByText('draft')).toBeTruthy();

    // The chips filter the table without a round-trip; each carries its count.
    fireEvent.click(screen.getByRole('button', { name: /^Issued\s?1$/ }));
    expect(screen.queryByRole('button', { name: 'Draft' })).toBeNull();
    expect(screen.getByRole('button', { name: 'BQ-07' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Draft\s?1$/ }));
    expect(screen.queryByRole('button', { name: 'BQ-07' })).toBeNull();
  });

  it('creates a draft and round-trips its header and lines', async () => {
    const createBudgetaryQuotation = vi.fn().mockResolvedValue(DRAFT_DETAIL);
    const updateBudgetaryQuotation = vi.fn().mockResolvedValue({
      ...DRAFT_DETAIL,
      budgetaryQuotation: { ...BQ_DRAFT, validUntil: '2026-08-31' },
    });
    const saveBudgetaryQuotationLines = vi.fn().mockResolvedValue({
      ...DRAFT_DETAIL,
      lines: [LINE],
      previewTotal: '10000.00',
    });
    const api = bqApi({
      listBudgetaryQuotations: vi.fn().mockResolvedValue([]),
      createBudgetaryQuotation,
      updateBudgetaryQuotation,
      saveBudgetaryQuotationLines,
    });
    renderQuotations(api);

    // Nothing quoted yet, so the create form leads rather than hiding the
    // only thing there is to do. Picking a client links and prefills the
    // addressee; the free text stays the record and stays editable.
    fireEvent.change(await screen.findByLabelText('Client contact (optional)'), {
      target: { value: CLIENT_ID },
    });
    expect(screen.getByLabelText<HTMLInputElement>('Addressed to').value).toBe(
      'M/s Sunrise Infra',
    );
    fireEvent.change(screen.getByLabelText('Addressed to'), {
      target: { value: 'Sr DEE (G) Pune' },
    });
    fireEvent.change(screen.getByLabelText('Subject'), {
      target: { value: 'Supply of LED fittings' },
    });
    fireEvent.change(screen.getByLabelText('Quotation date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.click(submitButton('Create quotation'));
    await waitFor(() => {
      expect(createBudgetaryQuotation).toHaveBeenCalledWith(ORG_ID, {
        customerContactId: CLIENT_ID,
        addressedTo: 'Sr DEE (G) Pune',
        subject: 'Supply of LED fittings',
        bqDate: '2026-08-01',
      });
    });

    // The created draft opens below, loaded from the server: the header
    // round-trips into the editor.
    const details = await screen.findByRole('form', { name: 'Quotation details' });
    expect(within(details).getByLabelText<HTMLInputElement>('Addressed to').value).toBe(
      'Sr DEE (G) Pune',
    );
    fireEvent.change(within(details).getByLabelText('Valid until (optional)'), {
      target: { value: '2026-08-31' },
    });
    fireEvent.click(within(details).getByRole('button', { name: 'Save details' }));
    await waitFor(() => {
      expect(updateBudgetaryQuotation).toHaveBeenCalledWith(ORG_ID, BQ_DRAFT_ID, {
        addressedTo: 'Sr DEE (G) Pune',
        subject: 'Supply of LED fittings',
        bqDate: '2026-08-01',
        validUntil: '2026-08-31',
      });
    });

    // Lines save wholesale — HSN/SAC and GST optional but carried when
    // given — and the server answers with the recomputed exact total.
    const lines = screen.getByRole('form', { name: 'Quotation lines' });
    fireEvent.change(within(lines).getByLabelText('Line 1 description'), {
      target: { value: 'Power cable 4 sq mm' },
    });
    fireEvent.change(
      within(lines).getByLabelText('Line 1 HSN or SAC code (optional)'),
      { target: { value: '854449' } },
    );
    fireEvent.change(within(lines).getByLabelText('Line 1 unit'), {
      target: { value: 'mtr' },
    });
    fireEvent.change(within(lines).getByLabelText('Line 1 quantity'), {
      target: { value: '100' },
    });
    fireEvent.change(within(lines).getByLabelText('Line 1 rate'), {
      target: { value: '100.00' },
    });
    fireEvent.change(within(lines).getByLabelText('Line 1 GST rate (optional)'), {
      target: { value: '18' },
    });
    fireEvent.click(within(lines).getByRole('button', { name: 'Save lines' }));
    await waitFor(() => {
      expect(saveBudgetaryQuotationLines).toHaveBeenCalledWith(ORG_ID, BQ_DRAFT_ID, {
        lines: [
          {
            description: 'Power cable 4 sq mm',
            hsnCode: '854449',
            unitCode: 'mtr',
            quantity: '100',
            rate: '100.00',
            gstRate: '18',
          },
        ],
      });
    });
    expect(await screen.findByText('₹10,000.00')).toBeTruthy();
  });

  it('issues a draft, freezing its number and total', async () => {
    const issueBudgetaryQuotation = vi.fn().mockResolvedValue({
      budgetaryQuotation: {
        ...BQ_DRAFT,
        status: 'issued' as const,
        bqNumber: 'BQ-08',
        sequenceNumber: 8,
        totalAmount: '10000.00',
        issuedAt: '2026-08-03T00:00:00.000Z',
      },
      lines: [LINE],
      customerSnapshot: null,
      previewTotal: '10000.00',
    });
    const api = bqApi({
      getBudgetaryQuotation: vi.fn().mockResolvedValue({
        ...DRAFT_DETAIL,
        lines: [LINE],
        previewTotal: '10000.00',
      }),
      issueBudgetaryQuotation,
    });
    renderQuotations(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Issue quotation' }));
    await waitFor(() => {
      expect(issueBudgetaryQuotation).toHaveBeenCalledWith(ORG_ID, BQ_DRAFT_ID);
    });

    // The editor gives way to the issued record: number in the heading,
    // outcome controls below.
    expect(await screen.findByText(/Quotation BQ-08/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark converted' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save lines' })).toBeNull();
  });

  it('records the converted outcome on an issued quotation', async () => {
    const setBudgetaryQuotationOutcome = vi.fn().mockResolvedValue({
      ...ISSUED_DETAIL,
      budgetaryQuotation: { ...BQ_ISSUED, status: 'converted' as const },
    });
    const api = bqApi({
      getBudgetaryQuotation: vi.fn().mockResolvedValue(ISSUED_DETAIL),
      setBudgetaryQuotationOutcome,
    });
    renderQuotations(api);

    fireEvent.click(await screen.findByRole('button', { name: 'BQ-07' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark converted' }));
    await waitFor(() => {
      expect(setBudgetaryQuotationOutcome).toHaveBeenCalledWith(ORG_ID, BQ_ISSUED_ID, {
        outcome: 'converted',
      });
    });
    // The state never moves again; the record says so.
    expect(await screen.findByText(/This quotation is converted/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark converted' })).toBeNull();
  });

  it('withdraws an issued quotation behind its explanatory confirm', async () => {
    const setBudgetaryQuotationOutcome = vi.fn().mockResolvedValue({
      ...ISSUED_DETAIL,
      budgetaryQuotation: { ...BQ_ISSUED, status: 'withdrawn' as const },
    });
    const api = bqApi({
      getBudgetaryQuotation: vi.fn().mockResolvedValue(ISSUED_DETAIL),
      setBudgetaryQuotationOutcome,
    });
    renderQuotations(api);

    fireEvent.click(await screen.findByRole('button', { name: 'BQ-07' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw quotation…' }));
    // The note explains what withdrawing is before anything is sent.
    expect(screen.getByText(/keeps its number forever/)).toBeTruthy();
    expect(setBudgetaryQuotationOutcome).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Withdraw BQ-07 now' }));
    await waitFor(() => {
      expect(setBudgetaryQuotationOutcome).toHaveBeenCalledWith(ORG_ID, BQ_ISSUED_ID, {
        outcome: 'withdrawn',
      });
    });
    expect(await screen.findByText(/This quotation is withdrawn/)).toBeTruthy();
  });

  it('deletes a draft behind its confirm', async () => {
    const deleteBudgetaryQuotation = vi.fn().mockResolvedValue(undefined);
    const api = bqApi({ deleteBudgetaryQuotation });
    renderQuotations(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete draft…' }));
    expect(deleteBudgetaryQuotation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete draft now' }));
    await waitFor(() => {
      expect(deleteBudgetaryQuotation).toHaveBeenCalledWith(ORG_ID, BQ_DRAFT_ID);
    });
    // The editor closes with the draft gone.
    expect(screen.queryByRole('form', { name: 'Quotation details' })).toBeNull();
  });

  /* The client picker's disabled reasons (docs/UX.md § 31): an empty
     roster and an unreadable one are different sentences, because they
     demand opposite actions — Masters → Contacts versus a reload. */

  it('keeps the client picker visible but disabled when no client exists yet', async () => {
    renderQuotations(
      bqApi({
        listBudgetaryQuotations: vi.fn().mockResolvedValue([]),
        listContacts: vi.fn().mockResolvedValue([]),
      }),
    );

    const picker = await screen.findByLabelText<HTMLSelectElement>(
      'Client contact (optional)',
    );
    expect(picker.disabled).toBe(true);
    const reason = screen.getByText(/no client contact to link yet/);
    // Bound to the control, so the two are one announcement.
    expect(picker.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('says the roster could not be read rather than claiming it is empty', async () => {
    renderQuotations(
      bqApi({
        listBudgetaryQuotations: vi.fn().mockResolvedValue([]),
        listContacts: vi.fn().mockRejectedValue(new Error('down')),
      }),
    );

    const picker = await screen.findByLabelText<HTMLSelectElement>(
      'Client contact (optional)',
    );
    expect(picker.disabled).toBe(true);
    // The honest sentence: a failed read must not send the operator to
    // Masters to duplicate a contact that already exists.
    expect(screen.getByText(/contact master could not be read/)).toBeTruthy();
    expect(screen.queryByText(/no client contact to link yet/)).toBeNull();
  });
});

// --- Procurement: the Work's purchase orders --------------------------------
