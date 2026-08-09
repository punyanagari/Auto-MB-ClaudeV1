SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 7: quantity-level installation records (legacy spec §5.4,
-- rules R5/R6/R11). An installation says "N units of item X went in at
-- location L on date D" — alongside the existing per-serial
-- challan_item_serials.installed_on facts, which stay authoritative for
-- WHICH physical unit is in. The location is snapshot-on-use: the picked
-- master's name is copied onto the record at write time, so renaming or
-- retiring the master never rewrites installation history (0013 posture).
-- Recorded installations cancel with a note; they are never deleted.

-- 1. The record.
CREATE TABLE installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0),
  installed_on date NOT NULL,
  location_id uuid NOT NULL,
  location_name text NOT NULL CHECK (length(btrim(location_name)) BETWEEN 2 AND 200),
  remarks text CHECK (remarks IS NULL OR length(btrim(remarks)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'cancelled')),
  cancellation_note text,
  recorded_by_user_id text NOT NULL,
  cancelled_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  FOREIGN KEY (organisation_id, work_item_id, work_id)
    REFERENCES work_items(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, location_id)
    REFERENCES location_masters(organisation_id, id),
  -- Cancellation is complete or absent: note (>= 3 chars), actor and time
  -- travel together, exactly the issue_challans shape.
  CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND length(btrim(cancellation_note)) >= 3)
    OR
    (status = 'recorded' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_note IS NULL)
  )
);

CREATE INDEX installations_work_idx
  ON installations (organisation_id, work_id, status, installed_on DESC, id);
-- The installed-quantity cap sums non-cancelled rows per item; keep that
-- scan narrow.
CREATE INDEX installations_item_recorded_idx
  ON installations (organisation_id, work_item_id)
  WHERE status = 'recorded';

-- 2. Serial attachment. challan_item_serials gains a work-lineage key so
-- the attachment's composite FK proves serial and installation belong to
-- the same Work of the same tenant.
ALTER TABLE challan_item_serials
  ADD CONSTRAINT challan_item_serials_org_id_work_key
  UNIQUE (organisation_id, id, work_id);

-- An attachment row is the durable fact "this physical unit was covered
-- by this installation record". Cancelling the installation releases the
-- serial (released_at set) instead of erasing the history.
CREATE TABLE installation_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  challan_item_serial_id uuid NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, installation_id, work_id)
    REFERENCES installations(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, challan_item_serial_id, work_id)
    REFERENCES challan_item_serials(organisation_id, id, work_id)
);

-- A physical unit is in at most one live installation (R6: a serial
-- cannot be installed twice). The API checks first with a friendly error;
-- this index makes the invariant hold against every writer.
CREATE UNIQUE INDEX installation_serials_one_live_per_serial
  ON installation_serials (organisation_id, challan_item_serial_id)
  WHERE released_at IS NULL;

CREATE INDEX installation_serials_installation_idx
  ON installation_serials (organisation_id, installation_id);

-- 3. Immutability guards. A recorded installation changes only by the
-- cancel transition; a cancelled one never changes; neither is deletable.
-- (Legacy §5.6 quantity edits via approvals arrive with the approvals
-- extension — until that migration relaxes this guard deliberately, the
-- correction path is cancel-and-re-record.)
CREATE FUNCTION app_private.guard_installation_update()
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

  RETURN NEW;
END
$$;

CREATE FUNCTION app_private.guard_installation_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'installation records cancel with a note; they are never deleted';
END
$$;

-- Attachments: INSERT only against a recorded installation; the only
-- permitted UPDATE is the one-way release that accompanies the parent's
-- cancellation; no DELETE. Runs as the invoking role — if the parent row
-- is invisible (no tenant bound), the status lookup yields NULL and the
-- mutation is refused rather than waved through.
CREATE FUNCTION app_private.guard_installation_serial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'installation serial attachments are released, never deleted';
  END IF;

  SELECT status INTO parent_status
  FROM installations
  WHERE organisation_id = NEW.organisation_id AND id = NEW.installation_id;

  IF TG_OP = 'INSERT' THEN
    IF parent_status IS DISTINCT FROM 'recorded' THEN
      RAISE EXCEPTION 'serials attach only to a recorded installation';
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

-- 4. Product date invariant (R11), held in the database: an installation
-- date is never in the future ("today" in the organisation's own
-- timezone) and never precedes the Work's LOA letter date — the 0010
-- challan guard, mirrored for the installed_on column. Steps aside when
-- the works row is invisible; the foreign keys still hold.
CREATE FUNCTION app_private.guard_installation_date()
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

  IF NEW.installed_on > v_today THEN
    RAISE EXCEPTION 'installed_on % is in the future (today is % in the organisation timezone)',
      NEW.installed_on, v_today
      USING ERRCODE = '23514';
  END IF;

  IF NEW.installed_on < v_letter_date THEN
    RAISE EXCEPTION 'installed_on % precedes the LOA letter date %',
      NEW.installed_on, v_letter_date
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- Guard triggers sort alphabetically before the touch trigger so
-- violations raise before updated_at churn (0003 ordering note).
CREATE TRIGGER installations_guard_delete
BEFORE DELETE ON installations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_installation_delete();

CREATE TRIGGER installations_guard_update
BEFORE UPDATE ON installations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_installation_update();

CREATE TRIGGER installations_date_guard
BEFORE INSERT OR UPDATE OF installed_on ON installations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_installation_date();

CREATE TRIGGER installations_touch_updated_at
BEFORE UPDATE ON installations
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TRIGGER installation_serials_guard_mutation
BEFORE INSERT OR UPDATE OR DELETE ON installation_serials
FOR EACH ROW EXECUTE FUNCTION app_private.guard_installation_serial_mutation();

-- 5. RLS: tenant policy on every new table.
ALTER TABLE installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE installations FORCE ROW LEVEL SECURITY;
ALTER TABLE installation_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE installation_serials FORCE ROW LEVEL SECURITY;

CREATE POLICY installations_tenant_policy ON installations
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY installation_serials_tenant_policy ON installation_serials
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- 6. Grants. Recorded documents cancel, never delete: no DELETE anywhere.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON installations, installation_serials TO auto_mb_app;
  END IF;
END
$$;
