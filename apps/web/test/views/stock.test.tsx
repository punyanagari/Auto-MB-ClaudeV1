// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  Contact,
  StockItem,
  StockMovement,
  StockShortage,
} from '@auto-mb/contracts';
import { StockRegister } from '../../src/views/StockRegister.js';
import { StockShortages } from '../../src/views/StockShortages.js';
import { ORG_ID, stubApi } from './helpers.js';

/*
 * The two stock screens, on the states only they have.
 *
 * The shared loading / empty / failure patterns are covered once for
 * every view by `state-coverage.test.tsx`. What is here is the arithmetic
 * an operator reads off these screens and cannot check anywhere else: the
 * three derived quantities, the badge that fires on the reorder level,
 * the signed ledger rendered as a direction and a magnitude, and the
 * shortage row that names its job cards instead of repeating itself once
 * per plan.
 */

const SMPS_ID = '22222222-2222-4222-8222-222222222222';
const CABINET_ID = '33333333-3333-4333-8333-333333333333';
const JOB_CARD_ID = '44444444-4444-4444-8444-444444444444';
const VENDOR_ID = '55555555-5555-4555-8555-555555555555';
const DISPATCH_ID = '66666666-6666-4666-8666-666666666666';
const PO_LINE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function item(overrides: Partial<StockItem> = {}): StockItem {
  return {
    id: SMPS_ID,
    itemCode: 'EL-SMPS-2410',
    name: '24 V 10 A SMPS',
    category: 'Power supplies',
    unit: 'Nos',
    active: true,
    reorderLevel: null,
    onHand: '30.000',
    committed: '24.000',
    available: '6.000',
    belowReorderLevel: false,
    ...overrides,
  };
}

function movement(overrides: Partial<StockMovement> = {}): StockMovement {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    reference: 'SM/EL-SMPS-2410/2',
    itemId: SMPS_ID,
    itemCode: 'EL-SMPS-2410',
    itemName: '24 V 10 A SMPS',
    unit: 'Nos',
    movementType: 'issue',
    quantity: '-4.000',
    movementDate: '2026-08-01',
    sourceLabel: 'PL-281',
    createdAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

function shortage(overrides: Partial<StockShortage> = {}): StockShortage {
  return {
    itemId: CABINET_ID,
    itemCode: 'RM-CAB-IPDB6',
    name: 'Powder-coated cabinet',
    unit: 'Nos',
    required: '11.000',
    onHand: '0.000',
    onOrder: '0.000',
    shortage: '11.000',
    jobCards: [
      {
        id: JOB_CARD_ID,
        number: 'PP-26-081',
        workId: '88888888-8888-4888-8888-888888888888',
        workCode: 'PL-281',
        required: '7.000',
      },
      {
        id: '99999999-9999-4999-8999-999999999999',
        number: 'PP-26-082',
        workId: null,
        workCode: null,
        required: '4.000',
      },
    ],
    ...overrides,
  };
}

const VENDOR = {
  id: VENDOR_ID,
  designation: 'Bright LED Components',
  isVendor: true,
  active: true,
} as unknown as Contact;

function registerApi(overrides: Partial<Parameters<typeof stubApi>[0]> = {}) {
  return stubApi({
    listStockItems: vi.fn().mockResolvedValue({
      items: [item()],
      nextCursor: null,
      summary: { partsTracked: 3, partsBelowReorderLevel: 1, partsShort: 2 },
    }),
    postStockMovement: vi.fn().mockResolvedValue({ movement: movement() }),
    listStockMovements: vi
      .fn()
      .mockResolvedValue({ movements: [movement()], nextCursor: null }),
    listPendingProductionReceipts: vi.fn().mockResolvedValue({ dispatches: [] }),
    ...overrides,
  });
}

describe('the stock register', () => {
  it('shows on hand, committed and available as three separate readings', async () => {
    render(
      <StockRegister
        api={registerApi()}
        organisationId={ORG_ID}
        canModify
        onOpenShortages={vi.fn()}
      />,
    );

    const row = await screen.findByRole('row', { name: /24 V 10 A SMPS/ });
    expect(within(row).getByText('30.000 Nos')).toBeTruthy();
    expect(within(row).getByText('24.000')).toBeTruthy();
    expect(within(row).getByText('6.000')).toBeTruthy();
    // Neither of the two derived numbers is presented as stock: only the
    // first column is quantity on a shelf.
    expect(within(row).getByText('Available')).toBeTruthy();
  });

  it('badges a part low when its available quantity reaches the reorder level', async () => {
    render(
      <StockRegister
        api={registerApi({
          listStockItems: vi.fn().mockResolvedValue({
            items: [item({ reorderLevel: '10.000', belowReorderLevel: true })],
            nextCursor: null,
            summary: { partsTracked: 1, partsBelowReorderLevel: 1, partsShort: 0 },
          }),
        })}
        organisationId={ORG_ID}
        canModify
        onOpenShortages={vi.fn()}
      />,
    );
    const row = await screen.findByRole('row', { name: /24 V 10 A SMPS/ });
    expect(within(row).getByText('Low stock')).toBeTruthy();
  });

  it('renders a negative available as the shortage it is, and still badges it', async () => {
    render(
      <StockRegister
        api={registerApi({
          listStockItems: vi.fn().mockResolvedValue({
            items: [
              item({ onHand: '2.000', committed: '24.000', available: '-22.000' }),
            ],
            nextCursor: null,
            summary: { partsTracked: 1, partsBelowReorderLevel: 0, partsShort: 1 },
          }),
        })}
        organisationId={ORG_ID}
        canModify
        onOpenShortages={vi.fn()}
      />,
    );
    const row = await screen.findByRole('row', { name: /24 V 10 A SMPS/ });
    expect(within(row).getByText('-22.000')).toBeTruthy();
    // No reorder level is set, so the badge fires on the shortage alone.
    expect(within(row).getByText('Low stock')).toBeTruthy();
  });

  it('renders a signed ledger row as a direction and a magnitude', async () => {
    render(
      <StockRegister
        api={registerApi()}
        organisationId={ORG_ID}
        canModify
        onOpenShortages={vi.fn()}
      />,
    );
    const row = await screen.findByRole('row', { name: /SM\/EL-SMPS-2410\/2/ });
    expect(within(row).getByText('Issue')).toBeTruthy();
    // The minus sign belongs to the word, not to the figure.
    expect(within(row).getByText('4.000 Nos')).toBeTruthy();
    expect(within(row).getByText('PL-281')).toBeTruthy();
    // NO balance column: the list interleaves parts, so a running total
    // down the side of it would total nothing.
    expect(
      within(row).queryByText('26.000'),
      'the cross-item ledger carries no balance column',
    ).toBeNull();
  });

  it('offers an unreceived despatch with the quantity production stated', async () => {
    const receive = vi.fn().mockResolvedValue({ movement: movement() });
    render(
      <StockRegister
        api={registerApi({
          listPendingProductionReceipts: vi.fn().mockResolvedValue({
            dispatches: [
              {
                productionDispatchId: DISPATCH_ID,
                reference: 'PP-26-081/D1',
                dispatchedOn: '2026-08-01',
                itemId: CABINET_ID,
                itemCode: 'PEB-IPDB-6L',
                itemName: 'IP Display Board',
                unit: 'Nos',
                quantity: '6',
              },
            ],
          }),
          recordProductionReceipt: receive,
        })}
        organisationId={ORG_ID}
        canModify
        onOpenShortages={vi.fn()}
      />,
    );

    expect(await screen.findByText('PP-26-081/D1')).toBeTruthy();
    // There is no quantity field: the number is the despatch's own.
    fireEvent.click(screen.getByRole('button', { name: 'Take into stock' }));
    await waitFor(() => {
      // No date either: the server resolves the organisation's today, so
      // a browser clock cannot date a legal record.
      expect(receive).toHaveBeenCalledWith(ORG_ID, {
        productionDispatchId: DISPATCH_ID,
      });
    });
  });

  it('gives a viewer no way to move stock', async () => {
    render(
      <StockRegister
        api={registerApi()}
        organisationId={ORG_ID}
        canModify={false}
        onOpenShortages={vi.fn()}
      />,
    );
    await screen.findByRole('row', { name: /24 V 10 A SMPS/ });
    expect(screen.queryByRole('button', { name: /Post a movement/ })).toBeNull();
  });
});

describe('shortage procurement', () => {
  function shortageApi(overrides: Partial<Parameters<typeof stubApi>[0]> = {}) {
    return stubApi({
      listStockShortages: vi.fn().mockResolvedValue({
        shortages: [shortage()],
        purchaseOrders: [],
        purchaseOrdersTruncated: false,
      }),
      listContacts: vi.fn().mockResolvedValue([VENDOR]),
      ...overrides,
    });
  }

  it('lists one row per part and names every job card asking for it', async () => {
    render(
      <StockShortages
        api={shortageApi()}
        organisationId={ORG_ID}
        canModify
        onOpenRegister={vi.fn()}
      />,
    );

    expect(await screen.findByText('Powder-coated cabinet')).toBeTruthy();
    // One checkbox, not one per plan: the mock's row-per-(plan, part)
    // orders the same cabinet twice.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText('PP-26-081 · PL-281')).toBeTruthy();
    expect(screen.getByText('PP-26-082')).toBeTruthy();
    expect(screen.getByText('11.000 Nos')).toBeTruthy();
  });

  it('offers only the job cards that have a Work to raise an order against', async () => {
    render(
      <StockShortages
        api={shortageApi()}
        organisationId={ORG_ID}
        canModify
        onOpenRegister={vi.fn()}
      />,
    );
    const picker = await screen.findByLabelText('Raise for job card');
    const options = within(picker).getAllByRole('option');
    // PP-26-082 serves a private purchase order and has no Work.
    expect(options.map((option) => option.textContent)).toEqual(['PP-26-081']);
  });

  it('sends the selected parts and no quantity at all', async () => {
    const create = vi.fn().mockResolvedValue({});
    render(
      <StockShortages
        api={shortageApi({ createShortagePurchaseOrder: create })}
        organisationId={ORG_ID}
        canModify
        onOpenRegister={vi.fn()}
      />,
    );

    await screen.findByText('Powder-coated cabinet');
    fireEvent.change(await screen.findByLabelText('Vendor'), {
      target: { value: VENDOR_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create draft supplier PO/ }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    const [, body] = create.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.productionItemIds).toEqual([CABINET_ID]);
    expect(body.jobCardId).toBe(JOB_CARD_ID);
    // The screen never sends a quantity or a rate: the server computes
    // the first and the purchase-order editor settles the second.
    expect(body).not.toHaveProperty('quantities');
    expect(body).not.toHaveProperty('rate');
  });

  it('says so plainly when every job card asking for the material is private', async () => {
    render(
      <StockShortages
        api={shortageApi({
          listStockShortages: vi.fn().mockResolvedValue({
            shortages: [
              shortage({
                jobCards: [
                  {
                    id: JOB_CARD_ID,
                    number: 'PP-26-082',
                    workId: null,
                    workCode: null,
                    required: '11.000',
                  },
                ],
              }),
            ],
            purchaseOrders: [],
            purchaseOrdersTruncated: false,
          }),
        })}
        organisationId={ORG_ID}
        canModify
        onOpenRegister={vi.fn()}
      />,
    );
    expect(await screen.findByText(/serves a private\s+purchase order/)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Create draft supplier PO/ }),
    ).toBeNull();
  });

  it('lists a raised order with its received-against-ordered balance', async () => {
    render(
      <StockShortages
        api={shortageApi({
          listStockShortages: vi.fn().mockResolvedValue({
            shortages: [],
            purchaseOrders: [
              {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                workId: '88888888-8888-4888-8888-888888888888',
                poNumber: 'PL-281-PO-03',
                status: 'issued',
                vendorDesignation: 'Bright LED Components',
                poDate: '2026-08-01',
                expectedOn: '2026-08-24',
                jobCardNumbers: ['PP-26-081'],
                lines: [
                  {
                    id: PO_LINE_ID,
                    productionItemId: CABINET_ID,
                    itemCode: 'RM-CAB-IPDB6',
                    name: 'Powder-coated cabinet',
                    unit: 'Nos',
                    ordered: '11.000',
                    received: '4.000',
                    outstanding: '7.000',
                  },
                ],
              },
            ],
            purchaseOrdersTruncated: false,
          }),
        })}
        organisationId={ORG_ID}
        canModify
        onOpenRegister={vi.fn()}
      />,
    );
    expect(await screen.findByText('PL-281-PO-03')).toBeTruthy();
    expect(screen.getByText('4.000 / 11.000 Nos')).toBeTruthy();
    expect(screen.getByText(/PP-26-081/)).toBeTruthy();
  });

  it('records a receipt for what the line is still owed', async () => {
    const post = vi.fn().mockResolvedValue({});
    render(
      <StockShortages
        api={shortageApi({
          postStockMovement: post,
          listStockShortages: vi.fn().mockResolvedValue({
            shortages: [],
            purchaseOrders: [
              {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                workId: '88888888-8888-4888-8888-888888888888',
                poNumber: 'PL-281-PO-03',
                status: 'issued',
                vendorDesignation: 'Bright LED Components',
                poDate: '2026-08-01',
                expectedOn: null,
                jobCardNumbers: ['PP-26-081'],
                lines: [
                  {
                    id: PO_LINE_ID,
                    productionItemId: CABINET_ID,
                    itemCode: 'RM-CAB-IPDB6',
                    name: 'Powder-coated cabinet',
                    unit: 'Nos',
                    ordered: '11.000',
                    received: '4.000',
                    outstanding: '7.000',
                  },
                ],
              },
            ],
            purchaseOrdersTruncated: false,
          }),
        })}
        organisationId={ORG_ID}
        canModify
        onOpenRegister={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Record receipt of/ }));
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(ORG_ID, {
        productionItemId: CABINET_ID,
        movementType: 'purchase_receipt',
        quantity: '7.000',
        purchaseOrderLineId: PO_LINE_ID,
      });
    });
  });

  it('says so when the order column is not the whole of it', async () => {
    render(
      <StockShortages
        api={shortageApi({
          listStockShortages: vi.fn().mockResolvedValue({
            shortages: [],
            purchaseOrders: [
              {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                workId: '88888888-8888-4888-8888-888888888888',
                poNumber: 'PL-281-PO-03',
                status: 'issued',
                vendorDesignation: 'Bright LED Components',
                poDate: '2026-08-01',
                expectedOn: null,
                jobCardNumbers: [],
                lines: [],
              },
            ],
            purchaseOrdersTruncated: true,
          }),
        })}
        organisationId={ORG_ID}
        canModify
        onOpenRegister={vi.fn()}
      />,
    );
    expect(await screen.findByText(/most recent orders/)).toBeTruthy();
  });
});
