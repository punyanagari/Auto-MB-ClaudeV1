SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 7: the lawful correction paths for ISSUED documents. The
-- Milestone 6 approval engine (0012) extends to issued Delivery and Issue
-- Challans: an evidence-free issued challan is corrected by an
-- approval-gated cancel-and-replace (the original cancels with a note
-- referencing the approval; a replacement draft carries provenance and
-- re-issues under the normal numbering discipline), while a challan whose
-- cancellation is lawfully blocked by downstream evidence gets a numbered
-- correction notice — an adjustment document that preserves the original,
-- exactly as migration 0008 promised. The issued snapshot is NEVER edited.

-- 1. The approval engine admits the three correction request types.
ALTER TABLE approval_requests
  DROP CONSTRAINT approval_requests_entity_type_check;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_entity_type_check
  CHECK (entity_type IN (
    'work_item_amendment',
    'challan_cancel_replace',
    'issue_challan_cancel_replace',
    'challan_correction_notice'
  ));

-- One pending CORRECTION per delivery challan across both correction
-- paths: the 0012 one-pending index keys on entity_type, so without this a
-- cancel-and-replace and a correction notice could be pending against the
-- same challan at once. (Work-item amendments and issue-challan requests
-- live in different id spaces, so they never collide here.)
CREATE UNIQUE INDEX approval_requests_one_pending_correction_per_challan
  ON approval_requests (organisation_id, entity_id)
  WHERE status = 'pending'
    AND entity_type IN ('challan_cancel_replace', 'challan_correction_notice');

-- 2. Replacement provenance: a draft created by an approved
-- cancel-and-replace names the cancelled document it supersedes. The
-- reference is org-paired and can never point at the row itself.
ALTER TABLE delivery_challans
  ADD COLUMN replaces_challan_id uuid,
  ADD CONSTRAINT delivery_challans_replaces_fk
    FOREIGN KEY (organisation_id, replaces_challan_id)
    REFERENCES delivery_challans(organisation_id, id),
  ADD CONSTRAINT delivery_challans_replaces_not_self_check
    CHECK (replaces_challan_id IS NULL OR replaces_challan_id <> id);

ALTER TABLE issue_challans
  ADD COLUMN replaces_issue_challan_id uuid,
  ADD CONSTRAINT issue_challans_replaces_fk
    FOREIGN KEY (organisation_id, replaces_issue_challan_id)
    REFERENCES issue_challans(organisation_id, id),
  ADD CONSTRAINT issue_challans_replaces_not_self_check
    CHECK (replaces_issue_challan_id IS NULL OR replaces_issue_challan_id <> id);

-- Provenance freezes with the document: the 0001/0014 immutability guards
-- enumerate their frozen columns, so the new columns get their own guards.
CREATE FUNCTION app_private.guard_challan_replaces_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.replaces_challan_id IS DISTINCT FROM OLD.replaces_challan_id
    AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'replacement provenance is immutable once the Delivery Challan leaves draft';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER delivery_challans_replaces_guard
BEFORE UPDATE ON delivery_challans
FOR EACH ROW EXECUTE FUNCTION app_private.guard_challan_replaces_provenance();

CREATE FUNCTION app_private.guard_issue_challan_replaces_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.replaces_issue_challan_id IS DISTINCT FROM OLD.replaces_issue_challan_id
    AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'replacement provenance is immutable once the Issue Challan leaves draft';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER issue_challans_replaces_guard
BEFORE UPDATE ON issue_challans
FOR EACH ROW EXECUTE FUNCTION app_private.guard_issue_challan_replaces_provenance();

-- 3. Correction notices: numbered adjustment documents for issued
-- Delivery Challans whose cancellation is blocked by downstream evidence.
-- Born issued (there is no draft stage — the approval IS the draft), they
-- snapshot the original challan's identity plus the sanctioned
-- corrections, and cancel forward-only with a note.
CREATE TABLE correction_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,
  delivery_challan_id uuid NOT NULL,
  approval_request_id uuid NOT NULL,
  notice_number text NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  -- Immutable issue-time snapshot: the original challan identity
  -- (number, date, consignee, lines) plus the corrections and reason.
  snapshot jsonb NOT NULL,
  template_version text NOT NULL,
  rendered_object_key text,
  rendered_sha256 text
    CHECK (rendered_sha256 IS NULL OR rendered_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'cancelled')),
  cancellation_note text,
  created_by_user_id text NOT NULL,
  cancelled_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, notice_number),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  FOREIGN KEY (organisation_id, delivery_challan_id, work_id)
    REFERENCES delivery_challans(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, approval_request_id)
    REFERENCES approval_requests(organisation_id, id),
  -- Cancellation must say why; issued rows carry no cancellation fields.
  CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL
      AND cancelled_by_user_id IS NOT NULL
      AND length(btrim(cancellation_note)) >= 3)
    OR
    (status <> 'cancelled' AND cancelled_at IS NULL
      AND cancelled_by_user_id IS NULL AND cancellation_note IS NULL)
  )
);

CREATE UNIQUE INDEX correction_notices_sequence_per_work
  ON correction_notices (organisation_id, work_id, sequence_number);
CREATE INDEX correction_notices_work_idx
  ON correction_notices (organisation_id, work_id, created_at DESC, id);
CREATE INDEX correction_notices_challan_idx
  ON correction_notices (organisation_id, delivery_challan_id, created_at DESC, id);

-- Issued business data is frozen except the render evidence; cancelled
-- rows are fully immutable. Forward-only: issued may only stay issued or
-- become cancelled.
CREATE FUNCTION app_private.guard_correction_notice_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled Correction Notices are immutable';
  END IF;

  IF NEW.status NOT IN ('issued', 'cancelled') THEN
    RAISE EXCEPTION 'issued Correction Notices may only remain issued or be cancelled';
  END IF;

  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.delivery_challan_id,
    NEW.approval_request_id, NEW.notice_number, NEW.sequence_number,
    NEW.snapshot, NEW.template_version, NEW.created_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.delivery_challan_id,
    OLD.approval_request_id, OLD.notice_number, OLD.sequence_number,
    OLD.snapshot, OLD.template_version, OLD.created_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'issued Correction Notice business data is immutable';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER correction_notices_guard_update
BEFORE UPDATE ON correction_notices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_correction_notice_update();

CREATE TRIGGER correction_notices_touch_updated_at
BEFORE UPDATE ON correction_notices
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- 4. Gapless per-Work notice numbering ('<work_code>-CN-NN'), the same
-- counter mechanics as 0014: the counter row lock serialises concurrent
-- approvals, rollback rolls the number back, the decrease guard prevents
-- reuse, and the sequence unique index on the table backstops it.
CREATE TABLE correction_notice_counters (
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

CREATE TRIGGER correction_notice_counters_guard_decrease
BEFORE UPDATE ON correction_notice_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

CREATE TRIGGER correction_notice_counters_touch_updated_at
BEFORE UPDATE ON correction_notice_counters
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- 5. RLS: tenant policy on every new table, enabled and forced.
ALTER TABLE correction_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE correction_notices FORCE ROW LEVEL SECURITY;

CREATE POLICY correction_notices_tenant_policy ON correction_notices
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

ALTER TABLE correction_notice_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE correction_notice_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY correction_notice_counters_tenant_policy ON correction_notice_counters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- 6. Grants. No DELETE anywhere: notices are numbered legal records that
-- cancel, never disappear, and the counter is numbering state.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON correction_notices TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE ON correction_notice_counters TO auto_mb_app;
  END IF;
END
$$;
