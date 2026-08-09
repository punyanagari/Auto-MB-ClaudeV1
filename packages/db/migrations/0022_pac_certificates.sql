SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 8 phase 1: PAC certificate lifecycle (legacy spec §5.5, rule
-- R18). A PAC certificate is the railway's certification that N units of
-- item X are provisionally accepted — issued in parts, recorded by office
-- staff, per-item certified quantities capped at installed minus already
-- certified. Certified quantities feed the PAC payment stage of the
-- stage-wise Measurement Book (§8: pac_qty).
--
-- The issuing consignee is snapshot-on-use (0013 posture): the picked
-- consignee master's designation is copied onto the certificate at record
-- time, so renaming or retiring the master never rewrites the certified
-- record; consignee_master_id stays as informational provenance only.
-- Recorded certificates cancel with a note; they are never deleted.
--
-- The reference-level work_instruments rows with kind = 'pac'
-- (Milestone 5) are untouched: those are banking-reference records; this
-- table is the quantity-bearing certificate.

-- 1. The certificate.
CREATE TABLE pac_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 100),
  issue_date date NOT NULL,
  consignee_master_id uuid NOT NULL,
  consignee_designation text NOT NULL
    CHECK (length(btrim(consignee_designation)) BETWEEN 2 AND 200),
  -- Optional scanned certificate: content-addressed object plus its
  -- sha256, both present or both absent.
  document_object_key text,
  document_sha256 text CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
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
  FOREIGN KEY (organisation_id, consignee_master_id)
    REFERENCES consignee_masters(organisation_id, id),
  CHECK (
    (document_object_key IS NULL) = (document_sha256 IS NULL)
  ),
  -- Cancellation is complete or absent: note (>= 3 chars), actor and time
  -- travel together, exactly the installations shape (0017).
  CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND length(btrim(cancellation_note)) >= 3)
    OR
    (status = 'recorded' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_note IS NULL)
  )
);

-- A reference names one live certificate per Work: unique among the
-- non-cancelled, case-insensitively. A cancelled certificate keeps its
-- reference forever, and the railway may re-issue under the same number.
CREATE UNIQUE INDEX pac_certificates_reference_per_work
  ON pac_certificates (organisation_id, work_id, lower(reference))
  WHERE status <> 'cancelled';

CREATE INDEX pac_certificates_work_idx
  ON pac_certificates (organisation_id, work_id, status, issue_date DESC, id);

-- 2. The certified quantities. One line per item per certificate; the
-- R18 cap sums these over non-cancelled certificates.
CREATE TABLE pac_certificate_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  pac_certificate_id uuid NOT NULL,
  work_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  certified_quantity numeric(18,3) NOT NULL CHECK (certified_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  -- The same work item may not appear twice in one certificate (merge
  -- quantities — the R12 posture challan lines already follow).
  UNIQUE (organisation_id, pac_certificate_id, work_item_id),
  FOREIGN KEY (organisation_id, pac_certificate_id, work_id)
    REFERENCES pac_certificates(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, work_item_id, work_id)
    REFERENCES work_items(organisation_id, id, work_id)
);

-- The R18 covered-sum scan (SUM of certified per item over non-cancelled
-- certificates) joins through the certificate; keep both sides narrow.
CREATE INDEX pac_certificate_items_item_idx
  ON pac_certificate_items (organisation_id, work_item_id);
CREATE INDEX pac_certificate_items_certificate_idx
  ON pac_certificate_items (organisation_id, pac_certificate_id);

-- 3. Immutability guards. A recorded certificate changes only by the
-- cancel transition or a scanned-document (re-)upload; a cancelled one
-- never changes; neither is deletable. Lines are frozen entirely once
-- written and only ever inserted against a recorded certificate.
CREATE FUNCTION app_private.guard_pac_certificate_update()
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

  RETURN NEW;
END
$$;

CREATE FUNCTION app_private.guard_pac_certificate_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PAC certificates cancel with a note; they are never deleted';
END
$$;

-- Lines: INSERT only against a recorded certificate; no UPDATE, no
-- DELETE — the certified quantities ARE the legal record, and freeing
-- them up happens by cancelling the whole certificate. Runs as the
-- invoking role — if the parent row is invisible (no tenant bound), the
-- status lookup yields NULL and the mutation is refused rather than
-- waved through (0017 posture).
CREATE FUNCTION app_private.guard_pac_certificate_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PAC certificate lines are released by cancelling their certificate, never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PAC certificate lines are immutable; cancel the certificate and re-record instead';
  END IF;

  SELECT status INTO parent_status
  FROM pac_certificates
  WHERE organisation_id = NEW.organisation_id AND id = NEW.pac_certificate_id;

  IF parent_status IS DISTINCT FROM 'recorded' THEN
    RAISE EXCEPTION 'certified quantities attach only to a recorded PAC certificate';
  END IF;
  RETURN NEW;
END
$$;

-- 4. Product date invariant (§5.5), held in the database: a PAC issue
-- date is never in the future ("today" in the organisation's own
-- timezone) and never precedes the Work's LOA letter date — the 0010
-- challan guard, mirrored for issue_date exactly as 0017 mirrored it for
-- installed_on. Steps aside when the works row is invisible; the foreign
-- keys still hold.
CREATE FUNCTION app_private.guard_pac_certificate_date()
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

  IF NEW.issue_date > v_today THEN
    RAISE EXCEPTION 'issue_date % is in the future (today is % in the organisation timezone)',
      NEW.issue_date, v_today
      USING ERRCODE = '23514';
  END IF;

  IF NEW.issue_date < v_letter_date THEN
    RAISE EXCEPTION 'issue_date % precedes the LOA letter date %',
      NEW.issue_date, v_letter_date
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- Guard triggers sort alphabetically before the touch trigger so
-- violations raise before updated_at churn (0003 ordering note).
CREATE TRIGGER pac_certificates_guard_delete
BEFORE DELETE ON pac_certificates
FOR EACH ROW EXECUTE FUNCTION app_private.guard_pac_certificate_delete();

CREATE TRIGGER pac_certificates_guard_update
BEFORE UPDATE ON pac_certificates
FOR EACH ROW EXECUTE FUNCTION app_private.guard_pac_certificate_update();

CREATE TRIGGER pac_certificates_date_guard
BEFORE INSERT OR UPDATE OF issue_date ON pac_certificates
FOR EACH ROW EXECUTE FUNCTION app_private.guard_pac_certificate_date();

CREATE TRIGGER pac_certificates_touch_updated_at
BEFORE UPDATE ON pac_certificates
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TRIGGER pac_certificate_items_guard_mutation
BEFORE INSERT OR UPDATE OR DELETE ON pac_certificate_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_pac_certificate_item_mutation();

-- 5. RLS: tenant policy on every new table.
ALTER TABLE pac_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pac_certificates FORCE ROW LEVEL SECURITY;
ALTER TABLE pac_certificate_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE pac_certificate_items FORCE ROW LEVEL SECURITY;

CREATE POLICY pac_certificates_tenant_policy ON pac_certificates
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY pac_certificate_items_tenant_policy ON pac_certificate_items
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- 6. Grants. Recorded certificates cancel, never delete: no DELETE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON pac_certificates, pac_certificate_items TO auto_mb_app;
  END IF;
END
$$;
