-- Migration 0044: close statutory-evidence delete gaps, make reverse-charge
-- liability explicit, and retain every rendered tax-invoice PDF as evidence.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Reverse charge is a legal invoice fact. Historical issued rows stay NULL:
-- the missing fact must not be invented. New drafts can be saved while the
-- operator decides, but issuance accepts only an explicit forward-charge
-- confirmation because reverse-charge computation is not implemented yet.
ALTER TABLE tax_invoices
  ADD COLUMN reverse_charge_applicable boolean;

COMMENT ON COLUMN tax_invoices.reverse_charge_applicable IS
  'Operator-confirmed GST liability. FALSE means forward charge. NULL on a '
  'historical issued row means the fact was not captured and must not be inferred.';

CREATE OR REPLACE FUNCTION app_private.guard_tax_invoice_reverse_charge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft'
       AND NEW.reverse_charge_applicable IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'issuing a tax invoice requires explicit forward-charge confirmation'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'draft'
     AND NEW.reverse_charge_applicable IS DISTINCT FROM OLD.reverse_charge_applicable THEN
    RAISE EXCEPTION 'issued tax invoice reverse-charge evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'draft' AND NEW.status <> 'draft'
     AND NEW.reverse_charge_applicable IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'issuing a tax invoice requires explicit forward-charge confirmation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tax_invoices_reverse_charge_guard
BEFORE INSERT OR UPDATE ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_reverse_charge();

-- The application role still needs DELETE for genuine drafts. Enforce that
-- boundary in the database so route bugs or same-tenant raw SQL cannot erase
-- numbered statutory records or provider-attempt evidence.
CREATE OR REPLACE FUNCTION app_private.guard_tax_invoice_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'draft'
     OR OLD.irp_provider IS NOT NULL
     OR OLD.irp_provider_state <> 'not_requested'
     OR OLD.irn IS NOT NULL
     OR OLD.rendered_object_key IS NOT NULL
     OR OLD.rendered_sha256 IS NOT NULL
     OR OLD.template_version IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM tax_invoice_renders render
       WHERE render.organisation_id = OLD.organisation_id
         AND render.tax_invoice_id = OLD.id
     )
     OR EXISTS (
       SELECT 1 FROM statutory_provider_operations operation
       WHERE operation.organisation_id = OLD.organisation_id
         AND operation.tax_invoice_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'only a pristine draft tax invoice may be deleted'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER tax_invoices_delete_guard
BEFORE DELETE ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_delete();

CREATE OR REPLACE FUNCTION app_private.guard_eway_bill_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'draft'
     OR OLD.provider IS NOT NULL
     OR OLD.provider_state <> 'not_requested'
     OR OLD.ewb_number IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM statutory_provider_operations operation
       WHERE operation.organisation_id = OLD.organisation_id
         AND operation.eway_bill_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'only a pristine draft e-way bill may be deleted'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER eway_bills_delete_guard
BEFORE DELETE ON eway_bills
FOR EACH ROW EXECUTE FUNCTION app_private.guard_eway_bill_delete();

-- Every render is a retained version. The parent columns remain a convenient
-- pointer to the latest version for existing clients; this ledger is the
-- authoritative history and makes prior bytes exportable and auditable.
CREATE TABLE tax_invoice_renders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  tax_invoice_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  template_version text NOT NULL,
  template_contract_legacy boolean NOT NULL DEFAULT false,
  source_sha256 text
    CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  source_evidence_missing boolean NOT NULL DEFAULT false,
  object_key_scope_missing boolean NOT NULL DEFAULT false,
  logo_evidence_missing boolean NOT NULL DEFAULT false,
  logo_object_key text,
  logo_sha256 text
    CHECK (logo_sha256 IS NULL OR logo_sha256 ~ '^[0-9a-f]{64}$'),
  logo_media_type text
    CHECK (logo_media_type IS NULL OR logo_media_type IN ('image/png', 'image/jpeg')),
  object_key text NOT NULL,
  pdf_sha256 text NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, tax_invoice_id, version),
  FOREIGN KEY (organisation_id, tax_invoice_id)
    REFERENCES tax_invoices (organisation_id, id),
  CONSTRAINT tax_invoice_renders_source_evidence CHECK (
    (source_sha256 IS NULL) = source_evidence_missing
  ),
  CONSTRAINT tax_invoice_renders_template_contract CHECK (
    template_contract_legacy
    OR length(btrim(template_version)) BETWEEN 1 AND 50
  ),
  CONSTRAINT tax_invoice_renders_pdf_key_scope CHECK (
    object_key_scope_missing
    OR object_key LIKE (
         organisation_id::text || '/ti/' || tax_invoice_id::text || '-%.pdf'
       )
  ),
  CONSTRAINT tax_invoice_renders_logo_evidence CHECK (
    (logo_evidence_missing AND logo_object_key IS NULL
                           AND logo_sha256 IS NULL
                           AND logo_media_type IS NULL)
    OR
    (NOT logo_evidence_missing AND (
      (logo_object_key IS NULL AND logo_sha256 IS NULL AND logo_media_type IS NULL)
      OR
      (logo_object_key IS NOT NULL AND logo_sha256 IS NOT NULL
                                   AND logo_media_type IS NOT NULL)
    ))
  ),
  CONSTRAINT tax_invoice_renders_logo_key_scope CHECK (
    logo_object_key IS NULL
    OR
    (logo_media_type = 'image/png' AND logo_object_key LIKE (
      organisation_id::text || '/ti/' || tax_invoice_id::text || '-logo-%.png'
    ))
    OR
    (logo_media_type = 'image/jpeg' AND logo_object_key LIKE (
      organisation_id::text || '/ti/' || tax_invoice_id::text || '-logo-%.jpg'
    ))
  )
);

COMMENT ON TABLE tax_invoice_renders IS
  'Append-only history of rendered tax-invoice PDFs, including exact source '
  'and frozen-logo digests. Parent render columns point to the latest version.';

-- Defensive compatibility backfill. No released build created these pointers
-- before this migration, but development/restore databases may contain them.
-- Their PDF hash and key are preserved; unavailable source/logo provenance is
-- labelled rather than reconstructed.
INSERT INTO tax_invoice_renders (
  organisation_id, tax_invoice_id, version, template_version,
  template_contract_legacy, source_sha256, source_evidence_missing,
  object_key_scope_missing, logo_evidence_missing,
  object_key, pdf_sha256, created_by_user_id, created_at
)
SELECT organisation_id, id, 1, template_version,
       true, NULL, true,
       NOT (rendered_object_key LIKE (
         organisation_id::text || '/ti/' || id::text || '-%.pdf'
       )),
       true,
       rendered_object_key, rendered_sha256, created_by_user_id,
       COALESCE(submitted_at, created_at)
FROM tax_invoices
WHERE rendered_object_key IS NOT NULL;

CREATE OR REPLACE FUNCTION app_private.guard_tax_invoice_render_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'tax invoice render history is append-only'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER tax_invoice_renders_immutable_guard
BEFORE UPDATE OR DELETE ON tax_invoice_renders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_render_immutable();

CREATE OR REPLACE FUNCTION app_private.guard_tax_invoice_render_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_status text;
  expected_version integer;
BEGIN
  SELECT invoice.status INTO parent_status
  FROM tax_invoices invoice
  WHERE invoice.organisation_id = NEW.organisation_id
    AND invoice.id = NEW.tax_invoice_id
  FOR UPDATE;

  IF NOT FOUND OR parent_status <> 'submitted' THEN
    RAISE EXCEPTION 'render versions may be appended only to submitted tax invoices'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.template_contract_legacy
     OR NEW.source_evidence_missing
     OR NEW.source_sha256 IS NULL
     OR NEW.object_key_scope_missing
     OR NEW.logo_evidence_missing THEN
    RAISE EXCEPTION 'missing render provenance markers are reserved for compatibility backfill'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(MAX(render.version), 0)::integer + 1
  INTO expected_version
  FROM tax_invoice_renders render
  WHERE render.organisation_id = NEW.organisation_id
    AND render.tax_invoice_id = NEW.tax_invoice_id;

  IF NEW.version <> expected_version THEN
    RAISE EXCEPTION 'tax invoice render versions must be contiguous'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tax_invoice_renders_insert_guard
BEFORE INSERT ON tax_invoice_renders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_render_insert();

-- The compatibility columns may only advance to the newest retained version.
-- This prevents raw same-tenant SQL from making /pdf point at untracked bytes,
-- clearing issued evidence, or presenting an older render as current.
CREATE OR REPLACE FUNCTION app_private.guard_tax_invoice_render_pointer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  latest tax_invoice_renders%ROWTYPE;
BEGIN
  IF NEW.template_version IS NOT DISTINCT FROM OLD.template_version
     AND NEW.rendered_object_key IS NOT DISTINCT FROM OLD.rendered_object_key
     AND NEW.rendered_sha256 IS NOT DISTINCT FROM OLD.rendered_sha256 THEN
    RETURN NEW;
  END IF;

  IF NEW.template_version IS NULL
     OR NEW.rendered_object_key IS NULL
     OR NEW.rendered_sha256 IS NULL THEN
    RAISE EXCEPTION 'tax invoice render pointer cannot be cleared or partial'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status <> 'submitted' THEN
    RAISE EXCEPTION 'only a submitted tax invoice may advance its render pointer'
      USING ERRCODE = '23514';
  END IF;

  SELECT render.* INTO latest
  FROM tax_invoice_renders render
  WHERE render.organisation_id = NEW.organisation_id
    AND render.tax_invoice_id = NEW.id
  ORDER BY render.version DESC
  LIMIT 1;

  IF NOT FOUND
     OR NEW.template_version IS DISTINCT FROM latest.template_version
     OR NEW.rendered_object_key IS DISTINCT FROM latest.object_key
     OR NEW.rendered_sha256 IS DISTINCT FROM latest.pdf_sha256 THEN
    RAISE EXCEPTION 'tax invoice render pointer must match its latest retained version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tax_invoices_render_pointer_guard
BEFORE UPDATE OF template_version, rendered_object_key, rendered_sha256
ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_render_pointer();

CREATE OR REPLACE FUNCTION app_private.advance_tax_invoice_render_pointer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE tax_invoices
  SET template_version = NEW.template_version,
      rendered_object_key = NEW.object_key,
      rendered_sha256 = NEW.pdf_sha256
  WHERE organisation_id = NEW.organisation_id
    AND id = NEW.tax_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tax invoice render parent disappeared'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tax_invoice_renders_advance_pointer
AFTER INSERT ON tax_invoice_renders
FOR EACH ROW EXECUTE FUNCTION app_private.advance_tax_invoice_render_pointer();

ALTER TABLE tax_invoice_renders ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_invoice_renders FORCE ROW LEVEL SECURITY;

CREATE POLICY tax_invoice_renders_tenant_policy
  ON tax_invoice_renders
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT ON tax_invoice_renders TO auto_mb_app;
  END IF;
END
$$;
