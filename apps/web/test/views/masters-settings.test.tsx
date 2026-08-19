// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RequestFailedError, type ApiClient } from '../../src/api.js';
import { PaymentMatrix } from '../../src/views/PaymentMatrix.js';
import { SerialTrace } from '../../src/views/SerialTrace.js';
import {
  openForm,
  openMastersCategory,
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
    openMastersCategory('Contacts');

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
    openMastersCategory('Contacts');

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
    openMastersCategory('Contacts');

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
    openMastersCategory('Contacts');

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
    openMastersCategory('Contacts');

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
    openMastersCategory('Contacts');

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

    // The category strip is a navigation, not a tablist: each category is
    // its own address and Back walks between them.
    const categories = await screen.findByRole('navigation', {
      name: 'Master data categories',
    });
    fireEvent.click(within(categories).getByRole('button', { name: 'Units' }));
    expect(
      within(categories)
        .getByRole('button', { name: 'Units' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(await screen.findByText('Numbers')).toBeTruthy();
    expect(listUnitMasters).toHaveBeenCalledWith(ORG_ID, false);
  });

  // --- Canonical items (migration 0078) ------------------------------------

  const CANONICAL_ITEM = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Outdoor horn speaker 30W',
    groupName: 'Audio',
    make: 'Ahuja',
    model: 'UHC-30 XT',
    defaultUnit: 'Nos',
    aliases: ['horn speaker', '30 watt speaker'],
    mappedLineCount: 7,
    active: true,
    createdAt: '2026-08-08T00:00:00.000Z',
  };

  it('opens on Items and shows each item with its derived mapped-line count', async () => {
    const listCanonicalItems = vi
      .fn()
      .mockResolvedValue({ items: [CANONICAL_ITEM], unmappedLineCount: 4 });
    const { Masters } = await import('../../src/views/Masters.js');
    render(
      <Masters
        api={stubApi({ listCanonicalItems })}
        organisationId={ORG_ID}
        canModify
      />,
    );

    // Items leads the rail and is what the page opens on, matching the
    // mock — no click needed to get here.
    const categories = await screen.findByRole('navigation', {
      name: 'Master data categories',
    });
    expect(
      within(categories)
        .getByRole('button', { name: 'Items' })
        .getAttribute('aria-current'),
    ).toBe('page');

    expect(await screen.findByText('Outdoor horn speaker 30W')).toBeTruthy();
    expect(screen.getByText('Ahuja · UHC-30 XT')).toBeTruthy();
    expect(screen.getByText('horn speaker, 30 watt speaker')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    // The unmapped count is the operator's queue, not an error.
    expect(screen.getByText(/4 schedule lines still need mapping/)).toBeTruthy();
    expect(listCanonicalItems).toHaveBeenCalledWith(ORG_ID, false);
  });

  it('sends aliases one per line, because a wording can contain a comma', async () => {
    const saveCanonicalItem = vi.fn().mockResolvedValue(CANONICAL_ITEM);
    const { Masters } = await import('../../src/views/Masters.js');
    render(
      <Masters
        api={stubApi({
          listCanonicalItems: vi
            .fn()
            .mockResolvedValue({ items: [CANONICAL_ITEM], unmappedLineCount: 4 }),
          saveCanonicalItem,
        })}
        organisationId={ORG_ID}
        canModify
      />,
    );

    expect(await screen.findByText('Outdoor horn speaker 30W')).toBeTruthy();
    await openForm('New item');
    fireEvent.change(screen.getByLabelText('Canonical item name'), {
      target: { value: '3-core PVC power cable' },
    });
    fireEvent.change(screen.getByLabelText('Group'), {
      target: { value: 'Power & cabling' },
    });
    fireEvent.change(screen.getByLabelText('Default unit'), {
      target: { value: 'Metre' },
    });
    fireEvent.change(screen.getByLabelText('Aliases (one per line)'), {
      target: { value: 'power cable\ncable, 3 core, PVC\n' },
    });
    fireEvent.click(submitButton('Add item'));

    await waitFor(() => {
      expect(saveCanonicalItem).toHaveBeenCalledWith(ORG_ID, null, {
        name: '3-core PVC power cable',
        groupName: 'Power & cabling',
        defaultUnit: 'Metre',
        // The comma inside the second wording survives: splitting on
        // commas would have shredded the very description this field
        // exists to record.
        aliases: ['power cable', 'cable, 3 core, PVC'],
      });
    });
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('round-trips a contact bank beneficiary through the form', async () => {
    const beneficiary = {
      ...CONSIGNEE,
      id: '77777777-7777-4777-8777-777777777777',
      designation: 'Metro Industrial Supplies',
      isConsignee: false,
      isVendor: true,
      bankAccountHolder: 'Metro Industrial Supplies',
      bankName: 'State Bank of India',
      bankAccountNumber: '20199473820',
      bankIfsc: 'SBIN0000300',
      bankBranch: 'Andheri East',
      bankAccountType: 'Current',
    };
    const saveContact = vi.fn().mockResolvedValue(beneficiary);
    const { Masters } = await import('../../src/views/Masters.js');
    render(
      <Masters
        api={stubApi({
          listContacts: vi.fn().mockResolvedValue([beneficiary]),
          saveContact,
        })}
        organisationId={ORG_ID}
        canModify
      />,
    );
    openMastersCategory('Contacts');

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    // Prefilled in full, which is why the contact endpoint returns the
    // stored number rather than masking it: this form is a full replace,
    // and a masked value would save back as a wiped one.
    expect(screen.getByLabelText<HTMLInputElement>('Account number').value).toBe(
      '20199473820',
    );
    expect(screen.getByLabelText<HTMLInputElement>('IFSC code').value).toBe(
      'SBIN0000300',
    );

    fireEvent.change(screen.getByLabelText('Branch (optional)'), {
      target: { value: 'Bandra Kurla' },
    });
    fireEvent.click(submitButton('Save changes'));

    await waitFor(() => {
      expect(saveContact).toHaveBeenCalledWith(ORG_ID, beneficiary.id, {
        designation: 'Metro Industrial Supplies',
        address: 'Delhi Division, New Delhi',
        phone: '011-23385678',
        bankAccountHolder: 'Metro Industrial Supplies',
        bankName: 'State Bank of India',
        bankAccountNumber: '20199473820',
        bankIfsc: 'SBIN0000300',
        bankBranch: 'Bandra Kurla',
        bankAccountType: 'Current',
      });
    });
  });
});

describe('Settings: company bank accounts', () => {
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
  const ACCOUNT = {
    id: '88888888-8888-4888-8888-888888888888',
    accountHolder: 'Sharma Constructions',
    bankName: 'HDFC Bank',
    accountNumberLast4: '8842',
    ifsc: 'HDFC0000182',
    branch: 'Andheri East',
    active: true,
    createdAt: '2026-08-08T00:00:00.000Z',
  };

  /** Every test here needs the profile fetch to resolve before the bank
   * card is reachable, so the stub carries it and each test adds only the
   * bank-account behaviour it is about. */
  function bankApi(overrides: Partial<ApiClient>): ApiClient {
    return stubApi({
      organisationProfile: vi.fn().mockResolvedValue(PROFILE),
      ...overrides,
    });
  }

  it('shows the masked account and badges the oldest live one as primary', async () => {
    const second = {
      ...ACCOUNT,
      id: '99999999-9999-4999-8999-999999999999',
      bankName: 'ICICI Bank',
      accountNumberLast4: '1396',
      ifsc: 'ICIC0000274',
    };
    const { Settings } = await import('../../src/views/Settings.js');
    render(
      <Settings
        api={bankApi({
          listOrganisationBankAccounts: vi.fn().mockResolvedValue([ACCOUNT, second]),
        })}
        organisationId={ORG_ID}
        isOwner
      />,
    );

    expect(await screen.findByText('•••• 8842')).toBeTruthy();
    expect(screen.getByText('•••• 1396')).toBeTruthy();
    // Derived, not stored: the badge sits on the oldest live account and
    // nothing in the product chooses one yet.
    const badges = screen.getAllByText('Primary');
    expect(badges).toHaveLength(1);
  });

  it('adds an account and never asks the reader to trust a full number', async () => {
    const createOrganisationBankAccount = vi.fn().mockResolvedValue(ACCOUNT);
    const { Settings } = await import('../../src/views/Settings.js');
    render(
      <Settings
        api={bankApi({
          listOrganisationBankAccounts: vi.fn().mockResolvedValue([]),
          createOrganisationBankAccount,
        })}
        organisationId={ORG_ID}
        isOwner
      />,
    );

    // The empty state opens the form: an invoice asking the railway to
    // pay has nowhere to tell it to pay to until this list exists.
    fireEvent.change(await screen.findByLabelText('Account holder'), {
      target: { value: 'Sharma Constructions' },
    });
    fireEvent.change(screen.getByLabelText('Bank name'), {
      target: { value: 'HDFC Bank' },
    });
    fireEvent.change(screen.getByLabelText('Account number'), {
      target: { value: '50100298128842' },
    });
    fireEvent.change(screen.getByLabelText('IFSC code'), {
      target: { value: 'HDFC0000182' },
    });
    fireEvent.click(submitButton('Save account'));

    await waitFor(() => {
      expect(createOrganisationBankAccount).toHaveBeenCalledWith(ORG_ID, {
        accountHolder: 'Sharma Constructions',
        bankName: 'HDFC Bank',
        accountNumber: '50100298128842',
        ifsc: 'HDFC0000182',
      });
    });
  });

  it('hides the add and retire controls from a non-owner', async () => {
    const { Settings } = await import('../../src/views/Settings.js');
    render(
      <Settings
        api={bankApi({
          listOrganisationBankAccounts: vi.fn().mockResolvedValue([ACCOUNT]),
        })}
        organisationId={ORG_ID}
        isOwner={false}
      />,
    );

    expect(await screen.findByText('•••• 8842')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a bank account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();
  });
});

describe('SerialTrace', () => {
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
    query = 'sb-2026',
  ) {
    return render(
      <SerialTrace
        api={api}
        organisationId={ORG_ID}
        query={query}
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

  it('asks nothing of the API below the two-character floor', () => {
    const searchSerials = vi.fn();
    const { container } = renderLookup(stubApi({ searchSerials }), {}, 'x');

    // Search owns the floor and its message; the chain simply has nothing
    // to show for a query that cannot be run.
    expect(container.textContent).toBe('');
    expect(searchSerials).not.toHaveBeenCalled();
  });

  it('reports truncation', async () => {
    const searchSerials = vi.fn().mockResolvedValue({
      matches: Array.from({ length: 50 }, (_, index) => ({
        ...MATCH,
        id: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
        serialNumber: `SB-${String(index)}`,
      })),
      truncated: true,
    });
    renderLookup(stubApi({ searchSerials }), {}, 'SB');

    expect(await screen.findByText(/Showing the first 50 matches/)).toBeTruthy();
  });

  it('says so when nothing matches', async () => {
    const searchSerials = vi.fn().mockResolvedValue({ matches: [], truncated: false });
    renderLookup(stubApi({ searchSerials }), {}, 'ZZ-NONE');

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
  /** The schedule the matrix screen groups its item table by. Its items
   * ARE the flat work-item list — the component derives one from the
   * other, so a fixture only ever states it once. */
  type MatrixSchedules = React.ComponentProps<typeof PaymentMatrix>['schedules'];
  const matrixSchedules = (
    items: MatrixSchedules[number]['items'],
  ): MatrixSchedules => [
    {
      id: MATRIX_ITEM.scheduleId,
      scheduleCode: 'A',
      title: 'Supply of switchgear',
      position: 1,
      items,
    },
  ];
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
        schedules={matrixSchedules([MATRIX_ITEM])}
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
        schedules={matrixSchedules([])}
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
        schedules={matrixSchedules([])}
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
        schedules={matrixSchedules([MATRIX_ITEM])}
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

  it('sections the item table by schedule, with one control for all of them', async () => {
    /* The awarded-items editor directly above this table is already an
       accordion; flat, this was a second run of up to 129 rows arriving
       right after the reader had closed the first. */
    const api = stubApi({ getPaymentMatrix: vi.fn().mockResolvedValue([SUPPLY_ROW]) });
    render(
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        schedules={matrixSchedules([MATRIX_ITEM])}
        canModify
        onItemCategoryChanged={vi.fn()}
      />,
    );

    const section = await screen.findByRole('button', { name: /Schedule A/ });
    expect(section.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Payment category for A/1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByLabelText('Payment category for A/1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByLabelText('Payment category for A/1')).toBeTruthy();
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
        schedules={matrixSchedules([
          { ...MATRIX_ITEM, paymentCategory: 'SUPPLY' as const },
        ])}
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
