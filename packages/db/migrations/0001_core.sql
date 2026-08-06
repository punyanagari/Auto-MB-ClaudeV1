SET lock_timeout = '2s';
SET statement_timeout = '5min';

CREATE SCHEMA IF NOT EXISTS app_private;

CREATE FUNCTION app_private.current_organisation_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.organisation_id', true), '')::uuid
$$;

CREATE FUNCTION app_private.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.user_id', true), '')
$$;

REVOKE ALL ON FUNCTION app_private.current_organisation_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.current_user_id() FROM PUBLIC;

CREATE TABLE organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organisation_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'office', 'site', 'viewer')),
  work_scope text NOT NULL DEFAULT 'all' CHECK (work_scope IN ('all', 'assigned')),
  can_issue_documents boolean NOT NULL DEFAULT false,
  can_cancel_documents boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, user_id)
);

CREATE TABLE works (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_code text NOT NULL CHECK (
    length(work_code) BETWEEN 1 AND 20
    AND work_code ~ '^[A-Z0-9][A-Z0-9_/-]*$'
  ),
  letter_number text NOT NULL CHECK (length(btrim(letter_number)) BETWEEN 1 AND 200),
  letter_date date NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 1000),
  advertised_value numeric(18,2) NOT NULL CHECK (advertised_value >= 0),
  contract_value numeric(18,2) NOT NULL CHECK (contract_value >= 0),
  pricing_shape text NOT NULL CHECK (pricing_shape IN ('letter_percentage', 'per_schedule')),
  letter_percentage numeric(6,3),
  letter_percentage_direction text CHECK (
    letter_percentage_direction IS NULL
    OR letter_percentage_direction IN ('below', 'at_par', 'above')
  ),
  allow_excess_delivery boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, work_code),
  UNIQUE (organisation_id, letter_number),
  CHECK (
    (pricing_shape = 'letter_percentage' AND letter_percentage IS NOT NULL AND letter_percentage_direction IS NOT NULL)
    OR
    (pricing_shape = 'per_schedule' AND letter_percentage IS NULL AND letter_percentage_direction IS NULL)
  )
);

CREATE TABLE work_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  schedule_code text NOT NULL CHECK (length(btrim(schedule_code)) BETWEEN 1 AND 50),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 1000),
  position integer NOT NULL CHECK (position > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, id, work_id),
  UNIQUE (organisation_id, work_id, schedule_code),
  UNIQUE (organisation_id, work_id, position),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

CREATE TABLE work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  item_number text NOT NULL CHECK (length(btrim(item_number)) BETWEEN 1 AND 100),
  description text NOT NULL CHECK (length(btrim(description)) >= 3),
  unit_code text NOT NULL CHECK (length(btrim(unit_code)) BETWEEN 1 AND 20),
  awarded_quantity numeric(18,3) NOT NULL CHECK (awarded_quantity > 0),
  effective_rate numeric(18,2) NOT NULL CHECK (effective_rate >= 0),
  requires_serials boolean NOT NULL DEFAULT false,
  payment_category text,
  source_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, id, work_id),
  UNIQUE (organisation_id, work_id, item_number),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  FOREIGN KEY (organisation_id, schedule_id, work_id) REFERENCES work_schedules(organisation_id, id, work_id)
);

CREATE TABLE loa_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  object_key text NOT NULL,
  original_filename text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text NOT NULL CHECK (media_type = 'application/pdf'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  extraction_status text NOT NULL DEFAULT 'pending' CHECK (
    extraction_status IN ('pending', 'processing', 'review', 'confirmed', 'failed')
  ),
  extraction_payload jsonb,
  confirmed_work_id uuid,
  uploaded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, object_key),
  FOREIGN KEY (organisation_id, confirmed_work_id) REFERENCES works(organisation_id, id)
);

CREATE TABLE delivery_challans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'cancelled')),
  challan_date date NOT NULL,
  challan_number text,
  sequence_number integer CHECK (sequence_number IS NULL OR sequence_number > 0),
  prefix text NOT NULL CHECK (length(prefix) BETWEEN 1 AND 25 AND prefix ~ '^[A-Z0-9][A-Z0-9_/-]*$'),
  consignee_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_snapshot jsonb,
  template_version text,
  rendered_object_key text,
  rendered_sha256 text CHECK (rendered_sha256 IS NULL OR rendered_sha256 ~ '^[0-9a-f]{64}$'),
  signed_copy_object_key text,
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
  CHECK (status <> 'draft' OR (issued_by_user_id IS NULL AND rendered_object_key IS NULL AND rendered_sha256 IS NULL AND signed_copy_object_key IS NULL))
);

CREATE UNIQUE INDEX delivery_challans_one_draft_per_work
  ON delivery_challans (organisation_id, work_id)
  WHERE status = 'draft';

CREATE TABLE delivery_challan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  delivery_challan_id uuid NOT NULL,
  work_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  description_snapshot text NOT NULL,
  unit_snapshot text NOT NULL,
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0),
  rate_snapshot numeric(18,2) NOT NULL CHECK (rate_snapshot >= 0),
  line_amount numeric(18,2) NOT NULL CHECK (line_amount >= 0),
  source_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL CHECK (position > 0),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, delivery_challan_id, work_item_id),
  UNIQUE (organisation_id, delivery_challan_id, position),
  FOREIGN KEY (organisation_id, delivery_challan_id, work_id) REFERENCES delivery_challans(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, work_item_id, work_id) REFERENCES work_items(organisation_id, id, work_id)
);

CREATE FUNCTION app_private.guard_delivery_challan_update()
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
      NEW.template_version, NEW.created_by_user_id, NEW.issued_by_user_id, NEW.issued_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.challan_date, OLD.challan_number,
      OLD.sequence_number, OLD.prefix, OLD.consignee_snapshot, OLD.issued_snapshot,
      OLD.template_version, OLD.created_by_user_id, OLD.issued_by_user_id, OLD.issued_at
    ) THEN
      RAISE EXCEPTION 'issued Delivery Challan business data is immutable';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Delivery Challans are deleted, not cancelled';
  END IF;

  RETURN NEW;
END
$$;

CREATE FUNCTION app_private.guard_delivery_challan_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'only draft Delivery Challans may be deleted';
  END IF;
  RETURN OLD;
END
$$;

CREATE FUNCTION app_private.guard_delivery_challan_item_mutation()
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
    target_challan_id := OLD.delivery_challan_id;
  ELSE
    target_organisation_id := NEW.organisation_id;
    target_challan_id := NEW.delivery_challan_id;
  END IF;

  SELECT status INTO target_status
  FROM delivery_challans
  WHERE organisation_id = target_organisation_id AND id = target_challan_id;

  IF target_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Delivery Challan lines are mutable only while the challan is draft';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER delivery_challans_guard_update
BEFORE UPDATE ON delivery_challans
FOR EACH ROW EXECUTE FUNCTION app_private.guard_delivery_challan_update();

CREATE TRIGGER delivery_challans_guard_delete
BEFORE DELETE ON delivery_challans
FOR EACH ROW EXECUTE FUNCTION app_private.guard_delivery_challan_delete();

CREATE TRIGGER delivery_challan_items_guard_mutation
BEFORE INSERT OR UPDATE OR DELETE ON delivery_challan_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_delivery_challan_item_mutation();

CREATE TABLE delivery_challan_counters (
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id text,
  action text NOT NULL CHECK (length(action) BETWEEN 3 AND 100),
  entity_type text NOT NULL CHECK (length(entity_type) BETWEEN 2 AND 100),
  entity_id uuid,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (organisation_id, id)
);

CREATE INDEX organisation_memberships_user_idx
  ON organisation_memberships (user_id, organisation_id)
  WHERE status = 'active';
CREATE INDEX works_list_idx
  ON works (organisation_id, status, updated_at DESC, id);
CREATE INDEX work_items_work_idx
  ON work_items (organisation_id, work_id, schedule_id, id)
  WHERE deleted_at IS NULL;
CREATE INDEX loa_documents_status_idx
  ON loa_documents (organisation_id, extraction_status, created_at DESC, id);
CREATE INDEX delivery_challans_work_idx
  ON delivery_challans (organisation_id, work_id, status, challan_date DESC, id);
CREATE INDEX delivery_challan_items_work_item_idx
  ON delivery_challan_items (organisation_id, work_item_id, delivery_challan_id);
CREATE INDEX audit_events_timeline_idx
  ON audit_events (organisation_id, occurred_at DESC, id);

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
ALTER TABLE organisation_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE works ENABLE ROW LEVEL SECURITY;
ALTER TABLE works FORCE ROW LEVEL SECURITY;
ALTER TABLE work_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_items FORCE ROW LEVEL SECURITY;
ALTER TABLE loa_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE loa_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_challans ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_challans FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_challan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_challan_items FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_challan_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_challan_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY organisations_tenant_policy ON organisations
  USING (id = app_private.current_organisation_id())
  WITH CHECK (id = app_private.current_organisation_id());

CREATE POLICY organisation_memberships_select_policy ON organisation_memberships
  FOR SELECT
  USING (
    organisation_id = app_private.current_organisation_id()
    OR user_id = app_private.current_user_id()
  );
CREATE POLICY organisation_memberships_insert_policy ON organisation_memberships
  FOR INSERT
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY organisation_memberships_update_policy ON organisation_memberships
  FOR UPDATE
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY organisation_memberships_delete_policy ON organisation_memberships
  FOR DELETE
  USING (organisation_id = app_private.current_organisation_id());
CREATE POLICY works_tenant_policy ON works
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY work_schedules_tenant_policy ON work_schedules
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY work_items_tenant_policy ON work_items
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY loa_documents_tenant_policy ON loa_documents
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY delivery_challans_tenant_policy ON delivery_challans
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY delivery_challan_items_tenant_policy ON delivery_challan_items
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY delivery_challan_counters_tenant_policy ON delivery_challan_counters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY audit_events_tenant_policy ON audit_events
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT USAGE ON SCHEMA public, app_private TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.current_organisation_id() TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.current_user_id() TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      organisations,
      organisation_memberships,
      works,
      work_schedules,
      work_items,
      loa_documents,
      delivery_challans,
      delivery_challan_items,
      delivery_challan_counters
    TO auto_mb_app;
    GRANT SELECT, INSERT ON audit_events TO auto_mb_app;
  END IF;
END
$$;
