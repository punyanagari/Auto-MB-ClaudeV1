SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Wave E: the defect liability period (DLP) that runs on a recorded
-- installation, and the Performance Bank Guarantee that has to outlive it.
--
-- ## What this pack is for
--
-- A railway supply-and-installation contract does not end when the units
-- go in. The agency warrants them for a stated period, the railway holds
-- the PBG until that period ends, and the two questions an office asks
-- every month are "what comes out of warranty soon" and "can this bank
-- guarantee be released yet". Neither was answerable: migration 0017
-- records WHAT went in and WHEN, 0022 records the railway's provisional
-- acceptance, 0016 records what the letter demands as a PBG, and nothing
-- joined the three into a period with an end date.
--
-- This migration adds that period, and nothing else. It mints no number,
-- issues no document and stores no money.
--
-- ## Two tables, and why they are two
--
--   `work_warranty_terms`      the CONTRACT term, one row per Work: how
--                              many months the DLP runs and what starts
--                              the clock. Policy — an operator may
--                              correct it, and correcting it never
--                              rewrites a period that has already begun.
--
--   `installation_warranties`  the PERIOD itself, one live row per
--                              installation record. It freezes the months
--                              and the basis it was started under, so a
--                              later edit of the terms above cannot move
--                              an expiry the railway is already holding a
--                              guarantee against (the 0013 snapshot-on-use
--                              posture, applied to a term instead of a
--                              name).
--
-- ## What is DERIVED and therefore not stored
--
-- Whether a live period is "expiring soon" or has "elapsed" is a
-- comparison against the organisation's own today, and it is computed on
-- read. Migration 0084's own review recorded the reason at length: a
-- stored copy of a computed fact is a field that can disagree with the
-- fact, and this one would disagree every midnight. The three stored
-- states are `active`, `closed` and `voided`, and every one of them is a
-- thing a person did.
--
-- The PBG cover reading is derived the same way and for the same reason:
-- it is the Work's latest DLP expiry against the expiry of the live
-- `work_instruments` row of kind 'pbg', compared at read time by the
-- route. Nothing here stores a shortfall.
--
-- ## The two dates, stated exactly
--
--   dlp_start_on    the day cover begins. On the 'installation' basis it
--                   is the installation's own `installed_on`; on the 'pac'
--                   basis it is the issue date of the PAC certificate that
--                   provisionally accepted the item. Both are legal dates
--                   and both are date-only (engineering rule 6).
--
--   dlp_expires_on  THE LAST DAY THE LIABILITY STANDS, not the first day
--                   after it. `app_private.warranty_expiry` states that
--                   once — start + N months, minus one day — and the
--                   insert derivation, the extension ceiling and every
--                   test read the same function, so the off-by-one this
--                   kind of date attracts has one place to be wrong in.
--                   PostgreSQL clamps a month addition to the end of the
--                   target month, so a 12-month period starting 31 March
--                   ends 30 March and a period starting 31 January ends
--                   30 January — the anniversary convention, not a
--                   day-count.
--
-- ## Extension, closure, and the way back out
--
-- A defect rectified inside the period extends it for the unit that was
-- repaired, so `dlp_expires_on` may move FORWARD, never back, and never
-- past ten years from the start. `original_expires_on` keeps the figure
-- the period began with, so an extended record still says what it was.
-- The reason for each extension is written to the audit trail rather than
-- to a third table: the Work's Timeline is where this product answers
-- "why does this run to 2029", and a table that duplicated it would be a
-- second place to look.
--
-- Closure is the operator recording that the period ran out and nothing
-- is outstanding. It is refused before the expiry and refused in the
-- future, which leaves exactly one way to undo a mistyped extension:
-- VOID the period with a note and start a new one. That is the
-- cancel-and-re-record path 0017 already gives an installation, and it is
-- deliberately the only escape — a closure date that could precede the
-- expiry would be the product asserting a discharge that had not happened.
--
-- ## What it does to installations
--
-- An installation carrying a period that is not voided cannot be
-- cancelled. Cancelling it would delete the ground the period stands on
-- while the railway still holds a guarantee against it, so the refusal
-- points at voiding the period first — the same shape 0022's certified
-- quantities already give the installations cancel path.
--
-- ## SQLSTATEs
--
-- Every RAISE in this file carries a code from the 23Q block, one per
-- rule, mapped in `apps/server/src/routes/warranty.ts` to a named refusal
-- and a remedy sentence. A guard that fires because a route's own check
-- lost a race reaches the operator as the sentence they would have got
-- from the route, never as an unexplained 500.

-- ---------------------------------------------------------------------
-- 1. The one definition of when a period ends.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.warranty_expiry(start_on date, months integer)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT (start_on + make_interval(months => months))::date - 1
$$;

COMMENT ON FUNCTION app_private.warranty_expiry(date, integer) IS
  'The last day a defect liability period covers: start + N months, minus one day. Every derivation and every ceiling in the warranty machinery calls this rather than repeating the arithmetic.';

-- ---------------------------------------------------------------------
-- 2. The Work's contract term.
-- ---------------------------------------------------------------------
CREATE TABLE work_warranty_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  -- Ten years is the ceiling everywhere in this pack: long enough for
  -- every railway term anybody writes, short enough that a mistyped
  -- "240" is refused rather than believed.
  dlp_months integer NOT NULL CHECK (dlp_months BETWEEN 1 AND 120),
  -- What starts the clock. 'installation' is the ordinary case; 'pac' is
  -- the contract that runs the warranty from provisional acceptance,
  -- which can be months after the units went in.
  start_basis text NOT NULL CHECK (start_basis IN ('installation', 'pac')),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
  recorded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One term per Work. This constraint's index is also what covers the
  -- foreign key below, so the table carries no index of its own.
  UNIQUE (organisation_id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

-- ---------------------------------------------------------------------
-- 3. The period.
-- ---------------------------------------------------------------------
CREATE TABLE installation_warranties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  -- Frozen from the Work's term at start time; a later correction of the
  -- term never reaches a period that has already begun.
  dlp_months integer NOT NULL CHECK (dlp_months BETWEEN 1 AND 120),
  start_basis text NOT NULL CHECK (start_basis IN ('installation', 'pac')),
  -- Provenance only, and deliberately not a live link: the period froze
  -- the certificate's issue date at start, so cancelling the certificate
  -- afterwards does not move an expiry the railway is holding a guarantee
  -- against. The row stays pointing at what it was started from, exactly
  -- as 0022 keeps `consignee_master_id` beside its snapshotted
  -- designation.
  pac_certificate_id uuid,
  dlp_start_on date NOT NULL,
  -- What the period began with, kept beside what it now runs to, so an
  -- extended record still says what it was.
  original_expires_on date NOT NULL,
  dlp_expires_on date NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed', 'voided')),
  closed_on date,
  closure_note text,
  closed_by_user_id text,
  closed_at timestamptz,
  void_note text,
  voided_by_user_id text,
  voided_at timestamptz,
  started_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  -- Composite through the Work on all three, so no row can name an
  -- installation, or a certificate, belonging to another Work — or
  -- another tenant.
  FOREIGN KEY (organisation_id, installation_id, work_id)
    REFERENCES installations(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, pac_certificate_id, work_id)
    REFERENCES pac_certificates(organisation_id, id, work_id),
  -- The basis and its certificate travel together in both directions: an
  -- installation-based period may not name one, and a PAC-based one must.
  CONSTRAINT installation_warranties_basis_shape_check
    CHECK ((start_basis = 'pac') = (pac_certificate_id IS NOT NULL)),
  -- A period that ended before it began is not a period.
  CONSTRAINT installation_warranties_window_check
    CHECK (dlp_expires_on >= dlp_start_on AND original_expires_on >= dlp_start_on),
  -- An extension moves the expiry forward, so what the row runs to is
  -- never earlier than what it began with.
  CONSTRAINT installation_warranties_extension_check
    CHECK (dlp_expires_on >= original_expires_on),
  -- Closure is complete or absent: the date, the note, the actor and the
  -- instant travel together, and the date is never inside the period it
  -- discharges.
  CONSTRAINT installation_warranties_closure_shape_check CHECK (
    (
      status = 'closed'
      AND closed_on IS NOT NULL AND closed_at IS NOT NULL
      AND closed_by_user_id IS NOT NULL
      AND length(btrim(closure_note)) >= 3
      AND closed_on >= dlp_expires_on
    )
    OR (
      status <> 'closed'
      AND closed_on IS NULL AND closed_at IS NULL
      AND closed_by_user_id IS NULL AND closure_note IS NULL
    )
  ),
  -- Voiding takes the 0017 cancellation shape: note, actor and instant
  -- together or not at all.
  CONSTRAINT installation_warranties_void_shape_check CHECK (
    (
      status = 'voided'
      AND voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL
      AND length(btrim(void_note)) >= 3
    )
    OR (
      status <> 'voided'
      AND voided_at IS NULL AND voided_by_user_id IS NULL AND void_note IS NULL
    )
  )
);

-- One live period per installation. A voided one releases the slot,
-- which is what makes "void and start again" the correction path; a
-- closed one does not, because a discharged period is the end of the
-- story for those units.
CREATE UNIQUE INDEX installation_warranties_one_live_per_installation
  ON installation_warranties (organisation_id, installation_id)
  WHERE status <> 'voided';

-- The Work's own card reads by Work and orders by expiry.
CREATE INDEX installation_warranties_work_idx
  ON installation_warranties (organisation_id, work_id, dlp_expires_on, id);

-- The register's question — what comes out of warranty next — is an
-- ordered scan of the live rows and nothing else.
CREATE INDEX installation_warranties_expiry_idx
  ON installation_warranties (organisation_id, dlp_expires_on, id)
  WHERE status = 'active';

-- Foreign-key coverage. Referential integrity cannot use a partial
-- index, so neither of the two above answers for the installation key;
-- these two are plain and exist for that reason (the standing audit in
-- `packages/db/test/fk-index-coverage.integration.test.ts`).
CREATE INDEX installation_warranties_installation_idx
  ON installation_warranties (organisation_id, installation_id);
CREATE INDEX installation_warranties_pac_idx
  ON installation_warranties (organisation_id, pac_certificate_id);

-- ---------------------------------------------------------------------
-- 4. The term's guard: provenance frozen, the term itself editable.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_work_warranty_terms_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF ROW(NEW.organisation_id, NEW.work_id, NEW.recorded_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.organisation_id, OLD.work_id, OLD.recorded_by_user_id, OLD.created_at)
  THEN
    RAISE EXCEPTION
      'the tenant, Work and provenance of a warranty term are immutable'
      USING ERRCODE = '23Q10';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------
-- 5. The period's guard. Both directions of every rule the route also
--    checks, so a writer that reached the table another way — or a route
--    check that lost a race — meets the same refusal.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_installation_warranty()
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
    END IF;

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

CREATE FUNCTION app_private.guard_installation_warranty_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION
    'defect liability periods are voided with a note; they are never deleted'
    USING ERRCODE = '23Q08';
END
$$;

-- ---------------------------------------------------------------------
-- 6. What a live period does to its installation.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_installation_warranty_cancel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM installation_warranties w
    WHERE w.organisation_id = OLD.organisation_id
      AND w.installation_id = OLD.id
      AND w.status <> 'voided'
  ) THEN
    RAISE EXCEPTION
      'this installation carries a defect liability period that has not been voided'
      USING ERRCODE = '23Q09';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------
-- 7. Triggers. Every guard sorts alphabetically before its table's touch
--    trigger, so a refused write raises before updated_at moves (the
--    0003 ordering note).
-- ---------------------------------------------------------------------
CREATE TRIGGER work_warranty_terms_guard_update
BEFORE UPDATE ON work_warranty_terms
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_warranty_terms_update();

CREATE TRIGGER work_warranty_terms_touch_updated_at
BEFORE UPDATE ON work_warranty_terms
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TRIGGER installation_warranties_guard_delete
BEFORE DELETE ON installation_warranties
FOR EACH ROW EXECUTE FUNCTION app_private.guard_installation_warranty_delete();

CREATE TRIGGER installation_warranties_guard_transition
BEFORE INSERT OR UPDATE ON installation_warranties
FOR EACH ROW EXECUTE FUNCTION app_private.guard_installation_warranty();

CREATE TRIGGER installation_warranties_touch_updated_at
BEFORE UPDATE ON installation_warranties
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- WHEN-gated on the one transition it has anything to say about. Ungated
-- it would run the EXISTS on every installation write — the recording of
-- each new record included, where the answer cannot be anything but
-- false.
CREATE TRIGGER installations_guard_warranty_cancel
BEFORE UPDATE ON installations
FOR EACH ROW
WHEN (OLD.status = 'recorded' AND NEW.status = 'cancelled')
EXECUTE FUNCTION app_private.guard_installation_warranty_cancel();

-- ---------------------------------------------------------------------
-- 8. RLS, in the ADR-0010 InitPlan shape on both tables.
-- ---------------------------------------------------------------------
ALTER TABLE work_warranty_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_warranty_terms FORCE ROW LEVEL SECURITY;
ALTER TABLE installation_warranties ENABLE ROW LEVEL SECURITY;
ALTER TABLE installation_warranties FORCE ROW LEVEL SECURITY;

CREATE POLICY work_warranty_terms_tenant_policy ON work_warranty_terms
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
CREATE POLICY installation_warranties_tenant_policy ON installation_warranties
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- ---------------------------------------------------------------------
-- 9. Grants. A period is the record that a warranty ran: it is voided
--    with a note, never removed, so neither table hands out a DELETE.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON work_warranty_terms TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE ON installation_warranties TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION
      app_private.warranty_expiry(date, integer) TO auto_mb_app;
  END IF;
END
$$;
