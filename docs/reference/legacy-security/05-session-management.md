## 4. V7 Session Management

| ASVS | Requirement | Implementation | Proving test | Status |
|---|---|---|---|---|
| 7.2.1, 7.3.2 | Server-side session truth; ~12 h lifetime | Better Auth sessions | Integration: expiry | TBD |
| 7.2.1, 8.3.1 | Permissions & active flag read from DB per request, never from tokens | Two-tier authorizer (in-memory TTL + Redis pub/sub invalidation); fresh-read variant on security-sensitive endpoints | Integration: disable user → next request cut off without re-login | TBD |
| 8.3.2 (L3, exceeds L2 bar) | Invalidation on grant/scope/active-flag writes | Mandatory publish of invalidation event | Integration: stale-cache window bounded | TBD |

