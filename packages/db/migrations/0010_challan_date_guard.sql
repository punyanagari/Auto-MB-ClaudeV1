-- 0010: the product contract's date invariant, held in the database
-- (external re-audit). A Delivery Challan's date is never in the future
-- and never precedes the Work's LOA letter date; "today" is evaluated in
-- the organisation's own timezone. The API validates first with friendly
-- errors — this trigger makes the invariant hold against every writer.
--
-- Runs as the invoking role, so the lookup sees the works row through the
-- same RLS the writer does; if the lookup yields nothing (e.g. an
-- administrative session with no tenant bound), the guard steps aside and
-- the foreign keys still hold referential integrity.

CREATE FUNCTION app_private.guard_challan_date()
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

  IF NEW.challan_date > v_today THEN
    RAISE EXCEPTION 'challan_date % is in the future (today is % in the organisation timezone)',
      NEW.challan_date, v_today
      USING ERRCODE = '23514';
  END IF;

  IF NEW.challan_date < v_letter_date THEN
    RAISE EXCEPTION 'challan_date % precedes the LOA letter date %',
      NEW.challan_date, v_letter_date
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER delivery_challans_date_guard
  BEFORE INSERT OR UPDATE OF challan_date ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION app_private.guard_challan_date();
