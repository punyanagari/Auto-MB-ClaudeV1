/**
 * Pure computation core of the stage-wise Measurement Book engine
 * (ADR-0006; legacy spec §5.9). Given per-item stage deltas (already
 * summed over the selected sources), the prior-cumulative memory
 * (summed over prior non-cancelled finalized MBs' lines), the Work's
 * payment matrix, and — for the final MB — the cumulative delivered and
 * installed quantities, this module produces the exact per-line
 * snapshot the finalize transaction writes: resolved percentages, the
 * final-bill delta (base minus prior, final MB only), stage amounts
 * (line-rounded then summed, R13), line totals, the MB total, and the
 * contractual remark text via computeMbRemark.
 *
 * No database, no IO: the route layer loads state and snapshots the
 * result; unit tests drive the workbook scenario without a database.
 * Every quantity, percentage, rate, and amount is an exact decimal
 * STRING — no JavaScript float ever touches an authoritative value.
 */

import type { WorkItemPaymentCategory } from '@auto-mb/contracts';
import {
  addDecimalStrings,
  computeMbRemark,
  computeStageAmounts,
  resolveFinalBillBase,
} from './mb-remark.js';
import {
  resolvePaymentPercentages,
  type PaymentMatrixPercentages,
  type PaymentMatrixRowData,
} from './payment-matrix.js';

/** One Work item's live state as loaded by the route layer. */
export interface MbItemInput {
  readonly workItemId: string;
  readonly itemNumber: string;
  readonly description: string;
  readonly unitCode: string;
  readonly paymentCategory: WorkItemPaymentCategory | null;
  /** coalesce(effective_unit_rate, effective_rate)::text — the
   * authoritative rate at computation time. */
  readonly effectiveRate: string;
  /** This MB's deltas, summed over the SELECTED sources. */
  readonly deltaSupplied: string;
  readonly deltaInstalled: string;
  readonly deltaPac: string;
  /** True-cumulative prior billed quantities: SUM of deltas over all
   * prior non-cancelled finalized MBs' lines. */
  readonly priorSupplied: string;
  readonly priorInstalled: string;
  readonly priorPac: string;
  readonly priorFinalBill: string;
  /** Work-lifetime aggregates for the final-bill base (final MB only):
   * delivered = SUM over issued DCs; installed = SUM over non-cancelled
   * installations. */
  readonly cumulativeDelivered: string;
  readonly cumulativeInstalled: string;
}

/** One computed (previewed or to-be-snapshotted) MB line. */
export interface MbComputedLine {
  readonly workItemId: string;
  readonly itemNumber: string;
  readonly description: string;
  readonly unitCode: string;
  readonly paymentCategory: WorkItemPaymentCategory | null;
  /** The matrix row the item resolved through ('UNCATEGORISED' for
   * uncategorised items). */
  readonly resolvedCategory: string;
  readonly percentages: PaymentMatrixPercentages;
  readonly effectiveRate: string;
  readonly deltaSupplied: string;
  readonly deltaInstalled: string;
  readonly deltaPac: string;
  /** Final MB only: resolveFinalBillBase(cumulative) minus the prior
   * final-bill cumulative, floored at 0. '0' on every non-final MB. */
  readonly deltaFinalBill: string;
  readonly priorSupplied: string;
  readonly priorInstalled: string;
  readonly priorPac: string;
  readonly priorFinalBill: string;
  readonly amountSupply: string;
  readonly amountInstallation: string;
  readonly amountPac: string;
  readonly amountFinalBill: string;
  readonly lineTotal: string;
  readonly remark: string;
}

/** An item whose category has no matrix row to resolve through. The
 * draft preview surfaces these as warnings; finalize collects them all
 * and fails with ONE 409 naming each item and its missing category. */
export interface MbUnresolvedItem {
  readonly workItemId: string;
  readonly itemNumber: string;
  readonly missingCategory: string;
}

export interface MbComputation {
  /** Lines in item-number order; only items with at least one nonzero
   * stage delta appear (an MB bills deltas). */
  readonly lines: readonly MbComputedLine[];
  /** SUM of the line totals (line-rounded then summed, R13), exactly 2
   * fraction digits. */
  readonly totalAmount: string;
  /** Items that would appear on the MB but cannot resolve percentages. */
  readonly unresolved: readonly MbUnresolvedItem[];
}

// eslint-disable-next-line security/detect-unsafe-regex -- fully anchored, two adjacent digit runs with no nested quantifier; linear on all inputs (same shape as mb-remark.ts)
const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

function isPositiveDecimal(raw: string): boolean {
  const m = DECIMAL_RE.exec(raw.trim());
  if (m === null) throw new Error(`Not a plain decimal string: ${JSON.stringify(raw)}`);
  return m[1] !== '-' && /[1-9]/.test(`${m[2] ?? ''}${m[3] ?? ''}`);
}

function isNegativeDecimal(raw: string): boolean {
  const m = DECIMAL_RE.exec(raw.trim());
  if (m === null) throw new Error(`Not a plain decimal string: ${JSON.stringify(raw)}`);
  return m[1] === '-' && /[1-9]/.test(`${m[2] ?? ''}${m[3] ?? ''}`);
}

/** a - b over exact decimal strings (addDecimalStrings with b negated). */
export function subtractDecimalStrings(a: string, b: string): string {
  const trimmed = b.trim();
  const negated = trimmed.startsWith('-') ? trimmed.slice(1) : `-${trimmed}`;
  return addDecimalStrings(a, negated);
}

/**
 * The final-bill stage delta for one item on the FINAL MB: the base
 * quantity (delivered for supply-branch items, installed for
 * installation-branch items — resolveFinalBillBase) minus what the
 * final-bill stage already billed, floored at zero.
 */
export function computeFinalBillDelta(item: MbItemInput): string {
  const base = resolveFinalBillBase({
    paymentCategory: item.paymentCategory,
    description: item.description,
    deliveredQuantity: item.cumulativeDelivered,
    installedQuantity: item.cumulativeInstalled,
  });
  const delta = subtractDecimalStrings(base.baseQuantity, item.priorFinalBill);
  return isNegativeDecimal(delta) ? '0' : delta;
}

/**
 * Computes the full MB line set from live state. Deterministic and
 * side-effect free; the finalize transaction snapshots the result
 * verbatim and the draft GET serves it as the preview.
 */
export function computeMeasurementBook(input: {
  readonly matrix: readonly PaymentMatrixRowData[];
  readonly isFinal: boolean;
  readonly items: readonly MbItemInput[];
}): MbComputation {
  const lines: MbComputedLine[] = [];
  const unresolved: MbUnresolvedItem[] = [];
  let totalAmount = '0.00';

  const ordered = [...input.items].sort((a, b) =>
    a.itemNumber.localeCompare(b.itemNumber, 'en'),
  );

  for (const item of ordered) {
    const deltaFinalBill = input.isFinal ? computeFinalBillDelta(item) : '0';
    const hasDelta =
      isPositiveDecimal(item.deltaSupplied) ||
      isPositiveDecimal(item.deltaInstalled) ||
      isPositiveDecimal(item.deltaPac) ||
      isPositiveDecimal(deltaFinalBill);
    if (!hasDelta) continue;

    const resolution = resolvePaymentPercentages(input.matrix, item.paymentCategory);
    if (!resolution.resolved) {
      unresolved.push({
        workItemId: item.workItemId,
        itemNumber: item.itemNumber,
        missingCategory: resolution.missingCategory,
      });
      continue;
    }
    const { percentages } = resolution;

    const amounts = computeStageAmounts({
      effectiveRate: item.effectiveRate,
      stages: [
        {
          stage: 'supply',
          percent: percentages.pctSupply,
          deltaQuantity: item.deltaSupplied,
        },
        {
          stage: 'installation',
          percent: percentages.pctInstallation,
          deltaQuantity: item.deltaInstalled,
        },
        { stage: 'pac', percent: percentages.pctPac, deltaQuantity: item.deltaPac },
        {
          stage: 'final_bill',
          percent: percentages.pctFinalBill,
          deltaQuantity: deltaFinalBill,
        },
      ],
    });
    const byStage = new Map(amounts.perStage.map((s) => [s.stage, s.amount]));

    const remark = computeMbRemark({
      unit: item.unitCode,
      stages: [
        {
          stage: 'supply',
          percent: percentages.pctSupply,
          priorCumulativeQuantity: item.priorSupplied,
          deltaQuantity: item.deltaSupplied,
        },
        {
          stage: 'installation',
          percent: percentages.pctInstallation,
          priorCumulativeQuantity: item.priorInstalled,
          deltaQuantity: item.deltaInstalled,
        },
        {
          stage: 'pac',
          percent: percentages.pctPac,
          priorCumulativeQuantity: item.priorPac,
          deltaQuantity: item.deltaPac,
        },
        {
          stage: 'final_bill',
          percent: percentages.pctFinalBill,
          priorCumulativeQuantity: item.priorFinalBill,
          deltaQuantity: deltaFinalBill,
        },
      ],
    });

    const line: MbComputedLine = {
      workItemId: item.workItemId,
      itemNumber: item.itemNumber,
      description: item.description,
      unitCode: item.unitCode,
      paymentCategory: item.paymentCategory,
      resolvedCategory: resolution.category,
      percentages,
      effectiveRate: item.effectiveRate,
      deltaSupplied: item.deltaSupplied,
      deltaInstalled: item.deltaInstalled,
      deltaPac: item.deltaPac,
      deltaFinalBill,
      priorSupplied: item.priorSupplied,
      priorInstalled: item.priorInstalled,
      priorPac: item.priorPac,
      priorFinalBill: item.priorFinalBill,
      amountSupply: byStage.get('supply') ?? '0.00',
      amountInstallation: byStage.get('installation') ?? '0.00',
      amountPac: byStage.get('pac') ?? '0.00',
      amountFinalBill: byStage.get('final_bill') ?? '0.00',
      lineTotal: amounts.total,
      remark,
    };
    lines.push(line);
    totalAmount = addDecimalStrings(totalAmount, amounts.total);
  }

  return { lines, totalAmount, unresolved };
}
