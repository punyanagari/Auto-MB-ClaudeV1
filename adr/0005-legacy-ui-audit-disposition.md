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
wholesale. The audit's author reviewed this verification on 2026-08-08,
accepted all seven corrections, and issued a corrected record; the
dispositions below reflect that reconciliation.

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
  it; wiring it through is the cheap first slice of PBG compliance. Per the
  corrected audit this wiring is a thin pre-pilot slice (Milestone 5's
  remaining list), not Milestone 6 scope, and it keeps the requirement
  (what the LOA demands) distinct from the instrument (what the contractor
  submitted) so shortfall and missed-window alerts fall out of the
  comparison. Bank details, renewal history, invocation and release
  paperwork, and FDR-specific behaviour stay evidence-driven additions.
- Maker-checker approvals are scoped as the corrected audit names them: an
  issued-record amendment and edit-approval workflow, landing with the
  amendment path (the only edit surface that will exist), not a blanket
  approve-everything engine. Issued records stay immutable; approvals gate
  proposed changes; one request may be pending per record; an
  approvals-holder may apply directly with the self-approval automatically
  recorded (the legacy rule), and invariants are revalidated at apply time
  so approval never merely blesses a stale payload. Approval-before-issue
  would be a separate product decision requiring operating evidence.
- The stage-wise payment matrix follows the legacy settled decision
  (`docs/reference/legacy-product-spec.md` §16): percentages live in a
  per-Work matrix keyed by item payment category. Per-item percentage
  entry was built and deliberately removed in the legacy product and is
  not reintroduced. Because bills are immutable and undeletable, the
  matrix schema must exist before a design partner prepares a bill on a
  staged contract; a 100%-of-measured bill on an 80/10/5/5 contract would
  be a permanently wrong financial record. Every finalised MB and bill
  snapshots the category assignment, resolved percentages, stage
  quantities, rates, and prior billed amounts, so a later matrix change
  never alters a finalised record.
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
  step (accepted by the corrected audit) is a
  `backup_last_success_timestamp_seconds` gauge on `/metrics`, updated by
  the backup script only after the dump, object archive, and manifest
  verification all complete, with staleness alerting owned by the
  external monitor. No application controls for deleting archives,
  downloading dumps, starting restores, or modifying retention.
  `docs/reference/README.md` warns against re-importing legacy governance
  surface without a current-day justification.

**Evidence-gated (Milestone 9 tranche and Milestone 6 discovery gates,
not committed scope):** standalone/non-Work challans, the unified
cross-document register, the full BOQ/Excel interchange machinery (the
immediate slice — add/remove rows on the LOA review screen — ships in
Milestone 6 because a letter the parser cannot fully serve currently has
no path to a Work), serial range expansion and spreadsheet capture,
organisation-wide audit search, numbering-series and signatory profiles,
and — as Milestone 6 discovery gates pending a partner's real paperwork —
the Contract Agreement register and the formal Variation Order register.

**Reconciliation notes (where the roadmap differs from the corrected
audit's milestone lists):** consignee/location/unit masters stay in
Milestone 7 rather than Milestone 9 because Milestone 7's own scope
consumes them (legacy installation picks its location from the master);
before/after audit capture starts in Milestone 6 even though the
organisation-wide search UI waits for Milestone 9, because every day
without capture permanently discards diff evidence; the unified document
register and serial range/spreadsheet capture stay evidence-gated rather
than Milestone 7 scope, consistent with the corrected audit's own rule
that screenshot-only concepts are not silently promoted (multiline batch
serial capture already shipped in Milestone 5).

## Consequences

The roadmap gains three committed milestones, an evidence-gated fourth
tranche (Milestone 9), and two thin pre-pilot slices (PBG requirement
wiring in Milestone 5's remaining list; the backup-age gauge in
Milestone 4's) without adopting the legacy product's full ERP breadth.
Two data-loss clocks identified by the review are addressed early: audit
writers currently record only changed-key names (before/after values are
discarded, so diff evidence is being lost daily — capture starts in
Milestone 6), and `requires_serials` has been stored since migration 0001
with zero enforcement (enforced in Milestone 7).
