-- Migration 0046: bind the delivery and installation quantity CEILINGS in the
-- database, prove 0045's merge provenance is complete, scope the tax-invoice
-- Measurement Book guard to its own tenant, and index the foreign keys that
-- had no usable index.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- 1. Finding 3.1 — 0045's preflight and its backfill did not agree.
--
-- The preflight accepted a merged record Measurement Book when ANY
-- measurement_book.merged audit event named it, but the backfill read only the
-- LATEST event per target (ORDER BY occurred_at DESC, id DESC LIMIT 1). The
-- merge route always creates a fresh target, so a route-created database has
-- exactly one event per target and the two agree; a legacy or non-route writer
-- that merged twice into one target would have passed the preflight and then
-- been backfilled from the newest event only, silently losing the provenance of
-- the earlier merge.
--
-- 0045 is applied and hash-ledgered, so it cannot be corrected in place. This
-- assertion is the correction: every live merged record must now be provable
-- from the normalized provenance table, not from audit JSON. A database that
-- lost rows to the asymmetry fails here, loudly, with the repair named —
-- instead of discovering the gap at un-merge time.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  unproven_count integer;
  sample text;
BEGIN
  SELECT count(*), min(record.id::text) INTO unproven_count, sample
  FROM measurement_books record
  WHERE record.kind = 'record' AND record.status = 'merged'
    AND NOT EXISTS (
      SELECT 1
      FROM measurement_book_merge_provenance provenance
      WHERE provenance.organisation_id = record.organisation_id
        AND provenance.record_measurement_book_id = record.id
        AND provenance.target_measurement_book_id = record.merged_into_id
    );

  IF unproven_count > 0 THEN
    RAISE EXCEPTION
      '0046 found % merged record Measurement Book(s) with no merge provenance row (for example %); 0045 backfilled only the latest merge event per target, so repair the missing provenance from the measurement_book.merged audit events before migrating',
      unproven_count, sample
      USING ERRCODE = '23514';
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. Finding 2.1 — the installation ceiling, enforced at the row.
--
-- 0030 bound the amendment FLOOR: a sanctioned quantity may not drop below
-- what is already delivered, installed, or certified. Nothing bound the
-- CEILING, so a direct-SQL writer, an importer, or a future handler could
-- record installations beyond the sanctioned quantity and the 0030 floor would
-- then ratify that breach permanently. This is exactly the writer class 0030's
-- own comment says triggers exist to bind.
--
-- R5, first half, and the shape the recording route already enforces
-- (apps/server/src/routes/installations.ts): cumulative installed quantity per
-- item never exceeds COALESCE(effective_quantity, awarded_quantity). The
-- aggregate counts status = 'recorded' rows, which is the whole non-cancelled
-- set (installations are only ever 'recorded' or 'cancelled'), so the trigger
-- and the route read the same number.
--
-- The excess-delivery toggle deliberately does NOT reach here. It lifts the
-- delivery cap only; installation is always capped at the sanctioned quantity.
--
-- Concurrency: two simultaneous recordings that each fit on their own can
-- jointly breach the ceiling, so the item row is taken FOR UPDATE before the
-- sum is read. The recording route locks works and then work_items; this
-- trigger takes only the work_items lock, a subset in the same order, so it
-- cannot invert any writer's lock order. On the route path the lock is already
-- held and re-taking it costs nothing.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_installation_quantity_ceiling()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ceiling numeric(18,3);
  v_item_number text;
  v_already numeric(18,3);
BEGIN
  -- A cancelled row releases its quantity and is outside every aggregate.
  IF NEW.status <> 'recorded' THEN
    RETURN NEW;
  END IF;

  -- An update that leaves a recorded row on the same item without raising its
  -- quantity cannot breach a ceiling it already satisfied. OLD is read only
  -- under an explicit TG_OP test: plpgsql leaves it unassigned on INSERT and
  -- SQL boolean operators do not promise short-circuit evaluation.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'recorded'
       AND NEW.work_item_id = OLD.work_item_id
       AND NEW.quantity <= OLD.quantity THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT COALESCE(item.effective_quantity, item.awarded_quantity), item.item_number
    INTO v_ceiling, v_item_number
  FROM work_items item
  WHERE item.organisation_id = NEW.organisation_id
    AND item.id = NEW.work_item_id
  FOR UPDATE;

  IF v_ceiling IS NULL THEN
    RAISE EXCEPTION
      'installation names work item %, which this transaction cannot read',
      NEW.work_item_id
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(other.quantity), 0) INTO v_already
  FROM installations other
  WHERE other.organisation_id = NEW.organisation_id
    AND other.work_item_id = NEW.work_item_id
    AND other.status = 'recorded'
    AND other.id <> NEW.id;

  IF v_already + NEW.quantity > v_ceiling THEN
    RAISE EXCEPTION
      'installation ceiling: cumulative installation for % would reach % against the sanctioned quantity %',
      v_item_number, v_already + NEW.quantity, v_ceiling
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- Fires after installations_guard_insert / installations_guard_update, which
-- decide whether the write is a legal transition at all, and before
-- installations_touch_updated_at.
CREATE TRIGGER installations_quantity_ceiling_guard
BEFORE INSERT OR UPDATE ON installations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_installation_quantity_ceiling();

-- ---------------------------------------------------------------------
-- 3. Finding 2.1 — the delivery ceiling, enforced at the issue transition.
--
-- Delivery quantity becomes real when a Delivery Challan is issued: draft
-- lines deliver nothing, cancelled challans release their quantities, and 0001
-- already makes lines mutable only while the challan is draft. The issue
-- transition is therefore the complete gate, and it mirrors the check the issue
-- route runs (apps/server/src/routes/challans.ts): this challan's line quantity
-- plus everything already ISSUED for the same item must stay within
-- COALESCE(effective_quantity, awarded_quantity).
--
-- works.allow_excess_delivery lifts this cap and only this cap. That is the
-- product's deliberate escape hatch for a consignee who accepted more than the
-- sanctioned quantity; the installation ceiling above stays bound regardless.
--
-- Concurrency: the work_items rows this challan touches are taken FOR UPDATE in
-- ascending id order — the order the issue route uses — and each ceiling is
-- read from the locked row itself. A writer that lowered the sanctioned
-- quantity while this issue waited therefore wins: the row-lock release
-- re-evaluates against the committed version, so the challan is measured
-- against the new ceiling rather than the one that was current when the
-- statement began.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_delivery_challan_quantity_ceiling()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_allow_excess boolean;
  v_line record;
  v_delivered numeric(18,3);
  v_breaches text[] := ARRAY[]::text[];
BEGIN
  IF NEW.status <> 'issued' THEN
    RETURN NEW;
  END IF;
  -- Only the draft -> issued transition adds delivered quantity. Later updates
  -- of an already-issued challan (render pointers, warranty stamps) change no
  -- line, and 0001 keeps the lines themselves frozen once the challan leaves
  -- draft. OLD is read only under an explicit TG_OP test: plpgsql leaves it
  -- unassigned on INSERT and SQL boolean operators do not promise
  -- short-circuit evaluation.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'issued' THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT work.allow_excess_delivery INTO v_allow_excess
  FROM works work
  WHERE work.organisation_id = NEW.organisation_id AND work.id = NEW.work_id;
  -- An unreadable Work leaves v_allow_excess NULL, which is not true, so the
  -- check below still runs: the cap is lifted only by a Work that says so.
  IF v_allow_excess THEN
    RETURN NEW;
  END IF;

  FOR v_line IN
    SELECT item.id AS work_item_id,
           item.item_number,
           COALESCE(item.effective_quantity, item.awarded_quantity) AS ceiling,
           line.quantity
    FROM delivery_challan_items line
    JOIN work_items item
      ON item.organisation_id = line.organisation_id AND item.id = line.work_item_id
    WHERE line.organisation_id = NEW.organisation_id
      AND line.delivery_challan_id = NEW.id
    ORDER BY item.id
    FOR UPDATE OF item
  LOOP
    SELECT COALESCE(sum(issued_line.quantity), 0) INTO v_delivered
    FROM delivery_challan_items issued_line
    JOIN delivery_challans issued
      ON issued.organisation_id = issued_line.organisation_id
     AND issued.id = issued_line.delivery_challan_id
    WHERE issued_line.organisation_id = NEW.organisation_id
      AND issued_line.work_item_id = v_line.work_item_id
      AND issued_line.delivery_challan_id <> NEW.id
      AND issued.status = 'issued';

    IF v_delivered + v_line.quantity > v_line.ceiling THEN
      v_breaches := v_breaches || (
        v_line.item_number || ' (' || (v_delivered + v_line.quantity)::text
        || ' against ' || v_line.ceiling::text || ')'
      );
    END IF;
  END LOOP;

  IF array_length(v_breaches, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'delivery ceiling: issuing this Delivery Challan would exceed the sanctioned quantity for: %',
      array_to_string(v_breaches, ', ')
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- Fires after delivery_challans_guard_insert / delivery_challans_guard_update,
-- which decide whether the transition itself is legal, and before
-- delivery_challans_touch_updated_at.
CREATE TRIGGER delivery_challans_quantity_ceiling_guard
BEFORE INSERT OR UPDATE ON delivery_challans
FOR EACH ROW EXECUTE FUNCTION app_private.guard_delivery_challan_quantity_ceiling();

-- ---------------------------------------------------------------------
-- 4. Info finding — the tax-invoice Measurement Book guard reads one tenant.
--
-- guard_tax_invoice_mb (0039) is SECURITY DEFINER and owned by a role that
-- bypasses row-level security, and it looked up measurement_books by id alone.
-- Binding an invoice to another tenant's Measurement Book was already
-- impossible — the composite foreign key on (organisation_id,
-- measurement_book_id) refuses it — but this was the only guard that read
-- another tenant's rows while deciding. The organisation predicate below makes
-- the read match the tenancy the constraint already enforces; a foreign id now
-- reports the Measurement Book as missing rather than reporting its kind or
-- status. Everything else is unchanged.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.guard_tax_invoice_mb()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_kind text;
  v_work uuid;
BEGIN
  IF NEW.measurement_book_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT status, kind, work_id INTO v_status, v_kind, v_work
    FROM measurement_books
    WHERE id = NEW.measurement_book_id
      AND organisation_id = NEW.organisation_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'measurement book % is missing', NEW.measurement_book_id;
  END IF;
  IF v_kind = 'record' THEN
    RAISE EXCEPTION
      'measurement book % is a record MB — merge it into an on-account MB before invoicing',
      NEW.measurement_book_id;
  END IF;
  IF v_status <> 'finalized' THEN
    RAISE EXCEPTION
      'measurement book % is % — only a finalized MB can be invoiced',
      NEW.measurement_book_id, v_status;
  END IF;
  IF v_work IS DISTINCT FROM NEW.work_id THEN
    RAISE EXCEPTION 'measurement book % belongs to another work',
      NEW.measurement_book_id;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 5. Finding 4.1 — foreign keys with no usable index.
--
-- Each of these columns is the referencing side of a foreign key with no index
-- whose leading columns match it, so every delete or key update on the parent
-- takes a sequential scan of the child, and ordinary lookups by the parent id
-- do the same. Existing partial indexes on some of these columns
-- (eway_bills_one_live_per_invoice, installation_serials_one_live_per_serial,
-- work_items_work_idx, mb_entries_unbilled_idx) are filtered, so referential
-- integrity cannot use them and full-row lookups fall back to a scan.
--
-- Every index leads with organisation_id, matching the tenant predicate that
-- row-level security adds to every query. Written as plain CREATE INDEX because
-- the migration runner wraps each file in one transaction, where CONCURRENTLY
-- is not available; the tables are small enough for the 2s lock_timeout above
-- to bound the ACCESS SHARE / SHARE lock wait.
-- ---------------------------------------------------------------------
CREATE INDEX challan_item_serials_challan_idx
  ON challan_item_serials (organisation_id, delivery_challan_id);

CREATE INDEX mb_entries_challan_idx
  ON mb_entries (organisation_id, delivery_challan_id);

-- A prefix of work_items_organisation_id_schedule_id_work_id_fkey; the
-- remaining work_id equality is a cheap recheck on the fetched row.
CREATE INDEX work_items_schedule_idx
  ON work_items (organisation_id, schedule_id);

CREATE INDEX installation_serials_serial_idx
  ON installation_serials (organisation_id, challan_item_serial_id);

CREATE INDEX eway_bills_invoice_idx
  ON eway_bills (organisation_id, tax_invoice_id);

CREATE INDEX measurement_book_merge_provenance_record_idx
  ON measurement_book_merge_provenance (organisation_id, record_measurement_book_id);

CREATE INDEX loa_documents_confirmed_work_idx
  ON loa_documents (organisation_id, confirmed_work_id);

-- ---------------------------------------------------------------------
-- 6. The RLS posture 0003 asserts at catalog level still holds.
--
-- This migration creates no table, so nothing new can escape it; the assertion
-- is repeated here so the claim is proved by this migration rather than assumed
-- from an earlier one. The new triggers are SECURITY INVOKER, so under the
-- application role their aggregate reads stay inside the caller's tenant, and
-- the tenant predicates written into them keep that true for the bypassing
-- roles as well.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  unprotected_count integer;
BEGIN
  SELECT count(*) INTO unprotected_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname <> 'schema_migrations'
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected_count > 0 THEN
    RAISE EXCEPTION
      'every public table except schema_migrations must have RLS enabled and forced';
  END IF;
END
$$;
