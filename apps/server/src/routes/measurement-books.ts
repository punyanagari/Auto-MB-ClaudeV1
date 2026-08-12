import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  BillSchema,
  CancelMeasurementBookRequestSchema,
  CreateMeasurementBookRequestSchema,
  MeasurementBookDetailResponseSchema,
  MeasurementBookListResponseSchema,
  MergeMeasurementBooksRequestSchema,
  SetMbSourcesRequestSchema,
  type Bill,
  type MbFinalSweepDetails,
  type MbHasMergedRecordsDetails,
  type MbNotNewestDetails,
  type MbPercentagesUnresolvedDetails,
  type MbSourceConflictDetails,
  type MbSourceRef,
  type MbSourceType,
  type MeasurementBook,
  type MeasurementBookDetailResponse,
  type MeasurementBookKind,
  type MeasurementBookLine,
  type MeasurementBookSource,
  type WorkCompletionBlocker,
  type WorkItemPaymentCategory,
  type WorkNotCleanDetails,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireWriterRole } from '../authz.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import {
  computeMeasurementBook,
  type MbComputation,
  type MbComputedLine,
  type MbItemInput,
} from '../mb-compute.js';
import {
  MB_TEMPLATE_VERSION,
  renderMeasurementBookHtml,
  type MeasurementBookBranding,
  type MeasurementBookSnapshot,
} from '../mb-html.js';
import { MB_REMARK_TEMPLATE_VERSION } from '../mb-remark.js';
import { loadPaymentMatrix } from '../payment-matrix.js';
import { canonicalRateText } from '../rate-text.js';
import type { ObjectStorage } from '../storage.js';
import { withBoundTenant } from '../tenant-context.js';
import { assertWorkOperable } from '../work-status.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

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

interface BookRow {
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

function toBook(row: BookRow): MeasurementBook {
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

const BOOK_COLUMNS = `
  mb.id, mb.work_id, mb.status, mb.kind, mb.is_final,
  mb.consignee_contact_id, mb.merged_into_id, mb.mb_date::text as mb_date,
  mb.mb_number, mb.sequence_number, mb.total_amount::text as total_amount,
  mb.remark_template_version, mb.template_version, mb.rendered_object_key,
  mb.cancellation_note,
  (select b.id from bills b
    where b.mb_id = mb.id) as bill_id,
  mb.created_at, mb.finalized_at, mb.cancelled_at
`;

async function readBook(tx: TransactionSql, id: string): Promise<BookRow | undefined> {
  const rows = (await tx.unsafe(
    `select ${BOOK_COLUMNS} from measurement_books mb where mb.id = $1`,
    [id],
  )) as unknown as BookRow[];
  return rows[0];
}

/** The claimed sources with human labels: challan number, installation
 * summary, or PAC reference. */
async function readSources(
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

interface ItemInputRow {
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
}

/**
 * Loads every item's computation input for one MB: this MB's per-stage
 * deltas summed over its SELECTED sources, the true-cumulative prior
 * billed quantities (SUM of deltas over other FINALIZED MBs' lines —
 * cancelled MBs excluded), and the Work-lifetime delivered/installed
 * aggregates for the final-bill base. All sums run in exact SQL
 * numeric arithmetic. The delta joins filter on the source's billable
 * status, so a dead claim (source cancelled while selected on a draft
 * in a write-skew race) contributes nothing to the preview; finalize
 * revalidates the locked sources, for which the filter is a no-op.
 */
async function loadItemInputs(
  tx: TransactionSql,
  workId: string,
  bookId: string,
): Promise<MbItemInput[]> {
  const rows = await tx<ItemInputRow[]>`
    select wi.id as work_item_id, wi.item_number, wi.description, wi.unit_code,
           wi.payment_category,
           coalesce(wi.effective_unit_rate, wi.effective_rate)::text as effective_rate,
           delta_supplied.total::text as delta_supplied,
           delta_installed.total::text as delta_installed,
           delta_pac.total::text as delta_pac,
           prior.supplied::text as prior_supplied,
           prior.installed::text as prior_installed,
           prior.pac::text as prior_pac,
           prior.final_bill::text as prior_final_bill,
           delivered.total::text as cumulative_delivered,
           installed.total::text as cumulative_installed
    from work_items wi
    cross join lateral (
      select coalesce(sum(dci.quantity), 0)::numeric(18,3) as total
      from mb_sources ms
      join delivery_challans dc on dc.id = ms.source_id and dc.status = 'issued'
      join delivery_challan_items dci on dci.delivery_challan_id = ms.source_id
      where ms.measurement_book_id = ${bookId}
        and ms.source_type = 'delivery_challan'
        and dci.work_item_id = wi.id
    ) delta_supplied
    cross join lateral (
      select coalesce(sum(i.quantity), 0)::numeric(18,3) as total
      from mb_sources ms
      join installations i on i.id = ms.source_id and i.status = 'recorded'
      where ms.measurement_book_id = ${bookId}
        and ms.source_type = 'installation'
        and i.work_item_id = wi.id
    ) delta_installed
    cross join lateral (
      select coalesce(sum(pci.certified_quantity), 0)::numeric(18,3) as total
      from mb_sources ms
      join pac_certificates pc on pc.id = ms.source_id and pc.status = 'recorded'
      join pac_certificate_items pci on pci.pac_certificate_id = ms.source_id
      where ms.measurement_book_id = ${bookId}
        and ms.source_type = 'pac_certificate'
        and pci.work_item_id = wi.id
    ) delta_pac
    cross join lateral (
      select coalesce(sum(l.delta_supplied), 0)::numeric(18,3) as supplied,
             coalesce(sum(l.delta_installed), 0)::numeric(18,3) as installed,
             coalesce(sum(l.delta_pac), 0)::numeric(18,3) as pac,
             coalesce(sum(l.delta_final_bill), 0)::numeric(18,3) as final_bill
      from measurement_book_lines l
      join measurement_books pmb on pmb.id = l.measurement_book_id
      where l.work_item_id = wi.id
        and pmb.status = 'finalized'
        and pmb.id <> ${bookId}
    ) prior
    cross join lateral (
      select coalesce(sum(dci.quantity), 0)::numeric(18,3) as total
      from delivery_challan_items dci
      join delivery_challans dc on dc.id = dci.delivery_challan_id
      where dci.work_item_id = wi.id and dc.status = 'issued'
    ) delivered
    cross join lateral (
      select coalesce(sum(i.quantity), 0)::numeric(18,3) as total
      from installations i
      where i.work_item_id = wi.id and i.status = 'recorded'
    ) installed
    where wi.work_id = ${workId} and wi.deleted_at is null
    order by wi.item_number
  `;
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
  }));
}

async function computeForBook(
  tx: TransactionSql,
  book: { work_id: string; id: string; is_final: boolean },
): Promise<MbComputation> {
  const [matrix, items] = [
    await loadPaymentMatrix(tx, book.work_id),
    await loadItemInputs(tx, book.work_id, book.id),
  ];
  return computeMeasurementBook({ matrix, isFinal: book.is_final, items });
}

function toLine(line: MbComputedLine): MeasurementBookLine {
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

interface StoredLineRow {
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

async function readStoredLines(
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
async function readDetail(
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

const SOURCE_LABELS: Record<MbSourceType, string> = {
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

interface SourceStateRow {
  id: string;
  status: string;
  label: string | null;
}

/** Loads (and optionally row-locks) the named sources of one type,
 * scoped to the Work. A source of another Work answers exactly like an
 * unknown id. */
async function loadSourcesOfType(
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

const BILLABLE_STATE: Record<MbSourceType, string> = {
  delivery_challan: 'issued',
  installation: 'recorded',
  pac_certificate: 'recorded',
};

function groupByType(sources: readonly MbSourceRef[]): Record<MbSourceType, string[]> {
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
async function validateSources(
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
async function assertSourcesUnclaimed(
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
async function nameSourceConflict(
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

interface BrandingRow {
  name: string;
  address: string | null;
  gstin: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  logo_object_key: string | null;
  logo_media_type: string | null;
}

async function readBranding(tx: TransactionSql): Promise<BrandingRow | undefined> {
  const [organisation] = await tx<BrandingRow[]>`
    select name, address, gstin, contact_phone, contact_email,
           logo_object_key, logo_media_type
    from organisations
    where id = app_private.current_organisation_id()
  `;
  return organisation;
}

interface WorkIdentityRow {
  work_code: string;
  title: string;
  letter_number: string;
  letter_date: string;
}

async function readWorkIdentity(
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

function toSnapshot(
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
async function brandingWithLogo(
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

/** HTML -> PDF through Gotenberg; failures surface as a clean 502 that
 * leaves the Measurement Book untouched. */
async function convertToPdf(
  gotenbergUrl: string,
  html: string,
  logError: (error: unknown) => void,
): Promise<Buffer> {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  try {
    const response = await fetch(`${gotenbergUrl}/forms/chromium/convert/html`, {
      method: 'POST',
      body: form,
    });
    if (!response.ok) {
      throw new Error(`Gotenberg answered ${String(response.status)}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    logError(error);
    throw httpError(
      502,
      'RENDER_FAILED',
      'The PDF service is unavailable; the Measurement Book is unaffected — retry later.',
    );
  }
}

// --- Routes -----------------------------------------------------------------

export function registerMeasurementBookRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/measurement-books',
      schema: {
        params: IdParamsSchema,
        response: { 200: MeasurementBookListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const rows = (await tx.unsafe(
          `select ${BOOK_COLUMNS} from measurement_books mb
           where mb.work_id = $1
           order by mb.created_at desc, mb.id`,
          [workId],
        )) as unknown as BookRow[];
        return { books: rows.map(toBook) };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/measurement-books/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const book = await readBook(tx, id);
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/measurement-books',
      schema: {
        params: IdParamsSchema,
        body: CreateMeasurementBookRequestSchema,
        response: { 201: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      // `kind` is the request truth (0034); `isFinal` stays accepted as
      // the pre-0034 alias (true = final, false/absent = on_account). A
      // body naming both must agree with itself.
      if (
        body.kind !== undefined &&
        body.isFinal !== undefined &&
        body.isFinal !== (body.kind === 'final')
      ) {
        throw httpError(
          400,
          'MB_KIND_CONFLICT',
          `The request contradicts itself: kind '${body.kind}' with isFinal ${String(body.isFinal)}.`,
        );
      }
      const kind: MeasurementBookKind =
        body.kind ?? ((body.isFinal ?? false) ? 'final' : 'on_account');
      if (kind === 'record' && body.consigneeContactId === undefined) {
        throw httpError(
          400,
          'MB_CONSIGNEE_REQUIRED',
          'A record Measurement Book names the consignee filling it — consigneeContactId is required.',
        );
      }
      if (kind !== 'record' && body.consigneeContactId !== undefined) {
        throw httpError(
          400,
          'MB_CONSIGNEE_NOT_ALLOWED',
          'Only record Measurement Books name a consignee.',
        );
      }
      const detail = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<
          { status: string; letter_date: string; today: string }[]
        >`
            select w.status, w.letter_date::text as letter_date,
                   (now() at time zone o.timezone)::date::text as today
            from works w
            join organisations o on o.id = w.organisation_id
            where w.id = ${workId} and w.deleted_at is null
            for update of w
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        // R8: a completed Work accepts no new operational documents.
        // The works lock above pairs with the one POST
        // /api/works/:id/complete holds, so a draft MB can never appear
        // behind a completed Work's refusals; the 0031 insert guard
        // backstops it in the database.
        assertWorkOperable(work.status, 'raising a Measurement Book');
        // §5.9, friendly form (the 0024 trigger holds it against every
        // writer): MB date not in the future in the organisation's
        // timezone, not before the LOA letter date.
        if (body.mbDate > work.today) {
          throw httpError(
            400,
            'MB_DATE_FUTURE',
            `The MB date cannot be in the future (today is ${work.today}).`,
          );
        }
        if (body.mbDate < work.letter_date) {
          throw httpError(
            400,
            'MB_DATE_BEFORE_LOA',
            `The MB date cannot precede the LOA letter date ${work.letter_date}.`,
          );
        }
        // §5.9 register order: the MB register's dates must not run
        // backwards behind its gap-free, strictly increasing numbering.
        // MB-02's per-line remarks narrate 'previously billed X, now Y'
        // from the prior-cumulative memory, so an MB dated before its
        // predecessor prints a prior cumulative that, by its own date,
        // had not yet been measured — and the finalized snapshot is
        // immutable, so it can never be corrected. Equal dates pass:
        // several MBs on one day is normal. Checked here only: one
        // BILLING draft per Work (0034) means no MB can be finalized
        // between this draft's creation and its own finalize, so the
        // newest finalized date can only fall (by cancellation)
        // meanwhile, never rise. One indexed read —
        // measurement_books_work_idx already orders by (work_id,
        // status, mb_date desc). Record MBs are exempt: they never
        // take a number, never print the prior-cumulative narration,
        // and their sheet dates flow into nothing — the merged
        // on-account draft carries its own register-checked date.
        if (kind !== 'record') {
          const [newest] = await tx<{ mb_date: string; mb_number: string | null }[]>`
              select mb_date::text as mb_date, mb_number
              from measurement_books
              where work_id = ${workId} and status = 'finalized'
              order by mb_date desc
              limit 1
            `;
          if (newest && body.mbDate < newest.mb_date) {
            throw httpError(
              400,
              'MB_DATE_BEFORE_PREVIOUS',
              `The MB date cannot precede ${newest.mb_number ?? 'the previous Measurement Book'}, dated ${newest.mb_date}.`,
            );
          }
        }
        // A record MB names an ACTIVE consignee-role contact (the
        // 0034 FK holds existence; role and lifecycle are checked here
        // like every other contact picker).
        if (kind === 'record' && body.consigneeContactId !== undefined) {
          const [contact] = await tx<
            { id: string; is_consignee: boolean; active: boolean }[]
          >`
              select id, is_consignee, active from contacts
              where id = ${body.consigneeContactId}
            `;
          if (!contact) {
            throw httpError(404, 'CONTACT_NOT_FOUND', 'No such contact.');
          }
          if (!contact.is_consignee) {
            throw httpError(
              409,
              'CONTACT_NOT_CONSIGNEE',
              'A record Measurement Book is filled by a consignee contact; this contact does not carry the consignee role.',
            );
          }
          if (!contact.active) {
            throw httpError(
              409,
              'CONTACT_RETIRED',
              'This consignee is retired — reactivate it or pick another.',
            );
          }
        }
        // No further MBs once a live final MB exists (friendly form;
        // the 0024 insert guard holds it against every writer —
        // record sheets included: nothing they gather could ever be
        // billed past the final MB).
        const [finalBook] = await tx<{ id: string; mb_number: string | null }[]>`
            select id, mb_number from measurement_books
            where work_id = ${workId} and is_final and status <> 'cancelled'
          `;
        if (finalBook) {
          throw httpError(
            409,
            'FINAL_MB_EXISTS',
            `The final Measurement Book ${finalBook.mb_number ?? finalBook.id} closes this Work's payment cycle; no further Measurement Books can be raised.`,
          );
        }
        // The 0034 draft rules, friendly form (the two partial unique
        // indexes decide races; the catches rebuild the same 409s):
        // exactly one BILLING draft (on-account or final) per Work,
        // and one record draft per consignee — record sheets run in
        // parallel across consignees by design.
        if (kind === 'record') {
          const [existingRecord] = await tx<{ id: string }[]>`
              select id from measurement_books
              where work_id = ${workId} and status = 'draft' and kind = 'record'
                and consignee_contact_id = ${body.consigneeContactId ?? null}
            `;
          if (existingRecord) {
            throw draftConflictError(
              'MB_RECORD_DRAFT_EXISTS',
              'This consignee already has an open record Measurement Book on this Work; merge or delete it first.',
              existingRecord.id,
            );
          }
        } else {
          const [existingDraft] = await tx<{ id: string }[]>`
              select id from measurement_books
              where work_id = ${workId} and status = 'draft' and kind <> 'record'
            `;
          if (existingDraft) {
            throw draftConflictError(
              'MB_DRAFT_EXISTS',
              'This Work already has a draft Measurement Book; finalize or delete it first.',
              existingDraft.id,
            );
          }
        }
        // 0034 made is_final a GENERATED column: the insert names
        // `kind`, never is_final.
        const [row] = await tx<{ id: string }[]>`
            insert into measurement_books (
              organisation_id, work_id, mb_date, kind, consignee_contact_id,
              created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.mbDate}, ${kind},
              ${body.consigneeContactId ?? null}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              kind === 'record' ? 'MB_RECORD_DRAFT_EXISTS' : 'MB_DRAFT_EXISTS',
              kind === 'record'
                ? 'This consignee already has an open record Measurement Book on this Work; merge or delete it first.'
                : 'This Work already has a draft Measurement Book; finalize or delete it first.',
            );
          }
          throw error;
        });
        if (!row) throw new Error('measurement book insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.created',
          'measurement_books',
          row.id,
          {
            workId,
            mbDate: body.mbDate,
            kind,
            isFinal: kind === 'final',
            ...(kind === 'record'
              ? { consigneeContactId: body.consigneeContactId }
              : {}),
          },
        );
        return readDetail(tx, row.id);
      }).catch(async (error: unknown) => {
        const conflictCode =
          kind === 'record' ? 'MB_RECORD_DRAFT_EXISTS' : 'MB_DRAFT_EXISTS';
        throw await nameDraftConflict(error, conflictCode, async () => {
          return tenant(async (tx) => {
            const [draft] =
              kind === 'record'
                ? await tx<{ id: string }[]>`
                    select id from measurement_books
                    where work_id = ${workId} and status = 'draft'
                      and kind = 'record'
                      and consignee_contact_id = ${body.consigneeContactId ?? null}
                  `
                : await tx<{ id: string }[]>`
                    select id from measurement_books
                    where work_id = ${workId} and status = 'draft'
                      and kind <> 'record'
                  `;
            return draft?.id ?? null;
          });
        });
      });
      return reply.status(201).send(detail);
    },
  );

  // Merge: record drafts -> ONE new on-account draft (0034). The design
  // note, because the mechanics matter: mb_sources claims cannot be
  // released outside a cancel (the 0024 release guard), so the merge
  // does NOT move rows — it DELETES the records' claims (legal while
  // they are still drafts) and INSERTS fresh claims on the new target
  // in the same transaction. At every commit point each source has
  // exactly one live claim (the partial unique index never lapses);
  // provenance — which source came from which record — is written into
  // a constrained tenant table. Audit JSON stays human-readable evidence,
  // but operational un-merge never depends on its mutable shape.
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/measurement-books/merge',
      schema: {
        params: IdParamsSchema,
        body: MergeMeasurementBooksRequestSchema,
        response: { 201: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      if (new Set(body.recordMbIds).size !== body.recordMbIds.length) {
        throw httpError(
          400,
          'MB_MERGE_DUPLICATED',
          'The same record Measurement Book appears more than once.',
        );
      }
      const detail = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertWorkAccess(tx, user.id, workId);
        // The works lock serialises the merge against create, another
        // merge, finalize, and completion — the create-route lock
        // order (work first, then MB rows).
        const [work] = await tx<
          { status: string; letter_date: string; today: string }[]
        >`
            select w.status, w.letter_date::text as letter_date,
                   (now() at time zone o.timezone)::date::text as today
            from works w
            join organisations o on o.id = w.organisation_id
            where w.id = ${workId} and w.deleted_at is null
            for update of w
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'merging record Measurement Books');
        // The created draft is a BILLING draft: the full register-date
        // discipline of the create route applies to it.
        if (body.mbDate > work.today) {
          throw httpError(
            400,
            'MB_DATE_FUTURE',
            `The MB date cannot be in the future (today is ${work.today}).`,
          );
        }
        if (body.mbDate < work.letter_date) {
          throw httpError(
            400,
            'MB_DATE_BEFORE_LOA',
            `The MB date cannot precede the LOA letter date ${work.letter_date}.`,
          );
        }
        const [newest] = await tx<{ mb_date: string; mb_number: string | null }[]>`
            select mb_date::text as mb_date, mb_number
            from measurement_books
            where work_id = ${workId} and status = 'finalized'
            order by mb_date desc
            limit 1
          `;
        if (newest && body.mbDate < newest.mb_date) {
          throw httpError(
            400,
            'MB_DATE_BEFORE_PREVIOUS',
            `The MB date cannot precede ${newest.mb_number ?? 'the previous Measurement Book'}, dated ${newest.mb_date}.`,
          );
        }
        const [finalBook] = await tx<{ id: string; mb_number: string | null }[]>`
            select id, mb_number from measurement_books
            where work_id = ${workId} and is_final and status <> 'cancelled'
          `;
        if (finalBook) {
          throw httpError(
            409,
            'FINAL_MB_EXISTS',
            `The final Measurement Book ${finalBook.mb_number ?? finalBook.id} closes this Work's payment cycle; no further Measurement Books can be raised.`,
          );
        }
        // One billing draft per Work still applies to the draft the
        // merge creates; the friendly check names the open one.
        const [existingDraft] = await tx<{ id: string }[]>`
            select id from measurement_books
            where work_id = ${workId} and status = 'draft' and kind <> 'record'
          `;
        if (existingDraft) {
          throw draftConflictError(
            'MB_DRAFT_EXISTS',
            'This Work already has a draft Measurement Book; finalize or delete it before merging.',
            existingDraft.id,
          );
        }
        // Lock the named record MBs (id order — the un-merge locks
        // them the same way) and hold every one to the rule: a record
        // draft of THIS Work. Another Work's or tenant's MB answers
        // exactly like an unknown id.
        const records = await tx<
          {
            id: string;
            work_id: string;
            status: string;
            kind: string;
            consignee_contact_id: string | null;
          }[]
        >`
            select id, work_id, status, kind, consignee_contact_id
            from measurement_books
            where id = any(${body.recordMbIds}::uuid[])
            order by id
            for update
          `;
        const byId = new Map(records.map((row) => [row.id, row]));
        for (const recordId of body.recordMbIds) {
          const row = byId.get(recordId);
          if (!row || row.work_id !== workId) {
            throw httpError(
              404,
              'MEASUREMENT_BOOK_NOT_FOUND',
              'No such Measurement Book in this Work.',
            );
          }
          if (row.kind !== 'record' || row.status !== 'draft') {
            throw httpError(
              409,
              'MB_MERGE_NOT_RECORD_DRAFT',
              `Only record Measurement Book drafts merge — ${recordId} is a ${row.status} ${row.kind.replace('_', '-')} Measurement Book.`,
            );
          }
        }
        // Everything the records gathered, with its provenance. A
        // record draft's claims are always live (release needs a
        // cancel, and records never cancel), but the filter states
        // the invariant.
        const claims = await tx<
          {
            measurement_book_id: string;
            source_type: MbSourceType;
            source_id: string;
          }[]
        >`
            select measurement_book_id, source_type, source_id
            from mb_sources
            where measurement_book_id = any(${body.recordMbIds}::uuid[])
              and released_at is null
            order by measurement_book_id, source_type, source_id
          `;
        if (claims.length === 0) {
          throw httpError(
            409,
            'MB_MERGE_EMPTY',
            'There is nothing to merge — the record Measurement Books claim no sources.',
          );
        }
        // Row-lock the sources and revalidate their billable state
        // (the finalize discipline), serialising against the source
        // cancel routes.
        const refs = claims.map((claim) => ({
          sourceType: claim.source_type,
          sourceId: claim.source_id,
        }));
        await validateSources(tx, workId, refs, true);
        // The new on-account draft. The partial unique index decides
        // a billing-draft race; the insert guard backstops the final-
        // MB freeze.
        const [target] = await tx<{ id: string }[]>`
            insert into measurement_books (
              organisation_id, work_id, mb_date, kind, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.mbDate}, 'on_account',
              ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'MB_DRAFT_EXISTS',
              'This Work already has a draft Measurement Book; finalize or delete it before merging.',
            );
          }
          throw error;
        });
        if (!target) throw new Error('merge target insert returned no row');
        // Capture ownership while every claim still sits on its source
        // record. The insert guard can therefore prove exact provenance;
        // after the records become merged this ledger accepts no additions.
        for (const record of records) {
          const recordClaims = claims.filter(
            (claim) => claim.measurement_book_id === record.id,
          );
          if (recordClaims.length === 0) {
            await tx`
                insert into measurement_book_merge_provenance (
                  organisation_id, target_measurement_book_id,
                  record_measurement_book_id, work_id, source_type, source_id,
                  created_by_user_id
                ) values (
                  ${organisationId}, ${target.id}, ${record.id}, ${workId},
                  null, null, ${user.id}
                )
              `;
            continue;
          }
          for (const claim of recordClaims) {
            await tx`
                insert into measurement_book_merge_provenance (
                  organisation_id, target_measurement_book_id,
                  record_measurement_book_id, work_id, source_type, source_id,
                  created_by_user_id
                ) values (
                  ${organisationId}, ${target.id}, ${record.id}, ${workId},
                  ${claim.source_type}, ${claim.source_id}, ${user.id}
                )
              `;
          }
        }
        // The claim transfer: delete off the records (draft-time
        // claims delete cleanly, 0024), then claim the union on the
        // target. The union has no duplicates — the partial unique
        // index guarantees one live claim per source.
        await tx`
            delete from mb_sources
            where measurement_book_id = any(${body.recordMbIds}::uuid[])
          `;
        const types = claims.map((claim) => claim.source_type);
        const ids = claims.map((claim) => claim.source_id);
        await tx`
            insert into mb_sources (
              organisation_id, measurement_book_id, work_id, source_type, source_id
            )
            select ${organisationId}, ${target.id}, ${workId}, req.source_type,
                   req.source_id
            from unnest(${types as string[]}::text[], ${ids}::uuid[])
              as req(source_type, source_id)
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'MB_SOURCE_ALREADY_BILLED',
              'A source was claimed by another live Measurement Book while merging.',
            );
          }
          throw error;
        });
        // Mark the records merged, pointing at the draft that
        // absorbed them.
        await tx`
            update measurement_books
            set status = 'merged', merged_into_id = ${target.id}
            where id = any(${body.recordMbIds}::uuid[])
          `;
        // Keep the same rich audit evidence for investigators and export.
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.merged',
          'measurement_books',
          target.id,
          {
            workId,
            mbDate: body.mbDate,
            recordMbIds: records.map((row) => row.id),
            records: records.map((row) => ({
              recordMbId: row.id,
              consigneeContactId: row.consignee_contact_id,
              sources: claims
                .filter((claim) => claim.measurement_book_id === row.id)
                .map((claim) => ({
                  sourceType: claim.source_type,
                  sourceId: claim.source_id,
                })),
            })),
            sourceCount: claims.length,
          },
        );
        return readDetail(tx, target.id);
      }).catch(async (error: unknown) => {
        throw await nameDraftConflict(error, 'MB_DRAFT_EXISTS', async () => {
          return tenant(async (tx) => {
            const [draft] = await tx<{ id: string }[]>`
              select id from measurement_books
              where work_id = ${workId} and status = 'draft' and kind <> 'record'
            `;
            return draft?.id ?? null;
          });
        });
      });
      return reply.status(201).send(detail);
    },
  );

  // Un-merge: the ONLY way to take apart an on-account draft that
  // absorbed record MBs (DELETE answers MB_HAS_MERGED_RECORDS while any
  // exist). Restores each record MB to draft and re-claims, on each
  // record, exactly the sources the merge took from it — read back from
  // normalized merge provenance. Claims the operator added to the target
  // AFTER the merge are simply released with the deleted draft, like
  // any draft deletion. One live claim per source holds at every commit
  // point: the target's claims are deleted and the records' re-inserted
  // inside one transaction.
  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/unmerge',
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        const [book] = await tx<{ id: string; work_id: string; status: string }[]>`
          select id, work_id, status from measurement_books
          where id = ${id}
          for update
        `;
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.status !== 'draft') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            `Only a draft Measurement Book can be un-merged (current status: ${book.status}); once finalized, the merged records are billed for good.`,
          );
        }
        // The absorbed records, locked in id order (the merge's order).
        const absorbed = await tx<
          { id: string; consignee_contact_id: string | null }[]
        >`
          select id, consignee_contact_id from measurement_books
          where merged_into_id = ${id} and status = 'merged'
          order by id
          for update
        `;
        if (absorbed.length === 0) {
          throw httpError(
            409,
            'MB_NO_MERGED_RECORDS',
            'This Measurement Book absorbed no record Measurement Books; delete it instead.',
          );
        }
        // Operational restore state is normalized and constrained. Audit
        // JSON remains evidence only, so format drift cannot strand a merge.
        const provenanceRows = await tx<
          {
            record_measurement_book_id: string;
            source_type: MbSourceType | null;
            source_id: string | null;
          }[]
        >`
          select record_measurement_book_id, source_type, source_id
          from measurement_book_merge_provenance
          where target_measurement_book_id = ${id}
          order by record_measurement_book_id, source_type nulls first, source_id
        `;
        const provenance = new Map<string, MbSourceRef[]>();
        for (const row of provenanceRows) {
          const sources = provenance.get(row.record_measurement_book_id) ?? [];
          if (row.source_type !== null && row.source_id !== null) {
            sources.push({ sourceType: row.source_type, sourceId: row.source_id });
          }
          provenance.set(row.record_measurement_book_id, sources);
        }
        for (const record of absorbed) {
          if (!provenance.has(record.id)) {
            // The merge writes provenance in the same transaction that
            // marks the records, so a hole is corruption, not user error.
            throw new Error(
              `merge provenance for record Measurement Book ${record.id} is missing`,
            );
          }
        }
        // A record draft slot may have been re-occupied since the merge
        // (same Work, same consignee): name it before the index does.
        const [occupied] = await tx<
          { id: string; consignee_contact_id: string | null }[]
        >`
          select id, consignee_contact_id from measurement_books
          where work_id = ${book.work_id} and status = 'draft'
            and kind = 'record'
            and consignee_contact_id = any(${absorbed
              .map((record) => record.consignee_contact_id)
              .filter((value): value is string => value !== null)}::uuid[])
          limit 1
        `;
        if (occupied) {
          throw draftConflictError(
            'MB_RECORD_DRAFT_EXISTS',
            'A newer record Measurement Book draft exists for one of the merged consignees; merge or delete it first.',
            occupied.id,
          );
        }
        // Restore the records to draft. merged_into_id clears in the
        // same statement (the 0034 merged-shape CHECK holds them
        // together); the per-consignee index decides any remaining
        // race.
        await tx`
          update measurement_books
          set status = 'draft', merged_into_id = null
          where merged_into_id = ${id} and status = 'merged'
        `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'MB_RECORD_DRAFT_EXISTS',
              'A newer record Measurement Book draft exists for one of the merged consignees; merge or delete it first.',
            );
          }
          throw error;
        });
        // Release everything the target claims by deleting its rows
        // (draft-deletion semantics), then re-claim each transferred
        // source on the record it came from. Row-locking the sources
        // revalidates billable state and serialises against cancels —
        // a source deselected from the target after the merge could
        // have moved on, and answers a clean 409 here.
        const restored: MbSourceRef[] = absorbed.flatMap(
          (record) => provenance.get(record.id) ?? [],
        );
        // ACCEPTED DEAD END. This validation is all-or-nothing over the
        // provenance set, and the provenance set is fixed at merge time,
        // so one sequence puts un-merge permanently out of reach: deselect
        // a transferred source from the target (PUT /sources releases its
        // mb_sources claim while its provenance row stays), then cancel
        // that now-unclaimed source document. From then on validateSources
        // answers 409 MB_SOURCE_NOT_BILLABLE on every un-merge attempt,
        // and there is no way back:
        //   - the merged records cannot be cancelled or deleted (both
        //     refuse with MB_STATUS_CONFLICT, pointing at un-merge);
        //   - the target draft cannot be deleted while they point at it
        //     (MB_HAS_MERGED_RECORDS, backed by the 0034 RESTRICT FK);
        //   - un-merge itself is the blocked operation.
        // The operator's ONLY exit is to finalise the target, after which
        // the records stay merged and billed for good (the un-merge route
        // refuses a non-draft book above with exactly that explanation).
        //
        // This is deliberate, not an oversight. A partial restore would
        // silently drop billable work from the record MB it belonged to,
        // and restoring the claim anyway would leave a live Measurement
        // Book claiming a cancelled document. Finalising the target bills
        // the work that is still live and closes the merge honestly, which
        // is the correct answer to "a source I merged has since been
        // cancelled". If this ever needs an operator-facing escape, it
        // belongs in a route that re-derives provenance from the
        // still-billable subset with its own audit trail, not in a
        // loosened check here.
        await validateSources(tx, book.work_id, restored, true);
        await tx`delete from mb_sources where measurement_book_id = ${id}`;
        for (const record of absorbed) {
          const sources = provenance.get(record.id) ?? [];
          if (sources.length === 0) continue;
          const types = sources.map((source) => source.sourceType);
          const ids = sources.map((source) => source.sourceId);
          await tx`
            insert into mb_sources (
              organisation_id, measurement_book_id, work_id, source_type, source_id
            )
            select ${organisationId}, ${record.id}, ${book.work_id},
                   req.source_type, req.source_id
            from unnest(${types as string[]}::text[], ${ids}::uuid[])
              as req(source_type, source_id)
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'MB_SOURCE_ALREADY_BILLED',
                'A transferred source is claimed by another live Measurement Book; resolve that claim first.',
              );
            }
            throw error;
          });
        }
        // The emptied target draft goes, like any deleted draft.
        await tx`delete from measurement_books where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.unmerged',
          'measurement_books',
          id,
          {
            workId: book.work_id,
            recordMbIds: absorbed.map((record) => record.id),
            restoredSourceCount: restored.length,
          },
        );
      });
      return reply.status(204).send(null);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/measurement-books/:id/sources',
      schema: {
        params: IdParamsSchema,
        body: SetMbSourcesRequestSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const keys = body.sources.map((s) => `${s.sourceType}:${s.sourceId}`);
      if (new Set(keys).size !== keys.length) {
        throw httpError(
          400,
          'MB_SOURCES_DUPLICATED',
          'The same source appears more than once in the selection.',
        );
      }
      return tenant(async (tx) => {
        // The MB row lock serialises selection edits against finalize,
        // delete, and concurrent selection replacements.
        const [book] = await tx<{ id: string; work_id: string; status: string }[]>`
          select id, work_id, status from measurement_books
          where id = ${id}
          for update
        `;
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.status !== 'draft') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            'Sources are selected while the Measurement Book is draft.',
          );
        }
        // lock=true: row-locking the selected sources serialises the
        // selection against the source cancel routes' FOR UPDATE locks
        // (same single-type lock order finalize uses), closing the
        // write-skew where a source is cancelled and claimed at once.
        await validateSources(tx, book.work_id, body.sources, true);
        await assertSourcesUnclaimed(tx, id, body.sources);
        await tx`
          delete from mb_sources where measurement_book_id = ${id}
        `;
        if (body.sources.length > 0) {
          const types = body.sources.map((s) => s.sourceType);
          const ids = body.sources.map((s) => s.sourceId);
          await tx`
            insert into mb_sources (
              organisation_id, measurement_book_id, work_id, source_type, source_id
            )
            select ${organisationId}, ${id}, ${book.work_id}, req.source_type,
                   req.source_id
            from unnest(${types as string[]}::text[], ${ids}::uuid[])
              as req(source_type, source_id)
          `.catch((error: unknown) => {
            // The partial unique index decided a claim race against
            // another live MB; the route-level catch names the holder.
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'MB_SOURCE_ALREADY_BILLED',
                'A source in this selection was just claimed by another live Measurement Book.',
              );
            }
            throw error;
          });
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.sources_updated',
          'measurement_books',
          id,
          {
            workId: book.work_id,
            sources: body.sources.map((s) => ({
              sourceType: s.sourceType,
              sourceId: s.sourceId,
            })),
            count: body.sources.length,
          },
        );
        return readDetail(tx, id);
      }).catch(async (error: unknown) => {
        throw await nameSourceConflict(
          error,
          database,
          organisationId,
          user.id,
          id,
          body.sources,
        );
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/finalize',
      schema: {
        params: IdParamsSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        // Finalizing assigns a legal number and freezes a financial
        // snapshot: issue authority required, like bill preparation.
        const [book] = await tx<
          {
            id: string;
            work_id: string;
            status: string;
            kind: MeasurementBookKind;
            is_final: boolean;
          }[]
        >`
          select id, work_id, status, kind, is_final from measurement_books
          where id = ${id}
          for update
        `;
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        // A record MB is one consignee's parallel sheet — it never
        // takes a number and never bills (the 0034 status coherence
        // holds it in the database). Everything it gathers flows onward
        // through the merge.
        if (book.kind === 'record') {
          throw httpError(
            409,
            'MB_RECORD_NOT_BILLABLE',
            'Record Measurement Books are never finalized — merge them into an on-account Measurement Book and finalize that.',
          );
        }
        if (book.status !== 'draft') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            `Only draft Measurement Books can be finalized (current status: ${book.status}).`,
          );
        }
        // The Work row lock serialises numbering AND the prior-
        // cumulative reads against every other finalize on this Work.
        const [work] = await tx<{ id: string; work_code: string }[]>`
          select id, work_code from works
          where id = ${book.work_id} and deleted_at is null
          for update
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        // Row-lock every selected source and revalidate its billable
        // state from live rows: a source cancelled between draft and
        // finalize surfaces here as a clean 409, never a broken write.
        const claimed = await tx<{ source_type: MbSourceType; source_id: string }[]>`
          select source_type, source_id from mb_sources
          where measurement_book_id = ${id}
          order by source_type, source_id
        `;
        await validateSources(
          tx,
          book.work_id,
          claimed.map((claim) => ({
            sourceType: claim.source_type,
            sourceId: claim.source_id,
          })),
          true,
        );

        // The final MB must sweep EVERY remaining open billable source
        // of the Work (spec §5.9). Open = billable state and no live
        // claim by any MB; this draft's own claims are already live.
        if (book.is_final) {
          // The adopted CLEAN-STATE rule, one layer over from Work
          // completion (completionBlockers in work-completion.ts): a
          // draft delivery or issue challan is invisible to the sweep
          // below, which only sees sources already in their billable
          // state. Finalizing over it strands it forever — the 0031
          // guard refuses its issue for as long as a live final MB
          // exists, so it can never become evidence, never reach the
          // ledger, and nothing tells the operator why. So refuse, and
          // name every one. Note the remedy: 'issue it instead' is NOT
          // available while this book exists, because that same guard
          // counts a DRAFT final MB as live — the drafts are deleted, or
          // this book is deleted first and raised again after they are
          // issued. The Work row lock above serialises the check against
          // a concurrent issue attempt on the same draft.
          const openDrafts = await tx<
            { kind: WorkCompletionBlocker['kind']; record_id: string; label: string }[]
          >`
            select 'draft_delivery_challan' as kind, dc.id as record_id,
                   'Draft delivery challan dated ' || dc.challan_date::text as label
            from delivery_challans dc
            where dc.work_id = ${book.work_id} and dc.status = 'draft'
            union all
            select 'draft_issue_challan', ic.id,
                   'Draft issue challan dated ' || ic.challan_date::text
            from issue_challans ic
            where ic.work_id = ${book.work_id} and ic.status = 'draft'
            order by 1, 3
          `;
          if (openDrafts.length > 0) {
            // Same details shape the Work-completion 409 answers with,
            // so a client renders one worklist for both refusals.
            const details: WorkNotCleanDetails = {
              blockers: openDrafts.map((row) => ({
                kind: row.kind,
                recordId: row.record_id,
                label: row.label,
              })),
            };
            const names = openDrafts.map((row) => row.label).join('; ');
            throw httpError(
              409,
              'MB_FINAL_DRAFTS_OPEN',
              `The final Measurement Book closes this Work's payment cycle, so nothing may still be open — ${names}. Delete each draft, or delete this Measurement Book, issue them, and raise the final Measurement Book again so the sweep picks them up.`,
              details,
            );
          }

          const missed = await tx<
            { source_type: MbSourceType; source_id: string; label: string | null }[]
          >`
            select 'delivery_challan' as source_type, dc.id as source_id,
                   dc.challan_number as label
            from delivery_challans dc
            where dc.work_id = ${book.work_id} and dc.status = 'issued'
              and not exists (
                select 1 from mb_sources ms
                where ms.source_type = 'delivery_challan' and ms.source_id = dc.id
                  and ms.released_at is null
              )
            union all
            select 'installation', i.id,
                   (select wi.item_number from work_items wi
                     where wi.id = i.work_item_id) || ' x ' || i.quantity::text
            from installations i
            where i.work_id = ${book.work_id} and i.status = 'recorded'
              and not exists (
                select 1 from mb_sources ms
                where ms.source_type = 'installation' and ms.source_id = i.id
                  and ms.released_at is null
              )
            union all
            select 'pac_certificate', pc.id, pc.reference
            from pac_certificates pc
            where pc.work_id = ${book.work_id} and pc.status = 'recorded'
              and not exists (
                select 1 from mb_sources ms
                where ms.source_type = 'pac_certificate' and ms.source_id = pc.id
                  and ms.released_at is null
              )
            order by 1, 3
          `;
          if (missed.length > 0) {
            const details: MbFinalSweepDetails = {
              missedSources: missed.map((row) => ({
                sourceType: row.source_type,
                sourceId: row.source_id,
                label: row.label ?? row.source_id,
              })),
            };
            const names = missed
              .map(
                (row) =>
                  `${SOURCE_LABELS[row.source_type]} ${row.label ?? row.source_id}`,
              )
              .join('; ');
            throw httpError(
              409,
              'MB_FINAL_SWEEP_INCOMPLETE',
              `The final Measurement Book must sweep every open source of the Work — missing: ${names}.`,
              details,
            );
          }
        }

        // Recompute everything from live state under the locks.
        const computation = await computeForBook(tx, book);
        if (computation.unresolved.length > 0) {
          const details: MbPercentagesUnresolvedDetails = {
            items: [...computation.unresolved],
          };
          const names = computation.unresolved
            .map((item) => `${item.itemNumber} (missing ${item.missingCategory} row)`)
            .join('; ');
          throw httpError(
            409,
            'MB_PERCENTAGES_UNRESOLVED',
            `The payment matrix cannot price every item on this Measurement Book — ${names}. Add the missing matrix rows and retry.`,
            details,
          );
        }
        if (computation.lines.length === 0) {
          throw httpError(
            409,
            'MB_EMPTY',
            'This Measurement Book has nothing to bill — select sources with unbilled quantities first.',
          );
        }

        // Gapless <work_code>-MB-NN under the counter row lock (0014
        // mechanics): concurrent finalizes serialise here; rollback
        // rolls the number back with the transaction.
        const [counter] = await tx<{ next_value: number }[]>`
          insert into measurement_book_counters (organisation_id, work_id)
          values (${organisationId}, ${book.work_id})
          on conflict (organisation_id, work_id)
          do update set next_value = measurement_book_counters.next_value + 1,
                        updated_at = now()
          returning next_value
        `;
        if (!counter)
          throw new Error('measurement book counter upsert returned no row');
        const sequence = counter.next_value;
        const mbNumber = `${work.work_code}-MB-${String(sequence).padStart(2, '0')}`;

        // Snapshot the lines while the book is still draft (the line
        // guard requires it), then stamp the finalized shape.
        for (const line of computation.lines) {
          await tx`
            insert into measurement_book_lines (
              organisation_id, measurement_book_id, work_id, work_item_id,
              item_number, description, unit_code, payment_category,
              resolved_category, pct_supply, pct_installation, pct_pac,
              pct_final_bill, effective_rate,
              delta_supplied, delta_installed, delta_pac, delta_final_bill,
              prior_supplied, prior_installed, prior_pac, prior_final_bill,
              amount_supply, amount_installation, amount_pac, amount_final_bill,
              line_total, remark
            )
            values (
              ${organisationId}, ${id}, ${book.work_id}, ${line.workItemId},
              ${line.itemNumber}, ${line.description}, ${line.unitCode},
              ${line.paymentCategory}, ${line.resolvedCategory},
              ${line.percentages.pctSupply}, ${line.percentages.pctInstallation},
              ${line.percentages.pctPac}, ${line.percentages.pctFinalBill},
              ${line.effectiveRate},
              ${line.deltaSupplied}, ${line.deltaInstalled}, ${line.deltaPac},
              ${line.deltaFinalBill},
              ${line.priorSupplied}, ${line.priorInstalled}, ${line.priorPac},
              ${line.priorFinalBill},
              ${line.amountSupply}, ${line.amountInstallation}, ${line.amountPac},
              ${line.amountFinalBill},
              ${line.lineTotal}, ${line.remark}
            )
          `;
        }
        await tx`
          update measurement_books
          set status = 'finalized', mb_number = ${mbNumber},
              sequence_number = ${sequence},
              total_amount = ${computation.totalAmount},
              remark_template_version = ${MB_REMARK_TEMPLATE_VERSION},
              finalized_by_user_id = ${user.id}, finalized_at = now()
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.finalized',
          'measurement_books',
          id,
          {
            before: { status: 'draft' },
            after: { status: 'finalized' },
            workId: book.work_id,
            mbNumber,
            sequence,
            totalAmount: computation.totalAmount,
            isFinal: book.is_final,
            lineCount: computation.lines.length,
            remarkTemplateVersion: MB_REMARK_TEMPLATE_VERSION,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelMeasurementBookRequestSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const [book] = await tx<
          {
            id: string;
            work_id: string;
            status: string;
            sequence_number: number | null;
            mb_number: string | null;
          }[]
        >`
          select id, work_id, status, sequence_number, mb_number
          from measurement_books
          where id = ${id}
          for update
        `;
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.status === 'draft') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            'Draft Measurement Books are deleted, not cancelled.',
          );
        }
        // A merged record has no life of its own to cancel: its sources
        // moved into the on-account draft that absorbed it (0034 status
        // coherence — records only draft or merge).
        if (book.status === 'merged') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            'Merged record Measurement Books are not cancelled — un-merge the Measurement Book that absorbed them instead.',
          );
        }
        if (book.status === 'cancelled') {
          throw httpError(
            409,
            'MB_ALREADY_CANCELLED',
            'This Measurement Book is already cancelled.',
          );
        }
        // The Work row lock serialises cancel against a concurrent
        // finalize of the same Work's draft (finalize holds this lock
        // for its prior-cumulative reads and numbering). Lock order
        // matches finalize — own MB row first, then the works row — so
        // the two transactions cannot deadlock, and the newest/billed
        // checks below always run against committed finalize state.
        // The 0027 guard_measurement_book_update backstops both checks
        // in the database against every writer.
        const [workRow] = await tx<{ id: string; status: string }[]>`
          select id, status from works
          where id = ${book.work_id} and deleted_at is null
          for update
        `;
        if (!workRow) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        // R8: a completed Work's measurement record is frozen — releasing
        // this book's sources would reopen quantities the completion was
        // measured against. The works lock above serialises this against
        // completion, and the 0032 Measurement Book update guard backstops
        // the refusal in the database.
        assertWorkOperable(workRow.status, 'cancelling a Measurement Book');
        // Only the newest live MB may be cancelled (deltas must stay
        // coherent, spec §5.9).
        const [newer] = await tx<{ id: string; mb_number: string | null }[]>`
          select id, mb_number from measurement_books
          where work_id = ${book.work_id} and status = 'finalized'
            and sequence_number > ${book.sequence_number ?? 0}
          order by sequence_number desc
          limit 1
        `;
        if (newer) {
          const details: MbNotNewestDetails = {
            newerMeasurementBookId: newer.id,
            newerMbNumber: newer.mb_number,
          };
          throw httpError(
            409,
            'MB_NOT_NEWEST',
            `Only the newest live Measurement Book may be cancelled — cancel ${newer.mb_number ?? newer.id} first.`,
            details,
          );
        }
        // A billed MB is permanently locked (ADR-0006 decision 3: bills
        // cannot be cancelled, so corrections happen as compensating
        // entries on a subsequent MB).
        const [bill] = await tx<{ id: string; bill_number: number }[]>`
          select id, bill_number from bills where mb_id = ${id}
        `;
        if (bill) {
          throw httpError(
            409,
            'MB_BILLED',
            `Bill #${String(bill.bill_number)} was prepared from this Measurement Book; billed Measurement Books cannot be cancelled — correct with compensating entries on the next MB.`,
          );
        }
        await tx`
          update measurement_books
          set status = 'cancelled', cancellation_note = ${body.note},
              cancelled_by_user_id = ${user.id}, cancelled_at = now()
          where id = ${id}
        `;
        // Cancelling releases the sources for a corrected MB: the
        // claims stay as history with released_at stamped, and the
        // partial unique index frees the slots immediately.
        const released = await tx<{ id: string }[]>`
          update mb_sources
          set released_at = now()
          where measurement_book_id = ${id} and released_at is null
          returning id
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.cancelled',
          'measurement_books',
          id,
          {
            before: { status: 'finalized' },
            after: { status: 'cancelled' },
            workId: book.work_id,
            mbNumber: book.mb_number,
            note: body.note,
            releasedSourceCount: released.length,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/measurement-books/:id',
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        const [book] = await tx<{ id: string; work_id: string; status: string }[]>`
          select id, work_id, status from measurement_books
          where id = ${id}
          for update
        `;
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.status !== 'draft') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            book.status === 'merged'
              ? 'Merged record Measurement Books are not deleted — un-merge the Measurement Book that absorbed them instead.'
              : 'Only draft Measurement Books can be deleted; finalized ones cancel with a note.',
          );
        }
        // A draft that absorbed record MBs cannot simply vanish: the
        // records point at it (0034 RESTRICT FK) and their sources live
        // on it. The un-merge endpoint is the one honest way to take it
        // apart — it puts the records back first.
        const merged = await tx<{ id: string }[]>`
          select id from measurement_books
          where merged_into_id = ${id} and status = 'merged'
          order by id
        `;
        if (merged.length > 0) {
          const details: MbHasMergedRecordsDetails = {
            recordMbIds: merged.map((row) => row.id),
          };
          throw httpError(
            409,
            'MB_HAS_MERGED_RECORDS',
            'This Measurement Book absorbed record Measurement Books; un-merge it instead so the records and their sources are restored.',
            details,
          );
        }
        // Deleting the draft removes its claims entirely — the sources
        // return to the open pool with no residue.
        await tx`delete from mb_sources where measurement_book_id = ${id}`;
        await tx`delete from measurement_books where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.deleted',
          'measurement_books',
          id,
          {
            workId: book.work_id,
          },
        );
      });
      return reply.status(204).send(null);
    },
  );

  // Bill preparation FROM a finalized, un-billed Measurement Book
  // (ADR-0006 decision 2; replaces the Milestone 5 sweep of unbilled
  // mb_entries). Amount = the MB's snapshotted total; lines_snapshot
  // carries the MB's lines verbatim; bills.mb_id links 1:1.
  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/bill',
      schema: {
        params: IdParamsSchema,
        response: { 201: BillSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const bill = await tenant(async (tx) => {
        // Preparing a bill is a financial act: issue authority
        // required (Milestone 5 gate, unchanged).
        const [book] = await tx<
          {
            id: string;
            work_id: string;
            status: string;
            mb_number: string | null;
            total_amount: string | null;
          }[]
        >`
            select id, work_id, status, mb_number, total_amount::text as total_amount
            from measurement_books
            where id = ${id}
            for update
          `;
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.status !== 'finalized') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            `Bills are prepared from finalized Measurement Books (current status: ${book.status}).`,
          );
        }
        const [existing] = await tx<{ id: string; bill_number: number }[]>`
            select id, bill_number from bills where mb_id = ${id}
          `;
        if (existing) {
          throw httpError(
            409,
            'MB_ALREADY_BILLED',
            `Bill #${String(existing.bill_number)} was already prepared from this Measurement Book.`,
          );
        }

        // The counter row lock serialises concurrent bill preparation
        // for the Work (0006 mechanics, unchanged).
        const [counter] = await tx<{ next_value: number }[]>`
            insert into bill_counters (organisation_id, work_id)
            values (${organisationId}, ${book.work_id})
            on conflict (organisation_id, work_id)
            do update set next_value = bill_counters.next_value + 1,
                          updated_at = now()
            returning next_value
          `;
        if (!counter) throw new Error('bill counter upsert returned no row');

        const lines = await readStoredLines(tx, id);
        const [row] = await tx<
          {
            id: string;
            work_id: string;
            bill_number: number;
            status: Bill['status'];
            lines_snapshot: unknown;
            total_amount: string;
            mb_id: string | null;
            created_at: Date;
            submitted_at: Date | null;
            paid_at: Date | null;
          }[]
        >`
            insert into bills (
              organisation_id, work_id, bill_number, lines_snapshot,
              total_amount, prepared_by_user_id, mb_id
            )
            values (
              ${organisationId}, ${book.work_id}, ${counter.next_value},
              ${jsonb(tx, lines)}, ${book.total_amount},
              ${user.id}, ${id}
            )
            returning id, work_id, bill_number, status, lines_snapshot,
                      total_amount::text as total_amount, mb_id, created_at,
                      submitted_at, paid_at
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'MB_ALREADY_BILLED',
              'A bill was already prepared from this Measurement Book.',
            );
          }
          throw error;
        });
        if (!row) throw new Error('bill insert returned no row');
        await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, entity_id,
              details
            )
            values (
              ${organisationId}, ${user.id}, 'bill.prepared', 'bills', ${row.id},
              ${jsonb(tx, {
                billNumber: row.bill_number,
                totalAmount: row.total_amount,
                measurementBookId: id,
                mbNumber: book.mb_number,
                lineCount: lines.length,
              })}
            )
          `;
        return {
          id: row.id,
          workId: row.work_id,
          billNumber: row.bill_number,
          status: row.status,
          totalAmount: row.total_amount,
          linesSnapshot: parseJsonbColumn(row.lines_snapshot),
          createdAt: row.created_at.toISOString(),
          submittedAt: row.submitted_at?.toISOString() ?? null,
          paidAt: row.paid_at?.toISOString() ?? null,
          mbId: row.mb_id,
        } satisfies Bill;
      });
      return reply.status(201).send(bill);
    },
  );

  // The MB document (phase 3; spec §5.9 "MB document (PDF)"). A
  // FINALIZED MB renders from its IMMUTABLE stored lines to a
  // persisted, content-addressed PDF: object key + SHA-256 +
  // template_version recorded on the row, audit trail appended. The
  // snapshot read and the PDF write live in separate transactions so
  // the slow external call holds no database locks; the final write
  // re-checks the status so a race against cancel discards the orphan
  // render instead of stamping it (the challan render discipline).
  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/render',
      schema: {
        params: IdParamsSchema,
        response: {
          200: MeasurementBookDetailResponseSchema,
          ...errorResponses,
          502: ApiErrorSchema,
        },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;

      const { snapshot, branding } = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        const book = await readBook(tx, id);
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.status !== 'finalized') {
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            `Only finalized Measurement Books render to a persisted PDF (current status: ${book.status}); drafts stream a live preview instead.`,
          );
        }
        const work = await readWorkIdentity(tx, book.work_id);
        const lines = await readStoredLines(tx, id);
        const organisation = await readBranding(tx);
        return {
          snapshot: toSnapshot(
            book,
            organisation?.name ?? '',
            work,
            lines,
            book.total_amount ?? '0.00',
            book.remark_template_version ?? MB_REMARK_TEMPLATE_VERSION,
          ),
          branding: organisation,
        };
      });

      const html = renderMeasurementBookHtml(
        snapshot,
        await brandingWithLogo(storage, branding, (error) => {
          request.log.warn({ err: error }, 'measurement book render: logo unavailable');
        }),
      );
      const pdf = await convertToPdf(gotenbergUrl, html, (error) => {
        request.log.error({ err: error }, 'measurement book render failed');
      });
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/mb/${id}.pdf`;
      await storage.put(objectKey, pdf);

      return tenant(async (tx) => {
        const updated = await tx`
          update measurement_books
          set rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256},
              template_version = ${MB_TEMPLATE_VERSION}
          where id = ${id} and status = 'finalized'
        `;
        if (updated.count === 0) {
          // The MB stopped being finalized while Gotenberg rendered; the
          // stored PDF is an orphan, not evidence — no audit entry.
          throw httpError(
            409,
            'MB_STATUS_CONFLICT',
            'The Measurement Book is no longer finalized; the render was discarded.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'measurement_book.rendered',
          'measurement_books',
          id,
          {
            sha256,
            templateVersion: MB_TEMPLATE_VERSION,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  // GET .../pdf streams the PERSISTED render of a finalized (or
  // cancelled-after-finalized) MB — 404 RENDER_MISSING until rendered.
  // GET .../pdf?preview=1 streams a live DRAFT preview: computed from
  // live state, watermarked DRAFT, converted, and streamed WITHOUT
  // persisting — drafts change constantly, so no stored artifact and no
  // render columns are ever touched. Same authz as the MB read routes.
  tenantRoute(
    {
      method: 'GET',
      url: '/api/measurement-books/:id/pdf',
      schema: {
        params: IdParamsSchema,
        querystring: Type.Object(
          { preview: Type.Optional(Type.Literal('1')) },
          { additionalProperties: false },
        ),
      },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const { preview } = request.query;

      if (preview === '1') {
        const { snapshot, branding } = await tenant(async (tx) => {
          const book = await readBook(tx, id);
          if (!book) {
            throw httpError(
              404,
              'MEASUREMENT_BOOK_NOT_FOUND',
              'No such Measurement Book.',
            );
          }
          await assertWorkAccess(tx, user.id, book.work_id);
          if (book.status !== 'draft') {
            throw httpError(
              409,
              'MB_STATUS_CONFLICT',
              `The live preview is for draft Measurement Books (current status: ${book.status}); use the persisted render instead.`,
            );
          }
          const work = await readWorkIdentity(tx, book.work_id);
          const computation = await computeForBook(tx, book);
          const organisation = await readBranding(tx);
          return {
            snapshot: toSnapshot(
              book,
              organisation?.name ?? '',
              work,
              computation.lines.map(toLine),
              computation.totalAmount,
              MB_REMARK_TEMPLATE_VERSION,
            ),
            branding: organisation,
          };
        });
        const html = renderMeasurementBookHtml(
          snapshot,
          await brandingWithLogo(storage, branding, (error) => {
            request.log.warn(
              { err: error },
              'measurement book preview: logo unavailable',
            );
          }),
        );
        const pdf = await convertToPdf(gotenbergUrl, html, (error) => {
          request.log.error({ err: error }, 'measurement book preview failed');
        });
        void reply.type('application/pdf');
        void reply.header(
          'content-disposition',
          `inline; filename="measurement-book-${id}-draft-preview.pdf"`,
        );
        return reply.send(pdf);
      }

      const key = await tenant(async (tx) => {
        const book = await readBook(tx, id);
        if (!book) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.rendered_object_key === null) {
          throw httpError(
            404,
            'RENDER_MISSING',
            book.status === 'draft'
              ? 'Draft Measurement Books have no persisted PDF; use the live preview.'
              : 'This Measurement Book has not been rendered yet.',
          );
        }
        return book.rendered_object_key;
      });
      const bytes = await storage.get(key);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="measurement-book-${id}.pdf"`,
      );
      return reply.send(bytes);
    },
  );
}
