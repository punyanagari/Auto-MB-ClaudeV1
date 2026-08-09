# ADR-0006: The Measurement Book is a new entity; bills stay the payment record

- Status: Accepted
- Date: 2026-08-09

## Context

Milestone 8 (stage-wise Measurement Book lifecycle and payment
eligibility) requires the legacy MB semantics from
`docs/reference/legacy-product-spec.md` §5.9: an MB is built from a
Work's unbilled sources (issued delivery challans, recorded
installations, recorded PAC certificates), each source is billed by at
most one live MB ever, drafts recompute from live state, finalisation
assigns `<work_code>-MB-NN` gap-free, only the newest live MB may be
cancelled (releasing its sources), and once a final MB exists no
further MB may be raised.

The repository already carries two adjacent structures from
Milestone 5, and the second auditor review flagged the collision as a
design decision that must be settled before implementation:

- `bills` (migration 0006): gapless per-Work numbering,
  `status IN ('prepared','submitted','paid')` — deliberately no
  `cancelled` state, DELETE not granted, immutable snapshot. It models
  the money-side record a contractor submits for payment.
- `mb_entries` (migration 0006): individual measured quantities capped
  at delivered, swept wholesale into a bill by the Milestone 5
  preparation endpoint at 100% of measured value. It models site
  measurement evidence, not the MB document.

Retrofitting `bills` into the MB would demand a `cancelled` state and
source links on a table whose shipped invariants (forward-only,
never-cancelled, snapshot-immutable) exist precisely to keep submitted
financial records trustworthy, and would fuse two lifecycles (billing
document vs payment tracking) into one table.

## Decision

1. A new entity, `measurement_books` (with per-item-per-stage lines and
   explicit `mb_sources` links), implements the legacy MB lifecycle:
   draft → finalized → cancelled (newest-live-only), with gapless
   `<work_code>-MB-NN` numbering under a per-Work counter lock. Source
   uniqueness — one live MB per source record, ever — is enforced by the
   database (partial unique index over released sources), not by
   application queries.
2. `bills` remains the payment record with its existing forward-only
   lifecycle. A bill is prepared from a finalized MB (1:1, `bills.mb_id`),
   its amount equal to the MB's snapshotted total. Bills still cannot be
   cancelled.
3. MB cancellation is therefore permitted only while the MB has no bill.
   The legacy rule releases an MB when its _invoice_ is cancelled; this
   repository's bills are stricter than legacy invoices (no cancel), so
   a billed MB is permanently locked and corrections happen as
   compensating entries on a subsequent MB. This deliberately keeps the
   repository's stronger immutability posture (see the Wave 3 revised
   handoff's "do not adopt weaker cancellation rules").
4. The Milestone 5 bill-preparation endpoint (sweep of unbilled
   `mb_entries` at 100% of measured value) is removed. The roadmap
   already recorded that a 100%-of-measured bill on a staged contract
   would be a permanently wrong financial record; once the stage-wise
   path exists, keeping the hazardous path would contradict it.
   `mb_entries` stays as recordable site measurement evidence (its
   delivered-quantity cap and immutability are untouched), but it is not
   a billing input and is not an MB source: the legacy sources are
   delivery, installation, and PAC facts, and those live in their own
   tables.
5. Payment eligibility resolves through item payment categories
   (`SUPPLY`, `SUPPLY_AND_INSTALLATION`, `PURE_INSTALLATION`,
   `SPARE_SUPPLY` — a CHECK constraint on the existing
   `work_items.payment_category` column) and a per-Work payment matrix
   keyed by category whose four stage percentages sum to exactly 100
   (R10: deliberately no per-item percentage entry). Every finalised MB
   snapshots the category, resolved percentages, rate, eligible
   quantities, and prior billed amounts, so later matrix or category
   edits never alter a finalised MB.

## Consequences

- Migration 0022 adds `measurement_books`, `measurement_book_lines`,
  `mb_sources`, and `measurement_book_counters`, plus R19 coherence
  guards: a DC, installation, or PAC billed in a live MB cannot be
  cancelled, and approval-applied edits to them are blocked while
  billed.
- `bills` gains a required link to its MB for new rows; the Milestone 5
  sweep tests migrate to the MB-based preparation path.
- The MB remark algorithm (spec §"The MB remark algorithm") renders
  per-line contractual wording from the finalised snapshot alone, with
  the template versioned so historical MBs never re-render differently.
