SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 8 phase 2: the stage-wise Measurement Book lifecycle
-- (ADR-0006; legacy spec §5.9, rule R19). An MB is built from a Work's
-- open sources (issued delivery challans, recorded installations,
-- recorded PAC certificates), bills only the DELTAS since the previous
-- MB, and finalises into an immutable snapshot: per-item stage deltas,
-- the prior-cumulative memory, the resolved payment percentages, the
-- rate, the computed stage amounts, and the contractual remark text.
-- Drafts recompute from live state and may be deleted; finalisation
-- assigns <work_code>-MB-NN gap-free under a per-Work counter lock;
-- only the newest live MB may be cancelled (releasing its sources); a
-- final MB (is_final) closes the payment cycle — no further MBs.
--
-- bills stays the payment record (ADR-0006 decision 2): a bill is now
-- prepared FROM a finalized MB (1:1 via bills.mb_id), and the
-- Milestone 5 sweep of unbilled mb_entries is removed at the API.
-- mb_entries itself stays as site measurement evidence (decision 4).

-- 1. The Measurement Book document.
CREATE TABLE measurement_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'finalized', 'cancelled')),
  -- The final MB bills the final-bill stage and closes the Work's
  -- payment cycle. One live final MB per Work (partial unique below);
  -- while it lives, no further MB may be raised (insert guard below).
  is_final boolean NOT NULL DEFAULT false,
  mb_date date NOT NULL,
  mb_number text,
  sequence_number integer CHECK (sequence_number IS NULL OR sequence_number > 0),
  -- Finalize-written: SUM of the line-rounded line totals (R13), never
  -- recomputed afterwards.
  total_amount numeric(18,2) CHECK (total_amount IS NULL OR total_amount >= 0),
  -- The remark wording template the snapshotted line remarks were
  -- rendered with (mb-remark.ts MB_REMARK_TEMPLATE_VERSION); historical
  -- MBs are never re-rendered.
  remark_template_version text,
  cancellation_note text,
  created_by_user_id text NOT NULL,
  finalized_by_user_id text,
  cancelled_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, id, work_id),
  UNIQUE (organisation_id, mb_number),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  -- Status shape: a draft carries no number, total, template version or
  -- finalize stamps; a finalized (or later cancelled) MB carries all.
  CHECK (
    (status = 'draft' AND mb_number IS NULL AND sequence_number IS NULL AND total_amount IS NULL AND remark_template_version IS NULL AND finalized_at IS NULL AND finalized_by_user_id IS NULL)
    OR
    (status IN ('finalized', 'cancelled') AND mb_number IS NOT NULL AND sequence_number IS NOT NULL AND total_amount IS NOT NULL AND remark_template_version IS NOT NULL AND finalized_at IS NOT NULL AND finalized_by_user_id IS NOT NULL)
  ),
  -- Cancellation is complete or absent, NULL-proof (0023 restatement
  -- style): note (>= 3 chars), actor and time travel together.
  CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND cancellation_note IS NOT NULL AND length(btrim(cancellation_note)) >= 3)
    OR
    (status <> 'cancelled' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_note IS NULL)
  )
);

-- One open draft per Work (R19; the API answers the conflict with the
-- existing draft's id, DraftConflictDetails shape).
CREATE UNIQUE INDEX measurement_books_one_draft_per_work
  ON measurement_books (organisation_id, work_id)
  WHERE status = 'draft';

-- One live final MB per Work, in any non-cancelled status.
CREATE UNIQUE INDEX measurement_books_one_live_final_per_work
  ON measurement_books (organisation_id, work_id)
  WHERE is_final AND status <> 'cancelled';

-- Sequence numbers serialised per Work at the database, mirroring
-- delivery_challans_sequence_per_work: two MBs on one Work can never
-- share a sequence number even if the counter is corrupted.
CREATE UNIQUE INDEX measurement_books_sequence_per_work
  ON measurement_books (organisation_id, work_id, sequence_number)
  WHERE sequence_number IS NOT NULL;

CREATE INDEX measurement_books_work_idx
  ON measurement_books (organisation_id, work_id, status, mb_date DESC, id);

-- 2. The finalized lines: one row per item per MB, written ONLY inside
-- the finalize transaction (the mutation guard requires the parent to
-- still be draft at INSERT time and freezes rows entirely afterwards).
-- Every column is a snapshot: later matrix, category, or rate edits
-- never alter a finalised MB (ADR-0006 decision 5).
CREATE TABLE measurement_book_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  measurement_book_id uuid NOT NULL,
  work_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  -- Item snapshot.
  item_number text NOT NULL,
  description text NOT NULL,
  unit_code text NOT NULL,
  payment_category text,
  resolved_category text NOT NULL,
  -- The matrix row's percentages, verbatim numeric(5,2).
  pct_supply numeric(5,2) NOT NULL CHECK (pct_supply BETWEEN 0 AND 100),
  pct_installation numeric(5,2) NOT NULL CHECK (pct_installation BETWEEN 0 AND 100),
  pct_pac numeric(5,2) NOT NULL CHECK (pct_pac BETWEEN 0 AND 100),
  pct_final_bill numeric(5,2) NOT NULL CHECK (pct_final_bill BETWEEN 0 AND 100),
  effective_rate numeric(18,2) NOT NULL CHECK (effective_rate >= 0),
  -- This MB's per-stage delta quantities. delta_final_bill is the
  -- final-MB base-minus-prior; 0 on every non-final MB.
  delta_supplied numeric(18,3) NOT NULL DEFAULT 0 CHECK (delta_supplied >= 0),
  delta_installed numeric(18,3) NOT NULL DEFAULT 0 CHECK (delta_installed >= 0),
  delta_pac numeric(18,3) NOT NULL DEFAULT 0 CHECK (delta_pac >= 0),
  delta_final_bill numeric(18,3) NOT NULL DEFAULT 0 CHECK (delta_final_bill >= 0),
  -- The TRUE-cumulative memory at finalize time: per stage, the sum of
  -- deltas over all prior non-cancelled finalized MBs (spec: "Cumulative
  -- means true cumulative").
  prior_supplied numeric(18,3) NOT NULL DEFAULT 0 CHECK (prior_supplied >= 0),
  prior_installed numeric(18,3) NOT NULL DEFAULT 0 CHECK (prior_installed >= 0),
  prior_pac numeric(18,3) NOT NULL DEFAULT 0 CHECK (prior_pac >= 0),
  prior_final_bill numeric(18,3) NOT NULL DEFAULT 0 CHECK (prior_final_bill >= 0),
  -- Stage amounts: round2(delta × rate × pct / 100), line-rounded then
  -- summed into line_total (R13; computed by computeStageAmounts).
  amount_supply numeric(18,2) NOT NULL,
  amount_installation numeric(18,2) NOT NULL,
  amount_pac numeric(18,2) NOT NULL,
  amount_final_bill numeric(18,2) NOT NULL,
  line_total numeric(18,2) NOT NULL,
  -- The contractual remark, rendered by computeMbRemark under the
  -- parent's remark_template_version, character-for-character.
  remark text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, measurement_book_id, work_item_id),
  FOREIGN KEY (organisation_id, measurement_book_id, work_id)
    REFERENCES measurement_books(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, work_item_id, work_id)
    REFERENCES work_items(organisation_id, id, work_id)
);

-- The prior-cumulative scan sums deltas per item over the Work's
-- finalized MBs; keep it narrow.
CREATE INDEX measurement_book_lines_item_idx
  ON measurement_book_lines (organisation_id, work_item_id);
CREATE INDEX measurement_book_lines_book_idx
  ON measurement_book_lines (organisation_id, measurement_book_id);

-- 3. Source claims. A draft claims its sources when they are selected;
-- finalize keeps the claims; cancel releases them by stamping
-- released_at; deleting a draft removes its rows. The partial unique
-- index IS the R19 "billed by at most one live MB, ever" rule — held by
-- the database against every writer, not by application queries.
CREATE TABLE mb_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  measurement_book_id uuid NOT NULL,
  work_id uuid NOT NULL,
  source_type text NOT NULL
    CHECK (source_type IN ('delivery_challan', 'installation', 'pac_certificate')),
  source_id uuid NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, measurement_book_id, work_id)
    REFERENCES measurement_books(organisation_id, id, work_id)
);

CREATE UNIQUE INDEX mb_sources_one_live_per_source
  ON mb_sources (organisation_id, source_type, source_id)
  WHERE released_at IS NULL;

CREATE INDEX mb_sources_book_idx
  ON mb_sources (organisation_id, measurement_book_id);

-- 4. Gapless per-Work numbering state, exactly the DC/IC counter
-- mechanism (0014): the counter row lock orders concurrent finalizes,
-- rollback rolls the counter back with the transaction, and the 0003
-- decrease guard keeps numbers from being reused.
CREATE TABLE measurement_book_counters (
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

CREATE TRIGGER measurement_book_counters_guard_decrease
BEFORE UPDATE ON measurement_book_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

CREATE TRIGGER measurement_book_counters_touch_updated_at
BEFORE UPDATE ON measurement_book_counters
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- 5. Measurement Book lifecycle guards. Forward-only: draft -> finalized
-- -> cancelled; drafts delete rather than cancel; a finalized MB's
-- business data is frozen; a cancelled MB never changes.
CREATE FUNCTION app_private.guard_measurement_book_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled Measurement Books are immutable';
  END IF;

  IF OLD.status = 'finalized' THEN
    IF NEW.status NOT IN ('finalized', 'cancelled') THEN
      RAISE EXCEPTION 'finalized Measurement Books may only remain finalized or be cancelled';
    END IF;
    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.is_final, NEW.mb_date,
      NEW.mb_number, NEW.sequence_number, NEW.total_amount,
      NEW.remark_template_version, NEW.created_by_user_id,
      NEW.finalized_by_user_id, NEW.created_at, NEW.finalized_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.is_final, OLD.mb_date,
      OLD.mb_number, OLD.sequence_number, OLD.total_amount,
      OLD.remark_template_version, OLD.created_by_user_id,
      OLD.finalized_by_user_id, OLD.created_at, OLD.finalized_at
    ) THEN
      RAISE EXCEPTION 'finalized Measurement Book business data is immutable';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Measurement Books are deleted, not cancelled';
  END IF;

  RETURN NEW;
END
$$;

CREATE FUNCTION app_private.guard_measurement_book_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'only draft Measurement Books may be deleted';
  END IF;
  RETURN OLD;
END
$$;

-- No new MB while a live final MB exists for the Work (spec: "Once a
-- final MB exists (any non-cancelled status), no further MBs can be
-- raised"). Runs as the invoking role: same-tenant writers see the
-- final MB through RLS; with no tenant bound the FKs still hold.
CREATE FUNCTION app_private.guard_measurement_book_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM measurement_books mb
    WHERE mb.organisation_id = NEW.organisation_id
      AND mb.work_id = NEW.work_id
      AND mb.is_final
      AND mb.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'a final Measurement Book exists for this Work; no further Measurement Books can be raised'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Product date invariant (R11 shape), held in the database: an MB date
-- is never in the future ("today" in the organisation's own timezone)
-- and never precedes the Work's LOA letter date — the 0010 challan
-- guard, mirrored for mb_date exactly as 0017/0022 mirrored it. Steps
-- aside when the works row is invisible; the foreign keys still hold.
CREATE FUNCTION app_private.guard_measurement_book_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_letter_date date;
  v_today date;
BEGIN
  SELECT w.letter_date, (now() AT TIME ZONE o.timezone)::date
    INTO v_letter_date, v_today
  FROM works w
  JOIN organisations o ON o.id = w.organisation_id
  WHERE w.id = NEW.work_id;

  IF v_letter_date IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.mb_date > v_today THEN
    RAISE EXCEPTION 'mb_date % is in the future (today is % in the organisation timezone)',
      NEW.mb_date, v_today
      USING ERRCODE = '23514';
  END IF;

  IF NEW.mb_date < v_letter_date THEN
    RAISE EXCEPTION 'mb_date % precedes the LOA letter date %',
      NEW.mb_date, v_letter_date
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- Lines: INSERT only while the parent MB is still draft (i.e. inside
-- the finalize transaction, before the status flip); no UPDATE, no
-- DELETE, ever — the lines ARE the finalised legal snapshot. Runs as
-- the invoking role — an invisible parent yields NULL and the mutation
-- is refused rather than waved through (0017/0022 posture).
CREATE FUNCTION app_private.guard_measurement_book_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Measurement Book lines are part of the finalised snapshot; they are never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Measurement Book lines are immutable once written';
  END IF;

  SELECT status INTO parent_status
  FROM measurement_books
  WHERE organisation_id = NEW.organisation_id AND id = NEW.measurement_book_id;

  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Measurement Book lines are written only by the finalize transaction';
  END IF;
  RETURN NEW;
END
$$;

-- Source claims: INSERT only onto a draft MB, and only for a real
-- source of the same organisation AND the MB's Work in its billable
-- state (challan issued; installation recorded; PAC recorded). DELETE
-- only while the MB is draft (selection replacement / draft deletion).
-- The only permitted UPDATE is the one-way release stamped by the
-- cancel transaction. Runs as the invoking role — invisible rows refuse
-- rather than wave through.
CREATE FUNCTION app_private.guard_mb_source_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  book_status text;
  book_work uuid;
  source_state text;
  source_work uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO book_status
    FROM measurement_books
    WHERE organisation_id = OLD.organisation_id AND id = OLD.measurement_book_id;
    IF book_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Measurement Book source claims are released by cancellation, never deleted, once the book is finalized';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT status, work_id INTO book_status, book_work
    FROM measurement_books
    WHERE organisation_id = NEW.organisation_id AND id = NEW.measurement_book_id;
    IF book_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'sources are selected while the Measurement Book is draft';
    END IF;

    IF NEW.source_type = 'delivery_challan' THEN
      SELECT dc.status, dc.work_id INTO source_state, source_work
      FROM delivery_challans dc
      WHERE dc.organisation_id = NEW.organisation_id AND dc.id = NEW.source_id;
      IF source_work IS NULL OR source_work IS DISTINCT FROM book_work THEN
        RAISE EXCEPTION 'the claimed delivery challan does not belong to the Measurement Book''s Work';
      END IF;
      IF source_state IS DISTINCT FROM 'issued' THEN
        RAISE EXCEPTION 'only issued delivery challans are billable Measurement Book sources';
      END IF;
    ELSIF NEW.source_type = 'installation' THEN
      SELECT i.status, i.work_id INTO source_state, source_work
      FROM installations i
      WHERE i.organisation_id = NEW.organisation_id AND i.id = NEW.source_id;
      IF source_work IS NULL OR source_work IS DISTINCT FROM book_work THEN
        RAISE EXCEPTION 'the claimed installation does not belong to the Measurement Book''s Work';
      END IF;
      IF source_state IS DISTINCT FROM 'recorded' THEN
        RAISE EXCEPTION 'only recorded installations are billable Measurement Book sources';
      END IF;
    ELSE
      SELECT pc.status, pc.work_id INTO source_state, source_work
      FROM pac_certificates pc
      WHERE pc.organisation_id = NEW.organisation_id AND pc.id = NEW.source_id;
      IF source_work IS NULL OR source_work IS DISTINCT FROM book_work THEN
        RAISE EXCEPTION 'the claimed PAC certificate does not belong to the Measurement Book''s Work';
      END IF;
      IF source_state IS DISTINCT FROM 'recorded' THEN
        RAISE EXCEPTION 'only recorded PAC certificates are billable Measurement Book sources';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: everything except the NULL -> timestamp release is frozen.
  IF ROW(
    NEW.organisation_id, NEW.measurement_book_id, NEW.work_id,
    NEW.source_type, NEW.source_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.measurement_book_id, OLD.work_id,
    OLD.source_type, OLD.source_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Measurement Book source claim data is immutable';
  END IF;
  IF NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    IF OLD.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a released source claim cannot be re-claimed; select the source on a new draft';
    END IF;
    SELECT status INTO book_status
    FROM measurement_books
    WHERE organisation_id = NEW.organisation_id AND id = NEW.measurement_book_id;
    IF book_status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'source claims are released only by cancelling their Measurement Book';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Guard triggers sort alphabetically before the touch trigger so
-- violations raise before updated_at churn (0003 ordering note).
CREATE TRIGGER measurement_books_guard_delete
BEFORE DELETE ON measurement_books
FOR EACH ROW EXECUTE FUNCTION app_private.guard_measurement_book_delete();

CREATE TRIGGER measurement_books_guard_insert
BEFORE INSERT ON measurement_books
FOR EACH ROW EXECUTE FUNCTION app_private.guard_measurement_book_insert();

CREATE TRIGGER measurement_books_guard_update
BEFORE UPDATE ON measurement_books
FOR EACH ROW EXECUTE FUNCTION app_private.guard_measurement_book_update();

CREATE TRIGGER measurement_books_date_guard
BEFORE INSERT OR UPDATE OF mb_date ON measurement_books
FOR EACH ROW EXECUTE FUNCTION app_private.guard_measurement_book_date();

CREATE TRIGGER measurement_books_touch_updated_at
BEFORE UPDATE ON measurement_books
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TRIGGER measurement_book_lines_guard_mutation
BEFORE INSERT OR UPDATE OR DELETE ON measurement_book_lines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_measurement_book_line_mutation();

CREATE TRIGGER mb_sources_guard_mutation
BEFORE INSERT OR UPDATE OR DELETE ON mb_sources
FOR EACH ROW EXECUTE FUNCTION app_private.guard_mb_source_mutation();

-- 6. R19 coherence guards, database half: a source billed in a LIVE
-- (unreleased) Measurement Book claim cannot be cancelled — the MB must
-- be cancelled first. Each existing guard function is restated with its
-- full original body (0008 for delivery challans; 0017 for
-- installations; 0022 for PAC certificates) plus the MB check, keeping
-- the original error wording conventions.

-- 0008 guard_challan_cancellation, restated + MB check.
CREATE OR REPLACE FUNCTION app_private.guard_challan_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status = 'issued' THEN
    IF EXISTS (
        SELECT 1 FROM challan_receipts r WHERE r.delivery_challan_id = OLD.id
      )
      OR EXISTS (
        SELECT 1 FROM challan_item_serials s WHERE s.delivery_challan_id = OLD.id
      )
      OR EXISTS (
        SELECT 1 FROM mb_entries mb WHERE mb.delivery_challan_id = OLD.id
      ) THEN
      RAISE EXCEPTION
        'challan % has downstream evidence and cannot be cancelled', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        SELECT 1 FROM mb_sources ms
        WHERE ms.source_type = 'delivery_challan'
          AND ms.source_id = OLD.id
          AND ms.released_at IS NULL
      ) THEN
      RAISE EXCEPTION
        'challan % is billed in a live Measurement Book and cannot be cancelled', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 0017 guard_installation_update, restated + MB check on the cancel
-- transition (quantity edits were already frozen by the original body).
CREATE OR REPLACE FUNCTION app_private.guard_installation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled installation records are immutable';
  END IF;

  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.work_item_id, NEW.quantity,
    NEW.installed_on, NEW.location_id, NEW.location_name, NEW.remarks,
    NEW.recorded_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.work_item_id, OLD.quantity,
    OLD.installed_on, OLD.location_id, OLD.location_name, OLD.remarks,
    OLD.recorded_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'installation business data is immutable; cancel and re-record instead';
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status = 'recorded' THEN
    IF EXISTS (
        SELECT 1 FROM mb_sources ms
        WHERE ms.source_type = 'installation'
          AND ms.source_id = OLD.id
          AND ms.released_at IS NULL
      ) THEN
      RAISE EXCEPTION
        'installation % is billed in a live Measurement Book and cannot be cancelled', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- 0022 guard_pac_certificate_update, restated + MB check on the cancel
-- transition.
CREATE OR REPLACE FUNCTION app_private.guard_pac_certificate_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled PAC certificates are immutable';
  END IF;

  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.reference, NEW.issue_date,
    NEW.consignee_master_id, NEW.consignee_designation,
    NEW.recorded_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.reference, OLD.issue_date,
    OLD.consignee_master_id, OLD.consignee_designation,
    OLD.recorded_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'PAC certificate business data is immutable; cancel and re-record instead';
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status = 'recorded' THEN
    IF EXISTS (
        SELECT 1 FROM mb_sources ms
        WHERE ms.source_type = 'pac_certificate'
          AND ms.source_id = OLD.id
          AND ms.released_at IS NULL
      ) THEN
      RAISE EXCEPTION
        'PAC certificate % is billed in a live Measurement Book and cannot be cancelled', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- 7. bills gains its MB link (ADR-0006 decision 2: a bill is prepared
-- from a finalized MB, 1:1, amount equal to the MB's snapshotted
-- total). Nullable so Milestone 5 sweep-era bills keep their history.
ALTER TABLE bills
  ADD COLUMN mb_id uuid;

ALTER TABLE bills
  ADD CONSTRAINT bills_mb_fk
  FOREIGN KEY (organisation_id, mb_id)
  REFERENCES measurement_books(organisation_id, id);

CREATE UNIQUE INDEX bills_one_per_mb
  ON bills (organisation_id, mb_id)
  WHERE mb_id IS NOT NULL;

-- 0006 guard_bill_update, restated with mb_id in the frozen business
-- row so the MB link can never be rewritten after preparation.
CREATE OR REPLACE FUNCTION app_private.guard_bill_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.bill_number, NEW.lines_snapshot,
    NEW.total_amount, NEW.prepared_by_user_id, NEW.created_at, NEW.mb_id
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.bill_number, OLD.lines_snapshot,
    OLD.total_amount, OLD.prepared_by_user_id, OLD.created_at, OLD.mb_id
  ) THEN
    RAISE EXCEPTION 'bill business data is immutable; only status may change';
  END IF;
  IF NOT (
    (OLD.status = 'prepared' AND NEW.status IN ('prepared', 'submitted'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('submitted', 'paid'))
    OR (OLD.status = 'paid' AND NEW.status = 'paid')
  ) THEN
    RAISE EXCEPTION 'bill status only moves forward: prepared -> submitted -> paid';
  END IF;
  RETURN NEW;
END
$$;

-- 8. RLS: tenant policy on every new table, enabled and forced.
ALTER TABLE measurement_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_books FORCE ROW LEVEL SECURITY;
ALTER TABLE measurement_book_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_book_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE mb_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE mb_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE measurement_book_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_book_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY measurement_books_tenant_policy ON measurement_books
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY measurement_book_lines_tenant_policy ON measurement_book_lines
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY mb_sources_tenant_policy ON mb_sources
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY measurement_book_counters_tenant_policy ON measurement_book_counters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- 9. Grants. Drafts (and their source claims) stay deletable, guarded
-- by the triggers above; finalized snapshots and numbering state keep
-- no DELETE. Lines take UPDATE nominally with every UPDATE refused by
-- trigger — the snapshot is immutable either way.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON measurement_books, mb_sources TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE ON measurement_book_lines TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE ON measurement_book_counters TO auto_mb_app;
  END IF;
END
$$;
