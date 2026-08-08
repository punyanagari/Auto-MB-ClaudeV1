# ADR-0005: Disposition of the legacy UI audit (roadmap extension)

- Status: Accepted
- Date: 2026-08-08

## Context

An external audit reviewed 93 screenshots from the two legacy Auto-MB
archives (AutoMBUI and Auto-MB-Legacy — the archives themselves are not in
this repository) against ClaudeV1 and proposed fifteen roadmap additions
across four new milestones. Every factual claim in the audit was verified
against this repository (docs, migrations, routes, web views) and against
the imported legacy material in `docs/reference/`; none was refuted. The
audit's priorities, however, were set without the repository's own settled
decisions and pre-pilot posture in view, so acceptance is item by item, not
wholesale.

## Decision

Roadmap Milestones 6–8 (docs/ROADMAP.md) adopt the verified, re-scoped
subset. The dispositions that differ from the audit's proposal, and why:

**Accepted with re-scoping:**

- Contract change control enters as an audited, approval-gated work-item
  amendment path plus an actually settable excess-delivery flag —
  `works.allow_excess_delivery` has existed since migration 0001 with no
  setter in any route or screen, so the product's only sanctioned way to
  exceed the awarded baseline is dead code. A formal variation-order
  document register waits for a design partner's real variation paperwork.
- The works table has no completion date at all, which makes every legacy
  PBG-validity-versus-completion rule unimplementable; completion dates and
  extension (DOC) tracking are therefore scheduled before deeper PBG
  automation. The deterministic parser already extracts the LOA's
  performance-guarantee requirement (`extractPerformanceGuarantee`,
  `packages/loa-parser/src/header.ts`) and confirmation currently discards
  it; wiring it through is the cheap first slice of PBG compliance.
- Maker-checker approvals land with the amendment path (the only edit
  surface that will exist), not as a blanket approve-everything engine.
  Issued records stay immutable; approvals gate proposed changes. The
  legacy flow permitted an approvals-holder to self-apply with an
  auto-recorded request; blocking self-approval stays an optional policy.
- The stage-wise payment matrix follows the legacy settled decision
  (`docs/reference/legacy-product-spec.md` §16): percentages live in a
  per-Work matrix keyed by item payment category. Per-item percentage
  entry was built and deliberately removed in the legacy product and is
  not reintroduced. Because bills are immutable and undeletable, the
  matrix schema must exist before a design partner prepares a bill on a
  staged contract; a 100%-of-measured bill on an 80/10/5/5 contract would
  be a permanently wrong financial record.
- Issue Challans adopt the legacy lifecycle (draft → issued → cancelled,
  plus loan/return type). The audit's six-state machine and standalone
  custody ledger exceed what any in-repo legacy evidence supports.
- Master data is limited to what current workflows touch: consignees
  (retire-not-delete, snapshot-on-use — the snapshot rule is already an
  enforced invariant), locations, units (seeded from the parser's canon),
  and org-profile signatories. Banks and railway zone/division masters
  have no in-repo corroboration and are dropped.

**Rejected:**

- Multiple legal entities/letterheads inside one organisation. This
  contradicts the tenancy model: PRODUCT.md defines an organisation as one
  legal entity, ADR-0002 makes a second entity a cheap second organisation,
  and the imported decision APPROVED-026 settled JV identity the same way.
  Multi-entity users get multiple organisations under one login (which
  already works); only numbering-series/financial-year and named-signatory
  configuration remain as deferred single-org enhancements.
- An in-app backup/restore evidence console. Milestone 4 deliberately
  assigns operational visibility to external monitoring; the proportionate
  step is a last-backup-age gauge on `/metrics`, and
  `docs/reference/README.md` warns against re-importing legacy governance
  surface without a current-day justification.

**Demand-gated (added to the deferred list, not to a milestone):**
standalone/non-Work challans, the unified cross-document register, the
full BOQ/Excel interchange machinery (the immediate slice — add/remove
rows on the LOA review screen — ships in Milestone 6 because a letter the
parser cannot fully serve currently has no path to a Work), the Contract
Agreement register, and the variation-order document register.

## Consequences

The roadmap gains three evidence-backed milestones without adopting the
legacy product's full ERP breadth. Two data-loss clocks identified by the
review start being addressed in Milestone 6: audit writers currently
record only changed-key names (before/after values are discarded, so diff
evidence is being lost daily), and `requires_serials` has been stored
since migration 0001 with zero enforcement.
