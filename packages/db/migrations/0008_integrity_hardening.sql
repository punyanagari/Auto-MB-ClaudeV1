SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Integrity hardening from the 2026-08-08 external review: the database
-- now proves relationships and transitions the application previously
-- only promised.

-- 1. Serial lineage: the referenced challan line must belong to the
-- referenced challan. The two previously-independent foreign keys could
-- not prove that jointly.
ALTER TABLE delivery_challan_items
  ADD CONSTRAINT delivery_challan_items_org_challan_line_key
  UNIQUE (organisation_id, delivery_challan_id, id);

ALTER TABLE challan_item_serials
  ADD CONSTRAINT challan_item_serials_line_lineage_fk
  FOREIGN KEY (organisation_id, delivery_challan_id, delivery_challan_item_id)
  REFERENCES delivery_challan_items(organisation_id, delivery_challan_id, id);

-- 2. Measurement provenance: an MB entry claiming a source challan must
-- reference a real challan of the same organisation AND the same Work.
ALTER TABLE mb_entries
  ADD CONSTRAINT mb_entries_challan_provenance_fk
  FOREIGN KEY (organisation_id, delivery_challan_id, work_id)
  REFERENCES delivery_challans(organisation_id, id, work_id);

-- 3. Signed-copy evidence gets the same hash discipline as rendered PDFs.
ALTER TABLE delivery_challans
  ADD COLUMN signed_copy_sha256 text
    CHECK (signed_copy_sha256 IS NULL OR signed_copy_sha256 ~ '^[0-9a-f]{64}$');

-- 4. Instrument statuses move forward only: transitions are allowed
-- exclusively out of 'active'; released/expired/closed are terminal.
CREATE OR REPLACE FUNCTION app_private.guard_instrument_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'active' THEN
    RAISE EXCEPTION 'instrument status % is terminal', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER work_instruments_status_guard
  BEFORE UPDATE ON work_instruments
  FOR EACH ROW
  EXECUTE FUNCTION app_private.guard_instrument_status();

-- 5. An issued challan with downstream evidence (receipt, serials, or
-- Measurement Book entries) can no longer be cancelled: received goods
-- cannot be un-delivered. Corrections happen through adjustment
-- documents, never by erasing the ledger a measurement was validated
-- against.
CREATE OR REPLACE FUNCTION app_private.guard_challan_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status = 'issued' THEN
    IF EXISTS (
        SELECT 1 FROM challan_receipts r WHERE r.delivery_challan_id = OLD.id
      )
      OR EXISTS (
        SELECT 1 FROM challan_item_serials s WHERE s.delivery_challan_id = OLD.id
      )
      OR EXISTS (
        SELECT 1 FROM mb_entries mb WHERE mb.delivery_challan_id = OLD.id
      ) THEN
      RAISE EXCEPTION
        'challan % has downstream evidence and cannot be cancelled', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_challans_cancellation_guard
  BEFORE UPDATE ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION app_private.guard_challan_cancellation();
