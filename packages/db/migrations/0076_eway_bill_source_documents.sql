-- Migration 0076: an e-way bill names exactly one source document.
--
-- 0035 built the e-way bill as a child of the tax invoice, because at the
-- time the tax invoice was the only document this product could move
-- goods with. ADR-0013 adds the second: a standalone Delivery Challan
-- carrying goods to a private customer, a vendor or a job worker is a
-- goods movement in its own right, and 0075 gave it the statutory facts
-- NIC requires.
--
-- So tax_invoice_id becomes nullable, delivery_challan_id joins it, and a
-- CHECK insists that exactly one of the two is set. Existing rows all name
-- an invoice and satisfy the new shape unchanged; there is no backfill.
--
-- What deliberately does NOT change: numbering (an e-way bill has no local
-- number — NIC's twelve digits are the only one it ever carries), RLS (the
-- policy keys on organisation_id and never looked at the source), the
-- immutability guard's posture, the provider-state machine, and the
-- provider-operation ledger (which keys on eway_bill_id). Those all key on
-- the BILL, so a second kind of parent costs them nothing. The one guard
-- that did read the source — 0035's insert guard — is restated below to
-- read whichever source the row names.
--
-- Where the applicability rule is NOT: this migration does not test
-- whether the source carries goods lines. ADR-0013 asks for that rule in
-- ONE place server-side, identical for both source kinds, and an invoice's
-- goods test reads a frozen JSON snapshot whose two template versions
-- shape their lines differently. Restating it here in SQL would be a
-- second implementation of a rule whose whole point is that there is one.
-- The structural facts below — a submitted invoice, an issued standalone
-- challan — are what the database can state exactly, so they are what it
-- states.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- 1. The second source, and the rule that there is only ever one.
-- ---------------------------------------------------------------------

ALTER TABLE eway_bills ALTER COLUMN tax_invoice_id DROP NOT NULL;

ALTER TABLE eway_bills ADD COLUMN delivery_challan_id uuid;

ALTER TABLE eway_bills
  ADD CONSTRAINT eway_bills_delivery_challan_fkey
  FOREIGN KEY (organisation_id, delivery_challan_id)
  REFERENCES delivery_challans (organisation_id, id);

-- Exactly one, never both, never neither: an e-way bill with no source
-- moves nothing, and one with two sources cannot say which document the
-- consignment travels under.
ALTER TABLE eway_bills
  ADD CONSTRAINT eway_bills_source_shape CHECK (
    (tax_invoice_id IS NOT NULL AND delivery_challan_id IS NULL)
    OR
    (tax_invoice_id IS NULL AND delivery_challan_id IS NOT NULL)
  );

-- One live bill per source document, the challan half of 0035's rule.
-- 0035's eway_bills_one_live_per_invoice needs no change and gets none:
-- its key column is NULL on every challan-sourced row, and NULLs never
-- collide in a unique index, so those rows self-exclude exactly the way
-- 0056's standalone challans self-excluded from the per-Work draft index.
CREATE UNIQUE INDEX eway_bills_one_live_per_challan
  ON eway_bills (organisation_id, delivery_challan_id)
  WHERE status <> 'cancelled';

-- The new foreign key must be indexable, and the index above cannot serve
-- referential integrity because it is partial (the standing rule in
-- packages/db/test/fk-index-coverage.integration.test.ts, itself 0046's
-- audit made permanent). This is the unconditional one.
CREATE INDEX eway_bills_challan_idx
  ON eway_bills (organisation_id, delivery_challan_id);

COMMENT ON COLUMN eway_bills.delivery_challan_id IS
  'The standalone Delivery Challan this bill moves, or NULL when the '
  'source is a tax invoice. Exactly one of the two is always set '
  '(ADR-0013).';

-- ---------------------------------------------------------------------
-- 2. The insert guard learns the second source.
--
-- 0035's rule was "an e-way bill moves a SUBMITTED invoice: a draft has no
-- legal number to move, and a cancelled one moves nothing". The same
-- sentence holds for the challan with its own vocabulary: an ISSUED
-- standalone challan. A draft challan has no number and may still change;
-- a cancelled one moves nothing; a work-scoped challan is not a movement
-- to an outside party at all, and ADR-0013 admits only the standalone.
--
-- SECURITY DEFINER, as 0035 wrote it, and therefore tenant-pinned by the
-- row's own organisation_id rather than by the session binding — the 0046
-- review found a definer guard reading across tenants once and it must
-- not come back. (0035's invoice read was pinned by primary key alone;
-- it gains the organisation predicate here for the same reason.)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.guard_eway_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_kind text;
BEGIN
  -- A row naming NEITHER source is the source CHECK's to refuse, and it
  -- says so in one sentence. Reaching the challan branch with a NULL id
  -- would answer "delivery challan <NULL> is missing", which describes
  -- the symptom rather than the rule.
  IF NEW.tax_invoice_id IS NULL AND NEW.delivery_challan_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.tax_invoice_id IS NOT NULL THEN
    SELECT status INTO v_status FROM tax_invoices
    WHERE organisation_id = NEW.organisation_id AND id = NEW.tax_invoice_id;
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'tax invoice % is missing', NEW.tax_invoice_id;
    END IF;
    IF v_status <> 'submitted' THEN
      RAISE EXCEPTION
        'tax invoice % is % — an e-way bill needs a submitted invoice',
        NEW.tax_invoice_id, v_status;
    END IF;
    RETURN NEW;
  END IF;

  SELECT status, challan_kind INTO v_status, v_kind FROM delivery_challans
  WHERE organisation_id = NEW.organisation_id AND id = NEW.delivery_challan_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'delivery challan % is missing', NEW.delivery_challan_id;
  END IF;
  IF v_kind <> 'standalone' THEN
    RAISE EXCEPTION
      'delivery challan % is a % challan — an e-way bill is raised from a standalone challan',
      NEW.delivery_challan_id, v_kind;
  END IF;
  IF v_status <> 'issued' THEN
    RAISE EXCEPTION
      'delivery challan % is % — an e-way bill needs an issued challan',
      NEW.delivery_challan_id, v_status;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. The source is issued-document business data.
--
-- The body below is 0041's VERBATIM plus delivery_challan_id in the
-- immutability row comparison. A generated e-way bill that could be
-- repointed at another document would be NIC evidence attached to a
-- movement it never described. Nothing else is touched: the reopening
-- refusal, the local and provider cancellation evidence, the provider
-- identity, and the whole provider-state transition whitelist are as
-- 0041 wrote them.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.guard_eway_bill_issued_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF ROW(
      NEW.organisation_id, NEW.tax_invoice_id, NEW.delivery_challan_id,
      NEW.transport_mode, NEW.transporter_id, NEW.transporter_name,
      NEW.vehicle_number, NEW.transport_doc_number, NEW.transport_doc_date,
      NEW.distance_km, NEW.from_pincode, NEW.to_pincode,
      NEW.ewb_number, NEW.ewb_date, NEW.valid_until,
      NEW.ewb_date_text, NEW.valid_until_text,
      NEW.legacy_evidence_missing,
      NEW.generated_at, NEW.generated_by_user_id,
      NEW.created_by_user_id, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.tax_invoice_id, OLD.delivery_challan_id,
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

-- ---------------------------------------------------------------------
-- 4. The printable e-way bill summary.
--
-- The tax invoice's render ledger (0044) is the precedent and this is its
-- smaller sibling: append-only, one row per render, the parent carrying a
-- pointer at the current version. The document is a CONVENIENCE PRINT —
-- the statutory original is the copy on the NIC portal, and the template
-- says so on its face — so it is deliberately thinner than
-- tax_invoice_renders: no logo freezing, no legacy-provenance columns,
-- no scope-missing markers, because none of that history exists here.
--
-- A render is possible only once the bill is GENERATED: before NIC
-- answers there is no e-way bill number, validity window, or evidence to
-- print, and printing a draft would produce a document that looks
-- statutory and is not.
-- ---------------------------------------------------------------------

CREATE TABLE eway_bill_renders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  eway_bill_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  template_version text NOT NULL
    CHECK (length(btrim(template_version)) BETWEEN 1 AND 40),
  source_sha256 sha256_hex NOT NULL,
  object_key text NOT NULL CHECK (length(btrim(object_key)) BETWEEN 1 AND 400),
  pdf_sha256 sha256_hex NOT NULL,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, eway_bill_id, version),
  FOREIGN KEY (organisation_id, eway_bill_id)
    REFERENCES eway_bills (organisation_id, id),
  -- The stored object must sit under the organisation's own prefix, so a
  -- key can never be forged to read another tenant's bytes. Same shape as
  -- 0044's tax_invoice_renders_pdf_key_scope.
  CONSTRAINT eway_bill_renders_pdf_key_scope CHECK (
    object_key LIKE organisation_id::text || '/ewb/%'
  )
);

COMMENT ON TABLE eway_bill_renders IS
  'Append-only history of printable e-way bill summaries. A convenience '
  'print of facts this module already holds; the NIC portal document '
  'remains the statutory original.';

CREATE INDEX eway_bill_renders_bill_idx
  ON eway_bill_renders (organisation_id, eway_bill_id, version DESC);

ALTER TABLE eway_bills
  ADD COLUMN rendered_object_key text,
  ADD COLUMN rendered_sha256 sha256_hex,
  ADD COLUMN rendered_version integer CHECK (
    rendered_version IS NULL OR rendered_version > 0
  );

-- The three pointer columns arrive together or not at all: half a pointer
-- names bytes nobody can verify.
ALTER TABLE eway_bills
  ADD CONSTRAINT eway_bills_render_pointer_shape CHECK (
    (rendered_object_key IS NULL AND rendered_sha256 IS NULL
      AND rendered_version IS NULL)
    OR
    (rendered_object_key IS NOT NULL AND rendered_sha256 IS NOT NULL
      AND rendered_version IS NOT NULL)
  );

-- Append-only: a render that could be edited or deleted is not evidence
-- of what was printed. 0044's tax_invoice_renders_immutable_guard, said
-- again for this table.
CREATE FUNCTION app_private.guard_eway_bill_render_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'e-way bill renders are append-only'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER eway_bill_renders_immutable_guard
BEFORE UPDATE OR DELETE ON eway_bill_renders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_eway_bill_render_immutable();

-- A render belongs to a GENERATED bill and its versions are contiguous
-- from one, so "version 3" always means "the third print of this bill"
-- and never "the third that happened to survive".
CREATE FUNCTION app_private.guard_eway_bill_render_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_previous integer;
BEGIN
  SELECT status INTO v_status FROM eway_bills
  WHERE organisation_id = NEW.organisation_id AND id = NEW.eway_bill_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'e-way bill % is missing', NEW.eway_bill_id
      USING ERRCODE = '23514';
  END IF;
  IF v_status = 'draft' THEN
    RAISE EXCEPTION
      'a draft e-way bill has no NIC facts to print'
      USING ERRCODE = '23514';
  END IF;

  SELECT max(version) INTO v_previous FROM eway_bill_renders
  WHERE organisation_id = NEW.organisation_id AND eway_bill_id = NEW.eway_bill_id;
  IF NEW.version IS DISTINCT FROM COALESCE(v_previous, 0) + 1 THEN
    RAISE EXCEPTION
      'e-way bill render versions are contiguous from one (expected %, got %)',
      COALESCE(v_previous, 0) + 1, NEW.version
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER eway_bill_renders_insert_guard
BEFORE INSERT ON eway_bill_renders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_eway_bill_render_insert();

-- Tenant isolation and least privilege for the new table. Renders are
-- append-only for the application role too: SELECT and INSERT, nothing
-- else, exactly as 0044 granted tax_invoice_renders.
ALTER TABLE eway_bill_renders ENABLE ROW LEVEL SECURITY;
ALTER TABLE eway_bill_renders FORCE ROW LEVEL SECURITY;

CREATE POLICY eway_bill_renders_tenant_policy
  ON eway_bill_renders
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT ON eway_bill_renders TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 5. The RLS posture 0003 asserts at catalog level still holds.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  unprotected_count integer;
BEGIN
  SELECT count(*) INTO unprotected_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname <> 'schema_migrations'
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected_count > 0 THEN
    RAISE EXCEPTION
      'every public table except schema_migrations must have RLS enabled and forced';
  END IF;
END
$$;
