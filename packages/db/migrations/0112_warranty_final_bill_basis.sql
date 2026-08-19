SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- Migration 0112: a defect liability period may start from the Work's
-- FINAL BILL.
--
-- Numbering: 0105 to 0111 are claimed by packs that have not merged yet,
-- so this corrections pack takes 0112. The runner sorts file names and
-- requires only that ids be unique
-- (`packages/db/src/migration-runner.ts`), so the gap costs nothing and
-- the merge-down that brings the others in needs no renumbering here.
--
-- ## The rule
--
-- Migration 0099 shipped two contract shapes for when a warranty starts:
-- the installation date, and the issue date of the PAC certificate that
-- provisionally accepted the item. A third is common in railway works
-- letters and had nowhere to live — the clock starts when the FINAL BILL
-- is raised, which is the moment the contract's execution is complete
-- and the agency's liability turns from delivery into defects.
--
-- Owner ruling of 2026-08-19: the basis ships, and the start date is
-- PINNED to the final bill's date exactly, the way 0099's own review
-- pinned the other two. Not bracketed into a window, not defaulted with
-- an override: one date, refused if it is any other date, and refused
-- outright while the Work has no final bill at all.
--
-- ## WHAT "THE WORK'S FINAL BILL'S DATE" IS, stated honestly
--
-- `bills` carries NO date column. It has `created_at`, which is the
-- instant a row was written and not a legal date, and engineering rule 6
-- is explicit that a legal date is a date-only value that is never
-- timezone-round-tripped. So there is no "bill date" column to pin to
-- and this migration does not invent one.
--
-- What a bill DOES carry is `mb_id` (0024 § 7): since ADR-0006 decision
-- 2 a bill is prepared FROM a finalized Measurement Book, one to one,
-- and that Book carries `mb_date` — a real legal date, refused in the
-- future and refused before the Work's LOA letter date by 0024's own
-- date guard. The final bill is therefore the bill prepared from the
-- Work's FINAL Measurement Book (`measurement_books.is_final`), and the
-- date this basis pins to is that Book's `mb_date`.
--
-- Three properties make that a single, unambiguous date rather than a
-- lookup that could return two answers:
--
--   * `measurement_books_one_live_final_per_work` (0024) admits one
--     non-cancelled final Book per Work;
--   * `bills_one_per_mb` (0024) admits one bill per Book;
--   * a billed Book cannot be cancelled at all — the finalize module
--     refuses it ("billed Measurement Books cannot be cancelled —
--     correct with compensating entries on the next MB"), which is why
--     the `status = 'finalized'` arm below is a belt rather than a
--     filter that ever changes the answer.
--
-- The lookup is written with that `finalized` requirement anyway, for
-- the reason 0099's own guards give for stating a rule twice: a guard
-- that assumes another module's refusal is a guard that stops working
-- when that module changes.
--
-- ## What is NOT changed
--
-- `installation_warranties_basis_shape_check` already reads
-- `(start_basis = 'pac') = (pac_certificate_id IS NOT NULL)`, which is
-- exactly right for a third basis that names no certificate: a
-- final-bill period carries none, and the constraint refuses one.
--
-- The 0099 rule that a period never starts before its installation date
-- (23Q02) is untouched and still applies. A final bill dated before the
-- units went in would be refused by it, and that refusal is correct: the
-- defect liability on a unit cannot begin before the unit is installed.
--
-- ## The ordering this basis inherits, stated because it surprises
--
-- A Work carrying a live final Measurement Book REFUSES new
-- installations outright — "recording this installation would create a
-- source that can never be billed" (0027, restated by 0031). So on this
-- basis every installation a period could attach to necessarily exists
-- before the bill that dates it, and the operator's sequence is fixed:
-- record the installations, finalise the final Book, prepare its bill,
-- then start the periods. That is not a rule this migration adds; it is
-- one it inherits, and it is why the refusal above points at the
-- Measurement Book rather than at a date field.
--
-- It does NOT make the 23Q02 arm unreachable. An installation recorded
-- before the final Book may still be DATED after the Book's own
-- `mb_date` — both are only bounded by today — so a final bill can still
-- predate the units, and that period is still refused.
--
-- ## SQLSTATE
--
-- One new code, 23Q11, the next free one in the block 0099 opened. It is
-- mapped in `apps/server/src/routes/warranty.ts` to a named refusal and
-- a remedy sentence, exactly as the ten before it are, so a guard that
-- fires because the route's own check lost a race reaches the operator
-- as a sentence rather than as a 500.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. The two basis vocabularies.
-- ---------------------------------------------------------------------
ALTER TABLE work_warranty_terms
  DROP CONSTRAINT work_warranty_terms_start_basis_check;
ALTER TABLE work_warranty_terms
  ADD CONSTRAINT work_warranty_terms_start_basis_check
  CHECK (start_basis IN ('installation', 'pac', 'final_bill'));

ALTER TABLE installation_warranties
  DROP CONSTRAINT installation_warranties_start_basis_check;
ALTER TABLE installation_warranties
  ADD CONSTRAINT installation_warranties_start_basis_check
  CHECK (start_basis IN ('installation', 'pac', 'final_bill'));

-- ---------------------------------------------------------------------
-- 2. The one definition of the Work's final bill date.
--
-- A function rather than a repeated join, because the guard below and
-- the route both have to answer the same question and an office that got
-- two answers to "what date does this period start on" would have no way
-- to tell which was the record. `STABLE`, not `IMMUTABLE`: it reads
-- tables.
--
-- SECURITY INVOKER (the default, stated here because it is load-bearing
-- rather than incidental): it runs as whoever calls it, so row-level
-- security applies and a caller with no tenant bound sees nothing and
-- gets NULL — which the guard turns into a refusal rather than into a
-- period seated on a bill nobody proved exists. That is the 0099 posture
-- for the installation lookup, applied to this one.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.work_final_bill_date(
  p_organisation_id uuid, p_work_id uuid
)
RETURNS date
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT mb.mb_date
  FROM bills b
  JOIN measurement_books mb
    ON mb.organisation_id = b.organisation_id AND mb.id = b.mb_id
  WHERE b.organisation_id = p_organisation_id
    AND b.work_id = p_work_id
    AND mb.is_final
    AND mb.status = 'finalized'
  ORDER BY mb.mb_date, b.bill_number
  LIMIT 1
$$;

COMMENT ON FUNCTION app_private.work_final_bill_date(uuid, uuid) IS
  'The date of the Work''s final bill: the mb_date of the finalized final Measurement Book the bill was prepared from. bills carries no date column of its own, and this is the legal date behind it. NULL where the Work has no final bill.';

-- ---------------------------------------------------------------------
-- 3. The period's guard, with the third basis arm.
--
-- Restated whole rather than patched, because a plpgsql function has no
-- partial replacement and a reader comparing this to 0099 should see one
-- file per version of the rule. Everything outside the marked arm is
-- byte-identical to 0099 § 5.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.guard_installation_warranty()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_installation_status text;
  v_installed_on date;
  v_work_item_id uuid;
  v_today date;
  v_pac_status text;
  v_pac_issue_date date;
  v_pac_covers boolean;
  v_final_bill_date date;
BEGIN
  v_today := app_private.organisation_today(NEW.organisation_id);

  IF TG_OP = 'INSERT' THEN
    -- Runs as the INVOKING role deliberately (the 0017 posture): if the
    -- parent installation is invisible because no tenant is bound, the
    -- lookup yields NULL and the insert is refused rather than waved
    -- through on a row nobody proved exists.
    SELECT i.status, i.installed_on, i.work_item_id
      INTO v_installation_status, v_installed_on, v_work_item_id
    FROM installations i
    WHERE i.organisation_id = NEW.organisation_id AND i.id = NEW.installation_id
    FOR SHARE;

    IF v_installation_status IS DISTINCT FROM 'recorded' THEN
      RAISE EXCEPTION
        'a defect liability period attaches only to a recorded installation'
        USING ERRCODE = '23Q01';
    END IF;

    IF NEW.dlp_start_on < v_installed_on THEN
      RAISE EXCEPTION
        'the defect liability period starts on %, before the installation date %',
        NEW.dlp_start_on, v_installed_on
        USING ERRCODE = '23Q02';
    -- The PIN, not just the bracket. The header above says an
    -- installation-based period starts on the installation's own
    -- `installed_on`, and `routes/warranty.ts` writes exactly that — but
    -- this guard used only to bracket the date into [installed_on,
    -- today], which is a window months wide. A writer that did not come
    -- through the route could seat a period weeks late and shorten the
    -- cover the railway is holding a guarantee against, and the file's
    -- own header would have said that could not happen. The 'pac' arm
    -- below pins its date exactly; this is the same rule stated for the
    -- other basis, so both layers now say the one thing.
    ELSIF NEW.start_basis = 'installation' AND NEW.dlp_start_on <> v_installed_on THEN
      RAISE EXCEPTION
        'an installation-based defect liability period starts on the installation date %, not %',
        v_installed_on, NEW.dlp_start_on
        USING ERRCODE = '23Q02';
    END IF;

    -- Kept as a backstop rather than removed, though it is now
    -- unreachable on all three bases: the pin above forces the
    -- 'installation' basis onto `installed_on`, which 0017 already
    -- refuses in the future; the 'pac' pin forces the second onto a
    -- certificate issue date, which 0022 refuses in the future the same
    -- way; and the 'final_bill' pin forces the third onto an `mb_date`,
    -- which 0024's own date guard refuses in the future for the third
    -- time. It survives because it is the only arm that would still fire
    -- if any of those upstream rules were ever relaxed, and a period
    -- whose cover starts in the future is the one error here that reads
    -- as valid on every screen.
    IF NEW.dlp_start_on > v_today THEN
      RAISE EXCEPTION
        'the defect liability period starts on %, which is in the future (today is % in the organisation timezone)',
        NEW.dlp_start_on, v_today
        USING ERRCODE = '23Q02';
    END IF;

    IF NEW.start_basis = 'pac' THEN
      SELECT pc.status, pc.issue_date,
             EXISTS (
               SELECT 1 FROM pac_certificate_items pci
               WHERE pci.organisation_id = pc.organisation_id
                 AND pci.pac_certificate_id = pc.id
                 AND pci.work_item_id = v_work_item_id
             )
        INTO v_pac_status, v_pac_issue_date, v_pac_covers
      FROM pac_certificates pc
      WHERE pc.organisation_id = NEW.organisation_id
        AND pc.id = NEW.pac_certificate_id
        -- The Work as well as the tenant, and that is not belt and
        -- braces. The composite foreign key below would refuse a
        -- certificate of another Work too, but it refuses it as a 23503
        -- raised at constraint-check time, which no route maps and an
        -- operator therefore meets as a 500. Matching the Work here
        -- turns the same refusal into this block's own code.
        AND pc.work_id = NEW.work_id;

      IF v_pac_status IS DISTINCT FROM 'recorded' THEN
        RAISE EXCEPTION
          'the PAC certificate a defect liability period starts from must be a recorded certificate of the same Work'
          USING ERRCODE = '23Q03';
      END IF;
      IF v_pac_covers IS DISTINCT FROM true THEN
        RAISE EXCEPTION
          'the PAC certificate does not certify the item this installation recorded'
          USING ERRCODE = '23Q03';
      END IF;
      IF NEW.dlp_start_on <> v_pac_issue_date THEN
        RAISE EXCEPTION
          'a PAC-based defect liability period starts on the certificate issue date %, not %',
          v_pac_issue_date, NEW.dlp_start_on
          USING ERRCODE = '23Q03';
      END IF;
    END IF;

    -- 0112: the third basis. Two refusals, in the order an operator
    -- meets them — there is no final bill at all, or there is one and
    -- this period is not seated on its date. The second is the whole
    -- point of the basis: "starts when the final bill is raised" is a
    -- date the contract fixes, not a date a writer chooses, so a period
    -- a day either side of it is a day of cover the railway is holding a
    -- guarantee against and nobody agreed to.
    IF NEW.start_basis = 'final_bill' THEN
      v_final_bill_date := app_private.work_final_bill_date(
        NEW.organisation_id, NEW.work_id
      );
      IF v_final_bill_date IS NULL THEN
        RAISE EXCEPTION
          'this Work has no final bill, so a final-bill defect liability period has no date to start from'
          USING ERRCODE = '23Q11';
      END IF;
      IF NEW.dlp_start_on <> v_final_bill_date THEN
        RAISE EXCEPTION
          'a final-bill defect liability period starts on the final bill date %, not %',
          v_final_bill_date, NEW.dlp_start_on
          USING ERRCODE = '23Q11';
      END IF;
    END IF;

    -- ONE definition of the end date, and the writer does not get a vote.
    -- Both columns are overwritten from the function above, so a route,
    -- a fixture and a hand-written statement cannot each arrive at a
    -- different answer (the 0077 `NEW.pending_variation :=` posture).
    NEW.dlp_expires_on := app_private.warranty_expiry(NEW.dlp_start_on, NEW.dlp_months);
    NEW.original_expires_on := NEW.dlp_expires_on;

    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION
        'a defect liability period is created active, not as %', NEW.status
        USING ERRCODE = '23Q04';
    END IF;

    -- The two end-of-period column groups belong to acts that have not
    -- happened yet. Said here rather than left to the shape CHECKs below,
    -- because a CHECK raises 23514, which no route maps and every
    -- operator therefore meets as a 500.
    IF NEW.closed_on IS NOT NULL OR NEW.closed_at IS NOT NULL
       OR NEW.closed_by_user_id IS NOT NULL OR NEW.closure_note IS NOT NULL
       OR NEW.voided_at IS NOT NULL OR NEW.voided_by_user_id IS NOT NULL
       OR NEW.void_note IS NOT NULL
    THEN
      RAISE EXCEPTION
        'a defect liability period is created with no closure or void record on it'
        USING ERRCODE = '23Q07';
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE. Closed and voided are terminal: a discharged period is the
  -- record that the liability ended, and a voided one is the record that
  -- it should never have started.
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION
      'a % defect liability period is immutable', OLD.status
      USING ERRCODE = '23Q04';
  END IF;

  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.installation_id, NEW.dlp_months,
    NEW.start_basis, NEW.pac_certificate_id, NEW.dlp_start_on,
    NEW.original_expires_on, NEW.started_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.installation_id, OLD.dlp_months,
    OLD.start_basis, OLD.pac_certificate_id, OLD.dlp_start_on,
    OLD.original_expires_on, OLD.started_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'defect liability period business data is immutable; void the period and start it again instead'
      USING ERRCODE = '23Q05';
  END IF;

  IF NEW.dlp_expires_on IS DISTINCT FROM OLD.dlp_expires_on THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION
        'extend the defect liability period or end it, not both in one write'
        USING ERRCODE = '23Q06';
    END IF;
    IF NEW.dlp_expires_on <= OLD.dlp_expires_on THEN
      RAISE EXCEPTION
        'a defect liability period is extended forward: % does not follow %',
        NEW.dlp_expires_on, OLD.dlp_expires_on
        USING ERRCODE = '23Q06';
    END IF;
    IF NEW.dlp_expires_on > app_private.warranty_expiry(NEW.dlp_start_on, 120) THEN
      RAISE EXCEPTION
        'a defect liability period cannot run past % — ten years from its start',
        app_private.warranty_expiry(NEW.dlp_start_on, 120)
        USING ERRCODE = '23Q06';
    END IF;
  END IF;

  IF NEW.status = 'closed' THEN
    -- Completeness first, and with a mapped code: the shape CHECK below
    -- would raise 23514, which reaches an operator as a 500.
    IF NEW.closed_on IS NULL OR NEW.closed_at IS NULL
       OR NEW.closed_by_user_id IS NULL
       OR length(btrim(coalesce(NEW.closure_note, ''))) < 3
    THEN
      RAISE EXCEPTION
        'closing a defect liability period records the date, who closed it, and a note of at least three characters'
        USING ERRCODE = '23Q07';
    END IF;
    IF NEW.closed_on < NEW.dlp_expires_on THEN
      RAISE EXCEPTION
        'the defect liability period runs to %; it cannot be closed on %',
        NEW.dlp_expires_on, NEW.closed_on
        USING ERRCODE = '23Q07';
    END IF;
    IF NEW.closed_on > v_today THEN
      RAISE EXCEPTION
        'a defect liability period cannot be closed on %, which is in the future (today is % in the organisation timezone)',
        NEW.closed_on, v_today
        USING ERRCODE = '23Q07';
    END IF;
  END IF;

  IF NEW.status = 'voided' THEN
    IF NEW.voided_at IS NULL OR NEW.voided_by_user_id IS NULL
       OR length(btrim(coalesce(NEW.void_note, ''))) < 3
    THEN
      RAISE EXCEPTION
        'voiding a defect liability period records who voided it and a note of at least three characters'
        USING ERRCODE = '23Q07';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------
-- 4. Grant. The route reads the same function the guard enforces with,
--    so it must be callable by the application role — the 0099 posture
--    for `warranty_expiry` beside it.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION
      app_private.work_final_bill_date(uuid, uuid) TO auto_mb_app;
  END IF;
END
$$;
