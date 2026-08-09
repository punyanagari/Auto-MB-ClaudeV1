/**
 * Apply-time logic for the Milestone 7 correction paths, called from the
 * approval engine's dispatch (routes/amendments.ts applyApproval) INSIDE
 * the deciding transaction. Everything here revalidates against LIVE
 * state under row locks; any violation throws an httpError, the
 * transaction rolls back, and the approval request remains pending — the
 * claim is released, exactly like a failed amendment apply.
 */

import type {
  SaveChallanRequest,
  SaveIssueChallanRequest,
  CorrectionNoticeEntry,
} from '@auto-mb/contracts';
import type { TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import {
  CORRECTION_NOTICE_TEMPLATE_VERSION,
  type CorrectionNoticeSnapshot,
} from './correction-notice-html.js';
import type { ChallanSnapshot } from './challan-html.js';
import { draftConflictError } from './draft-conflict.js';
import { httpError } from './http.js';
import { parseJsonbColumn } from './jsonb-column.js';
import { assertSourceNotBilled } from './routes/measurement-books.js';
import {
  assertChallanDate,
  writeLines as writeChallanLines,
} from './routes/challans.js';
import { writeLines as writeIssueChallanLines } from './routes/issue-challans.js';

// --- Proposal snapshot shapes (stored verbatim in approval_requests) --------

export interface ChallanCancelReplaceProposal {
  kind: 'cancel_replace_challan';
  challanId: string;
  challanNumber: string;
  replacement: SaveChallanRequest;
}

export interface IssueChallanCancelReplaceProposal {
  kind: 'cancel_replace_issue_challan';
  issueChallanId: string;
  challanNumber: string;
  replacement: SaveIssueChallanRequest;
}

export interface CorrectionNoticeProposal {
  kind: 'correction_notice';
  challanId: string;
  challanNumber: string;
  corrections: CorrectionNoticeEntry[];
  statement: string | null;
  reason: string;
}

async function audit(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, ${entityType}, ${entityId},
      ${jsonb(tx, details)}
    )
  `;
}

/** Live downstream-evidence counts for a Delivery Challan — the same
 * predicate the cancel route (and the 0008 trigger) enforce. */
export async function challanEvidenceCounts(
  tx: TransactionSql,
  challanId: string,
): Promise<{ receipts: number; serials: number; measurements: number }> {
  const [row] = await tx<{ receipts: number; serials: number; measurements: number }[]>`
    select
      (select count(*) from challan_receipts
        where delivery_challan_id = ${challanId})::int as receipts,
      (select count(*) from challan_item_serials
        where delivery_challan_id = ${challanId})::int as serials,
      (select count(*) from mb_entries
        where delivery_challan_id = ${challanId})::int as measurements
  `;
  return row ?? { receipts: 0, serials: 0, measurements: 0 };
}

/** The cancellation note carries the requester's HUMAN reason (spec R17)
 * plus the approval reference — the cancelled document must explain
 * itself without a queue lookup. */
async function cancellationNote(
  tx: TransactionSql,
  approvalId: string,
): Promise<string> {
  const [request] = await tx<{ reason: string }[]>`
    select reason from approval_requests where id = ${approvalId}
  `;
  if (!request) throw new Error('correction apply without its approval request');
  return `Cancelled and replaced (approval ${approvalId}): ${request.reason}`;
}

// --- Path A apply: Delivery Challan cancel-and-replace ----------------------

export async function applyChallanCancelReplace(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  approvalId: string,
  proposed: ChallanCancelReplaceProposal,
): Promise<void> {
  // Lock the original: cancel, receipt recording, serial recording, and MB
  // entry writes all serialise on this row, so the evidence check below
  // cannot race new evidence.
  const [challan] = await tx<
    { id: string; work_id: string; status: string; challan_number: string | null }[]
  >`
    select id, work_id, status, challan_number
    from delivery_challans where id = ${proposed.challanId}
    for update
  `;
  if (!challan) {
    throw httpError(
      409,
      'CORRECTION_TARGET_MISSING',
      'The challan this correction targets no longer exists.',
    );
  }
  if (challan.status !== 'issued') {
    throw httpError(
      409,
      'CHALLAN_STATUS_CONFLICT',
      `The challan is no longer issued (current status: ${challan.status}); the correction cannot apply.`,
    );
  }
  // Evidence recorded between filing and approval lawfully blocks
  // cancellation: the request stays pending and the queue stays truthful —
  // the operator withdraws it and files a correction notice instead.
  const evidence = await challanEvidenceCounts(tx, challan.id);
  if (evidence.receipts > 0 || evidence.serials > 0 || evidence.measurements > 0) {
    throw httpError(
      409,
      'CHALLAN_HAS_EVIDENCE',
      'A receipt, serials, or measurements were recorded against this challan after the correction was filed; it can no longer be cancelled — use a correction notice.',
    );
  }
  // R19 (app half): a challan billed in a live Measurement Book cannot
  // be cancel-and-replaced — the MB must be cancelled first. The 0024
  // database guard backstops this; the request stays pending exactly
  // like the evidence conflict above.
  await assertSourceNotBilled(tx, 'delivery_challan', challan.id);
  // One draft per Work: the replacement becomes THE draft. A conflict
  // releases the claim back to pending, naming the occupying draft so
  // the client can open it.
  const [existingDraft] = await tx<{ id: string }[]>`
    select id from delivery_challans
    where work_id = ${challan.work_id} and status = 'draft'
  `;
  if (existingDraft) {
    throw draftConflictError(
      'DRAFT_EXISTS',
      'This Work already has a draft challan; issue or delete it before the replacement can be created.',
      existingDraft.id,
    );
  }
  await assertChallanDate(tx, challan.work_id, proposed.replacement.challanDate);

  // Cancel the original with the human reason plus the approval
  // reference. The 0008 trigger re-proves the evidence-free invariant at
  // the database.
  const note = await cancellationNote(tx, approvalId);
  await tx`
    update delivery_challans
    set status = 'cancelled', cancelled_by_user_id = ${userId},
        cancelled_at = now(), cancellation_note = ${note}
    where id = ${challan.id}
  `;
  await audit(
    tx,
    organisationId,
    userId,
    'challan.cancelled',
    'delivery_challans',
    challan.id,
    {
      challanNumber: challan.challan_number,
      note,
      approvalRequestId: approvalId,
    },
  );

  // Create the replacement DRAFT carrying provenance. It goes through the
  // normal issue path later and takes the next number in the series —
  // the numbering discipline is untouched.
  const [replacement] = await tx<{ id: string }[]>`
    insert into delivery_challans (
      organisation_id, work_id, challan_date, prefix, consignee_snapshot,
      created_by_user_id, replaces_challan_id
    )
    values (
      ${organisationId}, ${challan.work_id}, ${proposed.replacement.challanDate},
      ${proposed.replacement.prefix}, ${jsonb(tx, proposed.replacement.consignee)},
      ${userId}, ${challan.id}
    )
    returning id
  `.catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === '23505') {
      // A draft raced in between the pre-check above and this insert;
      // the deciding transaction is aborted, so the winner's id cannot
      // be read here — the operator's retry lands on the pre-check,
      // whose 409 names it.
      throw httpError(
        409,
        'DRAFT_EXISTS',
        'This Work already has a draft challan; issue or delete it before the replacement can be created.',
      );
    }
    throw error;
  });
  if (!replacement) throw new Error('replacement challan insert returned no row');
  await writeChallanLines(
    tx,
    organisationId,
    replacement.id,
    challan.work_id,
    proposed.replacement,
  );
  await audit(
    tx,
    organisationId,
    userId,
    'challan.replacement_drafted',
    'delivery_challans',
    replacement.id,
    {
      replacesChallanId: challan.id,
      replacesChallanNumber: challan.challan_number,
      approvalRequestId: approvalId,
      workId: challan.work_id,
    },
  );
}

// --- Path A apply: Issue Challan cancel-and-replace -------------------------

export async function applyIssueChallanCancelReplace(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  approvalId: string,
  proposed: IssueChallanCancelReplaceProposal,
): Promise<void> {
  const [challan] = await tx<
    {
      id: string;
      work_id: string;
      status: string;
      challan_number: string | null;
      prefix: string;
    }[]
  >`
    select id, work_id, status, challan_number, prefix
    from issue_challans where id = ${proposed.issueChallanId}
    for update
  `;
  if (!challan) {
    throw httpError(
      409,
      'CORRECTION_TARGET_MISSING',
      'The Issue Challan this correction targets no longer exists.',
    );
  }
  if (challan.status !== 'issued') {
    throw httpError(
      409,
      'ISSUE_CHALLAN_STATUS_CONFLICT',
      `The Issue Challan is no longer issued (current status: ${challan.status}); the correction cannot apply.`,
    );
  }
  // Issue Challans have no downstream evidence tables — cancellation is
  // always lawful (legacy spec §5.3); only the one-draft rule can block,
  // and its 409 names the occupying draft so the client can open it.
  const [existingDraft] = await tx<{ id: string }[]>`
    select id from issue_challans
    where work_id = ${challan.work_id} and status = 'draft'
  `;
  if (existingDraft) {
    throw draftConflictError(
      'DRAFT_EXISTS',
      'This Work already has a draft Issue Challan; issue or delete it before the replacement can be created.',
      existingDraft.id,
    );
  }
  await assertChallanDate(tx, challan.work_id, proposed.replacement.challanDate);

  const note = await cancellationNote(tx, approvalId);
  await tx`
    update issue_challans
    set status = 'cancelled', cancelled_by_user_id = ${userId},
        cancelled_at = now(), cancellation_note = ${note}
    where id = ${challan.id}
  `;
  await audit(
    tx,
    organisationId,
    userId,
    'issue_challan.cancelled',
    'issue_challans',
    challan.id,
    {
      challanNumber: challan.challan_number,
      note,
      approvalRequestId: approvalId,
    },
  );

  const replacementBody = proposed.replacement;
  const [replacement] = await tx<{ id: string }[]>`
    insert into issue_challans (
      organisation_id, work_id, movement_type, challan_date, prefix,
      issued_to_name, issued_to_role, location, remarks,
      created_by_user_id, replaces_issue_challan_id
    )
    values (
      ${organisationId}, ${challan.work_id}, ${replacementBody.movementType},
      ${replacementBody.challanDate}, ${challan.prefix},
      ${replacementBody.issuedToName.trim()},
      ${replacementBody.issuedToRole?.trim() ?? null},
      ${replacementBody.location?.trim() ?? null},
      ${replacementBody.remarks?.trim() ?? null},
      ${userId}, ${challan.id}
    )
    returning id
  `.catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === '23505') {
      // A draft raced in between the pre-check above and this insert;
      // the deciding transaction is aborted, so the winner's id cannot
      // be read here — the operator's retry lands on the pre-check,
      // whose 409 names it.
      throw httpError(
        409,
        'DRAFT_EXISTS',
        'This Work already has a draft Issue Challan; issue or delete it before the replacement can be created.',
      );
    }
    throw error;
  });
  if (!replacement) throw new Error('replacement issue challan insert returned no row');
  await writeIssueChallanLines(
    tx,
    organisationId,
    replacement.id,
    challan.work_id,
    replacementBody,
  );
  await audit(
    tx,
    organisationId,
    userId,
    'issue_challan.replacement_drafted',
    'issue_challans',
    replacement.id,
    {
      replacesIssueChallanId: challan.id,
      replacesChallanNumber: challan.challan_number,
      approvalRequestId: approvalId,
      workId: challan.work_id,
    },
  );
}

// --- Path B apply: numbered correction notice -------------------------------

export async function applyCorrectionNotice(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  approvalId: string,
  proposed: CorrectionNoticeProposal,
): Promise<void> {
  const [challan] = await tx<
    {
      id: string;
      work_id: string;
      status: string;
      challan_number: string | null;
      issued_snapshot: unknown;
    }[]
  >`
    select id, work_id, status, challan_number, issued_snapshot
    from delivery_challans where id = ${proposed.challanId}
    for update
  `;
  if (!challan) {
    throw httpError(
      409,
      'CORRECTION_TARGET_MISSING',
      'The challan this correction targets no longer exists.',
    );
  }
  // The original is NEVER touched — but a notice against a cancelled
  // challan would correct a record that no longer stands.
  if (challan.status !== 'issued') {
    throw httpError(
      409,
      'CHALLAN_STATUS_CONFLICT',
      `The challan is no longer issued (current status: ${challan.status}); the correction notice cannot apply.`,
    );
  }
  const [work] = await tx<
    {
      work_code: string;
      title: string;
      letter_number: string;
      letter_date: string;
    }[]
  >`
    select work_code, title, letter_number, letter_date::text as letter_date
    from works where id = ${challan.work_id}
  `;
  if (!work) throw new Error('challan without a Work');

  // Gapless per-Work numbering under the counter row lock (0014 counter
  // mechanics): concurrent approvals serialise here, rollback rolls the
  // number back.
  const [counter] = await tx<{ next_value: number }[]>`
    insert into correction_notice_counters (organisation_id, work_id)
    values (${organisationId}, ${challan.work_id})
    on conflict (organisation_id, work_id)
    do update set next_value = correction_notice_counters.next_value + 1,
                  updated_at = now()
    returning next_value
  `;
  if (!counter) throw new Error('correction notice counter upsert returned no row');
  const sequence = counter.next_value;
  const noticeNumber = `${work.work_code}-CN-${String(sequence).padStart(2, '0')}`;

  const [organisation] = await tx<{ name: string }[]>`
    select name from organisations
  `;
  const challanSnapshot = parseJsonbColumn(challan.issued_snapshot) as ChallanSnapshot;
  const issuedAt = new Date().toISOString();
  const snapshot: CorrectionNoticeSnapshot = {
    templateVersion: CORRECTION_NOTICE_TEMPLATE_VERSION,
    organisationName: organisation?.name ?? '',
    noticeNumber,
    issuedAt,
    work: {
      workCode: work.work_code,
      title: work.title,
      letterNumber: work.letter_number,
      letterDate: work.letter_date,
    },
    challan: {
      challanNumber: challan.challan_number ?? '',
      challanDate: challanSnapshot.challanDate,
      consignee: challanSnapshot.consignee,
      lines: challanSnapshot.items.map((item) => ({
        position: item.position,
        itemNumber: item.itemNumber,
        description: item.description,
        unit: item.unit,
        quantity: item.quantity,
      })),
    },
    corrections: proposed.corrections,
    statement: proposed.statement,
    reason: proposed.reason,
  };

  const [notice] = await tx<{ id: string }[]>`
    insert into correction_notices (
      organisation_id, work_id, delivery_challan_id, approval_request_id,
      notice_number, sequence_number, snapshot, template_version,
      created_by_user_id
    )
    values (
      ${organisationId}, ${challan.work_id}, ${challan.id}, ${approvalId},
      ${noticeNumber}, ${sequence}, ${jsonb(tx, snapshot)},
      ${CORRECTION_NOTICE_TEMPLATE_VERSION}, ${userId}
    )
    returning id
  `;
  if (!notice) throw new Error('correction notice insert returned no row');
  await audit(
    tx,
    organisationId,
    userId,
    'correction_notice.issued',
    'correction_notices',
    notice.id,
    {
      noticeNumber,
      sequence,
      deliveryChallanId: challan.id,
      challanNumber: challan.challan_number,
      approvalRequestId: approvalId,
      workId: challan.work_id,
    },
  );
}
