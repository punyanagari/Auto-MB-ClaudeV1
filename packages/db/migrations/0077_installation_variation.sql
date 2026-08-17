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
-- is marked as owing a variation. Two things deliberately do NOT change:
--
--   * DELIVERY still caps at the sanctioned quantity unless the Work's
--     excess-delivery toggle lifts it. That toggle's meaning is unchanged and
--     the delivery ceiling guard 0046 created is untouched.
--   * COMPLETION still measures against the sanctioned quantity. R8 asks for
--     numeric EQUALITY, so an over-installed item is as unfinished as a short
--     one and a Work cannot close on the strength of the excess.
--
-- BILLING does not refuse; it CLAMPS (owner ruling, 2026-08-17: "Final MB can
-- be done even if excess installation variation is not processed — sometimes
-- we have to work free for the Railways"). The Measurement Book engine bills
-- min(cumulative measured, sanctioned) on every stage whose basis is the
-- installed quantity, so the excess is simply never billed and no book — the
-- final one included — is ever blocked by it. See apps/server/src/mb-compute.ts.
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
-- triggers below recompute it from that aggregate on every write that can move
-- either side. Nothing may set it by hand: the work_items triggers overwrite
-- whatever a writer supplies with the computed value, so a direct SQL writer
-- can neither raise a variation no measurement supports nor clear one that a
-- measurement does.
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
-- 3. The formula, written once.
--
-- Both triggers and the backfill read the same sentence from here, so there is
-- exactly one definition of "over-installed" in the database. The aggregate
-- counts status = 'recorded' rows, which is the whole non-cancelled set
-- (installations are only ever 'recorded' or 'cancelled') — the same rows the
-- recording route, the completion predicate and the Measurement Book loader
-- sum, and the same rows 0046's ceiling counted.
--
-- Invoker rights: a definer function would read across tenants, and every
-- caller is already inside the row's own tenant. VOLATILE (the default) is
-- deliberate rather than incidental — a STABLE function would take the calling
-- statement's snapshot, and section 5 depends on re-reading the sum AFTER a
-- lock wait, which is exactly the snapshot a volatile call refreshes.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.work_item_over_installed(
  p_organisation_id uuid,
  p_work_item_id uuid,
  p_sanctioned numeric
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_installed numeric(18,3);
BEGIN
  IF p_sanctioned IS NULL THEN
    RETURN false;
  END IF;
  SELECT COALESCE(sum(i.quantity), 0) INTO v_installed
  FROM installations i
  WHERE i.organisation_id = p_organisation_id
    AND i.work_item_id = p_work_item_id
    AND i.status = 'recorded';
  RETURN v_installed > p_sanctioned;
END
$$;

REVOKE ALL ON FUNCTION
  app_private.work_item_over_installed(uuid, uuid, numeric) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION
      app_private.work_item_over_installed(uuid, uuid, numeric) TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 4. The item side: the flag follows the sanctioned quantity.
--
-- This is what makes the column derived rather than merely maintained. An
-- amendment that raises the ceiling above the installed total clears the flag;
-- one that lowers it (never below the installed total — the 0030 floor sees to
-- that) leaves it alone; and a writer that sets the column directly has its
-- value discarded in favour of the computed one.
--
-- BOTH TRIGGERS ARE WHEN-GATED, and that is the point of them being two. A
-- work_items row is written for many reasons that cannot move this flag — the
-- bulk item insert of an LOA confirmation, a payment-category sweep, an HSN
-- edit — and an unconditional trigger would run the installations aggregate
-- once per row for every one of them. The UPDATE gate names the only three
-- columns whose change can change the answer (including the flag itself, so a
-- hand-set value is still corrected); the INSERT gate fires only when a writer
-- supplies `true` on a brand-new item, which no code path does and which is
-- false by construction — an id that has just been generated has no
-- installations. Ordinary inserts take the column DEFAULT and touch nothing.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.sync_work_item_pending_variation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.pending_variation := app_private.work_item_over_installed(
    NEW.organisation_id,
    NEW.id,
    COALESCE(NEW.effective_quantity, NEW.awarded_quantity)
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER work_items_pending_variation_insert
BEFORE INSERT ON work_items
FOR EACH ROW WHEN (NEW.pending_variation)
EXECUTE FUNCTION app_private.sync_work_item_pending_variation();

-- Fires after work_items_baseline_guard and work_items_omission_guard and
-- before work_items_quantity_floor_guard (alphabetical order on the name), all
-- of which either raise or return NEW untouched; none of them reads this
-- column, so the position is free.
CREATE TRIGGER work_items_pending_variation_sync
BEFORE UPDATE ON work_items
FOR EACH ROW WHEN (
  OLD.effective_quantity IS DISTINCT FROM NEW.effective_quantity
  OR OLD.awarded_quantity IS DISTINCT FROM NEW.awarded_quantity
  OR OLD.pending_variation IS DISTINCT FROM NEW.pending_variation
)
EXECUTE FUNCTION app_private.sync_work_item_pending_variation();

-- ---------------------------------------------------------------------
-- 5. The installation side: a recording, a cancellation, or a re-pointing
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
-- FOR EACH ROW rather than a statement-level trigger over a transition table:
-- the lock-then-recompute has to happen per item whatever the shape, and every
-- writer in the product moves installations one row at a time (the recording
-- route inserts one, the cancel route updates one, and 0023 refuses deletion
-- outright). A statement-level rewrite would buy nothing until a bulk
-- installation writer exists, and there is none to measure against.
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
  v_sanctioned numeric(18,3);
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
      INTO v_sanctioned
    FROM work_items item
    WHERE item.organisation_id = v_organisation_id
      AND item.id = v_item
    FOR UPDATE;

    IF v_sanctioned IS NULL THEN
      RAISE EXCEPTION
        'installation names work item %, which this transaction cannot read',
        v_item
        USING ERRCODE = '23514';
    END IF;

    v_flag := app_private.work_item_over_installed(
      v_organisation_id, v_item, v_sanctioned
    );

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
-- 6. Backfill.
--
-- Expected to touch nothing: 0046 has refused every over-installation since it
-- applied, and 0030 refuses to lower a ceiling below the installed total, so a
-- database only ever written through this product holds no over-installed
-- item. It runs anyway, because a database restored from before 0046 — or
-- written around it by an importer that predates it — can hold one, and a flag
-- that starts out wrong is worse than no flag: it would say "sanctioned" about
-- an item that is not.
--
-- Driven from the INSTALLATIONS side. The ADD COLUMN above holds ACCESS
-- EXCLUSIVE on work_items for the length of this migration, and an item with
-- no installation cannot be over-installed, so there is no reason to walk
-- every item of every tenant to discover that. The EXISTS narrows the scan to
-- the items that could possibly answer differently from the column default,
-- and section 3's function supplies the answer, so the formula is not written
-- a third time here.
-- ---------------------------------------------------------------------
UPDATE work_items item
SET pending_variation = app_private.work_item_over_installed(
      item.organisation_id,
      item.id,
      COALESCE(item.effective_quantity, item.awarded_quantity)
    )
WHERE EXISTS (
  SELECT 1 FROM installations i
  WHERE i.organisation_id = item.organisation_id
    AND i.work_item_id = item.id
    AND i.status = 'recorded'
);
