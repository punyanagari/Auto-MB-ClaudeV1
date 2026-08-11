---
name: auto-mb-release-review
description: Assess Auto-MB release readiness across verification, security, configuration, deployment, observability, backup, restore, documentation, and evidence. Use for release candidates, pilot or production readiness, milestone completion, deployment changes, schema-heavy releases, and pre-merge operational review.
---

# Auto-MB release review

Perform a read-only release assessment. Evidence beats plans or green-looking summaries.

## Establish candidate

1. Record exact branch, commit, diff scope, target environment, and release intent.
2. Read AGENTS.md, docs/SECURITY.md, docs/OPERATIONS.md, docs/RUNBOOK.md, relevant ADRs, deployment files, and CI workflows.
3. Identify changes affecting database, RLS, auth, uploads, documents, numbering, money, infrastructure, backup, or restore. Require fresh high-risk review for those surfaces.

## Required evidence

- pnpm verify passed on exact candidate.
- Web changes passed relevant component, production-build, Playwright, accessibility, state, contrast, RTL, and taste checks.
- Real PostgreSQL integration tests passed, including tenant isolation and applicable concurrency cases.
- Compose and configuration parse checks passed.
- Production topology smoke passed with scanner and readiness gates active.
- Fresh-cluster backup and restore proof passed for schema or release candidates; a backup without successful restore is not accepted.
- Dependency audit, Semgrep, secret scan, and upload controls have current evidence.
- Health, metrics, logs, alerts, rollback, incident, migration, and operator documentation match deployed behavior.
- No production credentials, customer data, placeholder claims, or skipped required checks appear in workspace or evidence.
- Product-owner visual approval remains explicit for UX releases.

Use CI jobs in .github/workflows/ci.yml as canonical executable evidence. Do not improvise destructive restore tests against production. Use an isolated disposable database and object store.

## Result

Return one decision:

- **Ready**: all required evidence exists for exact candidate.
- **Conditionally ready**: only named external or manual gates remain; no code or safety blocker.
- **Blocked**: failed or missing required evidence, unresolved high-risk finding, documentation mismatch, or unsafe operational gap.

For every blocker, cite exact evidence, owner, and next action. Distinguish not run, failed, and passed.
