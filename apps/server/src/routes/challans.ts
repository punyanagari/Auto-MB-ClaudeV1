import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  CancelChallanRequestSchema,
  ChallanDetailResponseSchema,
  ChallanListResponseSchema,
  SaveChallanRequestSchema,
  WorkBalanceResponseSchema,
  type CancelChallanRequest,
  type Challan,
  type ChallanDetailResponse,
  type ChallanItem,
  type ChallanOverReceiptWarning,
  type Consignee,
  type SaveChallanRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireAuthority, requireWriterRole } from '../authz.js';
import {
  CHALLAN_TEMPLATE_VERSION,
  WARRANTY_TEMPLATE_VERSION,
  renderChallanHtml,
  type ChallanSnapshot,
} from '../challan-html.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
import { httpError } from '../http.js';
import {
  NumberTemplateError,
  loadNumberTemplate,
  renderNumberTemplate,
} from '../number-series.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import type { MalwareScanner } from '../malware-scan.js';
import { canonicalRateText } from '../rate-text.js';
import { assertSourceNotBilled } from './measurement-books.js';
import { assertNotMalware } from '../upload-guards.js';
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { assertWorkOperable } from '../work-status.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  502: ApiErrorSchema,
} as const;

const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

const PdfQuerySchema = Type.Object(
  {
    kind: Type.Optional(Type.Union([Type.Literal('rendered'), Type.Literal('signed')])),
  },
  { additionalProperties: false },
);

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_PDF_BYTES = 25 * 1024 * 1024;

interface ChallanRow {
  id: string;
  work_id: string;
  status: Challan['status'];
  challan_date: string;
  challan_number: string | null;
  sequence_number: number | null;
  prefix: string;
  consignee_snapshot: unknown;
  template_version: string | null;
  warranty_template_version: string | null;
  warranty_text_sha256: string | null;
  rendered_object_key: string | null;
  signed_copy_object_key: string | null;
  cancellation_note: string | null;
  created_at: Date;
  issued_at: Date | null;
  cancelled_at: Date | null;
}

const CHALLAN_COLUMNS = `
  id, work_id, status, challan_date::text as challan_date, challan_number,
  sequence_number, prefix, consignee_snapshot, template_version,
  warranty_template_version, warranty_text_sha256,
  rendered_object_key, signed_copy_object_key, cancellation_note,
  created_at, issued_at, cancelled_at
`;

function toChallan(row: ChallanRow): Challan {
  return {
    id: row.id,
    workId: row.work_id,
    status: row.status,
    challanDate: row.challan_date,
    challanNumber: row.challan_number,
    sequenceNumber: row.sequence_number,
    prefix: row.prefix,
    consignee: parseJsonbColumn(row.consignee_snapshot) as Consignee,
    templateVersion: row.template_version,
    warrantyTemplateVersion: row.warranty_template_version,
    warrantyTextSha256: row.warranty_text_sha256,
    renderedAvailable: row.rendered_object_key !== null,
    signedCopyAvailable: row.signed_copy_object_key !== null,
    cancellationNote: row.cancellation_note,
    createdAt: row.created_at.toISOString(),
    issuedAt: row.issued_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

interface ChallanItemRow {
  id: string;
  work_item_id: string;
  description_snapshot: string;
  unit_snapshot: string;
  quantity: string;
  rate_snapshot: string;
  line_amount: string;
  position: number;
  purchase_order_line_id: string | null;
}

function toChallanItem(row: ChallanItemRow): ChallanItem {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    description: row.description_snapshot,
    unit: row.unit_snapshot,
    quantity: row.quantity,
    rate: canonicalRateText(row.rate_snapshot),
    lineAmount: row.line_amount,
    position: row.position,
    purchaseOrderLineId: row.purchase_order_line_id,
  };
}

async function readItems(
  tx: TransactionSql,
  challanId: string,
): Promise<ChallanItem[]> {
  const rows = await tx<ChallanItemRow[]>`
    select id, work_item_id, description_snapshot, unit_snapshot,
           quantity::text as quantity, rate_snapshot::text as rate_snapshot,
           line_amount::text as line_amount, position, purchase_order_line_id
    from delivery_challan_items
    where delivery_challan_id = ${challanId}
    order by position
  `;
  return rows.map(toChallanItem);
}

/**
 * The over-receipt notices for this challan's purchase-order-linked
 * lines, one per purchase-order line, in exact SQL numeric arithmetic
 * (rule 5). `received` counts issued receipts on OTHER challans plus this
 * challan's own lines â€” the projection while this challan is a draft and
 * the actual total once it is issued (its own lines are then part of the
 * issued sum, so the two readings agree). Over-receipt is deliberately a
 * WARNING, never a refusal: vendors over-ship, and the delivery document
 * must record what actually arrived (the purchase-order balance already
 * floors its pending figure at zero, purchase-orders.ts readLines).
 */
async function readOverReceiptWarnings(
  tx: TransactionSql,
  challanId: string,
): Promise<ChallanOverReceiptWarning[]> {
  const rows = await tx<
    {
      purchase_order_line_id: string;
      po_number: string;
      line_number: number;
      description: string;
      ordered_quantity: string;
      received_quantity: string;
    }[]
  >`
    select pol.id as purchase_order_line_id, po.po_number, pol.line_number,
           pol.description, pol.quantity::text as ordered_quantity,
           (coalesce(elsewhere.received, 0) + own.quantity)
             ::numeric(18,3)::text as received_quantity
    from (
      select dci.purchase_order_line_id as pol_id, sum(dci.quantity) as quantity
      from delivery_challan_items dci
      where dci.delivery_challan_id = ${challanId}
        and dci.purchase_order_line_id is not null
      group by dci.purchase_order_line_id
    ) own
    join purchase_order_lines pol on pol.id = own.pol_id
    join purchase_orders po on po.id = pol.purchase_order_id
    left join lateral (
      select sum(q.quantity) as received
      from delivery_challan_items q
      join delivery_challans dc on dc.id = q.delivery_challan_id
      where q.purchase_order_line_id = pol.id
        and dc.status = 'issued'
        and q.delivery_challan_id <> ${challanId}
    ) elsewhere on true
    where coalesce(elsewhere.received, 0) + own.quantity > pol.quantity
    order by pol.line_number
  `;
  return rows.map((row) => ({
    purchaseOrderLineId: row.purchase_order_line_id,
    poNumber: row.po_number,
    poLineNumber: row.line_number,
    description: row.description,
    orderedQuantity: row.ordered_quantity,
    receivedQuantity: row.received_quantity,
  }));
}

async function readDetail(
  tx: TransactionSql,
  challanId: string,
): Promise<ChallanDetailResponse> {
  const [row] = await tx<(ChallanRow & { issued_snapshot: unknown })[]>`
    select ${tx.unsafe(CHALLAN_COLUMNS)}, issued_snapshot
    from delivery_challans where id = ${challanId}
  `;
  if (!row) throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
  return {
    challan: toChallan(row),
    items: await readItems(tx, challanId),
    issuedSnapshot: parseJsonbColumn(row.issued_snapshot),
    // A cancelled challan released its receipts, so it can no longer
    // over-receive anything; otherwise the notices are recomputed live so
    // a receipt issued elsewhere shows up on the next read of this one.
    warnings:
      row.status === 'cancelled' ? [] : await readOverReceiptWarnings(tx, challanId),
  };
}

/** Product contract: a document date is never in the future and never
 * before the Work's LOA letter date. "Today" is the organisation's own
 * timezone (default Asia/Kolkata), not the server clock â€” an evening
 * entry in India must not be rejected as tomorrow's date. (Exported for
 * the correction flow, which validates replacement drafts.) */
export async function assertChallanDate(
  tx: TransactionSql,
  workId: string,
  challanDate: string,
): Promise<void> {
  const [bounds] = await tx<{ letter_date: string; today: string }[]>`
    select w.letter_date::text as letter_date,
           (now() at time zone o.timezone)::date::text as today
    from works w
    join organisations o on o.id = w.organisation_id
    where w.id = ${workId}
  `;
  if (!bounds) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  // ISO dates compare correctly as strings.
  if (challanDate > bounds.today) {
    throw httpError(
      400,
      'CHALLAN_DATE_INVALID',
      `The challan date cannot be in the future (today is ${bounds.today}).`,
    );
  }
  if (challanDate < bounds.letter_date) {
    throw httpError(
      400,
      'CHALLAN_DATE_INVALID',
      `The challan date cannot precede the LOA letter date (${bounds.letter_date}).`,
    );
  }
}

/** True when a DecimalString denotes a value greater than zero, decided
 * on the digits themselves â€” never binary floating-point arithmetic
 * (engineering rule 5). The schema pattern guarantees the shape, so a
 * leading '-' is the only sign and any non-zero digit means positive. */
function isPositiveDecimal(value: string): boolean {
  return !value.startsWith('-') && /[1-9]/.test(value);
}

/** Digits before the decimal point. `delivery_challan_items.quantity` is
 * numeric(18,3), so sixteen of them is a numeric field overflow (22003)
 * in Postgres â€” the same statusless error a failed CHECK raises. */
function integerDigitCount(value: string): number {
  const [whole = ''] = value.replace('-', '').split('.');
  return whole.length;
}

/** The consignee block exactly as it will be printed. `ConsigneeSchema`
 * counts RAW characters, so `{name: '  ', address: '   '}` satisfies its
 * minimums, is frozen into the issued snapshot, and reaches the railway
 * as a delivery document with a blank consignee â€” and `consignee_snapshot`
 * is bare jsonb, so nothing below catches it either. Trim first, then
 * prove the printed parts survived. A phone of only spaces is dropped
 * rather than stored blank. (The web editor already trims; this closes
 * the same hole for direct API callers.) */
export function normaliseConsignee(consignee: Consignee): Consignee {
  const name = consignee.name.trim();
  const address = consignee.address.trim();
  const phone = consignee.phone?.trim() ?? '';
  if (name.length < 2 || address.length < 3) {
    throw httpError(
      400,
      'CONSIGNEE_INVALID',
      'The consignee needs a name and an address that are not blank â€” this challan is printed and handed to the consignee.',
    );
  }
  return { name, address, ...(phone.length > 0 ? { phone } : {}) };
}

/** A cancellation note as the DATABASE judges it. Every cancellation
 * CHECK in the schema reads `length(btrim(note)) >= 3` while the contract
 * counts raw characters, so a note of three spaces passed validation,
 * reached Postgres, and came back as a bare 500 'The request could not be
 * completed.' The trimmed text is what gets stored, so the note on the
 * record is the note the operator meant. (Exported: the correction-notice
 * and PAC cancels answer to the same CHECK.) */
export function cancellationNote(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length < 3) {
    throw httpError(
      400,
      'CANCELLATION_NOTE_REQUIRED',
      'The cancellation note must say why the record is being cancelled â€” at least three characters that are not spaces.',
    );
  }
  return trimmed;
}

/** Locks the challan row for the rest of the transaction and returns it.
 * Every state transition starts here so concurrent requests serialise. */
async function lockChallan(tx: TransactionSql, challanId: string): Promise<ChallanRow> {
  const [row] = await tx<ChallanRow[]>`
    select ${tx.unsafe(CHALLAN_COLUMNS)}
    from delivery_challans where id = ${challanId}
    for update
  `;
  if (!row) throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
  return row;
}

export interface LinkedPurchaseOrderLock {
  readonly id: string;
  readonly status: string;
  readonly po_number: string | null;
}

/** Locks every PO linked by this challan's lines in stable id order. Call
 * before locking the challan itself: PO close uses purchase_orders ->
 * delivery_challans, so this shared order prevents a close/cancel cycle. */
export async function lockLinkedPurchaseOrdersForChallan(
  tx: TransactionSql,
  challanId: string,
): Promise<LinkedPurchaseOrderLock[]> {
  return tx<LinkedPurchaseOrderLock[]>`
    select po.id, po.status, po.po_number
    from purchase_orders po
    where po.id in (
      select pol.purchase_order_id
      from delivery_challan_items dci
      join purchase_order_lines pol on pol.id = dci.purchase_order_line_id
      where dci.delivery_challan_id = ${challanId}
    )
    order by po.id
    for update
  `;
}

/** Revalidates the immutable issued-line link set after the challan lock. */
export async function assertLinkedPurchaseOrderLocksCurrent(
  tx: TransactionSql,
  challanId: string,
  lockedOrders: readonly LinkedPurchaseOrderLock[],
): Promise<void> {
  const current = await tx<{ id: string }[]>`
    select po.id
    from purchase_orders po
    where po.id in (
      select pol.purchase_order_id
      from delivery_challan_items dci
      join purchase_order_lines pol on pol.id = dci.purchase_order_line_id
      where dci.delivery_challan_id = ${challanId}
    )
    order by po.id
  `;
  if (
    current.length !== lockedOrders.length ||
    current.some((row, index) => row.id !== lockedOrders[index]?.id)
  ) {
    throw httpError(
      409,
      'CHALLAN_PO_LINK_CHANGED',
      'The challan receipt links changed concurrently; retry the operation.',
    );
  }
}

/** A receipt release makes a formerly complete PO incomplete. Reopen every
 * linked closed order atomically and leave a durable audit explanation. */
export async function reopenClosedPurchaseOrders(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  challan: { id: string; challan_number: string | null },
  note: string,
  linkedOrders: readonly LinkedPurchaseOrderLock[],
): Promise<void> {
  for (const order of linkedOrders) {
    if (order.status !== 'closed') continue;
    awa×^yîÚ$z{-®éÜj×&—F–öå÷6æ6†÷BÀ¢Væ—C¢Æ–æRçVæ—E÷6æ6†÷BÀ¢VçF—G“¢Æ–æRçVçF—G’À¢&FS¢6æöæ–6Å&FUFW‡B†Æ–æRç&FU÷6æ6†÷B’À¢Æ–æTÖ÷VçC¢Æ–æRæÆ–æUöÖ÷VçBÀ¢Ò’’À¢F÷FÄÖ÷VçC¢F÷FÃòæÖ÷VçBóòsãrÀ¢âââ‡v'&çG’ÓÒVæFVf–æVBò²v'&çG’Ò¢·Ò’À¢Ó° ¢v—BG† ¢WFFRFVÆ—fW'•ö6†ÆÆç0¢6WB7FGW2Òv—77VVBrÂ6†ÆÆåöçVÖ&W"ÒG¶6†ÆÆäçVÖ&W'ÒÀ¢6WVVæ6UöçVÖ&W"ÒG·6WVVæ6WÒÀ¢—77VVE÷6æ6†÷BÒG¶§6öæ"‡G‚Â6æ6†÷B—ÒÀ¢—77VVEö'•÷W6W%ö–BÒG·W6W"æ–GÒÂ—77VVEöBÒG¶—77VVDGÒÀ¢FV×ÆFU÷fW'6–öâÒG´4„ÄÄåõDTÕÄDUõdU%4”ôçÒÀ¢v'&çG•÷FV×ÆFU÷fW'6–öâÒG·v'&çG“òçFV×ÆFUfW'6–öâóòçVÆÇÒÀ¢v'&çG•÷FW‡E÷6†#SbÒG·v'&çG“òçFW‡E6†#SbóòçVÆÇĞ¢v†W&R–BÒG¶–GĞ¢æ6F6‚‚†W'&÷#¢Væ¶æ÷vâ’Óâ°¢–b†W'&÷"–ç7Fæ6VöbW'&÷"bbv6öFRr–âW'&÷"bbW'&÷"æ6öFRÓÓÒs#3SRr’°¢F‡&÷r‡GGW'&÷"€¢C’À¢tåTÔ$U%ô4ôädÄ”5BrÀ¢6†ÆÆâçVÖ&W"G¶6†ÆÆäçVÖ&W'ÒÇ&VG’W†—7G2–âF†—2÷&væ—6F–öã²W6RF—7F–æ7B&Vf—‚f÷"F†—2v÷&²æÀ¢“°¢Ğ¢F‡&÷rW'&÷#°¢Ò“° ¢v—BVF—D6†ÆÆâ‡G‚Â÷&væ—6F–öä–BÂW6W"æ–BÂv6†ÆÆâæ—77VVBrÂ–BÂ°¢6†ÆÆäçVÖ&W"À¢6WVVæ6RÀ¢F÷FÄÖ÷VçC¢6æ6†÷BçF÷FÄÖ÷VçBÀ¢Ò“°¢&WGW&â&VDFWF–Â‡G‚Â–B“°¢ÒÀ¢“°¢&WGW&â&WÇ’ç7FGW2ƒ#’ç6VæB†FWF–Â“°¢ÒÀ¢“° ¢ç÷7B€¢rö’ö6†ÆÆç2ó¦–Bö6æ6VÂrÀ¢°¢66†VÖ¢°¢&×3¢–E&×566†VÖÀ¢&öG“¢6æ6VÄ6†ÆÆå&WVW7E66†VÖÀ¢&W7öç6S¢²#¢6†ÆÆäFWF–Å&W7öç6U66†VÖÂââæW'&÷%&W7öç6W2ÒÀ¢ÒÀ¢ÒÀ¢7–æ2‡&WVW7B’Óâ°¢6öç7BW6W"Òv—B&WV—&UW6W"†WF‚Â&WVW7B“°¢6öç7B÷&væ—6F–öä–BÒ&WV—&T÷&væ—6F–öä†VFW"€¢&WVW7Bæ†VFW'5²w‚Ö÷&væ—6F–öâÖ–BuÒÀ¢“°¢6öç7B²–BÒÒ&WVW7Bç&×22²–C¢7G&–ærÓ°¢6öç7B&öG’Ò&WVW7Bæ&öG’26æ6VÄ6†ÆÆå&WVW7C°¢6öç7Bæ÷FRÒ6æ6VÆÆF–öäæ÷FR†&öG’ææ÷FR“°¢&WGW&âv—F„&÷VæEFVæçB†FF&6RÂ÷&væ—6F–öä–BÂW6W"æ–BÂ7–æ2‡G‚’Óâ°¢v—B&WV—&TWF†÷&—G’‡G‚ÂW6W"æ–BÂv6æ6VÂr“°¢6öç7B¶6†ÆÆå&VeÒÒv—BGƒÇ²v÷&µö–C¢7G&–ærÕµÓæ ¢6VÆV7Bv÷&µö–Bg&öÒFVÆ—fW'•ö6†ÆÆç2v†W&R–BÒG¶–GĞ¢°¢–b‚6†ÆÆå&Vb’°¢F‡&÷r‡GGW'&÷"ƒCBÂt4„ÄÄåôäõEôdõTäBrÂtæò7V6‚FVÆ—fW'’6†ÆÆââr“°¢Ğ¢v—B76W'Ev÷&´66W72‡G‚ÂW6W"æ–BÂ6†ÆÆå&Vbçv÷&µö–B“°¢òò6Æ÷6–æròÆö6·2W&6†6Uö÷&FW'2ÓâÆ–æ¶VBFVÆ—fW'•ö6†ÆÆç2à¢òòF¶RF†R–FVçF–6Â÷&FW"†W&R&Vf÷&RÆö6¶–ærF†—26†ÆÆâÂ6ò¢òò&V6V—B&VÆV6R6â&V÷VâWfW'’ffV7FVBòv—F†÷WBFVFÆö6²à¢òò—77VVB6†ÆÆâÆ–æW2&R–Ö×WF&ÆS²F†R6V6öæB&VB&VÆ÷rFWFV7G0¢òòâW†6WF–öæÂ6öæ7W'&VçB&rÕ5ÂÆ–æ²6†ævRæBf–Ç2Fò&WG'’à¢6öç7BÆ–æ¶VD÷&FW'2Òv—BÆö6´Æ–æ¶VEW&6†6T÷&FW'4f÷$6†ÆÆâ‡G‚Â–B“°¢6öç7B6†ÆÆâÒv—BÆö6´6†ÆÆâ‡G‚Â–B“°¢v—B76W'Ev÷&´66W72‡G‚ÂW6W"æ–BÂ6†ÆÆâçv÷&µö–B“°¢&WV—&U7FGW2†6†ÆÆâÂv—77VVBr“°¢v—B76W'DÆ–æ¶VEW&6†6T÷&FW$Æö6·47W'&VçB‡G‚Â–BÂÆ–æ¶VD÷&FW'2“°¢òò#ƒ¢6æ6VÆÆ–ærF†—26†ÆÆâv÷VÆBG&÷F†RFVÆ—fW&VBVçF—G¢òòF†R6ö×ÆWF–öâ&VF–6FRv2ÖV7W&VBv–ç7BÂÆVf–ærv÷&°¢òòF†B6—2v6ö×ÆWFVBr&VÆ÷rRW†V7WFVBâÆö6²÷&FW"—2F†P¢òò7&VF–öâF‡2r(	BFö7VÖVçB&÷rf—'7BÂF†Vâv÷&·2(	B6ò6æ6VÀ¢òòæB6ö×ÆWF–öâ6W&–Æ—6R–ç7FVBöbFVFÆö6¶–ærÂæBF†R3 ¢òò6†ÆÆâ×WFFRwV&B&6·7F÷2F†R&VgW6Â–âF†RFF&6Rà¢6öç7B·v÷&µÒÒv—BGƒÇ²7FGW3¢7G&–ærÕµÓæ ¢6VÆV7B7FGW2g&öÒv÷&·0¢v†W&R–BÒG¶6†ÆÆâçv÷&µö–GÒæBFVÆWFVEöB—2çVÆÀ¢f÷"WFFP¢°¢–b‚v÷&²’F‡&÷r‡GGW'&÷"ƒCBÂutõ$µôäõEôdõTäBrÂtæò7V6‚v÷&²âr“°¢76W'Ev÷&´÷W&&ÆR‡v÷&²ç7FGW2Âv6æ6VÆÆ–ærFVÆ—fW'’6†ÆÆâr“°¢òò&V6V—fVBvööG26ææ÷B&RVâÖFVÆ—fW&VC¢öæ6R&V6V—BÂ6W&–ÂÀ¢òò÷"ÖV7W&VÖVçB&öö²VçG'’&VfW&Væ6W2F†—26†ÆÆâÂ6æ6VÆÆF–öà¢òò—2f÷&&–FFVâ‡öÆ–7’##bÓ‚Óƒ²F†RD"G&–vvW"&6·2F†—2W’à¢6öç7B¶Wf–FVæ6UÒÒv—BGƒÀ¢²&V6V—G3¢7G&–æs²6W&–Ç3¢7G&–æs²ÖV7W&VÖVçG3¢7G&–ærÕµĞ¢æ ¢6VÆV7@¢‡6VÆV7B6÷VçB‚¢’g&öÒ6†ÆÆå÷&V6V—G0¢v†W&RFVÆ—fW'•ö6†ÆÆåö–BÒG¶–GÒ“£§FW‡B2&V6V—G2À¢‡6VÆV7B6÷VçB‚¢’g&öÒ6†ÆÆåö—FVÕ÷6W&–Ç0¢v†W&RFVÆ—fW'•ö6†ÆÆåö–BÒG¶–GÒ“£§FW‡B26W&–Ç2À¢‡6VÆV7B6÷VçB‚¢’g&öÒÖ%öVçG&–W0¢v†W&RFVÆ—fW'•ö6†ÆÆåö–BÒG¶–GÒ“£§FW‡B2ÖV7W&VÖVçG0¢°¢–b€¢Wf–FVæ6Rb`¢†Wf–FVæ6Rç&V6V—G2ÓÒsrÇÀ¢Wf–FVæ6Rç6W&–Ç2ÓÒsrÇÀ¢Wf–FVæ6RæÖV7W&VÖVçG2ÓÒsr¢’°¢F‡&÷r‡GGW'&÷"€¢C’À¢t4„ÄÄåô„5ôUd”DTä4RrÀ¢uF†—26†ÆÆâ†2&V6÷&FVB&V6V—BÂ6W&–Ç2Â÷"ÖV7W&VÖVçG2æB6âæòÆöævW"&R6æ6VÆÆVBârÀ¢“°¢Ğ¢òò#“¢6†ÆÆâ&–ÆÆVB–âÆ—fRÖV7W&VÖVçB&öö²6ææ÷B&P¢òò6æ6VÆÆVB(	BF†RÔ"×W7B&R6æ6VÆÆVBf—'7B‡F†R#BFF&6P¢òòwV&B&6·7F÷2F†—2v–ç7BWfW'’w&—FW"’à¢v—B76W'E6÷W&6Tæ÷D&–ÆÆVB‡G‚ÂvFVÆ—fW'•ö6†ÆÆârÂ–B“°¢v—BG† ¢WFFRFVÆ—fW'•ö6†ÆÆç0¢6WB7FGW2Òv6æ6VÆÆVBrÂ6æ6VÆÆVEö'•÷W6W%ö–BÒG·W6W"æ–GÒÀ¢6æ6VÆÆVEöBÒæ÷r‚’Â6æ6VÆÆF–öåöæ÷FRÒG¶æ÷FWĞ¢v†W&R–BÒG¶–GĞ¢°¢v—BVF—D6†ÆÆâ‡G‚Â÷&væ—6F–öä–BÂW6W"æ–BÂv6†ÆÆâæ6æ6VÆÆVBrÂ–BÂ°¢6†ÆÆäçVÖ&W#¢6†ÆÆâæ6†ÆÆåöçVÖ&W"À¢æ÷FRÀ¢Ò“°¢òò6Æ÷6VBòv†÷6R&V6V—Bv2§W7B&VÆV6VB×W7B&V6öÖR&V6V—f&ÆP¢òòv–ââ÷F†W'v—6R—G2Æ—fR&Ææ6R6†÷w2VæF–ærÖFW&–Âv†–ÆRF†P¢òò6†ÆÆâVF—F÷"&VgW6W2F†R&WÆ6VÖVçB&V6V—B2õôäõEô•55TTBà¢v—B&V÷Vä6Æ÷6VEW&6†6T÷&FW'2€¢G‚À¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢²–BÂ6†ÆÆåöçVÖ&W#¢6†ÆÆâæ6†ÆÆåöçVÖ&W"ÒÀ¢æ÷FRÀ¢Æ–æ¶VD÷&FW'2À¢“°¢&WGW&â&VDFWF–Â‡G‚Â–B“°¢Ò“°¢ÒÀ¢“° ¢ç÷7B€¢rö’ö6†ÆÆç2ó¦–B÷&VæFW"rÀ¢°¢66†VÖ¢°¢&×3¢–E&×566†VÖÀ¢&W7öç6S¢²#¢6†ÆÆäFWF–Å&W7öç6U66†VÖÂââæW'&÷%&W7öç6W2ÒÀ¢ÒÀ¢ÒÀ¢7–æ2‡&WVW7B’Óâ°¢6öç7BW6W"Òv—B&WV—&UW6W"†WF‚Â&WVW7B“°¢6öç7B÷&væ—6F–öä–BÒ&WV—&T÷&væ—6F–öä†VFW"€¢&WVW7Bæ†VFW'5²w‚Ö÷&væ—6F–öâÖ–BuÒÀ¢“°¢6öç7B²–BÒÒ&WVW7Bç&×22²–C¢7G&–ærÓ° ¢òò6æ6†÷B&VBæBDbw&—FRÆ—fR–â6W&FRG&ç67F–öç26òF†P¢òò6Æ÷rW‡FW&æÂ6ÆÂ†öÆG2æòFF&6RÆö6·3²F†RÆVvÂ6öçFVçB—0¢òòF†R–Ö×WF&ÆR—77VVB6æ6†÷BÂ6ò&R×&VæFW&–ær&W&öGV6W2F†P¢òò&V6÷&Bâ'&æF–ær†ÆövòÂ6ö×ç’FWF–Ç2’—2&W6VçFF–öâæ@¢òò6öÖW2g&öÒF†R÷&væ—6F–öâw27W'&VçB&öf–ÆRà¢6öç7B²6æ6†÷BÂ'&æF–ærÒÒv—Bv—F„&÷VæEFVæçB€¢FF&6RÀ¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢7–æ2‡G‚’Óâ°¢v—B&WV—&Uw&—FW%&öÆR‡G‚ÂW6W"æ–B“°¢6öç7B6†ÆÆâÒv—BÆö6´6†ÆÆâ‡G‚Â–B“°¢v—B76W'Ev÷&´66W72‡G‚ÂW6W"æ–BÂ6†ÆÆâçv÷&µö–B“°¢&WV—&U7FGW2†6†ÆÆâÂv—77VVBr“°¢6öç7B·&÷uÒÒv—BGƒÇ²—77VVE÷6æ6†÷C¢Væ¶æ÷vâÕµÓæ ¢6VÆV7B—77VVE÷6æ6†÷Bg&öÒFVÆ—fW'•ö6†ÆÆç2v†W&R–BÒG¶–GĞ¢°¢6öç7B¶÷&væ—6F–öåÒÒv—BGƒÀ¢°¢FG&W73¢7G&–ærÂçVÆÃ°¢w7F–ã¢7G&–ærÂçVÆÃ°¢6öçF7E÷†öæS¢7G&–ærÂçVÆÃ°¢6öçF7EöVÖ–Ã¢7G&–ærÂçVÆÃ°¢Æövõöö&¦V7Eö¶W“¢7G&–ærÂçVÆÃ°¢ÆövõöÖVF–÷G—S¢7G&–ærÂçVÆÃ°¢ÕµĞ¢æ ¢6VÆV7BFG&W72Âw7F–âÂ6öçF7E÷†öæRÂ6öçF7EöVÖ–ÂÀ¢Æövõöö&¦V7Eö¶W’ÂÆövõöÖVF–÷G—P¢g&öÒ÷&væ—6F–öç0¢°¢&WGW&â°¢6æ6†÷C¢'6T§6öæ$6öÇVÖâ‡&÷sòæ—77VVE÷6æ6†÷B’26†ÆÆå6æ6†÷BÀ¢'&æF–æs¢÷&væ—6F–öâóòçVÆÂÀ¢Ó°¢ÒÀ¢“° ¢ÆWBÆövôFFW&“¢7G&–ærÂVæFVf–æVC°¢–b†'&æF–æsòæÆövõöö&¦V7Eö¶W’bb'&æF–æræÆövõöÖVF–÷G—R’°¢G'’°¢6öç7BÆövòÒv—B7F÷&vRævWB†'&æF–æræÆövõöö&¦V7Eö¶W’“°¢ÆövôFFW&’ÒFF¢G¶'&æF–æræÆövõöÖVF–÷G—WÓ¶&6ScBÂG¶ÆövòçFõ7G&–ær‚v&6ScBr—Ö°¢Ò6F6‚†W'&÷"’°¢òòÖ—76–ærÆövòö&¦V7B×W7Bæ÷B&Æö6²â—77VVBFö7VÖVçBà¢&WVW7BæÆörçv&â‡²W'#¢W'&÷"ÒÂv6†ÆÆâ&VæFW#¢ÆövòVæf–Æ&ÆRr“°¢Ğ¢Ğ¢6öç7B‡FÖÂÒ&VæFW$6†ÆÆä‡FÖÂ‡6æ6†÷BÂ°¢âââ†ÆövôFFW&’ÓÒVæFVf–æVBò²ÆövôFFW&’Ò¢·Ò’À¢FG&W73¢'&æF–æsòæFG&W72óòçVÆÂÀ¢w7F–ã¢'&æF–æsòæw7F–âóòçVÆÂÀ¢6öçF7E†öæS¢'&æF–æsòæ6öçF7E÷†öæRóòçVÆÂÀ¢6öçF7DVÖ–Ã¢'&æF–æsòæ6öçF7EöVÖ–ÂóòçVÆÂÀ¢Ò“°¢6öç7Bf÷&ÒÒæWrf÷&ÔFF‚“°¢f÷&ÒæVæB‚vf–ÆW2rÂæWr&Æö"…¶‡FÖÅÒÂ²G—S¢wFW‡Bö‡FÖÂrÒ’Âv–æFW‚æ‡FÖÂr“°¢ÆWBFc¢'VffW#°¢G'’°¢6öç7B&W7öç6RÒv—BfWF6‚†G¶v÷FVæ&W&uW&ÇÒöf÷&×2ö6‡&öÖ—VÒö6öçfW'Bö‡FÖÆÂ°¢ÖWF†öC¢uõ5BrÀ¢&öG“¢f÷&ÒÀ¢Ò“°¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"†v÷FVæ&W&rç7vW&VBGµ7G&–ær‡&W7öç6Rç7FGW2—Ö“°¢Ğ¢FbÒ'VffW"æg&öÒ†v—B&W7öç6Ræ'&”'VffW"‚’“°¢Ò6F6‚†W'&÷"’°¢&WVW7BæÆöræW'&÷"‡²W'#¢W'&÷"ÒÂv6†ÆÆâ&VæFW"f–ÆVBr“°¢F‡&÷r‡GGW'&÷"€¢S"À¢u$TäDU%ôd”ÄTBrÀ¢uF†RDb6W'f–6R—2Væf–Æ&ÆS²F†R—77VVB6†ÆÆâ—2VæffV7FVB(	B&WG'’ÆFW"ârÀ¢“°¢Ğ¢6öç7B6†#SbÒ7&VFT†6‚‚w6†#Sbr’çWFFR‡Fb’æF–vW7B‚v†W‚r“°¢6öç7Bö&¦V7D¶W’ÒG¶÷&væ—6F–öä–GÒöF2òG¶–GÒçFf°¢v—B7F÷&vRçWB†ö&¦V7D¶W’ÂFb“° ¢&WGW&âv—F„&÷VæEFVæçB†FF&6RÂ÷&væ—6F–öä–BÂW6W"æ–BÂ7–æ2‡G‚’Óâ°¢6öç7BWFFVBÒv—BG† ¢WFFRFVÆ—fW'•ö6†ÆÆç0¢6WB&VæFW&VEöö&¦V7Eö¶W’ÒG¶ö&¦V7D¶W—ÒÂ&VæFW&VE÷6†#SbÒG·6†#SgĞ¢v†W&R–BÒG¶–GÒæB7FGW2Òv—77VVBp¢°¢–b‡WFFVBæ6÷VçBÓÓÒ’°¢òòF†R6†ÆÆâ7F÷VB&V–ær—77VVBv†–ÆRv÷FVæ&W&r&VæFW&VC²F†P¢òò7F÷&VBDb—2â÷'†âÂæ÷BWf–FVæ6R(	BæòVF—BVçG'’à¢F‡&÷r‡GGW'&÷"€¢C’À¢t4„ÄÄåõ5DEU5ô4ôädÄ”5BrÀ¢uF†R6†ÆÆâ—2æòÆöævW"—77VVC²F†R&VæFW"v2F—66&FVBârÀ¢“°¢Ğ¢v—BVF—D6†ÆÆâ‡G‚Â÷&væ—6F–öä–BÂW6W"æ–BÂv6†ÆÆâç&VæFW&VBrÂ–BÂ°¢6†#SbÀ¢Ò“°¢&WGW&â&VDFWF–Â‡G‚Â–B“°¢Ò“°¢ÒÀ¢“° ¢ç÷7B€¢rö’ö6†ÆÆç2ó¦–B÷6–væVBÖ6÷’rÀ¢°¢&öG”Æ–Ö—C¢Ô…õDeô%•DU2À¢66†VÖ¢°¢&×3¢–E&×566†VÖÀ¢&W7öç6S¢²#¢6†ÆÆäFWF–Å&W7öç6U66†VÖÂââæW'&÷%&W7öç6W2ÒÀ¢ÒÀ¢ÒÀ¢7–æ2‡&WVW7B’Óâ°¢6öç7BW6W"Òv—B&WV—&UW6W"†WF‚Â&WVW7B“°¢6öç7B÷&væ—6F–öä–BÒ&WV—&T÷&væ—6F–öä†VFW"€¢&WVW7Bæ†VFW'5²w‚Ö÷&væ—6F–öâÖ–BuÒÀ¢“°¢6öç7B²–BÒÒ&WVW7Bç&×22²–C¢7G&–ærÓ°¢6öç7B&öG’Ò&WVW7Bæ&öG“°¢–b‚'VffW"æ—4'VffW"†&öG’’ÇÂ&öG’æÆVæwF‚ÓÓÒ’°¢F‡&÷r‡GGW'&÷"€¢CÀ¢uDeõ$UT•$TBrÀ¢u6VæBF†R6–væVB6÷’2âÆ–6F–öâ÷Fb&WVW7B&öG’ârÀ¢“°¢Ğ¢–b‚&öG’ç7V&'&’ƒÂDeôÔt”2æÆVæwF‚’æWVÇ2…DeôÔt”2’’°¢F‡&÷r‡GGW'&÷"ƒCÂtäõEôõDbrÂuF†RWÆöFVBf–ÆR—2æ÷BDbâr“°¢Ğ¢òòWF†÷&—6F–öâ&Vf÷&RF†RW‡Vç6—fR66â†÷2&F6‚“¢à¢òòVæWF†÷&—6VB6ÆÆW"×W7Bæ÷B7VæB66ææW"66—G’à¢v—Bv—F„&÷VæEFVæçB†FF&6RÂ÷&væ—6F–öä–BÂW6W"æ–BÂ7–æ2‡G‚’Óâ°¢v—B&WV—&Uw&—FW%&öÆR‡G‚ÂW6W"æ–B“°¢Ò“°¢v—B76W'Dæ÷DÖÇv&R‡66ææW"Â&öG’“°¢òò6öçFVçBÖFG&W76VB¶W“¢&WÆ6VÖVçBWÆöBvWG2æWrö&¦V7Bæ@¢òòæWfW"÷fW'w&—FW2V&Æ–W"Wf–FVæ6S²F†R†6‚—2&V6÷&FVBÆ–¶RF†P¢òò&VæFW&VBDbw2à¢6öç7B6–væVE6†#SbÒ7&VFT†6‚‚w6†#Sbr’çWFFR†&öG’’æF–vW7B‚v†W‚r“°¢6öç7Bö&¦V7D¶W’ÒG¶÷&væ—6F–öä–GÒ÷6–væVBòG¶–GÒÒG·6–væVE6†#Sbç6Æ–6RƒÂb—ÒçFf°¢&WGW&âv—F„&÷VæEFVæçB†FF&6RÂ÷&væ—6F–öä–BÂW6W"æ–BÂ7–æ2‡G‚’Óâ°¢v—B&WV—&Uw&—FW%&öÆR‡G‚ÂW6W"æ–B“°¢6öç7B6†ÆÆâÒv—BÆö6´6†ÆÆâ‡G‚Â–B“°¢v—B76W'Ev÷&´66W72‡G‚ÂW6W"æ–BÂ6†ÆÆâçv÷&µö–B“°¢&WV—&U7FGW2†6†ÆÆâÂv—77VVBr“°¢v—B7F÷&vRçWB†ö&¦V7D¶W’Â&öG’“°¢v—BG† ¢WFFRFVÆ—fW'•ö6†ÆÆç0¢6WB6–væVEö6÷•öö&¦V7Eö¶W’ÒG¶ö&¦V7D¶W—ÒÀ¢6–væVEö6÷•÷6†#SbÒG·6–væVE6†#SgĞ¢v†W&R–BÒG¶–GĞ¢°¢v—BVF—D6†ÆÆâ€¢G‚À¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢v6†ÆÆâç6–væVEö6÷•÷WÆöFVBrÀ¢–BÀ¢²6—¦T'—FW3¢&öG’æÆVæwF‚Â6†#Sc¢6–væVE6†#SbÒÀ¢“°¢&WGW&â&VDFWF–Â‡G‚Â–B“°¢Ò“°¢ÒÀ¢“° ¢ævWB€¢rö’ö6†ÆÆç2ó¦–B÷FbrÀ¢°¢66†VÖ¢²&×3¢–E&×566†VÖÂVW'—7G&–æs¢FeVW'•66†VÖÒÀ¢ÒÀ¢7–æ2‡&WVW7BÂ&WÇ’’Óâ°¢6öç7BW6W"Òv—B&WV—&UW6W"†WF‚Â&WVW7B“°¢6öç7B÷&væ—6F–öä–BÒ&WV—&T÷&væ—6F–öä†VFW"€¢&WVW7Bæ†VFW'5²w‚Ö÷&væ—6F–öâÖ–BuÒÀ¢“°¢6öç7B²–BÒÒ&WVW7Bç&×22²–C¢7G&–ærÓ°¢6öç7B²¶–æBÒw&VæFW&VBrÒÒ&WVW7BçVW'’2²¶–æCó¢w&VæFW&VBrÂw6–væVBrÓ°¢6öç7B¶W’Òv—Bv—F„&÷VæEFVæçB€¢FF&6RÀ¢÷&væ—6F–öä–BÀ¢W6W"æ–BÀ¢7–æ2‡G‚’Óâ°¢6öç7B·&÷uÒÒv—BGƒÀ¢°¢v÷&µö–C¢7G&–æs°¢&VæFW&VEöö&¦V7Eö¶W“¢7G&–ærÂçVÆÃ°¢6–væVEö6÷•öö&¦V7Eö¶W“¢7G&–ærÂçVÆÃ°¢ÕµĞ¢æ ¢6VÆV7Bv÷&µö–BÂ&VæFW&VEöö&¦V7Eö¶W’Â6–væVEö6÷•öö&¦V7Eö¶W¢g&öÒFVÆ—fW'•ö6†ÆÆç2v†W&R–BÒG¶–GĞ¢°¢–b‚&÷r’°¢F‡&÷r‡GGW'&÷"ƒCBÂt4„ÄÄåôäõEôdõTäBrÂtæò7V6‚FVÆ—fW'’6†ÆÆââr“°¢Ğ¢v—B76W'Ev÷&´66W72‡G‚ÂW6W"æ–BÂ&÷rçv÷&µö–B“°¢6öç7Bf÷VæBĞ¢¶–æBÓÓÒw&VæFW&VBrò&÷rç&VæFW&VEöö&¦V7Eö¶W’¢&÷rç6–væVEö6÷•öö&¦V7Eö¶W“°¢–b†f÷VæBÓÓÒçVÆÂ’°¢F‡&÷r‡GGW'&÷"€¢CBÀ¢uDeôäõEôd”Ä$ÄRrÀ¢¶–æBÓÓÒw&VæFW&VBp¢òuF†—26†ÆÆâ†2æ÷B&VVâ&VæFW&VB–WBâp¢¢tæò6–væVB6÷’†2&VVâWÆöFVBf÷"F†—26†ÆÆâârÀ¢“°¢Ğ¢&WGW&âf÷VæC°¢ÒÀ¢“°¢6öç7B'—FW2Òv—B7F÷&vRævWB†¶W’“°¢fö–B&WÇ’çG—R‚vÆ–6F–öâ÷Fbr“°¢fö–B&WÇ’æ†VFW"€¢v6öçFVçBÖF—7÷6—F–öârÀ¢–æÆ–æS²f–ÆVæÖSÒ&6†ÆÆâÒG¶–GÒÒG¶¶–æGÒçFb&À¢“°¢&WGW&â&WÇ’ç6VæB†'—FW2“°¢ÒÀ¢“°§Ğ