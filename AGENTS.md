# Auto-MB ClaudeV1 — repository instructions

## Mission

Build the smallest reliable post-award works-contract execution product for Indian government contractors. The first commercial path is LOA intake to issued Delivery Challan and an honest quantity ledger.

## Sources of truth

Read in this order:

1. `docs/PRODUCT.md`
2. `docs/ARCHITECTURE.md`
3. `docs/SECURITY.md`
4. `docs/UX.md` for interaction architecture and the measurement-to-billing narrative
5. `docs/DESIGN.md` for the design-contract token and component specification
6. the relevant ADR
7. the issue or task being implemented
8. existing tests and fixtures

`docs/reference/**` is historical evidence, not active instruction. Do not copy legacy architecture or governance merely because it exists there.

## Non-negotiable engineering rules

1. Deliver vertical user outcomes; do not create speculative frameworks.
2. Every tenant-owned row carries `organisation_id` and is protected by PostgreSQL RLS.
3. Normal data access must run in an organisation-scoped transaction.
4. The application DB role must not be superuser, table owner, or `BYPASSRLS`.
5. Money uses decimal/numeric values; never JavaScript floating-point arithmetic for authoritative totals.
6. Legal dates are date-only `YYYY-MM-DD` values; do not timezone-round-trip them.
   The one exception is a deadline that states a time of day, where the time is
   what decides the outcome — see migration `0083_tenders.sql` § NUMBERING and
   `bid_closes_at` for the reasoning and the timezone binding it uses instead.
7. Issued documents are immutable snapshots. Master-data edits never rewrite history.
8. Drafts may be deleted. Issued records cancel with a reason and retain their number forever.
9. Number assignment and quantity validation must remain correct under concurrency.
10. AI extraction may propose data but never directly commit authoritative contract records.
11. Request logs never include bodies, passwords, tokens, LOA contents, or personal documents.
12. No production credentials or customer data in agent workspaces.

## Design contract

The Vercel mock repository (`punyanagari/Auto-MB-Vercel-du`, authored in
v0) is the binding UI/UX contract for the redesigned application. Design
iteration happens in v0 and lands in that repository; this application
replicates the mock, never the other way around.

1. No change may alter any UI/UX element — layout, navigation, screen
   structure, components, tokens, colors, spacing, typography, or
   interaction patterns — unless the mock has been updated in Vercel
   first and the change replicates the updated mock. Pull requests for
   such changes must cite the mock commit they replicate.
2. Purely textual changes (copy, labels, messages, error text) are the
   only UI changes allowed to land app-first without a mock update.
3. Screens that exist in both the mock and the application must remain
   visually indistinguishable; pixel drift is a defect, not a liberty.
4. Behaviour the mock cannot express (validation, real data, server
   rules) is built inside the mock's visual grammar using its existing
   components, without inventing new visual language.

## Change workflow

For each material change:

1. Restate the user outcome and non-goals.
2. Inspect current code and relevant documentation.
3. Propose the smallest implementation plan.
4. Identify schema, tenancy, authorization, audit, migration, and operations effects.
5. Add or update tests before claiming completion.
6. Run `pnpm preflight` before your first push.
7. Run the narrow checks while developing and `pnpm verify` before handoff.
8. Review the final diff against the issue, not against the implementation plan alone.

`pnpm preflight` reads the files this branch changed against its merge base
with `origin/main` and runs the gates those files can break: formatting and
the pure source-scan censuses always, plus the standing database-shape
censuses — migration contract and SQLSTATE uniqueness, the bootstrap
privilege matrix, foreign-key index coverage, and the audit-timeline,
error-remedies and write-loop censuses — when the change touches
`packages/db` or any `.sql` file. It takes under a minute and needs no
build. It exists because those gates were otherwise discovered one CI round
at a time; it does not replace `pnpm verify`, which still owns lint,
typecheck, build and the integration suites.

High-risk work requires a fresh review pass: RLS, authentication, authorization, uploads, numbering, money, migrations, infrastructure, and issued-document changes.

## Shared values across concurrent branches

Some values are allocated by hand and shared by every branch in flight: the
export package's format version, and the section numbers in `docs/UX.md`.
Two branches that both take the next free number produce IDENTICAL lines,
which git merges without a conflict. The collision is silent, and it has
happened repeatedly — `export-v37`, then `export-v40`, then UX § 38.

Do not claim a number on a feature branch. Hold a placeholder instead, and
let the coordinator assign the concrete value at merge.

- **Export format version.** Write `export-vNEXT` in BOTH
  `apps/server/src/routes/export.ts` (`EXPORT_FORMAT_VERSION`) and
  `apps/server/test/helpers/export-format.ts` (`EXPECTED_EXPORT_VERSION`).
  The pinning suites treat the sentinel as "not assigned yet" and skip the
  assertion. `pnpm export:check` fails when the sentinel is still present on
  `main`, and when only one of the two files holds it; it passes on feature
  branches, which is where the sentinel belongs. It runs in `pnpm preflight`
  and in the CI cheap-gates lane.
- **`docs/UX.md` section numbers.** Write the heading as `### NN. Title` and
  leave `NN` literally as `NN`. Nothing mechanical can check this — a
  section number is prose, and a placeholder is indistinguishable from a
  typo to a scanner — so it is a convention rather than a gate. Cite the
  section as `§ NN` in the same branch's prose so the coordinator's
  find-and-replace at merge is one pass, not a hunt.

Whoever merges the branch replaces every placeholder with the value that is
actually free on `main` at that moment, in the same commit as the merge.

## Architecture boundaries

- `apps/web`: presentation and interaction; no authoritative business calculations.
- `apps/server`: product modules and HTTP orchestration.
- `apps/worker`: asynchronous jobs only.
- `packages/db`: connections, migrations, transaction/tenant primitives.
- `packages/contracts`: shared API schemas and types.
- `packages/loa-parser`: pure LOA parsing and regression corpus.

Do not create a new package until there is a real second consumer or independent release boundary. Document rendering and shared test infrastructure stay inside the module that needs them until that bar is met.

## Agent prose style

Conversational replies default to the vendored `caveman` skill
(`.claude/skills/caveman/SKILL.md`): terse fragments, no filler or hedging,
technical terms and numbers exact. A `SessionStart` hook turns it on for every
session; `.claude/skills/PROVENANCE.md` explains the wiring and the off
switches.

This governs chat register only. Everything that outlives the conversation —
code, comments, commit messages, documentation, issue and PR text — is written
in normal prose, as is any security warning or irreversible-action
confirmation. The engineering rules above are unaffected.

## Agent orchestration

- Keep one writer: the main agent owns repository edits and integration.
- Use at most two concurrent read-only subagents for independent exploration,
  verification, or review. The project Codex limit excludes the primary thread.
- Use the project explorer before medium or high-complexity changes when the
  implementation path is unclear.
- Use the integrity reviewer for RLS, authentication, authorization, uploads,
  money, quantities, numbering, concurrency, migrations, issued documents, and
  other high-risk surfaces.
- Use the test reviewer after implementation to compare acceptance criteria,
  the final diff, and required proof.
- Do not run parallel writers on overlapping application or migration code.

## Definition of done

A change is complete only when:

- acceptance criteria are demonstrably met;
- type checking, linting, formatting, and relevant tests pass;
- database work has real PostgreSQL integration tests;
- tenant-owned work has cross-tenant denial tests;
- concurrency-sensitive work has simultaneous-request tests;
- security and operations documentation changed when the deployed behaviour changed;
- no placeholder, TODO, fake implementation, or silently skipped verification remains in the accepted path.
