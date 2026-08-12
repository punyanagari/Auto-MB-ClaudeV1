-- Migration 0045: close remaining audit findings around procurement parent
-- immutability, draft scope, record-MB shape, and merge provenance.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- A record MB without a consignee cannot be routed or uniquely reserved; a
-- billing MB carrying one is equally ambiguous. Existing route-created rows
-- already satisfy this. Fail with an actionable preflight if raw legacy SQL did
-- not, rather than silently inventing a consignee.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM measurement_books
    WHERE (kind = 'record') IS DISTINCT FROM (consignee_contact_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      '0045 requires every record Measurement Book to name a consignee and every billing Measurement Book to omit it; repair legacy rows before migrating'
      USING ERRCODE = '23514';
  END IF;
END
$$;

ALTER TABLE measurement_books
  ADD CONSTRAINT measurement_books_record_consignee_shape CHECK (
    (kind = 'record') = (consignee_contact_id IS NOT NULL)
  );

-- Different vendors may legitimately have drafts on the same Work. Retain the
-- useful duplicate-draft protection only at the actual business key.
DROP INDEX purchase_orders_one_draft_per_work;
CREATE UNIQUE INDEX purchase_orders_one_draft_per_work_vendor
  ON purchase_orders (organisation_id, work_id, vendor_contact_id)
  WHERE status = 'draft';

-- Parent legal facts freeze with issue, just as their line rows already do.
-- PO lifecycle columns may advance issued -> closed/cancelled, and a closed PO
-- may return to issued only when released receipt evidence reopens its balance.
CREATE OR REPLACE FUNCTION app_private.guard_purchase_order_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'issued') THEN
      RAISE EXCEPTION 'a draft purchase order may only remain draft or be issued'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.id, NEW.organisation_id, NEW.work_id, NEW.vendor_contact_id,
    NEW.po_number, NEW.sequence_number, NEW.po_date, NEW.expected_on,
    NEW.terms, NEW.vendor_snapshot, NEW.total_amount,
    NEW.issued_at, NEW.issued_by_user_id, NEW.created_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.organisation_id, OLD.work_id, OLD.vendor_contact_id,
    OLD.po_number, OLD.sequence_number, OLD.po_date, OLD.expected_on,
    OLD.terms, OLD.vendor_snapshot, OLD.total_amount,
    OLD.issued_at, OLD.issued_by_user_id, OLD.created_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'issued purchase order business data is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'issued' AND NEW.status NOT IN ('issued', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'issued purchase order lifecycle transition is invalid'
      USING ERRCODE = '23514';
  ELSIF OLD.status = 'closed' THEN
    IF NEW.status NOT IN ('closed', 'issued') THEN
      RAISE EXCEPTION 'closed purchase order may only remain closed or reopen to issued'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'closed'
       AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
      RAISE EXCEPTION 'closed purchase order evidence is immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'cancelled' THEN
    IF ROW(
      NEW.status, NEW.closed_at, NEW.cancelled_at,
      NEW.cancelled_by_user_id, NEW.cancellation_note
    ) IS DISTINCT FROM ROW(
      OLD.status, OLD.closed_at, OLD.cancelled_at,
      OLD.cancelled_by_user_id, OLD.cancellation_note
    ) THEN
      RAISE EXCEPTION 'cancelled purchase order is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER purchase_orders_update_guard
BEFORE UPDATE ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_purchase_order_update();

CREATE OR REPLACE FUNCTION app_private.guard_budgetary_quotation_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'issued') THEN
      RAISE EXCEPTION 'a draft budgetary quotation may only remain draft or be issued'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.id, NEW.organisation_id, NEW.customer_contact_id, NEW.addressed_to,
    NEW.subject, NEW.bq_number, NEW.sequence_number, NEW.bq_date,
    NEW.valid_until, NEW.notes, NEW.customer_snapshot, NEW.total_amount,
    NEW.issued_at, NEW.issued_by_user_id, NEW.created_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.organisation_id, OLD.customer_contact_id, OLD.addressed_to,
    OLD.subject, OLD.bq_number, OLD.sequence_number, OLD.bq_date,
    OLD.valid_until, OLD.notes, OLD.customer_snapshot, OLD.total_amount,
    OLD.issued_at, OLD.issued_by_user_id, OLD.created_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'issued budgetary quotation business data is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'issued' THEN
    IF NEW.status NOT IN ('issued', 'expired', 'converted', 'withdrawn') THEN
      RAISE EXCEPTION 'issued budgetary quotation lifecycle transition is invalid'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'terminal budgetary quotation cannot be reopened'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER budgetary_quotations_update_guard
BEFORE UPDATE ON budgetary_quotations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_budgetary_quotation_update();

-- Operational unmerge provenance belongs in constrained tenant data, not in
-- audit JSON. One row per record/source is normalized; a NULL source pair is a
-- membership sentinel for a selected record that had no source of its own.
CREATE TABLE measurement_book_merge_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  target_measurement_book_id uuid NOT NULL,
  record_measurement_book_id uuid NOT NULL,
  work_id uuid NOT NULL,
  source_type text CHECK (
    source_type IS NULL
    OR source_type IN ('delivery_challan', 'installation', 'pac_certificate')
  ),
  source_id uuid,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, target_measurement_book_id)
    REFERENCES measurement_books (organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, record_measurement_book_id)
    REFERENCES measurement_books (organisation_id, id),
  FOREIGN KEY (organisation_id, work_id)
    REFERENCES works (organisation_id, id),
  CONSTRAINT measurement_book_merge_distinct_books CHECK (
    target_measurement_book_id <> record_measurement_book_id
  ),
  CONSTRAINT measurement_book_merge_source_pair CHECK (
    (source_type IS NULL) = (source_id IS NULL)
  )
);

CREATE UNIQUE INDEX measurement_book_merge_provenance_identity
  ON measurement_book_merge_provenance (
    organisation_id, target_measurement_book_id, record_measurement_book_id,
    source_type, source_id
  ) NULLS NOT DISTINCT;

-- One transferred source belonged to exactly one record before the merge.
-- This also prevents a compromised app-role session from making un-merge
-- fail later by assigning the same target claim to two records.
CREATE UNIQUE INDEX measurement_book_merge_provenance_source_owner
  ON measurement_book_merge_provenance (
    organisation_id, target_measurement_book_id, source_type, source_id
  )
  WHERE source_id IS NOT NULL;

CREATE INDEX measurement_book_merge_provenance_target_idx
  ON measurement_book_merge_provenance (
    organisation_id, target_measurement_book_id, record_measurement_book_id
  );

-- Backfill any live pre-0045 merge from the audit payload that the old route
-- wrote atomically with the merge. Refuse the upgrade when that evidence is
-- absent or malformed rather than guessing source ownership.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM measurement_books record
    WHERE record.kind = 'record' AND record.status = 'merged'
      AND NOT EXISTS (
        SELECT 1
        FROM audit_events event
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(event.details->'records') = 'array'
            THEN event.details->'records' ELSE '[]'::jsonb END
        ) member
        WHERE event.organisation_id = record.organisation_id
          AND event.action = 'measurement_book.merged'
          AND event.entity_type = 'measurement_books'
          AND event.entity_id = record.merged_into_id
          AND member->>'recordMbId' = record.id::text
      )
  ) THEN
    RAISE EXCEPTION
      '0045 cannot prove merge provenance for every live merged record Measurement Book; repair the merge audit evidence before migrating'
      USING ERRCODE = '23514';
  END IF;
END
$$;

WITH live_records AS (
  SELECT record.organisation_id, record.work_id,
         record.id AS record_measurement_book_id,
         record.merged_into_id AS target_measurement_book_id,
         record.created_by_user_id
  FROM measurement_books record
  WHERE record.kind = 'record' AND record.status = 'merged'
), merge_entries AS (
  SELECT live.*, event.actor_user_id, event.occurred_at, member
  FROM live_records live
  CROSS JOIN LATERAL (
    SELECT audit.actor_user_id, audit.occurred_at, audit.details
    FROM audit_events audit
    WHERE audit.organisation_id = live.organisation_id
      AND audit.action = 'measurement_book.merged'
      AND audit.entity_type = 'measurement_books'
      AND audit.entity_id = live.target_measurement_book_id
    ORDER BY audit.occurred_at DESC, audit.id DESC
    LIMIT 1
  ) event
  CROSS JOIN LATERAL jsonb_array_elements(event.details->'records') member
  WHERE member->>'recordMbId' = live.record_measurement_book_id::text
), expanded AS (
  SELECT entry.*, source
  FROM merge_entries entry
  LEFT JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(entry.member->'sources') = 'array'
      THEN entry.member->'sources' ELSE '[]'::jsonb END
  ) source ON true
)
INSERT INTO measurement_book_merge_provenance (
  organisation_id, target_measurement_book_id, record_measurement_book_id,
  work_id, source_type, source_id, created_by_user_id, created_at
)
SELECT organisation_id, target_measurement_book_id, record_measurement_book_id,
       work_id, source->>'sourceType', (source->>'sourceId')::uuid,
       COALESCE(actor_user_id, created_by_user_id), occurred_at
FROM expanded;

CREATE OR REPLACE FUNCTION app_private.guard_measurement_book_merge_provenance_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_book measurement_books%ROWTYPE;
  record_book measurement_books%ROWTYPE;
BEGIN
  SELECT * INTO target_book FROM measurement_books
  WHERE organisation_id = NEW.organisation_id
    AND id = NEW.target_measurement_book_id;
  SELECT * INTO record_book FROM measurement_books
  WHERE organisation_id = NEW.organisation_id
    AND id = NEW.record_measurement_book_id;

  IF target_book.id IS NULL OR target_book.work_id <> NEW.work_id
     OR target_book.kind <> 'on_account' OR target_book.status <> 'draft'
     OR record_book.id IS NULL OR record_book.work_id <> NEW.work_id
     OR record_book.kind <> 'record' OR record_book.status <> 'draft'
     OR record_book.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'measurement book merge provenance must be captured from a live record draft'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_type IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mb_sources source
    WHERE source.measurement_book_id = NEW.record_measurement_book_id
      AND source.work_id = NEW.work_id
      AND source.source_type = NEW.source_type
      AND source.source_id = NEW.source_id
      AND source.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'merge provenance source is not claimed by its record Measurement Book'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_type IS NULL AND EXISTS (
    SELECT 1 FROM mb_sources source
    WHERE source.measurement_book_id = NEW.record_measurement_book_id
      AND source.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a merge provenance sentinel requires a source-free record'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_type IS NULL AND EXISTS (
    SELECT 1 FROM measurement_book_merge_provenance provenance
    WHERE provenance.organisation_id = NEW.organisation_id
      AND provenance.target_measurement_book_id = NEW.target_measurement_book_id
      AND provenance.record_measurement_book_id = NEW.record_measurement_book_id
      AND provenance.source_type IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a merge provenance sentinel cannot accompany source rows'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.source_type IS NOT NULL AND EXISTS (
    SELECT 1 FROM measurement_book_merge_provenance provenance
    WHERE provenance.organisation_id = NEW.organisation_id
      AND provenance.target_measurement_book_id = NEW.target_measurement_book_id
      AND provenance.record_measurement_book_id = NEW.record_measurement_book_id
      AND provenance.source_type IS NULL
  ) THEN
    RAISE EXCEPTION 'merge provenance source rows cannot accompany a sentinel'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER measurement_book_merge_provenance_insert_guard
BEFORE INSERT ON measurement_book_merge_provenance
FOR EACH ROW EXECUTE FUNCTION app_private.guard_measurement_book_merge_provenance_insert();

CREATE OR REPLACE FUNCTION app_private.guard_measurement_book_merge_provenance_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'measurement book merge provenance is append-only'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER measurement_book_merge_provenance_mutation_guard
BEFORE UPDATE ON measurement_book_merge_provenance
FOR EACH ROW EXECUTE FUNCTION app_private.guard_measurement_book_merge_provenance_mutation();

CREATE TRIGGER measurement_book_merge_provenance_truncate_guard
BEFORE TRUNCATE ON measurement_book_merge_provenance
FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_measurement_book_merge_provenance_mutation();

ALTER TABLE measurement_book_merge_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_book_merge_provenance FORCE ROW LEVEL SECURITY;

CREATE POLICY measurement_book_merge_provenance_tenant_policy
  ON measurement_book_merge_provenance
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT ON measurement_book_merge_provenance TO auto_mb_app;
  END IF;
END
$$;
