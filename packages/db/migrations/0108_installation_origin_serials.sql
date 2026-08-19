SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- Migration 0108: a serial may enter the record at INSTALLATION.
--
-- Numbering: 0105 is taken by the pack ahead of this one and 0106/0107 by
-- the measurement-AMC pack, so this drop takes 0108. The runner sorts file
-- names and only requires ids to be unique
-- (`packages/db/src/migration-runner.ts`), so gaps cost nothing.
--
-- THE PROBLEM, in the owner's words: "if missing serial in DC is added in
-- IC then accept it and record it." A Delivery Challan is typed from a
-- despatch note, and a nameplate that was missed there is discovered by
-- the person standing in front of the equipment at site — which is the
-- installation, not the challan. Before this, that serial had nowhere to
-- go: `challan_item_serials` required a challan line, so the site record
-- was refused as SERIAL_NOT_FOUND and the unit went in untraceable, or
-- the operator went back and edited an issued document, which is exactly
-- what issued documents do not do.
--
-- THE MODEL. One serial table, not two. `challan_item_serials` gains an
-- `origin` and its challan lineage becomes optional; an installation-added
-- serial is the same kind of record, entered at a different point. The
-- alternative — a second table for installation-added serials — was
-- rejected on the invariant it cannot hold: serial numbers are unique per
-- Work, and cross-table uniqueness is a trigger racing two concurrent
-- inserts, where one table is a unique index that cannot lose. Every read
-- that joins a challan keeps working unchanged and simply does not see the
-- new rows, which is the failure that is safe; the four reads that MUST
-- see them are widened in the same pull request, and they are:
--
--   1. `GET /api/serials/search` — the tenant-wide serial trace, which
--      renders the origin as a third answer beside Delivered and
--      Production (`routes/serials.ts`);
--   2. the installation record's own serial list, so a record says which
--      of its serials entered with it (`INSTALLATION_COLUMNS` below in
--      `routes/installations.ts`);
--   3. `PATCH /api/work-items/:id/requires-serials` — the R7 off-toggle
--      count, which would otherwise let serial tracking be switched off
--      underneath a serial the site captured (`routes/serials.ts`);
--   4. `GET /api/works/:id/serials` — the Work's own serial register
--      (`listSerials` in `routes/retention.ts`), whose consumers are the
--      Work page's traced-serial count and the Installations panel.
--
-- Everything else keeps the inner join on purpose. The Delivery Challan
-- screens ask challan questions, and a serial with no challan is not an
-- answer to any of them.
--
-- WHAT DOES NOT MOVE. Delivery Challan cancellation, deletion and line
-- rewriting all filter on `delivery_challan_id` / `delivery_challan_item_id`,
-- which an installation-added serial leaves NULL. So a cancelled challan
-- releases exactly its own serials, as it always did, and an
-- installation-added serial belongs to its installation instead — released
-- when that installation is cancelled, by the 0017 attachment path, which
-- is likewise unchanged.
-- ---------------------------------------------------------------------

-- 1. Where the serial entered the record.
ALTER TABLE challan_item_serials
  ADD COLUMN origin text NOT NULL DEFAULT 'delivery'
    CHECK (origin IN ('delivery', 'installation')),
  -- An installation-added serial has no challan line to take its item
  -- from, so it names the Work item itself. A delivery serial leaves this
  -- NULL and keeps taking the item from `delivery_challan_items`, which
  -- is the one place it can be right: two copies of the same fact is how
  -- they drift.
  ADD COLUMN work_item_id uuid;

ALTER TABLE challan_item_serials
  ALTER COLUMN delivery_challan_id DROP NOT NULL,
  ALTER COLUMN delivery_challan_item_id DROP NOT NULL;

ALTER TABLE challan_item_serials
  ADD CONSTRAINT challan_item_serials_work_item_fk
  FOREIGN KEY (organisation_id, work_item_id, work_id)
  REFERENCES work_items(organisation_id, id, work_id);

-- Exactly one of the two lineages, decided by the origin. The composite
-- foreign keys to `delivery_challans` and `delivery_challan_items` are
-- MATCH SIMPLE, so a NULL column switches them off rather than failing
-- them; this CHECK is what stops that becoming a hole a delivery serial
-- could slip through with no challan at all.
ALTER TABLE challan_item_serials
  ADD CONSTRAINT challan_item_serials_origin_lineage_check
  CHECK (
    (origin = 'delivery'
      AND delivery_challan_id IS NOT NULL
      AND delivery_challan_item_id IS NOT NULL
      AND work_item_id IS NULL)
    OR
    (origin = 'installation'
      AND delivery_challan_id IS NULL
      AND delivery_challan_item_id IS NULL
      AND work_item_id IS NOT NULL)
  );

-- Per-work-ITEM uniqueness is already held, and more tightly: the 0006
-- UNIQUE (organisation_id, work_id, serial_number) makes a serial number
-- unique across the whole Work, which no per-item index could weaken. An
-- installation-added serial therefore cannot collide with a delivered one,
-- and the collision is refused by an index rather than by a check that two
-- transactions could pass at once. Nothing to add here; said out loud
-- because its absence is the first thing a reader looks for.

-- The installation-added rows are found by item, never by challan — and
-- the new foreign key above needs the same columns for its own referential
-- checks against `work_items` (the 0046 index sweep's reasoning: a foreign
-- key whose referencing side has no usable index turns a parent update into
-- a sequential scan).
--
-- PLAIN, not partial. Two earlier drafts of this line carried a WHERE —
-- first `origin = 'installation'`, then `work_item_id IS NOT NULL` — on the
-- reasoning that both select the same rows (the CHECK above makes them
-- equivalent) and the second is the one a referential query could prove.
-- That reasoning is about the PLANNER, and an index backing a foreign key
-- has to satisfy something stricter than the planner: the rows a
-- referential check must consider under MATCH SIMPLE include the ones with
-- a NULL `work_item_id`, which a partial index does not contain at all. So
-- a partial index is not FK coverage, whatever the planner makes of it, and
-- `packages/db/test/fk-index-coverage.integration.test.ts` is right to
-- refuse one. Indexing every row is the correct answer here, not the
-- census-appeasing one; the delivery serials it also covers are the cheap
-- part of it.
CREATE INDEX challan_item_serials_work_item_idx
  ON challan_item_serials (organisation_id, work_item_id, work_id);

-- 2. Line lineage: the 0056 guard, restated with its full body and one
-- new first branch.
--
-- It exists because R6 is a Work-ITEM guarantee and a MANUAL challan line
-- has no work item to be traceable against, so it refuses a serial whose
-- line it cannot read or whose line names no item. An installation-added
-- serial names no line at all, which read as the first of those — "this
-- transaction cannot read line NULL" — and would have refused every row
-- this migration exists to allow. The guarantee is unchanged and is met a
-- different way: such a serial names its work item directly, and the
-- CHECK above proves it.
CREATE OR REPLACE FUNCTION app_private.guard_challan_item_serial_line()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_work_item uuid;
  v_found boolean;
BEGIN
  IF NEW.origin = 'installation' THEN
    RETURN NEW;
  END IF;

  SELECT line.work_item_id, true INTO v_work_item, v_found
  FROM delivery_challan_items line
  WHERE line.organisation_id = NEW.organisation_id
    AND line.id = NEW.delivery_challan_item_id;

  IF v_found IS NULL THEN
    RAISE EXCEPTION
      'serial names delivery challan line %, which this transaction cannot read',
      NEW.delivery_challan_item_id
      USING ERRCODE = '23514';
  END IF;

  IF v_work_item IS NULL THEN
    RAISE EXCEPTION
      'serials are recorded against LOA item lines, not manual lines'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- 3. Deletion. The 0015 guard reads the challan's status to decide, and an
-- installation-added serial has no challan, so it would fall through to
-- "deletable" — which is wrong twice over: it is not draft-stage evidence,
-- and deleting it would strand the attachment row that is the installation
-- record's own history.
CREATE OR REPLACE FUNCTION app_private.guard_serial_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  challan_status text;
  flagged boolean;
  attached boolean;
BEGIN
  IF OLD.origin = 'installation' THEN
    SELECT EXISTS (
      SELECT 1 FROM installation_serials att
      WHERE att.organisation_id = OLD.organisation_id
        AND att.challan_item_serial_id = OLD.id
    ) INTO attached;

    IF attached THEN
      -- SQLSTATE stated even though no application path reaches this
      -- branch: the DELETE route resolves serials through their challan
      -- and answers 404 for one that has none, so this fires only against
      -- direct SQL. A guard that is only ever met by a human at a psql
      -- prompt is exactly the one that should not raise the ambiguous
      -- P0001 every unqualified RAISE produces (0056's own convention).
      RAISE EXCEPTION
        'a serial recorded at installation is evidence of that installation; cancel the installation record instead'
        USING ERRCODE = '23514';
    END IF;

    RETURN OLD;
  END IF;

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

-- 4. Attachment: the 0023 guard, restated with its full body, plus two
-- changes.
--
--   (a) The item-lineage lookup reads the challan line for a delivered
--       serial and the serial's own `work_item_id` for one added at
--       installation. Left as it was, the join to `delivery_challan_items`
--       would find no row for an installation-added serial and the guard
--       would refuse every attachment this migration exists to allow.
--       Its refusal wording is unchanged: the rule did not change, only
--       where the item is read from.
--   (b) An installation never carries more serials than units — the
--       owner's "count <= installed qty". The API says the stricter thing
--       for serial-flagged items (exactly one serial per unit) and this
--       says the weaker one, which is the division of labour the 0017
--       comments already describe for the date rule.
--
--       WHAT THIS COUNT DOES AND DOES NOT HOLD, said plainly because a
--       count inside a BEFORE trigger invites the wrong reading. It holds
--       against a single writer: the attachment rows for one installation
--       are always written by the transaction that created that
--       installation, and PL/pgSQL bumps the command counter before each
--       of its own queries, so the count sees the earlier rows of a
--       multi-row INSERT. It is NOT a defence against two transactions
--       attaching to the same installation at once, because there is no
--       such pair — an installation id is invisible outside the
--       transaction that inserts it until that transaction commits, and by
--       then the record is complete. The invariant that genuinely survives
--       a race is the partial unique index from 0017
--       (`installation_serials_one_live_per_serial`), which is what stops
--       two installations claiming the same physical unit.
CREATE OR REPLACE FUNCTION app_private.guard_installation_serial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  parent_item uuid;
  parent_quantity numeric(18,3);
  serial_item uuid;
  live_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'installation serial attachments are released, never deleted';
  END IF;

  SELECT status, work_item_id, quantity
    INTO parent_status, parent_item, parent_quantity
  FROM installations
  WHERE organisation_id = NEW.organisation_id AND id = NEW.installation_id;

  IF TG_OP = 'INSERT' THEN
    IF parent_status IS DISTINCT FROM 'recorded' THEN
      RAISE EXCEPTION 'serials attach only to a recorded installation';
    END IF;

    SELECT COALESCE(dci.work_item_id, s.work_item_id) INTO serial_item
    FROM challan_item_serials s
    LEFT JOIN delivery_challan_items dci
      ON dci.organisation_id = s.organisation_id
     AND dci.id = s.delivery_challan_item_id
    WHERE s.organisation_id = NEW.organisation_id
      AND s.id = NEW.challan_item_serial_id;

    IF serial_item IS NULL OR serial_item IS DISTINCT FROM parent_item THEN
      RAISE EXCEPTION 'serial attachments must stay within the installation''s work item';
    END IF;

    SELECT count(*) INTO live_count
    FROM installation_serials att
    WHERE att.organisation_id = NEW.organisation_id
      AND att.installation_id = NEW.installation_id
      AND att.released_at IS NULL;

    -- The row being inserted is not yet visible to this count.
    IF live_count + 1 > parent_quantity THEN
      RAISE EXCEPTION
        'an installation carries at most one serial per installed unit (% units)',
        parent_quantity
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE: everything except the NULL -> timestamp release is frozen.
  IF ROW(
    NEW.organisation_id, NEW.installation_id, NEW.work_id,
    NEW.challan_item_serial_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.installation_id, OLD.work_id,
    OLD.challan_item_serial_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'installation serial attachment data is immutable';
  END IF;
  IF NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    IF OLD.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a released serial attachment cannot be re-attached; record a new installation';
    END IF;
    IF parent_status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'serial attachments are released only by cancelling their installation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
