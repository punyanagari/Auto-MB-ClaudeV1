-- Migration 0041 had to make legacy statutory rows satisfy the new exact-text
-- shape before adding constraints. Its later loss-detection predicates then
-- saw the synthesized compatibility values instead of the pre-migration
-- NULLs. We cannot reconstruct the former portal bytes now, so classify every
-- pre-provider-ledger manual statutory row conservatively. The displayed
-- values remain useful compatibility data, but the product must not claim
-- that they are complete exact provider evidence.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- 0041 deliberately makes issued statutory evidence immutable. This one-time
-- classification is the only legitimate mutation of the two legacy-loss
-- markers, so suspend only the named guards for the duration of this atomic
-- migration. Any failure rolls the transaction (including trigger state) back.
LOCK TABLE tax_invoices, eway_bills IN ACCESS EXCLUSIVE MODE;
ALTER TABLE tax_invoices DISABLE TRIGGER tax_invoices_issued_update_guard;
ALTER TABLE eway_bills DISABLE TRIGGER eway_bills_issued_update_guard;

UPDATE tax_invoices AS ti
SET irp_legacy_evidence_missing = true
WHERE ti.irn IS NOT NULL
  AND ti.irp_provider = 'manual'
  AND NOT EXISTS (
    SELECT 1
    FROM statutory_provider_operations AS operation
    WHERE operation.organisation_id = ti.organisation_id
      AND operation.tax_invoice_id = ti.id
      AND operation.operation IN ('register_irp', 'reconcile_irp')
      AND operation.status = 'succeeded'
  );

UPDATE eway_bills AS eb
SET legacy_evidence_missing = true
WHERE eb.status IN ('generated', 'cancelled')
  AND eb.provider = 'manual'
  AND NOT EXISTS (
    SELECT 1
    FROM statutory_provider_operations AS operation
    WHERE operation.organisation_id = eb.organisation_id
      AND operation.eway_bill_id = eb.id
      AND operation.operation IN ('generate_eway_bill', 'reconcile_eway_bill')
      AND operation.status = 'succeeded'
  );

ALTER TABLE tax_invoices ENABLE TRIGGER tax_invoices_issued_update_guard;
ALTER TABLE eway_bills ENABLE TRIGGER eway_bills_issued_update_guard;

COMMENT ON COLUMN tax_invoices.irp_legacy_evidence_missing IS
  'True when a migrated/manual IRP row cannot prove that every provider evidence byte was preserved exactly.';

COMMENT ON COLUMN eway_bills.legacy_evidence_missing IS
  'True when a migrated/manual EWB row cannot prove that every provider evidence byte was preserved exactly.';
