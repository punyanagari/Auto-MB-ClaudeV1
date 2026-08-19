import { createHash } from 'node:crypto';
import {
  byItemNumber,
  compareItemNumbers,
  CancelChallanRequestSchema,
  ChallanDetailResponseSchema,
  ChallanListResponseSchema,
  DeliveryChallanRegisterQuerySchema,
  DeliveryChallanRegisterResponseSchema,
  KeysetQuerySchema,
  SaveChallanRequestSchema,
  SaveStandaloneChallanRequestSchema,
  WorkBalanceResponseSchema,
  type Challan,
  type ChallanDetailResponse,
  type ChallanItem,
  type ChallanItemInput,
  type ChallanKind,
  type ChallanOverReceiptWarning,
  type Consignee,
  type DeliveryChallanMovement,
  type MovementReason,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope, requireWriterRole } from '../authz.js';
import {
  CHALLAN_TEMPLATE_VERSION,
  WARRANTY_TEMPLATE_VERSION,
  renderChallanHtml,
  type ChallanSnapshot,
} from '../challan-html.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
import { challanEwayEligible } from '../gsp/eway-source.js';
import { httpError } from '../http.js';
import {
  NumberTemplateError,
  loadNumberTemplate,
  renderNumberTemplate,
} from '../number-series.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import {
  cursorRowId,
  keysetPage,
  sqlLimit,
  workScopedCursorRowId,
} from '../pagination.js';
import type { MalwareScanner } from '../malware-scan.js';
import { canonicalRateText } from '../rate-text.js';
import { assertSourceNotBilled } from './measurement-books/index.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
} from '../upload-guards.js';
import type { ObjectStorage } from '@auto-mb/documents';
import { assertWorkOperable } from '../work-status.js';
import { financialYearLabel } from '../financial-year.js';
import {
  audit,
  IdParamsSchema,
  receivedQuantitySql,
  upstreamErrorResponses as errorResponses,
} from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import { renderPdfViaGotenberg } from '../pdf-render.js';

const PdfQuerySchema = Type.Object(
  {
    kind: Type.Optional(Type.Union([Type.Literal('rendered'), Type.Literal('signed')])),
  },
  { additionalProperties: false },
);

interface ChallanRow {
  id: string;
  work_id: string | null;
  challan_kind: ChallanKind;
  consignee_contact_id: string | null;
  fy_label: string | null;
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
  movement_reason: MovementReason | null;
  consignee_gstin: string | null;
  transporter_id: string | null;
  transporter_name: string | null;
  vehicle_number: string | null;
  transport_doc_number: string | null;
  transport_doc_date: string | null;
  transport_distance_km: number | null;
  created_at: Date;
  issued_at: Date | null;
  cancelled_at: Date | null;
}

const CHALLAN_COLUMNS = `
  id, work_id, challan_kind, consignee_contact_id, fy_label,
  status, challan_date::text as challan_date, challan_number,
  sequence_number, prefix, consignee_snapshot, template_version,
  warranty_template_version, warranty_text_sha256,
  rendered_object_key, signed_copy_object_key, cancellation_note,
  movement_reason, consignee_gstin, transporter_id, transporter_name,
  vehicle_number, transport_doc_number,
  transport_doc_date::text as transport_doc_date, transport_distance_km,
  created_at, issued_at, cancelled_at
`;

function toChallan(row: ChallanRow): Challan {
  return {
    id: row.id,
    workId: row.work_id,
    kind: row.challan_kind,
    consigneeContactId: row.consignee_contact_id,
    fyLabel: row.fy_label,
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
    movementReason: row.movement_reason,
    consigneeGstin: row.consignee_gstin,
    transporterId: row.transporter_id,
    transporterName: row.transporter_name,
    vehicleNumber: row.vehicle_number,
    transportDocNumber: row.transport_doc_number,
    transportDocDate: row.transport_doc_date,
    transportDistanceKm: row.transport_distance_km,
  };
}

interface ChallanItemRow {
  id: string;
  work_item_id: string | null;
  description_snapshot: string;
  unit_snapshot: string;
  quantity: string;
  rate_snapshot: string;
  line_amount: string;
  position: number;
  purchase_order_line_id: string | null;
  hsn_sac_code: string | null;
  is_service: boolean | null;
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
    hsnSacCode: row.hsn_sac_code,
    isService: row.is_service,
  };
}

async function readItems(
  tx: TransactionSql,
  challanId: string,
): Promise<ChallanItem[]> {
  const rows = await tx<ChallanItemRow[]>`
    select id, work_item_id, description_snapshot, unit_snapshot,
           quantity::text as quantity, rate_snapshot::text as rate_snapshot,
           line_amount::text as line_amount, position, purchase_order_line_id,
           hsn_sac_code, is_service
    from delivery_challan_items
    where delivery_challan_id = ${challanId}
    order by position
  `;
  return rows.map(toChallanItem);
}

/**
 * The over-receipt notices for this challan's purchase-order-linked
 * lines, one per purchase-order line, in exact SQL numeric arithmetic
 * (rule 5). `received` counts receipts recorded ELSEWHERE plus this
 * challan's own lines — the projection while this challan is a draft and
 * the actual total once it is issued (its own lines are then part of the
 * settled sum, so the two readings agree). Over-receipt is deliberately a
 * WARNING, never a refusal: vendors over-ship, and the delivery document
 * must record what actually arrived (the purchase-order balance already
 * floors its pending figure at zero, purchase-orders.ts readLines).
 *
 * "Elsewhere" comes from the shared `receivedQuantitySql` fragment rather
 * than a fourth copy of the arithmetic, so this warning and the balance
 * that decides whether the order may be CLOSED can never disagree about
 * what has arrived. The fragment also owns the channel rule (0087): a
 * line that names a part is stock-received and a line that does not is
 * challan-received, and a challan item pointing at a stock line is
 * refused at the database, so the branch this reader does not use cannot
 * hold a row.
 */
async function readOverReceiptWarnings(
  tx: TransactionSql,
  challanId: string,
): Promise<ChallanOverReceiptWarning[]> {
  const rows = (await tx.unsafe(
    `select pol.id as purchase_order_line_id, po.po_number, pol.line_number,
            pol.description, pol.quantity::text as ordered_quantity,
            (elsewhere.received + own.quantity)
              ::numeric(18,3)::text as received_quantity
     from (
       select dci.purchase_order_line_id as pol_id, sum(dci.quantity) as quantity
       from delivery_challan_items dci
       where dci.delivery_challan_id = $1
         and dci.purchase_order_line_id is not null
       group by dci.purchase_order_line_id
     ) own
     join purchase_order_lines pol on pol.id = own.pol_id
     join purchase_orders po on po.id = pol.purchase_order_id
     cross join lateral (
       select ${receivedQuantitySql({ excludingChallan: '$1' })} as received
     ) elsewhere
     where elsewhere.received + own.quantity > pol.quantity
     order by pol.line_number`,
    [challanId],
  )) as unknown as {
    purchase_order_line_id: string;
    po_number: string;
    line_number: number;
    description: string;
    ordered_quantity: string;
    received_quantity: string;
  }[];
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
  const items = await readItems(tx, challanId);
  return {
    challan: {
      ...toChallan(row),
      // The server's own applicability answer, so the screen offers the
      // e-way bill action exactly where the route would accept it
      // (ADR-0013). It calls the SAME predicate the route gates on —
      // `challanEwayEligible` — which requires the movement reason, every
      // line classified (no half/unclassified line), and at least one goods
      // line. The earlier form omitted the per-line completeness test and
      // so offered Raise on an issued challan with an unclassified line
      // that the route permanently refuses (its facts frozen at issue).
      ewayBillEligible:
        row.challan_kind === 'standalone' &&
        row.status === 'issued' &&
        challanEwayEligible(
          row.movement_reason,
          items.map((item) => ({
            isService: item.isService ?? null,
            hsnSacCode: item.hsnSacCode ?? null,
          })),
        ),
    },
    items,
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
 * timezone (default Asia/Kolkata), not the server clock — an evening
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

/** A standalone challan's date, which has no LOA letter to sit after.
 * "Today" is still the organisation's own timezone (default Asia/Kolkata),
 * not the server clock — an evening entry in India must not be rejected
 * as tomorrow's date. */
async function assertStandaloneChallanDate(
  tx: TransactionSql,
  challanDate: string,
): Promise<void> {
  const [bounds] = await tx<{ today: string }[]>`
    select (now() at time zone o.timezone)::date::text as today
    from organisations o
    where o.id = app_private.current_organisation_id()
  `;
  if (!bounds) throw new Error('organisation missing inside a bound tenant');
  // ISO dates compare correctly as strings.
  if (challanDate > bounds.today) {
    throw httpError(
      400,
      'CHALLAN_DATE_INVALID',
      `The challan date cannot be in the future (today is ${bounds.today}).`,
    );
  }
}

/**
 * Who may reach a challan that belongs to no Work.
 *
 * Work-scope is the product's reach mechanism, and it binds through a
 * Work: an 'assigned'-scoped membership is allowed exactly the Works it
 * is assigned to. A standalone challan has NO Work, so there is nothing
 * for that mechanism to bind to and no assignment that could ever grant
 * it — which means the honest answer is that a scoped membership does not
 * reach standalone challans at all. Full-scope memberships (work_scope
 * <> 'assigned') do; writing and issuing still need the writer role and
 * the issue/cancel authorities on top, exactly as a work challan does.
 *
 * The refusal is 404, not 403, matching assertWorkAccess: a guessed id
 * must not confirm the document exists.
 */
export async function assertStandaloneChallanAccess(
  tx: TransactionSql,
  userId: string,
): Promise<void> {
  if (await hasFullWorkScope(tx, userId)) return;
  throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
}

/** The reach check for a challan of either kind. */
async function assertChallanAccess(
  tx: TransactionSql,
  userId: string,
  challan: { work_id: string | null },
): Promise<void> {
  if (challan.work_id === null) {
    await assertStandaloneChallanAccess(tx, userId);
    return;
  }
  await assertWorkAccess(tx, userId, challan.work_id);
}

/** The Work a challan belongs to, refusing a standalone one by name.
 *
 * Every flow that reads back a challan through a WORK — receipts,
 * corrections, Measurement Book sourcing — needs the Work id and would
 * otherwise be handed a NULL that silently widens or narrows its query.
 * Exported so those callers say the rule instead of discovering it. */
export function requireWorkBoundChallan(challan: { work_id: string | null }): string {
  if (challan.work_id === null) {
    throw httpError(
      400,
      'CHALLAN_NOT_WORK_BOUND',
      'This is a standalone Delivery Challan; it belongs to no Work, so this operation does not apply to it.',
    );
  }
  return challan.work_id;
}

/** True when a DecimalString denotes a value greater than zero, decided
 * on the digits themselves — never binary floating-point arithmetic
 * (engineering rule 5). The schema pattern guarantees the shape, so a
 * leading '-' is the only sign and any non-zero digit means positive.
 *
 * Exported because every writer that refuses a non-positive quantity owes
 * the same answer. The alternative the other routes used, `Number(value)
 * === 0`, is correct only while DecimalStringSchema caps fraction digits
 * at three: widen that cap (RateStringSchema already allows six) and
 * '0.0001' rounds to a positive Number, passes, and lands on the
 * `CHECK (quantity > 0)` in the database as a statusless 23514 the
 * operator reads as 'The request could not be completed.' Digit
 * inspection does not depend on the cap. */
export function isPositiveDecimal(value: string): boolean {
  return !value.startsWith('-') && /[1-9]/.test(value);
}

/** Digits before the decimal point. `delivery_challan_items.quantity` is
 * numeric(18,3), so sixteen of them is a numeric field overflow (22003)
 * in Postgres — the same statusless error a failed CHECK raises. */
function integerDigitCount(value: string): number {
  const [whole = ''] = value.replace('-', '').split('.');
  return whole.length;
}

/** The statutory movement facts of a standalone challan, trimmed the way
 * their CHECKs measure them (migration 0075).
 *
 * A blank string is "not recorded" rather than a validation failure: the
 * editor shows every field, most of them stay empty on most challans, and
 * a form that clears a field by sending "" must be able to. The shapes
 * themselves are the schema's job — the CHECKs on the columns are the
 * backstop for any writer that is not this route.
 *
 * The consignee's GSTIN is defaulted from the contacts master when the
 * caller sends none, which is the only master read that happens here: it
 * is a DRAFT-time copy, frozen at issue like the rest of the consignee
 * block, and never re-read afterwards (rule 7). */
interface ChallanStatutoryInput {
  readonly movementReason?: Challan['movementReason'];
  readonly consigneeGstin?: string;
  readonly transporterId?: string;
  readonly transporterName?: string;
  readonly vehicleNumber?: string;
  readonly transportDocNumber?: string;
  readonly transportDocDate?: string;
  readonly transportDistanceKm?: number;
}

interface NormalisedChallanStatutory {
  readonly movementReason: string | null;
  readonly consigneeGstin: string | null;
  readonly transporterId: string | null;
  readonly transporterName: string | null;
  readonly vehicleNumber: string | null;
  readonly transportDocNumber: string | null;
  readonly transportDocDate: string | null;
  readonly transportDistanceKm: number | null;
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

function normaliseChallanStatutory(
  body: ChallanStatutoryInput,
  contactGstin: string | null,
): NormalisedChallanStatutory {
  const transportDocNumber = blankToNull(body.transportDocNumber);
  const transportDocDate = blankToNull(body.transportDocDate);
  // The 0075 CHECK pairs the two; named here so the operator is told
  // which half is missing rather than reading a statusless 23514.
  if ((transportDocNumber === null) !== (transportDocDate === null)) {
    throw httpError(
      400,
      'TRANSPORT_DOC_REQUIRED',
      'A transport document is a number and a date together — record both, or neither.',
    );
  }
  return {
    movementReason: body.movementReason ?? null,
    // Omitting the field defaults it from the master at draft time; sending
    // it — including an explicit blank — is honoured exactly. The old
    // `blankToNull(...) ?? contactGstin` re-applied the master on a blank,
    // so a deliberate clear on a draft silently pulled the GSTIN back and
    // could never be cleared. `undefined` is "not sent"; '' is "clear".
    consigneeGstin:
      body.consigneeGstin === undefined
        ? contactGstin
        : blankToNull(body.consigneeGstin),
    transporterId: blankToNull(body.transporterId),
    transporterName: blankToNull(body.transporterName),
    vehicleNumber: blankToNull(body.vehicleNumber),
    transportDocNumber,
    transportDocDate,
    transportDistanceKm: body.transportDistanceKm ?? null,
  };
}

/** The consignee block exactly as it will be printed. `ConsigneeSchema`
 * counts RAW characters, so `{name: '  ', address: '   '}` satisfies its
 * minimums, is frozen into the issued snapshot, and reaches the railway
 * as a delivery document with a blank consignee — and `consignee_snapshot`
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
      'The consignee needs a name and an address that are not blank — this challan is printed and handed to the consignee.',
    );
  }
  return { name, address, ...(phone.length > 0 ? { phone } : {}) };
}

interface StandaloneConsignee {
  readonly consignee: Consignee;
  /** The party's GSTIN as the master holds it right now — the default the
   * draft is seeded with, then frozen onto the challan. */
  readonly gstin: string | null;
}

/** The consignee block for a STANDALONE challan, taken from the contacts
 * master and snapshotted onto the document.
 *
 * Rule 7: master-data edits never rewrite history, so the contact is read
 * ONCE — here, while the draft is saved — and frozen into
 * consignee_snapshot exactly like the free-text block a work challan
 * carries. The contact id stays on the row so the register can group by
 * party and the one-open-draft rule has something to count, but nothing
 * downstream re-reads the contact.
 *
 * A retired contact is refused: this document is printed and handed over,
 * and a retired party is one the operator has already said they no longer
 * deal with. An address is required for the same reason the free-text
 * block requires one — it is the delivery address on the paper. */
async function loadStandaloneConsignee(
  tx: TransactionSql,
  contactId: string,
): Promise<StandaloneConsignee> {
  const [contact] = await tx<
    {
      designation: string;
      address: string | null;
      phone: string | null;
      active: boolean;
      gstin: string | null;
    }[]
  >`
    select designation, address, phone, active, gstin
    from contacts where id = ${contactId}
  `;
  if (!contact) {
    throw httpError(404, 'CONTACT_NOT_FOUND', 'No such contact.');
  }
  if (!contact.active) {
    throw httpError(
      409,
      'CONTACT_RETIRED',
      'That consignee has been retired; reactivate it or pick another.',
    );
  }
  if (contact.address === null || contact.address.trim().length < 3) {
    throw httpError(
      400,
      'CONSIGNEE_INVALID',
      'That consignee has no address on record — this challan is printed and handed to the consignee, so add the address to the contact first.',
    );
  }
  const phone = contact.phone?.trim() ?? '';
  return {
    consignee: {
      name: contact.designation.trim(),
      address: contact.address.trim(),
      ...(phone.length > 0 ? { phone } : {}),
    },
    gstin: contact.gstin,
  };
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
      'The cancellation note must say why the record is being cancelled — at least three characters that are not spaces.',
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

interface LinkedPurchaseOrderLock {
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
  const closed = linkedOrders.filter((order) => order.status === 'closed');
  if (closed.length === 0) return;
  // Two statements for the whole set rather than two per order; the
  // orders are already row-locked by the caller, so reopening them
  // together is the same act.
  await tx`
    update purchase_orders
    set status = 'issued', closed_at = null, updated_at = now()
    where id = any(${closed.map((order) => order.id)}::uuid[]) and status = 'closed'
  `;
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    select ${organisationId}, ${userId},
           'purchase_order.reopened_after_challan_cancellation',
           'purchase_orders', reopened.id, reopened.details::jsonb
    from unnest(
      ${closed.map((order) => order.id)}::uuid[],
      ${closed.map((order) =>
        JSON.stringify({
          poNumber: order.po_number,
          challanId: challan.id,
          challanNumber: challan.challan_number,
          cancellationNote: note,
        }),
      )}::text[]
    ) as reopened(id, details)
  `;
}

/** The receipt link (0033): a challan line may name the purchase-order
 * line it fulfils. The named line must belong to an ISSUED order of THIS
 * Work — a draft order has not been placed yet, a closed or cancelled one
 * takes no further receipts, and another Work's procurement answers
 * exactly like an unknown id (the same posture RLS gives another
 * tenant's). What is deliberately NOT checked here is the quantity:
 * over-receipt against the ordered amount is a warning on the read model
 * (readOverReceiptWarnings), never a refusal — vendors over-ship, and the
 * challan must record what actually arrived. The composite FK on
 * (organisation_id, purchase_order_line_id) backstops the existence check
 * in the database.
 *
 * `label` names the offending line the way the caller counts lines, e.g.
 * 'Line 2'. Exported so the correction propose path validates the link at
 * the person who can fix it, rather than discovering it at apply time
 * where the failure rolls the approver's decision back and strands the
 * request as pending.
 *
 * `reopenableOrderIds` is that propose path's one concession: a
 * cancel-and-replace releases the original challan's receipts, so its
 * apply reopens every CLOSED order those receipts closed
 * (reopenClosedPurchaseOrders) before writing the replacement lines. A
 * replacement that keeps a link into one of those orders is therefore
 * lawful even though the order reads 'closed' right now. Any other closed
 * order is refused, because nothing will reopen it. Writers of actual
 * lines pass nothing and hold the strict rule. */
export async function assertPurchaseOrderLineReceivable(
  tx: TransactionSql,
  workId: string,
  purchaseOrderLineId: string,
  label: string,
  reopenableOrderIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  const [poLine] = await tx<{ id: string; status: string; work_id: string }[]>`
    select po.id, po.status, po.work_id
    from purchase_order_lines pol
    join purchase_orders po on po.id = pol.purchase_order_id
    where pol.id = ${purchaseOrderLineId}
  `;
  if (!poLine || poLine.work_id !== workId) {
    throw httpError(
      404,
      'PO_LINE_NOT_FOUND',
      `${label}: the named purchase-order line does not belong to this Work.`,
    );
  }
  const reopenable = poLine.status === 'closed' && reopenableOrderIds.has(poLine.id);
  if (poLine.status !== 'issued' && !reopenable) {
    throw httpError(
      409,
      'PO_NOT_ISSUED',
      `${label}: deliveries are received against an ISSUED purchase order (current status: ${poLine.status}).`,
    );
  }
}

function requireStatus(row: ChallanRow, status: Challan['status']): void {
  if (row.status !== status) {
    throw httpError(
      409,
      'CHALLAN_STATUS_CONFLICT',
      `This operation requires a ${status} challan (current status: ${row.status}).`,
    );
  }
}

/** The statutory classification a line may carry (ADR-0013, migration
 * 0075). Both null on a line that carries none — the pair travels
 * together because a code with no kind cannot be read. */
interface LineStatutoryFacts {
  readonly hsnSacCode: string | null;
  readonly isService: boolean | null;
}

/** One line, resolved to the shape it actually is.
 *
 * A `work_item` line takes description/unit/rate from the live schedule
 * item and is the only shape the quantity ledger sees. A `manual` line
 * carries its own printed text and is inert — non-LOA installation
 * material on a work challan, or the whole of a standalone challan. */
type ResolvedLine =
  | {
      readonly shape: 'work_item';
      readonly workItemId: string;
      readonly quantity: string;
      readonly purchaseOrderLineId: string | null;
      readonly statutory: LineStatutoryFacts;
    }
  | {
      readonly shape: 'manual';
      readonly quantity: string;
      readonly description: string;
      readonly unit: string;
      readonly rate: string;
      readonly statutory: LineStatutoryFacts;
    };

/** The goods marker as an array-safe lexeme. postgres.js serialises a
 * SINGLE-element boolean array as a scalar boolean, and the `::boolean[]`
 * cast then fails with "cannot cast type boolean to boolean[]"; text
 * arrays have no such problem, so the value travels as text and is cast
 * back in the select list. */
function booleanText(value: boolean | null): string | null {
  return value === null ? null : value ? 'true' : 'false';
}

/** The classification as sent, refusing the half-stated pair by name.
 *
 * The database CHECK (0075) refuses it too, but as a statusless 23514
 * that reaches the operator as "The request could not be completed." */
function resolveLineStatutory(
  item: ChallanItemInput,
  label: string,
): LineStatutoryFacts {
  const code = item.hsnSacCode?.trim() ?? '';
  if (code.length === 0 && item.isService === undefined) {
    return { hsnSacCode: null, isService: null };
  }
  if (code.length === 0 || item.isService === undefined) {
    throw httpError(
      400,
      'LINE_SHAPE_INVALID',
      `${label}: an HSN/SAC code and a goods-or-service marker are recorded together — the marker is what says which of the two the code is.`,
    );
  }
  if (item.isService && !/^[0-9]{6}$/.test(code)) {
    throw httpError(
      400,
      'LINE_SHAPE_INVALID',
      `${label}: a service line carries a six-digit SAC; ${code} is not one.`,
    );
  }
  return { hsnSacCode: code, isService: item.isService };
}

/**
 * Decides which shape a request line is, and refuses every mixture BY
 * NAME. The schema admits both shapes in one object precisely so these
 * answers can be specific: a caller who sends a purchase-order link on a
 * manual line has made a domain mistake — a receipt is received against
 * an ordered LOA item — and deserves to be told that, not "body/items/0
 * does not match any allowed shape".
 *
 * `label` names the offending line the way the caller counts lines.
 */
/**
 * Refuses Delivery Challan lines that name an AMC item (migration 0068).
 *
 * Annual maintenance is served over a period and certified by the
 * railway; nothing is despatched, so nothing can appear on a challan. A
 * database trigger holds this against every writer, including raw SQL —
 * but a trigger speaks in `RAISE EXCEPTION` and reaches the operator as
 * an unhandled 500. This is the same refusal with a code, a remedy, and
 * the item numbers in it.
 *
 * Called under the caller's row locks on those items, so the category it
 * reads cannot move before the lines are written.
 */
function assertItemsAreDeliverable(
  items: readonly { item_number: string; payment_category: string | null }[],
): void {
  const amc = items
    .filter((item) => item.payment_category === 'AMC')
    .map((item) => item.item_number)
    .sort();
  if (amc.length === 0) return;
  throw httpError(
    409,
    'ITEM_NOT_DELIVERABLE',
    `${amc.join(', ')} ${amc.length > 1 ? 'are annual maintenance items' : 'is an annual maintenance item'}: maintenance is served and certified, never despatched, so it cannot go on a Delivery Challan. Record the acceptance certificate for the period served instead.`,
    { itemNumbers: amc },
  );
}

function resolveLine(item: ChallanItemInput, label: string): ResolvedLine {
  const manualFields = [item.description, item.unit, item.rate];
  const manualCount = manualFields.filter((value) => value !== undefined).length;

  if (item.workItemId !== undefined) {
    if (manualCount > 0) {
      throw httpError(
        400,
        'LINE_SHAPE_INVALID',
        `${label}: a Work item line takes its description, unit and rate from the schedule item — send them only on a manual line.`,
      );
    }
    return {
      shape: 'work_item',
      workItemId: item.workItemId,
      quantity: item.quantity,
      purchaseOrderLineId: item.purchaseOrderLineId ?? null,
      statutory: resolveLineStatutory(item, label),
    };
  }

  if (item.purchaseOrderLineId !== undefined) {
    // R: a purchase-order receipt is received against an ORDERED item of
    // the Work. A manual line names no such item, so the link has nothing
    // to fulfil and the purchase-order balance would be moved by a line
    // the ledger cannot see.
    throw httpError(
      400,
      'PO_LINE_REQUIRES_WORK_ITEM_LINE',
      `${label}: a purchase-order receipt is recorded against a Work item line; a manual line has no ordered item to receive against.`,
    );
  }

  if (manualCount < manualFields.length) {
    throw httpError(
      400,
      'MANUAL_LINE_INCOMPLETE',
      `${label}: a manual line needs a description, a unit and a rate — this document is printed and handed to the consignee.`,
    );
  }

  const description = (item.description ?? '').trim();
  const unit = (item.unit ?? '').trim();
  if (description.length === 0 || unit.length === 0) {
    throw httpError(
      400,
      'MANUAL_LINE_INCOMPLETE',
      `${label}: the description and unit of a manual line cannot be blank.`,
    );
  }
  return {
    shape: 'manual',
    quantity: item.quantity,
    description,
    unit,
    rate: item.rate ?? '',
    statutory: resolveLineStatutory(item, label),
  };
}

/** Replaces the challan's lines from the request, snapshotting
 * description/unit/rate from the live work items and computing the line
 * amount in exact SQL numeric arithmetic. (Exported for the correction
 * flow, which writes replacement drafts through the same path.)
 *
 * `workId` is null for a standalone challan, where every line must be
 * manual — the migration 0056 trigger holds that against direct SQL and
 * this refuses it by name for API callers. */
export async function writeLines(
  tx: TransactionSql,
  organisationId: string,
  challanId: string,
  workId: string | null,
  body: { items: readonly ChallanItemInput[] },
): Promise<void> {
  // Draft-time serials hang off the line rows being replaced (serial
  // lineage FK); they are draft-stage records — deletable by rule — and
  // cannot outlive their lines, so a line rewrite clears them and they
  // are re-recorded against the new lines before issue.
  await tx`
    delete from challan_item_serials where delivery_challan_id = ${challanId}
  `;
  await tx`
    delete from delivery_challan_items where delivery_challan_id = ${challanId}
  `;
  // Every line is resolved and refused BEFORE anything is written, in
  // request order, so the message the operator reads is still the first
  // fault in their document. The rows then land as one statement per
  // shape instead of one per line.
  const manualLines: {
    position: number;
    line: Extract<ResolvedLine, { shape: 'manual' }>;
  }[] = [];
  const itemLines: {
    position: number;
    line: Extract<ResolvedLine, { shape: 'work_item' }>;
  }[] = [];
  for (const [index, item] of body.items.entries()) {
    // The column reads `numeric(18,3) NOT NULL CHECK (quantity > 0)`,
    // while the shared DecimalString shape admits '0', '-5' and a
    // sixteen-digit typo. Each of those reaches Postgres as a 23514 or a
    // 22003, neither of which carries an HTTP status, so the operator
    // reads 'The request could not be completed.' and the logs record a
    // false 5xx. Refused here instead, naming the line — the same answer
    // the correction path already gives (corrections.ts QUANTITY_INVALID).
    const lineNumber = String(index + 1);
    if (!isPositiveDecimal(item.quantity)) {
      throw httpError(
        400,
        'QUANTITY_INVALID',
        `Line ${lineNumber}: the delivered quantity must be greater than zero (received ${item.quantity}).`,
      );
    }
    if (integerDigitCount(item.quantity) > 15) {
      throw httpError(
        400,
        'QUANTITY_INVALID',
        `Line ${lineNumber}: the delivered quantity ${item.quantity} is too large to record — check for a mistyped digit.`,
      );
    }
    const line = resolveLine(item, `Line ${lineNumber}`);

    if (line.shape === 'manual') {
      // The rate is operator text on a manual line, so it answers to the
      // same digit rules the quantity does; a negative one would reach
      // the `rate_snapshot >= 0` CHECK as a statusless 23514.
      if (line.rate.startsWith('-')) {
        throw httpError(
          400,
          'RATE_INVALID',
          `Line ${lineNumber}: the rate cannot be negative (received ${line.rate}).`,
        );
      }
      if (integerDigitCount(line.rate) > 15) {
        throw httpError(
          400,
          'RATE_INVALID',
          `Line ${lineNumber}: the rate ${line.rate} is too large to record — check for a mistyped digit.`,
        );
      }
      manualLines.push({ position: index + 1, line });
      continue;
    }

    if (workId === null) {
      // Backstopped by the 0056 trigger; named here so the operator is
      // told what is wrong rather than reading 'The request could not be
      // completed.'
      throw httpError(
        400,
        'STANDALONE_LINE_MUST_BE_MANUAL',
        `Line ${lineNumber}: a standalone Delivery Challan belongs to no Work, so its lines cannot name Work items.`,
      );
    }

    if (line.purchaseOrderLineId !== null) {
      await assertPurchaseOrderLineReceivable(
        tx,
        workId,
        line.purchaseOrderLineId,
        `Line ${lineNumber}`,
      );
    }
    itemLines.push({ position: index + 1, line });
  }

  if (manualLines.length > 0) {
    await tx`
      insert into delivery_challan_items (
        organisation_id, delivery_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, rate_snapshot,
        line_amount, position, purchase_order_line_id,
        hsn_sac_code, is_service
      )
      select ${organisationId}, ${challanId}, ${workId}, null,
             manual.description, manual.unit, manual.quantity, manual.rate,
             (manual.quantity * manual.rate)::numeric(18,2),
             manual.position, null, manual.hsn_sac_code,
             manual.is_service::boolean
      from unnest(
        ${manualLines.map((entry) => entry.line.description)}::text[],
        ${manualLines.map((entry) => entry.line.unit)}::text[],
        ${manualLines.map((entry) => entry.line.quantity)}::numeric(18,3)[],
        ${manualLines.map((entry) => entry.line.rate)}::numeric(18,2)[],
        ${manualLines.map((entry) => entry.position)}::int[],
        ${manualLines.map((entry) => entry.line.statutory.hsnSacCode)}::text[],
        ${manualLines.map((entry) => booleanText(entry.line.statutory.isService))}::text[]
      ) as manual(
        description, unit, quantity, rate, position, hsn_sac_code, is_service
      )
    `;
  }

  if (itemLines.length > 0) {
    // Lock the referenced items BEFORE reading anything off them, in id
    // order — the discipline installations.ts and pac.ts already use,
    // and the same works -> work_items order every writer that takes
    // both takes.
    //
    // Without this the insert below joins `work_items` lock-free, so a
    // draft save and `PATCH /api/work-items/:id/payment-category` could
    // interleave: the save reads a category the PATCH is about to change
    // and the PATCH cannot see the line the save has not committed. That
    // is a write skew, and for AMC it is a hole in a structural rule —
    // migration 0068's trigger fires only on line INSERT/UPDATE, and
    // issuing a challan updates `delivery_challans.status`, never the
    // line, so a line written while the item was still SUPPLY would
    // never be re-examined. Locking here makes the two serialise: one
    // waits, and whichever runs second sees the other's committed state.
    const wantedItemIds = [
      ...new Set(itemLines.map((entry) => entry.line.workItemId)),
    ].sort();
    const lockedItems = await tx<
      { id: string; item_number: string; payment_category: string | null }[]
    >`
      select id, item_number, payment_category from work_items
      where id = any(${wantedItemIds}::uuid[]) and work_id = ${workId}
        and deleted_at is null
      order by id
      for update
    `;
    // The category refusal, said in the operator's own words. The 0068
    // trigger below is the backstop that holds for every writer; this is
    // the sentence the screen can act on.
    assertItemsAreDeliverable(lockedItems);

    // The join to work_items is what snapshots description, unit and
    // rate, and what refuses an item of another Work: a line whose item
    // does not join produces no row, so a short count names the fault.
    const inserted = await tx<{ work_item_id: string }[]>`
      insert into delivery_challan_items (
        organisation_id, delivery_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, rate_snapshot,
        line_amount, position, purchase_order_line_id,
        hsn_sac_code, is_service
      )
      select ${organisationId}, ${challanId}, ${workId}, wi.id,
             coalesce(wi.effective_description, wi.description),
             coalesce(wi.effective_unit, wi.unit_code), requested.quantity,
             coalesce(wi.effective_unit_rate, wi.effective_rate),
             (requested.quantity
               * coalesce(wi.effective_unit_rate, wi.effective_rate))::numeric(18,2),
             requested.position, requested.purchase_order_line_id,
             requested.hsn_sac_code, requested.is_service::boolean
      from unnest(
        ${itemLines.map((entry) => entry.line.workItemId)}::uuid[],
        ${itemLines.map((entry) => entry.line.quantity)}::numeric(18,3)[],
        ${itemLines.map((entry) => entry.position)}::int[],
        ${itemLines.map((entry) => entry.line.purchaseOrderLineId)}::uuid[],
        ${itemLines.map((entry) => entry.line.statutory.hsnSacCode)}::text[],
        ${itemLines.map((entry) => booleanText(entry.line.statutory.isService))}::text[]
      ) as requested(
        work_item_id, quantity, position, purchase_order_line_id,
        hsn_sac_code, is_service
      )
      join work_items wi on wi.id = requested.work_item_id
        and wi.work_id = ${workId} and wi.deleted_at is null
      returning work_item_id
    `.catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === '23505') {
        throw httpError(
          409,
          'DUPLICATE_ITEM',
          'The same Work item appears more than once on this challan.',
        );
      }
      throw error;
    });
    if (inserted.length !== itemLines.length) {
      throw httpError(
        404,
        'WORK_ITEM_NOT_FOUND',
        'A selected item does not belong to this Work.',
      );
    }
  }
}

/** The challan's lines in request-input shape ({workItemId, quantity,
 * purchaseOrderLineId}) for audit diffing; quantity text comes normalised
 * from the numeric column so before/after compare like for like. */
async function readLineInputs(
  tx: TransactionSql,
  challanId: string,
): Promise<
  {
    workItemId: string | null;
    quantity: string;
    purchaseOrderLineId: string | null;
    description: string | null;
    unit: string | null;
    rate: string | null;
  }[]
> {
  const rows = await tx<
    {
      work_item_id: string | null;
      quantity: string;
      purchase_order_line_id: string | null;
      description_snapshot: string;
      unit_snapshot: string;
      rate_snapshot: string;
    }[]
  >`
    select work_item_id, quantity::text as quantity, purchase_order_line_id,
           description_snapshot, unit_snapshot,
           rate_snapshot::text as rate_snapshot
    from delivery_challan_items
    where delivery_challan_id = ${challanId}
    order by position
  `;
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    quantity: row.quantity,
    purchaseOrderLineId: row.purchase_order_line_id,
    // A work item line's printed text belongs to the schedule item, so
    // diffing it would report an amendment as a challan edit; a manual
    // line's IS the edit, and the trail has to carry it.
    description: row.work_item_id === null ? row.description_snapshot : null,
    unit: row.work_item_id === null ? row.unit_snapshot : null,
    rate: row.work_item_id === null ? canonicalRateText(row.rate_snapshot) : null,
  }));
}

/**
 * The half of issuing that is identical for every Delivery Challan,
 * whatever it moves: freeze the immutable snapshot, stamp the number, and
 * write the trail.
 *
 * `work` is the Work block for a work challan and undefined for a
 * standalone one — a standalone challan belongs to no contract, and
 * printing a Work block on it would be a claim about a contract that does
 * not exist. Everything the two kinds share (the warranty certificate,
 * the line snapshots, the total, the number-conflict refusal) is here
 * exactly once, so the two paths cannot drift apart.
 */
async function finaliseChallanIssue(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  challanId: string,
  challan: ChallanRow,
  minted: {
    readonly challanNumber: string;
    readonly sequence: number;
    readonly fyLabel: string | null;
    readonly work?: ChallanSnapshot['work'];
  },
): Promise<void> {
  const [organisation] = await tx<
    { name: string; warranty_template_text: string | null }[]
  >`
    select name, warranty_template_text from organisations
    where id = app_private.current_organisation_id()
  `;
  // A manual line has no work item, so its item number is the empty
  // string and the document prints an em dash in that column.
  const lines = await tx<(ChallanItemRow & { item_number: string })[]>`
    select dci.id, dci.work_item_id, dci.description_snapshot,
           dci.unit_snapshot, dci.quantity::text as quantity,
           dci.rate_snapshot::text as rate_snapshot,
           dci.line_amount::text as line_amount, dci.position,
           dci.purchase_order_line_id,
           coalesce(wi.item_number, '') as item_number
    from delivery_challan_items dci
    left join work_items wi on wi.id = dci.work_item_id
    where dci.delivery_challan_id = ${challanId}
    order by dci.position
  `;
  const [total] = await tx<{ amount: string }[]>`
    select coalesce(sum(line_amount), 0)::numeric(18,2)::text as amount
    from delivery_challan_items where delivery_challan_id = ${challanId}
  `;

  // Legacy §11: the warranty/guarantee certificate page is optional —
  // it exists exactly when the organisation has template text at issue
  // time. The FULL text is frozen into the immutable snapshot (with the
  // certificate template version and the SHA-256 of the exact text), so
  // later profile edits never change an issued certificate.
  const warrantyText = organisation?.warranty_template_text ?? null;
  const warranty =
    warrantyText !== null
      ? {
          templateVersion: WARRANTY_TEMPLATE_VERSION,
          textSha256: createHash('sha256').update(warrantyText, 'utf8').digest('hex'),
          text: warrantyText,
        }
      : undefined;

  const issuedAt = new Date().toISOString();
  const snapshot: ChallanSnapshot = {
    templateVersion: CHALLAN_TEMPLATE_VERSION,
    organisationName: organisation?.name ?? '',
    challanNumber: minted.challanNumber,
    challanDate: challan.challan_date,
    issuedAt,
    ...(minted.work !== undefined ? { work: minted.work } : {}),
    consignee: parseJsonbColumn(challan.consignee_snapshot) as Consignee,
    items: lines.map((line) => ({
      position: line.position,
      itemNumber: line.item_number,
      description: line.description_snapshot,
      unit: line.unit_snapshot,
      quantity: line.quantity,
      rate: canonicalRateText(line.rate_snapshot),
      lineAmount: line.line_amount,
    })),
    totalAmount: total?.amount ?? '0.00',
    ...(warranty !== undefined ? { warranty } : {}),
  };

  await tx`
    update delivery_challans
    set status = 'issued', challan_number = ${minted.challanNumber},
        sequence_number = ${minted.sequence}, fy_label = ${minted.fyLabel},
        issued_snapshot = ${tx.json(snapshot as never)},
        issued_by_user_id = ${userId}, issued_at = ${issuedAt},
        template_version = ${CHALLAN_TEMPLATE_VERSION},
        warranty_template_version = ${warranty?.templateVersion ?? null},
        warranty_text_sha256 = ${warranty?.textSha256 ?? null}
    where id = ${challanId}
  `.catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === '23505') {
      throw httpError(
        409,
        'NUMBER_CONFLICT',
        `Challan number ${minted.challanNumber} already exists in this organisation; use a distinct prefix for this challan.`,
      );
    }
    throw error;
  });

  await audit(
    tx,
    organisationId,
    userId,
    'challan.issued',
    'delivery_challans',
    challanId,
    {
      challanNumber: minted.challanNumber,
      sequence: minted.sequence,
      kind: challan.challan_kind,
      totalAmount: snapshot.totalAmount,
    },
  );
}

/**
 * Issuing a STANDALONE Delivery Challan: goods leaving the factory for a
 * private customer, a vendor, or a job worker.
 *
 * Nothing the work path does applies. There is no sanctioned quantity, so
 * no delivery ceiling; no Work, so no completion state and no final
 * Measurement Book to close a payment cycle; no schedule item, so no
 * requires_serials rule and no amendment that could make the draft stale.
 * The document is the movement and nothing else.
 *
 * The number is minted from a gap-free counter per (organisation,
 * financial year) — the counter row lock orders concurrent issues and a
 * rolled-back issue rolls the counter back with it, exactly as the
 * per-Work counter does for a work challan.
 */
async function issueStandaloneChallan(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  challanId: string,
  challan: ChallanRow,
): Promise<void> {
  const fyLabel = financialYearLabel(challan.challan_date);
  const [counter] = await tx<{ next_value: number }[]>`
    insert into standalone_challan_counters (organisation_id, fy_label)
    values (${organisationId}, ${fyLabel})
    on conflict (organisation_id, fy_label)
    do update set next_value = standalone_challan_counters.next_value + 1
    returning next_value
  `;
  if (!counter) throw new Error('counter upsert returned no row');
  const template = await loadNumberTemplate(tx, 'standalone_challan');
  let challanNumber: string;
  try {
    challanNumber = renderNumberTemplate(template, {
      prefix: challan.prefix,
      work: null,
      financialYear: fyLabel,
      documentDate: challan.challan_date,
      sequence: counter.next_value,
    });
  } catch (cause) {
    if (cause instanceof NumberTemplateError) {
      throw httpError(400, 'CHALLAN_NUMBER_UNFILLABLE', cause.message);
    }
    throw cause;
  }
  await finaliseChallanIssue(tx, organisationId, userId, challanId, challan, {
    challanNumber,
    sequence: counter.next_value,
    fyLabel,
  });
}

export function registerChallanRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
  scanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/balance',
      schema: {
        params: IdParamsSchema,
        response: { 200: WorkBalanceResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ allow_excess_delivery: boolean; today: string }[]>`
          select w.allow_excess_delivery,
                 (now() at time zone o.timezone)::date::text as today
          from works w
          join organisations o on o.id = w.organisation_id
          where w.id = ${workId} and w.deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        // The delivery ceiling is COALESCE(effective_quantity,
        // awarded_quantity): approved amendments (Milestone 6) raise or
        // lower it, and the rate/description an amendment changed is what
        // new challan lines will snapshot.
        const rows = await tx<
          {
            work_item_id: string;
            item_number: string;
            description: string;
            unit_code: string;
            awarded: string;
            effective: string | null;
            delivered: string;
            remaining: string;
            rate: string;
          }[]
        >`
          select wi.id as work_item_id, wi.item_number,
                 coalesce(wi.effective_description, wi.description) as description,
                 coalesce(wi.effective_unit, wi.unit_code) as unit_code,
                 wi.awarded_quantity::text as awarded,
                 wi.effective_quantity::text as effective,
                 coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0)::text as delivered,
                 (coalesce(wi.effective_quantity, wi.awarded_quantity)
                   - coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0))::text as remaining,
                 coalesce(wi.effective_unit_rate, wi.effective_rate)::text as rate
          from work_items wi
          left join delivery_challan_items dci on dci.work_item_id = wi.id
          left join delivery_challans dc on dc.id = dci.delivery_challan_id
          where wi.work_id = ${workId} and wi.deleted_at is null
            -- AMC items are excluded (migration 0068). This register is
            -- "what is left to deliver", and an annual maintenance item
            -- has no delivery balance at all: nothing is ever despatched
            -- against it, the 0068 trigger refuses a line naming it, and
            -- the editors that read this endpoint build their item
            -- pickers straight from it. Leaving them in would offer the
            -- operator a row whose every value is a fiction and whose
            -- only outcome is a refusal at save.
            and coalesce(wi.payment_category, '') <> 'AMC'
          group by wi.id
          order by wi.item_number
        `;
        // What a NEW draft opens on: the Work's most recent ISSUED
        // challan, chosen by sequence number rather than by date or by
        // row age. The sequence is assigned at issue and is the Work's
        // real series order, so a challan back-entered with an older
        // challan date — or written to the table out of order — cannot
        // displace a later one. `status = 'issued'` excludes drafts,
        // which hold no sequence at all, and cancelled challans, which
        // are no precedent: whatever was wrong with one may be exactly
        // these fields. `work_id` excludes standalone challans, which
        // carry no Work by construction (migration 0056).
        const [deliverySource] = await tx<
          {
            prefix: string;
            consignee_name: string;
            consignee_address: string;
            consignee_phone: string | null;
            challan_number: string;
          }[]
        >`
          select prefix,
                 coalesce(consignee_snapshot->>'name', '') as consignee_name,
                 coalesce(consignee_snapshot->>'address', '') as consignee_address,
                 consignee_snapshot->>'phone' as consignee_phone,
                 challan_number
          from delivery_challans
          where work_id = ${workId} and status = 'issued'
          order by sequence_number desc
          limit 1
        `;
        // The Issue Challan side of the same question, chosen the same
        // way. Movement type is deliberately not read: it is the field
        // that decides what the document DOES, and one 'return' must not
        // turn every later Issue Challan into a return.
        const [issueSource] = await tx<
          {
            issued_to_name: string;
            issued_to_role: string | null;
            location: string | null;
            challan_number: string;
          }[]
        >`
          select issued_to_name, issued_to_role, location, challan_number
          from issue_challans
          where work_id = ${workId} and status = 'issued'
          order by sequence_number desc
          limit 1
        `;
        return {
          allowExcessDelivery: work.allow_excess_delivery,
          today: work.today,
          deliveryCarryForward:
            deliverySource === undefined
              ? null
              : {
                  prefix: deliverySource.prefix,
                  consigneeName: deliverySource.consignee_name,
                  consigneeAddress: deliverySource.consignee_address,
                  consigneePhone: deliverySource.consignee_phone,
                  sourceChallanNumber: deliverySource.challan_number,
                },
          issueCarryForward:
            issueSource === undefined
              ? null
              : {
                  issuedToName: issueSource.issued_to_name,
                  issuedToRole: issueSource.issued_to_role,
                  location: issueSource.location,
                  sourceChallanNumber: issueSource.challan_number,
                },
          // Natural order. `item_number` is text, so the SQL sorts A1/1,
          // A1/10, A1/11, A1/2 — the order this picker used to offer the
          // operator, who is reading the letter's schedule beside it.
          items: byItemNumber(
            rows.map((row) => ({
              workItemId: row.work_item_id,
              itemNumber: row.item_number,
              description: row.description,
              unitCode: row.unit_code,
              awardedQuantity: row.awarded,
              effectiveQuantity: row.effective,
              deliveredQuantity: row.delivered,
              remainingQuantity: row.remaining,
              effectiveRate: canonicalRateText(row.rate),
            })),
          ),
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/challans',
      schema: {
        params: IdParamsSchema,
        querystring: KeysetQuerySchema,
        response: { 200: ChallanListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const query = request.query;
      const paged = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        // The tie-break was `id` ascending under a descending created_at,
        // which cannot be expressed as one row comparison; it is `id desc`
        // now so the keyset predicate matches the ORDER BY exactly. Only
        // ties are affected — challans created in the same instant — and
        // no screen depends on their relative order.
        // The cursor must name a challan OF THIS WORK — an id from another
        // Work (or a standalone challan, whose work_id is null) is refused
        // as CURSOR_INVALID, indistinguishable from a nonexistent one; see
        // `cursorRowId` for the oracle this closes.
        const cursor = await cursorRowId(tx, 'delivery_challans', query.cursor, workId);
        const rows = await tx<ChallanRow[]>`
            select ${tx.unsafe(CHALLAN_COLUMNS)}
            from delivery_challans
            where work_id = ${workId}
              and (${cursor === null} or (created_at, id) < (
                select c.created_at, c.id from delivery_challans c
                where c.id = ${cursor}))
            order by created_at desc, id desc
            limit ${sqlLimit(query.limit)}
          `;
        return keysetPage(rows, query.limit, (row) => row.id);
      });
      return { challans: paged.rows.map(toChallan), nextCursor: paged.nextCursor };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/challans',
      schema: {
        params: IdParamsSchema,
        body: SaveChallanRequestSchema,
        response: { 201: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const consignee = normaliseConsignee(body.consignee);

      const detail = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertWorkAccess(tx, user.id, workId);
        // The works row lock pairs with the one POST
        // /api/works/:id/complete holds: a draft created here and a
        // completion on the same Work serialise, so a draft can never
        // appear behind a completed Work's refusals (the 0031 insert
        // guard backstops it in the database).
        const [work] = await tx<{ status: string }[]>`
            select status from works where id = ${workId} and deleted_at is null
            for update
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'drafting a delivery challan');
        await assertChallanDate(tx, workId, body.challanDate);

        // One open draft per Work (the partial unique index is the
        // arbiter): the 409 names the existing draft so the client can
        // open it instead of parsing the message.
        const [existingDraft] = await tx<{ id: string }[]>`
            select id from delivery_challans
            where work_id = ${workId} and status = 'draft'
          `;
        if (existingDraft) {
          throw draftConflictError(
            'DRAFT_EXISTS',
            'This Work already has a draft challan; issue or delete it first.',
            existingDraft.id,
          );
        }

        const [created] = await tx<{ id: string }[]>`
            insert into delivery_challans (
              organisation_id, work_id, challan_date, prefix,
              consignee_snapshot, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.challanDate}, ${body.prefix},
              ${tx.json(consignee as never)}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            // A concurrent create won between the pre-check and this
            // insert; the transaction is aborted, so the route-level
            // catch names the winner from a fresh read.
            throw httpError(
              409,
              'DRAFT_EXISTS',
              'This Work already has a draft challan; issue or delete it first.',
            );
          }
          throw error;
        });
        if (!created) throw new Error('challan insert returned no row');

        await writeLines(tx, organisationId, created.id, workId, body);
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.created',
          'delivery_challans',
          created.id,
          {
            workId,
            itemCount: body.items.length,
          },
        );
        return readDetail(tx, created.id);
      }).catch(async (error: unknown) => {
        // The unique-index race path could not name the winning draft
        // inside its aborted transaction; do it from a fresh read.
        throw await nameDraftConflict(error, 'DRAFT_EXISTS', () =>
          tenant(async (tx) => {
            const [row] = await tx<{ id: string }[]>`
              select id from delivery_challans
              where work_id = ${workId} and status = 'draft'
            `;
            return row?.id ?? null;
          }),
        );
      });
      return reply.status(201).send(detail);
    },
  );

  // ------------------------------------------------------------------
  // The Delivery Challan MODULE: one register across all three
  // movements, and the standalone create/edit flow.
  //
  // A work challan still lives on its Work's Deliveries tab and is still
  // created there — /api/works/:id/challans above is untouched. What is
  // new is that the movement document has a home of its own, because two
  // of its three cases have no Work to live under.
  // ------------------------------------------------------------------

  tenantRoute(
    {
      method: 'GET',
      url: '/api/delivery-challans',
      schema: {
        querystring: DeliveryChallanRegisterQuerySchema,
        response: { 200: DeliveryChallanRegisterResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const query = request.query;
      return tenant(async (tx) => {
        // An 'assigned'-scoped membership sees its assigned Works'
        // challans and NOTHING standalone: work-scope binds through a
        // Work, and a standalone challan has none, so no assignment
        // could ever reach it. Decided in SQL rather than by filtering
        // in the handler, so the rows never leave the database.
        const full = await hasFullWorkScope(tx, user.id);
        // The register reads newest challan date first; the keyset runs
        // BACKWARD on (challan_date, created_at, id). The trailing `id`
        // was ascending under two descending keys, which no single row
        // comparison can express, so it is descending now — a difference
        // only two challans issued in the same instant on the same date
        // could ever see. The cursor is proven against the work-scope
        // predicate as well as the tenant, so an 'assigned'-scoped member
        // cannot use a forbidden challan's id as a position and read its
        // date back out of the comparison; see `workScopedCursorRowId`.
        const cursor = await workScopedCursorRowId(
          tx,
          'delivery_challans',
          query.cursor,
          { userId: user.id, full },
        );
        const rows = await tx<
          {
            id: string;
            challan_kind: ChallanKind;
            status: Challan['status'];
            challan_date: string;
            challan_number: string | null;
            prefix: string;
            work_id: string | null;
            work_code: string | null;
            consignee_snapshot: unknown;
            contact_designation: string | null;
            line_count: string;
            manual_line_count: string;
            total_amount: string;
            created_at: Date;
            issued_at: Date | null;
          }[]
        >`
          select dc.id, dc.challan_kind, dc.status,
                 dc.challan_date::text as challan_date, dc.challan_number,
                 dc.prefix, dc.work_id, w.work_code,
                 dc.consignee_snapshot, c.designation as contact_designation,
                 lines.line_count::text as line_count,
                 lines.manual_line_count::text as manual_line_count,
                 lines.total_amount::numeric(18,2)::text as total_amount,
                 dc.created_at, dc.issued_at
          from delivery_challans dc
          left join works w on w.id = dc.work_id
          left join contacts c on c.id = dc.consignee_contact_id
          cross join lateral (
            select count(*) as line_count,
                   count(*) filter (where i.work_item_id is null)
                     as manual_line_count,
                   coalesce(sum(i.line_amount), 0) as total_amount
            from delivery_challan_items i
            where i.delivery_challan_id = dc.id
          ) lines
          where (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = dc.work_id and wa.user_id = ${user.id}
            ))
            -- The module's ?work= deep link, narrowed here rather than
            -- over the page the client already holds: a Work with more
            -- movements than one page holds used to show only the page's
            -- worth of them. It sits INSIDE the work-scope predicate, so
            -- naming a Work the caller may not see narrows an empty set
            -- and discloses nothing. Served by delivery_challans_work_idx
            -- (organisation_id, work_id, status, challan_date DESC, id).
            and (${query.work === undefined} or dc.work_id = ${query.work ?? null})
            and (${cursor === null} or
              (dc.challan_date, dc.created_at, dc.id) < (
                select c.challan_date, c.created_at, c.id from delivery_challans c
                where c.id = ${cursor}))
          order by dc.challan_date desc, dc.created_at desc, dc.id desc
          limit ${sqlLimit(query.limit)}
        `;
        const paged = keysetPage(rows, query.limit, (row) => row.id);
        return {
          nextCursor: paged.nextCursor,
          challans: paged.rows.map((row) => {
            const manualLineCount = Number(row.manual_line_count);
            const movement: DeliveryChallanMovement =
              row.challan_kind === 'standalone'
                ? 'standalone'
                : manualLineCount > 0
                  ? 'work_material'
                  : 'loa_supply';
            const snapshot = parseJsonbColumn(row.consignee_snapshot) as
              Partial<Consignee> | undefined;
            return {
              id: row.id,
              kind: row.challan_kind,
              movement,
              status: row.status,
              challanDate: row.challan_date,
              challanNumber: row.challan_number,
              prefix: row.prefix,
              workId: row.work_id,
              workCode: row.work_code,
              consigneeName: snapshot?.name ?? row.contact_designation ?? '',
              lineCount: Number(row.line_count),
              manualLineCount,
              totalAmount: row.total_amount,
              createdAt: row.created_at.toISOString(),
              issuedAt: row.issued_at?.toISOString() ?? null,
            };
          }),
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/delivery-challans',
      schema: {
        body: SaveStandaloneChallanRequestSchema,
        response: { 201: ChallanDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const detail = await tenant(async (tx) => {
        await assertStandaloneChallanAccess(tx, user.id);
        await assertStandaloneChallanDate(tx, body.challanDate);
        const { consignee, gstin: contactGstin } = await loadStandaloneConsignee(
          tx,
          body.consigneeContactId,
        );

        // One open draft per consignee (the partial unique index of 0056
        // is the arbiter): the 409 names the existing draft so the client
        // can open it instead of parsing the message. The per-Work rule
        // is untouched — its index self-excludes these rows.
        const [existingDraft] = await tx<{ id: string }[]>`
          select id from delivery_challans
          where challan_kind = 'standalone' and status = 'draft'
            and consignee_contact_id = ${body.consigneeContactId}
        `;
        if (existingDraft) {
          throw draftConflictError(
            'DRAFT_EXISTS',
            'This consignee already has a draft standalone challan; issue or delete it first.',
            existingDraft.id,
          );
        }

        const statutory = normaliseChallanStatutory(body, contactGstin);
        const [created] = await tx<{ id: string }[]>`
          insert into delivery_challans (
            organisation_id, work_id, challan_kind, consignee_contact_id,
            challan_date, prefix, consignee_snapshot, created_by_user_id,
            movement_reason, consignee_gstin, transporter_id, transporter_name,
            vehicle_number, transport_doc_number, transport_doc_date,
            transport_distance_km
          )
          values (
            ${organisationId}, null, 'standalone', ${body.consigneeContactId},
            ${body.challanDate}, ${body.prefix},
            ${tx.json(consignee as never)}, ${user.id},
            ${statutory.movementReason}, ${statutory.consigneeGstin},
            ${statutory.transporterId}, ${statutory.transporterName},
            ${statutory.vehicleNumber}, ${statutory.transportDocNumber},
            ${statutory.transportDocDate}, ${statutory.transportDistanceKm}
          )
          returning id
        `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'DRAFT_EXISTS',
              'This consignee already has a draft standalone challan; issue or delete it first.',
            );
          }
          throw error;
        });
        if (!created) throw new Error('challan insert returned no row');

        await writeLines(tx, organisationId, created.id, null, body);
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.created',
          'delivery_challans',
          created.id,
          {
            kind: 'standalone',
            consigneeContactId: body.consigneeContactId,
            itemCount: body.items.length,
          },
        );
        return readDetail(tx, created.id);
      }).catch(async (error: unknown) => {
        // The unique-index race path could not name the winning draft
        // inside its aborted transaction; do it from a fresh read.
        throw await nameDraftConflict(error, 'DRAFT_EXISTS', () =>
          tenant(async (tx) => {
            const [row] = await tx<{ id: string }[]>`
              select id from delivery_challans
              where challan_kind = 'standalone' and status = 'draft'
                and consignee_contact_id = ${body.consigneeContactId}
            `;
            return row?.id ?? null;
          }),
        );
      });
      return reply.status(201).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/delivery-challans/:id',
      schema: {
        params: IdParamsSchema,
        body: SaveStandaloneChallanRequestSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const challan = await lockChallan(tx, id);
        if (challan.challan_kind !== 'standalone') {
          // A work challan's consignee is free text and its lines answer
          // to the Work; it is edited through PUT /api/challans/:id.
          throw httpError(
            400,
            'CHALLAN_NOT_STANDALONE',
            'This challan belongs to a Work; edit it through its Work.',
          );
        }
        await assertStandaloneChallanAccess(tx, user.id);
        requireStatus(challan, 'draft');
        await assertStandaloneChallanDate(tx, body.challanDate);
        const { consignee, gstin: contactGstin } = await loadStandaloneConsignee(
          tx,
          body.consigneeContactId,
        );
        const statutory = normaliseChallanStatutory(body, contactGstin);
        const linesBefore = await readLineInputs(tx, id);
        await tx`
          update delivery_challans
          set challan_date = ${body.challanDate}, prefix = ${body.prefix},
              consignee_contact_id = ${body.consigneeContactId},
              consignee_snapshot = ${tx.json(consignee as never)},
              movement_reason = ${statutory.movementReason},
              consignee_gstin = ${statutory.consigneeGstin},
              transporter_id = ${statutory.transporterId},
              transporter_name = ${statutory.transporterName},
              vehicle_number = ${statutory.vehicleNumber},
              transport_doc_number = ${statutory.transportDocNumber},
              transport_doc_date = ${statutory.transportDocDate},
              transport_distance_km = ${statutory.transportDistanceKm}
          where id = ${id}
        `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'DRAFT_EXISTS',
              'That consignee already has a draft standalone challan; issue or delete it first.',
            );
          }
          throw error;
        });
        await writeLines(tx, organisationId, id, null, body);
        const changes = auditDiff(
          {
            challanDate: challan.challan_date,
            prefix: challan.prefix,
            consigneeContactId: challan.consignee_contact_id,
            movementReason: challan.movement_reason,
            consigneeGstin: challan.consignee_gstin,
            vehicleNumber: challan.vehicle_number,
            items: linesBefore,
          },
          {
            challanDate: body.challanDate,
            prefix: body.prefix,
            consigneeContactId: body.consigneeContactId,
            movementReason: statutory.movementReason,
            consigneeGstin: statutory.consigneeGstin,
            vehicleNumber: statutory.vehicleNumber,
            items: await readLineInputs(tx, id),
          },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.updated',
          'delivery_challans',
          id,
          { before: changes.before, after: changes.after },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/challans/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [ref] = await tx<{ work_id: string | null }[]>`
          select work_id from delivery_challans where id = ${id}
        `;
        if (!ref) {
          throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
        }
        await assertChallanAccess(tx, user.id, ref);
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/challans/:id',
      schema: {
        params: IdParamsSchema,
        body: SaveChallanRequestSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const consignee = normaliseConsignee(body.consignee);
      return tenant(async (tx) => {
        const challan = await lockChallan(tx, id);
        await assertChallanAccess(tx, user.id, challan);
        requireStatus(challan, 'draft');
        // A standalone draft has a contacts-master consignee rather than
        // this free-text one, so it is edited through its own route
        // (PUT /api/delivery-challans/:id) instead of being half-updated
        // here.
        const workId = requireWorkBoundChallan(challan);
        await assertChallanDate(tx, workId, body.challanDate);
        const linesBefore = await readLineInputs(tx, id);
        await tx`
          update delivery_challans
          set challan_date = ${body.challanDate}, prefix = ${body.prefix},
              consignee_snapshot = ${tx.json(consignee)}
          where id = ${id}
        `;
        await writeLines(tx, organisationId, id, workId, body);
        // Milestone 6: the trail records what each changed field was and
        // became. Lines round-trip through the database on both sides so
        // quantities compare in the same normalised numeric text.
        const changes = auditDiff(
          {
            challanDate: challan.challan_date,
            prefix: challan.prefix,
            consignee: parseJsonbColumn(challan.consignee_snapshot),
            items: linesBefore,
          },
          {
            challanDate: body.challanDate,
            prefix: body.prefix,
            consignee,
            items: await readLineInputs(tx, id),
          },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.updated',
          'delivery_challans',
          id,
          {
            before: changes.before,
            after: changes.after,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/challans/:id',
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        const challan = await lockChallan(tx, id);
        await assertChallanAccess(tx, user.id, challan);
        requireStatus(challan, 'draft');
        // A deleted draft takes its draft-stage serials with it (they
        // reference the lines and would otherwise orphan the delete).
        await tx`delete from challan_item_serials where delivery_challan_id = ${id}`;
        await tx`delete from delivery_challan_items where delivery_challan_id = ${id}`;
        await tx`delete from delivery_challans where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.deleted',
          'delivery_challans',
          id,
          {
            workId: challan.work_id,
          },
        );
      });
      return reply.status(204).send(null);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/challans/:id/issue',
      schema: {
        params: IdParamsSchema,
        response: { 201: ChallanDetailResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const detail = await tenant(async (tx) => {
        // Closing a PO locks purchase_orders -> linked delivery_challans.
        // Take the identical order here before locking this challan, so
        // the status re-check below cannot deadlock against a close.
        const linkedOrders = await lockLinkedPurchaseOrdersForChallan(tx, id);
        const challan = await lockChallan(tx, id);
        await assertChallanAccess(tx, user.id, challan);
        requireStatus(challan, 'draft');
        await assertLinkedPurchaseOrderLocksCurrent(tx, id, linkedOrders);
        // writeLines validates the receipt link when the draft is saved,
        // but the order may have been closed or cancelled in between: a
        // closed or cancelled order takes no further receipts, and only
        // a cancellation reopens one. Re-check under the locks above so
        // the issue is refused rather than silently over-receipting.
        const unavailableOrder = linkedOrders.find(
          (order) => order.status !== 'issued',
        );
        if (unavailableOrder) {
          throw httpError(
            409,
            'PO_NOT_ISSUED',
            `Purchase order ${unavailableOrder.po_number ?? unavailableOrder.id} is no longer issued (current status: ${unavailableOrder.status}); deliveries are received against an ISSUED purchase order.`,
          );
        }

        // A standalone challan has no Work, so every gate below — the
        // works lock, the completion state, the final Measurement Book,
        // the delivery ceiling, requires_serials, the amendment
        // staleness check — has nothing to act on. It takes its own
        // path and returns.
        if (challan.work_id === null) {
          await issueStandaloneChallan(tx, organisationId, user.id, id, challan);
          return readDetail(tx, id);
        }
        const workId = challan.work_id;

        // The works row lock pairs with the one the MB finalize
        // transaction holds: an issue and a final-MB finalize on the
        // same Work serialise here, so whichever commits second sees
        // the other — a challan issued first is caught by the final
        // sweep, and a final MB finalized first makes this issue fail
        // the FINAL_MB_EXISTS check below (the 0027 challan-update
        // guard backstops it in the database). Lock order works ->
        // work_items matches every other writer taking both.
        const [work] = await tx<
          {
            allow_excess_delivery: boolean;
            work_code: string;
            title: string;
            letter_number: string;
            letter_date: string;
            status: string;
          }[]
        >`
            select allow_excess_delivery, work_code, title, letter_number,
                   letter_date::text as letter_date, status
            from works where id = ${workId} and deleted_at is null
            for update
          `;
        if (!work) throw new Error('challan without a Work');

        // R8: a completed Work accepts no new operational documents.
        // The works lock above serialises this against completion, and
        // the 0031 challan-update guard backstops it in the database.
        assertWorkOperable(work.status, 'issuing a delivery challan');

        // A live final Measurement Book closes the Work's payment
        // cycle (spec §5.9): a challan issued after it could never be
        // billed, so the issue is refused outright.
        const [finalBook] = await tx<{ id: string; mb_number: string | null }[]>`
            select id, mb_number from measurement_books
            where work_id = ${workId} and is_final
              and status <> 'cancelled'
          `;
        if (finalBook) {
          throw httpError(
            409,
            'FINAL_MB_EXISTS',
            `The final Measurement Book ${finalBook.mb_number ?? finalBook.id} closes this Work's payment cycle; a challan issued now could never be billed.`,
          );
        }

        // Concurrency-safe quantity validation: this challan's lines plus
        // everything already ISSUED must stay within the delivery ceiling
        // COALESCE(effective_quantity, awarded_quantity) — exact numeric
        // arithmetic in SQL. The challan row lock above serialises
        // competing issues of this work's single draft, and the item row
        // locks below serialise against amendment apply (Milestone 6),
        // which takes the same locks before lowering a ceiling.
        //
        // Every read of the lines from here down says `work_item_id is
        // not null` outright. Manual (non-LOA) lines carry installation
        // material that is on no schedule, so they have no sanctioned
        // quantity to breach, no serial guarantee to satisfy, and no
        // amendment that could make them stale — and the join to
        // work_items would drop them anyway. The invariant this module
        // rests on is not left to a join predicate.
        const lockedLineItems = await tx<
          { item_number: string; payment_category: string | null }[]
        >`
            select wi.id, wi.item_number, wi.payment_category from work_items wi
            where wi.id in (
              select dci.work_item_id from delivery_challan_items dci
              where dci.delivery_challan_id = ${id}
                and dci.work_item_id is not null
            )
            order by wi.id
            for update
          `;
        // The category, re-checked at the issue transition (migration
        // 0068). The draft save refuses an AMC line under these same
        // locks, but the two acts are separate transactions and the
        // category can move between them — and nothing else would catch
        // it, because issuing updates `delivery_challans.status` and
        // never the line, so the 0068 line trigger does not re-fire.
        // This is the gate that makes "no issued challan quantity ever
        // stands against an AMC item" true rather than merely usual.
        assertItemsAreDeliverable(lockedLineItems);
        if (!work.allow_excess_delivery) {
          const exceeded = await tx<{ item_number: string }[]>`
              select wi.item_number
              from delivery_challan_items dci
              join work_items wi on wi.id = dci.work_item_id
              where dci.delivery_challan_id = ${id}
                and dci.work_item_id is not null
                and dci.quantity + coalesce((
                  select sum(q.quantity)
                  from delivery_challan_items q
                  join delivery_challans dc on dc.id = q.delivery_challan_id
                  where q.work_item_id = dci.work_item_id
                    and q.work_item_id is not null
                    and dc.status = 'issued'
                ), 0) > coalesce(wi.effective_quantity, wi.awarded_quantity)
              order by wi.item_number
            `;
          if (exceeded.length > 0) {
            throw httpError(
              409,
              'QUANTITY_EXCEEDED',
              `Issuing would exceed the permitted quantity for: ${exceeded
                .map((row) => row.item_number)
                .sort(compareItemNumbers)
                .join(', ')}.`,
            );
          }
        }

        // THE INSPECTION DISPATCH GATE (migration 0082).
        //
        // Placed here, immediately after the delivery ceiling and before
        // the serial check, because it is the same kind of rule: a
        // per-item cap on what this challan may carry, configured on the
        // Work, evaluated once at the transition that makes the despatch
        // real. It is the same arithmetic as the ceiling above, over a
        // different allowance.
        //
        // LOCK ORDER, and why the FOR SHARE below is here. Withdrawing a
        // certificate is what makes a passing item fail, and it is a
        // different transaction. Without a lock the two interleave: this
        // read sees a live call, the withdrawal commits, and the challan
        // issues under a certificate that no longer authorises it. So the
        // issue takes a SHARE lock on the calls it is about to rely on,
        // after the works and work_items locks it already holds — the
        // order works -> work_items -> inspection_calls, which is the
        // order the clause-mapping and cancel paths take too, so no pair
        // of them can deadlock. SHARE and not UPDATE because concurrent
        // issues may rely on the same certificate; only a withdrawal
        // (which takes the row FOR UPDATE) has to wait.
        await tx`
            select ic.id
            from inspection_calls ic
            where ic.status = 'closed'
              and exists (
                select 1
                from inspection_call_items ici
                join delivery_challan_items dci
                  on dci.work_item_id = ici.work_item_id
                join inspection_clauses c
                  on c.work_item_id = ici.work_item_id
                where ici.inspection_call_id = ic.id
                  and dci.delivery_challan_id = ${id}
                  and dci.work_item_id is not null
                  and c.gates_dispatch
                  and c.agency = ic.agency
              )
            order by ic.id
            for share
          `;

        // The refusal itself. One SQL function
        // (`app_private.inspection_dispatch_shortfall`, migration 0082)
        // answers it, and the backstop trigger on this table calls the
        // SAME function — so the sentence an operator reads and the
        // refusal the database raises cannot disagree about the numbers.
        //
        // "Live" is decided against the ORGANISATION's today, not UTC's:
        // at 04:00 IST those are different days, and the difference
        // decides whether a lorry may leave.
        const uninspected = await tx<
          {
            item_number: string;
            agency: string;
            despatched: string;
            certified: string;
          }[]
        >`
            select item_number, agency,
                   despatched::text as despatched,
                   certified::text as certified
            from app_private.inspection_dispatch_shortfall(
              ${id},
              (select app_private.organisation_today(${organisationId}))
            )
          `;
        if (uninspected.length > 0) {
          throw httpError(
            409,
            'INSPECTION_CERTIFICATE_MISSING',
            `These items would be despatched beyond the quantity a live inspection certificate covers: ${uninspected
              .map(
                (row) =>
                  `${row.item_number} (${row.agency}: ${row.certified} certified, ${row.despatched} despatched)`,
              )
              .join(', ')}.`,
          );
        }

        // requires_serials enforcement. The challan's work_items rows
        // are locked FOR UPDATE (no flag predicate) so a concurrent
        // flag toggle serialises with this check in both orders: a
        // toggle that committed first is visible in the locked read;
        // a toggle waiting on these locks re-validates against the
        // now-issued lines after we commit. Serial recording/deletion
        // already serialises against issue through the challan row
        // lock taken above.
        const challanWorkItems = await tx<
          { id: string; item_number: string; requires_serials: boolean }[]
        >`
            select wi.id, wi.item_number, wi.requires_serials
            from work_items wi
            where wi.id in (
              select work_item_id from delivery_challan_items
              where delivery_challan_id = ${id}
                and work_item_id is not null
            )
            order by wi.id
            for update of wi
          `;

        // R7 / rule 7: issue freezes the line snapshots written at
        // DRAFT-SAVE time (description, unit, rate) into the immutable
        // snapshot and the PDF handed to the consignee. An amendment
        // approved since then moved work_items.effective_* and never
        // touched the open draft, so issuing now would carry the
        // superseded reading forever — the quantity ledger and the
        // bill maths stay right (both read the live item), the printed
        // document does not. Silently re-snapshotting here would change
        // amounts the operator reviewed on screen a moment ago, so the
        // draft is sent back to be re-saved instead. This runs under
        // the work_items row locks taken just above, which are the same
        // locks amendment apply takes before writing effective_*, so an
        // amendment either committed before this read or waits behind
        // the issue.
        const stale = await tx<{ item_number: string; fields: string[] }[]>`
            select wi.item_number,
                   array_remove(array[
                     case when dci.description_snapshot
                       is distinct from coalesce(wi.effective_description, wi.description)
                       then 'description'::text end,
                     case when dci.unit_snapshot
                       is distinct from coalesce(wi.effective_unit, wi.unit_code)
                       then 'unit'::text end,
                     case when dci.rate_snapshot
                       is distinct from coalesce(wi.effective_unit_rate, wi.effective_rate)
                       then 'rate'::text end
                   ], null) as fields
            from delivery_challan_items dci
            join work_items wi on wi.id = dci.work_item_id
            where dci.delivery_challan_id = ${id}
              and dci.work_item_id is not null
              and (
                dci.description_snapshot
                  is distinct from coalesce(wi.effective_description, wi.description)
                or dci.unit_snapshot
                  is distinct from coalesce(wi.effective_unit, wi.unit_code)
                or dci.rate_snapshot
                  is distinct from coalesce(wi.effective_unit_rate, wi.effective_rate)
              )
            order by wi.item_number
          `;
        if (stale.length > 0) {
          const changed = [...stale]
            .sort((left, right) =>
              compareItemNumbers(left.item_number, right.item_number),
            )
            .map((line) => `${line.item_number} (${line.fields.join(', ')})`)
            .join('; ');
          throw httpError(
            409,
            'DRAFT_STALE',
            `These items were amended after this draft was saved: ${changed}. Reopen the draft and save it to pick up the new values, then issue.`,
          );
        }

        const flaggedItemIds = challanWorkItems
          .filter((item) => item.requires_serials)
          .map((item) => item.id);
        if (flaggedItemIds.length > 0) {
          // Exact count check in SQL: recorded serials must equal the
          // line quantity (numeric comparison, no floats).
          const incomplete = await tx<
            { item_number: string; quantity: string; recorded: string }[]
          >`
              select wi.item_number, dci.quantity::text as quantity,
                     (
                       select count(*) from challan_item_serials s
                       where s.delivery_challan_item_id = dci.id
                     )::text as recorded
              from delivery_challan_items dci
              join work_items wi on wi.id = dci.work_item_id
              where dci.delivery_challan_id = ${id}
                and dci.work_item_id = any(${flaggedItemIds}::uuid[])
                and (
                  select count(*) from challan_item_serials s
                  where s.delivery_challan_item_id = dci.id
                ) <> dci.quantity
              order by wi.item_number
            `;
          if (incomplete.length > 0) {
            const detail = [...incomplete]
              .sort((left, right) =>
                compareItemNumbers(left.item_number, right.item_number),
              )
              .map(
                (line) =>
                  `${line.item_number} (${line.recorded} of ${line.quantity} serials recorded)`,
              )
              .join('; ');
            throw httpError(
              409,
              'SERIALS_INCOMPLETE',
              `These items require one serial per unit before issue: ${detail}.`,
            );
          }
        }

        // Serialised per-Work numbering: the counter row lock orders
        // concurrent issues; a rolled-back transaction rolls the counter
        // back with it, so numbers are gapless per Work.
        const [counter] = await tx<{ next_value: number }[]>`
            insert into delivery_challan_counters (organisation_id, work_id)
            values (${organisationId}, ${workId})
            on conflict (organisation_id, work_id)
            do update set next_value = delivery_challan_counters.next_value + 1,
                          updated_at = now()
            returning next_value
          `;
        if (!counter) throw new Error('counter upsert returned no row');
        const sequence = counter.next_value;
        // The organisation's own format; the default is the
        // prefix/serial this route used to build by hand.
        // The Work code is a template token, so it is read here rather
        // than assumed: an organisation whose series is {WORK}-DC-{SEQ}
        // needs it, and the default never asks for it.
        const [numberWork] = await tx<{ work_code: string }[]>`
            select work_code from works where id = ${workId}
          `;
        const template = await loadNumberTemplate(tx, 'delivery_challan');
        let challanNumber: string;
        try {
          challanNumber = renderNumberTemplate(template, {
            prefix: challan.prefix,
            work: numberWork?.work_code ?? null,
            documentDate: challan.challan_date,
            sequence,
          });
        } catch (cause) {
          if (cause instanceof NumberTemplateError) {
            throw httpError(400, 'CHALLAN_NUMBER_UNFILLABLE', cause.message);
          }
          throw cause;
        }

        await finaliseChallanIssue(tx, organisationId, user.id, id, challan, {
          challanNumber,
          sequence,
          fyLabel: null,
          work: {
            workCode: work.work_code,
            title: work.title,
            letterNumber: work.letter_number,
            letterDate: work.letter_date,
          },
        });
        return readDetail(tx, id);
      });
      return reply.status(201).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/challans/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelChallanRequestSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const note = cancellationNote(body.note);
      return tenant(async (tx) => {
        const [challanRef] = await tx<{ work_id: string | null }[]>`
          select work_id from delivery_challans where id = ${id}
        `;
        if (!challanRef) {
          throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
        }
        await assertChallanAccess(tx, user.id, challanRef);
        // Closing a PO locks purchase_orders -> linked delivery_challans.
        // Take the identical order here before locking this challan, so a
        // receipt release can reopen every affected PO without a deadlock.
        // Issued challan lines are immutable; the second read below detects
        // an exceptional concurrent raw-SQL link change and fails to retry.
        const linkedOrders = await lockLinkedPurchaseOrdersForChallan(tx, id);
        const challan = await lockChallan(tx, id);
        await assertChallanAccess(tx, user.id, challan);
        requireStatus(challan, 'issued');
        await assertLinkedPurchaseOrderLocksCurrent(tx, id, linkedOrders);
        // R8: cancelling this challan would drop the delivered quantity
        // the completion predicate was measured against, leaving a Work
        // that says 'completed' below 100% executed. Lock order is the
        // creation paths' — document row first, then works — so cancel
        // and completion serialise instead of deadlocking, and the 0032
        // challan-update guard backstops the refusal in the database.
        //
        // A standalone challan delivered nothing against a sanctioned
        // quantity, so no completion predicate was ever measured against
        // it and there is no Work to lock.
        if (challan.work_id !== null) {
          const [work] = await tx<{ status: string }[]>`
            select status from works
            where id = ${challan.work_id} and deleted_at is null
            for update
          `;
          if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
          assertWorkOperable(work.status, 'cancelling a delivery challan');
        }
        // Received goods cannot be un-delivered: once a receipt, serial,
        // or Measurement Book entry references this challan, cancellation
        // is forbidden (policy 2026-08-08; the DB trigger backs this up).
        const [evidence] = await tx<
          { receipts: string; serials: string; measurements: string }[]
        >`
          select
            (select count(*) from challan_receipts
              where delivery_challan_id = ${id})::text as receipts,
            (select count(*) from challan_item_serials
              where delivery_challan_id = ${id})::text as serials,
            (select count(*) from mb_entries
              where delivery_challan_id = ${id})::text as measurements
        `;
        if (
          evidence &&
          (evidence.receipts !== '0' ||
            evidence.serials !== '0' ||
            evidence.measurements !== '0')
        ) {
          throw httpError(
            409,
            'CHALLAN_HAS_EVIDENCE',
            'This challan has a recorded receipt, serials, or measurements and can no longer be cancelled.',
          );
        }
        // R19: a challan billed in a live Measurement Book cannot be
        // cancelled — the MB must be cancelled first (the 0024 database
        // guard backstops this against every writer).
        await assertSourceNotBilled(tx, 'delivery_challan', id);
        // An e-way bill moves THIS challan; cancelling it under a live
        // movement document would leave the e-way bill moving a cancelled
        // consignment. The e-way bill goes first — the same interlock the
        // invoice cancel path enforces (tax-invoices/cancel.ts). The
        // invoice path carries no DB backstop for this and neither does the
        // challan path; both refuse it at the route.
        const [liveEwb] = await tx<{ id: string; ewb_number: string | null }[]>`
          select id, ewb_number from eway_bills
          where delivery_challan_id = ${id} and status <> 'cancelled'
        `;
        if (liveEwb) {
          throw httpError(
            409,
            'EWAY_BILL_LIVE',
            `E-way bill ${liveEwb.ewb_number ?? liveEwb.id} still moves this challan; cancel it first.`,
          );
        }
        await tx`
          update delivery_challans
          set status = 'cancelled', cancelled_by_user_id = ${user.id},
              cancelled_at = now(), cancellation_note = ${note}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.cancelled',
          'delivery_challans',
          id,
          {
            challanNumber: challan.challan_number,
            note,
          },
        );
        // A closed PO whose receipt was just released must become receivable
        // again. Otherwise its live balance shows pending material while the
        // challan editor refuses the replacement receipt as PO_NOT_ISSUED.
        await reopenClosedPurchaseOrders(
          tx,
          organisationId,
          user.id,
          { id, challan_number: challan.challan_number },
          note,
          linkedOrders,
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/challans/:id/render',
      schema: {
        params: IdParamsSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;

      // Snapshot read and PDF write live in separate transactions so the
      // slow external call holds no database locks; the legal content is
      // the immutable issued snapshot, so re-rendering reproduces the
      // record. Branding (logo, company details) is presentation and
      // comes from the organisation's current profile.
      const { snapshot, branding } = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        const challan = await lockChallan(tx, id);
        await assertChallanAccess(tx, user.id, challan);
        requireStatus(challan, 'issued');
        const [row] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from delivery_challans where id = ${id}
          `;
        const [organisation] = await tx<
          {
            address: string | null;
            gstin: string | null;
            contact_phone: string | null;
            contact_email: string | null;
            logo_object_key: string | null;
            logo_media_type: string | null;
          }[]
        >`
            select address, gstin, contact_phone, contact_email,
                   logo_object_key, logo_media_type
            from organisations
            where id = app_private.current_organisation_id()
          `;
        return {
          snapshot: parseJsonbColumn(row?.issued_snapshot) as ChallanSnapshot,
          branding: organisation ?? null,
        };
      });

      let logoDataUri: string | undefined;
      if (branding?.logo_object_key && branding.logo_media_type) {
        try {
          const logo = await storage.get(branding.logo_object_key);
          logoDataUri = `data:${branding.logo_media_type};base64,${logo.toString('base64')}`;
        } catch (error) {
          // A missing logo object must not block an issued document.
          request.log.warn({ err: error }, 'challan render: logo unavailable');
        }
      }
      const html = renderChallanHtml(snapshot, {
        ...(logoDataUri !== undefined ? { logoDataUri } : {}),
        address: branding?.address ?? null,
        gstin: branding?.gstin ?? null,
        contactPhone: branding?.contact_phone ?? null,
        contactEmail: branding?.contact_email ?? null,
      });
      const pdf = await renderPdfViaGotenberg(gotenbergUrl, html, {
        failureMessage:
          'The PDF service is unavailable; the issued challan is unaffected — retry later.',
        logError: (error) => {
          request.log.error({ err: error }, 'challan render failed');
        },
      });
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/dc/${id}.pdf`;
      await storage.put(objectKey, pdf);

      return tenant(async (tx) => {
        const updated = await tx`
          update delivery_challans
          set rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256}
          where id = ${id} and status = 'issued'
        `;
        if (updated.count === 0) {
          // The challan stopped being issued while Gotenberg rendered; the
          // stored PDF is an orphan, not evidence — no audit entry.
          throw httpError(
            409,
            'CHALLAN_STATUS_CONFLICT',
            'The challan is no longer issued; the render was discarded.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.rendered',
          'delivery_challans',
          id,
          {
            sha256,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/challans/:id/signed-copy',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParamsSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { bytes: body } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the signed copy',
      });
      // Authorisation before the expensive scan (ops batch): an
      // unauthorised caller must not spend scanner capacity.
      await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
      });
      await assertNotMalware(scanner, body);
      // Content-addressed key: a replacement upload gets a new object and
      // never overwrites earlier evidence; the hash is recorded like the
      // rendered PDF's.
      const signedSha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/signed/${id}-${signedSha256.slice(0, 16)}.pdf`;
      return tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        const challan = await lockChallan(tx, id);
        await assertChallanAccess(tx, user.id, challan);
        requireStatus(challan, 'issued');
        await storage.put(objectKey, body);
        await tx`
          update delivery_challans
          set signed_copy_object_key = ${objectKey},
              signed_copy_sha256 = ${signedSha256}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.signed_copy_uploaded',
          'delivery_challans',
          id,
          { sizeBytes: body.length, sha256: signedSha256 },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/challans/:id/pdf',
      schema: { params: IdParamsSchema, querystring: PdfQuerySchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const { kind = 'rendered' } = request.query;
      const key = await tenant(async (tx) => {
        const [row] = await tx<
          {
            work_id: string;
            rendered_object_key: string | null;
            signed_copy_object_key: string | null;
          }[]
        >`
            select work_id, rendered_object_key, signed_copy_object_key
            from delivery_challans where id = ${id}
          `;
        if (!row) {
          throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
        }
        await assertChallanAccess(tx, user.id, row);
        const found =
          kind === 'rendered' ? row.rendered_object_key : row.signed_copy_object_key;
        if (found === null) {
          throw httpError(
            404,
            'PDF_NOT_AVAILABLE',
            kind === 'rendered'
              ? 'This challan has not been rendered yet.'
              : 'No signed copy has been uploaded for this challan.',
          );
        }
        return found;
      });
      const bytes = await storage.get(key);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="challan-${id}-${kind}.pdf"`,
      );
      return reply.send(bytes);
    },
  );
}
