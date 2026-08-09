# Auto-MB operations contract

The concrete pilot procedures implementing this contract live in
docs/RUNBOOK.md.

## 1. Environments

- `local`: Docker PostgreSQL and Gotenberg; synthetic or approved fixtures.
- `staging`: production-like networking, database roles, object storage, monitoring, and deployment.
- `production`: India-region deployment where customer/government requirements demand it; private database and storage; controlled egress.

No production secret, database dump, or customer document belongs in local development or an AI-agent workspace.

## 2. Service topology

- static web assets;
- API service;
- worker service;
- PostgreSQL;
- private object storage;
- private Gotenberg;
- edge/WAF and TLS termination;
- central logs, metrics, traces, and alerting.

The API's login/upload rate limits and the account-scoped login lockout
keep their counters in process memory: they protect a SINGLE API
instance only. Running more than one API instance divides (and for the
lockout, weakens) these thresholds — before scaling out, move that state
into PostgreSQL or a shared store (docs/SECURITY.md).

## 3. Deployment rules

1. Build immutable artifacts from a reviewed commit.
2. Run unit, integration, tenant-isolation, migration, and smoke tests.
3. Apply backward-compatible migrations before or during controlled rollout.
4. Deploy staging and run smoke/DAST checks.
5. Production deployment requires human approval.
6. Failed health checks trigger rollback.
7. Never depend on an agent session as the sole deployment record.

## 4. Database changes

- forward-only SQL migrations;
- one migration id per file;
- migration content is hashed and recorded;
- lock and statement timeouts are explicit;
- destructive changes use expand/migrate/contract sequencing;
- every migration has a tested rollback/mitigation plan even when SQL rollback is not automatic.

## 5. Backup and recovery

Before a paid pilot:

- automated encrypted backups;
- point-in-time recovery;
- documented RPO and RTO;
- quarterly restore test at minimum during pilot, more often while the system changes rapidly;
- object-storage versioning/retention appropriate to legal records;
- restore evidence retained.

A backup is not accepted until a restore has succeeded.

## 6. Observability

Minimum signals:

- API request rate, errors, and latency;
- database saturation and slow queries;
- job queue depth, retries, and dead letters;
- LOA extraction failures and review rate;
- PDF generation failures;
- authentication failures and suspicious access;
- object-storage errors;
- tenant-boundary denial events;
- backup recency: age of the last fully verified backup, exposed as a
  metric and alerted on before it exceeds one missed backup cycle;
- deployment and migration status.

Logs include request id, route, status, duration, actor id when available, and organisation id when safe. Logs exclude bodies, passwords, tokens, LOA text, and document contents.

## 7. Incident response

Initial severities:

- SEV-1: confirmed/suspected cross-tenant exposure, credential compromise, material document corruption, or widespread outage.
- SEV-2: one-customer critical workflow unavailable, failed issue/numbering integrity, restore risk.
- SEV-3: degraded non-critical function or isolated retryable job failure.

For every material incident: contain, preserve evidence, communicate, remediate, verify, and record prevention work.

## 8. Support and data operations

- support impersonation is explicit, temporary, and audited;
- customer exports are scoped and reproducible;
- deletion/erasure requests preserve legally required immutable records while removing eligible personal data;
- no manual database edit without a ticket, peer review, backup, and audit record.

## 9. v1 cutover runbook (legacy-data import)

The v1 legacy product's SQLite backup is imported once per organisation
with `scripts/import-v1.ts` (engine: `apps/server/src/import/`). The
importer is an administrator-role operational tool: it runs with
`DATABASE_ADMIN_URL`, keeps every schema guard and trigger active
(`session_replication_role` tricks are forbidden), records provenance in
`import_batches` / `import_records` (migration 0025), and is idempotent —
re-running the same input is a no-op; a changed source row is reported as
drift and never silently repaired.

Order of operations:

1. **Dry run.** Against the production database (or a restored copy):
   `pnpm exec tsx scripts/import-v1.ts --backup <v1.sqlite> --mapping
scripts/import-v1.mapping.json --mode dry-run`. The whole pipeline runs
   in one transaction and rolls back; only the reconciliation report
   remains.
2. **Review the report** with the customer: per-organisation source vs
   imported counts, contract-value and challan-line totals, per-Work
   challan-number continuity (gaps are reported, never filled; counters
   land so the next issued number continues the historical series),
   serial counts, quantization statistics, and EVERY exception with its
   source id and violated rule. Exceptions are expected in real data
   (non-numeric challan suffixes, variation-only zero-quantity items,
   duplicate serials); agree what, if anything, is fixed in v1 first.
3. **Freeze v1.** Stop all v1 data entry; announce the cutover window.
4. **Fresh backup.** Take a new v1 backup AFTER the freeze and re-run the
   dry run on it; the report must match expectations.
5. **Apply.** Same command with `--mode apply` (one transaction per
   organisation). Store the printed report with the change ticket; it is
   also persisted in `import_batches.reconciliation`.
6. **Verify reconciliation.** Re-run `--mode dry-run` on the same input:
   every entity must now show `unchanged`, zero `imported`, zero drift.
   Spot-check a handful of challans against printed v1 documents.
7. **Invite users.** Imported organisations are created idle (no
   memberships): create owner invitations through the product; assign
   roles and authorities explicitly.
8. **Launch.** Enable access, monitor the first issued challan per Work —
   its number must be `highest imported sequence + 1` in the historical
   series.

The v1 backup contains customer production data: it never enters the
repository, agent workspaces, or fixtures. The importer's tests build
synthetic SQLite fixtures; the optional real-backup smoke test runs only
where an operator has placed a backup locally.
