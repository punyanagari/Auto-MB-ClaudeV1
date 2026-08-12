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
  type CancelMeasurementBookRequest,
  type CreateMeasurementBookRequest,
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
  type MergeMeasurementBooksRequest,
  type SetMbSourcesRequest,
  type WorkCompletionBlocker,
  type WorkItemPaymentCategory,
  type WorkNotCleanDetails,
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
import { assertWorkOperable } from '../work-status.js';

/**
 * Milestone 8 phase 2: the stage-wise Measurement Book lifecycle engine
 * (ADR-0006; legacy spec Â§5.9, rule R19). Draft -> finalized ->
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
 * they claim sources exactly like any draft, and they NEVER finalize â€”
 * the merge endpoint folds them into a new on-account draft that claims
 * the union of their sources and marks each record merged. The
 * one-billing-draft rule (on-account/final) and the final-MB sweep are
 * unchanged; record MBs are invisible to billing. Un-merge is the only
 * way to take an absorbing draft apart: it restores the records and
 * their claims from normalized merge provenance, then deletes the draft.
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
 * billed quantities (SUM of deltas over other FINALIZED MBs' lines â€”
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
   Û:ÖÚ$z{-®éÜj×–ç7FVBâp¢¢töæÇ’G&gBÖV7W&VÖVçB&öö·26â&RFVÆWFVC²f–æÆ—¦VBöæW26æ6VÂv—F‚æ÷FRârÀ¢“°¢Ğ¢òòG&gBF†B'6÷&&VB&V6÷&BÔ'26ææ÷B6–×Ç’fæ—6ƒ¢F†P¢òò&V6÷&G2ö–çBB—Bƒ3B$U5E$”5Bd²’æBF†V—"6÷W&6W2Æ—fP¢òòöâ—BâF†RVâÖÖW&vRVæGö–çB—2F†RöæR†öæW7Bv’FòF¶R—@¢òò'B(	B—BWG2F†R&V6÷&G2&6²f—'7Bà¢6öç7BÖW&vVBÒv—BGƒÇ²–C¢7G&–ærÕµÓæ ¢6VÆV7B–Bg&öÒÖV7W&VÖVçEö&öö·0¢v†W&RÖW&vVEö–çFõö–BÒG¶–GÒæB7FGW2ÒvÖW&vVBp¢÷&FW"'’–@¢°¢–b†ÖW&vVBæÆVæwF‚â’°¢6öç7BFWF–Ç3¢Ö$†4ÖW&vVE&V6÷&G4FWF–Ç2Ò°¢&V6÷&DÖ$–G3¢ÖW&vVBæÖ‚‡&÷r’Óâ&÷ræ–B’À¢Ó°¢F‡&÷r‡GGW'&÷"€¢C’À¢tÔ%ô„5ôÔU$tTEõ$T4õ$E2rÀ¢uF†—2ÖV7W&VÖVçB&öö²'6÷&&VB&V6÷&BÖV7W&VÖVçB&öö·3²VâÖÖW&vR—B–ç7FVB6òF†R&V6÷&G2æBF†V—"6÷W&6W2&R&W7F÷&VBârÀ¢FWF–Ç2À¢“°¢Ğ¢òòFVÆWF–ærF†RG&gB&VÖ÷fW2—G26Æ–×2VçF—&VÇ’(	BF†R6÷W&6W0¢òò&WGW&âFòF†R÷VâööÂv—F‚æò&W6–GVRà¢v—BG†FVÆWFRg&öÒÖ%÷6÷W&6W2v†W&RÖV7W&VÖVçEö&ööµö–BÒG¶–GÖ°¢v—BG†FVÆWFRg&öÒÖV7W&VÖVçEö&öö·2v†W&R–BÒG¶–GÖ°¢v—BVF—B‡G‚Â÷&væ—6F–öä–BÂW6W"æ–BÂvÖV7W&VÖVçEö&öö²æFVÆWFVBrÂ–BÂ°¢v÷&´–C¢&öö²çv÷&µö–BÀ¢Ò“°¢Ò“°¢&WGW&â&WÇ’ç7FGW2ƒ#B’ç6VæB‚“°¢ÒÀ¢“° ¢òò&–ÆÂ&W&F–öâe$ôÒf–æÆ—¦VBÂVâÖ&–ÆÆVBÖV7W&VÖVçB&öö°¢òò„E"ÓbFV6—6–öâ#²&WÆ6W2F†RÖ–ÆW7FöæRR7vVWöbVæ&–ÆÆV@¢òòÖ%öVçG&–W2’âÖ÷VçBÒF†RÔ"w26æ6†÷GFVBF÷FÃ²Æ–æW5÷6æ6†÷@¢òò6'&–W2F†RÔ"w2Æ–æW2fW&&F–Ó²&–ÆÇ2æÖ%ö–BÆ–æ·2£à¢ç÷7B€¢rö’öÖV7W&VÖVçBÖ&öö·2ó¦–Bö&–ÆÂrÀ¢°¢66†VÖ¢°¢&×3¢–E&×566†VÖÀ¢&W7öç6S¢²#¢&–ÆÅ66†VÖÂââæW'&÷%&W7öç6W2ÒÀ¢ÒÀ¢ÒÀ¢7–æ2‡&WVW7BÂ&WÇ’’Óâ°¢6öç7BW6W"Òv—B&WV—&UW6W"†WF‚Â&WVW7B“°¢6öç7B÷&væ—6F–öä–BÒ&WV—&T÷&væ—6F–öä†VFW"€¢&WVW7Bæ†VFW'5²w‚Ö÷&væ—6F–öâÖ–BuÒÀ¢“°¢6öç7B²–BÒÒ&WVW7Bç&×22²–C¢7G&–ærÓ°¢6öç7B&–ÆÂÒv—Bv—F„&÷VæEFVæçB€¢FF&6RÀ¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢7–æ2‡G‚’Óâ°¢òò&W&–ær&–ÆÂ—2f–ææ6–Â7C¢—77VRWF†÷&—G¢òò&WV—&VB„Ö–ÆW7FöæRRvFRÂVæ6†ævVB’à¢v—B&WV—&TWF†÷&—G’‡G‚ÂW6W"æ–BÂv—77VRr“°¢6öç7B¶&ööµÒÒv—BGƒÀ¢°¢–C¢7G&–æs°¢v÷&µö–C¢7G&–æs°¢7FGW3¢7G&–æs°¢Ö%öçVÖ&W#¢7G&–ærÂçVÆÃ°¢F÷FÅöÖ÷VçC¢7G&–ærÂçVÆÃ°¢ÕµĞ¢æ ¢6VÆV7B–BÂv÷&µö–BÂ7FGW2ÂÖ%öçVÖ&W"ÂF÷FÅöÖ÷VçC£§FW‡B2F÷FÅöÖ÷Vç@¢g&öÒÖV7W&VÖVçEö&öö·0¢v†W&R–BÒG¶–GĞ¢f÷"WFFP¢°¢–b‚&öö²’°¢F‡&÷r‡GGW'&÷"€¢CBÀ¢tÔT5U$TÔTåEô$ôôµôäõEôdõTäBrÀ¢tæò7V6‚ÖV7W&VÖVçB&öö²ârÀ¢“°¢Ğ¢v—B76W'Ev÷&´66W72‡G‚ÂW6W"æ–BÂ&öö²çv÷&µö–B“°¢–b†&öö²ç7FGW2ÓÒvf–æÆ—¦VBr’°¢F‡&÷r‡GGW'&÷"€¢C’À¢tÔ%õ5DEU5ô4ôädÄ”5BrÀ¢&–ÆÇ2&R&W&VBg&öÒf–æÆ—¦VBÖV7W&VÖVçB&öö·2†7W'&VçB7FGW3¢G¶&öö²ç7FGW7Ò’æÀ¢“°¢Ğ¢6öç7B¶W†—7F–æuÒÒv—BGƒÇ²–C¢7G&–æs²&–ÆÅöçVÖ&W#¢çVÖ&W"ÕµÓæ ¢6VÆV7B–BÂ&–ÆÅöçVÖ&W"g&öÒ&–ÆÇ2v†W&RÖ%ö–BÒG¶–GĞ¢°¢–b†W†—7F–ær’°¢F‡&÷r‡GGW'&÷"€¢C’À¢tÔ%ôÅ$TE•ô$”ÄÄTBrÀ¢&–ÆÂ2Gµ7G&–ær†W†—7F–æræ&–ÆÅöçVÖ&W"—Òv2Ç&VG’&W&VBg&öÒF†—2ÖV7W&VÖVçB&öö²æÀ¢“°¢Ğ ¢òòF†R6÷VçFW"&÷rÆö6²6W&–Æ—6W26öæ7W'&VçB&–ÆÂ&W&F–öà¢òòf÷"F†Rv÷&²ƒbÖV6†æ–72ÂVæ6†ævVB’à¢6öç7B¶6÷VçFW%ÒÒv—BGƒÇ²æW‡E÷fÇVS¢çVÖ&W"ÕµÓæ ¢–ç6W'B–çFò&–ÆÅö6÷VçFW'2†÷&væ—6F–öåö–BÂv÷&µö–B¢fÇVW2‚G¶÷&væ—6F–öä–GÒÂG¶&öö²çv÷&µö–GÒ¢öâ6öæfÆ–7B†÷&væ—6F–öåö–BÂv÷&µö–B¢FòWFFR6WBæW‡E÷fÇVRÒ&–ÆÅö6÷VçFW'2ææW‡E÷fÇVR²À¢WFFVEöBÒæ÷r‚¢&WGW&æ–æræW‡E÷fÇVP¢°¢–b‚6÷VçFW"’F‡&÷ræWrW'&÷"‚v&–ÆÂ6÷VçFW"W6W'B&WGW&æVBæò&÷rr“° ¢6öç7BÆ–æW2Òv—B&VE7F÷&VDÆ–æW2‡G‚Â–B“°¢6öç7B·&÷uÒÒv—BGƒÀ¢°¢–C¢7G&–æs°¢v÷&µö–C¢7G&–æs°¢&–ÆÅöçVÖ&W#¢çVÖ&W#°¢7FGW3¢&–ÆÅ²w7FGW2uÓ°¢Æ–æW5÷6æ6†÷C¢Væ¶æ÷vã°¢F÷FÅöÖ÷VçC¢7G&–æs°¢Ö%ö–C¢7G&–ærÂçVÆÃ°¢7&VFVEöC¢FFS°¢7V&Ö—GFVEöC¢FFRÂçVÆÃ°¢–EöC¢FFRÂçVÆÃ°¢ÕµĞ¢æ ¢–ç6W'B–çFò&–ÆÇ2€¢÷&væ—6F–öåö–BÂv÷&µö–BÂ&–ÆÅöçVÖ&W"ÂÆ–æW5÷6æ6†÷BÀ¢F÷FÅöÖ÷VçBÂ&W&VEö'•÷W6W%ö–BÂÖ%ö–@¢¢fÇVW2€¢G¶÷&væ—6F–öä–GÒÂG¶&öö²çv÷&µö–GÒÂG¶6÷VçFW"ææW‡E÷fÇVWÒÀ¢G¶§6öæ"‡G‚ÂÆ–æW2—ÒÂG¶&öö²çF÷FÅöÖ÷VçGÒÀ¢G·W6W"æ–GÒÂG¶–GĞ¢¢&WGW&æ–ær–BÂv÷&µö–BÂ&–ÆÅöçVÖ&W"Â7FGW2ÂÆ–æW5÷6æ6†÷BÀ¢F÷FÅöÖ÷VçC£§FW‡B2F÷FÅöÖ÷VçBÂÖ%ö–BÂ7&VFVEöBÀ¢7V&Ö—GFVEöBÂ–Eö@¢æ6F6‚‚†W'&÷#¢Væ¶æ÷vâ’Óâ°¢–b†W'&÷"–ç7Fæ6VöbW'&÷"bbv6öFRr–âW'&÷"bbW'&÷"æ6öFRÓÓÒs#3SRr’°¢F‡&÷r‡GGW'&÷"€¢C’À¢tÔ%ôÅ$TE•ô$”ÄÄTBrÀ¢t&–ÆÂv2Ç&VG’&W&VBg&öÒF†—2ÖV7W&VÖVçB&öö²ârÀ¢“°¢Ğ¢F‡&÷rW'&÷#°¢Ò“°¢–b‚&÷r’F‡&÷ræWrW'&÷"‚v&–ÆÂ–ç6W'B&WGW&æVBæò&÷rr“°¢v—BG† ¢–ç6W'B–çFòVF—EöWfVçG2€¢÷&væ—6F–öåö–BÂ7F÷%÷W6W%ö–BÂ7F–öâÂVçF—G•÷G—RÂVçF—G•ö–BÀ¢FWF–Ç0¢¢fÇVW2€¢G¶÷&væ—6F–öä–GÒÂG·W6W"æ–GÒÂv&–ÆÂç&W&VBrÂv&–ÆÇ2rÂG·&÷ræ–GÒÀ¢G¶§6öæ"‡G‚Â°¢&–ÆÄçVÖ&W#¢&÷ræ&–ÆÅöçVÖ&W"À¢F÷FÄÖ÷VçC¢&÷rçF÷FÅöÖ÷VçBÀ¢ÖV7W&VÖVçD&öö´–C¢–BÀ¢Ö$çVÖ&W#¢&öö²æÖ%öçVÖ&W"À¢Æ–æT6÷VçC¢Æ–æW2æÆVæwF‚À¢Ò—Ğ¢¢°¢&WGW&â°¢–C¢&÷ræ–BÀ¢v÷&´–C¢&÷rçv÷&µö–BÀ¢&–ÆÄçVÖ&W#¢&÷ræ&–ÆÅöçVÖ&W"À¢7FGW3¢&÷rç7FGW2À¢F÷FÄÖ÷VçC¢&÷rçF÷FÅöÖ÷VçBÀ¢Æ–æW56æ6†÷C¢'6T§6öæ$6öÇVÖâ‡&÷ræÆ–æW5÷6æ6†÷B’À¢7&VFVDC¢&÷ræ7&VFVEöBçFô•4õ7G&–ær‚’À¢7V&Ö—GFVDC¢&÷rç7V&Ö—GFVEöCòçFô•4õ7G&–ær‚’óòçVÆÂÀ¢–DC¢&÷rç–EöCòçFô•4õ7G&–ær‚’óòçVÆÂÀ¢Ö$–C¢&÷ræÖ%ö–BÀ¢Ò6F—6f–W2&–ÆÃ°¢ÒÀ¢“°¢&WGW&â&WÇ’ç7FGW2ƒ#’ç6VæB†&–ÆÂ“°¢ÒÀ¢“° ¢òòF†RÔ"Fö7VÖVçB‡†6R3²7V2*sRã’$Ô"Fö7VÖVçB…Db’"’â¢òòd”äÄ•¤TBÔ"&VæFW'2g&öÒ—G2”ÔÕUD$ÄR7F÷&VBÆ–æW2Fò¢òòW'6—7FVBÂ6öçFVçBÖFG&W76VBDc¢ö&¦V7B¶W’²4„Ó#Sb°¢òòFV×ÆFU÷fW'6–öâ&V6÷&FVBöâF†R&÷rÂVF—BG&–ÂVæFVBâF†P¢òò6æ6†÷B&VBæBF†RDbw&—FRÆ—fR–â6W&FRG&ç67F–öç26ğ¢òòF†R6Æ÷rW‡FW&æÂ6ÆÂ†öÆG2æòFF&6RÆö6·3²F†Rf–æÂw&—FP¢òò&RÖ6†V6·2F†R7FGW26ò&6Rv–ç7B6æ6VÂF—66&G2F†R÷'†à¢òò&VæFW"–ç7FVBöb7F×–ær—B‡F†R6†ÆÆâ&VæFW"F—66—Æ–æR’à¢ç÷7B€¢rö’öÖV7W&VÖVçBÖ&öö·2ó¦–B÷&VæFW"rÀ¢°¢66†VÖ¢°¢&×3¢–E&×566†VÖÀ¢&W7öç6S¢°¢#¢ÖV7W&VÖVçD&öö´FWF–Å&W7öç6U66†VÖÀ¢ââæW'&÷%&W7öç6W2À¢S#¢”W'&÷%66†VÖÀ¢ÒÀ¢ÒÀ¢ÒÀ¢7–æ2‡&WVW7B’Óâ°¢6öç7BW6W"Òv—B&WV—&UW6W"†WF‚Â&WVW7B“°¢6öç7B÷&væ—6F–öä–BÒ&WV—&T÷&væ—6F–öä†VFW"€¢&WVW7Bæ†VFW'5²w‚Ö÷&væ—6F–öâÖ–BuÒÀ¢“°¢6öç7B²–BÒÒ&WVW7Bç&×22²–C¢7G&–ærÓ° ¢6öç7B²6æ6†÷BÂ'&æF–ærÒÒv—Bv—F„&÷VæEFVæçB€¢FF&6RÀ¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢7–æ2‡G‚’Óâ°¢v—B&WV—&Uw&—FW%&öÆR‡G‚ÂW6W"æ–B“°¢6öç7B&öö²Òv—B&VD&öö²‡G‚Â–B“°¢–b‚&öö²’°¢F‡&÷r‡GGW'&÷"€¢CBÀ¢tÔT5U$TÔTåEô$ôôµôäõEôdõTäBrÀ¢tæò7V6‚ÖV7W&VÖVçB&öö²ârÀ¢“°¢Ğ¢v—B76W'Ev÷&´66W72‡G‚ÂW6W"æ–BÂ&öö²çv÷&µö–B“°¢–b†&öö²ç7FGW2ÓÒvf–æÆ—¦VBr’°¢F‡&÷r‡GGW'&÷"€¢C’À¢tÔ%õ5DEU5ô4ôädÄ”5BrÀ¢öæÇ’f–æÆ—¦VBÖV7W&VÖVçB&öö·2&VæFW"FòW'6—7FVBDb†7W'&VçB7FGW3¢G¶&öö²ç7FGW7Ò“²G&gG27G&VÒÆ—fR&Wf–Wr–ç7FVBæÀ¢“°¢Ğ¢6öç7Bv÷&²Òv—B&VEv÷&´–FVçF—G’‡G‚Â&öö²çv÷&µö–B“°¢6öç7BÆ–æW2Òv—B&VE7F÷&VDÆ–æW2‡G‚Â–B“°¢6öç7B÷&væ—6F–öâÒv—B&VD'&æF–ær‡G‚“°¢&WGW&â°¢6æ6†÷C¢Fõ6æ6†÷B€¢&öö²À¢÷&væ—6F–öãòææÖRóòrrÀ¢v÷&²À¢Æ–æW2À¢&öö²çF÷FÅöÖ÷VçBóòsãrÀ¢&öö²ç&VÖ&µ÷FV×ÆFU÷fW'6–öâóòÔ%õ$TÔ$µõDTÕÄDUõdU%4”ôâÀ¢’À¢'&æF–æs¢÷&væ—6F–öâÀ¢Ó°¢ÒÀ¢“° ¢6öç7B‡FÖÂÒ&VæFW$ÖV7W&VÖVçD&öö´‡FÖÂ€¢6æ6†÷BÀ¢v—B'&æF–æuv—F„Æövò‡7F÷&vRÂ'&æF–ærÂ†W'&÷"’Óâ°¢&WVW7BæÆörçv&â‡²W'#¢W'&÷"ÒÂvÖV7W&VÖVçB&öö²&VæFW#¢ÆövòVæf–Æ&ÆRr“°¢Ò’À¢“°¢6öç7BFbÒv—B6öçfW'EFõFb†v÷FVæ&W&uW&ÂÂ‡FÖÂÂ†W'&÷"’Óâ°¢&WVW7BæÆöræW'&÷"‡²W'#¢W'&÷"ÒÂvÖV7W&VÖVçB&öö²&VæFW"f–ÆVBr“°¢Ò“°¢6öç7B6†#SbÒ7&VFT†6‚‚w6†#Sbr’çWFFR‡Fb’æF–vW7B‚v†W‚r“°¢6öç7Bö&¦V7D¶W’ÒG¶÷&væ—6F–öä–GÒöÖ"òG¶–GÒçFf°¢v—B7F÷&vRçWB†ö&¦V7D¶W’ÂFb“° ¢&WGW&âv—F„&÷VæEFVæçB†FF&6RÂ÷&væ—6F–öä–BÂW6W"æ–BÂ7–æ2‡G‚’Óâ°¢6öç7BWFFVBÒv—BG† ¢WFFRÖV7W&VÖVçEö&öö·0¢6WB&VæFW&VEöö&¦V7Eö¶W’ÒG¶ö&¦V7D¶W—ÒÂ&VæFW&VE÷6†#SbÒG·6†#SgÒÀ¢FV×ÆFU÷fW'6–öâÒG´Ô%õDTÕÄDUõdU%4”ôçĞ¢v†W&R–BÒG¶–GÒæB7FGW2Òvf–æÆ—¦VBp¢°¢–b‡WFFVBæ6÷VçBÓÓÒ’°¢òòF†RÔ"7F÷VB&V–ærf–æÆ—¦VBv†–ÆRv÷FVæ&W&r&VæFW&VC²F†P¢òò7F÷&VBDb—2â÷'†âÂæ÷BWf–FVæ6R(	BæòVF—BVçG'’à¢F‡&÷r‡GGW'&÷"€¢C’À¢tÔ%õ5DEU5ô4ôädÄ”5BrÀ¢uF†RÖV7W&VÖVçB&öö²—2æòÆöævW"f–æÆ—¦VC²F†R&VæFW"v2F—66&FVBârÀ¢“°¢Ğ¢v—BVF—B‡G‚Â÷&væ—6F–öä–BÂW6W"æ–BÂvÖV7W&VÖVçEö&öö²ç&VæFW&VBrÂ–BÂ°¢6†#SbÀ¢FV×ÆFUfW'6–öã¢Ô%õDTÕÄDUõdU%4”ôâÀ¢Ò“°¢&WGW&â&VDFWF–Â‡G‚Â–B“°¢Ò“°¢ÒÀ¢“° ¢òòtUBâââ÷Fb7G&V×2F†RU%4•5DTB&VæFW"öbf–æÆ—¦VB†÷ ¢òò6æ6VÆÆVBÖgFW"Öf–æÆ—¦VB’Ô"(	BCB$TäDU%ôÔ•54”ärVçF–Â&VæFW&VBà¢òòtUBâââ÷Fc÷&Wf–WsÓ7G&V×2Æ—fRE$eB&Wf–Ws¢6ö×WFVBg&öĞ¢òòÆ—fR7FFRÂvFW&Ö&¶VBE$eBÂ6öçfW'FVBÂæB7G&VÖVBt•D„õU@¢òòW'6—7F–ær(	BG&gG26†ævR6öç7FçFÇ’Â6òæò7F÷&VB'F–f7BæBæğ¢òò&VæFW"6öÇVÖç2&RWfW"F÷V6†VBâ6ÖRWF‡¢2F†RÔ"&VB&÷WFW2à¢ævWB€¢rö’öÖV7W&VÖVçBÖ&öö·2ó¦–B÷FbrÀ¢°¢66†VÖ¢°¢&×3¢–E&×566†VÖÀ¢VW'—7G&–æs¢G—Räö&¦V7B€¢²&Wf–Ws¢G—Rä÷F–öæÂ…G—RäÆ—FW&Â‚sr’’ÒÀ¢²FF—F–öæÅ&÷W'F–W3¢fÇ6RÒÀ¢’À¢ÒÀ¢ÒÀ¢7–æ2‡&WVW7BÂ&WÇ’’Óâ°¢6öç7BW6W"Òv—B&WV—&UW6W"†WF‚Â&WVW7B“°¢6öç7B÷&væ—6F–öä–BÒ&WV—&T÷&væ—6F–öä†VFW"€¢&WVW7Bæ†VFW'5²w‚Ö÷&væ—6F–öâÖ–BuÒÀ¢“°¢6öç7B²–BÒÒ&WVW7Bç&×22²–C¢7G&–ærÓ°¢6öç7B²&Wf–WrÒÒ&WVW7BçVW'’2²&Wf–Wsó¢srÓ° ¢–b‡&Wf–WrÓÓÒsr’°¢6öç7B²6æ6†÷BÂ'&æF–ærÒÒv—Bv—F„&÷VæEFVæçB€¢FF&6RÀ¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢7–æ2‡G‚’Óâ°¢6öç7B&öö²Òv—B&VD&öö²‡G‚Â–B“°¢–b‚&öö²’°¢F‡&÷r‡GGW'&÷"€¢CBÀ¢tÔT5U$TÔTåEô$ôôµôäõEôdõTäBrÀ¢tæò7V6‚ÖV7W&VÖVçB&öö²ârÀ¢“°¢Ğ¢v—B76W'Ev÷&´66W72‡G‚ÂW6W"æ–BÂ&öö²çv÷&µö–B“°¢–b†&öö²ç7FGW2ÓÒvG&gBr’°¢F‡&÷r‡GGW'&÷"€¢C’À¢tÔ%õ5DEU5ô4ôädÄ”5BrÀ¢F†RÆ—fR&Wf–Wr—2f÷"G&gBÖV7W&VÖVçB&öö·2†7W'&VçB7FGW3¢G¶&öö²ç7FGW7Ò“²W6RF†RW'6—7FVB&VæFW"–ç7FVBæÀ¢“°¢Ğ¢6öç7Bv÷&²Òv—B&VEv÷&´–FVçF—G’‡G‚Â&öö²çv÷&µö–B“°¢6öç7B6ö×WFF–öâÒv—B6ö×WFTf÷$&öö²‡G‚Â&öö²“°¢6öç7B÷&væ—6F–öâÒv—B&VD'&æF–ær‡G‚“°¢&WGW&â°¢6æ6†÷C¢Fõ6æ6†÷B€¢&öö²À¢÷&væ—6F–öãòææÖRóòrrÀ¢v÷&²À¢6ö×WFF–öâæÆ–æW2æÖ‡FôÆ–æR’À¢6ö×WFF–öâçF÷FÄÖ÷VçBÀ¢Ô%õ$TÔ$µõDTÕÄDUõdU%4”ôâÀ¢’À¢'&æF–æs¢÷&væ—6F–öâÀ¢Ó°¢ÒÀ¢“°¢6öç7B‡FÖÂÒ&VæFW$ÖV7W&VÖVçD&öö´‡FÖÂ€¢6æ6†÷BÀ¢v—B'&æF–æuv—F„Æövò‡7F÷&vRÂ'&æF–ærÂ†W'&÷"’Óâ°¢&WVW7BæÆörçv&â€¢²W'#¢W'&÷"ÒÀ¢vÖV7W&VÖVçB&öö²&Wf–Ws¢ÆövòVæf–Æ&ÆRrÀ¢“°¢Ò’À¢“°¢6öç7BFbÒv—B6öçfW'EFõFb†v÷FVæ&W&uW&ÂÂ‡FÖÂÂ†W'&÷"’Óâ°¢&WVW7BæÆöræW'&÷"‡²W'#¢W'&÷"ÒÂvÖV7W&VÖVçB&öö²&Wf–Wrf–ÆVBr“°¢Ò“°¢fö–B&WÇ’çG—R‚vÆ–6F–öâ÷Fbr“°¢fö–B&WÇ’æ†VFW"€¢v6öçFVçBÖF—7÷6—F–öârÀ¢–æÆ–æS²f–ÆVæÖSÒ&ÖV7W&VÖVçBÖ&öö²ÒG¶–GÒÖG&gB×&Wf–WrçFb&À¢“°¢&WGW&â&WÇ’ç6VæB‡Fb“°¢Ğ ¢6öç7B¶W’Òv—Bv—F„&÷VæEFVæçB€¢FF&6RÀ¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢7–æ2‡G‚’Óâ°¢6öç7B&öö²Òv—B&VD&öö²‡G‚Â–B“°¢–b‚&öö²’°¢F‡&÷r‡GGW'&÷"€¢CBÀ¢tÔT5U$TÔTåEô$ôôµôäõEôdõTäBrÀ¢tæò7V6‚ÖV7W&VÖVçB&öö²ârÀ¢“°¢Ğ¢v—B76W'Ev÷&´66W72‡G‚ÂW6W"æ–BÂ&öö²çv÷&µö–B“°¢–b†&öö²ç&VæFW&VEöö&¦V7Eö¶W’ÓÓÒçVÆÂ’°¢F‡&÷r‡GGW'&÷"€¢CBÀ¢u$TäDU%ôÔ•54”ärrÀ¢&öö²ç7FGW2ÓÓÒvG&gBp¢òtG&gBÖV7W&VÖVçB&öö·2†fRæòW'6—7FVBDc²W6RF†RÆ—fR&Wf–Wrâp¢¢uF†—2ÖV7W&VÖVçB&öö²†2æ÷B&VVâ&VæFW&VB–WBârÀ¢“°¢Ğ¢&WGW&â&öö²ç&VæFW&VEöö&¦V7Eö¶W“°¢ÒÀ¢“°¢6öç7B'—FW2Òv—B7F÷&vRævWB†¶W’“°¢fö–B&WÇ’çG—R‚vÆ–6F–öâ÷Fbr“°¢fö–B&WÇ’æ†VFW"€¢v6öçFVçBÖF—7÷6—F–öârÀ¢–æÆ–æS²f–ÆVæÖSÒ&ÖV7W&VÖVçBÖ&öö²ÒG¶–GÒçFb&À¢“°¢&WGW&â&WÇ’ç6VæB†'—FW2“°¢ÒÀ¢“°§Ğ 