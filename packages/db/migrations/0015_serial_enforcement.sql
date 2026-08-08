SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 7: requires_serials enforcement. Once a Delivery Challan is
-- issued, every line whose Work item requires serial traceability was
-- proven complete (serial count = shipped quantity) inside the issue
-- transaction. This trigger makes that proof durable: deleting a serial
-- from such a line would silently break the issued record, so the
-- database refuses it regardless of what application code asks.
-- Draft-line serials stay freely deletable (data-entry corrections), and
-- serials of non-flagged items keep their existing lifecycle.

CREATE FUNCTION app_private.guard_serial_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  challan_status text;
  flagged boolean;
BEGIN
  SELECT dc.status INTO challan_status
  FROM delivery_challans dc
  WHERE dc.organisation_id = OLD.organisation_id
    AND dc.id = OLD.delivery_challan_id;

  IF challan_status = 'issued' THEN
    SELECT wi.requires_serials INTO flagged
    FROM delivery_challan_items dci
    JOIN work_items wi
      ON wi.organisation_id = dci.organisation_id
     AND wi.id = dci.work_item_id
    WHERE dci.organisation_id = OLD.organisation_id
      AND dci.id = OLD.delivery_challan_item_id;

    IF flagged THEN
      RAISE EXCEPTION
        'serials on issued challan lines that require serials are immutable';
    END IF;
  END IF;

  RETURN OLD;
END
$$;

CREATE TRIGGER challan_item_serials_guard_delete
BEFORE DELETE ON challan_item_serials
FOR EACH ROW EXECUTE FUNCTION app_private.guard_serial_delete();
