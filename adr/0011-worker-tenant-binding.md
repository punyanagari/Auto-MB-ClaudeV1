# ADR-0011: Worker jobs impersonate their requesting user; the queue is reached only through definer functions

- Status: Accepted (owner approval 2026-08-14), with **two amendments
  proposed by the P18 implementation review and awaiting owner
  ratification** — see "Proposed amendments" at the foot of this file.
  Both correct statements of fact that turned out to be wrong; neither
  changes the decision, and the implementation follows the corrected text.
- Date: 2026-08-14
- Programme reference: P18 (worker wiring), IMPROVEMENT-PROGRAMME-2026-08-13 §2.4; ADR-0008 (worker scaffold); ADR-0010 (bind-time verification)

## Context

P18 moves work off the request path into `apps/worker`, coordinated
through a `FOR UPDATE SKIP LOCKED` queue table. The four candidates were
Gotenberg render, ClamAV scan, Poppler extraction and signature
verification; **two of them moved** — Poppler extraction and signature
verification, which share one job on the LOA intake path. The ClamAV scan
stayed synchronous by design (it is an admission gate: nothing unscanned
is ever stored, and an asynchronous scan could only promise the weaker
"nothing unscanned is ever served"), and the Gotenberg render was
deferred with its design recorded. See amendment (b). Every one of these touches tenant data, and since ADR-0010 the
only way to bind a tenant context is `app_private.bind_tenant`, which
proves an **active membership** for a named user and fails closed with
`28A01`. ADR-0010 deliberately gave it no service bypass and deferred
the worker's binding shape to P18's design. This is that decision.

The constraint that must survive: the tenancy floor is membership
verification **inside the database**. A worker that can bind any
organisation without a membership proof is an application-layer bypass
of exactly the floor ADR-0010 refused to weaken — whatever role it
connects as.

## Decision

**1. Jobs run as the user who caused them.** Every P18 job is
request-triggered: some authenticated user uploaded the document or
requested the render. The enqueue happens _inside that request's
tenant transaction_, so the queue row's `(organisation_id, user_id)`
pair is written under an already-verified binding — the enqueuer
cannot record an organisation it does not hold. At execution the
worker calls the ordinary `withTenant(sql, {organisationId, userId},
…)`: `bind_tenant` re-proves the membership at that moment, RLS
applies exactly as it does on the request path, and nothing about the
floor changes. The worker holds no privilege a request handler does
not.

Membership revoked between enqueue and execution → the bind raises
`TenantBindRefusedError` and the job parks in a named terminal state
(`refused_bind`), visible in the queue, never silently retried into
denial. That is the correct outcome: work commissioned by a user who
has since lost the tenancy should not run on their authority, and the
operator remedy (re-request under a live user) is honest.

**2. The queue table is reachable only through SECURITY DEFINER
functions.** The queue is inherently cross-tenant — the worker must
claim the next job regardless of organisation, before any tenant
binding exists. Giving the app role direct SELECT on an RLS-exempt
table would let any SQL-injection payload enumerate every tenant's job
metadata. Instead the table gets **no grants to `auto_mb_app`** at
all; access is through definer-owned functions in the 0004/0069
pattern:

- `enqueue_job(kind, payload_ref)` — callable only inside a bound
  tenant transaction; stamps `(organisation_id, user_id)` from the
  verified binding itself (`current_organisation_id()`), never from
  arguments, so a caller cannot enqueue for another tenant.
- `claim_next_job()` — `FOR UPDATE SKIP LOCKED`, returns at most one
  row and marks it claimed.
- `complete_job(id, outcome)` / `fail_job(id, error, retry_at)` —
  callable only by the claimant's session for the job it claimed.

Residual exposure, stated honestly — and **corrected by amendment (a)**,
because the paragraph as first written stated a bound that is not true.
Arbitrary SQL as the app role can call `claim_next_job()` and see one
job's metadata (ids, kind, timestamps, and the payload reference — not
payloads, which live behind tenant RLS); can starve the queue by claiming
without completing; and — the part the original paragraph missed — is
handed that job's claim token by the call, so it can also **destroy** the
job, with `complete_job` marking work done that never ran or
`fail_job(..., 'refused_bind')` additionally forging a
membership-revocation signal. Destruction is not bounded by the lease,
because a completed job never returns. It remains a denial-of-service and
job-metadata surface rather than a tenancy break — no document content is
readable and no cross-tenant write is possible — but "claims expire by
timeout and re-queue" is not the whole answer to it.

**3. Payloads stay behind tenant RLS.** The queue row carries
references, never content. The worker reads the actual document bytes
and writes results only inside the impersonated tenant transaction —
so a job claimed maliciously yields nothing readable.

## Alternatives rejected

- **Service role with BYPASSRLS for the worker**: one compromised
  worker query reads every tenant. Rejected outright; it is the
  bypass ADR-0010 refused.
- **`bind_service_tenant(org)` without a user**: membership proof
  becomes "the app said so" — the floor demotes to application-layer
  trust for every path the worker touches. Rejected for the same
  reason the verified-GUC design died in ADR-0010.
- **Policy change adding an OR-service-context arm to every tenant
  policy**: re-touches all 64 policies, widens every table's read
  path, and creates a second trust anchor to audit forever. Cost
  without necessity: no P18 job lacks a requesting user.
- **Queue table with plain RLS**: the worker cannot see jobs before
  binding, and binding requires knowing the job's organisation —
  circular.

## Consequences

- No migration touches existing policies; the queue table plus its
  functions are additive (next free migration id at P18's start).
- The worker needs no new database role; it connects as `auto_mb_app`
  with the same LOGIN. Deployment stays one credential.
- A future genuinely user-less job (scheduled backup verification is
  the standing candidate) is **out of scope**: it must arrive with its
  own ADR choosing an authority model, not inherit impersonation by
  default. `enqueue_job`'s binding requirement makes this structural —
  there is no way to enqueue without a user until someone designs one.
- Enqueue-side latency: one extra definer call inside the request
  transaction, matching the bind_tenant precedent (single round trip).
- Job retry semantics interact with membership churn: a transient
  `refused_bind` is terminal, not retried — tests must pin this.
- Guards required of P18's implementation PR: (a) a catalog assertion
  that `auto_mb_app` holds zero direct grants on the queue table —
  fails if anyone adds one; (b) a cross-tenant enqueue attempt via
  crafted arguments proves impossible (org taken from binding, not
  input); (c) a revoked-membership job parks as `refused_bind` with
  the bind never entering the payload read; (d) claim-timeout
  re-queue proven; (e) the ADR-0008 tripwire (worker stays out of the
  deployed set until this pack) is retired in the same PR that deploys
  it, with the OPERATIONS.md paragraph updated in the same commit.
- This ADR touches the security kernel's boundary. The implementation
  PR is opened, not merged — CONTRIBUTING's fresh-human-review
  requirement applies, and approval of this ADR does not waive it.

## Proposed amendments (P18 implementation review, 2026-08-14)

Raised by the review of the implementation pull request, applied to the
implementation, and recorded here for owner ratification rather than
folded in silently — the treatment ADR-0010's own correction had in
pull request #70. Neither changes the decision this ADR takes.

**(a) The residual-exposure bound was falsifiable, and false.** The
original text held that the exposure was metadata disclosure plus
lease-bounded starvation. It is not: `claim_next_job()` returns the claim
token to whoever called it, so an attacker holding the application role
can complete or fail the job it claimed. That is permanent destruction of
queued work, and `fail_job(..., 'refused_bind')` additionally plants a
signal an operator would reasonably read as a real membership revocation.
The Decision section above now states the true bound.

Two things mitigate it and neither was available when the paragraph was
written. Terminal jobs now reconcile their document to a `failed` state
carrying an operator remedy, so a destroyed job leaves a visibly failed
document rather than one stranded mid-flight; and the whole surface still
requires arbitrary SQL as the application role, which is already a
availability compromise. The alternative — a claimant identity the caller
cannot influence at all — was considered and not taken: the session-level
GUC it would need is exactly the shape ADR-0010 rejected for tenancy, and
it would not help, because the same attacker holds the same session.

**(b) "P18 moves four operations off the request path" was wrong by
two.** Two moved. The ClamAV scan stayed synchronous on a security
argument the pack states in `docs/PRODUCT.md` §5.8, and the Gotenberg
render was deferred to a follow-up with its design (HTML by reference
through object storage, so the queue row still carries no content)
written down. The Context section above now says so. This matters beyond
tidiness: a reader taking the original sentence at face value would
believe upload scanning had become asynchronous, which is the opposite of
what the pack decided and the opposite of what the code does.
