import type { Sql, TransactionSql } from '@auto-mb/db';
import { TenantBindRefusedError, withTenant, withTenantSnapshot } from '@auto-mb/db';
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
 * `app_private.bind_tenant` proves the membership as the transaction opens
 * — so `refuseNonMember` below translates the `TenantBindRefusedError`
 * that `@auto-mb/db` raises for it into the same named 403 the floor check
 * has always produced. The HTTP contract is unchanged; only the place the
 * answer is computed moved.
 */
export async function withBoundTenant<T>(
  sql: Sql,
  organisationId: string,
  userId: string,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return refuseNonMember(
    withTenant(sql, { organisationId, userId }, (tx) =>
      assertBoundThen(tx, organisationId, work),
    ),
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
  return refuseNonMember(
    withTenantSnapshot(sql, { organisationId, userId }, (tx) =>
      assertBoundThen(tx, organisationId, work),
    ),
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
 * Turns the bind refusal into the named 403.
 *
 * The discrimination is structural, not positional: `@auto-mb/db` raises
 * `TenantBindRefusedError` only for Auto-MB's own SQLSTATE and only for
 * the bind statement, so nothing else can arrive here wearing it. In
 * particular a genuine `28000` — PostgreSQL's own
 * `invalid_authorization_specification`, which a pg_hba, LOGIN, or
 * definer-ownership failure raises — is NOT a bind refusal and propagates
 * as the 5xx it is. An authentication outage must look like an outage,
 * not like every tenant losing their membership at once.
 */
async function refuseNonMember<T>(bound: Promise<T>): Promise<T> {
  try {
    return await bound;
  } catch (error) {
    if (error instanceof TenantBindRefusedError) throw notAMemberError();
    throw error;
  }
}

/**
 * The read-back below is INTENTIONALLY REDUNDANT since 0069, and kept.
 *
 * `bind_tenant` already refused this exact condition a statement earlier,
 * so the 403 branch should now be unreachable through this module. It is
 * retained for two reasons, and the choice is flagged in the pull request
 * for the reviewer rather than made silently.
 *
 * First, the repository's own recurring finding is "security is enforced
 * twice; money once". Tenancy is the surface that gets two enforcements,
 * and removing one to save a single cheap statement inverts that rule.
 *
 * Second — and this is the concrete reason, not the principle — the bind's
 * transaction-local `set_config` calls happen INSIDE a function carrying
 * its own `SET search_path` clause, and whether a GUC written there
 * survives the function boundary is PostgreSQL implementation behaviour,
 * not something the SQL standard promises. It was verified on 18.4 and on
 * the 17 image CI runs. This read-back is the standing check that it still
 * holds on whatever server version production is actually on: if a future
 * release ever unwound those writes at function exit, every request would
 * refuse loudly here instead of quietly reading an unbound database.
 */
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
