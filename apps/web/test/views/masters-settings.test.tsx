// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RequestFailedError, type ApiClient } from '../../src/api.js';
import { PaymentMatrix } from '../../src/views/PaymentMatrix.js';
import { SerialLookup } from '../../src/views/SerialLookup.js';
import {
  openForm,
  submitButton,
  stubApi,
  ORG_ID,
  WORK_ID,
  CHALLAN_ID,
  ITEM_A,
} from './helpers.js';

describe('Settings', () => {
  const PROFILE = {
    id: ORG_ID,
    name: 'Sharma Constructions',
    slug: 'sharma',
    address: null,
    gstin: null,
    stateCode: null,
    contactPhone: null,
    contactEmail: null,
    hasLogo: false,
  };

  it('lets an owner edit company details, GST state code included', async () => {
    const updateOrganisationProfile = vi.fn().mockResolvedValue({
      ...PROFILE,
      address: 'Plot 4, MIDC, Nashik',
      gstin: '27ABCDE1234F1Z5',
      stateCode: '27',
    });
    const { Settings } = await import('../../src/views/Settings.js');
    render(
      <Settings
        api={stubApi({
          organisationProfile: vi.fn().mockResolvedValue(PROFILE),
          updateOrganisationProfile,
        })}
        organisationId={ORG_ID}
        isOwner
      />,
    );

    // Awaited on a LOADED control, never on the heading: Settings renders
    // its <h1> during the profile fetch too, so waiting for the heading
    // resolves against the loading state and the next line then races the
    // fetch. That race is why this file failed once in CI under load.
    fireEvent.change(await screen.findByLabelText('Address'), {
      target: { value: 'Plot 4, MIDC, Nashik' },
    });
    fireEvent.change(screen.getByLabelText('GSTIN'), {
      target: { value: '27ABCDE1234F1Z5' },
    });
    fireEvent.change(screen.getByLabelText('GST state code'), {
      target: { value: '27' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save company details' }));

    await waitFor(() => {
      expect(updateOrganisationProfile).toHaveBeenCalledWith(ORG_ID, {
        name: 'Sharma Constructions',
        address: 'Plot 4, MIDC, Nashik',
        gstin: '27ABCDE1234F1Z5',
        stateCode: '27',
        tradeName: null,
        locality: null,
        pincode: null,
        contactPhone: null,
        contactEmail: null,
        msmeNumber: null,
        invoiceNumberPrefix: null,
        invoiceNotes: null,
        warrantyTemplateText: null,
      });
    });
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('pins the STATE_CODE_GSTIN_MISMATCH refusal to the state-code field', async () => {
    const message =
      'The GST state code 29 contradicts the GSTIN 27ABCDE1234F1Z5, which is registered in state 27. The state code decides CGST+SGST against IGST on every invoice, so correct whichever of the two is wrong.';
    const updateOrganisationProfile = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(400, 'STATE_CODE_GSTIN_MISMATCH', message),
      );
    const { Settings } = await import('../../src/views/Settings.js');
    render(
      <Settings
        api={stubApi({
          organisationProfile: vi
            .fn()
            .mockResolvedValue({ ...PROFILE, gstin: '27ABCDE1234F1Z5' }),
          updateOrganisationProfile,
        })}
        organisationId={ORG_ID}
        isOwner
      />,
    );

    const stateCode = await screen.findByLabelText('GST state code');
    fireEvent.change(stateCode, { target: { value: '29' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save company details' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(message);
    // Inline: the refusal is the field's own description, not a footer.
    expect(stateCode.getAttribute('aria-invalid')).toBe('true');
    expect(stateCode.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('shows read-only details to non-owners', async () => {
    const { Settings } = await import('../../src/views/Settings.js');
    render(
      <Settings
        api={stubApi({
          organisationProfile: vi.fn().mockResolvedValue({
            ...PROFILE,
            address: 'Plot 4, MIDC, Nashik',
          }),
        })}
        organisationId={ORG_ID}
        isOwner={false}
      />,
    );

    expect(await screen.findByText('Plot 4, MIDC, Nashik')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save company details' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload logo' })).toBeNull();
  });

  it('saves the warranty template through the profile update', async () => {
    const updateOrganisationProfile = vi.fn().mockResolvedValue({
      ...PROFILE,
      warrantyTemplateText: 'Goods carry a 24-month warranty.',
    });
    const { Settings } = await import('../../src/views/Settings.js');
    render(
      <Settings
        api={stubApi({
          organisationProfile: vi.fn().mockResolvedValue(PROFILE),
          updateOrganisationProfile,
        })}
        organisationId={ORG_ID}
        isOwner
      />,
    );

    fireEvent.change(await screen.findByLabelText('Warranty agreement template'), {
      target: { value: 'Goods carry a 24-month warranty.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save company details' }));

    await waitFor(() => {
      expect(updateOrganisationProfile).toHaveBeenCalledWith(
        ORG_ID,
        expect.objectContaining({
          warrantyTemplateText: 'Goods carry a 24-month warranty.',
        }),
      );
    });
  });
});

describe('Masters', () => {
  const CONSIGNEE = {
    id: '44444444-4444-4444-8444-444444444444',
    designation: 'Sr. DEE (G) NR',
    address: 'Delhi Division, New Delhi',
    contactPerson: null,
    phone: '011-23385678',
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

  it('lists contacts and adds one through the form', async () => {
    const saveContact = vi.fn().mockResolvedValue(CONSIGNEE);
    const api = stubApi({
      listContacts: vi.fn().mockResolvedValue([CONSIGNEE]),
      saveContact,
    });
    const { Masters } = await import('../../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify />);

    expect(await screen.findByText('Sr. DEE (G) NR')).toBeTruthy();
    await openForm('New contact');
    fireEvent.change(screen.getByLabelText('Designation / name'), {
      target: { value: 'SSE (Signal) GZB' },
    });
    fireEvent.change(screen.getByLabelText('Address (optional)'), {
      target: { value: 'Signal Workshop, Ghaziabad' },
    });
    fireEvent.click(submitButton('Add contact'));

    await waitFor(() => {
      expect(saveContact).toHaveBeenCalledWith(ORG_ID, null, {
        designation: 'SSE (Signal) GZB',
        address: 'Signal Workshop, Ghaziabad',
      });
    });
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  const VENDOR_CLIENT = {
    ...CONSIGNEE,
    id: '66666666-6666-4666-8666-666666666666',
    designation: 'M/s Kay Traders',
    address: 'Industrial Area, Kanpur',
    phone: null,
    isConsignee: false,
    isVendor: true,
    isClient: true,
  };

  it('creates a vendor: checking the role unchecks the derived consignee box', async () => {
    const saveContact = vi.fn().mockResolvedValue(VENDOR_CLIENT);
    const api = stubApi({
      listContacts: vi.fn().mockResolvedValue([CONSIGNEE]),
      saveContact,
    });
    const { Masters } = await import('../../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify />);

    expect(await screen.findByText('Sr. DEE (G) NR')).toBeTruthy();
    await openForm('New contact');
    const consigneeRole = screen.getByLabelText<HTMLInputElement>('Consignee');
    // A create naming no role makes a consignee, so the box starts checked
    // — and stays read-only, because isConsignee is a create-time fact.
    expect(consigneeRole.checked).toBe(true);
    expect(consigneeRole.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText<HTMLInputElement>('Vendor'));
    expect(screen.getByLabelText<HTMLInputElement>('Consignee').checked).toBe(false);

    fireEvent.change(screen.getByLabelText('Designation / name'), {
      target: { value: 'M/s Kay Traders' },
    });
    fireEvent.click(submitButton('Add contact'));

    await waitFor(() => {
      expect(saveContact).toHaveBeenCalledWith(ORG_ID, null, {
        designation: 'M/s Kay Traders',
        isVendor: true,
      });
    });
  });

  it('shows each contact role as a chip in the list', async () => {
    const api = stubApi({
      listContacts: vi.fn().mockResolvedValue([CONSIGNEE, VENDOR_CLIENT]),
    });
    const { Masters } = await import('../../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify />);

    expect(await screen.findByText('M/s Kay Traders')).toBeTruthy();
    expect(screen.getByText('consignee')).toBeTruthy();
    expect(screen.getByText('vendor')).toBeTruthy();
    expect(screen.getByText('client')).toBeTruthy();
  });

  it('sends only the changed role flag when editing, never isConsignee', async () => {
    const saveContact = vi
      .fn()
      .mockResolvedValue({ ...VENDOR_CLIENT, isClient: false });
    const api = stubApi({
      listContacts: vi.fn().mockResolvedValue([VENDOR_CLIENT]),
      saveContact,
    });
    const { Masters } = await import('../../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('heading', { name: 'Edit M/s Kay Traders' });
    const clientRole = screen.getByLabelText<HTMLInputElement>('Client');
    expect(clientRole.checked).toBe(true);
    fireEvent.click(clientRole);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      // Vendor is untouched so it does not travel; the dropped client role
      // travels as an explicit false. isConsignee is never a request field.
      expect(saveContact).toHaveBeenCalledWith(ORG_ID, VENDOR_CLIENT.id, {
        designation: 'M/s Kay Traders',
        address: 'Industrial Area, Kanpur',
        isClient: false,
      });
    });
  });

  it('retires a contact and surfaces duplicate conflicts as alerts', async () => {
    const setContactActive = vi.fn().mockResolvedValue({ ...CONSIGNEE, active: false });
    const saveContact = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'CONTACT_EXISTS',
          'An active contact with this designation and address already exists.',
        ),
      );
    const api = stubApi({
      listContacts: vi.fn().mockResolvedValue([CONSIGNEE]),
      setContactActive,
      saveContact,
    });
    const { Masters } = await import('../../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    await waitFor(() => {
      expect(setContactActive).toHaveBeenCalledWith(ORG_ID, CONSIGNEE.id, false);
    });

    await openForm('New contact');
    fireEvent.change(screen.getByLabelText('Designation / name'), {
      target: { value: 'Sr. DEE (G) NR' },
    });
    fireEvent.click(submitButton('Add contact'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('already exists');
  });

  it('hides mutations from read-only members', async () => {
    const api = stubApi({
      listContacts: vi.fn().mockResolvedValue([CONSIGNEE]),
    });
    const { Masters } = await import('../../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify={false} />);

    expect(await screen.findByText('Sr. DEE (G) NR')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add contact' })).toBeNull();
  });

  it('switches to the units tab and shows the seeded canon', async () => {
    const listUnitMasters = vi.fn().mockResolvedValue([
      {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Numbers',
        active: true,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    ]);
    const api = stubApi({ listUnitMasters });
    const { Masters } = await import('../../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify />);

    fireEvent.click(await screen.findByRole('tab', { name: 'Units' }));
    expect(await screen.findByText('Numbers')).toBeTruthy();
    expect(listUnitMasters).toHaveBeenCalledWith(ORG_ID, false);
  });
});

describe('SerialLookup', () => {
  const MATCH = {
    id: '99999999-9999-4999-8999-999999999999',
    serialNumber: 'SB-2026-014',
    workId: WORK_ID,
    workCode: 'DCW-1',
    workTitle: 'Supply of switchboards',
    itemDescription: 'Main switchboard',
    challanId: CHALLAN_ID,
    challanNumber: 'DC/1',
    challanDate: '2026-08-08',
    challanStatus: 'issued' as const,
    receiptRecorded: true,
    installedOn: null,
  };

  function renderLookup(
    api: ApiClient,
    handlers: Partial<{
      onOpenWork: (workId: string) => void;
      onOpenChallan: (workId: string, challanId: string) => void;
    }> = {},
  ) {
    return render(
      <SerialLookup
        api={api}
        organisationId={ORG_ID}
        onOpenWork={handlers.onOpenWork ?? vi.fn()}
        onOpenChallan={handlers.onOpenChallan ?? vi.fn()}
      />,
    );
  }

  it('searches and links each match to its work and challan', async () => {
    const searchSerials = vi
      .fn()
      .mockResolvedValue({ matches: [MATCH], truncated: false });
    const onOpenWork = vi.fn();
    const onOpenChallan = vi.fn();
    renderLookup(stubApi({ searchSerials }), { onOpenWork, onOpenChallan });

    fireEvent.change(screen.getByLabelText('Serial number'), {
      target: { value: 'sb-2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(searchSerials).toHaveBeenCalledWith(ORG_ID, 'sb-2026');
    });
    expect(await screen.findByText('SB-2026-014')).toBeTruthy();
    expect(screen.getByText('received')).toBeTruthy();
    expect(screen.getByText('not installed')).toBeTruthy();

    const workLink = screen.getByRole('link', { name: 'DCW-1' });
    expect(workLink.getAttribute('href')).toBe(`#/works/${WORK_ID}`);
    fireEvent.click(workLink);
    expect(onOpenWork).toHaveBeenCalledWith(WORK_ID);
    const challanLink = screen.getByRole('link', { name: 'DC/1' });
    expect(challanLink.getAttribute('href')).toBe(
      `#/works/${WORK_ID}/challans/${CHALLAN_ID}`,
    );
    fireEvent.click(challanLink);
    expect(onOpenChallan).toHaveBeenCalledWith(WORK_ID, CHALLAN_ID);
  });

  it('rejects queries shorter than 2 characters without calling the API', async () => {
    const searchSerials = vi.fn();
    renderLookup(stubApi({ searchSerials }));

    fireEvent.change(screen.getByLabelText('Serial number'), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Enter at least 2 characters of the serial number.',
    );
    expect(searchSerials).not.toHaveBeenCalled();
  });

  it('reports truncation and the empty state', async () => {
    const searchSerials = vi
      .fn()
      .mockResolvedValueOnce({
        matches: Array.from({ length: 50 }, (_, index) => ({
          ...MATCH,
          id: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
          serialNumber: `SB-${String(index)}`,
        })),
        truncated: true,
      })
      .mockResolvedValueOnce({ matches: [], truncated: false });
    renderLookup(stubApi({ searchSerials }));

    fireEvent.change(screen.getByLabelText('Serial number'), {
      target: { value: 'SB' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Showing the first 50 matches/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Serial number'), {
      target: { value: 'ZZ-NONE' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/No serial matches/)).toBeTruthy();
  });
});

describe('PaymentMatrix', () => {
  const MATRIX_ITEM = {
    id: ITEM_A,
    scheduleId: '77777777-7777-4777-8777-777777777777',
    itemNumber: 'A/1',
    description: 'Main switchboard',
    unitCode: 'Nos',
    awardedQuantity: '5.000',
    effectiveRate: '100.00',
    requiresSerials: false,
    paymentCategory: null,
  };
  const SUPPLY_ROW = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    workId: WORK_ID,
    category: 'SUPPLY' as const,
    pctSupply: '80.00',
    pctInstallation: '10.00',
    pctPac: '0.00',
    pctFinalBill: '10.00',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  };

  it('shows saved rows, states the R10 rule, and saves an edited row', async () => {
    const upsertPaymentMatrixRow = vi.fn().mockResolvedValue({
      ...SUPPLY_ROW,
      pctSupply: '70.00',
      pctFinalBill: '20.00',
    });
    const api = stubApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([SUPPLY_ROW]),
      upsertPaymentMatrixRow,
    });
    render(
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[MATRIX_ITEM]}
        canModify
        onItemCategoryChanged={vi.fn()}
      />,
    );

    const supplyInput =
      await screen.findByLabelText<HTMLInputElement>('Supply % for Supply');
    expect(supplyInput.value).toBe('80.00');
    // Percentages are per category, never per item — the settled R10 note.
    expect(screen.getByText(/never per item/)).toBeTruthy();
    expect(screen.getByText(/settled decision R10/)).toBeTruthy();

    fireEvent.change(supplyInput, { target: { value: '70.00' } });
    fireEvent.change(screen.getByLabelText('Final bill % for Supply'), {
      target: { value: '20.00' },
    });
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    fireEvent.click(saveButtons[0] as HTMLElement);
    await waitFor(() => {
      expect(upsertPaymentMatrixRow).toHaveBeenCalledWith(ORG_ID, WORK_ID, 'SUPPLY', {
        pctSupply: '70.00',
        pctInstallation: '10.00',
        pctPac: '0.00',
        pctFinalBill: '20.00',
      });
    });
    expect((await screen.findByRole('status')).textContent).toContain(
      'Percentages saved',
    );
  });

  it('flags a sum that is not exactly 100 inline and disables the save', async () => {
    const upsertPaymentMatrixRow = vi.fn();
    const api = stubApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([SUPPLY_ROW]),
      upsertPaymentMatrixRow,
    });
    render(
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[]}
        canModify
        onItemCategoryChanged={vi.fn()}
      />,
    );
    const supplyInput = await screen.findByLabelText('Supply % for Supply');
    fireEvent.change(supplyInput, { target: { value: '75.00' } });
    const alerts = await screen.findAllByRole('alert');
    expect(
      alerts.some((alert) =>
        (alert.textContent ?? '').includes('must sum to exactly 100'),
      ),
    ).toBe(true);
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    expect((saveButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect(upsertPaymentMatrixRow).not.toHaveBeenCalled();
  });

  it('removes a configured row', async () => {
    const deletePaymentMatrixRow = vi.fn().mockResolvedValue(undefined);
    const api = stubApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([SUPPLY_ROW]),
      deletePaymentMatrixRow,
    });
    render(
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[]}
        canModify
        onItemCategoryChanged={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(deletePaymentMatrixRow).toHaveBeenCalledWith(ORG_ID, WORK_ID, 'SUPPLY');
    });
    expect((await screen.findByRole('status')).textContent).toContain('row removed');
  });

  it('sets an item payment category and reports it to the parent', async () => {
    const setWorkItemPaymentCategory = vi.fn().mockResolvedValue({
      id: ITEM_A,
      itemNumber: 'A/1',
      paymentCategory: 'SUPPLY',
    });
    const onItemCategoryChanged = vi.fn();
    const api = stubApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([]),
      setWorkItemPaymentCategory,
    });
    render(
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[MATRIX_ITEM]}
        canModify
        onItemCategoryChanged={onItemCategoryChanged}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Payment category for A/1'), {
      target: { value: 'SUPPLY' },
    });
    await waitFor(() => {
      expect(setWorkItemPaymentCategory).toHaveBeenCalledWith(ORG_ID, ITEM_A, 'SUPPLY');
    });
    expect(onItemCategoryChanged).toHaveBeenCalledWith(ITEM_A, 'SUPPLY');
  });

  it('renders read-only percentages and categories for viewers', async () => {
    const api = stubApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([SUPPLY_ROW]),
    });
    render(
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[{ ...MATRIX_ITEM, paymentCategory: 'SUPPLY' as const }]}
        canModify={false}
        onItemCategoryChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText('80.00')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByLabelText('Payment category for A/1')).toBeNull();
    expect(screen.getAllByText('Supply').length).toBeGreaterThan(0);
  });
});
