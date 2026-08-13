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

## Knowledge graph

`graphify-out/graph.json` holds a knowledge graph of this repository —
every code symbol from AST extraction plus the concepts, rules and
findings extracted from the documentation, clustered into communities
and linked across the two layers.

It is **git-ignored and built locally**, so it may be absent or stale in
any given clone. Everything below is conditional on the file existing.
Never assume it does, and never treat it as authoritative over the code:
it records what was true when it was built.

When it is present, prefer it for orientation questions — "how does X
work", "what else touches Y", "where is Z decided" — because it returns
a scoped subgraph instead of a directory sweep:

```
graphify query "how is tenant isolation enforced"
graphify path "createTenantRouteRegistrar" "current_organisation_id"
graphify explain "guard_tax_invoice_issued_update"
graphify affected "assertWorkAccess"
```

Then read the actual files it points at. The graph tells you where to
look; it does not tell you what the code currently says.

`graphify-out/GRAPH_REPORT.md` is for broad architecture review only —
god nodes, community structure, hyperedges, and an honest list of
knowledge gaps. Reach for it when query/path/explain do not surface
enough, not as a first step.

Two things it is known to be weak at, so do not read absence as
evidence: symbol-level imports across workspace packages are
under-linked where a barrel file re-exports them (the file-level edge
survives, the symbol-level one does not), and the smaller communities
carry names derived from their directory rather than their meaning.

A `post-commit` hook rebuilds the code half of the graph automatically
(AST only, no LLM, no API cost). It deliberately does nothing inside a
git worktree, so agent worktrees neither rebuild it nor race each other
— the graph refreshes on commits in the main checkout, which is where
merges land. Install the hooks per-machine with `graphify hook install`;
they are not part of the repository. The documentation half only
refreshes on a full `/graphify` run.

Subagents do not inherit the working directory of the main checkout. If
a subagent should use the graph, give it the absolute path to
`graphify-out/graph.json` in its brief.
