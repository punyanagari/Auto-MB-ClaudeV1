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
import type { SupersedeBlocker } from '@auto-mb/contracts';
import { httpError } from './http.js';

/**
 * The registers that make a Work ineligible: everything the agency issued,
 * received, or became bound by on this Work's account.
 *
 * `works` has 29 direct children. This list holds the 16 that are
 * documents; `WORK_CHILD_TABLES_EXEMPT` holds the other 13 with the reason
 * each is exempt, and `test/work-supersede-census.integration.test.ts`
 * proves the union is exactly the catalog — so a table added later cannot
 * be silently omitted from the rule.
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
  const census = DOWNSTREAM_REGISTERS.map(
    ({ register }, index) =>
      `select ${index} as position, '${register}' as register, ` +
      `count(*)::int as count from ${register} ` +
      `where organisation_id = app_private.current_organisation_id() ` +
      `and work_id = $1::uuid${registerPredicate(register)}`,
  ).join(' union all ');
  const rows = (await tx.unsafe(`${census} order by position`, [workId])) as unknown as {
    position: number;
    register: string;
    count: number;
  }[];
  const labels = new Map<string, string>(
    DOWNSTREAM_REGISTERS.map((entry) => [entry.register, entry.label]),
  );
  return rows
    .filter((row) => row.count > 0)
    .map((row) => ({
      register: row.register,
      label: labels.get(row.register) ?? row.register,
      count: row.count,
    }));
}

export interface SupersedeEligibility {
  readonly workId: string;
  readonly workCode: string;
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
  const [work] = lock
    ? await tx<{ id: string; work_code: string; status: string }[]>`
        select id, work_code, status from works
        where id = ${workId} and deleted_at is null
        for update
      `
    : await tx<{ id: string; work_code: string; status: string }[]>`
        select id, work_code, status from works
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
    .map((blocker) => `${blocker.count} ${blocker.label}`)
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

/**
 * Binds the successor when a released letter is confirmed again. Called
 * from the confirm route with the new Work already inserted, in the same
 * transaction. Returns the supersession id when one was bound.
 *
 * Nothing here refuses: confirming a released letter is legitimate whether
 * or not a supersession is waiting for it, and a supersession left without
 * a successor (the operator discarded the letter and uploaded a corrected
 * copy instead) is a true record rather than a broken one.
 */
export async function bindSupersessionSuccessor(
  tx: TransactionSql,
  userId: string,
  loaDocumentId: string,
  successorWorkId: string,
): Promise<string | null> {
  const [bound] = await tx<{ id: string; superseded_work_id: string }[]>`
    update work_supersessions
    set successor_work_id = ${successorWorkId},
        successor_bound_at = now(),
        successor_bound_by_user_id = ${userId}
    where loa_document_id = ${loaDocumentId}
      and successor_work_id is null
    returning id, superseded_work_id
  `;
  return bound?.id ?? null;
}
