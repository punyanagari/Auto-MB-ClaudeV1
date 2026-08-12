-- Migration 0053: manual IRP evidence truth (finding 2 residue,
-- docs/AUDIT-DISPOSITION-2026-08-10.md). Runs after 0051 (credit notes)
-- and 0052 (money backstops); both guard recreations below are written
-- ON TOP OF 0051's function texts, so every supersession clause 0051
-- added survives.
--
-- Two truths this migration adds:
--
-- 1. The provider operation ledger retains the raw request and response
--    bodies beside the hash, code and status it already keeps. A hash
--    proves WHAT was sent only to someone who already holds the bytes;
--    the ledger now holds them. Bounded, append-once: the request body is
--    part of the operation's immutable identity, the response body lands
--    exactly when the operation completes and is frozen with it.
--
-- 2. A registration recorded through the manual compatibility door gets
--    its own provider state, `registered_unverified`, instead of sharing
--    `registered` with provider-verified rows. It behaves as registered
--    for local rules (the cancel interlock, the reporting window) but is
--    excluded from every provider-verified claim, and only
--    irp_provider = 'manual' rows may hold it.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. Raw provider evidence on the operation ledger.
--
-- 256 KiB bounds each body. Requests are the exact statutory JSON already
-- hashed into request_sha256 and stay far below the bound; a register
-- response can exceed it (the signed invoice alone may reach 1 MiB), so
-- an over-bound body is stored as a truncated prefix with an explicit
-- marker rather than silently dropped or silently cut. Provider AUTH
-- calls never open ledger operations, so tokens and credentials cannot
-- land here; docs/SECURITY.md carries that boundary.

ALTER TABLE statutory_provider_operations
  ADD COLUMN request_body text
    CHECK (request_body IS NULL OR octet_length(request_body) <= 262144),
  ADD COLUMN request_body_truncated boolean NOT NULL DEFAULT false,
  ADD COLUMN response_body text
    CHECK (response_body IS NULL OR octet_length(response_body) <= 262144),
  ADD COLUMN response_body_truncated boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT statutory_provider_operations_truncation_shape CHECK (
    (request_body IS NOT NULL OR request_body_truncated = false)
    AND (response_body IS NOT NULL OR response_body_truncated = false)
  );

COMMENT ON COLUMN statutory_provider_operations.request_body IS
  'Raw provider request body, exactly the bytes request_sha256 hashes (truncated with request_body_truncated = true when over 256 KiB). NULL on rows that predate 0053.';
COMMENT ON COLUMN statutory_provider_operations.response_body IS
  'Raw provider response body as received (truncated with response_body_truncated = true when over 256 KiB). Written once, when the operation completes; NULL when no response arrived or the row predates 0053.';

-- Recreated verbatim from 0051's text (which added credit_note_id to the
-- identity ROW) with two additions: the raw request body joins the
-- immutable operation identity, and the raw response body may change
-- only in the update that takes the row out of pending (completed rows
-- were already immutable). No other clause changes; the 0051
-- credit-note pinning survives.
CREATE OR REPLACE FUNCTION app_private.guard_statutory_operation_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'completed statutory provider operations are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF ROW(
    NEW.organisation_id, NEW.tax_invoice_id, NEW.eway_bill_id,
    NEW.credit_note_id,
    NEW.provider, NEW.environment, NEW.operation, NEW.correlation_id,
    NEW.request_sha256, NEW.request_body, NEW.request_body_truncated,
    NEW.created_by_user_id, NEW.started_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.tax_invoice_id, OLD.eway_bill_id,
    OLD.credit_note_id,
    OLD.provider, OLD.environment, OLD.operation, OLD.correlation_id,
    OLD.request_sha256, OLD.request_body, OLD.request_body_truncated,
    OLD.created_by_user_id, OLD.started_at
  ) THEN
    RAISE EXCEPTION 'statutory provider operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'pending' AND ROW(
    NEW.response_body, NEW.response_body_truncated
  ) IS DISTINCT FROM ROW(
    OLD.response_body, OLD.response_body_truncated
  ) THEN
    RAISE EXCEPTION 'provider response evidence lands only when the operation completes'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. The distinct manually-recorded registration state.

ALTER TABLE tax_invoices
  DROP CONSTRAINT tax_invoices_irp_provider_state_check;

ALTER TABLE tax_invoices
  ADD CONSTRAINT tax_invoices_irp_provider_state_check CHECK (
    irp_provider_state IN (
      'not_requested', 'registering', 'registered', 'registered_unverified',
      'registration_failed', 'registration_unknown',
      'cancelling', 'cancelled', 'cancellation_unknown'
    )
  );

-- registered_unverified carries full registration evidence exactly like
-- registered: same first arm of the 0041 evidence-shape constraint.
ALTER TABLE tax_invoices
  DROP CONSTRAINT tax_invoices_irp_registration_evidence_shape;

ALTER TABLE tax_invoices
  ADD CONSTRAINT tax_invoices_irp_registration_evidence_shape CHECK (
    (irp_provider_state IN (
       'registered', 'registered_unverified',
       'cancelling', 'cancelled', 'cancellation_unknown'
     )
     AND irn IS NOT NULL
     AND (
       (ack_number IS NOT NULL AND ack_date IS NOT NULL
        AND ack_date_text IS NOT NULL AND signed_qr IS NOT NULL
        AND irp_legacy_evidence_missing = false)
       OR (irp_provider = 'manual' AND irp_legacy_evidence_missing = true)
     ))
    OR
    (irp_provider_state IN (
       'not_requested', 'registering', 'registration_failed',
       'registration_unknown'
     )
     AND irn IS NULL AND ack_number IS NULL AND ack_date IS NULL
     AND ack_date_text IS NULL AND signed_qr IS NULL
     AND signed_invoice IS NULL AND irp_legacy_evidence_missing = false)
  );

-- Recreated verbatim from 0051's text — NOT 0049's: 0051 rebuilt this
-- guard with the credit-note supersession clauses (draft can never be
-- superseded; submitted -> superseded only under an issued credit note
-- with no provider operation mid-flight; superseded terminal except the
-- guarded revert to submitted when no issued note remains) and made it
-- SECURITY DEFINER for the cross-row credit_notes reads. Every one of
-- those clauses survives below. What THIS migration adds is exactly two
-- transition arms and nothing else: the manual compatibility door lands
-- a fresh recording in registered_unverified, and externally confirmed
-- cancellation evidence closes it as cancelled. registered_unverified
-- deliberately stays OUT of the whitebooks arms (registering/cancelling
-- never touch it), IS caught by the local-cancel interlock (it is not in
-- ('not_requested', 'cancelled')), and does NOT block supersession —
-- a manually-registered invoice past the 24-hour window is precisely the
-- case the credit note exists for.
CREATE OR REPLACE FUNCTION app_private.guard_tax_invoice_issued_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'superseded' THEN
    RAISE EXCEPTION 'only a submitted tax invoice can be superseded by a credit note'
      USING ERRCODE = '23514';
  END IF;

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

    IF OLD.status = 'submitted' AND NEW.status = 'superseded' THEN
      IF OLD.irp_provider_state IN ('registering', 'cancelling') THEN
        RAISE EXCEPTION 'resolve the in-flight provider operation before superseding the invoice'
          USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM credit_notes
         WHERE tax_invoice_id = OLD.id
           AND organisation_id = OLD.organisation_id
           AND status = 'issued'
      ) THEN
        RAISE EXCEPTION 'a tax invoice is superseded only by an issued credit note'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
      IF NEW.status <> 'submitted' THEN
        RAISE EXCEPTION 'a superseded tax invoice is terminal (it may only revert to submitted when its credit note is cancelled)'
          USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM credit_notes
         WHERE tax_invoice_id = OLD.id
           AND organisation_id = OLD.organisation_id
           AND status = 'issued'
      ) THEN
        RAISE EXCEPTION 'the invoice stays superseded while an issued credit note exists for it'
          USING ERRCODE = '23514';
      END IF;
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
          AND NEW.irp_provider_state IN (
            'registering', 'registered', 'registered_unverified'
          ))
         OR (OLD.irp_provider_state = 'registering'
          AND NEW.irp_provider_state IN (
            'registered', 'registration_failed', 'registration_unknown'
          ))
         OR (OLD.irp_provider_state IN (
               'registration_failed', 'registration_unknown'
             ) AND NEW.irp_provider_state = 'registering')
         OR (OLD.irp_provider_state = 'registered'
          AND NEW.irp_provider_state IN ('cancelling', 'cancelled'))
         OR (OLD.irp_provider_state = 'registered_unverified'
          AND NEW.irp_provider_state = 'cancelled')
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

-- ---------------------------------------------------------------------------
-- 3. Reclassify existing manually-recorded registrations.
--
-- Every irp_provider = 'manual' row standing in 'registered' was typed in
-- by an operator (0041's backfill and the manual route both wrote that
-- pair); none was provider-verified, so all of them move to
-- registered_unverified. One-time classification of the same kind as
-- 0043: the issued-update guard is suspended for exactly this statement,
-- inside the same atomic migration, under an exclusive lock.

DO $$
DECLARE
  manual_registered_count bigint;
BEGIN
  SELECT count(*) INTO manual_registered_count
  FROM tax_invoices
  WHERE irp_provider = 'manual' AND irp_provider_state = 'registered';
  RAISE NOTICE
    '0053 preflight: % manually-recorded registered tax invoice(s) move to registered_unverified (no evidence bytes change; the rows were never provider-verified)',
    manual_registered_count;
END
$$;

LOCK TABLE tax_invoices IN ACCESS EXCLUSIVE MODE;
ALTER TABLE tax_invoices DISABLE TRIGGER tax_invoices_issued_update_guard;

UPDATE tax_invoices
SET irp_provider_state = 'registered_unverified'
WHERE irp_provider = 'manual' AND irp_provider_state = 'registered';

ALTER TABLE tax_invoices ENABLE TRIGGER tax_invoices_issued_update_guard;

-- After the move the pairing is an invariant: only manual rows hold
-- registered_unverified, and no manual row may claim provider-verified
-- 'registered' again.
ALTER TABLE tax_invoices
  ADD CONSTRAINT tax_invoices_manual_unverified_shape CHECK (
    (irp_provider_state <> 'registered_unverified' OR irp_provider = 'manual')
    AND NOT (irp_provider = 'manual' AND irp_provider_state = 'registered')
  );

COMMENT ON CONSTRAINT tax_invoices_manual_unverified_shape ON tax_invoices IS
  'registered_unverified is exactly the manually-recorded registration state: only manual rows hold it, and manual rows can never claim the provider-verified registered state.';
