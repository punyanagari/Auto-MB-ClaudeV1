# ADR-0010: RLS helper moves to per-statement evaluation; membership is verified at bind time

- Status: Accepted (owner approval 2026-08-14)
- Date: 2026-08-14
- Programme reference: P17 (migration 0069), IMPROVEMENT-PROGRAMME-2026-08-13 §2.4

## Context

Every tenant table's RLS policy calls `app_private.current_organisation_id()`
in bare filter position — 135 call sites across 27 migrations, all of the
shape:

```sql
USING (organisation_id = app_private.current_organisation_id())
```

The helper (0004) is `SECURITY DEFINER` and does real work on every
evaluation: it reads the candidate organisation id from the `app.organisation_id`
GUC and proves an active row exists in `organisation_memberships` for the
session's user. Because the call sits in bare filter position and the function
is only `STABLE`, the planner evaluates it per candidate row. The reconciled
review measured the helper at **4.1× overhead in filter position** (score
sheet row 34); on a register scan every row pays a membership index probe
that can only ever produce one answer per statement.

The same shape has a second cost, a semantic one: a handler that stamps an
organisation the user does not belong to gets `NULL` from the helper, so
every policy silently denies and the request sees empty results. Nothing
fails loudly; the wrong binding is discovered by absence.

The tenancy floor this design buys is precise, and it is the thing P17 is
forbidden to weaken: membership verification happens **inside the
database**, on the definer's authority, so no application-layer bug — up to
and including an attacker executing arbitrary SQL as `auto_mb_app` — can
bind a tenant context the user does not hold. FORCEd RLS plus this helper
is why tenant isolation scored 8.5 and why `docs/SECURITY.md` can claim SQL
injection does not cross tenants.

## The design the programme row prescribed, and why it is rejected as written

The pack row proposed: verify membership once at bind time, write the
result to a _verified_ GUC (e.g. `app.verified_organisation_id`), and have
policies read that GUC through a cheap, table-free function.

The performance is real, but the floor does not survive it. Postgres user
GUCs have no ACL. Revoking `pg_catalog.set_config()` from `auto_mb_app`
does not close the hole, because `SET app.verified_organisation_id = '…'`
is a **SQL command, not a function call** — it cannot be revoked per role
for user-defined parameters. Under the prescribed design, any path to
arbitrary SQL execution forges the verified binding in one statement and
every policy believes it. Tenant isolation would silently demote from
"enforced in-database against arbitrary SQL" to "enforced if the
application layer is uncompromised" — exactly the demotion the row's own
caveat forbids. A static census of `set_config` call sites cannot repair
this; it audits our code, not an attacker's statement.

## Decision

Two changes, which together capture the measured win with **zero change to
the trust model**:

**1. Policies evaluate the existing helper once per statement, via an
InitPlan.** Migration 0069 rewrites every tenant policy from bare filter
position to scalar-subquery position:

```sql
USING (organisation_id = (SELECT app_private.current_organisation_id()))
```

An uncorrelated scalar subquery is planned as an InitPlan: the helper —
membership probe and all — runs **once per statement**, and its result is a
parameter the planner can use in index conditions. The membership `EXISTS`
stays inside the helper, on the definer's authority, byte-for-byte
unchanged. Arbitrary SQL as `auto_mb_app` gains nothing it does not have
today. This is the same per-row cost the 4.1× measurement describes,
removed at its source; the residual cost is one membership index probe per
statement, which is noise.

The mixed policies (e.g. `organisation_memberships_select_policy`'s
`OR user_id = app_private.current_user_id()`) get the same wrapping on each
helper call. The migration carries explicit, statically written
`ALTER POLICY` statements for every site — generated once from
`pg_policies` at authoring time and reviewed as SQL, not rewritten
dynamically at run time.

**2. Membership verification also happens at bind time, and fails closed.**
A new definer function `app_private.bind_tenant(p_organisation_id uuid,
p_user_id text)` performs the two `set_config` calls (transaction-local,
exactly as `tenant.ts` does today) and then proves the active membership,
raising `28A01` if it does not hold. `withTenantAt` in
`packages/db/src/tenant.ts` replaces its two `set_config` statements with
one `SELECT app_private.bind_tenant(...)` call — one round trip instead of
two, and a wrong binding now fails at the top of the transaction with a
named error instead of producing silent empty results downstream.

_This ADR first named `28000` here and in the two places below; implementation
review took `28A01`, and this record states the decision as taken. `28000` is
`invalid_authorization_specification`, which PostgreSQL itself raises when a
connection fails `pg_hba`, LOGIN or role authorisation — so a caller mapping it
to "not a member" would answer a cluster-wide authentication outage with a
fleet of tenant-shaped 403s and no 5xx at all, and the outage would read as a
permissions change. Class 28 carries exactly two upstream codes (`28000` and
`28P01`), so `28A01` is unused by PostgreSQL and unused anywhere in this
schema, and `tenant.ts` catches exactly it. See the migration header and
`TENANT_BIND_REFUSED_SQLSTATE` in `packages/db/src/tenant.ts`._

Bind-time verification is **additive, not load-bearing**: the policies do
not trust it. If a future code path binds GUCs without calling
`bind_tenant`, it lands exactly where it lands today — the helper returns
`NULL` and every policy denies. Fail-fast is a semantics improvement; the
floor remains the helper.

## Alternatives considered

- **Verified GUC, policies trust it** (the row's literal design): rejected
  above — unforgeability cannot be had for user GUCs, so it weakens the
  floor against the one adversary the current design provably beats.
- **Verified GUC, helper re-verifies anyway**: keeps the floor but the GUC
  then saves only the per-statement probe the InitPlan already made
  negligible. Complexity with no remaining benefit.
- **Do nothing at the policies, rely on caching**: Postgres does not
  memoise `STABLE` functions across rows in filter position; there is
  nothing to switch on.

## Consequences

- Expected: register/list scans stop paying a per-row definer call; the
  review's 4.1× filter-position overhead collapses to once per statement.
  The implementation must measure this, not assert it: `EXPLAIN (ANALYZE,
BUFFERS)` on a register query at fixture scale, before and after, stated
  in the PR.
- Membership revocation semantics are unchanged: the helper is `STABLE`,
  so it was already fixed within a statement; across statements in a
  transaction it re-evaluates, before and after this change. `bind_tenant`
  adds an additional check at transaction start.
- `withUserContext` (user-scoped, no organisation) is untouched.
- Callers of `withTenant`/`withTenantSnapshot` that bind with an **absent
  user id** would now raise `28A01` at bind instead of silently reading
  nothing. Implementation must census such call sites first; the
  expectation is zero live ones (they were already broken-silent). If the
  census finds one, it is a pre-existing bug to surface, not a reason to
  soften `bind_tenant`.
- P18 (worker) interaction: background jobs have no requesting user. The
  worker's binding shape (service context vs. impersonation) is a separate
  decision to be made in P18's design, not smuggled in here; `bind_tenant`
  deliberately has no service bypass.
- Guards required by the implementation PR:
  1. A catalog census asserting **no policy qual contains a bare
     (non-InitPlan) helper call** — must fail on the pre-fix tree.
  2. A plan-shape assertion (P11 precedent) that a tenant register scan
     evaluates the helper via InitPlan, not per row.
  3. A fail-closed test: binding a non-member organisation raises `28A01`
     at `bind_tenant`, before any statement runs.
  4. The existing tenancy suite (`packages/db/test/tenancy.integration.test.ts`,
     `organisation-read-pinning`, `cross-org-authority`) must pass
     unmodified except where it asserts exact policy qual text.
- Migration 0069 is policy-only plus one function; it may apply out of
  order relative to 0066–0068 (runner applies any unapplied id; precedent 0070) and depends on none of them.
- This ADR touches the security kernel. The implementation PR is opened,
  not merged — CONTRIBUTING requires fresh human review for RLS and
  authentication changes, and approval of this ADR does not waive it.
