import { describe, expect, it } from 'vitest';
import {
  resolvePaymentPercentages,
  type PaymentMatrixRowData,
} from '../src/payment-matrix.js';

/**
 * The pure stage-percentage resolution contract (Milestone 8 phase 1):
 * category row first, UNCATEGORISED only for uncategorised items, and a
 * precise missing-row failure — never a silent substitute. Phase 2's MB
 * engine builds its finalization errors from exactly these results.
 */

const SUPPLY_ROW: PaymentMatrixRowData = {
  category: 'SUPPLY',
  pctSupply: '80.00',
  pctInstallation: '10.00',
  pctPac: '0.00',
  pctFinalBill: '10.00',
};

const UNCATEGORISED_ROW: PaymentMatrixRowData = {
  category: 'UNCATEGORISED',
  pctSupply: '60.00',
  pctInstallation: '20.00',
  pctPac: '10.00',
  pctFinalBill: '10.00',
};

describe('resolvePaymentPercentages', () => {
  it('resolves a categorised item through its own category row, verbatim strings', () => {
    const resolution = resolvePaymentPercentages(
      [UNCATEGORISED_ROW, SUPPLY_ROW],
      'SUPPLY',
    );
    expect(resolution).toEqual({
      resolved: true,
      category: 'SUPPLY',
      percentages: {
        pctSupply: '80.00',
        pctInstallation: '10.00',
        pctPac: '0.00',
        pctFinalBill: '10.00',
      },
    });
  });

  it('resolves an UNCATEGORISED item through the residual row', () => {
    // UNCATEGORISED is a CHOICE since migration 0105 — an item carries
    // it, and it resolves like any other category.
    const resolution = resolvePaymentPercentages(
      [SUPPLY_ROW, UNCATEGORISED_ROW],
      'UNCATEGORISED',
    );
    expect(resolution).toEqual({
      resolved: true,
      category: 'UNCATEGORISED',
      percentages: {
        pctSupply: '60.00',
        pctInstallation: '20.00',
        pctPac: '10.00',
        pctFinalBill: '10.00',
      },
    });
  });

  it('fails precisely when a categorised item has no row — even if UNCATEGORISED exists', () => {
    // A categorised item never falls back: substituting the
    // UNCATEGORISED percentages would silently bill with the wrong
    // split. The missing category is named so MB finalization can list
    // every affected item.
    const resolution = resolvePaymentPercentages(
      [UNCATEGORISED_ROW],
      'PURE_INSTALLATION',
    );
    expect(resolution).toEqual({
      resolved: false,
      missingCategory: 'PURE_INSTALLATION',
    });
  });

  it('refuses an item with no category chosen, however full the matrix', () => {
    // NULL means NOT SELECTED (migration 0105). It resolves through
    // nothing — not even the residual row, which is what it used to fall
    // through to — so a matrix carrying every row in the vocabulary
    // still cannot price it. `missingCategory: null` says there is no
    // row to add; the remedy is a decision on the item.
    for (const matrix of [[SUPPLY_ROW], [SUPPLY_ROW, UNCATEGORISED_ROW], []]) {
      expect(resolvePaymentPercentages(matrix, null)).toEqual({
        resolved: false,
        missingCategory: null,
      });
    }
  });

  it('resolves against an empty matrix as missing, not as zero percentages', () => {
    expect(resolvePaymentPercentages([], 'SPARE_SUPPLY')).toEqual({
      resolved: false,
      missingCategory: 'SPARE_SUPPLY',
    });
  });
});
