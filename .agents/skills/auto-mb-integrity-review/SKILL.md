---
name: auto-mb-integrity-review
description: Review Auto-MB changes for tenant isolation, authorization, auditability, money, legal dates, numbering, quantity, concurrency, immutable issued records, and migration safety. Use for RLS, database, authentication, permissions, uploads, billing, Measurement Book, challan issue or cancel, quantities, numbering, migrations, and final high-risk review.
---

# Auto-MB integrity review

Perform an independent, read-only review. Seek counterexamples and invariant failures, not style preferences.

## Read first

Read AGENTS.md, docs/PRODUCT.md, docs/ARCHITECTURE.md, docs/SECURITY.md, relevant ADRs, migrations, routes, contracts, and tests. Trace request to database and back before judging a guard.

## Review checklist

### Tenant and authority

- Every tenant-owned row has organisation_id.
- RLS and FORCE ROW LEVEL SECURITY fail closed.
- Normal access uses an organisation-scoped transaction and membership floor.
- Application role is not owner, superuser, or BYPASSRLS.
- Server authorization covers role, Work scope, assignments, and sensitive-action flags.
- UI visibility is never only authorization control.
- Cross-tenant guessed identifiers fail through real pool and HTTP paths.
- Material actions append sufficient audit evidence without logging secrets or document bodies.

### Values and legal state

- Money and authoritative quantities use PostgreSQL numeric and decimal strings, never JavaScript floating-point arithmetic.
- Legal dates stay date-only YYYY-MM-DD; no timezone conversion changes them.
- Number allocation is serialized, gap-free where required, and happens only during successful issue.
- Quantity floors, ceilings, duplicate-line rules, and effective quantities hold under concurrent requests.
- Drafts may be deleted; issued records cancel with reasons, retain numbers, and remain immutable.
- Generated documents use stored issued snapshots, not mutable master data.

### Migrations and operations

- Migration upgrades existing and fresh databases safely, remains rerunnable where required, and preserves ownership, grants, RLS, and indexes.
- Backfill and constraints cannot create cross-tenant or lifecycle corruption.
- Rollback strategy is explicit when reversal is unsafe.
- PostgreSQL tests cover cross-tenant denial, boundaries, failure paths, and concurrency for affected invariants.

## Findings

Report actionable findings first, ordered P0 to P3. For each finding include:

- concrete failure scenario;
- exact file and line;
- violated contract or invariant;
- missing or inadequate test;
- smallest safe correction direction.

Do not edit code. If no findings exist, state that and list tests and residual risks inspected.
