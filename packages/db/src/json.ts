import type { Sql, TransactionSql } from 'postgres';

/**
 * Binds a structured value as a real jsonb parameter. Two things make this
 * helper worth having over inlining:
 *
 * - passing `JSON.stringify(value)` (with or without a `::jsonb` cast)
 *   stores a jsonb STRING SCALAR containing JSON text, not an object —
 *   `->>` and friends silently return NULL against it;
 * - postgres.js's `JSONValue` parameter type demands index signatures,
 *   which interface-typed domain values structurally lack even though
 *   serialization is JSON.stringify either way.
 */
export function jsonb(sql: Sql | TransactionSql, value: unknown) {
  return sql.json(value as never);
}
