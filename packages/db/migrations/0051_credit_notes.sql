SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0051: the credit note, and the supersession it performs
-- (finding 5's residue, docs/AUDIT-DISPOSITION-2026-08-10.md).
--
-- An invoice registered on the IRP more than 24 hours ago is permanently
-- uncancellable there — NIC's own contract: "You can cancel only past 24
-- hours of invoices". The lawful instrument after that window is a
-- credit note under CGST Section 34: itself an IRN document (DocTyp CRN,
-- the same INV-01 schema) for e-invoice-applicable taxpayers, with its
-- own 24-hour cancellation window and the same 30-day reporting rule
-- finding 20 modelled in 0049.
--
-- The shape settled with the owner (Option A): the credit note is FULL
-- VALUE — its money columns are copies of the invoice's, enforced below
-- — and issuing it SUPERSEDES the invoice: a terminal state alongside
-- cancelled that releases the invoice's Measurement Book for a corrected
-- invoice while every issued fact and every byte of IRN evidence stays
-- frozen. Section 34(2) as amended (effective October 2025) conditions
-- the supplier's tax reduction on the recipient reversing ITC; that fact
-- is RECORDABLE here (recipient_itc_status), never enforced, because the
-- recipient's books are not this system's to assert.

-- ---------------------------------------------------------------------
-- 1. The invoice learns 'superseded'.

ALTER TABLE tax_invoices DROP CONSTRAINT tax_invoices_status_check;
ALTER TABLE tax_invoices
  ADD CONSTRAINT tax_invoices_status_check
    CHECK (status IN ('draft', 'submitted', 'cancelled', 'superseded'));

COMMENT ON COLUMN tax_invoices.status IS
  'draft -> submitted -> cancelled | superseded. superseded means an '
  'issued credit note replaced this invoice in full; like cancelled it '
  'is terminal (reverting to submitted is permitted only while the '
  'credit note that caused it has itself been cancelled) and releases '
  'the Measurement Book.';

-- Supersession releases the Measurement Book exactly as cancellation
-- does: the one-live index stops seeing the superseded invoice, so a
-- corrected invoice can be raised against the same MB.
DROP INDEX tax_invoices_one_live_per_mb;
CREATE UNIQUE INDEX tax_invoices_one_live_per_mb
  ON tax_invoices (organisation_id, measurement_book_id)
  WHERE status NOT IN ('cancelled', 'superseded');

-- The 0035 MB-cancel guard must also stop counting a superseded invoice
-- as the thing that closes its Measurement Book.
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
       WHERE measurement_book_id = OLD.id
         AND status NOT IN ('cancelled', 'superseded')
    ) THEN
      RAISE EXCEPTION
        'measurement book % is closed by a tax invoice — cancel the invoice first',
        OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 2. The credit note itself.

CREATE TABLE credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  tax_invoice_id uuid NOT NULL,
  -- Denormalised from the invoice at draft time (NULL for a direct,
  -- MB-less invoice) so Work-scope checks and Work listings read one
  -- row; the insert guard pins it to the invoice's own work_id.
  work_id uuid,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'cancelled')),
  note_number text,
  sequence_number integer,
  fy_label text CHECK (fy_label IS NULL OR fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  note_date date NOT NULL,
  -- Section 34 requires the reason on the face of the document.
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  number_prefix text
    CHECK (number_prefix IS NULL OR number_prefix ~ '^[A-Z][A-Z0-9]{0,7}$'),
  -- FULL-VALUE money: copies of the superseded invoice's frozen columns,
  -- written at issue and proven equal by guard_credit_note_full_value().
  taxable_value numeric(18, 2) CHECK (taxable_value IS NULL OR taxable_value >= 0),
  cgst_amount numeric(18, 2) CHECK (cgst_amount IS NULL OR cgst_amount >= 0),
  sgst_amount numeric(18, 2) CHECK (sgst_amount IS NULL OR sgst_amount >= 0),
  igst_amount numeric(18, 2) CHECK (igst_amount IS NULL OR igst_amount >= 0),
  round_off numeric(18, 2)
    CHECK (round_off IS NULL OR (round_off > -0.50 AND round_off <= 0.50)),
  total_amount numeric(18, 2) CHECK (total_amount IS NULL OR total_amount >= 0),
  issued_snapshot jsonb,
  -- Section 34(2) as amended, effective October 2025: the supplier's tax
  -- reduction is conditional on the recipient reversing ITC. Recordable
  -- evidence, never an enforcement gate.
  recipient_itc_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (recipient_itc_status IN ('not_applicable', 'reversal_confirmed', 'pending')),
  -- The IRP lifecycle, axis for axis the invoice's (0041): the credit
  -- note is an IRN document of its own (DocTyp CRN).
  irp_provider text
    CHECK (irp_provider IS NULL OR irp_provider IN ('manual', 'whitebooks')),
  irp_provider_state text NOT NULL DEFAULT 'not_requested'
    CHECK (irp_provider_state IN (
      'not_requested', 'registering', 'registered',
      'registration_failed', 'registration_unknown',
      'cancelling', 'cancelled', 'cancellation_unknown'
    )),
  irn text CHECK (irn IS NULL OR irn ~ '^[0-9a-f]{64}$'),
  ack_number text,
  ack_date timestamptz,
  ack_date_text text
    CHECK (ack_date_text IS NULL OR (
      length(ack_date_text) BETWEEN 19 AND 25
      AND ack_date_text ~ '^([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}([zZ]|[+-][0-9]{2}:[0-9]{2})?|[0-9]{2}/[0-9]{2}/[0-9]{4}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})$'
    )),
  signed_qr text,
  signed_invoice text,
  irp_legacy_evidence_missing boolean NOT NULL DEFAULT false,
  irp_cancelled_at timestamptz,
  irp_cancelled_at_text text
    CHECK (irp_cancelled_at_text IS NULL OR (
      length(irp_cancelled_at_text) BETWEEN 19 AND 25
      AND irp_cancelled_at_text ~ '^([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}([zZ]|[+-][0-9]{2}:[0-9]{2})?|[0-9]{2}/[0-9]{2}/[0-9]{4}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})$'
    )),
  irp_cancel_reason_code text
    CHECK (irp_cancel_reason_code IS NULL OR irp_cancel_reason_code ~ '^[1-4]$'),
  irp_cancel_remark text
    CHECK (irp_cancel_remark IS NULL
           OR length(btrim(irp_cancel_remark)) BETWEEN 3 AND 2000),
  -- Finding 20's machinery, inherited (0049): stamped at ISSUE from the
  -- declaration then in force — the 30-day rule covers credit notes.
  irp_reporting_deadline date,
  -- The rendered document (0026's pairing rule).
  template_version text,
  rendered_object_key text,
  rendered_sha256 text
    CHECK (rendered_sha256 IS NULL OR rendered_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz,
  issued_by_user_id text,
  cancelled_at timestamptz,
  cancelled_by_user_id text,
  cancellation_note text,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, note_number),
  FOREIGN KEY (organisation_id, tax_invoice_id)
    REFERENCES tax_invoices (organisation_id, id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works (organisation_id, id),
  CONSTRAINT credit_notes_draft_shape CHECK (
    (status = 'draft'
      AND note_number IS NULL AND sequence_number IS NULL
      AND fy_label IS NULL
      AND taxable_value IS NULL AND cgst_amount IS NULL
      AND sgst_amount IS NULL AND igst_amount IS NULL
      AND round_off IS NULL AND total_amount IS NULL
      AND issued_snapshot IS NULL AND irp_reporting_deadline IS NULL
      AND issued_at IS NULL AND issued_by_user_id IS NULL)
    OR
    (status <> 'draft'
      AND note_number IS NOT NULL AND sequence_number IS NOT NULL
      AND fy_label IS NOT NULL
      AND taxable_value IS NOT NULL AND cgst_amount IS NOT NULL
      AND sgst_amount IS NOT NULL AND igst_amount IS NOT NULL
      AND round_off IS NOT NULL AND total_amount IS NOT NULL
      AND issued_snapshot IS NOT NULL
      AND issued_at IS NOT NULL AND issued_by_user_id IS NOT NULL)
  ),
  CONSTRAINT credit_notes_cancel_shape CHECK (
    (status = 'cancelled'
      AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
      AND cancellation_note IS NOT NULL
      AND length(btrim(cancellation_note)) BETWEEN 3 AND 2000)
    OR
    (status <> 'cancelled'
      AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
      AND cancellation_note IS NULL)
  ),
  CONSTRAINT credit_notes_split_coherence CHECK (
    status = 'draft'
    OR (igst_amount = 0 AND cgst_amount >= 0 AND sgst_amount >= 0)
    OR (igst_amount > 0 AND cgst_amount = 0 AND sgst_amount = 0)
  ),
  CONSTRAINT credit_notes_total_reconciles CHECK (
    status = 'draft'
    OR total_amount =
         taxable_value + cgst_amount + sgst_amount + igst_amount + round_off
  ),
  CONSTRAINT credit_notes_render_pair CHECK (
    (rendered_object_key IS NULL) = (rendered_sha256 IS NULL)
      AND (rendered_object_key IS NULL OR template_version IS NOT NULL)
  ),
  CONSTRAINT credit_notes_irp_provider_shape CHECK (
    (irp_provider_state = 'not_requested' AND irp_provider IS NULL)
    OR (irp_provider_state <> 'not_requested' AND irp_provider IS NOT NULL)
  ),
  CONSTRAINT credit_notes_irp_cancel_evidence_shape CHECK (
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
  ),
  CONSTRAINT credit_notes_irp_registration_evidence_shape CHECK (
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
  ),
  -- An IRN can only ever have been minted for an issued document.
  CONSTRAINT credit_notes_irp_needs_issue CHECK (
    irp_provider_state = 'not_requested' OR status <> 'draft'
  )
);

COMMENT ON TABLE credit_notes IS
  'The CGST Section 34 credit note: full value against one tax invoice, '
  'issuing it supersedes the invoice and releases its Measurement Book. '
  'An IRN document of its own (DocTyp CRN, positive values by NIC '
  'convention) with the invoice''s exact provider-evidence posture.';
COMMENT ON COLUMN credit_notes.reason IS
  'Why the note was issued — Section 34 requires it on the face of the document.';
COMMENT ON COLUMN credit_notes.recipient_itc_status IS
  'Section 34(2) as amended eff. Oct 2025: the supplier''s tax reduction '
  'is conditional on the recipient reversing ITC. Recorded, not enforced.';
COMMENT ON COLUMN credit_notes.irp_reporting_deadline IS
  'Frozen at issue from the organisation declaration then in force '
  '(0049): note_date + irp_reporting_window_days when a window applied. '
  'NULL means no window applied at issue.';

-- One live credit note per invoice, ever; cancelling one releases the
-- invoice for a corrected note (the invoice reverts to submitted in the
-- same transaction).
CREATE UNIQUE INDEX credit_notes_one_live_per_invoice
  ON credit_notes (organisation_id, tax_invoice_id)
  WHERE status <> 'cancelled';

CREATE INDEX credit_notes_invoice_history
  ON credit_notes (organisation_id, tax_invoice_id, created_at DESC, id);

CREATE INDEX credit_notes_work_idx
  ON credit_notes (organisation_id, work_id, status, note_date DESC, id);

-- Gap-free per (organisation, financial year), mirroring
-- tax_invoice_counters: GST rule 46A wants a consecutive serial unique
-- within the FY, and the counter row lock serialises concurrent issues.
CREATE TABLE credit_note_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  fy_label text NOT NULL CHECK (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (organisation_id, fy_label)
);

CREATE FUNCTION app_private.guard_credit_note_counter_decrease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION 'credit note counters must not decrease'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER credit_note_counters_guard_decrease
BEFORE UPDATE ON credit_note_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_credit_note_counter_decrease();

CREATE TRIGGER credit_notes_touch_updated_at
BEFORE UPDATE ON credit_notes
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. Cross-record guards.

-- A credit note is drafted against a SUBMITTED invoice of the same
-- organisation; the denormalised work_id must be the invoice's own.
-- SECURITY DEFINER like the 0035 cross-record guards: the read must not
-- depend on the caller's RLS binding.
CREATE FUNCTION app_private.guard_credit_note_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_work uuid;
BEGIN
  -- Tenant-scoped read (the 0046 review's rule for definer guards):
  -- the composite FK guarantees same-organisation rows, and this read
  -- must not leak another tenant's invoice state through error text.
  SELECT status, work_id INTO v_status, v_work
    FROM tax_invoices
   WHERE id = NEW.tax_invoice_id
     AND organisation_id = NEW.organisation_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'tax invoice % is missing', NEW.tax_invoice_id;
  END IF;
  IF v_status NOT IN ('submitted', 'superseded') THEN
    RAISE EXCEPTION
      'tax invoice % is % — a credit note supersedes a submitted invoice',
      NEW.tax_invoice_id, v_status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'draft' AND v_status <> 'submitted' THEN
    RAISE EXCEPTION
      'tax invoice % is already superseded — cancel the live credit note first',
      NEW.tax_invoice_id
      USING ERRCODE = '23514';
  END IF;
  IF v_work IS DISTINCT FROM NEW.work_id THEN
    RAISE EXCEPTION
      'credit note work_id must be the invoice''s own (% expected)',
      COALESCE(v_work::text, 'NULL')
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credit_notes_invoice_guard
BEFORE INSERT ON credit_notes
FOR EACH ROW EXECUTE FUNCTION app_private.guard_credit_note_invoice();

-- FULL VALUE, proven at the database: the moment a credit note becomes
-- issued its six money columns must equal the invoice's frozen ones.
CREATE FUNCTION app_private.guard_credit_note_full_value()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  invoice tax_invoices%ROWTYPE;
BEGIN
  IF NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    RETURN NEW; -- already issued; immutability is the update guard's job
  END IF;
  SELECT * INTO invoice FROM tax_invoices
   WHERE id = NEW.tax_invoice_id
     AND organisation_id = NEW.organisation_id;
  IF invoice.id IS NULL THEN
    RAISE EXCEPTION 'tax invoice % is missing', NEW.tax_invoice_id;
  END IF;
  IF ROW(
    NEW.taxable_value, NEW.cgst_amount, NEW.sgst_amount,
    NEW.igst_amount, NEW.round_off, NEW.total_amount
  ) IS DISTINCT FROM ROW(
    invoice.taxable_value, invoice.cgst_amount, invoice.sgst_amount,
    invoice.igst_amount, invoice.round_off, invoice.total_amount
  ) THEN
    RAISE EXCEPTION
      'credit note money must equal the superseded invoice''s frozen values in full'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credit_notes_full_value_guard
BEFORE INSERT OR UPDATE ON credit_notes
FOR EACH ROW EXECUTE FUNCTION app_private.guard_credit_note_full_value();

-- The credit note's own freeze, mirroring the 0041/0049 invoice posture:
-- issued facts immutable, cancelled terminal with immutable evidence,
-- IRP evidence append-once, provider identity immutable, the identical
-- provider-state transition matrix, and local cancel gated on a resolved
-- provider state. recipient_itc_status and the render columns are
-- lifecycle facts and stay mutable.
CREATE FUNCTION app_private.guard_credit_note_issued_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF ROW(
      NEW.organisation_id, NEW.tax_invoice_id, NEW.work_id,
      NEW.note_number, NEW.sequence_number, NEW.fy_label,
      NEW.note_date, NEW.reason, NEW.number_prefix,
      NEW.taxable_value, NEW.cgst_amount, NEW.sgst_amount,
      NEW.igst_amount, NEW.round_off, NEW.total_amount,
      NEW.issued_snapshot, NEW.irp_reporting_deadline,
      NEW.issued_at, NEW.issued_by_user_id,
      NEW.created_by_user_id, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.tax_invoice_id, OLD.work_id,
      OLD.note_number, OLD.sequence_number, OLD.fy_label,
      OLD.note_date, OLD.reason, OLD.number_prefix,
      OLD.taxable_value, OLD.cgst_amount, OLD.sgst_amount,
      OLD.igst_amount, OLD.round_off, OLD.total_amount,
      OLD.issued_snapshot, OLD.irp_reporting_deadline,
      OLD.issued_at, OLD.issued_by_user_id,
      OLD.created_by_user_id, OLD.created_at
    ) THEN
      RAISE EXCEPTION 'issued credit note business facts are immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'cancelled credit notes cannot be reopened'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'cancelled' AND ROW(
      NEW.cancelled_at, NEW.cancelled_by_user_id, NEW.cancellation_note
    ) IS DISTINCT FROM ROW(
      OLD.cancelled_at, OLD.cancelled_by_user_id, OLD.cancellation_note
    ) THEN
      RAISE EXCEPTION 'credit note cancellation evidence is immutable'
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
      RAISE EXCEPTION 'credit note IRP registration evidence is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.irp_provider IS NOT NULL
       AND NEW.irp_provider IS DISTINCT FROM OLD.irp_provider THEN
      RAISE EXCEPTION 'credit note IRP provider identity is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.irp_cancelled_at IS NOT NULL AND ROW(
      NEW.irp_cancelled_at, NEW.irp_cancelled_at_text,
      NEW.irp_cancel_reason_code, NEW.irp_cancel_remark
    ) IS DISTINCT FROM ROW(
      OLD.irp_cancelled_at, OLD.irp_cancelled_at_text,
      OLD.irp_cancel_reason_code, OLD.irp_cancel_remark
    ) THEN
      RAISE EXCEPTION 'credit note IRP cancellation evidence is immutable'
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
      RAISE EXCEPTION 'invalid credit note IRP provider-state transition'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'issued' AND NEW.status = 'cancelled'
       AND OLD.irp_provider_state NOT IN ('not_requested', 'cancelled') THEN
      RAISE EXCEPTION 'resolve provider registration/cancellation before cancelling the local credit note'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER credit_notes_issued_update_guard
BEFORE UPDATE ON credit_notes
FOR EACH ROW EXECUTE FUNCTION app_private.guard_credit_note_issued_update();

-- ---------------------------------------------------------------------
-- 4. The invoice guard learns supersession. Recreated ON TOP OF 0049's
-- text — the frozen-facts ROW (including irp_reporting_deadline), the
-- cancellation clauses, the IRP evidence clauses and the provider-state
-- matrix are verbatim from 0049. What is ADDED:
--
--   * submitted -> superseded is permitted only when an ISSUED credit
--     note exists for the invoice and no provider operation is
--     mid-flight; every issued fact and every byte of IRN evidence
--     stays frozen and is never cleared;
--   * superseded is terminal like cancelled, with ONE guarded exception:
--     superseded -> submitted, permitted only when NO issued credit note
--     remains (the note was cancelled in the same transaction) — the
--     one-live-per-MB index then decides whether the MB was re-invoiced
--     meanwhile;
--   * a draft can never be superseded.
--
-- The function becomes SECURITY DEFINER because the new clauses read
-- credit_notes across rows; the pinned search_path keeps that read safe,
-- and every pre-existing clause touches only OLD/NEW.

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

-- ---------------------------------------------------------------------
-- 5. Legal document dates cannot be future facts: the 0041 guard learns
-- the credit note's date column and gains a trigger on the new table.

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
    (to_jsonb(NEW)->>'bq_date')::date,
    (to_jsonb(NEW)->>'note_date')::date
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

CREATE TRIGGER credit_notes_date_guard
BEFORE INSERT OR UPDATE OF note_date ON credit_notes
FOR EACH ROW EXECUTE FUNCTION app_private.guard_billing_document_date();

-- ---------------------------------------------------------------------
-- 6. The provider operation ledger gains a third target.

ALTER TABLE statutory_provider_operations
  ADD COLUMN credit_note_id uuid,
  ADD FOREIGN KEY (organisation_id, credit_note_id)
    REFERENCES credit_notes (organisation_id, id);

ALTER TABLE statutory_provider_operations
  DROP CONSTRAINT statutory_provider_operations_operation_check;
ALTER TABLE statutory_provider_operations
  ADD CONSTRAINT statutory_provider_operations_operation_check
    CHECK (operation IN (
      'register_irp', 'reconcile_irp', 'cancel_irp',
      'generate_eway_bill', 'reconcile_eway_bill', 'cancel_eway_bill',
      'register_crn', 'reconcile_crn', 'cancel_crn'
    ));

ALTER TABLE statutory_provider_operations
  DROP CONSTRAINT statutory_provider_operations_target;
ALTER TABLE statutory_provider_operations
  ADD CONSTRAINT statutory_provider_operations_target CHECK (
    (tax_invoice_id IS NOT NULL AND eway_bill_id IS NULL
      AND credit_note_id IS NULL
      AND operation IN ('register_irp', 'reconcile_irp', 'cancel_irp'))
    OR
    (tax_invoice_id IS NULL AND eway_bill_id IS NOT NULL
      AND credit_note_id IS NULL
      AND operation IN (
        'generate_eway_bill', 'reconcile_eway_bill', 'cancel_eway_bill'
      ))
    OR
    (tax_invoice_id IS NULL AND eway_bill_id IS NULL
      AND credit_note_id IS NOT NULL
      AND operation IN ('register_crn', 'reconcile_crn', 'cancel_crn'))
  );

CREATE UNIQUE INDEX statutory_provider_operations_one_pending_credit_note
  ON statutory_provider_operations (organisation_id, credit_note_id)
  WHERE status = 'pending' AND credit_note_id IS NOT NULL;

CREATE INDEX statutory_provider_operations_credit_note_history
  ON statutory_provider_operations
    (organisation_id, credit_note_id, started_at DESC, id);

-- The operation identity freeze (0041) learns the new column; every
-- other clause is verbatim.
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
    NEW.request_sha256, NEW.created_by_user_id, NEW.started_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.tax_invoice_id, OLD.eway_bill_id,
    OLD.credit_note_id,
    OLD.provider, OLD.environment, OLD.operation, OLD.correlation_id,
    OLD.request_sha256, OLD.created_by_user_id, OLD.started_at
  ) THEN
    RAISE EXCEPTION 'statutory provider operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------
-- 7. Numbering under finding 8: 'credit_note' joins the configurable
-- document types, and the 0047 scope CHECK gains an EXPLICIT arm for it
-- — the old ELSE true would have silently exempted the new type, which
-- is the exact regression finding 8 was about. Preflight first, with the
-- fix named.

DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(
           format('organisation %s: %s template %L',
                  organisation_id, document_type, template),
           '; ')
    INTO offending
    FROM document_number_series
   WHERE document_type = 'credit_note'
     AND template NOT LIKE '%{FY%';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'credit note number templates lack their counter''s scope token: %s. '
        'Add {FY} or {FY2} to credit note templates, then rerun the upgrade.',
        offending);
  END IF;
END
$$;

ALTER TABLE document_number_series
  DROP CONSTRAINT document_number_series_document_type_check;
ALTER TABLE document_number_series
  ADD CONSTRAINT document_number_series_document_type_check
    CHECK (document_type IN (
      'delivery_challan', 'issue_challan', 'tax_invoice',
      'budgetary_quotation', 'credit_note'
    ));

ALTER TABLE document_number_series
  DROP CONSTRAINT document_number_series_scope;
ALTER TABLE document_number_series
  ADD CONSTRAINT document_number_series_scope CHECK (
    CASE document_type
      WHEN 'delivery_challan' THEN
        template LIKE '%{WORK%' OR template LIKE '%{PREFIX%'
      WHEN 'issue_challan' THEN
        template LIKE '%{WORK%' OR template LIKE '%{PREFIX%'
      WHEN 'tax_invoice' THEN
        template LIKE '%{FY%'
      WHEN 'credit_note' THEN
        template LIKE '%{FY%'
      ELSE true
    END
  );

-- ---------------------------------------------------------------------
-- 8. Tenant isolation and least privilege.

ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_note_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY credit_notes_tenant_policy ON credit_notes
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY credit_note_counters_tenant_policy ON credit_note_counters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    -- A draft credit note may be discarded; anything issued cancels
    -- instead (the routes and the issued-update guard enforce it).
    -- Counters never delete.
    GRANT SELECT, INSERT, UPDATE, DELETE ON credit_notes TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE ON credit_note_counters TO auto_mb_app;
  END IF;
END
$$;
