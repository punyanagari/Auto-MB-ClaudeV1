// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Payments } from '../../src/views/Payments.js';
import { ORG_ID, stubApi } from './helpers.js';

/* The vendor-invoice form's purchase-order picker (docs/UX.md § 31).
 *
 * The picker's roster is read per vendor, one page of the register at a
 * time, and its disabled reason has to say WHICH of three different
 * facts is true: no vendor named yet, the read failed, or the read
 * landed and found nothing recent. The last two used to share one
 * sentence that sent the operator off to raise a purchase order that
 * might already exist. */

const VENDOR_ID = '3f1c9a52-0000-4000-8000-00000000c001';

const VENDOR = {
  id: VENDOR_ID,
  designation: 'Bright LED Components',
  contactPerson: null,
  address: null,
  phone: null,
  email: null,
  gstin: null,
  pan: null,
  pincode: null,
  stateCode: null,
  isConsignee: false,
  isVendor: true,
  isClient: false,
  active: true,
  createdAt: '2026-07-01T00:00:00.000Z',
};

function renderVendorLedger(overrides: Parameters<typeof stubApi>[0] = {}) {
  const api = stubApi({
    listContacts: vi.fn().mockResolvedValue([VENDOR]),
    ...overrides,
  });
  render(
    <Payments
      api={api}
      organisationId={ORG_ID}
      currentUserId="user-1"
      canManagePayments
      canCancel
      tab="vendors"
      onOpenRegister={vi.fn()}
    />,
  );
  return api;
}

async function openOrderPicker() {
  fireEvent.click(await screen.findByRole('button', { name: 'Record invoice' }));
  return screen.getByLabelText<HTMLSelectElement>('Against purchase order');
}

describe('the vendor-invoice purchase-order picker', () => {
  it('waits for a vendor, then says when none of the RECENT orders is theirs', async () => {
    const api = renderVendorLedger();
    const picker = await openOrderPicker();

    // No vendor named yet: disabled, and the reason says which fact
    // gates it — bound to the control, not just standing nearby.
    expect(picker.disabled).toBe(true);
    const waiting = screen.getByText(/Choose the vendor first/);
    expect(picker.getAttribute('aria-describedby')).toBe(waiting.id);

    fireEvent.change(screen.getByLabelText('Vendor'), {
      target: { value: VENDOR_ID },
    });
    await waitFor(() => {
      expect(api.listPurchaseOrders).toHaveBeenCalledWith(ORG_ID, {
        status: 'issued',
        limit: 100,
      });
    });
    // Only one page of the register was read, so the sentence claims
    // "recently issued", never "has none" — and points at the order's
    // own page for the older case.
    expect(
      await screen.findByText(/None of the recently issued purchase orders/),
    ).toBeTruthy();
    expect(picker.disabled).toBe(true);
  });

  it('says the read failed rather than pretending the vendor has no orders', async () => {
    renderVendorLedger({
      listPurchaseOrders: vi.fn().mockRejectedValue(new Error('down')),
    });
    const picker = await openOrderPicker();

    fireEvent.change(screen.getByLabelText('Vendor'), {
      target: { value: VENDOR_ID },
    });
    expect(await screen.findByText(/purchase orders could not be read/)).toBeTruthy();
    expect(picker.disabled).toBe(true);
    expect(screen.queryByText(/None of the recently issued/)).toBeNull();
  });
});
