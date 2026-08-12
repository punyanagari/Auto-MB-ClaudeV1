import type { TransactionSql } from '@auto-mb/db';
import { httpError } from './http.js';

export interface MembershipRow {
  role: string;
  work_scope: string;
  can_issue_documents: boolean;
  can_cancel_documents: boolean;
}

export async function membershipOf(
  tx: TransactionSql,
  userId: string,
): Promise<MembershipRow | undefined> {
  const [membership] = await tx<MembershipRow[]>`
    select role, work_scope, can_issue_documents, can_cancel_documents
    from organisation_memberships
    where user_id = ${userId}
      and organisation_id = app_private.current_organisation_id()
  `;
  return membership;
}

/** Drafting/uploading/confirming mutates Works — owner/office only. */
export async function requireWriterRole(
  tx: TransactionSql,
  userId: string,
): Promise<void> {
  const membership = await membershipOf(tx, userId);
  if (membership?.role !== 'owner' && membership?.role !== 'office') {
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

/** Issue and cancel are explicit per-member authorities, separate from
 * role (docs/SECURITY.md: "sensitive issue/cancel actions require
 * explicit authority"). */
export async function requireAuthority(
  tx: TransactionSql,
  userId: string,
  authority: 'issue' | 'cancel',
): Promise<void> {
  const membership = await membershipOf(tx, userId);
  const granted =
    authority === 'issue'
      ? (membership?.can_issue_documents ?? false)
      : (membership?.can_cancel_documents ?? false);
  if (!granted) {
    throw httpError(
      403,
      'AUTHORITY_REQUIRED',
      `Your membership does not carry the ${authority} authority for documents.`,
    );
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
 * must filter to assignments. */
export async function hasFullWorkScope(
  tx: TransactionSql,
  userId: string,
): Promise<boolean> {
  const membership = await membershipOf(tx, userId);
  return membership?.work_scope !== 'assigned';
}
