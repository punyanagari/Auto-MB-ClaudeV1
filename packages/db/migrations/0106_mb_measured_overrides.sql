SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- Migration 0106: a draft Measurement Book's measured quantity may be
-- reduced, per line, and never raised.
--
-- Numbering: 0105 is the live-testing corrections pack's
-- `uncategorised_item_category`, so this pack takes 0106 and 0107.
--
-- THE RULING, 2026-08-19 (live-testing ledger item 2(a)): "MB books
-- drafts: per-line measured quantity becomes EDITABLE DOWNWARD ONLY,
-- capped at the claimed source's quantity — partial measurement of a
-- claimed challan/installation."
--
-- WHY A TABLE AND NOT A COLUMN. A draft Measurement Book's lines are not
-- rows. `measurement_book_lines` is written once, by the finalize
-- transaction, and 0024's `guard_measurement_book_line_mutation` permits
-- no UPDATE and no DELETE ever; a draft's lines are recomputed from live
-- state on every read (`ITEM_INPUTS_SQL`, `mb-compute.ts`). So there is
-- no row to edit. What the operator is editing is an INSTRUCTION to the
-- computation — "measure only 8 of the 10 this challan delivered" — and
-- an instruction attached to (this draft, this item) is what this table
-- holds. It carries no money and no percentages: the same computation
-- prices the reduced quantity exactly as it prices an unreduced one.
--
-- THE TWO EDITABLE STAGES ARE SUPPLY AND INSTALLATION, and the absence of
-- a third is deliberate. The ledger names the claimed challan and the
-- claimed installation. The acceptance-certificate stage is not editable
-- here because the owner's AMC ruling of the same session settles it the
-- other way for the one category that lives on it: "MBs always certify
-- the FULL period quantity; downtime penalties are BILL-TIME deductions
-- (PENALTY head), never short certificates." A short certificate is a
-- refusal this product makes, not an edit it offers.
--
-- WHERE THE CLAMP IS APPLIED, and why it is not applied here. This table
-- states the operator's number; `mb-compute.ts` applies
-- `min(override, measured)` beside `clampToSanctioned`, which is where
-- the module already decides what a book bills and why the draft preview,
-- the draft PDF and the finalize snapshot cannot disagree with each other.
-- So this migration's cap trigger is the SECOND layer, not the first: it
-- refuses an override written above what the draft's own claimed sources
-- measure at the moment it is written, and the computation clamps
-- afterwards for the case the sources move underneath it (a source
-- deselected after the override was saved). Neither layer can be dropped:
-- the trigger is what stops a raw writer, and the clamp is what keeps a
-- stale override from ever billing more than the evidence.
--
-- WHAT AN OVERRIDE DOES NOT DO. It never raises a quantity above what the
-- claimed sources measure, and never takes one below zero. The quantity
-- it leaves unmeasured is not lost: it stays outside this book exactly as
-- an over-installed quantity stays outside every book under 0077, and the
-- final Measurement Book's final-bill stage — whose base is the item's
-- LIFETIME delivered/installed quantity, not a delta over selected
-- sources — sweeps it up wherever the payment matrix gives that stage a
-- share. `docs/UX.md` § 25 states this in the operator's words.
--
-- OVERRIDES DIE WITH THE DRAFT. Deleting a draft deletes them (the
-- drafting route, beside the `mb_sources` delete it already does);
-- finalizing freezes them, because the guard below permits no mutation
-- once the parent book has left `draft`, and the finalized lines carry
-- the reduced quantity as the snapshot they always carried. Cancelling a
-- finalized book leaves them frozen too: they are the record of what that
-- book was told to measure.
--
-- SQLSTATE: the Measurement Book module owned no block; `23R` was free
-- and is taken here. 23R01 and 23R02 are this migration's; 23R03 is
-- 0107's.
-- ---------------------------------------------------------------------

CREATE TABLE mb_measured_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  measurement_book_id uuid NOT NULL,
  work_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  -- NULL means "no instruction for this stage", which is not the same as
  -- zero: zero is an operator saying "measure none of it from these
  -- sources", and it is a legal thing to say.
  measured_supplied quantity_amount
    CHECK (measured_supplied IS NULL OR measured_supplied >= 0),
  measured_installed quantity_amount
    CHECK (measured_installed IS NULL OR measured_installed >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A row saying nothing is a row that should not exist; the route
  -- deletes an emptied override rather than storing a pair of NULLs.
  CONSTRAINT mb_measured_overrides_says_something
    CHECK (num_nonnulls(measured_supplied, measured_installed) > 0),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, measurement_book_id, work_item_id),
  FOREIGN KEY (organisation_id, measurement_book_id, work_id)
    REFERENCES measurement_books(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, work_item_id, work_id)
    REFERENCES work_items(organisation_id, id, work_id)
);

COMMENT ON TABLE mb_measured_overrides IS
  'Per (draft Measurement Book, Work item) instruction to measure LESS than the claimed sources deliver, per stage. Owner ruling of 2026-08-19: a draft line''s measured quantity is editable downward only, capped at the claimed source quantity and floored at zero. Holds no money — the same computation prices a reduced quantity exactly as it prices an unreduced one.';

-- One index per composite foreign key, each leading on exactly that
-- key's columns (0046's rule, as `fk-index-coverage.integration.test.ts`
-- measures it: a non-partial index whose leading columns are the key's,
-- in order). The book index doubles as the computation's own read —
-- every override of one book at once, and the book is the only way in.
CREATE INDEX mb_measured_overrides_book_idx
  ON mb_measured_overrides (organisation_id, measurement_book_id, work_id);
CREATE INDEX mb_measured_overrides_item_idx
  ON mb_measured_overrides (organisation_id, work_item_id, work_id);

-- ── The guard: draft only, and never above the claimed measurement ────
--
-- IT READS THE SOURCES ITSELF rather than trusting a number the caller
-- also sent. The claimed measurement is `sum(quantity)` over the rows the
-- book's own live `mb_sources` claims point at, in their billable state —
-- the same two sums `ITEM_INPUTS_SQL`'s `delta_supplied` and
-- `delta_installed` CTEs take, restated here because a trigger cannot
-- call a query the application holds. Restating them is the point: a
-- writer that never goes near the route still meets the rule.
--
-- A NULL stage is not checked, because it states nothing. A stage whose
-- sources measure nothing caps at zero, so an override on a stage the
-- book does not claim can only ever be zero — which is the honest answer:
-- there is nothing there to reduce.
CREATE FUNCTION app_private.guard_mb_measured_override()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row mb_measured_overrides;
  v_book_status text;
  v_claimed numeric(18,3);
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  SELECT mb.status INTO v_book_status
  FROM measurement_books mb
  WHERE mb.organisation_id = v_row.organisation_id
    AND mb.id = v_row.measurement_book_id;

  IF v_book_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'a measured-quantity adjustment belongs to a draft Measurement Book; this one is %',
      coalesce(v_book_status, 'unreadable')
      USING ERRCODE = '23R02', CONSTRAINT = 'mb_override_book_not_draft';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.measured_supplied IS NOT NULL THEN
    SELECT coalesce(sum(dci.quantity), 0)::numeric(18,3) INTO v_claimed
    FROM mb_sources ms
    JOIN delivery_challans dc
      ON dc.organisation_id = ms.organisation_id
     AND dc.id = ms.source_id
     AND dc.status = 'issued'
    JOIN delivery_challan_items dci
      ON dci.delivery_challan_id = ms.source_id
    WHERE ms.organisation_id = NEW.organisation_id
      AND ms.measurement_book_id = NEW.measurement_book_id
      AND ms.source_type = 'delivery_challan'
      AND ms.released_at IS NULL
      AND dci.work_item_id = NEW.work_item_id;

    IF NEW.measured_supplied > v_claimed THEN
      RAISE EXCEPTION
        'the supplied quantity may be reduced, never raised: % exceeds the % this Measurement Book''s claimed delivery challans deliver',
        NEW.measured_supplied, v_claimed
        USING ERRCODE = '23R01', CONSTRAINT = 'mb_override_above_claimed';
    END IF;
  END IF;

  IF NEW.measured_installed IS NOT NULL THEN
    SELECT coalesce(sum(i.quantity), 0)::numeric(18,3) INTO v_claimed
    FROM mb_sources ms
    JOIN installations i
      ON i.organisation_id = ms.organisation_id
     AND i.id = ms.source_id
     AND i.status = 'recorded'
    WHERE ms.organisation_id = NEW.organisation_id
      AND ms.measurement_book_id = NEW.measurement_book_id
      AND ms.source_type = 'installation'
      AND ms.released_at IS NULL
      AND i.work_item_id = NEW.work_item_id;

    IF NEW.measured_installed > v_claimed THEN
      RAISE EXCEPTION
        'the installed quantity may be reduced, never raised: % exceeds the % this Measurement Book''s claimed installations record',
        NEW.measured_installed, v_claimed
        USING ERRCODE = '23R01', CONSTRAINT = 'mb_override_above_claimed';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_mb_measured_override() IS
  'Database half of the downward-only measured quantity (owner ruling of 2026-08-19): an adjustment exists only while its Measurement Book is a draft (23R02), and never states more than the book''s own claimed, unreleased, billable sources measure for that item (23R01). Re-derives the claimed totals from mb_sources rather than trusting the writer.';

-- Guard sorts alphabetically before the touch trigger, so a violation
-- raises before updated_at churn (the 0003 ordering note).
CREATE TRIGGER mb_measured_overrides_guard_mutation
BEFORE INSERT OR UPDATE OR DELETE ON mb_measured_overrides
FOR EACH ROW EXECUTE FUNCTION app_private.guard_mb_measured_override();

CREATE TRIGGER mb_measured_overrides_touch_updated_at
BEFORE UPDATE ON mb_measured_overrides
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE mb_measured_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE mb_measured_overrides FORCE ROW LEVEL SECURITY;

-- The 0069 initplan spelling: the tenant function is wrapped in a
-- scalar sub-select so the planner caches it once per statement.
CREATE POLICY mb_measured_overrides_tenant_policy ON mb_measured_overrides
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mb_measured_overrides TO auto_mb_app;
  END IF;
END
$$;
