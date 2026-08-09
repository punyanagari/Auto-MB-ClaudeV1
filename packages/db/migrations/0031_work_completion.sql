SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 6/7 retrofit (Track: work completion): the R8/R15 completion
-- status lifecycle. works.status has carried the
-- 'active'|'completed'|'cancelled' CHECK since migration 0001, but no
-- writer ever moved a row off 'active' — the transitions themselves were
-- never built, so several routes' `status <> 'active'` refusals have been
-- dead code since day one. This migration builds the transition.
--
-- Reconciling R15 honestly. The legacy rule names three work statuses.
-- This product implements TWO of them:
--   * 'active' and 'completed' become reachable here, with notes and an
--     audit trail on both directions (R8: "Completion/reopen takes an
--     audit note");
--   * 'cancelled' stays UNREACHABLE. The removal path this product
--     actually implements is the soft delete (works.deleted_at, migration
--     0001, guarded by the R15 "no challans or installations" refusal in
--     the retention routes). Adding a second, parallel removal state with
--     no writer, no UI, and no rules of its own would be speculative
--     framework, so the transition guard below REFUSES any transition
--     into or out of 'cancelled' rather than leaving an unimplemented
--     state silently reachable through raw SQL. The column CHECK from
--     0001 is left untouched: whoever builds work cancellation later gets
--     a clean slate and one guard clause to revisit, and no existing row
--     can have reached that value.
--
-- Contents:
--   1. Completion/reopen state columns on works, with shape CHECKs.
--   2. The status-transition guard trigger (legal transitions + note
--      presence). The R8 100%-executed PREDICATE is deliberately NOT in
--      this trigger: it is computed in exact SQL by POST
--      /api/works/:id/complete under the works row lock, which serialises
--      against every writer that can move a delivered/installed/effective
--      quantity (all of them take the same works lock). A per-UPDATE
--      re-scan of every item on the works row would charge that cost to
--      every unrelated works update, and would still need the route's
--      structured unfinished-item list to be useful.
--   3. The database backstop for "a completed Work accepts no new
--      operational documents": every route check has a matching guard, so
--      raw SQL and any future writer are refused too. Five existing guard
--      functions are restated verbatim (their CURRENT, layered bodies —
--      0018/0027 for the delivery challan, 0014 for the issue challan,
--      0024/0027 for the insert guards) plus the new completed-work
--      clause; four tables that had no insert-time guard gain one.
--
-- All guards run as the invoking role, like every guard since 0011:
-- same-tenant writers see the works row through their own RLS, and the
-- administrator (importer) sees everything.

-- 1. Completion state. completed_* record the CURRENT completion; a
-- reopen clears them and records reopened_* instead, so the row always
-- shows its last lifecycle transition and the DB can prove a note was
-- given in BOTH directions. The full history (every completion and every
-- reopen, with before/after) lives in audit_events, which is append-only
-- — duplicating it in per-transition columns here would buy nothing.
ALTER TABLE works
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN completed_by_user_id text,
  ADD COLUMN completion_note text
    CHECK (completion_note IS NULL OR length(btrim(completion_note)) BETWEEN 3 AND 2000),
  ADD COLUMN reopened_at timestamptz,
  ADD COLUMN reopened_by_user_id text,
  ADD COLUMN reopen_note text
    CHECK (reopen_note IS NULL OR length(btrim(reopen_note)) BETWEEN 3 AND 2000);

-- Shape: a completed Work carries its completion triple and no reopen
-- state; an active Work carries no completion state and either a full
-- reopen triple (it has been reopened) or none at all (it never left
-- 'active').
ALTER TABLE works
  ADD CONSTRAINT works_completion_shape_check CHECK (
    (status = 'completed'
       AND completed_at IS NOT NULL
       AND completed_by_user_id IS NOT NULL
       AND completion_note IS NOT NULL
       AND reopened_at IS NULL
       AND reopened_by_user_id IS NULL
       AND reopen_note IS NULL)
    OR
    (status <> 'completed'
       AND completed_at IS NULL
       AND completed_by_user_id IS NULL
       AND completion_note IS NULL)
  );

ALTER TABLE works
  ADD CONSTRAINT works_reopen_shape_check CHECK (
    (reopened_at IS NULL AND reopened_by_user_id IS NULL AND reopen_note IS NULL)
    OR
    (reopened_at IS NOT NULL AND reopened_by_user_id IS NOT NULL AND reopen_note IS NOT NULL)
  );

-- 2. The transition guard. Named so it fires BEFORE the alphabetically
-- later works_touch_updated_at, exactly like works_completion_date_guard.
CREATE FUNCTION app_private.guard_work_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    -- Not a lifecycle transition: the completion/reopen columns are
    -- decided by the transition that set them and never drift alone.
    IF ROW(
      NEW.completed_at, NEW.completed_by_user_id, NEW.completion_note,
      NEW.reopened_at, NEW.reopened_by_user_id, NEW.reopen_note
    ) IS DISTINCT FROM ROW(
      OLD.completed_at, OLD.completed_by_user_id, OLD.completion_note,
      OLD.reopened_at, OLD.reopened_by_user_id, OLD.reopen_note
    ) THEN
      RAISE EXCEPTION 'completion state changes only with the Work status'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'cancelled' OR NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'Work cancellation is not implemented; soft-delete the Work instead'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'completed' THEN
    IF NEW.completion_note IS NULL OR length(btrim(NEW.completion_note)) < 3 THEN
      RAISE EXCEPTION 'completing a Work takes a note'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'completed' AND NEW.status = 'active' THEN
    IF NEW.reopen_note IS NULL OR length(btrim(NEW.reopen_note)) < 3 THEN
      RAISE EXCEPTION 'reopening a Work takes a note'
        USING ERRCODE = '23514';
    END IF;
    -- The reopen must be recorded as this transaction's own act, not
    -- carried over from a previous reopen.
    IF NEW.reopened_at IS NOT DISTINCT FROM OLD.reopened_at THEN
      RAISE EXCEPTION 'reopening a Work records a fresh reopen timestamp'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unsupported Work status transition % -> %', OLD.status, NEW.status
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER works_status_transition_guard
  BEFORE UPDATE ON works
  FOR EACH ROW
  EXECUTE FUNCTION app_private.guard_work_status_transition();

-- 3a. Delivery challans. The 0027 body (which itself restated 0018's)
-- verbatim, plus the completed-work clause on both the draft insert and
-- the draft -> issued transition.
CREATE OR REPLACE FUNCTION app_private.guard_delivery_challan_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled Delivery Challans are immutable';
  END IF;

  IF OLD.status = 'issued' THEN
    IF NEW.status NOT IN ('issued', 'cancelled') THEN
      RAISE EXCEPTION 'issued Delivery Challans may only remain issued or be cancelled';
    END IF;

    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.challan_date, NEW.challan_number,
      NEW.sequence_number, NEW.prefix, NEW.consignee_snapshot, NEW.issued_snapshot,
      NEW.template_version, NEW.warranty_template_version, NEW.warranty_text_sha256,
      NEW.created_by_user_id, NEW.issued_by_user_id, NEW.issued_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.challan_date, OLD.challan_number,
      OLD.sequence_number, OLD.prefix, OLD.consignee_snapshot, OLD.issued_snapshot,
      OLD.template_version, OLD.warranty_template_version, OLD.warranty_text_sha256,
      OLD.created_by_user_id, OLD.issued_by_user_id, OLD.issued_at
    ) THEN
      RAISE EXCEPTION 'issued Delivery Challan business data is immutable';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Delivery Challans are deleted, not cancelled';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'issued' THEN
    IF EXISTS (
      SELECT 1 FROM measurement_books mb
      WHERE mb.organisation_id = NEW.organisation_id
        AND mb.work_id = NEW.work_id
        AND mb.is_final
        AND mb.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION
        'a final Measurement Book exists for this Work; issuing this delivery challan would create a source that can never be billed'
        USING ERRCODE = 'check_violation';
    END IF;

    -- R8: a completed Work accepts no new operational documents.
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = NEW.organisation_id
        AND w.id = NEW.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before issuing a delivery challan'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE FUNCTION app_private.guard_delivery_challan_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM works w
    WHERE w.organisation_id = NEW.organisation_id
      AND w.id = NEW.work_id
      AND w.status = 'completed'
  ) THEN
    RAISE EXCEPTION
      'this Work is completed; reopen it before drafting a delivery challan'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER delivery_challans_guard_insert
BEFORE INSERT ON delivery_challans
FOR EACH ROW EXECUTE FUNCTION app_private.guard_delivery_challan_insert();

-- 3b. Issue challans. The 0014 body verbatim plus the same clause, and a
-- matching insert guard.
CREATE OR REPLACE FUNCTION app_private.guard_issue_challan_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled Issue Challans are immutable';
  END IF;

  IF OLD.status = 'issued' THEN
    IF NEW.status NOT IN ('issued', 'cancelled') THEN
      RAISE EXCEPTION 'issued Issue Challans may only remain issued or be cancelled';
    END IF;

    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.movement_type, NEW.challan_date,
      NEW.challan_number, NEW.sequence_number, NEW.prefix, NEW.issued_to_name,
      NEW.issued_to_role, NEW.location, NEW.remarks, NEW.issued_snapshot,
      NEW.template_version, NEW.created_by_user_id, NEW.issued_by_user_id,
      NEW.issued_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.movement_type, OLD.challan_date,
      OLD.challan_number, OLD.sequence_number, OLD.prefix, OLD.issued_to_name,
      OLD.issued_to_role, OLD.location, OLD.remarks, OLD.issued_snapshot,
      OLD.template_version, OLD.created_by_user_id, OLD.issued_by_user_id,
      OLD.issued_at
    ) THEN
      RAISE EXCEPTION 'issued Issue Challan business data is immutable';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Issue Challans are deleted, not cancelled';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'issued' THEN
    -- R8: a completed Work accepts no new operational documents.
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = NEW.organisation_id
        AND w.id = NEW.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before issuing an issue challan'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE FUNCTION app_private.guard_issue_challan_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM works w
    WHERE w.organisation_id = NEW.organisation_id
      AND w.id = NEW.work_id
      AND w.status = 'completed'
  ) THEN
    RAISE EXCEPTION
      'this Work is completed; reopen it before drafting an issue challan'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER issue_challans_guard_insert
BEFORE INSERT ON issue_challans
FOR EACH ROW EXECUTE FUNCTION app_private.guard_issue_challan_insert();

-- 3c. Installation records. The 0027 insert guard verbatim plus the
-- completed-work clause.
CREATE OR REPLACE FUNCTION app_private.guard_installation_insert()
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
    RAISE EXCEPTION
      'a final Measurement Book exists for this Work; recording this installation would create a source that can never be billed'
      USING ERRCODE = 'check_violation';
  END IF;

  -- R8: a completed Work accepts no new operational documents.
  IF EXISTS (
    SELECT 1 FROM works w
    WHERE w.organisation_id = NEW.organisation_id
      AND w.id = NEW.work_id
      AND w.status = 'completed'
  ) THEN
    RAISE EXCEPTION
      'this Work is completed; reopen it before recording an installation'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- 3d. PAC certificates. The 0027 insert guard verbatim plus the clause.
CREATE OR REPLACE FUNCTION app_private.guard_pac_certificate_insert()
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
    RAISE EXCEPTION
      'a final Measurement Book exists for this Work; recording this PAC certificate would create a source that can never be billed'
      USING ERRCODE = 'check_violation';
  END IF;

  -- R8: a completed Work accepts no new operational documents.
  IF EXISTS (
    SELECT 1 FROM works w
    WHERE w.organisation_id = NEW.organisation_id
      AND w.id = NEW.work_id
      AND w.status = 'completed'
  ) THEN
    RAISE EXCEPTION
      'this Work is completed; reopen it before recording a PAC certificate'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- 3e. Measurement Books. The 0024 insert guard verbatim plus the clause.
CREATE OR REPLACE FUNCTION app_private.guard_measurement_book_insert()
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

  -- R8: a completed Work accepts no new operational documents.
  IF EXISTS (
    SELECT 1 FROM works w
    WHERE w.organisation_id = NEW.organisation_id
      AND w.id = NEW.work_id
      AND w.status = 'completed'
  ) THEN
    RAISE EXCEPTION
      'this Work is completed; reopen it before raising a Measurement Book'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- 3f. Extension requests and amendment/correction proposals: the two
-- remaining creation paths the completed Work must refuse. Both tables
-- had no insert-time guard, so they gain one (the 0024/0027 pattern).
CREATE FUNCTION app_private.guard_extension_request_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM works w
    WHERE w.organisation_id = NEW.organisation_id
      AND w.id = NEW.work_id
      AND w.status = 'completed'
  ) THEN
    RAISE EXCEPTION
      'this Work is completed; reopen it before raising an extension request'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER extension_requests_guard_insert
BEFORE INSERT ON extension_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_extension_request_insert();

CREATE FUNCTION app_private.guard_approval_request_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM works w
    WHERE w.organisation_id = NEW.organisation_id
      AND w.id = NEW.work_id
      AND w.status = 'completed'
  ) THEN
    RAISE EXCEPTION
      'this Work is completed; reopen it before proposing a change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER approval_requests_guard_insert
BEFORE INSERT ON approval_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_approval_request_insert();

-- 4. The dashboard's completion alerts already filter w.status = 'active'
-- (migration 0011's read path), so a completed Work stops alerting the
-- moment this transition becomes reachable; no query change is needed and
-- the behaviour is pinned by a test.
