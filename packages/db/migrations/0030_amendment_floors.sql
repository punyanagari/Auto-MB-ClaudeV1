SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 6/7 retrofit (Track 1): R7 completed in the DATABASE.
--
-- The route layer already refused a quantity reduction below the
-- delivered and installed sums. Three obligations of R7 were still
-- unenforced anywhere, and two of them were unenforceable by a route
-- alone (a direct-SQL writer, an importer, or a future handler could
-- breach them silently):
--
--   * the PAC certified floor — R18 caps certification at the installed
--     quantity, so a ceiling drop below the certified total would
--     retroactively breach R18 as well as R7;
--   * item OMISSION as soft-delete — permitted only while the item
--     carries no delivery, installation, PAC, or billing evidence, and
--     never as an erasure (item numbers stay reserved forever, R7 +
--     R1's "codes are not reusable" discipline);
--   * requires_serials as a ONE-WAY flag — enabling serial tracking is
--     always allowed, switching it off once serials exist is not.
--
-- All three land here as triggers on work_items, so every writer is
-- bound. The routes keep their friendly 409s; these are the floor under
-- them.

-- ---------------------------------------------------------------------
-- 1. The amendment floor, enforced at the row.
--
-- effective_quantity is the sanctioned ceiling. It may never drop below
-- what issued Delivery Challans delivered, what recorded installations
-- installed, or what recorded PAC certificates certified. The check runs
-- only when the ceiling actually moves DOWN, so ordinary updates (rate,
-- description, unit, payment category, soft-delete) pay nothing.
--
-- Cancelled documents release their quantities and are excluded, exactly
-- like every other aggregate in the product.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_work_item_quantity_floor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  new_ceiling numeric(18,3);
  old_ceiling numeric(18,3);
  delivered numeric(18,3);
  installed numeric(18,3);
  certified numeric(18,3);
BEGIN
  new_ceiling := COALESCE(NEW.effective_quantity, NEW.awarded_quantity);
  old_ceiling := COALESCE(OLD.effective_quantity, OLD.awarded_quantity);
  IF new_ceiling >= old_ceiling THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(sum(dci.quantity), 0) INTO delivered
  FROM delivery_challan_items dci
  JOIN delivery_challans dc ON dc.id = dci.delivery_challan_id
  WHERE dci.work_item_id = NEW.id AND dc.status = 'issued';

  SELECT COALESCE(sum(i.quantity), 0) INTO installed
  FROM installations i
  WHERE i.work_item_id = NEW.id AND i.status = 'recorded';

  SELECT COALESCE(sum(pci.certified_quantity), 0) INTO certified
  FROM pac_certificate_items pci
  JOIN pac_certificates pc ON pc.id = pci.pac_certificate_id
  WHERE pci.work_item_id = NEW.id AND pc.status = 'recorded';

  IF new_ceiling < GREATEST(delivered, installed, certified) THEN
    RAISE EXCEPTION
      'amendment floor: the quantity of % cannot go below the already-delivered %, the already-installed %, or the already-certified %',
      NEW.item_number, delivered, installed, certified
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER work_items_quantity_floor_guard
BEFORE UPDATE ON work_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_item_quantity_floor();

-- ---------------------------------------------------------------------
-- 2. Omission is a soft-delete, and only while the item is evidence-free.
--
-- R7: items are removable "only while nothing is delivered/installed".
-- The retrofit widens the evidence set to everything that would be
-- orphaned by the removal: PAC certification and billing (Measurement
-- Book lines carrying real quantity, which is also how a bill reaches an
-- item — bills hang off a Measurement Book, never off an item directly).
--
-- A finalised Measurement Book writes one line per item of the Work,
-- including all-zero lines for items it did not bill; only a line
-- carrying a non-zero delta or prior quantity is billing evidence.
--
-- Un-deleting is always allowed (an omission recorded in error is
-- reversible); erasure is not — see the DELETE guard below.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_work_item_omission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence text[] := ARRAY[]::text[];
  hits numeric;
BEGIN
  IF NOT (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(sum(dci.quantity), 0) INTO hits
  FROM delivery_challan_items dci
  JOIN delivery_challans dc ON dc.id = dci.delivery_challan_id
  WHERE dci.work_item_id = NEW.id AND dc.status <> 'cancelled';
  IF hits > 0 THEN
    evidence := evidence || ('delivery challans (' || hits::text || ')');
  END IF;

  SELECT COALESCE(sum(i.quantity), 0) INTO hits
  FROM installations i
  WHERE i.work_item_id = NEW.id AND i.status = 'recorded';
  IF hits > 0 THEN
    evidence := evidence || ('installations (' || hits::text || ')');
  END IF;

  SELECT COALESCE(sum(pci.certified_quantity), 0) INTO hits
  FROM pac_certificate_items pci
  JOIN pac_certificates pc ON pc.id = pci.pac_certificate_id
  WHERE pci.work_item_id = NEW.id AND pc.status = 'recorded';
  IF hits > 0 THEN
    evidence := evidence || ('PAC certificates (' || hits::text || ')');
  END IF;

  SELECT count(*) INTO hits
  FROM measurement_book_lines mbl
  JOIN measurement_books mb ON mb.id = mbl.measurement_book_id
  WHERE mbl.work_item_id = NEW.id
    AND mb.status <> 'cancelled'
    AND (
      mbl.delta_supplied <> 0 OR mbl.delta_installed <> 0
      OR mbl.delta_pac <> 0 OR mbl.delta_final_bill <> 0
      OR mbl.prior_supplied <> 0 OR mbl.prior_installed <> 0
      OR mbl.prior_pac <> 0 OR mbl.prior_final_bill <> 0
    );
  IF hits > 0 THEN
    evidence := evidence || ('Measurement Book lines (' || hits::text || ')');
  END IF;

  IF array_length(evidence, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'item % carries evidence and cannot be omitted: %',
      NEW.item_number, array_to_string(evidence, ', ')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER work_items_omission_guard
BEFORE UPDATE ON work_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_item_omission();

-- Erasure is never the removal path, and it already cannot be: the
-- privilege matrix grants the application role SELECT/INSERT/UPDATE on
-- work_items and no DELETE, so no handler — present or future — can
-- erase an item. A retired item number therefore stays reserved forever:
-- the UNIQUE (organisation_id, work_id, item_number) constraint from
-- migration 0001 is a plain table constraint, so it counts soft-deleted
-- rows, which is exactly the reservation R7 demands. Both facts are
-- pinned by direct-SQL tests rather than restated as a trigger, which
-- would bind only the owner role that fixtures clean up with.

-- ---------------------------------------------------------------------
-- 3. requires_serials is one-way once serials exist (R7, last sentence).
--
-- Enabling serial tracking at any time is legitimate — the legacy
-- product allows it and the delivered pool simply starts empty.
-- Switching it OFF once physical units have been captured would orphan
-- every serial and silently break R6's traceability, so it is refused.
-- Serials hang off delivery-challan LINES, so the lookup joins through
-- them to reach the item.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_work_item_serial_flag()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.requires_serials AND NOT NEW.requires_serials AND EXISTS (
    SELECT 1
    FROM challan_item_serials cis
    JOIN delivery_challan_items dci ON dci.id = cis.delivery_challan_item_id
    WHERE dci.work_item_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'serial tracking cannot be switched off on % once serials exist',
      NEW.item_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER work_items_serial_flag_guard
BEFORE UPDATE ON work_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_item_serial_flag();

-- ---------------------------------------------------------------------
-- 4. Indexes the new guards read. The delivered/installed/certified sums
-- already have covering indexes (delivery_challan_items work_item_id,
-- installations_item_recorded_idx, pac_certificate_items_item_idx); the
-- Measurement Book line lookup by item exists as
-- measurement_book_lines_item_idx. Nothing further is needed.
-- ---------------------------------------------------------------------
