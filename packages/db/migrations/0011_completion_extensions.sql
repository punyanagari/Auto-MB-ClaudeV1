SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 6: contract completion dates and DOC extension requests.
--
-- A Work gains an original and a current completion date, set together
-- exactly once. Afterwards the current date moves ONLY when a formal
-- extension request to the railway is answered accepted/modified — the
-- letter is drafted, finalised into a numbered immutable snapshot
-- (<work_code>-Extension-NN, gapless per Work through a counter row
-- lock, same serialisation as delivery challans), and the railway's
-- response document is stored content-addressed alongside the outcome.
-- The database proves the whole path: write-once original date, the
-- sanctioned-transition guard on works, forward-only extension statuses,
-- and immutability after finalise.

-- 1. Completion dates on works. Both are set together (one-time), and
-- neither may precede the LOA letter date — the same product date
-- invariant migration 0010 holds for challan dates, expressible here as
-- plain CHECKs because letter_date lives on the same row.
ALTER TABLE works
  ADD COLUMN original_completion_date date,
  ADD COLUMN current_completion_date date;

ALTER TABLE works
  ADD CONSTRAINT works_completion_dates_together_check
  CHECK ((original_completion_date IS NULL) = (current_completion_date IS NULL));

ALTER TABLE works
  ADD CONSTRAINT works_original_completion_after_letter_check
  CHECK (original_completion_date IS NULL OR original_completion_date >= letter_date);

ALTER TABLE works
  ADD CONSTRAINT works_current_completion_after_letter_check
  CHECK (current_completion_date IS NULL OR current_completion_date >= letter_date);

CREATE INDEX works_completion_due_idx
  ON works (organisation_id, current_completion_date)
  WHERE current_completion_date IS NOT NULL;

-- 2. Extension requests: the letter asking the railway for more time.
CREATE TABLE extension_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalised', 'responded')),
  proposed_completion_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  addressee text NOT NULL CHECK (length(btrim(addressee)) BETWEEN 2 AND 200),
  letter_date date,
  sequence_number integer CHECK (sequence_number IS NULL OR sequence_number > 0),
  request_number text,
  finalised_snapshot jsonb,
  template_version text,
  rendered_object_key text,
  rendered_sha256 text CHECK (rendered_sha256 IS NULL OR rendered_sha256 ~ '^[0-9a-f]{64}$'),
  response_object_key text,
  response_sha256 text CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[0-9a-f]{64}$'),
  response_outcome text CHECK (
    response_outcome IS NULL OR response_outcome IN ('accepted', 'modified', 'rejected')
  ),
  granted_completion_date date,
  created_by_user_id text NOT NULL,
  finalised_by_user_id text,
  responded_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalised_at timestamptz,
  responded_at timestamptz,
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, id, work_id),
  UNIQUE (organisation_id, request_number),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  -- Drafts carry no number, snapshot, render, or response state.
  CHECK (
    status <> 'draft'
    OR (
      sequence_number IS NULL AND request_number IS NULL
      AND finalised_snapshot IS NULL AND template_version IS NULL
      AND finalised_at IS NULL AND finalised_by_user_id IS NULL
      AND rendered_object_key IS NULL AND rendered_sha256 IS NULL
      AND response_object_key IS NULL AND response_sha256 IS NULL
      AND response_outcome IS NULL AND granted_completion_date IS NULL
      AND responded_at IS NULL AND responded_by_user_id IS NULL
    )
  ),
  -- Finalised and responded requests carry the number, snapshot, and a
  -- letter date.
  CHECK (
    status = 'draft'
    OR (
      sequence_number IS NOT NULL AND request_number IS NOT NULL
      AND finalised_snapshot IS NOT NULL AND template_version IS NOT NULL
      AND finalised_at IS NOT NULL AND finalised_by_user_id IS NOT NULL
      AND letter_date IS NOT NULL
    )
  ),
  -- A responded request records the outcome, the response document, the
  -- actor, and the moment.
  CHECK (
    status <> 'responded'
    OR (
      response_outcome IS NOT NULL AND response_object_key IS NOT NULL
      AND response_sha256 IS NOT NULL
      AND responded_at IS NOT NULL AND responded_by_user_id IS NOT NULL
    )
  ),
  -- accepted/modified grant a date; rejected grants none.
  CHECK (
    (response_outcome IS NULL AND granted_completion_date IS NULL)
    OR (response_outcome IN ('accepted', 'modified') AND granted_completion_date IS NOT NULL)
    OR (response_outcome = 'rejected' AND granted_completion_date IS NULL)
  )
);

-- At most one draft extension request per Work (same 409 surface as the
-- delivery-challan one-draft rule).
CREATE UNIQUE INDEX extension_requests_one_draft_per_work
  ON extension_requests (organisation_id, work_id)
  WHERE status = 'draft';

-- Sequence numbers are serialised per Work at the database, not only by
-- the counter row (same proof as delivery_challans_sequence_per_work).
CREATE UNIQUE INDEX extension_requests_sequence_per_work
  ON extension_requests (organisation_id, work_id, sequence_number)
  WHERE sequence_number IS NOT NULL;

CREATE INDEX extension_requests_work_idx
  ON extension_requests (organisation_id, work_id, status, created_at DESC, id);

-- 3. Per-Work numbering counters (copy of delivery_challan_counters: the
-- row lock serialises concurrent finalisations, and a rolled-back
-- finalise rolls its number back with it, so numbers stay gapless).
CREATE TABLE extension_request_counters (
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

-- 4. The proposed date must extend the Work's current completion date —
-- validated when the row is created or edited as a draft and revalidated
-- on the draft -> finalised transition. Runs as the invoking role (0010
-- pattern): if the works row is invisible (administrative session with
-- no tenant bound) the guard steps aside and the foreign keys still hold.
CREATE FUNCTION app_private.guard_extension_request_dates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_current date;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    RETURN NEW;
  END IF;

  SELECT w.current_completion_date INTO v_current
  FROM works w
  WHERE w.id = NEW.work_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'the Work has no completion date yet; set it before requesting an extension'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.proposed_completion_date <= v_current THEN
    RAISE EXCEPTION 'proposed_completion_date % must be after the current completion date %',
      NEW.proposed_completion_date, v_current
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER extension_requests_date_guard
  BEFORE INSERT OR UPDATE ON extension_requests
  FOR EACH ROW
  EXECUTE FUNCTION app_private.guard_extension_request_dates();

-- 5. Forward-only statuses and immutability after finalise. While
-- finalised, only the render evidence and the response fields may change;
-- once responded, only re-rendering the letter remains possible.
CREATE FUNCTION app_private.guard_extension_request_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'responded' THEN
    IF NEW.status <> 'responded' THEN
      RAISE EXCEPTION 'extension request status only moves forward: draft -> finalised -> responded';
    END IF;
    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.proposed_completion_date, NEW.reason,
      NEW.addressee, NEW.letter_date, NEW.sequence_number, NEW.request_number,
      NEW.finalised_snapshot, NEW.template_version, NEW.response_object_key,
      NEW.response_sha256, NEW.response_outcome, NEW.granted_completion_date,
      NEW.created_by_user_id, NEW.finalised_by_user_id, NEW.responded_by_user_id,
      NEW.created_at, NEW.finalised_at, NEW.responded_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.proposed_completion_date, OLD.reason,
      OLD.addressee, OLD.letter_date, OLD.sequence_number, OLD.request_number,
      OLD.finalised_snapshot, OLD.template_version, OLD.response_object_key,
      OLD.response_sha256, OLD.response_outcome, OLD.granted_completion_date,
      OLD.created_by_user_id, OLD.finalised_by_user_id, OLD.responded_by_user_id,
      OLD.created_at, OLD.finalised_at, OLD.responded_at
    ) THEN
      RAISE EXCEPTION 'responded extension requests are immutable apart from re-rendering the letter';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'finalised' THEN
    IF NEW.status NOT IN ('finalised', 'responded') THEN
      RAISE EXCEPTION 'finalised extension requests may only remain finalised or become responded';
    END IF;
    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.proposed_completion_date, NEW.reason,
      NEW.addressee, NEW.letter_date, NEW.sequence_number, NEW.request_number,
      NEW.finalised_snapshot, NEW.template_version, NEW.created_by_user_id,
      NEW.finalised_by_user_id, NEW.created_at, NEW.finalised_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.proposed_completion_date, OLD.reason,
      OLD.addressee, OLD.letter_date, OLD.sequence_number, OLD.request_number,
      OLD.finalised_snapshot, OLD.template_version, OLD.created_by_user_id,
      OLD.finalised_by_user_id, OLD.created_at, OLD.finalised_at
    ) THEN
      RAISE EXCEPTION 'finalised extension request business data is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'responded' THEN
    RAISE EXCEPTION 'a draft extension request must be finalised before a response is recorded';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER extension_requests_guard_update
BEFORE UPDATE ON extension_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_extension_request_update();

CREATE FUNCTION app_private.guard_extension_request_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'only draft extension requests may be deleted';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER extension_requests_guard_delete
BEFORE DELETE ON extension_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_extension_request_delete();

CREATE TRIGGER extension_requests_touch_updated_at
BEFORE UPDATE ON extension_requests
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TRIGGER extension_request_counters_touch_updated_at
BEFORE UPDATE ON extension_request_counters
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- 6. The works-side guard: original_completion_date is write-once, and
-- current_completion_date changes only on the one-time initial set or
-- when an extension request for this Work was marked responded
-- accepted/modified IN THE SAME TRANSACTION granting exactly this date
-- (the row's xmin proves the same-transaction requirement). No free-form
-- completion-date edit exists anywhere. Runs as the invoking role, so
-- the extension lookup sees rows through the caller's own RLS; fixture
-- cleanup uses session_replication_role = 'replica' like every other
-- guarded table.
CREATE FUNCTION app_private.guard_work_completion_dates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.original_completion_date IS NOT NULL
     AND NEW.original_completion_date IS DISTINCT FROM OLD.original_completion_date THEN
    RAISE EXCEPTION 'original_completion_date is set once and never edited'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.current_completion_date IS DISTINCT FROM OLD.current_completion_date THEN
    IF OLD.current_completion_date IS NULL AND OLD.original_completion_date IS NULL THEN
      -- The one-time initial set; the table CHECK forces both columns
      -- together and both >= letter_date.
      RETURN NEW;
    END IF;

    IF NEW.current_completion_date IS NULL THEN
      RAISE EXCEPTION 'current_completion_date cannot be cleared'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM extension_requests er
      WHERE er.organisation_id = NEW.organisation_id
        AND er.work_id = NEW.id
        AND er.status = 'responded'
        AND er.response_outcome IN ('accepted', 'modified')
        AND er.granted_completion_date = NEW.current_completion_date
        AND er.xmin = pg_current_xact_id()::xid
    ) THEN
      RAISE EXCEPTION 'current_completion_date changes only when an extension request for this Work is marked responded accepted/modified in the same transaction'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER works_completion_date_guard
  BEFORE UPDATE OF original_completion_date, current_completion_date ON works
  FOR EACH ROW
  EXECUTE FUNCTION app_private.guard_work_completion_dates();

-- 7. RLS: tenant policy on both new tables.
ALTER TABLE extension_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE extension_request_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_request_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY extension_requests_tenant_policy ON extension_requests
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());
CREATE POLICY extension_request_counters_tenant_policy ON extension_request_counters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- 8. Grants. Drafts are deletable (the delete guard blocks everything
-- else); counters are numbering state and keep no DELETE, like
-- delivery_challan_counters.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON extension_requests TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE ON extension_request_counters TO auto_mb_app;
  END IF;
END
$$;
