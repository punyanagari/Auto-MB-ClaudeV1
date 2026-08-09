SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Wave 5: v1 legacy-data cutover provenance. Two tenant tables record
-- what the operational importer (scripts/import-v1.ts) did:
--
--   import_batches  — one row per organisation per importer run: which
--                     input (sha256 digest), which importer version, when,
--                     dry-run or apply, and the full reconciliation report
--                     the run printed.
--   import_records  — one row per imported business row, keyed by the
--                     source identity (entity_type, source_system,
--                     source_id) per organisation. target_id points at the
--                     row the import created; payload_fingerprint is the
--                     sha256 of the source row's canonical JSON; payload
--                     carries the v1 facts that have no target column
--                     (free-text completion periods, v1 estimate rates,
--                     variation trails, warranty quantities, ...).
--
-- Idempotency / re-run model (documented decision): provenance rows are
-- APPEND-ONLY. A re-run matches each source row against import_records;
-- when the stored payload_fingerprint equals the recomputed one the row is
-- a no-op, and when it differs the row is reported as DRIFT in the
-- reconciliation report and left untouched — nothing is repaired
-- silently, and nothing ever updates or deletes a provenance row. The
-- application role therefore holds SELECT and INSERT only. The importer
-- itself runs as the database administrator role (it is an operational
-- tool, not application code), which also finalises import_batches
-- (finished_at, reconciliation) before commit.
--
-- The organisation export (export-v5) is deliberately unchanged:
-- import provenance is operator/audit data about the cutover, not
-- organisation business data, and the export format stays pinned.

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  source_system text NOT NULL DEFAULT 'auto-mb-v1'
    CHECK (length(btrim(source_system)) BETWEEN 1 AND 100),
  importer_version text NOT NULL CHECK (length(btrim(importer_version)) BETWEEN 1 AND 100),
  -- sha256 over the source backup bytes plus the canonical mapping JSON:
  -- proves WHICH input a batch imported.
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  operator_note text CHECK (operator_note IS NULL OR length(operator_note) <= 2000),
  dry_run boolean NOT NULL DEFAULT false,
  -- The reconciliation report for this organisation, verbatim as printed.
  reconciliation jsonb,
  UNIQUE (organisation_id, id),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE import_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  entity_type text NOT NULL CHECK (length(btrim(entity_type)) BETWEEN 2 AND 100),
  source_system text NOT NULL DEFAULT 'auto-mb-v1'
    CHECK (length(btrim(source_system)) BETWEEN 1 AND 100),
  source_id text NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 300),
  target_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Source facts without a target column; '{}' when everything mapped.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, entity_type, source_system, source_id),
  FOREIGN KEY (organisation_id, batch_id)
    REFERENCES import_batches(organisation_id, id)
);

CREATE INDEX import_records_batch_idx
  ON import_records (organisation_id, batch_id, entity_type);
CREATE INDEX import_records_target_idx
  ON import_records (organisation_id, target_id);

-- RLS: tenant policy, enabled and forced like every tenant table.
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE import_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_records FORCE ROW LEVEL SECURITY;

CREATE POLICY import_batches_tenant_policy ON import_batches
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY import_records_tenant_policy ON import_records
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- Grants: append-only for the application role — provenance is a ledger.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT ON import_batches, import_records TO auto_mb_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON import_batches, import_records FROM auto_mb_app;
  END IF;
END
$$;
