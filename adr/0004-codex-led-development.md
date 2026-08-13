# ADR-0004: One primary coding agent, which is not the authority

- Status: Accepted (2026-08-06); amended 2026-08-07 (primary agent changed
  from Codex to Claude Code) and 2026-08-13 (the read-only reviewer roles
  named). The decision itself stands; only the agent filling the primary
  role and the review roles around it have changed.
- Date: 2026-08-06

The file name still says `codex-led` because ADR file names are stable
identifiers, not claims; the amendments below are the current state.

## Context

A custom Software Factory consumed significant repository surface before an executable application existed. Codex already provides repository editing, command execution, parallel worktrees, review, and reusable instructions.

## Decision

Use one AI development system as the sole required primary coding agent. Use concise `AGENTS.md`, bounded issues, deterministic CI, fresh review sessions, and human approval for product/high-risk changes. Add Codev or another orchestrator only after measured coordination failure.

## Consequences

No custom agent hierarchy, routing framework, or persistent chat-memory system is built. Agent output is always reviewed and verified; qualified external humans remain required for security, operations, and compliance assurance.

## Amendment — 2026-08-07

Claude Code replaces Codex as the primary coding agent. The substance of the decision is unchanged: one primary agent, concise `AGENTS.md`, deterministic CI, human ownership of product and high-risk decisions, and no custom agent hierarchy, routing, or memory system.

## Amendment — 2026-08-13

The workflow around the primary agent is recorded here because the
original text described only the agent, and the repository had since grown
roles the ADR did not name. `AGENTS.md` ("Agent orchestration") governs;
this is the decision behind it.

- **One writer.** The primary agent owns repository edits and integration.
  Parallel writers on overlapping application or migration code are not
  run.
- **Bounded read-only subagents.** At most two concurrent read-only
  subagents assist with exploration, verification, or review: a project
  explorer before medium or high-complexity changes, an integrity reviewer
  for RLS, authentication, authorization, uploads, money, quantities,
  numbering, concurrency, migrations and issued documents, and a test
  reviewer that compares acceptance criteria against the final diff. They
  are defined once and shared across hosts — `.codex/agents/*.toml` and
  `.agents/skills/**` carry the same three roles for Codex.
- **Still not the authority.** These roles review; they do not approve.
  `CONTRIBUTING.md`'s requirement of fresh human review for row-level
  security, authentication, permissions, uploads, money, numbering, issued
  documents, migrations, infrastructure and production configuration is
  unaffected by any number of agent reviewers, and a subagent's report is
  never the human approval that requirement means.
