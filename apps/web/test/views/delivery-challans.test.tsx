// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryChallanRegisterEntry } from '@auto-mb/contracts';
import { DeliveryChallans } from '../../src/views/DeliveryChallans.js';
import { ORG_ID, WORK_ID, openForm, stubApi, submitButton } from './helpers.js';

/* The register's job is to say which of the three movements each row is,
 * and to keep the two that have no Work reachable at all. A screen that
 * showed them as one undifferentiated list would put a standalone
 * despatch and an LOA supply challan under the same reading. */

const WORK_CHALLAN_ID = '3f1c9a52-0000-4000-8000-00000000a001';
const STANDALONE_ID = '3f1c9a52-0000-4000-8000-00000000a002';
const CONTACT_ID = '3f1c9a52-0000-4000-8000-00000000b001';

const LOA_SUPPLY: DeliveryChallanRegisterEntry = {
  id: WORK_CHALLAN_ID,
  kind: 'work',
  movement: 'loa_supply',
  status: 'issued',
  challanDate: '2026-08-08',
  challanNumber: 'DC/1',
  prefix: 'DC',
  workId: WORK_ID,
  workCode: 'RE-2026-01',
  consigneeName: 'Sr. DEE (G) NR',
  lineCount: 2,
  manualLineCount: 0,
  totalAmount: '1200.00',
  createdAt: '2026-08-08T04:00:00.000Z',
  issuedAt: '2026-08-08T05:00:00.000Z',
};

const STANDALONE: DeliveryChallanRegisterEntry = {
  id: STANDALONE_ID,
  kind: 'standalone',
  movement: 'standalone',
  status: 'draft',
  challanDate: '2026-08-09',
  challanNumber: null,
  prefix: 'SDC',
  workId: null,
  workCode: null,
  consigneeName: 'Modern Rail Systems',
  lineCount: 1,
  manualLineCount: 1,
  totalAmount: '1250.00',
  createdAt: '2026-08-09T04:00:00.000Z',
  issuedAt: null,
};

const CONTACT = {
  id: CONTACT_ID,
  designation: 'Modern Rail Systems',
  contactPerson: null,
  address: 'Plot 4, Industrial Estate, Nashik',
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

function renderRegister(overrides: Parameters<typeof stubApi>[0] = {}, props = {}) {
  const onOpenChallan = vi.fn();
  const onOpenWorkChallan = vi.fn();
  const api = stubApi({
    listDeliveryChallans: vi.fn().mockResolvedValue([LOA_SUPPLY, STANDALONE]),
    listContacts: vi.fn().mockResolvedValue([CONTACT]),
    ...overrides,
  });
  render(
    <DeliveryChallans
      api={api}
      organisationId={ORG_ID}
      canModify
      canIssue
      canCancel
      canManageStatutory
      openChallanId={null}
      onOpenChallan={onOpenChallan}
      onOpenWorkChallan={onOpenWorkChallan}
      {...props}
    />,
  );
  return { api, onOpenChallan, onOpenWorkChallan };
}

describe('the Delivery Challan register', () => {
  it('names which of the three movements each row is', async () => {
    renderRegister();
    const supply = await screen.findByRole('row', { name: /DC\/1/ });
    expect(within(supply).getByText('LOA supply')).toBeDefined();
    expect(within(supply).getByText('RE-2026-01')).toBeDefined();

    const standalone = screen.getByRole('row', { name: /Modern Rail Systems/ });
    expect(within(standalone).getByText('Standalone')).toBeDefined();
    // No Work, and the column says so rather than sitting blank.
    expect(within(standalone).getByText('—')).toBeDefined();
  });

  it('sends a work challan to its Work and a standalone one to this module', async () => {
    const { onOpenChallan, onOpenWorkChallan } = renderRegister();
    fireEvent.click(await screen.findByRole('link', { name: 'DC/1' }));
    expect(onOpenWorkChallan).toHaveBeenCalledWith(WORK_ID, WORK_CHALLAN_ID);

    fireEvent.click(screen.getByRole('link', { name: 'Draft' }));
    expect(onOpenChallan).toHaveBeenCalledWith(STANDALONE_ID);
  });

  it('links every row so a middle click still opens a real page', async () => {
    renderRegister();
    const supply = await screen.findByRole('link', { name: 'DC/1' });
    expect(supply.getAttribute('href')).toBe(
      `#/works/${WORK_ID}/challans/${WORK_CHALLAN_ID}`,
    );
    expect(screen.getByRole('link', { name: 'Draft' }).getAttribute('href')).toBe(
      `#/delivery-challans/${STANDALONE_ID}`,
    );
  });

  it('filters to one movement at a time', async () => {
    renderRegister();
    fireEvent.click(await screen.findByRole('button', { name: /^Standalone/ }));
    expect(screen.queryByRole('link', { name: 'DC/1' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Draft' })).toBeDefined();
  });

  it('drafts a standalone challan from a contacts-master consignee', async () => {
    const created = {
      challan: { ...STANDALONE, id: STANDALONE_ID },
      items: [],
      issuedSnapshot: null,
    };
    const createStandaloneChallan = vi.fn().mockResolvedValue(created);
    const { onOpenChallan } = renderRegister({ createStandaloneChallan });

    await screen.findByRole('link', { name: 'DC/1' });
    await openForm('New standalone challan');
    fireEvent.change(await screen.findByLabelText('Consignee'), {
      target: { value: CONTACT_ID },
    });
    fireEvent.change(screen.getByLabelText('Challan date'), {
      target: { value: '2026-08-09' },
    });
    fireEvent.change(screen.getByLabelText('Prefix'), { target: { value: 'SDC' } });
    fireEvent.change(screen.getByLabelText('Line 1 description'), {
      target: { value: 'Relay casing' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 unit'), {
      target: { value: 'Nos' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 quantity'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 rate'), {
      target: { value: '125.00' },
    });
    fireEvent.click(submitButton('Create standalone challan'));

    await waitFor(() => {
      expect(createStandaloneChallan).toHaveBeenCalledWith(ORG_ID, {
        challanDate: '2026-08-09',
        prefix: 'SDC',
        consigneeContactId: CONTACT_ID,
        // Only manual lines, because that is all a standalone challan may
        // carry — the form never offers a Work item.
        items: [
          { description: 'Relay casing', unit: 'Nos', quantity: '10', rate: '125.00' },
        ],
      });
    });
    await waitFor(() => {
      expect(onOpenChallan).toHaveBeenCalledWith(STANDALONE_ID);
    });
  });

  it('says what is missing before spending a round trip', async () => {
    renderRegister();
    await screen.findByRole('link', { name: 'DC/1' });
    await openForm('New standalone challan');
    // Nothing chosen yet: the submit is unavailable and the reason is on
    // screen rather than waiting for the server to say it.
    expect(submitButton('Create standalone challan')).toHaveProperty('disabled', true);
    expect(screen.getByText(/Choose the consignee/)).toBeDefined();
  });

  it('offers no create panel to a member who may not draft', async () => {
    renderRegister({}, { canModify: false });
    await screen.findByRole('link', { name: 'DC/1' });
    expect(screen.queryByRole('button', { name: 'New standalone challan' })).toBeNull();
  });

  it('carries the stage-3b statutory facts on the draft it sends', async () => {
    const createStandaloneChallan = vi.fn().mockResolvedValue({
      challan: { ...STANDALONE, id: STANDALONE_ID },
      items: [],
      issuedSnapshot: null,
    });
    renderRegister({ createStandaloneChallan });

    await screen.findByRole('link', { name: 'DC/1' });
    await openForm('New standalone challan');
    fireEvent.change(await screen.findByLabelText('Consignee'), {
      target: { value: CONTACT_ID },
    });
    fireEvent.change(screen.getByLabelText('Challan date'), {
      target: { value: '2026-08-09' },
    });
    fireEvent.change(screen.getByLabelText('Prefix'), { target: { value: 'SDC' } });
    fireEvent.change(screen.getByLabelText('Line 1 description'), {
      target: { value: 'Relay casing' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 unit'), {
      target: { value: 'Nos' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 quantity'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 rate'), {
      target: { value: '125.00' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 HSN or SAC code'), {
      target: { value: '85444999' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 goods or service'), {
      target: { value: 'goods' },
    });
    await openForm('Statutory movement facts (for an e-way bill)');
    fireEvent.change(screen.getByLabelText('Reason for the movement'), {
      target: { value: 'job_work' },
    });
    fireEvent.change(screen.getByLabelText('Vehicle number'), {
      target: { value: 'dl01ab1234' },
    });
    fireEvent.change(screen.getByLabelText('Distance (km)'), {
      target: { value: '25' },
    });
    fireEvent.click(submitButton('Create standalone challan'));

    await waitFor(() => {
      expect(createStandaloneChallan).toHaveBeenCalledWith(ORG_ID, {
        challanDate: '2026-08-09',
        prefix: 'SDC',
        consigneeContactId: CONTACT_ID,
        items: [
          {
            description: 'Relay casing',
            unit: 'Nos',
            quantity: '10',
            rate: '125.00',
            hsnSacCode: '85444999',
            isService: false,
          },
        ],
        movementReason: 'job_work',
        vehicleNumber: 'DL01AB1234',
        transportDistanceKm: 25,
      });
    });
  });

  it('refuses a half-stated line classification before the round trip', async () => {
    renderRegister();
    await screen.findByRole('link', { name: 'DC/1' });
    await openForm('New standalone challan');
    fireEvent.change(await screen.findByLabelText('Consignee'), {
      target: { value: CONTACT_ID },
    });
    fireEvent.change(screen.getByLabelText('Line 1 description'), {
      target: { value: 'Relay casing' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 unit'), {
      target: { value: 'Nos' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 quantity'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('Line 1 rate'), {
      target: { value: '125.00' },
    });
    // A code with no marker cannot be read: the marker is what says which
    // of the two the code is, and the server refuses the pair by name.
    fireEvent.change(screen.getByLabelText('Line 1 HSN or SAC code'), {
      target: { value: '85444999' },
    });
    expect(submitButton('Create standalone challan')).toHaveProperty('disabled', true);
    expect(screen.getByText(/whether it is goods or a service/)).toBeDefined();
  });
});
