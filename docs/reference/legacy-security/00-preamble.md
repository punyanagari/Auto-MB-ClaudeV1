# SECURITY.md — ASVS Level 2 Traceability Matrix

> **Status:** Skeleton, created 23/07/2026 per `AMENDMENTS-2026-07-17.md`
> §A2 / §A10 item 4. This file is the single security ledger of the Auto-MB
> SaaS: every OWASP **ASVS 5.0 Level 2** control in scope maps to *where it
> is implemented* and *which test proves it*. It doubles as the auditor
> handover pack for the STQC / CERT-In empanelled security audit.
>
> **Governance rule (from CLAUDE.md):** any PR that adds an endpoint, a
> module, an upload path, a queue consumer, or touches `packages/kernel`
> MUST update this matrix in the same PR. The gates listed in §2 may never
> be disabled, skipped, or downgraded. **They now block a merge.**
> `.github/workflows/ci.yml` runs `pnpm gates` on every pull request and on
> pushes to `main` (OPS-15, `decisions/APPROVED-080` — PR runs cover every
> PR-branch push, and the required PR checks below are the wall),
> and as of 28/07/2026 **both** CI jobs — `frozen-effect` and `gates` — are
> *required* status checks on `main`. Both were measured, not read off a
> settings page (§2.1, §2.2): a pull request whose `gates` run failed while
> `frozen-effect` stayed green reported `mergeable_state: blocked`, where the
> same shape had reported `unstable` before the ruleset change. So §2.1's chain
> is genuinely build-failing in the sense an auditor means, for the first time
> since this file was written. §2 still splits into what `pnpm gates` enforces
> (§2.1) and what is named but does not exist (§2.2) — the latter is unchanged
> and remains owed. As of 28/07/2026 `scripts/tickets-check.sh` **and its
> negative probe are in the chain** (§2.1), so an invalid ticket now fails
> `gates` and blocks a merge. One limit stays: **no pull-request review is
> required** on `main` — direct pushes are refused, but an unreviewed PR
> merges once the required checks are green.
>
> **Scope note:** rows are populated for the **DC-first dogfooding
> milestone** (auth, tenancy, works, delivery challans, uploads, audit).
> MB / GST / billing controls enter the matrix when those phases are
> scoped, per ROADMAP. Rows marked `TBD` are owed before the stage that
> ships the feature exits.

---

