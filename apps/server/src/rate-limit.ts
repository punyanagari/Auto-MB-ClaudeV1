/**
 * Dependency-free sliding-window rate limiter (ops batch: login and
 * upload throttling). Per-process state is the right scope for the
 * single-host pilot topology; a multi-instance deployment would move
 * this into PostgreSQL or a shared store.
 */

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
