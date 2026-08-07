SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- 1. An issued Delivery Challan must record who issued it (PRODUCT.md
-- invariant 12). The original status CHECK required the cancel actor but
-- not the issue actor.
ALTER TABLE delivery_challans
  ADD CONSTRAINT delivery_challans_issued_actor_check
  CHECK (status = 'draft' OR issued_by_user_id IS NOT NULL);

-- 2. Sequence numbers are serialised per Work at the database, not only by
-- the counter row and the free-text prefix (PRODUCT.md invariant 4): two
-- challans on one Work can never share a sequence number even if the
-- counter is corrupted.
CREATE UNIQUE INDEX delivery_challans_sequence_per_work
  ON delivery_challans (organisation_id, work_id, sequence_number)
  WHERE sequence_number IS NOT NULL;

-- 3. Challan counters only move forward; a decreased counter is how
-- numbers get reused.
CREATE FUNCTION app_private.guard_counter_decrease()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION 'delivery challan counters must not decrease';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER delivery_challan_counters_guard_decrease
BEFORE UPDATE ON delivery_challan_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

-- 4. updated_at is maintained by the database, so list orderings such as
-- works_list_idx (updated_at DESC) reflect modification, not insertion.
CREATE FUNCTION app_private.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER organisations_touch_updated_at
BEFORE UPDATE ON organisations
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER organisation_memberships_touch_updated_at
BEFORE UPDATE ON organisation_memberships
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER works_touch_updated_at
BEFORE UPDATE ON works
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER work_items_touch_updated_at
BEFORE UPDATE ON work_items
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER loa_documents_touch_updated_at
BEFORE UPDATE ON loa_documents
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
-- Runs after the alphabetical-earlier guard trigger, so immutability
-- violations still raise before the timestamp is touched, and the issued
-- immutability ROW comparison does not include updated_at.
CREATE TRIGGER delivery_challans_touch_updated_at
BEFORE UPDATE ON delivery_challans
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER delivery_challan_counters_touch_updated_at
BEFORE UPDATE ON delivery_challan_counters
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- 5. Soft-deleted business records stay reserved (PRODUCT.md invariants 1
-- and 10): the application role must not be able to hard-delete the rows
-- that anchor work_code / letter_number reservations, tenant identity, or
-- numbering state. Drafts (challans, their lines), memberships, and
-- schedules keep DELETE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    REVOKE DELETE ON
      organisations,
      works,
      work_items,
      loa_documents,
      delivery_challan_counters
    FROM auto_mb_app;
  END IF;
END
$$;

-- 6. LOA object keys are tenant-prefixed and unique across the shared
-- bucket, so one organisation's upload can never overwrite another's.
-- Pre-production: only integration-test residue can exist, so non-conforming
-- rows are removed rather than migrated. Remove this DELETE pattern once a
-- production deployment exists.
DELETE FROM loa_documents
WHERE object_key NOT LIKE organisation_id::text || '/%';

ALTER TABLE loa_documents
  ADD CONSTRAINT loa_documents_object_key_tenant_prefix_check
  CHECK (object_key LIKE organisation_id::text || '/%');

CREATE UNIQUE INDEX loa_documents_object_key_unique
  ON loa_documents (object_key);

-- 7. Guardrails the 0002 assertions missed: role-membership escalation and
-- RLS coverage. Direct attributes were already checked; membership in
-- privileged roles defeats those checks silently.
DO $$
DECLARE
  unprotected_count integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    IF pg_has_role('auto_mb_app', 'pg_read_all_data', 'MEMBER')
      OR pg_has_role('auto_mb_app', 'pg_write_all_data', 'MEMBER') THEN
      RAISE EXCEPTION 'auto_mb_app must not be a member of pg_read_all_data or pg_write_all_data';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_owner')
      AND pg_has_role('auto_mb_app', 'auto_mb_owner', 'MEMBER') THEN
      RAISE EXCEPTION 'auto_mb_app must not be a member of auto_mb_owner';
    END IF;
  END IF;

  SELECT count(*) INTO unprotected_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname <> 'schema_migrations'
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected_count > 0 THEN
    RAISE EXCEPTION 'every public table except schema_migrations must have RLS enabled and forced';
  END IF;
END
$$;
