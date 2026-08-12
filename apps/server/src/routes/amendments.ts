import { randomUUID } from 'node:crypto';
import {
  ApprovalListQuerySchema,
  ApprovalListResponseSchema,
  ApprovalRequestSchema,
  ApproveAmendmentRequestSchema,
  ProposeAddItemRequestSchema,
  ProposeAmendmentRequestSchema,
  ProposeRemoveItemRequestSchema,
  RejectAmendmentRequestSchema,
  UpdateWorkSettingsRequestSchema,
  WorkSettingsResponseSchema,
  type AmendmentDiffEntry,
  type ApprovalRequest,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import {
  assertWorkAccess,
  hasFullWorkScope,
  requireAuthority,
  requireWriterRole,
} from '../authz.js';
import {
  applyChallanCancelReplace,
  applyCorrectionNotice,
  applyIssueChallanCancelReplace,
  type ChallanCancelReplaceProposal,
  type CorrectionNoticeProposal,
  type IssueChallanCancelReplaceProposal,
} from '../corrections-apply.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { canonicalRateText } from '../rate-text.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { assertWorkOperable } from '../work-status.js';
import { isPositiveDecimal } from './challans.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';

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
  | CorrectionNoticeProposal;

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
}

const APPROVAL_SELECT = `
  select ar.id, ar.entity_type, ar.entity_id, ar.work_id, w.work_code,
         case when ar.entity_type = 'work_item_amendment'
           then coalesce(wi.item_number, ar.proposed->>'itemNumber') end
           as item_number,
         case when ar.entity_type <> 'work_item_amendment'
           then ar.proposed->>'challanNumber' end as document_number,
         ar.proposed, ar.diff, ar.reason, ar.status, ar.requested_by_user_id,
         ar.decided_by_user_id, ar.decided_at, ar.decision_note, ar.created_at
  from approval_requests ar
  join works w on w.id = ar.work_id
  left join work_items wi
    on wi.id = ar.entity_id and ar.entity_type = 'work_item_amendment'
`;

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
      : 'correction.approved';
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
    },
  );
}

export function registerAmendmentRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  // --- Propose a change to an existing item (quantity/rate/description/
  // unit; quantity '0' omits the item) --------------------------------------
  app.post(
    '/api/works/:id/amendments',
    {
      schema: {
        params: IdParamsSchema,
        body: ProposeAmendmentRequestSchema,
        response: { 201: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
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

      const approval = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
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
        },
      );
      return reply.status(201).send(approval);
    },
  );

  // --- Propose ADDING a new item to a schedule ------------------------------
  app.post(
    '/api/works/:id/amendments/items',
    {
      schema: {
        params: IdParamsSchema,
        body: ProposeAddItemRequestSchema,
        response: { 201: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
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

      const approval = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
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
        },
      );
      return reply.status(201).send(approval);
    },
  );

  // --- Propose OMITTING (retiring) an existing item -------------------------
  // R7's removal half, through the same approval engine as add_item: the
  // omission is a soft-delete, allowed only while the item is free of
  // delivery, installation, PAC, and billing evidence, and the item
  // number stays reserved forever afterwards.
  app.post(
    '/api/works/:id/amendments/removals',
    {
      schema: {
        params: IdParamsSchema,
        body: ProposeRemoveItemRequestSchema,
        response: { 201: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params;
      const body = request.body;

      const approval = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
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
        },
      );
      return reply.status(201).send(approval);
    },
  );

  // --- Per-Work amendment history ------------------------------------------
  app.get(
    '/api/works/:id/amendments',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: ApprovalListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params;
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await assertWorkAccess(tx, user.id, workId);
          const [work] = await tx<{ id: string }[]>`
            select id from works where id = ${workId} and deleted_at is null
          `;
          if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
          return tx<ApprovalRow[]>`
            ${tx.unsafe(APPROVAL_SELECT)}
            where ar.work_id = ${workId}
            order by ar.created_at desc, ar.id
          `;
        },
      );
      return { approvals: rows.map(toApproval) };
    },
  );

  // --- Organisation-wide approvals queue -----------------------------------
  app.get(
    '/api/approvals',
    {
      schema: {
        querystring: ApprovalListQuerySchema,
        response: { 200: ApprovalListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { status } = request.query;
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          // 'assigned'-scoped memberships see only their Works' requests.
          const full = await hasFullWorkScope(tx, user.id);
          return tx<ApprovalRow[]>`
            ${tx.unsafe(APPROVAL_SELECT)}
            where (${status ?? null}::text is null or ar.status = ${status ?? null})
              and (${full} or exists (
                select 1 from work_assignments wa
                where wa.work_id = ar.work_id and wa.user_id = ${user.id}
              ))
            order by ar.created_at desc, ar.id
          `;
        },
      );
      return { approvals: rows.map(toApproval) };
    },
  );

  // --- Decide ---------------------------------------------------------------
  app.post(
    '/api/approvals/:id/approve',
    {
      schema: {
        params: IdParamsSchema,
        body: ApproveAmendmentRequestSchema,
        response: { 200: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params;
      const body = request.body;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
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

  app.post(
    '/api/approvals/:id/reject',
    {
      schema: {
        params: IdParamsSchema,
        body: RejectAmendmentRequestSchema,
        response: { 200: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params;
      const body = request.body;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
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

  app.post(
    '/api/approvals/:id/withdraw',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
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
  app.patch(
    '/api/works/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: UpdateWorkSettingsRequestSchema,
        response: { 200: WorkSettingsResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params;
      const body = request.body;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
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
