-- Migration 0035: the GST tax invoice, and the e-way bill that moves it.
--
-- The invoice model, settled with the product owner: a works contract is
-- a supply of services under GST, so the tax invoice is CUMULATIVE — one
-- service line at a SAC for the finalized Measurement Book's total. It is
-- never a per-item HSN document; per-item HSN stays optional metadata on
-- the Work's items (0033).
--
-- GSP-readiness, not GSP-coupling: this schema stores what the NIC IRP
-- e-invoice payload (INV-01, schema 1.1) and the NIC e-way bill payload
-- need, and what their responses return (IRN, ack, signed QR; EWB number
-- and validity). The payloads themselves are built by the server from
-- these rows; the GSP that carries them (Taxilla, most likely) lives
-- behind an adapter and never shapes this table.
--
-- Lifecycle agreed: draft -> submitted (numbered, snapshotted, amounts
-- frozen) -> cancelled. Submitting the invoice is what CLOSES the MB it
-- bills — an MB with a live tax invoice can no longer be cancelled.
-- Numbering is gapless per organisation PER FINANCIAL YEAR, because GST
-- rule 46 wants a consecutive serial unique within the FY.

-- ---------------------------------------------------------------------
-- 1. Tax invoices.

CREATE TABLE tax_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,
  measurement_book_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'cancelled')),
  invoice_number text,
  sequence_number integer,
  -- '2026-27': April-to-March, derived from invoice_date by the server
  -- and stored so the counter scope and the number agree forever.
  fy_label text CHECK (fy_label IS NULL OR fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  invoice_date date NOT NULL,
  -- The cumulative service line. SAC is six digits (services have no
  -- 8-digit deepening); 9954xx is the works-contract family but the
  -- schema does not hard-code that judgement.
  sac_code text NOT NULL CHECK (sac_code ~ '^[0-9]{6}$'),
  service_description text NOT NULL
    CHECK (length(btrim(service_description)) BETWEEN 3 AND 1000),
  gst_rate numeric(5, 2) NOT NULL CHECK (gst_rate >= 0 AND gst_rate <= 100),
  -- Two-digit state code of the place of supply. Against the
  -- organisation's own state it decides CGST+SGST (intra) vs IGST
  -- (inter); the amounts below are frozen at submit so the decision is
  -- part of the record, not a recomputation.
  place_of_supply text NOT NULL CHECK (place_of_supply ~ '^[0-9]{2}$'),
  -- The buyer as invoiced: name, GSTIN (null for an unregistered buyer —
  -- URP on the wire), address, state code, pincode. Written at submit.
  buyer_snapshot jsonb,
  taxable_value numeric(18, 2) CHECK (taxable_value IS NULL OR taxable_value >= 0),
  cgst_amount numeric(18, 2) CHECK (cgst_amount IS NULL OR cgst_amount >= 0),
  sgst_amount numeric(18, 2) CHECK (sgst_amount IS NULL OR sgst_amount >= 0),
  igst_amount numeric(18, 2) CHECK (igst_amount IS NULL OR igst_amount >= 0),
  total_amount numeric(18, 2) CHECK (total_amount IS NULL OR total_amount >= 0),
  -- What the IRP hands back through the GSP. Never computed here.
  irn text CHECK (irn IS NULL OR irn ~ '^[0-9a-f]{64}$'),
  ack_number text,
  ack_date timestamptz,
  signed_qr text,
  submitted_at timestamptz,
  submitted_by_user_id text,
  cancelled_at timestamptz,
  cancelled_by_user_id text,
  cancellation_note text,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, invoice_number),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works (organisation_id, id),
  FOREIGN KEY (organisation_id, measurement_book_id)
    REFERENCES measurement_books (organisation_id, id),
  -- Draft: unnumbered, amounts open. Submitted or later: everything
  -- frozen — number, FY, buyer, money, actor, time.
  CONSTRAINT tax_invoices_draft_shape CHECK (
    (status = 'draft'
      AND invoice_number IS NULL AND sequence_number IS NULL
      AND fy_label IS NULL AND buyer_snapshot IS NULL
      AND taxable_value IS NULL AND cgst_amount IS NULL
      AND sgst_amount IS NULL AND igst_amount IS NULL
      AND total_amount IS NULL
      AND submitted_at IS NULL AND submitted_by_user_id IS NULL)
    OR
    (status <> 'draft'
      AND invoice_number IS NOT NULL AND sequence_number IS NOT NULL
      AND fy_label IS NOT NULL AND buyer_snapshot IS NOT NULL
      AND taxable_value IS NOT NULL AND cgst_amount IS NOT NULL
      AND sgst_amount IS NOT NULL AND igst_amount IS NOT NULL
      AND total_amount IS NOT NULL
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL)
  ),
  CONSTRAINT tax_invoices_cancel_shape CHECK (
    (status = 'cancelled'
      AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
      AND cancellation_note IS NOT NULL
      AND length(btrim(cancellation_note)) BETWEEN 3 AND 2000)
    OR
    (status <> 'cancelled'
      AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
      AND cancellation_note IS NULL)
  ),
  -- Intra-state carries CGST+SGST and no IGST; inter-state the reverse.
  -- NULLs (draft) pass; a submitted invoice must be one or the other.
  CONSTRAINT tax_invoices_split_coherence CHECK (
    status = 'draft'
    OR (igst_amount = 0 AND cgst_amount >= 0 AND sgst_amount >= 0)
    OR (igst_amount > 0 AND cgst_amount = 0 AND sgst_amount = 0)
  )
);

COMMENT ON TABLE tax_invoices IS
  'The GST tax invoice: one cumulative service line at a SAC for a '
  'finalized Measurement Book''s total. IRP fields arrive from the GSP.';

-- One live invoice per Measurement Book, ever; cancelling one releases
-- the MB for a corrected invoice.
CREATE UNIQUE INDEX tax_invoices_one_live_per_mb
  ON tax_invoices (organisation_id, measurement_book_id)
  WHERE status <> 'cancelled';

CREATE INDEX tax_invoices_work_idx
  ON tax_invoices (organisation_id, work_id, status, invoice_date DESC, id);

-- Gapless per (organisation, financial year).
CREATE TABLE tax_invoice_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  fy_label text NOT NULL CHECK (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (organisation_id, fy_label)
);

-- ---------------------------------------------------------------------
-- 2. E-way bills.

CREATE TABLE eway_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  tax_invoice_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'generated', 'cancelled')),
  transport_mode text NOT NULL DEFAULT 'road'
    CHECK (transport_mode IN ('road', 'rail', 'air', 'ship')),
  -- The GSTIN-shaped transporter enrolment id. Optional: the supplier's
  -- own vehicle needs none.
  transporter_id text CHECK (
    transporter_id IS NULL OR transporter_id ~ '^[0-9]{2}[0-9A-Z]{13}$'
  ),
  transporter_name text CHECK (
    transporter_name IS NULL
    OR length(btrim(transporter_name)) BETWEEN 2 AND 200
  ),
  vehicle_number text CHECK (
    vehicle_number IS NULL OR vehicle_number ~ '^[A-Z0-9]{6,12}$'
  ),
  -- Rail/air/ship move on a transport document, road on a vehicle.
  transport_doc_number text CHECK (
    transport_doc_number IS NULL
    OR length(btrim(transport_doc_number)) BETWEEN 1 AND 30
  ),
  transport_doc_date date,
  distance_km integer NOT NULL CHECK (distance_km >= 0 AND distance_km <= 4000),
  from_pincode text NOT NULL CHECK (from_pincode ~ '^[0-9]{6}$'),
  to_pincode text NOT NULL CHECK (to_pincode ~ '^[0-9]{6}$'),
  -- What NIC hands back through the GSP.
  ewb_number text CHECK (ewb_number IS NULL OR ewb_number ~ '^[0-9]{12}$'),
  ewb_date timestamptz,
  valid_until timestamptz,
  generated_at timestamptz,
  generated_by_user_id text,
  cancelled_at timestamptz,
  cancelled_by_user_id text,
  cancellation_note text,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, tax_invoice_id)
    REFERENCES tax_invoices (organisation_id, id),
  CONSTRAINT eway_bills_generated_shape CHECK (
    (status = 'generated'
      AND ewb_number IS NOT NULL AND ewb_date IS NOT NULL
      AND generated_at IS NOT NULL AND generated_by_user_id IS NOT NULL)
    OR
    (status <> 'generated'
      AND ewb_number IS NULL AND ewb_date IS NULL AND valid_until IS NULL
      AND generated_at IS NULL AND generated_by_user_id IS NULL)
  ),
  CONSTRAINT eway_bills_cancel_shape CHECK (
    (status = 'cancelled'
      AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
      AND cancellation_note IS NOT NULL
      AND length(btrim(cancellation_note)) BETWEEN 3 AND 2000)
    OR
    (status <> 'cancelled'
      AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
      AND cancellation_note IS NULL)
  ),
  -- A road movement names a vehicle; the other modes name a document.
  CONSTRAINT eway_bills_carriage_shape CHECK (
    status = 'draft'
    OR (transport_mode = 'road' AND vehicle_number IS NOT NULL)
    OR (transport_mode <> 'road'
        AND transport_doc_number IS NOT NULL
        AND transport_doc_date IS NOT NULL)
  )
);

COMMENT ON TABLE eway_bills IS
  'The movement document for a tax invoice. Drafted here, generated by NIC '
  'through the GSP; the 12-digit EWB number and validity come back, never '
  'made up locally.';

CREATE UNIQUE INDEX eway_bills_one_live_per_invoice
  ON eway_bills (organisation_id, tax_invoice_id)
  WHERE status <> 'cancelled';

-- ---------------------------------------------------------------------
-- 3. Cross-record guards, at the database because the route is not the
-- only writer the future holds.

-- An invoice may only be raised against a finalized, non-record MB.
CREATE OR REPLACE FUNCTION app_private.guard_tax_invoice_mb()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_kind text;
  v_work uuid;
BEGIN
  SELECT status, kind, work_id INTO v_status, v_kind, v_work
    FROM measurement_books WHERE id = NEW.measurement_book_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'measurement book % is missing', NEW.measurement_book_id;
  END IF;
  IF v_kind = 'record' THEN
    RAISE EXCEPTION
      'measurement book % is a record MB — merge it into an on-account MB before invoicing',
      NEW.measurement_book_id;
  END IF;
  IF v_status <> 'finalized' THEN
    RAISE EXCEPTION
      'measurement book % is % — only a finalized MB can be invoiced',
      NEW.measurement_book_id, v_status;
  END IF;
  IF v_work IS DISTINCT FROM NEW.work_id THEN
    RAISE EXCEPTION 'measurement book % belongs to another work',
      NEW.measurement_book_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tax_invoices_mb_guard
BEFORE INSERT ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_mb();

-- Submitting the invoice closes its MB: a Measurement Book with a live
-- tax invoice can no longer be cancelled. (The same rule bills already
-- impose through the route; this is the schema saying it too.)
CREATE OR REPLACE FUNCTION app_private.guard_mb_cancel_with_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status = 'finalized' THEN
    IF EXISTS (
      SELECT 1 FROM tax_invoices
       WHERE measurement_book_id = OLD.id AND status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION
        'measurement book % is closed by a tax invoice — cancel the invoice first',
        OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER measurement_books_invoice_close_guard
BEFORE UPDATE OF status ON measurement_books
FOR EACH ROW EXECUTE FUNCTION app_private.guard_mb_cancel_with_invoice();

-- An e-way bill moves a SUBMITTED invoice: a draft has no legal number to
-- move, and a cancelled one moves nothing.
CREATE OR REPLACE FUNCTION app_private.guard_eway_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM tax_invoices WHERE id = NEW.tax_invoice_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'tax invoice % is missing', NEW.tax_invoice_id;
  END IF;
  IF v_status <> 'submitted' THEN
    RAISE EXCEPTION
      'tax invoice % is % — an e-way bill needs a submitted invoice',
      NEW.tax_invoice_id, v_status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER eway_bills_invoice_guard
BEFORE INSERT ON eway_bills
FOR EACH ROW EXECUTE FUNCTION app_private.guard_eway_invoice();

-- ---------------------------------------------------------------------
-- 4. updated_at upkeep.

CREATE TRIGGER tax_invoices_touch_updated_at
BEFORE UPDATE ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TRIGGER eway_bills_touch_updated_at
BEFORE UPDATE ON eway_bills
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 5. RLS.

ALTER TABLE tax_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE tax_invoice_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_invoice_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE eway_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE eway_bills FORCE ROW LEVEL SECURITY;

CREATE POLICY tax_invoices_tenant_policy ON tax_invoices
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY tax_invoice_counters_tenant_policy ON tax_invoice_counters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY eway_bills_tenant_policy ON eway_bills
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- ---------------------------------------------------------------------
-- 6. Grants. A draft invoice or e-way bill may be discarded; anything
-- submitted or generated cancels instead. Counters never delete.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tax_invoices TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE ON tax_invoice_counters TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON eway_bills TO auto_mb_app;
  END IF;
END
$$;
