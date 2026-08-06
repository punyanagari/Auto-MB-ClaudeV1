# ARCHITECTURE.md — Auto-MB production architecture

> How Auto-MB is built to run. `PRODUCT-SPEC.md` says what it must do
> (stack-agnostic); this file says how, and **what we deliberately are not
> doing and what would change that**.
>
> Status: FINAL for the stack; ratified per `decisions/APPROVED-015`. Every choice
> below was re-evaluated from scratch on CEO instruction (2026-07-27) with
> **no incumbent advantage** — where an incumbent survived, the challenger's
> specific losing argument is recorded. Two incumbents did not survive.

## 1. Scale we are designing for

**2,000–10,000 tenant organisations**, each with 100–500 ongoing works, ~45
line items per work. At a 3-year horizon (5,000 tenants, ~1,000 lifetime
works each): ~5M `works`, ~225M `work_items`, ~50M `delivery_challans`,
~400M `dc_items`, ~100M `serial_numbers`, ~25M `documents`, and `audit_log`
larger than all of them.

> **Horizon note (`decisions/APPROVED-026`, Option A).** These are the
> **multi-tenant horizon** figures the schema must carry — not a description
> of v1, which deploys **single-tenant, one agency per instance**
> (PRODUCT-SPEC §1). Both statements are true of different horizons:
> `tenant_id` on every tenant table (§4 item 1), RLS + `FORCE RLS` bound
> per transaction (§5) land in v1 with exactly one tenant per deployment,
> and a second legal entity (the JV case) is a separate instance today, a
> separate tenant only when multi-tenancy ships.

**The load conclusion:** a large *single-database* problem, not a
distributed-systems problem. Every query is naturally tenant-scoped.
Independent review of this derivation found nothing to challenge, and it
drives the engine choice below — CockroachDB and YugabyteDB buy nothing at
this scale and cost real properties we need.

The engineering risk is not throughput. It is **getting the irreversible
decisions right before 400M rows exist**.

## 2. The stack

| Layer | Choice | The challenger that lost, and on what |
|---|---|---|
| Database | **PostgreSQL** on AWS Aurora/RDS `ap-south-1` | **CockroachDB has no stable advisory locks** — our gap-free numbering depends on `pg_advisory_xact_lock`; that is load-bearing, not a nice-to-have. **MySQL/MariaDB have no native RLS at all.** Turso/SQLite has no arbitrary-precision decimal — money would live in integer paise. **Neon has no Mumbai region.** |
| Tenancy | **RLS + `FORCE RLS`, under a compile-time scoped repository** | App-layer scoping alone **fails open** — the 2025 Asana MCP leak exposed cross-organisation data for two weeks because scoping was convention, not a database guarantee. Schema-per-tenant dies at 10,000 migrations. |
| Data access | **Drizzle** | **Prisma rejected on a real incompatibility**: a client extension that sets RLS context per transaction does not compose with Prisma's `$transaction([])` batch API or nested interactive transactions. Kysely is the close runner-up, not a rout. |
| Runtime | **Node.js / TypeScript (LTS)** | Elixir + Oban is the *objectively better* transactional job architecture; it loses only because our code is written by agents and Elixir's public corpus is thinnest. **Bun rejected on production evidence** — memory leaks under sustained load, 72h+ instability. |
| API | **Fastify** + boot-time route assertion | Express and Hono offer no structural guarantee. NestJS's global-guard is the turnkey alternative and a legitimate call — it costs a heavier DI surface. |
| Auth | **Better Auth**, self-hosted | Clerk/WorkOS/Auth0 fail on **both** geography (no India residency) and architecture (token-based, not per-request DB reads). Lucia is deprecated. |
| Jobs | **Postgres-native** (pg-boss / Graphile Worker) | Enqueue in the same transaction as the business write — a clean outbox. Re-checked against every runtime candidate; unchanged. |
| Frontend | **React 19 + Compiler, plain Vite SPA** | Svelte/Solid are faster on paper and lose on grid ecosystem and agent-authorability. **Next.js/Remix rejected on shape** — we already have a separate REST API; an SSR tier would duplicate it. |
| Data grid | **TanStack Table + virtualizer** | **Glide Data Grid rejected**: canvas rendering does not print, and its own README states accessibility flaws are likely. AG Grid is $999/dev/yr. MUI X paywalls virtualization. |
| Components | **Base UI + Tailwind** (via shadcn/ui source) | CEO-approved. Radix is more battle-tested today; Base UI wins on maintenance trajectory — a bet to revisit if its velocity stalls. |
| Deployment | **AWS ECS Fargate, `ap-south-1`** | **App Runner removed 2026-07-28 (`decisions/APPROVED-032` item 0): AWS closed it to new customers 2026-04-30 (maintenance mode) and it has no published SLA** — nothing was deployed on it, so nothing migrates. **Railway and Render have no India region at all** — binary exclusion. Fly.io has Mumbai but a reported capacity constraint; verify by load test before choosing it. Serverless cannot host polling workers (900s ceiling). |

## 3. Shape

**A modular monolith.** One deployable API, one database, module boundaries
enforced by lint rather than network hops — because the engineering
organisation is an agent workforce with one human decision-maker, and
microservices would multiply the surface we can actually supervise.

    web (React SPA)  →  api (modular monolith)  →  postgres (primary + replica)
                              ├→ worker (same codebase, queue consumer)
                              ├→ redis (authz invalidation, rate limits)
                              └→ object storage (documents, private)

## 4. The decisions that are expensive to reverse

1. **`tenant_id` on every tenant table, leading every composite index.** RLS
   adds that predicate whether the query does or not; an index that does not
   lead with it will not be used.
2. **UUIDv7 primary keys.** v4 randomises B-tree inserts and bloats indexes
   at 100M+ rows; bigserial is enumerable, which invites IDOR.
3. **Partition `audit_log` by month from the first migration.** Postgres
   offers no row-count threshold — its own rule is table size exceeding RAM,
   or painful vacuum windows, with partitions kept in the 10–100 GB range.
   `dc_items`/`work_items` stay **unpartitioned**: their access is per-work,
   not per-time-range, so neither pruning nor retention-drop applies. Settle
   this with a load test before DC-3, not by guessing.
4. **Money is `numeric`; legal dates are `date`, never `timestamptz`.**
   Round each line to 2dp then sum — never round a sum.
5. **Issued documents snapshot what they printed.** Never reconstruct a
   historical document by joining live masters.

## 5. Tenancy, in detail

Two layers, chosen because they fail in opposite directions:

- **RLS with `FORCE ROW LEVEL SECURITY`** is the runtime backstop. It fails
  toward **zero rows** on a missing or NULL tenant context. Without FORCE,
  the table owner bypasses RLS entirely and isolation silently does not
  exist.
- **A compile-time-enforced scoped repository** sits above it, so
  agent-authored feature code cannot obtain an unscoped query handle at all.

Binding rules, all load-bearing:
- `SET LOCAL` inside an explicit transaction only. Session-level `SET` is
  listed by PgBouncer as **never** compatible with transaction pooling.
- `pg_advisory_xact_lock` only — session-scoped advisory locks can lock on
  one backend and unlock on another.
- **`SET ROLE`-based tenant switching is forbidden** (CVE-2024-10976 class).
- Wrap the tenant-context read in `(select …)` so the planner evaluates it
  once per statement, not once per row.
- **Minimum Postgres ≥17.6 / 16.10 / 15.14 / 14.19 / 13.22** — CVE-2025-8713
  leaked sampled data past RLS *specifically in partitioning hierarchies*,
  and we combine RLS with partitioning.
- PgBouncer never certifies `SET LOCAL`; its safety follows from Postgres
  semantics. So DC-7's coverage test **must include a live cross-tenant
  probe through a real pooled connection**, not only a unit test.

**The honest risk:** this concentrates all isolation trust in one small
piece of kernel middleware. App-layer scoping fails *more often*; RLS, when
it fails, fails *totally* — every tenant table at once, silently. AGENTS.md
already classes kernel changes as full-re-audit. That weighting is correct
and must stay real rather than aspirational.

## 6. Deployment and data

Single region, **India (Mumbai)**, multi-AZ.

*Correction on evidence:* an earlier draft called this a DPDP requirement.
**It is not.** DPDP §16 is a blacklist model — transfers are permitted
except to countries the government notifies as restricted, and none have
been. Targeted localisation binds only *Significant* Data Fiduciaries, which
we are not. Single-region India is right for honest reasons — the entire
customer base is here, it is what Railways and GST counterparties expect,
and it hedges a future SDF designation — but it is not a legal mandate.

Object storage: **AWS S3 `ap-south-1`** or DigitalOcean Spaces `BLR1`.
Cloudflare R2 has no India jurisdiction guarantee, only a best-effort hint;
Backblaze has no India region. **Presigned URLs are ruled out, not
deferred** — they bypass our request path by construction and cannot satisfy
"log every document access". Stream through the app.

Migrations: hand-written safe DDL (instant `ADD COLUMN`, `CREATE INDEX
CONCURRENTLY` outside any transaction, `NOT VALID` + `VALIDATE`), gated in
CI by **Squawk** so an agent cannot merge a migration taking an
`ACCESS EXCLUSIVE` lock on a hot table. pgroll is interesting but its
published case studies are 40M rows against our 400M — validate before
trusting.

## 7. DPDP obligations that shape the schema

Personal data includes the **contact-person name, phone, email and
designation on the Contacts master**, even though Auto-MB is B2B.

1. **Tag personal-data fields at schema time** (DC-3) so export and erasure
   can target exactly those columns.
2. **Erasure is field-level, never row-delete.** GST and Companies Act
   retention independently oblige keeping invoices and challans for years,
   and DPDP's "unless required by law" carve-out defers to that.
3. **The erasure-request audit trail is itself non-erasable**, designed so
   from the first migration.

Breach duty: intimate the Board "without delay", detailed report **within 72
hours of awareness**. Verify against primary Gazette text before writing a
compliance runbook — our source is commentary.

## 8. Offline strategy

**Thin, not full sync.** Service worker caches reads and lets site staff
compose drafts offline; submission is idempotent submit-and-wait, surfaced
as "will sync when back online" — never pretend-succeeded.

**Optimistic writes are forbidden for anything that assigns a number,
issues a document, or crosses an approval boundary.** R2 gap-free numbering,
R5/R6 caps and R19 MB coherence are exactly the guarantees naive
offline-sync breaks. Prove the reconnect race with a live test, the same way
tenancy demands a live pooled probe.

## 9. What we are deliberately not building

| Not building | Would reconsider when |
|---|---|
| Sharding / multi-primary | one primary demonstrably saturates on write after partitioning and index work; shard key would be `tenant_id` |
| Microservices | never at this team size |
| Elasticsearch / vector search | Postgres FTS and trigram indexes measurably fail a real user search |
| Event sourcing | the audit log already gives the legally required record |
| Multi-region | a second jurisdiction requires it |
| Kubernetes | a managed container platform stops being enough |
| GraphQL | REST plus the route registry stops meeting client needs |
| SSR meta-framework | we need public SEO pages, or first-load on bad networks proves unfixable by code-splitting |

## 10. Cloud portability — AWS now, Azure possible later

CEO approved AWS to start and asked whether moving to Azure later is
feasible. **Yes — but portability is a property we pay a small price for
now, not a free outcome.** Azure has Central India (Pune), South India
(Chennai) and West India (Mumbai), so the residency posture survives a move.

**Portable with no work** — these are the same product on both clouds:
- PostgreSQL → Azure Database for PostgreSQL Flexible Server. RLS,
  `FORCE RLS`, declarative partitioning, `pg_advisory_xact_lock`,
  `SET LOCAL` all behave identically. This is the largest single risk and
  it is genuinely portable, because we chose plain Postgres.
- Redis → Azure Cache for Redis.
- The API and worker → any container host. Azure Container Apps is the
  ECS-Fargate-class equivalent.
- The React SPA → any static host or CDN.

**Needs an adapter — cheap if the seam exists, expensive if retrofitted:**
- **Object storage.** S3 and Azure Blob are different APIs, not merely
  different endpoints. DC-36 is already scoped as a *storage adapter*, so
  the seam is planned rather than bolted on. Keep it that way.
- **KMS / secrets.** AWS KMS → Azure Key Vault. Relevant at the GST phase
  (per-tenant GSP credentials, envelope-encrypted) — the kernel crypto
  envelope must expose an interface, not an AWS SDK call.

**Three disciplines that keep the door open. Adopt them now; they cost
roughly a day and turn a multi-month migration into a couple of weeks:**
1. **Containerise.** Deploy a container image, never a platform buildpack.
   Any container host then works, and it costs nothing today.
2. **Plain Postgres only.** No Aurora-specific features — no fast clones,
   no Global Database, no Babelfish. If we ever want one, it becomes a
   decision with a stated lock-in cost, not an accident.
3. **Cloud SDKs live behind kernel interfaces**, never called from feature
   code. Exactly two adapters today: storage and secrets. That is the
   correct amount of abstraction.

**What we deliberately do NOT build: a general cloud-abstraction layer.**
Paying permanent complexity to hedge a switch that may never happen is the
classic version of this mistake. Two thin interfaces at real boundaries is
the whole hedge.

**Costs that no design removes**, so nobody is surprised later:
- **Egress.** Moving ~25M documents out of S3 is billed per GB. This grows
  with the document corpus and is the single largest migration tax.
- **Database cutover.** Logical replication makes it near-zero-downtime,
  but it is a planned operation, not a config change.
- **Infrastructure-as-code is rewritten**, not ported.

Verdict: a switch is a **weeks-scale project, not a rewrite** — provided the
three disciplines hold. If they lapse, it becomes a rewrite, which is why
they are recorded here rather than assumed.

## 11. Growth ceiling, stated honestly

This carries 10,000 tenants on one primary provided §4 is respected. First
things to break, in expected order: `audit_log` size and retention;
aggregate queries over `dc_items`; PDF generation at month-end peaks
(embarrassingly parallel); then write throughput. None requires a rewrite —
that is the property we are buying.
