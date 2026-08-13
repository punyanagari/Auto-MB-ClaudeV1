import type { Sql, TransactionSql } from 'postgres';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TenantContext {
  readonly organisationId: string;
  readonly userId?: string;
}

export async function withUserContext<T>(
  sql: Sql,
  userId: string,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (userId.length === 0) throw new TypeError('userId is required');

  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.organisation_id', '', true)`;
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return work(tx);
  });
  // postgres.js types begin() as UnwrapPromiseArray<T>, which is identity
  // here because the callback resolves a single value, never an array of
  // promises.
  return result as T;
}

/**
 * The tenant binding, in one place for both isolation levels.
 *
 * `app_private.bind_tenant` (migration 0069) writes the two GUCs every RLS
 * policy reads and then proves, on the definer's authority, that the user
 * holds an ACTIVE membership in the organisation being bound. Both writes
 * are `set_config(..., is_local = true)` inside that function, which is
 * what keeps them scoped to THIS transaction: a session-level setting
 * would outlive the work and leak the binding onto the next borrower of
 * the pooled connection. Both keys are always written, including an empty
 * user id, so a missing value can never fall through to a previous
 * transaction's. Any variant added here must keep going through
 * `bind_tenant` rather than setting the GUCs itself.
 *
 * A binding the user does not hold now raises SQLSTATE 28000 here, before
 * any statement of `work` runs, instead of leaving the policies to deny
 * everything silently and the caller to read an empty database. That is
 * fail-fast, not the floor: the floor is still
 * `app_private.current_organisation_id()`, which every policy calls and
 * which re-proves the membership itself.
 *
 * `beginOptions` is appended to BEGIN by postgres.js. It is a fixed
 * literal chosen by the exported wrapper below, never caller input.
 */
async function withTenantAt<T>(
  sql: Sql,
  context: TenantContext,
  beginOptions: string,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(context.organisationId)) {
    throw new TypeError('organisationId must be a UUID');
  }

  const result = await sql.begin(beginOptions, async (tx) => {
    await tx`select app_private.bind_tenant(${context.organisationId}::uuid, ${context.userId ?? ''})`;
    return work(tx);
  });
  // Same UnwrapPromiseArray<T> identity as withUserContext above.
  return result as T;
}

/** The default: a tenant-scoped transaction at the server's isolation
 * level (READ COMMITTED). Every statement sees the newest committed data,
 * which is what a request that reads and writes one consistent set of
 * rows under row locks wants. */
export async function withTenant<T>(
  sql: Sql,
  context: TenantContext,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withTenantAt(sql, context, '', work);
}

/**
 * A tenant-scoped transaction at REPEATABLE READ: every statement reads
 * the same snapshot, taken at the first one.
 *
 * For work that reads MANY tables and has to hand back a self-consistent
 * result. Under READ COMMITTED each statement takes its own snapshot, so
 * a writer committing midway through a long sequence of SELECTs is
 * visible to the later ones and invisible to the earlier ones — a
 * full-organisation export can then contain challan items whose parent
 * challan was read before it existed. Locking those tables is not an
 * option (it would stall the tenant's normal work for the length of the
 * export); a snapshot costs nothing and answers exactly the question.
 *
 * The transaction stays READ WRITE, so callers may still record their own
 * audit event. The cost is that a concurrent update to a row this
 * transaction writes raises a serialization_failure (40001) instead of
 * blocking, so a caller that writes contended rows should use `withTenant`
 * or be prepared to retry.
 */
export async function withTenantSnapshot<T>(
  sql: Sql,
  context: TenantContext,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withTenantAt(sql, context, 'isolation level repeatable read', work);
}
