export * from './pool.js';
export * from './tenant.js';
export * from './queue.js';
export * from './migration-runner.js';
export * from './roles.js';
/**
 * Structured values go into a statement through the client's json helper,
 * spelled `json(value as never)` on the `sql` instance. Two traps make the
 * spelling load-bearing:
 *
 * - passing `JSON.stringify(value)` (with or without a `::jsonb` cast)
 *   stores a jsonb STRING SCALAR containing JSON text, not an object —
 *   `->>` and friends silently return NULL against it;
 * - postgres.js's `JSONValue` parameter type demands index signatures,
 *   which interface-typed domain values structurally lack even though
 *   serialization is JSON.stringify either way — hence the cast.
 */
export type { Sql, TransactionSql } from 'postgres';
