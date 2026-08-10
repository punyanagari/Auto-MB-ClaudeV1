-- Migration 0039: numbering the organisation defines, and invoices that
-- answer to no Measurement Book.
--
-- Two corrections from the product owner, both of which say the same
-- thing about a wrong assumption baked into 0035:
--
-- 1. AN INVOICE NEED NOT BILL A MEASUREMENT BOOK. 0035 made work_id and
--    measurement_book_id NOT NULL, so the only invoice the system could
--    raise was one against a railway works contract. A contractor also
--    sells to private customers, and that invoice descends from no LOA,
--    no Work and no MB. It still needs a number, a buyer, a taxable
--    value, GST and an IRN.
--
-- 2. NUMBER FORMATS BELONG TO THE ORGANISATION, NOT TO US. The owner's
--    invoice series is PXXYY000 — P, the railnet division code with its
--    trailing zero dropped, the financial year, and a three-digit
--    serial — and they were explicit that this is THEIR house rule, not
--    a rule of the trade. So the product stops hard-coding formats and
--    starts storing them: a template per document type per organisation,
--    with the current hard-coded strings as the defaults, so an
--    organisation that configures nothing keeps exactly the numbers it
--    has always had.
--
-- What is deliberately NOT generalised: the Measurement Book, purchase
-- order, extension request, correction notice and bill keep their fixed
-- formats. The owner named four documents — delivery challan, issue
-- challan, tax invoice and budgetary quotation — and a template engine
-- pointed at documents nobody asked to re-format is surface area with no
-- demand behind it.

-- ---------------------------------------------------------------------
-- 1. The division code, on the contact that has one.
--
-- Railway units are listed in the railnet STD directory with a numeric
-- code. The owner's series takes that code WITHOUT ITS TRAILING ZERO —
-- 100 becomes 10, 140 becomes 14 — which is why the code is stored as
-- the directory writes it and the dropping is done at composition time.
-- Storing the already-shortened form would lose the directory's own
-- value and make the next series rule that wants it unimplementable.

ALTER TABLE contacts
  ADD COLUMN division_code text
    CHECK (division_code IS NULL OR division_code ~ '^[0-9]{2,5}$');

COMMENT ON COLUMN contacts.division_code IS
  'Railway division code as the railnet STD directory writes it. The '
  '{DIV} numbering token drops one trailing zero from it.';

-- ---------------------------------------------------------------------
-- 2. The number series an organisation defines for itself.

CREATE TABLE document_number_series (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  document_type text NOT NULL CHECK (document_type IN (
    'delivery_challan', 'issue_challan', 'tax_invoice', 'budgetary_quotation'
  )),
  -- The template, in tokens the server understands. Anything outside a
  -- brace is a literal, so 'BQ-{SEQ:2}' is the BQ default written out.
  -- The bound is generous but finite; a template is a number format, not
  -- a document.
  template text NOT NULL CHECK (length(btrim(template)) BETWEEN 1 AND 120),
  -- Every template must consume the counter, or the series would mint
  -- the same string for every document and the unique index behind each
  -- document's number would refuse the second one with a conflict the
  -- operator cannot act on.
  CONSTRAINT document_number_series_uses_sequence
    CHECK (template LIKE '%{SEQ%'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, document_type)
);

COMMENT ON TABLE document_number_series IS
  'Per-organisation number formats. A document type with no row here '
  'uses the product default, which is exactly the format it had before '
  'this table existed.';
COMMENT ON COLUMN document_number_series.template IS
  'Tokens: {WORK} work code, {PREFIX} the document''s own prefix, {DIV} '
  'buyer division code less one trailing zero, {FY} 2026-27, {FY2} 26, '
  '{YYYY}/{YY} calendar year of the document date, {SEQ} or {SEQ:n} the '
  'zero-padded counter. Everything else is a literal.';

CREATE TRIGGER document_number_series_touch_updated_at
BEFORE UPDATE ON document_number_series
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE document_number_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_number_series FORCE ROW LEVEL SECURITY;

CREATE POLICY document_number_series_tenant_policy ON document_number_series
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON document_number_series TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 3. The invoice lets go of the Measurement Book.
--
-- Both columns become nullable together: an invoice with no MB has no
-- Work either, because the Work is the LOA's, and a private sale has no
-- LOA. What replaces the MB total is a taxable value the operator states
-- on the draft — and exactly one of the two must be present, because an
-- invoice with both would have two answers to what it is worth and one
-- with neither would have none.

ALTER TABLE tax_invoices
  ALTER COLUMN work_id DROP NOT NULL,
  ALTER COLUMN measurement_book_id DROP NOT NULL,
  ADD COLUMN stated_taxable_value numeric(18, 2)
    CHECK (stated_taxable_value IS NULL OR stated_taxable_value >= 0),
  -- A direct invoice needs to say who it is for in its own words; there
  -- is no Work title to fall back on.
  ADD CONSTRAINT tax_invoices_value_source CHECK (
    (measurement_book_id IS NOT NULL AND stated_taxable_value IS NULL)
    OR
    (measurement_book_id IS NULL AND stated_taxable_value IS NOT NULL)
  ),
  -- The Work and the Measurement Book travel together. An invoice
  -- against a Work but no MB of it would sidestep the finalized-MB
  -- guard entirely.
  ADD CONSTRAINT tax_invoices_work_with_mb CHECK (
    (work_id IS NULL) = (measurement_book_id IS NULL)
  );

COMMENT ON COLUMN tax_invoices.stated_taxable_value IS
  'The taxable value of a DIRECT invoice — one raised against a private '
  'customer rather than a Measurement Book. Exactly one of this and '
  'measurement_book_id is ever set.';

-- The one-live-per-MB rule is unaffected by NULLs: a unique index treats
-- NULLs as distinct, so any number of direct invoices coexist while two
-- live invoices against the same MB still collide. Stated explicitly
-- because it is load-bearing and easy to misread as a hole.

-- ---------------------------------------------------------------------
-- 4. The MB guard steps aside for an invoice that names no MB.
--
-- Everything it refuses — a record MB, an unfinalized MB, an MB of
-- another Work — is a statement about a Measurement Book. With no MB
-- there is nothing to refuse, and the CHECK above has already made sure
-- the invoice carries a stated value instead.

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
  IF NEW.measurement_book_id IS NULL THEN
    RETURN NEW;
  END IF;
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

-- ---------------------------------------------------------------------
-- 5. A number need not have a prefix.
--
-- 0037 required one on every submitted invoice, because at that point
-- the number was always prefix + year + serial. Now the format is the
-- organisation's, and the product default (TI/<FY>/NNN) uses no prefix
-- at all — so requiring the column would refuse the default series.

ALTER TABLE tax_invoices DROP CONSTRAINT tax_invoices_prefix_with_number;
