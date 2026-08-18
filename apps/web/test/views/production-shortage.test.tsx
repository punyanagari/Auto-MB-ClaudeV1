// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  JobCardDetail,
  JobCardSummary,
  MaterialRequirement,
} from '@auto-mb/contracts';
import { Production } from '../../src/views/Production.js';
import { ProductionJobCard } from '../../src/views/ProductionJobCard.js';
import { ORG_ID, stubApi } from './helpers.js';

/*
 * The material shortage, where an operator reads it.
 *
 * The stock ledger (migration 0087) made shortage a real number, and
 * `docs/UX.md` § 11 retired the row that said this product could only
 * show the requirement. What is proved here is the half of that the
 * server cannot: that the register's badge and the job card's Materials
 * tab say the same thing, that the badge is a count of PARTS rather than
 * the mock's sum of quantities across units that do not add, and that a
 * shortage closed by material already on order shows as nothing to buy.
 *
 * The loading / empty / failure states of both views are covered once in
 * `state-coverage.test.tsx`; nothing here repeats them.
 */

const JOB_CARD_ID = 'a1a1a1a1-1111-4111-8111-111111111111';
const ITEM_ID = 'b2b2b2b2-2222-4222-8222-222222222222';
const SMPS_ID = 'c3c3c3c3-3333-4333-8333-333333333333';
const CABINET_ID = 'd4d4d4d4-4444-4444-8444-444444444444';

function material(overrides: Partial<MaterialRequirement> = {}): MaterialRequirement {
  return {
    itemId: SMPS_ID,
    itemCode: 'EL-SMPS-2410',
    name: '24 V 10 A SMPS',
    unit: 'Nos',
    required: '24.000',
    available: '24.000',
    shortage: '0.000',
    serialControlled: false,
    ...overrides,
  };
}

function summary(overrides: Partial<JobCardSummary> = {}): JobCardSummary {
  return {
    id: JOB_CARD_ID,
    number: 'PP-26-081',
    sourceType: 'work',
    sourceReference: 'Schedule A2/1',
    workId: null,
    workCode: 'PL-281',
    customer: null,
    itemId: ITEM_ID,
    itemCode: 'PEB-IPDB-6L',
    itemName: 'IP Display Board · 6 line',
    quantity: 12,
    manufactured: 0,
    dispatched: 0,
    materialLines: 2,
    materialShortParts: 0,
    status: 'in_production',
    dueDate: '2026-11-30',
    completedOn: null,
    cancellationReason: null,
    ...overrides,
  };
}

function detail(overrides: Partial<JobCardDetail> = {}): JobCardDetail {
  return {
    ...summary(),
    materials: [material()],
    serials: [],
    componentSlots: [],
    dispatches: [],
    dispatchReady: false,
    ...overrides,
  };
}

function registerApi(cards: readonly JobCardSummary[]) {
  return stubApi({
    listJobCards: vi.fn().mockResolvedValue({
      jobCards: cards,
      nextCursor: null,
      openCount: cards.length,
      inProductionCount: cards.length,
      dispatchReadyCount: 0,
    }),
  });
}

describe('the production register Material badge', () => {
  it('badges the count of parts short, not a sum of quantities in different units', async () => {
    render(
      <Production
        api={registerApi([summary({ materialShortParts: 2 })])}
        organisationId={ORG_ID}
        workId={null}
        canRecord
        onOpenJobCard={vi.fn()}
        onOpenItemMaster={vi.fn()}
      />,
    );

    const row = await screen.findByRole('row', { name: /PP-26-081/ });
    expect(within(row).getByText(/parts short/)).toBeTruthy();
    expect(within(row).getByText('2')).toBeTruthy();
    // The mock's "2277 units short" adds Nos to Mtr to Kg. Nothing on
    // this row states a quantity for the shortage at all.
    expect(within(row).queryByText(/units short/)).toBeNull();
  });

  it('says one PART short in the singular', async () => {
    render(
      <Production
        api={registerApi([summary({ materialShortParts: 1 })])}
        organisationId={ORG_ID}
        workId={null}
        canRecord
        onOpenJobCard={vi.fn()}
        onOpenItemMaster={vi.fn()}
      />,
    );
    const row = await screen.findByRole('row', { name: /PP-26-081/ });
    expect(within(row).getByText(/part short/)).toBeTruthy();
    expect(within(row).queryByText(/parts short/)).toBeNull();
  });

  it('reads Ready when the bill of material is covered', async () => {
    render(
      <Production
        api={registerApi([summary({ materialShortParts: 0 })])}
        organisationId={ORG_ID}
        workId={null}
        canRecord
        onOpenJobCard={vi.fn()}
        onOpenItemMaster={vi.fn()}
      />,
    );
    const row = await screen.findByRole('row', { name: /PP-26-081/ });
    expect(within(row).getByText('Ready')).toBeTruthy();
    expect(within(row).queryByText(/short/)).toBeNull();
  });

  it('says a product with no bill of material cannot be short of anything', async () => {
    render(
      <Production
        api={registerApi([summary({ materialLines: 0, materialShortParts: 0 })])}
        organisationId={ORG_ID}
        workId={null}
        canRecord
        onOpenJobCard={vi.fn()}
        onOpenItemMaster={vi.fn()}
      />,
    );
    const row = await screen.findByRole('row', { name: /PP-26-081/ });
    expect(within(row).getByText('No bill of material')).toBeTruthy();
    expect(within(row).queryByText('Ready')).toBeNull();
  });
});

describe("the job card's Materials tab", () => {
  async function openMaterials(card: JobCardDetail) {
    render(
      <ProductionJobCard
        api={stubApi({ getJobCard: vi.fn().mockResolvedValue(card) })}
        organisationId={ORG_ID}
        jobCardId={JOB_CARD_ID}
        canRecord
        canCancel
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Materials' }));
  }

  it('shows Required, Available and Shortage as three separate readings', async () => {
    await openMaterials(
      detail({
        materials: [
          material({ required: '24.000', available: '9.000', shortage: '15.000' }),
          material({
            itemId: CABINET_ID,
            itemCode: 'RM-CAB-IPDB6',
            name: 'Powder-coated cabinet',
            required: '12.000',
            available: '12.000',
            shortage: '0.000',
          }),
        ],
      }),
    );

    const short = await screen.findByRole('row', { name: /24 V 10 A SMPS/ });
    expect(within(short).getByText('24.000')).toBeTruthy();
    expect(within(short).getByText('9.000')).toBeTruthy();
    expect(within(short).getByText('15.000')).toBeTruthy();

    const covered = screen.getByRole('row', { name: /Powder-coated cabinet/ });
    expect(within(covered).getByText('0.000')).toBeTruthy();
    expect(within(covered).getAllByText('12.000').length).toBe(2);
  });

  it('shows nothing to buy when an order in transit covers the gap, and says why', async () => {
    // The shelf holds nine of the twenty-four this card needs, and the
    // other fifteen are on an open purchase order. Required minus
    // Available is fifteen; the shortage is nothing, because the material
    // is already bought.
    await openMaterials(
      detail({
        materials: [
          material({ required: '24.000', available: '9.000', shortage: '0.000' }),
        ],
      }),
    );

    const row = await screen.findByRole('row', { name: /24 V 10 A SMPS/ });
    expect(within(row).getByText('24.000')).toBeTruthy();
    expect(within(row).getByText('9.000')).toBeTruthy();
    expect(within(row).getByText('0.000')).toBeTruthy();
    // The caption is what stops the three columns reading as arithmetic
    // that does not add up.
    expect(screen.getByText(/already on order/)).toBeTruthy();
  });
});
