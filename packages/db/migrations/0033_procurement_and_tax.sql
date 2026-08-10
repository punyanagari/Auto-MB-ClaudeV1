-- Migration 0033: the procurement wave, and the tax facts every outward
-- document needs.
--
-- Three things arrive together because none of them is useful alone:
--
-- 1. TAX FACTS. A GST tax invoice cannot be built from what the schema
--    held: an item had a description, a unit and a rate, but no HSN/SAC
--    code and no tax rate, and the organisation knew its GSTIN but not
--    the state that GSTIN belongs to. Both the IRP e-invoice payload and
--    the NIC e-way bill payload demand all four per line, so they are
--    recorded on the item and on the organisation.
--
-- 2. PURCHASE ORDERS. What a contractor buys in, to supply what the Work
--    awarded. A PO is placed on a vendor contact, carries lines against
--    the Work's items, and closes when delivery challans have received
--    everything it ordered. `contacts.is_vendor` has been sitting dormant
--    since 0028 waiting for exactly this.
--
-- 3. BUDGETARY QUOTATIONS. Priced offers made outward — to a private
--    customer, or to a railway officer building a tender's item list.
--    Deliberately NOT tied to a Work: a BQ usually precedes any award,
--    and forcing a Work on it would invent one that does not exist.
--
-- Numbering follows the delivery-challan posture throughout: a per-scope
-- counter row taken under lock, gapless, assigned at issue and never
-- reused. Money is numeric, quantities are numeric(18,3), dates are date.

-- ---------------------------------------------------------------------
-- 1. Tax facts.

-- The supplier's own state, as the two-digit GST state code. It is the
-- first two characters of a registered GSTIN, but it is stored rather
-- than derived: an unregistered organisation still has a place of
-- business, and the invoice still has to name a state.
ALTER TABLE organisations
  ADD COLUMN state_code text
    CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$');

COMMENT ON COLUMN organisations.state_code IS
  'Two-digit GST state code of the place of business. Determines whether a '
  'supply is intra-state (CGST+SGST) or inter-state (IGST) against the '
  'invoice place of supply.';

-- Per item, because the rate follows the goods and a Work mixes them: a
-- switchboard and its installation service do not share an HSN or a rate.
ALTER TABLE work_items
  ADD COLUMN hsn_code text
    CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'),
  ADD COLUMN gst_rate numeric(5, 2)
    CHECK (gst_rate IS NULL OR (gst_rate >= 0 AND gst_rate <= 100)),
  -- Drives IsServc on the e-invoice line, and the choice between an HSN
  -- and an SAC reading of the code above.
  ADD COLUMN is_service boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN work_items.hsn_code IS
  'HSN (goods) or SAC (services) code, 4 to 8 digits. Mandatory on every '
  'e-invoice line, so an item without one cannot be invoiced.';
COMMENT ON COLUMN work_items.gst_rate IS
  'Total GST percentage for the item. Split into CGST+SGST or carried as '
  'IGST at invoice time, from the supplier state against the place of supply.';

-- ---------------------------------------------------------------------
-- 2. Purchase orders.

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,
  -- The vendor is a contact carrying is_vendor. Snapshotted onto the
  -- issued document below, so retiring the contact never rewrites history.
  vendor_contact_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'closed', 'cancelled')),
  po_number text,
  sequence_number integer,
  po_date date NOT NULL,
  -- When the vendor promised delivery. Advisory: nothing refuses a late
  -- receipt, the date is there so an operator can chase it.
  expected_on date,
  terms text CHECK (terms IS NULL OR length(btrim(terms)) BETWEEN 3 AND 4000),
  vendor_snapshot jsonb,
  total_amount numeric(18, 2) CHECK (total_amount IS NULL OR total_amount >= 0),
  issued_at timestamptz,
  issued_by_user_id text,
  closed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by_user_id text,
  cancellation_note text,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, po_number),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works (organisation_id, id),
  FOREIGN KEY (organisation_id, vendor_contact_id)
    REFERENCES contacts (organisation_id, id),
  -- A draft carries no number and no snapshot; anything issued carries
  -- both, for good. Same shape rule the challan and MB tables hold.
  CONSTRAINT purchase_orders_draft_shape CHECK (
    (status = 'draft'
      AND po_number IS NULL AND sequence_number IS NULL
      AND vendor_snapshot IS NULL AND total_amount IS NULL
      AND issued_at IS NULL AND issued_by_user_id IS NULL)
    OR
    (status <> 'draft'
      AND po_number IS NOT NULL AND sequence_number IS NOT NULL
      AND vendor_snapshot IS NOT NULL AND total_amount IS NOT NULL
      AND issued_at IS NOT NULL AND issued_by_user_id IS NOT NULL)
  ),
  CONSTRAINT purchase_orders_cancel_shape CHECK (
    (status = 'cancelled'
      AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
      AND cancellation_note IS NOT NULL
      AND length(btrim(cancellation_note)) BETWEEN 3 AND 2000)
    OR
    (status <> 'cancelled'
      AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
      AND cancellation_note IS NULL)
  ),
  CONSTRAINT purchase_orders_closed_shape CHECK (
    (status = 'closed' AND closed_at IS NOT NULL)
    OR (status <> 'closed' AND closed_at IS NULL)
  )
);

COMMENT ON TABLE purchase_orders IS
  'What the contractor buys in to supply a Work. Closes when its lines have '
  'been fully received against delivery challans.';

-- At most one open draft per Work, exactly like the delivery challan: two
-- half-written orders to the same vendor is a data-entry accident, not a
-- workflow.
CREATE UNIQUE INDEX purchase_orders_one_draft_per_work
  ON purchase_orders (organisation_id, work_id)
  WHERE status = 'draft';

CREATE INDEX purchase_orders_work_idx
  ON purchase_orders (organisation_id, work_id, status, po_date DESC, id);

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  purchase_order_id uuid NOT NULL,
  -- A PO line usually buys an awarded item, but a contractor also buys
  -- consumables that never appear on the LOA, so the link is optional and
  -- the description always stands on its own.
  work_item_id uuid,
  line_number integer NOT NULL CHECK (line_number > 0),
  description text NOT NULL CHECK (length(btrim(description)) >= 3),
  hsn_code text CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'),
  unit_code text NOT NULL CHECK (length(btrim(unit_code)) BETWEEN 1 AND 20),
  quantity numeric(18, 3) NOT NULL CHECK (quantity > 0),
  rate numeric(18, 6) NOT NULL CHECK (rate >= 0),
  gst_rate numeric(5, 2) CHECK (gst_rate IS NULL OR (gst_rate >= 0 AND gst_rate <= 100)),
  line_amount numeric(18, 2) NOT NULL CHECK (line_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (purchase_order_id, line_number),
  FOREIGN KEY (organisation_id, purchase_order_id)
    REFERENCES purchase_orders (organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, work_item_id)
    REFERENCES work_items (organisation_id, id)
);

CREATE INDEX purchase_order_lines_po_idx
  ON purchase_order_lines (organisation_id, purchase_order_id, line_number);
CREATE INDEX purchase_order_lines_item_idx
  ON purchase_order_lines (organisation_id, work_item_id)
  WHERE work_item_id IS NOT NULL;

-- The receipt link: a delivery challan line may name the PO line it
-- fulfils. Nullable because plenty of material arrives without a PO — a
-- free issue from the railway, or stock the contractor already held.
ALTER TABLE delivery_challan_items
  ADD COLUMN purchase_order_line_id uuid,
  ADD CONSTRAINT delivery_challan_items_po_line_fk
    FOREIGN KEY (organisation_id, purchase_order_line_id)
      REFERENCES purchase_order_lines (organisation_id, id);

CREATE INDEX delivery_challan_items_po_line_idx
  ON delivery_challan_items (organisation_id, purchase_order_line_id)
  WHERE purchase_order_line_id IS NOT NULL;

CREATE TABLE purchase_order_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (organisation_id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works (organisation_id, id)
);

-- ---------------------------------------------------------------------
-- 3. Budgetary quotations.

CREATE TABLE budgetary_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  -- No work_id on purpose: a budgetary quotation is normally what happens
  -- BEFORE there is a Work at all — a price offered to a private customer,
  -- or to a railway officer assembling a tender's schedule.
  customer_contact_id uuid,
  -- So a quotation can be addressed to someone who is not yet a contact.
  addressed_to text NOT NULL CHECK (length(btrim(addressed_to)) BETWEEN 2 AND 200),
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 3 AND 500),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'expired', 'converted', 'withdrawn')),
  bq_number text,
  sequence_number integer,
  bq_date date NOT NULL,
  valid_until date,
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 3 AND 4000),
  customer_snapshot jsonb,
  total_amount numeric(18, 2) CHECK (total_amount IS NULL OR total_amount >= 0),
  issued_at timestamptz,
  issued_by_user_id text,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, bq_number),
  FOREIGN KEY (organisation_id, customer_contact_id)
    REFERENCES contacts (organisation_id, id),
  CONSTRAINT budgetary_quotations_draft_shape CHECK (
    (status = 'draft'
      AND bq_number IS NULL AND sequence_number IS NULL
      AND total_amount IS NULL AND issued_at IS NULL AND issued_by_user_id IS NULL)
    OR
    (status <> 'draft'
      AND bq_number IS NOT NULL AND sequence_number IS NOT NULL
      AND total_amount IS NOT NULL AND issued_at IS NOT NULL
      AND issued_by_user_id IS NOT NULL)
  ),
  CONSTRAINT budgetary_quotations_validity CHECK (
    valid_until IS NULL OR valid_until >= bq_date
  )
);

COMMENT ON TABLE budgetary_quotations IS
  'A priced offer made outward, before any award: to a private customer, or '
  'to a railway officer adding items to a tender. Carries no Work.';

CREATE INDEX budgetary_quotations_org_idx
  ON budgetary_quotations (organisation_id, status, bq_date DESC, id);

CREATE TABLE budgetary_quotation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  budgetary_quotation_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number > 0),
  description text NOT NULL CHECK (length(btrim(description)) >= 3),
  hsn_code text CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'),
  unit_code text NOT NULL CHECK (length(btrim(unit_code)) BETWEEN 1 AND 20),
  quantity numeric(18, 3) NOT NULL CHECK (quantity > 0),
  rate numeric(18, 6) NOT NULL CHECK (rate >= 0),
  gst_rate numeric(5, 2) CHECK (gst_rate IS NULL OR (gst_rate >= 0 AND gst_rate <= 100)),
  line_amount numeric(18, 2) NOT NULL CHECK (line_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budgetary_quotation_id, line_number),
  FOREIGN KEY (organisation_id, budgetary_quotation_id)
    REFERENCES budgetary_quotations (organisation_id, id) ON DELETE CASCADE
);

CREATE INDEX budgetary_quotation_lines_bq_idx
  ON budgetary_quotation_lines (organisation_id, budgetary_quotation_id, line_number);

CREATE TABLE budgetary_quotation_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id) PRIMARY KEY,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0)
);

-- ---------------------------------------------------------------------
-- 4. Immutability: an issued order or quotation is a document that left
-- the building. Lines may only be written while their parent is a draft,
-- the same rule delivery challan lines have held since 0001.

CREATE OR REPLACE FUNCTION app_private.guard_purchase_order_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_po uuid;
BEGIN
  v_po := COALESCE(NEW.purchase_order_id, OLD.purchase_order_id);
  SELECT status INTO v_status FROM purchase_orders WHERE id = v_po;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'purchase order % is % — its lines are fixed once it is issued',
      v_po, COALESCE(v_status, 'missing');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER purchase_order_lines_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_purchase_order_line_mutation();

CREATE OR REPLACE FUNCTION app_private.guard_bq_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_bq uuid;
BEGIN
  v_bq := COALESCE(NEW.budgetary_quotation_id, OLD.budgetary_quotation_id);
  SELECT status INTO v_status FROM budgetary_quotations WHERE id = v_bq;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'budgetary quotation % is % — its lines are fixed once it is issued',
      v_bq, COALESCE(v_status, 'missing');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER budgetary_quotation_lines_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON budgetary_quotation_lines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_bq_line_mutation();

-- A purchase order dated before its Work's letter cannot be right: the
-- contractor cannot buy against an award that did not exist. Same guard
-- the delivery challan has carried since 0010, including the future bound
-- read in the organisation's own timezone.
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
  SELECT w.letter_date, (now() AT TIME ZONE o.timezone)::date
    INTO v_letter_date, v_today
    FROM works w
    JOIN organisations o ON o.id = w.organisation_id
   WHERE w.id = NEW.work_id;

  IF v_letter_date IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.po_date < v_letter_date THEN
    RAISE EXCEPTION 'po_date % precedes the LOA letter date %',
      NEW.po_date, v_letter_date;
  END IF;
  IF NEW.po_date > v_today THEN
    RAISE EXCEPTION 'po_date % is in the future (today is %)',
      NEW.po_date, v_today;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_orders_date_guard
BEFORE INSERT OR UPDATE OF po_date ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_purchase_order_date();

-- ---------------------------------------------------------------------
-- 5. Completed Works accept no new procurement either (R8, migration
-- 0031). The route refuses first; this is the backstop for raw SQL.

CREATE OR REPLACE FUNCTION app_private.guard_purchase_order_work_active()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM works WHERE id = NEW.work_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'work % is % — reopen it before recording a purchase order',
      NEW.work_id, COALESCE(v_status, 'missing');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_orders_work_active
BEFORE INSERT ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_purchase_order_work_active();

-- ---------------------------------------------------------------------
-- 6. updated_at upkeep.

CREATE TRIGGER purchase_orders_touch_updated_at
BEFORE UPDATE ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TRIGGER budgetary_quotations_touch_updated_at
BEFORE UPDATE ON budgetary_quotations
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 7. RLS on every new table.

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE budgetary_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgetary_quotations FORCE ROW LEVEL SECURITY;
ALTER TABLE budgetary_quotation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgetary_quotation_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE budgetary_quotation_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgetary_quotation_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY purchase_orders_tenant_policy ON purchase_orders
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY purchase_order_lines_tenant_policy ON purchase_order_lines
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY purchase_order_counters_tenant_policy ON purchase_order_counters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY budgetary_quotations_tenant_policy ON budgetary_quotations
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY budgetary_quotation_lines_tenant_policy ON budgetary_quotation_lines
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY budgetary_quotation_counters_tenant_policy ON budgetary_quotation_counters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- ---------------------------------------------------------------------
-- 8. Grants. Documents are cancelled or withdrawn, never deleted — except
-- a draft, which is not yet a document, so drafts and their lines keep
-- DELETE exactly as delivery challan drafts do.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_orders TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order_lines TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE ON purchase_order_counters TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON budgetary_quotations TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON budgetary_quotation_lines TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE ON budgetary_quotation_counters TO auto_mb_app;
  END IF;
END
$$;
