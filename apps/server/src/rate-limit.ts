/**
 * Sliding-window rate limiter (ops batch: login and upload throttling)
 * and the account-scoped login lockout that rides beside it.
 *
 * Two implementations share each interface. The PostgreSQL-backed ones
 * (finding 38, migration 0054) are what a database-configured server
 * runs: every API instance counts the same attempts, so adding a replica
 * no longer divides the windows. The in-process Map implementations
 * remain for database-less instances (a bare buildApp() in tests exposes
 * no login or upload surface to protect) and as the reference semantics
 * the PostgreSQL versions replicate.
 */

import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { recordAccountLockout, recordRateLimitRejection } from './metrics.js';

export interface RateLimitRule {
  readonly windowMs: number;
  readonly max: number;
}

/** Which throttle refused a request, for the finding-37 rejection counter.
 * Both implementations of each interface count at the moment of refusal,
 * so the metric measures the control rather than any one caller's
 * bookkeeping. */
type RateLimitScopeName =
  'auth' | 'upload' | 'account_lockout' | 'signing' | 'notification_webhook';

interface RateLimiter {
  /** Records an attempt for the key and reports whether it is allowed.
   * Synchronous for the in-process implementation, a promise for the
   * PostgreSQL-backed one; callers await either. */
  allow(key: string): boolean | Promise<boolean>;
}

export function createRateLimiter(
  rule: RateLimitRule,
  scope: Exclude<RateLimitScopeName, 'account_lockout'> = 'auth',
): RateLimiter {
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  return {
    allow(key: string): boolean {
      const now = Date.now();
      const cutoff = now - rule.windowMs;

      // Periodic sweep keeps abandoned keys from accumulating.
      if (now - lastSweep > rule.windowMs) {
        lastSweep = now;
        for (const [candidate, stamps] of hits) {
          if (stamps.every((stamp) => stamp <= cutoff)) hits.delete(candidate);
        }
      }

      const recent = (hits.get(key) ?? []).filter((stamp) => stamp > cutoff);
      if (recent.length >= rule.max) {
        hits.set(key, recent);
        recordRateLimitRejection(scope);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}

export interface AccountLockoutRule {
  /** Sliding window over which failed attempts are counted. */
  readonly windowMs: number;
  /** Failures within the window that trigger the lock. */
  readonly maxFailures: number;
  /** How long a triggered lock holds before it expires on its own. */
  readonly lockMs: number;
}

export interface AccountLockout {
  /** True while the key is inside an active lock. */
  isLocked(key: string): boolean | Promise<boolean>;
  /**
   * Records one failed attempt. Returns true exactly when this failure
   * transitions the key into the locked state (so the caller can audit
   * the lockout once, not once per rejected attempt).
   */
  recordFailure(key: string): boolean | Promise<boolean>;
  /** Clears the failure history and any active lock (successful login). */
  clear(key: string): void | Promise<void>;
}

/**
 * Derives the account-lockout map key from a submitted login email:
 * normalised (trimmed, lowercased) and then SHA-256 hashed so the raw
 * address never sits in process memory as a long-lived map key where a
 * debugging surface (heap dump, inspector) could leak it.
 */
export function accountLockoutKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * Account-scoped counterpart to the per-address limiter above: a
 * distributed attacker who rotates source addresses against one account
 * walks straight past a per-IP window, so repeated failures for the SAME
 * account (existing or not — the caller must not disclose which) earn a
 * temporary lock. Failures decay with the sliding window and a
 * successful login clears them. In-process state, same single-instance
 * caveat as createRateLimiter.
 */
export function createAccountLockout(rule: AccountLockoutRule): AccountLockout {
  const failures = new Map<string, { stamps: number[]; lockedUntil: number }>();
  let lastSweep = 0;

  function sweep(now: number): void {
    const cutoff = now - rule.windowMs;
    if (now - lastSweep <= rule.windowMs) return;
    lastSweep = now;
    for (const [candidate, entry] of failures) {
      if (entry.lockedUntil <= now && entry.stamps.every((stamp) => stamp <= cutoff)) {
        failures.delete(candidate);
      }
    }
  }

  return {
    isLocked(key: string): boolean {
      const now = Date.now();
      sweep(now);
      const entry = failures.get(key);
      const locked = entry !== undefined && entry.lockedUntil > now;
      if (locked) recordRateLimitRejection('account_lockout');
      return locked;
    },
    recordFailure(key: string): boolean {
      const now = Date.now();
      sweep(now);
      const cutoff = now - rule.windowMs;
      const entry = failures.get(key) ?? { stamps: [], lockedUntil: 0 };
      const wasLocked = entry.lockedUntil > now;
      entry.stamps = entry.stamps.filter((stamp) => stamp > cutoff);
      entry.stamps.push(now);
      const justLocked = !wasLocked && entry.stamps.length >= rule.maxFailures;
      if (justLocked) {
        entry.lockedUntil = now + rule.lockMs;
        recordAccountLockout();
      }
      failures.set(key, entry);
      return justLocked;
    },
    clear(key: string): void {
      failures.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL-backed implementations (finding 38, migration 0054).
//
// Same windows, same thresholds, same refusal semantics as the Map
// versions above — the state just lives in the shared `rate_limit_attempts`
// and `account_lockout_locks` tables (UNLOGGED: reconstructible, no WAL on
// the sign-in path) so a second API instance divides nothing. Per-key
// mutations serialise on a transaction-scoped advisory lock, which keeps
// the count-then-record step exact under concurrency exactly as the
// single-threaded Maps were. A database failure fails CLOSED for the
// pre-request checks: the hook's thrown error becomes the standard 503,
// and the endpoints these limits protect could not have served the
// request without the database anyway.

/** Hashes a limiter key (a client address, or the account lockout's
 * already-hashed email) together with the throttle namespace, so no raw
 * address rests in the database. The namespace scopes the shared tables:
 * every production replica passes the same deployment namespace and
 * therefore counts the same attempts; a test instance without explicit
 * configuration gets an instance-scoped namespace (see buildApp), which
 * reproduces the per-process semantics the Map implementations had. */
function limiterKeyHash(namespace: string, key: string): string {
  return createHash('sha256').update(`${namespace}:${key}`).digest('hex');
}

type ThrottleScope = RateLimitScopeName;

/** Serialises this statement's transaction against every other mutation of
 * the same (scope, key) pair. hashtextextended gives a stable 64-bit key;
 * collisions across different keys merely serialise two unrelated attempts. */
async function lockThrottleKey(
  tx: Sql | TransactionSql,
  scope: ThrottleScope,
  keyHash: string,
): Promise<void> {
  await tx`
    select pg_advisory_xact_lock(hashtextextended(${`${scope}:${keyHash}`}, 0))
  `;
}

export function createPgRateLimiter(
  sql: Sql,
  scope: Exclude<RateLimitScopeName, 'account_lockout'>,
  rule: RateLimitRule,
  namespace: string,
): RateLimiter {
  // The sweep cadence is per-process, like the Map version's; the DELETE
  // itself acts on the shared table, so any one instance sweeping is
  // enough and two sweeping concurrently just both delete dead rows.
  let lastSweep = 0;

  return {
    async allow(key: string): Promise<boolean> {
      const keyHash = limiterKeyHash(namespace, key);
      const now = Date.now();
      if (now - lastSweep > rule.windowMs) {
        lastSweep = now;
        await sql`
          delete from rate_limit_attempts
          where scope = ${scope}
            and occurred_at <= now() - make_interval(secs => ${rule.windowMs / 1000})
        `;
      }
      const allowed = await sql.begin(async (tx) => {
        await lockThrottleKey(tx, scope, keyHash);
        const inserted = await tx<{ recorded: number }[]>`
          insert into rate_limit_attempts (scope, key_hash)
          select ${scope}, ${keyHash}
          where (
            select count(*) from rate_limit_attempts
            where scope = ${scope} and key_hash = ${keyHash}
              and occurred_at > now() - make_interval(secs => ${rule.windowMs / 1000})
          ) < ${rule.max}
          returning 1 as recorded
        `;
        return inserted.length === 1;
      });
      // Counted here, in the shared-state limiter every production replica
      // runs (finding 38), so the rejection metric measures the deployment
      // rather than one instance's view of it.
      if (!allowed) recordRateLimitRejection(scope);
      return allowed;
    },
  };
}

export function createPgAccountLockout(
  sql: Sql,
  rule: AccountLockoutRule,
  namespace: string,
): AccountLockout {
  const scope: ThrottleScope = 'account_lockout';
  let lastSweep = 0;

  async function sweep(): Promise<void> {
    const now = Date.now();
    if (now - lastSweep <= rule.windowMs) return;
    lastSweep = now;
    await sql`
      delete from rate_limit_attempts
      where scope = ${scope}
        and occurred_at <= now() - make_interval(secs => ${rule.windowMs / 1000})
    `;
    await sql`delete from account_lockout_locks where locked_until <= now()`;
  }

  async function activeLock(
    tx: Sql | TransactionSql,
    keyHash: string,
  ): Promise<boolean> {
    const rows = await tx<{ locked: number }[]>`
      select 1 as locked from account_lockout_locks
      where key_hash = ${keyHash} and locked_until > now()
    `;
    return rows.length === 1;
  }

  return {
    async isLocked(key: string): Promise<boolean> {
      await sweep();
      const locked = await activeLock(sql, limiterKeyHash(namespace, key));
      if (locked) recordRateLimitRejection(scope);
      return locked;
    },
    async recordFailure(key: string): Promise<boolean> {
      await sweep();
      const keyHash = limiterKeyHash(namespace, key);
      return sql.begin(async (tx) => {
        await lockThrottleKey(tx, scope, keyHash);
        // Same shape as the Map version: a failure while already locked
        // never re-reports the lock, expired failures decay, and the
        // window filling up (again) engages the lock (again).
        const wasLocked = await activeLock(tx, keyHash);
        await tx`
          delete from rate_limit_attempts
          where scope = ${scope} and key_hash = ${keyHash}
            and occurred_at <= now() - make_interval(secs => ${rule.windowMs / 1000})
        `;
        await tx`
          insert into rate_limit_attempts (scope, key_hash)
          values (${scope}, ${keyHash})
        `;
        const [counted] = await tx<{ failures: number }[]>`
          select count(*)::int as failures from rate_limit_attempts
          where scope = ${scope} and key_hash = ${keyHash}
            and occurred_at > now() - make_interval(secs => ${rule.windowMs / 1000})
        `;
        const justLocked = !wasLocked && (counted?.failures ?? 0) >= rule.maxFailures;
        if (justLocked) {
          // Once per lockout episode, matching the audit row app.ts writes
          // off the same boolean — never once per rejected attempt.
          recordAccountLockout();
          await tx`
            insert into account_lockout_locks (key_hash, locked_until)
            values (${keyHash}, now() + make_interval(secs => ${rule.lockMs / 1000}))
            on conflict (key_hash)
              do update set locked_until = excluded.locked_until
          `;
        }
        return justLocked;
      });
    },
    async clear(key: string): Promise<void> {
      const keyHash = limiterKeyHash(namespace, key);
      await sql`
        delete from rate_limit_attempts
        where scope = ${scope} and key_hash = ${keyHash}
      `;
      await sql`delete from account_lockout_locks where key_hash = ${keyHash}`;
    },
  };
}
