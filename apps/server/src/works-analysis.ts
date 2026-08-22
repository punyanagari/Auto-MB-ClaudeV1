import type { TransactionSql } from '@auto-mb/db';
import type {
  CombinedPendingRow,
  CombinedPendingTotals,
  DivisionAnalysisResponse,
  ItemGroupProposalsResponse,
  MappedItemAnalysisResponse,
  WorkAnalysisBill,
  WorkAnalysisInspectionGroup,
  WorkAnalysisItem,
  WorkAnalysisResponse,
  WorksAnalysisDivisionSource,
  WorksAnalysisInspectionAgency,
} from '@auto-mb/contracts';
import { paiseText, toPaise } from './money.js';

/**
 * The reads behind the three works-analysis reports.
 *
 * `packages/contracts/src/works-analysis.ts` states what each figure MEANS
 * and which sources are included; this file is where they are computed, and
 * they are computed in PostgreSQL. Every quantity and every amount below
 * leaves this module as the exact decimal string a `numeric` column or a
 * `numeric` expression produced. Nothing here — and nothing downstream —
 * puts a money figure through `Number()`.
 *
 * ## Why these are new statements rather than `computeForBook`
 *
 * `routes/measurement-books/internal.ts` answers a different question: what
 * one Measurement Book may bill NEXT, which is a delta against the prior
 * cumulative and is clamped per book. These reports answer what the CONTRACT
 * still owes, cumulatively, with no book in hand — and for the portfolio
 * reports, across every Work at once, where opening a book per Work would be
 * hundreds of round trips to answer one screen.
 *
 * The two agree by construction where they overlap, because the clamps are
 * the same ones written out cumulatively: supply is never clamped (the
 * excess-delivery toggle is the only ceiling and it lives on the challan),
 * installation and PAC are clamped to the sanctioned quantity, and every
 * stage amount is `round(quantity x rate x percent / 100, 2)` — PostgreSQL's
 * `round(numeric, 2)` and `roundDecimalString` both round half away from
 * zero, so the two arithmetics cannot drift.
 */

/* --- report A: one Work ---------------------------------------------- */

/**
 * The per-item position of one Work. `$1` is the Work id.
 *
 * Each source is its own grouped CTE joined onto the item list, which is the
 * shape `ITEM_INPUTS_SQL` uses for the same reason: one pass per source
 * table, no correlated subquery per item, and a plan that does not change
 * when a Work grows from twelve items to a hundred and twenty-nine.
 *
 * `baseline` reads only LOCKED baselines. That is the whole meaning of the
 * lock (migration 0114): an unlocked baseline is a proposal somebody is
 * still editing, and folding it into a report would publish a draft as a
 * position.
 */
export const WORK_ITEM_POSITION_SQL = `
  with items as (
    select wi.id as work_item_id, wi.item_number,
           coalesce(wi.effective_description, wi.description) as description,
           coalesce(wi.effective_unit, wi.unit_code) as unit_code,
           coalesce(wi.effective_unit_rate, wi.effective_rate)::numeric(18,6) as rate,
           coalesce(wi.effective_quantity, wi.awarded_quantity)::numeric(18,3)
             as sanctioned,
           wi.payment_category
    from work_items wi
    where wi.work_id = $1 and wi.deleted_at is null
  ),
  delivered as (
    select dci.work_item_id, sum(dci.quantity) as quantity
    from delivery_challan_items dci
    join delivery_challans dc on dc.id = dci.delivery_challan_id
    where dc.work_id = $1 and dc.status = 'issued'
    group by dci.work_item_id
  ),
  installed as (
    select i.work_item_id, sum(i.quantity) as quantity
    from installations i
    where i.work_id = $1 and i.status = 'recorded'
    group by i.work_item_id
  ),
  certified as (
    select pci.work_item_id, sum(pci.certified_quantity) as quantity
    from pac_certificate_items pci
    join pac_certificates pc on pc.id = pci.pac_certificate_id
    where pc.work_id = $1 and pc.status = 'recorded'
    group by pci.work_item_id
  ),
  baseline as (
    select l.work_item_id, l.prior_supplied, l.prior_installed, l.prior_pac,
           coalesce(l.amount, 0) as amount
    from work_billing_baseline_lines l
    join work_billing_baselines b
      on b.id = l.work_billing_baseline_id
    where b.work_id = $1 and b.locked_at is not null
  ),
  billed as (
    select l.work_item_id, sum(l.line_total) as amount
    from measurement_book_lines l
    join measurement_books mb on mb.id = l.measurement_book_id
    where mb.work_id = $1 and mb.status = 'finalized'
    group by l.work_item_id
  ),
  called as (
    select ci.work_item_id,
           sum(ci.quantity) as called,
           coalesce(sum(ci.quantity) filter (where c.status = 'closed'), 0) as passed
    from inspection_call_items ci
    join inspection_calls c on c.id = ci.inspection_call_id
    where ci.work_id = $1 and c.status <> 'cancelled'
    group by ci.work_item_id
  ),
  position as (
    select it.*,
           cl.agency, cl.inspection_quantity,
           coalesce(cd.called, 0)::numeric(18,3) as called_quantity,
           coalesce(cd.passed, 0)::numeric(18,3) as passed_quantity,
           coalesce(bl.prior_supplied, 0)::numeric(18,3) as baseline_supplied,
           coalesce(bl.prior_installed, 0)::numeric(18,3) as baseline_installed,
           (coalesce(dv.quantity, 0) + coalesce(bl.prior_supplied, 0))::numeric(18,3)
             as delivered,
           (coalesce(iv.quantity, 0) + coalesce(bl.prior_installed, 0))::numeric(18,3)
             as installed,
           (coalesce(cv.quantity, 0) + coalesce(bl.prior_pac, 0))::numeric(18,3)
             as certified,
           (coalesce(bd.amount, 0) + coalesce(bl.amount, 0))::numeric(18,2)
             as billed_amount,
           pm.pct_supply, pm.pct_installation, pm.pct_pac
    from items it
    left join delivered dv on dv.work_item_id = it.work_item_id
    left join installed iv on iv.work_item_id = it.work_item_id
    left join certified cv on cv.work_item_id = it.work_item_id
    left join baseline bl on bl.work_item_id = it.work_item_id
    left join billed bd on bd.work_item_id = it.work_item_id
    left join inspection_clauses cl on cl.work_item_id = it.work_item_id
    left join called cd on cd.work_item_id = it.work_item_id
    -- The matrix row the item's own category resolves through. An item
    -- with no category resolves through nothing, exactly as
    -- \`resolvePaymentPercentages\` decides: a categorised item does NOT
    -- fall back to the residual row, so neither does this join.
    left join payment_matrices pm
      on pm.work_id = $1 and pm.category = it.payment_category
  )
  select p.work_item_id, p.item_number, p.description, p.unit_code,
         p.rate::text as rate,
         p.sanctioned::text as sanctioned_quantity,
         round(p.sanctioned * p.rate, 2)::text as sanctioned_value,
         p.delivered::text as delivered_quantity,
         round(p.delivered * p.rate, 2)::text as delivered_value,
         p.installed::text as installed_quantity,
         round(p.installed * p.rate, 2)::text as installed_value,
         p.baseline_supplied::text as baseline_supplied_quantity,
         p.baseline_installed::text as baseline_installed_quantity,
         -- Every \`greatest(x, 0)\` is CAST back to its column's scale. The
         -- zero is an integer literal, and PostgreSQL returns the literal
         -- itself when it wins, so an item with nothing pending reported
         -- '0' where its neighbours reported '0.000' — a figure that reads
         -- as a different kind of number in a column of quantities.
         greatest(p.sanctioned - p.delivered, 0)::numeric(18,3)::text
           as pending_supply_quantity,
         round(greatest(p.sanctioned - p.delivered, 0) * p.rate, 2)
           ::numeric(18,2)::text as pending_supply_value,
         greatest(p.sanctioned - p.installed, 0)::numeric(18,3)::text
           as pending_install_quantity,
         round(greatest(p.sanctioned - p.installed, 0) * p.rate, 2)
           ::numeric(18,2)::text as pending_install_value,
         greatest(p.delivered - p.installed, 0)::numeric(18,3)::text
           as supplied_not_installed_quantity,
         round(greatest(p.delivered - p.installed, 0) * p.rate, 2)
           ::numeric(18,2)::text as supplied_not_installed_value,
         greatest(p.installed - p.sanctioned, 0)::numeric(18,3)::text
           as installed_above_sanctioned_quantity,
         p.agency,
         p.inspection_quantity::text as inspection_quantity,
         p.called_quantity::text as inspection_called_quantity,
         p.passed_quantity::text as inspection_passed_quantity,
         case when p.inspection_quantity is null then null
              else greatest(p.inspection_quantity - p.called_quantity, 0)
                     ::numeric(18,3)::text
         end as pending_inspection_quantity,
         case when p.inspection_quantity is null then null
              else round(
                greatest(p.inspection_quantity - p.called_quantity, 0) * p.rate, 2
              )::numeric(18,2)::text
         end as pending_inspection_value,
         p.billed_amount::text as billed_value,
         -- Stage amounts, line-rounded then summed (rule R13), on the
         -- cumulative quantities: supply unclamped, installation and PAC
         -- clamped to sanction exactly as \`clampToSanctioned\` clamps each
         -- book's delta.
         case when p.pct_supply is null then null else (
             round(p.delivered * p.rate * p.pct_supply / 100, 2)
           + round(least(p.installed, p.sanctioned) * p.rate
                     * p.pct_installation / 100, 2)
           + round(least(p.certified, p.sanctioned) * p.rate * p.pct_pac / 100, 2)
         )::text end as executed_value,
         case when p.pct_supply is null then null else greatest((
             round(p.delivered * p.rate * p.pct_supply / 100, 2)
           + round(least(p.installed, p.sanctioned) * p.rate
                     * p.pct_installation / 100, 2)
           + round(least(p.certified, p.sanctioned) * p.rate * p.pct_pac / 100, 2)
           - p.billed_amount
         ), 0)::numeric(18,2)::text end as unbilled_executed_value
  from position p
  order by p.item_number
`;

interface WorkItemPositionRow {
  work_item_id: string;
  item_number: string;
  description: string;
  unit_code: string;
  rate: string;
  sanctioned_quantity: string;
  sanctioned_value: string;
  delivered_quantity: string;
  delivered_value: string;
  installed_quantity: string;
  installed_value: string;
  baseline_supplied_quantity: string;
  baseline_installed_quantity: string;
  pending_supply_quantity: string;
  pending_supply_value: string;
  pending_install_quantity: string;
  pending_install_value: string;
  supplied_not_installed_quantity: string;
  supplied_not_installed_value: string;
  installed_above_sanctioned_quantity: string;
  agency: WorksAnalysisInspectionAgency | null;
  inspection_quantity: string | null;
  inspection_called_quantity: string;
  inspection_passed_quantity: string;
  pending_inspection_quantity: string | null;
  pending_inspection_value: string | null;
  billed_value: string;
  executed_value: string | null;
  unbilled_executed_value: string | null;
}

/**
 * The Work's totals and its per-agency inspection subtotals, summed by
 * PostgreSQL over the same statement the item rows come from.
 *
 * A second pass over the same CTEs rather than a fold in TypeScript: rule 5
 * forbids JavaScript arithmetic on authoritative money, and a fold that used
 * the exact-decimal helpers would still be a second implementation of the
 * sum the database already knows how to do.
 */
const WORK_TOTALS_SQL = `
  with rows as (${WORK_ITEM_POSITION_SQL})
  select count(*)::text as item_count,
         coalesce(sum(sanctioned_value::numeric), 0)::numeric(18,2)::text
           as sanctioned_value,
         coalesce(sum(delivered_value::numeric), 0)::numeric(18,2)::text
           as delivered_value,
         coalesce(sum(installed_value::numeric), 0)::numeric(18,2)::text
           as installed_value,
         coalesce(sum(pending_supply_value::numeric), 0)::numeric(18,2)::text
           as pending_supply_value,
         coalesce(sum(pending_install_value::numeric), 0)::numeric(18,2)::text
           as pending_install_value,
         coalesce(sum(supplied_not_installed_value::numeric), 0)::numeric(18,2)::text
           as supplied_not_installed_value,
         coalesce(sum(pending_inspection_value::numeric), 0)::numeric(18,2)::text
           as pending_inspection_value,
         coalesce(sum(billed_value::numeric), 0)::numeric(18,2)::text as billed_value,
         coalesce(sum(unbilled_executed_value::numeric), 0)::numeric(18,2)::text
           as unbilled_executed_value,
         count(*) filter (where executed_value is null)::text
           as items_without_matrix_row
  from rows
`;

const WORK_INSPECTION_SQL = `
  with rows as (${WORK_ITEM_POSITION_SQL})
  select agency,
         count(*)::text as item_count,
         coalesce(sum(inspection_quantity::numeric), 0)::numeric(18,3)::text
           as clause_quantity,
         coalesce(sum(inspection_called_quantity::numeric), 0)::numeric(18,3)::text
           as called_quantity,
         coalesce(sum(inspection_passed_quantity::numeric), 0)::numeric(18,3)::text
           as passed_quantity,
         coalesce(sum(pending_inspection_quantity::numeric), 0)::numeric(18,3)::text
           as pending_quantity,
         coalesce(sum(pending_inspection_value::numeric), 0)::numeric(18,2)::text
           as pending_value
  from rows
  group by agency
  -- Nulls last, so the two agencies an operator came for lead the table and
  -- "no clause" reads as the remainder it is.
  order by agency nulls last
`;

/**
 * The Work's bills and their settlement positions. `$1` is the Work id.
 *
 * `bill_settlement_positions` (migration 0067) is the one place this product
 * answers "what is still owed": the reference is the RAILWAY'S bill amount
 * reached through the Measurement Book it closed, never the prepared amount,
 * and a deduction counts as settled because money the railway kept is money
 * it does not still owe.
 *
 * Historical invoices (migration 0115) are not here and must not be: they
 * are an imported display-only register carrying disputed flags, not bills.
 */
const WORK_BILLS_SQL = `
  select p.bill_id, p.bill_number, p.status,
         p.prepared_amount::text as prepared_amount,
         p.railway_bill_amount::text as railway_bill_amount,
         p.received_total::text as received_total,
         p.deduction_total::text as deduction_total,
         p.outstanding_amount::text as outstanding_amount
  from bill_settlement_positions p
  where p.work_id = $1
  order by p.bill_number
`;

const WORK_PAYMENT_TOTALS_SQL = `
  select count(*)::text as bill_count,
         coalesce(sum(p.railway_bill_amount), 0)::numeric(18,2)::text as railway_total,
         coalesce(sum(p.received_total)
                    filter (where p.railway_bill_amount is not null),
                  0)::numeric(18,2)::text as received_total,
         coalesce(sum(p.deduction_total)
                    filter (where p.railway_bill_amount is not null),
                  0)::numeric(18,2)::text as deduction_total,
         coalesce(sum(p.received_total + p.deduction_total)
                    filter (where p.railway_bill_amount is not null),
                  0)::numeric(18,2)::text as settled_total,
         coalesce(sum(p.outstanding_amount), 0)::numeric(18,2)::text
           as outstanding_total,
         count(*) filter (where p.railway_bill_amount is null)::text
           as indeterminate_bills
  from bill_settlement_positions p
  where p.work_id = $1
`;

/**
 * The division codes the Work's own consignees carry. `$1` is the Work id.
 *
 * Stated plainly because the derivation is the report's weakest claim: this
 * schema has no `works.client_contact_id`, so there is no stored answer to
 * "which division is this Work under". What it does have is
 * `work_consignees` — the railway offices the Work is executed for, chosen
 * by the operator on the Work's own Consignees screen — and
 * `contacts.division_code` (migration 0039) on each of those.
 *
 * That is the right evidence rather than merely the available evidence, and
 * the alternative is worth recording because it was tried first: a
 * work-scoped delivery challan's `consignee_contact_id` is constrained NULL
 * by `delivery_challans_kind_shape` (migration 0056), so deriving from
 * issued challans would have joined nothing on every Work in the product
 * and reported "no division on record" for all of them — a report that is
 * empty for a reason nobody could see.
 *
 * A Work whose consignees carry one division code is that division's. One
 * carrying two is reported as ambiguous and grouped under "no division on
 * record", because a tie-break here would put a Work's whole pending
 * position under a heading somebody would then order against.
 */
const WORK_DIVISION_SQL = `
  select array_remove(array_agg(distinct c.division_code), null) as codes
  from work_consignees wc
  join contacts c on c.id = wc.contact_id
  where wc.work_id = $1
`;

function divisionOf(codes: readonly string[] | null): {
  divisionCode: string | null;
  divisionSource: WorksAnalysisDivisionSource;
  divisionCandidates: string[];
} {
  const found = codes ?? [];
  if (found.length === 1 && found[0] !== undefined) {
    return {
      divisionCode: found[0],
      divisionSource: 'consignee',
      divisionCandidates: [...found],
    };
  }
  return {
    divisionCode: null,
    divisionSource: found.length === 0 ? 'none' : 'ambiguous',
    divisionCandidates: [...found],
  };
}

export async function readWorkAnalysis(
  tx: TransactionSql,
  workId: string,
): Promise<WorkAnalysisResponse | null> {
  const [work] = await tx<
    {
      id: string;
      work_code: string;
      title: string;
      status: string;
      contract_value: string;
      allow_excess_delivery: boolean;
    }[]
  >`
    select id, work_code, title, status,
           contract_value::text as contract_value, allow_excess_delivery
    from works where id = ${workId} and deleted_at is null
  `;
  if (work === undefined) return null;

  const items = (await tx.unsafe(WORK_ITEM_POSITION_SQL, [
    workId,
  ])) as unknown as WorkItemPositionRow[];
  const [totals] = (await tx.unsafe(WORK_TOTALS_SQL, [workId])) as unknown as {
    item_count: string;
    sanctioned_value: string;
    delivered_value: string;
    installed_value: string;
    pending_supply_value: string;
    pending_install_value: string;
    supplied_not_installed_value: string;
    pending_inspection_value: string;
    billed_value: string;
    unbilled_executed_value: string;
    items_without_matrix_row: string;
  }[];
  const inspection = (await tx.unsafe(WORK_INSPECTION_SQL, [workId])) as unknown as {
    agency: WorksAnalysisInspectionAgency | null;
    item_count: string;
    clause_quantity: string;
    called_quantity: string;
    passed_quantity: string;
    pending_quantity: string;
    pending_value: string;
  }[];
  const bills = (await tx.unsafe(WORK_BILLS_SQL, [workId])) as unknown as {
    bill_id: string;
    bill_number: string;
    status: string;
    prepared_amount: string;
    railway_bill_amount: string | null;
    received_total: string;
    deduction_total: string;
    outstanding_amount: string | null;
  }[];
  const [payment] = (await tx.unsafe(WORK_PAYMENT_TOTALS_SQL, [workId])) as unknown as {
    bill_count: string;
    railway_total: string;
    received_total: string;
    deduction_total: string;
    settled_total: string;
    outstanding_total: string;
    indeterminate_bills: string;
  }[];
  const [division] = (await tx.unsafe(WORK_DIVISION_SQL, [workId])) as unknown as {
    codes: string[] | null;
  }[];
  const [baseline] = await tx<{ locked: boolean }[]>`
    select true as locked from work_billing_baselines
    where work_id = ${workId} and locked_at is not null
  `;

  return {
    work: {
      id: work.id,
      workCode: work.work_code,
      title: work.title,
      status: work.status,
      contractValue: work.contract_value,
      allowExcessDelivery: work.allow_excess_delivery,
    },
    ...divisionOf(division?.codes ?? null),
    baselineLocked: baseline !== undefined,
    items: items.map(toWorkAnalysisItem),
    totals: {
      itemCount: Number(totals?.item_count ?? '0'),
      sanctionedValue: totals?.sanctioned_value ?? '0.00',
      deliveredValue: totals?.delivered_value ?? '0.00',
      installedValue: totals?.installed_value ?? '0.00',
      pendingSupplyValue: totals?.pending_supply_value ?? '0.00',
      pendingInstallValue: totals?.pending_install_value ?? '0.00',
      suppliedNotInstalledValue: totals?.supplied_not_installed_value ?? '0.00',
      pendingInspectionValue: totals?.pending_inspection_value ?? '0.00',
      billedValue: totals?.billed_value ?? '0.00',
      unbilledExecutedValue: totals?.unbilled_executed_value ?? '0.00',
      itemsWithoutMatrixRow: Number(totals?.items_without_matrix_row ?? '0'),
    },
    inspection: inspection.map((row): WorkAnalysisInspectionGroup => ({
      agency: row.agency,
      itemCount: Number(row.item_count),
      clauseQuantity: row.clause_quantity,
      calledQuantity: row.called_quantity,
      passedQuantity: row.passed_quantity,
      pendingQuantity: row.pending_quantity,
      pendingValue: row.pending_value,
    })),
    bills: bills.map((row): WorkAnalysisBill => ({
      billId: row.bill_id,
      billNumber: row.bill_number,
      status: row.status,
      preparedAmount: row.prepared_amount,
      railwayBillAmount: row.railway_bill_amount,
      receivedTotal: row.received_total,
      deductionTotal: row.deduction_total,
      outstandingAmount: row.outstanding_amount,
    })),
    payment: {
      billCount: Number(payment?.bill_count ?? '0'),
      railwayTotal: payment?.railway_total ?? '0.00',
      receivedTotal: payment?.received_total ?? '0.00',
      deductionTotal: payment?.deduction_total ?? '0.00',
      settledTotal: payment?.settled_total ?? '0.00',
      outstandingTotal: payment?.outstanding_total ?? '0.00',
      indeterminateBills: Number(payment?.indeterminate_bills ?? '0'),
    },
  };
}

function toWorkAnalysisItem(row: WorkItemPositionRow): WorkAnalysisItem {
  return {
    workItemId: row.work_item_id,
    itemNumber: row.item_number,
    description: row.description,
    unitCode: row.unit_code,
    rate: row.rate,
    sanctionedQuantity: row.sanctioned_quantity,
    sanctionedValue: row.sanctioned_value,
    deliveredQuantity: row.delivered_quantity,
    deliveredValue: row.delivered_value,
    installedQuantity: row.installed_quantity,
    installedValue: row.installed_value,
    pendingSupplyQuantity: row.pending_supply_quantity,
    pendingSupplyValue: row.pending_supply_value,
    pendingInstallQuantity: row.pending_install_quantity,
    pendingInstallValue: row.pending_install_value,
    suppliedNotInstalledQuantity: row.supplied_not_installed_quantity,
    suppliedNotInstalledValue: row.supplied_not_installed_value,
    installedAboveSanctionedQuantity: row.installed_above_sanctioned_quantity,
    baselineSuppliedQuantity: row.baseline_supplied_quantity,
    baselineInstalledQuantity: row.baseline_installed_quantity,
    inspectionAgency: row.agency,
    inspectionQuantity: row.inspection_quantity,
    inspectionCalledQuantity: row.inspection_called_quantity,
    inspectionPassedQuantity: row.inspection_passed_quantity,
    pendingInspectionQuantity: row.pending_inspection_quantity,
    pendingInspectionValue: row.pending_inspection_value,
    billedValue: row.billed_value,
    executedValue: row.executed_value,
    unbilledExecutedValue: row.unbilled_executed_value,
  };
}

/* --- reports B and C: combined pending -------------------------------- */

/**
 * The assignment predicate, identical to the one every cross-Work register
 * uses (`routes/mis.ts`): `$1` is the caller's full-scope flag and `$2`
 * their user id, so an assigned-scope member's report narrows rather than
 * refusing or, worse, widening.
 */
const VISIBLE_WORK = `($1::boolean or exists (
  select 1 from work_assignments wa
  where wa.work_id = w.id and wa.user_id = $2))`;

/**
 * Every live schedule line of every ACTIVE Work, with its cumulative
 * position and the canonical item it maps to.
 *
 * Active only, and that is a judgement worth disagreeing with: these two
 * reports exist so material can be ORDERED, and a cancelled Work is not
 * something to order against while a completed one has nothing outstanding
 * by definition (a Work reaches `completed` only at 100% executed value).
 * The per-Work report has no such filter — it is asked about one named Work,
 * whatever its status.
 *
 * The mapping join is `routes/masters.ts`'s, verbatim in meaning: a line
 * counts against a canonical item when its normalised description equals
 * that item's name or one of its aliases, compared lowercased and trimmed,
 * against ACTIVE items only. `limit 1` under a deterministic order settles
 * the one case that comparison leaves open — two items claiming the same
 * alias — rather than double-counting the line under both.
 */
const PENDING_LINES_CTE = `
  lines as (
    select wi.id as work_item_id, wi.work_id,
           lower(btrim(coalesce(wi.effective_description, wi.description))) as key,
           coalesce(wi.effective_description, wi.description) as description,
           coalesce(wi.effective_unit, wi.unit_code) as unit_code,
           coalesce(wi.effective_unit_rate, wi.effective_rate)::numeric(18,6) as rate,
           coalesce(wi.effective_quantity, wi.awarded_quantity)::numeric(18,3)
             as sanctioned
    from work_items wi
    join works w on w.id = wi.work_id and w.deleted_at is null
    where wi.deleted_at is null and w.status = 'active' and ${VISIBLE_WORK}
  ),
  delivered as (
    select dci.work_item_id, sum(dci.quantity) as quantity
    from delivery_challan_items dci
    join delivery_challans dc on dc.id = dci.delivery_challan_id
    where dc.status = 'issued'
    group by dci.work_item_id
  ),
  installed as (
    select i.work_item_id, sum(i.quantity) as quantity
    from installations i
    where i.status = 'recorded'
    group by i.work_item_id
  ),
  baseline as (
    select l.work_item_id, l.prior_supplied, l.prior_installed
    from work_billing_baseline_lines l
    join work_billing_baselines b on b.id = l.work_billing_baseline_id
    where b.locked_at is not null
  ),
  positions as (
    select l.work_item_id, l.work_id, l.key, l.description, l.unit_code, l.rate,
           l.sanctioned,
           (coalesce(dv.quantity, 0) + coalesce(bl.prior_supplied, 0))::numeric(18,3)
             as delivered,
           (coalesce(iv.quantity, 0) + coalesce(bl.prior_installed, 0))::numeric(18,3)
             as installed
    from lines l
    left join delivered dv on dv.work_item_id = l.work_item_id
    left join installed iv on iv.work_item_id = l.work_item_id
    left join baseline bl on bl.work_item_id = l.work_item_id
  ),
  mapped as (
    select p.*, ci.id as canonical_item_id, ci.name as canonical_name,
           ci.group_name
    from positions p
    left join lateral (
      select item.id, item.name, item.group_name
      from canonical_items item
      where item.active
        and (lower(btrim(item.name)) = p.key
             or exists (
               select 1 from unnest(item.aliases) alias
               where lower(btrim(alias)) = p.key
             ))
      order by lower(btrim(item.name))
      limit 1
    ) ci on true
  )
`;

/**
 * The grouped pending row.
 *
 * The GROUP KEY is the CANONICAL ITEM where there is one, and the
 * normalised description only where there is not — plus the unit in both
 * cases, so a canonical item quantified in two units yields two rows and no
 * quantity is ever added across units.
 *
 * Grouping on the description key throughout was the first cut and it was
 * wrong in exactly the case the item master exists for: "42U Rack" and
 * "42U Rack," map to the same master item and have different keys, so the
 * report drew two rows for one product and quietly under-reported the
 * larger one. Combining EXACTLY where a mapping exists means combining
 * across the wordings that mapping covers.
 *
 * The rate is reported as `min`/`max` rather than averaged: the value
 * columns are summed per line at each line's own rate, so a spread never
 * makes a total wrong, and averaging one would invent a rate no contract
 * carries.
 */
const PENDING_GROUP_KEY = `coalesce(m.canonical_item_id::text, m.key)`;

const PENDING_ROW_SELECT = `
  select m.canonical_item_id::text as canonical_item_id,
         coalesce(m.canonical_name, min(m.description)) as label,
         m.group_name,
         m.unit_code,
         min(m.rate)::text as rate_low,
         max(m.rate)::text as rate_high,
         count(distinct m.work_id)::text as work_count,
         count(*)::text as line_count,
         sum(m.sanctioned)::numeric(18,3)::text as sanctioned_quantity,
         sum(m.delivered)::numeric(18,3)::text as delivered_quantity,
         sum(m.installed)::numeric(18,3)::text as installed_quantity,
         sum(greatest(m.sanctioned - m.delivered, 0))::numeric(18,3)::text
           as pending_supply_quantity,
         sum(round(greatest(m.sanctioned - m.delivered, 0) * m.rate, 2))
           ::numeric(18,2)::text as pending_supply_value,
         sum(greatest(m.sanctioned - m.installed, 0))::numeric(18,3)::text
           as pending_install_quantity,
         sum(round(greatest(m.sanctioned - m.installed, 0) * m.rate, 2))
           ::numeric(18,2)::text as pending_install_value
`;

interface PendingRow {
  canonical_item_id: string | null;
  label: string;
  group_name: string | null;
  unit_code: string;
  rate_low: string;
  rate_high: string;
  work_count: string;
  line_count: string;
  sanctioned_quantity: string;
  delivered_quantity: string;
  installed_quantity: string;
  pending_supply_quantity: string;
  pending_supply_value: string;
  pending_install_quantity: string;
  pending_install_value: string;
}

function toPendingRow(row: PendingRow): CombinedPendingRow {
  return {
    canonicalItemId: row.canonical_item_id,
    label: row.label,
    groupName: row.group_name,
    unitCode: row.unit_code,
    rateLow: row.rate_low,
    rateHigh: row.rate_high,
    workCount: Number(row.work_count),
    lineCount: Number(row.line_count),
    sanctionedQuantity: row.sanctioned_quantity,
    deliveredQuantity: row.delivered_quantity,
    installedQuantity: row.installed_quantity,
    pendingSupplyQuantity: row.pending_supply_quantity,
    pendingSupplyValue: row.pending_supply_value,
    pendingInstallQuantity: row.pending_install_quantity,
    pendingInstallValue: row.pending_install_value,
  };
}

/**
 * The division each visible active Work belongs to, by the derivation
 * `WORK_DIVISION_SQL` documents, evaluated for every Work at once.
 */
const DIVISION_WORKS_SQL = `
  select w.id as work_id, w.work_code, w.title,
         array_remove(array_agg(distinct c.division_code), null) as codes
  from works w
  left join work_consignees wc on wc.work_id = w.id
  left join contacts c on c.id = wc.contact_id
  where w.deleted_at is null and w.status = 'active' and ${VISIBLE_WORK}
  group by w.id, w.work_code, w.title
  order by w.work_code
`;

const DIVISION_ROWS_SQL = `
  with ${PENDING_LINES_CTE},
  work_division as (
    select w.id as work_id,
           array_remove(array_agg(distinct c.division_code), null) as codes
    from works w
    left join work_consignees wc on wc.work_id = w.id
    left join contacts c on c.id = wc.contact_id
    where w.deleted_at is null
    group by w.id
  )
  ${PENDING_ROW_SELECT},
         (case when cardinality(wd.codes) = 1 then wd.codes[1] end) as division_code
  from mapped m
  join work_division wd on wd.work_id = m.work_id
  -- Grouped on the EXPRESSION rather than on the output name: PostgreSQL
  -- resolves a GROUP BY name against the input columns first, so an alias
  -- that ever collides with one would silently group by the wrong thing.
  group by (case when cardinality(wd.codes) = 1 then wd.codes[1] end),
           ${PENDING_GROUP_KEY}, m.canonical_item_id, m.canonical_name,
           m.group_name, m.unit_code
  order by division_code nulls last, label, m.unit_code
`;

const MAPPED_ITEM_ROWS_SQL = `
  with ${PENDING_LINES_CTE}
  ${PENDING_ROW_SELECT}
  from mapped m
  group by ${PENDING_GROUP_KEY}, m.canonical_item_id, m.canonical_name,
           m.group_name, m.unit_code
  order by (m.canonical_item_id is null), label, m.unit_code
`;

/** How many live schedule lines match no active canonical item. The count
 * the item-master screen puts above its table, asked here so the report can
 * say how much of the portfolio the grouping does not yet cover. */
const UNMAPPED_LINES_SQL = `
  with ${PENDING_LINES_CTE}
  select count(*) filter (where m.canonical_item_id is null)::text
           as unmapped_line_count
  from mapped m
`;

export async function readDivisionAnalysis(
  tx: TransactionSql,
  fullScope: boolean,
  userId: string,
): Promise<DivisionAnalysisResponse> {
  const parameters: (boolean | string)[] = [fullScope, userId];
  const works = (await tx.unsafe(DIVISION_WORKS_SQL, parameters)) as unknown as {
    work_id: string;
    work_code: string;
    title: string;
    codes: string[] | null;
  }[];
  const rows = (await tx.unsafe(
    DIVISION_ROWS_SQL,
    parameters,
  )) as unknown as (PendingRow & { division_code: string | null })[];

  const byDivision = new Map<
    string,
    { divisionCode: string | null; rows: CombinedPendingRow[] }
  >();
  const keyOf = (code: string | null): string => code ?? '';
  for (const row of rows) {
    const key = keyOf(row.division_code);
    const bucket = byDivision.get(key) ?? { divisionCode: row.division_code, rows: [] };
    bucket.rows.push(toPendingRow(row));
    byDivision.set(key, bucket);
  }
  const worksByDivision = new Map<string, DivisionWork[]>();
  for (const work of works) {
    const derived = divisionOf(work.codes);
    const key = keyOf(derived.divisionCode);
    const list = worksByDivision.get(key) ?? [];
    list.push({
      id: work.work_id,
      workCode: work.work_code,
      title: work.title,
      divisionSource: derived.divisionSource,
      divisionCandidates: derived.divisionCandidates,
    });
    worksByDivision.set(key, list);
  }

  // Every division that has either a Work or a row, so a division whose
  // Works are all fully delivered still appears with an empty table rather
  // than vanishing and reading as "no such division".
  const keys = [...new Set([...byDivision.keys(), ...worksByDivision.keys()])].sort();
  const divisions = keys.map((key) => {
    const bucket = byDivision.get(key);
    const divisionWorks = worksByDivision.get(key) ?? [];
    const divisionRows = bucket?.rows ?? [];
    return {
      divisionCode: key === '' ? null : key,
      // A group keyed on no code holds the Works that named none and the
      // Works that named several; the per-Work `divisionSource` beside each
      // one says which, because the two need different fixes.
      divisionSource:
        key === ''
          ? divisionWorks.some((work) => work.divisionSource === 'ambiguous')
            ? ('ambiguous' as const)
            : ('none' as const)
          : ('consignee' as const),
      works: divisionWorks,
      rows: divisionRows,
      totals: sumRows(divisionRows),
    };
  });

  return {
    divisions,
    totals: sumRows(divisions.flatMap((division) => division.rows)),
  };
}

interface DivisionWork {
  id: string;
  workCode: string;
  title: string;
  divisionSource: WorksAnalysisDivisionSource;
  divisionCandidates: string[];
}

/**
 * The totals under a set of grouped rows.
 *
 * Added as exact PAISE through `money.ts`'s own `toPaise`/`paiseText`, which
 * is what the rest of this server already uses for the same job — never as
 * JavaScript numbers, which rule 5 forbids for a reason a report of ten
 * thousand rows would demonstrate. Reached by folding rather than by a
 * fourth grouped statement per division because the rows are already here
 * and exact; the arithmetic, not the storage, is what the rule is about.
 */
function sumRows(rows: readonly CombinedPendingRow[]): CombinedPendingTotals {
  let supply = 0n;
  let install = 0n;
  for (const row of rows) {
    supply += toPaise(row.pendingSupplyValue);
    install += toPaise(row.pendingInstallValue);
  }
  return {
    rowCount: rows.length,
    mappedRowCount: rows.filter((row) => row.canonicalItemId !== null).length,
    pendingSupplyValue: paiseText(supply),
    pendingInstallValue: paiseText(install),
  };
}

export async function readMappedItemAnalysis(
  tx: TransactionSql,
  fullScope: boolean,
  userId: string,
): Promise<MappedItemAnalysisResponse> {
  const parameters: (boolean | string)[] = [fullScope, userId];
  const rows = (await tx.unsafe(
    MAPPED_ITEM_ROWS_SQL,
    parameters,
  )) as unknown as PendingRow[];
  const [unmapped] = (await tx.unsafe(UNMAPPED_LINES_SQL, parameters)) as unknown as {
    unmapped_line_count: string;
  }[];
  const mappedRows = rows.map(toPendingRow);
  return {
    rows: mappedRows,
    totals: sumRows(mappedRows),
    unmappedLineCount: Number(unmapped?.unmapped_line_count ?? '0'),
  };
}

/* --- the proposals ---------------------------------------------------- */

/**
 * Unmapped descriptions that differ only in case, punctuation or spacing.
 *
 * The key drops everything that is not a letter, a digit or a space, then
 * collapses runs of space. That is the whole comparison, and it is
 * deliberately this weak: `routes/masters.ts` records that fuzzy matching
 * belongs behind a review step, and a proposal an operator cannot verify by
 * reading two strings side by side is not a review step — it is the silent
 * guessing the item master exists to avoid.
 *
 * Groups of ONE are not proposals. A single unmapped description needs no
 * grouping decision; it needs a canonical item, which the item master screen
 * already offers.
 *
 * This statement WRITES NOTHING. Confirming a proposal is
 * `POST /api/masters/canonical-items` with the proposed name and the other
 * wordings as aliases — the existing control, which is also what makes the
 * confirmed group persist and start counting in the report above.
 */
const ITEM_GROUP_PROPOSALS_SQL = `
  with ${PENDING_LINES_CTE},
  unmapped as (
    select m.description, m.unit_code, m.rate, m.work_id,
           btrim(regexp_replace(
             regexp_replace(lower(m.description), '[^a-z0-9 ]+', ' ', 'g'),
             '\\s+', ' ', 'g'
           )) as fold
    from mapped m
    where m.canonical_item_id is null
  ),
  folded as (
    select fold,
           count(*)::int as line_count,
           count(distinct work_id)::int as work_count,
           count(distinct description)::int as wording_count,
           array_agg(distinct description) as descriptions,
           array_agg(distinct unit_code) as unit_codes,
           min(rate) as rate_low,
           max(rate) as rate_high
    from unmapped
    group by fold
  ),
  -- The wording to NAME the item: the one the most lines carry, ties broken
  -- alphabetically so two runs of this report propose the same name.
  leading_wording as (
    select distinct on (fold) fold, description
    from (
      select fold, description, count(*) as lines
      from unmapped group by fold, description
    ) counted
    order by fold, lines desc, description
  )
  select f.fold as key, l.description as proposed_name,
         f.descriptions, f.unit_codes,
         f.rate_low::text as rate_low, f.rate_high::text as rate_high,
         f.line_count::text as line_count, f.work_count::text as work_count
  from folded f
  join leading_wording l on l.fold = f.fold
  where f.wording_count > 1
  order by f.line_count desc, f.fold
`;

export async function readItemGroupProposals(
  tx: TransactionSql,
  fullScope: boolean,
  userId: string,
): Promise<ItemGroupProposalsResponse> {
  const rows = (await tx.unsafe(ITEM_GROUP_PROPOSALS_SQL, [
    fullScope,
    userId,
  ])) as unknown as {
    key: string;
    proposed_name: string;
    descriptions: string[];
    unit_codes: string[];
    rate_low: string;
    rate_high: string;
    line_count: string;
    work_count: string;
  }[];
  return {
    proposals: rows.map((row) => ({
      key: row.key,
      proposedName: row.proposed_name,
      aliases: row.descriptions.filter((name) => name !== row.proposed_name),
      unitCodes: row.unit_codes,
      rateLow: row.rate_low,
      rateHigh: row.rate_high,
      lineCount: Number(row.line_count),
      workCount: Number(row.work_count),
    })),
  };
}
