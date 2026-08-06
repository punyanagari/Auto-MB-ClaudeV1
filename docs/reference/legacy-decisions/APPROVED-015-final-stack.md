# APPROVED-015: Final production stack (from-scratch re-evaluation)
Status: APPROVED — via dashboard 2026-07-27
Filed by: orchestrator on 2026-07-27
Deadline: before DC-1 · Default if silent: Option A
Authorizes: APPROVED-015
Scope: ARCHITECTURE.md docs/architecture-change-log.md
Amended: 2026-07-30 per APPROVED-053 (ticket SEC-13) — header only, decided substance untouched. `Authorizes:` retired the legacy self-token `PENDING-015` for the self-id `APPROVED-015`. Audit finding **L-6**, the class `APPROVED-048` closed for `APPROVED-013` and `APPROVED-052` for `APPROVED-033`/`APPROVED-046`: this decision was written on 2026-07-27, before the ticket system existed (`APPROVED-022`, 2026-07-28), when a decision's own `PENDING-0nn` id was the only name it had. Approval renames the file but nothing rewrote the header, so the id of a *pending* decision stayed a live authorization token — a string a CEO could plausibly set believing it names something still awaiting an answer. Measured 2026-07-30, this one is **inert**: neither `ARCHITECTURE.md` nor `docs/architecture-change-log.md` is in `is_protected_path`, so both read exit 0 under `PENDING-015`, under the self-id, under a bogus id **and** under an unset `CLAUDE_TICKET` alike — the signature of an unprotected path, not of a grant (`memory/inbox/2026-07-30-exit-0-is-not-a-grant-and-content-aware-freezes.md`). Retired anyway, per `APPROVED-053` Option A: inertness is a property of today's frozen set, not of this header. `APPROVED-049` turned `DASH-1`, `MEM-1` and `UX-5` into rule-8 violations hours after each shipped clean, because freezing a path arms every dormant token naming it, retroactively and silently — and "inert today" has now been the wrong call twice (H-1 on `SEC-12`, L-6 on seven of these ten). Never exercised: `git log --all` attributes no commit on these paths to `PENDING-015`. The self-id retains this decision's own implementing grant, exactly as `APPROVED-013` retained its own under [SEC-10].

## Context
CEO discarded the prior stack commitments in `SECURITY.md` and asked for a
from-scratch conclusion. Three independent evaluations ran with **no
incumbent advantage**: data layer, application layer, frontend and design.
Full reasoning in `ARCHITECTURE.md`; the before/after with costs is in
`docs/architecture-change-log.md`.

**CEO ruling, 2026-07-27 (in session): "I agree with your recommendations."**
Recorded as approval of Option A below.

## Option A — the stack
| Layer | Choice |
|---|---|
| Database | PostgreSQL ≥17.6/16.10/15.14/14.19/13.22, Aurora/RDS `ap-south-1` |
| Tenancy | RLS + `FORCE RLS` **and** a compile-time scoped repository |
| Data access | Drizzle |
| Migrations | Hand-written safe DDL, gated by Squawk in CI |
| Runtime | Node.js / TypeScript LTS |
| API | Fastify + boot-time route-permission assertion |
| Auth | Better Auth, self-hosted |
| Jobs | Postgres-native (pg-boss / Graphile Worker), same-transaction enqueue |
| Frontend | React 19 + Compiler, plain Vite SPA |
| Data grid | TanStack Table + virtualizer |
| Components | Base UI + Tailwind, shadcn/ui source (per CEO approval) |
| Storage | AWS S3 `ap-south-1`; presigned URLs ruled out |
| Deployment | AWS App Runner / ECS Fargate `ap-south-1`, multi-AZ |
| Offline | Thin — cached reads, draft composition, idempotent submit-and-wait |

Irreversible decisions locked: `tenant_id` leading every composite index;
UUIDv7 keys; `audit_log` partitioned monthly from migration 1; money
`numeric` and legal dates `date`; issued documents snapshot what they
printed.

## What this overturns
- **Prisma is rejected** — its client-extension RLS pattern does not compose
  with `$transaction([])` or nested interactive transactions.
- **India residency is not a DPDP legal mandate** — kept on commercial
  grounds, not law.
- **Presigned URLs are ruled out**, not deferred.
- **Railway and Render are excluded** — no India region exists on either.

## Open items deliberately not decided
1. Whether `dc_items`/`work_items` need partitioning — settle by load test
   at target scale **before DC-9 commits a scheme**. No case study exists
   either way at 400M rows.
2. Fly.io `bom` capacity — verify by load test before preferring it over
   AWS on operator-simplicity grounds.
3. React+Compiler vs Svelte/Solid INP on a low-end Android running a dense
   form and a virtualised grid simultaneously — no benchmark exists for this
   workload shape.
