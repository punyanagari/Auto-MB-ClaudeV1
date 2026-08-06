# Contributing

This is initially a private product repository.

## Before coding

1. Read `AGENTS.md`.
2. Link work to a bounded GitHub issue.
3. State the user outcome, acceptance criteria, and non-goals.
4. For high-risk changes, obtain plan approval before implementation.

## Branch and commit

- branch: `codex/<issue>-<description>`
- commits: small, intentional, and reviewable
- no direct commits to protected `main`

## Pull requests

A pull request must include:

- what user outcome changed;
- why the chosen implementation is the smallest correct option;
- schema/security/operations effects;
- exact verification commands and results;
- screenshots for visible UI changes;
- migration and rollback/mitigation notes when relevant.

## Required review

Fresh review is mandatory for RLS, auth, permissions, uploads, money, numbering, issued documents, migrations, infrastructure, and production configuration.
