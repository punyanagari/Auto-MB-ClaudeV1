-- Migration 0041: trustworthy statutory-provider evidence.
--
-- The application already freezes the GST invoice itself at submit, but
-- Whitebooks/IRP/NIC responses used to be typed into mutable parent rows with
-- no provider boundary.  This migration separates local issue state from
-- provider state, retains signed evidence, and adds an append-only operation
-- ledger.  It also closes two old audit-trail-as-operational-store gaps:
-- buyer_contact_id now lives on the invoice row, and cancelled e-way bills
-- retain the official number and validity evidence they received.

-- Bounded DDL/backfills: deployment must fail clearly instead of waiting
-- forever behind an application transaction.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. The draft buyer is normal relational state, not a fact reconstructed
-- from the newest audit JSON document.

ALTER TABLE tax_invoices
  ADD COLUMN buyer_contact_id uuid;

UPDATE tax_invoices ti
SET buyer_contact_id = COALESCE(
  CASE
    WHEN ti.buyer_snapshot->>'contactId'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (ti.buyer_snapshot->>'contactId')::uuid
    ELSE NULL
  END,
  (
    SELECT (ae.details->>'buyerContactId')::uuid
    FROM audit_events ae
    WHERE ae.organisation_id = ti.organisation_id
      AND ae.entity_type = 'tax_invoices'
      AND ae.entity_id = ti.id
      AND ae.details->>'buyerContactId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ORDER BY ae.occurred_at DESC, ae.id DESC
    LIMIT 1
  )
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tax_invoices WHERE buyer_contact_id IS NULL) THEN
    RAISE EXCEPTION
      '0041 cannot prove buyer_contact_id for every tax invoice; repair provenance before migrating';
  END IF;
END
$$;

ALTER TABLE tax_invoices
  ALTER COLUMN buyer_contact_id SET NOT NULL,
  ADD CONSTRAINT tax_invoices_buyer_contact_fk
    FOREIGN KEY (organisation_id, buyer_contact_id)
      REFERENCES contacts (organisation_id, id);

-- ---------------------------------------------------------------------------
-- 2. IRP and NIC evidence state.  Provider values are never credentials;
-- these columns contain only names, stable status, and statutory evidence.

-- 0037 assumed one display layout. Whitebooks/NIC legitimately returns
-- both ISO-like and DD/MM/YYYY wall clocks. Preserve the exact text while
-- keeping a bounded, explicit set of timestamp shapes.
ALTER TABLE tax_invoices
  DROP CONSTRAINT tax_invoices_ack_date_text_check;

ALTER TABLE tax_invoices
  ADD CONSTRAINT tax_invoices_ack_date_text_check CHECK (
    ack_date_text IS NULL
    OR (
      length(ack_date_text) BETWEEN 19 AND 25
      AND ack_date_text ~ '^([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}([zZ]|[+-][0-9]{2}:[0-9]{2})?|[0-9]{2}/[0-9]{2}/[0-9]{4}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})$'
    )
  );

ALTER TABLE tax_invoices
  ADD COLUMN irp_provider text
    CHECK (irp_provider IS NULL OR irp_provider IN ('manual', 'whitebooks')),
  ADD COLUMN irp_provider_state text NOT NULL DEFAULT 'not_requested'
    CHECK (irp_provider_state IN (
      'not_requested', 'registering', 'registered',
      'registration_failed', 'registration_unknown',
      'cancelling', 'cancelled', 'cancellation_unknown'
    )),
  ADD COLUMN signed_invoice text,
  ADD COLUMN irp_cancelled_at timestamptz,
  ADD COLUMN irp_cancelled_at_text text
    CHECK (irp_cancelled_at_text IS NULL OR (
      length(irp_cancelled_at_text) BETWEEN 19 AND 25
      AND irp_cancelled_at_text ~ '^([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}([zZ]|[+-][0-9]{2}:[0-9]{2})?|[0-9]{2}/[0-9]{2}/[0-9]{4}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})$'
    )),
  ADD COLUMN irp_cancel_reason_code text
    CHECK (irp_cancel_reason_code IS NULL OR irp_cancel_reason_code ~ '^[1-4]$'),
  ADD COLUMN irp_cancel_remark text
    CHECK (irp_cancel_remark IS NULL
           OR length(btrim(irp_cancel_remark)) BETWEEN 3 AND 2000),
  ADD COLUMN irp_legacy_evidence_missing boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT tax_invoices_irp_provider_shape CHECK (
    (irp_provider_state = 'not_requested' AND irp_provider IS NULL)
    OR (irp_provider_state <> 'not_requested' AND irp_provider IS NOT NULL)
  ),
  ADD CONSTRAINT tax_invoices_irp_cancel_evidence_shape CHECK (
    (irp_provider_state = 'cancelled'
      AND irp_cancelled_at IS NOT NULL
      AND irp_cancelled_at_text IS NOT NULL
      AND irp_cancel_reason_code IS NOT NULL
      AND irp_cancel_remark IS NOT NULL)
    OR
    (irp_provider_state <> 'cancelled'
      AND irp_cancelled_at IS NULL
      AND irp_cancelled_at_text IS NULL
      AND irp_cancel_reason_code IS NULL
      AND irp_cancel_remark IS NULL)
  );

UPDATE tax_invoices
SET irp_provider = 'manual',
    irp_provider_state = CASE
      WHEN status = 'cancelled' THEN 'cancellation_unknown'
      ELSE 'registered'
    END
WHERE irn IS NOT NULL;

UPDATE tax_invoices
SET ack_date_text = COALESCE(
      ack_date_text,
      to_char(ack_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS')
    )
WHERE irn IS NOT NULL;

UPDATE tax_invoices
SET irp_legacy_evidence_missing = true
WHERE irn IS NOT NULL
  AND (ack_number IS NULL OR ack_date IS NULL OR ack_date_text IS NULL
       OR signed_qr IS NULL);

ALTER TABLE tax_invoices
  ADD CONSTRAINT tax_invoices_irp_registration_evidence_shape CHECK (
    (irp_provider_state IN (
       'registered', 'cancelling', 'cancelled', 'cancellation_unknown'
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

ALTER TABLE eway_bills
  ADD COLUMN provider text
    CHECK (provider IS NULL OR provider IN ('manual', 'whitebooks')),
  ADD COLUMN provider_state text NOT NULL DEFAULT 'not_requested'
    CHECK (provider_state IN (
      'not_requested', 'generating', 'generated',
      'generation_failed', 'generation_unknown',
      'cancelling', 'cancelled', 'cancellation_unknown'
    )),
  ADD COLUMN ewb_date_text text,
  ADD COLUMN valid_until_text text,
  ADD COLUMN provider_cancelled_at timestamptz,
  ADD COLUMN provider_cancelled_at_text text
    CHECK (provider_cancelled_at_text IS NULL OR (
      length(provider_cancelled_at_text) BETWEEN 19 AND 25
      AND provider_cancelled_at_text ~ '^([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}([zZ]|[+-][0-9]{2}:[0-9]{2})?|[0-9]{2}/[0-9]{2}/[0-9]{4}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})$'
    )),
  ADD COLUMN provider_cancel_reason_code text
    CHECK (provider_cancel_reason_code IS NULL
           OR provider_cancel_reason_code ~ '^[1-4]$'),
  ADD COLUMN provider_cancel_remark text
    CHECK (provider_cancel_remark IS NULL
           OR length(btrim(provider_cancel_remark)) BETWEEN 3 AND 2000),
  ADD COLUMN legacy_evidence_missing boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT eway_bills_provider_shape CHECK (
    (provider_state = 'not_requested' AND provider IS NULL)
    OR (provider_state <> 'not_requested' AND provider IS NOT NULL)
  ),
  ADD CONSTRAINT eway_bills_provider_cancel_evidence_shape CHECK (
    (provider_state = 'cancelled'
      AND provider_cancelled_at IS NOT NULL
      AND provider_cancelled_at_text IS NOT NULL
      AND provider_cancel_reason_code IS NOT NULL
      AND provider_cancel_remark IS NOT NULL)
    OR
    (provider_state <> 'cancelled'
      AND provider_cancelled_at IS NULL
      AND provider_cancelled_at_text IS NULL
      AND provider_cancel_reason_code IS NULL
      AND provider_cancel_remark IS NULL)
  );

-- Generated rows already retain evidence.  Cancelled legacy rows had it
-- cleared by the old route; recover the exact response from the append-only
-- generation event where possible.  A truthful marker records any historical
-- hole instead of inventing a number or timestamp.
UPDATE eway_bills
SET provider = 'manual',
    provider_state = CASE
      WHEN status = 'generated' THEN 'generated'
      ELSE 'cancellation_unknown'
    END
WHERE status <> 'draft';

WITH latest_generation AS (
  SELECT DISTINCT ON (ae.organisation_id, ae.entity_id)
    ae.organisation_id,
    ae.entity_id,
    ae.actor_user_id,
    ae.occurred_at,
    ae.details
  FROM audit_events ae
  WHERE ae.entity_type = 'eway_bills'
    AND ae.action = 'eway_bill.generated'
  ORDER BY ae.organisation_id, ae.entity_id, ae.occurred_at DESC, ae.id DESC
)
UPDATE eway_bills eb
SET ewb_number = CASE
      WHEN lg.details->>'ewbNumber' ~ '^[0-9]{12}$'
        THEN lg.details->>'ewbNumber'
      ELSE eb.ewb_number
    END,
    ewb_date = CASE
      WHEN lg.details->>'ewbDate' IS NOT NULL
        THEN (lg.details->>'ewbDate')::timestamptz
      ELSE eb.ewb_date
    END,
    valid_until = CASE
      WHEN lg.details->>'validUntil' IS NOT NULL
        THEN (lg.details->>'validUntil')::timestamptz
      ELSE eb.valid_until
    END,
    generated_at = COALESCE(eb.generated_at, lg.occurred_at),
    generated_by_user_id = COALESCE(eb.generated_by_user_id, lg.actor_user_id)
FROM latest_generation lg
WHERE eb.status = 'cancelled'
  AND lg.organisation_id = eb.organisation_id
  AND lg.entity_id = eb.id;

-- Older rows stored only normalized instants. Their exact portal wall clock
-- cannot be recovered, so use a deterministic India-time display and retain
-- the manual/legacy classification rather than pretending it came verbatim.
UPDATE eway_bills
SET ewb_date_text = COALESCE(
      ewb_date_text,
      to_char(ewb_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS')
    ),
    valid_until_text = COALESCE(
      valid_until_text,
      to_char(valid_until AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS')
    )
WHERE status <> 'draft';

UPDATE eway_bills
SET legacy_evidence_missing = true
WHERE status = 'cancelled'
  AND (ewb_number IS NULL OR ewb_date IS NULL OR valid_until IS NULL
       OR ewb_date_text IS NULL OR valid_until_text IS NULL
       OR generated_at IS NULL OR generated_by_user_id IS NULL);

UPDATE eway_bills
SET legacy_evidence_missing = true
WHERE status = 'generated'
  AND (ewb_number IS NULL OR ewb_date IS NULL OR valid_until IS NULL
       OR ewb_date_text IS NULL OR valid_until_text IS NULL
       OR generated_at IS NULL OR generated_by_user_id IS NULL);

ALTER TABLE eway_bills DROP CONSTRAINT eway_bills_generated_shape;

ALTER TABLE eway_bills
  ADD CONSTRAINT eway_bills_generated_shape CHECK (
    (status = 'draft'
      AND ewb_number IS NULL AND ewb_date IS NULL AND valid_until IS NULL
      AND generated_at IS NULL AND generated_by_user_id IS NULL
      AND legacy_evidence_missing = false)
    OR
    (status = 'generated'
      AND (
        (ewb_number IS NOT NULL AND ewb_date IS NOT NULL
         AND valid_until IS NOT NULL
         AND ewb_date_text IS NOT NULL AND valid_until_text IS NOT NULL
         AND generated_at IS NOT NULL AND generated_by_user_id IS NOT NULL
         AND legacy_evidence_missing = false)
        OR legacy_evidence_missing = true
      ))
    OR
    (status = 'cancelled'
      AND (
        (ewb_number IS NOT NULL AND ewb_date IS NOT NULL
         AND valid_until IS NOT NULL
         AND ewb_date_text IS NOT NULL AND valid_until_text IS NOT NULL
         AND generated_at IS NOT NULL AND generated_by_user_id IS NOT NULL
         AND legacy_evidence_missing = false)
        OR legacy_evidence_missing = true
      ))
  );

-- ---------------------------------------------------------------------------
-- 3. Provider operation ledger.  No raw request body, response wrapper,
-- token, SEK, password, client secret, or signed document is stored here.

CREATE TABLE statutory_provider_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  tax_invoice_id uuid,
  eway_bill_id uuid,
  provider text NOT NULL CHECK (provider = 'whitebooks'),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  operation text NOT NULL CHECK (operation IN (
    'register_irp', 'reconcile_irp', 'cancel_irp',
    'generate_eway_bill', 'reconcile_eway_bill', 'cancel_eway_bill'
  )),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  provider_code text
    CHECK (provider_code IS NULL
           OR length(provider_code) BETWEEN 1 AND 120),
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  created_by_user_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, correlation_id),
  FOREIGN KEY (organisation_id, tax_invoice_id)
    REFERENCES tax_invoices (organisation_id, id),
  FOREIGN KEY (organisation_id, eway_bill_id)
    REFERENCES eway_bills (organisation_id, id),
  CONSTRAINT statutory_provider_operations_target CHECK (
    (tax_invoice_id IS NOT NULL AND eway_bill_id IS NULL
      AND operation IN ('register_irp', 'reconcile_irp', 'cancel_irp'))
    OR
    (tax_invoice_id IS NULL AND eway_bill_id IS NOT NULL
      AND operation IN (
        'generate_eway_bill', 'reconcile_eway_bill', 'cancel_eway_bill'
      ))
  ),
  CONSTRAINT statutory_provider_operations_completion CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status <> 'pending' AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX statutory_provider_operations_one_pending_invoice
  ON statutory_provider_operations (organisation_id, tax_invoice_id)
  WHERE status = 'pending' AND tax_invoice_id IS NOT NULL;

CREATE UNIQUE INDEX statutory_provider_operations_one_pending_eway
  ON statutory_provider_operations (organisation_id, eway_bill_id)
  WHERE status = 'pending' AND eway_bill_id IS NOT NULL;

CREATE INDEX statutory_provider_operations_invoice_history
  ON statutory_provider_operations
    (organisation_id, tax_invoice_id, started_at DESC, id);

CREATE INDEX statutory_provider_operations_eway_history
  ON statutory_provider_operations
    (organisation_id, eway_bill_id, started_at DESC, id);

-- ---------------------------------------------------------------------------
-- 4. Parent freeze guards.  Provider evidence and render locations may be
-- appended after issue; the issued business facts themselves may not move.

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

CREATE TRIGGER tax_invoices_issued_update_guard
BEFORE UPDATE ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_issued_update();

CREATE OR REPLACE FUNCTION app_private.guard_eway_bill_issued_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF ROW(
      NEW.organisation_id, NEW.tax_invoice_id,
      NEW.transport_mode, NEW.transporter_id, NEW.transporter_name,
      NEW.vehicle_number, NEW.transport_doc_number, NEW.transport_doc_date,
      NEW.distance_km, NEW.from_pincode, NEW.to_pincode,
      NEW.ewb_number, NEW.ewb_date, NEW.valid_until,
      NEW.ewb_date_text, NEW.valid_until_text,
      NEW.legacy_evidence_missing,
      NEW.generated_at, NEW.generated_by_user_id,
      NEW.created_by_user_id, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.tax_invoice_id,
      OLD.transport_mode, OLD.transporter_id, OLD.transporter_name,
      OLD.vehicle_number, OLD.transport_doc_number, OLD.transport_doc_date,
      OLD.distance_km, OLD.from_pincode, OLD.to_pincode,
      OLD.ewb_number, OLD.ewb_date, OLD.valid_until,
      OLD.ewb_date_text, OLD.valid_until_text,
      OLD.legacy_evidence_missing,
      OLD.generated_at, OLD.generated_by_user_id,
      OLD.created_by_user_id, OLD.created_at
    ) THEN
      RAISE EXCEPTION 'generated e-way bill facts and NIC evidence are immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'cancelled e-way bills cannot be reopened'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'cancelled' AND ROW(
      NEW.cancelled_at, NEW.cancelled_by_user_id, NEW.cancellation_note
    ) IS DISTINCT FROM ROW(
      OLD.cancelled_at, OLD.cancelled_by_user_id, OLD.cancellation_note
    ) THEN
      RAISE EXCEPTION 'e-way bill local cancellation evidence is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.provider IS NOT NULL
       AND NEW.provider IS DISTINCT FROM OLD.provider THEN
      RAISE EXCEPTION 'e-way bill provider identity is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.provider_cancelled_at IS NOT NULL AND ROW(
      NEW.provider_cancelled_at, NEW.provider_cancelled_at_text,
      NEW.provider_cancel_reason_code, NEW.provider_cancel_remark
    ) IS DISTINCT FROM ROW(
      OLD.provider_cancelled_at, OLD.provider_cancelled_at_text,
      OLD.provider_cancel_reason_code, OLD.provider_cancel_remark
    ) THEN
      RAISE EXCEPTION 'e-way bill provider cancellation evidence is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.provider_state IS DISTINCT FROM OLD.provider_state
       AND NOT (
         (OLD.provider_state = 'not_requested'
          AND NEW.provider_state IN ('generating', 'generated'))
         OR (OLD.provider_state = 'generating'
          AND NEW.provider_state IN (
            'generated', 'generation_failed', 'generation_unknown'
          ))
         OR (OLD.provider_state IN (
               'generation_failed', 'generation_unknown'
             ) AND NEW.provider_state = 'generating')
         OR (OLD.provider_state = 'generated'
          AND NEW.provider_state IN (
            'cancelling', 'cancelled', 'cancellation_unknown'
          ))
         OR (OLD.provider_state = 'cancelling'
          AND NEW.provider_state IN (
            'generated', 'cancelled', 'cancellation_unknown'
          ))
         OR (OLD.provider_state = 'cancellation_unknown'
          AND NEW.provider_state = 'cancelled')
       ) THEN
      RAISE EXCEPTION 'invalid e-way bill provider-state transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER eway_bills_issued_update_guard
BEFORE UPDATE ON eway_bills
FOR EACH ROW EXECUTE FUNCTION app_private.guard_eway_bill_issued_update();

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
    NEW.provider, NEW.environment, NEW.operation, NEW.correlation_id,
    NEW.request_sha256, NEW.created_by_user_id, NEW.started_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.tax_invoice_id, OLD.eway_bill_id,
    OLD.provider, OLD.environment, OLD.operation, OLD.correlation_id,
    OLD.request_sha256, OLD.created_by_user_id, OLD.started_at
  ) THEN
    RAISE EXCEPTION 'statutory provider operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER statutory_provider_operations_update_guard
BEFORE UPDATE ON statutory_provider_operations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_statutory_operation_update();

-- Legal document dates cannot be future facts. Evaluate "today" in the
-- organisation's own timezone, matching the existing challan/MB guards.
CREATE OR REPLACE FUNCTION app_private.guard_billing_document_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  document_date date;
  organisation_today date;
BEGIN
  document_date := COALESCE(
    (to_jsonb(NEW)->>'invoice_date')::date,
    (to_jsonb(NEW)->>'bq_date')::date
  );
  SELECT (now() AT TIME ZONE o.timezone)::date
  INTO organisation_today
  FROM organisations o
  WHERE o.id = NEW.organisation_id;
  IF organisation_today IS NULL THEN
    RAISE EXCEPTION 'document organisation does not exist'
      USING ERRCODE = '23503';
  END IF;
  IF document_date > organisation_today THEN
    RAISE EXCEPTION '% date % is in the future (today is % in the organisation timezone)',
      TG_TABLE_NAME, document_date, organisation_today
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tax_invoices_date_guard
BEFORE INSERT OR UPDATE OF invoice_date ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_billing_document_date();

CREATE TRIGGER budgetary_quotations_date_guard
BEFORE INSERT OR UPDATE OF bq_date ON budgetary_quotations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_billing_document_date();

-- ---------------------------------------------------------------------------
-- 5. Tenant isolation and least privilege.

ALTER TABLE statutory_provider_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE statutory_provider_operations FORCE ROW LEVEL SECURITY;

CREATE POLICY statutory_provider_operations_tenant_policy
  ON statutory_provider_operations
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON statutory_provider_operations TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE ON tax_invoices TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON eway_bills TO auto_mb_app;
  END IF;
END
$$;
