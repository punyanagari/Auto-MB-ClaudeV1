/**
 * Superseding a confirmed Work (migration 0071).
 *
 * Migration 0063 ends by naming the remedy for a Work confirmed from a
 * letter that was read wrongly — "discard the LOA document and confirm it
 * again" — and that remedy did not exist. Migration 0055 makes a confirmed
 * letter undiscardable, deliberately, because it is the Work's source of
 * truth; nothing had ever written `works.deleted_at`. This module is the
 * exit: an approval-gated withdrawal of a Work that carries no downstream
 * document, which releases its letter back into review so the ordinary
 * intake flow can produce a successor.
 *
 * Everything authoritative happens in `applyWorkSupersede`, inside the
 * deciding transaction, under the Work's own row lock — the same contract
 * every other `applyApproval` branch honours. The eligibility census below
 * is re-run there against live state, and the database re-runs it again
 * (`app_private.guard_work_soft_delete`), so a Work that acquires a challan
 * between the proposal and the decision is refused twice.
 */

import type { TransactionSql } from '@auto-mb/db';
import type { SupersedeBlocker, WorkSupersession } from '@auto-mb/contracts';
import { httpError } from './http.js';
import { assertWorkOperable } from './work-status.js';

/**
 * The registers that make a Work ineligible: everything the agency issued,
 * received, or became bound by on this Work's account.
 *
 * Forty-four tables can reach `works` through a chain of foreign keys.
 * This list holds the 17 that are documents in their own right;
 * `WORK_CHILD_TABLES_EXEMPT` holds the other 27 with the reason each is
 * exempt, and the census in `test/work-supersede.integration.test.ts`
 * proves the union is exactly the catalog — TRANSITIVELY, not only over
 * direct children, because a document hanging off an exempt parent is
 * precisely the case a direct-children census cannot see.
 *
 * The identifiers are frozen literals interpolated as identifiers (postgres
 * has no parameter form for a table name); every value is a bound
 * parameter. `packages/db/migrations/0071_work_supersession.sql` carries the
 * same list as SQL, and the census test compares the two.
 */
export const DOWNSTREAM_REGISTERS = [
  { register: 'delivery_challans', label: 'delivery challans' },
  { register: 'issue_challans', label: 'issue challans' },
  { register: 'installations', label: 'installation records' },
  { register: 'measurement_books', label: 'Measurement Books' },
  {
    register: 'measurement_book_merge_provenance',
    label: 'Measurement Book merge records',
  },
  { register: 'mb_entries', label: 'Measurement Book entries' },
  { register: 'tax_invoices', label: 'tax invoices' },
  { register: 'credit_notes', label: 'credit notes' },
  { register: 'pac_certificates', label: 'PAC certificates' },
  { register: 'correction_notices', label: 'correction notices' },
  { register: 'work_instruments', label: 'submitted instruments' },
  { register: 'bills', label: 'bills' },
  { register: 'extension_requests', label: 'extension requests' },
  { register: 'purchase_orders', label: 'purchase orders' },
  { register: 'received_railway_bills', label: 'received railway bills' },
  { register: 'amendment_variation_orders', label: 'cited variation orders' },
  { register: 'approval_requests', label: 'live change requests' },
] as const;

/**
 * The other children of `works`, and why none of them blocks. Read as the
 * second half of the census: the test refuses any table that appears in
 * neither list.
 */
export const WORK_CHILD_TABLES_EXEMPT: Readonly<Record<string, string>> = {
  // The Work's own body. Superseding withdraws exactly this.
  work_schedules: "the Work's own schedule structure",
  work_items: "the Work's own item table",
  payment_matrices: "the Work's own payment-stage configuration",
  work_consignees: 'a consignee preference list, not a document (0028)',
  work_assignments: 'access control, not a document',
  loa_documents: 'the source letter, released back to review by the supersede',
  // Numbering state. A counter records what a series reached; it is
  // created eagerly by the numbering paths and is not a document. The
  // successor is a new Work with its own counters starting at 1, so no
  // number is ever minted twice and the predecessor's series is frozen
  // wherever it stopped.
  delivery_challan_counters: 'numbering state, not a document',
  issue_challan_counters: 'numbering state, not a document',
  bill_counters: 'numbering state, not a document',
  extension_request_counters: 'numbering state, not a document',
  correction_notice_counters: 'numbering state, not a document',
  measurement_book_counters: 'numbering state, not a document',
  purchase_order_counters: 'numbering state, not a document',
  // Lines, evidence and portal state hanging off a register that DOES
  // block. Each reaches `works` only through its own parent, so blocking
  // on the parent already covers it: a Work with none of the seventeen
  // registers populated has none of these either, and adding them to the
  // census would ask seventeen more questions with the same answer. They
  // are listed rather than omitted because a table that reached `works`
  // through an exempt parent WOULD be invisible to the rule, and telling
  // the two cases apart is the census's whole job.
  delivery_challan_items: 'lines of a delivery challan, which blocks',
  challan_receipts: 'receipts against a delivery challan, which blocks',
  challan_item_serials: 'serials on a delivery challan line, which blocks',
  issue_challan_lines: 'lines of an issue challan, which blocks',
  installation_serials: 'serials on an installation record, which blocks',
  pac_certificate_items: 'lines of a PAC certificate, which blocks',
  measurement_book_lines: 'lines of a Measurement Book, which blocks',
  mb_sources: 'the measurements a Measurement Book claims, which blocks',
  purchase_order_lines: 'lines of a purchase order, which blocks',
  tax_invoice_lines: 'lines of a tax invoice, which blocks',
  tax_invoice_renders: 'render history of a tax invoice, which blocks',
  eway_bills: 'the e-way bill of a tax invoice, which blocks',
  statutory_provider_operations:
    'portal evidence for an invoice, credit note or e-way bill, each of which blocks',
  // The rule's own bookkeeping: it points at both ends of the change, and
  // is written by the supersede itself.
  work_supersessions: 'the supersession record itself',
};

/** `approval_requests` blocks only while a request is live: a pending one
 * must be decided before the Work it argues about disappears, and an
 * approved one has already moved the item table. A rejected or withdrawn
 * request changed nothing, and treating it as a blocker would re-lock the
 * deadlock this feature exists to open. The supersede request itself is
 * never its own blocker. */
const LIVE_APPROVAL_PREDICATE =
  "entity_type <> 'work_supersede' and status in ('pending', 'approved')";

function registerPredicate(register: string): string {
  return register === 'approval_requests' ? ` and ${LIVE_APPROVAL_PREDICATE}` : '';
}

/**
 * Counts every blocking register in one round trip. Ordered by the
 * declaration order above so the operator always reads the same list in
 * the same order.
 */
export async function readSupersedeBlockers(
  tx: TransactionSql,
  workId: string,
): Promise<readonly SupersedeBlocker[]> {
  // `exists`, never `count(*)`: the rule turns on whether a register holds
  // anything, and a count would scan every matching row of seventeen
  // registers to answer a question the first row settles. This runs on
  // every eligibility read AND inside the apply transaction, which holds
  // the works row lock — the cheaper shape is the one that holds the lock
  // for less time.
  const census = DOWNSTREAM_REGISTERS.map(
    ({ register }, index) =>
      `select ${index} as position, '${register}' as register ` +
      `where exists (select 1 from ${register} ` +
      `where organisation_id = app_private.current_organisation_id() ` +
      `and work_id = $1::uuid${registerPredicate(register)})`,
  ).join(' union all ');
  const rows = (await tx.unsafe(`${census} order by position`, [
    workId,
  ])) as unknown as {
    position: number;
    register: string;
  }[];
  const labels = new Map<string, string>(
    DOWNSTREAM_REGISTERS.map((entry) => [entry.register, entry.label]),
  );
  return rows.map((row) => ({
    register: row.register,
    label: labels.get(row.register) ?? row.register,
  }));
}

export interface SupersedeEligibility {
  readonly workId: string;
  readonly workCode: string;
  readonly letterNumber: string;
  readonly status: string;
  readonly blockers: readonly SupersedeBlocker[];
  readonly loaDocumentId: string | null;
  readonly pendingRequestId: string | null;
}

/**
 * Reads the Work, its blockers and the letter that would be released.
 * `lock` takes the works row for update — the proposal path reads without
 * it, the apply path always takes it, so the census and the soft delete
 * see one state.
 */
export async function readSupersedeEligibility(
  tx: TransactionSql,
  workId: string,
  lock = false,
): Promise<SupersedeEligibility> {
  type WorkRow = {
    id: string;
    work_code: string;
    letter_number: string;
    status: string;
  };
  const [work] = lock
    ? await tx<WorkRow[]>`
        select id, work_code, letter_number, status from works
        where id = ${workId} and deleted_at is null
        for update
      `
    : await tx<WorkRow[]>`
        select id, work_code, letter_number, status from works
        where id = ${workId} and deleted_at is null
      `;
  if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

  // The confirmed letter. A Work imported from v1 has none, and without a
  // letter to read again there is nothing for a successor to be confirmed
  // from — the eligibility response says so rather than offering a button
  // that would strand the Work.
  const [document] = await tx<{ id: string }[]>`
    select id from loa_documents
    where confirmed_work_id = ${workId}
      and document_kind = 'loa'
      and extraction_status = 'confirmed'
  `;
  const [pending] = await tx<{ id: string }[]>`
    select id from approval_requests
    where entity_type = 'work_supersede' and entity_id = ${workId}
      and status = 'pending'
  `;
  return {
    workId: work.id,
    workCode: work.work_code,
    letterNumber: work.letter_number,
    status: work.status,
    blockers: await readSupersedeBlockers(tx, workId),
    loaDocumentId: document?.id ?? null,
    pendingRequestId: pending?.id ?? null,
  };
}

/** One sentence naming everything that stands in the way, so the operator
 * reads the whole list rather than discovering it one refusal at a time. */
export function describeBlockers(blockers: readonly SupersedeBlocker[]): string {
  return blockers
    .map((blocker) => blocker.label)
    .join(', ')
    .replace(/, ([^,]*)$/, blockers.length > 1 ? ' and $1' : '$1');
}

export function assertSupersedable(eligibility: SupersedeEligibility): string {
  if (eligibility.blockers.length > 0) {
    throw httpError(
      409,
      'WORK_HAS_DOWNSTREAM_DOCUMENTS',
      `Work ${eligibility.workCode} carries ${describeBlockers(eligibility.blockers)}, so it cannot be superseded. A Work that has issued or received something is corrected through the amendment and correction paths instead. Nothing was changed.`,
      { blockers: eligibility.blockers },
    );
  }
  if (eligibility.loaDocumentId === null) {
    throw httpError(
      409,
      'WORK_HAS_NO_LOA_DOCUMENT',
      `Work ${eligibility.workCode} was not confirmed from an LOA document in this product, so there is no letter to read again and superseding it would leave nothing in its place. Nothing was changed.`,
    );
  }
  return eligibility.loaDocumentId;
}

/** The stored proposal. Everything the apply step needs is re-derived from
 * live state; the snapshot records what the requester was looking at. */
export interface WorkSupersedeProposal {
  readonly kind: 'work_supersede';
  readonly workId: string;
  readonly workCode: string;
  readonly loaDocumentId: string;
  readonly reason: string;
}

/**
 * Withdraws the Work and releases its letter, in the deciding
 * transaction. Called only from `applyApproval`, which has already locked
 * the request, proved it pending, and checked the decider's authorities.
 *
 * Order matters and is enforced by the 0071 triggers: the supersession row
 * exists before the Work is soft-deleted (the works guard demands it), and
 * the Work is soft-deleted before the letter is released (the release
 * guard demands it). A failure at any step rolls the whole decision back
 * and the request remains pending.
 */
export async function applyWorkSupersede(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  approvalRequestId: string,
  proposed: WorkSupersedeProposal,
): Promise<{ readonly supersessionId: string; readonly loaDocumentId: string }> {
  // Live state, under the works row lock — not the proposal snapshot.
  const eligibility = await readSupersedeEligibility(tx, proposed.workId, true);
  // Defence in depth: the proposal route already refused a completed Work,
  // and the census refuses one anyway (completion needs 100% executed
  // value, which needs documents). Restated here because the decision can
  // arrive days after the proposal, and a Work reopened, executed and
  // completed in between must not be withdrawn on a stale request.
  assertWorkOperable(eligibility.status, 'superseding it');
  const loaDocumentId = assertSupersedable(eligibility);

  const [supersession] = await tx<{ id: string }[]>`
    insert into work_supersessions (
      organisation_id, superseded_work_id, loa_document_id,
      approval_request_id, reason, superseded_by_user_id
    )
    values (
      ${organisationId}, ${proposed.workId}, ${loaDocumentId},
      ${approvalRequestId}, ${proposed.reason}, ${userId}
    )
    returning id
  `.catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === '23505') {
      throw httpError(
        409,
        'WORK_ALREADY_SUPERSEDED',
        'This Work has already been superseded.',
      );
    }
    throw error;
  });
  if (!supersession) throw new Error('work_supersessions insert returned no row');

  const [withdrawn] = await tx<{ id: string }[]>`
    update works set deleted_at = now()
    where id = ${proposed.workId} and deleted_at is null
    returning id
  `;
  if (!withdrawn) throw new Error('works soft delete returned no row');

  // Back to review, with no Work — exactly the state an uploaded letter
  // sits in before anyone confirms it, so the review screen, the confirm
  // route and (if the copy is illegible) the ordinary discard route all
  // work on it again with no special case.
  const [released] = await tx<{ id: string }[]>`
    update loa_documents
    set extraction_status = 'review', confirmed_work_id = null
    where id = ${loaDocumentId} and extraction_status = 'confirmed'
    returning id
  `;
  if (!released) throw new Error('loa_documents release returned no row');

  // Supporting contract documents were stamped with the Work at
  // confirmation and follow their letter back.
  await tx`
    update loa_documents set confirmed_work_id = null
    where parent_loa_document_id = ${loaDocumentId}
      and confirmed_work_id = ${proposed.workId}
  `;

  return { supersessionId: supersession.id, loaDocumentId };
}

/** An open supersession: the Work withdrawn, its identity, and the letter
 * released for it, read from the document being confirmed. */
export interface OpenSupersession {
  readonly id: string;
  readonly supersededWorkId: string;
  readonly supersededWorkCode: string;
  readonly supersededLetterNumber: string;
}

/**
 * The supersession waiting on this letter, if any: withdrawn, released,
 * and not yet answered by a successor. Read before the Work is inserted
 * so the confirm route can refuse on authority and on identity before it
 * writes anything.
 */
export async function readOpenSupersession(
  tx: TransactionSql,
  loaDocumentId: string,
): Promise<OpenSupersession | null> {
  const [row] = await tx<
    {
      id: string;
      superseded_work_id: string;
      work_code: string;
      letter_number: string;
    }[]
  >`
    select s.id, s.superseded_work_id, w.work_code, w.letter_number
    from work_supersessions s
    join works w
      on w.organisation_id = s.organisation_id
     and w.id = s.superseded_work_id
    where s.loa_document_id = ${loaDocumentId}
      and s.successor_work_id is null
    for update of s
  `;
  if (!row) return null;
  return {
    id: row.id,
    supersededWorkId: row.superseded_work_id,
    supersededWorkCode: row.work_code,
    supersededLetterNumber: row.letter_number,
  };
}

/**
 * THE IDENTITY RULE. A successor carries the withdrawn Work's work code
 * and letter number, unchanged.
 *
 * Without this, superseding is a work-code rename with no approval behind
 * it: the approver reads a reason for withdrawing PL-270 and approves
 * that, and whoever confirms the released letter afterwards could file it
 * under any code they like — an authoritative identity change that no
 * approval covers and no audit event describes as one. The successor is
 * the SAME contract read again, so its identity is not the confirmer's to
 * choose.
 *
 * A genuinely wrong work code or letter number is corrected the way every
 * other wrong extracted value is: discard the released letter and upload
 * the correct one, which the supersession has already made possible.
 */
export function assertSuccessorIdentity(
  supersession: OpenSupersession,
  workCode: string,
  letterNumber: string,
): void {
  if (
    workCode === supersession.supersededWorkCode &&
    letterNumber === supersession.supersededLetterNumber
  ) {
    return;
  }
  throw httpError(
    409,
    'SUCCESSOR_IDENTITY_MISMATCH',
    `This letter was released by an approved supersede of Work ${supersession.supersededWorkCode} (${supersession.supersededLetterNumber}), so the Work confirmed in its place carries that same work code and letter number — it is the same contract. Confirm it as ${supersession.supersededWorkCode} / ${supersession.supersededLetterNumber}, or discard this letter and upload the correct one if the identity itself is what was wrong. Nothing was saved.`,
    {
      supersededWorkId: supersession.supersededWorkId,
      expectedWorkCode: supersession.supersededWorkCode,
      expectedLetterNumber: supersession.supersededLetterNumber,
    },
  );
}

/**
 * THE RESERVATION. While a supersession is open and its released letter
 * still exists, the withdrawn Work's identity belongs to that letter's
 * successor and to nothing else.
 *
 * The partial unique indexes free the code the moment the predecessor is
 * withdrawn; without this, an unrelated confirmation could take it during
 * the window and the successor would be locked out of its own contract's
 * identity. The reservation lifts when the released letter is DISCARDED,
 * because a discarded letter can never produce the successor — which is
 * exactly the discard-and-re-upload path, and is why that path can reuse
 * the code (docs/PRODUCT.md §5.6). That fact is read from the
 * supersession's own `released_letter_discarded_at`, never from
 * `loa_documents`: the database guard behind this check runs at COMMIT of
 * every works INSERT, and a check that read the documents table would make
 * every Work creation in the organisation wait on any lock held there.
 */
export async function assertIdentityNotReserved(
  tx: TransactionSql,
  loaDocumentId: string,
  workCode: string,
  letterNumber: string,
): Promise<void> {
  const [reserved] = await tx<{ work_code: string; letter_number: string }[]>`
    select w.work_code, w.letter_number
    from work_supersessions s
    join works w
      on w.organisation_id = s.organisation_id
     and w.id = s.superseded_work_id
    join loa_documents d
      on d.organisation_id = s.organisation_id
     and d.id = s.loa_document_id
    where s.successor_work_id is null
      -- Only a WITHDRAWN Work's identity is reserved; a supersession whose
      -- predecessor is still live has freed nothing to hold.
      and w.deleted_at is not null
      and s.loa_document_id <> ${loaDocumentId}
      and d.extraction_status <> 'discarded'
      and (w.work_code = ${workCode} or w.letter_number = ${letterNumber})
    limit 1
  `;
  if (!reserved) return;
  const clash =
    reserved.work_code === workCode
      ? `work code ${workCode}`
      : `letter number ${letterNumber}`;
  throw httpError(
    409,
    'WORK_IDENTITY_RESERVED',
    `The ${clash} belongs to a Work that has been superseded and whose letter is waiting to be confirmed again; it is reserved for that successor. Confirm the released letter, or discard it, before using this identity for anything else. Nothing was saved.`,
    { workCode, letterNumber },
  );
}

/**
 * Binds the successor when a released letter is confirmed again, and
 * carries the withdrawn Work's assignments across.
 *
 * Called from the confirm route with the new Work already inserted, in the
 * same transaction, AFTER the identity and access checks above. Returns
 * the supersession id when one was bound.
 *
 * Assignments travel because work_scope is how an 'assigned' member sees a
 * contract at all: leaving them behind on the withdrawn Work would make a
 * correction silently revoke every site member's access to the work they
 * are executing. Copied as the same rows, audited in the shape the
 * owner-managed assignment writes use.
 */
export async function bindSupersessionSuccessor(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  supersession: OpenSupersession,
  successorWorkId: string,
): Promise<{ readonly supersessionId: string; readonly assignedUserIds: string[] }> {
  const [bound] = await tx<{ id: string }[]>`
    update work_supersessions
    set successor_work_id = ${successorWorkId},
        successor_bound_at = now(),
        successor_bound_by_user_id = ${userId}
    where id = ${supersession.id}
      and successor_work_id is null
    returning id
  `;
  if (!bound) {
    // Another transaction bound this supersession between the read above
    // and here. Refused rather than silently left unbound: two Works
    // claiming one contract's identity is the state the reservation
    // exists to prevent.
    throw httpError(
      409,
      'WORK_ALREADY_SUPERSEDED',
      'This letter has already been confirmed into a successor Work. Nothing was saved.',
    );
  }

  const carried = await tx<{ user_id: string }[]>`
    insert into work_assignments (
      organisation_id, work_id, user_id, created_by_user_id
    )
    select ${organisationId}, ${successorWorkId}, a.user_id, ${userId}
    from work_assignments a
    where a.organisation_id = ${organisationId}
      and a.work_id = ${supersession.supersededWorkId}
    on conflict do nothing
    returning user_id
  `;
  return {
    supersessionId: bound.id,
    assignedUserIds: carried.map((row) => row.user_id).sort(),
  };
}

/**
 * The provenance of one Work: the supersession it is the successor of.
 * Null for a Work that replaced nothing.
 */
export async function readWorkSupersession(
  tx: TransactionSql,
  successorWorkId: string,
): Promise<WorkSupersession | null> {
  const [row] = await tx<
    {
      id: string;
      superseded_work_id: string;
      work_code: string;
      letter_number: string;
      successor_work_id: string | null;
      loa_document_id: string;
      approval_request_id: string;
      reason: string;
      superseded_at: Date;
      superseded_by_user_id: string;
      successor_bound_at: Date | null;
    }[]
  >`
    select s.id, s.superseded_work_id, w.work_code, w.letter_number,
           s.successor_work_id, s.loa_document_id, s.approval_request_id,
           s.reason, s.superseded_at, s.superseded_by_user_id,
           s.successor_bound_at
    from work_supersessions s
    join works w
      on w.organisation_id = s.organisation_id
     and w.id = s.superseded_work_id
    where s.successor_work_id = ${successorWorkId}
  `;
  if (!row) return null;
  return {
    id: row.id,
    supersededWorkId: row.superseded_work_id,
    supersededWorkCode: row.work_code,
    supersededLetterNumber: row.letter_number,
    successorWorkId: row.successor_work_id,
    loaDocumentId: row.loa_document_id,
    approvalRequestId: row.approval_request_id,
    reason: row.reason,
    supersededAt: row.superseded_at.toISOString(),
    supersededByUserId: row.superseded_by_user_id,
    successorBoundAt: row.successor_bound_at?.toISOString() ?? null,
  };
}

/**
 * Refuses to discard a supporting contract document while the letter it
 * belongs to is mid-supersession.
 *
 * A released letter's package is evidence in flight: the letter is going
 * to be confirmed again, and the tender specification or NIT attached to
 * it is part of what a reviewer reads while doing so. Before this, the
 * supersession cleared `confirmed_work_id` on the supporting documents,
 * which is exactly what the ordinary discard rule tests — so the window
 * silently made them discardable one at a time, and the successor could
 * be confirmed against a package quietly emptied out underneath it.
 *
 * The letter ITSELF stays discardable: discarding it is the documented
 * remedy for an illegible scan, and 0055 already takes the whole package
 * with it.
 */
/**
 * Records that a released letter was discarded, closing its supersession
 * without a successor and lifting the identity reservation. Called from
 * the LOA discard route; a no-op for a document no supersession released.
 */
export async function closeSupersessionOnDiscard(
  tx: TransactionSql,
  loaDocumentId: string,
): Promise<string | null> {
  const [closed] = await tx<{ id: string }[]>`
    update work_supersessions
    set released_letter_discarded_at = now()
    where loa_document_id = ${loaDocumentId}
      and successor_work_id is null
      and released_letter_discarded_at is null
    returning id
  `;
  return closed?.id ?? null;
}

export async function assertSupportingDocumentDiscardable(
  tx: TransactionSql,
  documentId: string,
  parentLoaDocumentId: string | null,
): Promise<void> {
  if (parentLoaDocumentId === null) return;
  const [open] = await tx<{ work_code: string }[]>`
    select w.work_code
    from work_supersessions s
    join works w
      on w.organisation_id = s.organisation_id
     and w.id = s.superseded_work_id
    where s.loa_document_id = ${parentLoaDocumentId}
      and s.successor_work_id is null
      and s.released_letter_discarded_at is null
  `;
  if (!open) return;
  throw httpError(
    409,
    'SUPERSEDE_IN_PROGRESS',
    `This document supports a letter released by the supersede of Work ${open.work_code} and waiting to be confirmed again, so it cannot be withdrawn from the package on its own. Confirm the letter first, or discard the letter itself — which withdraws its whole package together. Nothing was changed.`,
    { documentId },
  );
}
