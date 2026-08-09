import type {
  PaymentMatrixCategory,
  WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import type { TransactionSql } from '@auto-mb/db';

/**
 * Milestone 8 phase 1: stage-percentage resolution (legacy spec §8,
 * rule R10; ADR-0006 decision 5).
 *
 * An item resolves its four stage percentages through its payment
 * category's matrix row; an uncategorised item (payment_category NULL)
 * resolves through the Work's optional UNCATEGORISED row. Per the
 * settled decision R10 there is deliberately NO per-item percentage
 * entry — percentages live only in the per-Work matrix, keyed by
 * category (do not re-add a per-item interface).
 *
 * Everything here is exact decimal strings, verbatim from
 * numeric(5,2)::text — callers must never convert through JavaScript
 * floats for authoritative values.
 */

/** The four stage percentages, verbatim numeric(5,2)::text strings
 * (e.g. '80.00'). The database CHECK guarantees each is 0–100 and the
 * four sum to exactly 100. */
export interface PaymentMatrixPercentages {
  readonly pctSupply: string;
  readonly pctInstallation: string;
  readonly pctPac: string;
  readonly pctFinalBill: string;
}

/** One loaded matrix row (percentages plus its category key). */
export interface PaymentMatrixRowData extends PaymentMatrixPercentages {
  readonly category: PaymentMatrixCategory;
}

/**
 * The outcome of resolving one item against a Work's matrix.
 *
 * - `resolved: true` — `percentages` carry the exact strings of the
 *   matrix row the item resolves through, and `category` names that
 *   row's key (the item's own category, or 'UNCATEGORISED').
 * - `resolved: false` — the required row does not exist.
 *   `missingCategory` names the row that must be created. Phase 2's MB
 *   finalization collects these across ALL items on the MB and fails
 *   with one precise error naming every affected item — resolution
 *   never silently substitutes another row (a categorised item does NOT
 *   fall back to the UNCATEGORISED row).
 */
export type PaymentPercentageResolution =
  | {
      readonly resolved: true;
      readonly category: PaymentMatrixCategory;
      readonly percentages: PaymentMatrixPercentages;
    }
  | {
      readonly resolved: false;
      readonly missingCategory: PaymentMatrixCategory;
    };

/**
 * Resolves the stage percentages for one Work item against its Work's
 * payment matrix. Pure over pre-loaded rows (see `loadPaymentMatrix`),
 * so phase 2's MB engine can load the matrix once per Work and resolve
 * every line without further queries — and unit tests need no database.
 *
 * Contract:
 * - `matrix` must be the FULL set of the Work's matrix rows (any
 *   subset would fabricate missing-row failures).
 * - `paymentCategory` is the item's stored category or null
 *   (uncategorised).
 * - The returned percentage strings are the row's values verbatim;
 *   callers snapshot them onto finalised documents unchanged so later
 *   matrix edits never alter history (ADR-0006 decision 5).
 */
export function resolvePaymentPercentages(
  matrix: readonly PaymentMatrixRowData[],
  paymentCategory: WorkItemPaymentCategory | null,
): PaymentPercentageResolution {
  const needed: PaymentMatrixCategory = paymentCategory ?? 'UNCATEGORISED';
  const row = matrix.find((candidate) => candidate.category === needed);
  if (row === undefined) {
    return { resolved: false, missingCategory: needed };
  }
  return {
    resolved: true,
    category: row.category,
    percentages: {
      pctSupply: row.pctSupply,
      pctInstallation: row.pctInstallation,
      pctPac: row.pctPac,
      pctFinalBill: row.pctFinalBill,
    },
  };
}

/** Loads a Work's full payment matrix inside the caller's tenant-bound
 * transaction, percentages as exact ::text strings, in a stable
 * category order. */
export async function loadPaymentMatrix(
  tx: TransactionSql,
  workId: string,
): Promise<PaymentMatrixRowData[]> {
  return tx<PaymentMatrixRowData[]>`
    select category,
           pct_supply::text as "pctSupply",
           pct_installation::text as "pctInstallation",
           pct_pac::text as "pctPac",
           pct_final_bill::text as "pctFinalBill"
    from payment_matrices
    where work_id = ${workId}
    order by category
  `;
}
