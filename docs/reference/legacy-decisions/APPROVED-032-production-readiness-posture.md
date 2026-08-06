# APPROVED-032: Production-readiness posture — seven gaps researched, ruled, and placed in the roadmap
Status: APPROVED — via dashboard 2026-07-28
Decision: Option A
Authorizes: OPS-1 OPS-2 OPS-3 OPS-4 OPS-5 OPS-6 OPS-7
Scope: ROADMAP.md SECURITY.md ARCHITECTURE.md docs/migration-discipline.md docs/api-posture.md docs/job-semantics.md docs/slo.md scripts/migration-lint.sh scripts/openapi-drift-check.mjs .github/dependabot.yml tickets/OPS-1.md tickets/OPS-2.md tickets/OPS-3.md tickets/OPS-4.md tickets/OPS-5.md tickets/OPS-6.md tickets/OPS-7.md memory/inbox/**
Filed by: orchestrator (CEO-directed; seven researcher briefs, 2026-07-28) on 2026-07-28
Deadline: 2026-07-30  ·  Default if silent: A (every per-item recommendation below)
Blocks: OPS-1..OPS-7; the ROADMAP/SECURITY insertions this decision rules

## Context (≤10 lines)
Seven production-readiness gaps verified absent from ROADMAP.md, SECURITY.md
and all tickets (2026-07-28 audit follow-up, main @ 7c13e14). Seven
researcher briefs (per ROUTING.md, one per area, external material treated
as data) fed this single decision. Every recommendation targets the ratified
stack (APPROVED-015/ARCHITECTURE.md) under the standing constraints: no
third-party SaaS receives tenant/contract data (APPROVED-016's
Chromatic/Percy bar), no unaudited community installs (APPROVED-006), and
**nothing here wires a gate into `package.json`, `pnpm-workspace.yaml` or
`.github/workflows/**` — all frozen; every such wiring is OWED to a separate
scoped decision and is named in "Owed wiring" below.**

## Item 0 — Stack correction the research surfaced (rules first, everything downstream assumes it)
**AWS App Runner entered maintenance mode 2026-03-31 and closed to new
customers 2026-04-30** — two researchers independently corroborated
(primary AWS page 403s through this environment's proxy; InfoQ 2026-04 +
AWS Support statement + AWS re:Post threads agree; confidence medium-high —
CEO should eyeball the primary page once from a browser). Auto-MB has not
deployed, so it would be a new customer: **App Runner is unavailable, not a
trade-off**. ARCHITECTURE.md §2's deployment row and §10 read "App Runner /
ECS Fargate"; App Runner also has no published SLA, so no availability
number can honestly be composed on it.
**Ruling sought:** deployment target is **ECS Fargate** (`ap-south-1`,
multi-AZ, Amazon Compute SLA 99.99%); ARCHITECTURE.md §2/§10 amended
accordingly in the same diff as the roadmap insertions. Reversibility: high
(container image per §10 discipline 1 runs anywhere).

## Item 1 — Observability & crash reporting
Options: (i) CloudWatch-native now — EMF metrics from the app (no sidecar),
CloudWatch Alarms (~6 alarms, <$1/mo), `@fastify/under-pressure` `/live` +
cached-dependency `/ready`, pino structured logs (already mandated,
SECURITY.md §11) plus a synthetic error-fingerprint field; no error tracker
yet. (ii) plus self-hosted GlitchTip (~1GB/1vCPU, Sentry-SDK-compatible)
now. (iii) self-hosted Sentry (20+ containers) or Prometheus+Alertmanager
stack (~$200/mo + real FTE share) now. (iv) any SaaS tracker.
**Sovereignty line drawn:** AWS-as-provider (CloudWatch) already processes
our data by ARCHITECTURE's own design — inside the bar. A SaaS tracker is a
NEW third party receiving stack traces with request context — same class as
the Chromatic/Percy rejection. **(iv) rejected outright; (iii) rejected on
ops weight for a one-human org.**
**Recommendation: (i) now; (ii) GlitchTip added at launch track** (source-
map/release value only exists once real users hit the SPA). Roadmap: health
endpoints + fingerprint field are Phase-A API work (OPS-6 + log-middleware
acceptance); alert set + GlitchTip = launch-track lines.

## Item 2 — Release engineering
Recommendation (adjusted for Item 0): **ECS Fargate rolling deploys with the
deployment circuit breaker now; re-evaluate CodeDeploy blue/green (true
instant rollback) at launch track.** Artifact: multi-stage Dockerfile via
`pnpm deploy` per package (api + worker from one builder), distroless
`nodejs22-debian12` runtime (SECURITY.md §12 row), ECR `ap-south-1` with
**tag immutability**, tags = git SHA, **deploy by digest**. Staging:
separate database on the shared RDS instance until real tenants (then
dedicated). Releases are gate:CEO (LOOPS.md §4): GitHub Environment
`production` with required reviewer = CEO — build+push unattended, deploy
job pauses for approval. Rollback = redeploy prior digest; **expand/contract
is release law** (a rolled-back image must run against the expanded schema —
Item 3's doc carries the rule). SPA: S3+CloudFront, hashed assets synced
first, `index.html` swapped last (atomic from the client's view).
Reversibility: high. Roadmap: **launch track** (manager derives tickets at
Phase D exit); dogfooding runs off dev compose until then per CLOUD.md.

## Item 3 — Zero-downtime migration discipline
Needed **before DC-2/DC-3 dispatch** (audit_log partitioning is the FIRST
migration; live dogfooding rows accumulate from the DC-38 family — inside
Phase A, earlier than the task's Phase-B floor).
**Recommendation:** land `docs/migration-discipline.md` (OPS-1) ruling:
`drizzle-kit push` banned outside local throwaway DBs; generated SQL is
hand-audited (DC-2 already says so); expand/contract N/N+1 rule with an
explicit rollback window; every migration session opens
`SET lock_timeout/statement_timeout`; the safe-rewrite catalogue (SET NOT
NULL via CHECK NOT VALID→VALIDATE→SET NOT NULL scan-skip on PG≥12; PK via
CREATE UNIQUE INDEX CONCURRENTLY + USING INDEX; instant vs rewriting type/
DEFAULT changes); partition automation via an **app-level scheduled job**,
not pg_partman/pg_cron (plain-Postgres discipline, ARCHITECTURE §10);
parent-index pattern `CREATE INDEX ON ONLY` → per-partition CONCURRENTLY →
ATTACH; DETACH CONCURRENTLY needs PG≥14 — verify the actual deployed major
before relying on it; RLS policy/FORCE-RLS changes take ACCESS EXCLUSIVE and
go through the same lock_timeout wrapper; `SET ROLE` tenancy stays banned
(CVE-2024-10976). Plus `scripts/migration-lint.sh` (OPS-1): structure-only,
DB-free checks (timeout preamble present, no CONCURRENTLY inside a
transaction, no bare NOT NULL column adds, no `drizzle-kit push` anywhere),
with a built-in fault-injection self-test — **not wired into gates here**
(owed wiring, below). Squawk remains the AST-level gate and is **absent from
SECURITY.md §2.2's owed-gate table** — added there as owed, wiring in the
same owed decision.

## Item 4 — API versioning + OpenAPI
**Recommendation:** URL prefix **`/v1`** at the boot-time route assertion
now (costs nothing, forecloses nothing); additive-only evolution within v1;
header/media-type negotiation rejected as premature. **TypeBox** type
provider (native JSON Schema — shortest path to both validation and
OpenAPI; Zod-v4 adapter newer, needs a transform hop). Committed
`openapi.json` generated from the booted instance + `scripts/openapi-drift-
check.mjs` (regenerate-and-diff; ungated — owed wiring). `openapi-
typescript` as a web build step (one committed artifact, not two). Error
contract: a strict **field-subset of RFC 9457** (`status`,`title`,`detail`,
`instance`=request-id) satisfying SECURITY.md §9's uniform-error row;
upgrading to full `application/problem+json` is additive when an external
consumer exists. Roadmap: posture doc = OPS-2 (now); artifact + drift script
+ error filter = OPS-7 (depends on the API skeleton); deprecation/Sunset
mechanics deferred until a public API is actually scoped (no phase owns one
today — noted, not invented).

## Item 5 — Queue/job reliability
**Recommendation: pg-boss** (official Drizzle same-transaction adapter,
native `deadLetter` queues, priorities, larger corpus — the same
agent-authorability argument ARCHITECTURE used for Node; Graphile Worker is
sound but thinner and single-maintainer). **Semantics ratified as law**
(OPS-3 doc, binding on every async ticket from Phase B/C on): at-least-once
delivery + **idempotent consumers** — "exactly-once" explicitly rejected as
a design premise; the outbox is ONE transaction (business write + audit
write + job enqueue — all three or none; SECURITY.md §11 same-tx invariant
extended, never weakened); ordering never comes from the queue — handlers
take `pg_advisory_xact_lock` per scope where it matters; kernel idempotency
extends to handlers APPROVED-017-style (store the first result, replays
return it). Defaults: internal jobs retryLimit 5-8 + exponential backoff +
DLQ; external-API jobs (Phase G IRN): INV-01 arithmetic failures are
data-fixes, never retried; retries on network/5xx only; duplicate-active-IRN
is a hard stop; the 24h cancel window never silently retried past — human
escalation. GSP idempotency contract must be verified against sandbox docs
before Phase G ships (roadmap note). Worker = same image; graceful drain on
SIGTERM; abandoned jobs redeliver — which the idempotency law already
absorbs.

## Item 6 — Backend SLOs (defaults, revisable with data)
**Recommendation (OPS-4 doc):** server-side targets — interactive reads
p95≤400ms/p99≤800ms (Doherty 400ms; Nielsen 1s ceiling); **DC issue path
p95≤600ms/p99≤2.5s** — it is a lock-wait queue by design
(pg_advisory_xact_lock per scope), so p99-under-contention is the published
number and what the load test proves; reports p95≤3s synchronous; Excel
export p95≤8s with a **hard async-job cutover past 10s** (needs a
PRODUCT-SPEC async/progress posture ratified before Phase E builds — roadmap
note); LOA parse runs as a job, p95≤15s, failure-rate tracked not p99.
Availability: substrate composes to ~99.94–99.98% (Fargate 99.99% × RDS
multi-AZ 99.95%) — **publish 99.9%** (43min/mo budget), single-region
stated. Measurement: Logs Insights `pct()` over the SECURITY.md §11 request
logs + one `endpointClass` field (read/issue/report/export/parse) — no new
pipeline. Load tests: **k6 OSS self-hosted only** (SaaS load tools receive
request payloads — same sovereignty bar); the two that matter: issue-path
concurrency (R2 gap-free + p99) and pooled-connection RLS probe under load —
correctness halves already owed by DC-30/DC-7 suites; k6 posture = launch
track. Error-budget-lite: alarm → ticket with a verify line; budget
exhaustion is CEO-visible. No pagers.

## Item 7 — Four smaller rulings
**7a Feature flags: defer-with-trigger.** Env/static config until Phase B's
approvals engine needs a runtime switch; then a DB-backed flags table
through the kernel config surface (its own kernel-class decision at that
point). flagd/OpenFeature rejected (new standing infra). Roadmap: trigger
noted under Phase B.
**7b Per-tenant quotas: no split.** Phase A's flat security caps are already
ticketed (DC-35 size caps, DC-37 Redis rate limits — SECURITY.md §7 rows);
plan-varying quotas stay inside the launch track's "entitlement gates +
pricing plans," whose wording is clarified to enumerate works-count caps,
per-tenant API rate, storage-by-plan.
**7c Supply chain (postures; wiring owed):** SBOM via **pnpm-native `pnpm
sbom`** (CycloneDX/SPDX) for the dependency tree, syft/Trivy for container
layers once images exist; artifact signing **cosign keyless + GitHub OIDC**
with verification as a deploy-pipeline step (neither Fargate nor ECR
enforces at pull; compare AWS Signer when the pipeline is built);
dependency cadence **Dependabot** (GitHub-native — no new vendor grant;
Renovate would be one, APPROVED-006) with grouped weekly, lockfile-only PRs
audited per APPROVED-006 — config lives at `.github/dependabot.yml`, which
is NOT frozen (only `.github/workflows/**` is) → OPS-5 now; pnpm
`minimumReleaseAge` cooldown endorsed but its home (`pnpm-workspace.yaml`)
is frozen → owed wiring.
**7d PR review on main:** a GitHub ruleset switch, owner CEO — already
recommended by APPROVED-029 (audit branch). Recorded as a dated CEO ruling
in ROADMAP so SECURITY.md stops re-measuring it (four entries and counting).

## Owed wiring — explicitly NOT done under this decision
Frozen-path gate wiring, each needing its own scoped decision when its
prerequisites exist: (1) Squawk + `migration-lint.sh` into the gates chain;
(2) `openapi-drift-check.mjs` into the gates chain; (3) `pnpm sbom` +
cosign verify into the build/deploy pipeline (`.github/workflows/**`);
(4) `minimumReleaseAge` into `pnpm-workspace.yaml`. `package.json`,
`pnpm-workspace.yaml` and `.github/workflows/**` stay untouched here.

## Options
A. **Adopt every per-item recommendation above** (incl. Item 0's Fargate
   ruling) and execute the Phase-3 insertions: ROADMAP lines + dated
   rulings, SECURITY.md rows (all TBD, named future proving tests),
   ARCHITECTURE.md §2/§10 amendment, tickets OPS-1..OPS-7, scribe note.
B. **Adopt selectively** — CEO strikes items by number; unstruck items
   proceed as recommended.
C. Status quo. Rejected on its face: the gaps are real, verified absent,
   and three of them (migration discipline, job semantics, /v1) get more
   expensive every week the DC DAG advances.

## Recommendation
**A.** Sequenced so nothing blocks the DC milestone: OPS-1..OPS-5 are
dispatchable immediately (docs, lint self-test, dependabot config); OPS-6/7
depend on the API skeleton; everything heavier lands as launch-track lines
the manager derives when phases exit — exactly ROADMAP's altitude rule.
