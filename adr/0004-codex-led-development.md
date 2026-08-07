# ADR-0004: Codex is the primary coding agent, not the authority

- Status: Accepted, amended 2026-08-07 — Claude Code is now the primary coding agent (see Amendment below)
- Date: 2026-08-06

## Context

A custom Software Factory consumed significant repository surface before an executable application existed. Codex already provides repository editing, command execution, parallel worktrees, review, and reusable instructions.

## Decision

Use Codex as the sole required AI development system initially. Use concise `AGENTS.md`, bounded issues, deterministic CI, fresh review sessions, and human approval for product/high-risk changes. Add Codev or another orchestrator only after measured coordination failure.

## Consequences

No custom agent hierarchy, routing framework, or persistent chat-memory system is built. Codex output is always reviewed and verified; qualified external humans remain required for security, operations, and compliance assurance.

## Amendment — 2026-08-07

Claude Code replaces Codex as the primary coding agent. The substance of the decision is unchanged: one primary agent, concise `AGENTS.md`, deterministic CI, human ownership of product and high-risk decisions, and no custom agent hierarchy, routing, or memory system.
