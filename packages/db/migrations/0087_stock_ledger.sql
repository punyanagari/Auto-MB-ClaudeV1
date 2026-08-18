SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0087: the stock ledger — an append-only record of every
-- movement of every part the organisation holds, the balance derived
-- from it, and the shortage that balance lets the bill of material
-- finally compute.
--
-- Migration 0084 built the factory and stopped at the despatch, saying
-- so in its § 7: "a stock ledger records a receipt of finished goods,
-- and its source document is a despatch". This is that ledger. It is
-- also the other half of 0084's deliberate hole — its Production
-- register could state what a job card REQUIRES and never what is
-- SHORT, because shortage is requirement minus stock and there was no
-- stock. The mock draws both screens: `app/inventory/page.tsx` (the
-- stock register and its movements) and
-- `app/inventory/purchase-orders/page.tsx` ("Shortage procurement"), at
-- fdfe5ef.
--
-- THREE THINGS, AND WHY EACH EXISTS.
--
--   stock_movements          one movement in or out, append-only
--   stock_movement_counters  per-item ledger position
--   (a column on production_items)  the reorder level
--
-- ---------------------------------------------------------------------
-- WHY THERE IS NO STOCK ITEM MASTER.
--
-- The mock has one — `StockItem` in `lib/data.ts`, with a code, a name,
-- a unit and a category — and it is the SAME LIST the bill of material
-- points at: `BomNode.itemId` holds `st-1`, a stock item id. The mock
-- keeps `manufacturedItems` and `stockItems` in two arrays only because
-- a fixture file can; the edge between them already crosses.
--
-- Migration 0084 collapsed that pair into one table for exactly this
-- reason ("One table for everything the factory names: the products the
-- agency sells AND the parts it buys to build them"), so the stock item
-- master already exists and is called `production_items`. A third item
-- master — after `canonical_items` (0078) and this one — would need a
-- mapping to the BOM's items with nothing to write it, which is 0078's
-- dead nullable key for the third time.
--
-- So a stock balance is a fact about a `production_items` row. What
-- Inventory adds to that master is ONE column, `reorder_level`, because
-- it is a stock fact and there is nowhere else honest to put it.
--
-- ---------------------------------------------------------------------
-- WHAT A BALANCE IS, AND WHY IT IS NOT A COLUMN ON THE ITEM.
--
-- The mock stores `onHand` on the item and mutates it
-- (`app/actions/inventory.ts`: `item.onHand = String(after)`), with the
-- movement list carrying a `balanceAfter` alongside. Two writers, one
-- number: the moment a movement is inserted without the update, or the
-- update lands without the movement, the register and its own ledger
-- disagree and nothing can say which is right.
--
-- Here the ledger is the only authority. `balance_after` IS stored, and
-- that is a cache — but a provably reconcilable one, which is the whole
-- of the difference:
--
--   * it is computed by the trigger below, never supplied by a writer;
--   * it is computed as the PREVIOUS row's balance plus this row's
--     signed quantity, under the per-item counter row's lock, so two
--     concurrent movements cannot both read the same previous balance;
--   * the row is append-only — no UPDATE grant, no DELETE grant — so
--     nothing can move a balance after the fact;
--   * therefore `sum(quantity) = balance_after` of the last row, always,
--     and `test/stock-ledger.integration.test.ts` asserts exactly that
--     after a concurrent burst.
--
-- A balance is read as the last row's `balance_after`, which is one
-- index seek rather than a sum over the item's whole history.
--
-- ---------------------------------------------------------------------
-- NEGATIVE STOCK IS REFUSED. Decided, not left open.
--
-- An issue that would take a balance below zero is refused, and the
-- refusal is a CHECK on the column (`balance_after >= 0`) rather than
-- only a test in the trigger — a CHECK cannot be reached around, and it
-- states the policy where a reader of the schema will find it.
--
-- The alternative posture — let stock go negative and reconcile later —
-- is what a warehouse with an unreliable receipt process needs, and the
-- product does not have one: every inbound movement here names a
-- document that already exists (a despatch, a purchase order line) or
-- carries a typed reason. A negative balance would therefore never mean
-- "the paperwork is late", it would mean "somebody issued material that
-- is not there", and the moment to say so is when they try.
--
-- The escape hatch is the adjustment, which is the point of adjustments:
-- stock found on a shelf is `adjustment_in` with a reason, and stock
-- found missing is `adjustment_out` with a reason — and an
-- `adjustment_out` cannot go below zero either, because you cannot lose
-- more than you had.
--
-- ---------------------------------------------------------------------
-- WHY THE PURCHASE ORDER IS THE ONE FROM 0033, NOT A NEW ONE.
--
-- The mock draws `SupplierPO` as its own type, with its own numbering
-- (`SPO/26-27/116`) and its own four statuses. This migration does NOT
-- build it. `purchase_orders` (0033) is already "what the contractor
-- buys IN": a vendor contact, lines, a gapless per-Work number, a
-- snapshot at issue, a derived receipt balance, and a route module that
-- has been carrying all of that since the procurement wave. A second PO
-- concept would duplicate every one of those and split the answer to
-- "what have we ordered from this vendor" across two registers.
--
-- What Inventory adds is TWO nullable columns on `purchase_order_lines`,
-- both with a writer and both with a reader:
--
--   production_item_id      which part this line buys. Without it a
--                           receipt cannot know what to add to stock,
--                           because the existing line names a
--                           `work_item_id` — a contract line, not a
--                           part — or nothing at all.
--   production_job_card_id  the job card whose shortage asked for it.
--                           The mock's `SupplierPO.planIds`, on the LINE
--                           rather than the order, because the mock's
--                           own field is a LIST: one order covers
--                           several plans.
--
-- A line carrying `production_item_id` can be received into stock, and
-- its quantity then counts toward the order's receipt balance alongside
-- the delivery-challan receipts that module already counts. A line
-- without it behaves exactly as it did before this migration, which is
-- why no existing order changes state.
--
-- WHAT INVENTORY DID NOT DO TO THAT MODULE. `purchase_orders.work_id`
-- stays NOT NULL. A shortage raised from a job card that serves a
-- private purchase order — 0084's `work_id IS NULL` shape — therefore
-- has no order to convert into, and the route says so in those words.
-- Relaxing the column would mean relaxing the per-Work counter that
-- numbers the document, the two triggers that read `works` for the date
-- and the active check, the partial unique index that holds one draft
-- per Work and vendor, and — the reason this is not a small change —
-- the `assertWorkAccess` call that is the only authorization on every
-- route in that module. That is a numbering-and-authorization change to
-- an issued-document surface, and it belongs in its own pack with its
-- own review, not as a side effect of a stock ledger.
--
-- ---------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE.
--
--   * No warehouse dimension. The mock's item carries a `warehouse` and
--     its movement dialog collects one, and neither participates in any
--     arithmetic it does: `available` is one pooled number per item, and
--     nothing transfers between locations. Its own data layer gives the
--     game away — `app/actions/inventory.ts` reads `item.location` and
--     `item.description` off a `StockItem` that has neither field, so
--     every warehouse in the running mock is `undefined`. A location
--     that labels a movement without moving a balance between locations
--     is a field that can only ever be wrong. Multi-location stock is a
--     real feature; it is a balance per (item, location) plus a transfer
--     movement, and it arrives whole or not at all.
--
--   * No `reserved` column. The mock stores one per item and no code
--     path ever writes it — its fixture values do not match its own
--     bill-of-material arithmetic either (twelve cabinets reserved
--     against a plan needing twelve, but 720 driver ICs against a plan
--     needing 2 304). A stored reservation with no writer is a fake.
--     What the register shows instead is DERIVED: the outstanding
--     bill-of-material requirement of every open job card, from
--     `app_private.stock_outstanding_requirement` below. That number has
--     a writer — the job cards themselves — and cannot drift.
--
--   * No batch control. `batchControlled` is a checkbox on the mock's
--     item dialog and there is no batch anywhere else in the mock or in
--     this application. A flag with no feature behind it is a promise
--     the screen cannot keep.
--
--   * No serialised stock rows. 0084 § 7 offers a per-unit foreign key
--     ("where the ledger is serialised, the individual unit"), and this
--     ledger deliberately does not take it. Taking it means issues pick
--     serials, returns return serials, and the balance becomes the count
--     of un-issued serial rows — a second ledger, none of which any
--     screen in the mock draws. The unit-level record already exists and
--     is better: `production_serials` and `production_component_serials`
--     hold the genealogy, and a despatch names exactly which units left.
--     Stock is the quantitative view of the same fact, and it says so by
--     deriving its receipt quantity from the despatch's own unit count
--     rather than letting anybody type one.
--
-- ---------------------------------------------------------------------
-- NAMED SQLSTATES. Every RAISE below carries a code from the 23F block,
-- which this migration is the first to use, so a guard that fires
-- because a writer reached the table by another path surfaces as the
-- same 409 the route would have raised rather than an unexplained 500.
-- `apps/server/src/routes/inventory.ts` maps every one of them.
--
--   23F01  the movement would take the balance below zero
--   23F02  the movement's source document does not admit it
--   23F03  the ledger row cannot be written this way
--
-- ---------------------------------------------------------------------
-- LOCK ORDER. `routes/inspections.ts` declares the product's ordering as
-- works -> work_items -> inspection_calls, and 0084 extended it to
-- works -> work_items -> production_job_cards -> production_serials.
-- Stock hangs off the far end and takes ONE lock of its own: the
-- per-item counter row, claimed by upsert as the first write of any
-- movement. Nothing in this migration takes a Work, a job card or an
-- item lock at all — the guard reads those rows without locking them —
-- so no path here can be half of a cycle.
--
-- ---------------------------------------------------------------------
-- NUMBERING OF THE MIGRATION ITSELF. 0087 is allocated by the wave
-- coordinator; 0085 is production's unused buffer, 0086 is
-- correspondence, and 0088 is this pack's. The series is allocated, not
-- contiguous, and has been since 0066.

-- ---------------------------------------------------------------------
-- 1. The reorder level.
--
-- The one stock fact the item master does not already carry. The mock's
-- register badges "Low stock" when available falls to it, and its stat
-- strip counts the items that have. Nullable, because "no reorder level
-- set" is a real answer and zero is not the same statement.
-- ---------------------------------------------------------------------
ALTER TABLE production_items
  ADD COLUMN reorder_level quantity_amount
    CHECK (reorder_level IS NULL OR reorder_level >= 0);

COMMENT ON COLUMN production_items.reorder_level IS
  'The available quantity at or below which the stock register badges this part low. NULL means no level is set, which is a different statement from zero. The only column Inventory (0087) adds to the item master: everything else it needs is already here.';

-- ---------------------------------------------------------------------
-- 2. The ledger position.
--
-- One counter row per item. It is claimed by upsert as the FIRST write
-- of every movement, and that is not only how the position is allocated
-- — it is the mutex the balance arithmetic runs under. Two operators
-- issuing the last unit at the same moment serialise here, so the second
-- one reads the first one's balance rather than the balance they both
-- started from.
-- ---------------------------------------------------------------------
CREATE TABLE stock_movement_counters (
  organisation_id uuid NOT NULL,
  production_item_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, production_item_id),
  FOREIGN KEY (organisation_id, production_item_id)
    REFERENCES production_items(organisation_id, id)
);

COMMENT ON TABLE stock_movement_counters IS
  'Per item, the next ledger position. Claimed by upsert rather than by reading max()+1, and claimed FIRST, because the row lock it takes is what makes the balance arithmetic in app_private.guard_stock_movement() correct under concurrency.';

ALTER TABLE stock_movement_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movement_counters FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the
-- planner treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY stock_movement_counters_tenant_policy ON stock_movement_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE: the counter records how far the ledger has gone, and the
-- ledger is append-only, so there is never anything to reset it to.
GRANT SELECT, INSERT, UPDATE ON stock_movement_counters TO auto_mb_app;

-- Migration 0064's rule for every counter in this schema: a counter may
-- only ever go up. Rewinding one would re-issue a ledger position and
-- put two rows at the same point in one item's history.
CREATE TRIGGER stock_movement_counters_guard_decrease
BEFORE UPDATE ON stock_movement_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

-- ---------------------------------------------------------------------
-- 3. The ledger.
--
-- SIX MOVEMENT TYPES, in three pairs, and the sign is bound to the type
-- by a CHECK so the two can never disagree:
--
--   production_receipt  (+)  finished units arriving from a despatch
--   purchase_receipt    (+)  bought-in material arriving on a PO line
--   issue               (-)  material going out to a job card or a Work
--   return              (+)  the same material coming back
--   adjustment_in       (+)  found, with a typed reason
--   adjustment_out      (-)  lost, with a typed reason
--
-- The mock has four (`receipt`, `issue`, `adjustment-in`,
-- `adjustment-out`). Its single `receipt` is split here because the two
-- kinds rest on DIFFERENT documents — a despatch and a purchase order
-- line — and each is bound to its own by the shape CHECK below, which a
-- shared type could not be. `return` is the movement the mock's
-- arithmetic has no type for and its register still needs: material
-- issued to a job card that is cancelled has to come back somehow, and
-- an `adjustment_in` with a typed excuse would lose the fact that it is
-- the same material going the other way.
--
-- EVERY MOVEMENT NAMES ITS DOCUMENT OR ITS REASON, and the shape CHECK
-- makes that structural rather than a convention. The mock's movement
-- dialog collects a free-text "Work / challan reference" instead; a
-- reference nothing can resolve is a string, not a link, and a ledger
-- whose rows cannot be traced back to what caused them is a list of
-- numbers.
-- ---------------------------------------------------------------------
CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  production_item_id uuid NOT NULL,

  -- The item's own ledger position, from the counter above. `SM/<item
  -- code>/<sequence>` is built for display by the route, as
  -- `routes/inspections.ts` builds its call reference, rather than
  -- stored a third time.
  sequence_number integer NOT NULL CHECK (sequence_number >= 1),

  movement_type text NOT NULL CHECK (
    movement_type IN (
      'production_receipt', 'purchase_receipt', 'issue', 'return',
      'adjustment_in', 'adjustment_out'
    )
  ),

  -- SIGNED: positive into stock, negative out of it. Stored signed
  -- rather than as a positive magnitude beside a direction, because the
  -- balance arithmetic is then addition and cannot get the sign wrong;
  -- a register that wants "12 Nos out" renders abs().
  quantity quantity_amount NOT NULL CHECK (quantity <> 0),

  -- The balance AFTER this movement. See the header: a cache, computed
  -- by the trigger under the counter's lock, never supplied by a writer,
  -- and never updated afterwards.
  balance_after quantity_amount NOT NULL CHECK (balance_after >= 0),

  -- Date-only per rule 6, and bounded against the ORGANISATION's today
  -- (`app_private.organisation_today`, migration 0082) rather than the
  -- server's, so a movement posted at 00:30 IST is not refused as being
  -- in the future by a server thinking in UTC.
  movement_date date NOT NULL,

  -- The source document, exactly one shape per type (the CHECK below).
  production_dispatch_id uuid,
  purchase_order_line_id uuid,
  production_job_card_id uuid,
  work_id uuid,

  -- Why, in the operator's words. Mandatory for an adjustment and
  -- refused on everything else: a movement that names a document has
  -- already said why it happened, and a second free-text explanation
  -- beside it is somewhere for a contradiction to live.
  reason text CHECK (
    reason IS NULL
    OR (btrim(reason) = reason AND length(reason) BETWEEN 3 AND 500)
  ),
  -- The supplier or receiver as the paperwork names them. The mock's
  -- "Supplier / receiver" field, optional on every type.
  counterparty text CHECK (
    counterparty IS NULL
    OR (btrim(counterparty) = counterparty AND length(counterparty) BETWEEN 2 AND 200)
  ),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  FOREIGN KEY (organisation_id, production_item_id)
    REFERENCES production_items(organisation_id, id),
  -- 0084 § 7's interface, taken verbatim. Its own comment records that
  -- this key is what closes the despatch DELETE path: once stock has
  -- moved on the strength of a release, PostgreSQL refuses to delete it,
  -- and the guard is the reference rather than a rule somebody has to
  -- remember to write.
  FOREIGN KEY (organisation_id, production_dispatch_id)
    REFERENCES production_dispatches(organisation_id, id),
  FOREIGN KEY (organisation_id, purchase_order_line_id)
    REFERENCES purchase_order_lines(organisation_id, id),
  FOREIGN KEY (organisation_id, production_job_card_id)
    REFERENCES production_job_cards(organisation_id, id),
  FOREIGN KEY (organisation_id, work_id)
    REFERENCES works(organisation_id, id),

  CONSTRAINT stock_movements_direction_check CHECK (
    CASE
      WHEN movement_type IN (
        'production_receipt', 'purchase_receipt', 'return', 'adjustment_in'
      ) THEN quantity > 0
      ELSE quantity < 0
    END
  ),

  -- One shape per type. Written as a searched CASE so a seventh type
  -- added without a shape is a syntax error in review rather than a row
  -- that names nothing.
  CONSTRAINT stock_movements_source_shape_check CHECK (
    CASE movement_type
      WHEN 'production_receipt' THEN
        production_dispatch_id IS NOT NULL
        AND purchase_order_line_id IS NULL
        AND production_job_card_id IS NULL AND work_id IS NULL
        AND reason IS NULL
      WHEN 'purchase_receipt' THEN
        purchase_order_line_id IS NOT NULL
        AND production_dispatch_id IS NULL
        AND production_job_card_id IS NULL AND work_id IS NULL
        AND reason IS NULL
      WHEN 'issue' THEN
        (production_job_card_id IS NOT NULL) <> (work_id IS NOT NULL)
        AND production_dispatch_id IS NULL AND purchase_order_line_id IS NULL
        AND reason IS NULL
      WHEN 'return' THEN
        (production_job_card_id IS NOT NULL) <> (work_id IS NOT NULL)
        AND production_dispatch_id IS NULL AND purchase_order_line_id IS NULL
        AND reason IS NULL
      ELSE
        reason IS NOT NULL
        AND production_dispatch_id IS NULL AND purchase_order_line_id IS NULL
        AND production_job_card_id IS NULL AND work_id IS NULL
    END
  )
);

COMMENT ON TABLE stock_movements IS
  'The append-only stock ledger: one movement in or out of one part, with the source document that caused it or the typed reason that stands in for one. The balance is this table and nothing else — see migration 0087''s header for why balance_after is a cache that cannot drift, and why an issue below zero is refused rather than reconciled later.';
COMMENT ON COLUMN stock_movements.quantity IS
  'Signed: positive into stock, negative out. Stored signed rather than as a magnitude beside a direction, so the balance arithmetic is addition and cannot get the sign wrong.';
COMMENT ON COLUMN stock_movements.balance_after IS
  'The balance after this movement, computed by app_private.guard_stock_movement() under the item counter''s row lock and never supplied by a writer. A cache, but a reconcilable one: the table is append-only, so sum(quantity) equals the last row''s balance_after forever.';
COMMENT ON CONSTRAINT stock_movements_source_shape_check ON stock_movements IS
  'Every movement names the document that caused it or carries a typed reason. The mock collects a free-text work reference instead; a reference nothing can resolve is a string, not a link.';

-- The ledger position, the on-hand seek (the last row of an item, found
-- by an index scan backwards rather than a sum over its history), and
-- the foreign key's leading index all in one.
CREATE UNIQUE INDEX stock_movements_item_position
  ON stock_movements (organisation_id, production_item_id, sequence_number);

-- The register's "Recent movements" list, newest first across every item.
--
-- THREE COLUMNS, and the middle one is load-bearing. A movement is dated
-- by the operator and several land on one date routinely — an opening
-- count and the first issue against it, most obviously — so
-- (movement_date, id) leaves same-day rows tie-broken by a RANDOM uuid.
-- That is not merely arbitrary: it puts the issue above the receipt that
-- funded it about half the time, on a ledger whose whole job is to show
-- what happened in what order. `created_at` is the order the ledger
-- actually recorded them in, and the id still closes the key so the
-- keyset has a total order to seek on.
CREATE INDEX stock_movements_register_idx
  ON stock_movements (organisation_id, movement_date, created_at, id);

-- A despatch is received into stock exactly once. NULLs are distinct in
-- PostgreSQL, so this is also the non-partial leading index the foreign
-- key needs, without excluding the movements that name no despatch.
CREATE UNIQUE INDEX stock_movements_dispatch_once
  ON stock_movements (organisation_id, production_dispatch_id);

-- The remaining three foreign keys, each needing a NON-partial leading
-- index (`test/fk-index-coverage.integration.test.ts`: referential
-- integrity cannot use a partial one). The purchase-order index is also
-- the one `routes/purchase-orders.ts` reads to add stock receipts to a
-- line's received quantity.
CREATE INDEX stock_movements_purchase_order_line_idx
  ON stock_movements (organisation_id, purchase_order_line_id);
CREATE INDEX stock_movements_job_card_idx
  ON stock_movements (organisation_id, production_job_card_id);
CREATE INDEX stock_movements_work_idx
  ON stock_movements (organisation_id, work_id);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;

CREATE POLICY stock_movements_tenant_policy ON stock_movements
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- APPEND-ONLY, and the grant is the enforcement. No UPDATE: a movement
-- states what happened, and a balance that can be edited is not a
-- ledger. No DELETE either — a movement posted in error is reversed by
-- an adjustment carrying the reason, which leaves both the mistake and
-- the correction on the record. This is the same posture the audit trail
-- (0002) and the tender status trail (0083) hold.
GRANT SELECT, INSERT ON stock_movements TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 4. The balance, read.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.stock_on_hand(org uuid, item uuid)
RETURNS quantity_amount
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    (
      SELECT m.balance_after
      FROM stock_movements m
      WHERE m.organisation_id = org AND m.production_item_id = item
      ORDER BY m.sequence_number DESC
      LIMIT 1
    ),
    0
  )::quantity_amount
$$;

COMMENT ON FUNCTION app_private.stock_on_hand(uuid, uuid) IS
  'What is on the shelf: the last ledger row''s balance_after, or zero for a part that has never moved. One index seek on stock_movements_item_position rather than a sum over the item''s history.';

-- ---------------------------------------------------------------------
-- 5. The write guard.
--
-- Everything a movement is allowed to be. The route checks the same
-- rules first, so an operator gets a named 409 with a remedy; this is
-- the arm that holds when a writer reaches the table another way, and
-- the arm that holds under concurrency, which the route cannot.
-- ---------------------------------------------------------------------

-- `SET search_path` for the reason 0067, 0077, 0079 and 0084 all give: a
-- function that resolves its own identifiers through the caller's path
-- is a rule a shadowing object in a writable schema can rewrite into
-- whatever it likes. Not SECURITY DEFINER: every table it touches is one
-- the caller may already read under RLS, and a definer function here
-- would read across tenants.
CREATE FUNCTION app_private.guard_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  item_active boolean;
  released integer;
  line_item uuid;
  order_status text;
  card_status text;
  work_status text;
  previous quantity_amount;
BEGIN
  -- THE MUTEX, AND IT IS FIRST. The counter upsert takes a row lock on
  -- this item's counter, so two movements against one item serialise
  -- from here to commit: the second reads a balance that already
  -- includes the first. Nothing below reads a balance before this.
  INSERT INTO stock_movement_counters (organisation_id, production_item_id)
  VALUES (NEW.organisation_id, NEW.production_item_id)
  ON CONFLICT (organisation_id, production_item_id)
  DO UPDATE SET
    next_value = stock_movement_counters.next_value + 1,
    updated_at = now()
  RETURNING next_value INTO NEW.sequence_number;

  SELECT active INTO item_active
  FROM production_items
  WHERE organisation_id = NEW.organisation_id AND id = NEW.production_item_id;

  IF item_active IS NULL THEN
    RAISE EXCEPTION
      'movement names item %, which this transaction cannot read',
      NEW.production_item_id
      USING ERRCODE = '23F03';
  END IF;

  -- A retired part takes nothing more IN — that is what retiring it
  -- said. What is already on its shelf still goes OUT, because the
  -- alternative is stock nobody can ever clear.
  IF NOT item_active AND NEW.quantity > 0 THEN
    RAISE EXCEPTION
      'item % is retired and takes no further stock in',
      NEW.production_item_id
      USING ERRCODE = '23F03';
  END IF;

  IF NEW.movement_date > app_private.organisation_today(NEW.organisation_id) THEN
    RAISE EXCEPTION
      'movement date % is in the future', NEW.movement_date
      USING ERRCODE = '23F03';
  END IF;

  IF NEW.movement_type = 'production_receipt' THEN
    -- PRODUCTION STATES THE QUANTITY, NOT THE OPERATOR. 0084 § 7: "The
    -- quantity received equals the number of production_dispatch_serials
    -- rows the despatch carries; production never states a quantity of
    -- its own, so the two cannot disagree." Counted here, and the
    -- movement is refused if it claims anything else.
    SELECT count(*) INTO released
    FROM production_dispatch_serials ds
    JOIN production_serials s
      ON s.organisation_id = ds.organisation_id
     AND s.id = ds.production_serial_id
    WHERE ds.organisation_id = NEW.organisation_id
      AND ds.production_dispatch_id = NEW.production_dispatch_id
      AND s.item_id = NEW.production_item_id;

    IF released = 0 THEN
      RAISE EXCEPTION
        'despatch % released no unit of item %',
        NEW.production_dispatch_id, NEW.production_item_id
        USING ERRCODE = '23F02';
    END IF;

    IF NEW.quantity <> released THEN
      RAISE EXCEPTION
        'despatch % released % units, so the receipt cannot be for %',
        NEW.production_dispatch_id, released, NEW.quantity
        USING ERRCODE = '23F02';
    END IF;

  ELSIF NEW.movement_type = 'purchase_receipt' THEN
    SELECT pol.production_item_id, po.status INTO line_item, order_status
    FROM purchase_order_lines pol
    JOIN purchase_orders po
      ON po.organisation_id = pol.organisation_id
     AND po.id = pol.purchase_order_id
    WHERE pol.organisation_id = NEW.organisation_id
      AND pol.id = NEW.purchase_order_line_id;

    -- A line that names no part cannot be received into stock: its
    -- quantity is in whatever unit somebody typed, against a contract
    -- line rather than a shelf. Only a line raised from a shortage — or
    -- one an operator has since pointed at a part — carries one.
    IF line_item IS NULL OR line_item <> NEW.production_item_id THEN
      RAISE EXCEPTION
        'purchase order line % does not buy item %',
        NEW.purchase_order_line_id, NEW.production_item_id
        USING ERRCODE = '23F02';
    END IF;

    -- A draft has ordered nothing yet, and a cancelled order is never
    -- coming. A closed one has already been declared fully received, and
    -- reopening that by receiving more is a state change the procurement
    -- module owns.
    IF order_status <> 'issued' THEN
      RAISE EXCEPTION
        'purchase order line % belongs to a % order', NEW.purchase_order_line_id,
        order_status
        USING ERRCODE = '23F02';
    END IF;

  ELSIF NEW.production_job_card_id IS NOT NULL THEN
    SELECT status INTO card_status
    FROM production_job_cards
    WHERE organisation_id = NEW.organisation_id
      AND id = NEW.production_job_card_id;

    -- Material moves for a job card that is still being built. A
    -- completed or cancelled card consumes nothing more, and material
    -- coming back from a cancelled one is an adjustment against the
    -- ledger, not a movement against the card.
    IF card_status IS NULL OR card_status NOT IN ('planned', 'in_production') THEN
      RAISE EXCEPTION
        'job card % is % and takes no stock movement',
        NEW.production_job_card_id, coalesce(card_status, 'missing')
        USING ERRCODE = '23F02';
    END IF;

  ELSIF NEW.work_id IS NOT NULL THEN
    SELECT status INTO work_status
    FROM works
    WHERE organisation_id = NEW.organisation_id
      AND id = NEW.work_id AND deleted_at IS NULL;

    -- R8 (migration 0031): a completed Work accepts no new movement,
    -- the same refusal procurement and the challan module already make.
    IF work_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION
        'work % is % and takes no stock movement', NEW.work_id,
        coalesce(work_status, 'missing')
        USING ERRCODE = '23F02';
    END IF;
  END IF;

  -- THE BALANCE. Read after the counter lock, so it is this item's
  -- balance as of now and not as of whenever a competing transaction
  -- started.
  previous := app_private.stock_on_hand(
    NEW.organisation_id, NEW.production_item_id
  );
  NEW.balance_after := previous + NEW.quantity;

  -- The negative-stock policy, stated where it happens. The column's own
  -- CHECK refuses this too and cannot be reached around; this raise
  -- exists so the refusal arrives with the numbers in it rather than as
  -- a bare 23514.
  IF NEW.balance_after < 0 THEN
    RAISE EXCEPTION
      'item % holds % and cannot release %',
      NEW.production_item_id, previous, abs(NEW.quantity)
      USING ERRCODE = '23F01';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_stock_movement() IS
  'Allocates the ledger position, which is also the per-item mutex; binds a receipt to the despatch or purchase order line that admits it and a movement to a live job card or Work; computes balance_after from the previous row under that mutex; and refuses a movement that would take the balance below zero.';

CREATE TRIGGER stock_movements_guard_write
BEFORE INSERT ON stock_movements
FOR EACH ROW EXECUTE FUNCTION app_private.guard_stock_movement();

-- ---------------------------------------------------------------------
-- 6. The purchase order's two new columns.
--
-- See the header for why this is 0033's purchase order rather than the
-- mock's separate `SupplierPO`. Both columns are nullable and both are
-- written by the shortage conversion in `routes/inventory.ts`; a line
-- carrying neither behaves exactly as every line did before this
-- migration.
-- ---------------------------------------------------------------------
ALTER TABLE purchase_order_lines
  ADD COLUMN production_item_id uuid,
  ADD COLUMN production_job_card_id uuid,
  ADD CONSTRAINT purchase_order_lines_production_item_fk
    FOREIGN KEY (organisation_id, production_item_id)
      REFERENCES production_items(organisation_id, id),
  ADD CONSTRAINT purchase_order_lines_production_job_card_fk
    FOREIGN KEY (organisation_id, production_job_card_id)
      REFERENCES production_job_cards(organisation_id, id),
  -- A job card can only be recorded as the REASON for buying a part, so
  -- naming one without naming the part is a row that says nothing.
  ADD CONSTRAINT purchase_order_lines_shortage_shape_check CHECK (
    production_job_card_id IS NULL OR production_item_id IS NOT NULL
  );

COMMENT ON COLUMN purchase_order_lines.production_item_id IS
  'The part this line buys, when it buys a part. NULL on every line raised before Inventory (0087) and on any line an operator types by hand against a contract item or a consumable. A line carrying it can be received into stock, and that receipt counts toward the order''s received quantity alongside the delivery-challan receipts routes/purchase-orders.ts already sums.';
COMMENT ON COLUMN purchase_order_lines.production_job_card_id IS
  'The job card whose shortage asked for this line. The mock''s SupplierPO.planIds, held on the line rather than the order because the mock''s own field is a list: one order covers several plans.';

-- Non-partial leading indexes, for the same reason § 3's are.
CREATE INDEX purchase_order_lines_production_item_idx
  ON purchase_order_lines (organisation_id, production_item_id);
CREATE INDEX purchase_order_lines_production_job_card_idx
  ON purchase_order_lines (organisation_id, production_job_card_id);

-- ---------------------------------------------------------------------
-- 7. The bill-of-material explosion, and the shortage it feeds.
--
-- The subtraction 0084 could not finish. One function, so the number on
-- the stock register's "Committed" column, the number the shortage
-- screen orders against, and the number a job card's material list shows
-- are one arithmetic rather than three.
--
-- WHAT IS OUTSTANDING. A job card that has planned twelve units and
-- serialised six still needs material for six. The requirement is
-- therefore the per-unit explosion times the units NOT YET BUILT, not
-- times the planned quantity — the material for the six that exist has
-- already been consumed, and counting it again would order it twice.
--
-- WHY THE EXPLOSION IS GROSS. Every level's requirement is the parent's
-- requirement times the edge quantity, all the way down, with no netting
-- of a sub-assembly's own stock against its children. That is the mock's
-- own `explodeBom`, and it over-orders: ninety-six finished LED boards
-- on the shelf do not reduce the driver ICs this asks for.
--
-- ponytail: gross explosion, and the ceiling is real — a stocked
-- sub-assembly is bought twice, once assembled and once as its parts.
-- The upgrade is level-by-level netting with low-level coding, which
-- needs each item's lowest level across the whole bill and an allocation
-- pass that a single recursive query cannot express. It belongs with a
-- planning screen that shows the netting, not hidden inside a shortage
-- list.
--
-- WHY THE SHORTAGE IS PER PART AND NOT PER JOB CARD. The mock's
-- shortage screen lists one row per (plan, part) and offers a checkbox
-- on each. Tick the two rows for the same part from two plans and it
-- orders it twice, because neither row knows about the other — and
-- there is no honest per-card answer to "how much of the shelf is
-- mine". This function returns the contribution PER CARD so a screen can
-- say who wants it, and the shortage is computed once per part from
-- their sum against one balance. `docs/UX.md` records the divergence.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.stock_outstanding_requirement(org uuid)
RETURNS TABLE (
  job_card_id uuid,
  component_item_id uuid,
  required quantity_amount
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH RECURSIVE open_cards AS (
    SELECT j.id,
           j.item_id,
           j.quantity - (
             SELECT count(*)
             FROM production_serials s
             WHERE s.organisation_id = j.organisation_id AND s.job_card_id = j.id
           ) AS outstanding
    FROM production_job_cards j
    WHERE j.organisation_id = org
      AND j.status IN ('planned', 'in_production')
  ),
  tree(job_card_id, component_item_id, quantity, depth) AS (
    SELECT c.id, line.component_item_id, line.quantity * c.outstanding, 1
    FROM open_cards c
    JOIN production_bom_lines line
      ON line.organisation_id = org AND line.parent_item_id = c.item_id
    WHERE c.outstanding > 0
    UNION ALL
    SELECT tree.job_card_id, line.component_item_id,
           tree.quantity * line.quantity, tree.depth + 1
    FROM tree
    JOIN production_bom_lines line
      ON line.organisation_id = org AND line.parent_item_id = tree.component_item_id
    WHERE tree.depth < app_private.production_bom_max_depth()
  ) CYCLE component_item_id SET is_cycle USING path
  -- 0084 refuses a cycle at write time, so `is_cycle` is never true
  -- against stored data. It is filtered anyway because the CYCLE clause
  -- EMITS the offending row before it stops expanding it, and summing
  -- that row would add a phantom requirement to a shortage list — the
  -- one place a defensive filter is cheaper than the bug it prevents.
  SELECT t.job_card_id, t.component_item_id, sum(t.quantity)::quantity_amount
  FROM tree t
  WHERE NOT t.is_cycle
  GROUP BY t.job_card_id, t.component_item_id
$$;

COMMENT ON FUNCTION app_private.stock_outstanding_requirement(uuid) IS
  'What every open job card still needs, part by part: the recursive bill-of-material explosion times the units not yet serialised. The stock register''s committed quantity, the shortage screen''s requirement, and a job card''s material list are all this one arithmetic. A gross explosion — a stocked sub-assembly does not reduce its children (migration 0087 § 7).';
