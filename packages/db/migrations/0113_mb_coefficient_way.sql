SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0113: which WAY a Measurement Book is filed for the railway.
--
-- Owner ruling, live-testing corrections item 24.
--
-- ---------------------------------------------------------------------
-- THE TWO WAYS, AND WHY THE CHOICE HAS TO BE PERSISTED.
--
-- A railway Measurement Book is filed one of two ways in the field.
--
--   COEFFICIENT  the recorded quantity is the PHYSICAL quantity times the
--                payment stage's percentage, and the sheet pays that
--                figure at 100%: a stage reading "70% for 3 Nos" is
--                recorded as 2.1 and paid in full. This organisation's
--                own practice, and the way every document in the
--                committed settlement corpus is written — BILL-1 item
--                A/01 prints `Qty Upto Date 2.1` against an agreement
--                quantity of 6, and BILL-3 carries the compound case,
--                64% of 10 plus 64% of 5 summing to 9.6 of an agreement
--                18.
--
--   PHYSICAL     the physical quantity is recorded and the stage
--                percentage is applied when the bill is computed. This
--                product's own engine is this way automated: quantities
--                stay physical in `mb-compute.ts` and the payment matrix
--                decides the money.
--
-- The way is a RAILWAY-INTERFACE CONVENTION and not a different contract.
-- Nothing about the snapshot changes: `measurement_book_lines` still
-- stores physical quantities beside their stage percentages, the stage
-- amounts are still `computeStageAmounts`, and the book's total is
-- byte-identical whichever way it prints. What the column below decides
-- is what the QUANTITY COLUMN of the draft preview and of the PDF reads,
-- and whether the sheet carries the `Payable 100%` column IWRCMS prints
-- beside its own `Reason for Reduction` text.
--
-- So why store a presentation choice at all? Because migration 0111's
-- gate reads the railway's copy of this book, and the railway's copy was
-- typed from whichever way the sheet was filed. A matcher that has to
-- decide in a year's time whether a printed `2.1` means three units at
-- 70% or 2.1 units at 100% is guessing at a fact this row knows.
-- `railway-measurement-match.ts` tries BOTH arithmetics on every line and
-- records which one the figure came from — the column below only breaks
-- the tie on a line billed entirely at a single 100% stage, where the two
-- genuinely coincide. Detected, never assumed.
--
-- ---------------------------------------------------------------------
-- DEFAULT ON, STICKY PER WORK, FLIPPABLE PER DRAFT.
--
-- Two columns rather than one, because they answer different questions.
-- `works.mb_way_default` is what the NEXT book on this Work starts as;
-- `measurement_books.mb_way` is what THIS book is. Flipping a draft ALSO
-- moves the Work's default — the item-24 ruling made the choice sticky
-- per Work, so the way a book actually went out is the way the next one
-- starts, and an agency that files one Work the railway's coefficient way
-- and another physically states each Work's practice by flipping once.
--
-- Both default to `coefficient`, which is the owner's ruling and is also
-- what every book already in the database was in fact filed as — the
-- corpus is the evidence, and a backfill to the other value would be
-- rewriting history to match a default.
--
-- ---------------------------------------------------------------------
-- THE GUARD, AND WHY THERE IS NO NEW TRIGGER.
--
-- The way is flippable while the book is a DRAFT and frozen once it is
-- finalized, which is exactly the rule `guard_measurement_book_update`
-- already states about every other piece of a finalized book's business
-- data. It is restated below with `mb_way` in its frozen row rather than
-- given a guard of its own: one rule, one place, and the trigger 0024
-- created still carries it. The house style for that is
-- `CREATE OR REPLACE` with the CURRENT body restated in full — see § 3
-- for which body that is and what happens to a pack that reaches for the
-- wrong one.
--
-- No new SQLSTATE is taken here. This pack's block is 23W and migration
-- 0114 opens it; the restated guard keeps every code and every sentence
-- it already had, because an operator meeting one of its refusals is
-- meeting a rule that has not changed.

-- ---------------------------------------------------------------------
-- 1. The Work's sticky default.
-- ---------------------------------------------------------------------
ALTER TABLE works
  ADD COLUMN mb_way_default text NOT NULL DEFAULT 'coefficient'
    CHECK (mb_way_default IN ('coefficient', 'physical'));

COMMENT ON COLUMN works.mb_way_default IS
  'Which way the NEXT Measurement Book raised on this Work is filed for the railway: coefficient (quantity x stage percentage, paid at 100%) or physical. Presentation only — no amount depends on it. Set by flipping a draft, so the choice an operator makes once persists for the books after it.';

-- ---------------------------------------------------------------------
-- 2. The book's own way.
-- ---------------------------------------------------------------------
ALTER TABLE measurement_books
  ADD COLUMN mb_way text NOT NULL DEFAULT 'coefficient'
    CHECK (mb_way IN ('coefficient', 'physical'));

COMMENT ON COLUMN measurement_books.mb_way IS
  'How this book is transcribed for the railway: coefficient (stage-weighted quantity paid at 100%) or physical (quantity as measured, percentage applied in the bill). Presentation only; the lines snapshot is physical quantities plus percentages either way and the total is identical. Persisted so migration 0111''s matcher knows what the railway''s own copy was typed from.';

-- ---------------------------------------------------------------------
-- 3. The Measurement Book update guard, restated with mb_way frozen.
--
-- RESTATED FROM 0066, NOT FROM 0024, and that distinction is the whole
-- reason this section is longer than the two columns above deserve. This
-- guard has been restated five times — 0026 for the render evidence, 0027
-- for the bill-lock and newest-only cancel rules, 0032 for the completed
-- Work, 0036 for `kind`, 0066 for closure — and the house discipline
-- 0066's own header states in as many words is to restate the CURRENT
-- body rather than the one the original migration installed. Reaching for
-- 0024's copy silently deletes five migrations' worth of rules.
--
-- 0036's trap is the one that bites hardest and leaves no trace: 0024
-- froze `NEW.is_final`, which became a GENERATED ALWAYS column, and
-- PostgreSQL leaves generated columns NULL in a BEFORE trigger's NEW row.
-- Freezing it therefore refuses EVERY legitimate update of a finalized
-- book — cancellation, render evidence, closure — with the immutability
-- message, which reads like the rule working. The body below is 0066's
-- verbatim, `NEW.kind` and all, with `mb_way` added to the frozen ROW and
-- nothing else moved.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.guard_measurement_book_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled Measurement Books are immutable';
  END IF;

  -- NEW in 0066. Closure is append-once, like the signature verdict it
  -- rests on: reopening a closed book would let an inconvenient railway
  -- bill be detached from the measurement it settled while the bill
  -- itself stayed exactly as it was.
  IF OLD.closed_at IS NOT NULL AND ROW(
    NEW.closed_at, NEW.closed_by_user_id, NEW.closed_by_received_bill_id
  ) IS DISTINCT FROM ROW(
    OLD.closed_at, OLD.closed_by_user_id, OLD.closed_by_received_bill_id
  ) THEN
    RAISE EXCEPTION 'a closed Measurement Book cannot be reopened or re-closed';
  END IF;

  -- NEW in 0066. Cancelling a closed book would strand a settled railway
  -- bill against a withdrawn measurement.
  IF OLD.closed_at IS NOT NULL AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION
      'a Measurement Book closed by a railway bill cannot be cancelled'
      USING ERRCODE = 'check_violation';
  END IF;

  -- NEW in 0066. What the closing bill has to BE.
  --
  -- The shape CHECK on this table only says the three columns move
  -- together and that the book is finalized. That is not the claim the
  -- header and `docs/PRODUCT.md` §5.5 make, which is that closure is
  -- enforced twice. So the structural half of the gate is enforced here,
  -- against the bill row itself, and a writer that never went through the
  -- route gets the same answer:
  --
  --   * the bill exists and belongs to THIS organisation and THIS book;
  --   * it is not discarded;
  --   * its stored document verdict is one of the two settleable ones;
  --   * it carries at least the three signatures an accepted bill has.
  --
  -- What is deliberately NOT duplicated here: the per-signature predicate
  -- — integrity, reaching a configured anchor, distinct signing
  -- certificates, and the last signature covering the file. That is the
  -- OWNER'S RULING rather than a structural fact, it is the kind of thing
  -- that gets revisited (the distinct-signer clause is itself an extension
  -- the owner ruled on a day later, on 2026-08-14), and a ruling that
  -- lives in two languages drifts between them. It lives once, in
  -- `apps/server/src/railway-bill-verdict.ts`. The split is stated in
  -- exactly these words in §5.5, so the two-layer claim is true of what
  -- each layer actually does.
  IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL THEN
    DECLARE
      bill received_railway_bills%ROWTYPE;
    BEGIN
      SELECT * INTO bill FROM received_railway_bills
      WHERE id = NEW.closed_by_received_bill_id
        AND organisation_id = NEW.organisation_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'Measurement Book % cannot close: no railway bill % in this organisation',
          NEW.id, NEW.closed_by_received_bill_id
          USING ERRCODE = 'check_violation';
      END IF;
      IF bill.measurement_book_id <> NEW.id THEN
        RAISE EXCEPTION
          'railway bill % settles a different measurement and cannot close Measurement Book %',
          bill.id, NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF bill.discarded_at IS NOT NULL THEN
        RAISE EXCEPTION
          'railway bill % is discarded and cannot close a Measurement Book', bill.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF bill.signature_status NOT IN ('signed_and_intact', 'signed_chain_expired') THEN
        RAISE EXCEPTION
          'railway bill % has signature verdict % and cannot close a Measurement Book',
          bill.id, bill.signature_status
          USING ERRCODE = 'check_violation';
      END IF;
      IF coalesce(
           jsonb_array_length(bill.signature_verdict -> 'signatures'), 0
         ) < 3 THEN
        RAISE EXCEPTION
          'railway bill % carries fewer than the three signatures an accepted On-Account Bill has',
          bill.id
          USING ERRCODE = 'check_violation';
      END IF;
    END;
  END IF;

  IF OLD.status = 'finalized' THEN
    IF NEW.status NOT IN ('finalized', 'cancelled') THEN
      RAISE EXCEPTION 'finalized Measurement Books may only remain finalized or be cancelled';
    END IF;
    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.kind, NEW.mb_date,
      NEW.mb_number, NEW.sequence_number, NEW.total_amount,
      NEW.remark_template_version, NEW.created_by_user_id,
      NEW.finalized_by_user_id, NEW.created_at, NEW.finalized_at,
      NEW.mb_way
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.kind, OLD.mb_date,
      OLD.mb_number, OLD.sequence_number, OLD.total_amount,
      OLD.remark_template_version, OLD.created_by_user_id,
      OLD.finalized_by_user_id, OLD.created_at, OLD.finalized_at,
      OLD.mb_way
    ) THEN
      RAISE EXCEPTION 'finalized Measurement Book business data is immutable';
    END IF;
    IF NEW.status = 'cancelled' THEN
      IF EXISTS (
        SELECT 1 FROM bills b
        WHERE b.organisation_id = OLD.organisation_id AND b.mb_id = OLD.id
      ) THEN
        RAISE EXCEPTION
          'Measurement Book % has a prepared bill and is permanently locked; corrections happen as compensating entries on a subsequent MB',
          OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM measurement_books newer
        WHERE newer.organisation_id = OLD.organisation_id
          AND newer.work_id = OLD.work_id
          AND newer.status = 'finalized'
          AND newer.sequence_number > OLD.sequence_number
      ) THEN
        RAISE EXCEPTION
          'Measurement Book % is not the newest live Measurement Book of its Work; only the newest may be cancelled',
          OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Measurement Books are deleted, not cancelled';
  END IF;

  -- R8 (0032): cancelling releases this book's claimed sources, so a
  -- completed Work must be reopened first.
  IF OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = OLD.organisation_id
        AND w.id = OLD.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before cancelling a Measurement Book'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_measurement_book_update() IS
  'A finalized Measurement Book''s business data is immutable and a cancelled one never changes. Since migration 0113 the frozen row includes mb_way: the way a book was filed for the railway is part of what a finalized book states, because the railway''s own copy was typed from it.';
