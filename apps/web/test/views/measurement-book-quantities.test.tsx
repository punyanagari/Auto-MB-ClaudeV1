// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  MeasurementBook,
  MeasurementBookDetailResponse,
  MeasurementBookLine,
} from '@auto-mb/contracts';
import { MeasurementBooks } from '../../src/views/MeasurementBooks.js';
import { billableBook, ORG_ID, stubApi, WORK_ID } from './helpers.js';

/**
 * The editable measured quantity on a draft Measurement Book's lines
 * (owner ruling of 2026-08-19; `docs/UX.md` § 25).
 *
 * The assertions here are the ones the pull request stands on in place of
 * screenshots: that the operator sees BOTH figures, that an untouched
 * line is sent as "no adjustment" rather than as a number that happens to
 * match, and that a finalized book has no field at all.
 *
 * Every await resolves against something that exists only once the books
 * have loaded — the register's own row — never against the heading, which
 * the loading state renders too (the `loading-anchor-census` rule).
 */

const ITEM_ID = '44444444-4444-4444-8444-444444444444';

function line(overrides: Partial<MeasurementBookLine> = {}): MeasurementBookLine {
  return {
    workItemId: ITEM_ID,
    itemNumber: '1',
    description: 'Power cable',
    unitCode: 'mtr',
    paymentCategory: 'SUPPLY',
    resolvedCategory: 'SUPPLY',
    pctSupply: '80.00',
    pctInstallation: '0.00',
    pctPac: '0.00',
    pctFinalBill: '20.00',
    effectiveRate: '100.000000',
    deltaSupplied: '10.000',
    deltaInstalled: '0.000',
    sourceSupplied: '10.000',
    sourceInstalled: '0.000',
    overrideSupplied: null,
    overrideInstalled: null,
    deltaPac: '0.000',
    deltaFinalBill: '0',
    priorSupplied: '0.000',
    priorInstalled: '0.000',
    priorPac: '0.000',
    priorFinalBill: '0.000',
    amountSupply: '800.00',
    amountInstallation: '0.00',
    amountPac: '0.00',
    amountFinalBill: '0.00',
    lineTotal: '800.00',
    remark: 'Now to pay 80% for 10 mtr.',
    ...overrides,
  };
}

function draft(overrides: Partial<MeasurementBook> = {}): MeasurementBook {
  return billableBook({
    status: 'draft',
    mbNumber: null,
    sequenceNumber: null,
    totalAmount: null,
    finalizedAt: null,
    ...overrides,
  });
}

function detail(
  book: MeasurementBook,
  lines: MeasurementBookLine[],
): MeasurementBookDetailResponse {
  return {
    book,
    sources: [],
    lines,
    warnings: [],
    previewTotal: '800.00',
    unbillableVariationExposure: '0',
    measurementAdjustedAway: '0.00',
  };
}

function renderBooks(api: ReturnType<typeof stubApi>) {
  return render(
    <MeasurementBooks
      api={api}
      organisationId={ORG_ID}
      workId={WORK_ID}
      canModify
      canIssue
      canPrepareBill={false}
      canCancel
      onBillPrepared={() => undefined}
      onBooksKnown={() => undefined}
    />,
  );
}

async function openDraft(api: ReturnType<typeof stubApi>) {
  renderBooks(api);
  fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
  const field = await screen.findByLabelText('Supplied quantity measured for item 1');
  // The open is itself an action, and every control on the panel is
  // disabled while one is in flight. Waiting for its notice is waiting
  // for the panel to be usable — clicking Save before it lands clicks a
  // disabled button and asserts nothing.
  await screen.findByText('Measurement Book draft opened below.');
  return field;
}

describe('the measured quantity on a draft Measurement Book line', () => {
  it('shows what the operator may enter beside what the sources claim', async () => {
    const book = draft();
    const api = stubApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [book] }),
      getMeasurementBook: vi.fn().mockResolvedValue(detail(book, [line()])),
    });
    const field = await openDraft(api);
    expect((field as HTMLInputElement).value).toBe('10.000');
    // The claimed figure is the field's own description, so the pair
    // reaches a screen reader as a pair rather than as a loose number.
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain('10.000');
  });

  it('sends a changed line as an adjustment and an untouched one as none', async () => {
    const book = draft();
    const setMeasurementBookMeasuredQuantities = vi
      .fn()
      .mockResolvedValue(
        detail(book, [line({ deltaSupplied: '8.000', amountSupply: '640.00' })]),
      );
    const api = stubApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [book] }),
      getMeasurementBook: vi.fn().mockResolvedValue(detail(book, [line()])),
      setMeasurementBookMeasuredQuantities,
    });
    const field = await openDraft(api);
    fireEvent.change(field, { target: { value: '8' } });
    const save = await screen.findByRole('button', {
      name: 'Save measured quantities',
    });
    fireEvent.click(save);

    await waitFor(() => {
      expect(setMeasurementBookMeasuredQuantities).toHaveBeenCalled();
    });
    expect(setMeasurementBookMeasuredQuantities.mock.calls[0]).toEqual([
      ORG_ID,
      book.id,
      {
        overrides: [
          {
            workItemId: ITEM_ID,
            measuredSupplied: '8',
            // Untouched, and equal to what the sources claim — so it is
            // not an adjustment and no row is written for it.
            measuredInstalled: null,
          },
        ],
      },
    ]);
    // The server's recomputed preview is what the screen shows next: the
    // field re-seeds from the answer, never from what was typed.
    await waitFor(() => {
      expect(
        screen.getByLabelText<HTMLInputElement>('Supplied quantity measured for item 1')
          .value,
      ).toBe('8.000');
    });
  });

  it('writes NO adjustment when a clamped line is saved untouched', async () => {
    // The regression this guards: the field is seeded with the BILLED
    // figure, and on a sanction-clamped line that is already below what
    // the sources claim. Deciding "unchanged" by comparing the two would
    // save an adjustment at the clamped quantity on every clamped line —
    // and that adjustment would then cap the item there for good, once
    // an amendment reopened the sanction.
    const book = draft();
    const clamped = line({
      deltaInstalled: '5.000',
      sourceInstalled: '40.000',
      overrideInstalled: null,
    });
    const setMeasurementBookMeasuredQuantities = vi
      .fn()
      .mockResolvedValue(detail(book, [clamped]));
    const api = stubApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [book] }),
      getMeasurementBook: vi.fn().mockResolvedValue(detail(book, [clamped])),
      setMeasurementBookMeasuredQuantities,
    });
    await openDraft(api);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Save measured quantities' }),
    );
    await waitFor(() => {
      expect(setMeasurementBookMeasuredQuantities).toHaveBeenCalled();
    });
    expect(setMeasurementBookMeasuredQuantities.mock.calls[0]?.[2]).toEqual({
      overrides: [
        { workItemId: ITEM_ID, measuredSupplied: null, measuredInstalled: null },
      ],
    });
  });

  it('echoes an adjustment nobody touched instead of dropping it', async () => {
    // The other half of the same rule: the save replaces the whole set,
    // so a field the operator did not edit has to carry its stored
    // adjustment back or the save would silently clear it.
    const book = draft();
    const adjusted = line({ deltaSupplied: '8.000', overrideSupplied: '8' });
    const setMeasurementBookMeasuredQuantities = vi
      .fn()
      .mockResolvedValue(detail(book, [adjusted]));
    const api = stubApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [book] }),
      getMeasurementBook: vi.fn().mockResolvedValue(detail(book, [adjusted])),
      setMeasurementBookMeasuredQuantities,
    });
    await openDraft(api);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Save measured quantities' }),
    );
    await waitFor(() => {
      expect(setMeasurementBookMeasuredQuantities).toHaveBeenCalled();
    });
    expect(setMeasurementBookMeasuredQuantities.mock.calls[0]?.[2]).toEqual({
      overrides: [
        { workItemId: ITEM_ID, measuredSupplied: '8', measuredInstalled: null },
      ],
    });
  });

  it('clears an adjustment when its field is emptied', async () => {
    const book = draft();
    const adjusted = line({ deltaSupplied: '8.000', overrideSupplied: '8' });
    const setMeasurementBookMeasuredQuantities = vi
      .fn()
      .mockResolvedValue(detail(book, [adjusted]));
    const api = stubApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [book] }),
      getMeasurementBook: vi.fn().mockResolvedValue(detail(book, [adjusted])),
      setMeasurementBookMeasuredQuantities,
    });
    const field = await openDraft(api);
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Save measured quantities' }),
    );
    await waitFor(() => {
      expect(setMeasurementBookMeasuredQuantities).toHaveBeenCalled();
    });
    // An emptied field is no adjustment — never the empty string, which
    // the request schema would refuse as a malformed decimal.
    expect(setMeasurementBookMeasuredQuantities.mock.calls[0]?.[2]).toEqual({
      overrides: [
        { workItemId: ITEM_ID, measuredSupplied: null, measuredInstalled: null },
      ],
    });
  });

  it('states what the adjustments left out, in rupees', async () => {
    const book = draft();
    const api = stubApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [book] }),
      getMeasurementBook: vi.fn().mockResolvedValue({
        ...detail(book, [line({ deltaSupplied: '8.000', overrideSupplied: '8' })]),
        measurementAdjustedAway: '160.00',
      }),
    });
    await openDraft(api);
    expect(
      await screen.findByText('Measured down on this Measurement Book'),
    ).toBeTruthy();
  });

  it('offers no field where the sources claim nothing to reduce', async () => {
    const book = draft();
    const api = stubApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [book] }),
      getMeasurementBook: vi.fn().mockResolvedValue(detail(book, [line()])),
    });
    await openDraft(api);
    expect(
      screen.queryByLabelText('Installed quantity measured for item 1'),
    ).toBeNull();
  });

  it('keeps an adjusted-to-nothing line on screen, with its own field still in it', async () => {
    const book = draft();
    const zeroed = line({
      deltaSupplied: '0.000',
      amountSupply: '0.00',
      lineTotal: '0.00',
      remark: 'Now to pay nill.',
    });
    const api = stubApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [book] }),
      getMeasurementBook: vi.fn().mockResolvedValue(detail(book, [zeroed])),
    });
    const field = await openDraft(api);
    expect((field as HTMLInputElement).value).toBe('0.000');
  });

  it('offers no field at all on a finalized book', async () => {
    const book = billableBook();
    const snapshot = line({ sourceSupplied: null, sourceInstalled: null });
    const api = stubApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [book] }),
      getMeasurementBook: vi.fn().mockResolvedValue(detail(book, [snapshot])),
    });
    renderBooks(api);
    fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-01' }));
    expect(await screen.findByText('Power cable')).toBeTruthy();
    expect(screen.queryByLabelText('Supplied quantity measured for item 1')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Save measured quantities' }),
    ).toBeNull();
  });
});
