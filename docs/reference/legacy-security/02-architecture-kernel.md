## 1. Architecture: the security kernel

All security primitives are consumed **only** via the public interfaces of
`packages/kernel` (import-boundary lint, build-failing). The kernel is the
audit-stable boundary: changes inside it classify as **full re-audit** in
the change-classification matrix (see §12, parked detail in
`docs/archive/2026-07-14-azure-adr/ARCHIVED-ARCHITECTURE.md` §12).

Kernel surface (Stage 0): authn/session adapter (Better Auth), authorizer
(two-tier cache + invalidation), tenant context / RLS session binding,
idempotency-key interceptor, audit writer, upload validation,
`assignNumber(tx, scope)`, crypto envelope helpers.

---

