// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TaxInvoiceRegisterEntry } from '@auto-mb/contracts';
import { InvoicesRegister } from '../../src/views/InvoicesRegister.js';
import { CLIENT_CONTACT, ORG_ID, WORK_ID, stubApi } from './helpers.js';

/* The register answers what the per-Work list cannot: what have we
 * billed, to whom, and what is still unregistered — across Works, and
 * including the DIRECT invoices that belong to no Work at all and had no
 * screen before this one. So a row has to say where the invoice came
 * from, and a direct row has to say Direct rather than render a Work link
 * over three nulls. */

const WORK_BACKED: TaxInvoiceRegisterEntry = {
  id: '7a2c9a52-0000-4000-8000-00000000a001',
  workId: WORK_ID,
  workCode: 'DCW-1',
  workTitle: 'Supply of switchboards',
  invoiceNumber: 'TI/2026-27/001',
  invoiceDate: '2026-08-09',
  status: 'submitted',
  buyerName: 'Sr. DEE/TRD/Bhusawal',
  taxableValue: '125000.00',
  gstAmount: '22500.00',
  totalAmount: '147500.00',
  irn: 'a'.repeat(64),
  irpProvider: 'whitebooks',
  irpProviderState: 'registered',
  irpReportingDeadline: null,
  irpReportingOverdue: false,
};

const DIRECT: TaxInvoiceRegisterEntry = {
  id: '7a2c9a52-0000-4000-8000-00000000a002',
  workId: null,
  workCode: null,
  workTitle: null,
  invoiceNumber: null,
  invoiceDate: '2026-08-07',
  status: 'draft',
  buyerName: 'Deccan Switchgear Pvt Ltd',
  taxableValue: null,
  gstAmount: null,
  totalAmount: null,
  irn: null,
  irpProvider: null,
  irpProviderState: 'not_requested',
  irpReportingDeadline: null,
  irpReportingOverdue: false,
};

function page(
  invoices: readonly TaxInvoiceRegisterEntry[],
  nextCursor: string | null = null,
) {
  return { invoices, nextCursor };
}

function renderRegister(overrides: Parameters<typeof stubApi>[0] = {}) {
  const onOpenInvoice = vi.fn();
  const onOpenWork = vi.fn();
  const api = stubApi({
    listTaxInvoices: vi.fn().mockResolvedValue(page([WORK_BACKED, DIRECT])),
    listContacts: vi.fn().mockResolvedValue([CLIENT_CONTACT]),
    ...overrides,
  });
  render(
    <InvoicesRegister
      api={api}
      organisationId={ORG_ID}
      canModify
      canIssue
      canCancel
      canManageStatutory
      openInvoiceId={null}
      onOpenInvoice={onOpenInvoice}
      onOpenWork={onOpenWork}
    />,
  );
  return { api, onOpenInvoice, onOpenWork };
}

describe('the tax-invoice register', () => {
  it('lists an invoice with its buyer, money and both status languages', async () => {
    renderRegister();

    const link = await screen.findByRole('link', { name: 'TI/2026-27/001' });
    expect(link.getAttribute('href')).toBe(`#/invoices/${WORK_BACKED.id}`);
    expect(screen.getByText('Sr. DEE/TRD/Bhusawal')).toBeTruthy();
    expect(screen.getByText('09 Aug 2026')).toBeTruthy();
    // The local state and the statutory one are separate columns, never
    // collapsed into one ambiguous status.
    expect(screen.getByText('submitted')).toBeTruthy();
    expect(screen.getByText('Registered')).toBeTruthy();
  });

  it('names a direct invoice as Direct, and links a work-backed one to its Work', async () => {
    const { onOpenWork } = renderRegister();

    await screen.findByRole('link', { name: 'TI/2026-27/001' });
    // A direct invoice descends from no LOA: there is no Work to link to,
    // and the row says which kind of document it is instead.
    expect(screen.getByText('Direct')).toBeTruthy();
    expect(screen.getByText('Deccan Switchgear Pvt Ltd')).toBeTruthy();
    // A draft has no frozen money yet, and says so rather than showing a
    // zero it never measured.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);

    const workLink = screen.getByRole('link', { name: 'DCW-1' });
    expect(workLink.getAttribute('href')).toBe(`#/works/${WORK_ID}/bills`);
    fireEvent.click(workLink);
    expect(onOpenWork).toHaveBeenCalledWith(WORK_ID);
  });

  it('opens an invoice by its number', async () => {
    const { onOpenInvoice } = renderRegister();

    fireEvent.click(await screen.findByRole('link', { name: 'TI/2026-27/001' }));
    expect(onOpenInvoice).toHaveBeenCalledWith(WORK_BACKED.id);
  });

  it('shows an unnumbered draft as Draft rather than as blank', async () => {
    renderRegister();

    const draft = await screen.findByRole('link', { name: 'Draft' });
    expect(draft.getAttribute('href')).toBe(`#/invoices/${DIRECT.id}`);
  });

  it('asks for a page, and pages on with the cursor the server returned', async () => {
    const listTaxInvoices = vi
      .fn()
      .mockResolvedValueOnce(page([WORK_BACKED], DIRECT.id))
      .mockResolvedValueOnce(page([DIRECT]));
    renderRegister({ listTaxInvoices });

    await screen.findByRole('link', { name: 'TI/2026-27/001' });
    // A bounded first read: the register is not a table dump.
    expect(listTaxInvoices).toHaveBeenCalledWith(ORG_ID, { limit: 100 });

    fireEvent.click(screen.getByRole('button', { name: 'Load more invoices' }));
    expect(await screen.findByRole('link', { name: 'Draft' })).toBeTruthy();
    expect(listTaxInvoices).toHaveBeenLastCalledWith(ORG_ID, {
      limit: 100,
      cursor: DIRECT.id,
    });
    // The page that exhausted the register retires the button.
    expect(screen.queryByRole('button', { name: 'Load more invoices' })).toBeNull();
    // …and the first page is still on screen beneath the second.
    expect(screen.getByRole('link', { name: 'TI/2026-27/001' })).toBeTruthy();
  });

  it('narrows to a date window, and says so when the window is empty', async () => {
    const listTaxInvoices = vi
      .fn()
      .mockResolvedValueOnce(page([WORK_BACKED, DIRECT]))
      .mockResolvedValueOnce(page([]));
    renderRegister({ listTaxInvoices });

    await screen.findByRole('link', { name: 'TI/2026-27/001' });
    fireEvent.change(screen.getByLabelText('Invoiced on or after'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByLabelText('Invoiced on or before'), {
      target: { value: '2026-08-02' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply dates' }));

    // A filtered zero is not the same state as an empty register: it
    // offers the window back rather than the drafting story.
    expect(await screen.findByText(/No invoices were raised in these dates/)).toBeTruthy();
    expect(listTaxInvoices).toHaveBeenLastCalledWith(ORG_ID, {
      limit: 100,
      invoicedFrom: '2026-08-01',
      invoicedTo: '2026-08-02',
    });
  });

  it('raises a direct invoice with a stated taxable value and no Measurement Book', async () => {
    const createDirectTaxInvoice = vi.fn().mockResolvedValue({
      invoice: { ...DIRECT, id: DIRECT.id },
      buyerSnapshot: null,
      shipToSnapshot: null,
      issuedSnapshot: null,
      signedQr: null,
      lines: [],
    });
    const { onOpenInvoice } = renderRegister({ createDirectTaxInvoice });

    await screen.findByRole('link', { name: 'TI/2026-27/001' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Raise an invoice for a private customer' }),
    );

    fireEvent.change(screen.getByLabelText('Invoice date'), {
      target: { value: '2026-08-11' },
    });
    fireEvent.change(screen.getByLabelText('SAC code'), { target: { value: '998734' } });
    fireEvent.change(screen.getByLabelText('Tax payable on reverse charge'), {
      target: { value: 'false' },
    });
    fireEvent.change(screen.getByLabelText('Service description'), {
      target: { value: 'Panel commissioning at customer premises' },
    });
    fireEvent.change(screen.getByLabelText('GST rate (%)'), { target: { value: '18' } });
    fireEvent.change(screen.getByLabelText('Place of supply'), {
      target: { value: '27' },
    });
    fireEvent.change(screen.getByLabelText('Buyer'), {
      target: { value: CLIENT_CONTACT.id },
    });
    fireEvent.change(screen.getByLabelText('Taxable value'), {
      target: { value: '125000.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));

    await screen.findByText(/Draft tax invoice created/);
    expect(createDirectTaxInvoice).toHaveBeenCalledWith(ORG_ID, {
      invoiceDate: '2026-08-11',
      placeOfSupply: '27',
      reverseChargeApplicable: false,
      buyerContactId: CLIENT_CONTACT.id,
      sacCode: '998734',
      serviceDescription: 'Panel commissioning at customer premises',
      gstRate: '18',
      taxableValue: '125000.00',
    });
    // The new draft opens, so the operator lands on the document they
    // just raised rather than hunting for it in the register.
    expect(onOpenInvoice).toHaveBeenCalledWith(DIRECT.id);
  });

  it('refuses to hide the drafting workflow when no client contact exists', async () => {
    renderRegister({ listContacts: vi.fn().mockResolvedValue([]) });

    await screen.findByRole('link', { name: 'TI/2026-27/001' });
    // A disabled action with the way to fix it, not a silently absent one.
    const blocked = await screen.findByRole('button', {
      name: 'Raise an invoice for a private customer',
    });
    expect(blocked.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('link', { name: /Masters/ })).toBeTruthy();
  });
});
