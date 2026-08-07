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

  return sql.begin(async (tx) => {
    await tx`select set_config('app.organisation_id', '', true)`;
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return work(tx);
  });
}

export async function withTenant<T>(
  sql: Sql,
  context: TenantContext,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(context.organisationId)) {
    throw new TypeError('organisationId must be a UUID');
  }

  return sql.begin(async (tx) => {
    await tx`select set_config('app.organisation_id', ${context.organisationId}, true)`;
    await tx`select set_config('app.user_id', ${context.userId ?? ''}, true)`;
    return work(tx);
  });
}
