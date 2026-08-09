/**
 * Dependency-free sliding-window rate limiter (ops batch: login and
 * upload throttling) and the account-scoped login lockout that rides
 * beside it. Per-process state is the right scope for the single-host
 * pilot topology; a multi-instance deployment would move this into
 * PostgreSQL or a shared store.
 */

import { createHash } from 'node:crypto';

export interface RateLimitRule {
  readonly windowMs: number;
  readonly max: number;
}

export interface RateLimiter {
  /** Records an attempt for the key and reports whether it is allowed. */
  allow(key: string): boolean;
}

export function createRateLimiter(rule: RateLimitRule): RateLimiter {
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
  isLocked(key: string): boolean;
  /**
   * Records one failed attempt. Returns true exactly when this failure
   * transitions the key into the locked state (so the caller can audit
   * the lockout once, not once per rejected attempt).
   */
  recordFailure(key: string): boolean;
  /** Clears the failure history and any active lock (successful login). */
  clear(key: string): void;
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
      return entry !== undefined && entry.lockedUntil > now;
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
      if (justLocked) entry.lockedUntil = now + rule.lockMs;
      failures.set(key, entry);
      return justLocked;
    },
    clear(key: string): void {
      failures.delete(key);
    },
  };
}
