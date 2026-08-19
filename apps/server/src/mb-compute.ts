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
  /** The operator's downward adjustment for this draft's line, per stage
   * (migration 0106), or null where none was made. Never trusted as an
   * upper bound: `min(override, measured)` is applied below, so an
   * adjustment left behind by a source that was later deselected can
   * only ever reduce further, never raise. */
  readonly measuredSupplied: string | null;
  readonly measuredInstalled: string | null;
  /** The item's schedule's AMC billing cadence (migration 0107), or null
   * on every schedule that states none. Read only for an AMC item, and
   * only to render period language in the remark. */
  readonly amcBillingPeriods: number | null;
  readonly amcCycleNoun: string | null;
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
  /** BILLED installation quantity, not measured: the selected sources'
   * installation total after `clampToSanctioned`. The two differ exactly
   * when the item is over-installed and its variation order has not
   * arrived. */
  readonly deltaInstalled: string;
  /** What the selected sources measure BEFORE the operator's downward
   * adjustment (0106) — the two deltas above are what will be billed,
   * these two are what the evidence says, and they are equal on every
   * line nobody adjusted. Carried so the draft screen can print
   * "computed 10 / entered 8"; the finalize snapshot has no column for
   * them and does not need one. */
  readonly sourceSupplied: string;
  readonly sourceInstalled: string;
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
  /** Lines in item-number order; an item appears when it has at least one
   * nonzero stage delta (an MB bills deltas) or when the operator has
   * adjusted its measured quantity, including down to nothing — see the
   * `isAdjusted` note in `computeMeasurementBook`. */
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
 * THE DOWNWARD-ONLY MEASURED QUANTITY (owner ruling, 2026-08-19: a draft
 * Measurement Book's per-line measured quantity is editable downward
 * only, capped at the claimed source's quantity).
 *
 * Applied here, beside `clampToSanctioned`, for the reason this module's
 * header gives for that one: the draft preview, the draft PDF and the
 * finalize snapshot all read this function, so what an operator is shown
 * before finalizing is what finalizing writes. It is deliberately NOT a
 * `least(...)` inside `ITEM_INPUTS_SQL` — that statement is P11's six
 * grouped CTEs and its plan shape is under a measured buffer ratchet
 * (`apps/server/test/query-aggregates.integration.test.ts`), and pushing
 * an eighth join into it to do arithmetic this module already does
 * exactly would spend that budget on nothing.
 *
 * `min`, not "the override": migration 0106's trigger refuses an
 * adjustment above what the book's claimed sources measure AT THE MOMENT
 * IT IS WRITTEN, and the sources can move afterwards — a challan
 * deselected from the draft leaves an adjustment that now names more than
 * the evidence. Taking the smaller of the two means a stale adjustment
 * can only ever reduce further, never resurrect a quantity whose source
 * has gone.
 */
export function applyMeasuredOverride(
  measured: string,
  override: string | null,
): string {
  return override === null ? measured : minDecimalStrings(override, measured);
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
 * Whether a computed line bills any quantity at all.
 *
 * It exists because a line can now be present and measure nothing: an
 * adjusted-to-zero line stays in the preview so its own input is still
 * on screen (see `isAdjusted` below). Finalize asks this of every line
 * rather than counting them. A string comparison against `'0'` would not
 * do — the loader renders quantities at `numeric(18,3)`, so an empty
 * stage arrives as `'0.000'`.
 */
export function lineHasQuantity(line: MbComputedLine): boolean {
  return (
    isPositiveDecimal(line.deltaSupplied) ||
    isPositiveDecimal(line.deltaInstalled) ||
    isPositiveDecimal(line.deltaPac) ||
    isPositiveDecimal(line.deltaFinalBill)
  );
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
    // The operator's downward adjustment comes FIRST, because it states
    // what was measured; the sanction clamp then decides how much of that
    // measurement this book may bill. Reversing them would let an
    // adjustment above the sanction quietly reopen room the clamp had
    // already closed.
    const deltaSupplied = applyMeasuredOverride(
      item.deltaSupplied,
      item.measuredSupplied,
    );
    // The two stages measured on work physically done are clamped at the
    // sanctioned quantity; the supply stage is not, for the reason
    // `computeFinalBillDelta` gives. From here down `deltaInstalled` and
    // `deltaPac` mean BILLED quantity, which is what they have always
    // meant on a Measurement Book line — the measurement itself lives on
    // the installation record and the certificate, and the difference is
    // reported as the Work's unbillable variation exposure.
    const deltaInstalled = clampToSanctioned({
      priorQuantity: item.priorInstalled,
      deltaQuantity: applyMeasuredOverride(item.deltaInstalled, item.measuredInstalled),
      sanctionedQuantity: item.sanctionedQuantity,
    });
    const deltaPac = clampToSanctioned({
      priorQuantity: item.priorPac,
      deltaQuantity: item.deltaPac,
      sanctionedQuantity: item.sanctionedQuantity,
    });
    const deltaFinalBill = input.isFinal ? computeFinalBillDelta(item) : '0';
    // An ADJUSTED line stays on the book even when every stage reduces to
    // zero, and that is the whole reason this flag exists. Without it the
    // line vanishes from the preview the moment an operator types 0, and
    // the field they would type into to undo it vanishes with it. Keeping
    // it also keeps the rule this module exists to hold — preview, PDF
    // and snapshot are the same computation — rather than showing a line
    // that finalize would silently drop. `finalize` refuses a book whose
    // lines all measure nothing, so a zeroed book still cannot be
    // numbered.
    const isAdjusted =
      item.measuredSupplied !== null || item.measuredInstalled !== null;
    const hasDelta =
      isPositiveDecimal(deltaSupplied) ||
      isPositiveDecimal(deltaInstalled) ||
      isPositiveDecimal(deltaPac) ||
      isPositiveDecimal(deltaFinalBill);
    if (!hasDelta && !isAdjusted) continue;

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
          deltaQuantity: deltaSupplied,
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

    // Period language fires only for an AMC item whose schedule states a
    // cadence (owner ruling Q3, 2026-08-19). Gating on the category as
    // well as the columns keeps a supply item that happens to sit on a
    // maintenance schedule reading in its own unit.
    const amcCycle =
      item.paymentCategory === 'AMC' &&
      item.amcBillingPeriods !== null &&
      item.amcCycleNoun !== null
        ? {
            totalQuantity: item.sanctionedQuantity,
            billingPeriods: item.amcBillingPeriods,
            cycleNoun: item.amcCycleNoun,
          }
        : undefined;

    const remark = computeMbRemark({
      unit: item.unitCode,
      ...(amcCycle === undefined ? {} : { amcCycle }),
      stages: [
        {
          stage: 'supply',
          percent: percentages.pctSupply,
          priorCumulativeQuantity: item.priorSupplied,
          deltaQuantity: deltaSupplied,
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
      deltaSupplied,
      deltaInstalled,
      sourceSupplied: item.deltaSupplied,
      sourceInstalled: item.deltaInstalled,
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
