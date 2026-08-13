# ADR-0008: The empty apps/worker scaffold stays, as a declared boundary

- Status: Accepted
- Date: 2026-08-12

## Context

`apps/worker` contains a single `main.ts` that logs "worker boundary
ready; jobs land with the first async workflow" and waits for a signal.
No job has ever run in it. A repository-hygiene review asked the obvious
question: is an empty service a speculative framework of the kind
AGENTS.md rule 1 forbids, and should it be folded into `apps/server`
until real asynchronous work exists?

## Decision

Keep the scaffold. It is a boundary declaration, not a framework.

- `docs/ARCHITECTURE.md` and AGENTS.md both name the worker as one of the
  four deployables of the modular monolith ("`apps/worker`: asynchronous
  jobs only"). The scaffold is the placement of that declared boundary in
  code — roughly thirty lines plus configs — and removing it would mean
  editing the two authority documents to describe a three-part monolith,
  a larger and higher-risk change than the emptiness it cures.
- The rule-1 hazard in speculative structure is that it accretes
  abstractions nothing consumes. The worker has no abstractions: no
  queue library, no job interface, no shared "framework" — exactly so
  that the first real async workflow (LOA extraction offload and
  scheduled backup verification are the standing candidates on the
  roadmap) decides those shapes when it arrives.
- Folding into the server would invite the tempting wrong default of
  running background work on the request process in the meantime, and
  re-extracting it later would be a second decision made under whatever
  pressure produced the first job rather than in advance.

## Consequences

- The worker stays in `pnpm dev`, typecheck and test fan-outs at
  near-zero cost (its test suite is empty and vitest exits cleanly).
- The scaffold is **not deployed**. Correcting a claim this ADR carried as
  accepted until 2026-08-13: the third decision bullet argued that folding
  the worker into the server and re-extracting it would "churn the compose
  files, CI, and the process supervisor twice". It would not, because none
  of those name the worker. `docker-compose.yml`, `deploy/docker-compose.prod.yml`,
  `deploy/Dockerfile.server` and every workflow under `.github/workflows`
  mention it nowhere; the only places it exists are the workspace globs
  in `pnpm-workspace.yaml` and the four files under `apps/worker`. So the
  cost of removing the scaffold is the two authority documents plus those
  four files, and the case for keeping it rests on the boundary
  declaration and the wrong-default hazard alone — which is why the
  decision above is stated that way and this consequence records what the
  scaffold does not buy.
- A corollary the tripwire below depends on: the first pull request to
  land a real job must also give the worker a deployment, because today
  nothing would run it.
- Tripwire: the first PR that lands a real asynchronous workflow must
  either put its jobs here or, if it concludes in-process execution is
  correct for that workload, replace this ADR with one that removes the
  scaffold and amends `docs/ARCHITECTURE.md` and AGENTS.md in the same
  change. The scaffold may not simply persist past that decision point
  unexamined.
