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
 *
 * This is also where the sanctioned quantity binds the MONEY (migration
 * 0077, `clampToSanctioned`). It is decided here rather than at the
 * finalize route deliberately: the draft preview, the draft PDF and the
 * finalize snapshot all read this one function, so what an operator is
 * shown before finalizing is what finalizing writes.
 */

import { byItemNumber, type WorkItemPaymentCategory } from '@auto-mb/contracts';
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
  /** SUM over non-cancelled acceptance certificates, FOR AMC ITEMS ONLY
   * — the base an AMC item earns its final bill on, and '0' on every
   * other category because no other branch reads it. See
   * `FinalBillBaseInput.amcCertifiedQuantity`. */
  readonly cumulativeAmcCertified: string;
  /** coalesce(effective_quantity, awarded_quantity) — what the contract
   * sanctions. THE BILLING CEILING: every stage measured on work that
   * was physically done clamps its lifetime billed quantity here (see
   * `clampToSanctioned`). */
  readonly sanctionedQuantity: string;
}

/** One computed (previewed or to-be-snapshotted) MB line. */
export interface MbComputedLine {
  readonly workItemId: string;
  readonly itemNumber: string;
  readonly description: string;
  readonly unitCode: string;
  readonly paymentCategory: WorkItemPaymentCategory | null;
  /** The matrix row the item resolved through. Always the item's own
   * category since migration 0105 — an item with none resolves through
   * nothing and never reaches a line. */
  readonly resolvedCategory: string;
  readonly percentages: PaymentMatrixPercentages;
  readonly effectiveRate: string;
  readonly deltaSupplied: string;
  /** BILLED installation quantity, not measured: the selected sources'
   * installation total after `clampToSanctioned`. The two differ exactly
   * when the item is over-installed and its variation order has not
   * arrived. */
  readonly deltaInstalled: string;
  /** BILLED certified quantity, clamped the same way and for the same
   * reason — a non-AMC certificate attests installed work, which is no
   * longer bounded by the sanction. */
  readonly deltaPac: string;
  /** Final MB only: resolveFinalBillBase(cumulative), clamped at the
   * sanctioned quantity on the installed and certified branches, minus
   * the prior final-bill cumulative, floored at 0. '0' on every non-final
   * MB. */
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
interface MbUnresolvedItem {
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

/** The smaller of two exact decimals, without a float in the middle. */
function minDecimalStrings(a: string, b: string): string {
  return isNegativeDecimal(subtractDecimalStrings(a, b)) ? a : b;
}

/**
 * THE BILLING CLAMP (owner ruling, 2026-08-17: "Final MB can be done even
 * if excess installation variation is not processed — sometimes we have
 * to work free for the Railways").
 *
 * Migration 0077 lifted the sanctioned quantity off INSTALLATION, so site
 * may measure more than the contract sanctions while the variation order
 * is awaited. Money did not move with it: a stage whose basis is work
 * physically done bills min(lifetime measured, sanctioned), and the
 * remainder is simply not billed. It is not refused — refusing would
 * block the final book, and the final book has to be able to close a
 * contract that was worked over.
 *
 * Given what prior books already billed on this stage and what this
 * book's selected sources measure, returns the delta this book may bill:
 * the room left under the sanction, never negative, never more than the
 * measurement. A stage already billed up to the sanction contributes
 * nothing further, so the excess stays outside every book until an
 * amendment raises the ceiling — at which point the room reopens and the
 * next book bills it with no correction entry needed.
 */
export function clampToSanctioned(input: {
  readonly priorQuantity: string;
  readonly deltaQuantity: string;
  readonly sanctionedQuantity: string;
}): string {
  const room = subtractDecimalStrings(input.sanctionedQuantity, input.priorQuantity);
  if (isNegativeDecimal(room)) return '0';
  return minDecimalStrings(input.deltaQuantity, room);
}

/**
 * The final-bill stage delta for one item on the FINAL MB: the base
 * quantity (delivered for supply-branch items, installed for
 * installation-branch items, certified for AMC items —
 * resolveFinalBillBase) minus what the final-bill stage already billed,
 * floored at zero.
 *
 * The base is clamped at the sanctioned quantity on the two branches
 * that measure work physically done. The DELIVERED branch deliberately
 * is not: over-delivery is reachable only through the Work's
 * excess-delivery toggle, which is an owner's deliberate acceptance of
 * material beyond the sanction and has always billed, and 0077 did not
 * touch it. Clamping it here would silently change what over-delivering
 * Works are paid.
 */
export function computeFinalBillDelta(item: MbItemInput): string {
  const base = resolveFinalBillBase({
    paymentCategory: item.paymentCategory,
    description: item.description,
    deliveredQuantity: item.cumulativeDelivered,
    installedQuantity: item.cumulativeInstalled,
    amcCertifiedQuantity: item.cumulativeAmcCertified,
  });
  const baseQuantity =
    base.branch === 'delivered'
      ? base.baseQuantity
      : minDecimalStrings(base.baseQuantity, item.sanctionedQuantity);
  const delta = subtractDecimalStrings(baseQuantity, item.priorFinalBill);
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

  // Natural order (`compareItemNumbers`), which is the order the letter's
  // schedule is written in: A1/2 before A1/10, not after it. A finalized
  // MB's line order is snapshotted from this sort and printed, so a
  // character-by-character sort put every item past the ninth in a place
  // the reader has to hunt for.
  const ordered = byItemNumber(input.items);

  for (const item of ordered) {
    // The two stages measured on work physically done are clamped at the
    // sanctioned quantity; the supply stage is not, for the reason
    // `computeFinalBillDelta` gives. From here down `deltaInstalled` and
    // `deltaPac` mean BILLED quantity, which is what they have always
    // meant on a Measurement Book line — the measurement itself lives on
    // the installation record and the certificate, and the difference is
    // reported as the Work's unbillable variation exposure.
    const deltaInstalled = clampToSanctioned({
      priorQuantity: item.priorInstalled,
      deltaQuantity: item.deltaInstalled,
      sanctionedQuantity: item.sanctionedQuantity,
    });
    const deltaPac = clampToSanctioned({
      priorQuantity: item.priorPac,
      deltaQuantity: item.deltaPac,
      sanctionedQuantity: item.sanctionedQuantity,
    });
    const deltaFinalBill = input.isFinal ? computeFinalBillDelta(item) : '0';
    const hasDelta =
      isPositiveDecimal(item.deltaSupplied) ||
      isPositiveDecimal(deltaInstalled) ||
      isPositiveDecimal(deltaPac) ||
      isPositiveDecimal(deltaFinalBill);
    if (!hasDelta) continue;

    const resolution = resolvePaymentPercentages(input.matrix, item.paymentCategory);
    if (!resolution.resolved) {
      unresolved.push({
        workItemId: item.workItemId,
        itemNumber: item.itemNumber,
        // NULL from the resolver means the item has no category YET, so
        // there is no row to name. `NOT_SELECTED` is that state on the
        // wire — a token the finalize route turns into the sentence
        // that says the remedy is a decision, not a matrix row.
        missingCategory: resolution.missingCategory ?? 'NOT_SELECTED',
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
          deltaQuantity: deltaInstalled,
        },
        { stage: 'pac', percent: percentages.pctPac, deltaQuantity: deltaPac },
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
          deltaQuantity: deltaInstalled,
        },
        {
          stage: 'pac',
          percent: percentages.pctPac,
          priorCumulativeQuantity: item.priorPac,
          deltaQuantity: deltaPac,
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
      deltaInstalled,
      deltaPac,
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
