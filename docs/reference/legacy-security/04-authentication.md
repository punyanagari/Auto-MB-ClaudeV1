## 3. V6 Authentication

Auth is delegated to **Better Auth** (ratified 17/07); custom surface is
limited to the rules below. Better Auth schema regeneration is a
kernel-class change (human sign-off required).

| ASVS | Requirement | Implementation | Proving test | Status |
|---|---|---|---|---|
| 6.2.1, 6.2.4, 6.2.5 | Password policy: min 8 characters, any character composition (no composition mandates), known-common/default passwords rejected | Custom validator on top of Better Auth (PRODUCT-SPEC §3.4) | Unit: policy matrix incl. `ChangeMe@123` etc. | TBD |
| 11.4.2 | Adaptive password hashing | Better Auth default; bcrypt-verify shim for migrated v1 hashes (cost embedded per hash) | Unit: v1 hash verifies, new hash uses current scheme | TBD |
| 6.3.1, 2.4.1 | Login throttling | Per-IP 20/15 min + per-username lock 5/15 min (shared store — must survive multi-instance) | Integration: throttle boundaries | TBD |
| 6.4.1 | Temporary password: random, shown once, never stored/logged plain, forces change | Custom flow (not for master admin/owner) | Integration: reuse rejected, forced change enforced | TBD |
| 6.3.2 | Default-credential warning at first run | Seed flow warning | Integration | TBD |
| 16.2.5 | No credential leakage in logs | Log middleware never logs bodies/secrets | Static audit + log-capture test | TBD |

