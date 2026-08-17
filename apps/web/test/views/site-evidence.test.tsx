// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../../src/api.js';
import { Installations } from '../../src/views/Installations.js';
import { MeasurementBooks } from '../../src/views/MeasurementBooks.js';
import { PacCertificates } from '../../src/views/PacCertificates.js';
import { openForm, submitButton, stubApi, ORG_ID, WORK_ID } from './helpers.js';

describe('Installations', () => {
  const ITEM_PLAIN = '44444444-4444-4444-8444-444444444444';
  const ITEM_SERIAL = '55555555-5555-4555-8555-555555555555';
  const LOCATION_ID = '66666666-6666-4666-8666-666666666666';
  const INSTALLATION_ID = '99999999-9999-4999-8999-999999999999';
  const SERIAL_ONE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const SERIAL_TWO = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
  const CHALLAN = '77777777-1111-4111-8111-777777777777';
  const CHALLAN_ITEM = '77777777-2222-4222-8222-777777777777';

  const WORK_ITEMS: readonly WorkItem[] = [
    {
      id: ITEM_PLAIN,
      scheduleId: '77777777-7777-4777-8777-777777777777',
      itemNumber: 'A/1',
      description: 'Cable set',
      unitCode: 'Set',
      awardedQuantity: '10.000',
      effectiveRate: '250.00',
      requiresSerials: false,
    },
    {
      id: ITEM_SERIAL,
      scheduleId: '77777777-7777-4777-8777-777777777777',
      itemNumber: 'A/2',
      description: 'Main switchboard',
      unitCode: 'Nos',
      awardedQuantity: '5.000',
      effectiveRate: '100.00',
      requiresSerials: true,
    },
  ];

  const SERIALS = [
    {
      id: SERIAL_ONE,
      deliveryChallanId: CHALLAN,
      challanItemId: CHALLAN_ITEM,
      challanNumber: 'DC/1',
      itemDescription: 'Main switchboard',
      serialNumber: 'SN-001',
      installedOn: null,
      installationRemarks: null,
      workItemId: ITEM_SERIAL,
      challanStatus: 'issued' as const,
      installationId: null,
      installationLocation: null,
    },
    {
      id: SERIAL_TWO,
      deliveryChallanId: CHALLAN,
      challanItemId: CHALLAN_ITEM,
      challanNumber: 'DC/1',
      itemDescription: 'Main switchboard',
      serialNumber: 'SN-002',
      installedOn: null,
      installationRemarks: null,
      workItemId: ITEM_SERIAL,
      challanStatus: 'issued' as const,
      installationId: null,
      installationLocation: null,
    },
    {
      id: 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa',
      deliveryChallanId: CHALLAN,
      challanItemId: CHALLAN_ITEM,
      challanNumber: 'DC/1',
      itemDescription: 'Main switchboard',
      serialNumber: 'SN-003',
      installedOn: '2026-08-01',
      installationRemarks: null,
      workItemId: ITEM_SERIAL,
      challanStatus: 'issued' as const,
      installationId: INSTALLATION_ID,
      installationLocation: 'Nashik Road station',
    },
  ];

  const LOCATION = {
    id: LOCATION_ID,
    name: 'Nashik Road station',
    kind: 'station' as const,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const RECORDED = {
    id: INSTALLATION_ID,
    workId: WORK_ID,
    workItemId: ITEM_SERIAL,
    itemNumber: 'A/2',
    quantity: '1.000',
    installedOn: '2026-08-01',
    locationId: LOCATION_ID,
    locationName: 'Nashik Road station',
    remarks: null,
    status: 'recorded' as const,
    cancellationNote: null,
    serials: [
      {
        serialId: 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa',
        serialNumber: 'SN-003',
        challanNumber: 'DC/1',
      },
    ],
    createdAt: '2026-08-01T00:00:00.000Z',
    cancelledAt: null,
  };

  const LIST = {
    installations: [RECORDED],
    itemSummaries: [
      { workItemId: ITEM_PLAIN, itemNumber: 'A/1', installedQuantity: '0.000' },
      { workItemId: ITEM_SERIAL, itemNumber: 'A/2', installedQuantity: '1.000' },
    ],
  };

  function installationsApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      listWorkInstallations: vi.fn().mockResolvedValue(LIST),
      listLocationMasters: vi.fn().mockResolvedValue([LOCATION]),
      listWorkSerials: vi.fn().mockResolvedValue(SERIALS),
      ...overrides,
    });
  }

  function renderInstallations(
    api: ApiClient,
    options: Partial<{
      canRecordEvidence: boolean;
      workItems: readonly WorkItem[];
    }> = {},
  ) {
    return render(
      <Installations
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canRecordEvidence={options.canRecordEvidence ?? true}
        workItems={options.workItems ?? WORK_ITEMS}
        serials={SERIALS}
        onSerialsChanged={vi.fn()}
      />,
    );
  }

  it('shows the per-item installed summary and the records', async () => {
    renderInstallations(installationsApi());

    await screen.findByRole('button', { name: 'New installation' });
    // Summary rows: the authoritative installed quantity per item.
    expect(screen.getAllByText('1.000').length).toBeGreaterThan(0);
    expect(screen.getByText('0.000')).toBeTruthy();
    // The record row with its snapshot location and serials.
    expect(screen.getAllByText('Nashik Road station').length).toBeGreaterThan(0);
    expect(screen.getByText('SN-003')).toBeTruthy();
    expect(screen.getByText('recorded')).toBeTruthy();
  });

  it('keeps installation evidence visible when the location master fails', async () => {
    const listLocationMasters = vi
      .fn()
      .mockRejectedValueOnce(new Error('Locations unavailable.'))
      .mockResolvedValueOnce([LOCATION]);
    renderInstallations(installationsApi({ listLocationMasters }));

    expect(await screen.findByText('SN-003')).toBeTruthy();
    expect(screen.getAllByText('Nashik Road station').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Cancel record' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /location master could not be loaded/i,
    );
    expect(screen.queryByRole('button', { name: 'New installation' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry locations' }));

    expect(
      await screen.findByRole('button', { name: 'New installation' }),
    ).toBeTruthy();
    expect(listLocationMasters).toHaveBeenCalledTimes(2);
  });

  it('records a plain quantity installation against an existing location', async () => {
    const recordWorkInstallation = vi.fn().mockResolvedValue({
      ...RECORDED,
      id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
      workItemId: ITEM_PLAIN,
      itemNumber: 'A/1',
      quantity: '2.500',
      serials: [],
      locationId: LOCATION_ID,
    });
    const api = installationsApi({ recordWorkInstallation });
    renderInstallations(api);

    await openForm('New installation');
    fireEvent.change(screen.getByLabelText('1. Work item'), {
      target: { value: ITEM_PLAIN },
    });
    fireEvent.change(screen.getByLabelText('2. Quantity installed'), {
      target: { value: '2.500' },
    });
    fireEvent.change(screen.getByLabelText('3. Installed on'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(screen.getByLabelText('4. Location'), {
      target: { value: LOCATION_ID },
    });
    fireEvent.click(submitButton('Record installation'));

    await waitFor(() => {
      expect(recordWorkInstallation).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        workItemId: ITEM_PLAIN,
        quantity: '2.500',
        installedOn: '2026-08-05',
        locationId: LOCATION_ID,
      });
    });
  });

  it('keeps a successful record successful when the location refresh fails', async () => {
    const recordWorkInstallation = vi.fn().mockResolvedValue(RECORDED);
    const listLocationMasters = vi
      .fn()
      .mockResolvedValueOnce([LOCATION])
      .mockRejectedValueOnce(new Error('Locations unavailable.'));
    const api = installationsApi({ recordWorkInstallation, listLocationMasters });
    renderInstallations(api);

    await openForm('New installation');
    fireEvent.change(screen.getByLabelText('2. Quantity installed'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('3. Installed on'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.click(submitButton('Record installation'));

    expect(await screen.findByText('Installation recorded.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry locations' })).toBeTruthy();
    expect(screen.queryByText(/nothing was changed/i)).toBeNull();
  });

  it('records a serialised installation with tap-selected serials and an inline location', async () => {
    const recordWorkInstallation = vi.fn().mockResolvedValue(RECORDED);
    const api = installationsApi({ recordWorkInstallation });
    renderInstallations(api);

    await openForm('New installation');
    fireEvent.change(screen.getByLabelText('1. Work item'), {
      target: { value: ITEM_SERIAL },
    });
    // The pool offers only delivered-but-uninstalled serials of the item.
    expect(screen.getByLabelText(/SN-001/)).toBeTruthy();
    expect(screen.getByLabelText(/SN-002/)).toBeTruthy();
    expect(screen.queryByLabelText(/SN-003/)).toBeNull();

    fireEvent.change(screen.getByLabelText('2. Quantity installed'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('3. Installed on'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(screen.getByLabelText('4. Location'), {
      target: { value: '__new__' },
    });
    fireEvent.change(screen.getByLabelText('New location name'), {
      target: { value: 'Bhusawal yard' },
    });
    fireEvent.change(screen.getByLabelText('New location kind'), {
      target: { value: 'installation_point' },
    });
    fireEvent.click(screen.getByLabelText(/SN-001/));
    fireEvent.click(screen.getByLabelText(/SN-002/));
    fireEvent.click(submitButton('Record installation'));

    await waitFor(() => {
      expect(recordWorkInstallation).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        workItemId: ITEM_SERIAL,
        quantity: '2',
        installedOn: '2026-08-05',
        newLocation: { name: 'Bhusawal yard', kind: 'installation_point' },
        serialIds: [SERIAL_ONE, SERIAL_TWO],
      });
    });
  });

  it('cancels a record with a mandatory note', async () => {
    const cancelWorkInstallation = vi.fn().mockResolvedValue({
      ...RECORDED,
      status: 'cancelled',
      cancellationNote: 'Wrong item picked',
      cancelledAt: '2026-08-06T00:00:00.000Z',
    });
    const api = installationsApi({ cancelWorkInstallation });
    renderInstallations(api);

    fireEvent.change(
      // The date reads the way every other date in the product does.
      await screen.findByLabelText(/Cancellation note for A\/2 on 01 Aug 2026/),
      { target: { value: 'Wrong item picked' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel record' }));

    await waitFor(() => {
      expect(cancelWorkInstallation).toHaveBeenCalledWith(
        ORG_ID,
        INSTALLATION_ID,
        'Wrong item picked',
      );
    });
  });

  it('announces a cap conflict in an alert region', async () => {
    const recordWorkInstallation = vi.fn().mockRejectedValue(
      // The sanctioned quantity stopped capping installation in
      // migration 0077; the delivery floor below it did not, and it is
      // the cap conflict the recording form can still meet.
      new RequestFailedError(
        409,
        'INSTALLATION_EXCEEDS_DELIVERY',
        'Cumulative installation for A/1 would exceed the delivered quantity.',
      ),
    );
    const api = installationsApi({ recordWorkInstallation });
    renderInstallations(api);

    await openForm('New installation');
    fireEvent.change(screen.getByLabelText('2. Quantity installed'), {
      target: { value: '99' },
    });
    fireEvent.change(screen.getByLabelText('3. Installed on'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.click(submitButton('Record installation'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('exceed the delivered quantity');
  });

  it('flags an over-installed item as owing a variation, on the row and in the form', async () => {
    // Replicates the mock's chip (Auto-MB-Vercel-du,
    // components/installation-capture-flow.tsx at a8e1fde): same words,
    // same warning tone. The flag is the server's — the browser never
    // compares the quantities itself.
    renderInstallations(installationsApi(), {
      workItems: WORK_ITEMS.map((item) =>
        item.id === ITEM_PLAIN ? { ...item, pendingVariation: true } : item,
      ),
    });

    await screen.findByRole('button', { name: 'New installation' });
    expect(screen.getAllByText('Above LOA — variation pending')).toHaveLength(1);

    // …and again beside the item picker once the form is open on it.
    await openForm('New installation');
    fireEvent.change(screen.getByLabelText('1. Work item'), {
      target: { value: ITEM_PLAIN },
    });
    expect(screen.getAllByText('Above LOA — variation pending')).toHaveLength(2);
  });

  it('raises the chip from the recording response, before the Work reloads', async () => {
    // The Work items this panel is handed are the ones the Work page last
    // loaded, so the recording that CREATES the variation would otherwise
    // leave the operator looking at a screen that does not know yet.
    const recordWorkInstallation = vi.fn().mockResolvedValue({
      ...RECORDED,
      workItemId: ITEM_PLAIN,
      itemNumber: 'A/1',
      quantity: '12.000',
      serials: [],
      locationId: LOCATION_ID,
      pendingVariation: true,
    });
    renderInstallations(installationsApi({ recordWorkInstallation }));

    await openForm('New installation');
    expect(screen.queryByText('Above LOA — variation pending')).toBeNull();
    fireEvent.change(screen.getByLabelText('1. Work item'), {
      target: { value: ITEM_PLAIN },
    });
    fireEvent.change(screen.getByLabelText('2. Quantity installed'), {
      target: { value: '12.000' },
    });
    fireEvent.change(screen.getByLabelText('3. Installed on'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(screen.getByLabelText('4. Location'), {
      target: { value: LOCATION_ID },
    });
    fireEvent.click(submitButton('Record installation'));

    expect(
      (await screen.findAllByText('Above LOA — variation pending')).length,
    ).toBeGreaterThan(0);
  });

  it('hides recording and cancellation from read-only members', async () => {
    renderInstallations(installationsApi(), { canRecordEvidence: false });

    // Awaited on a loaded record, not the "Installations" heading: the
    // panel's loading branch renders that heading too, so waiting on it
    // resolves against the loading state and the absence checks below
    // would pass vacuously while the list is still loading (§2.7 hazard).
    expect(await screen.findByText('SN-003')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New installation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel record' })).toBeNull();
  });
});

describe('PAC certificates', () => {
  const ITEM_ONE = '44444444-4444-4444-8444-444444444444';
  const ITEM_TWO = '55555555-5555-4555-8555-555555555555';
  const CONSIGNEE_ID = '66666666-6666-4666-8666-666666666666';
  const CERTIFICATE_ID = '99999999-9999-4999-8999-999999999999';

  const PAC_WORK_ITEMS = [
    {
      id: ITEM_ONE,
      scheduleId: '77777777-7777-4777-8777-777777777777',
      itemNumber: 'A/1',
      description: 'Cable set',
      unitCode: 'Set',
      awardedQuantity: '10.000',
      effectiveRate: '250.00',
      requiresSerials: false,
    },
    {
      id: ITEM_TWO,
      scheduleId: '77777777-7777-4777-8777-777777777777',
      itemNumber: 'A/2',
      description: 'Main switchboard',
      unitCode: 'Nos',
      awardedQuantity: '5.000',
      effectiveRate: '100.00',
      requiresSerials: true,
    },
  ];

  const CONSIGNEE = {
    id: CONSIGNEE_ID,
    designation: 'Sr. DEE (G) CR',
    address: 'Bhusawal Division',
    contactPerson: null,
    phone: null,
    email: null,
    gstin: null,
    pincode: null,
    stateCode: null,
    isConsignee: true,
    isVendor: false,
    isClient: false,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const RECORDED_PAC = {
    id: CERTIFICATE_ID,
    workId: WORK_ID,
    reference: 'PAC/2026/01',
    issueDate: '2026-08-01',
    consigneeMasterId: CONSIGNEE_ID,
    consigneeDesignation: 'Sr. DEE (G) CR',
    status: 'recorded' as const,
    cancellationNote: null,
    documentAvailable: false,
    items: [
      {
        workItemId: ITEM_TWO,
        itemNumber: 'A/2',
        certifiedQuantity: '2.000',
        releasedValue: null,
      },
    ],
    releasedValue: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    cancelledAt: null,
  };

  const PAC_LIST = {
    certificates: [RECORDED_PAC],
    itemSummaries: [
      {
        workItemId: ITEM_ONE,
        itemNumber: 'A/1',
        installedQuantity: '0.000',
        certificationBasis: 'installed',
        supportingQuantity: '0.000',
        pacCertifiedQuantity: '0.000',
        availableQuantity: '0.000',
      },
      {
        workItemId: ITEM_TWO,
        itemNumber: 'A/2',
        installedQuantity: '3.000',
        certificationBasis: 'installed',
        supportingQuantity: '3.000',
        pacCertifiedQuantity: '2.000',
        availableQuantity: '1.000',
      },
    ],
  };

  function pacApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      listWorkPacCertificates: vi.fn().mockResolvedValue(PAC_LIST),
      listContacts: vi.fn().mockResolvedValue([CONSIGNEE]),
      listWorkConsignees: vi.fn().mockResolvedValue([]),
      ...overrides,
    });
  }

  function renderPac(api: ApiClient, options: Partial<{ canModify: boolean }> = {}) {
    return render(
      <PacCertificates
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={options.canModify ?? true}
        workItems={PAC_WORK_ITEMS}
      />,
    );
  }

  it('shows the per-item certified summary and a null released value as a dash', async () => {
    renderPac(pacApi());

    await screen.findByRole('button', { name: 'New PAC certificate' });
    // Summary per item: installed, the ceiling the R18 cap is measured
    // against and which rule chose it, certified, and available. Read as
    // whole rows, because the installed total and the supporting
    // quantity coincide for an installable item and a bare text query
    // could not tell one column from the other.
    const rows = screen
      .getAllByRole('row')
      .map((row) =>
        Array.from(row.querySelectorAll('th, td')).map(
          (cell) => cell.textContent ?? '',
        ),
      );
    expect(rows).toContainEqual([
      'A/1',
      '0.000',
      'installed',
      '0.000',
      '0.000',
      '0.000',
    ]);
    expect(rows).toContainEqual([
      'A/2',
      '3.000',
      'installed',
      '3.000',
      '2.000',
      '1.000',
    ]);
    // The certificate block with its consignee snapshot and status.
    expect(
      screen.getByRole('heading', { name: 'PAC PAC/2026/01 · 2026-08-01' }),
    ).toBeTruthy();
    expect(screen.getByText(/Issued by Sr\. DEE \(G\) CR/)).toBeTruthy();
    expect(screen.getByText('recorded')).toBeTruthy();
    // Released value is display-only and unresolved in phase 1: an em
    // dash, never a fabricated number.
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('records a certificate with reference, date, consignee and per-item quantities', async () => {
    const recordWorkPacCertificate = vi.fn().mockResolvedValue({
      ...RECORDED_PAC,
      id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
      reference: 'PAC/2026/02',
    });
    const api = pacApi({ recordWorkPacCertificate });
    renderPac(api);

    await openForm('New PAC certificate');
    fireEvent.change(screen.getByLabelText('Certificate reference'), {
      target: { value: 'PAC/2026/02' },
    });
    fireEvent.change(screen.getByLabelText('Issue date'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(screen.getByLabelText('Issuing consignee'), {
      target: { value: CONSIGNEE_ID },
    });
    // The per-item rows announce installed / certified / available.
    fireEvent.change(
      screen.getByLabelText(
        /A\/2 — Main switchboard \(installed 3\.000, certified 2\.000, available 1\.000\)/,
      ),
      { target: { value: '1.000' } },
    );
    fireEvent.click(submitButton('Record PAC certificate'));

    await waitFor(() => {
      expect(recordWorkPacCertificate).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        reference: 'PAC/2026/02',
        issueDate: '2026-08-05',
        consigneeMasterId: CONSIGNEE_ID,
        items: [{ workItemId: ITEM_TWO, certifiedQuantity: '1.000' }],
      });
    });
  });

  it('announces the R18 cap conflict in an alert region', async () => {
    const recordWorkPacCertificate = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'PAC_EXCEEDS_INSTALLED',
          'The certified quantity exceeds what installation records support — A/2: installed 3.000, already certified 2.000, available 1.000.',
        ),
      );
    const api = pacApi({ recordWorkPacCertificate });
    renderPac(api);

    await openForm('New PAC certificate');
    fireEvent.change(screen.getByLabelText('Certificate reference'), {
      target: { value: 'PAC/2026/03' },
    });
    fireEvent.change(screen.getByLabelText('Issue date'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(screen.getByLabelText(/A\/2 — Main switchboard/), {
      target: { value: '5.000' },
    });
    fireEvent.click(submitButton('Record PAC certificate'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'installed 3.000, already certified 2.000, available 1.000',
    );
  });

  it('cancels a certificate with a mandatory note', async () => {
    const cancelPacCertificate = vi.fn().mockResolvedValue({
      ...RECORDED_PAC,
      status: 'cancelled',
      cancellationNote: 'Superseded by the railway',
      cancelledAt: '2026-08-06T00:00:00.000Z',
    });
    const api = pacApi({ cancelPacCertificate });
    renderPac(api);

    await openForm('Cancel certificate…');
    fireEvent.change(screen.getByLabelText('Cancellation note for PAC PAC/2026/01'), {
      target: { value: 'Superseded by the railway' },
    });
    fireEvent.click(submitButton('Cancel certificate'));

    await waitFor(() => {
      expect(cancelPacCertificate).toHaveBeenCalledWith(
        ORG_ID,
        CERTIFICATE_ID,
        'Superseded by the railway',
      );
    });
  });

  it('offers the scanned-certificate download when a document exists', async () => {
    const downloadPacCertificateDocument = vi.fn().mockResolvedValue(new Blob());
    const api = pacApi({
      listWorkPacCertificates: vi.fn().mockResolvedValue({
        ...PAC_LIST,
        certificates: [{ ...RECORDED_PAC, documentAvailable: true }],
      }),
      downloadPacCertificateDocument,
    });
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    const createObjectURL = vi.fn().mockReturnValue('blob:pac');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    try {
      renderPac(api);
      fireEvent.click(
        await screen.findByRole('button', { name: 'Open scanned certificate' }),
      );
      await waitFor(() => {
        expect(downloadPacCertificateDocument).toHaveBeenCalledWith(
          ORG_ID,
          CERTIFICATE_ID,
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hides recording, cancellation and upload from read-only members', async () => {
    renderPac(pacApi(), { canModify: false });

    // Awaited on the loaded certificate, not the "PAC certificates"
    // heading, which the panel's loading branch renders too (§2.7 hazard).
    expect(
      await screen.findByRole('heading', { name: 'PAC PAC/2026/01 · 2026-08-01' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New PAC certificate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel certificate' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Upload scanned certificate' }),
    ).toBeNull();
  });
});

describe('MeasurementBooks workspace', () => {
  const MB_DRAFT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const MB_FINAL_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const DC_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
  const INST_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
  const PAC_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
  const ITEM_ID = 'ffffffff-6666-4666-8666-ffffffffffff';

  const MB_DRAFT = {
    id: MB_DRAFT_ID,
    workId: WORK_ID,
    status: 'draft' as const,
    isFinal: false,
    mbDate: '2026-08-05',
    mbNumber: null,
    sequenceNumber: null,
    totalAmount: null,
    remarkTemplateVersion: null,
    templateVersion: null,
    renderedAvailable: false,
    cancellationNote: null,
    billId: null,
    createdAt: '2026-08-05T00:00:00.000Z',
    finalizedAt: null,
    cancelledAt: null,
  };

  const MB_FINAL = {
    ...MB_DRAFT,
    id: MB_FINAL_ID,
    status: 'finalized' as const,
    isFinal: true,
    mbNumber: 'DCW-1-MB-02',
    sequenceNumber: 2,
    totalAmount: '4000.00',
    remarkTemplateVersion: 'mb-remark-v1',
    finalizedAt: '2026-08-05T10:00:00.000Z',
  };

  const LINE = {
    workItemId: ITEM_ID,
    itemNumber: 'A/1',
    description: 'Power cable',
    unitCode: 'mtr',
    paymentCategory: null,
    resolvedCategory: 'UNCATEGORISED',
    pctSupply: '80.00',
    pctInstallation: '10.00',
    pctPac: '0.00',
    pctFinalBill: '10.00',
    effectiveRate: '1.00',
    deltaSupplied: '5000.000',
    deltaInstalled: '0.000',
    deltaPac: '0.000',
    deltaFinalBill: '0.000',
    priorSupplied: '0.000',
    priorInstalled: '0.000',
    priorPac: '0.000',
    priorFinalBill: '0.000',
    amountSupply: '4000.00',
    amountInstallation: '0.00',
    amountPac: '0.00',
    amountFinalBill: '0.00',
    lineTotal: '4000.00',
    remark: 'Now to pay 80% for 5000 mtr.',
  };

  const DRAFT_DETAIL = {
    book: MB_DRAFT,
    sources: [],
    lines: [LINE],
    warnings: [],
    previewTotal: '4000.00',
    unbillableVariationExposure: '0.00',
  };

  const FINAL_DETAIL = {
    book: MB_FINAL,
    sources: [],
    lines: [LINE],
    warnings: [],
    previewTotal: '4000.00',
    unbillableVariationExposure: '0.00',
  };

  const CANDIDATES: Partial<ApiClient> = {
    listChallans: vi.fn().mockResolvedValue([
      {
        id: DC_ID,
        workId: WORK_ID,
        status: 'issued',
        challanNumber: 'DC/1',
        challanDate: '2026-08-01',
      },
    ]),
    listWorkInstallations: vi.fn().mockResolvedValue({
      installations: [
        {
          id: INST_ID,
          workId: WORK_ID,
          workItemId: ITEM_ID,
          itemNumber: 'A/1',
          quantity: '1000.000',
          installedOn: '2026-08-02',
          locationName: 'Nashik Road station',
          status: 'recorded',
        },
      ],
      itemSummaries: [],
    }),
    listWorkPacCertificates: vi.fn().mockResolvedValue({
      certificates: [
        {
          id: PAC_ID,
          workId: WORK_ID,
          reference: 'PAC/2026/01',
          issueDate: '2026-08-03',
          status: 'recorded',
          items: [],
        },
      ],
      itemSummaries: [],
    }),
  };

  function mbApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      listWorkMeasurementBooks: vi
        .fn()
        .mockResolvedValue({ books: [MB_FINAL, MB_DRAFT] }),
      getMeasurementBook: vi.fn().mockResolvedValue(DRAFT_DETAIL),
      ...CANDIDATES,
      ...overrides,
    });
  }

  function renderMb(
    api: ApiClient,
    options: Partial<{
      canModify: boolean;
      canIssue: boolean;
      canPrepareBill: boolean;
      canCancel: boolean;
      onBillPrepared: () => void;
    }> = {},
  ) {
    return render(
      <MeasurementBooks
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        onBooksKnown={() => {}}
        canModify={options.canModify ?? true}
        canIssue={options.canIssue ?? true}
        canPrepareBill={options.canPrepareBill ?? true}
        canCancel={options.canCancel ?? true}
        onBillPrepared={options.onBillPrepared ?? vi.fn()}
      />,
    );
  }

  /**
   * Finding 27's residue. The Measurement Book register reported a failed
   * load but offered no way out of it, and the consignee pick list beside
   * it failed silently — which withdrew the record-MB option and looked
   * identical to a Work that simply has no consignees.
   */
  it('offers a retry when the Measurement Books cannot be read', async () => {
    const listWorkMeasurementBooks = vi
      .fn()
      .mockRejectedValueOnce(
        new RequestFailedError(
          503,
          'UNAVAILABLE',
          'Measurement Books are unavailable.',
        ),
      )
      .mockResolvedValue({ books: [MB_FINAL, MB_DRAFT] });
    renderMb(mbApi({ listWorkMeasurementBooks }));

    expect(await screen.findByText(/Measurement Books are unavailable/)).toBeTruthy();
    // Never an empty register: the operator must not read this as "no
    // Measurement Books exist".
    expect(screen.queryByRole('button', { name: 'DCW-1-MB-02' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry Measurement Books' }));
    expect(await screen.findByRole('button', { name: 'DCW-1-MB-02' })).toBeTruthy();
  });

  it('says when the consignee list could not be read, instead of dropping the option', async () => {
    const api = mbApi({
      listWorkConsignees: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(503, 'UNAVAILABLE', 'Consignees are unavailable.'),
        ),
    });
    renderMb(api);

    expect(await screen.findByText(/Consignees are unavailable/)).toBeTruthy();
    // The books themselves are unaffected — the warning is scoped to the
    // action it actually removed.
    expect(screen.getByRole('button', { name: 'DCW-1-MB-02' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry consignees' })).toBeTruthy();
  });

  it('lists MBs with status chips, totals, and the FINAL BILL badge', async () => {
    renderMb(mbApi());

    await screen.findByRole('button', { name: 'DCW-1-MB-02' });
    expect(screen.getByRole('button', { name: 'Draft' })).toBeTruthy();
    expect(screen.getByText('finalized')).toBeTruthy();
    expect(screen.getAllByText('FINAL BILL').length).toBeGreaterThan(0);
    expect(screen.getByText('₹4,000.00')).toBeTruthy();
    // A draft and a live final MB exist: no create form is offered.
    expect(screen.queryByLabelText('MB date')).toBeNull();
  });

  it('creates a draft with the final-MB sweep explanation', async () => {
    const createWorkMeasurementBook = vi.fn().mockResolvedValue(DRAFT_DETAIL);
    const api = mbApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [] }),
      createWorkMeasurementBook,
    });
    renderMb(api);

    // No Measurement Book has been raised yet, so the section leads with its
    // form rather than hiding the only thing there is to do.
    fireEvent.change(await screen.findByLabelText('MB date'), {
      target: { value: '2026-08-05' },
    });
    // The sweep warning is the FINAL kind's alone — it would be a lie above
    // the on-account default, which bills a stage and sweeps nothing.
    expect(screen.queryByText(/must sweep every remaining open source/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'final' } });
    expect(screen.getByText(/must sweep every remaining open source/)).toBeTruthy();
    fireEvent.click(submitButton('Create draft'));

    await waitFor(() => {
      expect(createWorkMeasurementBook).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        mbDate: '2026-08-05',
        kind: 'final',
      });
    });
  });

  it('offers to open the existing draft on the one-draft 409', async () => {
    const getMeasurementBook = vi.fn().mockResolvedValue(DRAFT_DETAIL);
    const api = mbApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [] }),
      createWorkMeasurementBook: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(
            409,
            'MB_DRAFT_EXISTS',
            'This Work already has a draft Measurement Book; finalize or delete it first.',
            { existingRecordId: MB_DRAFT_ID },
          ),
        ),
      getMeasurementBook,
    });
    renderMb(api);

    fireEvent.change(await screen.findByLabelText('MB date'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.click(submitButton('Create draft'));

    const open = await screen.findByRole('button', { name: 'Open existing draft' });
    fireEvent.click(open);
    await waitFor(() => {
      expect(getMeasurementBook).toHaveBeenCalledWith(ORG_ID, MB_DRAFT_ID);
    });
  });

  it('opens a draft with grouped source candidates, saves the selection, and shows the preview', async () => {
    const setMeasurementBookSources = vi.fn().mockResolvedValue(DRAFT_DETAIL);
    const api = mbApi({ setMeasurementBookSources });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));

    // Candidates grouped by type with human labels.
    await screen.findByText('Delivery challans (issued)');
    expect(screen.getByText('Installations (recorded)')).toBeTruthy();
    expect(screen.getByText('PAC certificates (recorded)')).toBeTruthy();
    // Dates run through the shared `formatDate` helper, never the raw
    // date-only string the API sends.
    expect(screen.getByText(/DC\/1 · 01 Aug 2026/)).toBeTruthy();
    expect(
      screen.getByText(/A\/1 × 1000\.000 · 02 Aug 2026 · Nashik Road station/),
    ).toBeTruthy();
    expect(screen.getByText(/PAC\/2026\/01 · 03 Aug 2026/)).toBeTruthy();

    // The live preview mirrors the PDF columns including the remark.
    expect(screen.getByText('Supplied Δ')).toBeTruthy();
    expect(screen.getByText('Now to pay 80% for 5000 mtr.')).toBeTruthy();
    // The total is a table summary, not a body row: this table is printed to
    // PDF, where only a foot repeats across pages.
    expect(screen.getByText('Total payable this MB').closest('tfoot')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/DC\/1 · 01 Aug 2026/));
    fireEvent.click(screen.getByRole('button', { name: 'Save source selection' }));
    await waitFor(() => {
      expect(setMeasurementBookSources).toHaveBeenCalledWith(ORG_ID, MB_DRAFT_ID, {
        sources: [{ sourceType: 'delivery_challan', sourceId: DC_ID }],
      });
    });
  });

  /**
   * The unbillable variation exposure panel (Auto-MB-Vercel-du,
   * components/measurement-book.tsx at a8e1fde). Installation may now
   * exceed the sanctioned quantity; measurement and billing still cap at it. The MB
   * lines therefore arrive already clamped by the server, and the excess
   * would be invisible without this panel — the operator would read a
   * short MB with no statement of what was left out of it.
   */
  it('states the unbillable variation exposure in rupees when the Work carries one', async () => {
    const api = mbApi({
      getMeasurementBook: vi.fn().mockResolvedValue({
        ...DRAFT_DETAIL,
        unbillableVariationExposure: '18500.50',
      }),
    });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));

    expect(await screen.findByText('Unbillable variation exposure')).toBeTruthy();
    // Exact to the paisa. This is the money a variation order would have to
    // sanction, so it is never abbreviated to crores.
    expect(screen.getByText('₹18,500.50')).toBeTruthy();
    expect(
      screen.getByText(
        /excluded from measurement and billing until variation approval/,
      ),
    ).toBeTruthy();
  });

  it('stays silent when nothing is installed above the sanctioned quantity', async () => {
    // '0.00' is not "no answer" — it is the Work reporting no exposure, and
    // an amber panel reading zero would be a standing false alarm.
    renderMb(mbApi());

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));

    await screen.findByText('Supplied Δ');
    expect(screen.queryByText('Unbillable variation exposure')).toBeNull();
  });

  it('shows the exposure on a finalized book too, not only on a draft', async () => {
    // The exposure is a current fact about the Work rather than a snapshot
    // of the book, so finalizing does not retire it.
    const api = mbApi({
      getMeasurementBook: vi
        .fn()
        .mockResolvedValue({ ...FINAL_DETAIL, unbillableVariationExposure: '200.00' }),
    });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));

    expect(await screen.findByText('Unbillable variation exposure')).toBeTruthy();
    expect(screen.getByText('₹200.00')).toBeTruthy();
  });

  function sourceConflict(
    sourceType: string,
    sourceId: string,
    holdingMbNumber: string,
  ) {
    return new RequestFailedError(
      409,
      'MB_SOURCE_ALREADY_BILLED',
      'A source can be billed by at most one live Measurement Book.',
      { sourceType, sourceId, holdingMeasurementBookId: MB_FINAL_ID, holdingMbNumber },
    );
  }

  it('marks a source claimed by another live MB from the structured 409', async () => {
    const api = mbApi({
      setMeasurementBookSources: vi
        .fn()
        .mockRejectedValue(sourceConflict('delivery_challan', DC_ID, 'DCW-1-MB-02')),
    });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    fireEvent.click(await screen.findByLabelText(/DC\/1 · 01 Aug 2026/));
    fireEvent.click(screen.getByRole('button', { name: 'Save source selection' }));

    const chip = await screen.findByText('claimed by DCW-1-MB-02');
    expect(screen.getByRole('alert').textContent).toContain(
      'at most one live Measurement Book',
    );

    // The claim is enforced in the UI rather than left to fail server-side on
    // the next save, and the chip describes the box instead of being read as
    // part of its name.
    const box = screen.getByLabelText<HTMLInputElement>(/DC\/1 · 01 Aug 2026/);
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(box.getAttribute('aria-describedby')).toBe(chip.id);
    expect(chip.closest('label')).toBeNull();
  });

  it('keeps every source conflict marked, not only the newest', async () => {
    const api = mbApi({
      setMeasurementBookSources: vi
        .fn()
        .mockRejectedValueOnce(sourceConflict('delivery_challan', DC_ID, 'DCW-1-MB-02'))
        .mockRejectedValueOnce(sourceConflict('installation', INST_ID, 'DCW-1-MB-01')),
    });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    fireEvent.click(await screen.findByLabelText(/DC\/1 · 01 Aug 2026/));
    fireEvent.click(screen.getByRole('button', { name: 'Save source selection' }));
    await screen.findByText('claimed by DCW-1-MB-02');

    fireEvent.click(screen.getByLabelText(/A\/1 × 1000\.000/));
    fireEvent.click(screen.getByRole('button', { name: 'Save source selection' }));
    await screen.findByText('claimed by DCW-1-MB-01');

    // The second clash must not unmark the row the first one flagged.
    expect(screen.getByText('claimed by DCW-1-MB-02')).toBeTruthy();
  });

  it('links unresolved-category warnings to the payment matrix', async () => {
    const api = mbApi({
      getMeasurementBook: vi.fn().mockResolvedValue({
        ...DRAFT_DETAIL,
        lines: [],
        warnings: [
          { workItemId: ITEM_ID, itemNumber: 'A/1', missingCategory: 'SUPPLY' },
        ],
        previewTotal: '0.00',
      }),
    });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    await screen.findByText(/cannot price every selected item/);
    const link = screen.getByRole('link', { name: 'payment matrix' });
    expect(link.getAttribute('href')).toBe(`#/works/${WORK_ID}/schedules`);
    expect(screen.getByText(/A\/1:/)).toBeTruthy();

    // The warnings are part of the view as it opens, so they are a status
    // region; alert is reserved for what the operator just caused.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen
        .getAllByRole('status')
        .some((region) =>
          (region.textContent ?? '').includes('cannot price every selected item'),
        ),
    ).toBe(true);
  });

  it('finalizes through a confirm step naming the next number', async () => {
    const finalizeMeasurementBook = vi.fn().mockResolvedValue(FINAL_DETAIL);
    const api = mbApi({ finalizeMeasurementBook });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize…' }));
    // The number is assigned at finalize; the confirm names the next slot
    // after the highest existing sequence (02 -> 03).
    await screen.findByText(/next number 03/);
    fireEvent.click(screen.getByRole('button', { name: 'Finalize now' }));

    await waitFor(() => {
      expect(finalizeMeasurementBook).toHaveBeenCalledWith(ORG_ID, MB_DRAFT_ID);
    });
  });

  it('deletes a draft only through a confirm step that names the released claims', async () => {
    const deleteMeasurementBook = vi.fn().mockResolvedValue(undefined);
    const api = mbApi({ deleteMeasurementBook });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete draft…' }));

    // Deleting is unrecoverable, so the first click must destroy nothing.
    expect(deleteMeasurementBook).not.toHaveBeenCalled();
    await screen.findByText(/releases every source it claimed/);

    fireEvent.click(screen.getByRole('button', { name: 'Keep drafting' }));
    expect(screen.queryByRole('button', { name: 'Delete draft now' })).toBeNull();
    expect(deleteMeasurementBook).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete draft…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete draft now' }));
    await waitFor(() => {
      expect(deleteMeasurementBook).toHaveBeenCalledWith(ORG_ID, MB_DRAFT_ID);
    });
  });

  it('streams the draft preview PDF from the preview endpoint', async () => {
    const downloadMeasurementBookDraftPreview = vi.fn().mockResolvedValue(new Blob());
    const api = mbApi({ downloadMeasurementBookDraftPreview });
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    const createObjectURL = vi.fn().mockReturnValue('blob:mb');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    try {
      renderMb(api);
      fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Preview PDF (draft)' }),
      );
      await waitFor(() => {
        expect(downloadMeasurementBookDraftPreview).toHaveBeenCalledWith(
          ORG_ID,
          MB_DRAFT_ID,
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('prepares the bill from a finalized MB and refreshes the Bills section', async () => {
    const prepareBillFromMeasurementBook = vi.fn().mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      billNumber: 1,
      mbId: MB_FINAL_ID,
    });
    const onBillPrepared = vi.fn();
    const api = mbApi({
      getMeasurementBook: vi.fn().mockResolvedValue(FINAL_DETAIL),
      prepareBillFromMeasurementBook,
    });
    renderMb(api, { onBillPrepared });

    fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare bill' }));

    await waitFor(() => {
      expect(prepareBillFromMeasurementBook).toHaveBeenCalledWith(ORG_ID, MB_FINAL_ID);
      expect(onBillPrepared).toHaveBeenCalled();
    });
  });

  it('renders and opens the finalized MB PDF, and cancels with a note', async () => {
    const renderMeasurementBook = vi.fn().mockResolvedValue({
      ...FINAL_DETAIL,
      book: { ...MB_FINAL, renderedAvailable: true, templateVersion: 'mb-v1' },
    });
    const downloadMeasurementBookPdf = vi.fn().mockResolvedValue(new Blob());
    const cancelMeasurementBook = vi.fn().mockResolvedValue({
      ...FINAL_DETAIL,
      book: {
        ...MB_FINAL,
        status: 'cancelled',
        cancellationNote: 'Wrong measurement basis.',
        cancelledAt: '2026-08-06T00:00:00.000Z',
      },
    });
    const api = mbApi({
      getMeasurementBook: vi.fn().mockResolvedValue(FINAL_DETAIL),
      renderMeasurementBook,
      downloadMeasurementBookPdf,
      cancelMeasurementBook,
    });
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    const createObjectURL = vi.fn().mockReturnValue('blob:mb');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    try {
      renderMb(api);

      fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Render PDF' }));
      await waitFor(() => {
        expect(renderMeasurementBook).toHaveBeenCalledWith(ORG_ID, MB_FINAL_ID);
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Open PDF' }));
      await waitFor(() => {
        expect(downloadMeasurementBookPdf).toHaveBeenCalledWith(ORG_ID, MB_FINAL_ID);
      });

      await openForm('Cancel Measurement Book…');
      fireEvent.change(screen.getByLabelText(/Cancellation note/), {
        target: { value: 'Wrong measurement basis.' },
      });
      fireEvent.click(submitButton('Continue to confirmation'));

      // Cancelling a numbered record is irreversible, so the confirm echoes
      // the number before anything is sent.
      await screen.findByText(/Measurement Book DCW-1-MB-02 will be cancelled/);
      expect(cancelMeasurementBook).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel DCW-1-MB-02 now' }));
      await waitFor(() => {
        expect(cancelMeasurementBook).toHaveBeenCalledWith(
          ORG_ID,
          MB_FINAL_ID,
          'Wrong measurement basis.',
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('withdraws the cancel confirmation when the note is reworded', async () => {
    const cancelMeasurementBook = vi.fn();
    const api = mbApi({
      getMeasurementBook: vi.fn().mockResolvedValue(FINAL_DETAIL),
      cancelMeasurementBook,
    });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));
    await openForm('Cancel Measurement Book…');
    const note = screen.getByLabelText(/Cancellation note/);
    fireEvent.change(note, { target: { value: 'Wrong measurement basis.' } });
    fireEvent.click(submitButton('Continue to confirmation'));
    await screen.findByRole('button', { name: 'Cancel DCW-1-MB-02 now' });

    // What was confirmed must be the wording that gets stored, so rewording
    // the note sends the operator back through the confirm step.
    fireEvent.change(note, { target: { value: 'Wrong quantities recorded.' } });
    expect(screen.queryByRole('button', { name: 'Cancel DCW-1-MB-02 now' })).toBeNull();
    expect(cancelMeasurementBook).not.toHaveBeenCalled();
  });

  it('hides drafting and financial actions from members without the rights', async () => {
    const api = mbApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [MB_FINAL] }),
      getMeasurementBook: vi.fn().mockResolvedValue(FINAL_DETAIL),
    });
    renderMb(api, { canModify: false, canIssue: false, canCancel: false });

    fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));
    await screen.findByText('Now to pay 80% for 5000 mtr.');
    expect(screen.queryByLabelText('MB date')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prepare bill' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Render PDF' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Finalize/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Cancel Measurement Book…' }),
    ).toBeNull();
  });

  it('gates the cancel form on the CANCEL authority, not the issue authority', async () => {
    const api = mbApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [MB_FINAL] }),
      getMeasurementBook: vi.fn().mockResolvedValue(FINAL_DETAIL),
    });
    // Issue authority without cancel authority: financial actions offered,
    // the cancel form withheld (the server route requires can_cancel_documents).
    renderMb(api, { canIssue: true, canCancel: false });
    fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));
    await screen.findByRole('button', { name: 'Prepare bill' });
    expect(
      screen.queryByRole('button', { name: 'Cancel Measurement Book…' }),
    ).toBeNull();
    cleanup();

    // Cancel authority without issue authority: the cancel form is
    // offered, the financial actions are not.
    renderMb(api, { canIssue: false, canCancel: true });
    fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));
    await screen.findByRole('button', { name: 'Cancel Measurement Book…' });
    expect(screen.queryByRole('button', { name: 'Prepare bill' })).toBeNull();
  });
});

/** The challan pages contradicted themselves in three places: they printed
 * the evidence that blocks a cancellation and then offered Cancel anyway,
 * they hid pre-issue serial recording behind an issued-only branch, and
 * they offered both mutating forms on a completed Work. These cover the
 * refusals AND the legitimate cases each one must leave alone. */
