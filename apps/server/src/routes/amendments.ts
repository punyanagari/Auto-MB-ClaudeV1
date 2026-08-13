import { createHash, randomUUID } from 'node:crypto';
import {
  ApprovalListQuerySchema,
  ApprovalListResponseSchema,
  ApprovalRequestSchema,
  ApproveAmendmentRequestSchema,
  AttachVariationOrderQuerySchema,
  AttachVariationOrderResponseSchema,
  KeysetQuerySchema,
  ProposeAddItemRequestSchema,
  ProposeAmendmentRequestSchema,
  ProposeRemoveItemRequestSchema,
  RejectAmendmentRequestSchema,
  UpdateWorkSettingsRequestSchema,
  withKeysetQuery,
  WorkSettingsResponseSchema,
  type AmendmentDiffEntry,
  type ApprovalRequest,
  type VariationOrder,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope, requireAuthority } from '../authz.js';
import {
  applyChallanCancelReplace,
  applyCorrectionNotice,
  applyIssueChallanCancelReplace,
  type ChallanCancelReplaceProposal,
  type CorrectionNoticeProposal,
  type IssueChallanCancelReplaceProposal,
} from '../corrections-apply.js';
import { httpError } from '../http.js';
import { cursorRowId, keysetPage, sqlLimit } from '../pagination.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { extractPdfText, PdfToTextConfigurationError } from '../loa-extract.js';
import type { MalwareScanner } from '../malware-scan.js';
import { canonicalRateText } from '../rate-text.js';
import type { ObjectStorage } from '../storage.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
} from '../upload-guards.js';
import {
  describeFailedClaims,
  verifyVariationOrder,
  type OmissionUnderVerification,
  type VariationOrderVerdict,
} from '../variation-order-verify.js';
import { assertWorkOperable } from '../work-status.js';
import {
  applyWorkSupersede,
  type WorkSupersedeProposal,
} from '../work-supersede.js';
import { isPositiveDecimal } from './challans.js';
import {
  audit,
  upstreamErrorResponses,
  errorResponses,
  IdParamsSchema,
} from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

interface ChangeSet {
  quantity?: string;
  rate?: string;
  description?: string;
  unit?: string;
}

/** The stored `proposed` snapshot: everything apply needs, verbatim.
 * Milestone 7 adds the correction paths for issued documents. */
export type ProposedSnapshot =
  | {
      kind: 'change_item';
      workItemId: string;
      itemNumber: string;
      changes: ChangeSet;
    }
  | {
      kind: 'add_item';
      scheduleId: string;
      itemNumber: string;
      description: string;
      unitCode: string;
      quantity: string;
      rate: string;
    }
  | {
      kind: 'remove_item';
      workItemId: string;
      itemNumber: string;
    }
  | ChallanCancelReplaceProposal
  | IssueChallanCancelReplaceProposal
  | CorrectionNoticeProposal
  | WorkSupersedeProposal;

interface ApprovalRow {
  id: string;
  entity_type: ApprovalRequest['entityType'];
  entity_id: string | null;
  work_id: string;
  work_code: string;
  item_number: string | null;
  document_number: string | null;
  proposed: unknown;
  diff: unknown;
  reason: string;
  status: ApprovalRequest['status'];
  requested_by_user_id: string;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
  variation_order_id: string | null;
  variation_loa_number: string | null;
  variation_loa_date: string | null;
  variation_agreement_number: string | null;
  variation_number: string | null;
  variation_filename: string | null;
  variation_sha256: string | null;
  variation_size_bytes: string | number | null;
  variation_verdict: unknown;
  variation_uploaded_by_user_id: string | null;
  variation_created_at: Date | null;
}

const APPROVAL_SELECT = `
  select ar.id, ar.entity_type, ar.entity_id, ar.work_id, w.work_code,
         case when ar.entity_type = 'work_item_amendment'
           then coalesce(wi.item_number, ar.proposed->>'itemNumber') end
           as item_number,
         case when ar.entity_type <> 'work_item_amendment'
           then ar.proposed->>'challanNumber' end as document_number,
         ar.proposed, ar.diff, ar.reason, ar.status, ar.requested_by_user_id,
         ar.decided_by_user_id, ar.decided_at, ar.decision_note, ar.created_at,
         avo.id as variation_order_id,
         avo.loa_number as variation_loa_number,
         to_char(avo.loa_date, 'YYYY-MM-DD') as variation_loa_date,
         avo.agreement_number as variation_agreement_number,
         avo.variation_number as variation_number,
         avo.original_filename as variation_filename,
         avo.sha256 as variation_sha256,
         avo.size_bytes as variation_size_bytes,
         avo.verdict as variation_verdict,
         avo.uploaded_by_user_id as variation_uploaded_by_user_id,
         avo.created_at as variation_created_at
  from approval_requests ar
  join works w on w.id = ar.work_id
  left join work_items wi
    on wi.id = ar.entity_id and ar.entity_type = 'work_item_amendment'
  left join amendment_variation_orders avo on avo.approval_request_id = ar.id
`;

/** The cited order, assembled from the joined columns. Null unless a
 * verified one has actually been attached — the table holds no other kind. */
function toVariationOrder(row: ApprovalRow): VariationOrder | null {
  if (
    row.variation_order_id === null ||
    row.variation_loa_number === null ||
    row.variation_loa_date === null ||
    row.variation_agreement_number === null ||
    row.variation_number === null ||
    row.variation_filename === null ||
    row.variation_sha256 === null ||
    row.variation_size_bytes === null ||
    row.variation_uploaded_by_user_id === null ||
    row.variation_created_at === null
  ) {
    return null;
  }
  return {
    id: row.variation_order_id,
    approvalRequestId: row.id,
    loaNumber: row.variation_loa_number,
    loaDate: row.variation_loa_date,
    agreementNumber: row.variation_agreement_number,
    variationNumber: row.variation_number,
    originalFilename: row.variation_filename,
    sha256: row.variation_sha256,
    sizeBytes: Number(row.variation_size_bytes),
    verdict: parseJsonbColumn(row.variation_verdict) as VariationOrder['verdict'],
    uploadedByUserId: row.variation_uploaded_by_user_id,
    createdAt: row.variation_created_at.toISOString(),
  };
}

function toApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    workId: row.work_id,
    workCode: row.work_code,
    itemNumber: row.item_number,
    documentNumber: row.document_number,
    proposed: parseJsonbColumn(row.proposed),
    diff: parseJsonbColumn(row.diff) as AmendmentDiffEntry[],
    reason: row.reason,
    status: row.status,
    requestedByUserId: row.requested_by_user_id,
    decidedByUserId: row.decided_by_user_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionNote: row.decision_note,
    variationOrder: toVariationOrder(row),
    createdAt: row.created_at.toISOString(),
  };
}

export async function readApproval(
  tx: TransactionSql,
  approvalId: string,
): Promise<ApprovalRequest> {
  const [row] = await tx<ApprovalRow[]>`
    ${tx.unsafe(APPROVAL_SELECT)}
    where ar.id = ${approvalId}
  `;
  if (!row) throw httpError(404, 'APPROVAL_NOT_FOUND', 'No such approval request.');
  return toApproval(row);
}

/** can_approve_amendments is an explicit per-member authority, separate
 * from role — the same model as can_issue_documents. */
export async function isApprover(tx: TransactionSql, userId: string): Promise<boolean> {
  const [membership] = await tx<{ can_approve_amendments: boolean }[]>`
    select can_approve_amendments from organisation_memberships
    where user_id = ${userId}
      and organisation_id = app_private.current_organisation_id()
  `;
  return membership?.can_approve_amendments ?? false;
}

async function requireApprover(tx: TransactionSql, userId: string): Promise<void> {
  if (!(await isApprover(tx, userId))) {
    throw httpError(
      403,
      'AUTHORITY_REQUIRED',
      'Your membership does not carry the amendment-approval authority.',
    );
  }
}

/**
 * R9/§5.6: one pending request per record. The partial unique index
 * backs this against concurrency; this pre-check exists so the ordinary
 * (non-racing) caller gets the pending request's id in the uniform
 * conflict shape — a unique-violation aborts the transaction, so the id
 * can no longer be read once the index has spoken.
 */
async function assertNoPendingRequest(
  tx: TransactionSql,
  entityType: ApprovalRequest['entityType'],
  entityId: string,
): Promise<void> {
  const [pending] = await tx<{ id: string }[]>`
    select id from approval_requests
    where entity_type = ${entityType} and entity_id = ${entityId}
      and status = 'pending'
  `;
  if (pending) {
    throw httpError(
      409,
      'PENDING_EXISTS',
      'This record already has a pending request; decide or withdraw it first.',
      { existingRecordId: pending.id },
    );
  }
}

/** Rejects negative decimals before they reach a CHECK constraint, so the
 * caller gets a friendly 400 instead of a 500. */
function assertNonNegative(value: string, field: string): void {
  if (value.startsWith('-')) {
    throw httpError(400, 'AMENDMENT_INVALID', `${field} cannot be negative.`);
  }
}

/**
 * Applies an approved amendment in the CURRENT transaction and marks the
 * request approved. Called from the approve endpoint and from direct-apply
 * proposals. The request row must already be locked and pending, and the
 * caller must have re-checked the approver authority inside this same
 * transaction — approval and apply are one atomic step: if any invariant
 * fails against live state, the whole transaction rolls back and the
 * request REMAINS PENDING (documented decision: the approve call fails
 * atomically rather than recording a failed apply).
 */
export async function applyApproval(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  request: {
    id: string;
    entity_id: string | null;
    work_id: string;
    proposed: unknown;
    diff: unknown;
  },
  note: string | null,
): Promise<void> {
  const proposed = parseJsonbColumn(request.proposed) as ProposedSnapshot;
  let boundEntityId = request.entity_id;

  if (proposed.kind === 'change_item') {
    // Lock the target item: delivery-challan issue takes the same lock
    // before validating quantities, so a ceiling change can never race an
    // in-flight issue (see challans.ts).
    const [item] = await tx<
      { id: string; item_number: string; current_quantity: string }[]
    >`
      select id, item_number,
             coalesce(effective_quantity, awarded_quantity)::text as current_quantity
      from work_items
      where id = ${proposed.workItemId} and work_id = ${request.work_id}
        and deleted_at is null
      for update
    `;
    if (!item) {
      throw httpError(
        409,
        'AMENDMENT_ITEM_MISSING',
        'The amended Work item no longer exists.',
      );
    }
    const changes = proposed.changes;
    if (changes.quantity !== undefined) {
      // Floor revalidation against LIVE state, in exact SQL numeric
      // arithmetic: a REDUCTION can never drop the ceiling below what
      // issued challans already delivered, below what installation
      // records already installed, NOR below what recorded PAC
      // certificates already certified (spec R7 completed; the R5
      // installed-≤-LOA and R18 certified-≤-installed invariants would
      // otherwise be breached retroactively). Every one of those writers
      // takes this same work_items row lock, so the sums cannot race this
      // apply, and the 0030 trigger holds the identical floor against
      // direct SQL.
      //
      // R7 floors REDUCTIONS, so an increase is never blocked. That is
      // not a nicety: on a Work with the excess-delivery toggle on, R4
      // permits delivered to exceed the sanctioned quantity, and the
      // lawful fix R5 prescribes ("amend the item quantity first") is
      // precisely an increase that may still sit below the delivered
      // total. Flooring it would refuse the one remedy the rule names.
      // Installed and certified can never exceed the CURRENT ceiling, so
      // an increase cannot breach R5 or R18 either.
      const [floor] = await tx<
        {
          delivered: string;
          installed: string;
          certified: string;
          violates: boolean;
        }[]
      >`
        with delivered as (
          select coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0)
                   as total
          from delivery_challan_items dci
          join delivery_challans dc on dc.id = dci.delivery_challan_id
          where dci.work_item_id = ${item.id}
        ), installed as (
          select coalesce(sum(i.quantity), 0) as total
          from installations i
          where i.work_item_id = ${item.id} and i.status = 'recorded'
        ), certified as (
          select coalesce(sum(pci.certified_quantity), 0) as total
          from pac_certificate_items pci
          join pac_certificates pc on pc.id = pci.pac_certificate_id
          where pci.work_item_id = ${item.id} and pc.status = 'recorded'
        )
        select delivered.total::text as delivered,
               installed.total::text as installed,
               certified.total::text as certified,
               ${changes.quantity}::numeric(18,3)
                 < ${item.current_quantity}::numeric(18,3)
               and greatest(delivered.total, installed.total, certified.total)
                 > ${changes.quantity}::numeric(18,3) as violates
        from delivered, installed, certified
      `;
      if (floor?.violates === true) {
        throw httpError(
          409,
          'AMENDMENT_FLOOR_VIOLATION',
          `The quantity of ${item.item_number} cannot go below the already-delivered ${floor.delivered}, the already-installed ${floor.installed}, or the already-certified ${floor.certified}.`,
        );
      }
    }
    await tx`
      update work_items set
        effective_quantity = case
          when ${changes.quantity !== undefined}
          then ${changes.quantity ?? null}::numeric(18,3)
          else effective_quantity end,
        effective_unit_rate = case
          when ${changes.rate !== undefined}
          then ${changes.rate ?? null}::numeric(18,6)
          else effective_unit_rate end,
        effective_description = case
          when ${changes.description !== undefined}
          then ${changes.description ?? null}
          else effective_description end,
        effective_unit = case
          when ${changes.unit !== undefined}
          then ${changes.unit ?? null}
          else effective_unit end
      where id = ${item.id}
    `;
  } else if (proposed.kind === 'remove_item') {
    // R7 omission. Soft-delete under the item row lock, never erasure:
    // the item number stays reserved for the life of the Work (the 0001
    // uniqueness constraint counts deleted rows), so a later addition
    // can never reuse it.
    const [item] = await tx<{ id: string; item_number: string }[]>`
      select id, item_number from work_items
      where id = ${proposed.workItemId} and work_id = ${request.work_id}
        and deleted_at is null
      for update
    `;
    if (!item) {
      throw httpError(
        409,
        'AMENDMENT_ITEM_MISSING',
        'The Work item is already omitted or no longer exists.',
      );
    }
    // Evidence revalidation against LIVE state — a delivery, installation,
    // PAC certificate or Measurement Book line may have landed between
    // filing and deciding. The 0030 trigger refuses the same set against
    // every writer; this query exists to name what blocks the omission.
    const [evidence] = await tx<
      {
        delivered: string;
        installed: string;
        certified: string;
        billed_lines: string;
      }[]
    >`
      select
        coalesce((
          select sum(dci.quantity) from delivery_challan_items dci
          join delivery_challans dc on dc.id = dci.delivery_challan_id
          where dci.work_item_id = ${item.id} and dc.status <> 'cancelled'
        ), 0)::text as delivered,
        coalesce((
          select sum(i.quantity) from installations i
          where i.work_item_id = ${item.id} and i.status = 'recorded'
        ), 0)::text as installed,
        coalesce((
          select sum(pci.certified_quantity) from pac_certificate_items pci
          join pac_certificates pc on pc.id = pci.pac_certificate_id
          where pci.work_item_id = ${item.id} and pc.status = 'recorded'
        ), 0)::text as certified,
        (
          select count(*) from measurement_book_lines mbl
          join measurement_books mb on mb.id = mbl.measurement_book_id
          where mbl.work_item_id = ${item.id} and mb.status <> 'cancelled'
            and (
              mbl.delta_supplied <> 0 or mbl.delta_installed <> 0
              or mbl.delta_pac <> 0 or mbl.delta_final_bill <> 0
              or mbl.prior_supplied <> 0 or mbl.prior_installed <> 0
              or mbl.prior_pac <> 0 or mbl.prior_final_bill <> 0
            )
        )::text as billed_lines
    `;
    const blocking = [
      ...(Number(evidence?.delivered) > 0
        ? [`delivery challans (${evidence?.delivered ?? '0'})`]
        : []),
      ...(Number(evidence?.installed) > 0
        ? [`installations (${evidence?.installed ?? '0'})`]
        : []),
      ...(Number(evidence?.certified) > 0
        ? [`PAC certificates (${evidence?.certified ?? '0'})`]
        : []),
      ...(Number(evidence?.billed_lines) > 0
        ? [`Measurement Book lines (${evidence?.billed_lines ?? '0'})`]
        : []),
    ];
    if (blocking.length > 0) {
      throw httpError(
        409,
        'AMENDMENT_ITEM_HAS_EVIDENCE',
        `Item ${item.item_number} carries evidence and cannot be omitted: ${blocking.join(', ')}. Cancel that evidence first.`,
      );
    }
    // THE AUTHORISATION GATE (owner ruling, 2026-08-13). An omission after
    // award is a contractual event, and the railway's variation order is
    // what authorises it. The order is uploaded and VERIFIED against this
    // very amendment before it is stored, so the presence of a row here is
    // the authorisation — there is no unverified kind to check for.
    //
    // Checked inside the same transaction that applies, under the request
    // and item locks the caller already holds, exactly like the approver-
    // authority check: a request filed without an order is lawful,
    // approving one is not. Migration 0058 holds the identical rule
    // against every writer, twice — at the request when it becomes
    // approved, and at the item when it is soft-deleted.
    //
    // Deliberately AFTER the evidence test, and 0058's trigger orders the
    // two the same way: an item carrying a delivery challan cannot be
    // omitted at all, and answering "go and fetch a variation order" would
    // send the operator to obtain paperwork that will not help. What they
    // need to hear first is "cancel that challan".
    const [cited] = await tx<{ id: string }[]>`
      select id from amendment_variation_orders
      where approval_request_id = ${request.id} and verified
    `;
    if (!cited) {
      throw httpError(
        409,
        'OMISSION_VARIATION_REFERENCE_REQUIRED',
        `Item ${item.item_number} cannot be omitted until the railway variation order authorising it has been uploaded and verified. Cite the variation order against this request, then approve it.`,
        { approvalId: request.id },
      );
    }
    await tx`
      update work_items set deleted_at = now() where id = ${item.id}
    `;
    boundEntityId = item.id;
  } else if (proposed.kind === 'add_item') {
    // add_item: the approved values become the new item's baseline.
    const [schedule] = await tx<{ id: string }[]>`
      select id from work_schedules
      where id = ${proposed.scheduleId} and work_id = ${request.work_id}
    `;
    if (!schedule) {
      throw httpError(
        409,
        'AMENDMENT_SCHEDULE_MISSING',
        'The target schedule no longer exists on this Work.',
      );
    }
    const newItemId = randomUUID();
    await tx`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, amendment_added,
        source_approval_id, source_evidence
      )
      values (
        ${newItemId}, ${organisationId}, ${request.work_id},
        ${proposed.scheduleId}, ${proposed.itemNumber}, ${proposed.description},
        ${proposed.unitCode}, ${proposed.quantity}, ${proposed.rate}, true,
        ${request.id}, ${jsonb(tx, { amendmentApprovalId: request.id })}
      )
    `.catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === '23505') {
        throw httpError(
          409,
          'DUPLICATE_ENTRY',
          `Item number ${proposed.itemNumber} already exists in this Work.`,
        );
      }
      throw error;
    });
    boundEntityId = newItemId;
  } else if (proposed.kind === 'cancel_replace_challan') {
    // Milestone 7 Path A: cancel the issued (still evidence-free) challan
    // and draft its replacement, atomically, revalidating live state.
    // Cancelling an issued document demands the explicit cancel authority
    // of the DECIDER, exactly like the direct cancel routes — approval
    // authority alone does not cancel documents. A 403 here rolls back
    // and the request remains pending, like any other failed apply.
    await requireAuthority(tx, userId, 'cancel');
    await applyChallanCancelReplace(tx, organisationId, userId, request.id, proposed);
  } else if (proposed.kind === 'cancel_replace_issue_challan') {
    await requireAuthority(tx, userId, 'cancel');
    await applyIssueChallanCancelReplace(
      tx,
      organisationId,
      userId,
      request.id,
      proposed,
    );
  } else if (proposed.kind === 'work_supersede') {
    // Withdrawing a confirmed Work takes the deciding user's CANCEL
    // authority on top of the approval authority, for the same reason
    // cancel-and-replace does: approval authority decides whether a change
    // is warranted, while taking an authoritative record out of service is
    // a separate grant. No new permission column exists for this —
    // superseding mints no number and issues no document, so `cancel` is
    // the authority the product already means by "may withdraw a record".
    await requireAuthority(tx, userId, 'cancel');
    await applyWorkSupersede(tx, organisationId, userId, request.id, proposed);
  } else {
    // Milestone 7 Path B: issue a numbered correction notice; the original
    // challan is never touched. Minting a numbered document demands the
    // deciding user's issue authority, mirroring the direct issue routes.
    await requireAuthority(tx, userId, 'issue');
    await applyCorrectionNotice(tx, organisationId, userId, request.id, proposed);
  }

  await tx`
    update approval_requests set
      status = 'approved',
      decided_by_user_id = ${userId},
      decided_at = now(),
      decision_note = ${note},
      entity_id = ${boundEntityId}
    where id = ${request.id}
  `;
  const approvedAction =
    proposed.kind === 'change_item' ||
    proposed.kind === 'add_item' ||
    proposed.kind === 'remove_item'
      ? 'amendment.approved'
      : proposed.kind === 'work_supersede'
        ? 'work.superseded'
        : 'correction.approved';
  // The authorisation travels with the decision. The audit-diff machinery
  // already records the value pairs the amendment moved; for an omission
  // the trail must also answer "on whose authority", so the cited order's
  // identity — every field of it extracted from the document, not typed —
  // is recorded beside the diff rather than left to be joined for later.
  const [citedForAudit] =
    proposed.kind === 'remove_item'
      ? await tx<
          {
            id: string;
            loa_number: string;
            loa_date: string;
            agreement_number: string;
            variation_number: string;
            sha256: string;
          }[]
        >`
          select id, loa_number, to_char(loa_date, 'YYYY-MM-DD') as loa_date,
                 agreement_number, variation_number, sha256
          from amendment_variation_orders
          where approval_request_id = ${request.id}
        `
      : [];
  await audit(
    tx,
    organisationId,
    userId,
    approvedAction,
    'approval_requests',
    request.id,
    {
      workId: request.work_id,
      entityId: boundEntityId,
      kind: proposed.kind,
      diff: parseJsonbColumn(request.diff),
      ...(citedForAudit === undefined
        ? {}
        : {
            variationOrder: {
              id: citedForAudit.id,
              loaNumber: citedForAudit.loa_number,
              loaDate: citedForAudit.loa_date,
              agreementNumber: citedForAudit.agreement_number,
              variationNumber: citedForAudit.variation_number,
              sha256: citedForAudit.sha256,
            },
          }),
    },
  );
}

/** The wire/stored shape of a verdict: the claims and the outcome, without
 * the extracted-facts block, which is written into its own columns. */
function storedVerdict(verdict: VariationOrderVerdict): VariationOrder['verdict'] {
  return {
    verified: verdict.verified,
    claims: verdict.claims.map((claim) => ({ ...claim })),
    failedClaims: [...verdict.failedClaims],
  };
}

interface OmissionTarget {
  readonly workId: string;
  readonly omission: OmissionUnderVerification;
}

/**
 * Everything a variation order must be checked against: the Work's LOA
 * identity and the item's own stored facts. Read from the database, never
 * from the request — the operator supplies only the PDF.
 *
 * Refuses anything that is not a PENDING omission: a decided request has
 * nothing left to authorise, and the other amendment kinds are outside
 * this ruling's scope.
 */
async function readOmissionUnderVerification(
  tx: TransactionSql,
  userId: string,
  approvalId: string,
  lock = false,
): Promise<OmissionTarget> {
  const [row] = lock
    ? await tx<ApprovalTargetRow[]>`
        select id, work_id, status, proposed from approval_requests
        where id = ${approvalId}
        for update
      `
    : await tx<ApprovalTargetRow[]>`
        select id, work_id, status, proposed from approval_requests
        where id = ${approvalId}
      `;
  if (!row) throw httpError(404, 'APPROVAL_NOT_FOUND', 'No such approval request.');
  // Work scope, exactly as every other amendment surface checks it: an
  // 'assigned'-scoped member may not cite an order against someone else's
  // Work, and a cross-tenant id never resolves at all.
  await assertWorkAccess(tx, userId, row.work_id);
  const proposed = parseJsonbColumn(row.proposed) as ProposedSnapshot;
  if (proposed.kind !== 'remove_item') {
    throw httpError(
      409,
      'VARIATION_ORDER_NOT_APPLICABLE',
      'Only an item omission cites a railway variation order. This request is not an omission.',
    );
  }
  if (row.status !== 'pending') {
    throw httpError(
      409,
      'APPROVAL_NOT_PENDING',
      `This request is already ${row.status}.`,
    );
  }
  const [work] = await tx<
    { letter_number: string; letter_date: string; contract_value: string }[]
  >`
    select letter_number, to_char(letter_date, 'YYYY-MM-DD') as letter_date,
           contract_value::text as contract_value
    from works where id = ${row.work_id} and deleted_at is null
  `;
  if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  const [item] = await tx<
    { item_number: string; unit_code: string; awarded_quantity: string }[]
  >`
    select item_number, coalesce(effective_unit, unit_code) as unit_code,
           coalesce(effective_quantity, awarded_quantity)::text as awarded_quantity
    from work_items
    where id = ${proposed.workItemId} and work_id = ${row.work_id}
      and deleted_at is null
  `;
  if (!item) {
    throw httpError(
      409,
      'AMENDMENT_ITEM_MISSING',
      'The Work item is already omitted or no longer exists.',
    );
  }
  return {
    workId: row.work_id,
    omission: {
      workLetterNumber: work.letter_number,
      workLetterDate: work.letter_date,
      itemNumber: item.item_number,
      unitCode: item.unit_code,
      awardedQuantity: item.awarded_quantity,
      contractValue: work.contract_value,
    },
  };
}

interface ApprovalTargetRow {
  id: string;
  work_id: string;
  status: string;
  proposed: unknown;
}

export function registerAmendmentRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  // --- Propose a change to an existing item (quantity/rate/description/
  // unit; quantity '0' omits the item) --------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/amendments',
      schema: {
        params: IdParamsSchema,
        body: ProposeAmendmentRequestSchema,
        response: { 201: ApprovalRequestSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const changed = Object.keys(body.changes);
      if (changed.length === 0) {
        throw httpError(
          400,
          'AMENDMENT_EMPTY',
          'An amendment must change at least one field.',
        );
      }
      if (body.changes.quantity !== undefined) {
        assertNonNegative(body.changes.quantity, 'quantity');
      }
      if (body.changes.rate !== undefined) {
        assertNonNegative(body.changes.rate, 'rate');
      }

      const approval = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        // The works row lock pairs with the one POST
        // /api/works/:id/complete holds: a proposal filed here and a
        // completion on the same Work serialise, so a pending proposal
        // can never be stranded behind a completed Work (the 0031
        // approval-request insert guard is the database backstop).
        const [work] = await tx<{ status: string }[]>`
            select status from works where id = ${workId} and deleted_at is null
            for update
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'proposing an amendment');
        // Lock the item so the diff's before-values are consistent with
        // any concurrent apply.
        const [item] = await tx<
          {
            id: string;
            item_number: string;
            current_quantity: string;
            current_rate: string;
            current_description: string;
            current_unit: string;
          }[]
        >`
            select id, item_number,
                   coalesce(effective_quantity, awarded_quantity)::text as current_quantity,
                   coalesce(effective_unit_rate, effective_rate)::text as current_rate,
                   coalesce(effective_description, description) as current_description,
                   coalesce(effective_unit, unit_code) as current_unit
            from work_items
            where id = ${body.workItemId} and work_id = ${workId}
              and deleted_at is null
            for update
          `;
        if (!item) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }
        await assertNoPendingRequest(tx, 'work_item_amendment', item.id);

        // Normalise proposed decimals through SQL numeric, so the stored
        // snapshot and diff carry the exact values apply will write.
        const [normalised] = await tx<
          { quantity: string | null; rate: string | null }[]
        >`
            select ${body.changes.quantity ?? null}::numeric(18,3)::text as quantity,
                   ${body.changes.rate ?? null}::numeric(18,6)::text as rate
          `;
        const changes: ChangeSet = {
          ...(body.changes.quantity !== undefined && normalised?.quantity != null
            ? { quantity: normalised.quantity }
            : {}),
          ...(body.changes.rate !== undefined && normalised?.rate != null
            ? { rate: canonicalRateText(normalised.rate) }
            : {}),
          ...(body.changes.description !== undefined
            ? { description: body.changes.description }
            : {}),
          ...(body.changes.unit !== undefined ? { unit: body.changes.unit } : {}),
        };
        const diff: AmendmentDiffEntry[] = [];
        if (changes.quantity !== undefined) {
          diff.push({
            field: 'quantity',
            before: item.current_quantity,
            after: changes.quantity,
          });
        }
        if (changes.rate !== undefined) {
          diff.push({
            field: 'rate',
            before: canonicalRateText(item.current_rate),
            after: changes.rate,
          });
        }
        if (changes.description !== undefined) {
          diff.push({
            field: 'description',
            before: item.current_description,
            after: changes.description,
          });
        }
        if (changes.unit !== undefined) {
          diff.push({
            field: 'unit',
            before: item.current_unit,
            after: changes.unit,
          });
        }

        const proposed: ProposedSnapshot = {
          kind: 'change_item',
          workItemId: item.id,
          itemNumber: item.item_number,
          changes,
        };
        const [created] = await tx<
          { id: string; entity_id: string | null; work_id: string }[]
        >`
            insert into approval_requests (
              organisation_id, entity_type, entity_id, work_id, proposed,
              diff, reason, requested_by_user_id
            )
            values (
              ${organisationId}, 'work_item_amendment', ${item.id}, ${workId},
              ${jsonb(tx, proposed)}, ${jsonb(tx, diff)}, ${body.reason},
              ${user.id}
            )
            returning id, entity_id, work_id
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'PENDING_EXISTS',
              'This item already has a pending amendment; decide or withdraw it first.',
            );
          }
          throw error;
        });
        if (!created) throw new Error('approval insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'amendment.proposed',
          'approval_requests',
          created.id,
          {
            workId,
            workItemId: item.id,
            itemNumber: item.item_number,
            diff,
            reason: body.reason,
          },
        );

        // Direct-apply: an approval-authority holder's proposal applies
        // immediately, auto-recording the approved request with
        // decided_by = requester — the audit trail is identical.
        if (await isApprover(tx, user.id)) {
          await applyApproval(
            tx,
            organisationId,
            user.id,
            { ...created, proposed, diff },
            null,
          );
        }
        return readApproval(tx, created.id);
      });
      return reply.status(201).send(approval);
    },
  );

  // --- Propose ADDING a new item to a schedule ------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/amendments/items',
      schema: {
        params: IdParamsSchema,
        body: ProposeAddItemRequestSchema,
        response: { 201: ApprovalRequestSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      assertNonNegative(body.rate, 'rate');
      if (!isPositiveDecimal(body.quantity)) {
        throw httpError(
          400,
          'AMENDMENT_INVALID',
          'A new item needs a strictly positive quantity.',
        );
      }

      const approval = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        // The works row lock pairs with the one POST
        // /api/works/:id/complete holds: a proposal filed here and a
        // completion on the same Work serialise, so a pending proposal
        // can never be stranded behind a completed Work (the 0031
        // approval-request insert guard is the database backstop).
        const [work] = await tx<{ status: string }[]>`
            select status from works where id = ${workId} and deleted_at is null
            for update
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'proposing an amendment');
        const [schedule] = await tx<{ id: string }[]>`
            select id from work_schedules
            where id = ${body.scheduleId} and work_id = ${workId}
          `;
        if (!schedule) {
          throw httpError(404, 'SCHEDULE_NOT_FOUND', 'No such schedule.');
        }
        // Deliberately unfiltered by deleted_at: an OMITTED item keeps
        // its number reserved forever (R7), so the number can never be
        // handed to a different item later. The 0001 uniqueness
        // constraint counts soft-deleted rows for the same reason.
        const [duplicate] = await tx<{ id: string; deleted_at: Date | null }[]>`
            select id, deleted_at from work_items
            where work_id = ${workId} and item_number = ${body.itemNumber}
          `;
        if (duplicate) {
          throw httpError(
            409,
            'DUPLICATE_ENTRY',
            duplicate.deleted_at === null
              ? `Item number ${body.itemNumber} already exists in this Work.`
              : `Item number ${body.itemNumber} belonged to an omitted item and stays reserved; use a new number.`,
          );
        }
        const [normalised] = await tx<{ quantity: string; rate: string }[]>`
            select ${body.quantity}::numeric(18,3)::text as quantity,
                   ${body.rate}::numeric(18,6)::text as rate
          `;
        if (!normalised) throw new Error('normalisation returned no row');
        const proposed: ProposedSnapshot = {
          kind: 'add_item',
          scheduleId: body.scheduleId,
          itemNumber: body.itemNumber,
          description: body.description,
          unitCode: body.unitCode,
          quantity: normalised.quantity,
          rate: canonicalRateText(normalised.rate),
        };
        const diff: AmendmentDiffEntry[] = [
          { field: 'item', before: null, after: body.itemNumber },
          { field: 'description', before: null, after: body.description },
          { field: 'unit', before: null, after: body.unitCode },
          { field: 'quantity', before: null, after: normalised.quantity },
          { field: 'rate', before: null, after: canonicalRateText(normalised.rate) },
        ];
        const [created] = await tx<
          { id: string; entity_id: string | null; work_id: string }[]
        >`
            insert into approval_requests (
              organisation_id, entity_type, entity_id, work_id, proposed,
              diff, reason, requested_by_user_id
            )
            values (
              ${organisationId}, 'work_item_amendment', null, ${workId},
              ${jsonb(tx, proposed)}, ${jsonb(tx, diff)}, ${body.reason},
              ${user.id}
            )
            returning id, entity_id, work_id
          `;
        if (!created) throw new Error('approval insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'amendment.proposed',
          'approval_requests',
          created.id,
          {
            workId,
            itemNumber: body.itemNumber,
            diff,
            reason: body.reason,
          },
        );
        if (await isApprover(tx, user.id)) {
          await applyApproval(
            tx,
            organisationId,
            user.id,
            { ...created, proposed, diff },
            null,
          );
        }
        return readApproval(tx, created.id);
      });
      return reply.status(201).send(approval);
    },
  );

  // --- Propose OMITTING (retiring) an existing item -------------------------
  // R7's removal half, through the same approval engine as add_item: the
  // omission is a soft-delete, allowed only while the item is free of
  // delivery, installation, PAC, and billing evidence, and the item
  // number stays reserved forever afterwards.
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/amendments/removals',
      schema: {
        params: IdParamsSchema,
        body: ProposeRemoveItemRequestSchema,
        response: { 201: ApprovalRequestSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;

      const approval = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        // The works row lock pairs with the one POST
        // /api/works/:id/complete holds: a proposal filed here and a
        // completion on the same Work serialise, so a pending proposal
        // can never be stranded behind a completed Work (the 0031
        // approval-request insert guard is the database backstop).
        const [work] = await tx<{ status: string }[]>`
            select status from works where id = ${workId} and deleted_at is null
            for update
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'proposing an amendment');
        // Lock the item so the before-values recorded in the diff match
        // whatever a concurrent apply leaves behind.
        const [item] = await tx<
          {
            id: string;
            item_number: string;
            current_quantity: string;
            current_description: string;
          }[]
        >`
            select id, item_number,
                   coalesce(effective_quantity, awarded_quantity)::text
                     as current_quantity,
                   coalesce(effective_description, description)
                     as current_description
            from work_items
            where id = ${body.workItemId} and work_id = ${workId}
              and deleted_at is null
            for update
          `;
        if (!item) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }
        await assertNoPendingRequest(tx, 'work_item_amendment', item.id);

        const proposed: ProposedSnapshot = {
          kind: 'remove_item',
          workItemId: item.id,
          itemNumber: item.item_number,
        };
        // Before/after evidence for an omission: the item existed with
        // this description and quantity, and after the amendment it does
        // not (the number stays reserved).
        const diff: AmendmentDiffEntry[] = [
          { field: 'item', before: item.item_number, after: null },
          { field: 'description', before: item.current_description, after: null },
          { field: 'quantity', before: item.current_quantity, after: null },
        ];
        const [created] = await tx<
          { id: string; entity_id: string | null; work_id: string }[]
        >`
            insert into approval_requests (
              organisation_id, entity_type, entity_id, work_id, proposed,
              diff, reason, requested_by_user_id
            )
            values (
              ${organisationId}, 'work_item_amendment', ${item.id}, ${workId},
              ${jsonb(tx, proposed)}, ${jsonb(tx, diff)}, ${body.reason},
              ${user.id}
            )
            returning id, entity_id, work_id
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'PENDING_EXISTS',
              'This item already has a pending amendment; decide or withdraw it first.',
            );
          }
          throw error;
        });
        if (!created) throw new Error('approval insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'amendment.proposed',
          'approval_requests',
          created.id,
          {
            workId,
            workItemId: item.id,
            itemNumber: item.item_number,
            diff,
            reason: body.reason,
          },
        );
        // NO DIRECT APPLY, deliberately — unlike a change or an addition.
        // An omission now needs the railway's variation order verified
        // against it, and that arrives as a separate upload; direct-apply
        // would 409 the FILING for anyone holding the approval authority,
        // when filing without an order yet is exactly what the ruling
        // permits. The omission therefore always waits in the queue until
        // its order is cited, and is then approved explicitly.
        return readApproval(tx, created.id);
      });
      return reply.status(201).send(approval);
    },
  );

  // --- Cite the railway variation order that authorises an omission --------
  // The upload path reuses the machinery the LOA and contract-source
  // uploads already established — the same PDF magic-byte gate, the same
  // malware scan, the same Poppler-only text extraction (a non-Poppler
  // binary is refused outright by PR #24's probe), the same private object
  // key — and adds the verification the ruling asks for. Nothing is stored
  // unless the document itself supports every required claim.
  tenantRoute(
    {
      method: 'POST',
      url: '/api/approvals/:id/variation-order',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParamsSchema,
        querystring: AttachVariationOrderQuerySchema,
        response: {
          201: AttachVariationOrderResponseSchema,
          ...upstreamErrorResponses,
        },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: approvalId } = request.params;
      const { filename } = request.query;
      const { bytes: body } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the variation order',
      });

      // What the order must describe is read BEFORE the scan and the
      // extraction, so a caller with no access to this Work cannot spend
      // either, and so the verification has something to check against.
      const target = await tenant((tx) =>
        readOmissionUnderVerification(tx, user.id, approvalId),
      );
      await assertNotMalware(scanner, body);

      let text: string;
      try {
        text = await extractPdfText(body);
      } catch (error) {
        // A misconfigured extraction binary is an operator fault, not a
        // fault in the uploaded order: reporting it as "this PDF has no
        // text" would send the operator chasing the wrong problem.
        if (error instanceof PdfToTextConfigurationError) {
          throw httpError(
            503,
            'PDF_TEXT_EXTRACTION_UNAVAILABLE',
            'PDF text extraction is not correctly configured on the server. No document was rejected; contact your administrator.',
            { reason: error.message },
          );
        }
        throw httpError(
          400,
          'VARIATION_ORDER_EXTRACTION_FAILED',
          'The variation order could not be read. Upload the machine-readable order issued by IREPS, not a scan or a photograph of it.',
          { reason: error instanceof Error ? error.message : 'extraction failed' },
        );
      }

      const verdict = verifyVariationOrder(text, target.omission);
      const sha256 = createHash('sha256').update(body).digest('hex');
      if (!verdict.verified) {
        // The refusal is recorded: an operator repeatedly presenting an
        // order the document does not support is worth seeing, and the
        // rejected bytes are never stored.
        await tenant(async (tx) => {
          await audit(
            tx,
            organisationId,
            user.id,
            'amendment.variation_order_rejected',
            'approval_requests',
            approvalId,
            {
              workId: target.workId,
              filename,
              sha256,
              failedClaims: verdict.failedClaims,
            },
          );
        });
        throw httpError(
          409,
          'OMISSION_VARIATION_ORDER_UNVERIFIED',
          `The uploaded document does not authorise this omission. ${describeFailedClaims(verdict)}`,
          { failedClaims: verdict.failedClaims, claims: verdict.claims },
        );
      }

      const documentId = randomUUID();
      const objectKey = `${organisationId}/variationorder/${documentId}.pdf`;
      await storage.put(objectKey, body);

      const result = await tenant(async (tx) => {
        // Re-read under the request lock: the amendment could have been
        // decided or withdrawn while the scan and extraction ran, and the
        // item's own facts could have moved under a concurrent amendment.
        const current = await readOmissionUnderVerification(
          tx,
          user.id,
          approvalId,
          true,
        );
        const recheck = verifyVariationOrder(text, current.omission);
        if (!recheck.verified) {
          throw httpError(
            409,
            'OMISSION_VARIATION_ORDER_UNVERIFIED',
            `The Work changed while the variation order was being read, and the order no longer supports this omission. ${describeFailedClaims(recheck)}`,
            { failedClaims: recheck.failedClaims, claims: recheck.claims },
          );
        }
        const document = recheck.document;
        if (
          document.loaNumber === null ||
          document.loaDate === null ||
          document.agreementNumber === null ||
          document.variationNumber === null
        ) {
          // Unreachable while the claims above are required; asserted
          // rather than coerced so a future claim change cannot quietly
          // start writing nulls into the evidence row.
          throw new Error('a verified verdict is missing its extracted identity');
        }
        await tx`
          insert into amendment_variation_orders (
            id, organisation_id, approval_request_id, work_id, loa_number,
            loa_date, agreement_number, variation_number, object_key,
            original_filename, sha256, media_type, size_bytes, verdict,
            verified, uploaded_by_user_id
          )
          values (
            ${documentId}, ${organisationId}, ${approvalId}, ${current.workId},
            ${document.loaNumber}, ${document.loaDate},
            ${document.agreementNumber}, ${document.variationNumber},
            ${objectKey}, ${filename}, ${sha256}, 'application/pdf',
            ${body.length}, ${jsonb(tx, storedVerdict(recheck))}, true,
            ${user.id}
          )
        `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'VARIATION_ORDER_ALREADY_CITED',
              'This omission already cites a variation order. Withdraw the request and file it again to cite a different one.',
            );
          }
          throw error;
        });
        await audit(
          tx,
          organisationId,
          user.id,
          'amendment.variation_order_cited',
          'approval_requests',
          approvalId,
          {
            workId: current.workId,
            variationOrderId: documentId,
            loaNumber: document.loaNumber,
            loaDate: document.loaDate,
            agreementNumber: document.agreementNumber,
            variationNumber: document.variationNumber,
            itemNumber: current.omission.itemNumber,
            filename,
            sha256,
            verifiedClaims: recheck.claims
              .filter((entry) => entry.verified)
              .map((entry) => entry.code),
          },
        );
        return {
          approval: await readApproval(tx, approvalId),
          verdict: storedVerdict(recheck),
        };
      });
      return reply.status(201).send(result);
    },
  );

  // --- Read the cited order back -------------------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/approvals/:id/variation-order/file',
      schema: {
        params: IdParamsSchema,
        response: { 200: Type.Any(), ...errorResponses },
      },
    },
    async ({ request, reply, user, tenant }) => {
      const { id: approvalId } = request.params;
      const row = await tenant(async (tx) => {
        const [document] = await tx<
          { object_key: string; original_filename: string; work_id: string }[]
        >`
          select object_key, original_filename, work_id
          from amendment_variation_orders
          where approval_request_id = ${approvalId}
        `;
        if (document === undefined) {
          throw httpError(
            404,
            'VARIATION_ORDER_NOT_FOUND',
            'This request cites no variation order.',
          );
        }
        await assertWorkAccess(tx, user.id, document.work_id);
        return document;
      });
      const bytes = await storage.get(row.object_key);
      void reply.header(
        'content-disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(row.original_filename)}`,
      );
      void reply.type('application/pdf');
      return reply.send(bytes);
    },
  );

  /** Both approval registers order newest first on (created_at, id), so
   * they share one cursor resolver. The queue and the per-Work history
   * read the same table; a cursor from one is a valid position in the
   * other, which is harmless — the WHERE clause still decides what the
   * caller may see. */
  const approvalCursor = (
    tx: TransactionSql,
    cursor: string | undefined,
  ): Promise<string | null> => cursorRowId(tx, 'approval_requests', cursor);

  // --- Per-Work amendment history ------------------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/amendments',
      schema: {
        params: IdParamsSchema,
        querystring: KeysetQuerySchema,
        response: { 200: ApprovalListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const query = request.query;
      const paged = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
            select id from works where id = ${workId} and deleted_at is null
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const cursor = await approvalCursor(tx, query.cursor);
        const rows = await tx<ApprovalRow[]>`
            ${tx.unsafe(APPROVAL_SELECT)}
            where ar.work_id = ${workId}
              and (${cursor === null} or (ar.created_at, ar.id) < (
                select c.created_at, c.id from approval_requests c
                where c.id = ${cursor}))
            order by ar.created_at desc, ar.id desc
            limit ${sqlLimit(query.limit)}
          `;
        return keysetPage(rows, query.limit, (row) => row.id);
      });
      return { approvals: paged.rows.map(toApproval), nextCursor: paged.nextCursor };
    },
  );

  // --- Organisation-wide approvals queue -----------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/approvals',
      schema: {
        querystring: withKeysetQuery(ApprovalListQuerySchema),
        response: { 200: ApprovalListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { status, limit, cursor: rawCursor } = request.query;
      const paged = await tenant(async (tx) => {
        // 'assigned'-scoped memberships see only their Works' requests.
        const full = await hasFullWorkScope(tx, user.id);
        const cursor = await approvalCursor(tx, rawCursor);
        const rows = await tx<ApprovalRow[]>`
            ${tx.unsafe(APPROVAL_SELECT)}
            where (${status ?? null}::text is null or ar.status = ${status ?? null})
              and (${full} or exists (
                select 1 from work_assignments wa
                where wa.work_id = ar.work_id and wa.user_id = ${user.id}
              ))
              and (${cursor === null} or (ar.created_at, ar.id) < (
                select c.created_at, c.id from approval_requests c
                where c.id = ${cursor}))
            order by ar.created_at desc, ar.id desc
            limit ${sqlLimit(limit)}
          `;
        return keysetPage(rows, limit, (row) => row.id);
      });
      return { approvals: paged.rows.map(toApproval), nextCursor: paged.nextCursor };
    },
  );

  // --- Decide ---------------------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/approvals/:id/approve',
      schema: {
        params: IdParamsSchema,
        body: ApproveAmendmentRequestSchema,
        response: { 200: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        // Authority is validated HERE, at apply time, in the same
        // transaction that applies — not merely at submission.
        await requireApprover(tx, user.id);
        const [row] = await tx<
          {
            id: string;
            entity_id: string | null;
            work_id: string;
            status: string;
            proposed: unknown;
            diff: unknown;
          }[]
        >`
          select id, entity_id, work_id, status, proposed, diff
          from approval_requests where id = ${id}
          for update
        `;
        if (!row) {
          throw httpError(404, 'APPROVAL_NOT_FOUND', 'No such approval request.');
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.status !== 'pending') {
          throw httpError(
            409,
            'APPROVAL_NOT_PENDING',
            `This request is already ${row.status}.`,
          );
        }
        await applyApproval(tx, organisationId, user.id, row, body.note ?? null);
        return readApproval(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/approvals/:id/reject',
      schema: {
        params: IdParamsSchema,
        body: RejectAmendmentRequestSchema,
        response: { 200: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        await requireApprover(tx, user.id);
        const [row] = await tx<
          { status: string; work_id: string; entity_type: string }[]
        >`
          select status, work_id, entity_type from approval_requests
          where id = ${id}
          for update
        `;
        if (!row) {
          throw httpError(404, 'APPROVAL_NOT_FOUND', 'No such approval request.');
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.status !== 'pending') {
          throw httpError(
            409,
            'APPROVAL_NOT_PENDING',
            `This request is already ${row.status}.`,
          );
        }
        await tx`
          update approval_requests set
            status = 'rejected',
            decided_by_user_id = ${user.id},
            decided_at = now(),
            decision_note = ${body.note}
          where id = ${id}
        `;
        const rejectedAction =
          row.entity_type === 'work_item_amendment'
            ? 'amendment.rejected'
            : row.entity_type === 'work_supersede'
              ? 'work.supersede_rejected'
              : 'correction.rejected';
        await audit(
          tx,
          organisationId,
          user.id,
          rejectedAction,
          'approval_requests',
          id,
          {
            note: body.note,
          },
        );
        return readApproval(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/approvals/:id/withdraw',
      schema: {
        params: IdParamsSchema,
        response: { 200: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [row] = await tx<
          {
            status: string;
            work_id: string;
            requested_by_user_id: string;
            entity_type: string;
          }[]
        >`
          select status, work_id, requested_by_user_id, entity_type
          from approval_requests where id = ${id}
          for update
        `;
        if (!row) {
          throw httpError(404, 'APPROVAL_NOT_FOUND', 'No such approval request.');
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.requested_by_user_id !== user.id) {
          throw httpError(
            403,
            'NOT_REQUESTER',
            'Only the requester may withdraw their own pending request.',
          );
        }
        if (row.status !== 'pending') {
          throw httpError(
            409,
            'APPROVAL_NOT_PENDING',
            `This request is already ${row.status}.`,
          );
        }
        await tx`
          update approval_requests set
            status = 'withdrawn',
            decided_by_user_id = ${user.id},
            decided_at = now()
          where id = ${id}
        `;
        const withdrawnAction =
          row.entity_type === 'work_item_amendment'
            ? 'amendment.withdrawn'
            : row.entity_type === 'work_supersede'
              ? 'work.supersede_withdrawn'
              : 'correction.withdrawn';
        await audit(
          tx,
          organisationId,
          user.id,
          withdrawnAction,
          'approval_requests',
          id,
          {},
        );
        return readApproval(tx, id);
      });
    },
  );

  // --- Work settings: the allow_excess_delivery escape hatch ----------------
  tenantRoute(
    {
      method: 'PATCH',
      url: '/api/works/:id',
      schema: {
        params: IdParamsSchema,
        body: UpdateWorkSettingsRequestSchema,
        response: { 200: WorkSettingsResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const [membership] = await tx<{ role: string }[]>`
          select role from organisation_memberships
          where user_id = ${user.id}
            and organisation_id = app_private.current_organisation_id()
        `;
        if (membership?.role !== 'owner') {
          throw httpError(
            403,
            'OWNER_REQUIRED',
            'Only an organisation owner may change excess-delivery permission.',
          );
        }
        await assertWorkAccess(tx, user.id, workId);
        const [updated] = await tx<{ id: string; allow_excess_delivery: boolean }[]>`
          update works set allow_excess_delivery = ${body.allowExcessDelivery}
          where id = ${workId} and deleted_at is null
          returning id, allow_excess_delivery
        `;
        if (!updated) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        await tx`
          insert into audit_events (
            organisation_id, actor_user_id, action, entity_type, entity_id, details
          )
          values (
            ${organisationId}, ${user.id}, 'work.excess_delivery_set', 'works',
            ${workId}, ${jsonb(tx, { allowExcessDelivery: body.allowExcessDelivery })}
          )
        `;
        return {
          id: updated.id,
          allowExcessDelivery: updated.allow_excess_delivery,
        };
      });
    },
  );
}
