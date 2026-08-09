SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Wave 2 hardening (adversarial review follow-up): close the schema gaps
-- the merged Milestone 7 tracks left open.
--
--   1. correction_notices gains the BEFORE DELETE guard every other
--      never-delete document table carries (0006/0011/0014/0015/0017).
--   2. The cancellation-shape CHECKs accepted a NULL cancellation_note:
--      with note NULL the cancelled branch evaluates to NULL (not FALSE)
--      and NULL OR FALSE passes the CHECK. Re-state each constraint
--      faithfully with an explicit cancellation_note IS NOT NULL conjunct.
--   3. approval_requests: the correction entity types must always bind to
--      a target document — entity_id nullability exists solely for
--      add-item amendment proposals (0012).
--   4. installation_serials: the composite FKs prove WORK lineage only; a
--      trigger now proves ITEM lineage — the serial's delivery challan
--      item must resolve to the same work_item as the parent installation.

-- 1. correction_notices: never-delete guard (0017 pattern).
CREATE FUNCTION app_private.guard_correction_notice_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Correction Notices are numbered legal records; they cancel, never delete';
END
$$;

CREATE TRIGGER correction_notices_guard_delete
BEFORE DELETE ON correction_notices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_correction_notice_delete();

-- 2. Cancellation-shape CHECKs: NULL-proof re-statements. Each constraint
-- keeps its original (auto-generated) name and its original branches,
-- plus cancellation_note IS NOT NULL in the cancelled branch.

-- 0001 delivery_challans.
ALTER TABLE delivery_challans
  DROP CONSTRAINT delivery_challans_check1;
ALTER TABLE delivery_challans
  ADD CONSTRAINT delivery_challans_check1 CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND cancellation_note IS NOT NULL AND length(btrim(cancellation_note)) >= 3)
    OR
    (status <> 'cancelled' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_note IS NULL)
  );

-- 0014 issue_challans.
ALTER TABLE issue_challans
  DROP CONSTRAINT issue_challans_check1;
ALTER TABLE issue_challans
  ADD CONSTRAINT issue_challans_check1 CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND cancellation_note IS NOT NULL AND length(btrim(cancellation_note)) >= 3)
    OR
    (status <> 'cancelled' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_note IS NULL)
  );

-- 0017 installations.
ALTER TABLE installations
  DROP CONSTRAINT installations_check;
ALTER TABLE installations
  ADD CONSTRAINT installations_check CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND cancellation_note IS NOT NULL AND length(btrim(cancellation_note)) >= 3)
    OR
    (status = 'recorded' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_note IS NULL)
  );

-- 0019 correction_notices.
ALTER TABLE correction_notices
  DROP CONSTRAINT correction_notices_check;
ALTER TABLE correction_notices
  ADD CONSTRAINT correction_notices_check CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL
      AND cancelled_by_user_id IS NOT NULL
      AND cancellation_note IS NOT NULL
      AND length(btrim(cancellation_note)) >= 3)
    OR
    (status <> 'cancelled' AND cancelled_at IS NULL
      AND cancelled_by_user_id IS NULL AND cancellation_note IS NULL)
  );

-- 3. Correction requests always name their target document. (Both
-- one-pending partial unique indexes filter on entity_id, so a NULL
-- entity_id row would escape the one-pending-correction guarantee.)
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_correction_entity_check
  CHECK (entity_type = 'work_item_amendment' OR entity_id IS NOT NULL);

-- 4. Item lineage for serial attachments: the 0017 guard re-stated with
-- an INSERT-time check that the serial was delivered under the SAME work
-- item the installation records. Runs as the invoking role — an invisible
-- row yields NULL and the mutation is refused rather than waved through.
CREATE OR REPLACE FUNCTION app_private.guard_installation_serial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  parent_item uuid;
  serial_item uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'installation serial attachments are released, never deleted';
  END IF;

  SELECT status, work_item_id INTO parent_status, parent_item
  FROM installations
  WHERE organisation_id = NEW.organisation_id AND id = NEW.installation_id;

  IF TG_OP = 'INSERT' THEN
    IF parent_status IS DISTINCT FROM 'recorded' THEN
      RAISE EXCEPTION 'serials attach only to a recorded installation';
    END IF;
    SELECT dci.work_item_id INTO serial_item
    FROM challan_item_serials s
    JOIN delivery_challan_items dci ON dci.id = s.delivery_challan_item_id
    WHERE s.organisation_id = NEW.organisation_id
      AND s.id = NEW.challan_item_serial_id;
    IF serial_item IS NULL OR serial_item IS DISTINCT FROM parent_item THEN
      RAISE EXCEPTION 'serial attachments must stay within the installation''s work item';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: everything except the NULL -> timestamp release is frozen.
  IF ROW(
    NEW.organisation_id, NEW.installation_id, NEW.work_id,
    NEW.challan_item_serial_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.installation_id, OLD.work_id,
    OLD.challan_item_serial_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'installation serial attachment data is immutable';
  END IF;
  IF NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    IF OLD.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a released serial attachment cannot be re-attached; record a new installation';
    END IF;
    IF parent_status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'serial attachments are released only by cancelling their installation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
