# Working agreement for Claude Code

Read `AGENTS.md` for the engineering rules and `CONTRIBUTING.md` for the
review policy. This file records how work is delivered.

## Delivery

Finish every task by opening a pull request from the working branch and
merging it into `main`. Completed work is not left sitting on a branch,
and nothing is pushed directly to `main`.

Fill in `.github/pull_request_template.md`, including the exact
verification commands that were run and their results.

`CONTRIBUTING.md` still requires fresh human review for changes touching
row-level security, authentication, permissions, uploads, money,
numbering, issued documents, migrations, infrastructure, and production
configuration. When a pull request touches any of those, say so
explicitly in the pull request and in the summary handed back, so the
review requirement is visible rather than assumed to have been waived.
