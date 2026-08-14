SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0072: the worker job queue (ADR-0011, programme pack P18).
--
-- `apps/worker` has existed since ADR-0008 as an empty boundary
-- declaration. This migration gives it the one thing it lacked: somewhere
-- for a job to be written down. Everything about the shape below follows
-- from ADR-0011, which the owner accepted on 2026-08-14, and the two
-- properties that ADR refuses to trade away are worth restating at the
-- top of the file that implements them.
--
-- FIRST: a job runs as the user who caused it. There is no service
-- identity, no organisation the worker can bind without a membership
-- proof, and no argument by which a caller can name an organisation. The
-- `(organisation_id, user_id)` pair on a queue row is stamped by
-- `enqueue_job` from the binding that is already active in the enqueuing
-- transaction — `current_organisation_id()`, the same function every RLS
-- policy calls, on the definer's authority. A caller who is not bound
-- cannot enqueue at all, and a caller who IS bound can only enqueue for
-- the organisation they are bound to. That is why the function takes no
-- organisation parameter: not as a convenience, but so that the
-- cross-tenant enqueue has no syntax.
--
-- SECOND: the queue itself is unreachable from the application role. It
-- is inherently cross-tenant — the worker must find the next job before
-- it knows whose job it is, so no tenant policy can express the read —
-- and an RLS-exempt table the app role could SELECT would be an
-- enumeration oracle for every organisation's job metadata behind any SQL
-- injection anywhere in the product. So the table carries NO grant to
-- `auto_mb_app` whatsoever, and the four functions below are the entire
-- surface. `packages/db/test/worker-queue.integration.test.ts` asserts
-- the zero-grant state against the catalog, and
-- `UNGRANTED_BY_DESIGN` in `packages/db/src/bootstrap.ts` records the
-- same decision where the privilege matrix lives, so neither can be
-- undone quietly.
--
-- The residual exposure ADR-0011 states plainly, and this file will not
-- pretend otherwise: arbitrary SQL as the application role can call
-- `claim_next_job` and learn one job's metadata — its id, kind, and
-- timestamps, never its payload — and can starve the queue by claiming
-- without completing. That is denial of service, not a tenancy break, and
-- the claim lease below is what bounds it: an unfinished claim expires
-- and the job returns to the queue.

-- ---------------------------------------------------------------------
-- 1. The table.

CREATE TABLE worker_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stamped from the enqueuing transaction's verified binding, never from
  -- a parameter. The foreign key is the ordinary one; the guarantee that
  -- makes it meaningful is that no caller chooses the value.
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  -- The user whose authority the job runs under. `text` rather than uuid
  -- because that is what `organisation_memberships.user_id` and every
  -- other actor column in this schema is (Better Auth owns the shape).
  -- Deliberately NOT a foreign key to auth_users: a job row is a record
  -- of who commissioned the work, and it must survive the account being
  -- deleted so the queue can still say why the job then refused to run.
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 255),

  kind text NOT NULL CHECK (kind IN (
    -- Poppler text extraction plus digital-signature verification for an
    -- uploaded LOA, the two operations that read the same bytes once.
    'loa_document_intake'
  )),

  -- REFERENCES, never content (ADR-0011 §3). The row names the document
  -- to work on; the bytes and every result stay behind tenant RLS, so a
  -- job claimed by a malicious caller yields nothing readable. The CHECK
  -- keeps it an object rather than a bare scalar, and the size ceiling is
  -- there because a reference that needs eight kilobytes is content
  -- wearing a reference's name.
  payload_ref jsonb NOT NULL CHECK (
    jsonb_typeof(payload_ref) = 'object'
    AND length(payload_ref::text) <= 8192
  ),

  -- queued      → waiting, or returned by an expired claim
  -- claimed     → a worker holds a lease on it
  -- done        → finished, outcome recorded
  -- failed      → gave up after the retry budget, or a non-retryable fault
  -- refused_bind → the commissioning user's membership did not survive to
  --                execution. TERMINAL and never retried: ADR-0011 is
  --                explicit that work commissioned by a user who has since
  --                lost the tenancy must not run on their authority, and
  --                a retry would only re-refuse, more quietly each time.
  --                The operator remedy is to re-request under a live user,
  --                which this state makes visible rather than hiding it
  --                behind an exhausted retry count.
  state text NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued', 'claimed', 'done', 'failed', 'refused_bind')
  ),

  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),

  -- Not before this instant. Bumped by `fail_job` for a retry, so backoff
  -- is queue state rather than something a sleeping worker holds.
  run_after timestamptz NOT NULL DEFAULT now(),

  -- The lease. `claim_token` is generated inside `claim_next_job` and
  -- returned to the claimant exactly once; `complete_job` and `fail_job`
  -- demand it back. Because no application-role session can read this
  -- table, a token cannot be looked up — only received — which is what
  -- makes "callable only by the claimant's session for the job it
  -- claimed" (ADR-0011 §2) an unforgeable property rather than a
  -- convention. `claimed_by` is the worker's own name and exists for
  -- operators reading the queue, not for authorisation.
  claim_token uuid,
  claimed_by text CHECK (claimed_by IS NULL OR length(claimed_by) BETWEEN 1 AND 255),
  claimed_at timestamptz,
  claim_expires_at timestamptz,

  last_error text,
  outcome jsonb CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object'),
  finished_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A claim is one fact with four parts. Without this a row could sit in
  -- `claimed` with no lease to expire, which is the shape that turns a
  -- crashed worker into a permanently stuck job.
  CONSTRAINT worker_jobs_claim_shape_check CHECK (
    (
      state <> 'claimed'
      AND claim_token IS NULL
      AND claimed_by IS NULL
      AND claimed_at IS NULL
      AND claim_expires_at IS NULL
    )
    OR
    (
      state = 'claimed'
      AND claim_token IS NOT NULL
      AND claimed_by IS NOT NULL
      AND claimed_at IS NOT NULL
      AND claim_expires_at IS NOT NULL
    )
  ),

  -- A terminal state has an instant; a live one does not. Keeps `done`
  -- from being claimed by a row that never finished.
  CONSTRAINT worker_jobs_finished_shape_check CHECK (
    (state IN ('done', 'failed', 'refused_bind') AND finished_at IS NOT NULL)
    OR (state IN ('queued', 'claimed') AND finished_at IS NULL)
  )
);

COMMENT ON TABLE worker_jobs IS
  'Asynchronous job queue (ADR-0011). Reachable only through the app_private definer functions; auto_mb_app holds no privilege on it. Rows carry references, never document content.';
COMMENT ON COLUMN worker_jobs.user_id IS
  'The user whose authority the job runs under. The worker re-proves this membership with bind_tenant at execution; a revoked membership parks the job in refused_bind rather than running it.';
COMMENT ON COLUMN worker_jobs.claim_token IS
  'Generated by claim_next_job and returned once. complete_job and fail_job require it, and no application-role session can read this column, so only the claimant holds it.';

-- Claim ordering. The partial index carries only the rows a claim can
-- select — runnable queued rows and claims whose lease has lapsed — which
-- is the one query `claim_next_job` runs and the one that must stay fast
-- as the done rows accumulate.
CREATE INDEX worker_jobs_claimable_idx
  ON worker_jobs (run_after, created_at, id)
  WHERE state IN ('queued', 'claimed');

-- What an operator and the tenant-facing status reads actually ask:
-- "where has this document's job got to".
CREATE INDEX worker_jobs_organisation_state_idx
  ON worker_jobs (organisation_id, state, created_at DESC, id);

-- ---------------------------------------------------------------------
-- 2. Row-level security: enabled, forced, and with NO policy at all.
--
-- This is not an oversight and the repository's own conventions make it
-- worth spelling out, because every other table here gains a tenant
-- policy in the same breath as FORCE. A policy would be the wrong answer
-- twice over: the app role has no grant to exercise one, and the worker
-- must read across organisations before any binding exists, which no
-- tenant policy can express (ADR-0011 rejects "queue table with plain
-- RLS" as circular for exactly this reason). ENABLE + FORCE with no
-- policy is therefore deny-all for every role that is not BYPASSRLS —
-- the strictest available state, and the correct one. The definer
-- functions reach the rows because `auto_mb_definer` carries BYPASSRLS
-- (migration 0004), which is also why it needs explicit table grants
-- below: the attribute bypasses row security, never privileges.
ALTER TABLE worker_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_jobs FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON worker_jobs TO auto_mb_definer;

-- Deliberately absent: any GRANT to auto_mb_app. Revoked explicitly
-- rather than merely omitted, so a database that once carried a hand-made
-- grant converges to the same state as a fresh one — the revoke-then-
-- grant discipline of `applyGrants`, with the grant half left off on
-- purpose.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    REVOKE ALL ON worker_jobs FROM auto_mb_app;
  END IF;
END
$$;

CREATE TRIGGER worker_jobs_touch_updated_at
BEFORE UPDATE ON worker_jobs
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. enqueue_job — the only way a row is born.
--
-- Takes no organisation and no user. Both are read from the binding that
-- `bind_tenant` already proved for the surrounding transaction, which is
-- the whole of ADR-0011's cross-tenant defence: there is no argument to
-- craft. An unbound caller is refused with 28A01, the same SQLSTATE
-- `bind_tenant` raises and the same one `TenantBindRefusedError` carries,
-- because "you hold no membership here" is the same answer whether it is
-- discovered at bind time or at enqueue time.
--
-- SECURITY DEFINER because the application role cannot see this table at
-- all; STRICT is not used because a NULL payload should be a named
-- refusal rather than a silent no-op.
CREATE FUNCTION app_private.enqueue_job(
  p_kind text,
  p_payload_ref jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_private, pg_temp
AS $$
DECLARE
  v_organisation_id uuid;
  v_user_id text;
  v_id uuid;
BEGIN
  v_organisation_id := app_private.current_organisation_id();
  v_user_id := app_private.current_user_id();

  IF v_organisation_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION
      'a job can only be enqueued inside a bound tenant transaction'
      USING ERRCODE = '28A01';
  END IF;

  IF p_payload_ref IS NULL OR jsonb_typeof(p_payload_ref) <> 'object' THEN
    RAISE EXCEPTION 'payload_ref must be a JSON object'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO worker_jobs (organisation_id, user_id, kind, payload_ref)
  VALUES (v_organisation_id, v_user_id, p_kind, p_payload_ref)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

ALTER FUNCTION app_private.enqueue_job(text, jsonb) OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.enqueue_job(text, jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 4. claim_next_job — FOR UPDATE SKIP LOCKED, one row, with a lease.
--
-- The inner SELECT takes the row lock and the outer UPDATE writes the
-- claim, which is the standard shape: SKIP LOCKED lets a second worker
-- step over a row the first is already taking instead of queueing behind
-- it, so N workers make progress on N jobs rather than serialising.
--
-- The `claim_expires_at < now()` arm is the re-queue. A worker that dies
-- holding a claim leaves the row in `claimed` forever otherwise; here the
-- lease simply lapses and the next claim picks it up, incrementing
-- attempts so a job that repeatedly kills its worker still exhausts its
-- budget rather than looping without end.
CREATE FUNCTION app_private.claim_next_job(
  p_claimed_by text,
  p_lease_seconds integer
)
RETURNS TABLE (
  id uuid,
  organisation_id uuid,
  user_id text,
  kind text,
  payload_ref jsonb,
  attempts integer,
  max_attempts integer,
  claim_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_private, pg_temp
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
BEGIN
  IF p_claimed_by IS NULL OR length(p_claimed_by) = 0 THEN
    RAISE EXCEPTION 'a claim must name the worker making it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 THEN
    RAISE EXCEPTION 'a claim lease must be at least one second'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN QUERY
  UPDATE worker_jobs AS j
     SET state = 'claimed',
         claim_token = v_token,
         claimed_by = p_claimed_by,
         claimed_at = now(),
         claim_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1
   WHERE j.id = (
     SELECT candidate.id
       FROM worker_jobs AS candidate
      WHERE (candidate.state = 'queued' AND candidate.run_after <= now())
         OR (candidate.state = 'claimed' AND candidate.claim_expires_at < now())
      ORDER BY candidate.run_after, candidate.created_at, candidate.id
        FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING j.id, j.organisation_id, j.user_id, j.kind, j.payload_ref,
            j.attempts, j.max_attempts, j.claim_token;
END
$$;

ALTER FUNCTION app_private.claim_next_job(text, integer) OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.claim_next_job(text, integer) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 5. complete_job / fail_job — claimant only.
--
-- Both match on `claim_token` as well as id, and both return false rather
-- than raising when nothing matched. False is the honest answer to "my
-- lease expired while I was working and somebody else has the job now",
-- which is a normal race under a lease, not a fault; the worker logs it
-- and moves on rather than treating a lost race as an error.

CREATE FUNCTION app_private.complete_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_outcome jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_private, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_outcome IS NOT NULL AND jsonb_typeof(p_outcome) <> 'object' THEN
    RAISE EXCEPTION 'a job outcome must be a JSON object'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE worker_jobs
     SET state = 'done',
         outcome = p_outcome,
         finished_at = now(),
         claim_token = NULL,
         claimed_by = NULL,
         claimed_at = NULL,
         claim_expires_at = NULL,
         last_error = NULL
   WHERE id = p_job_id
     AND state = 'claimed'
     AND claim_token = p_claim_token;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END
$$;

ALTER FUNCTION app_private.complete_job(uuid, uuid, jsonb) OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.complete_job(uuid, uuid, jsonb) FROM PUBLIC;

-- `p_retry_at` NULL means "do not retry": the job goes to `p_terminal_state`
-- immediately. A non-NULL instant returns it to `queued` with `run_after`
-- moved, but only while attempts remain — the retry budget is enforced
-- here rather than trusted to the worker, because a worker that miscounts
-- would otherwise retry a poisoned job forever.
--
-- `p_terminal_state` exists for exactly one caller: a bind the database
-- refused. ADR-0011 makes that state terminal and distinct from `failed`
-- so an operator can tell "this job's user lost their membership" from
-- "this job kept breaking", and the function refuses any other value
-- rather than letting a typo invent a state the CHECK would then reject
-- with a less useful message. A refused bind ignores `p_retry_at`
-- entirely: there is no retry that could succeed, and offering one would
-- be a lie in the queue.
CREATE FUNCTION app_private.fail_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_error text,
  p_retry_at timestamptz DEFAULT NULL,
  p_terminal_state text DEFAULT 'failed'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_private, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_terminal_state NOT IN ('failed', 'refused_bind') THEN
    RAISE EXCEPTION 'a job fails as failed or refused_bind, not %', p_terminal_state
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE worker_jobs
     SET state = CASE
           WHEN p_terminal_state = 'refused_bind' THEN 'refused_bind'
           WHEN p_retry_at IS NOT NULL AND attempts < max_attempts THEN 'queued'
           ELSE p_terminal_state
         END,
         run_after = CASE
           WHEN p_terminal_state = 'refused_bind' THEN run_after
           WHEN p_retry_at IS NOT NULL AND attempts < max_attempts THEN p_retry_at
           ELSE run_after
         END,
         finished_at = CASE
           WHEN p_terminal_state = 'refused_bind' THEN now()
           WHEN p_retry_at IS NOT NULL AND attempts < max_attempts THEN NULL
           ELSE now()
         END,
         last_error = p_error,
         claim_token = NULL,
         claimed_by = NULL,
         claimed_at = NULL,
         claim_expires_at = NULL
   WHERE id = p_job_id
     AND state = 'claimed'
     AND claim_token = p_claim_token;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END
$$;

ALTER FUNCTION app_private.fail_job(uuid, uuid, text, timestamptz, text)
  OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.fail_job(uuid, uuid, text, timestamptz, text)
  FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 6. The application role's entire access to the queue: EXECUTE on four
-- functions, and nothing on the table.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION app_private.enqueue_job(text, jsonb) TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.claim_next_job(text, integer) TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.complete_job(uuid, uuid, jsonb) TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.fail_job(uuid, uuid, text, timestamptz, text)
      TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 7. The LOA intake path becomes asynchronous.
--
-- `extraction_status` has admitted 'pending' and 'processing' since
-- migration 0001 and no code has ever written either: the synchronous
-- upload jumped straight to 'review' or 'failed'. Those two values were
-- waiting for this pack, so the state machine needs no widening — only
-- the guard below, which is new, because a status that was previously
-- reachable only by the route is now reachable by a background writer.
--
-- The born-state hole, in the 0066 idiom: BEFORE INSERT OR UPDATE, not
-- UPDATE-only. A row may legitimately be BORN 'pending' (the upload
-- writes it that way now) and may legitimately be born 'review' (the
-- v1 importer writes settled documents directly), so an UPDATE-only
-- guard would watch the door while the window stood open.
--
-- What it enforces: extraction may only move FORWARD out of the
-- asynchronous states. 'pending' → 'processing' → 'review'/'failed' is
-- the worker's path, and nothing may put a document that has already been
-- read back into 'pending' or 'processing'. Without this, a job retried
-- after its document was confirmed could quietly reopen a confirmed
-- intake for re-extraction, and the confirmed Work would be resting on a
-- payload that changed underneath it.
CREATE FUNCTION app_private.guard_loa_extraction_progress()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW.extraction_status = OLD.extraction_status THEN
    RETURN NEW;
  END IF;

  IF NEW.extraction_status IN ('pending', 'processing')
     AND OLD.extraction_status NOT IN ('pending', 'processing')
  THEN
    RAISE EXCEPTION
      'LOA document % has already been extracted and cannot return to %',
      NEW.id, NEW.extraction_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER loa_documents_extraction_progress_guard
BEFORE INSERT OR UPDATE ON loa_documents
FOR EACH ROW EXECUTE FUNCTION app_private.guard_loa_extraction_progress();
