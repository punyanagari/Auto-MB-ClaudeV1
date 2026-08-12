SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- E-invoice applicability and the IRP reporting window (finding 20,
-- docs/AUDIT-DISPOSITION-2026-08-10.md).
--
-- Until now nothing recorded whether an organisation is required to
-- report its invoices to the IRP at all, or whether a given invoice is
-- still inside its lawful reporting window. The law (verified 12 August
-- 2026): e-invoicing is mandatory once aggregate annual turnover has
-- EVER exceeded ₹5 crore, and stays mandatory permanently once crossed;
-- since 1 April 2025 taxpayers with AATO of ₹10 crore or more cannot
-- report a document to the IRP more than 30 days after its date; and
-- voluntary registration below the mandate is not provided for.
--
-- The system does not know the organisation's turnover and must not
-- guess it. The OWNER declares the legal consequence — applicable from a
-- date, or not applicable — and, where the 30-day rule binds them, the
-- reporting window in days. Each invoice then FREEZES that consequence
-- at submit: its reporting deadline is computed from the declaration in
-- force at the money moment and never moves afterwards, exactly like
-- every other issued business fact.

-- 1. The organisation's declaration -----------------------------------------

ALTER TABLE organisations
  ADD COLUMN einvoice_applicability text NOT NULL DEFAULT 'undeclared'
    CHECK (einvoice_applicability IN ('undeclared', 'not_applicable', 'applicable')),
  ADD COLUMN einvoice_applicable_from date,
  ADD COLUMN irp_reporting_window_days integer
    CHECK (irp_reporting_window_days IS NULL
           OR irp_reporting_window_days BETWEEN 1 AND 365),
  ADD CONSTRAINT organisations_einvoice_declaration_coherent CHECK (
    ((einvoice_applicability = 'applicable')
      = (einvoice_applicable_from IS NOT NULL))
    AND (irp_reporting_window_days IS NULL
         OR einvoice_applicability = 'applicable')
  );

COMMENT ON COLUMN organisations.einvoice_applicability IS
  'Owner declaration: whether e-invoicing (IRP reporting) applies to this organisation. undeclared blocks the IRP transport; not_applicable refuses it because voluntary registration below the mandate is not provided for; applicable requires einvoice_applicable_from.';
COMMENT ON COLUMN organisations.einvoice_applicable_from IS
  'The date e-invoicing became mandatory for this organisation (mandatory permanently once AATO ever exceeded the threshold). Set exactly when the declaration is applicable.';
COMMENT ON COLUMN organisations.irp_reporting_window_days IS
  'Days after its date within which an invoice may still be reported to the IRP (30 for AATO >= 10 crore since 1 April 2025). NULL when no window binds the organisation; only declarable while applicable.';

-- 2. The invoice's frozen consequence ---------------------------------------

ALTER TABLE tax_invoices
  ADD COLUMN irp_reporting_deadline date;

COMMENT ON COLUMN tax_invoices.irp_reporting_deadline IS
  'Frozen at submit from the organisation declaration then in force: invoice_date + irp_reporting_window_days when the declaration was applicable, the invoice was dated on or after einvoice_applicable_from, and a window was declared. NULL means no window applied at submit; invoices issued before this column existed stay NULL honestly rather than acquiring a back-dated deadline.';

-- 3. Freeze it with the other issued facts ----------------------------------
--
-- The 0041 issued-invoice guard pins every business fact once the row
-- leaves draft. The reporting deadline is such a fact — it is the frozen
-- legal consequence of the declaration at the money moment, and letting
-- it move after issue would let a later declaration edit rewrite which
-- invoices look lawfully reportable. Recreated verbatim from 0041 with
-- irp_reporting_deadline added to the frozen-column ROW comparison; no
-- other clause changes.

CREATE OR REPLACE FUNCTION app_private.guard_tax_invoice_issued_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.measurement_book_id,
      NEW.invoice_number, NEW.sequence_number, NEW.fy_label,
      NEW.invoice_date, NEW.sac_code, NEW.service_description,
      NEW.gst_rate, NEW.place_of_supply, NEW.buyer_contact_id,
      NEW.buyer_snapshot, NEW.taxable_value, NEW.cgst_amount,
      NEW.sgst_amount, NEW.igst_amount, NEW.total_amount, NEW.round_off,
      NEW.customer_po_reference, NEW.unit_label, NEW.notes,
      NEW.ship_to_contact_id, NEW.ship_to_snapshot, NEW.issued_snapshot,
      NEW.number_prefix, NEW.stated_taxable_value,
      NEW.irp_reporting_deadline,
      NEW.submitted_by_user_id, NEW.submitted_at,
      NEW.created_by_user_id, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.measurement_book_id,
      OLD.invoice_number, OLD.sequence_number, OLD.fy_label,
      OLD.invoice_date, OLD.sac_code, OLD.service_description,
      OLD.gst_rate, OLD.place_of_supply, OLD.buyer_contact_id,
      OLD.buyer_snapshot, OLD.taxable_value, OLD.cgst_amount,
      OLD.sgst_amount, OLD.igst_amount, OLD.total_amount, OLD.round_off,
      OLD.customer_po_reference, OLD.unit_label, OLD.notes,
      OLD.ship_to_contact_id, OLD.ship_to_snapshot, OLD.issued_snapshot,
      OLD.number_prefix, OLD.stated_taxable_value,
      OLD.irp_reporting_deadline,
      OLD.submitted_by_user_id, OLD.submitted_at,
      OLD.created_by_user_id, OLD.created_at
    ) THEN
      RAISE EXCEPTION 'submitted tax invoice business facts are immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'cancelled tax invoices cannot be reopened'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'cancelled' AND ROW(
      NEW.cancelled_at, NEW.cancelled_by_user_id, NEW.cancellation_note
    ) IS DISTINCT FROM ROW(
      OLD.cancelled_at, OLD.cancelled_by_user_id, OLD.cancellation_note
    ) THEN
      RAISE EXCEPTION 'tax invoice cancellation evidence is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.irn IS NOT NULL AND ROW(
      NEW.irn, NEW.ack_number, NEW.ack_date, NEW.ack_date_text,
      NEW.signed_qr, NEW.signed_invoice, NEW.irp_provider,
      NEW.irp_legacy_evidence_missing
    ) IS DISTINCT FROM ROW(
      OLD.irn, OLD.ack_number, OLD.ack_date, OLD.ack_date_text,
      OLD.signed_qr, OLD.signed_invoice, OLD.irp_provider,
      OLD.irp_legacy_evidence_missing
    ) THEN
      RAISE EXCEPTION 'IRP registration evidence is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.irp_provider IS NOT NULL
       AND NEW.irp_provider IS DISTINCT FROM OLD.irp_provider THEN
      RAISE EXCEPTION 'IRP provider identity is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.irp_cancelled_at IS NOT NULL AND ROW(
      NEW.irp_cancelled_at, NEW.irp_cancelled_at_text,
      NEW.irp_cancel_reason_code, NEW.irp_cancel_remark
    ) IS DISTINCT FROM ROW(
      OLD.irp_cancelled_at, OLD.irp_cancelled_at_text,
      OLD.irp_cancel_reason_code, OLD.irp_cancel_remark
    ) THEN
      RAISE EXCEPTION 'IRP cancellation evidence is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.irp_provider_state IS DISTINCT FROM OLD.irp_provider_state
       AND NOT (
         (OLD.irp_provider_state = 'not_requested'
          AND NEW.irp_provider_state IN ('registering', 'registered'))
         OR (OLD.irp_provider_state = 'registering'
          AND NEW.irp_provider_state IN (
            'registered', 'registration_failed', 'registration_unknown'
          ))
         OR (OLD.irp_provider_state IN (
               'registration_failed', 'registration_unknown'
             ) AND NEW.irp_provider_state = 'registering')
         OR (OLD.irp_provider_state = 'registered'
          AND NEW.irp_provider_state IN ('cancelling', 'cancelled'))
         OR (OLD.irp_provider_state = 'cancelling'
          AND NEW.irp_provider_state IN (
            'registered', 'cancelled', 'cancellation_unknown'
          ))
         OR (OLD.irp_provider_state = 'cancellation_unknown'
          AND NEW.irp_provider_state = 'cancelled')
       ) THEN
      RAISE EXCEPTION 'invalid IRP provider-state transition'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'submitted' AND NEW.status = 'cancelled'
       AND OLD.irp_provider_state NOT IN ('not_requested', 'cancelled') THEN
      RAISE EXCEPTION 'resolve provider registration/cancellation before cancelling the local invoice'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
