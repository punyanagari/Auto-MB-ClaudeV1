# Auto-MB Codex

A clean-sheet implementation of Auto-MB: the post-award works-contract execution system for Indian government contractors, beginning with Indian Railways.

## Product wedge

The first sellable workflow is deliberately narrow:

```text
LOA PDF → reviewed Work → Delivery Challan → issued PDF → quantity ledger → audit trail
```

The repository is not an ERP framework, an AI-agent platform, or a rewrite of every historical Auto-MB plan. It preserves proven domain assets and rebuilds the application around a small, executable, shared multi-tenant SaaS.

## Status

**Foundation commit.** This repository contains:

- a React web shell;
- a Fastify API with OpenAPI and health endpoints;
- a worker process boundary;
- PostgreSQL migrations for organisations, memberships, works, LOA intake, Delivery Challans, RLS, and audit events;
- the six-letter / 281-item LOA parser corpus adopted from the original project;
- concise product, architecture, security, operations, and roadmap contracts;
- Codex instructions and CI.

It does **not** yet claim a complete LOA-to-DC workflow or STQC certification.

## Local start

Requirements:

- Node.js 22.12+
- pnpm 11+
- Docker with Compose

```bash
cp .env.example .env
corepack enable
pnpm install

docker compose up -d postgres gotenberg
pnpm db:migrate
pnpm dev
```

Then open:

- Web: `http://localhost:5173`
- API health: `http://localhost:3000/api/health`
- API docs: `http://localhost:3000/documentation/`

## Verification

```bash
pnpm verify
```

The first database-backed feature must additionally pass tenant-isolation and concurrency tests against a real PostgreSQL instance.

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

Codex is the primary coding agent. Product decisions remain human-owned; deterministic tests prove code properties; qualified external reviewers validate security, operations, and compliance before production.

Read `AGENTS.md` before making changes.
