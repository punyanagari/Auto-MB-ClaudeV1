import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  BillSchema,
  CancelMeasurementBookRequestSchema,
  CreateMeasurementBookRequestSchema,
  MeasurementBookDetailResponseSchema,
  MeasurementBookListResponseSchema,
  SetMbSourcesRequestSchema,
  type Bill,
  type CancelMeasurementBookRequest,
  type CreateMeasurementBookRequest,
  type MbFinalSweepDetails,
  type MbNotNewestDetails,
  type MbPercentagesUnresolvedDetails,
  type MbSourceConflictDetails,
  type MbSourceRef,
  type MbSourceType,
  type MeasurementBook,
  type MeasurementBookDetailResponse,
  type MeasurementBookLine,
  type MeasurementBookSource,
  type SetMbSourcesRequest,
  type WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireAuthority, requireWriterRole } from '../authz.js';
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
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

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
 */

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
} as const;

const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

async function audit(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, 'measurement_books', ${entityId},
      ${jsonb(tx, details)}
    )
  `;
}

// --- Row shapes -------------------------------------------------------------

interface BookRow {
  id: string;
  work_id: string;
  status: MeasurementBook['status'];
  is_final: boolean;
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
    isFinal: row.is_final,
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
  mb.id, mb.work_id, mb.status, mb.is_final, mb.mb_date::text as mb_date,
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
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
): void {
  app.get(
    '/api/works/:id/measurement-books',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: MeasurementBookListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
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

  app.get(
    '/api/measurement-books/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
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

  app.post(
    '/api/works/:id/measurement-books',
    {
      schema: {
        params: IdParamsSchema,
        body: CreateMeasurementBookRequestSchema,
        response: { 201: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const body = request.body as CreateMeasurementBookRequest;
      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
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
          `;
          if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
          if (work.status !== 'active') {
            throw httpError(
              409,
              'WORK_NOT_ACTIVE',
              'Measurement Books are raised on active Works only.',
            );
          }
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
          // No further MBs once a live final MB exists (friendly form;
          // the 0024 insert guard holds it against every writer).
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
          // One open draft per Work: friendly pre-check names the
          // existing draft; the partial unique index decides races and
          // the catch below rebuilds the same 409 shape.
          const [existingDraft] = await tx<{ id: string }[]>`
            select id from measurement_books
            where work_id = ${workId} and status = 'draft'
          `;
          if (existingDraft) {
            throw draftConflictError(
              'MB_DRAFT_EXISTS',
              'This Work already has a draft Measurement Book; finalize or delete it first.',
              existingDraft.id,
            );
          }
          const [row] = await tx<{ id: string }[]>`
            insert into measurement_books (
              organisation_id, work_id, mb_date, is_final, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.mbDate},
              ${body.isFinal ?? false}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'MB_DRAFT_EXISTS',
                'This Work already has a draft Measurement Book; finalize or delete it first.',
              );
            }
            throw error;
          });
          if (!row) throw new Error('measurement book insert returned no row');
          await audit(tx, organisationId, user.id, 'measurement_book.created', row.id, {
            workId,
            mbDate: body.mbDate,
            isFinal: body.isFinal ?? false,
          });
          return readDetail(tx, row.id);
        },
      ).catch(async (error: unknown) => {
        throw await nameDraftConflict(error, 'MB_DRAFT_EXISTS', async () => {
          return withBoundTenant(database, organisationId, user.id, async (tx) => {
            const [draft] = await tx<{ id: string }[]>`
              select id from measurement_books
              where work_id = ${workId} and status = 'draft'
            `;
            return draft?.id ?? null;
          });
        });
      });
      return reply.status(201).send(detail);
    },
  );

  app.put(
    '/api/measurement-books/:id/sources',
    {
      schema: {
        params: IdParamsSchema,
        body: SetMbSourcesRequestSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as SetMbSourcesRequest;
      const keys = body.sources.map((s) => `${s.sourceType}:${s.sourceId}`);
      if (new Set(keys).size !== keys.length) {
        throw httpError(
          400,
          'MB_SOURCES_DUPLICATED',
          'The same source appears more than once in the selection.',
        );
      }
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
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

  app.post(
    '/api/measurement-books/:id/finalize',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        // Finalizing assigns a legal number and freezes a financial
        // snapshot: issue authority required, like bill preparation.
        await requireAuthority(tx, user.id, 'issue');
        const [book] = await tx<
          { id: string; work_id: string; status: string; is_final: boolean }[]
        >`
          select id, work_id, status, is_final from measurement_books
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
        await audit(tx, organisationId, user.id, 'measurement_book.finalized', id, {
          before: { status: 'draft' },
          after: { status: 'finalized' },
          workId: book.work_id,
          mbNumber,
          sequence,
          totalAmount: computation.totalAmount,
          isFinal: book.is_final,
          lineCount: computation.lines.length,
          remarkTemplateVersion: MB_REMARK_TEMPLATE_VERSION,
        });
        return readDetail(tx, id);
      });
    },
  );

  app.post(
    '/api/measurement-books/:id/cancel',
    {
      schema: {
        params: IdParamsSchema,
        body: CancelMeasurementBookRequestSchema,
        response: { 200: MeasurementBookDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as CancelMeasurementBookRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireAuthority(tx, user.id, 'cancel');
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
        const [workRow] = await tx<{ id: string }[]>`
          select id from works
          where id = ${book.work_id} and deleted_at is null
          for update
        `;
        if (!workRow) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
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
        await audit(tx, organisationId, user.id, 'measurement_book.cancelled', id, {
          before: { status: 'finalized' },
          after: { status: 'cancelled' },
          workId: book.work_id,
          mbNumber: book.mb_number,
          note: body.note,
          releasedSourceCount: released.length,
        });
        return readDetail(tx, id);
      });
    },
  );

  app.delete(
    '/api/measurement-books/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      await withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
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
            'Only draft Measurement Books can be deleted; finalized ones cancel with a note.',
          );
        }
        // Deleting the draft removes its claims entirely — the sources
        // return to the open pool with no residue.
        await tx`delete from mb_sources where measurement_book_id = ${id}`;
        await tx`delete from measurement_books where id = ${id}`;
        await audit(tx, organisationId, user.id, 'measurement_book.deleted', id, {
          workId: book.work_id,
        });
      });
      return reply.status(204).send();
    },
  );

  // Bill preparation FROM a finalized, un-billed Measurement Book
  // (ADR-0006 decision 2; replaces the Milestone 5 sweep of unbilled
  // mb_entries). Amount = the MB's snapshotted total; lines_snapshot
  // carries the MB's lines verbatim; bills.mb_id links 1:1.
  app.post(
    '/api/measurement-books/:id/bill',
    {
      schema: {
        params: IdParamsSchema,
        response: { 201: BillSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const bill = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          // Preparing a bill is a financial act: issue authority
          // required (Milestone 5 gate, unchanged).
          await requireAuthority(tx, user.id, 'issue');
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
        },
      );
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
  app.post(
    '/api/measurement-books/:id/render',
    {
      schema: {
        params: IdParamsSchema,
        response: {
          200: MeasurementBookDetailResponseSchema,
          ...errorResponses,
          502: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };

      const { snapshot, branding } = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
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
        },
      );

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

      return withBoundTenant(database, organisationId, user.id, async (tx) => {
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
        await audit(tx, organisationId, user.id, 'measurement_book.rendered', id, {
          sha256,
          templateVersion: MB_TEMPLATE_VERSION,
        });
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
  app.get(
    '/api/measurement-books/:id/pdf',
    {
      schema: {
        params: IdParamsSchema,
        querystring: Type.Object(
          { preview: Type.Optional(Type.Literal('1')) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const { preview } = request.query as { preview?: '1' };

      if (preview === '1') {
        const { snapshot, branding } = await withBoundTenant(
          database,
          organisationId,
          user.id,
          async (tx) => {
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
          },
        );
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

      const key = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
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
        },
      );
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
