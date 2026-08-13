import {
  type MbSourceConflictDetails,
  type MbSourceRef,
  type MbSourceType,
  type MeasurementBook,
  type MeasurementBookDetailResponse,
  type MeasurementBookKind,
  type MeasurementBookLine,
  type MeasurementBookSource,
  type WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { httpError } from '../../http.js';
import {
  computeMeasurementBook,
  type MbComputation,
  type MbComputedLine,
  type MbItemInput,
} from '../../mb-compute.js';
import {
  MB_TEMPLATE_VERSION,
  type MeasurementBookBranding,
  type MeasurementBookSnapshot,
} from '../../mb-html.js';
import { loadPaymentMatrix } from '../../payment-matrix.js';
import { canonicalRateText } from '../../rate-text.js';
import type { ObjectStorage } from '../../storage.js';
import { withBoundTenant } from '../../tenant-context.js';
import { renderPdfViaGotenberg } from '../../pdf-render.js';

/**
 * Milestone 8 phase 2: the stage-wise Measurement Book lifecycle engine
 * (ADR-0006; legacy spec §5.9, rule R19). Draft -> finalized ->
 * cancelled (newest-live-only), gap-free <work_code>-MB-NN numbering
 * under the per-Work counter lock, database-enforced one-live-MB-per-
 * source claims (mb_sources partial unique index), true-cumulative
 * prior memory over non-cancelled finalized MBs, and bill preparation
 * FROM a finalized MB (bills.mb_id, amount = the MB's snapshotted
 * total). Drafts recompute from live state on every read; finalize
 * recomputes inside one transaction under the Work row lock and
 * snapshots lines whose remark text comes character-for-character from
 * computeMbRemark under MB_REMARK_TEMPLATE_VERSION.
 *
 * Migration 0034 adds the three kinds. RECORD drafts are per-consignee
 * parallel measurement sheets: several run at once (one per consignee),
 * they claim sources exactly like any draft, and they NEVER finalize —
 * the merge endpoint folds them into a new on-account draft that claims
 * the union of their sources and marks each record merged. The
 * one-billing-draft rule (on-account/final) and the final-MB sweep are
 * unchanged; record MBs are invisible to billing. Un-merge is the only
 * way to take an absorbing draft apart: it restores the records and
 * their claims from normalized merge provenance, then deletes the draft.
 */

// --- Row shapes -------------------------------------------------------------

export interface BookRow {
  id: string;
  work_id: string;
  status: MeasurementBook['status'];
  kind: MeasurementBookKind;
  is_final: boolean;
  consignee_contact_id: string | null;
  merged_into_id: string | null;
  mb_date: string;
  mb_number: string | null;
  sequence_number: number | null;
  total_amount: string | null;
  remark_template_version: string | null;
  template_version: string | null;
  rendered_object_key: string | null;
  cancellation_note: string | null;
  bill_id: string | null;
  created_at: Date;
  finalized_at: Date | null;
  cancelled_at: Date | null;
}

export function toBook(row: BookRow): MeasurementBook {
  return {
    id: row.id,
    workId: row.work_id,
    status: row.status,
    kind: row.kind,
    isFinal: row.is_final,
    consigneeContactId: row.consignee_contact_id,
    mergedIntoId: row.merged_into_id,
    mbDate: row.mb_date,
    mbNumber: row.mb_number,
    sequenceNumber: row.sequence_number,
    totalAmount: row.total_amount,
    remarkTemplateVersion: row.remark_template_version,
    templateVersion: row.template_version,
    renderedAvailable: row.rendered_object_key !== null,
    cancellationNote: row.cancellation_note,
    billId: row.bill_id,
    createdAt: row.created_at.toISOString(),
    finalizedAt: row.finalized_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

export const BOOK_COLUMNS = `
  mb.id, mb.work_id, mb.status, mb.kind, mb.is_final,
  mb.consignee_contact_id, mb.merged_into_id, mb.mb_date::text as mb_date,
  mb.mb_number, mb.sequence_number, mb.total_amount::text as total_amount,
  mb.remark_template_version, mb.template_version, mb.rendered_object_key,
  mb.cancellation_note,
  (select b.id from bills b
    where b.mb_id = mb.id) as bill_id,
  mb.created_at, mb.finalized_at, mb.cancelled_at
`;

export async function readBook(
  tx: TransactionSql,
  id: string,
): Promise<BookRow | undefined> {
  const rows = (await tx.unsafe(
    `select ${BOOK_COLUMNS} from measurement_books mb where mb.id = $1`,
    [id],
  )) as unknown as BookRow[];
  return rows[0];
}

/** The claimed sources with human labels: challan number, installation
 * summary, or PAC reference. */
export async function readSources(
  tx: TransactionSql,
  bookId: string,
): Promise<MeasurementBookSource[]> {
  const rows = await tx<
    {
      id: string;
      source_type: MbSourceType;
      source_id: string;
      label: string | null;
      released_at: Date | null;
    }[]
  >`
    select ms.id, ms.source_type, ms.source_id, ms.released_at,
           case ms.source_type
             when 'delivery_challan' then (
               select dc.challan_number from delivery_challans dc
               where dc.id = ms.source_id)
             when 'installation' then (
               select wi.item_number || ' x ' || i.quantity::text || ' @ ' || i.location_name
               from installations i
               join work_items wi on wi.id = i.work_item_id
               where i.id = ms.source_id)
             else (
               select pc.reference from pac_certificates pc
               where pc.id = ms.source_id)
           end as label
    from mb_sources ms
    where ms.measurement_book_id = ${bookId}
    order by ms.source_type, ms.created_at, ms.id
  `;
  return rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    label: row.label ?? row.source_id,
    releasedAt: row.released_at?.toISOString() ?? null,
  }));
}

// --- Live-state computation inputs ------------------------------------------

export interface ItemInputRow {
  work_item_id: string;
  item_number: string;
  description: string;
  unit_code: string;
  payment_category: string | null;
  effective_rate: string;
  delta_supplied: string;
  delta_installed: string;
  delta_pac: string;
  prior_supplied: string;
  prior_installed: string;
  prior_pac: string;
  prior_final_bill: string;
  cumulative_delivered: string;
  cumulative_installed: string;
  cumulative_amc_certified: string;
}

/**
 * The one statement behind `loadItemInputs`, as text so the query-budget
 * and plan-shape tests can EXPLAIN exactly what production runs
 * (`test/query-aggregates.integration.test.ts`). `$1` is the Work,
 * `$2` the Measurement Book.
 *
 * SHAPE, and why it matters: every stage is a CTE that GROUPS BY
 * `work_item_id` once, and the item list left-joins those groups. The
 * predecessor cross-joined six correlated laterals, so each aggregate
 * re-ran per item — 33,669 index probes and 446 ms on the review's
 * measured Work, growing with items x evidence. The arithmetic is
 * unchanged: the same sums over the same rows, still in exact SQL
 * numeric, still `coalesce(..., 0)::numeric(18,3)` per item, so every
 * reported quantity is character-for-character what the laterals
 * produced (proved on a seeded fixture by the equivalence test, which
 * runs the retired lateral text beside this one).
 *
 * `items` is referenced by every stage, so PostgreSQL materialises it:
 * one scan of the Work's live items feeds every aggregate, and each
 * aggregate scans its own evidence once.
 *
 * Migration 0068 added a seventh aggregate, `certified`, for the AMC
 * final-bill base. It is the one aggregate restricted to a subset of the
 * items, because it is the one whose value only a single branch of
 * `resolveFinalBillBase` reads — see the CTE's own note.
 */
export const ITEM_INPUTS_SQL = `
  with items as (
    select wi.id, wi.item_number, wi.description, wi.unit_code,
           wi.payment_category,
           coalesce(wi.effective_unit_rate, wi.effective_rate) as effective_rate
    from work_items wi
    where wi.work_id = $1 and wi.deleted_at is null
  ),
  delta_supplied as (
    select dci.work_item_id, sum(dci.quantity) as total
    from mb_sources ms
    join delivery_challans dc on dc.id = ms.source_id and dc.status = 'issued'
    join delivery_challan_items dci on dci.delivery_challan_id = ms.source_id
    join items it on it.id = dci.work_item_id
    where ms.measurement_book_id = $2
      and ms.source_type = 'delivery_challan'
    group by dci.work_item_id
  ),
  delta_installed as (
    select i.work_item_id, sum(i.quantity) as total
    from mb_sources ms
    join installations i on i.id = ms.source_id and i.status = 'recorded'
    join items it on it.id = i.work_item_id
    where ms.measurement_book_id = $2
      and ms.source_type = 'installation'
    group by i.work_item_id
  ),
  delta_pac as (
    select pci.work_item_id, sum(pci.certified_quantity) as total
    from mb_sources ms
    join pac_certificates pc on pc.id = ms.source_id and pc.status = 'recorded'
    join pac_certificate_items pci on pci.pac_certificate_id = ms.source_id
    join items it on it.id = pci.work_item_id
    where ms.measurement_book_id = $2
      and ms.source_type = 'pac_certificate'
    group by pci.work_item_id
  ),
  prior as (
    select l.work_item_id,
           sum(l.delta_supplied) as supplied,
           sum(l.delta_installed) as installed,
           sum(l.delta_pac) as pac,
           sum(l.delta_final_bill) as final_bill
    from measurement_book_lines l
    join measurement_books pmb on pmb.id = l.measurement_book_id
    join items it on it.id = l.work_item_id
    where pmb.status = 'finalized' and pmb.id <> $2
    group by l.work_item_id
  ),
  delivered as (
    select dci.work_item_id, sum(dci.quantity) as total
    from delivery_challan_items dci
    join delivery_challans dc on dc.id = dci.delivery_challan_id
    join items it on it.id = dci.work_item_id
    where dc.status = 'issued'
    group by dci.work_item_id
  ),
  installed as (
    select i.work_item_id, sum(i.quantity) as total
    from installations i
    join items it on it.id = i.work_item_id
    where i.status = 'recorded'
    group by i.work_item_id
  ),
  -- The AMC final-bill base (migration 0068), and ONLY that. Unlike the
  -- delivered and installed aggregates beside it, this one is read by a
  -- single branch of resolveFinalBillBase, so it is restricted to the
  -- items that branch can select. A Work with no maintenance schedule —
  -- which is most of them — pays nothing for it, and one with a
  -- maintenance schedule aggregates over its one or two AMC items
  -- rather than over every certificate the Work holds.
  certified as (
    select pci.work_item_id, sum(pci.certified_quantity) as total
    from pac_certificate_items pci
    join pac_certificates pc on pc.id = pci.pac_certificate_id
    join items it on it.id = pci.work_item_id and it.payment_category = 'AMC'
    where pc.status = 'recorded'
    group by pci.work_item_id
  )
  select it.id as work_item_id, it.item_number, it.description, it.unit_code,
         it.payment_category,
         it.effective_rate::text as effective_rate,
         coalesce(ds.total, 0)::numeric(18,3)::text as delta_supplied,
         coalesce(di.total, 0)::numeric(18,3)::text as delta_installed,
         coalesce(dp.total, 0)::numeric(18,3)::text as delta_pac,
         coalesce(p.supplied, 0)::numeric(18,3)::text as prior_supplied,
         coalesce(p.installed, 0)::numeric(18,3)::text as prior_installed,
         coalesce(p.pac, 0)::numeric(18,3)::text as prior_pac,
         coalesce(p.final_bill, 0)::numeric(18,3)::text as prior_final_bill,
         coalesce(dv.total, 0)::numeric(18,3)::text as cumulative_delivered,
         coalesce(ins.total, 0)::numeric(18,3)::text as cumulative_installed,
         coalesce(crt.total, 0)::numeric(18,3)::text as cumulative_amc_certified
  from items it
  left join delta_supplied ds on ds.work_item_id = it.id
  left join delta_installed di on di.work_item_id = it.id
  left join delta_pac dp on dp.work_item_id = it.id
  left join prior p on p.work_item_id = it.id
  left join delivered dv on dv.work_item_id = it.id
  left join installed ins on ins.work_item_id = it.id
  left join certified crt on crt.work_item_id = it.id
  order by it.item_number
`;

/**
 * Loads every item's computation input for one MB: this MB's per-stage
 * deltas summed over its SELECTED sources, the true-cumulative prior
 * billed quantities (SUM of deltas over other FINALIZED MBs' lines —
 * cancelled MBs excluded), and the Work-lifetime
 * delivered/installed/certified aggregates for the final-bill base (an
 * AMC item earns its final bill on the certified quantity, being neither
 * delivered nor installed — migration 0068). All sums run in exact SQL
 * numeric arithmetic. The delta joins filter on the source's billable
 * status, so a dead claim (source cancelled while selected on a draft
 * in a write-skew race) contributes nothing to the preview; finalize
 * revalidates the locked sources, for which the filter is a no-op.
 */
export async function loadItemInputs(
  tx: TransactionSql,
  workId: string,
  bookId: string,
): Promise<MbItemInput[]> {
  const rows = (await tx.unsafe(ITEM_INPUTS_SQL, [
    workId,
    bookId,
  ])) as unknown as ItemInputRow[];
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    itemNumber: row.item_number,
    description: row.description,
    unitCode: row.unit_code,
    paymentCategory: row.payment_category as WorkItemPaymentCategory | null,
    effectiveRate: canonicalRateText(row.effective_rate),
    deltaSupplied: row.delta_supplied,
    deltaInstalled: row.delta_installed,
    deltaPac: row.delta_pac,
    priorSupplied: row.prior_supplied,
    priorInstalled: row.prior_installed,
    priorPac: row.prior_pac,
    priorFinalBill: row.prior_final_bill,
    cumulativeDelivered: row.cumulative_delivered,
    cumulativeInstalled: row.cumulative_installed,
    cumulativeAmcCertified: row.cumulative_amc_certified,
  }));
}

export async function computeForBook(
  tx: TransactionSql,
  book: { work_id: string; id: string; is_final: boolean },
): Promise<MbComputation> {
  const [matrix, items] = [
    await loadPaymentMatrix(tx, book.work_id),
    await loadItemInputs(tx, book.work_id, book.id),
  ];
  return computeMeasurementBook({ matrix, isFinal: book.is_final, items });
}

export function toLine(line: MbComputedLine): MeasurementBookLine {
  return {
    workItemId: line.workItemId,
    itemNumber: line.itemNumber,
    description: line.description,
    unitCode: line.unitCode,
    paymentCategory: line.paymentCategory,
    resolvedCategory: line.resolvedCategory,
    pctSupply: line.percentages.pctSupply,
    pctInstallation: line.percentages.pctInstallation,
    pctPac: line.percentages.pctPac,
    pctFinalBill: line.percentages.pctFinalBill,
    effectiveRate: line.effectiveRate,
    deltaSupplied: line.deltaSupplied,
    deltaInstalled: line.deltaInstalled,
    deltaPac: line.deltaPac,
    deltaFinalBill: line.deltaFinalBill,
    priorSupplied: line.priorSupplied,
    priorInstalled: line.priorInstalled,
    priorPac: line.priorPac,
    priorFinalBill: line.priorFinalBill,
    amountSupply: line.amountSupply,
    amountInstallation: line.amountInstallation,
    amountPac: line.amountPac,
    amountFinalBill: line.amountFinalBill,
    lineTotal: line.lineTotal,
    remark: line.remark,
  };
}

export interface StoredLineRow {
  work_item_id: string;
  item_number: string;
  description: string;
  unit_code: string;
  payment_category: string | null;
  resolved_category: string;
  pct_supply: string;
  pct_installation: string;
  pct_pac: string;
  pct_final_bill: string;
  effective_rate: string;
  delta_supplied: string;
  delta_installed: string;
  delta_pac: string;
  delta_final_bill: string;
  prior_supplied: string;
  prior_installed: string;
  prior_pac: string;
  prior_final_bill: string;
  amount_supply: string;
  amount_installation: string;
  amount_pac: string;
  amount_final_bill: string;
  line_total: string;
  remark: string;
}

export async function readStoredLines(
  tx: TransactionSql,
  bookId: string,
): Promise<MeasurementBookLine[]> {
  const rows = await tx<StoredLineRow[]>`
    select work_item_id, item_number, description, unit_code, payment_category,
           resolved_category,
           pct_supply::text as pct_supply,
           pct_installation::text as pct_installation,
           pct_pac::text as pct_pac,
           pct_final_bill::text as pct_final_bill,
           effective_rate::text as effective_rate,
           delta_supplied::text as delta_supplied,
           delta_installed::text as delta_installed,
           delta_pac::text as delta_pac,
           delta_final_bill::text as delta_final_bill,
           prior_supplied::text as prior_supplied,
           prior_installed::text as prior_installed,
           prior_pac::text as prior_pac,
           prior_final_bill::text as prior_final_bill,
           amount_supply::text as amount_supply,
           amount_installation::text as amount_installation,
           amount_pac::text as amount_pac,
           amount_final_bill::text as amount_final_bill,
           line_total::text as line_total,
           remark
    from measurement_book_lines
    where measurement_book_id = ${bookId}
    order by item_number
  `;
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    itemNumber: row.item_number,
    description: row.description,
    unitCode: row.unit_code,
    paymentCategory: row.payment_category as WorkItemPaymentCategory | null,
    resolvedCategory: row.resolved_category,
    pctSupply: row.pct_supply,
    pctInstallation: row.pct_installation,
    pctPac: row.pct_pac,
    pctFinalBill: row.pct_final_bill,
    effectiveRate: canonicalRateText(row.effective_rate),
    deltaSupplied: row.delta_supplied,
    deltaInstalled: row.delta_installed,
    deltaPac: row.delta_pac,
    deltaFinalBill: row.delta_final_bill,
    priorSupplied: row.prior_supplied,
    priorInstalled: row.prior_installed,
    priorPac: row.prior_pac,
    priorFinalBill: row.prior_final_bill,
    amountSupply: row.amount_supply,
    amountInstallation: row.amount_installation,
    amountPac: row.amount_pac,
    amountFinalBill: row.amount_final_bill,
    lineTotal: row.line_total,
    remark: row.remark,
  }));
}

/** Detail assembly: drafts COMPUTE the preview from live state;
 * finalized/cancelled MBs read their immutable lines. */
export async function readDetail(
  tx: TransactionSql,
  bookId: string,
): Promise<MeasurementBookDetailResponse> {
  const book = await readBook(tx, bookId);
  if (!book) {
    throw httpError(404, 'MEASUREMENT_BOOK_NOT_FOUND', 'No such Measurement Book.');
  }
  const sources = await readSources(tx, bookId);
  if (book.status === 'draft') {
    const computation = await computeForBook(tx, book);
    return {
      book: toBook(book),
      sources,
      lines: computation.lines.map(toLine),
      warnings: [...computation.unresolved],
      previewTotal: computation.totalAmount,
    };
  }
  return {
    book: toBook(book),
    sources,
    lines: await readStoredLines(tx, bookId),
    warnings: [],
    previewTotal: book.total_amount,
  };
}

// --- Source claim helpers ---------------------------------------------------

export const SOURCE_LABELS: Record<MbSourceType, string> = {
  delivery_challan: 'delivery challan',
  installation: 'installation',
  pac_certificate: 'PAC certificate',
};

/**
 * App half of R19 (shared with the challan/installation/PAC cancel
 * routes): refuses when the source is claimed by a LIVE (unreleased)
 * Measurement Book. The 0024 database guards backstop this against
 * every writer. The remedy branches on the holding MB's status: a
 * DRAFT holder has billed nothing and cannot be cancelled (drafts are
 * deleted), so the followable remedy is deselecting the source or
 * deleting the draft.
 */
export async function assertSourceNotBilled(
  tx: TransactionSql,
  sourceType: MbSourceType,
  sourceId: string,
): Promise<void> {
  const [claim] = await tx<
    { measurement_book_id: string; mb_number: string | null; status: string }[]
  >`
    select ms.measurement_book_id, mb.mb_number, mb.status
    from mb_sources ms
    join measurement_books mb on mb.id = ms.measurement_book_id
    where ms.source_type = ${sourceType} and ms.source_id = ${sourceId}
      and ms.released_at is null
  `;
  if (claim) {
    const details: MbSourceConflictDetails = {
      sourceType,
      sourceId,
      holdingMeasurementBookId: claim.measurement_book_id,
      holdingMbNumber: claim.mb_number,
    };
    const message =
      claim.status === 'draft'
        ? `This ${SOURCE_LABELS[sourceType]} is selected on draft Measurement Book ${claim.measurement_book_id}; remove it from the draft's source selection (or delete the draft) first.`
        : `This ${SOURCE_LABELS[sourceType]} is billed in Measurement Book ${claim.mb_number ?? claim.measurement_book_id}; cancel that Measurement Book first.`;
    throw httpError(409, 'SOURCE_BILLED_IN_MB', message, details);
  }
}

export interface SourceStateRow {
  id: string;
  status: string;
  label: string | null;
}

/** Loads (and optionally row-locks) the named sources of one type,
 * scoped to the Work. A source of another Work answers exactly like an
 * unknown id. */
export async function loadSourcesOfType(
  tx: TransactionSql,
  workId: string,
  sourceType: MbSourceType,
  ids: readonly string[],
  lock: boolean,
): Promise<Map<string, SourceStateRow>> {
  if (ids.length === 0) return new Map();
  let rows: SourceStateRow[];
  if (sourceType === 'delivery_challan') {
    rows = lock
      ? await tx<SourceStateRow[]>`
          select dc.id, dc.status, dc.challan_number as label
          from delivery_challans dc
          where dc.id = any(${ids as string[]}::uuid[]) and dc.work_id = ${workId}
          order by dc.id
          for update of dc
        `
      : await tx<SourceStateRow[]>`
          select dc.id, dc.status, dc.challan_number as label
          from delivery_challans dc
          where dc.id = any(${ids as string[]}::uuid[]) and dc.work_id = ${workId}
        `;
  } else if (sourceType === 'installation') {
    rows = lock
      ? await tx<SourceStateRow[]>`
          select i.id, i.status,
                 (select wi.item_number from work_items wi
                   where wi.id = i.work_item_id)
                   || ' x ' || i.quantity::text as label
          from installations i
          where i.id = any(${ids as string[]}::uuid[]) and i.work_id = ${workId}
          order by i.id
          for update of i
        `
      : await tx<SourceStateRow[]>`
          select i.id, i.status,
                 (select wi.item_number from work_items wi
                   where wi.id = i.work_item_id)
                   || ' x ' || i.quantity::text as label
          from installations i
          where i.id = any(${ids as string[]}::uuid[]) and i.work_id = ${workId}
        `;
  } else {
    rows = lock
      ? await tx<SourceStateRow[]>`
          select pc.id, pc.status, pc.reference as label
          from pac_certificates pc
          where pc.id = any(${ids as string[]}::uuid[]) and pc.work_id = ${workId}
          order by pc.id
          for update of pc
        `
      : await tx<SourceStateRow[]>`
          select pc.id, pc.status, pc.reference as label
          from pac_certificates pc
          where pc.id = any(${ids as string[]}::uuid[]) and pc.work_id = ${workId}
        `;
  }
  return new Map(rows.map((row) => [row.id, row]));
}

export const BILLABLE_STATE: Record<MbSourceType, string> = {
  delivery_challan: 'issued',
  installation: 'recorded',
  pac_certificate: 'recorded',
};

export function groupByType(
  sources: readonly MbSourceRef[],
): Record<MbSourceType, string[]> {
  const grouped: Record<MbSourceType, string[]> = {
    delivery_challan: [],
    installation: [],
    pac_certificate: [],
  };
  for (const source of sources) grouped[source.sourceType].push(source.sourceId);
  return grouped;
}

/**
 * Validates (and with `lock` row-locks, serialising against concurrent
 * source cancellation) every named source: it must exist in this Work
 * and be in its billable state. Returns the label map for messages.
 */
export async function validateSources(
  tx: TransactionSql,
  workId: string,
  sources: readonly MbSourceRef[],
  lock: boolean,
): Promise<Map<string, SourceStateRow>> {
  const grouped = groupByType(sources);
  const all = new Map<string, SourceStateRow>();
  for (const sourceType of Object.keys(grouped) as MbSourceType[]) {
    const loaded = await loadSourcesOfType(
      tx,
      workId,
      sourceType,
      grouped[sourceType],
      lock,
    );
    // First pass: existence within THIS Work (assertWorkAccess 404
    // discipline — a source of another Work or tenant answers exactly
    // like an unknown id).
    for (const id of grouped[sourceType]) {
      const row = loaded.get(id);
      if (!row) {
        throw httpError(
          404,
          'MB_SOURCE_NOT_FOUND',
          `No such ${SOURCE_LABELS[sourceType]} in this Work.`,
        );
      }
    }
    // Second pass: billable state (issued / recorded).
    for (const id of grouped[sourceType]) {
      const row = loaded.get(id);
      if (row && row.status !== BILLABLE_STATE[sourceType]) {
        throw httpError(
          409,
          'MB_SOURCE_NOT_BILLABLE',
          `${SOURCE_LABELS[sourceType]} ${row.label ?? id} is ${row.status}; only ${BILLABLE_STATE[sourceType]} sources are billable.`,
        );
      }
      if (row) all.set(`${sourceType}:${id}`, row);
    }
  }
  return all;
}

/** Friendly half of the one-live-MB-per-source rule: names every
 * requested source already claimed by ANOTHER live MB, with the holding
 * MB's number and id (the partial unique index decides races). */
export async function assertSourcesUnclaimed(
  tx: TransactionSql,
  bookId: string,
  sources: readonly MbSourceRef[],
): Promise<void> {
  if (sources.length === 0) return;
  const types = sources.map((source) => source.sourceType);
  const ids = sources.map((source) => source.sourceId);
  const claims = await tx<
    {
      source_type: MbSourceType;
      source_id: string;
      measurement_book_id: string;
      mb_number: string | null;
    }[]
  >`
    select ms.source_type, ms.source_id, ms.measurement_book_id, mb.mb_number
    from unnest(${types as string[]}::text[], ${ids}::uuid[]) as req(source_type, source_id)
    join mb_sources ms
      on ms.source_type = req.source_type and ms.source_id = req.source_id
      and ms.released_at is null
    join measurement_books mb on mb.id = ms.measurement_book_id
    where ms.measurement_book_id <> ${bookId}
  `;
  const [first] = claims;
  if (first) {
    const details: MbSourceConflictDetails = {
      sourceType: first.source_type,
      sourceId: first.source_id,
      holdingMeasurementBookId: first.measurement_book_id,
      holdingMbNumber: first.mb_number,
    };
    const message = claims
      .map(
        (claim) =>
          `${SOURCE_LABELS[claim.source_type]} ${claim.source_id} is claimed by Measurement Book ${claim.mb_number ?? claim.measurement_book_id}`,
      )
      .join('; ');
    throw httpError(
      409,
      'MB_SOURCE_ALREADY_BILLED',
      `A source can be billed by at most one live Measurement Book — ${message}.`,
      details,
    );
  }
}

/** Route-level completion of the claim race: a 23505 on the partial
 * unique index aborts the transaction before the holder is readable, so
 * the winning MB is looked up with a fresh read and the 409 rebuilt
 * with the structured details. */
export async function nameSourceConflict(
  error: unknown,
  database: Sql,
  organisationId: string,
  userId: string,
  bookId: string,
  sources: readonly MbSourceRef[],
): Promise<unknown> {
  const isUnnamed =
    error instanceof Error &&
    'statusCode' in error &&
    error.statusCode === 409 &&
    'code' in error &&
    error.code === 'MB_SOURCE_ALREADY_BILLED' &&
    !('details' in error && error.details !== undefined);
  if (!isUnnamed) return error;
  try {
    return await withBoundTenant(database, organisationId, userId, async (tx) => {
      await assertSourcesUnclaimed(tx, bookId, sources);
      return error;
    });
  } catch (named) {
    return named;
  }
}

// --- The MB document (phase 3) ----------------------------------------------

export interface BrandingRow {
  name: string;
  address: string | null;
  gstin: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  logo_object_key: string | null;
  logo_media_type: string | null;
}

export async function readBranding(
  tx: TransactionSql,
): Promise<BrandingRow | undefined> {
  const [organisation] = await tx<BrandingRow[]>`
    select name, address, gstin, contact_phone, contact_email,
           logo_object_key, logo_media_type
    from organisations
    where id = app_private.current_organisation_id()
  `;
  return organisation;
}

export interface WorkIdentityRow {
  work_code: string;
  title: string;
  letter_number: string;
  letter_date: string;
}

export async function readWorkIdentity(
  tx: TransactionSql,
  workId: string,
): Promise<WorkIdentityRow> {
  const [work] = await tx<WorkIdentityRow[]>`
    select work_code, title, letter_number, letter_date::text as letter_date
    from works where id = ${workId}
  `;
  if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  return work;
}

export function toSnapshot(
  book: BookRow,
  organisationName: string,
  work: WorkIdentityRow,
  lines: readonly MeasurementBookLine[],
  totalAmount: string,
  remarkTemplateVersion: string,
): MeasurementBookSnapshot {
  // Both callers gate on draft (preview) or finalized (render); a
  // merged record MB never becomes a document, and the snapshot type
  // says so.
  if (book.status === 'merged') {
    throw new Error('merged record Measurement Books render no document');
  }
  return {
    templateVersion: MB_TEMPLATE_VERSION,
    organisationName,
    status: book.status,
    mbNumber: book.mb_number,
    mbDate: book.mb_date,
    isFinal: book.is_final,
    work: {
      workCode: work.work_code,
      title: work.title,
      letterNumber: work.letter_number,
      letterDate: work.letter_date,
    },
    lines: lines.map((line) => ({
      itemNumber: line.itemNumber,
      description: line.description,
      unitCode: line.unitCode,
      deltaSupplied: line.deltaSupplied,
      deltaInstalled: line.deltaInstalled,
      deltaPac: line.deltaPac,
      lineTotal: line.lineTotal,
      remark: line.remark,
    })),
    totalAmount,
    remarkTemplateVersion,
  };
}

/** Branding is presentation, loaded from the organisation's current
 * profile at render time; a missing logo object must never block the
 * document (the challan render posture). */
export async function brandingWithLogo(
  storage: ObjectStorage,
  branding: BrandingRow | undefined,
  warn: (error: unknown) => void,
): Promise<MeasurementBookBranding> {
  let logoDataUri: string | undefined;
  if (branding?.logo_object_key && branding.logo_media_type) {
    try {
      const logo = await storage.get(branding.logo_object_key);
      logoDataUri = `data:${branding.logo_media_type};base64,${logo.toString('base64')}`;
    } catch (error) {
      warn(error);
    }
  }
  return {
    ...(logoDataUri !== undefined ? { logoDataUri } : {}),
    address: branding?.address ?? null,
    gstin: branding?.gstin ?? null,
    contactPhone: branding?.contact_phone ?? null,
    contactEmail: branding?.contact_email ?? null,
  };
}

/** HTML -> PDF through the shared hardened renderer; failures surface as
 * a clean 502 that leaves the Measurement Book untouched. */
export async function convertToPdf(
  gotenbergUrl: string,
  html: string,
  logError: (error: unknown) => void,
): Promise<Buffer> {
  return renderPdfViaGotenberg(gotenbergUrl, html, {
    failureMessage:
      'The PDF service is unavailable; the Measurement Book is unaffected — retry later.',
    logError,
  });
}
