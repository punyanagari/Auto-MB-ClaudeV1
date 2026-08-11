# Auto-MB ClaudeV1

A clean-sheet implementation of Auto-MB: the post-award works-contract execution system for Indian government contractors, beginning with Indian Railways.

## Product wedge

The first sellable workflow is deliberately narrow:

```text
LOA PDF → reviewed Work → execution evidence → Measurement Book → billing and tax documents → audit trail
```

The repository is not an ERP framework, an AI-agent platform, or a rewrite of every historical Auto-MB plan. It preserves proven domain assets and rebuilds the application around a small, executable, shared multi-tenant SaaS.

## Status

**Pilot workflow implemented; paid-production gates remain**
(`docs/ROADMAP.md` is the authoritative ledger). The repository contains:

- the full LOA-to-DC workflow: LOA PDF upload → parser-assisted review →
  confirmed Work → Delivery Challan drafting → issue with gapless
  numbering → branded PDF → signed-copy evidence;
- the retention and contract-administration workflows: delivery receipts,
  serial traceability, installations, PBG/PAC/DOC instruments, extensions,
  amendments, approvals, completion/reopen, correction chains, and a
  Work-scoped audit timeline;
- record, on-account, and final Measurement Books with stage-wise payment
  matrices, PAC evidence, immutable finalisation, bill preparation, and
  generated MB documents;
- procurement and tax-document foundations: contacts, purchase orders,
  budgetary quotations, direct or MB-backed GST invoices, configurable
  numbering, immutable invoice snapshots, IRP/NIC payloads, and e-way-bill
  lifecycle records. External GSP submission is not yet automatic;
- optional NIT, Contract Agreement, and tender/specification uploads tied to
  an LOA only after deterministic tender-number and work-name matching;
- a dashboard, organisation settings/branding, member roles, per-member
  work assignments, and issue/cancel authorities;
- multi-tenant PostgreSQL with forced RLS, an idempotent production
  bootstrap, malware-scanned uploads, rate limiting, component-aware
  readiness, backups with a CI-proven fresh-cluster restore, and a
  Caddy-fronted production compose deployment with CD;
- the six-letter / 281-item LOA parser corpus adopted from the original
  project;
- concise product, architecture, security, operations, and roadmap
  contracts; agent instructions and CI.

Owner MFA enforcement, external monitoring, DAST, direct GSP integration,
and a follow-up security review remain before paid production
(`docs/ROADMAP.md`). No STQC certification is claimed.

## Local start

Requirements:

- Node.js 22.13+
- pnpm 11+
- Docker with Compose

```bash
cp .env.example .env
set -a; . ./.env; set +a   # export configuration; db:migrate and dev read it
corepack enable
pnpm install

docker compose up -d postgres gotenberg
pnpm db:migrate
pnpm dev
```

Or run `bash scripts/bootstrap.sh`, which performs the same steps.

Then open:

- Web: `http://localhost:5173`
- API health: `http://localhost:3000/api/health`
- API docs: `http://localhost:3000/documentation/`

## Cloud agents

`.cursor/environment.json` provisions Cursor cloud agents: `scripts/cloud-install.sh` installs dependencies during environment builds, and `scripts/cloud-start.sh` brings up Docker, PostgreSQL, Gotenberg, and migrations on every agent boot, with `pnpm dev` running in a managed terminal. This repo-managed configuration takes precedence over dashboard-saved environments.

`.claude/hooks/session-start.sh` does the same job for Claude Code on the web, where there is no Docker daemon and PostgreSQL 16 is installed natively but stopped. It installs the workspace, ensures `poppler-utils`, starts the cluster, creates the admin and application roles and the database, applies migrations and the privilege matrix, and exports `DATABASE_ADMIN_URL`, `DATABASE_URL` and `PLAYWRIGHT_CHROMIUM_PATH` into the session. Its result is baked into the cached container image, so the cost is paid once at image-build time rather than at the start of every session. It is idempotent and does nothing outside that environment.

## Verification

```bash
docker compose up -d postgres
pnpm verify
```

`pnpm verify` runs formatting, lint (including static security rules), typecheck, the web production build, tests, migration checks, architecture checks, configuration parse checks, and the secret scan. The database package's tenant-isolation tests run against a real PostgreSQL instance and apply the migrations themselves, so PostgreSQL must be reachable (CI provisions the same PostgreSQL 17 service). Database-backed features must keep extending these tenant-isolation and concurrency suites.

## Authoritative documents

| File                   | Authority                                              |
| ---------------------- | ------------------------------------------------------ |
| `docs/PRODUCT.md`      | Current product boundary and business invariants       |
| `docs/ARCHITECTURE.md` | Current implementation architecture                    |
| `docs/SECURITY.md`     | Threat model, required controls, and audit posture     |
| `docs/OPERATIONS.md`   | Deployment, backup, restore, monitoring, and incidents |
| `docs/ROADMAP.md`      | Delivery sequence and release gates                    |
| `adr/`                 | Expensive-to-reverse decisions only                    |
| `docs/reference/`      | Historical evidence; never authoritative by itself     |

## Development model

Claude Code is the primary coding agent (see ADR-0004 amendment). Product decisions remain human-owned; deterministic tests prove code properties; qualified external reviewers validate security, operations, and compliance before production.

Read `AGENTS.md` before making changes.
