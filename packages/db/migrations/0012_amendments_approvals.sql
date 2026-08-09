SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 6: controlled baseline amendments and the edit-approval
-- workflow. The awarded LOA baseline on work_items stays immutable
-- forever; sanctioned changes write effective_* columns instead, and every
-- change travels through an approval_request — an immutable, audited
-- record of who proposed what, why, and who decided.

-- 1. Approval authority: a per-member flag, same pattern as
-- can_issue_documents / can_cancel_documents. Revalidated at apply time.
ALTER TABLE organisation_memberships
  ADD COLUMN can_approve_amendments boolean NOT NULL DEFAULT false;

-- 2. The generic approval engine. entity_type starts with
-- 'work_item_amendment'; entity_id is NULL while an add-item proposal has
-- no item yet and is bound once the approved apply creates it.
CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  entity_type text NOT NULL CHECK (entity_type IN ('work_item_amendment')),
  entity_id uuid,
  work_id uuid NOT NULL,
  -- Immutable snapshot of the full proposed change (kind, target, values).
  proposed jsonb NOT NULL,
  -- Structured before/after per field: [{ field, before, after }].
  diff jsonb NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by_user_id text NOT NULL,
  decided_by_user_id text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  -- A rejection must say why.
  CHECK (
    status <> 'rejected'
    OR (decision_note IS NOT NULL AND length(btrim(decision_note)) >= 3)
  ),
  -- Pending rows carry no decision; decided rows always carry one.
  CHECK (
    (status = 'pending' AND decided_by_user_id IS NULL AND decided_at IS NULL AND decision_note IS NULL)
    OR
    (status <> 'pending' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  )
);

-- At most one PENDING request per concrete entity (add-item proposals have
-- no entity yet and may coexist).
CREATE UNIQUE INDEX approval_requests_one_pending_per_entity
  ON approval_requests (organisation_id, entity_type, entity_id)
  WHERE status = 'pending' AND entity_id IS NOT NULL;

CREATE INDEX approval_requests_queue_idx
  ON approval_requests (organisation_id, status, created_at DESC, id);
CREATE INDEX approval_requests_work_idx
  ON approval_requests (organisation_id, work_id, created_at DESC, id);

-- Decided/withdrawn rows are frozen; pending rows may only change their
-- decision fields (and, for add-item applies, bind the created entity).
CREATE FUNCTION app_private.guard_approval_request_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'decided approval requests are immutable';
  END IF;
  IF ROW(
    NEW.organisation_id, NEW.entity_type, NEW.work_id, NEW.proposed,
    NEW.diff, NEW.reason, NEW.requested_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.entity_type, OLD.work_id, OLD.proposed,
    OLD.diff, OLD.reason, OLD.requested_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'approval request content is immutable; only the decision may change';
  END IF;
  IF NEW.entity_id IS DISTINCT FROM OLD.entity_id
    AND NOT (OLD.entity_id IS NULL AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'approval request entity binding is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER approval_requests_guard_update
BEFORE UPDATE ON approval_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_approval_request_update();

-- 3. Amendment columns on work_items. NULL means "no amendment; the
-- original applies". effective_quantity may be zero: an omitted item.
ALTER TABLE work_items
  ADD COLUMN effective_quantity numeric(18,3)
    CHECK (effective_quantity IS NULL OR effective_quantity >= 0),
  ADD COLUMN effective_unit_rate numeric(18,2)
    CHECK (effective_unit_rate IS NULL OR effective_unit_rate >= 0),
  ADD COLUMN effective_description text
    CHECK (effective_description IS NULL OR length(btrim(effective_description)) >= 3),
  ADD COLUMN effective_unit text
    CHECK (
      effective_unit IS NULL OR length(btrim(effective_unit)) BETWEEN 1 AND 20
    ),
  ADD COLUMN amendment_added boolean NOT NULL DEFAULT false,
  ADD COLUMN source_approval_id uuid;

-- An amendment-added item proves the approval that created it.
ALTER TABLE work_items
  ADD CONSTRAINT work_items_source_approval_fk
  FOREIGN KEY (organisation_id, source_approval_id)
  REFERENCES approval_requests(organisation_id, id);

ALTER TABLE work_items
  ADD CONSTRAINT work_items_amendment_added_source_check
  CHECK (amendment_added = false OR source_approval_id IS NOT NULL);

-- The awarded baseline is immutable forever: amendments write the
-- effective_* columns, never the values confirmed from the LOA. (Runs
-- before the alphabetically-later touch trigger, so updated_at churn
-- never masks a violation.)
CREATE FUNCTION app_private.guard_work_item_baseline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.awarded_quantity, NEW.effective_rate,
    NEW.amendment_added, NEW.source_approval_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.awarded_quantity, OLD.effective_rate,
    OLD.amendment_added, OLD.source_approval_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'awarded baseline values are immutable; amendments write effective_* columns';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER work_items_baseline_guard
BEFORE UPDATE ON work_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_item_baseline();

-- 4. RLS: tenant policy, enabled and forced like every tenant table.
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY approval_requests_tenant_policy ON approval_requests
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- 5. Grants. No DELETE: approval requests are a decision ledger —
-- withdrawal is a status, not an erasure.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON approval_requests TO auto_mb_app;
  END IF;
END
$$;
