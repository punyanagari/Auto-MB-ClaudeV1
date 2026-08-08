import type { TransactionSql } from '@auto-mb/db';
import { httpError } from './http.js';

interface AuthorityRow {
  role: string;
  can_issue_documents: boolean;
  can_cancel_documents: boolean;
}

async function membershipOf(
  tx: TransactionSql,
  userId: string,
): Promise<AuthorityRow | undefined> {
  const [membership] = await tx<AuthorityRow[]>`
    select role, can_issue_documents, can_cancel_documents
    from organisation_memberships where user_id = ${userId}
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
