SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 6/7 retrofit (Track 1): the unified Contacts master.
--
-- Legacy (docs/reference/legacy-product-spec.md §9) models ONE Contacts
-- master carrying role flags — is_consignee / is_vendor / is_client — not
-- a standalone consignee table. This migration moves the schema to that
-- shape while ACTIVATING ONLY THE CONSIGNEE ROLE: the is_vendor and
-- is_client columns exist so procurement (PO/BQ, legacy §5.8) lands
-- without another master migration, but NOTHING sets them yet — no API
-- accepts them, no picker reads them, and they stay false until the
-- procurement wave is accepted into scope. State duplicated in
-- apps/server/src/routes/masters.ts.
--
-- consignee_masters (0013) is replaced: its rows move into contacts
-- KEEPING THEIR PRIMARY KEYS, so the pac_certificates provenance FK
-- re-points without a mapping table, and a compatibility VIEW named
-- consignee_masters remains so existing readers/writers of the old name
-- (the PAC route's picker lookup, the v1 importer's master upsert — both
-- owned by a concurrent hardening wave) keep working against the same
-- rows. The view is not a tenant table: RLS lives on contacts and applies
-- through security_invoker.

-- 1. The contacts table. Field semantics follow §9: designation is the
-- railway-facing name ("Sr. DEE (G) CR"); GSTIN is format-validated and
-- stored uppercase, and TDS-deductor GSTINs ending in 'D' must be
-- accepted because railway units are deductors (spec §2 GSTIN, §5.7
-- "deductor GSTINs ending in D accepted"). The two accepted shapes:
--   standard  ^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$
--             (state code, PAN, entity code, the fixed 'Z', check char)
--   deductor  ^[0-9]{2}[0-9A-Z]{12}D$
--             (state code + TAN-based body, ending in the deductor 'D')
-- Both character classes are uppercase-only, so the CHECK also enforces
-- the uppercase rule; the API uppercases input before validating.
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  designation text NOT NULL CHECK (length(btrim(designation)) BETWEEN 2 AND 200),
  contact_person text
    CHECK (contact_person IS NULL OR length(btrim(contact_person)) BETWEEN 2 AND 200),
  address text CHECK (address IS NULL OR length(btrim(address)) BETWEEN 3 AND 1000),
  phone text CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 3 AND 30),
  email text CHECK (email IS NULL OR length(btrim(email)) BETWEEN 3 AND 200),
  gstin text CHECK (
    gstin IS NULL
    OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'
    OR gstin ~ '^[0-9]{2}[0-9A-Z]{12}D$'
  ),
  pincode text CHECK (pincode IS NULL OR pincode ~ '^[0-9]{6}$'),
  state_code text CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),
  is_consignee boolean NOT NULL DEFAULT false,
  -- Dormant until the procurement wave: columns only, never set, ignored
  -- by every picker.
  is_vendor boolean NOT NULL DEFAULT false,
  is_client boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id)
);

-- Duplicate guard, carried over from 0013: a railway contact is a
-- DESIGNATION posted at an ADDRESS, so uniqueness is the case-insensitive
-- pair per organisation with NULL address folding to ''. Scoped to ACTIVE
-- rows (the retrofit's refinement): a retired contact no longer blocks
-- re-creating the designation — reactivating the retired twin instead is
-- still offered by the API's 409, and a reactivation that would collide
-- with a live row answers 409 rather than resurrecting a duplicate.
CREATE UNIQUE INDEX contacts_org_designation_address_active
  ON contacts (organisation_id, lower(designation), lower(coalesce(address, '')))
  WHERE active;

-- Pickers list active consignee contacts per organisation.
CREATE INDEX contacts_org_consignee_idx
  ON contacts (organisation_id, is_consignee, active);

-- 2. Data migration: every consignee master becomes a consignee-role
-- contact, PRESERVING id, lifecycle flag, creator, and timestamps — the
-- primary keys carry over, so the referencing FK below re-points with no
-- mapping table. RLS on the old table is dropped for the copy (we are
-- about to drop the table itself); contacts' RLS is enabled only after
-- the copy so the migration works for a non-superuser owner role too.
ALTER TABLE consignee_masters NO FORCE ROW LEVEL SECURITY;
ALTER TABLE consignee_masters DISABLE ROW LEVEL SECURITY;

INSERT INTO contacts (
  id, organisation_id, designation, contact_person, address, phone, email,
  is_consignee, active, created_by_user_id, created_at, updated_at
)
SELECT id, organisation_id, designation, contact_person, address, phone, email,
       true, active, created_by_user_id, created_at, updated_at
FROM consignee_masters;

-- 3. Re-point the one referencing FK. Delivery challans never referenced
-- consignee_masters (their consignee is a free-text snapshot, 0013
-- posture), so pac_certificates.consignee_master_id is the only edge.
-- The COLUMN NAME IS KEPT: renaming it to contact_id would force edits in
-- the PAC route owned by the concurrent hardening wave for zero data
-- benefit — the comment records what the column now references, and the
-- id values are identical by construction.
ALTER TABLE pac_certificates
  DROP CONSTRAINT pac_certificates_organisation_id_consignee_master_id_fkey;
ALTER TABLE pac_certificates
  ADD CONSTRAINT pac_certificates_organisation_id_consignee_master_id_fkey
  FOREIGN KEY (organisation_id, consignee_master_id)
  REFERENCES contacts(organisation_id, id);

COMMENT ON COLUMN pac_certificates.consignee_master_id IS
  'Provenance FK into contacts(id) (consignee role) since migration 0028; '
  'the historical name is kept so the PAC route needs no change. The '
  'certified record is consignee_designation, snapshotted at record time.';

-- 4. Replace the table with the compatibility view. Straggler SQL that
-- still names consignee_masters (the PAC route's active-consignee lookup;
-- the v1 importer's SELECT + INSERT) resolves to consignee-role contacts:
--   * security_invoker: privileges AND the contacts RLS policy are
--     checked as the calling role, so tenant isolation is exactly the
--     base table's;
--   * the view carries is_consignee with a view-level DEFAULT true, so an
--     INSERT through the old name lands as a consignee contact;
--   * WITH LOCAL CHECK OPTION keeps view writes inside the consignee
--     subset (a row written through the view can never drop out of it).
DROP TABLE consignee_masters;

CREATE VIEW consignee_masters
WITH (security_invoker = true)
AS
  SELECT id, organisation_id, designation, address, contact_person, phone,
         email, active, created_by_user_id, created_at, updated_at,
         is_consignee
  FROM contacts
  WHERE is_consignee
WITH LOCAL CHECK OPTION;

ALTER VIEW consignee_masters ALTER COLUMN is_consignee SET DEFAULT true;

COMMENT ON VIEW consignee_masters IS
  'Compatibility surface over contacts WHERE is_consignee (migration '
  '0028). Not a tenant table: RLS lives on contacts and applies through '
  'security_invoker. New code reads and writes contacts directly.';

-- 5. Work <-> consignee association (legacy rule R16: "a work may have
-- many consignees; the challan picks one"). The association is an
-- ORGANISATIONAL PREFERENCE LIST, not a document: challans and PAC
-- certificates snapshot the consignee they used, so linking or unlinking
-- a contact never rewrites any record — which is why DELETE is granted
-- here (and only here among the masters family): removing an association
-- destroys no history, exactly like removing a work_assignment.
CREATE TABLE work_consignees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, work_id, contact_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  FOREIGN KEY (organisation_id, contact_id) REFERENCES contacts(organisation_id, id)
);

CREATE INDEX work_consignees_contact_idx
  ON work_consignees (organisation_id, contact_id);

-- Only consignee-role contacts may be associated (R16's positive half;
-- the API also refuses authority designations before a contact ever
-- becomes a consignee). Runs as the invoking role — if the contact row is
-- invisible (no tenant bound), the lookup yields NULL and the association
-- is refused rather than waved through (0017/0022 posture).
CREATE FUNCTION app_private.guard_work_consignee_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_consignee boolean;
BEGIN
  SELECT c.is_consignee INTO v_is_consignee
  FROM contacts c
  WHERE c.organisation_id = NEW.organisation_id AND c.id = NEW.contact_id;

  IF v_is_consignee IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'work consignees must be consignee-role contacts (R16)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER work_consignees_guard_role
BEFORE INSERT OR UPDATE ON work_consignees
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_consignee_role();

-- 6. updated_at upkeep on contacts (work_consignees rows are immutable
-- create/delete facts and carry no updated_at).
CREATE TRIGGER contacts_touch_updated_at
BEFORE UPDATE ON contacts
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- 7. RLS: tenant policy on both new tables, enabled after the data copy.
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE work_consignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_consignees FORCE ROW LEVEL SECURITY;

CREATE POLICY contacts_tenant_policy ON contacts
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY work_consignees_tenant_policy ON work_consignees
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- 8. Grants. Contacts retire, never delete (0013 posture: no DELETE
-- privilege exists). The association keeps DELETE — see the table comment
-- above. The compatibility view needs its own grants (SELECT for the PAC
-- route's lookup, INSERT for the importer's master upsert); privileges on
-- contacts are then re-checked for the same invoker underneath.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON contacts TO auto_mb_app;
    GRANT SELECT, INSERT, DELETE ON work_consignees TO auto_mb_app;
    GRANT SELECT, INSERT ON consignee_masters TO auto_mb_app;
  END IF;
END
$$;
