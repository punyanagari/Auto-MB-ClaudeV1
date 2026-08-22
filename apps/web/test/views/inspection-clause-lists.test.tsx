// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Contact, InspectionClauseRow } from '@auto-mb/contracts';
import type { ApiClient } from '../../src/api.js';
import { WorkInspectionClause } from '../../src/views/WorkInspectionClause.js';
import { ORG_ID, stubApi, WORK_ID } from './helpers.js';

/**
 * The clause tab's two lists and its structured premises (item 27,
 * migration 0116).
 *
 * Three things are held here, and each of them is a way the screen could
 * quietly stop being useful:
 *
 *   1. the split is by what the DESCRIPTION says, and the unmatched
 *      section is present rather than hidden — an inspection clause
 *      sometimes lives in the tender text, and a screen showing only the
 *      matched items would be wrong invisibly;
 *   2. a match PROPOSES and never commits — the agency select stays empty
 *      until an operator chooses;
 *   3. picking a vendor offers that vendor's PRIMARY address first, and
 *      the free-text premises survives for a sub-vendor with no master
 *      row (0082's case, which 0116 does not remove).
 */

function clauseRow(overrides: Partial<InspectionClauseRow>): InspectionClauseRow {
  return {
    workItemId: 'item-1',
    itemNumber: 'A/1',
    description: 'Supply of cable',
    unitCode: 'Nos',
    awardedQuantity: '100.000',
    manufacturedQuantity: '0.000',
    agency: null,
    inspectionQuantity: null,
    vendorContactId: null,
    vendorName: null,
    vendorAddressId: null,
    vendorAddress: null,
    vendorPremises: null,
    gatesDispatch: false,
    ...overrides,
  };
}

const VENDOR: Contact = {
  id: 'vendor-1',
  designation: 'RailTech Components',
  contactPerson: null,
  address: 'Plot 14, Hosur',
  phone: null,
  email: null,
  gstin: null,
  pincode: null,
  stateCode: null,
  locality: null,
  divisionCode: null,
  isConsignee: false,
  isVendor: true,
  isClient: false,
  isEmployee: false,
  pan: null,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  addresses: [
    {
      id: 'address-works',
      label: 'Works, Hosur',
      address: 'Plot 14, Hosur',
      pincode: null,
      locality: null,
      stateCode: null,
      isPrimary: true,
      sortOrder: 0,
      active: true,
    },
    {
      id: 'address-office',
      label: 'Regd. office',
      address: 'Anna Salai, Chennai',
      pincode: null,
      locality: null,
      stateCode: null,
      isPrimary: false,
      sortOrder: 1,
      active: true,
    },
  ],
};

function renderTab() {
  const api = stubApi({
    getWorkInspectionConfig: vi
      .fn<ApiClient['getWorkInspectionConfig']>()
      .mockResolvedValue({
        items: [
          clauseRow({
            workItemId: 'item-1',
            itemNumber: 'A/1',
            // Joined words and a transposed spelling: the two failures
            // the matcher exists for, in one description.
            description: 'Supply of relays, insepctionbyRDSO at vendor works',
          }),
          clauseRow({
            workItemId: 'item-2',
            itemNumber: 'A/2',
            description: 'Laying of cable in trench including backfill',
          }),
        ],
        checklists: {
          RDSO: { inherited: true, fields: [] },
          RITES: { inherited: true, fields: [] },
        },
      }),
    listContacts: vi.fn<ApiClient['listContacts']>().mockResolvedValue([VENDOR]),
  });
  render(
    <WorkInspectionClause
      api={api}
      organisationId={ORG_ID}
      workId={WORK_ID}
      canModify
      canGate
    />,
  );
  return api;
}

describe('the inspection clause tab', () => {
  it('splits the items into two sections, the matched one open', async () => {
    renderTab();
    const matched = await screen.findByRole('button', { name: /Matched items/ });
    const other = screen.getByRole('button', { name: /Other items/ });
    expect(matched.getAttribute('aria-expanded')).toBe('true');
    expect(other.getAttribute('aria-expanded')).toBe('false');

    // The matched item is on screen and the unmatched one is not — but it
    // is one click away, never hidden outright.
    expect(screen.getByLabelText('Inspection agency for A/1')).toBeInstanceOf(
      HTMLSelectElement,
    );
    expect(screen.queryByLabelText('Inspection agency for A/2')).toBe(null);
    fireEvent.click(other);
    await waitFor(() => {
      expect(screen.getByLabelText('Inspection agency for A/2')).toBeTruthy();
    });
  });

  it('proposes the agency it read and leaves the select empty', async () => {
    renderTab();
    const select = await screen.findByLabelText<HTMLSelectElement>(
      'Inspection agency for A/1',
    );
    // The proposal is stated…
    expect(screen.getByText('Description reads RDSO.')).toBeTruthy();
    // …and nothing is mapped. Mapping is the operator's act.
    expect(select.value).toBe('');
  });

  it('offers the vendor’s primary address first, and keeps the free-text fallback', async () => {
    renderTab();
    const vendor = await screen.findByLabelText<HTMLSelectElement>(
      'Inspection vendor for A/1',
    );
    // Before a vendor is named there is nowhere to choose from, so the
    // typed premises is what the row offers.
    expect(screen.getByLabelText('Vendor premises for A/1')).toBeTruthy();

    fireEvent.change(vendor, { target: { value: 'vendor-1' } });
    const address = await screen.findByLabelText<HTMLSelectElement>(
      'Inspection address for A/1',
    );
    // The PRIMARY one, chosen for the operator rather than left blank.
    expect(address.value).toBe('address-works');
    expect(
      within(address)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Type the premises instead', 'Works, Hosur (primary)', 'Regd. office']);
    // A saved address and free text are alternatives, so the typed field
    // goes away while one is chosen.
    expect(screen.queryByLabelText('Vendor premises for A/1')).toBe(null);

    // 0082's sub-vendor case survives: step off the saved address and the
    // typed premises comes back.
    fireEvent.change(address, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.getByLabelText('Vendor premises for A/1')).toBeTruthy();
    });
  });
});
