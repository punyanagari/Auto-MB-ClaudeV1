---
name: auto-mb-verify
description: Verify Auto-MB changes with risk-based narrow checks and the repository's existing full verification pipeline. Use after modifying Auto-MB code, tests, migrations, contracts, web UI, deployment files, or documentation; before claiming completion; and when investigating CI or local verification failures.
---

# Auto-MB verification

Use existing repository scripts. Do not invent a parallel quality system.

## Establish scope

1. Read AGENTS.md and relevant product, architecture, security, UX, ADR, and operations documents.
2. Inspect task and final diff. List affected surfaces: web, server, contracts, parser, database, operations, or documentation.
3. Confirm Node and pnpm satisfy package.json, dependencies are installed from lockfile, and required services are available.
4. If a prerequisite is missing, report it as a blocker. Do not describe an unexecuted check as passing.

## Run narrow checks first

- Web changes: run web typecheck, component tests, production build, and relevant Playwright tests. Run design:contrast, design:states, design:a11y, design:rtl, and design:taste when runtime prerequisites are available.
- API or contract changes: run affected server and contract tests plus type checking.
- Parser changes: run focused parser tests, then parser package suite and corpus regressions.
- Database or migration changes: run migration validation and real PostgreSQL integration tests. Require cross-tenant denial coverage. Require simultaneous-request coverage for numbering, quantities, migrations, or other concurrency-sensitive behavior.
- Deployment, backup, or configuration changes: run configuration parsing and relevant smoke or restore workflow described in .github/workflows/ci.yml and docs/RUNBOOK.md.
- Documentation-only changes: run formatting and validate every command, path, and behavioral claim against code or configuration.

Prefer package filters for narrow checks, for example:

    pnpm --filter @auto-mb/web typecheck
    pnpm --filter @auto-mb/web test
    pnpm --filter @auto-mb/web build
    pnpm --filter @auto-mb/web test:e2e
    pnpm --filter @auto-mb/server test
    pnpm --filter @auto-mb/db test
    pnpm --filter @auto-mb/loa-parser test

## Completion gate

Run pnpm verify from repository root before handoff. Treat any failure as unresolved unless task scope explicitly excludes fixing it and report that exclusion.

Review final diff against acceptance criteria after checks finish. Confirm no placeholder, TODO, fake implementation, or silently skipped verification remains in accepted path.

## Report

List:

- affected surfaces;
- commands that passed;
- commands that failed, with shortest decisive error;
- required commands skipped and exact reason;
- residual manual, browser, database, deployment, or product-owner checks.

Never claim full verification when any required check was skipped.
