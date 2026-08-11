-- Optional contract-source documents attached to one LOA intake package.
-- They reuse loa_documents' private-object, hash, RLS and audit boundary;
-- parser output remains proposal evidence and cannot create Work data directly.

ALTER TABLE loa_documents
  ADD COLUMN document_kind text NOT NULL DEFAULT 'loa',
  ADD COLUMN parent_loa_document_id uuid,
  ADD COLUMN match_status text NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN identity_match jsonb;

ALTER TABLE loa_documents
  ADD CONSTRAINT loa_documents_document_kind_check
  CHECK (document_kind IN (
    'loa', 'nit', 'contract_agreement', 'tender_specification'
  )),
  ADD CONSTRAINT loa_documents_match_status_check
  CHECK (match_status IN ('not_applicable', 'matched')),
  ADD CONSTRAINT loa_documents_source_shape_check
  CHECK (
    (
      document_kind = 'loa'
      AND parent_loa_document_id IS NULL
      AND match_status = 'not_applicable'
      AND identity_match IS NULL
    )
    OR
    (
      document_kind <> 'loa'
      AND parent_loa_document_id IS NOT NULL
      AND match_status = 'matched'
      AND jsonb_typeof(identity_match) = 'object'
    )
  ),
  ADD CONSTRAINT loa_documents_parent_same_tenant_fk
  FOREIGN KEY (organisation_id, parent_loa_document_id)
  REFERENCES loa_documents(organisation_id, id);

CREATE INDEX loa_documents_parent_kind_idx
  ON loa_documents (
    organisation_id, parent_loa_document_id, document_kind, created_at, id
  )
  WHERE parent_loa_document_id IS NOT NULL;

CREATE FUNCTION app_private.guard_contract_source_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_kind text;
BEGIN
  IF NEW.document_kind <> 'loa' THEN
    SELECT document_kind
    INTO parent_kind
    FROM loa_documents
    WHERE organisation_id = NEW.organisation_id
      AND id = NEW.parent_loa_document_id;

    IF parent_kind IS DISTINCT FROM 'loa' THEN
      RAISE EXCEPTION 'supporting contract documents must reference an LOA in the same organisation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(
    NEW.organisation_id,
    NEW.object_key,
    NEW.original_filename,
    NEW.sha256,
    NEW.media_type,
    NEW.size_bytes,
    NEW.uploaded_by_user_id,
    NEW.document_kind,
    NEW.parent_loa_document_id,
    NEW.match_status,
    NEW.identity_match
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id,
    OLD.object_key,
    OLD.original_filename,
    OLD.sha256,
    OLD.media_type,
    OLD.size_bytes,
    OLD.uploaded_by_user_id,
    OLD.document_kind,
    OLD.parent_loa_document_id,
    OLD.match_status,
    OLD.identity_match
  ) THEN
    RAISE EXCEPTION 'uploaded contract-source identity and bytes are immutable';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER loa_documents_contract_source_guard
BEFORE INSERT OR UPDATE ON loa_documents
FOR EACH ROW EXECUTE FUNCTION app_private.guard_contract_source_document();
