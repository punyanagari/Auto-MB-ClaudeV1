-- Migration 0065: named domains for the three repeated value shapes, and
-- a live-items view over the soft-deleted work_items table.
--
-- 1. DOMAINS. The schema repeats three value shapes by hand in more than
--    seventy places:
--
--      * a lowercase 64-character SHA-256 digest, written as `text` with
--        an inline `~ '^[0-9a-f]{64}$'` CHECK, twenty-one times;
--      * money, written as `numeric(18,2)`, thirty-four times;
--      * a measured quantity, written as `numeric(18,3)`, eighteen times.
--
--    Repeating a shape by hand is how it drifts: a future money column
--    written `numeric(12,2)` or a digest column with no CHECK would be
--    accepted silently today. Three domains make each shape a name the
--    catalog can be asserted on, and `packages/db/test/schema-domains`
--    asserts exactly that: after this migration no public table carries a
--    bare `numeric(18,2)` or `numeric(18,3)` column, and every digest
--    column uses `sha256_hex`.
--
--    `money_amount` and `quantity_amount` carry no CHECK on purpose. Sign
--    is a per-column fact here — `round_off` is legitimately negative, and
--    a measurement-book `delta_*` is negative when an amendment reduces a
--    quantity — so the existing per-column CHECKs remain the place where
--    sign is decided. What the domains fix is precision and scale, which
--    are never a per-column decision. `sha256_hex` does carry the digest
--    CHECK; the inline CHECKs it duplicates are deliberately left in place
--    (the house posture is that an invariant worth having is enforced
--    twice), so this migration drops no constraint.
--
--    Every ALTER below is binary-coercible — each domain sits directly on
--    the column's current base type — so PostgreSQL re-verifies but does
--    not rewrite the tables. Rollback is the same list of ALTERs with the
--    base types written back, followed by `DROP DOMAIN`.
--
-- 2. work_items_live. `work_items` is soft-deleted (`deleted_at`), so
--    every correct reader has to remember `AND deleted_at IS NULL`;
--    forgetting it resurrects an omitted schedule item into a ledger or a
--    total. The view gives that set a name. It is `security_invoker`, like
--    the 0028 compatibility view, so row-level security is re-checked
--    against the caller and the view grants no visibility the base table
--    would not. Existing routes are not migrated onto it in this
--    migration: that is a per-route reading change and belongs with the
--    route it changes.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- 1. The domains.
-- ---------------------------------------------------------------------

CREATE DOMAIN sha256_hex AS text
  CHECK (VALUE ~ '^[0-9a-f]{64}$');

COMMENT ON DOMAIN sha256_hex IS
  'A lowercase hex SHA-256 digest. NULL is permitted; a column that must '
  'always carry a digest states NOT NULL itself.';

CREATE DOMAIN money_amount AS numeric(18, 2);

COMMENT ON DOMAIN money_amount IS
  'An authoritative money value in rupees. Scale 2 is the whole point: '
  'never compute one of these in JavaScript floating point. Sign is a '
  'per-column decision and stays in per-column CHECKs.';

CREATE DOMAIN quantity_amount AS numeric(18, 3);

COMMENT ON DOMAIN quantity_amount IS
  'A measured or awarded quantity. Scale 3 matches the LOA schedules the '
  'quantities are read from. Sign is a per-column decision: measurement-'
  'book deltas go negative when an amendment reduces a quantity.';

-- ---------------------------------------------------------------------
-- 1b. Three column-scoped triggers stand in the way.
--
-- `ALTER COLUMN ... TYPE` refuses while a `BEFORE UPDATE OF <column>`
-- trigger names the column. Exactly three do, all on tax_invoices. They
-- are dropped here and recreated verbatim at the end of section 3, inside
-- this migration's transaction, so no window exists in which an invoice
-- can be written without them. Their names are unchanged, which keeps the
-- alphabetical firing order 0044 relies on.
-- ---------------------------------------------------------------------

DROP TRIGGER tax_invoices_render_pointer_guard ON tax_invoices;
DROP TRIGGER tax_invoices_split_place_guard ON tax_invoices;
DROP TRIGGER tax_invoices_tax_heads_guard ON tax_invoices;

-- ---------------------------------------------------------------------
-- 2. Digest columns adopt sha256_hex.
--
-- schema_migrations.sha256 is the migration ledger's own digest column,
-- created by the runner as plain text. It is included so the rule the
-- test asserts has no exceptions to remember.
-- ---------------------------------------------------------------------

ALTER TABLE account_lockout_locks
  ALTER COLUMN key_hash TYPE sha256_hex;

ALTER TABLE amendment_variation_orders
  ALTER COLUMN sha256 TYPE sha256_hex;

ALTER TABLE correction_notices
  ALTER COLUMN rendered_sha256 TYPE sha256_hex;

ALTER TABLE credit_notes
  ALTER COLUMN rendered_sha256 TYPE sha256_hex;

ALTER TABLE delivery_challans
  ALTER COLUMN rendered_sha256 TYPE sha256_hex,
  ALTER COLUMN signed_copy_sha256 TYPE sha256_hex,
  ALTER COLUMN warranty_text_sha256 TYPE sha256_hex;

ALTER TABLE extension_requests
  ALTER COLUMN rendered_sha256 TYPE sha256_hex,
  ALTER COLUMN response_sha256 TYPE sha256_hex;

ALTER TABLE issue_challans
  ALTER COLUMN rendered_sha256 TYPE sha256_hex,
  ALTER COLUMN signed_copy_sha256 TYPE sha256_hex;

ALTER TABLE loa_documents
  ALTER COLUMN sha256 TYPE sha256_hex;

ALTER TABLE measurement_books
  ALTER COLUMN rendered_sha256 TYPE sha256_hex;

ALTER TABLE pac_certificates
  ALTER COLUMN document_sha256 TYPE sha256_hex;

ALTER TABLE rate_limit_attempts
  ALTER COLUMN key_hash TYPE sha256_hex;

ALTER TABLE schema_migrations
  ALTER COLUMN sha256 TYPE sha256_hex;

ALTER TABLE statutory_provider_operations
  ALTER COLUMN request_sha256 TYPE sha256_hex;

ALTER TABLE tax_invoice_renders
  ALTER COLUMN logo_sha256 TYPE sha256_hex,
  ALTER COLUMN pdf_sha256 TYPE sha256_hex,
  ALTER COLUMN source_sha256 TYPE sha256_hex;

ALTER TABLE tax_invoices
  ALTER COLUMN rendered_sha256 TYPE sha256_hex;

-- ---------------------------------------------------------------------
-- 3. Money columns adopt money_amount.
-- ---------------------------------------------------------------------

ALTER TABLE bills
  ALTER COLUMN total_amount TYPE money_amount;

ALTER TABLE budgetary_quotation_lines
  ALTER COLUMN line_amount TYPE money_amount;

ALTER TABLE budgetary_quotations
  ALTER COLUMN total_amount TYPE money_amount;

ALTER TABLE credit_notes
  ALTER COLUMN taxable_value TYPE money_amount,
  ALTER COLUMN cgst_amount TYPE money_amount,
  ALTER COLUMN sgst_amount TYPE money_amount,
  ALTER COLUMN igst_amount TYPE money_amount,
  ALTER COLUMN round_off TYPE money_amount,
  ALTER COLUMN total_amount TYPE money_amount;

ALTER TABLE delivery_challan_items
  ALTER COLUMN line_amount TYPE money_amount;

ALTER TABLE measurement_book_lines
  ALTER COLUMN amount_supply TYPE money_amount,
  ALTER COLUMN amount_installation TYPE money_amount,
  ALTER COLUMN amount_pac TYPE money_amount,
  ALTER COLUMN amount_final_bill TYPE money_amount,
  ALTER COLUMN line_total TYPE money_amount;

ALTER TABLE measurement_books
  ALTER COLUMN total_amount TYPE money_amount;

ALTER TABLE purchase_order_lines
  ALTER COLUMN line_amount TYPE money_amount;

ALTER TABLE purchase_orders
  ALTER COLUMN total_amount TYPE money_amount;

ALTER TABLE tax_invoice_lines
  ALTER COLUMN unit_rate TYPE money_amount,
  ALTER COLUMN taxable_value TYPE money_amount,
  ALTER COLUMN cgst_amount TYPE money_amount,
  ALTER COLUMN sgst_amount TYPE money_amount,
  ALTER COLUMN igst_amount TYPE money_amount;

ALTER TABLE tax_invoices
  ALTER COLUMN taxable_value TYPE money_amount,
  ALTER COLUMN cgst_amount TYPE money_amount,
  ALTER COLUMN sgst_amount TYPE money_amount,
  ALTER COLUMN igst_amount TYPE money_amount,
  ALTER COLUMN round_off TYPE money_amount,
  ALTER COLUMN total_amount TYPE money_amount,
  ALTER COLUMN stated_taxable_value TYPE money_amount;

ALTER TABLE work_instruments
  ALTER COLUMN amount TYPE money_amount;

ALTER TABLE works
  ALTER COLUMN advertised_value TYPE money_amount,
  ALTER COLUMN contract_value TYPE money_amount,
  ALTER COLUMN pbg_required_amount TYPE money_amount;

-- The three triggers from section 1b, recreated exactly as
-- pg_get_triggerdef rendered them before the drop.

CREATE TRIGGER tax_invoices_render_pointer_guard
BEFORE UPDATE OF template_version, rendered_object_key, rendered_sha256
ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_render_pointer();

CREATE TRIGGER tax_invoices_split_place_guard
BEFORE INSERT OR UPDATE OF status, place_of_supply, cgst_amount, sgst_amount,
  igst_amount
ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_split_place();

CREATE TRIGGER tax_invoices_tax_heads_guard
BEFORE INSERT OR UPDATE OF status, line_shape, gst_rate, taxable_value,
  cgst_amount, sgst_amount, igst_amount
ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_tax_heads();

-- ---------------------------------------------------------------------
-- 4. Quantity columns adopt quantity_amount.
-- ---------------------------------------------------------------------

ALTER TABLE budgetary_quotation_lines
  ALTER COLUMN quantity TYPE quantity_amount;

ALTER TABLE delivery_challan_items
  ALTER COLUMN quantity TYPE quantity_amount;

ALTER TABLE installations
  ALTER COLUMN quantity TYPE quantity_amount;

ALTER TABLE issue_challan_lines
  ALTER COLUMN quantity TYPE quantity_amount;

ALTER TABLE mb_entries
  ALTER COLUMN measured_quantity TYPE quantity_amount;

ALTER TABLE measurement_book_lines
  ALTER COLUMN delta_supplied TYPE quantity_amount,
  ALTER COLUMN delta_installed TYPE quantity_amount,
  ALTER COLUMN delta_pac TYPE quantity_amount,
  ALTER COLUMN delta_final_bill TYPE quantity_amount,
  ALTER COLUMN prior_supplied TYPE quantity_amount,
  ALTER COLUMN prior_installed TYPE quantity_amount,
  ALTER COLUMN prior_pac TYPE quantity_amount,
  ALTER COLUMN prior_final_bill TYPE quantity_amount;

ALTER TABLE pac_certificate_items
  ALTER COLUMN certified_quantity TYPE quantity_amount;

ALTER TABLE purchase_order_lines
  ALTER COLUMN quantity TYPE quantity_amount;

ALTER TABLE tax_invoice_lines
  ALTER COLUMN quantity TYPE quantity_amount;

ALTER TABLE work_items
  ALTER COLUMN awarded_quantity TYPE quantity_amount,
  ALTER COLUMN effective_quantity TYPE quantity_amount;

-- ---------------------------------------------------------------------
-- 5. work_items_live.
--
-- Created after the ALTERs above: a view depending on work_items would
-- block altering the columns it selects.
-- ---------------------------------------------------------------------

CREATE VIEW work_items_live
WITH (security_invoker = true)
AS
  SELECT id, organisation_id, work_id, schedule_id, item_number, description,
         unit_code, awarded_quantity, effective_rate, requires_serials,
         payment_category, source_evidence, created_at, updated_at,
         effective_quantity, effective_unit_rate, effective_description,
         effective_unit, amendment_added, source_approval_id, hsn_code,
         gst_rate, is_service, advertised_rate
  FROM work_items
  WHERE deleted_at IS NULL;

COMMENT ON VIEW work_items_live IS
  'work_items excluding soft-deleted rows (migration 0065). Not a tenant '
  'table: RLS lives on work_items and applies through security_invoker. '
  'deleted_at is deliberately absent from the projection — inside this '
  'view it is always NULL.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT ON work_items_live TO auto_mb_app;
  END IF;
END
$$;
