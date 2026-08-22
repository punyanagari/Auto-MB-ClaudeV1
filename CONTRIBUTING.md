# Contributing

This is initially a private product repository.

## Before coding

1. Read `AGENTS.md`.
2. Link work to its row in the current programme document, or to a bounded
   GitHub issue.
3. State the user outcome, acceptance criteria, and non-goals.
4. For high-risk changes, obtain plan approval before implementation.

## Branch and commit

- branch: `pack/<id>-<slug>` for a programme pack (`pack/p18-worker-wiring`),
  `chore/<slug>` for landing records and maintenance
  (`chore/wave3-tranche-b-record`)
- commits: small, intentional, and reviewable
- no direct commits to protected `main`
- run `pnpm preflight` before the first push

`pnpm preflight` runs the gates the changed files can break — formatting and
the source-scan censuses always, the database-shape censuses when the change
touches `packages/db` or a `.sql` file — in under a minute and with no
build. It is what stops CI from teaching those gates one round at a time.
AGENTS.md § "Change workflow" describes the set; `pnpm verify` is still the
gate before handoff.

Branches in flight together must not claim a shared hand-allocated value
(the export format version, `docs/UX.md` section numbers). Hold the
placeholder AGENTS.md § "Shared values across concurrent branches"
describes; the coordinator assigns the concrete value at merge.

## Pull requests

A pull request must include:

- what user outcome changed;
- why the chosen implementation is the smallest correct option;
- schema/security/operations effects;
- exact verification commands and results;
- evidence for visible UI changes, per the section below;
- migration and rollback/mitigation notes when relevant.

### Evidence for a visible UI change

Paste the images into the pull request thread. They are review artefacts, not
product assets, and they are not committed to the repository —
`docs/screenshots/p14-railway-bill/` is the one historical exception, and its
own README records that the directory may be deleted at any time.

Where capture is genuinely infeasible from the environment the change was made
in, the fallback is text assertions of the changed states that run in CI on
every commit, together with an explicit statement in the pull request that no
images were produced and why. Silence is not the fallback: a reviewer must be
able to tell a substitution from an omission.

## Required review

Fresh review is mandatory for RLS, auth, permissions, uploads, money, numbering, issued documents, migrations, infrastructure, and production configuration.
