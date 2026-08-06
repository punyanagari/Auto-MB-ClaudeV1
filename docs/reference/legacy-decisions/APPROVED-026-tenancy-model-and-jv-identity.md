# APPROVED-026: PRODUCT-SPEC says one agency per instance; ARCHITECTURE says 5,000 tenants
Status: APPROVED — via dashboard 2026-07-28
Decision: Option A
Authorizes: APPROVED-026
Scope: PRODUCT-SPEC.md ARCHITECTURE.md tickets/DC-3.md tickets/DC-4.md tickets/DC-6.md tickets/DC-7.md tickets/DC-13.md tickets/DC-18.md
Filed by: orchestrator on 2026-07-28
Deadline: 2026-07-31  ·  Default if silent: A
Blocks: DC-3, DC-4, DC-6, DC-7, DC-13, DC-18 — every ticket that builds against the tenancy model
Continues: decisions/APPROVED-022 (the DAG these ids come from)
Amended: 2026-07-30 per APPROVED-053 (ticket SEC-13) — header only, decided substance untouched. `Authorizes:` retired the legacy self-token `PENDING-026` for the self-id `APPROVED-026`. Audit finding **L-6**, the class `APPROVED-048` closed for `APPROVED-013` and `APPROVED-052` for `APPROVED-033`/`APPROVED-046`: written 2026-07-28, in the window before the ticket system landed (`APPROVED-022`, same day), when a decision's own `PENDING-0nn` id was the only name it had; approval renamed the file and nothing rewrote the header, so the id of a *pending* decision stayed a live authorization token. Measured 2026-07-30, this one is **inert**: no entry in this `Scope:` is a protected path — `PRODUCT-SPEC.md`, `ARCHITECTURE.md` and the six `tickets/DC-*.md` files all read exit 0 under `PENDING-026`, under the self-id, under a bogus id **and** under an unset `CLAUDE_TICKET` alike, which is the signature of an unprotected path rather than of a grant (`memory/inbox/2026-07-30-exit-0-is-not-a-grant-and-content-aware-freezes.md`; `tickets/**` is on the audit's own §2 unbound-WRITABLE list). Retired anyway, per `APPROVED-053` Option A: inertness is a property of today's frozen set, not of this header, and "inert today" has now been the wrong call twice — H-1 called `SEC-12` dormant when it was already live, and L-6 called all ten of these inert when seven were live grants. `APPROVED-049` makes the mechanism concrete: it turned `DASH-1`, `MEM-1` and `UX-5` into rule-8 violations hours after each shipped clean, because freezing a path arms every dormant token naming it, retroactively and silently. Never exercised: `git log --all` attributes no commit on these paths to `PENDING-026`. The self-id retains this decision's own implementing grant, exactly as `APPROVED-013` retained its own under [SEC-10].

## Context (≤10 lines)
The two governing documents describe different products, and nothing has
reconciled them:

- `PRODUCT-SPEC.md:32` — "**Single-company deployment (one agency per
  instance)** in the current version." The word `tenant` appears **zero times**
  in the entire spec.
- `ARCHITECTURE.md:14` — "**2,000–10,000 tenant organisations**", 5,000 tenants
  at a 3-year horizon, `tenant_id` leading every composite index, RLS +
  `FORCE RLS` as the load-bearing control (§4.1, §34).

`SECURITY.md` §5 is titled "V8 Authorization (**the product's core risk**)" and
treats cross-tenant isolation as the central threat. AGENTS.md says
PRODUCT-SPEC is the law. The law does not mention the thing the architecture is
built around.

## How this surfaced
A real one. The five-letter LOA corpus contains two contractor identities:
four letters name one firm, `PL270` names a **joint venture** — confirmed by
the CEO on 2026-07-28 as a different company. A JV is a distinct legal entity
with its own books, PAN and GST, so its works must not sit under the other
firm's data. But "separate **tenant**" and "separate **instance**" are
different answers, and which one is correct depends on a question no document
answers.

## What each reading implies

| | Single-company per instance | Multi-tenant |
|---|---|---|
| The JV | its own deployment | tenant #2 in a shared instance |
| Separate credentials | free — different instance | a modelling decision (below) |
| `DC-7` cross-tenant probe | tests a property v1 does not have | essential |
| `tenant_id` everywhere | future-proofing, unused in v1 | load-bearing today |

## Options
A. **Multi-tenant-capable schema, single-tenant deployment in v1.**
   `tenant_id`, RLS and `FORCE RLS` land from day one exactly as ARCHITECTURE
   §4.1 specifies, and v1 ships one agency per instance as PRODUCT-SPEC says.
   The two documents are both right about different horizons, and each is
   amended to say so. The JV is a separate **instance** today and a separate
   **tenant** when multi-tenancy ships. `DC-7`'s isolation probe keeps its
   place: it catches code that ignores tenant context even when only one tenant
   exists, which is the bug that turns into a leak the day a second one does.
   cost/effort: nil — this is what the tickets already build ·
   risk: carrying an unused column and policy set through v1 ·
   reversibility: high.
B. **Multi-tenant from v1.** Amend PRODUCT-SPEC to drop "one agency per
   instance" and ship tenant switching, a membership model and per-tenant
   onboarding now. cost/effort: high — it adds a whole authorization surface
   that no ticket currently covers · risk: the DC-first milestone is delivery
   challans, not tenancy; this defers the thing being dogfooded ·
   reversibility: low.
C. **Genuinely single-tenant.** Drop `tenant_id`, RLS and `FORCE RLS`, delete
   `DC-4`, `DC-7` and the tenancy half of `DC-6`/`DC-13`/`DC-18`, and amend
   ARCHITECTURE and SECURITY.md §5 to match. cost/effort: moderate (deletion) ·
   risk: **retrofitting RLS later is the expensive direction**, and
   ARCHITECTURE §34 cites the 2025 Asana MCP leak precisely as what app-layer
   scoping costs when it fails open. **Rejected** unless the CEO intends
   Auto-MB never to be multi-tenant.
D. Status quo — leave the contradiction. cost/effort: nil · risk: six tickets
   build against a model nobody has agreed, and the first reviewer to read
   PRODUCT-SPEC will correctly object that none of it is specified. **Rejected.**

## Recommendation
**A**, and it is close to what everyone already assumes — which is exactly why
it needs writing down. "In the current version" in PRODUCT-SPEC reads as v1
scoping rather than a permanent product decision, and ARCHITECTURE's 5,000
tenants reads as the 3-year target. Under A both statements become true instead
of contradictory, and no ticket changes.

The one thing A must not do is leave `DC-7` justified by a horizon. Its value
is present-tense: a repository that forgets to set tenant context, or a
`SET LOCAL` that does not survive PgBouncer, is a live bug in a single-tenant
deployment too — it just does not leak until there is something to leak.
ARCHITECTURE §5 already says "PgBouncer never certifies `SET LOCAL`".

## Second question, decided in the same breath: JV credentials
The same human is proprietor of one firm and a partner in the JV, so one person
needs access to both sets of books. Two shapes:

1. **Separate credentials per entity.** Hard boundary, matches the legal
   separation, simplest to audit. Cost: one human holds two passwords and will
   reuse one, so a breach of either is a breach of both — which quietly undoes
   the separation being bought.
2. **One identity, membership in both, explicit switch.** The standard
   multi-tenant shape. RLS still scopes per transaction, so it is no weaker at
   the database layer; the boundary moves into the authorization layer.

**Recommended: 1 for v1**, because under option A the JV is a separate instance
anyway and shape 2 is not available without multi-tenancy. Revisit when
multi-tenancy ships. Whichever is chosen, it belongs in PRODUCT-SPEC §3.4,
which today says nothing about a user belonging to more than one company —
`grep -c tenant PRODUCT-SPEC.md` returns 0, and no ticket encodes it either.

## Also owed
- Whichever option is approved, **PRODUCT-SPEC.md and ARCHITECTURE.md are
  amended in the same PR** so the contradiction cannot be rediscovered.
- `SECURITY.md` §5's "core risk" framing is re-checked against the chosen
  model; under A it stands, under C it does not.
- None of the paths in this decision's `Scope:` are frozen, so the grant is
  documentary rather than a real unfreeze — recorded so no reader mistakes its
  presence for an authorization it does not confer.
