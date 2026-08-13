-- Migration 0068: AMC as the fifth item payment category, and the
-- database backstop that keeps an AMC item off the movement ledger.
--
-- THE DEFECT THIS CLOSES. A railway LOA routinely carries an annual
-- maintenance schedule beside its supply and installation schedules: the
-- flagship corpus letter PL270-CRB carries two of them (Schedule B, "AMC
-- for SCH A items for the period of 5 year", 5 Year at 3,623,698.84, and
-- Schedule D, the same shape at 1,877,965.44), together 27,508,321.40 of
-- a 169,228,497.35 net bid value — about 16% of the contract. Their unit
-- is `Year`. Nothing is ever delivered against them and nothing is ever
-- installed against them; a year of maintenance is SERVED, and the
-- railway certifies that it was.
--
-- The R8 completion predicate had four categories and no fifth. Every
-- one of them resolves to a delivery requirement, an installation
-- requirement, or both, and an uncategorised item falls back to reading
-- its own description. So an AMC item resolved to "must be fully
-- delivered", and its 5 Year could only be delivered by issuing a
-- Delivery Challan claiming that five years of maintenance moved on a
-- lorry. The predicate was therefore unsatisfiable without a fabricated
-- document, and a Work carrying an AMC schedule could never be completed
-- honestly. `docs/IMPROVEMENT-PROGRAMME-2026-08-13.md` §1.3 row 30
-- records the measurement.
--
-- THE SHAPE OF THE FIX. AMC is a fifth payment category rather than a
-- per-item completion override, because the category is ALREADY the
-- product's single answer to "how is this item executed and paid": it
-- selects the completion requirement, the final-bill stage base, and the
-- per-Work payment-matrix row. A per-item basis column would be a second
-- classification axis that can contradict the first — an item marked
-- SUPPLY with a service basis is a state with no meaning — and it would
-- answer only the completion half of the question while leaving billing
-- to fall back on the same fabricated challan.
--
-- An AMC item is discharged by CERTIFICATION: the acceptance-certificate
-- record already in the schema (0022 `pac_certificates`) certifies a
-- quantity per item, in parts, over time, with the certificate document
-- attached, cancellable with a note, and billable through the payment
-- matrix's certification stage. That is exactly the shape of an annual
-- maintenance certificate, so AMC reuses it instead of duplicating the
-- table, its RLS, its four guards and its Measurement Book source type.
-- What changes for an AMC item is only the CAP: R18 caps certification
-- at the installed quantity, which is structurally zero for an item that
-- is never installed, so an AMC item caps at its sanctioned quantity
-- instead — the same ceiling R5 already applies to installation. That
-- rule lives in `apps/server/src/routes/pac.ts`; this migration carries
-- the vocabulary and the two structural guards below.
--
-- Contents:
--   1. 'AMC' joins the work_items payment-category CHECK.
--   2. 'AMC' joins the payment_matrices category CHECK, with the extra
--      CHECK that an AMC matrix row bills nothing on the supply or
--      installation stages.
--   3. The movement backstop: no Delivery Challan line and no
--      installation may name an AMC item.
--
-- No existing row can be affected. `payment_category` has only ever held
-- the four 0021 values or NULL, and `payment_matrices.category` only
-- those four plus UNCATEGORISED, so both CHECK replacements are pure
-- widenings and both new triggers are vacuous until an item is
-- categorised AMC for the first time.

SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- 1. The fifth item category.
-- ---------------------------------------------------------------------

ALTER TABLE work_items
  DROP CONSTRAINT work_items_payment_category_check;

ALTER TABLE work_items
  ADD CONSTRAINT work_items_payment_category_check
  CHECK (
    payment_category IS NULL
    OR payment_category IN (
      'SUPPLY', 'SUPPLY_AND_INSTALLATION', 'PURE_INSTALLATION',
      'SPARE_SUPPLY', 'AMC'
    )
  );

-- ---------------------------------------------------------------------
-- 2. The fifth matrix row, and what it may bill.
--
-- The four stage percentages still sum to exactly 100 (the 0021 CHECK is
-- untouched), but for an AMC row two of the four stages can never carry
-- a quantity: `delta_supplied` comes from issued Delivery Challans and
-- `delta_installed` from recorded installations, and section 3 below
-- makes both structurally impossible for an AMC item. A matrix row that
-- parks contract value on a stage whose quantity is always zero is the
-- fabricated-challan problem restated as configuration — the value
-- becomes unbillable, and the operator's only route to it is to create
-- the movement record the value is waiting for. So an AMC row must place
-- its 100 on the certification stage, the final-bill stage, or a split
-- of the two.
-- ---------------------------------------------------------------------

ALTER TABLE payment_matrices
  DROP CONSTRAINT payment_matrices_category_check;

ALTER TABLE payment_matrices
  ADD CONSTRAINT payment_matrices_category_check
  CHECK (
    category IN (
      'SUPPLY', 'SUPPLY_AND_INSTALLATION', 'PURE_INSTALLATION',
      'SPARE_SUPPLY', 'AMC', 'UNCATEGORISED'
    )
  );

ALTER TABLE payment_matrices
  ADD CONSTRAINT payment_matrices_amc_bills_on_certification
  CHECK (
    category <> 'AMC'
    OR (pct_supply = 0 AND pct_installation = 0)
  );

COMMENT ON CONSTRAINT payment_matrices_amc_bills_on_certification
  ON payment_matrices IS
  'An AMC item is never delivered and never installed (0068 section 3), '
  'so its supply and installation stage deltas are permanently zero. '
  'Value placed on either stage could never be billed.';

-- ---------------------------------------------------------------------
-- 3. The movement backstop.
--
-- The completion requirement, the certification cap and the matrix CHECK
-- above all rest on one structural fact: an AMC item takes no delivery
-- and no installation. Stated once in a route, that fact is a convention
-- a future writer can miss; the reconciled review's recurring finding 2
-- ("security is enforced twice; money once") is precisely about
-- quantity rules that live in exactly one layer. So it is stated here as
-- well, and raw SQL is refused too.
--
-- Both guards are separate triggers rather than clauses added to the
-- existing guard functions, so no existing function body has to be
-- restated: a restatement is how a supersession clause gets silently
-- dropped, and 0024/0027/0031/0032 have already layered four of them
-- onto these tables.
--
-- The category is read from `work_items` without a row lock. A lock
-- would buy nothing: `PATCH /api/work-items/:id/payment-category`
-- refuses to move an item INTO the AMC category while any delivery or
-- installation names it, so the two writers cannot cross in a direction
-- that leaves an AMC item holding movement — and the reverse direction
-- (out of AMC) can only make this guard more permissive.
-- ---------------------------------------------------------------------

CREATE FUNCTION app_private.guard_delivery_challan_item_not_amc()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_category text;
  v_item_number text;
BEGIN
  IF NEW.work_item_id IS NULL THEN
    -- A manual (non-LOA) line names no item and is inert to the ledger.
    RETURN NEW;
  END IF;

  SELECT item.payment_category, item.item_number
    INTO v_category, v_item_number
  FROM work_items item
  WHERE item.organisation_id = NEW.organisation_id
    AND item.id = NEW.work_item_id;

  IF v_category = 'AMC' THEN
    RAISE EXCEPTION
      'work item % is an AMC item: annual maintenance is certified, not delivered, so it takes no Delivery Challan line',
      v_item_number
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- Fires alongside delivery_challan_items_guard_mutation (0001) and
-- delivery_challan_items_guard_kind (0056).
CREATE TRIGGER delivery_challan_items_guard_not_amc
BEFORE INSERT OR UPDATE ON delivery_challan_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_delivery_challan_item_not_amc();

CREATE FUNCTION app_private.guard_installation_not_amc()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_category text;
  v_item_number text;
BEGIN
  SELECT item.payment_category, item.item_number
    INTO v_category, v_item_number
  FROM work_items item
  WHERE item.organisation_id = NEW.organisation_id
    AND item.id = NEW.work_item_id;

  IF v_category = 'AMC' THEN
    RAISE EXCEPTION
      'work item % is an AMC item: annual maintenance is certified, not installed, so it takes no installation record',
      v_item_number
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- Fires alongside installations_guard_insert (0027/0031),
-- installations_guard_update (0017) and
-- installations_quantity_ceiling_guard (0046).
CREATE TRIGGER installations_guard_not_amc
BEFORE INSERT OR UPDATE ON installations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_installation_not_amc();
