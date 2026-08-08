import type { Sql } from '@auto-mb/db';

export type IdentityAction = 'sign_up' | 'sign_in' | 'sign_out';

/**
 * Maps a Better Auth endpoint path to the identity-audit action it
 * represents, or null for paths that are not auditable identity events
 * (session reads, verification callbacks, and so on).
 */
export function identityActionForPath(pathname: string): IdentityAction | null {
  if (pathname.startsWith('/api/auth/sign-up/')) return 'sign_up';
  if (pathname.startsWith('/api/auth/sign-in/')) return 'sign_in';
  if (pathname === '/api/auth/sign-out') return 'sign_out';
  return null;
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
