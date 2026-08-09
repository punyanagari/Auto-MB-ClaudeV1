SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 7: contract-domain master data + organisation profile
-- completion. Masters are PICKERS ONLY: documents keep their own
-- snapshots (the Delivery Challan consignee stays a free-text snapshot on
-- the challan — packages/contracts/src/challans.ts), so a master edit or
-- retire never rewrites history and no document table carries a foreign
-- key into a masters table. Masters retire (active = false) instead of
-- being deleted: the application role holds NO DELETE privilege on any of
-- these tables, so a hard delete does not exist even for unreferenced
-- rows. Retiring is always allowed and reversible.

-- 1. Consignee masters. Duplicate guard choice: a railway consignee is a
-- DESIGNATION posted at an ADDRESS ("Sr. DEE (G) NR, Delhi Division").
-- The same designation legitimately exists at two addresses (two
-- divisions), so uniqueness is the case-insensitive pair
-- (designation, address) per organisation, with a NULL address folding to
-- '' — exactly one address-less entry per designation.
CREATE TABLE consignee_masters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  designation text NOT NULL CHECK (length(btrim(designation)) BETWEEN 2 AND 200),
  address text CHECK (address IS NULL OR length(btrim(address)) BETWEEN 3 AND 1000),
  contact_person text
    CHECK (contact_person IS NULL OR length(btrim(contact_person)) BETWEEN 2 AND 200),
  phone text CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 3 AND 30),
  email text CHECK (email IS NULL OR length(btrim(email)) BETWEEN 3 AND 200),
  active boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id)
);

CREATE UNIQUE INDEX consignee_masters_org_designation_address
  ON consignee_masters (organisation_id, lower(designation), lower(coalesce(address, '')));

-- 2. Location masters: stations, installation points, stores. The same
-- name may recur across kinds (a station and its co-located store), so
-- uniqueness is (name, kind) per organisation, case-insensitive on name.
CREATE TABLE location_masters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  kind text NOT NULL CHECK (kind IN ('station', 'installation_point', 'store', 'other')),
  active boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id)
);

CREATE UNIQUE INDEX location_masters_org_name_kind
  ON location_masters (organisation_id, lower(name), kind);

-- 3. Unit masters. Tenant-owned, so there is deliberately NO global seed
-- here: each organisation's defaults are inserted lazily by the unit
-- list route (apps/server/src/routes/masters.ts) from the LOA parser's
-- canonical unit list, idempotently via ON CONFLICT DO NOTHING against
-- the unique index below — a retired default therefore stays retired
-- across re-seeds, and concurrent first calls converge on one row set.
CREATE TABLE unit_masters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id)
);

CREATE UNIQUE INDEX unit_masters_org_name
  ON unit_masters (organisation_id, lower(name));

-- 4. Organisation signatories: the people whose name/designation blocks
-- appear on generated documents (consumed by later document work; CRUD
-- only here).
CREATE TABLE organisation_signatories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  designation text NOT NULL CHECK (length(btrim(designation)) BETWEEN 2 AND 200),
  active boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id)
);

CREATE UNIQUE INDEX organisation_signatories_org_name_designation
  ON organisation_signatories (organisation_id, lower(name), lower(designation));

-- 5. Organisation profile completion (0007 pattern): the warranty
-- agreement template a later warranty document generator will consume.
-- Schema + CRUD only — nothing renders it yet.
ALTER TABLE organisations
  ADD COLUMN warranty_template_text text
    CHECK (
      warranty_template_text IS NULL
      OR length(warranty_template_text) BETWEEN 1 AND 20000
    );

-- 6. Touch triggers for updated_at.
CREATE TRIGGER consignee_masters_touch_updated_at
BEFORE UPDATE ON consignee_masters
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TRIGGER location_masters_touch_updated_at
BEFORE UPDATE ON location_masters
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TRIGGER unit_masters_touch_updated_at
BEFORE UPDATE ON unit_masters
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TRIGGER organisation_signatories_touch_updated_at
BEFORE UPDATE ON organisation_signatories
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- 7. RLS: tenant policy on every new table.
ALTER TABLE consignee_masters ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignee_masters FORCE ROW LEVEL SECURITY;
ALTER TABLE location_masters ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_masters FORCE ROW LEVEL SECURITY;
ALTER TABLE unit_masters ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_masters FORCE ROW LEVEL SECURITY;
ALTER TABLE organisation_signatories ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_signatories FORCE ROW LEVEL SECURITY;

CREATE POLICY consignee_masters_tenant_policy ON consignee_masters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY location_masters_tenant_policy ON location_masters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY unit_masters_tenant_policy ON unit_masters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY organisation_signatories_tenant_policy ON organisation_signatories
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- 8. Grants: no DELETE anywhere — masters retire, they are never erased.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON
      consignee_masters,
      location_masters,
      unit_masters,
      organisation_signatories
    TO auto_mb_app;
  END IF;
END
$$;
