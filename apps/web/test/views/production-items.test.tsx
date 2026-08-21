// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProductionItem } from '@auto-mb/contracts';
import type { ApiClient } from '../../src/api.js';
import { ProductionItems } from '../../src/views/ProductionItems.js';
import { ORG_ID, stubApi } from './helpers.js';

/*
 * The item master's three corrections of the round-5 wave.
 *
 *   item 31 — creation asks WHAT KIND first, and the catalogue rail
 *     lists OEM products only, with sub items behind their own filter;
 *   item 29 — an item can be edited, and the three things that cannot
 *     move say so on a disabled control instead of failing on submit;
 *   item 28 — a bill of material whose component select would be empty
 *     says why and offers the part form, returning with the new part
 *     already chosen.
 *
 * The loading / empty / failure states of this view are covered once in
 * `state-coverage.test.tsx`; nothing here repeats them.
 */

const PRODUCT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const PART_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const NEW_PART_ID = 'cccccccc-3333-4333-8333-333333333333';

function item(overrides: Partial<ProductionItem> = {}): ProductionItem {
  return {
    id: PRODUCT_ID,
    itemCode: 'PEB-IPDB-6L',
    name: 'IP Display Board · 6 line',
    category: 'Display boards',
    unit: 'Nos',
    manufactured: true,
    serialPrefix: 'IPDB6',
    serialControlled: true,
    role: 'oem',
    serialSeriesLocked: false,
    flagsLocked: false,
    specifications: [],
    active: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const PART = item({
  id: PART_ID,
  itemCode: 'EL-SMPS-2410',
  name: '24 V 10 A SMPS',
  category: 'Electricals',
  manufactured: false,
  serialPrefix: null,
  serialControlled: false,
  role: 'sub',
});

/** The kind chooser's two buttons. Queried through their heading text
 * rather than by accessible name: the rail filter beside them is called
 * "OEM items", and a name query loose enough to match one matches both. */
function kindButton(kind: 'OEM item' | 'Sub item'): HTMLElement {
  const card = screen.getByText('What kind of item is this?').closest('section');
  if (card === null) throw new Error('The kind chooser is not open.');
  const button = within(card).getByText(kind).closest('button');
  if (button === null) throw new Error(`No button around ${kind}.`);
  return button;
}

function view(
  items: readonly ProductionItem[],
  overrides: Partial<ApiClient> = {},
): void {
  const api = stubApi({
    listProductionItems: vi.fn().mockResolvedValue({ items }),
    ...overrides,
  });
  render(<ProductionItems api={api} organisationId={ORG_ID} canModify />);
}

describe('creating an item asks what kind it is', () => {
  it('offers OEM item and sub item rather than assuming OEM', async () => {
    view([item()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Add item' }));

    expect(screen.getByText('What kind of item is this?')).toBeTruthy();
    expect(kindButton('OEM item')).toBeTruthy();
    expect(kindButton('Sub item')).toBeTruthy();
  });

  it('does not ask an OEM item whether it is manufactured — it always is', async () => {
    const saved = vi.fn().mockResolvedValue(item({ id: NEW_PART_ID }));
    view([item()], { saveProductionItem: saved });

    fireEvent.click(await screen.findByRole('button', { name: 'Add item' }));
    fireEvent.click(kindButton('OEM item'));

    expect(
      screen.queryByRole('checkbox', { name: /The agency manufactures this/ }),
    ).toBeNull();
    const series = screen.getByLabelText('Serial series');
    fireEvent.change(screen.getByLabelText('Part number'), {
      target: { value: 'PEB-IPDB-8L' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'IP Display Board · 8 line' },
    });
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'Display boards' },
    });
    fireEvent.change(series, { target: { value: 'ipdb8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add OEM item' }));

    await waitFor(() => {
      expect(saved).toHaveBeenCalled();
    });
    expect(saved.mock.calls[0]?.[2]).toMatchObject({
      role: 'oem',
      manufactured: true,
      serialPrefix: 'IPDB8',
      serialControlled: true,
    });
  });

  it('asks a sub item whether it is bought or built', async () => {
    view([item()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Add item' }));
    fireEvent.click(kindButton('Sub item'));

    const manufactured = screen.getByRole<HTMLInputElement>('checkbox', {
      name: /The agency manufactures this/,
    });
    expect(manufactured.checked).toBe(false);
    // A bought-in part has no series of its own; a built one does.
    expect(screen.queryByLabelText('Serial series')).toBeNull();
    fireEvent.click(manufactured);
    expect(screen.getByLabelText('Serial series')).toBeTruthy();
  });
});

describe('the catalogue rail', () => {
  it('lists OEM items only, and reaches sub items through its filter', async () => {
    view([item(), PART]);
    const rail = (await screen.findByText('Catalogue')).closest('div')
      ?.parentElement as HTMLElement;

    expect(within(rail).getByText('IP Display Board · 6 line')).toBeTruthy();
    expect(within(rail).queryByText('24 V 10 A SMPS')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Sub items' }));
    expect(within(rail).getByText('24 V 10 A SMPS')).toBeTruthy();
    expect(within(rail).queryByText('IP Display Board · 6 line')).toBeNull();
  });

  it('says what a kind is when the catalogue holds none of it', async () => {
    view([item()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Sub items' }));
    expect(screen.getByText(/No sub items yet/)).toBeTruthy();
  });
});

describe('editing an item', () => {
  it('saves a corrected part number, name, category and unit', async () => {
    const saved = vi.fn().mockResolvedValue(item({ name: 'Corrected' }));
    view([item()], { saveProductionItem: saved });

    fireEvent.click(await screen.findByRole('button', { name: /Edit item/ }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'IP Display Board · 6 line, corrected' },
    });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'Set' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save item' }));

    await waitFor(() => {
      expect(saved).toHaveBeenCalled();
    });
    expect(saved.mock.calls[0]?.[1]).toBe(PRODUCT_ID);
    expect(saved.mock.calls[0]?.[2]).toMatchObject({
      name: 'IP Display Board · 6 line, corrected',
      unit: 'Set',
      role: 'oem',
    });
  });

  it('disables the serial series once a unit carries it, and says why', async () => {
    view([item({ serialSeriesLocked: true, flagsLocked: true })]);
    fireEvent.click(await screen.findByRole('button', { name: /Edit item/ }));

    const series = screen.getByLabelText<HTMLInputElement>('Serial series');
    expect(series.disabled).toBe(true);
    // The reason rides the control for a pointer AND sits under it in
    // view, so neither a mouse nor a screen reader has to guess.
    expect(series.title).toMatch(/printed on them/);
    expect(screen.getByText(/printed on them/)).toBeTruthy();
  });

  it('disables the manufactured flag once the item is referenced, and says why', async () => {
    view([
      item({
        role: 'sub',
        manufactured: true,
        flagsLocked: true,
        serialSeriesLocked: false,
      }),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Sub items' }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit item/ }));

    const manufactured = screen.getByRole<HTMLInputElement>('checkbox', {
      name: /The agency manufactures this/,
    });
    expect(manufactured.disabled).toBe(true);
    expect(screen.getByText(/job cards, units or consumptions/)).toBeTruthy();
  });

  it('refuses OEM as a kind for a bought-in item that can no longer become manufactured', async () => {
    view([
      item({
        role: 'sub',
        manufactured: false,
        serialPrefix: null,
        serialControlled: false,
        flagsLocked: true,
      }),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Sub items' }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit item/ }));

    const oem = screen.getByRole<HTMLInputElement>('radio', { name: /OEM item/ });
    expect(oem.disabled).toBe(true);
    expect(screen.getByText(/cannot start being manufactured/)).toBeTruthy();
  });
});

describe('a bill of material with nothing to build from', () => {
  it('names the condition and offers the part form, which returns with the part chosen', async () => {
    const created = item({
      id: NEW_PART_ID,
      itemCode: 'RM-CAB-IPDB6',
      name: 'Powder-coated cabinet',
      manufactured: false,
      serialPrefix: null,
      serialControlled: false,
      role: 'sub',
    });
    const saved = vi.fn().mockResolvedValue(created);
    // The only item in the catalogue is the one whose bill this is, so
    // the component select has nothing to offer.
    view([item()], { saveProductionItem: saved });

    fireEvent.click(await screen.findByRole('button', { name: /Material/ }));
    expect(screen.getByText(/no other items in the catalogue yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Create a part/ }));
    // The kind is not asked: a bill of material takes parts, and a part
    // is a sub item.
    expect(screen.queryByText('What kind of item is this?')).toBeNull();
    fireEvent.change(screen.getByLabelText('Part number'), {
      target: { value: 'RM-CAB-IPDB6' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Powder-coated cabinet' },
    });
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'Fabrication' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add sub item' }));

    await waitFor(() => {
      expect(saved).toHaveBeenCalled();
    });
    expect(saved.mock.calls[0]?.[2]).toMatchObject({ role: 'sub' });

    const select = await screen.findByLabelText<HTMLSelectElement>('Component');
    expect(select.value).toBe(NEW_PART_ID);
    expect(within(select).getByText(/Powder-coated cabinet/)).toBeTruthy();
  });
});
