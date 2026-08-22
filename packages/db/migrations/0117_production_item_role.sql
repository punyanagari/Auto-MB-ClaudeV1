SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- Migration 0117: what an item IS in the catalogue, and what an operator
-- may still correct about it afterwards.
--
-- Two owner rulings of the round-5 corrections wave, one column and one
-- restated guard between them.
--
-- RULING (item 31). "Add OEM item" misleads: not everything in the
-- catalogue is an OEM product. Creation becomes a choice — OEM ITEM or
-- SUB ITEM — and the OEM catalogue rail lists only the first kind. Sub
-- items (parts and sub-assemblies) appear inside bills of material and
-- stay reachable behind a filter, but they no longer clutter the rail an
-- operator opens to find a product.
--
-- WHY A COLUMN AND NOT `manufactured`. The obvious reading is that OEM
-- means `manufactured` and sub means not, and the ruling itself refuses
-- it: "a sub item may be either bought or built". A sub-assembly the
-- agency welds in-house is manufactured, carries a serial series, and is
-- still not a product anybody sells — under the obvious reading it would
-- appear in the OEM rail, which is exactly the clutter this removes.
--
-- WHY NOT DERIVED FROM THE BILL OF MATERIAL. "Is a component of
-- something" is computable, and it is the same mistake 0084 already
-- refused for `manufactured`: derived, the OEM catalogue would gain and
-- lose entries as somebody edited a bill of material, and a product used
-- once as a spare inside another product would silently stop being a
-- product. It is a DECISION about what the agency sells, so it is a
-- column.
--
-- THE INVARIANT. An OEM item is a product the agency builds and names
-- unit by unit, so `item_role = 'oem'` implies `manufactured`, which
-- 0084's own shape CHECK already implies a serial series and serial
-- control. Nothing here relaxes that chain; it only adds a link at the
-- top of it. A SUB item is unconstrained: bought-in bolts and welded
-- sub-assemblies are both sub items.
--
-- BACKFILL. Every existing manufactured item becomes 'oem' and every
-- bought-in part becomes 'sub', which is what the rail drew before this
-- migration (`ProductionItems.tsx` badged the non-manufactured ones
-- "Component"). No row changes meaning; the rail merely stops showing
-- half of them by default.
--
-- NO INDEX CHANGE. `production_items_catalogue_idx` still leads on
-- `manufactured`, and the catalogue read now orders OEM first instead.
-- The read is one unpaginated per-organisation catalogue — hundreds of
-- rows, not millions — and a second overlapping index on a table this
-- size costs more to maintain than the sort it saves.
--
-- ---------------------------------------------------------------------
-- RULING (item 29). A production item has no edit path: everything but
-- the reorder level freezes at creation, which is wrong for a MASTER.
-- Name, part number, unit, category and specifications become freely
-- editable — a record that snapshotted them keeps its copy — and the
-- deliberate immutables stay refusals with names rather than controls
-- that quietly do nothing.
--
-- 0084's guard already froze the serial series once units are minted and
-- refused clearing `manufactured` once job cards exist. The restatement
-- below widens both to the whole set of things that reference the item
-- physically, per the ruling ("units, job cards, or consumptions"):
--
--   * `manufactured` and `serial_controlled` are settled — in either
--     direction — once a job card, a minted unit, a consumption of this
--     item into somebody else's unit, or a stock ISSUE of it into a job
--     card exists. 0084 refused only the first of the four, and only for
--     clearing `manufactured`. The fourth arm is the one a serial-shaped
--     rule would miss entirely: an unserialised part is consumed by
--     quantity through 0087's ledger and records no component serial at
--     all, so without it the commonest consumption in the building is
--     invisible to the rule.
--
-- `item_role` is deliberately NOT frozen. Picking the wrong kind at
-- creation is exactly the mistake a master edit exists to correct, and
-- the OEM invariant above is what stops the correction from being a lie.
--
-- SQLSTATE. No new code. Both new arms raise 23D03 — 0084's "the item
-- master row cannot change this way" — because that is the rule they
-- are, and `apps/server/src/routes/production.ts` already maps it. The
-- route checks each of them first, under its own read, and answers a
-- named 409; this is the concurrent arm of the same rules, exactly as
-- 0084's header describes. The 23Z block allocated to this pack is
-- therefore unused and stays free.
--
-- The whole function is restated with CREATE OR REPLACE, which is the
-- house style for amending a guard and what the SQLSTATE census in
-- `migration-contract` reads: one function, however many files restate
-- it, is one rule.
-- ---------------------------------------------------------------------

ALTER TABLE production_items
  ADD COLUMN item_role text NOT NULL DEFAULT 'sub'
    CHECK (item_role IN ('oem', 'sub'));

COMMENT ON COLUMN production_items.item_role IS
  'Whether this is an OEM product the agency sells (''oem'', listed in the catalogue rail) or a part or sub-assembly it is built from (''sub'', reached through a bill of material or the rail filter). Not derived from the bill of material for the reason 0084 gives for not deriving `manufactured`: it is a decision about what the agency sells, and a derived one would move as somebody edited a bill.';

-- The rail drew exactly this split before the column existed.
UPDATE production_items SET item_role = 'oem' WHERE manufactured;

-- An OEM item is a product named unit by unit, so it is manufactured,
-- and 0084's shape CHECK carries that on to a serial series and serial
-- control. Added AFTER the backfill, which satisfies it by construction.
ALTER TABLE production_items
  ADD CONSTRAINT production_items_oem_manufactured_check
    CHECK (item_role <> 'oem' OR manufactured);

-- 0084's guard, restated whole with the two widened arms. Everything
-- above the first new arm is 0084 verbatim.
CREATE OR REPLACE FUNCTION app_private.guard_production_item_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Provenance is a fact about an act that already happened, and the
  -- tenant is not a property anything may edit: re-pointing
  -- `organisation_id` would move a part number and every job card behind
  -- it into another organisation in one statement, which RLS cannot
  -- catch because the row passes the policy on the way out and on the
  -- way in. The ROW form is 0079's, and `issued-immutability-coverage`
  -- reads it out of the stored function body to prove that every column
  -- of this table is either frozen here or declared mutable there.
  IF ROW(NEW.organisation_id, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM ROW(OLD.organisation_id, OLD.created_at, OLD.created_by_user_id)
  THEN
    RAISE EXCEPTION
      'a production item''s tenant and provenance are immutable'
      USING ERRCODE = '23D03';
  END IF;

  -- The serial series is frozen once it has minted anything. Moving it
  -- would put two prefixes inside one series with no way to tell which
  -- unit belongs to which, and the labels are already on the hardware.
  IF NEW.serial_prefix IS DISTINCT FROM OLD.serial_prefix AND EXISTS (
    SELECT 1 FROM production_serials s
    WHERE s.organisation_id = OLD.organisation_id AND s.item_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'item % has already minted serials, so its serial series cannot change',
      OLD.item_code
      USING ERRCODE = '23D03';
  END IF;

  -- The two classification flags. 0084 refused CLEARING `manufactured`
  -- while job cards existed; 0117 widens the question in both directions
  -- and to everything that references the item PHYSICALLY — a job card
  -- raised for it, a unit built from it, and a unit somebody else built
  -- it into. Each of those is a record that only makes sense under the
  -- flags it was written under: clearing `manufactured` orphans the job
  -- cards, setting it claims the agency built parts it bought, clearing
  -- `serial_controlled` leaves a genealogy nothing explains, and setting
  -- it claims consumptions already recorded were scanned when they were
  -- not.
  --
  -- `<>` rather than `IS DISTINCT FROM` because both columns are NOT
  -- NULL, so the two are the same test — and the scalar `IS DISTINCT
  -- FROM` form is what `issued-immutability-coverage` reads as a COLUMN
  -- FREEZE. Neither of these is frozen. Each carries a one-way rule that
  -- only bites once something references the row, which is why both stay
  -- declared mutable there.
  IF (
    NEW.manufactured <> OLD.manufactured
    OR NEW.serial_controlled <> OLD.serial_controlled
  ) AND (
    EXISTS (
      SELECT 1 FROM production_job_cards j
      WHERE j.organisation_id = OLD.organisation_id AND j.item_id = OLD.id
    )
    OR EXISTS (
      SELECT 1 FROM production_serials s
      WHERE s.organisation_id = OLD.organisation_id AND s.item_id = OLD.id
    )
    OR EXISTS (
      SELECT 1 FROM production_component_serials c
      WHERE c.organisation_id = OLD.organisation_id AND c.component_item_id = OLD.id
    )
    -- The stock ledger's own answer to the same question. A part
    -- consumed into a job card BY QUANTITY (0087's `issue` movement
    -- naming a job card) leaves NO `production_component_serials` row,
    -- because there was no serial to capture — and that is precisely the
    -- history that turning `serial_controlled` on would retroactively
    -- claim had been scanned. Without this arm the rule is blind to
    -- every unserialised part the agency actually consumes, which is
    -- most of them.
    OR EXISTS (
      SELECT 1 FROM stock_movements m
      WHERE m.organisation_id = OLD.organisation_id
        AND m.production_item_id = OLD.id
        AND m.movement_type = 'issue'
        AND m.production_job_card_id IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION
      'item % has job cards, units or consumptions on record, so whether it is manufactured and whether its serials are captured are both settled',
      OLD.item_code
      USING ERRCODE = '23D03';
  END IF;

  -- Retiring is the masters delete, so it asks the question a delete
  -- would: is anything still relying on this? An OPEN job card is; a
  -- finished one is history and does not block.
  IF OLD.active AND NOT NEW.active AND EXISTS (
    SELECT 1 FROM production_job_cards j
    WHERE j.organisation_id = OLD.organisation_id
      AND j.item_id = OLD.id
      AND j.status IN ('planned', 'in_production')
  ) THEN
    RAISE EXCEPTION
      'item % has open job cards and cannot be retired',
      OLD.item_code
      USING ERRCODE = '23D04';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_production_item_update() IS
  'Freezes a production item''s tenant, its serial series once units are minted, and both its manufactured flag and its serial control once a job card, a minted unit, a component consumption or a stock issue into a job card references it; refuses retirement while a job card is open.';
