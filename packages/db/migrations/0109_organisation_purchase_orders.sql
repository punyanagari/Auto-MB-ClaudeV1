SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0109: a purchase order may be raised outside any LOA, and no
-- purchase order closes without the vendor's tax invoice.
--
-- Two owner rulings taken on 2026-08-19, in one file because the second
-- one is a rule about EVERY purchase order and the first one creates the
-- purchase orders it would otherwise not cover.
--
-- ---------------------------------------------------------------------
-- THE PACK 0087 SAID WOULD HAVE TO EXIST.
--
-- `0087_stock_ledger.sql` § WHAT INVENTORY DID NOT DO TO THAT MODULE
-- refused to relax `purchase_orders.work_id` and listed, exactly, what
-- relaxing it would mean:
--
--   * the per-Work counter that numbers the document;
--   * the two triggers that read `works` for the date and the active
--     check;
--   * the partial unique index that holds one draft per Work and vendor;
--   * `assertWorkAccess`, the only authorization on every route in that
--     module.
--
-- "That is a numbering-and-authorization change to an issued-document
-- surface, and it belongs in its own pack with its own review." This is
-- that pack. All four are below, in that order, plus the fifth thing
-- 0087 did not have to name because it was writing it at the time: its
-- own `guard_stock_movement` reaches through the order to the Work, and
-- an order with no Work behind it must be exempt rather than refused.
--
-- ---------------------------------------------------------------------
-- WHY NULL RATHER THAN A SECOND DOCUMENT.
--
-- The alternative is a `standalone_purchase_orders` table, and it is the
-- same argument 0087 made against a second `SupplierPO`: a vendor
-- contact, lines, a gapless number, a snapshot at issue, a derived
-- receipt balance and a whole route module, all written twice, and the
-- answer to "what have we ordered from this vendor" split across two
-- registers forever. What actually differs between an order raised
-- against an award and one raised against nothing is the Work — one
-- column — so one column is what moves.
--
-- WHAT A WORK-LESS ORDER LOSES, stated rather than discovered:
--
--   * its date has no LOA letter to be after. The future bound stays;
--     the lower bound has nothing to be.
--   * its lines cannot name a Work item, because there is no Work whose
--     items they could be. They are consumables and free text, which the
--     line table has always allowed (`work_item_id` is nullable, 0033).
--   * R8 does not reach it. There is no Work to complete, so nothing
--     closes procurement down on it.
--   * work-scope does not reach it either. See § 4.
--
-- ---------------------------------------------------------------------
-- NUMBERING. The per-Work series is untouched: `purchase_order_counters`
-- keeps its shape, its rows, its trigger and its `<work_code>-PO-NN`
-- rendering. Work-less orders are a SECOND, INDEPENDENT series under
-- `organisation_purchase_order_counters`, one row per organisation,
-- rendered `PO-NN` — the shape `budgetary_quotations` already uses for
-- the other document in this module that carries no Work (`BQ-NN`,
-- 0033 § 3). Two series cannot collide inside
-- `purchase_orders_organisation_id_po_number_key` because a work code is
-- never empty, so `<code>-PO-01` is never the string `PO-01`.
--
-- The org series gets what 0064 § 2 gave the tax invoice and the per-Work
-- challan series have carried since 0003: a unique index on the SEQUENCE
-- the number is rendered from, not merely on the rendered string. A
-- gap-free series is only provable if the sequence itself is unique. The
-- per-Work series still has no such index and does not gain one here —
-- that is a separate defect with a separate proof, and this pack does not
-- widen its own blast radius to fix it.
--
-- ---------------------------------------------------------------------
-- THE TAX-INVOICE RULING, and why it lands on every order rather than
-- only on the new ones.
--
-- Owner, 2026-08-19: closing ANY purchase order requires a vendor tax
-- invoice. Closing has always been derived — an order closes when its
-- lines are received — and the ruling adds a second, independent
-- condition: the material arrived AND the vendor billed for it, with the
-- bill on file. The two refusals are separate because the remedies are
-- separate: one is chased at the gate, the other in the accounts inbox.
--
-- `vendor_invoices` (0080) is the liability register that already carries
-- the vendor, the amount, the TDS classification and the payments that
-- consume it. It gains an optional `purchase_order_id`, and the invoice
-- rides that machinery unchanged.
--
-- IT ALSO GAINS A DOCUMENT, because it had none. 0080 recorded a vendor
-- invoice as facts with no file behind them, which is adequate for a
-- liability and inadequate for evidence: "a stored key with no upload
-- behind it and no route to fetch it is a proof that cannot be produced"
-- (`packages/contracts/src/payments.ts`, on `proofReference`). A close
-- gated on an invoice nobody can produce would be a gate on a form field.
-- The seven storage columns are `company_document_versions`' own shape
-- (0079), including the tenant-prefix CHECK on the key, and the bytes
-- reach them through the same `consumeUpload` -> `assertNotMalware` ->
-- `storePdfUpload` path every other upload in this application takes.
--
-- ---------------------------------------------------------------------
-- NAMED SQLSTATES. This pack's block is 23U, one code per rule:
--
--   23U01  the purchase order has no vendor tax invoice on file
--   23U02  the vendor invoice's order link or document is already fixed
--
-- WHY 23U AND NOT THE NEXT LETTER. The letters run to 23Q (0099), and
-- 23R, 23S and 23T stand allocated by the Wave D/E namespace ledger to
-- E-offline, E-whatsapp-delivery and E-msme-43bh. Two of those are held
-- rather than cancelled, and a corrections pack must not spend a
-- reservation it did not make, so this takes the first letter past them.
-- I and O are skipped throughout the family because they read as 1 and 0
-- and the one thing an operator does with a SQLSTATE is read it aloud.
--
-- ---------------------------------------------------------------------
-- LOCK ORDER. Unchanged. The close path still takes
-- purchase_orders -> delivery_challans and the trigger added in § 8 reads
-- `vendor_invoices` without locking it: the only decision it makes is
-- whether a qualifying invoice EXISTS, and § 7 freezes the link and the
-- document once set, so an invoice that qualifies at this instant cannot
-- stop qualifying later by being re-pointed. It can only be cancelled,
-- which is a fact the register keeps and the audit trail names.
--
-- ---------------------------------------------------------------------
-- CENSUS.
--
--   Tables created                1  (organisation_purchase_order_counters)
--   Tables altered                2  (purchase_orders, vendor_invoices)
--   Columns added                 8  (all on vendor_invoices: the order
--                                     link, and the seven that describe
--                                     the uploaded document)
--   Columns relaxed               1  (purchase_orders.work_id)
--   Functions replaced            3  (guard_purchase_order_date,
--                                     guard_purchase_order_work_active,
--                                     guard_stock_movement)
--   Functions created             2  (guard_purchase_order_close_evidence,
--                                     guard_vendor_invoice_evidence_update)
--   Triggers created              5  (the counter's decrease guard, the
--                                     close-evidence guard, the vendor
--                                     invoice evidence guard, and the two
--                                     re-created in § 4 to widen their
--                                     event list to `work_id`)
--   Triggers dropped              2  (the same two, re-created immediately)
--   Indexes created               4
--   RLS policies created          1
--
-- ONE BEHAVIOUR CHANGE REACHES ORDERS THAT ALREADY EXIST, and it is § 2's:
-- the 0033 date guard returned early when a Work carried no letter date,
-- which skipped the FUTURE bound as well as the lower one. That early
-- return is gone, so a work-ful order dated in the future is now refused
-- where it previously was not. `works.letter_date` is NOT NULL (0001), so
-- no such order can exist; it is recorded because "replaced" is not the
-- same word as "unchanged".
--
-- WORK SUPERSESSION (0071). `purchase_orders` is already in the
-- supersession sweep by `work_id` and stays there: a work-less order has
-- no Work to supersede, and the sweep's `WHERE t.work_id = ...` never
-- matches it. `vendor_invoices` keeps its existing exemption
-- (`apps/server/src/work-supersede.ts`) — a liability to a vendor is not
-- a Work's document, and pointing one at a purchase order does not make
-- it one.
--
-- ROLLBACK. Nothing here rewrites a row. Reversing it is: drop the three
-- triggers and two functions this file creates, restore the three
-- replaced functions from 0087 and 0033 by replacing them back, drop the
-- four indexes and the counter table, drop the eight columns from
-- `vendor_invoices`, and re-assert `purchase_orders.work_id NOT NULL` —
-- which is only possible while no work-less order has been created.

-- ═════════════════════════════════════════════════════════════════════
-- § 1. THE COLUMN
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE purchase_orders ALTER COLUMN work_id DROP NOT NULL;

COMMENT ON COLUMN purchase_orders.work_id IS
  'The Work this order buys for, or NULL for an order raised outside any '
  'LOA. The composite tenant foreign key is MATCH SIMPLE, so it is '
  'satisfied trivially while the column is NULL and enforced in full the '
  'moment it is not: the link is checked exactly when there is a link.';

-- ═════════════════════════════════════════════════════════════════════
-- § 2. THE DATE GUARD, WITH NOTHING TO BE AFTER
-- ═════════════════════════════════════════════════════════════════════
--
-- The 0033 guard read `works` for the letter date and returned early when
-- it found none. That early return is now reachable by design rather than
-- by a missing Work, and it takes the FUTURE bound with it — so a
-- work-less order could be dated next year. The bound is restored by
-- reading the organisation's own today directly, which is what the Work
-- join was only ever a route to. `app_private.organisation_today` (0082)
-- is the same function the stock ledger's own future check uses, so an
-- order accepted today cannot be one another guard treats as tomorrow's.

CREATE OR REPLACE FUNCTION app_private.guard_purchase_order_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_letter_date date;
  v_today date;
BEGIN
  v_today := app_private.organisation_today(NEW.organisation_id);

  IF NEW.work_id IS NOT NULL THEN
    SELECT w.letter_date INTO v_letter_date
      FROM works w
     WHERE w.id = NEW.work_id;

    IF v_letter_date IS NOT NULL AND NEW.po_date < v_letter_date THEN
      RAISE EXCEPTION 'po_date % precedes the LOA letter date %',
        NEW.po_date, v_letter_date;
    END IF;
  END IF;

  IF v_today IS NOT NULL AND NEW.po_date > v_today THEN
    RAISE EXCEPTION 'po_date % is in the future (today is %)',
      NEW.po_date, v_today;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_private.guard_purchase_order_date() IS
  'A purchase order is never dated in the future, read in the organisation''s own timezone, and never before the LOA letter date of the Work it buys for. An order raised outside any LOA has no lower bound, because there is no award it could precede.';

-- ═════════════════════════════════════════════════════════════════════
-- § 3. R8 REACHES A WORK, AND THERE MAY BE NONE
-- ═════════════════════════════════════════════════════════════════════
--
-- The 0033 guard read the Work's status and refused anything that was not
-- 'active'; a NULL work_id produced a NULL status, and `IS DISTINCT FROM`
-- made that a refusal. R8 is a rule about completed Works, so an order
-- with no Work is outside it rather than in breach of it. Same NULL
-- exemption the job-card arm of `guard_stock_movement` has carried since
-- 0087.

CREATE OR REPLACE FUNCTION app_private.guard_purchase_order_work_active()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.work_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT status INTO v_status FROM works WHERE id = NEW.work_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'work % is % — reopen it before recording a purchase order',
      NEW.work_id, COALESCE(v_status, 'missing');
  END IF;
  RETURN NEW;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- § 4. ONE DRAFT PER VENDOR, WHEN THERE IS NO WORK TO COUNT IT UNDER
-- ═════════════════════════════════════════════════════════════════════
--
-- `purchase_orders_one_draft_per_work_vendor` (0045) is a partial unique
-- index on `(organisation_id, work_id, vendor_contact_id)`. NULLs are
-- distinct in a unique index, so it constrains nothing at all once
-- `work_id` may be NULL — a vendor could accumulate any number of open
-- work-less drafts, which is the data-entry accident 0045 exists to
-- refuse. The org series gets its own index rather than a rewrite of
-- that one, so the per-Work rule keeps its name, its shape and its
-- existing proof.

CREATE UNIQUE INDEX purchase_orders_one_draft_per_vendor_org
  ON purchase_orders (organisation_id, vendor_contact_id)
  WHERE status = 'draft' AND work_id IS NULL;

-- ---------------------------------------------------------------------
-- AND THE TWO GUARDS NOW WATCH THE COLUMN THEY DEPEND ON.
--
-- `purchase_orders_work_active` fired BEFORE INSERT and
-- `purchase_orders_date_guard` BEFORE INSERT OR UPDATE OF po_date, which
-- was complete while `work_id` was NOT NULL and set once at insert.
-- Dropping the constraint makes moving a DRAFT between Works — and
-- between the two number series, since the series is chosen at issue from
-- this column — a reachable write for the first time, and
-- `guard_purchase_order_update` (0045) returns early for a draft, so
-- neither R8 nor the letter-date bound would be re-checked.
--
-- No route writes `work_id` on an update; this is the layer that holds
-- when one does, or when a writer reaches the table another way.
DROP TRIGGER purchase_orders_work_active ON purchase_orders;
CREATE TRIGGER purchase_orders_work_active
BEFORE INSERT OR UPDATE OF work_id ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_purchase_order_work_active();

DROP TRIGGER purchase_orders_date_guard ON purchase_orders;
CREATE TRIGGER purchase_orders_date_guard
BEFORE INSERT OR UPDATE OF po_date, work_id ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_purchase_order_date();

-- ═════════════════════════════════════════════════════════════════════
-- § 5. THE ORGANISATION SERIES
-- ═════════════════════════════════════════════════════════════════════

CREATE TABLE organisation_purchase_order_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id) PRIMARY KEY,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0)
);

COMMENT ON TABLE organisation_purchase_order_counters IS
  'The gap-free sequence behind PO-NN, the number a purchase order raised outside any LOA carries. One row per organisation, taken under the row lock the issue path holds, exactly as budgetary_quotation_counters numbers the other work-less document in this module.';

ALTER TABLE organisation_purchase_order_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_purchase_order_counters FORCE ROW LEVEL SECURITY;

-- The scalar-subselect form is 0069's InitPlan rule: the helper is called
-- once per query rather than once per row.
CREATE POLICY organisation_purchase_order_counters_tenant_policy
  ON organisation_purchase_order_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE, like every other counter table: a series that can be reset
-- is a series whose numbers can be handed out twice.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE
      ON organisation_purchase_order_counters TO auto_mb_app;
  END IF;
END
$$;

-- The 0064 family guard, named after the same convention so the eleven
-- triggers read as one family in the catalog.
CREATE TRIGGER organisation_purchase_order_counters_guard_decrease
BEFORE UPDATE ON organisation_purchase_order_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

-- The sequence, not merely the rendered string. See NUMBERING above.
-- Drafts carry a NULL sequence_number and are excluded by the predicate,
-- exactly as `delivery_challans_sequence_per_work` does for draft
-- challans and `tax_invoices_sequence_per_fy` (0064) for draft invoices.
CREATE UNIQUE INDEX purchase_orders_org_sequence
  ON purchase_orders (organisation_id, sequence_number)
  WHERE work_id IS NULL AND sequence_number IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════
-- § 6. THE STOCK LEDGER REACHES THROUGH THE ORDER TO A WORK
-- ═════════════════════════════════════════════════════════════════════
--
-- `stock_movements` has always ALLOWED a work-less purchase receipt: the
-- `purchase_receipt` arm of `stock_movements_source_shape_check` requires
-- `work_id IS NULL` on the movement itself, because Work reachability is
-- derived through the order rather than stated on the row. What refused
-- it was the guard: the arm read the order's Work and applied R8 to it
-- with no NULL exemption, so a work-less order produced
-- "belongs to work <null>, which is missing".
--
-- Replaced whole, because a plpgsql body cannot be patched in part. ONE
-- arm changes — the R8 check is wrapped in `IF order_work IS NOT NULL`,
-- which is precisely what the job-card arm below it has always done for a
-- job card serving a private order. Everything else, including every
-- SQLSTATE, is 0087's verbatim.

CREATE OR REPLACE FUNCTION app_private.guard_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  item_active boolean;
  latest_date date;
  released integer;
  line_item uuid;
  order_status text;
  order_work uuid;
  card_status text;
  card_work uuid;
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

  -- TIME ONLY RUNS FORWARD, PER PART (see the 0087 header). Read under
  -- the counter lock taken above, so two writers cannot both pass this
  -- and then post out of order — which is exactly the race that would
  -- leave a running total dated behind the row before it.
  SELECT max(m.movement_date) INTO latest_date
  FROM stock_movements m
  WHERE m.organisation_id = NEW.organisation_id
    AND m.production_item_id = NEW.production_item_id;

  IF latest_date IS NOT NULL AND NEW.movement_date < latest_date THEN
    RAISE EXCEPTION
      'item % last moved on %, so a movement dated % cannot be posted behind it',
      NEW.production_item_id, latest_date, NEW.movement_date
      USING ERRCODE = '23F04';
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
    -- FOR SHARE OF po: the status decides whether this receipt is allowed
    -- at all, so it must not change under the transaction that read it. A
    -- share lock is the right strength — this path never writes the
    -- order, it only depends on it staying issued — and it blocks the
    -- cancel and close paths, which take the row FOR UPDATE, until this
    -- movement commits.
    SELECT pol.production_item_id, po.status, po.work_id
      INTO line_item, order_status, order_work
    FROM purchase_order_lines pol
    JOIN purchase_orders po
      ON po.organisation_id = pol.organisation_id
     AND po.id = pol.purchase_order_id
    WHERE pol.organisation_id = NEW.organisation_id
      AND pol.id = NEW.purchase_order_line_id
    FOR SHARE OF po;

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

    -- R8 reaches through the order. A receipt against a completed Work's
    -- purchase order is an operational act on that Work, and the direct
    -- `work_id` arm below already refuses one; the indirect route must
    -- not be the way around it.
    --
    -- CHANGED BY 0109: an order raised outside any LOA has no Work to
    -- reach, so there is no R8 to apply — the same NULL exemption the job
    -- card arm below has carried since 0087. Without the wrapper the
    -- lookup finds no row, `work_status` stays NULL, and `IS DISTINCT
    -- FROM 'active'` turns "there is no Work" into "the Work is missing".
    IF order_work IS NOT NULL THEN
      SELECT w.status INTO work_status
      FROM works w
      WHERE w.organisation_id = NEW.organisation_id
        AND w.id = order_work AND w.deleted_at IS NULL;

      IF work_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION
          'purchase order line % belongs to work %, which is %',
          NEW.purchase_order_line_id, order_work, coalesce(work_status, 'missing')
          USING ERRCODE = '23F02';
      END IF;
    END IF;

  ELSIF NEW.production_job_card_id IS NOT NULL THEN
    SELECT status, work_id INTO card_status, card_work
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

    -- R8 through the job card. A card serving a private purchase order
    -- has no Work and nothing to check; one serving a Work is bound by
    -- that Work's state exactly as the direct arm below is.
    IF card_work IS NOT NULL THEN
      SELECT w.status INTO work_status
      FROM works w
      WHERE w.organisation_id = NEW.organisation_id
        AND w.id = card_work AND w.deleted_at IS NULL;

      IF work_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION
          'job card % serves work %, which is %',
          NEW.production_job_card_id, card_work, coalesce(work_status, 'missing')
          USING ERRCODE = '23F02';
      END IF;
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

-- `CREATE OR REPLACE` keeps the pg_proc OID, so 0087's own COMMENT
-- survives this replacement unrefreshed and still promises to reach
-- "through both to the Work behind them" with no exception. Restated.
COMMENT ON FUNCTION app_private.guard_stock_movement() IS
  'Allocates the ledger position, which is also the per-item mutex; refuses a movement dated ahead of the organisation''s today or behind the part''s own last movement; binds a receipt to the despatch or purchase order line that admits it and a movement to a live job card or Work, reaching through both to the Work behind them where there is one — a job card serving a private order and, since 0109, a purchase order raised outside any LOA each have no Work to reach and are exempt; computes balance_after from the previous row under that mutex; and refuses a movement that would take the balance below zero.';

-- ═════════════════════════════════════════════════════════════════════
-- § 7. THE VENDOR INVOICE GAINS AN ORDER AND A FILE
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE vendor_invoices
  ADD COLUMN purchase_order_id uuid,
  ADD CONSTRAINT vendor_invoices_purchase_order_fk
    FOREIGN KEY (organisation_id, purchase_order_id)
      REFERENCES purchase_orders(organisation_id, id),

  -- The document, in `company_document_versions`' shape (0079). Five
  -- columns rather than a table because a vendor invoice has exactly one
  -- file and no version history: it is the vendor's paper, not this
  -- organisation's, so there is nothing here to supersede.
  ADD COLUMN object_key text,
  ADD COLUMN original_filename text CHECK (
    original_filename IS NULL
    OR length(btrim(original_filename)) BETWEEN 1 AND 255
  ),
  ADD COLUMN document_sha256 sha256_hex,
  ADD COLUMN document_media_type text CHECK (
    document_media_type IS NULL OR document_media_type = 'application/pdf'
  ),
  ADD COLUMN document_size_bytes bigint CHECK (
    document_size_bytes IS NULL OR document_size_bytes > 0
  ),
  ADD COLUMN document_uploaded_at timestamptz,
  ADD COLUMN document_uploaded_by_user_id text,

  -- All of it or none of it, so "this invoice has its document" is one
  -- column test and cannot half-exist. Same posture as
  -- `vendor_invoices_tds_shape_check` beside it.
  ADD CONSTRAINT vendor_invoices_document_shape_check CHECK (
    (object_key IS NULL AND original_filename IS NULL
      AND document_sha256 IS NULL AND document_media_type IS NULL
      AND document_size_bytes IS NULL AND document_uploaded_at IS NULL
      AND document_uploaded_by_user_id IS NULL)
    OR
    (object_key IS NOT NULL AND original_filename IS NOT NULL
      AND document_sha256 IS NOT NULL AND document_media_type IS NOT NULL
      AND document_size_bytes IS NOT NULL AND document_uploaded_at IS NOT NULL
      AND document_uploaded_by_user_id IS NOT NULL)
  ),

  -- The second layer on the key (0079 § the same CHECK): a key that does
  -- not start with this tenant's id is a key into another tenant's
  -- objects, and the route's own prefixing is the first layer only.
  ADD CONSTRAINT vendor_invoices_object_key_tenant_prefix_check CHECK (
    object_key IS NULL OR object_key LIKE organisation_id::text || '/%'
  );

COMMENT ON COLUMN vendor_invoices.purchase_order_id IS
  'The purchase order this invoice bills for, where there is one. Optional: a vendor bills for plenty this organisation never raised an order against. Required in the other direction — a purchase order does not close until at least one live invoice points at it carrying its document.';
COMMENT ON COLUMN vendor_invoices.object_key IS
  'The stored PDF of the vendor''s tax invoice, under a tenant-prefixed key. NULL until it is uploaded, and the whole document group is written once and then frozen.';

-- The composite FK's own index, unfiltered, for the reason
-- vendor_invoices_work_idx gives: an unindexed foreign key turns every
-- parent delete into a scan.
CREATE INDEX vendor_invoices_purchase_order_idx
  ON vendor_invoices (organisation_id, purchase_order_id, invoice_date DESC, id);

-- One object, one row. The same global unique index
-- company_document_versions carries, so a key can never be claimed twice.
CREATE UNIQUE INDEX vendor_invoices_object_key
  ON vendor_invoices (object_key)
  WHERE object_key IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════
-- § 8. THE TWO RULES, AT THE DATABASE
-- ═════════════════════════════════════════════════════════════════════
--
-- Layer two of two. The routes refuse first, with a sentence and a
-- remedy; these hold when a writer reaches the tables another way and
-- when the route's read and its write are separated by a concurrent
-- transaction.

-- Evidence, once written, is fixed. Without this the close gate is a gate
-- on a value that can be moved after the fact: attach an invoice, close
-- the order, re-point the invoice, and a closed order stands with no
-- evidence behind it — and `guard_purchase_order_update` (0045) makes
-- `closed_at` immutable, so nothing would ever notice. Cancelling the
-- invoice stays available and stays visible, which is the honest way to
-- withdraw it.
--
-- THREE WAYS TO REMOVE THE EVIDENCE, AND ALL THREE ARE HERE. Re-pointing
-- the link and overwriting the document are the two obvious ones. The
-- third is DELETING the invoice outright, which no route in this
-- application does — and which is exactly the writer this layer exists
-- for, since a guard that only covers the paths the routes already take
-- covers nothing. A row that is a CLOSED order's only remaining evidence
-- cannot be deleted; an invoice against an order that is still open, or
-- one of several, deletes freely.
--
-- The frozen group is all SEVEN document columns plus the link, matching
-- `vendor_invoices_document_shape_check` exactly. Leaving the uploader
-- out would let the attribution on a closed order's evidence be
-- rewritten afterwards, which is a smaller lie than swapping the file
-- and the same kind of lie.
CREATE FUNCTION app_private.guard_vendor_invoice_evidence_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.purchase_order_id IS NOT NULL
       AND OLD.cancelled_at IS NULL
       AND OLD.object_key IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM purchase_orders po
         WHERE po.organisation_id = OLD.organisation_id
           AND po.id = OLD.purchase_order_id
           AND po.status = 'closed'
       )
       AND NOT EXISTS (
         SELECT 1 FROM vendor_invoices other
         WHERE other.organisation_id = OLD.organisation_id
           AND other.purchase_order_id = OLD.purchase_order_id
           AND other.id <> OLD.id
           AND other.cancelled_at IS NULL
           AND other.object_key IS NOT NULL
       ) THEN
      RAISE EXCEPTION
        'vendor invoice % is the only evidence closing purchase order %',
        OLD.id, OLD.purchase_order_id
        USING ERRCODE = '23U02';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.purchase_order_id IS NOT NULL
     AND NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id THEN
    RAISE EXCEPTION
      'vendor invoice % is already billed against purchase order %',
      OLD.id, OLD.purchase_order_id
      USING ERRCODE = '23U02';
  END IF;

  IF OLD.object_key IS NOT NULL
     AND ROW(
       NEW.object_key, NEW.original_filename, NEW.document_sha256,
       NEW.document_media_type, NEW.document_size_bytes,
       NEW.document_uploaded_at, NEW.document_uploaded_by_user_id
     ) IS DISTINCT FROM ROW(
       OLD.object_key, OLD.original_filename, OLD.document_sha256,
       OLD.document_media_type, OLD.document_size_bytes,
       OLD.document_uploaded_at, OLD.document_uploaded_by_user_id
     ) THEN
    RAISE EXCEPTION
      'vendor invoice % already carries its uploaded document', OLD.id
      USING ERRCODE = '23U02';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER vendor_invoices_evidence_guard
BEFORE UPDATE OR DELETE ON vendor_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_vendor_invoice_evidence_update();

-- The ruling itself. Fired on the transition INTO closed only, so a
-- closed order re-read or reopened by released receipt evidence (0045
-- allows closed -> issued) is not re-judged against a rule it already
-- satisfied once.
--
-- A cancelled invoice does not count: it is a bill this organisation has
-- said it does not owe, and an order closed on the strength of a bill
-- nobody owes is closed on nothing.
CREATE FUNCTION app_private.guard_purchase_order_close_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    IF NOT EXISTS (
      SELECT 1 FROM vendor_invoices vi
      WHERE vi.organisation_id = NEW.organisation_id
        AND vi.purchase_order_id = NEW.id
        AND vi.cancelled_at IS NULL
        AND vi.object_key IS NOT NULL
    ) THEN
      RAISE EXCEPTION
        'purchase order % has no live vendor tax invoice carrying its uploaded document',
        NEW.id
        USING ERRCODE = '23U01';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_purchase_order_close_evidence() IS
  'The owner ruling of 2026-08-19: closing any purchase order requires at least one live vendor tax invoice linked to it and carrying its uploaded document. Independent of the receipt balance, which the route checks separately and names separately.';

-- Fires before `purchase_orders_update_guard` (0045), which triggers on
-- the same event: PostgreSQL runs BEFORE triggers in name order and
-- 'purchase_orders_close_evidence' sorts ahead of
-- 'purchase_orders_update_guard'. Either order is correct — both refuse
-- the same write — and the order is recorded so a later reader does not
-- have to rediscover it.
CREATE TRIGGER purchase_orders_close_evidence
BEFORE UPDATE ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_purchase_order_close_evidence();
