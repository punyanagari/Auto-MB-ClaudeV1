import type { TransactionSql } from '@auto-mb/db';
import { httpError } from './http.js';

export interface MembershipRow {
  role: string;
  work_scope: string;
  can_issue_documents: boolean;
  can_cancel_documents: boolean;
  can_manage_statutory_reporting: boolean;
  can_manage_payments: boolean;
}

export async function membershipOf(
  tx: TransactionSql,
  userId: string,
): Promise<MembershipRow | undefined> {
  const [membership] = await tx<MembershipRow[]>`
    select role, work_scope, can_issue_documents, can_cancel_documents,
           can_manage_statutory_reporting, can_manage_payments
    from organisation_memberships
    where user_id = ${userId}
      and organisation_id = app_private.current_organisation_id()
  `;
  return membership;
}

/**
 * Whether this membership is a WRITER: owner or office.
 *
 * The same two-role test the refusal below applies, as a question rather
 * than an assertion — for the several places that need the answer to
 * decide what to SHOW rather than whether to allow. It had been spelled
 * out inline at each of them (`routes/loa.ts` twice, the company document
 * library once), which is three copies of a role set that must not
 * disagree with the guard beneath it.
 *
 * A MISSING membership answers false. The tenant binding refuses an
 * unbound caller before a route body runs, so it should not arise; the
 * posture matches `hasFullWorkScope` below, where the safe default is
 * "sees less", never "sees everything".
 */
export function isWriterRole(membership: MembershipRow | undefined): boolean {
  return membership?.role === 'owner' || membership?.role === 'office';
}

/** Drafting/uploading/confirming mutates Works — owner/office only. */
export async function requireWriterRole(
  tx: TransactionSql,
  userId: string,
): Promise<void> {
  if (!isWriterRole(await membershipOf(tx, userId))) {
    throw httpError(
      403,
      'ROLE_FORBIDDEN',
      'Only owner or office members may modify Works.',
    );
  }
}

/** Statutory configuration — the GST rate master and anything else that
 * decides what a legal document may say — is the owner's alone; office
 * members draft documents against it but do not change it. */
export async function requireOwnerRole(
  tx: TransactionSql,
  userId: string,
): Promise<void> {
  const membership = await membershipOf(tx, userId);
  if (membership?.role !== 'owner') {
    throw httpError(
      403,
      'OWNER_REQUIRED',
      'Only an organisation owner may change this configuration.',
    );
  }
}

/** Delivery evidence — receipts, serials, installations, Measurement
 * Book entries — is the site staff's job; owner and office may record it
 * too. Viewers may not. */
export async function requireEvidenceRole(
  tx: TransactionSql,
  userId: string,
): Promise<void> {
  const membership = await membershipOf(tx, userId);
  if (
    membership?.role !== 'owner' &&
    membership?.role !== 'office' &&
    membership?.role !== 'site'
  ) {
    throw httpError(
      403,
      'ROLE_FORBIDDEN',
      'Only owner, office, or site members may record delivery evidence.',
    );
  }
}

/** The explicit per-member authorities, separate from role
 * (docs/SECURITY.md: "sensitive issue/cancel actions require explicit
 * authority"). `statutory` (migration 0061) is the compliance authority:
 * talking to the IRP or the NIC E-way Bill portal in the organisation's
 * name — and recording what those portals are said to have answered — is
 * a different act from issuing a document of our own, so it carries its
 * own grant on top of issue/cancel rather than replacing them. */
export type DocumentAuthority = 'issue' | 'cancel' | 'statutory' | 'payments';

/** Named refusals, so a denial says which authority is missing rather
 * than interpolating an internal token into prose. */
const AUTHORITY_REFUSALS: Record<DocumentAuthority, string> = {
  issue: 'Your membership does not carry the issue authority for documents.',
  cancel:
    'Your membership does not carry the cancel authority, which is required to cancel an issued document or to withdraw a confirmed Work.',
  statutory:
    'Your membership does not carry the statutory reporting authority, which is required to register, reconcile, cancel, or record government e-invoice and E-way Bill evidence.',
  payments:
    'Your membership does not carry the payments authority, which is required to approve employee payment requests and to record or pay vendor invoices.',
};

/** Exhaustive by construction: a new `DocumentAuthority` that is not
 * given a column here fails to typecheck, which is what stops a new
 * authority from silently defaulting to "granted". */
const AUTHORITY_COLUMNS: Record<
  DocumentAuthority,
  keyof Pick<
    MembershipRow,
    | 'can_issue_documents'
    | 'can_cancel_documents'
    | 'can_manage_statutory_reporting'
    | 'can_manage_payments'
  >
> = {
  issue: 'can_issue_documents',
  cancel: 'can_cancel_documents',
  statutory: 'can_manage_statutory_reporting',
  payments: 'can_manage_payments',
};

function authorityGranted(
  membership: MembershipRow | undefined,
  authority: DocumentAuthority,
): boolean {
  if (membership === undefined) return false;
  return membership[AUTHORITY_COLUMNS[authority]];
}

export async function requireAuthority(
  tx: TransactionSql,
  userId: string,
  authority: DocumentAuthority,
): Promise<void> {
  const membership = await membershipOf(tx, userId);
  if (!authorityGranted(membership, authority)) {
    throw httpError(403, 'AUTHORITY_REQUIRED', AUTHORITY_REFUSALS[authority]);
  }
}

/** The declarative form: every listed authority must be held, checked in
 * the order given so the refusal a caller sees is stable. One membership
 * read serves them all, and it stays pinned to the bound organisation
 * exactly as `membershipOf` pins it (docs/SECURITY.md's explicit-scoping
 * rule). */
export async function requireAuthorities(
  tx: TransactionSql,
  userId: string,
  authorities: readonly DocumentAuthority[],
): Promise<void> {
  if (authorities.length === 0) return;
  const membership = await membershipOf(tx, userId);
  for (const authority of authorities) {
    if (!authorityGranted(membership, authority)) {
      throw httpError(403, 'AUTHORITY_REQUIRED', AUTHORITY_REFUSALS[authority]);
    }
  }
}

/** Enforces work_scope: an 'assigned'-scoped membership reaches only the
 * Works it is assigned to. Denials are 404, not 403 — a guessed id must
 * not confirm the Work exists. Every Work-addressed route passes through
 * here after the tenant is bound. */
export async function assertWorkAccess(
  tx: TransactionSql,
  userId: string,
  workId: string,
): Promise<void> {
  const membership = await membershipOf(tx, userId);
  if (membership === undefined) {
    throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  }
  if (membership.work_scope !== 'assigned') return;
  const [assignment] = await tx<{ id: string }[]>`
    select id from work_assignments
    where work_id = ${workId} and user_id = ${userId}
  `;
  if (!assignment) {
    throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  }
}

/** True when the membership sees every Work; false when list queries
 * must filter to assignments.
 *
 * A MISSING membership answers false, not true. It cannot normally
 * happen — the tenant binding refuses an unbound caller before a route
 * body runs — but this function's answer is the entire scope predicate of
 * the cross-Work registers, so the failure it can produce is a register
 * that lists every Work in the organisation. Optional chaining on an
 * inequality reads as a safe default and is the opposite of one: absent
 * `work_scope` is `undefined`, which is not `'assigned'`, which was
 * `true`. The posture matches `assertWorkAccess` above, which treats a
 * missing membership as no access at all. */
export async function hasFullWorkScope(
  tx: TransactionSql,
  userId: string,
): Promise<boolean> {
  const membership = await membershipOf(tx, userId);
  if (membership === undefined) return false;
  return membership.work_scope !== 'assigned';
}
