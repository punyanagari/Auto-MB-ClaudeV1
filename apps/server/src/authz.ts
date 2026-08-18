import type { TransactionSql } from '@auto-mb/db';
import { httpError } from './http.js';

export interface MembershipRow {
  role: string;
  work_scope: string;
  can_issue_documents: boolean;
  can_cancel_documents: boolean;
  can_manage_statutory_reporting: boolean;
  can_manage_payments: boolean;
  can_sign_documents: boolean;
  can_manage_payroll: boolean;
  can_manage_notifications: boolean;
  can_import_data: boolean;
}

export async function membershipOf(
  tx: TransactionSql,
  userId: string,
): Promise<MembershipRow | undefined> {
  const [membership] = await tx<MembershipRow[]>`
    select role, work_scope, can_issue_documents, can_cancel_documents,
           can_manage_statutory_reporting, can_manage_payments,
           can_sign_documents, can_manage_payroll, can_manage_notifications,
           can_import_data
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

/**
 * The one company-document category that is not open to every member
 * (owner decision, 2026-08-18; migration 0079's library).
 *
 * Balance sheets, turnover certificates and bank solvency letters state
 * what the company is worth and who it banks with. Every other bucket is
 * a document the agency hands to strangers on request — a GST
 * registration number is printed on its invoices — but this one is
 * commercially sensitive, and site staff and viewers have no work that
 * needs it. The gate is the writer role, the same one that governs
 * writing the library: the people who file the financials are the people
 * who may read them.
 *
 * It lives HERE rather than in `routes/company-documents.ts` because it
 * is no longer one route's rule. Migration 0083's bid checklist points
 * at these credentials, so a tender read can expose by the back door
 * exactly what the library read refuses at the front — the credential's
 * name, its version, its expiry — and a rule enforced in one of two
 * readers is a rule with a hole in it. Every reader of a company
 * credential imports this and `isWriterRole` together.
 */
export const RESTRICTED_CREDENTIAL_CATEGORY = 'financial';

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
export type DocumentAuthority =
  | 'issue'
  | 'cancel'
  | 'statutory'
  | 'payments'
  /** Putting the organisation's own registered certificate on a document
   * it has already issued (0091, ADR-0012, owner ruling 2026-08-18).
   * Separate from `issue` because the digest binding and this authority
   * answer different questions: the binding makes it impossible to sign
   * bytes nobody authorised, and this makes it impossible for the wrong
   * member to put a correctly-bound request in front of a signer who is
   * about to type their PIN because the queue said to. */
  | 'sign'
  /** Seeing the employee register and running the monthly payroll (0089,
   * owner ruling 2026-08-18). Separate from `payments` because the
   * register carries every colleague's salary, PAN, UAN and bank
   * account, and a member who may approve a vendor payment has no
   * business reading any of that by default. */
  | 'payroll'
  /** Configuring the channels the organisation speaks through, the
   * templates it may say, and who has consented to be spoken to (0092).
   * Separate from `issue` because issuing a document commits words a
   * counterparty asked for, and choosing the number those words leave
   * from — and who else may be messaged — is a different decision about
   * the organisation's outbound voice. */
  | 'notifications'
  /** Pointing a spreadsheet at a register and committing the rows it
   * staged (0094, owner ruling). Separate from the writer role the
   * registers themselves require, because the two acts are not the same
   * size: adding one contact is a considered act with a form in front of
   * it, and committing a batch writes eight hundred rows from a file
   * somebody forwarded. It confers nothing on its own — a batch still
   * commits into the register's own role and its own constraints. */
  | 'import';

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
  sign: 'Your membership does not carry the signing authority, which is required to send an issued document for the organisation’s digital signature or to withdraw a request for one.',
  payroll:
    'Your membership does not carry the payroll authority, which is required to see the employee register and run payroll. It is separate from the payments authority because reading what every colleague earns is a different secret from approving a vendor payment.',
  notifications:
    'Your membership does not carry the notifications authority, which is required to configure a messaging channel, maintain a message template, record a recipient’s consent, or send a message.',
  import:
    'Your membership does not carry the import authority, which is required to upload a spreadsheet against a register and to commit the rows it stages. It is separate from the writer role because adding one record and adding eight hundred from a forwarded file are not the same act.',
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
    | 'can_sign_documents'
    | 'can_manage_payroll'
    | 'can_manage_notifications'
    | 'can_import_data'
  >
> = {
  issue: 'can_issue_documents',
  cancel: 'can_cancel_documents',
  statutory: 'can_manage_statutory_reporting',
  payments: 'can_manage_payments',
  sign: 'can_sign_documents',
  payroll: 'can_manage_payroll',
  notifications: 'can_manage_notifications',
  import: 'can_import_data',
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
