import type { Sql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';

export type IdentityAction =
  | 'sign_up'
  | 'sign_in'
  | 'sign_out'
  | 'two_factor_enabled'
  | 'two_factor_disabled'
  | 'two_factor_verified'
  | 'two_factor_backup_code_used'
  | 'two_factor_locked';

/**
 * Maps a Better Auth endpoint path to the identity-audit action it
 * represents, or null for paths that are not auditable identity events
 * (session reads, verification callbacks, and so on).
 *
 * Two-factor mappings carry the SUCCESS action for the path; the auth proxy
 * refines two of them from request context, which a path alone cannot see:
 * a 2xx verify-totp that completed enrolment is recorded as
 * 'two_factor_enabled' rather than 'two_factor_verified', and a 429 from
 * the built-in verification lockout is recorded as 'two_factor_locked'.
 * /two-factor/enable itself is deliberately unmapped — it only stages a
 * secret, and enrolment is not an audit fact until a code proves the
 * authenticator holds it.
 */
export function identityActionForPath(pathname: string): IdentityAction | null {
  if (pathname.startsWith('/api/auth/sign-up/')) return 'sign_up';
  if (pathname.startsWith('/api/auth/sign-in/')) return 'sign_in';
  if (pathname === '/api/auth/sign-out') return 'sign_out';
  if (pathname === '/api/auth/two-factor/verify-totp') return 'two_factor_verified';
  if (pathname === '/api/auth/two-factor/verify-backup-code') {
    return 'two_factor_backup_code_used';
  }
  if (pathname === '/api/auth/two-factor/disable') return 'two_factor_disabled';
  return null;
}

/** The two-factor endpoints the proxy audits and, for enable/disable,
 * follows with a revocation of the user's other sessions. */
export function isTwoFactorPath(pathname: string): boolean {
  return pathname.startsWith('/api/auth/two-factor/');
}

/**
 * Appends one identity audit event. Identity events are user-scoped, not
 * organisation-scoped, so they land in identity_audit_events (migration
 * 0005) rather than audit_events. The caller decides how failures are
 * handled — the auth response itself has already been produced by the time
 * this runs, so the app logs and continues rather than un-signing-in the
 * user over a failed audit write.
 */
export async function recordIdentityEvent(
  sql: Sql,
  event: {
    readonly userId: string;
    readonly action: IdentityAction;
    readonly requestId: string;
  },
): Promise<void> {
  await sql`
    insert into identity_audit_events (user_id, action, request_id)
    values (${event.userId}, ${event.action}, ${event.requestId})
  `;
}

/**
 * Appends the audit row for an account-scoped login lockout (migration
 * 0020). No authenticated user exists at that moment — the account may
 * not even exist, and saying so would be an existence oracle — so the row
 * is keyed by the SHA-256 hash of the normalised submitted email, the
 * same key the in-process lockout uses. Neither the raw email nor any
 * password material may ever reach this table.
 */
export async function recordLoginLockout(
  sql: Sql,
  event: {
    readonly emailHash: string;
    readonly requestId: string;
  },
): Promise<void> {
  await sql`
    insert into identity_audit_events (user_id, action, request_id, details)
    values (
      ${'email-sha256:' + event.emailHash},
      'login_locked',
      ${event.requestId},
      ${jsonb(sql, { emailSha256: event.emailHash })}
    )
  `;
}
