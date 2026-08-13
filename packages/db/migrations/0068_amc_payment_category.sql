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
--   4. The certification ceiling as a trigger, so R18 is enforced in two
--      layers like every other quantity rule rather than in the route
--      alone.
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
-- The category is read from `work_items` without a row lock, and that is
-- deliberately NOT the whole guarantee. A BEFORE-ROW trigger sees only
-- committed rows, so on its own it cannot stop a write skew: a Delivery
-- Challan draft save that reads an item while it is still SUPPLY, and a
-- category change to AMC that cannot see the uncommitted line, can
-- interleave and both commit. The trigger also fires on the LINE, and
-- issuing a challan updates `delivery_challans.status` rather than the
-- line, so it never gets a second look at issue time.
--
-- The race is closed in the application, where the locks live:
-- `routes/challans.ts` locks the referenced `work_items` rows FOR UPDATE
-- before it writes lines and re-checks the category at the issue
-- transition under the same locks, `routes/installations.ts` already
-- holds the item lock, and `PATCH /api/work-items/:id/payment-category`
-- now takes the works lock and then the item lock — the same
-- works -> work_items order — so a category change and a line write
-- serialise instead of interleaving. What this trigger adds is the
-- floor: no writer, and no raw SQL, can put movement against an AMC item
-- that was already AMC when the row was written.
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

-- ---------------------------------------------------------------------
-- 4. The certification ceiling, in the database.
--
-- R18 caps certification per item, and until now it was enforced in
-- exactly one layer: `routes/pac.ts`. That is the shape the reconciled
-- review's recurring finding 2 names — "security is enforced twice;
-- money once" — and this migration's own rationale above leans on the
-- second layer, so the ceiling gets one too. The certified quantity is
-- money: it is what the Measurement Book's certification stage bills.
--
-- The rule is the route's rule, verbatim: an AMC item caps at its
-- SANCTIONED quantity (nothing is ever installed against it), every
-- other item at its INSTALLED total. `0046` already holds exactly this
-- shape for the installation and delivery ceilings, and this function
-- follows it line for line, including the `FOR UPDATE` on the item —
-- which is what makes two concurrent certifications serialise rather
-- than jointly breaching a ceiling each of them read as satisfied.
--
-- INSERT only. A certificate's lines are immutable once recorded
-- (0022's `guard_pac_certificate_item_mutation` refuses UPDATE and
-- DELETE outright), so an UPDATE arm would be dead code guarding a
-- statement another trigger has already refused.
-- ---------------------------------------------------------------------

CREATE FUNCTION app_private.guard_pac_certified_ceiling()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_category text;
  v_ceiling numeric(18,3);
  v_already numeric(18,3);
  v_item_number text;
BEGIN
  SELECT item.payment_category, item.item_number,
         CASE WHEN item.payment_category = 'AMC'
           THEN COALESCE(item.effective_quantity, item.awarded_quantity)
           ELSE COALESCE((
             SELECT sum(i.quantity) FROM installations i
             WHERE i.organisation_id = NEW.organisation_id
               AND i.work_item_id = NEW.work_item_id
               AND i.status = 'recorded'
           ), 0)
         END
    INTO v_category, v_item_number, v_ceiling
  FROM work_items item
  WHERE item.organisation_id = NEW.organisation_id
    AND item.id = NEW.work_item_id
  FOR UPDATE;

  IF v_item_number IS NULL THEN
    RAISE EXCEPTION
      'PAC certificate line names work item %, which this transaction cannot read',
      NEW.work_item_id
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(other.certified_quantity), 0) INTO v_already
  FROM pac_certificate_items other
  JOIN pac_certificates pc ON pc.id = other.pac_certificate_id
  WHERE other.organisation_id = NEW.organisation_id
    AND other.work_item_id = NEW.work_item_id
    AND pc.status = 'recorded'
    AND other.id <> NEW.id;

  IF v_already + NEW.certified_quantity > v_ceiling THEN
    RAISE EXCEPTION
      'certification ceiling: cumulative certification for % would reach % against the % quantity %',
      v_item_number, v_already + NEW.certified_quantity,
      CASE WHEN v_category = 'AMC' THEN 'sanctioned' ELSE 'installed' END,
      v_ceiling
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- Fires alongside pac_certificate_items_guard_mutation (0022), which
-- decides whether the line may be written at all.
CREATE TRIGGER pac_certificate_items_certified_ceiling_guard
BEFORE INSERT ON pac_certificate_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_pac_certified_ceiling();
