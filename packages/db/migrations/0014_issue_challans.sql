SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 7: Issue Challans (IC) — the Delivery Challan's sibling
-- document for material issued out (to site, job work, loan/return).
-- Same lifecycle and numbering discipline as DCs with looser content
-- rules by design (legacy spec §5.3): lines may be manual (outside the
-- LOA) and quantities MAY exceed work quantities — there is deliberately
-- no ceiling against awarded or delivered quantities.

-- 1. The document. Consignee ("issued to") is free-text snapshot data on
-- the challan itself, not a master-data reference.
CREATE TABLE issue_challans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('issue', 'loan', 'return')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'cancelled')),
  challan_date date NOT NULL,
  challan_number text,
  sequence_number integer CHECK (sequence_number IS NULL OR sequence_number > 0),
  prefix text NOT NULL CHECK (length(prefix) BETWEEN 1 AND 25 AND prefix ~ '^[A-Z0-9][A-Z0-9_/-]*$'),
  issued_to_name text NOT NULL CHECK (length(btrim(issued_to_name)) BETWEEN 2 AND 200),
  issued_to_role text CHECK (issued_to_role IS NULL OR length(btrim(issued_to_role)) BETWEEN 2 AND 200),
  location text CHECK (location IS NULL OR length(btrim(location)) BETWEEN 2 AND 200),
  remarks text CHECK (remarks IS NULL OR length(btrim(remarks)) BETWEEN 1 AND 1000),
  issued_snapshot jsonb,
  template_version text,
  rendered_object_key text,
  rendered_sha256 text CHECK (rendered_sha256 IS NULL OR rendered_sha256 ~ '^[0-9a-f]{64}$'),
  signed_copy_object_key text,
  signed_copy_sha256 text CHECK (signed_copy_sha256 IS NULL OR signed_copy_sha256 ~ '^[0-9a-f]{64}$'),
  cancellation_note text,
  created_by_user_id text NOT NULL,
  issued_by_user_id text,
  cancelled_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  issued_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, id, work_id),
  UNIQUE (organisation_id, challan_number),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  CHECK (
    (status = 'draft' AND challan_number IS NULL AND sequence_number IS NULL AND issued_snapshot IS NULL AND issued_at IS NULL)
    OR
    (status IN ('issued', 'cancelled') AND challan_number IS NOT NULL AND sequence_number IS NOT NULL AND issued_snapshot IS NOT NULL AND issued_at IS NOT NULL)
  ),
  CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND length(btrim(cancellation_note)) >= 3)
    OR
    (status <> 'cancelled' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_note IS NULL)
  ),
  CHECK (status <> 'draft' OR (issued_by_user_id IS NULL AND rendered_object_key IS NULL AND rendered_sha256 IS NULL AND signed_copy_object_key IS NULL AND signed_copy_sha256 IS NULL)),
  -- An issued Issue Challan must record who issued it (same invariant the
  -- 0003 review added for Delivery Challans).
  CHECK (status = 'draft' OR issued_by_user_id IS NOT NULL)
);

CREATE UNIQUE INDEX issue_challans_one_draft_per_work
  ON issue_challans (organisation_id, work_id)
  WHERE status = 'draft';

-- Sequence numbers serialised per Work at the database, mirroring
-- delivery_challans_sequence_per_work: two ICs on one Work can never
-- share a sequence number even if the counter is corrupted.
CREATE UNIQUE INDEX issue_challans_sequence_per_work
  ON issue_challans (organisation_id, work_id, sequence_number)
  WHERE sequence_number IS NOT NULL;

-- 2. Lines. Either a Work-item reference (composite FK proves lineage
-- when present) or a manual description+unit outside the LOA. No rate,
-- no amount: an IC records material movement, not billing value.
CREATE TABLE issue_challan_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  issue_challan_id uuid NOT NULL,
  work_id uuid NOT NULL,
  work_item_id uuid,
  description_snapshot text NOT NULL CHECK (length(btrim(description_snapshot)) >= 3),
  unit_snapshot text NOT NULL CHECK (length(btrim(unit_snapshot)) BETWEEN 1 AND 20),
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0),
  position integer NOT NULL CHECK (position > 0),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, issue_challan_id, position),
  FOREIGN KEY (organisation_id, issue_challan_id, work_id) REFERENCES issue_challans(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, work_item_id, work_id) REFERENCES work_items(organisation_id, id, work_id)
);

-- The same Work item at most once per challan; manual lines are exempt.
CREATE UNIQUE INDEX issue_challan_lines_item_per_challan
  ON issue_challan_lines (organisation_id, issue_challan_id, work_item_id)
  WHERE work_item_id IS NOT NULL;

-- 3. Immutability guards (0008/0001 pattern): issued business data is
-- frozen, cancelled rows are frozen entirely, drafts delete rather than
-- cancel, and lines mutate only while the challan is draft.
CREATE FUNCTION app_private.guard_issue_challan_update()
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

  RETURN NEW;
END
$$;

CREATE FUNCTION app_private.guard_issue_challan_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'only draft Issue Challans may be deleted';
  END IF;
  RETURN OLD;
END
$$;

CREATE FUNCTION app_private.guard_issue_challan_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_organisation_id uuid;
  target_challan_id uuid;
  target_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_organisation_id := OLD.organisation_id;
    target_challan_id := OLD.issue_challan_id;
  ELSE
    target_organisation_id := NEW.organisation_id;
    target_challan_id := NEW.issue_challan_id;
  END IF;

  SELECT status INTO target_status
  FROM issue_challans
  WHERE organisation_id = target_organisation_id AND id = target_challan_id;

  IF target_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Issue Challan lines are mutable only while the challan is draft';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

-- Trigger names keep the guard alphabetically before the touch trigger,
-- so immutability violations raise before updated_at is touched (0003
-- ordering note).
CREATE TRIGGER issue_challans_guard_update
BEFORE UPDATE ON issue_challans
FOR EACH ROW EXECUTE FUNCTION app_private.guard_issue_challan_update();

CREATE TRIGGER issue_challans_guard_delete
BEFORE DELETE ON issue_challans
FOR EACH ROW EXECUTE FUNCTION app_private.guard_issue_challan_delete();

CREATE TRIGGER issue_challan_lines_guard_mutation
BEFORE INSERT OR UPDATE OR DELETE ON issue_challan_lines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_issue_challan_line_mutation();

CREATE TRIGGER issue_challans_touch_updated_at
BEFORE UPDATE ON issue_challans
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- 4. Product date invariant, held in the database: an IC's date is never
-- in the future and never precedes the Work's LOA letter date, evaluated
-- in the organisation's own timezone — the same 0010 guard the DCs carry,
-- replicated onto issue_challans (the function is generic over any row
-- with work_id + challan_date).
CREATE TRIGGER issue_challans_date_guard
  BEFORE INSERT OR UPDATE OF challan_date ON issue_challans
  FOR EACH ROW
  EXECUTE FUNCTION app_private.guard_challan_date();

-- 5. Gapless per-Work numbering state, exactly the DC counter mechanism:
-- the counter row lock orders concurrent issues, rollback rolls the
-- counter back with the transaction, and the 0003 decrease guard keeps
-- numbers from being reused.
CREATE TABLE issue_challan_counters (
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

CREATE TRIGGER issue_challan_counters_guard_decrease
BEFORE UPDATE ON issue_challan_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

CREATE TRIGGER issue_challan_counters_touch_updated_at
BEFORE UPDATE ON issue_challan_counters
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- 6. Indexes.
CREATE INDEX issue_challans_work_idx
  ON issue_challans (organisation_id, work_id, status, challan_date DESC, id);
CREATE INDEX issue_challan_lines_work_item_idx
  ON issue_challan_lines (organisation_id, work_item_id, issue_challan_id)
  WHERE work_item_id IS NOT NULL;

-- 7. RLS: tenant policy on every new table.
ALTER TABLE issue_challans ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_challans FORCE ROW LEVEL SECURITY;
ALTER TABLE issue_challan_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_challan_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE issue_challan_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_challan_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY issue_challans_tenant_policy ON issue_challans
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY issue_challan_lines_tenant_policy ON issue_challan_lines
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY issue_challan_counters_tenant_policy ON issue_challan_counters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- 8. Grants. Drafts and their lines stay deletable; the counter is
-- numbering state and never receives DELETE (0003 reservation-anchor
-- posture).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      issue_challans,
      issue_challan_lines
    TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE ON issue_challan_counters TO auto_mb_app;
  END IF;
END
$$;
