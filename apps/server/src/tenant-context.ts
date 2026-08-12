import type { Sql, TransactionSql } from '@auto-mb/db';
import { withTenant, withTenantSnapshot } from '@auto-mb/db';
import { httpError } from './http.js';

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
 * user holds no active membership in the requested organisation,
 * current_organisation_id() stays NULL and the request fails with 403
 * before any tenant data is touched.
 */
export async function withBoundTenant<T>(
  sql: Sql,
  organisationId: string,
  userId: string,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withTenant(sql, { organisationId, userId }, (tx) =>
    assertBoundThen(tx, organisationId, work),
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
  return withTenantSnapshot(sql, { organisationId, userId }, (tx) =>
    assertBoundThen(tx, organisationId, work),
  );
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
    throw httpError(
      403,
      'NOT_A_MEMBER',
      'The authenticated user holds no active membership in this organisation.',
    );
  }
  return work(tx);
}
