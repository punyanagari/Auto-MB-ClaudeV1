-- Migration 0077: installation may exceed the sanctioned quantity, and the
-- item that goes over is flagged PENDING VARIATION.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- 1. Why the installation ceiling goes (owner decision, 2026-08-17).
--
-- 0046 bound R5's first half in the database: cumulative installed quantity
-- per item never exceeds COALESCE(effective_quantity, awarded_quantity). The
-- rule matched the route, and both were wrong about site reality. Work goes in
-- before the paperwork catches up: the railway asks for four more spans at the
-- site meeting, the gang installs them, and the variation order that sanctions
-- them is issued weeks later. Refusing the RECORD refuses the measurement — it
-- does not stop the units going in, it only stops the product knowing about
-- them, and the operator's remedy ("amend the item quantity first") is
-- precisely the paperwork that has not arrived yet.
--
-- So installation is now measured as it happened, and the item it happened on
-- is marked as owing a variation. Three things deliberately do NOT change:
--
--   * DELIVERY still caps at the sanctioned quantity unless the Work's
--     excess-delivery toggle lifts it. That toggle's meaning is unchanged and
--     the delivery ceiling guard 0046 created is untouched.
--   * BILLING still caps at the sanctioned quantity. A Measurement Book may
--     not bill installed quantity above the sanctioned figure until a
--     variation raises it (apps/server/src/routes/measurement-books/
--     finalize.ts, MB_EXCEEDS_SANCTIONED). Measuring more than the contract
--     sanctions is honest; invoicing it is not.
--   * COMPLETION still measures against the sanctioned quantity. R8 asks for
--     numeric EQUALITY, so an over-installed item is as unfinished as a short
--     one and a Work cannot close on the strength of the excess.
--
-- The 0030 amendment FLOOR is untouched too, which is what makes the excess
-- safe to hold: a sanctioned quantity still cannot be amended DOWN below what
-- is already installed, so the flag clears only by sanctioning the work that
-- was done, or by cancelling the installation record that claims it.
-- ---------------------------------------------------------------------
DROP TRIGGER installations_quantity_ceiling_guard ON installations;
DROP FUNCTION app_private.guard_installation_quantity_ceiling();

-- ---------------------------------------------------------------------
-- 2. The flag itself.
--
-- DERIVED, not asserted. pending_variation is true exactly when the item's
-- cumulative installed quantity stands above its sanctioned quantity, and the
-- two triggers below recompute it from that aggregate on every write that can
-- move either side. Nothing may set it by hand: the work_items trigger
-- overwrites whatever a writer supplies with the computed value, so a direct
-- SQL writer can neither raise a variation no measurement supports nor clear
-- one that a measurement does.
--
-- A flag rather than a table, because there is exactly one fact to hold and it
-- is a property of the item. The variation ORDER that eventually resolves it
-- is already modelled: it arrives as a quantity amendment through the approval
-- engine (§5.1), and applying it raises the ceiling, which clears this flag
-- through the same trigger that set it.
-- ---------------------------------------------------------------------
ALTER TABLE work_items
  ADD COLUMN pending_variation boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN work_items.pending_variation IS
  'True when cumulative installed quantity exceeds COALESCE(effective_quantity, '
  'awarded_quantity) — the item owes a railway variation order (migration '
  '0077). Derived and trigger-maintained; never written by hand.';

-- ---------------------------------------------------------------------
-- 3. The item side: the flag is recomputed on every work_items write.
--
-- This is what makes the column derived rather than merely maintained. An
-- amendment that raises the ceiling above the installed total clears the flag;
-- one that lowers it (never below the installed total — the 0030 floor sees to
-- that) leaves it alone; and a writer that sets the column directly has its
-- value discarded in favour of the computed one.
--
-- INSERT is included so a new item cannot be born flagged. It reads the same
-- aggregate, which is empty for an id that has just been generated.
--
-- The aggregate counts status = 'recorded' rows, which is the whole
-- non-cancelled set (installations are only ever 'recorded' or 'cancelled') —
-- the same rows the recording route, the completion predicate and the
-- Measurement Book loader sum, and the same rows 0046's ceiling counted. It is
-- written out here and again in section 4 rather than shared through a helper
-- function: a helper would be called by NAME from inside a trigger body, which
-- resolves app_private at run time under the invoking role's privileges, and
-- these two triggers must run for every writer without depending on a grant.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.sync_work_item_pending_variation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_installed numeric(18,3);
BEGIN
  SELECT COALESCE(sum(i.quantity), 0) INTO v_installed
  FROM installations i
  WHERE i.organisation_id = NEW.organisation_id
    AND i.work_item_id = NEW.id
    AND i.status = 'recorded';

  NEW.pending_variation :=
    v_installed > COALESCE(NEW.effective_quantity, NEW.awarded_quantity);
  RETURN NEW;
END
$$;

-- Fires after work_items_baseline_guard and work_items_omission_guard and
-- before work_items_quantity_floor_guard (alphabetical order on the name), all
-- of which either raise or return NEW untouched; none of them reads this
-- column, so the position is free.
CREATE TRIGGER work_items_pending_variation_sync
BEFORE INSERT OR UPDATE ON work_items
FOR EACH ROW EXECUTE FUNCTION app_private.sync_work_item_pending_variation();

-- ---------------------------------------------------------------------
-- 4. The installation side: a recording, a cancellation, or a re-pointing
-- moves the flag.
--
-- AFTER, so the aggregate already includes (or excludes) the row that fired
-- it, and one code path serves insert, update and delete instead of three
-- arithmetic special cases.
--
-- CONCURRENCY, and this is the whole reason the function locks. Two recordings
-- of six against a sanctioned ten each fit on their own; together they do not.
-- Neither can see the other's uncommitted row, so both would compute "six, not
-- over" and neither would raise the flag — the excess would exist and nothing
-- would say so. The item row is therefore taken FOR UPDATE before the sum is
-- read: the second writer parks on the lock, and when it wakes, its next
-- statement takes a fresh snapshot that includes the first writer's committed
-- row, so it computes twelve and raises the flag. This is 0046's discipline
-- exactly, on the same row, in the same order (works -> work_items), which is
-- also why it cannot invert any writer's lock order.
--
-- The UPDATE is skipped when the value is unchanged, which is the ordinary
-- case: the LOCK is what serialises, not the write, so a Work whose
-- installations all sit inside the sanctioned quantity never touches
-- work_items at all and never churns its updated_at.
--
-- The items are locked in ascending id order, so two recordings that re-point
-- records between the same pair of items cannot deadlock against each other.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.refresh_work_item_pending_variation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_organisation_id uuid;
  v_items uuid[];
  v_item uuid;
  v_ceiling numeric(18,3);
  v_installed numeric(18,3);
  v_flag boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_organisation_id := OLD.organisation_id;
    v_items := ARRAY[OLD.work_item_id];
  ELSIF TG_OP = 'UPDATE' THEN
    v_organisation_id := NEW.organisation_id;
    -- A re-pointed record changes two items' answers, not one.
    v_items := ARRAY(
      SELECT DISTINCT item
      FROM unnest(ARRAY[OLD.work_item_id, NEW.work_item_id]) AS item
      ORDER BY item
    );
  ELSE
    v_organisation_id := NEW.organisation_id;
    v_items := ARRAY[NEW.work_item_id];
  END IF;

  FOREACH v_item IN ARRAY v_items LOOP
    SELECT COALESCE(item.effective_quantity, item.awarded_quantity)
      INTO v_ceiling
    FROM work_items item
    WHERE item.organisation_id = v_organisation_id
      AND item.id = v_item
    FOR UPDATE;

    IF v_ceiling IS NULL THEN
      RAISE EXCEPTION
        'installation names work item %, which this transaction cannot read',
        v_item
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(sum(i.quantity), 0) INTO v_installed
    FROM installations i
    WHERE i.organisation_id = v_organisation_id
      AND i.work_item_id = v_item
      AND i.status = 'recorded';

    v_flag := v_installed > v_ceiling;

    UPDATE work_items
    SET pending_variation = v_flag
    WHERE organisation_id = v_organisation_id
      AND id = v_item
      AND pending_variation IS DISTINCT FROM v_flag;
  END LOOP;

  RETURN NULL;
END
$$;

CREATE TRIGGER installations_pending_variation_sync
AFTER INSERT OR UPDATE OR DELETE ON installations
FOR EACH ROW EXECUTE FUNCTION app_private.refresh_work_item_pending_variation();

-- ---------------------------------------------------------------------
-- 5. Backfill.
--
-- Expected to touch nothing: 0046 has refused every over-installation since it
-- applied, and 0030 refuses to lower a ceiling below the installed total, so a
-- database only ever written through this product holds no over-installed
-- item. It runs anyway, because a database restored from before 0046 — or
-- written around it by an importer that predates it — can hold one, and a flag
-- that starts out wrong is worse than no flag: it would say "sanctioned" about
-- an item that is not.
--
-- Written as a plain UPDATE rather than driven through the trigger so the
-- intent is readable in the migration; the section 3 trigger recomputes the
-- same value on the same rows and agrees with it.
-- ---------------------------------------------------------------------
UPDATE work_items item
SET pending_variation = true
WHERE COALESCE((
    SELECT sum(i.quantity)
    FROM installations i
    WHERE i.organisation_id = item.organisation_id
      AND i.work_item_id = item.id
      AND i.status = 'recorded'
  ), 0) > COALESCE(item.effective_quantity, item.awarded_quantity);

-- ---------------------------------------------------------------------
-- 6. The Work's own view of its variations.
--
-- The flag exists to be read per Work — "which items on this contract owe a
-- variation order" — and the answer is a handful of rows out of a Work's
-- items. A partial index keeps that read off the item scan and costs nothing
-- on the overwhelming majority of items, which are not flagged.
-- ---------------------------------------------------------------------
CREATE INDEX work_items_pending_variation_idx
  ON work_items (organisation_id, work_id)
  WHERE pending_variation;
