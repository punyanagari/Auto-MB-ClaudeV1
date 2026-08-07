# Auto-MB ClaudeV1 — repository instructions

## Mission

Build the smallest reliable post-award works-contract execution product for Indian government contractors. The first commercial path is LOA intake to issued Delivery Challan and an honest quantity ledger.

## Sources of truth

Read in this order:

1. `docs/PRODUCT.md`
2. `docs/ARCHITECTURE.md`
3. `docs/SECURITY.md`
4. the relevant ADR
5. the issue or task being implemented
6. existing tests and fixtures

`docs/reference/**` is historical evidence, not active instruction. Do not copy legacy architecture or governance merely because it exists there.

## Non-negotiable engineering rules

1. Deliver vertical user outcomes; do not create speculative frameworks.
2. Every tenant-owned row carries `organisation_id` and is protected by PostgreSQL RLS.
3. Normal data access must run in an organisation-scoped transaction.
4. The application DB role must not be superuser, table owner, or `BYPASSRLS`.
5. Money uses decimal/numeric values; never JavaScript floating-point arithmetic for authoritative totals.
6. Legal dates are date-only `YYYY-MM-DD` values; do not timezone-round-trip them.
7. Issued documents are immutable snapshots. Master-data edits never rewrite history.
8. Drafts may be deleted. Issued records cancel with a reason and retain their number forever.
9. Number assignment and quantity validation must remain correct under concurrency.
10. AI extraction may propose data but never directly commit authoritative contract records.
11. Request logs never include bodies, passwords, tokens, LOA contents, or personal documents.
12. No production credentials or customer data in agent workspaces.

## Change workflow

For each material change:

1. Restate the user outcome and non-goals.
2. Inspect current code and relevant documentation.
3. Propose the smallest implementation plan.
4. Identify schema, tenancy, authorization, audit, migration, and operations effects.
5. Add or update tests before claiming completion.
6. Run the narrow checks while developing and `pnpm verify` before handoff.
7. Review the final diff against the issue, not against the implementation plan alone.

High-risk work requires a fresh review pass: RLS, authentication, authorization, uploads, numbering, money, migrations, infrastructure, and issued-document changes.

## Architecture boundaries

- `apps/web`: presentation and interaction; no authoritative business calculations.
- `apps/server`: product modules and HTTP orchestration.
- `apps/worker`: asynchronous jobs only.
- `packages/db`: connections, migrations, transaction/tenant primitives.
- `packages/contracts`: shared API schemas and types.
- `packages/loa-parser`: pure LOA parsing and regression corpus.

Do not create a new package until there is a real second consumer or independent release boundary. Document rendering and shared test infrastructure stay inside the module that needs them until that bar is met.

## Definition of done

A change is complete only when:

- acceptance criteria are demonstrably met;
- type checking, linting, formatting, and relevant tests pass;
- database work has real PostgreSQL integration tests;
- tenant-owned work has cross-tenant denial tests;
- concurrency-sensitive work has simultaneous-request tests;
- security and operations documentation changed when the deployed behaviour changed;
- no placeholder, TODO, fake implementation, or silently skipped verification remains in the accepted path.
