import type { Sql, TransactionSql } from '@auto-mb/db';
import { withTenant, withTenantSnapshot } from '@auto-mb/db';
import { httpError } from './http.js';
import {
  mfaEnforcementEnabled,
  mfaEnrolmentRequiredError,
  mfaGate,
} from './mfa-policy.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validates the organisation header shape before it ever reaches SQL. */
export function requireOrganisationHeader(
  header: string | string[] | undefined,
): string {
  if (typeof header !== 'string' || !UUID_PATTERN.test(header)) {
    throw httpError(
      400,
      'ORGANISATION_HEADER_REQUIRED',
      'The x-organisation-id header must carry the selected organisation id.',
    );
  }
  return header;
}

/**
 * Runs `work` inside a tenant-scoped transaction, but only after the
 * database's membership floor confirms the binding: if the authenticated
 * user holds no active membership in the requested organisation the
 * request fails with 403 before any tenant data is touched.
 *
 * Since migration 0069 that refusal arrives one step earlier —
 * `app_private.bind_tenant` proves the membership as the transaction
 * opens and raises SQLSTATE 28000 — so `refuseNonMember` below translates
 * it into the same named 403 the floor check has always produced. The
 * HTTP contract is unchanged; only the place the answer is computed moved.
 */
export async function withBoundTenant<T>(
  sql: Sql,
  organisationId: string,
  userId: string,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return refuseNonMember((entered) =>
    withTenant(sql, { organisationId, userId }, (tx) => {
      entered();
      return assertBoundThen(tx, organisationId, work);
    }),
  );
}

/**
 * `withBoundTenant` at REPEATABLE READ, for a request that reads many
 * tables and must hand back one self-consistent picture of them (see
 * `withTenantSnapshot`). The membership floor is proved identically and
 * on the same snapshot, so a membership revoked mid-request cannot widen
 * what the request may read.
 */
export async function withBoundTenantSnapshot<T>(
  sql: Sql,
  organisationId: string,
  userId: string,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return refuseNonMember((entered) =>
    withTenantSnapshot(sql, { organisationId, userId }, (tx) => {
      entered();
      return assertBoundThen(tx, organisationId, work);
    }),
  );
}

/** The one refusal a caller who is not a member of the bound organisation
 * ever sees, wherever it was detected. */
function notAMemberError(): Error {
  return httpError(
    403,
    'NOT_A_MEMBER',
    'The authenticated user holds no active membership in this organisation.',
  );
}

/**
 * Turns `bind_tenant`'s SQLSTATE 28000 back into the named 403.
 *
 * Scoped deliberately narrowly: only a 28000 raised BEFORE the callback
 * was entered can have come from the bind, so a 28000 thrown by anything
 * the request itself runs still propagates as itself rather than being
 * relabelled a membership problem.
 */
async function refuseNonMember<T>(
  run: (entered: () => void) => Promise<T>,
): Promise<T> {
  let entered = false;
  try {
    return await run(() => {
      entered = true;
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (!entered && code === '28000') throw notAMemberError();
    throw error;
  }
}

async function assertBoundThen<T>(
  tx: TransactionSql,
  organisationId: string,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const [bound] = await tx<{ organisation_id: string | null }[]>`
    select app_private.current_organisation_id() as organisation_id
  `;
  if (bound?.organisation_id !== organisationId) {
    throw notAMemberError();
  }
  // Finding 36: after the membership floor binds, the MFA wall stands in the
  // same place, so every tenant-scoped route is covered without any route
  // opting in. The gate is computed unconditionally (an authority granted a
  // minute ago must count on the very next request); only the refusal is
  // behind the enforcement flag so the control can deploy dark. Identity
  // endpoints (/api/me, /api/organisations, /api/auth/*) never pass through
  // here, which is what keeps enrolment itself reachable.
  const gate = await mfaGate(tx);
  if (gate.required && !gate.enabled && mfaEnforcementEnabled()) {
    throw mfaEnrolmentRequiredError();
  }
  return work(tx);
}
